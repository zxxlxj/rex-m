import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mirrorDue, mirrorSource } from '../src/mirror.mjs';

const origin = 'https://hub.example.com';
const row = (id, extra = {}) => ({ id, title: id, version: 'index-1', requiredVersion: '0.0.6', url: `https://upstream.example.com/${id}.js`, ...extra });
const sourceOf = (modules, extra = {}) => ({ url: '', delivery: 'mirror', modules, ...extra });
const script = (id, version = '2') => `\ufeffvar WidgetMetadata = {id:'${id}',title:'${id}',version:'${version}',requiredVersion:'0.0.7',modules:[]};\r\n`;
function setup(t) {
  const originalFetch = globalThis.fetch;
  t.after(() => { globalThis.fetch = originalFetch; });
  const files = new Map();
  return { files, env: { FILES: { async put(key, bytes) { files.set(key, new Uint8Array(bytes)); } } } };
}

test('mirrors exact bytes, trusts literal versions and scopes conditional validators to redirect destination', async t => {
  const { env, files } = setup(t);
  const original = sourceOf([row('alpha', { delivery: 'inherit' })]);
  const requests = [];
  let phase = 0;
  globalThis.fetch = async (url, options) => {
    assert.equal(options.redirect, 'manual');
    requests.push([url, options.headers.get('If-None-Match')]);
    if (url === original.modules[0].url) return new Response(null, { status: 307, headers: { Location: 'https://cdn.example.com/alpha.js' } });
    if (phase === 1) return new Response(null, { status: 304 });
    return new Response(script(phase === 2 ? 'other' : 'alpha'), { headers: { ETag: '"alpha"' } });
  };
  const first = await mirrorSource(original, env, origin);
  const bytes = new TextEncoder().encode(script('alpha'));
  const hash = createHash('sha256').update(bytes).digest('hex');
  const mirror = first.modules[0].mirror;
  assert.equal(mirror.url, `${origin}/files/${hash}.js`);
  assert.equal(mirror.version, '2');
  assert.equal(mirror.requiredVersion, '0.0.7');
  assert.equal(mirror.hash, hash);
  assert.equal(mirror.remoteUrl, original.modules[0].url);
  assert.equal(first.modules[0].url, original.modules[0].url);
  assert.deepEqual(files.get(`files/${hash}.js`), bytes);
  assert.equal(original.modules[0].mirror, undefined);
  phase++;
  assert.deepEqual(await mirrorSource(first, env, origin), first);
  const second = await mirrorSource(first, env, origin, { moduleId: 'alpha' });
  assert.deepEqual(requests.slice(-2), [[original.modules[0].url, null], ['https://cdn.example.com/alpha.js', '"alpha"']]);
  assert.equal(second.modules[0].mirror.hash, hash);
  phase++;
  const { modules: [failed] } = await mirrorSource(second, env, origin, { force: true });
  assert.match(failed.mirror.error, /ID/);
  assert.equal(failed.mirror.url, mirror.url);
  assert.equal(failed.mirror.version, mirror.version);
  assert.equal(files.size, 1);
});

test('applies module controls and schedules oldest due leaves without starving the tail', async t => {
  const { env } = setup(t);
  const seen = [];
  globalThis.fetch = async url => { const id = new URL(url).pathname.slice(1, -3); seen.push(id); return new Response(script(id)); };
  const now = Date.now();
  const source = sourceOf([
    row('stale', { refreshMinutes: 5, mirror: { checkedAt: new Date(now - 6 * 60_000).toISOString() } }),
    row('one'), row('two'), row('three'), row('four'),
    row('fresh', { mirror: { checkedAt: new Date(now).toISOString() } }),
    row('paused', { paused: true }), row('pending', { pending: true }), row('link', { delivery: 'link' }),
    row('local', { url: `${origin}/files/local.js` }), row('stable', { url: `${origin}/m/a/stable.js` }),
  ], { refreshMinutes: 10 });
  assert.equal(mirrorDue(source, now, origin), 0);
  assert.equal(mirrorDue({ ...source, paused: true }, now, origin), Infinity);
  assert.equal(mirrorDue(sourceOf([source.modules[5]], { refreshMinutes: 10 }), now), now + 10 * 60_000);
  assert.equal(mirrorDue(sourceOf(source.modules.slice(-2)), now, origin), Infinity);
  const first = await mirrorSource(source, env, origin);
  assert.deepEqual(seen, ['one', 'two', 'three']);
  const second = await mirrorSource(first, env, origin);
  assert.deepEqual(seen, ['one', 'two', 'three', 'four', 'stale']);
  await mirrorSource(second, env, origin, { moduleId: 'paused', force: true });
  await mirrorSource(second, env, origin, { moduleId: 'fresh' });
  assert.deepEqual(seen, ['one', 'two', 'three', 'four', 'stale', 'fresh']);
});

test('stores recognized encryption and opaque bytes as-is but never versions unchanged opaque content from the index alone', async t => {
  const { env, files } = setup(t);
  const enc = new TextEncoder().encode('REXENC:2\r\nEncrypted-Value');
  const binary = Uint8Array.of(255, 19, 0, 249, 18);
  const source = sourceOf([row('encrypted'), row('opaque')]);
  globalThis.fetch = async url => new Response(url.endsWith('encrypted.js') ? enc : binary, { headers: { 'Content-Type': 'application/octet-stream' } });
  const first = await mirrorSource(source, env, origin);
  assert.deepEqual(files.get(`files/${first.modules[0].mirror.hash}.js`), enc);
  assert.deepEqual(files.get(`files/${first.modules[1].mirror.hash}.js`), binary);
  first.modules[0].version = 'index-2';
  assert.equal((await mirrorSource(first, env, origin, { force: true })).modules[0].mirror.version, 'index-1');
});

test('rejects unsafe redirects and oversized or non-module upstream bodies', async t => {
  const { env, files } = setup(t);
  const seen = [];
  globalThis.fetch = async url => {
    seen.push(url);
    if (url.includes('redirect')) return new Response(null, { status: 302, headers: { Location: 'https://127.0.0.1/protected' } });
    if (url.includes('size')) return new Response(new Uint8Array(1024 * 1024 + 1));
    return new Response('<html>rate limit</html>');
  };
  const next = await mirrorSource(sourceOf([row('redirect'), row('size'), row('html')]), env, origin);
  assert.equal(seen.length, 3);
  assert.match(next.modules[0].mirror.error, /公开 HTTPS/);
  assert.match(next.modules[1].mirror.error, /1 MiB/);
  assert.match(next.modules[2].mirror.error, /网页/);
  assert.equal(files.size, 0);
});

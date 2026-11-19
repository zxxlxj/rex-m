import assert from 'node:assert/strict';
import {createHash, pbkdf2Sync} from 'node:crypto';
import {readFileSync} from 'node:fs';
import {DatabaseSync} from 'node:sqlite';
import {test} from 'node:test';
import {session, setup, login, logout} from '../src/auth.mjs';

const sql = readFileSync(new URL('../migrations/0002_auth.sql', import.meta.url), 'utf8');
const secret = 'test-only-high-entropy-setup-token';
const password = 'test password 火星🔑';
const credentials = {token:secret, password};
const sha = value => createHash('sha256').update(value).digest('hex');
const request = (ip = '192.0.2.1', cookie = '', url = 'https://hub.example.test/') =>
  new Request(url, {headers:{'CF-Connecting-IP':ip, Cookie:cookie}});
const cookie = response => response.headers.get('Set-Cookie').split(';')[0];

function fixture(t) {
  const sqlite = new DatabaseSync(':memory:');
  t.after(() => sqlite.close());
  sqlite.exec(sql);
  function prepare(statement, args = []) {
    return {
      bind: (...bindings) => prepare(statement, bindings),
      first: async () => sqlite.prepare(statement).get(...args) ?? null,
      run: async () => ({meta:{changes:sqlite.prepare(statement).run(...args).changes}}),
    };
  }
  const DB = {prepare, async batch(statements) {
    // Execute all synchronous SQLite calls before yielding, like a D1 transaction.
    sqlite.exec('BEGIN');
    try {
      const results = await Promise.all(statements.map(statement => statement.run()));
      sqlite.exec('COMMIT');
      return results;
    } catch (error) {
      sqlite.exec('ROLLBACK');
      throw error;
    }
  }};
  return {sqlite, env:{DB, SETUP_TOKEN:secret}};
}

test('setup once, persist only hashes, rotate session on login, and revoke on logout', async t => {
  const {sqlite, env} = fixture(t);
  const req = request();
  assert.deepEqual(await session(req, env), {initialized:false, authenticated:false});
  assert.equal((await login(req, env, {password})).status, 409);
  assert.equal((await setup(req, {...env, SETUP_TOKEN:''}, credentials)).status, 503);
  assert.equal((await setup(req, env, {token:'wrong',password})).status, 401);
  assert.equal((await setup(req, env, {token:secret,password:'short'})).status, 400);
  const response = await setup(req, env, credentials);
  const header = response.headers.get('Set-Cookie');
  assert.equal(response.status, 201);
  assert.match(header, /^__Host-rex_session=[a-f0-9]{64}; Path=\/; Max-Age=86400; HttpOnly; SameSite=Strict; Secure$/);
  assert.equal(response.headers.get('Cache-Control'), 'no-store');
  const admin = sqlite.prepare('SELECT * FROM auth_admin').get();
  assert.equal(admin.id, 1);
  assert.equal(admin.hash, pbkdf2Sync(password, Buffer.from(admin.salt, 'hex'), 100_000, 32, 'sha256').toString('hex'));
  assert.equal(sqlite.prepare('SELECT token_hash FROM auth_sessions').get().token_hash, sha(cookie(response).split('=')[1]));
  assert.equal((await setup(req, env, credentials)).status, 409);
  assert.equal((await login(req, env, {password:'wrong'})).status, 401);
  const previous = request('192.0.2.1', cookie(response));
  assert.deepEqual(await session(previous, env), {initialized:true, authenticated:true});
  assert.equal((await session(request('192.0.2.1', `${cookie(response)}; ${cookie(response)}`), env)).authenticated, false);
  const loggedIn = await login(previous, env, {password});
  assert.equal(loggedIn.status, 200);
  assert.notEqual(cookie(loggedIn), cookie(response));
  assert.equal((await session(previous, env)).authenticated, false);
  const current = request('192.0.2.1', cookie(loggedIn));
  const loggedOut = await logout(current, env);
  assert.match(loggedOut.headers.get('Set-Cookie'), /Max-Age=0; HttpOnly; SameSite=Strict; Secure$/);
  assert.equal((await session(current, env)).authenticated, false);
  assert.equal(sqlite.prepare('SELECT count(*) AS n FROM auth_sessions').get().n, 0);
});

test('concurrent setup has only one winner and session; expired session is rejected', async t => {
  const {sqlite, env} = fixture(t);
  const responses = await Promise.all([setup(request(), env, credentials), setup(request(), env, credentials)]);
  assert.deepEqual(responses.map(r => r.status).sort(), [201,409]);
  assert.equal(sqlite.prepare('SELECT count(*) AS n FROM auth_sessions').get().n, 1);
  assert.equal(responses.find(r => r.status === 409).headers.get('Set-Cookie'), null);
  const winner = request('192.0.2.1', cookie(responses.find(r => r.status === 201)));
  sqlite.exec('UPDATE auth_sessions SET expires_at=0');
  assert.deepEqual(await session(winner, env), {initialized:true, authenticated:false});
});

test('IP and global quotas share no partial increment and reset after expiry', async t => {
  const {sqlite, env} = fixture(t);
  const invalid = {...credentials, token:'invalid'};
  const requests = await Promise.all(Array.from({length:10}, () => setup(request(), env, invalid)));
  assert.equal(requests.filter(r => r.status === 401).length, 6);
  assert.equal(requests.filter(r => r.status === 429).length, 4);
  assert.equal(sqlite.prepare("SELECT count FROM auth_attempts WHERE bucket='setup:all'").get().count, 6);
  for (let i = 2; i <= 19; i++) {
    assert.equal((await setup(request(`192.0.2.${i}`), env, invalid)).status, 401);
  }
  const blocked = await setup(request('192.0.2.20'), env, credentials);
  assert.equal(blocked.status, 429);
  assert.equal(blocked.headers.get('Retry-After'), '900');
  sqlite.exec('UPDATE auth_attempts SET resets_at=0');
  assert.equal((await setup(request(), env, credentials)).status, 201);
  for (let i = 0; i < 8; i++) assert.equal((await login(request(), env, {password:'invalid'})).status, 401);
  assert.equal((await login(request(), env, {password})).status, 429);
  assert.equal((await login(request('192.0.2.2'), env, {password})).status, 200);
});

test('HTTP exception is opt-in, loopback-only and does not relax production cookies', async t => {
  const {env} = fixture(t);
  env.AUTH_ALLOW_INSECURE_LOCALHOST = '1';
  const local = request(undefined, '', 'http://127.0.0.1:8787');
  assert.equal((await setup(request(undefined, '', 'http://example.test'), env, credentials)).status, 400);
  const localResponse = await setup(local, env, credentials);
  assert.match(localResponse.headers.get('Set-Cookie'), /^rex_local_session=.*; HttpOnly; SameSite=Strict$/);
  assert.equal((await session(request(undefined, cookie(localResponse), local.url), env)).authenticated, true);
  assert.equal((await session(request(undefined, cookie(localResponse)), env)).authenticated, false);
  assert.match((await login(request(), env, {password})).headers.get('Set-Cookie'), /^__Host-rex_session=.*; Secure$/);
});

import { parseManifestLiteral } from './manifest-parser.mjs';
import { fetchMirrorBytes, contentMetadata } from './sources.mjs';

const BATCH = 3, DEFAULT_MINUTES = 30;
const SHA256 = /^[a-f0-9]{64}$/;
const REX_ENCRYPTED = /^\s*(?:\/\/\s*)?REXENC/i;
const BAD_META = /[\u0000-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069\ufffd]/u;
const utf8 = new TextDecoder('utf-8', { fatal: true });
const positive = n => typeof n === 'number' && Number.isFinite(n) && n > 0;
const validText = (s, n) => typeof s === 'string' && !!s.trim() && s.length <= n && !BAD_META.test(s);
const fields = m => validText(m?.id, 160) && /^[A-Za-z0-9_][A-Za-z0-9_.-]*$/.test(m.id) &&
  validText(m.title, 160) && validText(m.version, 48) && validText(m.requiredVersion, 48);

function localOrigin(value) {
  try {
    const u = new URL(value);
    if (u.protocol === 'https:' && !u.username && !u.password && u.href === `${u.origin}/`) return u.origin;
  } catch {}
  return '';
}

function eligible(source, m, origin) {
  return !source.paused && !m.paused && !m.pending &&
    (m.delivery === 'mirror' || (m.delivery !== 'link' && source.delivery === 'mirror')) &&
    typeof m.url === 'string' && !!m.url &&
    (!origin || (!m.url.startsWith(`${origin}/files/`) && !m.url.startsWith(`${origin}/m/`)));
}

function checkedAt(m, now) {
  const checked = Date.parse(m.mirror?.checkedAt);
  return Number.isFinite(checked) && checked <= now ? checked : -Infinity;
}

function dueAt(source, m, now) {
  const minutes = positive(m.refreshMinutes) ? m.refreshMinutes :
    positive(source.refreshMinutes) ? source.refreshMinutes : DEFAULT_MINUTES;
  const checked = checkedAt(m, now);
  return checked === -Infinity ? 0 : checked + minutes * 60_000;
}


export function mirrorDue(source, now = Date.now(), origin = source.origin) {
  const site = localOrigin(origin);
  let due = Infinity;
  for (const m of source.modules) if (eligible(source, m, site)) due = Math.min(due, dueAt(source, m, now));
  return due;
}

function snapshotVersion(module, bytes, contentType, effectiveUrl) {
  if (!bytes.length) throw new Error('上游模块为空');
  const mime = contentType.split(';', 1)[0].trim().toLowerCase();
  const head = new TextDecoder().decode(bytes.subarray(0, 512)).trimStart();
  if (/^<(?:!doctype\b|!--|\?xml\b|[a-z][a-z0-9:-]*(?:\s|\/?>))/i.test(head) || /^(?:text\/html|application\/(?:xhtml\+xml|xml|(?:[\w.-]+\+)?json)|text\/xml|image\/[^\s]+)$/.test(mime)) {
    throw new Error('上游返回的是网页、清单或图片，而不是模块');
  }
  let text;
  try { text = utf8.decode(bytes); } catch {                                                      }
  if (text !== undefined && !text.trim()) throw new Error('上游模块为空');

  const marker = REX_ENCRYPTED.test(text ?? head);
  if (marker) {

    const rest = (text ?? head).replace(REX_ENCRYPTED, '');
    if (!rest.replace(/^[\s:\d-]+/, '').trim() && (text !== undefined || bytes.length <= 512)) {
      throw new Error('上游 Rex 加密模块缺少有效内容');
    }
  } else if (text !== undefined) {
    if (text.includes('\0') && /\bWidgetMetadata\s*=/.test(text)) throw new Error('上游明文模块含有空字符');
    let metadata;
    try { metadata = parseManifestLiteral(text); } catch {                      }
    if (metadata !== undefined) {
      if (!fields(metadata) || !Array.isArray(metadata.modules)) throw new Error('上游 WidgetMetadata 不完整或无效');
      if (metadata.id !== module.id) throw new Error('上游 WidgetMetadata ID 与来源模块不一致');
      return { version: metadata.version.trim(), requiredVersion: metadata.requiredVersion.trim(), literal: true, ...contentMetadata(metadata) };
    }

    if (/\bWidgetMetadata\s*=/.test(text)) throw new Error('无法静态验证上游 WidgetMetadata');
    if (/^\s*[\[{]/.test(text)) {
      let json = false;
      try { JSON.parse(text); json = true; } catch {}
      if (json) throw new Error('上游返回的是 JSON，而不是模块');
    }
  }


  if (!fields(module)) throw new Error('不透明模块需要来源提供有效的 ID、标题、版本和所需版本');
  const scriptMime = /^(?:application|text)\/(?:javascript|ecmascript|x-javascript)$/.test(mime);
  const scriptPath = [module.url, effectiveUrl].some(url => /\.js$/i.test(new URL(url).pathname));
  if (!marker && !scriptMime && !scriptPath && mime !== 'application/octet-stream') {
    throw new Error('无法识别上游返回的模块内容');
  }
  if (!marker && text !== undefined && !text.includes('\0') &&
      !scriptMime && mime !== 'application/octet-stream' &&
      !/(?:[;={}()]|^\s*(?:\/\/|\/\*)|^\s*[A-Za-z0-9+/_=-]{32,}\s*$)/.test(text)) {
    throw new Error('上游文本不是可识别的模块内容');
  }
  return { version: module.version.trim(), requiredVersion: module.requiredVersion.trim(), literal: false, ...contentMetadata(module) };
}

async function digest(bytes) {
  return Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', bytes)), byte => byte.toString(16).padStart(2, '0')).join('');
}

async function check(module, env, site) {
  const remoteUrl = module.url;
  const previous = module.mirror;
  const success = previous?.url && previous.version && SHA256.test(previous.hash) ? previous : null;
  const timestamp = () => new Date().toISOString();
  let stage = 'prepare';
  try {
    if (!site) throw new Error('发布站点须为 HTTPS 源站地址');
    if (typeof env?.FILES?.put !== 'function') throw new Error('缺少 FILES 存储绑定');
    stage = 'download';
    const result = await fetchMirrorBytes(remoteUrl, success?.contentMetadataVersion===1 && success.remoteUrl === remoteUrl ? success : undefined);
    const { effectiveUrl, etag, lastModified } = result;
    const validators = etag || lastModified ? { effectiveUrl, ...(etag && { etag }), ...(lastModified && { lastModified }) } : {};
    if (result.unchanged) {
      const { version, requiredVersion, hash } = success;
      return { url: `${site}/files/${hash}.js`, version, requiredVersion, hash, remoteUrl, checkedAt: timestamp(), contentMetadataVersion:1, ...contentMetadata(success), ...validators };
    }
    stage = 'validate';
    const bytes = result.payload;
    const meta = snapshotVersion(module, bytes, result.contentType, effectiveUrl);
    const hash = await digest(bytes);
    const key = `files/${hash}.js`;
    if (hash !== success?.hash) {
      stage = 'store';
      await env.FILES.put(key, bytes, { httpMetadata: { contentType: 'text/plain; charset=utf-8', cacheControl: 'public, max-age=86400, immutable' } });
    }

    const keepVersion = !meta.literal && hash === success?.hash;
    const { version, requiredVersion } = keepVersion ? success : meta;
    return { url: `${site}/${key}`, version, requiredVersion, hash, remoteUrl, checkedAt: timestamp(), contentMetadataVersion:1, ...contentMetadata(keepVersion&&success.contentMetadataVersion===1?success:meta), ...validators };
  } catch (e) {

    const error = stage === 'store' ? '无法保存镜像文件' : e?.message || '无法检查镜像';
    return { ...(success || { url: '', version: '', hash: '', remoteUrl }), checkedAt: timestamp(), error };
  }
}

export async function mirrorSource(source, env, origin, { force = false, moduleId } = {}) {
  const next = { ...source, modules: source.modules.map(m => ({ ...m, ...(m.mirror && { mirror: { ...m.mirror } }) })) };
  const site = localOrigin(origin);
  const now = Date.now();
  const batch = next.modules
    .filter(m => eligible(source, m, site) && (moduleId === undefined || m.id === moduleId))
    .map(m => ({ m, due: dueAt(source, m, now), last: checkedAt(m, now) }))
    .filter(({ due }) => force || moduleId !== undefined || due <= now)
    .sort((a, b) => a.due - b.due || a.last - b.last)
    .slice(0, BATCH);
  await Promise.all(batch.map(async ({ m }) => { m.mirror = await check(m, env, site); }));
  return next;
}

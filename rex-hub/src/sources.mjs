import { parseManifestLiteral } from './manifest-parser.mjs';

const LIMIT = 8 * 1024 * 1024, UPLOAD_LIMIT = 2 * LIMIT, MAX_FILES = 32, MAX_ITEMS = 160;
const WRAPPER = 'rexnow.tv';
const REDIRECTS = new Set([301, 302, 303, 307, 308]);
const BAD_SUFFIX = /(?:^|\.)(?:localhost|local|localdomain|internal|intranet|lan|home|corp|onion|test|invalid|example|alt|arpa)$/i;
const BAD_CONTROL = /[\u0000-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069\ufffd]/u;
const FILE_KEY = /^\/files\/[a-f0-9]{64}\.js$/;
const SECRET = /token|(?:^|[_-])(?:key|secret|password|passwd|credential|authorization|auth|session|sig|signature|ticket|jwt|code)(?:$|[_-])|apikey|accesskey|privatekey|clientsecret|x-amz|x-goog|x-oss|^x-ms-|^cf-|^jwt$|^awsaccesskeyid$|^(?:policy|keypairid|key-pair-id|se|sp|sr|sv|skt|ske|skoid|sktid|sks|skv)$/i;
const own = (o, k) => Object.prototype.hasOwnProperty.call(o, k);
const object = v => v !== null && typeof v === 'object' && !Array.isArray(v);
const encrypted = s => /^\s*(?:\/\/\s*)?REXENC/i.test(s);
const encode = new TextEncoder();

function fail(message, status = 400) { throw Object.assign(new Error(message), { status }); }
function text(v, max, label, required = false) {
  if ((v == null || v === '') && !required) return '';
  if (typeof v !== 'string' || v.length > max || BAD_CONTROL.test(v) || (required && !v.trim())) fail(`${label}格式无效`);
  return v.trim();
}
function publicHost(host) {
  return host.length <= 253 && /^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z](?:[a-z0-9-]{0,61}[a-z0-9])$/i.test(host) && !BAD_SUFFIX.test(host) && !/\.(?:nip\.io|sslip\.io|xip\.io|localtest\.me|lvh\.me|localhost\.direct)$/i.test(`.${host}`);
}
function pathCheck(input) {
  const path = input.split(/[?#]/, 1)[0];
  for (const part of path.split('/')) {
    let s; try { s = decodeURIComponent(part); } catch { fail('网址路径编码无效'); }
    if (s === '..' || (s === '.' && part !== '.') || /[/\\%]/.test(s) || BAD_CONTROL.test(s)) fail('网址路径不安全');
  }
}
function publicUrl(value, base, wrapper = false) {
  const input = text(value, 2048, '网址', true);
  if (/[\\#]/.test(input) || input.startsWith('//') || (!base && !/^https:\/\/[^/]/i.test(input)) || (/^[a-z][a-z0-9+.-]*:/i.test(input) && !/^https:\/\/[^/]/i.test(input))) fail('只允许无凭据的公开 HTTPS 网址');
  pathCheck(input);
  let url; try { url = new URL(input, base); } catch { fail('网址无效'); }

  const authority = /^https:\/\/([^/?#]+)/i.exec(input)?.[1];
  if (url.protocol !== 'https:' || url.username || url.password || authority?.includes('@') || url.port || !publicHost(url.hostname)) fail('只允许无凭据的公开 HTTPS 网址');
  for (const [key, value] of url.searchParams) {
    if (key === 'url' && wrapper && url.hostname === WRAPPER && url.pathname === '/widget') continue;
    const name = key.toLowerCase().replace(/[\s.\[\]]+/g, '_');
    if (!/^[a-z0-9_-]{1,80}$/.test(name) || SECRET.test(name) || SECRET.test(name.replace(/[_-]/g, '')) || BAD_CONTROL.test(value) || /(?:^bearer\s|:\/\/[^/\s]*@|^eyJ[a-z0-9_-]+\.[a-z0-9_-]+\.[a-z0-9_-]+$)/i.test(value)) fail('网址不得包含疑似凭据的查询参数');
  }
  if (url.href.length > 2048) fail('网址过长');
  return url;
}
function sourceUrl(input) {
  let u = publicUrl(input, undefined, true);
  if (u.hostname === WRAPPER && u.pathname === '/widget') {
    const targets = u.searchParams.getAll('url');
    if (targets.length !== 1) fail('Rex 包装链接须包含一个 url 参数');
    u = publicUrl(targets[0]);
    if (u.hostname === WRAPPER && u.pathname === '/widget') fail('不接受嵌套 Rex 包装链接');
  }
  return u;
}
function publishUrl(value, base, leaf) {
  const u = publicUrl(value, base);
  if (leaf && (/\.(?:rex|json)\/?$/i.test(decodeURIComponent(u.pathname)) || (u.hostname === WRAPPER && u.pathname === '/widget'))) fail('合集不能包含嵌套索引或 Rex 包装链接');
  return u.href;
}
function safeHeader(v) { return typeof v === 'string' && /^[\x20-\x7e]{1,256}$/.test(v) ? v : ''; }
function stop(body) { try { void body?.cancel().catch(() => {}); } catch {} }

async function readBody(response, signal, raw) {
  if (Number(response.headers.get('Content-Length')) > LIMIT) { stop(response.body); fail('上游内容超过 8 MiB', 413); }
  if (!response.body) fail('上游响应没有内容', 502);
  const reader = response.body.getReader();
  let bytes = new Uint8Array(64 * 1024); let size = 0, done = false;
  const cancel = () => { void reader.cancel().catch(() => {}); };
  signal.addEventListener('abort', cancel, { once: true });
  try {
    for (;;) {
      const item = await reader.read();
      if (signal.aborted) fail('上游请求超时', 504);
      if (item.done) { done = true; break; }
      if (size + item.value.byteLength > LIMIT) fail('上游内容超过 8 MiB', 413);
      const end=size+item.value.byteLength;
      if(end>bytes.length){const larger=new Uint8Array(Math.min(LIMIT,Math.max(end,bytes.length*2)));larger.set(bytes);bytes=larger;}
      bytes.set(item.value, size); size=end;
    }
    const payload = bytes.subarray(0, size);
    if (raw) return payload;
    try { return new TextDecoder('utf-8', { fatal: true }).decode(payload); }
    catch { fail('上游内容不是有效的 UTF-8', 422); }
  } finally {
    signal.removeEventListener('abort', cancel);
    if (!done) cancel();
    reader.releaseLock();
  }
}

async function fetchSource(initial, previous, { raw = false, timeoutMs = 10_000 } = {}) {
  const controller = new AbortController();
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => { controller.abort(); reject(Object.assign(new Error('上游请求超时'), { status: 504 })); }, timeoutMs);
  });
  const seen = new Set(); let u = initial;
  try {
    for (let hop = 0; ; hop++) {
      if (seen.has(u.href)) fail('上游重定向循环', 422);
      seen.add(u.href);
      const accept = raw ? 'application/javascript, text/javascript, text/plain, application/octet-stream, */*;q=0.1' : 'application/json, application/javascript, text/plain, */*;q=0.1';
      const headers = new Headers({ Accept: accept, 'Cache-Control': 'no-cache' });

      if (previous?.effectiveUrl === u.href) {
        if (safeHeader(previous.etag)) headers.set('If-None-Match', previous.etag);
        if (safeHeader(previous.lastModified)) headers.set('If-Modified-Since', previous.lastModified);
      }
      const sent = headers.has('If-None-Match') || headers.has('If-Modified-Since');
      let r;
      try { r = await Promise.race([fetch(u.href, { method: 'GET', redirect: 'manual', headers, signal: controller.signal }), timeout]); }
      catch { if (controller.signal.aborted) fail('上游请求超时', 504); fail('无法连接来源服务器', 502); }
      if (REDIRECTS.has(r.status)) {
        stop(r.body);
        const next = r.headers.get('Location');
        if (!next || hop >= 3) fail('上游重定向无效或过多', 422);
        u = publicUrl(next, u.href);
        if (u.hostname === WRAPPER && u.pathname === '/widget') fail('上游不能重定向到 Rex 包装链接', 422);
        continue;
      }
      const etag = safeHeader(r.headers.get('ETag')), lastModified = safeHeader(r.headers.get('Last-Modified'));
      if (r.status === 304 && sent) {
        stop(r.body);
        return { unchanged: true, effectiveUrl: u.href, etag: etag || previous.etag, lastModified: lastModified || previous.lastModified };
      }
      if (r.status !== 200) { stop(r.body); fail(`来源请求失败（HTTP ${r.status}）`, 422); }
      let payload;
      try { payload = await Promise.race([readBody(r, controller.signal, raw), timeout]); }
      catch (e) { if (controller.signal.aborted) fail('上游请求超时', 504); if (e?.status) throw e; fail('无法完整读取上游内容', 502); }
      return { payload, effectiveUrl: u.href, etag, lastModified, ...(raw && { contentType: safeHeader(r.headers.get('Content-Type')) }) };
    }
  } finally { clearTimeout(timer); }
}


export function fetchMirrorBytes(url, previous) {
  return fetchSource(publicUrl(url), previous, { raw: true, timeoutMs: 8_000 });
}

export const CONTENT_TYPES = Object.freeze(['video','music','audiobook','shortDrama']);
export function contentMetadata(m){
  return {...(CONTENT_TYPES.includes(m?.contentType)?{contentType:m.contentType}:{}),...(typeof m?.continuousPlay==='boolean'?{continuousPlay:m.continuousPlay}:{})};
}
const META = ['id', 'title', 'version', 'requiredVersion', 'author', 'icon', 'description', 'contentType', 'continuousPlay'];
function manualMetadata(input, base) {
  if (input == null) return {};
  if (!object(input)) fail('手动元数据须为对象');
  const result = Object.fromEntries(META.filter(k => own(input, k) && !['contentType','continuousPlay'].includes(k)).map(k => [k, text(input[k], k === 'icon' ? 2048 : k === 'description' ? 500 : 160, '手动元数据')]));
  if (result.icon) result.icon = publishUrl(result.icon, base, false);
  return {...result,...contentMetadata(input)};
}
function moduleMeta(m, base, options = {}) {
  if (!object(m)) fail('模块元数据无效', 422);
  const id = text(m.id, 160, '模块 ID', true);
  if (!/^[A-Za-z0-9_][A-Za-z0-9_.-]*$/.test(id)) fail('模块 ID 只能使用英文字母、数字、下划线、点和连字符', 422);
  const icon = options.js ? (m.iconurl ?? m.iconUrl ?? m.iconURL ?? m.icon) : (m.icon ?? m.iconurl ?? m.iconUrl ?? m.iconURL);
  return {
    ...contentMetadata(m),
    id, title: text(m.title, 160, '模块标题', true), version: text(m.version, 48, '模块版本', true),
    requiredVersion: text(m.requiredVersion, 48, '模块所需版本', true), author: text(m.author, 120, '模块作者'),
    icon: icon ? publishUrl(icon, base, false) : text(icon, 2048, '图标网址'), description: text(m.description, 500, '模块描述')
  };
}
function moduleOf(meta, url) {
  return { ...meta, url, paused: false, disabled: false, categoryId: '', removed: false };
}
function jsMeta(payload, base, fallback) {
  if (!payload.trim() || /\u0000/.test(payload)) fail('模块文件为空或包含二进制内容', 422);
  if (encrypted(payload)) {
    if (!/^\s*(?:\/\/\s*)?REXENC\s*[:\d\r\n\t -]*\S/i.test(payload) || /^\s*(?:\/\/\s*)?REXENC\s*:?\s*$/i.test(payload)) fail('加密模块缺少有效内容', 422);
    if (!fallback?.id || !fallback.title || !fallback.version || !fallback.requiredVersion) fail('加密模块需要合集清单或手动提供 ID、标题、版本和所需版本', 422);
    return moduleMeta(fallback, base);
  }
  let manifest;
  try { manifest = parseManifestLiteral(payload); } catch { fail('无法静态读取 WidgetMetadata：请确认顶层声明包含可读取的 ID、标题、版本和 modules 数组', 422); }
  if (!object(manifest) || !Array.isArray(manifest.modules)) fail('WidgetMetadata 缺少 modules 数组', 422);
  return moduleMeta(manifest, base, { js: true });
}
function indexData(payload) {
  let index; try { index = JSON.parse(payload.replace(/^\uFEFF/, '')); } catch { fail('合集必须是有效的 JSON', 422); }
  if (!object(index) || !own(index, 'widgets') || !Array.isArray(index.widgets)) fail('合集必须包含 widgets 数组（允许为空）', 422);
  if (index.widgets.length > MAX_ITEMS) fail(`每个来源最多 ${MAX_ITEMS} 个模块`, 413);
  const label = text(index.title ?? index.name, 160, '合集标题');
  const author = typeof index.author === 'string' && index.author.length <= 120 && !BAD_CONTROL.test(index.author) ? index.author.trim() : '';
  return { rows: index.widgets, label, author, icon: index.icon || index.logo || index.iconURL || '' };
}
function sourceIcon(value,base){try{return value?publishUrl(value,base,false):'';}catch{return '';}}
function assertRow(row) {
  if (!object(row) || own(row, 'widgets')) fail('合集条目无效或含嵌套索引', 422);
  return text(row.url, 2048, '合集模块网址', true);
}
function unique(modules) {
  const ids = new Set(), urls = new Set();
  for (const m of modules) {
    if (ids.has(m.id) || urls.has(m.url)) fail('同一来源内存在重复的模块 ID 或 URL', 422);
    ids.add(m.id); urls.add(m.url);
  }
  return modules;
}
function parseOnline(payload, source, effective, manual) {
  if (/\.(?:rex|json)\/?$/i.test(decodeURIComponent(new URL(effective).pathname)) || /\.(?:rex|json)\/?$/i.test(decodeURIComponent(new URL(source).pathname)) || /^[\s\uFEFF]*[\[{]/.test(payload)) {
    const { rows, label, author, icon } = indexData(payload);
    const modules = unique(rows.map(row => {
      const url = publishUrl(assertRow(row), effective, true);
      if (url === effective || url === source) fail('合集不能引用自身', 422);
      return moduleOf(moduleMeta(row, effective), url);
    }));
    return { modules, label, author, icon:sourceIcon(icon,effective), kind: 'online-index' };
  }
  const meta = jsMeta(payload, effective, manual);
  return { modules: [moduleOf(meta, effective)], label: meta.title, author:meta.author, icon:meta.icon, kind: 'online-module' };
}

function importFiles(files) {
  if (!Array.isArray(files) || !files.length) fail('请选择至少一个文件');
  if (files.length > MAX_FILES) fail(`每次最多上传 ${MAX_FILES} 个文件`, 413);
  const names = new Set(), result = []; let total = 0;
  for (const f of files) {
    if (!object(f) || typeof f.name !== 'string' || typeof f.text !== 'string') fail('上传文件格式无效');
    const name = f.name;
    if (name.length > 180 || name !== name.trim() || name.startsWith('.') || /[/\\%?#:\u0000-\u001f\u007f]/.test(name) || BAD_CONTROL.test(name) || !/\.(?:js|rex)$/i.test(name)) fail('文件名无效，仅允许 .js 或 .rex 文件名，不含路径');
    if (names.has(name.toLowerCase())) fail('上传的文件名重复', 422);
    names.add(name.toLowerCase());
    if (f.text.length > LIMIT) fail('单个文件不能超过 8 MiB', 413);

    if (/[\uD800-\uDFFF]/u.test(f.text)) fail('文件内容不是有效的 Unicode', 422);
    const bytes = encode.encode(f.text); total += bytes.length;
    if (!bytes.length) fail('不能上传空文件', 422);
    if (bytes.length > LIMIT || total > UPLOAD_LIMIT) fail('单个文件最多 8 MiB，总计最多 16 MiB', 413);
    result.push({ name, payload: f.text, bytes, index: /\.rex$/i.test(name) });
  }
  return result;
}
function companionName(spec, base) {
  if (/^https:\/\//i.test(spec)) {
    const target = publicUrl(spec);
    if (!base) return decodeURIComponent(target.pathname.split('/').at(-1));
    const directory = new URL('.', base);
    if (target.origin !== directory.origin || !target.pathname.startsWith(directory.pathname)) return '';
    const tail = target.pathname.slice(directory.pathname.length);
    return tail && !tail.includes('/') ? decodeURIComponent(tail) : '';
  }
  const path = spec.split('?', 1)[0].replace(/^(?:\.\/)+/, '');
  pathCheck(spec);
  return path && !path.includes('/') ? decodeURIComponent(path) : '';
}
async function hash(bytes) {
  return Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', bytes)), x => x.toString(16).padStart(2, '0')).join('');
}
async function parseUpload(input, env, origin) {
  const files = importFiles(input.files);
  const indexes = files.filter(f => f.index), js = files.filter(f => !f.index);
  if (indexes.length > 1) fail('每次最多上传一个合集索引', 422);
  const base = input.baseUrl ? publicUrl(input.baseUrl).href : undefined;
  const manual = manualMetadata(input.metadata, base);
  const stored = new Map(), consumed = new Set();
  let localOrigin;
  async function uploadModule(file, row) {
    if (!localOrigin) {
      const local = publicUrl(origin);
      if (local.pathname !== '/' || local.search) fail('发布站点须为公开 HTTPS 源站地址', 422);
      localOrigin = local.origin;
    }
    const fallback = row ? { ...manual, ...Object.fromEntries(META.filter(k => row[k] != null && row[k] !== '').map(k => [k, row[k]])), icon: row.icon || row.iconurl || row.iconUrl || row.iconURL || manual.icon } : (js.length === 1 ? manual : {});

    const meta = jsMeta(file.payload, base, fallback);
    if (row && own(row, 'id') && text(row.id, 160, '合集模块 ID', true) !== meta.id) fail('合集模块 ID 与上传文件不一致', 422);
    const path = `/files/${await hash(file.bytes)}.js`;
    if (!FILE_KEY.test(path)) fail('文件路径无效', 500);
    stored.set(path.slice(1), file.bytes);
    return moduleOf(meta, localOrigin + path);
  }
  const modules = []; let label, author, icon;
  if (indexes.length) {
    const index = indexData(indexes[0].payload);
    label = index.label || indexes[0].name;
    author = index.author;
    icon=sourceIcon(index.icon,base);
    const byName = new Map(js.map(f => [f.name, f]));
    for (const row of index.rows) {
      const spec = assertRow(row);


      const url = /^https:\/\//i.test(spec) || base ? publishUrl(spec, base, true) : '';
      const localName = companionName(spec, base), file = byName.get(localName);
      if (file) {
        if (!url && spec.includes('?')) fail('本地文件引用不得包含查询参数', 422);
        if (consumed.has(file)) fail('合集重复引用同一上传文件', 422);
        consumed.add(file);
        modules.push(await uploadModule(file, row));
      } else {
        if (!url) fail('相对模块地址需要同名上传文件或基础 URL', 422);
        modules.push(moduleOf(moduleMeta(row, base), url));
      }
    }
    if (js.some(f => !consumed.has(f))) fail('有上传的 JS 文件未被合集引用', 422);
  } else {
    for (const f of js) modules.push(await uploadModule(f));
    label = modules.length === 1 ? modules[0].title : js[0].name;
  }
  unique(modules);
  if (stored.size) {
    if (typeof env?.FILES?.put !== 'function') fail('缺少 FILES 存储绑定', 500);

    try { for (const [key, bytes] of stored) await env.FILES.put(key, bytes, { httpMetadata: { contentType: 'text/plain; charset=utf-8', cacheControl: 'public, max-age=86400, immutable' } }); }
    catch { fail('无法保存上传文件', 503); }
  }
  return { modules, label, author:author??(modules.length===1?modules[0].author:''), icon:icon||modules[0]?.icon||'', kind: indexes.length ? 'upload-index' : 'upload-modules' };
}

const now = () => new Date().toISOString();
export async function ingest(input, env, origin) {
  if (!object(input)) fail('来源输入无效');
  const remote = input.url != null && input.url !== '', local = input.files != null;
  if (remote === local) fail('请只选择链接或文件其中一种来源');
  const categoryId = text(input.categoryId, 64, '分类 ID');
  const source = { id: crypto.randomUUID(), url: '', categoryId, paused: false };
  if (local) return { ...source, ...await parseUpload(input, env, origin), status: '静态上传', checkedAt: now() };
  const u = sourceUrl(input.url);
  const result = await fetchSource(u);
  const meta = manualMetadata(input.metadata, result.effectiveUrl);
  const parsed = parseOnline(result.payload, u.href, result.effectiveUrl, meta);
  const { effectiveUrl, etag, lastModified } = result;
  return { ...source, ...parsed, url: u.href, label: parsed.label || u.hostname, status: '正常', checkedAt: now(), contentMetadataVersion:1, effectiveUrl, etag, lastModified, manualMetadata: meta };
}

const override = m => ({ paused: !!m.paused, disabled: !!m.disabled, categoryId: m.categoryId || '', ...(m.autoCategoryFallbackId&&{autoCategoryFallbackId:m.autoCategoryFallbackId}) });
const RETAIN_MS = 30 * 24 * 60 * 60 * 1000;
function reconcile(previous, incoming) {
  const time = Date.now();
  const tombs = new Map((previous.moduleOverrides || []).filter(x => x.until > time).map(x => [x.id, x]));
  const old = new Map(previous.modules.map(m => [m.id, m]));
  const modules = incoming.map(m => {
    const last = old.get(m.id), saved = last || tombs.get(m.id);
    old.delete(m.id); tombs.delete(m.id);
    return last?.paused ? { ...last, removed: false } : saved ? { ...m, ...override(saved) } : m;
  });
  for (const m of old.values()) {

    if (m.paused) modules.push({ ...m, removed: true });
    else if (m.disabled || m.categoryId || m.autoCategoryFallbackId) tombs.set(m.id, { id: m.id, ...override(m), until: time + RETAIN_MS });
  }
  const moduleOverrides = [...tombs.values()].sort((a, b) => b.until - a.until).slice(0, MAX_ITEMS);
  if (modules.length > MAX_ITEMS) fail('上游模块与已暂停模块合计超过来源上限', 413);
  return { modules: unique(modules), moduleOverrides };
}
export async function refresh(source, env, _origin) {
  if (source.paused || !source.url) return source;
  const u = sourceUrl(source.url);
  const result = await fetchSource(u, source.contentMetadataVersion===1&&typeof source.author==='string'?source:undefined);
  const { effectiveUrl, etag, lastModified } = result;
  const info = { checkedAt: now(), effectiveUrl, etag, lastModified, status: '正常', contentMetadataVersion:1 };
  if (result.unchanged) return { ...source, ...info };
  const parsed = parseOnline(result.payload, u.href, effectiveUrl, source.manualMetadata || {});
  if (source.kind && source.kind !== parsed.kind) fail('来源内容类型已变化，需重新导入', 422);
  return { ...source, ...info, kind: parsed.kind, label:parsed.label||u.hostname, author:parsed.author, icon:parsed.icon, ...reconcile(source, parsed.modules) };
}

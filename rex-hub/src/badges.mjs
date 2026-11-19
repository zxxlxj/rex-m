// Auth and the 10 MiB POST parser belong to the Worker router. Bind DB and
// FILES (put/get/delete, with the same body contract as the hub's file routes).
// One UTC day's badge work reserves at most 850 KV puts and 850 deletes,
// conservatively including failures. Other hub writes share the account quota;
// coordinate large imports and mirrors. KV visibility can lag after a write.
const MiB = 1024 * 1024, BATCH = 8, PAGE = 48, QUOTA = 850;
const ID = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/;
const CONTROL = /[\u0000-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069\ufffd]/u;
const BAD_SUFFIX = /(?:^|\.)(?:localhost|local|localdomain|internal|intranet|lan|home|corp|onion|test|invalid|example|alt|arpa)$/i;
const SECRET = /token|(?:^|[_-])(?:key|secret|password|passwd|credential|authorization|auth|session|sig|signature|ticket|jwt|code)(?:$|[_-])|apikey|accesskey|privatekey|clientsecret|x-amz|x-goog|x-oss|^x-ms-|^cf-|^jwt$|^awsaccesskeyid$|^(?:policy|keypairid|key-pair-id|se|sp|sr|sv|skt|ske|skoid|sks|skv)$/i;
const REDIRECT = new Set([301, 302, 303, 307, 308]);
const TYPES = ['', 'image/png', 'image/jpeg', 'image/gif', 'image/webp', 'image/avif', 'image/svg+xml'];
const enc = new TextEncoder(), dec = new TextDecoder('utf-8', { fatal: true });
const guard = "EXISTS (SELECT 1 FROM badge_state WHERE id=1 AND lock_token=?)";
const headers = { 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'no-referrer' };
const imageHeaders = { ...headers, 'Content-Security-Policy': "sandbox; default-src 'none'; style-src 'unsafe-inline'; frame-ancestors 'none'", 'X-Frame-Options': 'DENY' };
const json = (o, status = 200) => new Response(JSON.stringify(o), { status, headers: { ...headers, 'Content-Type': 'application/json; charset=utf-8' } });
const say = (req, msg, status, extra) => new Response(req.method === 'HEAD' ? null : msg, { status, headers: { ...headers, 'Content-Type': 'text/plain; charset=utf-8', ...extra } });
const object = o => o !== null && typeof o === 'object' && !Array.isArray(o);
const owns = (o, k) => Object.hasOwn(o, k);
function fail(message, status = 400) { throw Object.assign(new Error(message), { status }); }
function str(v, max, label) {
  if (typeof v !== 'string' || v.length > max || CONTROL.test(v)) fail(`${label}格式无效`);
  return v.trim();
}

// Same URL restrictions as sources.mjs publicUrl (no Rex wrapper exception).
function publicUrl(value, base) {
  const input = str(value, 2048, '网址');
  const https = /^https:\/\/[^/]/i;
  if (!input || /[\\#]/.test(input) || input.startsWith('//') || (!base && !https.test(input)) || (/^[a-z][a-z0-9+.-]*:/i.test(input) && !https.test(input))) fail('只允许无凭据的公开 HTTPS 网址');
  for (const part of input.split(/[?#]/, 1)[0].split('/')) {
    let s; try { s = decodeURIComponent(part); } catch { fail('网址路径编码无效'); }
    if (s === '..' || (s === '.' && part !== '.') || /[/\\%]/.test(s) || CONTROL.test(s)) fail('网址路径不安全');
  }
  let u; try { u = new URL(input, base); } catch { fail('网址无效'); }
  const host = u.hostname;
  if (u.protocol !== 'https:' || u.username || u.password || /^https:\/\/([^/?#]+)/i.exec(input)?.[1]?.includes('@') || u.port || host.length > 253 || !/^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z](?:[a-z0-9-]{0,61}[a-z0-9])$/i.test(host) || BAD_SUFFIX.test(host) || /\.(?:nip\.io|sslip\.io|xip\.io|localtest\.me|lvh\.me|localhost\.direct)$/i.test(`.${host}`)) fail('只允许无凭据的公开 HTTPS 网址');
  for (const [k,v] of u.searchParams) {
    const name = k.toLowerCase().replace(/[\s.\[\]]+/g, '_');
    if (!/^[a-z0-9_-]{1,80}$/.test(name) || SECRET.test(name) || SECRET.test(name.replace(/[_-]/g, '')) || CONTROL.test(v) || /(?:^bearer\s|:\/\/[^/\s]*@|^eyJ[a-z0-9_-]+\.[a-z0-9_-]+\.[a-z0-9_-]+$)/i.test(v)) fail('网址不得包含疑似凭据的查询参数');
  }
  if (u.href.length > 2048) fail('网址过长');
  return u;
}
function cancel(body) { try { void body?.cancel().catch(() => {}); } catch {} }
async function load(initial, image = false) {
  const cap = (image ? 2 : 10) * MiB, controller = new AbortController();
  let u = publicUrl(initial); const seen = new Set();
  const timer = setTimeout(() => controller.abort(), image ? 7_000 : 12_000);
  try {
    for (let hop = 0; ; hop++) {
      if (seen.has(u.href)) fail('上游重定向循环', 422);
      seen.add(u.href);
      const r = await fetch(u.href, { redirect: 'manual', signal: controller.signal, headers: { Accept: image ? 'image/*, application/octet-stream;q=0.5' : 'application/json, text/plain;q=0.5' } });
      if (REDIRECT.has(r.status)) {
        cancel(r.body);
        const loc = r.headers.get('Location');
        if (!loc || hop >= (image ? 1 : 3)) fail('上游重定向无效或过多', 422);
        u = publicUrl(loc, u.href);
        continue;
      }
      if (r.status !== 200 || !r.body) { cancel(r.body); fail(`上游请求失败（HTTP ${r.status}）`, 422); }
      if (Number(r.headers.get('Content-Length')) > cap) { cancel(r.body); fail('上游文件超过大小限制', 413); }
      const reader = r.body.getReader(), chunks = [];
      let n = 0, done = false;
      const abort = () => { void reader.cancel().catch(() => {}); };
      controller.signal.addEventListener('abort', abort, { once: true });
      try {
        for (;;) {
          const item = await reader.read();
          if (controller.signal.aborted) fail('上游请求超时', 504);
          if (item.done) { done = true; break; }
          n += item.value.byteLength;
          if (n > cap) fail('上游文件超过大小限制', 413);
          chunks.push(item.value);
        }
      } finally {
        controller.signal.removeEventListener('abort', abort);
        if (!done) abort();
        reader.releaseLock();
      }
      const bytes = new Uint8Array(n);
      let offset = 0; for (const part of chunks) { bytes.set(part, offset); offset += part.byteLength; }
      return { bytes, url: u.href };
    }
  } catch (e) {
    if (controller.signal.aborted) fail('上游请求超时', 504);
    if (e?.status) throw e;
    fail('无法完整读取上游内容', 502);
  } finally { clearTimeout(timer); }
}

// Review/display imageURL fields only. Regex patterns, SVG data, colors and
// unknown schema fields remain inert JSON data; nothing is evaluated.
function visit(root, f, depth = 0) {
  if (depth > 48) fail('徽章包 JSON 嵌套过深', 422);
  if (!root || typeof root !== 'object') return;
  if (Array.isArray(root)) { for (const v of root) visit(v, f, depth + 1); return; }
  for (const k of Object.keys(root)) {
    if (k === 'imageURL') f(root);
    else visit(root[k], f, depth + 1);
  }
}
function compile(text, base) {
  let data;
  try { data = JSON.parse(text.replace(/^\uFEFF/, '')); } catch { fail('徽章包必须是有效的 JSON', 422); }
  if (!object(data) || !Array.isArray(data.groups) || !Array.isArray(data.filters)) fail('徽章包必须包含 groups 和 filters 数组', 422);
  if (data.groups.length > 500 || data.filters.length > 5000) fail('徽章包分组或规则过多', 413);
  const groups = new Set();
  for (const g of data.groups) {
    if (!object(g) || typeof g.id !== 'string' || !g.id || g.id.length > 160 || typeof g.name !== 'string' || groups.has(g.id)) fail('徽章分组无效或 ID 重复', 422);
    groups.add(g.id);
  }
  for (const f of data.filters) {
    if (!object(f) || typeof f.name !== 'string' || (f.groupId != null && typeof f.groupId !== 'string')) fail('徽章规则无效', 422);
  }
  const targets = [], slots = new Map(), byValue = Object.create(null);
  visit(data, obj => {
    const raw = obj.imageURL;
    if (raw === '' || raw == null) return;
    if (typeof raw !== 'string') fail('imageURL 必须是字符串', 422);
    if (owns(byValue, raw)) return;
    const url = publicUrl(raw, base).href;
    if (!slots.has(url)) { slots.set(url, targets.length); targets.push(url); }
    byValue[raw] = slots.get(url);
    if (targets.length > 5000) fail('徽章包图片过多', 413);
  });
  return { data, targets, byValue };
}
function mime(bytes) {
  const starts = (...seq) => seq.every((v,i) => bytes[i] === v);
  const ascii = (i, s) => [...s].every((c,j) => bytes[i+j] === c.charCodeAt(0));
  if (starts(137,80,78,71,13,10,26,10)) return 1;
  if (starts(255,216,255)) return 2;
  if (ascii(0,'GIF87a') || ascii(0,'GIF89a')) return 3;
  if (ascii(0,'RIFF') && ascii(8,'WEBP')) return 4;
  if (ascii(4,'ftyp') && (ascii(8,'avif') || ascii(8,'avis'))) return 5;
  // Recognize the document root, not an <svg> nested in arbitrary HTML.
  // SVG is never parsed or rendered here. Permit a conventional public DTD
  // declaration (no internal subset) and keep the browser response sandboxed.
  try {
    let head = new TextDecoder().decode(bytes.subarray(0,4096)).trimStart();
    if (/^<\?xml\s/.test(head)) head = head.replace(/^<\?xml\s[^?]*\?>\s*/, '');
    for (let i = 0; i < 8; i++) {
      const rest = head.replace(/^(?:<!--[\s\S]*?-->|<!DOCTYPE\s+svg(?:\s+(?:PUBLIC\s+"[^"]*"\s+"[^"]*"|SYSTEM\s+"[^"]*"))?\s*>)\s*/, '');
      if (rest === head) break;
      head = rest;
    }
    if (/^<svg(?:\s|\/?>)/.test(head)) return 6;
  } catch {}
  fail('上游不是支持的 PNG、JPEG、GIF、WebP、AVIF 或 SVG 图片', 422);
}

const sql = (env, q, ...args) => env.DB.prepare(q).bind(...args);
const first = (env, q, ...a) => sql(env, q, ...a).first();
const run = (env, q, ...a) => sql(env, q, ...a).run();
const rows = async (env, q, ...a) => (await sql(env, q, ...a).all()).results;
const now = () => Date.now();
const day = () => new Date().toISOString().slice(0,10);
const sourceKey = id => `badge-source/${id}.json`;
const planKey = id => `badge-source/${id}.plan`;
const assetKey = (id,g,s) => `badge-assets/${id}/${g}-${s}`;
const ready = p => p.mode === 'link' || p.done === p.assets;
const pending = p => p.mode === 'host' && (p.cursor < p.assets || p.retry_cursor != null);
const item = p => ({ id:p.id, alias:p.alias, mode:p.mode, url:p.url, groups:p.groups, filters:p.filters,
  assets:p.assets, done:p.done, failed:p.failed, status:ready(p) ? 'ready' : pending(p) ? 'queued' : 'error', ...(p.error && {error:p.error}) });
function packId(id) { if (typeof id !== 'string' || !ID.test(id)) fail('徽章包 ID 无效'); return id; }
async function pack(env,id) {
  const p = await first(env,'SELECT * FROM badge_packs WHERE id=? AND deleting=0',packId(id));
  if (!p) fail('徽章包不存在',404);
  return p;
}
async function lock(env, action, cron = false) {
  const token = crypto.randomUUID(), n = now();
  const result = await run(env,'UPDATE badge_state SET lock_token=?,lock_until=? WHERE id=1 AND lock_until<=?',token,n+600_000,n);
  if (!result.meta.changes) { if (cron) return; fail('徽章任务处理中，请稍后重试',409); }
  try { return await action(token); }
  finally { await run(env,'UPDATE badge_state SET lock_token=NULL,lock_until=0 WHERE id=1 AND lock_token=?',token); }
}
async function budget(env, kind) {
  const d = day();
  const row = await first(env,'SELECT quota_day,puts,deletes FROM badge_state WHERE id=1');
  return {d, n:row.quota_day === d ? QUOTA-row[kind] : QUOTA};
}
function debit(env,t,d,puts,deletes) {
  return sql(env,`UPDATE badge_state SET puts=(CASE WHEN quota_day=? THEN puts ELSE 0 END)+?,
    deletes=(CASE WHEN quota_day=? THEN deletes ELSE 0 END)+?,quota_day=? WHERE id=1 AND lock_token=?`,d,puts,d,deletes,d,t);
}
async function body(file) {
  if (!file) return null;
  if (file.body instanceof Uint8Array) return file.body;
  if (file.body instanceof ArrayBuffer) return new Uint8Array(file.body);
  return new Uint8Array(await new Response(file.body).arrayBuffer());
}
async function source(env,p) {
  const bytes = await body(await env.FILES.get(sourceKey(p.id)));
  if (!bytes) fail('徽章源文件暂不可读，请稍后重试',503);
  return compile(dec.decode(bytes),p.base || undefined);
}
function baseOrigin(env, url) {
  const u = new URL(env.PUBLIC_ORIGIN || url.origin);
  if (!['https:','http:'].includes(u.protocol) || u.username || u.password) fail('公开站点地址无效',500);
  return u.origin;
}
function previewItem(f,plan,p,origin) {
  const slot = plan.byValue[f.imageURL], external = slot == null ? '' : plan.targets[slot];
  return { name:f.name, groupId:f.groupId ?? '', imageURL:p.mode==='host' && ready(p) && external ? `${origin}/${assetKey(p.id,p.generation,slot)}` : external,
    tagColor:typeof f.tagColor==='string'?f.tagColor:'', textColor:typeof f.textColor==='string'?f.textColor:'', borderColor:typeof f.borderColor==='string'?f.borderColor:'' };
}
async function preview(env,url) {
  const p = await pack(env,url.searchParams.get('id')), plan = await source(env,p);
  const q = str(url.searchParams.get('q') ?? '',200,'搜索').toLowerCase(), group = url.searchParams.get('group');
  const page = Number(url.searchParams.get('page') ?? 1);
  if (!Number.isSafeInteger(page) || page<1 || page>100_000) fail('页码无效');
  const results = plan.data.filters.filter(f => (!group || f.groupId===group) && (!q || f.name.toLowerCase().includes(q)));
  const origin = baseOrigin(env,url);
  return { groups:plan.data.groups.map(({id,name}) => ({id,name})), items:results.slice((page-1)*PAGE,page*PAGE).map(f=>previewItem(f,plan,p,origin)), total:results.length, page, pageSize:PAGE };
}
function getMode(v) { if (v !== 'host' && v !== 'link') fail('徽章包模式无效'); return v; }
async function importPack(env,a) {
  const mode = getMode(a.mode), remote = owns(a,'url');
  if (remote === owns(a,'text')) fail('请选择 JSON 网址或文件，不能同时提供');
  let url='', base='', fallback, bytes, text;
  if (remote) {
    url = publicUrl(a.url).href;
    const fetched = await load(url);
    bytes = fetched.bytes; base = fetched.url;
    fallback = new URL(url).pathname.split('/').at(-1) || new URL(url).hostname;
    try { text = dec.decode(bytes); } catch { fail('上游徽章包不是有效 UTF-8',422); }
  } else {
    if (mode!=='host') fail('本地 JSON 只能使用托管模式');
    fallback = a.filename == null ? '徽章包' : str(a.filename,180,'文件名');
    if (typeof a.text!=='string' || a.text.length>10*MiB) fail('本地徽章包过大或无效',413);
    bytes = enc.encode(a.text); text = a.text;
    if (bytes.byteLength>10*MiB) fail('本地徽章包超过 10 MiB',413);
    base = a.baseUrl ? publicUrl(a.baseUrl).href : '';
  }
  const alias = (a.alias == null ? '' : str(a.alias,120,'别名')) || fallback.slice(0,120) || '徽章包';
  const {data,targets} = compile(text,base || undefined), id = crypto.randomUUID();
  await lock(env,async t => {
    const {d,n} = await budget(env,'puts');
    if (n<2) fail('今日徽章写入预算已用完，请在 UTC 日期变更后重试',429);
    const time = now();
    // Stage a tombstone before writing KV so a killed import can be cleaned up.
    await env.DB.batch([debit(env,t,d,2,0),sql(env,`INSERT INTO badge_packs
      (id,alias,mode,url,base,groups,filters,assets,created,touched,deleting,cleanup)
      SELECT ?,?,?,?,?,?,?,?,?,?,1,1 WHERE ${guard}`,id,alias,mode,url,base,data.groups.length,data.filters.length,targets.length,time,time,t)]);
    await env.FILES.put(sourceKey(id),bytes);
    await env.FILES.put(planKey(id),enc.encode(JSON.stringify(targets)));
    await run(env,`UPDATE badge_packs SET deleting=0,cleanup=0 WHERE id=? AND ${guard}`,id,t);
  });
  return { ok:true,id };
}
async function active(env,a) {
  return lock(env,async t => {
    if (a.id!=='') {
      const p = await pack(env,a.id);
      if (!ready(p)) fail('必须先完成全部徽章图片托管',409);
    }
    await run(env,'UPDATE badge_state SET active_id=? WHERE id=1 AND lock_token=?',a.id || null,t);
    return {ok:true,id:a.id};
  });
}
async function update(env,a) {
  return lock(env,async t => {
    const p = await pack(env,a.id), id=p.id;
    const alias = owns(a,'alias') ? str(a.alias,120,'别名') : p.alias;
    if (!alias && a.delete!==true) fail('别名不能为空');
    const mode = owns(a,'mode') ? getMode(a.mode) : p.mode;
    const clear = sql(env,'UPDATE badge_state SET active_id=NULL WHERE id=1 AND active_id=? AND lock_token=?',id,t);
    if (a.delete===true) {
      await env.DB.batch([clear,sql(env,`UPDATE badge_packs SET deleting=1,cleanup=1,touched=? WHERE id=? AND ${guard}`,now(),id,t)]);
    } else if (mode!==p.mode) {
      if (mode==='link' && !p.url) fail('本地 JSON 只能使用托管模式');
      if (p.cleanup) fail('旧图片尚在分批清理，请稍后重试',409);
      const statements = [sql(env,`DELETE FROM badge_failures WHERE pack=? AND ${guard}`,id,t),sql(env,`UPDATE badge_packs
        SET mode=?,alias=?,cursor=0,done=0,failed=0,error=NULL,retry_cursor=NULL,cleanup=?,cleanup_cursor=0,
          generation=generation+?,touched=? WHERE id=? AND ${guard}`,
        mode,alias,mode==='link'&&p.highwater>0?1:0,mode==='host'?1:0,now(),id,t)];
      if (mode==='host' && p.assets) statements.push(clear);
      await env.DB.batch(statements);
    } else {
      await run(env,`UPDATE badge_packs SET alias=?,retry_cursor=CASE WHEN ? AND mode='host' AND failed>0
        THEN COALESCE(retry_cursor,-1) ELSE retry_cursor END,touched=? WHERE id=? AND ${guard}`,alias,a.retry===true?1:0,now(),id,t);
    }
    return {ok:true,id};
  });
}

async function processPack(env,p,t) {
  if (!pending(p) || p.cleanup) return;
  const {d,n} = await budget(env,'puts');
  if (n<=0) return;
  let slots;
  if (p.retry_cursor!=null) slots = (await rows(env,'SELECT slot FROM badge_failures WHERE pack=? AND slot>? ORDER BY slot LIMIT ?',p.id,p.retry_cursor,Math.min(BATCH,n))).map(r=>r.slot);
  else slots = Array.from({length:Math.min(BATCH,n,p.assets-p.cursor)},(_,i)=>p.cursor+i);
  if (!slots.length) {
    await run(env,`UPDATE badge_packs SET retry_cursor=NULL,touched=? WHERE id=? AND ${guard}`,now(),p.id,t);
    return;
  }
  const bytes = await body(await env.FILES.get(planKey(p.id)));
  if (!bytes) fail('徽章图片清单暂不可用',503);
  const targets = JSON.parse(dec.decode(bytes));
  if (targets.length!==p.assets) fail('徽章图片清单暂不可用',503);
  const last = slots.at(-1);
  // Reserve quota and journal the maximum possible written slot before any IO.
  // Replaying after abrupt termination uses the same immutable slot keys.
  await env.DB.batch([debit(env,t,d,slots.length,0),sql(env,`UPDATE badge_packs SET highwater=MAX(highwater,?) WHERE id=? AND ${guard}`,last+1,p.id,t)]);
  const outcomes=[];
  for (let i=0; i<slots.length; i+=4) outcomes.push(...await Promise.all(slots.slice(i,i+4).map(async slot=>{
    try {
      const {bytes} = await load(targets[slot],true);
      const type = mime(bytes), payload = new Uint8Array(bytes.length+1);
      payload[0]=type; payload.set(bytes,1);
      await env.FILES.put(assetKey(p.id,p.generation,slot),payload);
      return {slot};
    } catch(e) { return {slot,error:e?.status ? e.message : '图片存储失败，请稍后重试'}; }
  })));
  const bad=outcomes.filter(x=>x.error), good=outcomes.filter(x=>!x.error);
  const journal=bad.length ? [sql(env,`INSERT OR REPLACE INTO badge_failures (pack,slot,error)
    SELECT ?,json_extract(value,'$.slot'),json_extract(value,'$.error') FROM json_each(?) WHERE ${guard}`,p.id,JSON.stringify(bad),t)] : [];
  if (p.retry_cursor!=null && good.length) journal.push(sql(env,`DELETE FROM badge_failures WHERE pack=? AND slot IN (${good.map(()=>'?').join(',')}) AND ${guard}`,p.id,...good.map(x=>x.slot),t));
  const retry=p.retry_cursor!=null;
  journal.push(sql(env,`UPDATE badge_packs SET done=done+?,failed=failed+?,error=CASE WHEN failed+?=0 THEN NULL ELSE COALESCE(?,error) END,
    cursor=?,retry_cursor=?,touched=? WHERE id=? AND ${guard}`,
    good.length,retry?-good.length:bad.length,retry?-good.length:bad.length,bad[0]?.error ?? null,retry?p.cursor:last+1,retry&&p.failed>good.length?last:null,now(),p.id,t));
  await env.DB.batch(journal);
}
async function clean(env,p,t) {
  const {d,n} = await budget(env,'deletes');
  if (n<=0) return;
  const end = Math.min(p.highwater,p.cleanup_cursor+BATCH,p.cleanup_cursor+n);
  const count = end-p.cleanup_cursor;
  const removeSource = p.deleting && end===p.highwater && n>=count+2 && count<=BATCH-2;
  if (count || removeSource) {
    await debit(env,t,d,0,count+(removeSource?2:0)).run();
    for (let i=p.cleanup_cursor;i<end;i++) await env.FILES.delete(assetKey(p.id,p.generation,i));
    if (removeSource) {
      await env.FILES.delete(sourceKey(p.id));
      await env.FILES.delete(planKey(p.id));
    }
  }
  if (removeSource) await run(env,`DELETE FROM badge_packs WHERE id=? AND ${guard}`,p.id,t);
  else if (end===p.highwater && !p.deleting) await run(env,`UPDATE badge_packs SET highwater=0,cleanup=0,cleanup_cursor=0,touched=? WHERE id=? AND ${guard}`,now(),p.id,t);
  else await run(env,`UPDATE badge_packs SET cleanup_cursor=?,touched=? WHERE id=? AND ${guard}`,end,now(),p.id,t);
}

// Schedule this independently of sync/mirror invocations. Up to 16 upstream
// requests + 24 adapter KV calls (get/put/get on error), 1 source get, and
// <=9 D1 round trips including caller authentication for manual processing.
export async function badgeTick(env,_origin) {
  return lock(env,async t=>{
    const p=await first(env,`SELECT p.* FROM badge_packs p CROSS JOIN badge_state s WHERE s.id=1 AND (
      (p.cleanup=1 AND (s.quota_day<>? OR s.deletes<=?-CASE WHEN p.deleting=1 AND p.cleanup_cursor=p.highwater THEN 2 ELSE 1 END)) OR
      (p.cleanup=0 AND p.deleting=0 AND p.mode='host' AND (p.cursor<p.assets OR p.retry_cursor IS NOT NULL)
        AND (s.quota_day<>? OR s.puts<?))) ORDER BY p.touched,p.id LIMIT 1`,day(),QUOTA,day(),QUOTA);
    if (p) {
      try { await (p.cleanup?clean(env,p,t):processPack(env,p,t)); }
      catch(e) {
        await run(env,`UPDATE badge_packs SET touched=? WHERE id=? AND ${guard}`,now(),p.id,t);
        throw e;
      }
    }
  },true);
}

export async function badgeApi(req,env,url,a) {
  const path=url.pathname;
  try {
    if (path==='/api/badges' && req.method==='GET') {
      const result=await env.DB.batch([sql(env,'SELECT active_id FROM badge_state WHERE id=1'),sql(env,'SELECT * FROM badge_packs WHERE deleting=0 ORDER BY created DESC,id')]);
      return json({ activeId:result[0].results[0]?.active_id ?? '', items:result[1].results.map(item) });
    }
    if (path==='/api/badges/preview' && req.method==='GET') return json(await preview(env,url));
    if (!['/api/badges/import','/api/badges/update','/api/badges/active','/api/badges/process'].includes(path)) {
      if (path==='/api/badges' || path==='/api/badges/preview') return json({error:'不支持此请求方法'},405);
      return json({error:'接口不存在'},404);
    }
    if (req.method!=='POST') return json({error:'不支持此请求方法'},405);
    if (!object(a)) fail('需要 JSON 对象');
    if (path.endsWith('/import')) return json(await importPack(env,a));
    if (path.endsWith('/update')) return json(await update(env,a));
    if (path.endsWith('/active')) return json(await active(env,a));
    return json(await lock(env,async t=>{
      const p=await pack(env,a.id);
      if (p.cleanup) await clean(env,p,t);
      else await processPack(env,p,t);
      return {ok:true,id:p.id,item:item(await pack(env,p.id))};
    }));
  } catch(e) {
    if (e?.status>=400 && e.status<600) return json({error:e.message},e.status);
    throw e;
  }
}

export async function badgePublic(req,env,url) {
  if (!['GET','HEAD'].includes(req.method)) return say(req,'Method not allowed',405,{Allow:'GET, HEAD'});
  const missing=()=>say(req,'Not found',404), unavailable=()=>say(req,'Badge storage temporarily unavailable',503,{'Retry-After':'30'});
  if (url.pathname==='/badge.json') {
    const p=await first(env,'SELECT p.* FROM badge_packs p JOIN badge_state s ON p.id=s.active_id WHERE s.id=1 AND p.deleting=0');
    if (!p || !ready(p)) return missing();
    if (p.mode==='link') return new Response(null,{status:302,headers:{...headers,Location:p.url}});
    const h={...headers,'Content-Type':'application/json; charset=utf-8'};
    if (req.method==='HEAD') return new Response(null,{headers:h});
    let plan;
    try { plan=await source(env,p); } catch(e) { if(e?.status===503) return unavailable(); throw e; }
    const origin=baseOrigin(env,url);
    visit(plan.data,o=>{
      const slot=plan.byValue[o.imageURL];
      if (slot!=null) o.imageURL=`${origin}/${assetKey(p.id,p.generation,slot)}`;
    });
    return new Response(JSON.stringify(plan.data),{headers:h});
  }
  const m=/^\/badge-assets\/([a-f0-9-]{36})\/([1-9]\d{0,12})-(0|[1-9]\d{0,4})$/.exec(url.pathname);
  if (!m || !ID.test(m[1])) return missing();
  const p=await first(env,"SELECT * FROM badge_packs WHERE id=? AND deleting=0 AND mode='host'",m[1]);
  if (!p || !ready(p) || String(p.generation)!==m[2] || Number(m[3])>=p.assets) return missing();
  const bytes=await body(await env.FILES.get(assetKey(p.id,p.generation,Number(m[3]))));
  if (!bytes) return unavailable();
  if (bytes.length<2 || !TYPES[bytes[0]]) return missing();
  return new Response(req.method==='HEAD'?null:bytes.subarray(1),{headers:{...imageHeaders,'Content-Type':TYPES[bytes[0]],'Content-Length':String(bytes.length-1)}});
}

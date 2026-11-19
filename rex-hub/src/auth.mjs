const encoder = new TextEncoder();
const ITERATIONS = 100_000; // workerd PBKDF2 cap; use a Workers Paid CPU budget.
const SESSION_TTL = 24 * 60 * 60;
const ATTEMPT_WINDOW = 15 * 60;
const MAX_CREDENTIAL_BYTES = 1024;
const TOKEN_PATTERN = /^[a-f0-9]{64}$/;
const nowSeconds = () => Math.floor(Date.now() / 1000);

function json(data, status = 200, extra = {}) {
  return new Response(JSON.stringify(data), {status, headers: {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
    ...extra,
  }});
}
const error = (status, message, headers) => json({error: message}, status, headers);
const hex = bytes => Array.from(new Uint8Array(bytes), b => b.toString(16).padStart(2, '0')).join('');
const unhex = value => Uint8Array.from(value.match(/../g), byte => parseInt(byte, 16));
const sha256 = value => crypto.subtle.digest('SHA-256', encoder.encode(value));
const tokenHash = async value => hex(await sha256(value));
const random = size => crypto.getRandomValues(new Uint8Array(size));

function credential(value, minimum = 1) {
  return typeof value === 'string' && value.length <= MAX_CREDENTIAL_BYTES &&
    !/[\ud800-\udfff]/u.test(value) && Array.from(value).length >= minimum &&
    encoder.encode(value).length <= MAX_CREDENTIAL_BYTES;
}

async function equal(left, right) {
  // All callers use fixed-size, 32-byte inputs. workerd supplies this extension.
  if (typeof crypto.subtle.timingSafeEqual === 'function') {
    return crypto.subtle.timingSafeEqual(left, right);
  }
  // Standard WebCrypto fallback (Node): native HMAC verification, no JS byte comparison.
  const key = await crypto.subtle.importKey('raw', random(32), {name:'HMAC', hash:'SHA-256'}, false, ['sign','verify']);
  return crypto.subtle.verify('HMAC', key, await crypto.subtle.sign('HMAC', key, left), right);
}

async function derive(password, salt) {
  const key = await crypto.subtle.importKey('raw', encoder.encode(password), 'PBKDF2', false, ['deriveBits']);
  return crypto.subtle.deriveBits({name:'PBKDF2', hash:'SHA-256', salt, iterations:ITERATIONS}, key, 256);
}

function cookieMode(request, env) {
  const url = new URL(request.url);
  if (url.protocol === 'https:') return {name:'__Host-rex_session', secure:true};
  if (url.protocol !== 'http:' || !['localhost','127.0.0.1','[::1]'].includes(url.hostname)) return null;
  // Keep Secure by default even on localhost; opt in only on a local dev server.
  return env.AUTH_ALLOW_INSECURE_LOCALHOST === '1'
    ? {name:'rex_local_session', secure:false}
    : {name:'__Host-rex_session', secure:true};
}

function cookie(mode, token, maxAge) {
  return `${mode.name}=${token}; Path=/; Max-Age=${maxAge}; HttpOnly; SameSite=Strict${mode.secure ? '; Secure' : ''}`;
}

function readToken(request, mode) {
  if (!mode) return null;
  let token = null;
  for (const part of (request.headers.get('Cookie') || '').split(';')) {
    const pair = part.trim();
    if (!pair.startsWith(`${mode.name}=`)) continue;
    const value = pair.slice(mode.name.length + 1);
    if (token !== null || !TOKEN_PATTERN.test(value)) return null;
    token = value;
  }
  return token;
}

async function isInitialized(db) {
  return Boolean(await db.prepare('SELECT 1 FROM auth_admin WHERE id = 1').first());
}

async function takeAttempt(request, db, action) {
  // Cloudflare supplies CF-Connecting-IP at ingress. Never trust X-Forwarded-For;
  // requests without an address share a single fallback bucket.
  const raw = request.headers.get('CF-Connecting-IP') || '';
  const ip = /^[0-9a-f:.]{1,45}$/i.test(raw) ? raw.toLowerCase() : 'unknown';
  const globalBucket = `${action}:all`;
  const ipBucket = `${action}:ip:${await tokenHash(ip)}`;
  const now = nowSeconds(), reset = now + ATTEMPT_WINDOW;
  const globalLimit = action === 'setup' ? 24 : 48;
  const ipLimit = action === 'setup' ? 6 : 8;
  // One SQL statement admits both buckets or neither, even across isolates.
  // An IP already at its own limit cannot consume the global quota by retrying.
  const result = await db.prepare(`WITH limits(bucket, cap) AS (VALUES (?, ?), (?, ?))
    INSERT INTO auth_attempts (bucket, count, resets_at)
    SELECT bucket, 1, ? FROM limits
    WHERE NOT EXISTS (
      SELECT 1 FROM auth_attempts AS a JOIN limits AS l ON l.bucket = a.bucket
      WHERE a.resets_at > ? AND a.count >= l.cap
    )
    ON CONFLICT(bucket) DO UPDATE SET
      count = CASE WHEN auth_attempts.resets_at <= ? THEN 1 ELSE auth_attempts.count + 1 END,
      resets_at = CASE WHEN auth_attempts.resets_at <= ? THEN excluded.resets_at ELSE auth_attempts.resets_at END`)
    .bind(globalBucket, globalLimit, ipBucket, ipLimit, reset, now, now, now).run();
  if (result.meta.changes !== 2) return false;
  await db.prepare(`DELETE FROM auth_attempts WHERE bucket IN (
    SELECT bucket FROM auth_attempts WHERE resets_at <= ? ORDER BY resets_at LIMIT 32
  )`).bind(now).run();
  return true;
}

const rateError = () => error(429, '验证尝试次数过多，请稍后重试', {'Retry-After': String(ATTEMPT_WINDOW)});
const transportError = () => error(400, '请通过 HTTPS 使用管理控制台');
const initializedError = () => error(409, '管理控制台已经初始化');

export async function session(request, env) {
  const token = readToken(request, cookieMode(request, env));
  if (!token) return {initialized: await isInitialized(env.DB), authenticated:false};
  const row = await env.DB.prepare(`SELECT
    EXISTS(SELECT 1 FROM auth_admin WHERE id = 1) AS initialized,
    EXISTS(SELECT 1 FROM auth_sessions WHERE token_hash = ? AND expires_at > ?) AS active`)
    .bind(await tokenHash(token), nowSeconds()).first();
  return {initialized: Boolean(row.initialized), authenticated: Boolean(row.initialized && row.active)};
}

export async function setup(request, env, input) {
  const mode = cookieMode(request, env);
  if (!mode) return transportError();
  const db = env.DB;
  if (await isInitialized(db)) return initializedError();
  if (!credential(env.SETUP_TOKEN, 24)) return error(503, '初始化暂不可用');
  if (!credential(input?.token)) return error(401, '初始化令牌不正确');
  if (!credential(input?.password, 12)) return error(400, '管理密码至少 12 个字符，且不超过 1024 UTF-8 字节');
  if (!await takeAttempt(request, db, 'setup')) return rateError();
  const [got, expected] = await Promise.all([sha256(input.token), sha256(env.SETUP_TOKEN)]);
  if (!await equal(got, expected)) return error(401, '初始化令牌不正确');
  const salt = random(16), saltHex = hex(salt);
  const hash = hex(await derive(input.password, salt));
  const token = hex(random(32)), now = nowSeconds();
  // A transactional D1 batch creates the initial session only for the winning
  // INSERT. Its fresh salt links the session write to this setup attempt.
  const [admin, createdSession] = await db.batch([
    db.prepare(`INSERT INTO auth_admin (id, salt, hash, created_at) VALUES (1, ?, ?, ?)
      ON CONFLICT(id) DO NOTHING`).bind(saltHex, hash, new Date(now * 1000).toISOString()),
    db.prepare(`INSERT INTO auth_sessions (token_hash, expires_at)
      SELECT ?, ? WHERE EXISTS (SELECT 1 FROM auth_admin WHERE id = 1 AND salt = ?)`)
      .bind(await tokenHash(token), now + SESSION_TTL, saltHex),
  ]);
  if (admin.meta.changes !== 1) return initializedError();
  if (createdSession.meta.changes !== 1) throw new Error('Session creation failed');
  return json({initialized:true, authenticated:true}, 201, {'Set-Cookie':cookie(mode, token, SESSION_TTL)});
}

export async function login(request, env, input) {
  const mode = cookieMode(request, env);
  if (!mode) return transportError();
  const db = env.DB;
  const admin = await db.prepare('SELECT salt, hash FROM auth_admin WHERE id = 1').first();
  if (!admin) return error(409, '请先初始化管理控制台');
  if (!credential(input?.password)) return error(401, '管理密码不正确');
  if (!await takeAttempt(request, db, 'login')) return rateError();
  if (!/^[a-f0-9]{32}$/.test(admin.salt) || !TOKEN_PATTERN.test(admin.hash)) throw new Error('Invalid credential record');
  if (!await equal(await derive(input.password, unhex(admin.salt)), unhex(admin.hash))) {
    return error(401, '管理密码不正确');
  }
  const token = hex(random(32)), now = nowSeconds(), oldToken = readToken(request, mode);
  await db.batch([
    db.prepare(`DELETE FROM auth_sessions WHERE token_hash IN (
      SELECT token_hash FROM auth_sessions WHERE expires_at <= ? ORDER BY expires_at LIMIT 64
    )`).bind(now),
    db.prepare('DELETE FROM auth_sessions WHERE token_hash = ?').bind(oldToken ? await tokenHash(oldToken) : null),
    db.prepare('INSERT INTO auth_sessions (token_hash, expires_at) VALUES (?, ?)').bind(await tokenHash(token), now + SESSION_TTL),
  ]);
  return json({initialized:true, authenticated:true}, 200, {'Set-Cookie':cookie(mode, token, SESSION_TTL)});
}

export async function logout(request, env) {
  const mode = cookieMode(request, env);
  if (!mode) return transportError();
  const token = readToken(request, mode);
  if (token) await env.DB.prepare('DELETE FROM auth_sessions WHERE token_hash = ?').bind(await tokenHash(token)).run();
  return json({initialized:await isInitialized(env.DB), authenticated:false}, 200, {'Set-Cookie':cookie(mode, '', 0)});
}

export async function changePassword(request,env,input){
  const mode=cookieMode(request,env);
  if(!mode)return transportError();
  if(!credential(input?.newPassword,12))return error(400,'新密码至少 12 个字符');
  if(!credential(input?.currentPassword))return error(400,'请输入当前密码');
  const db=env.DB, oldToken=readToken(request,mode);
  if(!oldToken)return error(401,'请先登录');
  if(!await takeAttempt(request,db,'password'))return rateError();
  const admin=await db.prepare('SELECT salt,hash FROM auth_admin WHERE id=1').first();
  if(!admin||!await equal(await derive(input.currentPassword,unhex(admin.salt)),unhex(admin.hash)))return error(403,'当前密码不正确');
  const salt=random(16),saltHex=hex(salt),hash=hex(await derive(input.newPassword,salt));
  const token=hex(random(32)), expires=nowSeconds()+SESSION_TTL;
  const [updated]=await db.batch([
    db.prepare('UPDATE auth_admin SET salt=?,hash=? WHERE id=1 AND salt=? AND EXISTS(SELECT 1 FROM auth_sessions WHERE token_hash=? AND expires_at>?)').bind(saltHex,hash,admin.salt,await tokenHash(oldToken),nowSeconds()),
    db.prepare('DELETE FROM auth_sessions WHERE EXISTS(SELECT 1 FROM auth_admin WHERE id=1 AND salt=?)').bind(saltHex),
    db.prepare('INSERT INTO auth_sessions(token_hash,expires_at) SELECT ?,? WHERE EXISTS(SELECT 1 FROM auth_admin WHERE id=1 AND salt=?)').bind(await tokenHash(token),expires,saltHex)
  ]);
  if(updated.meta.changes!==1)return error(409,'会话或密码已更新，请重新登录');
  return json({ok:true},200,{'Set-Cookie':cookie(mode,token,SESSION_TTL)});
}

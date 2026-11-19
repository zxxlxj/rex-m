use crate::{err, json, App, Result};
use axum::{
    http::{header, HeaderMap, HeaderValue, StatusCode},
    response::Response,
};
use pbkdf2::pbkdf2_hmac;
use rand::{rngs::OsRng, RngCore};
use rusqlite::{params, Connection, OptionalExtension, TransactionBehavior};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::sync::MutexGuard;
use subtle::ConstantTimeEq;

const ITERATIONS: u32 = 100_000;
const SESSION_TTL: i64 = 86_400;
const ATTEMPT_WINDOW: i64 = 900;
const MAX_CREDENTIAL_BYTES: usize = 1024;

struct Credential {
    salt: String,
    hash: String,
}

struct Session {
    token: String,
    hash: String,
}

impl Session {
    fn new() -> Result<Self> {
        let token = hex::encode(random::<32>()?);
        let hash = token_hash(&token);
        Ok(Self { token, hash })
    }

    fn insert(&self, db: &Connection, now: i64) -> Result<()> {
        db.execute(
            "INSERT INTO auth_sessions (token_hash, expires_at) VALUES (?1, ?2)",
            params![self.hash, now + SESSION_TTL],
        )?;
        Ok(())
    }
}

fn random<const N: usize>() -> Result<[u8; N]> {
    let mut bytes = [0; N];
    OsRng
        .try_fill_bytes(&mut bytes)
        .map_err(|_| err(500, "安全随机数暂不可用"))?;
    Ok(bytes)
}

fn db(app: &App) -> Result<MutexGuard<'_, Connection>> {
    app.db.lock().map_err(|_| err(500, "数据库暂不可用"))
}

fn now() -> i64 {
    chrono::Utc::now().timestamp()
}

fn valid_credential(value: &str, min_chars: usize) -> bool {
    value.len() <= MAX_CREDENTIAL_BYTES && value.chars().take(min_chars).count() == min_chars
}

fn field(data: &Value, name: &str, min_chars: usize) -> Option<String> {
    data.get(name)
        .and_then(Value::as_str)
        .filter(|value| valid_credential(value, min_chars))
        .map(str::to_owned)
}

fn lower_hex(value: &str, length: usize) -> bool {
    value.len() == length
        && value
            .bytes()
            .all(|b| matches!(b, b'0'..=b'9' | b'a'..=b'f'))
}

fn token_hash(value: &str) -> String {
    hex::encode(Sha256::digest(value.as_bytes()))
}

fn derive(password: &str, salt: &[u8; 16]) -> [u8; 32] {
    let mut hash = [0; 32];
    pbkdf2_hmac::<Sha256>(password.as_bytes(), salt, ITERATIONS, &mut hash);
    hash
}

async fn new_credential(password: String) -> Result<Credential> {
    tokio::task::spawn_blocking(move || {
        let salt = random::<16>()?;
        Ok(Credential {
            salt: hex::encode(salt),
            hash: hex::encode(derive(&password, &salt)),
        })
    })
    .await
    .map_err(|_| err(500, "认证暂不可用"))?
}

async fn verify(password: String, admin: &Credential) -> Result<bool> {
    let invalid = || err(500, "管理凭据记录无效");
    if !lower_hex(&admin.salt, 32) || !lower_hex(&admin.hash, 64) {
        return Err(invalid());
    }
    let mut salt = [0; 16];
    let mut expected = [0; 32];
    hex::decode_to_slice(&admin.salt, &mut salt).map_err(|_| invalid())?;
    hex::decode_to_slice(&admin.hash, &mut expected).map_err(|_| invalid())?;
    tokio::task::spawn_blocking(move || bool::from(derive(&password, &salt).ct_eq(&expected)))
        .await
        .map_err(|_| err(500, "认证暂不可用"))
}

fn cookie_name(secure: bool) -> &'static str {
    if secure {
        "__Host-rex_session"
    } else {
        "rex_local_session"
    }
}

fn cookie_hash(headers: &HeaderMap, secure: bool) -> Option<String> {
    let mut token = None;
    for header_value in headers.get_all(header::COOKIE) {
        for part in header_value.to_str().ok()?.split(';') {
            let part = part.trim_ascii();
            if let Some((key, value)) = part.split_once('=') {
                if key.trim_ascii_end() == cookie_name(secure) {
                    if token.is_some() || !lower_hex(value, 64) {
                        return None;
                    }
                    token = Some(value);
                }
            } else if part == cookie_name(secure) {
                return None;
            }
        }
    }
    token.map(token_hash)
}

fn respond(code: StatusCode, value: Value) -> Response {
    let mut response = json(value);
    *response.status_mut() = code;
    response
        .headers_mut()
        .insert(header::CACHE_CONTROL, HeaderValue::from_static("no-store"));
    response.headers_mut().insert(
        header::X_CONTENT_TYPE_OPTIONS,
        HeaderValue::from_static("nosniff"),
    );
    response
}

fn with_cookie(mut response: Response, secure: bool, session: Option<&Session>) -> Response {
    let (token, max_age) = session.map_or(("", 0), |item| (item.token.as_str(), SESSION_TTL));
    let flag = if secure { "; Secure" } else { "" };
    let name = cookie_name(secure);
    let value =
        format!("{name}={token}; Path=/; Max-Age={max_age}; HttpOnly; SameSite=Strict{flag}");
    let mut value = HeaderValue::from_str(&value).expect("session cookie uses fixed ASCII and hex");
    value.set_sensitive(true);
    response.headers_mut().insert(header::SET_COOKIE, value);
    response
}

fn session_json(initialized: bool, authenticated: bool) -> Value {
    json!({"initialized": initialized, "authenticated": authenticated})
}

fn initialized(db: &Connection) -> Result<bool> {
    Ok(db.query_row(
        "SELECT EXISTS(SELECT 1 FROM auth_admin WHERE id=1)",
        [],
        |row| row.get(0),
    )?)
}

pub fn status(app: &App, headers: &HeaderMap, secure: bool) -> Result<(bool, bool)> {
    let hash = cookie_hash(headers, secure);
    let db = db(app)?;
    if let Some(hash) = hash {
        let (initialized, active): (bool, bool) = db.query_row(
            "SELECT EXISTS(SELECT 1 FROM auth_admin WHERE id=1),
                    EXISTS(SELECT 1 FROM auth_sessions WHERE token_hash=?1 AND expires_at>?2)",
            params![hash, now()],
            |row| Ok((row.get(0)?, row.get(1)?)),
        )?;
        Ok((initialized, initialized && active))
    } else {
        Ok((initialized(&db)?, false))
    }
}

fn take_attempt(db: &Connection, bucket: &str, limit: i64, now: i64) -> Result<bool> {
    Ok(db.execute(
        "INSERT INTO auth_attempts (bucket, count, resets_at) VALUES (?1, 1, ?2)
         ON CONFLICT(bucket) DO UPDATE SET
           count=CASE WHEN auth_attempts.resets_at<=?3 THEN 1 ELSE auth_attempts.count+1 END,
           resets_at=CASE WHEN auth_attempts.resets_at<=?3 THEN excluded.resets_at ELSE auth_attempts.resets_at END
         WHERE auth_attempts.resets_at<=?3 OR auth_attempts.count<?4",
        params![bucket, now + ATTEMPT_WINDOW, now, limit],
    )? == 1)
}

fn rate_error() -> Response {
    let mut response = respond(
        StatusCode::TOO_MANY_REQUESTS,
        json!({"error": "验证尝试次数过多，请稍后重试"}),
    );
    response.headers_mut().insert(
        header::RETRY_AFTER,
        HeaderValue::from_str(&ATTEMPT_WINDOW.to_string()).expect("positive integer"),
    );
    response
}

fn already_initialized() -> crate::Error {
    err(409, "管理控制台已经初始化")
}

fn changed() -> crate::Error {
    err(409, "会话或密码已更新，请重新登录")
}

fn commit_setup(db: &mut Connection, admin: &Credential, session: &Session) -> Result<()> {
    let tx = db.transaction_with_behavior(TransactionBehavior::Immediate)?;
    let created = chrono::Utc::now();
    if tx.execute(
        "INSERT INTO auth_admin (id, salt, hash, created_at) VALUES (1, ?1, ?2, ?3)
         ON CONFLICT(id) DO NOTHING",
        params![
            admin.salt,
            admin.hash,
            created.to_rfc3339_opts(chrono::SecondsFormat::Millis, true)
        ],
    )? != 1
    {
        return Err(already_initialized());
    }
    session.insert(&tx, created.timestamp())?;
    tx.commit()?;
    Ok(())
}

async fn setup(app: &App, secure: bool, data: &Value) -> Result<Response> {
    {
        let conn = db(app)?;
        if initialized(&conn)? {
            return Err(already_initialized());
        }
    }
    let expected = app
        .setup_token
        .as_deref()
        .filter(|value| !value.trim().is_empty() && valid_credential(value, 24))
        .ok_or_else(|| err(503, "初始化暂不可用"))?;
    let supplied = data
        .get("token")
        .and_then(Value::as_str)
        .filter(|value| valid_credential(value, 1))
        .ok_or_else(|| err(401, "初始化令牌不正确"))?;
    let password = field(data, "password", 12)
        .ok_or_else(|| err(400, "管理密码至少 12 个字符，且不超过 1024 UTF-8 字节"))?;
    {
        let conn = db(app)?;
        if !take_attempt(&conn, "setup:all", 24, now())? {
            return Ok(rate_error());
        }
    }
    if !bool::from(Sha256::digest(supplied.as_bytes()).ct_eq(&Sha256::digest(expected.as_bytes())))
    {
        return Err(err(401, "初始化令牌不正确"));
    }
    let admin = new_credential(password).await?;
    let session = Session::new()?;
    commit_setup(&mut *db(app)?, &admin, &session)?;
    Ok(with_cookie(
        respond(StatusCode::CREATED, session_json(true, true)),
        secure,
        Some(&session),
    ))
}

fn load_admin(db: &Connection) -> Result<Option<Credential>> {
    Ok(db
        .query_row("SELECT salt, hash FROM auth_admin WHERE id=1", [], |row| {
            Ok(Credential {
                salt: row.get(0)?,
                hash: row.get(1)?,
            })
        })
        .optional()?)
}

fn revoke(db: &Connection, hash: Option<&str>) -> Result<()> {
    if let Some(hash) = hash {
        db.execute("DELETE FROM auth_sessions WHERE token_hash=?1", [hash])?;
    }
    Ok(())
}

fn commit_login(
    db: &mut Connection,
    admin: &Credential,
    old_hash: Option<&str>,
    session: &Session,
) -> Result<()> {
    let tx = db.transaction_with_behavior(TransactionBehavior::Immediate)?;
    let now = now();
    if tx.execute(
        "INSERT INTO auth_sessions (token_hash, expires_at)
         SELECT ?1, ?2 WHERE EXISTS (SELECT 1 FROM auth_admin WHERE id=1 AND salt=?3 AND hash=?4)",
        params![session.hash, now + SESSION_TTL, admin.salt, admin.hash],
    )? != 1
    {
        return Err(changed());
    }
    tx.execute(
        "DELETE FROM auth_sessions WHERE token_hash IN (
            SELECT token_hash FROM auth_sessions WHERE expires_at<=?1 ORDER BY expires_at LIMIT 64
        )",
        [now],
    )?;
    revoke(&tx, old_hash)?;
    tx.commit()?;
    Ok(())
}

async fn login(app: &App, headers: &HeaderMap, secure: bool, data: &Value) -> Result<Response> {
    let (admin, password) = {
        let conn = db(app)?;
        let admin = load_admin(&conn)?.ok_or_else(|| err(409, "请先初始化管理控制台"))?;
        let password = field(data, "password", 1).ok_or_else(|| err(401, "管理密码不正确"))?;
        if !take_attempt(&conn, "login:all", 48, now())? {
            return Ok(rate_error());
        }
        (admin, password)
    };
    if !verify(password, &admin).await? {
        return Err(err(401, "管理密码不正确"));
    }
    let old_hash = cookie_hash(headers, secure);
    let session = Session::new()?;
    commit_login(&mut *db(app)?, &admin, old_hash.as_deref(), &session)?;
    Ok(with_cookie(
        respond(StatusCode::OK, session_json(true, true)),
        secure,
        Some(&session),
    ))
}

fn logout(app: &App, headers: &HeaderMap, secure: bool) -> Result<Response> {
    let hash = cookie_hash(headers, secure);
    let conn = db(app)?;
    revoke(&conn, hash.as_deref())?;
    Ok(with_cookie(
        respond(StatusCode::OK, session_json(initialized(&conn)?, false)),
        secure,
        None,
    ))
}

fn commit_password(
    db: &mut Connection,
    previous: &Credential,
    updated: &Credential,
    old_hash: &str,
    session: &Session,
) -> Result<()> {
    let tx = db.transaction_with_behavior(TransactionBehavior::Immediate)?;
    let now = now();
    if tx.execute(
        "UPDATE auth_admin SET salt=?1, hash=?2 WHERE id=1 AND salt=?3 AND hash=?4
         AND EXISTS (SELECT 1 FROM auth_sessions WHERE token_hash=?5 AND expires_at>?6)",
        params![
            updated.salt,
            updated.hash,
            previous.salt,
            previous.hash,
            old_hash,
            now
        ],
    )? != 1
    {
        return Err(changed());
    }
    tx.execute("DELETE FROM auth_sessions", [])?;
    session.insert(&tx, now)?;
    tx.commit()?;
    Ok(())
}

async fn change_password(
    app: &App,
    headers: &HeaderMap,
    secure: bool,
    data: &Value,
) -> Result<Response> {
    let old_hash = cookie_hash(headers, secure).ok_or_else(|| err(401, "请先登录"))?;
    let previous = {
        let conn = db(app)?;
        conn.query_row(
            "SELECT salt, hash FROM auth_admin WHERE id=1
             AND EXISTS (SELECT 1 FROM auth_sessions WHERE token_hash=?1 AND expires_at>?2)",
            params![old_hash, now()],
            |row| {
                Ok(Credential {
                    salt: row.get(0)?,
                    hash: row.get(1)?,
                })
            },
        )
        .optional()?
        .ok_or_else(|| err(401, "请先登录"))?
    };
    let new_password = field(data, "newPassword", 12)
        .ok_or_else(|| err(400, "新密码至少 12 个字符，且不超过 1024 UTF-8 字节"))?;
    let current_password =
        field(data, "currentPassword", 1).ok_or_else(|| err(400, "请输入当前密码"))?;
    {
        let conn = db(app)?;
        if !take_attempt(&conn, "password:all", 48, now())? {
            return Ok(rate_error());
        }
    }
    if !verify(current_password, &previous).await? {
        return Err(err(403, "当前密码不正确"));
    }
    let updated = new_credential(new_password).await?;
    let session = Session::new()?;
    commit_password(&mut *db(app)?, &previous, &updated, &old_hash, &session)?;
    Ok(with_cookie(
        respond(StatusCode::OK, json!({"ok": true})),
        secure,
        Some(&session),
    ))
}

pub async fn api(
    app: &App,
    path: &str,
    headers: &HeaderMap,
    secure: bool,
    data: &Value,
) -> Result<Response> {
    match path {
        "/api/session" => {
            let (initialized, authenticated) = status(app, headers, secure)?;
            Ok(respond(
                StatusCode::OK,
                session_json(initialized, authenticated),
            ))
        }
        "/api/setup" => setup(app, secure, data).await,
        "/api/login" => login(app, headers, secure, data).await,
        "/api/logout" => logout(app, headers, secure),
        "/api/password" => change_password(app, headers, secure, data).await,
        _ => Err(err(404, "接口不存在")),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn fixture() -> Connection {
        let db = Connection::open_in_memory().unwrap();
        db.execute_batch(include_str!("../../migrations/0002_auth.sql"))
            .unwrap();
        db
    }

    fn session_count(db: &Connection) -> i64 {
        db.query_row("SELECT count(*) FROM auth_sessions", [], |r| r.get(0))
            .unwrap()
    }

    #[test]
    fn worker_password_hash_compatibility() {
        let salt = std::array::from_fn(|i| i as u8);
        assert_eq!(
            hex::encode(derive("test password 火星🔑", &salt)),
            "f69febb70739bd4eabfed0f45a4c2b0b92da14394b560b0e797b2eb48831f284"
        );
        assert!(valid_credential(&"🔑".repeat(256), 12));
        assert!(!valid_credential(&"🔑".repeat(257), 12));
    }

    #[test]
    fn cookie_modes_and_duplicates() {
        let session = Session::new().unwrap();
        for secure in [true, false] {
            let response =
                with_cookie(respond(StatusCode::OK, json!(null)), secure, Some(&session));
            let cookie = response.headers()[header::SET_COOKIE].to_str().unwrap();
            assert!(cookie.contains("; Path=/; Max-Age=86400; HttpOnly; SameSite=Strict"));
            assert_eq!(cookie.ends_with("; Secure"), secure);
            let mut headers = HeaderMap::new();
            let pair = HeaderValue::from_str(cookie.split(';').next().unwrap()).unwrap();
            headers.append(header::COOKIE, pair.clone());
            assert_eq!(cookie_hash(&headers, secure), Some(session.hash.clone()));
            assert_eq!(cookie_hash(&headers, !secure), None);
            headers.append(header::COOKIE, pair);
            assert_eq!(cookie_hash(&headers, secure), None);
        }
    }

    #[test]
    fn rate_limit_does_not_extend_when_blocked() {
        let db = fixture();
        for _ in 0..2 {
            assert!(take_attempt(&db, "login:all", 2, 10).unwrap());
        }
        assert!(!take_attempt(&db, "login:all", 2, 10 + ATTEMPT_WINDOW - 1).unwrap());
        assert!(take_attempt(&db, "login:all", 2, 10 + ATTEMPT_WINDOW).unwrap());
    }

    #[test]
    fn rotation_revokes_sessions_and_blocks_in_flight_stale_login() {
        let mut db = fixture();
        let old = Credential {
            salt: "old-salt".into(),
            hash: "old-hash".into(),
        };
        let new = Credential {
            salt: "new-salt".into(),
            hash: "new-hash".into(),
        };
        let first = Session::new().unwrap();
        let other = Session::new().unwrap();
        let rotated = Session::new().unwrap();
        commit_setup(&mut db, &old, &first).unwrap();
        assert!(commit_setup(&mut db, &new, &other).is_err());
        assert_eq!(session_count(&db), 1);
        commit_login(&mut db, &old, None, &other).unwrap();
        assert_eq!(session_count(&db), 2);
        db.execute(
            "UPDATE auth_sessions SET expires_at=0 WHERE token_hash=?1",
            [&other.hash],
        )
        .unwrap();
        assert!(commit_password(&mut db, &old, &new, &other.hash, &rotated).is_err());
        assert_eq!(session_count(&db), 2);
        commit_password(&mut db, &old, &new, &first.hash, &rotated).unwrap();
        assert!(commit_login(&mut db, &old, None, &other).is_err());
        assert!(commit_password(&mut db, &old, &new, &first.hash, &other).is_err());
        assert_eq!(session_count(&db), 1);
        let stored: String = db
            .query_row("SELECT token_hash FROM auth_sessions", [], |r| r.get(0))
            .unwrap();
        assert_eq!(stored, rotated.hash);
        commit_login(&mut db, &new, Some(&rotated.hash), &other).unwrap();
        assert_eq!(session_count(&db), 1);
        revoke(&db, Some(&other.hash)).unwrap();
        assert_eq!(session_count(&db), 0);
    }
}

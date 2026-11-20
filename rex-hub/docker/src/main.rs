mod auth;
mod badges;
mod sources;
mod state;

use axum::{
    body::{to_bytes, Body},
    extract::{Request, State},
    http::{header, HeaderMap, Method, StatusCode},
    response::{IntoResponse, Response},
    routing::any,
    Router,
};
use rusqlite::Connection;
use serde_json::Value;
use std::{
    collections::HashMap,
    env,
    path::{Path, PathBuf},
    sync::{Arc, Mutex},
    time::Duration,
};
use tokio_util::io::ReaderStream;
use url::Url;

pub struct App {
    pub db: Mutex<Connection>,
    pub badge_lock: tokio::sync::Mutex<()>,
    pub source_lock: tokio::sync::Mutex<()>,
    pub http: reqwest::Client,
    pub files: PathBuf,
    pub web: PathBuf,
    pub setup_token: Option<String>,
    pub origin: String,
    pub secure: bool,
}
#[derive(Debug)]
pub struct Error {
    pub status: u16,
    pub message: String,
}
pub type Result<T> = std::result::Result<T, Error>;
pub fn err(status: u16, msg: impl Into<String>) -> Error {
    Error {
        status,
        message: msg.into(),
    }
}
impl From<rusqlite::Error> for Error {
    fn from(e: rusqlite::Error) -> Self {
        eprintln!("SQLite: {e}");
        err(500, "数据库暂不可用")
    }
}
impl From<std::io::Error> for Error {
    fn from(e: std::io::Error) -> Self {
        eprintln!("I/O: {e}");
        err(500, "文件操作失败")
    }
}
impl IntoResponse for Error {
    fn into_response(self) -> Response {
        let mut r = json(serde_json::json!({"error":self.message}));
        *r.status_mut() =
            StatusCode::from_u16(self.status).unwrap_or(StatusCode::INTERNAL_SERVER_ERROR);
        r
    }
}
pub fn json(v: Value) -> Response {
    let mut r = axum::Json(v).into_response();
    r.headers_mut()
        .insert(header::CACHE_CONTROL, "no-store".parse().unwrap());
    r
}
pub fn text(v: &Value) -> &str {
    v.as_str().unwrap_or("")
}
pub fn now() -> String {
    chrono::Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Millis, true)
}
fn safe_path(root: &Path, key: &str) -> Result<PathBuf> {
    if key.is_empty()
        || key.split('/').any(|p| {
            p.is_empty()
                || p == "."
                || p == ".."
                || !p
                    .bytes()
                    .all(|x| x.is_ascii_alphanumeric() || b"._-".contains(&x))
        })
    {
        return Err(err(404, "文件不存在"));
    }
    Ok(root.join(key))
}
pub async fn put_file(app: &App, key: &str, bytes: &[u8]) -> Result<()> {
    let path = safe_path(&app.files, key)?;
    if let Some(parent) = path.parent() {
        tokio::fs::create_dir_all(parent).await?;
    }
    let tmp = path.with_extension(format!("tmp-{}", uuid::Uuid::new_v4()));
    tokio::fs::write(&tmp, bytes).await?;
    if let Err(e) = tokio::fs::rename(&tmp, &path).await {
        let _ = tokio::fs::remove_file(&tmp).await;
        return Err(e.into());
    }
    Ok(())
}
pub async fn delete_file(app: &App, key: &str) -> Result<()> {
    match tokio::fs::remove_file(safe_path(&app.files, key)?).await {
        Ok(()) => Ok(()),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(e) => Err(e.into()),
    }
}
fn mime(path: &str) -> &'static str {
    match path.rsplit('.').next() {
        Some("html") => "text/html; charset=utf-8",
        Some("js") => "text/javascript; charset=utf-8",
        Some("css") => "text/css; charset=utf-8",
        Some("png") => "image/png",
        Some("webp") => "image/webp",
        Some("gif") => "image/gif",
        Some("jpg") => "image/jpeg",
        Some("webmanifest") => "application/manifest+json",
        _ => "application/octet-stream",
    }
}
async fn file(root: &Path, key: &str, head: bool, kind: &str, cache: &str) -> Result<Response> {
    let path = safe_path(root, key)?;
    let f = tokio::fs::File::open(path).await.map_err(|e| {
        if e.kind() == std::io::ErrorKind::NotFound {
            err(404, "文件不存在")
        } else {
            e.into()
        }
    })?;
    let len = f.metadata().await?.len();
    let mut r = Response::new(if head {
        Body::empty()
    } else {
        Body::from_stream(ReaderStream::new(f))
    });
    let h = r.headers_mut();
    h.insert(header::CONTENT_TYPE, kind.parse().unwrap());
    h.insert(header::CONTENT_LENGTH, len.to_string().parse().unwrap());
    h.insert(header::CACHE_CONTROL, cache.parse().unwrap());
    Ok(r)
}
fn query(req: &Request) -> HashMap<String, String> {
    url::form_urlencoded::parse(req.uri().query().unwrap_or("").as_bytes())
        .into_owned()
        .collect()
}
async fn payload(req: Request, cap: usize) -> Result<Value> {
    if !req
        .headers()
        .get(header::CONTENT_TYPE)
        .and_then(|h| h.to_str().ok())
        .is_some_and(|h| h.split(';').next() == Some("application/json"))
    {
        return Err(err(415, "需要 JSON 请求"));
    }
    let body = to_bytes(req.into_body(), cap)
        .await
        .map_err(|_| err(413, "请求内容过大"))?;
    let v: Value = serde_json::from_slice(&body).map_err(|_| err(400, "无法读取 JSON"))?;
    if !v.is_object() {
        return Err(err(400, "需要 JSON 对象"));
    }
    Ok(v)
}
async fn route(app: &Arc<App>, req: Request) -> Result<Response> {
    let path = req.uri().path().to_owned();
    let method = req.method().clone();
    let headers: HeaderMap = req.headers().clone();
    let q = query(&req);
    if path == "/healthz" && method == Method::GET {
        return Ok(json(serde_json::json!({"ok":true})));
    }
    if path.starts_with("/api/") {
        if method == Method::POST
            && headers.get(header::ORIGIN).and_then(|x| x.to_str().ok())
                != Some(app.origin.as_str())
        {
            return Err(err(403, "请求来源不匹配"));
        }
        let (initialized, authenticated) = auth::status(app, &headers, app.secure)?;
        if path == "/api/bootstrap" && method == Method::GET {
            let mut value =
                serde_json::json!({"initialized":initialized,"authenticated":authenticated});
            if authenticated {
                value["state"] = state::dashboard(app)?;
            }
            return Ok(json(value));
        }
        if path == "/api/session" && method == Method::GET {
            return Ok(json(
                serde_json::json!({"initialized":initialized,"authenticated":authenticated}),
            ));
        }
        if method == Method::POST
            && matches!(
                path.as_str(),
                "/api/setup" | "/api/login" | "/api/logout" | "/api/password"
            )
        {
            if path == "/api/password" && !authenticated {
                return Err(err(401, "请先登录"));
            }
            return auth::api(
                app,
                &path,
                &headers,
                app.secure,
                &payload(req, 16_384).await?,
            )
            .await;
        }
        if !authenticated {
            return Err(err(401, "请先登录"));
        }
        if method != Method::GET && method != Method::POST {
            return Err(err(405, "请求方法不支持"));
        }
        if method == Method::POST && path == "/api/icon" {
            let bytes = to_bytes(req.into_body(), 2_000_000)
                .await
                .map_err(|_| err(413, "图标过大"))?;
            return state::upload_icon(app, bytes).await;
        }
        let data = if method == Method::POST {
            let cap = match path.as_str() {
                "/api/source" => 24 * 1024 * 1024,
                "/api/badges/import" => 12_000_000,
                _ => 256_000,
            };
            payload(req, cap).await?
        } else {
            Value::Null
        };
        if path == "/api/badges" || path.starts_with("/api/badges/") {
            return badges::api(app, &path, &method, &q, &data, &app.origin).await;
        }
        return state::api(app, &path, &method, &q, &data).await;
    }
    if !matches!(method, Method::GET | Method::HEAD) {
        return Err(err(405, "请求方法不支持"));
    }
    if path == "/badge.json" || path.starts_with("/badge-assets/") {
        return badges::public(app, &path, &method, &app.origin).await;
    }
    let head = method == Method::HEAD;
    if path.starts_with("/s/") || path.starts_with("/m/") {
        return state::public(app, &path, head, &headers).await;
    }
    if let Some(k) = path.strip_prefix("/files/") {
        if !state::module_hash(k) {
            return Err(err(404, "文件不存在"));
        }
        let mut r = file(
            &app.files,
            &format!("files/{k}"),
            head,
            "text/plain; charset=utf-8",
            "public, max-age=86400, immutable",
        )
        .await?;
        r.headers_mut().insert(
            header::CONTENT_DISPOSITION,
            "attachment; filename=\"module.rex.js\"".parse().unwrap(),
        );
        return Ok(r);
    }
    if let Some(k) = path.strip_prefix("/icons/") {
        if !state::icon_hash(k) {
            return Err(err(404, "文件不存在"));
        }
        return file(
            &app.files,
            &format!("icons/{k}"),
            head,
            mime(k),
            "public, max-age=86400, immutable",
        )
        .await;
    }
    let k = if path == "/" {
        "index.html"
    } else {
        path.trim_start_matches('/')
    };
    if k.contains('/')
        || !matches!(
            k.rsplit('.').next(),
            Some("html" | "js" | "css" | "png" | "gif" | "webmanifest" | "webp")
        )
    {
        return Err(err(404, "页面不存在"));
    }
    let cache =
        if k.starts_with("rex-dino-") && k.ends_with(".png") || k == "pull-rex-collection.png" {
            "public, max-age=604800"
        } else {
            "no-cache"
        };
    file(&app.web, k, head, mime(k), cache).await
}
async fn handler(State(app): State<Arc<App>>, req: Request) -> Response {
    let path = req.uri().path().to_owned();
    let mut r = match route(&app, req).await {
        Ok(r) => r,
        Err(e) => e.into_response(),
    };
    let h = r.headers_mut();
    h.insert(header::X_CONTENT_TYPE_OPTIONS, "nosniff".parse().unwrap());
    h.insert(header::REFERRER_POLICY, "no-referrer".parse().unwrap());
    h.insert(header::X_FRAME_OPTIONS, "DENY".parse().unwrap());
    h.entry(header::CONTENT_SECURITY_POLICY).or_insert(if path.starts_with("/files/")||path.starts_with("/m/")||path.starts_with("/badge-assets/"){"default-src 'none'; sandbox"}else{"default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' https: data: blob:; connect-src 'self'; object-src 'none'; frame-ancestors 'none'; base-uri 'self'; form-action 'self'"}.parse().unwrap());
    r
}
async fn shutdown() {
    let ctrl = tokio::signal::ctrl_c();
    #[cfg(unix)]
    {
        if let Ok(mut term) =
            tokio::signal::unix::signal(tokio::signal::unix::SignalKind::terminate())
        {
            tokio::select! {_=ctrl=>{},_=term.recv()=>{}}
            return;
        }
    }
    let _ = ctrl.await;
}
#[tokio::main]
async fn main() -> std::result::Result<(), Box<dyn std::error::Error>> {
    let origin = env::var("PUBLIC_ORIGIN").unwrap_or_else(|_| "http://localhost:8080".into());
    let u = Url::parse(&origin)?;
    if u.origin().ascii_serialization() != origin.trim_end_matches('/')
        || !matches!(u.scheme(), "https" | "http")
        || !u.username().is_empty()
        || u.password().is_some()
    {
        return Err("PUBLIC_ORIGIN 必须是完整源站地址，不含路径".into());
    }
    let secure = u.scheme() == "https";
    if !secure
        && !matches!(u.host_str(), Some("localhost" | "127.0.0.1" | "[::1]"))
        && env::var("ALLOW_INSECURE_HTTP").as_deref() != Ok("1")
    {
        return Err(
            "公网访问请配置 HTTPS 反代；可信内网 HTTP 需显式设置 ALLOW_INSECURE_HTTP=1".into(),
        );
    }
    let dir = PathBuf::from(env::var("DATA_DIR").unwrap_or_else(|_| "/data".into()));
    let files = dir.join("files-store");
    std::fs::create_dir_all(&files)?;
    let db = Connection::open(dir.join("hub.sqlite3"))?;
    db.busy_timeout(Duration::from_secs(4))?;
    db.execute_batch(
        "PRAGMA journal_mode=WAL; PRAGMA synchronous=NORMAL; PRAGMA foreign_keys=ON;",
    )?;
    for sql in [
        include_str!("../../migrations/0001_hub.sql"),
        include_str!("../../migrations/0002_auth.sql"),
        include_str!("../../migrations/0003_badges.sql"),
    ] {
        db.execute_batch(sql)?;
    }
    let http = reqwest::Client::builder()
        .timeout(Duration::from_secs(15))
        .connect_timeout(Duration::from_secs(5))
        .redirect(reqwest::redirect::Policy::none())
        .no_proxy()
        .dns_resolver(Arc::new(sources::PublicDns))
        .user_agent("RexHub-Docker/0.0.9")
        .build()?;
    let setup_token = env::var("SETUP_TOKEN_FILE")
        .ok()
        .map(std::fs::read_to_string)
        .transpose()?
        .or_else(|| env::var("SETUP_TOKEN").ok())
        .map(|s| s.trim().to_owned())
        .filter(|s| !s.is_empty());
    if setup_token.as_ref().is_some_and(|s| s.len() < 24) {
        return Err("SETUP_TOKEN 至少 24 个字符".into());
    }
    let app = Arc::new(App {
        db: Mutex::new(db),
        badge_lock: Default::default(),
        source_lock: Default::default(),
        http,
        files,
        web: PathBuf::from(env::var("WEB_DIR").unwrap_or_else(|_| "/app/public".into())),
        setup_token,
        origin: u.origin().ascii_serialization(),
        secure,
    });
    let tick = Arc::clone(&app);
    tokio::spawn(async move {
        let mut timer = tokio::time::interval(Duration::from_secs(30));
        timer.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Skip);
        loop {
            timer.tick().await;
            if let Err(e) = state::tick(&tick).await {
                eprintln!("同步: {}", e.message);
            }
        }
    });
    let tick = Arc::clone(&app);
    tokio::spawn(async move {
        let mut timer = tokio::time::interval(Duration::from_secs(3));
        timer.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Skip);
        loop {
            timer.tick().await;
            if let Err(e) = badges::tick(&tick).await {
                eprintln!("徽章: {}", e.message);
            }
        }
    });
    let port = env::var("PORT")
        .ok()
        .and_then(|p| p.parse::<u16>().ok())
        .unwrap_or(8080);
    let listener = tokio::net::TcpListener::bind((std::net::Ipv4Addr::UNSPECIFIED, port)).await?;
    eprintln!("Rex Hub {} :{port}", env!("CARGO_PKG_VERSION"));
    axum::serve(
        listener,
        Router::new().fallback(any(handler)).with_state(app),
    )
    .with_graceful_shutdown(shutdown())
    .await?;
    Ok(())
}

use crate::{err, json, put_file, App, Result};
use axum::{
    body::Body,
    http::{header, HeaderMap, HeaderValue, Method, StatusCode},
    response::Response,
};
use regex::Regex;
use rusqlite::{params, Connection, OptionalExtension, Row};
use serde_json::{json, Value};
use std::{
    collections::{HashMap, HashSet},
    sync::{LazyLock, MutexGuard},
    time::Duration,
};
use tokio::{
    io::{AsyncReadExt, Take},
    sync::{MutexGuard as AsyncGuard, Semaphore},
};
use tokio_util::io::ReaderStream;
use url::Url;
use uuid::Uuid;

const JSON_LIMIT: usize = 10 * 1024 * 1024;
const IMAGE_LIMIT: usize = 2 * 1024 * 1024;
const PLAN_LIMIT: usize = 5000 * 4098 + 2;
const BATCH: i64 = 8;
const PAGE: usize = 48;
const TYPES: [&str; 7] = [
    "",
    "image/png",
    "image/jpeg",
    "image/gif",
    "image/webp",
    "image/avif",
    "image/svg+xml",
];
const COLS: &str = "p.id,p.alias,p.mode,p.url,p.base,p.groups,p.filters,p.assets,p.done,p.failed,p.cursor,p.retry_cursor,p.error,p.generation,p.highwater,p.cleanup,p.cleanup_cursor,p.deleting";
static IMPORTS: Semaphore = Semaphore::const_new(4);
static MANIFEST_READS: Semaphore = Semaphore::const_new(4);
static MANUAL_BATCH: Semaphore = Semaphore::const_new(1);
static HOST: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r"^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z](?:[a-z0-9-]{0,61}[a-z0-9])$")
        .unwrap()
});
static BAD_HOST: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r"(?:^|\.)(?:localhost|local|localdomain|internal|intranet|lan|home|corp|onion|test|invalid|example|alt|arpa|nip\.io|sslip\.io|xip\.io|localtest\.me|lvh\.me|localhost\.direct)$").unwrap()
});
static SCHEME: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"(?i)^[a-z][a-z0-9+.-]*:").unwrap());
static SECRET: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r"token|(?:^|[_-])(?:key|secret|password|passwd|credential|authorization|auth|session|sig|signature|ticket|jwt|code)(?:$|[_-])|apikey|accesskey|privatekey|clientsecret|x-amz|x-goog|x-oss|^x-ms-|^cf-|^jwt$|^awsaccesskeyid$|^(?:policy|keypairid|key-pair-id|se|sp|sr|sv|skt|ske|skoid|sktid|sks|skv)$").unwrap()
});
static SECRET_VALUE: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r"(?i)(?:^bearer\s|://[^/\s]*@|^eyJ[a-z0-9_-]+\.[a-z0-9_-]+\.[a-z0-9_-]+$)").unwrap()
});
static SVG_PREAMBLE: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r#"(?s)^(?:<!--.*?-->|<!DOCTYPE\s+svg(?:\s+(?:PUBLIC\s+"[^"]*"\s+"[^"]*"|SYSTEM\s+"[^"]*"))?\s*>)\s*"#).unwrap()
});
static SVG_XML: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"^<\?xml\s[^?]*\?>\s*").unwrap());
static SVG_ROOT: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"^<svg(?:\s|/?>)").unwrap());

fn controls(value: &str) -> bool {
    value.chars().any(|c| {
        c.is_control()
            || matches!(c, '\u{202a}'..='\u{202e}' | '\u{2066}'..='\u{2069}' | '\u{fffd}')
    })
}

fn string<'a>(value: &'a Value, max: usize, label: &str) -> Result<&'a str> {
    match value
        .as_str()
        .filter(|s| s.len() <= max * 4 && s.encode_utf16().count() <= max && !controls(s))
    {
        Some(s) => Ok(s.trim()),
        None => Err(err(400, format!("{label}格式无效"))),
    }
}

fn path_segment(part: &str) -> Result<()> {
    let bytes = part.as_bytes();
    let mut i = 0;
    let mut decoded = Vec::with_capacity(bytes.len());
    while i < bytes.len() {
        if bytes[i] == b'%' {
            let digits = bytes
                .get(i + 1..i + 3)
                .ok_or_else(|| err(400, "网址路径编码无效"))?;
            let (a, b) = (
                (digits[0] as char).to_digit(16),
                (digits[1] as char).to_digit(16),
            );
            match (a, b) {
                (Some(a), Some(b)) => decoded.push((a * 16 + b) as u8),
                _ => return Err(err(400, "网址路径编码无效")),
            }
            i += 3;
        } else {
            decoded.push(bytes[i]);
            i += 1;
        }
    }
    let value = std::str::from_utf8(&decoded).map_err(|_| err(400, "网址路径编码无效"))?;
    if value == ".."
        || (value == "." && part != ".")
        || value.contains(['/', '\\', '%'])
        || controls(value)
    {
        return Err(err(400, "网址路径不安全"));
    }
    Ok(())
}

fn public_url(value: &str, base: Option<&Url>) -> Result<Url> {
    let bad = || err(400, "只允许无凭据的公开 HTTPS 网址");
    if value.encode_utf16().count() > 2048 || controls(value) {
        return Err(err(400, "网址格式无效"));
    }
    let input = value.trim();
    let authority = input
        .get(..8)
        .filter(|p| p.eq_ignore_ascii_case("https://"))
        .map(|_| input[8..].split(['/', '?']).next().unwrap_or(""));
    if input.is_empty()
        || input.contains(['\\', '#'])
        || input.starts_with("//")
        || authority.is_some_and(|a| a.is_empty() || a.contains('@'))
        || (authority.is_none() && (base.is_none() || SCHEME.is_match(input)))
    {
        return Err(bad());
    }
    for part in input.split('?').next().unwrap_or("").split('/') {
        path_segment(part)?;
    }
    let url = match base {
        Some(base) => base.join(input),
        None => Url::parse(input),
    }
    .map_err(|_| err(400, "网址无效"))?;
    let host = url.host_str().unwrap_or("");
    if url.scheme() != "https"
        || !url.username().is_empty()
        || url.password().is_some()
        || url.port().is_some()
        || host.len() > 253
        || !HOST.is_match(host)
        || BAD_HOST.is_match(host)
    {
        return Err(bad());
    }
    for (key, value) in url.query_pairs() {
        let mut name = String::new();
        let mut separator = false;
        for c in key.to_lowercase().chars() {
            if c.is_whitespace() || matches!(c, '.' | '[' | ']') {
                if !separator {
                    name.push('_');
                }
                separator = true;
            } else {
                name.push(c);
                separator = false;
            }
        }
        if name.is_empty()
            || name.len() > 80
            || !name
                .bytes()
                .all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b == b'_' || b == b'-')
            || SECRET.is_match(&name)
            || SECRET.is_match(&name.replace(['_', '-'], ""))
            || controls(&value)
            || SECRET_VALUE.is_match(&value)
        {
            return Err(err(400, "网址不得包含疑似凭据的查询参数"));
        }
    }
    if url.as_str().len() > 2048 {
        return Err(err(400, "网址过长"));
    }
    Ok(url)
}

fn normalize_origin(origin: &str) -> Result<String> {
    let parsed = Url::parse(origin).map_err(|_| err(500, "公开站点地址无效"))?;
    if !matches!(parsed.scheme(), "http" | "https")
        || !parsed.username().is_empty()
        || parsed.password().is_some()
    {
        return Err(err(500, "公开站点地址无效"));
    }
    Ok(parsed.origin().ascii_serialization())
}

fn source_key(id: &str) -> String {
    format!("badge-source/{id}.json")
}
fn plan_key(id: &str) -> String {
    format!("badge-source/{id}.plan")
}
fn asset_key(id: &str, generation: i64, slot: i64) -> String {
    format!("badge-assets/{id}/{generation}-{slot}")
}
fn millis() -> i64 {
    chrono::Utc::now().timestamp_millis()
}

fn valid_id(id: &str) -> bool {
    id.len() == 36
        && id.bytes().enumerate().all(|(i, b)| {
            if [8, 13, 18, 23].contains(&i) {
                b == b'-'
            } else {
                b.is_ascii_digit() || (b'a'..=b'f').contains(&b)
            }
        })
}

fn db(app: &App) -> Result<MutexGuard<'_, Connection>> {
    app.db.lock().map_err(|_| err(500, "数据库暂不可用"))
}

fn lock(app: &App) -> Result<AsyncGuard<'_, ()>> {
    app.badge_lock
        .try_lock()
        .map_err(|_| err(409, "徽章任务处理中，请稍后重试"))
}

struct Pack {
    id: String,
    alias: String,
    mode: String,
    url: String,
    base: String,
    groups: i64,
    filters: i64,
    assets: i64,
    done: i64,
    failed: i64,
    cursor: i64,
    retry_cursor: Option<i64>,
    error: Option<String>,
    generation: i64,
    highwater: i64,
    cleanup: bool,
    cleanup_cursor: i64,
    deleting: bool,
}

impl Pack {
    fn row(r: &Row<'_>) -> rusqlite::Result<Self> {
        Ok(Self {
            id: r.get(0)?,
            alias: r.get(1)?,
            mode: r.get(2)?,
            url: r.get(3)?,
            base: r.get(4)?,
            groups: r.get(5)?,
            filters: r.get(6)?,
            assets: r.get(7)?,
            done: r.get(8)?,
            failed: r.get(9)?,
            cursor: r.get(10)?,
            retry_cursor: r.get(11)?,
            error: r.get(12)?,
            generation: r.get(13)?,
            highwater: r.get(14)?,
            cleanup: r.get(15)?,
            cleanup_cursor: r.get(16)?,
            deleting: r.get(17)?,
        })
    }

    fn ready(&self) -> bool {
        self.mode == "link" || self.done == self.assets
    }
    fn pending(&self) -> bool {
        self.mode == "host" && (self.cursor < self.assets || self.retry_cursor.is_some())
    }
    fn item(&self) -> Value {
        let mut item = json!({"id":self.id,"alias":self.alias,"mode":self.mode,"url":self.url,"groups":self.groups,"filters":self.filters,"assets":self.assets,"done":self.done,"failed":self.failed,"status":if self.ready() {"ready"} else if self.pending() {"queued"} else {"error"}});
        if let Some(error) = self.error.as_ref().filter(|e| !e.is_empty()) {
            item["error"] = json!(error);
        }
        item
    }
}

fn pack(conn: &Connection, id: &str) -> Result<Pack> {
    if !valid_id(id) {
        return Err(err(400, "徽章包 ID 无效"));
    }
    conn.query_row(
        &format!("SELECT {COLS} FROM badge_packs p WHERE p.id=?1 AND p.deleting=0"),
        [id],
        Pack::row,
    )
    .optional()?
    .ok_or_else(|| err(404, "徽章包不存在"))
}

fn get_pack(app: &App, id: &str) -> Result<Pack> {
    pack(&*db(app)?, id)
}

struct Plan {
    data: Value,
    targets: Vec<String>,
    slots: HashMap<String, usize>,
}

fn visit(
    value: &mut Value,
    depth: usize,
    action: &mut impl FnMut(&mut Value) -> Result<()>,
) -> Result<()> {
    if depth > 48 {
        return Err(err(422, "徽章包 JSON 嵌套过深"));
    }
    match value {
        Value::Object(fields) => {
            for (key, field) in fields {
                if key == "imageURL" {
                    action(field)?;
                } else {
                    visit(field, depth + 1, action)?;
                }
            }
        }
        Value::Array(items) => {
            for item in items {
                visit(item, depth + 1, action)?;
            }
        }
        _ => (),
    }
    Ok(())
}

fn compile(bytes: &[u8], base: &str) -> Result<Plan> {
    let text = std::str::from_utf8(bytes).map_err(|_| err(422, "徽章包不是有效 UTF-8"))?;
    let mut data: Value = serde_json::from_str(text.strip_prefix('\u{feff}').unwrap_or(text))
        .map_err(|_| err(422, "徽章包必须是有效的 JSON"))?;
    let groups = data["groups"]
        .as_array()
        .ok_or_else(|| err(422, "徽章包必须包含 groups 和 filters 数组"))?;
    let filters = data["filters"]
        .as_array()
        .ok_or_else(|| err(422, "徽章包必须包含 groups 和 filters 数组"))?;
    if groups.len() > 500 || filters.len() > 5000 {
        return Err(err(413, "徽章包分组或规则过多"));
    }
    let mut group_ids = HashSet::new();
    for group in groups {
        let valid = group["id"].as_str().is_some_and(|id| {
            !id.is_empty()
                && id.len() <= 640
                && id.encode_utf16().count() <= 160
                && group_ids.insert(id)
        });
        if !valid || !group["name"].is_string() {
            return Err(err(422, "徽章分组无效或 ID 重复"));
        }
    }
    for filter in filters {
        if !filter["name"].is_string()
            || (!filter["groupId"].is_null() && !filter["groupId"].is_string())
        {
            return Err(err(422, "徽章规则无效"));
        }
    }
    let base = if base.is_empty() {
        None
    } else {
        Some(public_url(base, None)?)
    };
    let mut targets = Vec::new();
    let mut by_url = HashMap::new();
    let mut slots = HashMap::new();
    visit(&mut data, 0, &mut |value| {
        if value.is_null() {
            return Ok(());
        }
        let raw = value
            .as_str()
            .ok_or_else(|| err(422, "imageURL 必须是字符串"))?;
        if raw.is_empty() || slots.contains_key(raw) {
            return Ok(());
        }
        let url = public_url(raw, base.as_ref())?.to_string();
        let slot = *by_url.entry(url.clone()).or_insert_with(|| {
            let slot = targets.len();
            targets.push(url);
            slot
        });
        slots.insert(raw.to_owned(), slot);
        if targets.len() > 5000 {
            return Err(err(413, "徽章包图片过多"));
        }
        Ok(())
    })?;
    Ok(Plan {
        data,
        targets,
        slots,
    })
}

async fn read_local(app: &App, key: &str, cap: usize) -> Option<Vec<u8>> {
    let mut f = tokio::fs::File::open(app.files.join(key))
        .await
        .ok()?
        .take((cap + 1) as u64);
    let mut bytes = Vec::new();
    f.read_to_end(&mut bytes).await.ok()?;
    (bytes.len() <= cap).then_some(bytes)
}

async fn stored_source(app: &App, p: &Pack) -> Result<Plan> {
    let unavailable = || err(503, "徽章源文件暂不可读，请稍后重试");
    let bytes = read_local(app, &source_key(&p.id), JSON_LIMIT)
        .await
        .ok_or_else(unavailable)?;
    compile(&bytes, &p.base).map_err(|_| unavailable())
}

async fn fetch(app: &App, url: &str, cap: usize, secs: u64) -> Result<(Vec<u8>, String)> {
    let (bytes, final_url) = tokio::time::timeout(
        Duration::from_secs(secs),
        crate::sources::fetch_public(app, url, cap),
    )
    .await
    .map_err(|_| err(504, "上游请求超时"))??;
    Ok((bytes, public_url(&final_url, None)?.to_string()))
}

fn mode(value: &Value) -> Result<&str> {
    value
        .as_str()
        .filter(|v| matches!(*v, "host" | "link"))
        .ok_or_else(|| err(400, "徽章包模式无效"))
}

fn id(value: &Value) -> Result<&str> {
    value.as_str().ok_or_else(|| err(400, "徽章包 ID 无效"))
}

async fn import(app: &App, a: &Value) -> Result<Value> {
    let permit = IMPORTS
        .try_acquire()
        .map_err(|_| err(409, "徽章导入处理中，请稍后重试"))?;
    let mode = mode(&a["mode"])?;
    let remote = a.get("url").is_some();
    if remote == a.get("text").is_some() {
        return Err(err(400, "请选择 JSON 网址或文件，不能同时提供"));
    }
    let alias = if a["alias"].is_null() {
        ""
    } else {
        string(&a["alias"], 120, "别名")?
    };
    let (bytes, url, base, fallback) = if remote {
        let url = public_url(string(&a["url"], 2048, "网址")?, None)?;
        let fallback = url
            .path()
            .rsplit('/')
            .next()
            .filter(|p| !p.is_empty())
            .unwrap_or_else(|| url.host_str().unwrap_or(""))
            .to_owned();
        let (bytes, base) = fetch(app, url.as_str(), JSON_LIMIT, 12).await?;
        (bytes, url.to_string(), base, fallback)
    } else {
        if mode != "host" {
            return Err(err(400, "本地 JSON 只能使用托管模式"));
        }
        let fallback = if a["filename"].is_null() {
            "徽章包"
        } else {
            string(&a["filename"], 180, "文件名")?
        };
        let bytes = a["text"]
            .as_str()
            .filter(|s| s.len() <= JSON_LIMIT)
            .ok_or_else(|| err(413, "本地徽章包超过 10 MiB 或无效"))?
            .as_bytes()
            .to_vec();
        let base = if a["baseUrl"].is_null() || a["baseUrl"].as_str() == Some("") {
            String::new()
        } else {
            public_url(string(&a["baseUrl"], 2048, "网址")?, None)?.to_string()
        };
        (bytes, String::new(), base, fallback.to_owned())
    };
    let fallback: String = fallback.chars().take(120).collect();
    let alias = if !alias.is_empty() {
        alias
    } else if !fallback.is_empty() {
        &fallback
    } else {
        "徽章包"
    };
    let Plan { data, targets, .. } = compile(&bytes, &base)?;
    let groups = data["groups"].as_array().map_or(0, Vec::len) as i64;
    let filters = data["filters"].as_array().map_or(0, Vec::len) as i64;
    drop(data);
    let count = targets.len() as i64;
    let plan = serde_json::to_vec(&targets).map_err(|_| err(500, "无法生成徽章图片清单"))?;
    let id = Uuid::new_v4().to_string();
    let _guard = lock(app)?;
    let time = millis();
    db(app)?.execute("INSERT INTO badge_packs (id,alias,mode,url,base,groups,filters,assets,created,touched,deleting,cleanup) VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?9,1,1)", params![id,alias,mode,url,base,groups,filters,count,time])?;
    put_file(app, &source_key(&id), &bytes).await?;
    put_file(app, &plan_key(&id), &plan).await?;
    db(app)?.execute(
        "UPDATE badge_packs SET deleting=0,cleanup=0 WHERE id=?1",
        [&id],
    )?;
    drop(permit);
    Ok(json!({"ok":true,"id":id}))
}

fn list(app: &App) -> Result<Value> {
    let conn = db(app)?;
    let active: Option<String> =
        conn.query_row("SELECT active_id FROM badge_state WHERE id=1", [], |r| {
            r.get(0)
        })?;
    let mut statement = conn.prepare(&format!(
        "SELECT {COLS} FROM badge_packs p WHERE p.deleting=0 ORDER BY p.created DESC,p.id"
    ))?;
    let items = statement
        .query_map([], Pack::row)?
        .map(|p| p.map(|p| p.item()))
        .collect::<rusqlite::Result<Vec<_>>>()?;
    Ok(json!({"activeId":active.unwrap_or_default(),"items":items}))
}

async fn preview(app: &App, q: &HashMap<String, String>, origin: &str) -> Result<Value> {
    let p = get_pack(app, q.get("id").map_or("", String::as_str))?;
    let search_value = q.get("q").map_or("", String::as_str);
    if search_value.len() > 800
        || search_value.encode_utf16().count() > 200
        || controls(search_value)
    {
        return Err(err(400, "搜索格式无效"));
    }
    let search = search_value.trim().to_lowercase();
    let page = q
        .get("page")
        .map_or(Some(1), |s| s.trim().parse::<usize>().ok())
        .filter(|p| (1..=100_000).contains(p))
        .ok_or_else(|| err(400, "页码无效"))?;
    let group = q.get("group").filter(|s| !s.is_empty());
    let origin = normalize_origin(origin)?;
    let _permit = MANIFEST_READS
        .try_acquire()
        .map_err(|_| err(503, "徽章预览处理中，请稍后重试"))?;
    let plan = stored_source(app, &p).await?;
    let groups: Vec<_> = plan.data["groups"]
        .as_array()
        .into_iter()
        .flatten()
        .map(|g| json!({"id":g["id"],"name":g["name"]}))
        .collect();
    let offset = (page - 1) * PAGE;
    let mut total = 0;
    let mut items = Vec::new();
    for f in plan.data["filters"].as_array().into_iter().flatten() {
        let name = f["name"].as_str().unwrap_or("");
        if group.is_some_and(|g| f["groupId"].as_str() != Some(g.as_str()))
            || (!search.is_empty() && !name.to_lowercase().contains(&search))
        {
            continue;
        }
        if (offset..offset + PAGE).contains(&total) {
            let image = f["imageURL"]
                .as_str()
                .and_then(|s| plan.slots.get(s))
                .map_or_else(String::new, |slot| {
                    if p.mode == "host" && p.ready() {
                        format!("{origin}/{}", asset_key(&p.id, p.generation, *slot as i64))
                    } else {
                        plan.targets[*slot].clone()
                    }
                });
            items.push(json!({"name":name,"groupId":f["groupId"].as_str().unwrap_or(""),"imageURL":image,"tagColor":f["tagColor"].as_str().unwrap_or(""),"textColor":f["textColor"].as_str().unwrap_or(""),"borderColor":f["borderColor"].as_str().unwrap_or("")}));
        }
        total += 1;
    }
    Ok(json!({"groups":groups,"items":items,"total":total,"page":page,"pageSize":PAGE}))
}

fn set_active(app: &App, a: &Value) -> Result<Value> {
    let id = id(&a["id"])?;
    let _guard = lock(app)?;
    let conn = db(app)?;
    let active = if id.is_empty() {
        None
    } else {
        if !pack(&conn, id)?.ready() {
            return Err(err(409, "必须先完成全部徽章图片托管"));
        }
        Some(id)
    };
    conn.execute("UPDATE badge_state SET active_id=?1 WHERE id=1", [active])?;
    Ok(json!({"ok":true,"id":id}))
}

fn update(app: &App, a: &Value) -> Result<Value> {
    let id = id(&a["id"])?;
    let _guard = lock(app)?;
    let mut conn = db(app)?;
    let tx = conn.transaction()?;
    let p = pack(&tx, id)?;
    let deleting = a["delete"].as_bool() == Some(true);
    let alias = a
        .get("alias")
        .map(|v| string(v, 120, "别名"))
        .transpose()?
        .unwrap_or(&p.alias);
    if alias.is_empty() && !deleting {
        return Err(err(400, "别名不能为空"));
    }
    let mode = a.get("mode").map(mode).transpose()?.unwrap_or(&p.mode);
    let time = millis();
    if deleting {
        tx.execute(
            "UPDATE badge_state SET active_id=NULL WHERE id=1 AND active_id=?1",
            [id],
        )?;
        tx.execute(
            "UPDATE badge_packs SET deleting=1,cleanup=1,touched=?2 WHERE id=?1",
            params![id, time],
        )?;
    } else if mode != p.mode {
        if mode == "link" && p.url.is_empty() {
            return Err(err(400, "本地 JSON 只能使用托管模式"));
        }
        if p.cleanup {
            return Err(err(409, "旧图片尚在分批清理，请稍后重试"));
        }
        let host = mode == "host";
        tx.execute("DELETE FROM badge_failures WHERE pack=?1", [id])?;
        tx.execute("UPDATE badge_packs SET mode=?2,alias=?3,cursor=0,done=0,failed=0,error=NULL,retry_cursor=NULL,cleanup=?4,cleanup_cursor=0,generation=generation+?5,touched=?6 WHERE id=?1",
            params![id,mode,alias,!host && p.highwater > 0,i64::from(host),time])?;
        if host && p.assets > 0 {
            tx.execute(
                "UPDATE badge_state SET active_id=NULL WHERE id=1 AND active_id=?1",
                [id],
            )?;
        }
    } else {
        let retry = a["retry"].as_bool() == Some(true);
        tx.execute("UPDATE badge_packs SET alias=?2,retry_cursor=CASE WHEN ?3 AND mode='host' AND failed>0 THEN COALESCE(retry_cursor,-1) ELSE retry_cursor END,touched=?4 WHERE id=?1", params![id,alias,retry,time])?;
    }
    tx.commit()?;
    Ok(json!({"ok":true,"id":id}))
}

fn image_type(bytes: &[u8]) -> Option<u8> {
    if bytes.starts_with(b"\x89PNG\r\n\x1a\n") {
        return Some(1);
    }
    if bytes.starts_with(b"\xff\xd8\xff") {
        return Some(2);
    }
    if bytes.starts_with(b"GIF87a") || bytes.starts_with(b"GIF89a") {
        return Some(3);
    }
    if bytes.starts_with(b"RIFF") && bytes.get(8..12) == Some(b"WEBP") {
        return Some(4);
    }
    if bytes
        .get(4..12)
        .is_some_and(|s| s == b"ftypavif" || s == b"ftypavis")
    {
        return Some(5);
    }
    let head = String::from_utf8_lossy(&bytes[..bytes.len().min(4096)]);
    let mut rest = head.trim_start_matches(|c: char| c == '\u{feff}' || c.is_whitespace());
    if let Some(xml) = SVG_XML.find(rest) {
        rest = &rest[xml.end()..];
    }
    for _ in 0..8 {
        if let Some(pre) = SVG_PREAMBLE.find(rest) {
            rest = &rest[pre.end()..];
        } else {
            break;
        }
    }
    SVG_ROOT.is_match(rest).then_some(6)
}

async fn download_asset(app: &App, target: &str) -> Result<Vec<u8>> {
    let url = public_url(target, None)?;
    let (bytes, _) = fetch(app, url.as_str(), IMAGE_LIMIT, 7).await?;
    let kind = image_type(&bytes)
        .ok_or_else(|| err(422, "上游不是支持的 PNG、JPEG、GIF、WebP、AVIF 或 SVG 图片"))?;
    let mut payload = Vec::with_capacity(bytes.len() + 1);
    payload.push(kind);
    payload.extend_from_slice(&bytes);
    Ok(payload)
}

fn batch_slots(app: &App, p: &Pack) -> Result<Vec<i64>> {
    if let Some(cursor) = p.retry_cursor {
        let conn = db(app)?;
        let mut statement = conn.prepare(
            "SELECT slot FROM badge_failures WHERE pack=?1 AND slot>?2 ORDER BY slot LIMIT ?3",
        )?;
        let slots = statement
            .query_map(params![p.id, cursor, BATCH], |r| r.get(0))?
            .collect::<rusqlite::Result<Vec<_>>>()?;
        Ok(slots)
    } else {
        Ok((p.cursor..p.assets.min(p.cursor + BATCH)).collect())
    }
}

async fn process(app: &App, p: &Pack) -> Result<()> {
    process_with(app, p, |url| async move { download_asset(app, &url).await }).await
}

async fn process_with<F, Fut>(app: &App, p: &Pack, download: F) -> Result<()>
where
    F: Fn(String) -> Fut,
    Fut: std::future::Future<Output = Result<Vec<u8>>>,
{
    if !p.pending() || p.cleanup {
        return Ok(());
    }
    let slots = batch_slots(app, p)?;
    let Some(&last) = slots.last() else {
        db(app)?.execute(
            "UPDATE badge_packs SET retry_cursor=NULL,touched=?2 WHERE id=?1",
            params![p.id, millis()],
        )?;
        return Ok(());
    };
    let unavailable = || err(503, "徽章图片清单暂不可用");
    let bytes = read_local(app, &plan_key(&p.id), PLAN_LIMIT)
        .await
        .ok_or_else(unavailable)?;
    let plan: Vec<String> = serde_json::from_slice(&bytes).map_err(|_| unavailable())?;
    if plan.len() as i64 != p.assets || slots.iter().any(|s| !(0..p.assets).contains(s)) {
        return Err(unavailable());
    }
    db(app)?.execute(
        "UPDATE badge_packs SET highwater=MAX(highwater,?2) WHERE id=?1",
        params![p.id, last + 1],
    )?;
    let mut outcomes = Vec::new();
    for chunk in slots.chunks(4) {
        let work = |i: usize| {
            let input = chunk
                .get(i)
                .map(|&slot| (slot, download(plan[slot as usize].clone())));
            async move {
                if let Some((slot, future)) = input {
                    Some((slot, future.await))
                } else {
                    None
                }
            }
        };
        let results = tokio::join!(work(0), work(1), work(2), work(3));
        for (slot, download) in [results.0, results.1, results.2, results.3]
            .into_iter()
            .flatten()
        {
            let failure = match download {
                Ok(bytes) => put_file(app, &asset_key(&p.id, p.generation, slot), &bytes)
                    .await
                    .err()
                    .map(|_| "图片存储失败，请稍后重试".to_owned()),
                Err(e) => Some(e.message),
            };
            outcomes.push((slot, failure));
        }
    }
    let mut conn = db(app)?;
    let tx = conn.transaction()?;
    let retry = p.retry_cursor.is_some();
    let mut good = 0i64;
    let mut bad = 0i64;
    let mut first = None;
    for (slot, error) in &outcomes {
        if let Some(error) = error {
            tx.execute(
                "INSERT OR REPLACE INTO badge_failures (pack,slot,error) VALUES (?1,?2,?3)",
                params![p.id, slot, error],
            )?;
            if first.is_none() {
                first = Some(error);
            }
            bad += 1;
        } else {
            if retry {
                tx.execute(
                    "DELETE FROM badge_failures WHERE pack=?1 AND slot=?2",
                    params![p.id, slot],
                )?;
            }
            good += 1;
        }
    }
    let failed = if retry {
        p.failed - good
    } else {
        p.failed + bad
    };
    let next_retry = if retry && failed > 0 {
        let later: bool = tx.query_row(
            "SELECT EXISTS(SELECT 1 FROM badge_failures WHERE pack=?1 AND slot>?2)",
            params![p.id, last],
            |r| r.get(0),
        )?;
        later.then_some(last)
    } else {
        None
    };
    let error = if failed == 0 {
        None
    } else {
        first.map(String::as_str).or(p.error.as_deref())
    };
    tx.execute("UPDATE badge_packs SET done=done+?2,failed=?3,error=?4,cursor=?5,retry_cursor=?6,touched=?7 WHERE id=?1",
        params![p.id,good,failed,error,if retry {p.cursor} else {last+1},next_retry,millis()])?;
    tx.commit()?;
    Ok(())
}

async fn remove(app: &App, key: &str) -> Result<()> {
    match tokio::fs::remove_file(app.files.join(key)).await {
        Ok(()) => Ok(()),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(e) => Err(e.into()),
    }
}

async fn cleanup(app: &App, p: &Pack) -> Result<()> {
    let end = p.highwater.min(p.cleanup_cursor + BATCH);
    for slot in p.cleanup_cursor..end {
        remove(app, &asset_key(&p.id, p.generation, slot)).await?;
    }
    let finished = end == p.highwater;
    if finished && p.highwater > 0 {
        let _ = tokio::fs::remove_dir(app.files.join("badge-assets").join(&p.id)).await;
    }
    if finished && p.deleting && end - p.cleanup_cursor <= BATCH - 2 {
        remove(app, &source_key(&p.id)).await?;
        remove(app, &plan_key(&p.id)).await?;
        let mut conn = db(app)?;
        let tx = conn.transaction()?;
        tx.execute("DELETE FROM badge_failures WHERE pack=?1", [&p.id])?;
        tx.execute("DELETE FROM badge_packs WHERE id=?1", [&p.id])?;
        tx.commit()?;
    } else if finished && !p.deleting {
        db(app)?.execute(
            "UPDATE badge_packs SET highwater=0,cleanup=0,cleanup_cursor=0,touched=?2 WHERE id=?1",
            params![p.id, millis()],
        )?;
    } else {
        db(app)?.execute(
            "UPDATE badge_packs SET cleanup_cursor=?2,touched=?3 WHERE id=?1",
            params![p.id, end, millis()],
        )?;
    }
    Ok(())
}

async fn advance(app: &App, p: &Pack) -> Result<()> {
    let result = if p.cleanup {
        cleanup(app, p).await
    } else {
        process(app, p).await
    };
    if result.is_err() {
        db(app)?.execute(
            "UPDATE badge_packs SET touched=?2 WHERE id=?1",
            params![p.id, millis()],
        )?;
    }
    result
}

pub async fn tick(app: &App) -> Result<()> {
    let Ok(_guard) = app.badge_lock.try_lock() else {
        return Ok(());
    };
    let next = db(app)?.query_row(&format!("SELECT {COLS} FROM badge_packs p WHERE p.cleanup=1 OR (p.cleanup=0 AND p.deleting=0 AND p.mode='host' AND (p.cursor<p.assets OR p.retry_cursor IS NOT NULL)) ORDER BY p.touched,p.id LIMIT 1"), [], Pack::row).optional()?;
    if let Some(p) = next {
        advance(app, &p).await?;
    }
    Ok(())
}

pub async fn api(
    app: &App,
    path: &str,
    method: &Method,
    query: &HashMap<String, String>,
    data: &Value,
    origin: &str,
) -> Result<Response> {
    let body = match path {
        "/api/badges" if method == Method::GET => list(app)?,
        "/api/badges/preview" if method == Method::GET => preview(app, query, origin).await?,
        "/api/badges" | "/api/badges/preview" => return Err(err(405, "不支持此请求方法")),
        "/api/badges/import"
        | "/api/badges/update"
        | "/api/badges/active"
        | "/api/badges/process" => {
            if method != Method::POST {
                return Err(err(405, "不支持此请求方法"));
            }
            if !data.is_object() {
                return Err(err(400, "需要 JSON 对象"));
            }
            match path {
                "/api/badges/import" => import(app, data).await?,
                "/api/badges/update" => update(app, data)?,
                "/api/badges/active" => set_active(app, data)?,
                _ => {
                    let _permit = MANUAL_BATCH.try_acquire().map_err(|_| err(409, "徽章任务处理中，请稍后重试"))?;
                    let id = id(&data["id"])?;
                    let _guard = app.badge_lock.lock().await;
                    let p = get_pack(app, id)?;
                    advance(app, &p).await?;
                    json!({"ok":true,"id":id,"item":get_pack(app,id)?.item()})
                }
            }
        }
        _ => return Err(err(404, "接口不存在")),
    };
    Ok(json(body))
}

fn public_headers(h: &mut HeaderMap) {
    h.insert(header::CACHE_CONTROL, HeaderValue::from_static("no-store"));
    h.insert(
        header::X_CONTENT_TYPE_OPTIONS,
        HeaderValue::from_static("nosniff"),
    );
    h.insert(
        header::REFERRER_POLICY,
        HeaderValue::from_static("no-referrer"),
    );
}

fn response(code: StatusCode, content: &'static str, body: Body) -> Response {
    let mut r = Response::new(body);
    *r.status_mut() = code;
    public_headers(r.headers_mut());
    if !content.is_empty() {
        r.headers_mut()
            .insert(header::CONTENT_TYPE, HeaderValue::from_static(content));
    }
    r
}

fn say(head: bool, code: StatusCode, message: &'static str) -> Response {
    response(
        code,
        "text/plain; charset=utf-8",
        if head {
            Body::empty()
        } else {
            Body::from(message)
        },
    )
}

fn unavailable(head: bool) -> Response {
    let mut r = say(
        head,
        StatusCode::SERVICE_UNAVAILABLE,
        "Badge storage temporarily unavailable",
    );
    r.headers_mut()
        .insert(header::RETRY_AFTER, HeaderValue::from_static("30"));
    r
}

fn asset_parts(path: &str) -> Option<(&str, i64, i64)> {
    let (id, suffix) = path.strip_prefix("/badge-assets/")?.split_once('/')?;
    let (g, s) = suffix.split_once('-')?;
    if !valid_id(id)
        || g.is_empty()
        || g.len() > 13
        || g.starts_with('0')
        || s.is_empty()
        || s.len() > 5
        || (s.len() > 1 && s.starts_with('0'))
        || !g.bytes().chain(s.bytes()).all(|b| b.is_ascii_digit())
    {
        return None;
    }
    Some((id, g.parse().ok()?, s.parse().ok()?))
}

async fn read_asset(
    app: &App,
    p: &Pack,
    slot: i64,
) -> std::io::Result<Option<(usize, u64, Take<tokio::fs::File>)>> {
    let mut f = tokio::fs::File::open(app.files.join(asset_key(&p.id, p.generation, slot))).await?;
    let len = f.metadata().await?.len();
    if !(2..=IMAGE_LIMIT as u64 + 1).contains(&len) {
        return Ok(None);
    }
    let typ = f.read_u8().await? as usize;
    Ok((typ != 0 && typ < TYPES.len()).then(|| (typ, len - 1, f.take(len - 1))))
}

pub async fn public(app: &App, path: &str, method: &Method, origin: &str) -> Result<Response> {
    let head = method == Method::HEAD;
    let missing = || say(head, StatusCode::NOT_FOUND, "Not found");
    if method != Method::GET && !head {
        let mut r = say(head, StatusCode::METHOD_NOT_ALLOWED, "Method not allowed");
        r.headers_mut()
            .insert(header::ALLOW, HeaderValue::from_static("GET, HEAD"));
        return Ok(r);
    }
    if path == "/badge.json" {
        let p = db(app)?.query_row(&format!("SELECT {COLS} FROM badge_packs p JOIN badge_state s ON p.id=s.active_id WHERE s.id=1 AND p.deleting=0"), [], Pack::row).optional()?;
        let Some(p) = p.filter(Pack::ready) else {
            return Ok(missing());
        };
        if p.mode == "link" {
            let url = public_url(&p.url, None).map_err(|_| err(503, "徽章包链接暂不可用"))?;
            let mut r = response(StatusCode::FOUND, "", Body::empty());
            r.headers_mut().insert(
                header::LOCATION,
                HeaderValue::from_str(url.as_str()).map_err(|_| err(503, "徽章包链接暂不可用"))?,
            );
            return Ok(r);
        }
        let kind = "application/json; charset=utf-8";
        if head {
            return Ok(response(StatusCode::OK, kind, Body::empty()));
        }
        let Ok(_permit) = MANIFEST_READS.try_acquire() else {
            return Ok(unavailable(false));
        };
        let Ok(mut plan) = stored_source(app, &p).await else {
            return Ok(unavailable(false));
        };
        let origin = normalize_origin(origin)?;
        visit(&mut plan.data, 0, &mut |value| {
            if let Some(slot) = value.as_str().and_then(|v| plan.slots.get(v)) {
                *value = json!(format!(
                    "{origin}/{}",
                    asset_key(&p.id, p.generation, *slot as i64)
                ));
            }
            Ok(())
        })?;
        let body = serde_json::to_vec(&plan.data).map_err(|_| err(500, "无法发布徽章包"))?;
        return Ok(response(StatusCode::OK, kind, Body::from(body)));
    }
    let Some((id, generation, slot)) = asset_parts(path) else {
        return Ok(missing());
    };
    let p = db(app)?
        .query_row(
            &format!(
                "SELECT {COLS} FROM badge_packs p WHERE p.id=?1 AND p.deleting=0 AND p.mode='host'"
            ),
            [id],
            Pack::row,
        )
        .optional()?;
    let Some(p) = p.filter(|p| p.ready() && p.generation == generation && slot < p.assets) else {
        return Ok(missing());
    };
    let (typ, size, file) = match read_asset(app, &p, slot).await {
        Ok(Some(file)) => file,
        Ok(None) => return Ok(missing()),
        Err(_) => return Ok(unavailable(head)),
    };
    let body = if head {
        Body::empty()
    } else {
        Body::from_stream(ReaderStream::new(file))
    };
    let mut r = response(StatusCode::OK, TYPES[typ], body);
    let headers = r.headers_mut();
    headers.insert(header::CONTENT_LENGTH, HeaderValue::from(size));
    headers.insert(header::CONTENT_SECURITY_POLICY, HeaderValue::from_static("sandbox; default-src 'none'; style-src 'unsafe-inline'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'"));
    headers.insert(header::X_FRAME_OPTIONS, HeaderValue::from_static("DENY"));
    Ok(r)
}

#[cfg(test)]
mod tests {
    use super::*;
    use axum::body::to_bytes;
    use std::{path::PathBuf, sync::Mutex};

    const ORIGIN: &str = "https://hub.example.net";
    const PNG: &[u8] = b"\x89PNG\r\n\x1a\nfixture";
    const SVG: &[u8] = br#"<?xml version="1.0"?><!--svg--><!DOCTYPE svg PUBLIC "-//W3C//DTD SVG 1.1//EN" "http://www.w3.org/Graphics/SVG/1.1/DTD/svg11.dtd"><svg xmlns="http://www.w3.org/2000/svg" onload="alert(1)"/>"#;

    struct Fixture(App);

    impl Fixture {
        fn new() -> Self {
            let db = Connection::open_in_memory().unwrap();
            db.execute_batch(include_str!("../../migrations/0003_badges.sql"))
                .unwrap();
            let files = std::env::temp_dir().join(format!("rex-hub-badge-{}", Uuid::new_v4()));
            std::fs::create_dir(&files).unwrap();
            Self(App {
                db: Mutex::new(db),
                badge_lock: Default::default(),
                source_lock: Default::default(),
                http: reqwest::Client::new(),
                files,
                web: PathBuf::new(),
                setup_token: None,
                origin: ORIGIN.into(),
                secure: true,
            })
        }
    }

    impl Drop for Fixture {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.0.files);
        }
    }

    async fn body(r: Response) -> Value {
        serde_json::from_slice(&to_bytes(r.into_body(), JSON_LIMIT).await.unwrap()).unwrap()
    }

    async fn post(app: &App, action: &str, data: Value) -> Result<Value> {
        Ok(body(
            api(
                app,
                &format!("/api/badges/{action}"),
                &Method::POST,
                &HashMap::new(),
                &data,
                ORIGIN,
            )
            .await?,
        )
        .await)
    }

    fn manifest() -> Value {
        let mut filters: Vec<_> = (0..9).map(|i| json!({"name":format!("Rule {i}"),"groupId":"g","imageURL":format!("./{i}.png"),"pattern":"(?i)inert"})).collect();
        filters.push(json!({"name":"Duplicate","groupId":"g","imageURL":"https://cdn.example.net/packs/0.png"}));
        json!({"groups":[{"id":"g","name":"Group","extra":true}],"filters":filters,"extra":{"imageURL":"./8.png","keep":17}})
    }

    async fn run_batch(app: &App, id: &str, fail: bool) -> Pack {
        let p = get_pack(app, id).unwrap();
        process_with(app, &p, |url| async move {
            if fail && url.ends_with("/2.png") {
                return Err(err(422, "test failure"));
            }
            let bytes = if url.ends_with("/8.png") { SVG } else { PNG };
            let mut payload = vec![image_type(bytes).unwrap()];
            payload.extend_from_slice(bytes);
            Ok(payload)
        })
        .await
        .unwrap();
        get_pack(app, id).unwrap()
    }

    #[tokio::test]
    async fn storage_lifecycle() {
        let fixture = Fixture::new();
        let app = &fixture.0;
        let raw = manifest();
        assert_eq!(
            public(app, "/badge.json", &Method::GET, ORIGIN)
                .await
                .unwrap()
                .status(),
            404
        );
        let id = post(app,"import",json!({"mode":"host","baseUrl":"https://cdn.example.net/packs/main.json","text":raw.to_string()})).await.unwrap()["id"].as_str().unwrap().to_owned();
        let query = HashMap::from([
            ("id".into(), id.clone()),
            ("q".into(), "RULE 8".into()),
            ("group".into(), "g".into()),
        ]);
        let preview = body(
            api(
                app,
                "/api/badges/preview",
                &Method::GET,
                &query,
                &Value::Null,
                ORIGIN,
            )
            .await
            .unwrap(),
        )
        .await;
        assert_eq!(
            preview["items"][0]["imageURL"],
            "https://cdn.example.net/packs/8.png"
        );
        assert_eq!(preview["pageSize"], 48);
        assert_eq!(
            post(app, "active", json!({"id":id}))
                .await
                .unwrap_err()
                .status,
            409
        );
        let first = run_batch(app, &id, true).await;
        assert_eq!((first.done, first.failed, first.cursor), (7, 1, 8));
        let second = run_batch(app, &id, true).await;
        assert_eq!(second.item()["status"], "error");
        assert_eq!(second.assets, 9);
        post(app, "update", json!({"id":id,"retry":true}))
            .await
            .unwrap();
        assert!(run_batch(app, &id, false).await.ready());
        post(app, "active", json!({"id":id})).await.unwrap();
        let hosted = body(
            public(app, "/badge.json", &Method::GET, ORIGIN)
                .await
                .unwrap(),
        )
        .await;
        assert_eq!(hosted["groups"], raw["groups"]);
        assert_eq!(
            hosted["filters"][0]["pattern"],
            raw["filters"][0]["pattern"]
        );
        assert_eq!(
            hosted["filters"][0]["imageURL"],
            hosted["filters"][9]["imageURL"]
        );
        assert_eq!(
            hosted["extra"]["imageURL"],
            hosted["filters"][8]["imageURL"]
        );
        let image = hosted["extra"]["imageURL"]
            .as_str()
            .unwrap()
            .strip_prefix(ORIGIN)
            .unwrap();
        let r = public(app, image, &Method::GET, ORIGIN).await.unwrap();
        assert_eq!(r.headers()[header::CONTENT_TYPE], "image/svg+xml");
        assert!(r.headers()[header::CONTENT_SECURITY_POLICY]
            .to_str()
            .unwrap()
            .contains("sandbox; default-src 'none'"));
        assert_eq!(
            &to_bytes(r.into_body(), IMAGE_LIMIT).await.unwrap()[..],
            SVG
        );
        let r = public(app, image, &Method::HEAD, ORIGIN).await.unwrap();
        assert_eq!(r.headers()[header::CONTENT_LENGTH], SVG.len().to_string());
        assert!(to_bytes(r.into_body(), IMAGE_LIMIT)
            .await
            .unwrap()
            .is_empty());
        db(app)
            .unwrap()
            .execute(
                "UPDATE badge_packs SET url='https://cdn.example.net/packs/main.json' WHERE id=?1",
                [&id],
            )
            .unwrap();
        post(app, "update", json!({"id":id,"mode":"link"}))
            .await
            .unwrap();
        let r = public(app, "/badge.json", &Method::HEAD, ORIGIN)
            .await
            .unwrap();
        assert_eq!(r.status(), 302);
        assert_eq!(
            r.headers()[header::LOCATION],
            "https://cdn.example.net/packs/main.json"
        );
        assert_eq!(
            public(app, image, &Method::GET, ORIGIN)
                .await
                .unwrap()
                .status(),
            404
        );
        assert_eq!(
            post(app, "update", json!({"id":id,"mode":"host"}))
                .await
                .unwrap_err()
                .status,
            409
        );
        tick(app).await.unwrap();
        assert_eq!(get_pack(app, &id).unwrap().cleanup_cursor, 8);
        tick(app).await.unwrap();
        assert!(!app.files.join(image.trim_start_matches('/')).exists());
        post(app, "update", json!({"id":id,"mode":"host"}))
            .await
            .unwrap();
        assert_eq!(list(app).unwrap()["activeId"], "");
        assert_eq!(get_pack(app, &id).unwrap().generation, 2);
        run_batch(app, &id, false).await;
        post(app, "update", json!({"id":id,"delete":true}))
            .await
            .unwrap();
        assert!(list(app).unwrap()["items"].as_array().unwrap().is_empty());
        tick(app).await.unwrap();
        assert!(app.files.join(source_key(&id)).exists());
        tick(app).await.unwrap();
        assert!(!app.files.join(source_key(&id)).exists());
        assert!(!app.files.join(plan_key(&id)).exists());
        assert!(!app.files.join("badge-assets").join(&id).exists());
    }

    #[test]
    fn validates_source_format_and_asset_type() {
        let plan = compile(
            manifest().to_string().as_bytes(),
            "https://cdn.example.net/packs/main.json",
        )
        .unwrap();
        assert_eq!(plan.targets.len(), 9);
        assert!(compile(
            br#"{"groups":[],"filters":[{"name":"bad","imageURL":42}]}"#,
            ""
        )
        .is_err());
        assert!(compile(
            br#"{"groups":[{"id":"x","name":"a"},{"id":"x","name":"b"}],"filters":[]}"#,
            ""
        )
        .is_err());
        assert!(public_url("https://files.example.net/logo.svg?width=40", None).is_ok());
        assert!(public_url("https://files.example.net/logo.svg?access_token=x", None).is_err());
        assert_eq!(image_type(SVG), Some(6));
        assert_eq!(image_type(b"<html>not an image</html>"), None);
    }
}

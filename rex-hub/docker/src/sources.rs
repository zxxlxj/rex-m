use crate::{err, put_file, App};
use chrono::{DateTime, SecondsFormat, Utc};
use regex::Regex;
use reqwest::{
    dns::{Addrs, Name, Resolve, Resolving},
    header,
};
use serde_json::{json, Map, Value};
use sha2::{Digest, Sha256};
use std::{
    collections::{BTreeMap, HashSet},
    net::{IpAddr, SocketAddr},
    sync::LazyLock,
    time::Duration,
};
use url::Url;
use uuid::Uuid;

const LIMIT: usize = 1 << 20;
const MAX_ITEMS: usize = 160;
const META: [&str; 9] = [
    "id",
    "title",
    "version",
    "requiredVersion",
    "author",
    "icon",
    "description",
    "contentType",
    "continuousPlay",
];
const INTERVALS: [u64; 8] = [5, 15, 30, 60, 180, 360, 720, 1440];
type R<T> = std::result::Result<T, (u16, String)>;

static SECRET: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r"(?i)token|(?:^|[_-])(?:key|secret|password|passwd|credential|authorization|auth|session|sig|signature|ticket|jwt|code)(?:$|[_-])|apikey|accesskey|privatekey|clientsecret|x-amz|x-goog|x-oss|^x-ms-|^cf-|^jwt$|^awsaccesskeyid$|^(?:policy|keypairid|key-pair-id|se|sp|sr|sv|skt|ske|skoid|sktid|sks|skv)$").unwrap()
});
static SECRET_VALUE: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r"(?i)^bearer\s|://[^/\s]*@|^eyJ[a-z0-9_-]+\.[a-z0-9_-]+\.[a-z0-9_-]+$").unwrap()
});

fn fail(status: u16, message: impl Into<String>) -> (u16, String) {
    (status, message.into())
}
fn s<'a>(v: &'a Value, k: &str) -> &'a str {
    v[k].as_str().unwrap_or("")
}
fn yes(v: &Value, k: &str) -> bool {
    v[k].as_bool().unwrap_or(false)
}
fn has(v: &Value, k: &str) -> bool {
    v.get(k).is_some()
}
fn ws(c: char) -> bool {
    c.is_whitespace() || c == '\u{feff}'
}
fn stamp() -> String {
    Utc::now().to_rfc3339_opts(SecondsFormat::Millis, true)
}
fn bad(c: char) -> bool {
    matches!(c, '\0'..='\u{1f}' | '\u{7f}'..='\u{9f}' | '\u{202a}'..='\u{202e}' | '\u{2066}'..='\u{2069}' | '\u{fffd}')
}
fn text<'a>(v: &'a Value, max: usize, label: &str, required: bool) -> R<&'a str> {
    let valid = v
        .as_str()
        .filter(|x| x.encode_utf16().count() <= max && !x.chars().any(bad));
    match valid.map(|x| x.trim_matches(ws)) {
        Some(x) if !required || !x.is_empty() => Ok(x),
        None if !required && v.is_null() => Ok(""),
        _ => Err(fail(400, format!("{label}格式无效"))),
    }
}
fn public_host(host: &str) -> bool {
    if host.len() > 253 || !host.contains('.') {
        return false;
    }
    let tld = host.rsplit('.').next().unwrap_or("");
    if tld.len() < 2
        || !tld.as_bytes()[0].is_ascii_alphabetic()
        || matches!(
            tld,
            "localhost"
                | "local"
                | "localdomain"
                | "internal"
                | "intranet"
                | "lan"
                | "home"
                | "corp"
                | "onion"
                | "test"
                | "invalid"
                | "example"
                | "alt"
                | "arpa"
        )
    {
        return false;
    }
    if [
        "nip.io",
        "sslip.io",
        "xip.io",
        "localtest.me",
        "lvh.me",
        "localhost.direct",
    ]
    .iter()
    .any(|domain| {
        host == *domain
            || host
                .strip_suffix(domain)
                .is_some_and(|prefix| prefix.ends_with('.'))
    }) {
        return false;
    }
    host.split('.').all(|label| {
        !label.is_empty()
            && label.len() <= 63
            && !label.starts_with('-')
            && !label.ends_with('-')
            && label
                .bytes()
                .all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b == b'-')
    })
}
fn decode(input: &str) -> R<String> {
    fn digit(b: u8) -> Option<u8> {
        (b as char).to_digit(16).map(|n| n as u8)
    }
    let mut out = Vec::with_capacity(input.len());
    let mut it = input.bytes();
    let invalid = || fail(400, "网址路径编码无效");
    while let Some(b) = it.next() {
        if b == b'%' {
            let hi = it.next().and_then(digit).ok_or_else(invalid)?;
            let lo = it.next().and_then(digit).ok_or_else(invalid)?;
            out.push(hi * 16 + lo);
        } else {
            out.push(b);
        }
    }
    String::from_utf8(out).map_err(|_| invalid())
}
fn path_check(input: &str) -> R<()> {
    for part in input.split(['?', '#']).next().unwrap_or("").split('/') {
        let decoded = decode(part)?;
        if decoded == ".."
            || (decoded == "." && part != ".")
            || decoded.contains(['/', '\\', '%'])
            || decoded.chars().any(bad)
        {
            return Err(fail(400, "网址路径不安全"));
        }
    }
    Ok(())
}
fn https(input: &str) -> bool {
    input
        .get(..8)
        .is_some_and(|x| x.eq_ignore_ascii_case("https://"))
}
fn wrapper(u: &Url) -> bool {
    u.host_str() == Some("rexnow.tv") && u.path() == "/widget"
}
fn public_url(input: &str, base: Option<&Url>, allow_wrapper: bool) -> R<Url> {
    let denied = || fail(400, "只允许无凭据的公开 HTTPS 网址");
    if input.encode_utf16().count() > 2048 || input.chars().any(bad) {
        return Err(fail(400, "网址格式无效"));
    }
    let input = input.trim_matches(ws);
    let absolute = https(input);
    let prefix = input.split(['/', '?']).next().unwrap_or("");
    if input.is_empty()
        || input.contains(['\\', '#'])
        || input.starts_with("//")
        || (!absolute && (base.is_none() || prefix.contains(':')))
    {
        return Err(denied());
    }
    if absolute {
        let authority = input[8..].split(['/', '?']).next().unwrap_or("");
        if authority.is_empty() || authority.contains('@') {
            return Err(denied());
        }
    }
    path_check(input)?;
    let u = if absolute {
        Url::parse(input)
    } else {
        base.ok_or_else(denied)?.join(input)
    }
    .map_err(|_| fail(400, "网址无效"))?;
    if u.scheme() != "https"
        || !u.username().is_empty()
        || u.password().is_some()
        || u.port().is_some()
        || !u.host_str().is_some_and(public_host)
    {
        return Err(denied());
    }
    for (key, value) in u.query_pairs() {
        if allow_wrapper && wrapper(&u) && key == "url" {
            continue;
        }
        let mut name = String::new();
        let mut sep = false;
        for c in key.chars() {
            if ws(c) || matches!(c, '.' | '[' | ']') {
                if !sep {
                    name.push('_');
                }
                sep = true;
            } else {
                name.push(c.to_ascii_lowercase());
                sep = false;
            }
        }
        if name.is_empty()
            || name.len() > 80
            || !name
                .bytes()
                .all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || matches!(b, b'_' | b'-'))
            || SECRET.is_match(&name)
            || SECRET.is_match(&name.replace(['_', '-'], ""))
            || value.chars().any(bad)
            || SECRET_VALUE.is_match(&value)
        {
            return Err(fail(400, "网址不得包含疑似凭据的查询参数"));
        }
    }
    if u.as_str().len() > 2048 {
        return Err(fail(400, "网址过长"));
    }
    Ok(u)
}
fn source_url(input: &str) -> R<Url> {
    let u = public_url(input, None, true)?;
    if !wrapper(&u) {
        return Ok(u);
    }
    let mut targets = u.query_pairs().filter(|(k, _)| k == "url");
    let (_, target) = targets
        .next()
        .ok_or_else(|| fail(400, "Rex 包装链接须包含一个 url 参数"))?;
    if targets.next().is_some() {
        return Err(fail(400, "Rex 包装链接须包含一个 url 参数"));
    }
    let target = public_url(&target, None, false)?;
    if wrapper(&target) {
        return Err(fail(400, "不接受嵌套 Rex 包装链接"));
    }
    Ok(target)
}
fn index_url(u: &Url) -> bool {
    let path = decode(u.path()).unwrap_or_default().to_ascii_lowercase();
    let path = path.strip_suffix('/').unwrap_or(&path);
    path.ends_with(".rex") || path.ends_with(".json")
}
fn publish_url(input: &str, base: Option<&Url>, leaf: bool) -> R<Url> {
    let u = public_url(input, base, false)?;
    if leaf && (index_url(&u) || wrapper(&u)) {
        return Err(fail(400, "合集不能包含嵌套索引或 Rex 包装链接"));
    }
    Ok(u)
}
fn local_origin(origin: &str, public: bool) -> R<String> {
    let invalid = || fail(422, "发布站点须为 HTTP(S) 源站地址");
    let u = Url::parse(origin).map_err(|_| invalid())?;
    let site = u.origin().ascii_serialization();
    if public && u.scheme() == "https" {
        public_url(origin, None, false)?;
    }
    if !matches!(u.scheme(), "https" | "http")
        || u.host_str().is_none()
        || !u.username().is_empty()
        || u.password().is_some()
        || u.path() != "/"
        || u.query().is_some()
        || u.fragment().is_some()
        || origin.strip_suffix('/').unwrap_or(origin) != site
    {
        return Err(invalid());
    }
    Ok(site)
}

fn public_ip(ip: IpAddr) -> bool {
    match ip {
        IpAddr::V4(v4) => {
            let [a, b, c, _] = v4.octets();
            !matches!(a, 0 | 10 | 127 | 224..=255)
                && !(a == 100 && (64..=127).contains(&b))
                && !(a == 169 && b == 254)
                && !(a == 172 && (16..=31).contains(&b))
                && !(a == 192 && (b == 168 || b == 0 && matches!(c, 0 | 2) || b == 88 && c == 99))
                && !(a == 198 && (matches!(b, 18 | 19) || b == 51 && c == 100))
                && !(a == 203 && b == 0 && c == 113)
        }
        IpAddr::V6(v6) => {
            let [a, b, ..] = v6.segments();
            a & 0xe000 == 0x2000
                && !matches!(a, 0x2002 | 0x3fff)
                && !(a == 0x2001 && (b < 0x200 || b == 0xdb8))
        }
    }
}

pub struct PublicDns;

impl Resolve for PublicDns {
    fn resolve(&self, name: Name) -> Resolving {
        Box::pin(async move {
            let addrs = tokio::net::lookup_host((name.as_str(), 0))
                .await?
                .collect::<Vec<_>>();
            if addrs.is_empty() || addrs.iter().any(|a| !public_ip(a.ip())) {
                return Err(std::io::Error::new(
                    std::io::ErrorKind::PermissionDenied,
                    "不是公开来源地址",
                )
                .into());
            }
            Ok(Box::new(addrs.into_iter()) as Addrs)
        })
    }
}

struct Payload {
    body: Option<Vec<u8>>,
    url: Url,
    etag: String,
    modified: String,
    mime: String,
}
fn safe_header(v: &str) -> &str {
    if (1..=256).contains(&v.len()) && v.bytes().all(|b| (32..=126).contains(&b)) {
        v
    } else {
        ""
    }
}
async fn download(app: &App, initial: Url, previous: &Value, cap: usize, raw: bool) -> R<Payload> {
    tokio::time::timeout(Duration::from_secs(if raw { 8 } else { 10 }), async {
        let mut u = initial;
        let mut seen = HashSet::new();
        for hop in 0..=3 {
            if !seen.insert(u.as_str().to_owned()) { return Err(fail(422, "上游重定向循环")); }
            let domain = u.host_str().ok_or_else(|| fail(400, "网址无效"))?;
            let addrs = tokio::net::lookup_host((domain, 443)).await.map_err(|_| fail(502, "无法解析来源服务器"))?.collect::<Vec<SocketAddr>>();
            if addrs.is_empty() || addrs.iter().any(|a| !public_ip(a.ip())) { return Err(fail(400, "只允许无凭据的公开 HTTPS 网址")); }
            let accept = if raw { "application/javascript, text/javascript, text/plain, application/octet-stream, */*;q=0.1" } else { "application/json, application/javascript, text/plain, */*;q=0.1" };
            let mut req = app.http.get(u.clone()).header(header::ACCEPT, accept).header(header::CACHE_CONTROL, "no-cache");
            let (mut etag, mut modified) = ("", "");
            if s(previous, "effectiveUrl") == u.as_str() {
                etag = safe_header(s(previous, "etag"));
                modified = safe_header(s(previous, "lastModified"));
                if !etag.is_empty() { req = req.header(header::IF_NONE_MATCH, etag); }
                if !modified.is_empty() { req = req.header(header::IF_MODIFIED_SINCE, modified); }
            }
            let mut response = req.send().await.map_err(|e| if e.is_timeout() { fail(504, "上游请求超时") } else { fail(502, "无法连接来源服务器") })?;
            if response.url() != &u || response.remote_addr().is_some_and(|a| !public_ip(a.ip())) { return Err(fail(400, "只允许无凭据的公开 HTTPS 网址")); }
            let status = response.status().as_u16();
            if [301, 302, 303, 307, 308].contains(&status) {
                let location = response.headers().get(header::LOCATION).and_then(|v| v.to_str().ok()).filter(|v| !v.is_empty() && hop < 3).ok_or_else(|| fail(422, "上游重定向无效或过多"))?;
                u = public_url(location, Some(&u), false)?;
                if wrapper(&u) { return Err(fail(422, "上游不能重定向到 Rex 包装链接")); }
                continue;
            }
            let read_header = |key| response.headers().get(key).and_then(|h| h.to_str().ok()).map(safe_header).unwrap_or("").to_owned();
            let mut out = Payload { body: None, url: u, etag: read_header(header::ETAG), modified: read_header(header::LAST_MODIFIED), mime: read_header(header::CONTENT_TYPE) };
            if status == 304 && (!etag.is_empty() || !modified.is_empty()) {
                if out.etag.is_empty() { out.etag = etag.into(); }
                if out.modified.is_empty() { out.modified = modified.into(); }
                return Ok(out);
            }
            if status != 200 { return Err(fail(422, format!("来源请求失败（HTTP {status}）"))); }
            let too_big = || fail(413, if cap == LIMIT { "上游内容超过 1 MiB".into() } else { format!("上游内容超过 {cap} 字节") });
            if response.content_length().is_some_and(|n| n > cap as u64) { return Err(too_big()); }
            let mut bytes = Vec::new();
            while let Some(chunk) = response.chunk().await.map_err(|e| if e.is_timeout() { fail(504, "上游请求超时") } else { fail(502, "无法完整读取上游内容") })? {
                if chunk.len() > cap - bytes.len() { return Err(too_big()); }
                bytes.extend_from_slice(&chunk);
            }
            out.body = Some(bytes);
            return Ok(out);
        }
        Err(fail(422, "上游重定向无效或过多"))
    }).await.map_err(|_| fail(504, "上游请求超时"))?
}

pub async fn fetch_public(app: &App, url: &str, cap: usize) -> crate::Result<(Vec<u8>, String)> {
    async {
        let url = public_url(url, None, false)?;
        if wrapper(&url) {
            return Err(fail(422, "不接受 Rex 包装链接"));
        }
        let payload = download(app, url, &Value::Null, cap, false).await?;
        Ok((
            payload.body.ok_or_else(|| fail(502, "上游响应没有内容"))?,
            payload.url.into(),
        ))
    }
    .await
    .map_err(|(code, message)| err(code, message))
}

static NUMBER: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"(?i)^-?(?:[0-9]+\.?[0-9]*|\.[0-9]+)(?:e[+-]?[0-9]+)?").unwrap());
static ENCRYPTED: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"(?i)^[\s\u{feff}]*(?://\s*)?REXENC").unwrap());
static ASSIGNMENT: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"\bWidgetMetadata\s*=").unwrap());

struct Literal<'a>(&'a str);
impl<'a> Literal<'a> {
    fn whitespace(&mut self) -> Option<()> {
        loop {
            self.0 = self.0.trim_start_matches(ws);
            if let Some(tail) = self.0.strip_prefix("//") {
                self.0 = tail.find('\n').map_or("", |i| &tail[i..]);
            } else if let Some(tail) = self.0.strip_prefix("/*") {
                self.0 = &tail[tail.find("*/")? + 2..];
            } else {
                return Some(());
            }
        }
    }
    fn take(&mut self, ch: char) -> bool {
        if let Some(tail) = self.0.strip_prefix(ch) {
            self.0 = tail;
            true
        } else {
            false
        }
    }
    fn next(&mut self) -> Option<char> {
        let ch = self.0.chars().next()?;
        self.0 = &self.0[ch.len_utf8()..];
        Some(ch)
    }
    fn ident(&mut self) -> Option<&'a str> {
        let head = |b: u8| b.is_ascii_alphabetic() || matches!(b, b'_' | b'$');
        if !self.0.bytes().next().is_some_and(head) {
            return None;
        }
        let n = self
            .0
            .bytes()
            .take_while(|b| head(*b) || b.is_ascii_digit())
            .count();
        let (id, tail) = self.0.split_at(n);
        self.0 = tail;
        Some(id)
    }
    fn string(&mut self) -> Option<String> {
        let q = self.next()?;
        let mut out = Vec::new();
        loop {
            let mut c = self.next()?;
            if c == q {
                return String::from_utf16(&out).ok();
            }
            if c == '\\' {
                c = match self.next()? {
                    'n' => '\n',
                    'r' => '\r',
                    't' => '\t',
                    'b' => '\u{8}',
                    'f' => '\u{c}',
                    'v' => '\u{b}',
                    '0' => '\0',
                    e @ ('u' | 'x') => {
                        let n = if e == 'u' { 4 } else { 2 };
                        let hex = self.0.get(..n)?;
                        if !hex.bytes().all(|b| b.is_ascii_hexdigit()) {
                            return None;
                        }
                        out.push(u16::from_str_radix(hex, 16).ok()?);
                        self.0 = &self.0[n..];
                        continue;
                    }
                    e => e,
                };
            }
            out.extend_from_slice(c.encode_utf16(&mut [0; 2]));
        }
    }
    fn value(&mut self, depth: usize) -> Option<Value> {
        if depth > 64 {
            return None;
        }
        self.whitespace()?;
        match self.0.chars().next()? {
            '\'' | '"' => self.string().map(Value::String),
            '[' => {
                self.take('[');
                self.whitespace()?;
                let mut values = Vec::new();
                while !self.take(']') {
                    values.push(self.value(depth + 1)?);
                    self.whitespace()?;
                    if self.take(']') {
                        break;
                    }
                    if !self.take(',') {
                        return None;
                    }
                    self.whitespace()?;
                }
                Some(Value::Array(values))
            }
            '{' => {
                self.take('{');
                self.whitespace()?;
                let mut values = Map::new();
                while !self.take('}') {
                    let key = if self.0.starts_with(['\'', '"']) {
                        self.string()?
                    } else {
                        self.ident()?.into()
                    };
                    self.whitespace()?;
                    if !self.take(':') {
                        return None;
                    }
                    values.insert(key, self.value(depth + 1)?);
                    self.whitespace()?;
                    if self.take('}') {
                        break;
                    }
                    if !self.take(',') {
                        return None;
                    }
                    self.whitespace()?;
                }
                Some(Value::Object(values))
            }
            _ => {
                if let Some(number) = NUMBER.find(self.0) {
                    self.0 = &self.0[number.end()..];
                    return Some(json!(number.as_str().parse::<f64>().ok()?));
                }
                match self.ident()? {
                    "true" => Some(Value::Bool(true)),
                    "false" => Some(Value::Bool(false)),
                    "null" => Some(Value::Null),
                    _ => None,
                }
            }
        }
    }
}
fn literal(src: &str) -> Option<Value> {
    if src.len() > LIMIT || ENCRYPTED.is_match(src) {
        return None;
    }
    let mut p = Literal(src);
    p.whitespace()?;
    if p.0.starts_with("'use strict'") || p.0.starts_with("\"use strict\"") {
        p.string()?;
        p.whitespace()?;
        p.take(';');
        p.whitespace()?;
    }
    let mut id = p.ident()?;
    if matches!(id, "var" | "let" | "const") {
        p.whitespace()?;
        id = p.ident()?;
    }
    p.whitespace()?;
    if id != "WidgetMetadata" || !p.take('=') {
        return None;
    }
    p.value(1)
}
fn manual(input: &Value, base: Option<&Url>) -> R<Value> {
    if input.is_null() {
        return Ok(json!({}));
    }
    let fields = input
        .as_object()
        .ok_or_else(|| fail(400, "手动元数据须为对象"))?;
    let mut output = Map::new();
    for k in META {
        if matches!(k, "contentType" | "continuousPlay") {
            continue;
        }
        if let Some(v) = fields.get(k) {
            let value = text(
                v,
                match k {
                    "icon" => 2048,
                    "description" => 500,
                    _ => 160,
                },
                "手动元数据",
                false,
            )?;
            output.insert(
                k.into(),
                if k == "icon" && !value.is_empty() {
                    json!(publish_url(value, base, false)?.as_str())
                } else {
                    json!(value)
                },
            );
        }
    }
    output.extend(content_metadata(input));
    Ok(Value::Object(output))
}
pub fn content_metadata(v: &Value) -> Map<String, Value> {
    let mut out = Map::new();
    if matches!(
        v["contentType"].as_str(),
        Some("video" | "music" | "audiobook" | "shortDrama")
    ) {
        out.insert("contentType".into(), v["contentType"].clone());
    }
    if v["continuousPlay"].is_boolean() {
        out.insert("continuousPlay".into(), v["continuousPlay"].clone());
    }
    out
}
fn id_ok(id: &str) -> bool {
    id.bytes()
        .next()
        .is_some_and(|c| c.is_ascii_alphanumeric() || c == b'_')
        && id
            .bytes()
            .all(|c| c.is_ascii_alphanumeric() || matches!(c, b'_' | b'.' | b'-'))
}
fn pick<'a>(v: &'a Value, keys: &[&str]) -> &'a Value {
    keys.iter()
        .map(|k| &v[*k])
        .find(|x| !x.is_null())
        .unwrap_or(&Value::Null)
}
fn truthy(v: &Value) -> bool {
    match v {
        Value::Null => false,
        Value::Bool(x) => *x,
        Value::String(x) => !x.is_empty(),
        Value::Number(n) => n.as_f64().is_some_and(|n| n != 0.),
        _ => true,
    }
}
fn first<'a>(v: &'a Value, keys: &[&str]) -> &'a Value {
    keys.iter()
        .map(|k| &v[*k])
        .find(|x| truthy(x))
        .unwrap_or(&Value::Null)
}
fn meta(m: &Value, base: Option<&Url>, js: bool) -> R<Value> {
    if !m.is_object() {
        return Err(fail(422, "模块元数据无效"));
    }
    let id = text(&m["id"], 160, "模块 ID", true)?;
    if !id_ok(id) {
        return Err(fail(
            422,
            "模块 ID 只能使用英文字母、数字、下划线、点和连字符",
        ));
    }
    let icon = text(
        pick(
            m,
            if js {
                &["iconurl", "iconUrl", "iconURL", "icon"]
            } else {
                &["icon", "iconurl", "iconUrl", "iconURL"]
            },
        ),
        2048,
        "图标网址",
        false,
    )?;
    let icon = if icon.is_empty() {
        String::new()
    } else {
        publish_url(icon, base, false)?.into()
    };
    let mut out = json!({"id":id, "title":text(&m["title"],160,"模块标题",true)?, "version":text(&m["version"],48,"模块版本",true)?, "requiredVersion":text(&m["requiredVersion"],48,"模块所需版本",true)?, "author":text(&m["author"],120,"模块作者",false)?, "icon":icon, "description":text(&m["description"],500,"模块描述",false)?});
    out.as_object_mut().unwrap().extend(content_metadata(m));
    Ok(out)
}
fn module(mut m: Value, url: &str) -> Value {
    m["url"] = json!(url);
    m["paused"] = json!(false);
    m["disabled"] = json!(false);
    m["categoryId"] = json!("");
    m["removed"] = json!(false);
    m
}
fn empty_encrypted(rest: &str) -> bool {
    rest.trim_start_matches(|c: char| ws(c) || c.is_ascii_digit() || matches!(c, ':' | '-'))
        .trim_matches(ws)
        .is_empty()
}
fn js_meta(bytes: &[u8], base: Option<&Url>, fallback: &Value) -> R<Value> {
    let head = String::from_utf8_lossy(&bytes[..bytes.len().min(512)]);
    let decoded = std::str::from_utf8(bytes).ok();
    if let Some(marker) = ENCRYPTED.find(decoded.unwrap_or(&head)) {
        if empty_encrypted(&decoded.unwrap_or(&head)[marker.end()..])
            && (decoded.is_some() || bytes.len() <= 512)
        {
            return Err(fail(422, "加密模块缺少有效内容"));
        }
        if ["id", "title", "version", "requiredVersion"]
            .iter()
            .any(|k| !truthy(&fallback[*k]))
        {
            return Err(fail(
                422,
                "加密模块需要合集清单或手动提供 ID、标题、版本和所需版本",
            ));
        }
        return meta(fallback, base, false);
    }
    let src = decoded.ok_or_else(|| fail(422, "上游内容不是有效的 UTF-8"))?;
    if src.trim_matches(ws).is_empty() || src.contains('\0') {
        return Err(fail(422, "模块文件为空或包含二进制内容"));
    }
    let v = literal(src).ok_or_else(|| {
        fail(
            422,
            "无法静态读取 WidgetMetadata：请将字面量声明置于文件开头",
        )
    })?;
    if !v["modules"].is_array() {
        return Err(fail(422, "WidgetMetadata 缺少 modules 数组"));
    }
    meta(&v, base, true)
}

struct Index {
    rows: Vec<Value>,
    label: String,
    author: String,
    icon: Value,
}
fn index_data(bytes: &[u8]) -> R<Index> {
    let src = std::str::from_utf8(bytes).map_err(|_| fail(422, "上游内容不是有效的 UTF-8"))?;
    let value: Value = serde_json::from_str(src.strip_prefix('\u{feff}').unwrap_or(src))
        .map_err(|_| fail(422, "合集必须是有效的 JSON"))?;
    let rows = value["widgets"]
        .as_array()
        .ok_or_else(|| fail(422, "合集必须包含 widgets 数组（允许为空）"))?;
    if rows.len() > MAX_ITEMS {
        return Err(fail(413, "每个来源最多 160 个模块"));
    }
    Ok(Index {
        rows: rows.clone(),
        label: text(pick(&value, &["title", "name"]), 160, "合集标题", false)?.into(),
        author: text(&value["author"], 120, "合集作者", false)
            .unwrap_or_default()
            .into(),
        icon: first(&value, &["icon", "logo", "iconURL"]).clone(),
    })
}
fn source_icon(icon: &Value, base: Option<&Url>) -> String {
    icon.as_str()
        .and_then(|x| publish_url(x, base, false).ok())
        .map(Into::into)
        .unwrap_or_default()
}
fn row_url(row: &Value) -> R<&str> {
    if !row.is_object() || has(row, "widgets") {
        return Err(fail(422, "合集条目无效或含嵌套索引"));
    }
    text(&row["url"], 2048, "合集模块网址", true)
}
fn unique(modules: &[Value]) -> R<()> {
    let (mut ids, mut urls) = (HashSet::new(), HashSet::new());
    for m in modules {
        if !ids.insert(s(m, "id")) || !urls.insert(s(m, "url")) {
            return Err(fail(422, "同一来源内存在重复的模块 ID 或 URL"));
        }
    }
    Ok(())
}
struct Parsed {
    modules: Vec<Value>,
    label: String,
    author: String,
    icon: String,
    kind: &'static str,
}
fn parse_online(bytes: &[u8], source: &Url, effective: &Url, manual: &Value) -> R<Parsed> {
    let looks_json = std::str::from_utf8(bytes)
        .ok()
        .is_some_and(|src| src.trim_start_matches(ws).starts_with(['[', '{']));
    if index_url(effective) || index_url(source) || looks_json {
        let index = index_data(bytes)?;
        let mut modules = vec![];
        for row in index.rows {
            let url = publish_url(row_url(&row)?, Some(effective), true)?;
            if &url == source || &url == effective {
                return Err(fail(422, "合集不能引用自身"));
            }
            modules.push(module(meta(&row, Some(effective), false)?, url.as_str()));
        }
        unique(&modules)?;
        Ok(Parsed {
            modules,
            label: index.label,
            author: index.author,
            icon: source_icon(&index.icon, Some(effective)),
            kind: "online-index",
        })
    } else {
        let meta = js_meta(bytes, Some(effective), manual)?;
        let (label, icon, author) = (
            s(&meta, "title").into(),
            s(&meta, "icon").into(),
            s(&meta, "author").into(),
        );
        Ok(Parsed {
            modules: vec![module(meta, effective.as_str())],
            label,
            author,
            icon,
            kind: "online-module",
        })
    }
}
fn companion_name(spec: &str, base: Option<&Url>) -> R<String> {
    if https(spec) {
        let target = public_url(spec, None, false)?;
        if let Some(base) = base {
            let directory = base.join(".").map_err(|_| fail(400, "网址无效"))?;
            if target.origin() != directory.origin() {
                return Ok(String::new());
            }
            let tail = target.path().strip_prefix(directory.path()).unwrap_or("");
            if tail.contains('/') {
                return Ok(String::new());
            }
            return decode(tail);
        }
        return decode(target.path().rsplit('/').next().unwrap_or(""));
    }
    if spec.contains(['\\', '#']) || spec.starts_with("//") {
        return Err(fail(400, "网址路径不安全"));
    }
    path_check(spec)?;
    let mut path = spec.split('?').next().unwrap_or("");
    while let Some(tail) = path.strip_prefix("./") {
        path = tail;
    }
    if path.contains('/') {
        return Ok(String::new());
    }
    decode(path)
}
fn file_hash(bytes: &[u8]) -> String {
    format!("{:x}", Sha256::digest(bytes))
}
fn uploaded<'a>(
    file: &'a str,
    row: Option<&Value>,
    manual: &Value,
    js_count: usize,
    base: Option<&Url>,
    site: &str,
    stored: &mut BTreeMap<String, &'a [u8]>,
) -> R<Value> {
    let mut fallback = if row.is_some() || js_count == 1 {
        manual.clone()
    } else {
        json!({})
    };
    if let Some(row) = row {
        for k in META {
            if !row[k].is_null() && row[k].as_str() != Some("") {
                fallback[k] = row[k].clone();
            }
        }
        let icon = first(row, &["icon", "iconurl", "iconUrl", "iconURL"]);
        fallback["icon"] = if icon.is_null() {
            manual["icon"].clone()
        } else {
            icon.clone()
        };
    }
    let meta = js_meta(file.as_bytes(), base, &fallback)?;
    if let Some(row) = row {
        if has(row, "id") && text(&row["id"], 160, "合集模块 ID", true)? != s(&meta, "id") {
            return Err(fail(422, "合集模块 ID 与上传文件不一致"));
        }
    }
    let key = format!("files/{}.js", file_hash(file.as_bytes()));
    let url = format!("{site}/{key}");
    stored.insert(key, file.as_bytes());
    Ok(module(meta, &url))
}
async fn parse_upload(app: &App, input: &Value, origin: &str) -> R<Parsed> {
    let files = input["files"]
        .as_array()
        .filter(|x| !x.is_empty())
        .ok_or_else(|| fail(400, "请选择至少一个文件"))?;
    if files.len() > 32 {
        return Err(fail(413, "每次最多上传 32 个文件"));
    }
    let (mut seen, mut total, mut index, mut js) = (HashSet::new(), 0, None, vec![]);
    for file in files {
        let name = file["name"]
            .as_str()
            .ok_or_else(|| fail(400, "上传文件格式无效"))?;
        let payload = file["text"]
            .as_str()
            .ok_or_else(|| fail(400, "上传文件格式无效"))?;
        let lower = name.to_lowercase();
        let is_index = lower.ends_with(".rex");
        if name.encode_utf16().count() > 180
            || name != name.trim_matches(ws)
            || name.starts_with('.')
            || name.contains(['/', '\\', '%', '?', '#', ':'])
            || name.chars().any(bad)
            || !(is_index || lower.ends_with(".js"))
        {
            return Err(fail(400, "文件名无效，仅允许 .js 或 .rex 文件名，不含路径"));
        }
        if !seen.insert(lower) {
            return Err(fail(422, "上传的文件名重复"));
        }
        if payload.is_empty() {
            return Err(fail(422, "不能上传空文件"));
        }
        total += payload.len();
        if payload.len() > LIMIT || total > 4 * LIMIT {
            return Err(fail(413, "单个文件最多 1 MiB，总计最多 4 MiB"));
        }
        if is_index {
            if index.replace((name, payload)).is_some() {
                return Err(fail(422, "每次最多上传一个合集索引"));
            }
        } else {
            js.push((name, payload));
        }
    }
    let base = if truthy(&input["baseUrl"]) {
        Some(public_url(
            text(&input["baseUrl"], 2048, "网址", true)?,
            None,
            false,
        )?)
    } else {
        None
    };
    let base = base.as_ref();
    let manual = manual(&input["metadata"], base)?;
    let site = if js.is_empty() {
        String::new()
    } else {
        local_origin(origin, true)?
    };
    let (mut stored, mut used, mut modules) = (BTreeMap::new(), HashSet::new(), vec![]);
    let (label, author, mut icon, kind) = if let Some((name, payload)) = index {
        let index = index_data(payload.as_bytes())?;
        for row in index.rows {
            let spec = row_url(&row)?;
            let url = if https(spec) || base.is_some() {
                Some(publish_url(spec, base, true)?)
            } else {
                None
            };
            let local = companion_name(spec, base)?;
            if let Some(&(name, file)) = js.iter().find(|(name, _)| *name == local) {
                if url.is_none() && spec.contains('?') {
                    return Err(fail(422, "本地文件引用不得包含查询参数"));
                }
                if !used.insert(name) {
                    return Err(fail(422, "合集重复引用同一上传文件"));
                }
                modules.push(uploaded(
                    file,
                    Some(&row),
                    &manual,
                    js.len(),
                    base,
                    &site,
                    &mut stored,
                )?);
            } else {
                let url = url.ok_or_else(|| fail(422, "相对模块地址需要同名上传文件或基础 URL"))?;
                modules.push(module(meta(&row, base, false)?, url.as_str()));
            }
        }
        if used.len() != js.len() {
            return Err(fail(422, "有上传的 JS 文件未被合集引用"));
        }
        (
            if index.label.is_empty() {
                name.into()
            } else {
                index.label
            },
            index.author,
            source_icon(&index.icon, base),
            "upload-index",
        )
    } else {
        for (_, file) in &js {
            modules.push(uploaded(
                file,
                None,
                &manual,
                js.len(),
                base,
                &site,
                &mut stored,
            )?);
        }
        (
            if modules.len() == 1 {
                s(&modules[0], "title").into()
            } else {
                js[0].0.into()
            },
            if modules.len() == 1 {
                s(&modules[0], "author").into()
            } else {
                String::new()
            },
            String::new(),
            "upload-modules",
        )
    };
    unique(&modules)?;
    if icon.is_empty() {
        icon = modules.first().map_or("", |m| s(m, "icon")).into();
    }
    for (key, bytes) in stored {
        put_file(app, &key, bytes)
            .await
            .map_err(|_| fail(503, "无法保存上传文件"))?;
    }
    Ok(Parsed {
        modules,
        label,
        author,
        icon,
        kind,
    })
}

static MARKUP: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r"(?i)^<(?:!doctype\b|!--|\?xml\b|[a-z][a-z0-9:-]*(?:\s|/?>))").unwrap()
});
static DOCUMENT_MIME: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(
        r"^(?:text/html|application/(?:xhtml\+xml|xml|(?:[\w.-]+\+)?json)|text/xml|image/[^\s]+)$",
    )
    .unwrap()
});
static SCRIPT_MIME: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r"^(?:application|text)/(?:javascript|ecmascript|x-javascript)$").unwrap()
});
static SCRIPT_MARKER: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"[;={}()]|^\s*(?://|/\*)|^\s*[A-Za-z0-9+/_=-]{32,}\s*$").unwrap());
fn versions(m: &Value) -> Option<(&str, &str)> {
    let id = text(&m["id"], 160, "模块 ID", true).ok()?;
    if !id_ok(id) {
        return None;
    }
    text(&m["title"], 160, "模块标题", true).ok()?;
    Some((
        text(&m["version"], 48, "模块版本", true).ok()?,
        text(&m["requiredVersion"], 48, "模块所需版本", true).ok()?,
    ))
}
fn snapshot<'a>(
    m: &'a Value,
    bytes: &[u8],
    mime: &str,
    effective: &Url,
) -> R<(String, String, bool, Map<String, Value>)> {
    if bytes.is_empty() {
        return Err(fail(422, "上游模块为空"));
    }
    let mime = mime
        .split(';')
        .next()
        .unwrap_or("")
        .trim()
        .to_ascii_lowercase();
    let head = String::from_utf8_lossy(&bytes[..bytes.len().min(512)]);
    if MARKUP.is_match(head.trim_start_matches(ws)) || DOCUMENT_MIME.is_match(&mime) {
        return Err(fail(422, "上游返回的是网页、清单或图片，而不是模块"));
    }
    let src = std::str::from_utf8(bytes).ok();
    let probe = src.unwrap_or(&head);
    let marker = ENCRYPTED.find(probe);
    if let Some(marker) = marker {
        if empty_encrypted(&probe[marker.end()..]) && (src.is_some() || bytes.len() <= 512) {
            return Err(fail(422, "上游 Rex 加密模块缺少有效内容"));
        }
    } else if let Some(src) = src {
        let trimmed = src.trim_start_matches(ws);
        if trimmed.is_empty() {
            return Err(fail(422, "上游模块为空"));
        }
        if src.contains('\0') && ASSIGNMENT.is_match(src) {
            return Err(fail(422, "上游明文模块含有空字符"));
        }
        if let Some(metadata) = literal(src) {
            let (version, required) = versions(&metadata)
                .filter(|_| metadata["modules"].is_array())
                .ok_or_else(|| fail(422, "上游 WidgetMetadata 不完整或无效"))?;
            if s(&metadata, "id") != s(m, "id") {
                return Err(fail(422, "上游 WidgetMetadata ID 与来源模块不一致"));
            }
            return Ok((
                version.into(),
                required.into(),
                true,
                content_metadata(&metadata),
            ));
        }
        if ASSIGNMENT.is_match(src) {
            return Err(fail(422, "无法静态验证上游 WidgetMetadata"));
        }
        if trimmed.starts_with(['[', '{']) && serde_json::from_str::<Value>(trimmed).is_ok() {
            return Err(fail(422, "上游返回的是 JSON，而不是模块"));
        }
    }
    let (version, required) = versions(m)
        .ok_or_else(|| fail(422, "不透明模块需要来源提供有效的 ID、标题、版本和所需版本"))?;
    let js_url = |u: &Url| u.path().to_ascii_lowercase().ends_with(".js");
    let script_path = js_url(effective) || Url::parse(s(m, "url")).as_ref().is_ok_and(js_url);
    let script_mime = SCRIPT_MIME.is_match(&mime);
    let binary = mime == "application/octet-stream";
    if marker.is_none() && !script_mime && !script_path && !binary {
        return Err(fail(422, "无法识别上游返回的模块内容"));
    }
    if marker.is_none()
        && !script_mime
        && !binary
        && src.is_some_and(|src| {
            !src.contains('\0') && !SCRIPT_MARKER.is_match(src.trim_start_matches(ws))
        })
    {
        return Err(fail(422, "上游文本不是可识别的模块内容"));
    }
    Ok((version.into(), required.into(), false, content_metadata(m)))
}
fn hash_ok(hash: &str) -> bool {
    hash.len() == 64
        && hash
            .bytes()
            .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
}
async fn mirror_one(app: &App, m: &Value, site: &str) -> Value {
    let remote = s(m, "url");
    let old = &m["mirror"];
    let old_hash = s(old, "hash");
    let success = if hash_ok(old_hash)
        && !s(old, "url").is_empty()
        && !s(old, "version").is_empty()
        && tokio::fs::metadata(app.files.join(format!("files/{old_hash}.js")))
            .await
            .is_ok_and(|m| m.is_file())
    {
        old
    } else {
        &Value::Null
    };
    let result = async {
        if site.is_empty() { return Err(fail(422, "发布站点须为 HTTPS 源站地址")); }
        let u = public_url(remote, None, false)?;
        if wrapper(&u) { return Err(fail(422, "不接受 Rex 包装链接")); }
        let payload = download(app, u, if success["contentMetadataVersion"]==1 && remote == s(success, "remoteUrl") { success } else { &Value::Null }, LIMIT, true).await?;
        let (hash, version, required, fields) = if let Some(bytes) = &payload.body {
            let (version, required, literal, fields) = snapshot(m, bytes, &payload.mime, &payload.url)?;
            let hash = file_hash(bytes);
            if hash != s(success, "hash") {
                put_file(app, &format!("files/{hash}.js"), bytes).await.map_err(|_| fail(503, "无法保存镜像文件"))?;
            }
            if !literal && hash == s(success, "hash") { (hash, s(success, "version").into(), s(success, "requiredVersion").into(), if success["contentMetadataVersion"]==1{content_metadata(success)}else{fields}) } else { (hash, version, required, fields) }
        } else { (s(success, "hash").into(), s(success, "version").into(), s(success, "requiredVersion").into(), content_metadata(success)) };
        let mut out = json!({"url":format!("{site}/files/{hash}.js"), "version":version, "requiredVersion":required, "hash":hash, "remoteUrl":remote, "checkedAt":stamp(), "contentMetadataVersion":1});
        out.as_object_mut().unwrap().extend(fields);
        if !payload.etag.is_empty() || !payload.modified.is_empty() { out["effectiveUrl"] = json!(payload.url.as_str()); }
        if !payload.etag.is_empty() { out["etag"] = json!(payload.etag); }
        if !payload.modified.is_empty() { out["lastModified"] = json!(payload.modified); }
        Ok(out)
    }.await;
    match result {
        Ok(out) => out,
        Err((_, message)) => {
            let mut out = if success.is_null() {
                json!({"url":"", "version":"", "hash":"", "remoteUrl":remote})
            } else {
                success.clone()
            };
            out["checkedAt"] = json!(stamp());
            out["error"] = json!(message);
            out
        }
    }
}
fn time_of(input: &str) -> Option<i64> {
    DateTime::parse_from_rfc3339(input)
        .ok()
        .map(|t| t.timestamp_millis())
}
fn minutes(v: &Value, fallback: i64) -> i64 {
    v.as_i64()
        .filter(|m| *m > 0 && *m <= 1440)
        .unwrap_or(fallback)
}
fn modules(v: &Value) -> &[Value] {
    v["modules"].as_array().map(Vec::as_slice).unwrap_or(&[])
}
fn eligible(source: &Value, m: &Value, site: &str) -> bool {
    if yes(source, "paused") || yes(m, "paused") || yes(m, "pending") {
        return false;
    }
    let delivery = s(m, "delivery");
    if !(delivery == "mirror" || delivery != "link" && s(source, "delivery") == "mirror") {
        return false;
    }
    let url = s(m, "url");
    !url.is_empty()
        && (site.is_empty()
            || !url
                .strip_prefix(site)
                .is_some_and(|x| x.starts_with("/files/") || x.starts_with("/m/")))
}
fn mirror_due(source: &Value, m: &Value, now: i64) -> (i64, i64) {
    if let Some(last) = time_of(s(&m["mirror"], "checkedAt")).filter(|x| *x <= now) {
        (
            last + 60_000 * minutes(&m["refreshMinutes"], minutes(&source["refreshMinutes"], 30)),
            last,
        )
    } else {
        (0, i64::MIN)
    }
}
async fn mirror(app: &App, source: &mut Value, origin: &str, force: bool, only: Option<&str>) {
    let site = local_origin(origin, false).unwrap_or_default();
    let now = Utc::now().timestamp_millis();
    let mut queue = modules(source)
        .iter()
        .enumerate()
        .filter_map(|(i, m)| {
            if !eligible(source, m, &site) || only.is_some_and(|id| id != s(m, "id")) {
                return None;
            }
            let (due, last) = mirror_due(source, m, now);
            (force || only.is_some() || due <= now).then_some((due, last, i))
        })
        .collect::<Vec<_>>();
    queue.sort_unstable();
    let check = |job: Option<&(i64, i64, usize)>| {
        let job = job.map(|&(_, _, i)| (i, &modules(source)[i]));
        let site = site.as_str();
        async move {
            if let Some((i, module)) = job {
                Some((i, mirror_one(app, module, site).await))
            } else {
                None
            }
        }
    };
    let (a, b, c) = tokio::join!(
        check(queue.first()),
        check(queue.get(1)),
        check(queue.get(2))
    );
    for (i, snap) in [a, b, c].into_iter().flatten() {
        source["modules"][i]["mirror"] = snap;
    }
}

async fn ingest_inner(app: &App, input: &Value, origin: &str) -> R<Value> {
    if !input.is_object() {
        return Err(fail(400, "来源输入无效"));
    }
    let remote = !input["url"].is_null() && input["url"] != "";
    let local = !input["files"].is_null();
    if remote == local {
        return Err(fail(400, "请只选择链接或文件其中一种来源"));
    }
    let category = text(&input["categoryId"], 64, "分类 ID", false)?;
    let configurable = remote
        || input["files"].as_array().is_some_and(|rows| {
            rows.iter()
                .any(|row| s(row, "name").to_ascii_lowercase().ends_with(".rex"))
        });
    let mut source =
        json!({"id":Uuid::new_v4().to_string(), "url":"", "categoryId":category, "paused":false});
    if configurable {
        let delivery = pick(input, &["delivery", "defaultDelivery"]);
        let delivery = if delivery.is_null() {
            "link"
        } else {
            delivery.as_str().unwrap_or("")
        };
        if !matches!(delivery, "link" | "mirror") {
            return Err(fail(400, "分发方式无效"));
        }
        let interval = pick(input, &["refreshMinutes", "defaultRefreshMinutes"]);
        let minutes = if interval.is_null() {
            30
        } else {
            interval.as_u64().unwrap_or(0)
        };
        if !INTERVALS.contains(&minutes) {
            return Err(fail(400, "刷新频率无效"));
        }
        let policy = pick(input, &["newPolicy", "defaultNewPolicy"]);
        let policy = if policy.is_null() {
            "review"
        } else {
            policy.as_str().unwrap_or("")
        };
        if !matches!(policy, "review" | "auto") {
            return Err(fail(400, "新增策略无效"));
        }
        source["delivery"] = json!(delivery);
        source["refreshMinutes"] = json!(minutes);
        source["newPolicy"] = json!(policy);
    }
    let mut parsed = if local {
        source["status"] = json!("静态上传");
        parse_upload(app, input, origin).await?
    } else {
        let u = source_url(text(&input["url"], 2048, "网址", true)?)?;
        let payload = download(app, u.clone(), &Value::Null, LIMIT, false).await?;
        let manual = manual(&input["metadata"], Some(&payload.url))?;
        let mut parsed = parse_online(
            payload.body.as_deref().unwrap_or_default(),
            &u,
            &payload.url,
            &manual,
        )?;
        if parsed.label.is_empty() {
            parsed.label = u.host_str().unwrap_or("").into();
        }
        source["url"] = json!(u.as_str());
        source["status"] = json!("正常");
        source["effectiveUrl"] = json!(payload.url.as_str());
        source["etag"] = json!(payload.etag);
        source["lastModified"] = json!(payload.modified);
        source["manualMetadata"] = manual;
        source["contentMetadataVersion"] = json!(1);
        parsed
    };
    source["modules"] = Value::Array(std::mem::take(&mut parsed.modules));
    source["kind"] = json!(parsed.kind);
    source["label"] = json!(parsed.label);
    source["author"] = json!(parsed.author);
    source["icon"] = json!(parsed.icon);
    source["checkedAt"] = json!(stamp());
    if s(&source, "delivery") == "mirror" && s(input, "replaceId").is_empty() {
        mirror(app, &mut source, origin, true, None).await;
    }
    Ok(source)
}
const RETAIN_MS: i64 = 30 * 24 * 60 * 60 * 1000;
const OVERRIDES: [&str; 7] = [
    "paused",
    "disabled",
    "categoryId",
    "autoCategoryFallbackId",
    "pending",
    "delivery",
    "refreshMinutes",
];
fn reconcile(source: &Value, incoming: Vec<Value>) -> R<(Vec<Value>, Vec<Value>)> {
    let now = Utc::now().timestamp_millis();
    let mut tombs = BTreeMap::new();
    if let Some(saved) = source["moduleOverrides"].as_array() {
        for m in saved
            .iter()
            .filter(|m| m["until"].as_i64().is_some_and(|t| t > now))
        {
            tombs.insert(s(m, "id").to_owned(), m.clone());
        }
    }
    let old = modules(source);
    let mut seen = HashSet::new();
    let mut out = Vec::new();
    for mut m in incoming {
        let id = s(&m, "id").to_owned();
        let last = old.iter().find(|n| s(n, "id") == id);
        let saved = tombs.remove(&id);
        seen.insert(id);
        if let Some(last) = last.filter(|m| yes(m, "paused")) {
            m = last.clone();
            m["removed"] = json!(false);
        } else if let Some(last) = last {
            for k in OVERRIDES.into_iter().chain(["mirror"]) {
                if let Some(v) = last.get(k) {
                    m[k] = v.clone();
                }
            }
            if !has(&m, "pending") {
                m["pending"] = json!(false);
            }
        } else {
            m["pending"] = json!(s(source, "newPolicy") != "auto");
            if let Some(saved) = saved {
                for k in OVERRIDES {
                    if let Some(v) = saved.get(k) {
                        m[k] = v.clone();
                    }
                }
            } else {
                m["autoCategoryFallbackId"] = json!(s(source, "newCategoryId"));
            }
        }
        out.push(m);
    }
    for m in old.iter().filter(|m| !seen.contains(s(m, "id"))) {
        if yes(m, "paused") {
            let mut kept = m.clone();
            kept["removed"] = json!(true);
            out.push(kept);
        } else if yes(m, "disabled")
            || !s(m, "categoryId").is_empty()
            || !s(m, "autoCategoryFallbackId").is_empty()
            || has(m, "pending")
            || has(m, "delivery")
            || has(m, "refreshMinutes")
        {
            let id = s(m, "id");
            let mut tomb = json!({"id":id, "until":now + RETAIN_MS});
            for k in OVERRIDES {
                if let Some(v) = m.get(k) {
                    tomb[k] = v.clone();
                }
            }
            tombs.insert(id.into(), tomb);
        }
    }
    if out.len() > MAX_ITEMS {
        return Err(fail(413, "上游模块与已暂停模块合计超过来源上限"));
    }
    unique(&out)?;
    let mut tombs = tombs.into_values().collect::<Vec<_>>();
    tombs.sort_by_key(|m| std::cmp::Reverse(m["until"].as_i64().unwrap_or(0)));
    tombs.truncate(MAX_ITEMS);
    Ok((out, tombs))
}
async fn refresh_inner(
    app: &App,
    source: &Value,
    origin: &str,
    force: bool,
    module_id: Option<&str>,
) -> R<Value> {
    if !source.is_object() || !source["modules"].is_array() {
        return Err(fail(400, "来源格式无效"));
    }
    if yes(source, "paused") {
        return Ok(source.clone());
    }
    if module_id.is_some_and(|id| !modules(source).iter().any(|m| s(m, "id") == id)) {
        return Err(fail(404, "模块不存在"));
    }
    let mut out = source.clone();
    let url = s(source, "url");
    let now = Utc::now().timestamp_millis();
    let due = time_of(s(source, "checkedAt")).is_none_or(|last| {
        last > now || now >= last + 60_000 * minutes(&source["refreshMinutes"], 30)
    });
    if module_id.is_none() && !url.is_empty() && (force || due) {
        let u = source_url(url)?;
        let payload = download(
            app,
            u.clone(),
            if source["contentMetadataVersion"] == 1 && source["author"].is_string() {
                source
            } else {
                &Value::Null
            },
            LIMIT,
            false,
        )
        .await?;
        if let Some(bytes) = &payload.body {
            let parsed = parse_online(bytes, &u, &payload.url, &source["manualMetadata"])?;
            let kind = s(source, "kind");
            if !kind.is_empty() && kind != parsed.kind {
                return Err(fail(422, "来源内容类型已变化，需重新导入"));
            }
            let (modules, tombs) = reconcile(source, parsed.modules)?;
            out["kind"] = json!(parsed.kind);
            out["label"] = json!(if parsed.label.is_empty() {
                u.host_str().unwrap_or("")
            } else {
                &parsed.label
            });
            out["author"] = json!(parsed.author);
            out["icon"] = json!(parsed.icon);
            out["modules"] = json!(modules);
            out["moduleOverrides"] = json!(tombs);
        }
        out["checkedAt"] = json!(stamp());
        out["contentMetadataVersion"] = json!(1);
        out["status"] = json!("正常");
        out["effectiveUrl"] = json!(payload.url.as_str());
        out["etag"] = json!(payload.etag);
        out["lastModified"] = json!(payload.modified);
    }
    mirror(app, &mut out, origin, force, module_id).await;
    Ok(out)
}

pub async fn ingest(app: &App, a: &Value, origin: &str) -> crate::Result<Value> {
    ingest_inner(app, a, origin)
        .await
        .map_err(|(code, message)| err(code, message))
}
pub async fn refresh(
    app: &App,
    s: &Value,
    origin: &str,
    force: bool,
    module_id: Option<&str>,
) -> crate::Result<Value> {
    refresh_inner(app, s, origin, force, module_id)
        .await
        .map_err(|(code, message)| err(code, message))
}

#[cfg(test)]
mod tests {
    use super::*;

    const ORIGIN: &str = "https://hub.example.com";
    const WIDGET: &str = "\u{feff}/* Rex */\n'use strict';\nconst WidgetMetadata = {id:'org.rex.fixture',title:'示例 \\uD83D\\uDC4B',author:'JS author',version:'2.1',requiredVersion:'0.0.6',modules:[{id:'list', parameters:[{value:null, n:-.2e+2,},],},],};\n";

    fn test_app() -> App {
        App {
            http: reqwest::Client::builder()
                .no_proxy()
                .redirect(reqwest::redirect::Policy::none())
                .dns_resolver(std::sync::Arc::new(PublicDns))
                .build()
                .unwrap(),
            files: std::env::temp_dir().join(format!("rex-sources-test-{}", Uuid::new_v4())),
            db: std::sync::Mutex::new(rusqlite::Connection::open_in_memory().unwrap()),
            badge_lock: Default::default(),
            source_lock: Default::default(),
            web: Default::default(),
            setup_token: None,
            origin: ORIGIN.into(),
            secure: true,
        }
    }

    #[test]
    fn parses_metadata_and_collection() {
        let root = source_url("https://rexnow.tv/widget?url=https%3A%2F%2Fraw.githubusercontent.com%2Frex%2Fmain%2Flist.rex").unwrap();
        let row = json!({"id":"org.rex.fixture","title":"清单示例","version":"1.0","requiredVersion":"0.0.6","url":"./fixture.rex.js","icon":"./icons/sample.png"});
        let index = parse_online(
            json!({"title":"测试合集","author":"Index author","widgets":[row]})
                .to_string()
                .as_bytes(),
            &root,
            &root,
            &Value::Null,
        )
        .unwrap();
        assert_eq!(index.label, "测试合集");
        assert_eq!(index.author, "Index author");
        let js = Url::parse("https://cdn.example.com/fixture.js").unwrap();
        assert_eq!(
            parse_online(WIDGET.as_bytes(), &js, &js, &Value::Null)
                .unwrap()
                .author,
            "JS author"
        );
        assert_eq!(
            index.modules[0]["url"],
            "https://raw.githubusercontent.com/rex/main/fixture.rex.js"
        );
        assert_eq!(
            index.modules[0]["icon"],
            "https://raw.githubusercontent.com/rex/main/icons/sample.png"
        );
        let meta = js_meta(WIDGET.as_bytes(), None, &Value::Null).unwrap();
        assert_eq!(meta["title"], "示例 👋");
        assert_eq!(meta["version"], "2.1");
        let (_, _, verified, _) =
            snapshot(&index.modules[0], WIDGET.as_bytes(), "text/plain", &root).unwrap();
        assert!(verified);
        let (version, _, verified, _) = snapshot(
            &index.modules[0],
            b"// REXENC:2\r\nEncryptedPayload",
            "text/plain",
            &root,
        )
        .unwrap();
        assert_eq!(version, "1.0");
        assert!(!verified);
    }

    #[tokio::test]
    async fn stores_uploaded_bytes_verbatim() {
        let app = test_app();
        let encoded = "// REXENC:2\r\nEncryptedPayload";
        let index = json!({"widgets":[{"id":"org.rex.encrypted","title":"加密示例","version":"1","requiredVersion":"0.0.6","url":"./encrypted.js"},{"id":"org.rex.fixture","url":"fixture.js"}]});
        let input = json!({"files":[{"name":"bundle.rex","text":index.to_string()},{"name":"encrypted.js","text":encoded},{"name":"fixture.js","text":WIDGET}]});
        let source = ingest(&app, &input, ORIGIN).await.unwrap();
        assert_eq!(source["kind"], "upload-index");
        assert_eq!(source["delivery"], "link");
        assert_eq!(source["refreshMinutes"], 30);
        assert_eq!(modules(&source).len(), 2);
        for (m, original) in modules(&source).iter().zip([encoded, WIDGET]) {
            let path = format!("files/{}.js", file_hash(original.as_bytes()));
            assert_eq!(m["url"], format!("{ORIGIN}/{path}"));
            assert_eq!(
                tokio::fs::read(app.files.join(path)).await.unwrap(),
                original.as_bytes()
            );
        }
        assert_eq!(
            refresh(&app, &source, ORIGIN, true, None).await.unwrap(),
            source
        );
        tokio::fs::remove_dir_all(&app.files).await.unwrap();
    }

    #[tokio::test]
    #[ignore = "requires access to the public Rex sample repository"]
    async fn mirrors_live_rex_collection_and_encrypted_module() {
        let app = test_app();
        let upstream = "https://raw.githubusercontent.com/zxxlxj/rex-m/main/mania.rex";
        let source = ingest(&app, &json!({"url":upstream,"delivery":"mirror"}), ORIGIN)
            .await
            .unwrap();
        assert_eq!(source["kind"], "online-index");
        let children = modules(&source);
        assert!(!children.is_empty());
        for child in children {
            let snap = &child["mirror"];
            let hash = s(snap, "hash");
            assert!(hash_ok(hash), "{snap}");
            let bytes = tokio::fs::read(app.files.join(format!("files/{hash}.js")))
                .await
                .unwrap();
            assert_eq!(file_hash(&bytes), hash);
        }
        let child = &children[0];
        let direct = ingest(&app, &json!({"url":child["url"], "metadata":child}), ORIGIN)
            .await
            .unwrap();
        assert_eq!(direct["kind"], "online-module");
        assert_eq!(direct["modules"][0]["id"], child["id"]);
        tokio::fs::remove_dir_all(&app.files).await.unwrap();
    }

    #[test]
    fn reconciles_local_controls_and_new_policy() {
        let make = |id: &str| json!({"id":id,"title":"新标题","url":format!("https://cdn.example.com/{id}.js")});
        let source = json!({"newPolicy":"review","newCategoryId":"inbox","modules":[{"id":"existing","delivery":"link","pending":false,"refreshMinutes":5},{"id":"frozen","title":"旧标题","url":"https://cdn.example.com/frozen.js","paused":true},{"id":"gone","categoryId":"curated","disabled":true,"delivery":"mirror"}]});
        let (modules, overrides) = reconcile(&source, vec![make("existing"), make("new")]).unwrap();
        assert_eq!(modules[0]["delivery"], "link");
        assert_eq!(modules[0]["refreshMinutes"], 5);
        assert_eq!(modules[1]["pending"], true);
        assert!(s(&modules[1], "categoryId").is_empty());
        assert_eq!(modules[1]["autoCategoryFallbackId"], "inbox");
        assert_eq!(modules[2]["title"], "旧标题");
        assert_eq!(modules[2]["removed"], true);
        let source = json!({"newPolicy":"auto","modules":modules,"moduleOverrides":overrides});
        let (returned, _) = reconcile(&source, vec![make("gone"), make("frozen")]).unwrap();
        assert_eq!(returned[0]["disabled"], true);
        assert_eq!(returned[0]["categoryId"], "curated");
        assert_eq!(returned[0]["delivery"], "mirror");
        assert_eq!(returned[0]["pending"], false);
        assert_eq!(returned[1]["removed"], false);
        assert_eq!(returned[1]["title"], "旧标题");
    }
}

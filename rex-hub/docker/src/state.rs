use crate::{delete_file, err, json, now, put_file, text, App, Result};
use axum::{
    body::Bytes,
    http::{header, HeaderMap, Method, StatusCode},
    response::Response,
};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::collections::{BTreeMap, HashMap, HashSet};

fn defaults() -> Value {
    json!({"sources":[],"categories":[],"distributions":[],"logs":[],"sourceChecks":[],"fileDeletes":[],"settings":{"defaultRefreshMinutes":30,"defaultDelivery":"link","defaultIcon":"","defaultNewPolicy":"review"}})
}
fn arr(v: &Value) -> &[Value] {
    v.as_array().map(Vec::as_slice).unwrap_or(&[])
}
fn on(v: &Value) -> bool {
    v.as_bool() == Some(true)
}
fn id() -> String {
    uuid::Uuid::new_v4().to_string()
}
fn bounded(v: &Value, n: usize) -> Result<String> {
    if v.is_null() {
        return Ok(String::new());
    }
    let s = v
        .as_str()
        .filter(|s| s.chars().count() <= n && !s.contains('\0'))
        .ok_or_else(|| err(400, "字段格式或长度不符合要求"))?;
    Ok(s.trim().into())
}
fn index(v: &Value, id: &str) -> Result<usize> {
    arr(v)
        .iter()
        .position(|v| v["id"] == id)
        .ok_or_else(|| err(404, "项目不存在"))
}
fn category(st: &Value, v: &Value) -> Result<String> {
    let v = bounded(v, 80)?;
    if !v.is_empty() {
        index(&st["categories"], &v)?;
    }
    Ok(v)
}
fn get(app: &App) -> Result<Value> {
    let db = app.db.lock().unwrap();
    read(&db)
}
fn read(db: &rusqlite::Connection) -> Result<Value> {
    let raw: String = db.query_row("SELECT document FROM hub_state WHERE id=1", [], |r| {
        r.get(0)
    })?;
    let mut a = defaults();
    let v: Value = serde_json::from_str(&raw).map_err(|_| err(500, "状态数据损坏"))?;
    if let Some(fields) = v.as_object() {
        for (k, v) in fields {
            a[k] = v.clone();
        }
    }
    Ok(a)
}
fn change<F, T>(app: &App, f: F) -> Result<T>
where
    F: FnOnce(&mut Value) -> Result<T>,
{
    let mut db = app.db.lock().unwrap();
    let tx = db.transaction()?;
    let mut st = read(&tx)?;
    let out = f(&mut st)?;
    tx.execute(
        "UPDATE hub_state SET document=?,revision=revision+1 WHERE id=1",
        [st.to_string()],
    )?;
    tx.commit()?;
    Ok(out)
}
fn log(st: &mut Value, msg: String) {
    let a = st["logs"].as_array_mut().unwrap();
    a.insert(0, json!({"time":now(),"message":msg}));
    a.truncate(200);
}
fn list(v: &Value) -> Result<Value> {
    if v.is_null() {
        return Ok(json!([]));
    }
    let v = v
        .as_array()
        .filter(|v| v.len() <= 5000 && v.iter().all(|e| e.as_str().is_some_and(|e| e.len() <= 400)))
        .ok_or_else(|| err(400, "选择列表无效"))?;
    let mut seen = HashSet::new();
    Ok(Value::Array(
        v.iter().filter(|x| seen.insert(text(x))).cloned().collect(),
    ))
}
fn includes(v: &Value, s: &str) -> bool {
    arr(v).iter().any(|a| a == s)
}
fn safe_key(s: &str, n: usize) -> bool {
    !s.is_empty()
        && s.len() <= n
        && s.as_bytes()[0].is_ascii_alphanumeric()
        && s.bytes()
            .all(|x| x.is_ascii_alphanumeric() || b"_-".contains(&x))
}
fn hash_part(k: &str, ext: &str) -> bool {
    k.strip_suffix(ext).is_some_and(|s| {
        s.len() == 64
            && s.bytes()
                .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
    })
}
pub fn module_hash(k: &str) -> bool {
    hash_part(k, ".js")
}
pub fn icon_hash(k: &str) -> bool {
    [".png", ".jpg", ".webp", ".gif"]
        .iter()
        .any(|e| hash_part(k, e))
}
fn valid_icon(v: &Value, origin: &str) -> Result<String> {
    let s = bounded(v, 1500)?;
    if s.is_empty() {
        return Ok(s);
    }
    let base = url::Url::parse(origin).unwrap();
    let u = base.join(&s).map_err(|_| err(400, "图标地址不合法"))?;
    if !u.username().is_empty()
        || u.password().is_some()
        || u.fragment().is_some()
        || (u.scheme() != "https" && u.origin() != base.origin())
    {
        return Err(err(400, "图标地址不合法"));
    }
    Ok(u.into())
}
fn file_key(url: &Value, origin: &str) -> Option<String> {
    let u = url::Url::parse(text(url)).ok()?;
    if u.origin().ascii_serialization() != origin {
        return None;
    }
    let k = u.path().strip_prefix("/files/")?;
    module_hash(k).then(|| k.to_owned())
}
fn collect_files(s: &Value, origin: &str) -> HashSet<String> {
    let mut keep = HashSet::new();
    for p in arr(&s["fileHistory"]) {
        if module_hash(text(p)) {
            keep.insert(text(p).to_owned());
        }
    }
    for m in arr(&s["modules"]) {
        for x in [&m["url"], &m["mirror"]["url"]] {
            if let Some(k) = file_key(x, origin) {
                keep.insert(k);
            }
        }
    }
    keep
}
fn track(s: &mut Value, old: &Value, origin: &str) {
    let mut hs = collect_files(s, origin);
    hs.extend(collect_files(old, origin));
    s["fileHistory"] = json!(hs);
}
fn delivered<'a>(s: &'a Value, m: &'a Value, st: &'a Value) -> &'a str {
    match text(&m["delivery"]) {
        "link" => "link",
        "mirror" => "mirror",
        _ => s["delivery"]
            .as_str()
            .unwrap_or(text(&st["settings"]["defaultDelivery"])),
    }
}
fn uses_mirror(st: &Value, s: &Value, m: &Value, origin: &str) -> bool {
    delivered(s, m, st) == "mirror"
        && file_key(&m["url"], origin).is_none()
        && !text(&m["url"]).starts_with(&format!("{origin}/m/"))
}
fn delivery_metadata(m: &Value, mirror: bool) -> &Value {
    if mirror && m["mirror"]["contentMetadataVersion"] == 1 {
        &m["mirror"]
    } else {
        m
    }
}
const RULE_FIELDS: [&str; 4] = ["moduleName", "moduleAuthor", "sourceName", "sourceAuthor"];
fn valid_content_type(t: &str) -> bool {
    matches!(
        t,
        "video" | "music" | "audiobook" | "shortDrama" | "unspecified"
    )
}
fn normalize_rule(v: &Value) -> Value {
    let mut types = Vec::new();
    for t in arr(&v["contentTypes"]).iter().map(|x| text(x).trim()) {
        if valid_content_type(t) && !types.contains(&t) {
            types.push(t);
        }
    }
    let mut rule = json!({"enabled":on(&v["enabled"]), "contentTypes":types});
    for field in RULE_FIELDS {
        rule[field] = json!(text(&v[field]).trim());
    }
    rule
}
struct CategoryRule<'a> {
    id: &'a str,
    types: &'a [Value],
    terms: [Vec<String>; 4],
}
fn category_rules(categories: &[Value]) -> Vec<CategoryRule<'_>> {
    categories
        .iter()
        .filter_map(|c| {
            let rule = &c["autoRule"];
            let id = text(&c["id"]);
            if id.is_empty() || !on(&rule["enabled"]) {
                return None;
            }
            let types = arr(&rule["contentTypes"]);
            let terms = RULE_FIELDS.map(|field| {
                text(&rule[field])
                    .split([',', '，', '\r', '\n'])
                    .map(str::trim)
                    .filter(|t| !t.is_empty())
                    .map(str::to_lowercase)
                    .collect::<Vec<_>>()
            });
            (!types.is_empty() || terms.iter().any(|t| !t.is_empty())).then_some(CategoryRule {
                id,
                types,
                terms,
            })
        })
        .collect()
}
#[derive(Default)]
struct CategorySource {
    label: String,
    authors: HashSet<String>,
}
impl CategorySource {
    fn new(s: &Value) -> Self {
        let author = text(&s["author"]).trim();
        let authors = if author.is_empty() {
            arr(&s["modules"])
                .iter()
                .filter(|m| !on(&m["removed"]))
                .map(|m| text(&m["author"]).trim())
                .filter(|a| !a.is_empty())
                .map(str::to_lowercase)
                .collect()
        } else {
            HashSet::from([author.to_lowercase()])
        };
        Self {
            label: text(&s["label"]).to_lowercase(),
            authors,
        }
    }
}
fn effective_category<'a>(
    rules: &[CategoryRule<'a>],
    context: &CategorySource,
    s: &'a Value,
    m: &'a Value,
    mirror: bool,
) -> &'a str {
    let explicit = text(&m["categoryId"]);
    let arrival_fallback = text(&m["autoCategoryFallbackId"]);
    let fallback = if arrival_fallback.is_empty() {
        text(&s["categoryId"])
    } else {
        arrival_fallback
    };
    if !explicit.is_empty() {
        return explicit;
    }
    if rules.is_empty() {
        return fallback;
    }
    let kind = text(&delivery_metadata(m, mirror)["contentType"]);
    let kind = if valid_content_type(kind) {
        kind
    } else {
        "unspecified"
    };
    let fields = [
        text(&m["title"]).to_lowercase(),
        text(&m["author"]).to_lowercase(),
    ];
    rules
        .iter()
        .find(|r| {
            (r.types.is_empty() || r.types.iter().any(|t| t == kind))
                && r.terms.iter().enumerate().all(|(i, terms)| {
                    terms.is_empty()
                        || terms.iter().any(|term| match i {
                            0 | 1 => fields[i].contains(term),
                            2 => context.label.contains(term),
                            _ => context.authors.iter().any(|author| author.contains(term)),
                        })
                })
        })
        .map_or(fallback, |r| r.id)
}
fn attach_categories(st: &mut Value, origin: &str) {
    let mut categories = st["categories"].clone();
    for c in categories.as_array_mut().unwrap() {
        c["autoRule"] = normalize_rule(&c["autoRule"]);
    }
    let rules = category_rules(arr(&categories));
    let ids = arr(&st["sources"])
        .iter()
        .map(|s| {
            let context = if rules.is_empty() {
                CategorySource::default()
            } else {
                CategorySource::new(s)
            };
            arr(&s["modules"])
                .iter()
                .map(|m| {
                    effective_category(&rules, &context, s, m, uses_mirror(st, s, m, origin))
                        .to_owned()
                })
                .collect::<Vec<_>>()
        })
        .collect::<Vec<_>>();
    for (s, ids) in st["sources"].as_array_mut().unwrap().iter_mut().zip(ids) {
        if let Some(modules) = s["modules"].as_array_mut() {
            for (m, id) in modules.iter_mut().zip(ids) {
                m["effectiveCategoryId"] = json!(id);
            }
        }
    }
    st["categories"] = categories;
}
fn build(st: &Value, d: &Value, origin: &str) -> Value {
    let rules = if d["mode"] == "rules" && !arr(&d["categoryIds"]).is_empty() {
        category_rules(arr(&st["categories"]))
    } else {
        Vec::new()
    };
    let mut chosen: BTreeMap<String, Vec<(i32, &Value, &Value, String)>> = BTreeMap::new();
    let mut order = Vec::new();
    for s in arr(&st["sources"]) {
        let context = if rules.is_empty() {
            CategorySource::default()
        } else {
            CategorySource::new(s)
        };
        for m in arr(&s["modules"]) {
            let id = text(&m["id"]);
            let r = format!("{}:{id}", text(&s["id"]));
            let explicit = includes(&d["include"], &r);
            if on(&m["disabled"]) || on(&m["pending"]) || includes(&d["exclude"], &r) {
                continue;
            }
            if !explicit
                && !(d["mode"] == "rules"
                    && (includes(&d["sourceIds"], text(&s["id"]))
                        || (!arr(&d["categoryIds"]).is_empty() && {
                            let cat = effective_category(
                                &rules,
                                &context,
                                s,
                                m,
                                uses_mirror(st, s, m, origin),
                            );
                            !cat.is_empty() && includes(&d["categoryIds"], cat)
                        })))
            {
                continue;
            }
            if !chosen.contains_key(id) {
                order.push(id.to_string());
            }
            chosen
                .entry(id.into())
                .or_default()
                .push((i32::from(explicit), s, m, r));
        }
    }
    let mut widgets = Vec::new();
    let mut conflicts = Vec::new();
    let mut blocked = Vec::new();
    let mut missing = Vec::new();
    let mut files = BTreeMap::new();
    let mut refs = BTreeMap::new();
    for id in order {
        let a = chosen.get_mut(&id).unwrap();
        a.sort_by_key(|x| -x.0);
        let (_, s, m, r) = &a[0];
        if a.len() > 1 {
            let tied = a[0].0 == a[1].0;
            if tied {
                blocked.push(id.clone());
            }
            conflicts.push(json!({"id":id,"first":r,"second":a[1].3,"resolved":!tied}));
        }
        let mirror = uses_mirror(st, s, m, origin);
        let snap = &m["mirror"];
        let stored = file_key(&snap["url"], origin);
        let url = if mirror {
            if let Some(k) = stored {
                files.insert(id.clone(), format!("{origin}/files/{k}"));
                format!("{origin}/m/{}/{}.js", text(&d["key"]), id)
            } else {
                missing.push(json!({"id":id,"title":m["title"],"source":s["label"]}));
                String::new()
            }
        } else {
            text(&m["url"]).into()
        };
        let meta = |k: &str| {
            if mirror {
                snap[k]
                    .as_str()
                    .filter(|x| !x.is_empty())
                    .unwrap_or(text(&m[k]))
            } else {
                text(&m[k])
            }
        };
        refs.insert(id.clone(), r.clone());
        let mut widget = json!({"id":id,"title":m["title"],"description":text(&m["description"]),"requiredVersion":meta("requiredVersion"),"version":meta("version"),"author":text(&m["author"]),"icon":text(&m["icon"]),"url":url});
        widget
            .as_object_mut()
            .unwrap()
            .extend(crate::sources::content_metadata(delivery_metadata(
                m, mirror,
            )));
        widgets.push(widget);
    }
    if d["order"] != "source" {
        widgets.sort_by(|a, b| text(&a["title"]).cmp(text(&b["title"])));
    }
    let icon = d["icon"]
        .as_str()
        .filter(|s| !s.is_empty())
        .map(str::to_owned)
        .unwrap_or_else(|| format!("{origin}/rex-mark.png"));
    json!({"manifest":{"name":d["title"],"title":d["title"],"description":text(&d["description"]),"icon":icon,"logo":icon,"widgets":widgets},"conflicts":conflicts,"blocked":blocked,"missingMirrors":missing,"refs":refs,"files":files})
}
fn removal(d: &Value, next: &Value) -> bool {
    let current = arr(&d["published"]["widgets"]);
    let n = arr(&next["manifest"]["widgets"]);
    let gone = current
        .iter()
        .filter(|s| !n.iter().any(|m| m["id"] == s["id"]))
        .count();
    gone > 0 && (gone == current.len() || (gone >= 3 && gone * 2 >= current.len()))
}
fn record(d: &mut Value, next: Value) {
    d["published"] = next["manifest"].clone();
    d["publishedFiles"] = next["files"].clone();
    d["publishedRefs"] = next["refs"].clone();
    d["publishedAt"] = json!(now());
    d["publishWarning"] = json!("");
}
fn publish(d: &mut Value, next: Value, confirm: bool) -> Result<bool> {
    if !arr(&next["blocked"]).is_empty() {
        return Err(err(409, "请先解决同名模块冲突，再发布"));
    }
    if !arr(&next["missingMirrors"]).is_empty() {
        return Err(err(409, "等待托管模块首次下载"));
    }
    if !confirm && (arr(&next["manifest"]["widgets"]).is_empty() || removal(d, &next)) {
        return Ok(false);
    }
    let mut cfg = d.clone();
    for k in [
        "published",
        "active",
        "publishedAt",
        "publishedFiles",
        "publishedRefs",
        "publishWarning",
    ] {
        cfg.as_object_mut().unwrap().remove(k);
    }
    d["active"] = cfg;
    record(d, next);
    Ok(true)
}
fn republish(st: &mut Value, origin: &str, allow_remove: bool) {
    let mut logs = Vec::new();
    let ds = arr(&st["distributions"])
        .iter()
        .enumerate()
        .filter(|(_, d)| on(&d["enabled"]) && d["active"].is_object())
        .map(|(i, d)| (i, build(st, &d["active"], origin)))
        .collect::<Vec<_>>();
    for (i, next) in ds {
        let d = &mut st["distributions"][i];
        let reason = if !arr(&next["blocked"]).is_empty() {
            "模块 ID 冲突"
        } else if !arr(&next["missingMirrors"]).is_empty() {
            "等待托管模块首次下载"
        } else if !allow_remove && removal(d, &next) {
            "异常批量移除"
        } else {
            ""
        };
        if !reason.is_empty() {
            d["publishWarning"] = json!(reason);
        } else if d["published"] != next["manifest"]
            || d["publishedFiles"] != next["files"]
            || d["publishedRefs"] != next["refs"]
        {
            logs.push(format!(
                "自动更新「{}」：{} 个模块",
                text(&d["title"]),
                arr(&next["manifest"]["widgets"]).len()
            ));
            record(d, next);
        } else {
            d["publishWarning"] = json!("");
        }
    }
    for m in logs {
        log(st, m);
    }
}
fn options(target: &mut Value, a: &Value, module: bool) -> Result<()> {
    if let Some(x) = a.get("delivery") {
        if !matches!(text(x), "link" | "mirror") && !(module && x == "inherit") {
            return Err(err(400, "分发方式无效"));
        }
        target["delivery"] = x.clone();
    }
    if let Some(x) = a.get("refreshMinutes") {
        let n = x.as_u64().unwrap_or(99999);
        if ![5, 15, 30, 60, 180, 360, 720, 1440].contains(&n) && !(module && n == 0) {
            return Err(err(400, "刷新频率无效"));
        }
        target["refreshMinutes"] = x.clone();
    }
    Ok(())
}
fn delete_sources(st: &mut Value, ids: &[String], origin: &str) -> Result<()> {
    let mut files = HashSet::new();
    let mut refs = HashSet::new();
    for id in ids {
        let s = &st["sources"][index(&st["sources"], id)?];
        files.extend(collect_files(s, origin));
        for m in arr(&s["modules"]) {
            refs.insert(format!("{id}:{}", text(&m["id"])));
        }
    }
    st["sources"]
        .as_array_mut()
        .unwrap()
        .retain(|s| !ids.iter().any(|i| s["id"] == i.as_str()));
    st["sourceChecks"]
        .as_array_mut()
        .unwrap()
        .retain(|i| !ids.iter().any(|x| i == x));
    for d in st["distributions"].as_array_mut().unwrap() {
        if d["published"]["widgets"].is_array() {
            let chosen = arr(&d["published"]["widgets"])
                .iter()
                .filter(|m| refs.contains(text(&d["publishedRefs"][text(&m["id"])])))
                .map(|m| text(&m["id"]).to_owned())
                .collect::<HashSet<_>>();
            d["published"]["widgets"]
                .as_array_mut()
                .unwrap()
                .retain(|m| !chosen.contains(text(&m["id"])));
            for k in ["publishedRefs", "publishedFiles"] {
                if let Some(o) = d[k].as_object_mut() {
                    o.retain(|x, _| !chosen.contains(x));
                }
            }
        }
    }
    files.extend(arr(&st["fileDeletes"]).iter().map(|x| text(x).to_owned()));
    st["fileDeletes"] = json!(files);
    republish(st, origin, false);
    log(st, format!("已删除 {} 个来源并更新分发", ids.len()));
    Ok(())
}

async fn cleanup(app: &App) -> Result<bool> {
    let st = get(app)?;
    let mut live = HashSet::new();
    for s in arr(&st["sources"]) {
        live.extend(collect_files(s, &app.origin));
    }
    for d in arr(&st["distributions"]) {
        for m in arr(&d["published"]["widgets"]) {
            if let Some(k) = file_key(&m["url"], &app.origin) {
                live.insert(k);
            }
        }
        if let Some(o) = d["publishedFiles"].as_object() {
            for v in o.values() {
                if let Some(k) = file_key(v, &app.origin) {
                    live.insert(k);
                }
            }
        }
    }
    let mut done = HashSet::new();
    for v in arr(&st["fileDeletes"]).iter().take(200) {
        let k = text(v);
        if !live.contains(k) && module_hash(k) {
            delete_file(app, &format!("files/{k}")).await?;
        }
        done.insert(k);
    }
    if !done.is_empty() {
        change(app, |s| {
            s["fileDeletes"]
                .as_array_mut()
                .unwrap()
                .retain(|v| !done.contains(text(v)));
            Ok(())
        })?;
    }
    Ok(arr(&get(app)?["fileDeletes"]).len() > 0)
}
fn is_due(s: &Value) -> bool {
    let mins = s["refreshMinutes"].as_i64().unwrap_or(30);
    chrono::DateTime::parse_from_rfc3339(text(&s["checkedAt"]))
        .map(|t| chrono::Utc::now().timestamp() - t.timestamp() >= mins * 60)
        .unwrap_or(true)
}
async fn checks(app: &App, ids: &[String], module: Option<&str>, force: bool) -> Result<Value> {
    let _gate = app
        .source_lock
        .try_lock()
        .map_err(|_| err(409, "已有同步任务在运行"))?;
    let st = get(app)?;
    let mut checked = 0;
    let mut failed = 0;
    let mut skipped = 0;
    let mut selection = if ids.is_empty() {
        arr(&st["sources"])
            .iter()
            .filter(|s| {
                !on(&s["paused"])
                    && (is_due(s)
                        || includes(&st["sourceChecks"], text(&s["id"]))
                        || arr(&s["modules"])
                            .iter()
                            .any(|m| delivered(s, m, &st) == "mirror"))
            })
            .cloned()
            .collect::<Vec<_>>()
    } else {
        ids.iter()
            .map(|id| index(&st["sources"], id).map(|i| st["sources"][i].clone()))
            .collect::<Result<Vec<_>>>()?
    };
    let skipped_ids = selection
        .iter()
        .filter(|s| {
            on(&s["paused"])
                || (text(&s["url"]).is_empty()
                    && !arr(&s["modules"]).iter().any(|m| {
                        delivered(s, m, &st) == "mirror"
                            && file_key(&m["url"], &app.origin).is_none()
                    }))
        })
        .map(|s| text(&s["id"]).to_owned())
        .collect::<HashSet<_>>();
    selection.retain(|s| !skipped_ids.contains(text(&s["id"])));
    skipped += skipped_ids.len();
    if ids.is_empty() {
        selection.sort_by_key(|s| {
            (
                !includes(&st["sourceChecks"], text(&s["id"])),
                text(&s["lastProcessedAt"]).to_owned(),
            )
        });
    }
    selection.truncate(if force && ids.len() <= 1 { 1 } else { 4 });
    let mut results = Vec::new();
    for mut s in selection {
        if on(&s["paused"])
            || (text(&s["url"]).is_empty()
                && !arr(&s["modules"]).iter().any(|m| {
                    delivered(&s, m, &st) == "mirror" && file_key(&m["url"], &app.origin).is_none()
                }))
        {
            skipped += 1;
            continue;
        }
        let sid = text(&s["id"]).to_owned();
        if let Some(mid) = module {
            index(&s["modules"], mid)?;
        }
        for (k, v) in [
            ("delivery", "defaultDelivery"),
            ("refreshMinutes", "defaultRefreshMinutes"),
            ("newPolicy", "defaultNewPolicy"),
        ] {
            if s[k].is_null() {
                s[k] = st["settings"][v].clone();
            }
        }
        let result = match crate::sources::refresh(
            app,
            &s,
            &app.origin,
            force || includes(&st["sourceChecks"], &sid),
            module,
        )
        .await
        {
            Ok(n) => {
                if arr(&n["modules"]).iter().any(|m| {
                    !text(&m["mirror"]["error"]).is_empty()
                        && m["mirror"]["checkedAt"]
                            != arr(&s["modules"])
                                .iter()
                                .find(|x| x["id"] == m["id"])
                                .map(|x| x["mirror"]["checkedAt"].clone())
                                .unwrap_or(Value::Null)
                }) {
                    failed += 1;
                }
                n
            }
            Err(e) => {
                failed += 1;
                let mut n = s.clone();
                n["status"] = json!(e.message);
                n["checkedAt"] = json!(now());
                n
            }
        };
        results.push((sid, s, result));
        checked += 1;
    }
    if checked > 0 || !skipped_ids.is_empty() {
        change(app, |st| {
            st["sourceChecks"]
                .as_array_mut()
                .unwrap()
                .retain(|v| !skipped_ids.contains(text(v)));
            for (sid, old, mut next) in results {
                if let Ok(i) = index(&st["sources"], &sid) {
                    if st["sources"][i]["edit"] != old["edit"] {
                        continue;
                    }
                    track(&mut next, &old, &app.origin);
                    next["lastProcessedAt"] = json!(now());
                    if next["status"] != old["status"] && next["status"] != "正常" {
                        log(
                            st,
                            format!("「{}」：{}", text(&next["label"]), text(&next["status"])),
                        );
                    }
                    st["sources"][i] = next;
                    if module.is_none() {
                        st["sourceChecks"]
                            .as_array_mut()
                            .unwrap()
                            .retain(|v| v != sid.as_str());
                    }
                }
            }
            republish(st, &app.origin, false);
            Ok(())
        })?;
    }
    let _ = cleanup(app).await;
    Ok(
        json!({"ok":true,"checked":checked,"failed":failed,"skipped":skipped,"queued":arr(&get(app)?["sourceChecks"]).len()}),
    )
}
pub async fn tick(app: &App) -> Result<()> {
    match checks(app, &[], None, false).await {
        Ok(_) => Ok(()),
        Err(e) if e.status == 409 => Ok(()),
        Err(e) => Err(e),
    }
}
pub async fn upload_icon(app: &App, bytes: Bytes) -> Result<Response> {
    let b = bytes.as_ref();
    let ext = if b.starts_with(b"\x89PNG\r\n\x1a\n") {
        "png"
    } else if b.starts_with(&[255, 216, 255]) {
        "jpg"
    } else if b.starts_with(b"GIF87a") || b.starts_with(b"GIF89a") {
        "gif"
    } else if b.starts_with(b"RIFF") && b.get(8..12) == Some(b"WEBP") {
        "webp"
    } else {
        return Err(err(415, "只接受 PNG、JPEG、WebP、GIF 图标"));
    };
    let k = format!("icons/{}.{ext}", hex::encode(Sha256::digest(b)));
    put_file(app, &k, b).await?;
    Ok(json(json!({"url":format!("{}/{k}",app.origin)})))
}
pub async fn public(app: &App, path: &str, head: bool, headers: &HeaderMap) -> Result<Response> {
    let st = get(app)?;
    if let Some(k) = path
        .strip_prefix("/s/")
        .and_then(|k| k.strip_suffix(".rex"))
    {
        let d = arr(&st["distributions"])
            .iter()
            .find(|d| d["key"] == k && on(&d["enabled"]) && d["published"].is_object())
            .ok_or_else(|| err(404, "分发不存在"))?;
        let body = if head {
            axum::body::Body::empty()
        } else {
            axum::body::Body::from(d["published"].to_string())
        };
        let mut r = Response::new(body);
        let h = r.headers_mut();
        h.insert(
            header::CONTENT_TYPE,
            "text/plain; charset=utf-8".parse().unwrap(),
        );
        h.insert(header::CACHE_CONTROL, "private, no-cache".parse().unwrap());
        h.insert("x-robots-tag", "noindex, nofollow".parse().unwrap());
        return Ok(r);
    }
    if let Some((key, mid)) = path
        .strip_prefix("/m/")
        .and_then(|s| s.split_once('/'))
        .and_then(|(a, b)| b.strip_suffix(".js").map(|b| (a, b)))
    {
        let k = arr(&st["distributions"])
            .iter()
            .find(|d| d["key"] == key && on(&d["enabled"]) && d["published"].is_object())
            .and_then(|d| file_key(&d["publishedFiles"][mid], &app.origin))
            .ok_or_else(|| err(404, "模块不存在"))?;
        drop(st);
        let etag = format!("\"{k}\"");
        let mut r = crate::file(
            &app.files,
            &format!("files/{k}"),
            head,
            "text/plain; charset=utf-8",
            "private, no-cache",
        )
        .await?;
        if headers
            .get(header::IF_NONE_MATCH)
            .and_then(|x| x.to_str().ok())
            .is_some_and(|x| x.split(',').any(|x| x.trim() == etag || x.trim() == "*"))
        {
            r = Response::new(axum::body::Body::empty());
            *r.status_mut() = StatusCode::NOT_MODIFIED;
            r.headers_mut()
                .insert(header::CACHE_CONTROL, "private, no-cache".parse().unwrap());
        }
        r.headers_mut().insert(header::ETAG, etag.parse().unwrap());
        return Ok(r);
    }
    Err(err(404, "分发不存在"))
}
pub async fn api(
    app: &App,
    path: &str,
    method: &Method,
    q: &HashMap<String, String>,
    a: &Value,
) -> Result<Response> {
    if method == Method::GET {
        let mut st = get(app)?;
        if path == "/api/state" {
            attach_categories(&mut st, &app.origin);
            st["origin"] = json!(app.origin);
            return Ok(json(st));
        }
        if path == "/api/preview" {
            let d = &st["distributions"][index(
                &st["distributions"],
                q.get("id").map(String::as_str).unwrap_or(""),
            )?];
            let mut n = build(&st, d, &app.origin);
            n["needsConfirmation"] = json!(removal(d, &n));
            return Ok(json(n));
        }
        return Err(err(404, "接口不存在"));
    }
    let idv = bounded(&a["id"], 80)?;
    if path == "/api/sync" {
        let ids = if idv.is_empty() { vec![] } else { vec![idv] };
        return Ok(json(
            checks(app, &ids, a["moduleId"].as_str(), !ids.is_empty()).await?,
        ));
    }
    if path == "/api/source/batch" || (path == "/api/source/update" && on(&a["delete"])) {
        let batch = path == "/api/source/batch";
        let ids = if batch {
            arr(&list(&a["ids"])?)
                .iter()
                .map(|x| text(x).to_owned())
                .collect::<Vec<_>>()
        } else {
            vec![idv]
        };
        let action = if batch { text(&a["action"]) } else { "delete" };
        if ids.is_empty() {
            return Err(err(400, "请选择来源"));
        }
        if action == "check" {
            change(app, |s| {
                for i in &ids {
                    index(&s["sources"], i)?;
                }
                for i in &ids {
                    if !includes(&s["sourceChecks"], i) {
                        s["sourceChecks"].as_array_mut().unwrap().push(json!(i));
                    }
                }
                Ok(())
            })?;
            return match checks(app, &ids, None, true).await {
                Ok(out) => Ok(json(out)),
                Err(e) if e.status == 409 => {
                    Ok(json(json!({"ok":true,"checked":0,"queued":ids.len()})))
                }
                Err(e) => Err(e),
            };
        }
        if action != "delete" {
            return Err(err(400, "操作无效"));
        }
        let _guard = app.source_lock.lock().await;
        change(app, |s| delete_sources(s, &ids, &app.origin))?;
        let pending = cleanup(app).await.unwrap_or(true);
        return Ok(json(
            json!({"ok":true,"deleted":ids.len(),"cleanupPending":pending}),
        ));
    }
    if path == "/api/source" {
        let _guard = app
            .source_lock
            .try_lock()
            .map_err(|_| err(409, "已有同步任务在运行"))?;
        let st = get(app)?;
        let cat = category(&st, &a["categoryId"])?;
        let replace = text(&a["replaceId"]);
        let prior = if replace.is_empty() {
            None
        } else {
            Some(st["sources"][index(&st["sources"], replace)?].clone())
        };
        if prior
            .as_ref()
            .is_some_and(|s| !text(&s["url"]).is_empty() || a["url"].is_string())
        {
            return Err(err(422, "替换上传仅用于静态来源"));
        }
        let mut input = a.clone();
        for (k, v) in [
            ("delivery", "defaultDelivery"),
            ("refreshMinutes", "defaultRefreshMinutes"),
            ("newPolicy", "defaultNewPolicy"),
        ] {
            if input[k].is_null() {
                input[k] = st["settings"][v].clone();
            }
        }
        let mut source = crate::sources::ingest(app, &input, &app.origin).await?;
        source["categoryId"] = json!(cat);
        if let Some(old) = &prior {
            source["id"] = old["id"].clone();
            source["paused"] = old["paused"].clone();
            if cat.is_empty() {
                source["categoryId"] = old["categoryId"].clone();
            }
            for k in ["delivery", "refreshMinutes", "newPolicy", "newCategoryId"] {
                if let Some(x) = old.get(k) {
                    source[k] = x.clone();
                }
            }
            let a = source["modules"].as_array_mut().unwrap();
            for m in arr(&old["modules"]) {
                let i = a.iter().position(|n| n["id"] == m["id"]);
                if on(&m["paused"]) {
                    let mut keep = m.clone();
                    keep["removed"] = json!(i.is_none());
                    if let Some(i) = i {
                        a[i] = keep;
                    } else {
                        a.push(keep);
                    }
                } else if let Some(i) = i {
                    for k in [
                        "categoryId",
                        "autoCategoryFallbackId",
                        "disabled",
                        "delivery",
                        "refreshMinutes",
                        "mirror",
                        "pending",
                    ] {
                        if let Some(x) = m.get(k) {
                            a[i][k] = x.clone();
                        }
                    }
                }
            }
        }
        source["edit"] = json!(id());
        track(
            &mut source,
            prior.as_ref().unwrap_or(&Value::Null),
            &app.origin,
        );
        change(app, |s| {
            category(s, &source["categoryId"])?;
            if let Some(old) = &prior {
                let i = index(&s["sources"], text(&old["id"]))?;
                s["sources"][i] = source.clone();
            } else {
                if !text(&source["url"]).is_empty()
                    && arr(&s["sources"]).iter().any(|x| x["url"] == source["url"])
                {
                    return Err(err(409, "来源已添加"));
                }
                s["sources"].as_array_mut().unwrap().push(source.clone());
            }
            republish(s, &app.origin, prior.is_some());
            log(s, format!("已保存来源「{}」", text(&source["label"])));
            Ok(())
        })?;
        let mut r = json(json!({"ok":true,"source":source}));
        *r.status_mut() = StatusCode::CREATED;
        return Ok(r);
    }
    let x = change(app, |st| {
        if path == "/api/settings" {
            let mins = a["defaultRefreshMinutes"].as_u64().unwrap_or(0);
            if ![5, 15, 30, 60, 180, 360, 720, 1440].contains(&mins)
                || !matches!(text(&a["defaultDelivery"]), "link" | "mirror")
                || !matches!(text(&a["defaultNewPolicy"]), "review" | "auto")
            {
                return Err(err(400, "默认设置无效"));
            }
            st["settings"] = json!({"defaultRefreshMinutes":mins,"defaultDelivery":a["defaultDelivery"],"defaultNewPolicy":a["defaultNewPolicy"],"defaultIcon":valid_icon(&a["defaultIcon"],&app.origin)?});
            for s in st["sources"].as_array_mut().unwrap() {
                s["edit"] = json!(id());
            }
        } else if path == "/api/source/update" {
            let i = index(&st["sources"], &idv)?;
            let cat = a.get("categoryId").map(|v| category(st, v)).transpose()?;
            let newcat = a
                .get("newCategoryId")
                .map(|v| category(st, v))
                .transpose()?;
            let s = &mut st["sources"][i];
            let category_changed = cat.as_deref().is_some_and(|x| x != text(&s["categoryId"]));
            if let Some(x) = cat {
                s["categoryId"] = json!(x);
            }
            if let Some(x) = newcat {
                s["newCategoryId"] = json!(x);
            }
            if let Some(x) = a["paused"].as_bool() {
                s["paused"] = json!(x);
            }
            if let Some(x) = a.get("newPolicy") {
                if !matches!(text(x), "review" | "auto") {
                    return Err(err(400, "新增策略无效"));
                }
                s["newPolicy"] = x.clone();
            }
            options(s, a, false)?;
            s["edit"] = json!(id());
            republish(st, &app.origin, category_changed);
        } else if path == "/api/module/batch-category" {
            let cat = category(st, &a["categoryId"])?;
            let rows = a["modules"]
                .as_array()
                .filter(|v| !v.is_empty() && v.len() <= 5000)
                .ok_or_else(|| err(400, "请选择模块"))?;
            let mut seen = HashSet::new();
            let mut touched = HashSet::new();
            for row in rows {
                let i = index(&st["sources"], text(&row["sourceId"]))?;
                let j = index(&st["sources"][i]["modules"], text(&row["id"]))?;
                if seen.insert((i, j)) {
                    st["sources"][i]["modules"][j]["categoryId"] = json!(cat);
                    touched.insert(i);
                }
            }
            for i in touched {
                st["sources"][i]["edit"] = json!(id());
            }
            republish(st, &app.origin, true);
            log(st, format!("已批量调整 {} 个模块的分类", seen.len()));
            return Ok(json!({"ok":true,"count":seen.len()}));
        } else if path == "/api/module/update" {
            let i = index(&st["sources"], text(&a["sourceId"]))?;
            let j = index(&st["sources"][i]["modules"], &idv)?;
            let cat = a.get("categoryId").map(|v| category(st, v)).transpose()?;
            let s = &mut st["sources"][i];
            track(s, &Value::Null, &app.origin);
            let m = &mut s["modules"][j];
            let category_changed = cat.as_deref().is_some_and(|x| x != text(&m["categoryId"]));
            let approving = on(&a["approve"]) && on(&m["pending"]);
            if let Some(x) = cat {
                m["categoryId"] = json!(x);
            }
            for k in ["paused", "disabled"] {
                if let Some(x) = a[k].as_bool() {
                    m[k] = json!(x);
                }
            }
            if on(&a["approve"]) {
                m["pending"] = json!(false);
            }
            options(m, a, true)?;
            if on(&m["removed"]) && !on(&m["paused"]) {
                s["modules"].as_array_mut().unwrap().remove(j);
            }
            s["edit"] = json!(id());
            republish(st, &app.origin, category_changed || approving);
        } else if path == "/api/category" {
            let i = if idv.is_empty() {
                None
            } else {
                Some(index(&st["categories"], &idv)?)
            };
            let mut rule_changed = false;
            if on(&a["delete"]) {
                st["categories"]
                    .as_array_mut()
                    .unwrap()
                    .remove(i.ok_or_else(|| err(400, "需要分类 ID"))?);
                for s in st["sources"].as_array_mut().unwrap() {
                    for k in ["categoryId", "newCategoryId"] {
                        if s[k] == idv {
                            s[k] = json!("");
                        }
                    }
                    for k in ["modules", "moduleOverrides"] {
                        if let Some(ms) = s[k].as_array_mut() {
                            for m in ms {
                                for field in ["categoryId", "autoCategoryFallbackId"] {
                                    if m[field] == idv {
                                        m[field] = json!("");
                                    }
                                }
                            }
                        }
                    }
                    s["edit"] = json!(id());
                }
            } else {
                let existing = i.map(|i| &st["categories"][i]);
                let name = if let Some(name) = a.get("name") {
                    bounded(name, 60)?
                } else {
                    existing.map_or("", |c| text(&c["name"])).to_owned()
                };
                if name.is_empty() {
                    return Err(err(400, "分类名不能为空"));
                }
                if arr(&st["categories"])
                    .iter()
                    .enumerate()
                    .any(|(j, c)| Some(j) != i && c["name"] == name)
                {
                    return Err(err(409, "已有同名分类"));
                }
                let old_rule = normalize_rule(existing.map_or(&Value::Null, |c| &c["autoRule"]));
                let rule = a
                    .get("autoRule")
                    .map_or_else(|| old_rule.clone(), normalize_rule);
                rule_changed = rule != old_rule;
                if let Some(i) = i {
                    st["categories"][i]["name"] = json!(name);
                    st["categories"][i]["autoRule"] = rule;
                } else {
                    st["categories"]
                        .as_array_mut()
                        .unwrap()
                        .push(json!({"id":id(),"name":name,"autoRule":rule}));
                }
            }
            republish(st, &app.origin, rule_changed);
        } else if path == "/api/distribution" || path == "/api/publish" {
            let i = if idv.is_empty() {
                None
            } else {
                Some(index(&st["distributions"], &idv)?)
            };
            if on(&a["delete"]) && path == "/api/distribution" {
                st["distributions"]
                    .as_array_mut()
                    .unwrap()
                    .remove(i.ok_or_else(|| err(400, "需要分发 ID"))?);
                return Ok(json!({"ok":true}));
            }
            let mut d = i
                .map(|j| st["distributions"][j].clone())
                .unwrap_or_else(|| json!({"id":id(),"published":null,"active":null}));
            if path == "/api/distribution" {
                let mut key = bounded(&a["key"], 64)?;
                if key.is_empty() {
                    key = d["key"]
                        .as_str()
                        .map(str::to_owned)
                        .unwrap_or_else(|| uuid::Uuid::new_v4().simple().to_string());
                }
                if !safe_key(&key, 64) {
                    return Err(err(422, "分发标识格式无效"));
                }
                if arr(&st["distributions"])
                    .iter()
                    .enumerate()
                    .any(|(j, o)| Some(j) != i && o["key"] == key)
                {
                    return Err(err(409, "这个 key 已被使用"));
                }
                let title = bounded(&a["title"], 100)?;
                if title.is_empty() || !matches!(text(&a["mode"]), "manual" | "rules") {
                    return Err(err(400, "需要标题和分发模式"));
                }
                for (k, v) in [
                    ("key", json!(key)),
                    ("title", json!(title)),
                    ("description", json!(bounded(&a["description"], 500)?)),
                    ("icon", json!(valid_icon(&a["icon"], &app.origin)?)),
                    ("enabled", json!(on(&a["enabled"]))),
                    ("mode", a["mode"].clone()),
                    (
                        "order",
                        json!(if a["order"] == "source" {
                            "source"
                        } else {
                            "title"
                        }),
                    ),
                ] {
                    d[k] = v;
                }
                for k in ["categoryIds", "sourceIds", "include", "exclude"] {
                    d[k] = list(&a[k])?;
                }
            } else if i.is_none() {
                return Err(err(404, "分发不存在"));
            }
            let do_publish = path == "/api/publish" || on(&a["publish"]);
            if do_publish {
                let n = build(st, &d, &app.origin);
                if !publish(&mut d, n, on(&a["confirmEmpty"]))? {
                    return Ok(
                        json!({"code":"confirm_publish","error":"集合为空或检测到大量移除，请确认后再发布"}),
                    );
                }
                log(
                    st,
                    format!(
                        "发布「{}」：{} 个模块",
                        text(&d["title"]),
                        arr(&d["published"]["widgets"]).len()
                    ),
                );
            }
            let out = json!({"ok":true,"id":d["id"],"key":d["key"],"published":do_publish,"count":arr(&d["published"]["widgets"]).len()});
            if let Some(i) = i {
                st["distributions"][i] = d;
            } else {
                st["distributions"].as_array_mut().unwrap().push(d);
            }
            return Ok(out);
        } else {
            return Err(err(404, "接口不存在"));
        }
        Ok(json!({"ok":true}))
    })?;
    let confirm = x["code"] == "confirm_publish";
    let mut r = json(x);
    if confirm {
        *r.status_mut() = StatusCode::CONFLICT;
    }
    Ok(r)
}

#[cfg(test)]
mod tests {
    use super::*;

    const ORIGIN: &str = "https://hub.example.com";

    #[test]
    fn classification_resolves_rules_in_management_order() {
        let mut st = defaults();
        st["categories"] = json!([
            {"id":"disabled","autoRule":{"enabled":false,"moduleName":"opera"}},
            {"id":"empty","autoRule":{"enabled":true,"moduleName":" ,，\n "}},
            {"id":"first","autoRule":{"enabled":true,"contentTypes":["video","music"],"moduleName":"no match， OPERA\nThird","moduleAuthor":"alice","sourceName":"ARCHIVE","sourceAuthor":"boB"}},
            {"id":"second","autoRule":{"enabled":true,"contentTypes":["music"]}},
            {"id":"unknown","autoRule":{"enabled":true,"contentTypes":["unspecified"]}},
            {"id":"legacy"}
        ]);
        st["sources"] = json!([{"id":"s","label":"Classics Archive","categoryId":"source","modules":[
            {"id":"explicit","title":"An Opera","author":"Alice","contentType":"music","categoryId":"manual","autoCategoryFallbackId":"arrival"},
            {"id":"matching","title":"An Opera","author":"Alice","contentType":"music","autoCategoryFallbackId":"arrival"},
            {"id":"second","title":"Other","author":"Alice","contentType":"music","autoCategoryFallbackId":"arrival"},
            {"id":"fallback","title":"Other","author":"Bob","contentType":"audiobook","autoCategoryFallbackId":"arrival"},
            {"id":"source","title":"Other","contentType":"shortDrama"},
            {"id":"unknown","title":"Other"}
        ]}]);
        let distribution = json!({"key":"collection","mode":"rules","categoryIds":["first"]});
        assert_eq!(
            build(&st, &distribution, ORIGIN)["manifest"]["widgets"][0]["id"],
            "matching"
        );
        let mut response = st.clone();
        attach_categories(&mut response, ORIGIN);
        assert_eq!(
            response["categories"][5]["autoRule"],
            normalize_rule(&Value::Null)
        );
        let modules = arr(&response["sources"][0]["modules"]);
        assert_eq!(
            modules
                .iter()
                .map(|m| text(&m["effectiveCategoryId"]))
                .collect::<Vec<_>>(),
            ["manual", "first", "second", "arrival", "source", "unknown"]
        );
        assert!(st["sources"][0]["modules"][1]
            .get("effectiveCategoryId")
            .is_none());
        st["sources"][0]["author"] = json!("Editor");
        attach_categories(&mut st, ORIGIN);
        assert_eq!(
            st["sources"][0]["modules"][1]["effectiveCategoryId"],
            "second"
        );
    }

    #[test]
    fn classification_uses_the_published_mirror_type_and_preserves_background_removal_guard() {
        let mut st = defaults();
        st["categories"] = json!([{"id":"auto","autoRule":normalize_rule(&json!({"enabled":true,"contentTypes":["music","invalid"," music "]}))}]);
        assert_eq!(
            st["categories"][0]["autoRule"]["contentTypes"],
            json!(["music"])
        );
        st["sources"] = json!([{"id":"s","delivery":"mirror","modules":[{"id":"m","title":"Module","url":"https://example.com/m.js","contentType":"video","mirror":{"url":format!("{ORIGIN}/files/{}.js", "a".repeat(64)),"contentMetadataVersion":1,"contentType":"music"}}]}]);
        let mut d = json!({"key":"collection","title":"Collection","mode":"rules","categoryIds":["auto"],"enabled":true});
        let next = build(&st, &d, ORIGIN);
        assert_eq!(next["manifest"]["widgets"][0]["contentType"], "music");
        assert!(publish(&mut d, next, false).unwrap());
        st["distributions"] = json!([d]);
        st["sources"][0]["modules"][0]["mirror"]["contentType"] = json!("video");
        republish(&mut st, ORIGIN, false);
        assert_eq!(st["distributions"][0]["publishWarning"], "异常批量移除");
        assert_eq!(
            arr(&st["distributions"][0]["published"]["widgets"]).len(),
            1
        );
        republish(&mut st, ORIGIN, true);
        assert_eq!(st["distributions"][0]["publishWarning"], "");
        assert_eq!(st["distributions"][0]["published"]["widgets"], json!([]));
    }
}

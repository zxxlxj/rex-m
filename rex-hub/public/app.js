(() => {
'use strict';
const $ = (q, root = document) => root.querySelector(q);
const app = $('#app'), dialog = $('#dialog'), notice = $('#notice');
const esc = value => String(value ?? '').replace(/[&<>"']/g, ch => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[ch]));
const E = esc;
const checked = v => v ? ' checked' : '';
const selected = v => v ? ' selected' : '';
const mark = './hub-mark.png?v=hub2';
const defaultSettings = {defaultRefreshMinutes:30,defaultDelivery:'link',defaultIcon:'',defaultNewPolicy:'review'};
const blank = () => ({sources:[],categories:[],distributions:[],logs:[],settings:{...defaultSettings}});
let session, state = blank(), page = 'home', busy = false, timer, returnFocus;
const expanded = new Set(), openSettings = new Set(), openModules = new Set(), moduleSearch = new Map();
const selectedSources = new Set(), batchDeleteSources = new WeakMap();
let sourceSearch = '', selectingSources = false;
const selectedModules=new Map();
let selectingModules=false;
let sourceMode = 'groups', categorySearch = '', categoryFilter = '', typeFilter = '';
const contentTypes = Object.freeze({video:'视频', music:'音乐', audiobook:'有声书', shortDrama:'短剧'});
const contentType = (m,s) => {const type=m.mirror?.contentMetadataVersion===1 && s && sourceMirrorEnabled(s,m) ? m.mirror.contentType : m.contentType;return Object.hasOwn(contentTypes,type) ? type : '';};
const contentBadge = type => type ? `<span class="library-type" data-type="${type}">${contentTypes[type]}</span>` : '';
const effectiveCategory = (s,m) => m.effectiveCategoryId ?? (m.categoryId || s.categoryId || '');
const tabs = {home:'概览',sources:'来源',distributions:'分发',badges:'徽章',logs:'日志',settings:'设置'};
let unmountBadges;
const format = x => JSON.stringify(x, null, 2) ?? '—';
const label = s => s.label || s.url || s.id;
const normalizeState = obj => ({...Object.fromEntries(['sources','categories','distributions','logs'].map(k => [k, Array.isArray(obj?.[k]) ? obj[k] : []])),origin:obj?.origin,settings:{...defaultSettings,...obj?.settings}});
const values = (fd, key) => fd.getAll(key).map(String);
const text = (fd, key) => String(fd.get(key) || '').trim();
const errorText = e => e?.message || '操作失败，请重试。';
function toast(message) { clearTimeout(timer); notice.textContent = message; timer = setTimeout(() => notice.textContent = '', 5300); }
function image(src) {
  if (typeof src !== 'string' || !src.trim()) return mark;
  try { const parsed = new URL(src, location.href); if (!parsed.username && !parsed.password && !parsed.hash && ((/^https:\/\//i.test(src) && parsed.protocol === 'https:') || (/^\/(?![\/\\])/.test(src) && parsed.origin === location.origin) || (/^http:\/\//i.test(src) && parsed.protocol === 'http:' && parsed.origin === location.origin))) return src; } catch {}
  return mark;
}
async function api(path, body, type = 'application/json') {
  const response = await fetch(`/api/${path}`, body === undefined ? {cache:'no-store',credentials:'same-origin'} : {method:'POST',headers:{'Content-Type':type},credentials:'same-origin',body:type === 'application/json' ? JSON.stringify(body) : body});
  const data = await response.json().catch(() => null);
  if (!response.ok || data?.error) {
    if (response.status === 401 && session?.authenticated && !['login','setup'].includes(path)) {
      session.authenticated = false; state = blank(); if(dialog.open) dialog.close(); renderAuth();
    }
    throw Object.assign(Error(typeof data?.error === 'string' ? data.error : `请求失败（HTTP ${response.status}）`), {status:response.status,code:data?.code});
  }
  return data;
}
async function load() { state = normalizeState(await api('state')); }
function brand() { return `<div class="brand"><img src="${mark}" alt=""><div>REX Hub<small>管理控制台</small></div></div>`; }
function btn(title, action, attrs = '', variant = '') { return `<button type="button" class="btn ${variant}" data-act="${action}" ${attrs}>${E(title)}</button>`; }
function submit(title) { return `<button class="btn primary" type="submit">${E(title)}</button>`; }
function tag(title, off = false) { return `<span class="pill${off?' off':''}">${E(title)}</span>`; }
function empty(title) { return `<p class="empty">${E(title)}</p>`; }
function hero(_k,title) { return `<header class="library-head"><h1>${E(title)}</h1></header>`; }
function panel(title, content, tools='') { return `<section class="glass pad stack"><div class="row spread"><h2>${E(title)}</h2>${tools}</div><div>${content}</div></section>`; }
function field(title, control) { return `<label class="field"><span>${E(title)}</span>${control}</label>`; }
function input(name, value='', attrs='') { return `<input name="${name}" value="${E(value)}" ${attrs}>`; }
function toggle(title, name, value, attrs='') { return `<label class="toggle"><input type="checkbox" ${name ? `name="${name}"` : ''}${checked(value)} ${attrs}><span>${E(title)}</span></label>`; }
function categorySelect(current, attrs='', placeholder='未分类') { return `<select ${attrs}><option value="">${E(placeholder)}</option>${state.categories.map(c=>`<option value="${E(c.id)}"${selected(c.id===current)}>${E(c.name)}</option>`).join('')}</select>`; }
function formError() { return '<p class="error" data-error role="alert"></p>'; }
function renderAuth() {
  selectingSources=false;selectedSources.clear();
  sourceMode='groups';categorySearch='';categoryFilter='';typeFilter='';selectingModules=false;selectedModules.clear();
  unmountBadges?.();unmountBadges=undefined;
  const setup = !session.initialized;
  app.innerHTML = `<main class="auth-screen"><section class="auth glass pad stack">${brand()}<header><span class="eyebrow">${setup?'FIRST RUN':'WELCOME BACK'}</span><h1>${setup?'初始化控制台':'欢迎回来'}</h1><p>${setup?'输入部署时配置的初始化令牌，并为控制台设置密码。':'使用管理密码登录，管理 REX 来源与分发。'}</p></header><form class="stack" data-form="${setup?'setup':'login'}">${setup?field('初始化令牌',input('token','','type="password" required autocomplete="off"')):''}${field('管理密码',input('password','',`type="password" required autocomplete="${setup?'new-password':'current-password'}"`))}${formError()}${submit(setup?'初始化':'登录控制台')}</form></section></main>`;
}
function paths(d) { return `/s/${encodeURIComponent(d.key)}.rex`; }
function renderHome() {
  const moduleCount = state.sources.reduce((n,s)=>n+(s.modules||[]).filter(m=>!m.removed).length,0);
  const stats = [['来源',state.sources.length,'sources','groups'],['模块',moduleCount,'sources','groups'],['启用分发',state.distributions.filter(d=>d.enabled).length,'distributions'],['分类',state.categories.length,'sources','categories']];
  return hero('WORKSPACE','工作台','在同一个控制台里，管理模块来源、分类和对外分发。')+`<section class="grid" aria-label="工作台统计">${stats.map(([t,n,p,mode]) => `<div class="glass pad stat stack"><div><small>${t}</small><strong>${n}</strong></div>${btn('查看'+t,'nav',`data-page="${p}"${mode?` data-source-mode="${mode}"`:''}`,'link')}</div>`).join('')}</section>`+panel('快速操作','',`<div class="row">${btn('导入来源','import','','primary')}${btn('检查到期来源','sync')}</div>`)+panel('近期同步日志',logs(state.logs.slice(0,5)),btn('查看全部','nav','data-page="logs"'));
}
const refreshOptions=[5,15,30,60,180,360,720,1440];
const refreshValue=(value,isModule=false)=>refreshOptions.includes(Number(value))?Number(value):(isModule?0:30);
const deliveryValue=(value,isModule=false)=>value==='mirror'||value==='link'?value:(isModule?'inherit':'link');
const sourceDelivery=s=>deliveryValue(s.delivery??state.settings.defaultDelivery);
const sourceRefresh=s=>refreshValue(s.refreshMinutes);
const sourcePolicy=s=>s.newPolicy==='auto'?'auto':'review';
function policySelect(value,attrs) {
  return field('新增模块',`<select ${attrs}><option value="review"${selected(value!=='auto')}>待审核</option><option value="auto"${selected(value==='auto')}>自动接纳</option></select>`);
}
function deliverySelect(value,attrs,isModule=false) {
  const labels=[...(isModule?[['inherit','继承来源']]:[]),['link','上游直链'],['mirror','下载托管']];
  return field('交付方式',`<select ${attrs}>${labels.map(([key,title])=>`<option value="${key}"${selected(key===deliveryValue(value,isModule))}>${title}</option>`).join('')}</select>`);
}
function refreshSelect(value,attrs,isModule=false) {
  return field('刷新频率',`<select ${attrs}>${(isModule?[0,...refreshOptions]:refreshOptions).map(n=>`<option value="${n}"${selected(n===refreshValue(value,isModule))}>${n===0?'继承来源':n===1440?'24 小时':n>=60?`${n/60} 小时`:`${n} 分钟`}</option>`).join('')}</select>`);
}
const shanghaiTime = new Intl.DateTimeFormat('zh-CN',{timeZone:'Asia/Shanghai',year:'numeric',month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit',second:'2-digit',hourCycle:'h23'});
function checkTime(value) {
  if(value==null || value==='')return '—';
  const date=new Date(value);
  if(!Number.isFinite(date.getTime()))return '—';
  const p=Object.fromEntries(shanghaiTime.formatToParts(date).map(({type,value})=>[type,value]));
  return `${p.year}/${p.month}/${p.day} ${p.hour}:${p.minute}:${p.second}`;
}
function sourceCheck(s) {
  const last=Date.parse(s.checkedAt), due=last+sourceRefresh(s)*60_000;
  return [`上次检查：${Number.isFinite(last)?checkTime(last):'—'}`,s.paused?'自动检查已暂停':!Number.isFinite(last)?'':due<=Date.now()?'已到检查间隔，等待调度':`预计最早 ${checkTime(due)} 可再次检查`].filter(Boolean).join(' · ');
}
function isLocalModule(s,m) {
  if(m.local===true || m.uploaded===true || s.kind==='upload-modules')return true;
  try{const url=new URL(m.url,location.href);return /^\/files\/[a-f0-9]{64}\.js$/.test(url.pathname)&&(url.origin===location.origin||url.origin===state.origin);}catch{return false;}
}
function mirrorStatus(m) {
  const mirror=m.mirror||{}, last=Date.parse(mirror.checkedAt);
  const ready=mirror.url && image(mirror.url)===mirror.url;
  const version=mirror.version?`版本 ${mirror.version}`:'';
  const hash=mirror.hash?`<span title="${E(mirror.hash)}">哈希 ${E(String(mirror.hash).slice(0,12))}</span>`:'';
  return `<div class="library-mirror wrap"><small>${ready?`<a href="${E(mirror.url)}" target="_blank" rel="noopener noreferrer">托管文件</a>`:mirror.error?'托管未就绪':'等待下载'}${version?` · ${E(version)}`:''}${hash?` · ${hash}`:''} · 上次检查：${Number.isFinite(last)?E(checkTime(last)):'—'}</small>${mirror.remoteUrl&&mirror.remoteUrl!==m.url?`<small>上次检查地址：${E(mirror.remoteUrl)}</small>`:''}${mirror.error?`<small class="error">托管刷新失败：${E(mirror.error)}</small>`:''}</div>`;
}
function sourceMirrorEnabled(s,m){
  const delivery=deliveryValue(m.delivery,true);
  return delivery==='mirror'||delivery==='inherit'&&sourceDelivery(s)==='mirror';
}
function sourceCheckUnavailable(s){
  if(s.paused)return '来源已暂停刷新';
  if(s.url||(s.modules||[]).some(m=>m.url&&!isLocalModule(s,m)&&!m.paused&&!m.pending&&sourceMirrorEnabled(s,m)))return '';
  return '没有可检查的远程地址';
}
function sourceIcon(s){
  let hash=2166136261;
  for(const ch of String(s.id))hash=Math.imul(hash^ch.codePointAt(0),16777619);
  const fallback=`/rex-dino-${String((hash>>>0)%24+1).padStart(2,'0')}.png`;
  const first=(s.modules||[]).find(m=>!m.removed);
  const icon=image([s.icon,first?.icon].find(value=>typeof value==='string'&&value.trim())?.trim());
  return `<span class="library-glyph library-upstream-art" aria-hidden="true"><img src="${fallback}" alt="" decoding="async" width="35" height="35">${icon===mark||icon===fallback?'':`<img class="library-upstream-icon" src="${E(icon)}" data-upstream-icon alt="" decoding="async" referrerpolicy="same-origin" width="35" height="35">`}</span>`;
}
function sourceBatchToolbar(){
  return `<div class="library-batch row" id="source-batch" role="group" aria-label="批量操作"${selectingSources?'':' hidden'}><small data-source-selection-count role="status"></small>${btn('全选可见','source-select-visible','disabled')}${btn('清空','source-select-clear','disabled')}${btn('批量检查','source-batch-check','disabled')}${btn('批量删除','source-batch-delete','disabled','danger')}</div>`;
}
function sourceViewTabs() {
  return `<div class="library-view-tabs" role="tablist" aria-label="来源视图">${[['groups','来源分组'],['categories','分类']].map(([mode,title])=>btn(title,'source-view',`id="source-tab-${mode}" role="tab" aria-controls="source-view" aria-selected="${sourceMode===mode}" tabindex="${sourceMode===mode?0:-1}" data-source-mode="${mode}"`)).join('')}</div>`;
}
function renderSources() {
  return sourceMode==='categories'?renderSourceCategories():renderSourceGroups();
}
function renderSourceGroups() {
  if(!state.sources.length){selectingSources=false;sourceSearch='';}
  const ids=new Set(state.sources.map(s=>s.id));
  for(const id of selectedSources)if(!ids.has(id))selectedSources.delete(id);
  const rows=state.sources.map(s=>{
    const a=`data-id="${E(s.id)}"`, modules=s.modules||[];
    const pending=modules.filter(m=>m.pending).length;
    const category=state.categories.find(c=>c.id===s.categoryId)?.name;
    const host=s.url?new URL(s.url).hostname:'本地上传';
    const detailFlags=s.paused?'已暂停':pending?`${pending} 待审核`:'';
    const canMirror=modules.some(m=>!isLocalModule(s,m));
    const checkUnavailable=sourceCheckUnavailable(s);
    const checkLabel=`检查来源：${label(s)}${checkUnavailable?`（${checkUnavailable}）`:''}`;
    const onlineSettings=s.url?`${deliverySelect(sourceDelivery(s),`data-change="source-delivery" ${a}`)}${refreshSelect(sourceRefresh(s),`data-change="source-refresh" ${a}`)}${policySelect(sourcePolicy(s),`data-change="source-policy" ${a}`)}${field('新增模块分类',categorySelect(s.newCategoryId,`data-change="source-new-category" ${a}`, '自动分类或继承来源'))}${toggle('暂停刷新','',s.paused,`data-change="source-paused" ${a}`)}`:'';
    const options=`<details class="library-options" data-source-settings="${E(s.id)}"${openSettings.has(s.id)?' open':''}><summary>来源设置 <i class="chevron"></i></summary><div class="library-settings">${s.url?`<small class="wrap">${E(s.url)}${typeof s.status==='string'&&s.status!=='正常'?` · ${E(s.status)}`:''}</small><small class="wrap">${E(sourceCheck(s))}</small>`:''}<div class="library-fields">${field('默认分类',categorySelect(s.categoryId,`data-change="source-category" ${a}`))}${onlineSettings}${!s.url&&canMirror?deliverySelect(sourceDelivery(s),`data-change="source-delivery" ${a}`)+refreshSelect(sourceRefresh(s),`data-change="source-refresh" ${a}`):''}</div><div class="row">${!s.url?btn('重新上传','replace-source',a):''}${btn('删除来源','delete-source',a,'danger')}</div></div></details>`;
    const items=modules.map(m=>{
      const r=`data-id="${E(m.id)}" data-source="${E(s.id)}"`, key=`${s.id}:${m.id}`;
      const cat=state.categories.find(c=>c.id===effectiveCategory(s,m))?.name, type=contentType(m,s);
      const remote=!isLocalModule(s,m), delivery=deliveryValue(m.delivery,true);
      const mirrored=remote&&(delivery==='mirror'||delivery==='inherit'&&sourceDelivery(s)==='mirror');
      const deliverySettings=remote?`${deliverySelect(m.delivery,`data-change="module-delivery" ${r}`,true)}${mirrored?refreshSelect(m.refreshMinutes,`data-change="module-refresh" ${r}`,true):''}`:'';
      const mirrorAction=mirrored&&!s.paused&&!m.paused&&!m.pending?btn('检查托管','sync',`${a} data-module="${E(m.id)}"`):'';
      const meta=[m.version?`v${m.version}`:'',cat,mirrored?(m.mirror?.url?'下载托管':'托管未就绪'):'',m.pending?'待审核':'',m.removed?'上游已移除':'',m.disabled?'已禁用':'',m.paused?'已暂停':''].filter(Boolean).join(' · ');
      return `<details class="library-module" name="modules-${E(s.id)}" data-module="${E(key)}" data-search="${E(`${m.title||''} ${m.id} ${type} ${contentTypes[type]||''} ${meta}`.toLowerCase())}"${openModules.has(key)?' open':''}><summary><span class="library-text"><strong>${E(m.title||m.id)}</strong><small>${E(meta||m.id)}</small></span>${contentBadge(type)}<i class="chevron"></i></summary><div class="library-module-body"><small class="wrap mono">${E(m.id)}${m.url?` · ${E(m.url)}`:''}</small>${mirrored?mirrorStatus(m):''}<div class="library-fields">${field('模块分类',categorySelect(m.categoryId,`data-change="module-category" ${r}`,'自动分类或继承来源'))}${deliverySettings}<div class="row">${toggle('暂停刷新','',m.paused,`data-change="module-paused" ${r}`)}${toggle('禁用','',m.disabled,`data-change="module-disabled" ${r}`)}</div></div>${mirrorAction}${m.pending?btn('审核通过','approve-module',r,'primary'):''}</div></details>`;
    }).join('');
    return `<div class="library-source-row" ${a} data-search="${E(`${label(s)} ${host} ${category||''}`.toLowerCase())}"><details class="library-source" name="rex-library-source" ${a}${expanded.has(s.id)?' open':''}><summary>${sourceIcon(s)}<span class="library-text"><strong>${E(label(s))}</strong><small>${E([host,category,detailFlags].filter(Boolean).join(' · '))}</small></span><span class="library-count" aria-label="${modules.length} 个模块">${modules.length}</span><i class="chevron" aria-hidden="true"></i></summary><div class="library-body">${options}${modules.length>=6?`<input class="library-search" data-filter="modules" type="search" placeholder="搜索模块" aria-label="搜索模块" value="${E(moduleSearch.get(s.id)||'')}">`:''}<div class="library-modules">${items||empty('暂无模块')}<p class="empty" data-no-match hidden>无匹配模块</p></div></div></details><label class="library-source-select"${selectingSources?'':' hidden'}><input type="checkbox" data-change="source-select" ${a} aria-label="${E(`选择来源：${label(s)}`)}"${checked(selectedSources.has(s.id))}></label>${btn('检查','sync',`${a} aria-label="${E(checkLabel)}"${checkUnavailable?` disabled title="${E(checkUnavailable)}"`:''}`,'library-source-check')}</div>`;
  }).join('');
  const multiselect=`<button type="button" class="btn library-multiselect" data-act="source-multiselect" aria-label="批量选择来源" title="批量选择来源" aria-controls="source-batch" aria-pressed="${selectingSources}"${state.sources.length?'':' disabled'}><svg viewBox="0 0 24 24" width="19" height="19" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false"><rect x="3" y="3" width="18" height="18" rx="4"/><path d="m7.5 12 3 3 6-6"/></svg></button>`;
  return `<header class="library-head row spread"><h1>来源</h1><div class="row">${multiselect}${btn('检查到期来源','sync')}${btn('＋ 导入','import','','primary')}</div></header>${sourceViewTabs()}<section class="glass library-panel" id="source-view" role="tabpanel" aria-labelledby="source-tab-groups">${state.sources.length>=5||sourceSearch?`<input class="library-search" data-filter="sources" type="search" placeholder="搜索来源" aria-label="搜索来源" value="${E(sourceSearch)}">`:''}${sourceBatchToolbar()}<div class="library-sources">${rows||empty('暂无来源')}<p class="empty" data-no-match hidden>无匹配来源</p></div></section>`;
}
function renderSourceCategories() {
  const groups=new Map(state.categories.map(c=>[c.id,{key:`category:${c.id}`,title:c.name,rows:[]}]));
  const uncategorized={key:'uncategorized',title:'未分类',rows:[]};
  const allGroups=[...groups.values(),uncategorized];
  if(categoryFilter&&!allGroups.some(g=>g.key===categoryFilter))categoryFilter='';
  for(const s of state.sources)for(const m of s.modules||[]){
    const group=groups.get(effectiveCategory(s,m))||uncategorized, type=contentType(m,s), title=m.title||m.id;
    const meta=[label(s),m.version?`v${m.version}`:'',m.pending?'待审核':'',m.removed?'上游已移除':'',m.disabled?'已禁用':'',m.paused?'已暂停':''].filter(Boolean).join(' · ');
    const search=[title,m.id,group.title,meta,type,contentTypes[type]].join(' ').toLowerCase();
    const attrs=`data-change="module-category" data-id="${E(m.id)}" data-source="${E(s.id)}" aria-label="${E(`修改模块分类：${title}（${label(s)}）`)}"`;
    const ref=`${s.id}:${m.id}`;
    group.rows.push(`<li class="library-category-row" data-module-ref="${E(ref)}" data-source-id="${E(s.id)}" data-module-id="${E(m.id)}" data-search="${E(search)}" data-content-type="${type||'unspecified'}">${selectingModules?`<input type="checkbox" data-change="category-module-select" aria-label="${E(`选择 ${title}`)}"${checked(selectedModules.has(ref))}>`:``}<span class="library-text"><strong title="${E(title)}">${E(title)}</strong><small title="${E(meta)}">${E(meta)}</small></span>${contentBadge(type)}<div class="library-category-assignment">${categorySelect(m.categoryId,attrs,'自动或继承')}</div></li>`);
  }
  const filters=`<div class="library-category-filters"><input type="search" data-filter="category-modules" aria-label="搜索模块" placeholder="搜索模块或来源" autocomplete="off" value="${E(categorySearch)}">${field('模块声明',`<select data-change="category-type-filter"><option value="">全部类型</option><option value="unspecified"${selected(typeFilter==='unspecified')}>未指定</option>${Object.entries(contentTypes).map(([key,title])=>`<option value="${key}"${selected(key===typeFilter)}>${title}</option>`).join('')}</select>`)}</div>`;
  const categoryTabs=[{key:'',title:'全部'},uncategorized,...groups.values()];
  const chip=g=>btn(g.title,'category-chip',`data-category-key="${E(g.key)}" aria-pressed="${g.key===categoryFilter}"`,'library-category-chip');
  const primary=categoryTabs.slice(0,6), overflow=categoryTabs.slice(6);
  const activeOverflow=overflow.find(g=>g.key===categoryFilter);
  const categoryNav=`<div class="library-category-tabs" role="group" aria-label="模块分类">${primary.map(chip).join('')}${overflow.length?`<details class="library-category-more"><summary class="btn library-category-chip">${activeOverflow?E(activeOverflow.title)+' · ':''}更多</summary><div class="library-category-overflow">${overflow.map(chip).join('')}</div></details>`:''}</div>`;
  const groupsHtml=allGroups.filter(g=>g.rows.length).map(g=>`<section class="library-category-group" data-category-group="${E(g.key)}"><h2>${E(g.title)}</h2><ul>${g.rows.join('')}</ul></section>`).join('');
  return `<header class="library-head row spread"><h1>来源</h1><div class="row">${btn(selectingModules?'完成':'多选','module-select-mode',`aria-pressed="${selectingModules}"`)}${btn('管理分类','category-manage','','primary')}</div></header>${sourceViewTabs()}<div id="source-view" class="stack library-category-view" role="tabpanel" aria-labelledby="source-tab-categories">${categoryNav}<section class="glass library-category-panel" aria-label="分类模块">${filters}${selectingModules?`<div class="library-batch row"><small data-module-selection role="status"></small>${btn('全选筛选结果','module-select-visible')}${btn('清空','module-clear-selection')}${btn('调整分类','module-batch-category','disabled','primary')}</div>`:``}<p class="library-category-count" data-category-count role="status"></p>${groupsHtml}<p class="empty" data-category-empty hidden></p></section></div>`;
}
function filterCategoryModules(){
  const view=$('.library-category-view',app);if(!view)return;
  const query=categorySearch.trim().toLowerCase();let visible=0, total=0;
  for(const group of view.querySelectorAll('[data-category-group]')){
    const matchesCategory=!categoryFilter||categoryFilter===group.dataset.categoryGroup;
    group.querySelector('h2').hidden=!!categoryFilter;
    let groupCount=0;
    for(const row of group.querySelectorAll('.library-category-row')){
      const matches=matchesCategory&&(!typeFilter||typeFilter===row.dataset.contentType)&&row.dataset.search.includes(query);
      row.hidden=!matches;
      if(matches)groupCount++;
      total++;
    }
    group.hidden=!groupCount;
    visible+=groupCount;
  }
  $('[data-category-count]',view).textContent=`${visible} 个模块`;
  const noMatch=$('[data-category-empty]',view);
  const selection=$('[data-module-selection]',view);
  if(selection){const hidden=selectedModules.size-[...view.querySelectorAll('.library-category-row:not([hidden])')].filter(row=>selectedModules.has(row.dataset.moduleRef)).length;selection.textContent=`已选 ${selectedModules.size} 项${hidden?`（${hidden} 项不在当前筛选结果）`:``}`;$('[data-act="module-batch-category"]',view).disabled=!selectedModules.size||busy;}
  noMatch.hidden=visible>0;
  noMatch.textContent=categoryFilter&&!query&&!typeFilter?'此分类暂无模块。':!total&&!query&&!typeFilter?'暂无模块。':'没有匹配的模块。';
}
function filterLibrary(el){
  if(el.dataset.filter==='category-modules'){categorySearch=el.value;filterCategoryModules();return;}
  const modules=el.dataset.filter==='modules', scope=modules?el.closest('.library-source'):el.closest('.library-panel');
  const list=scope?.querySelector(modules?'.library-modules':'.library-sources');if(!list)return;
  const query=el.value.trim().toLowerCase();let count=0;
  if(modules)moduleSearch.set(scope.dataset.id,el.value);else sourceSearch=el.value;
  for(const row of list.children)if(row.dataset.search!==undefined){row.hidden=!row.dataset.search.includes(query);if(!row.hidden)count++;}
  const noMatch=list.querySelector(':scope > [data-no-match]');if(noMatch)noMatch.hidden=!query||count>0;
  if(!modules)refreshSourceSelection();
}
function sourceRows(){return app.querySelectorAll('.library-sources > .library-source-row');}
function selectedSourceRows(){return state.sources.filter(s=>selectedSources.has(s.id));}
function refreshSourceSelection(){
  const toolbar=$('#source-batch',app), toggle=$('[data-act="source-multiselect"]',app);
  if(!toolbar||!toggle)return;
  const rows=[...sourceRows()], chosen=selectedSourceRows();
  const hiddenCount=rows.filter(row=>row.hidden&&selectedSources.has(row.dataset.id)).length;
  const checkableCount=chosen.filter(s=>!sourceCheckUnavailable(s)).length;
  toolbar.hidden=!selectingSources;
  toggle.setAttribute('aria-pressed',String(selectingSources));
  $('.library-sources',app).classList.toggle('is-selecting',selectingSources);
  for(const row of rows){
    const checkbox=$('[data-change="source-select"]',row);
    checkbox.parentElement.hidden=!selectingSources;
    checkbox.checked=selectedSources.has(row.dataset.id);
    checkbox.disabled=busy;
  }
  $('[data-source-selection-count]',toolbar).textContent=`已选 ${chosen.length} 项${hiddenCount?` · ${hiddenCount} 项不在当前结果`:''}`;
  for(const [act,disabled] of [
    ['source-select-visible',!rows.some(row=>!row.hidden&&!selectedSources.has(row.dataset.id))],
    ['source-select-clear',!chosen.length],
    ['source-batch-check',!checkableCount],
    ['source-batch-delete',!chosen.length]
  ])$(`[data-act="${act}"]`,toolbar).disabled=busy||disabled;
  const check=$('[data-act="source-batch-check"]',toolbar);
  check.textContent=`批量检查${checkableCount?`（${checkableCount}）`:''}`;
  check.title='仅检查已选的可用远程来源；跳过已暂停和无远程地址的来源';
}
function renderDistributions() {
  const rows=state.distributions.map(d=>{
    const a=`data-id="${E(d.id)}"`;
    const path=d.key?paths(d):'', title=d.title||d.key||d.id;
    const mode=d.mode==='manual'?'手动选择':'规则筛选', status=d.enabled?'已启用':'已停用';
    const terms=[title,d.key,d.id,d.description,path,mode,status].join(' ');
    const publication=Object.hasOwn(d,'published')?(d.publishedAt?`上次发布：${E(checkTime(d.publishedAt))}`:'尚未发布'):'';
    return `<article class="dist-row" data-dist-item="${E(terms)}"><div class="dist-main"><img class="icon dist-icon" src="${E(image(d.icon))}" alt="" loading="lazy"><div class="dist-identity"><h3 class="wrap">${E(title)}</h3><div class="dist-meta"><span class="dist-status${d.enabled?' is-on':''}">${status}</span><span>${mode}</span>${publication&&!d.publishedAt?'<span>尚未发布</span>':''}</div></div><div class="dist-actions" aria-label="分发操作">${btn('编辑','edit-distribution',a)}${btn('预览','preview',a)}${btn('发布','publish',a,'primary')}</div></div>${d.publishWarning?`<small class="dist-warning wrap">自动发布暂停：${E(d.publishWarning)}</small>`:''}<details class="dist-more"><summary>链接与管理</summary><div class="dist-extra">${d.description?`<p class="wrap">${E(d.description)}</p>`:''}${path?`<a class="mono wrap" href="${E(path)}" target="_blank" rel="noopener noreferrer">${E(path)}</a>`:''}${publication?`<small class="wrap">${publication}</small>`:''}<div class="dist-actions">${path?btn('复制链接','copy',a):''}${btn(d.enabled?'停用':'启用','toggle-distribution',a)}${btn('删除','delete-distribution',a,'danger')}</div></div></details></article>`;
  }).join('');
  const count=state.distributions.length;
  const content=count?`<div data-dist-search class="dist-directory"><div class="dist-toolbar"><input type="search" data-dist-query aria-label="搜索分发" placeholder="搜索分发名称、标识或状态" enterkeyhint="search" autocomplete="off"><small class="dist-count" data-dist-count role="status">${count} 项分发</small></div><div class="dist-rows">${rows}</div><p class="dist-empty" data-dist-empty hidden>未找到分发，试试其他关键词。</p></div>`:empty('暂无分发。');
  return `<div class="dist-page stack">${hero('DELIVERY','分发管理','保存草稿后，可预览清单、手动发布并复制 REX 订阅链接。')}${panel('分发列表',content,btn('新建分发','edit-distribution','','primary'))}</div>`;
}
function logs(items) {
  return items.map(l=>`<div class="log"><small class="mono wrap">${E(checkTime(l.time))}</small><span class="wrap">${E(l.message)}</span></div>`).join('') || empty('暂无日志。');
}
const LOG_PAGE_SIZE=50;
let logPage=1;
function renderLogs() {
  const total=state.logs.length, pages=Math.max(1,Math.ceil(total/LOG_PAGE_SIZE));
  logPage=Math.min(pages,Math.max(1,logPage));
  const offset=(logPage-1)*LOG_PAGE_SIZE;
  const pager=()=>`<nav class="log-pager row" aria-label="日志分页">${btn('上一页','log-page',`data-log-page="${logPage-1}"${logPage===1?' disabled':''}`)}<span class="log-page-label" role="status">${logPage} / ${pages}</span>${btn('下一页','log-page',`data-log-page="${logPage+1}"${logPage===pages?' disabled':''}`)}</nav>`;
  return `<header class="library-head row spread"><div><h1>同步日志</h1><small>${total} 条</small></div>${btn('刷新','reload')}</header>${pages>1?pager():''}<section class="glass pad activity-list">${logs(state.logs.slice(offset,offset+LOG_PAGE_SIZE))}</section>${pages>1?pager():''}`;
}
function renderSettings() {
  const {defaultIcon,defaultDelivery,defaultRefreshMinutes,defaultNewPolicy}=state.settings;
  const defaultsForm=`<form class="stack" data-form="settings"><div class="library-fields">${deliverySelect(defaultDelivery,'name="defaultDelivery"')}${refreshSelect(defaultRefreshMinutes,'name="defaultRefreshMinutes"')}${policySelect(defaultNewPolicy,'name="defaultNewPolicy"')}</div><div class="row"><img class="icon" src="${E(image(defaultIcon))}" alt=""><small>默认分发图标</small></div>${iconFields(defaultIcon)}${formError()}<div class="row">${submit('保存默认设置')}</div></form>`;
  const passwordForm=`<form class="stack" data-form="password">${field('当前密码',input('currentPassword','','type="password" required autocomplete="current-password"'))}${field('新密码',input('newPassword','','type="password" required autocomplete="new-password"'))}${field('确认新密码',input('confirmPassword','','type="password" required autocomplete="new-password"'))}${formError()}<div class="row">${submit('修改密码')}</div></form>`;
  return hero('SETTINGS','设置')+panel('新建默认值',defaultsForm)+panel('修改密码',passwordForm)+'<small class="release-version">Rex Hub · '+E(document.querySelector('meta[name="application-version"]')?.content||'')+'</small>';
}
const renderers = {home:renderHome,sources:renderSources,distributions:renderDistributions,badges:()=>window.RexBadges.render(),logs:renderLogs,settings:renderSettings};
function render() {
  if (!session?.authenticated) return renderAuth();
  unmountBadges?.();unmountBadges=undefined;
  if(!$('#main',app))app.innerHTML=`<header class="top"><div class="row spread">${brand()}<nav class="nav" aria-label="主导航">${Object.entries(tabs).map(([key,name])=>`<button type="button" data-act="nav" data-page="${key}">${name}</button>`).join('')}</nav>${btn('退出','logout')}</div></header><div class="lg-bottom-edge" aria-hidden="true"></div><main class="page stack" id="main"></main>`;
  for(const tab of app.querySelectorAll('.nav > button[data-page]')){
    if(tab.dataset.page===page){if(tab.getAttribute('aria-current')!=='page')tab.setAttribute('aria-current','page');}
    else if(tab.hasAttribute('aria-current'))tab.removeAttribute('aria-current');
  }
  $('#main',app).innerHTML=renderers[page]();
  app.querySelectorAll('[data-filter]').forEach(filterLibrary);
  if(page==='sources')refreshSourceSelection();
  if(page==='badges')unmountBadges=window.RexBadges.attach($('[data-rex-badges]',app),{api,toast});
}
function go(target) { if (!Object.hasOwn(tabs,target)) return; page=target; render(); window.scrollTo(0,0); const h=$('main h1'); h.tabIndex=-1; h.focus({preventScroll:true}); }
function showDialog(title, html) {
  if(!dialog.open)returnFocus = document.activeElement;
  dialog.innerHTML=`<div class="stack"><div class="row spread"><h2 id="dialog-title">${E(title)}</h2>${btn('关闭','close','','link')}</div>${html}</div>`;
  if(!dialog.open)dialog.showModal();
}
dialog.addEventListener('close',()=>{if(returnFocus?.isConnected)returnFocus.focus({preventScroll:true});});
dialog.addEventListener('cancel',event=>{if(busy)event.preventDefault();});
function importForm(source) {
  const editing=Boolean(source);
  showDialog(editing?'重新上传来源':'导入来源',`<form class="stack" data-form="import" data-id="${E(source?.id)}">${editing?'<input type="hidden" name="method" value="files">':field('导入方式','<select name="method" data-change="import-method"><option value="url">从 URL 导入</option><option value="files">从文件导入</option></select>')}<div class="stack" data-import="url"${editing?' hidden':''}>${field('订阅或模块地址',input('url','',`type="url" ${editing?'disabled':'required'} placeholder="https://…"`))}${editing?'':`<div class="library-fields">${deliverySelect(state.settings.defaultDelivery,'name="delivery"')}${refreshSelect(state.settings.defaultRefreshMinutes,'name="refreshMinutes"')}</div>`}</div><div class="stack" data-import="files"${editing?'':' hidden'}>${field('模块文件（可多选）',`<input name="files" type="file" accept=".js,.rex.js,.rex" multiple ${editing?'required':'disabled'}>`)}</div>${editing?'':field('分类',categorySelect('', 'name="categoryId"'))}<details><summary>高级选项</summary><div class="stack">${field('相对地址的基础 URL（可选）',input('baseUrl','','type="url" placeholder="https://…/"'))}${[['id','模块 ID'],['title','模块标题'],['version','模块版本'],['requiredVersion','所需 REX 版本'],['author','作者'],['icon','模块图标 URL']].map(([k,t])=>field(`${t}（可选）`,input(k))).join('')}${field('内容类型（加密模块）','<select name="contentType"><option value="">未指定</option><option value="video">视频</option><option value="music">音乐</option><option value="audiobook">有声书</option><option value="shortDrama">短剧</option></select>')}${field('默认连播（加密模块）','<select name="continuousPlay"><option value="">未指定</option><option value="true">开启</option><option value="false">关闭</option></select>')}</div></details>${formError()}${submit(editing?'替换文件':'导入')}</form>`);
}
function iconFields(icon) {
  const chosen=String(icon||'').match(/(?:^|\/)rex-dino-(\d\d)\.png$/)?.[1];
  const gallery=`<details class="rex-icon-picker"><summary>选择像素霸王龙 <small data-rex-selected>${chosen?`已选 ${chosen} 号`:''}</small></summary><div class="rex-icon-grid" role="group" aria-label="像素霸王龙图标">${Array.from({length:24},(_,i)=>{const n=String(i+1).padStart(2,'0');return `<button type="button" aria-label="霸王龙 ${n} 号" aria-pressed="${chosen===n}" data-rex-icon="${n}"><img src="/rex-dino-${n}.png" alt="" width="42" height="42" loading="lazy"></button>`;}).join('')}</div></details>`;
  return gallery+field('图标 URL（可选）' ,input('icon',icon,'placeholder="https://… 或 /…"'))+field('或上传图标（优先使用）','<input name="iconFile" type="file" accept="image/png,image/jpeg,image/webp,image/gif">');
}
function checks(title, name, opts, current, grouped=false) {
  const chosen=new Set(current||[]);
  const map=new Map(opts.map(o=>[o.value,o]));
  for(const v of chosen) if(!map.has(v))map.set(v,{value:v,title:v,status:'当前不可用',group:'unavailable',groupTitle:'当前不可用'});
  const groups=new Map();
  for(const o of map.values()){
    const key=grouped?(o.group||'unavailable'):'';
    if(!groups.has(key))groups.set(key,{title:o.groupTitle||'当前不可用',items:[]});
    groups.get(key).items.push(o);
  }
  const row=o=>{
    const on=chosen.has(o.value);
    const terms=[o.title,o.value,o.id,o.groupTitle,o.status,o.search].join(' ');
    return `<label class="dist-choice" data-dist-option="${E(terms)}"><input type="checkbox" name="${name}" value="${E(o.value)}"${checked(on)}${o.pending&&name==='include'&&!on?' disabled':''}><span class="dist-option-text"><span class="dist-option-title">${E(o.title)}</span>${o.id&&o.id!==o.title?`<small class="mono" title="${E(o.id)}">${E(o.id)}</small>`:''}</span>${o.status?`<span class="dist-option-state">${E(o.status)}</span>`:''}</label>`;
  };
  const results=[...groups.values()].map(g=>{
    const rows=g.items.map(row).join('');
    if(!grouped)return rows;
    const count=g.items.filter(o=>chosen.has(o.value)).length;
    return `<details class="dist-group" data-dist-group${groups.size===1?' open':''}><summary><span class="wrap">${E(g.title)}</span><small data-dist-group-count>${count?`已选 ${count} · `:''}${g.items.length} 项</small></summary><div class="dist-group-options">${rows}</div></details>`;
  }).join('');
  return `<details class="dist-picker" data-dist-picker><summary><span>${E(title)}</span><small class="dist-count" data-dist-selected>已选 ${chosen.size}</small></summary><fieldset class="dist-picker-body"><legend class="dist-sr">${E(title)}</legend>${map.size?`<div class="dist-picker-tools"><input type="search" data-dist-query aria-label="搜索${E(title)}" placeholder="${grouped?'搜索名称、ID 或来源':'搜索名称或 ID'}" autocomplete="off" enterkeyhint="search"><button class="btn dist-selected-only" type="button" data-dist-selected-only aria-pressed="false">仅已选</button></div><p class="dist-result-note" data-dist-count role="status">${map.size} 项${grouped?` · ${groups.size} 组`:''}</p><div class="dist-results" data-dist-results tabindex="0" role="region" aria-label="${E(title)}选项">${results}</div><p class="dist-empty" data-dist-empty hidden>没有匹配的选项。</p>`:empty('暂无可选项。')}</fieldset></details>`;
}
function distributionForm(d) {
  const model=d||{};
  const opts=state.sources.flatMap(s=>(s.modules||[]).map(m=>({value:`${s.id}:${m.id}`,title:m.title||m.id,id:m.id,group:s.id,groupTitle:label(s),search:[m.url,s.url].join(' '),pending:!!m.pending,status:[m.pending?'待审核':'',m.disabled?'已禁用':'',m.removed?'上游已移除':''].filter(Boolean).join(' · ')})));
  const moduleHelp='排除优先；已禁用或待审核的模块不会分发。';
  showDialog(d?'编辑分发':'新建分发',`<form class="stack dist-form" data-form="distribution" data-id="${E(model.id)}">${field('标题',input('title',model.title,'required'))}<details class="dist-form-extra"><summary>描述、地址与图标</summary><div class="stack">${field('描述（可选）',`<textarea name="description" rows="2">${E(model.description)}</textarea>`)}${field('自定义地址标识（留空随机生成）',input('key',model.key,'placeholder="例如 my-rex" autocapitalize="none" spellcheck="false"'))}${iconFields(d?model.icon:state.settings.defaultIcon)}</div></details><div class="dist-form-settings">${field('选择模式',`<select name="mode" data-change="mode"><option value="rules"${selected(model.mode!=='manual')}>按规则筛选</option><option value="manual"${selected(model.mode==='manual')}>手动选择模块</option></select>`)}${toggle('启用分发','enabled',model.enabled??true)}</div><div class="dist-picker-list" data-rules ${model.mode==='manual'?'hidden':''}>${checks('分类规则','categoryIds',state.categories.map(c=>({value:c.id,title:c.name})),model.categoryIds)}${checks('来源规则','sourceIds',state.sources.map(s=>({value:s.id,title:label(s),search:s.url})),model.sourceIds)}<small>来源规则包含整个来源，即使模块已单独改分类。</small></div><div class="dist-picker-list">${checks('明确包含模块','include',opts,model.include,true)}${checks('排除模块','exclude',opts,model.exclude,true)}<small>${moduleHelp}</small></div>${field('排序',`<select name="order"><option value="title"${selected(model.order!=='source')}>按标题</option><option value="source"${selected(model.order==='source')}>按来源</option></select>`)}${formError()}<div class="row"><button class="btn primary" type="submit" value="publish">保存并发布</button><button class="btn" type="submit" value="draft">存草稿</button><button class="btn danger" type="button" data-confirm-publish hidden>确认并发布</button></div></form>`);
}
(() => {
  const normalize=value=>value.normalize('NFKC').toLowerCase();
  const terms=input=>normalize(input.value).trim().split(/\s+/).filter(Boolean);
  const matches=(value,words)=>!words.length||words.every(word=>normalize(value).includes(word));
  const set=(el,value)=>{if(el.textContent!==value)el.textContent=value;};
  const previousGroups=new WeakMap();
  function updatePicker(picker,reason){
    const query=$('[data-dist-query]',picker), only=$('[data-dist-selected-only]',picker);
    const words=terms(query), selectedOnly=only.getAttribute('aria-pressed')==='true';
    const filtering=words.length>0||selectedOnly;
    const groups=[...picker.querySelectorAll('[data-dist-group]')];
    if(filtering&&!previousGroups.has(picker))previousGroups.set(picker,new Set(groups.filter(g=>g.open)));
    const prior=previousGroups.get(picker);
    let shown=0,total=0,on=0,visibleGroups=0;
    const updateRows=root=>{
      let count=0,picked=0,size=0;
      for(const row of root.querySelectorAll('[data-dist-option]')){
        const input=$('input',row);
        row.hidden=(!input.checked&&selectedOnly)||!matches(row.dataset.distOption,words);
        if(!row.hidden)++count;
        if(input.checked)++picked;
        ++size;
      }
      shown+=count; on+=picked; total+=size;
      return {count,picked,size};
    };
    if(groups.length){
      for(const g of groups){
        const {count,picked,size}=updateRows(g);
        g.hidden=!count;
        if(count)++visibleGroups;
        if(filtering&&reason!=='selection'&&count)g.open=true;
        if(!filtering&&prior)g.open=prior.has(g);
        set($('[data-dist-group-count]',g),`${picked?`已选 ${picked} · `:''}${filtering?`${count} / `:''}${size} 项`);
      }
    }else updateRows(picker);
    if(!filtering)previousGroups.delete(picker);
    set($('[data-dist-selected]',picker),`已选 ${on}`);
    set($('[data-dist-count]',picker),`${filtering?`${shown} / `:''}${total} 项${groups.length?` · ${visibleGroups} 组`:''}`);
    $('[data-dist-empty]',picker).hidden=shown>0;
    $('[data-dist-results]',picker).hidden=shown===0;
  }
  function filter(event){
    const input=event.target;
    if(!input.matches?.('[data-dist-query]')||event.isComposing)return;
    const picker=input.closest('[data-dist-picker]');
    if(picker){updatePicker(picker,'query');return;}
    const scope=input.closest('[data-dist-search]');
    if(!scope)return;
    const words=terms(input), items=scope.querySelectorAll('[data-dist-item]');
    let shown=0;
    for(const row of items){row.hidden=!matches(row.dataset.distItem,words);if(!row.hidden)++shown;}
    set($('[data-dist-count]',scope),`${words.length?`${shown} / `:''}${items.length} 项分发`);
    $('[data-dist-empty]',scope).hidden=shown>0;
  }
  document.addEventListener('input',filter);
  document.addEventListener('compositionend',filter);
  document.addEventListener('keydown',event=>{
    if(event.key==='Enter'&&!event.isComposing&&event.target.matches?.('.dist-picker [data-dist-query]'))event.preventDefault();
  });
  document.addEventListener('click',event=>{
    const button=event.target.closest?.('[data-dist-selected-only]');
    if(!button||busy)return;
    button.setAttribute('aria-pressed',String(button.getAttribute('aria-pressed')!=='true'));
    updatePicker(button.closest('[data-dist-picker]'),'query');
  });
  document.addEventListener('change',event=>{
    const row=event.target.closest?.('[data-dist-option]');
    if(!row)return;
    const picker=row.closest('[data-dist-picker]'), focused=document.activeElement===event.target;
    updatePicker(picker,'selection');
    if(row.hidden&&focused)$('[data-dist-selected-only]',picker).focus({preventScroll:true});
  });
})();
const ruleFields={moduleName:'模块名称',moduleAuthor:'模块作者',sourceName:'来源名称',sourceAuthor:'来源作者'};
function categoryAutoRule(c){
  const rule=c.autoRule||{};
  const types={...contentTypes,unspecified:'未指定'};
  return `<details class="category-auto"><summary><span class="grow wrap">${E(c.name)}</span><small>${rule.enabled?'自动分类已开启':'自动分类关闭'}</small><i class="chevron" aria-hidden="true"></i></summary><form class="stack" data-form="category-rule" data-id="${E(c.id)}">${toggle('开启自动分类','autoEnabled',rule.enabled)}<fieldset><legend>模块声明</legend><div class="category-rule-types">${Object.entries(types).map(([key,label])=>`<label><input type="checkbox" name="autoTypes" value="${key}"${checked((rule.contentTypes||[]).includes(key))}>${label}</label>`).join('')}</div></fieldset><div class="category-rule-fields">${Object.entries(ruleFields).map(([key,label])=>field(label,input(key,rule[key],'maxlength="256" placeholder="任意匹配，多个词用逗号"'))).join('')}</div><small>填写的条件须同时满足。多条规则命中时，列表靠前的分类优先；手动分类不受影响。</small>${formError()}<div class="row">${submit('保存规则')}${btn('重命名','edit-category',`data-id="${E(c.id)}"`)}${btn('删除','delete-category',`data-id="${E(c.id)}"`,'danger')}</div></form></details>`;
}
function categoryForm(c) {
  showDialog(c?'重命名分类':'新建分类',`<form class="stack" data-form="category" data-id="${E(c?.id)}">${field('分类名称',input('name',c?.name,'required'))}${formError()}${submit('保存分类')}</form>`);
}
function config(d) {
  const {id,key,title,description,icon,enabled,mode,categoryIds,sourceIds,include,exclude,order}=d;
  return {id,key,title,description:description||'',icon:icon||'',enabled:!!enabled,mode:mode||'rules',categoryIds:categoryIds||[],sourceIds:sourceIds||[],include:include||[],exclude:exclude||[],order:order||'title'};
}
async function uploadedIcon(fd) {
  const file=fd.get('iconFile');
  if(file?.name) {
    const types={png:'image/png',jpg:'image/jpeg',jpeg:'image/jpeg',webp:'image/webp',gif:'image/gif'};
    const type=Object.values(types).includes(file.type)?file.type:types[file.name.split('.').pop().toLowerCase()];
    if(!type)throw Error('请选择 PNG、JPEG、WebP 或 GIF 图标。');
    const data=await api('icon',file,type);
    if(!data?.url)throw Error('图标已上传，但未收到可用地址。');
    return data.url;
  }
  const url=text(fd,'icon');
  if(url && image(url)!==url)throw Error('请填写 HTTP(S) 图标地址或以 / 开头的同站路径。');
  return url;
}
const pendingPublish = new WeakMap(), editedDistribution = new WeakMap();
const forms={
  async login(fd){await api('login',{password:fd.get('password')}); await boot(true);},
  async setup(fd){await api('setup',{token:text(fd,'token'),password:fd.get('password')}); await boot(true);},
  async import(fd,form){
    const data=form.dataset.id?{replaceId:form.dataset.id}:{};
    if(text(fd,'method')==='files'){
      const files=fd.getAll('files').filter(f=>f.name);
      if(!files.length || files.some(f=>!(/\.(js|rex)$/i.test(f.name))))throw Error('请选择 .js、.rex.js 或 .rex 文件。');
      data.files=await Promise.all(files.map(async f=>({name:f.name,text:await f.text()})));
    }else {
      data.url=text(fd,'url');
      data.delivery=deliveryValue(text(fd,'delivery'));
      data.refreshMinutes=refreshValue(text(fd,'refreshMinutes'));
    }
    for(const key of ['baseUrl','categoryId']) if(text(fd,key))data[key]=text(fd,key);
    const metadata=Object.fromEntries(['id','title','version','requiredVersion','author','icon','contentType'].map(k=>[k,text(fd,k)]).filter(([,v])=>v));
    const play=text(fd,'continuousPlay');if(play)metadata.continuousPlay=play==='true';
    if(Object.keys(metadata).length)data.metadata=metadata;
    await save('source',data,'已导入。','sources');
  },
  async approve(fd,form){const {id,source}=form.dataset;await save('module/update',{id,sourceId:source,approve:true,categoryId:text(fd,'categoryId')},'审核通过。');},
  async 'category-batch'(fd){
    const modules=[...selectedModules.values()];if(!modules.length)return;
    await api('module/batch-category',{modules,categoryId:text(fd,'categoryId')});
    dialog.close();selectedModules.clear();selectingModules=false;await load();render();toast(`已调整 ${modules.length} 个模块的分类`);
  },
  async 'category-rule'(fd,form){
    const id=form.dataset.id, autoRule={enabled:fd.has('autoEnabled'),contentTypes:values(fd,'autoTypes')};
    for(const key of Object.keys(ruleFields))autoRule[key]=text(fd,key);
    if(autoRule.enabled&&!autoRule.contentTypes.length&&!Object.keys(ruleFields).some(key=>autoRule[key].split(/[,，\n]/).some(x=>x.trim())))throw Error('开启自动分类时，请至少设置一个匹配条件。');
    await api('category',{id,autoRule});await load();render();actions['category-manage']();
    for(const item of dialog.querySelectorAll('.category-auto'))if(item.querySelector('form')?.dataset.id===id)item.open=true;
    toast('自动分类规则已保存');
  },
  async category(fd,form){const id=form.dataset.id; await save('category',{...(id?{id}:{}),name:text(fd,'name')},'分类已保存。');},
  async distribution(fd,form,intent){
    const publish=intent!=='draft', confirm=publish&&intent==='confirm';
    const confirmButton=$('[data-confirm-publish]',form), pending=pendingPublish.get(form);
    const revision=editedDistribution.get(form);
    confirmButton.hidden=true;pendingPublish.delete(form);
    let payload;
    if(confirm){
      if(!pending || pending.revision!==revision)throw Error('配置已更改，请重新保存并发布。');
      payload={...pending.payload,confirmEmpty:true};
    }else{
      const id=form.dataset.id,key=text(fd,'key');
      payload={...(id?{id}:{}),...(key?{key}:{}),publish,title:text(fd,'title'),description:text(fd,'description'),icon:await uploadedIcon(fd),enabled:fd.has('enabled'),mode:text(fd,'mode'),order:text(fd,'order')};
      for(const k of ['categoryIds','sourceIds','include','exclude'])payload[k]=values(fd,k);
    }
    try{await save('distribution',payload,publish?'分发已保存并发布。':'分发草稿已保存。');}
    catch(e){
      if(publish&&!confirm&&form.isConnected&&dialog.open&&canConfirmPublish(e)&&editedDistribution.get(form)===revision){
        pendingPublish.set(form,{payload,revision});
        confirmButton.hidden=false;
        confirmButton.disabled=false;
        delete confirmButton.dataset.busy;
        confirmButton.focus();
      }
      throw e;
    }
  },
  async settings(fd){
    const defaultIcon=await uploadedIcon(fd);
    await save('settings',{defaultIcon,defaultDelivery:deliveryValue(text(fd,'defaultDelivery')),defaultRefreshMinutes:refreshValue(text(fd,'defaultRefreshMinutes')),defaultNewPolicy:text(fd,'defaultNewPolicy')},'默认设置已保存。');
  },
  async password(fd,form){
    const currentPassword=fd.get('currentPassword'), newPassword=fd.get('newPassword');
    if(newPassword!==fd.get('confirmPassword'))throw Error('两次输入的新密码不一致。');
    await api('password',{currentPassword,newPassword});
    form.reset();toast('密码已修改。');
  }
};
async function save(path,payload,message,target){
  const result=await api(path,payload);
  if(path==='source'&&result?.source?.id)expanded.add(result.source.id);
  if(dialog.open)dialog.close();
  try { await load(); } catch(e) { throw Error(`操作已提交，但刷新状态失败：${errorText(e)}`); }
  if(target)go(target);else render();
  toast(result?.cleanupPending?'来源已撤下，剩余文件将分批清理。':message);
}
function setBusy(value){
  busy=value;
  document.body.toggleAttribute('aria-busy',value);
  if(value) for(const b of document.querySelectorAll('button:enabled')) {b.dataset.busy='1';b.disabled=true;}
  else for(const b of document.querySelectorAll('[data-busy]')) {delete b.dataset.busy;b.disabled=false;}
  if(page==='sources')refreshSourceSelection();
}
function ask(title, message, act, id, button=title, danger=true){
  showDialog(title,`<p class="wrap">${E(message)}</p>${formError()}<div class="row">${btn('取消','close')}${btn(button,act,`data-id="${E(id)}"`,danger?'danger':'primary')}</div>`);
}
async function distributionPreview(d,publishing){
  const data=await api(`preview?id=${encodeURIComponent(d.id)}`);
  const manifest=data?.manifest, conflicts=data?.conflicts;
  const items=Array.isArray(manifest)?manifest:['widgets','modules','items','list','sources'].map(k=>manifest?.[k]).find(Array.isArray);
  const isEmpty=manifest==null || typeof manifest==='object' && !Object.keys(manifest).length || items?.length===0;
  const hasConflicts=Array.isArray(conflicts)?conflicts.length:conflicts && (typeof conflicts!=='object'||Object.keys(conflicts).length);
  const conflictBlocked=Array.isArray(data?.blocked)&&data.blocked.length>0;
  const missing=Array.isArray(data?.missingMirrors)?data.missingMirrors:[];
  const blocked=conflictBlocked||missing.length>0;
  const needsConfirmation=isEmpty||data?.needsConfirmation===true;
  showDialog(publishing?'确认发布':'分发预览',`${conflictBlocked?'<p class="error">模块 ID 冲突：请明确包含一个模块或排除重复项。</p>':''}${missing.length?`<p class="error wrap">${missing.length} 个托管模块等待首次下载：${E(missing.slice(0,4).map(m=>m.title||m.id).join('、'))}${missing.length>4?'…':''}。请先检查来源。</p>`:''}${!blocked&&isEmpty?'<p class="error">清单没有模块，发布会替换当前内容。</p>':!blocked&&needsConfirmation?'<p class="error">此次发布将移除大量模块，请核对清单。</p>':''}${hasConflicts?`<details><summary>ID 冲突</summary><pre>${E(format(conflicts))}</pre></details>`:''}<details ${!publishing||needsConfirmation?'open':''}><summary>草稿清单${items?` · ${items.length} 项`:''}</summary><pre>${E(format(manifest))}</pre></details>${formError()}${publishing?`<div class="row">${btn('取消','close')}${blocked?'':btn(isEmpty?'确认发布空清单':needsConfirmation?'确认移除并发布':'确认发布','publish-confirm',`data-id="${E(d.id)}"${needsConfirmation?' data-empty="1"':''}`,'primary')}</div>`:''}`);
}
async function copy(value){
  try { if (navigator.clipboard?.writeText) {await navigator.clipboard.writeText(value);return;} } catch {}
  showDialog('复制分发链接',`<p>浏览器没有授予剪贴板访问权限。可长按或选中文字复制。</p>${field('完整链接',input('copy-link',value,'readonly autofocus'))}`);
  $('[name="copy-link"]',dialog).select();
}
async function submitSourceBatch(action, ids){
  const result=await api('source/batch',{ids,action});
  if(dialog.open)dialog.close();
  if(action==='delete')for(const id of ids)selectedSources.delete(id);
  try{await load();}catch(e){throw Error(`操作已提交，但刷新状态失败：${errorText(e)}`);}
  render();
  const focusAct=action==='delete'?'source-multiselect':'source-batch-check';
  requestAnimationFrame(()=>{
    if(page!=='sources'||dialog.open)return;
    const target=$(`[data-act="${focusAct}"]:enabled`,app)||$('.library-head h1',app);
    if(target?.tagName==='H1')target.tabIndex=-1;
    target?.focus({preventScroll:true});
  });
  if(action==='delete'){
    toast(`已删除 ${result?.deleted??ids.length} 个来源${result?.cleanupPending?'，剩余文件将分批清理':''}。`);
  }else{
    const parts=[`本次已检查 ${result?.checked??0} 项`];
    if(result?.failed)parts.push(`${result.failed} 项失败`);
    if(result?.queued)parts.push(`队列剩余 ${result.queued} 项`);
    if(result?.skipped)parts.push(`跳过 ${result.skipped} 项`);
    toast(parts.join('，')+'。');
  }
}
const actions={
  'category-chip'(b){categoryFilter=b.dataset.categoryKey;render();const chips=[...app.querySelectorAll('[data-category-key]')];const current=chips.find(x=>x.dataset.categoryKey===categoryFilter);(current?.closest('.library-category-more')?.querySelector('summary')||current)?.focus({preventScroll:true});},
  'category-manage'(){
    const rows=state.categories.map(categoryAutoRule).join('')||empty('尚未添加分类。');
    showDialog('管理分类',`<div class="stack">${btn('＋ 新建分类','edit-category','','primary')}<div class="library-category-manager-list">${rows}</div></div>`);
  },
  'module-select-mode'(){selectingModules=!selectingModules;if(!selectingModules)selectedModules.clear();render();$('[data-act="module-select-mode"]',app)?.focus({preventScroll:true});},
  'module-select-visible'(){for(const row of app.querySelectorAll('.library-category-row:not([hidden])')){selectedModules.set(row.dataset.moduleRef,{sourceId:row.dataset.sourceId,id:row.dataset.moduleId});$('input[type=checkbox]',row).checked=true;}filterCategoryModules();},
  'module-clear-selection'(){selectedModules.clear();for(const i of app.querySelectorAll('[data-change="category-module-select"]'))i.checked=false;filterCategoryModules();},
  'module-batch-category'(){if(!selectedModules.size)return;showDialog('调整分类',`<form class="stack" data-form="category-batch"><p>为已选的 ${selectedModules.size} 个模块设置分类。</p>${field('目标分类',categorySelect('','name="categoryId"','恢复自动分类或继承来源'))}${formError()}${submit('应用')}</form>`);},
  'source-multiselect'(){
    selectingSources=!selectingSources;
    if(!selectingSources)selectedSources.clear();
    refreshSourceSelection();
  },
  'source-select-visible'(){for(const row of sourceRows())if(!row.hidden)selectedSources.add(row.dataset.id);refreshSourceSelection();},
  'source-select-clear'(){selectedSources.clear();refreshSourceSelection();},
  'source-batch-delete'(){
    const chosen=selectedSourceRows();if(!chosen.length)return;
    const hidden=[...sourceRows()].filter(row=>row.hidden&&selectedSources.has(row.dataset.id)).length;
    const names=chosen.slice(0,5).map(s=>`<li>${E(label(s))}</li>`).join('');
    showDialog('批量删除来源',`<p class="wrap">确定删除 ${chosen.length} 个来源${hidden?`（含 ${hidden} 个不在当前筛选结果）`:''}？它们的模块将从分发撤下，未被其他来源使用的托管文件将被清理。</p><ul class="library-delete-list wrap">${names}${chosen.length>5?`<li>另有 ${chosen.length-5} 个来源</li>`:''}</ul>${formError()}<div class="row">${btn('取消','close')}${btn(`删除 ${chosen.length} 个来源`,'source-batch-delete-confirm','','danger')}</div>`);
    batchDeleteSources.set($('[data-act="source-batch-delete-confirm"]',dialog),chosen.map(s=>s.id));
  },
  'source-batch-delete-confirm'(b){const ids=batchDeleteSources.get(b);if(ids?.length)return submitSourceBatch('delete',ids);},
  'source-batch-check'(){const rows=selectedSourceRows();if(rows.some(s=>!sourceCheckUnavailable(s)))return submitSourceBatch('check',rows.map(s=>s.id));},
  nav(b){
    if(b.dataset.page==='sources'&&b.dataset.sourceMode)sourceMode=b.dataset.sourceMode;
    go(b.dataset.page);
  },
  'source-view'(b){
    const mode=b.dataset.sourceMode;
    if(page!=='sources'||!['groups','categories'].includes(mode)||mode===sourceMode)return;
    sourceMode=mode;render();
    $(`#source-tab-${mode}`,app)?.focus({preventScroll:true});
  },
  async logout(){await api('logout',{}); session.authenticated=false; state=blank();page='home';expanded.clear();renderAuth();},
  import(){importForm();},
  close(){dialog.close();},
  async sync(b){const {id,module}=b.dataset;await save('sync',id?{id,...(module?{moduleId:module}:{})}:{},'检查完成。');},
  async reload(){await load();logPage=1;render();toast('日志已刷新。');},
  'log-page'(b){logPage=Number(b.dataset.logPage)||1;go('logs');},
  'edit-category'(_,id){categoryForm(state.categories.find(c=>c.id===id));},
  'delete-category'(_,id){const c=state.categories.find(x=>x.id===id);if(c)ask('删除分类',`确定删除「${c.name}」？请检查引用此分类的分发规则。`,'delete-category-confirm',id);},
  'delete-category-confirm'(_,id){return save('category',{id,delete:true},'分类已删除。');},
  'delete-source'(_,id){const s=state.sources.find(x=>x.id===id);if(s)ask('删除来源',`确定删除「${label(s)}」？它的模块将从分发撤下，未被其他来源使用的托管文件会同步清理。`,'delete-source-confirm',id);},
  'replace-source'(_,id){const s=state.sources.find(x=>x.id===id&&!x.url);if(s)importForm(s);},
  'approve-module'(b,id){
    const sourceId=b.dataset.source,s=state.sources.find(x=>x.id===sourceId),m=s?.modules?.find(x=>x.id===id&&x.pending);
    if(!m)return;
    expanded.add(sourceId);
    showDialog('审核通过',`<form class="stack" data-form="approve" data-id="${E(id)}" data-source="${E(sourceId)}"><p class="wrap">「${E(m.title||m.id)}」审核通过后，符合规则的分发将自动更新。</p>${field('模块分类',categorySelect(m.categoryId,'name="categoryId"','自动分类或继承来源'))}${formError()}${submit('确认通过')}</form>`);
  },
  'delete-source-confirm'(_,id){return save('source/update',{id,delete:true},'来源已删除。');},
  'edit-distribution'(_,id,d){distributionForm(d);},
  'delete-distribution'(_,id,d){if(d)ask('删除分发',`确定删除「${d.title||d.key}」？此操作可能使现有订阅链接失效。`,'delete-distribution-confirm',id);},
  'delete-distribution-confirm'(_,id){return save('distribution',{id,delete:true},'分发已删除。');},
  'toggle-distribution'(_,id,d){if(d)ask(d.enabled?'停用分发':'启用分发',d.enabled?'停用可能影响现有订阅，请确认。':'启用分发不会替你发布草稿。','toggle-distribution-confirm',id,undefined,!!d.enabled);},
  'toggle-distribution-confirm'(_,id,d){if(d)return save('distribution',{...config(d),enabled:!d.enabled},d.enabled?'分发已停用。':'分发已启用。');},
  preview(_,id,d){if(d)return distributionPreview(d,false);},
  publish(_,id,d){if(d)return distributionPreview(d,true);},
  async 'publish-confirm'(b,id){
    try {await save('publish',{id,...(b.dataset.empty?{confirmEmpty:true}:{})},'分发已发布。');}
    catch(e){
      if(b.dataset.empty || !dialog.open || !canConfirmPublish(e))throw e;
      dialog.close();ask('再次确认发布',`${errorText(e)}。继续会替换当前发布内容。`,'publish-empty',id,'确认并发布',true);
    }
  },
  'publish-empty'(_,id){return save('publish',{id,confirmEmpty:true},'分发已发布。');},
  async copy(_,id,d){if(d?.key)await copy(new URL(paths(d),location.href).href);}
};
function canConfirmPublish(e) {
  return e?.status===409&&(e.code==='confirm_publish'||(!e.code&&/^(?:集合为空或检测到大量移除|清单为空或检测到大量移除)[，,。]?请确认后再发布[。！!]?$/u.test(errorText(e))));
}
function report(e, scope) {
  const target=scope?.isConnected ? $('[data-error]',scope) : null;
  if(target)target.textContent=errorText(e);else toast(errorText(e));
}
function asyncAction(work,scope){
  if(busy)return;
  const err=scope && $('[data-error]',scope);if(err)err.textContent='';
  setBusy(true);
  Promise.resolve().then(work).catch(e=>report(e,scope)).finally(()=>setBusy(false));
}
document.addEventListener('click',event=>{
  const b=event.target.closest?.('button[data-act]'); if(!b||busy)return;
  const {act,id}=b.dataset;
  if(['nav','source-view','category-chip','category-manage','module-select-mode','module-select-visible','module-clear-selection','module-batch-category','log-page','close','import','edit-distribution','edit-category','delete-category','delete-source','delete-distribution','toggle-distribution','replace-source','approve-module','source-multiselect','source-select-visible','source-select-clear','source-batch-delete'].includes(act)){
    actions[act](b,id,state.distributions.find(d=>d.id===id));return;
  }
  if(act==='retry'){asyncAction(()=>boot());return;}
  if(Object.hasOwn(actions,act))asyncAction(()=>actions[act](b,id,state.distributions.find(d=>d.id===id)),b.closest('dialog'));
});
document.addEventListener('submit',event=>{
  const f=event.target;
  if(!Object.hasOwn(forms,f.dataset.form))return;
  event.preventDefault();if(busy)return;
  const fd=new FormData(f);
  const intent=event.submitter?.value;
  asyncAction(()=>forms[f.dataset.form](fd,f,intent),f);
});
dialog.addEventListener('click',event=>{
  const button=event.target.closest?.('[data-confirm-publish]');
  if(!button||button.hidden||busy)return;
  const form=button.form;
  if(form.reportValidity())asyncAction(()=>forms.distribution(null,form,'confirm'),form);
});
function clearPublishConfirmation(event){
  const form=event.target.closest?.('form[data-form=distribution]');
  if(!form||!event.target.name)return;
  editedDistribution.set(form,(editedDistribution.get(form)||0)+1);
  pendingPublish.delete(form);
  const button=$('[data-confirm-publish]',form);
  if(!button.hidden){button.hidden=true;$('[data-error]',form).textContent='';}
}
dialog.addEventListener('input',clearPublishConfirmation);
dialog.addEventListener('change',clearPublishConfirmation);
function revealSourceIcon(img){if(img.matches?.('img[data-upstream-icon]')&&img.complete&&img.naturalWidth>0)img.classList.add('is-ready');}
app.addEventListener('load',event=>revealSourceIcon(event.target),true);
app.addEventListener('error',event=>{const img=event.target;if(img.matches?.('img[data-upstream-icon]'))navigator.serviceWorker?.controller?.postMessage({type:'bad-upstream-icon',url:img.currentSrc||img.src});},true);
app.addEventListener('input',event=>{if(event.target.dataset.filter&&!event.isComposing)filterLibrary(event.target);});
app.addEventListener('compositionend',event=>{if(event.target.dataset.filter)filterLibrary(event.target);});
app.addEventListener('keydown',event=>{
  if(busy||!event.target.matches?.('[data-act="source-view"]')||!['ArrowLeft','ArrowRight','Home','End'].includes(event.key))return;
  event.preventDefault();
  const mode=event.key==='Home'?'groups':event.key==='End'?'categories':sourceMode==='groups'?'categories':'groups';
  if(mode!==sourceMode)$(`#source-tab-${mode}`,app)?.click();
});
app.addEventListener('toggle',event=>{
  const el=event.target;
  if(!el.isConnected||page!=='sources')return;
  const key=el.dataset.module||el.dataset.sourceSettings||el.dataset.id;
  const group=el.dataset.module?openModules:el.dataset.sourceSettings?openSettings:expanded;
  if(el.tagName==='DETAILS'&&key){if(el.open)group.add(key);else group.delete(key);}
},true);
document.addEventListener('change',event=>{
  const el=event.target;
  const {change,id,source}=el.dataset;
  if(!change)return;
  if(change==='source-select'){
    if(!busy&&selectingSources){if(el.checked)selectedSources.add(id);else selectedSources.delete(id);}
    refreshSourceSelection();return;
  }
  if(change==='category-module-select'){const row=el.closest('[data-module-ref]');if(!row)return;const d=row.dataset;if(busy){el.checked=selectedModules.has(d.moduleRef);return;}if(el.checked)selectedModules.set(d.moduleRef,{sourceId:d.sourceId,id:d.moduleId});else selectedModules.delete(d.moduleRef);filterCategoryModules();return;}
  if(change==='category-type-filter'){
    typeFilter=el.value;
    filterCategoryModules();return;
  }
  if(change==='import-method') {
    for(const part of dialog.querySelectorAll('[data-import]')){
      part.hidden=part.dataset.import!==el.value;
      for(const control of part.querySelectorAll('input, select'))control.disabled=part.hidden;
      const i=$('input',part);i.required=!part.hidden;
    }
    return;
  }
  if(change==='mode'){ $('[data-rules]',dialog).hidden=el.value==='manual';return; }
  const s=state.sources.find(x=>x.id===(source||id));
  const m=source?s?.modules?.find(x=>x.id===id):s;
  if(!m)return;
  const prop=({'source-paused':'paused','source-category':'categoryId','source-policy':'newPolicy','source-new-category':'newCategoryId','source-delivery':'delivery','source-refresh':'refreshMinutes','module-delivery':'delivery','module-refresh':'refreshMinutes','module-paused':'paused','module-disabled':'disabled','module-category':'categoryId'})[change];
  if(!prop)return;
  const isCheck=el.type==='checkbox';
  const restore=()=>{
    if(isCheck)el.checked=!!m[prop];
    else el.value=prop==='delivery'?(source?deliveryValue(m.delivery,true):sourceDelivery(s)):prop==='refreshMinutes'?(source?refreshValue(m.refreshMinutes,true):sourceRefresh(s)):prop==='newPolicy'?sourcePolicy(s):m[prop]||'';
  };
  if(busy){restore();return;}
  const data={id,...(source?{sourceId:source}:{}),[prop]:isCheck?el.checked:prop==='refreshMinutes'?Number(el.value):el.value};
  asyncAction(async()=>{
    try{await save(source?'module/update':'source/update',data,'设置已保存。');}
    catch(e){restore();throw e;}
  });
});
async function boot(throwError=false){
  try{
    session=await api('bootstrap');
    if(!session || typeof session.initialized !== 'boolean' || typeof session.authenticated !== 'boolean')throw Error('会话响应无效。');
    if(session.authenticated){if(!session.state)throw Error('未收到后台数据。');state=normalizeState(session.state);delete session.state;}else state=blank();
    render();
  }catch(e){
    if(throwError)throw e;
    app.innerHTML=`<main class="startup glass stack" role="alert"><h2>无法连接控制台</h2><p>${E(errorText(e))}</p>${btn('重试','retry','','primary')}</main>`;
  }
}
document.addEventListener('click',event=>{
  const button=event.target.closest?.('button[data-rex-icon]');if(!button||busy)return;
  const form=button.closest('form'), n=button.dataset.rexIcon;
  if(!form||!n)return;
  form.elements.icon.value=`/rex-dino-${n}.png`;
  form.elements.iconFile.value='';
  for(const item of form.querySelectorAll('[data-rex-icon]'))item.setAttribute('aria-pressed',String(item===button));
  $('[data-rex-selected]',form).textContent=`已选 ${n} 号`;
});
document.addEventListener('input',event=>{
  const field=event.target, form=field.form;
  if(!form||!['icon','iconFile'].includes(field.name))return;
  for(const item of form.querySelectorAll('[data-rex-icon]'))item.setAttribute('aria-pressed','false');
  const status=$('[data-rex-selected]',form);if(status)status.textContent='';
});
app.addEventListener('rex:pull-refresh' ,event=>{
  if(busy||!session?.authenticated||document.querySelector('dialog[open]'))return;
  event.detail.pending=(async()=>{
    try{
      const badge=$('[data-rex-badges]',app);
      if(page==='badges'&&badge){
        const detail={};badge.dispatchEvent(new CustomEvent('rex:refresh',{detail}));
        if(detail.pending&&await detail.pending===false)throw Error('刷新失败，请重试。');
      }else{await load();if(!busy&&!document.querySelector('dialog[open]'))render();}
      return true;
    }catch(e){toast(errorText(e));return false;}
  })();
});
boot();
})();

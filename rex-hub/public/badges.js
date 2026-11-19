(() => {
'use strict';

const E = value => String(value ?? '').replace(/[&<>"']/g, ch => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[ch]));
const count = n => Math.max(0, Math.floor(Number(n) || 0));
const msg = error => error?.message || '操作失败，请重试。';
const title = item => item?.alias || item?.url || '未命名徽章包';
const modeName = item => item?.mode === 'host' ? '图片托管' : '直链';
const publicInput = value => /^https:\/\/[^/]/i.test(value) && !value.includes('#') && safeURL(value);
const presetBase = 'https://raw.githubusercontent.com/zxxlxj/rex-m/main/xijing-club/';
const presets = [['pppboom.json','戏精俱乐部 · 普通版','Rex 推荐']];
const glyph = (type, extra = '') => `<svg aria-hidden="true" ${extra} viewBox="0 0 24 24" width="19" height="19" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round">${({badge:'<path d="m12 2 4 2.3 4.5.9.9 4.5L23 12l-1.6 2.3-.9 4.5-4.5.9L12 22l-4-2.3-4.5-.9-.9-4.5L1 12l1.6-2.3.9-4.5L8 4.3Z"/><path d="m8.5 12 2.3 2.2 4.7-4.8"/>',plus:'<path d="M12 5v14M5 12h14"/>',copy:'<rect x="8" y="8" width="12" height="12" rx="2"/><path d="M16 8V6a2 2 0 0 0-2-2H6a2 2 0 0 0-2 2v8a2 2 0 0 0 2 2h2"/>',search:'<circle cx="10.5" cy="10.5" r="5.5"/><path d="m15 15 4 4"/>',chevron:'<path d="m8 10 4 4 4-4"/>',image:'<rect x="3.5" y="4.5" width="17" height="15" rx="3"/><path d="m4 16 4.5-4 3 2.5 3.5-4 5 5"/><circle cx="8.5" cy="8.5" r=".75"/>'})[type]}</svg>`;
const b = (label, act, opts = {}) => `<button type="button" class="rb-btn${opts.kind ? ` rb-${opts.kind}` : ''}" data-rb-act="${act}"${opts.id != null ? ` data-rb-id="${E(opts.id)}"` : ''}${opts.disabled ? ' disabled' : ''}${opts.attributes || ''}>${opts.icon ? glyph(opts.icon) : ''}${E(label)}</button>`;
const color = value => typeof value === 'string' && /^#(?:[a-f\d]{3}|[a-f\d]{4}|[a-f\d]{6}|[a-f\d]{8})$/i.test(value) ? value : '';
function safeURL(value, image = false) {
  if (typeof value !== 'string' || !value.trim() || /[\\\x00-\x20\x7f]/.test(value) || value.startsWith('//')) return '';
  try {
    const abs = /^https?:\/\//i.test(value);
    if (!abs && !(image && value.startsWith('/'))) return '';
    const url = new URL(value, location.href);
    if (url.username || url.password) return '';
    if (url.protocol !== 'https:' && !(url.protocol === 'http:' && (!image || url.origin === location.origin))) return '';
    return url.href;
  } catch { return ''; }
}
async function localApi(path, body) {
  const response = await fetch(`/api/${path}`, body === undefined ? {cache:'no-store',credentials:'same-origin'} : {method:'POST',credentials:'same-origin',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)});
  const value = await response.json().catch(() => null);
  if (!response.ok || typeof value?.error === 'string') throw Error(typeof value?.error === 'string' ? value.error : `请求失败（HTTP ${response.status}）`);
  return value;
}

function render() {
  return `<section class="rb" data-rex-badges aria-labelledby="rb-title">
    <header class="rb-head"><h1 id="rb-title">徽章管理</h1>${b('导入徽章','import',{kind:'primary',icon:'plus'})}</header>
    <section class="rb-glass rb-live" aria-labelledby="rb-live-title"><div class="rb-emblem">${glyph('badge')}</div><div class="rb-live-text"><p class="rb-kicker" id="rb-live-title">当前使用</p><h2 data-rb-live>正在读取…</h2><code data-rb-url></code></div><div class="rb-actions">${b('复制订阅链接','copy',{icon:'copy'})}${b('清除启用','clear',{kind:'quiet',disabled:true})}</div></section>
    <div class="rb-columns">
      <section class="rb-glass rb-panel" aria-labelledby="rb-list-title"><header class="rb-section-head"><h2 id="rb-list-title">徽章包</h2><span class="rb-counter" data-rb-count>—</span></header><div data-rb-list><p class="rb-empty">正在读取徽章包…</p></div></section>
      <details class="rb-glass rb-panel rb-preview" aria-labelledby="rb-preview-title" data-rb-preview><summary class="rb-section-head rb-preview-toggle" id="rb-preview-title"><span>预览 <small class="rb-muted" data-rb-preview-name></small></span>${glyph('chevron')}</summary>
        <form class="rb-tools" data-rb-form="search" hidden><label class="rb-search">${glyph('search')}<input type="search" name="query" placeholder="搜索徽章" aria-label="搜索徽章" maxlength="200" enterkeyhint="search" autocomplete="off"></label><select name="group" aria-label="筛选分组"><option value="">全部分组</option></select></form>
        <div data-rb-results aria-busy="false"><p class="rb-empty">选择一个徽章包预览。</p></div><div class="rb-pager" data-rb-pager hidden>${b('上一页','prev')}<small data-rb-page></small>${b('下一页','next')}</div><p class="rb-sr" data-rb-preview-status role="status" aria-live="polite"></p>
      </details>
    </div>
    <p class="rb-flash" data-rb-flash role="status" aria-live="polite" aria-atomic="true"></p>
    <dialog class="rb-dialog" data-rb-dialog aria-labelledby="rb-dialog-title"></dialog>
  </section>`;
}

const IS_MOUNTED = new WeakMap();
// api accepts paths relative to /api/; the returned cleanup is optional on DOM removal.
function attach(root, { api = localApi, toast } = {}) {
  if (!root) return;
  if (!root.matches('[data-rex-badges]')) root = root.querySelector('[data-rex-badges]');
  if (!root) return;
  if (IS_MOUNTED.has(root)) return IS_MOUNTED.get(root);
  const $ = selector => root.querySelector(selector);
  const stableURL = new URL('/badge.json', location.href).href;
  const live = $('[data-rb-live]'), list = $('[data-rb-list]'), dialog = $('[data-rb-dialog]');
  const search = $('[data-rb-form="search"]'), query = search.elements.query, group = search.elements.group;
  const preview = $('[data-rb-preview]'), results = $('[data-rb-results]'), previewStatus = $('[data-rb-preview-status]'), pager = $('[data-rb-pager]');
  const pending = new Set(), running = new Set(), stopped = new Map(), openRows = new Set();
  const abort = new AbortController();
  let data = {activeId:'',items:[]}, selectedId = '', page = 1, lastPage = 1, loaded = false, listSeq = 0, previewSeq = 0;
  let activeBusy = false, modalBusy = false, composing = false, importRows = [], returnFocus, searchTimer, flashTimer, processTimer;
  const alive = () => !abort.signal.aborted && root.isConnected;
  const lookup = id => data.items.find(item => item.id === id);
  const button = (action, id) => [...root.querySelectorAll(`[data-rb-act="${action}"]`)].find(el => id == null || el.dataset.rbId === id);
  const canActivate = item => item?.status === 'ready';
  const on = (element, type, callback, options) => element.addEventListener(type, callback, {...options,signal:abort.signal});
  const flash = message => {
    if (!alive()) return;
    const box = $('[data-rb-flash]'); box.textContent = message;
    clearTimeout(flashTimer);
    flashTimer = setTimeout(() => { box.textContent = ''; }, 6300);
  };
  let writes = Promise.resolve();
  function write(path, body) {
    const request = writes.then(() => {
      if (!alive()) throw Error('徽章管理已关闭。');
      return api(path,body);
    });
    writes = request.catch(() => {});
    return request;
  }
  $('[data-rb-url]').textContent = stableURL;

  function listPaint() {
    const focused = root.ownerDocument.activeElement;
    const rowFocus = list.contains(focused) ? {act:focused.dataset.rbAct,id:focused.dataset.rbId || focused.closest('details')?.dataset.rbRow} : null;
    for (const details of list.querySelectorAll('details[data-rb-row]')) {
      if (details.open) openRows.add(details.dataset.rbRow); else openRows.delete(details.dataset.rbRow);
    }
    const active = lookup(data.activeId);
    live.textContent = active ? title(active) : '未启用徽章包';
    root.toggleAttribute('data-rb-enabled', Boolean(active));
    button('clear').disabled = !data.activeId || activeBusy;
    $('[data-rb-count]').textContent = `${data.items.length} 个`;
    list.innerHTML = data.items.map(item => {
      const id = item.id, isActive = id === data.activeId, inspected = id === selectedId, queued = item.status === 'queued';
      const locked = pending.has(id), processing = running.has(id), paused = stopped.get(id);
      const all = count(item.assets), done = count(item.done), fail = count(item.failed);
      const status = queued ? (processing ? '下载中' : paused ? '已暂停' : '等待下载') : item.status === 'error' ? '失败' : '就绪';
      return `<article class="rb-row${inspected?' rb-inspected':''}">
        <div class="rb-row-head"><div class="rb-item-id"><h3>${E(title(item))}</h3><div class="rb-meta">${E(modeName(item))} · ${count(item.groups)} 组 · ${count(item.filters)} 条</div></div><span class="rb-status${isActive?' rb-status-on':item.status === 'error'?' rb-status-error':''}">${isActive ? '使用中' : status}</span></div>
        ${item.mode === 'host' ? `<div class="rb-progress"><progress aria-label="图片处理进度" max="${all || 1}" value="${Math.min(all,done + fail)}"></progress><small>已下载 ${done}/${all}${fail ? ` · ${fail} 失败` : ''}</small></div>` : ''}
        ${item.error || paused ? `<p class="rb-error">${E(item.error || paused)}</p>` : ''}
        <div class="rb-actions">
          ${b('预览','preview',{id,kind:'quiet',attributes:` aria-pressed="${inspected}"`})}
          ${isActive ? '' : b(activeBusy && locked ? '切换中…' : '设为当前','activate',{id,kind:'switch',disabled:!canActivate(item) || activeBusy || locked})}
          ${queued && paused ? b('继续下载','process',{id,disabled:locked || processing}) : (item.status === 'error' || (fail && !queued)) ? b('重试','retry',{id,disabled:locked || processing}) : ''}
          <details class="rb-more" data-rb-row="${E(id)}"${openRows.has(id) ? ' open' : ''}><summary aria-label="${E(title(item))}的更多操作">更多${glyph('chevron')}</summary>
            <div class="rb-menu">${item.url ? `<small title="来源地址">${E(item.url)}</small>` : ''}<div class="rb-actions">${b('编辑','edit',{id,disabled:locked || processing})}${b('删除','delete',{id,kind:'danger',disabled:locked || processing})}</div></div>
          </details>
        </div>
      </article>`;
    }).join('') || '<div class="rb-empty"><span class="rb-placeholder">' + glyph('badge') + '</span><strong>还没有徽章包</strong><span>可批量导入链接或本地 JSON 文件。</span></div>';
    if (rowFocus) {
      const substitute = (rowFocus.act && button(rowFocus.act,rowFocus.id)) || (rowFocus.act === undefined && [...list.querySelectorAll('summary')].find(el => el.closest('details').dataset.rbRow === rowFocus.id));
      (substitute && !substitute.disabled ? substitute : button('preview',rowFocus.id))?.focus({preventScroll:true});
    }
  }

  async function refresh() {
    const seq = ++listSeq;
    try {
      const next = await api('badges');
      if (!alive() || seq !== listSeq) return false;
      if (!next || !Array.isArray(next.items)) throw Error('服务器未返回徽章包列表。');
      data = {activeId:typeof next.activeId === 'string' ? next.activeId : '', items:next.items.filter(item => typeof item?.id === 'string' && item.id)};
      loaded = true;
      if (!lookup(selectedId)) selectPreview(lookup(data.activeId)?.id || data.items[0]?.id || '', false);
      else $('[data-rb-preview-name]').textContent = title(lookup(selectedId));
      listPaint();
      schedule();
      return true;
    } catch (error) {
      if (!alive() || seq !== listSeq) return false;
      if (!loaded) {
        live.textContent = '读取失败';
        list.innerHTML = `<div class="rb-empty"><span class="rb-error">${E(msg(error))}</span>${b('重新读取','reload')}</div>`;
      } else flash(`列表刷新失败：${msg(error)}`);
      return false;
    }
  }

  function selectPreview(id, focus = true) {
    const name = $('[data-rb-preview-name]'), heading = $('#rb-preview-title');
    if (id !== selectedId || !id) {
      clearTimeout(searchTimer);
      selectedId = id;
      query.value = '';
      group.innerHTML = '<option value="">全部分组</option>';
      page = lastPage = 1;
    }
    name.textContent = id ? title(lookup(id)) : '';
    search.hidden = !id;
    if (focus) {
      const wasOpen=preview.open;
      preview.open=true;
      heading.focus({preventScroll:true});
      preview.scrollIntoView({block:'nearest'});
      if(!wasOpen)return; // Opening triggers the toggle listener below.
    }
    if(preview.open)void loadPreview();
  }

  on(preview,'toggle',()=>{
    if(preview.open){void loadPreview();return;}
    clearTimeout(searchTimer);
    previewSeq++;
    results.replaceChildren();
    results.setAttribute('aria-busy','false');
    pager.hidden=true;
    previewStatus.textContent='';
  });

  async function loadPreview() {
    if(!preview.open)return;
    const seq = ++previewSeq, requestedId = selectedId;
    pager.hidden = true;
    if (!requestedId) {
      results.setAttribute('aria-busy','false');
      results.innerHTML = '<p class="rb-empty">选择一个徽章包预览。</p>';
      previewStatus.textContent = '';
      return;
    }
    const params = new URLSearchParams({id:requestedId,q:query.value.trim(),group:group.value,page:String(page)});
    results.setAttribute('aria-busy','true');
    results.innerHTML = '<p class="rb-empty">正在加载预览…</p>';
    previewStatus.textContent = '正在加载预览';
    try {
      const next = await api(`badges/preview?${params}`);
      if (!alive() || previewSeq !== seq) return;
      if (!Array.isArray(next?.items) || !Array.isArray(next.groups)) throw Error('服务器未返回预览数据。');
      const chosen = params.get('group'), groups = new Map();
      for (const entry of next.groups) if (entry?.id != null && String(entry.id)) groups.set(String(entry.id), entry.name || String(entry.id));
      group.innerHTML = '<option value="">全部分组</option>' + [...groups].map(([id,name]) => `<option value="${E(id)}">${E(name)}</option>`).join('');
      if (chosen && !groups.has(chosen)) {
        page = 1;
        void loadPreview();
        return;
      }
      group.value = chosen;
      lastPage = Math.max(1, Math.ceil(count(next.total) / (count(next.pageSize) || 1)));
      page = count(next.page) || page;
      if (!next.items.length && page > lastPage) { page = lastPage; void loadPreview(); return; }
      const rendered = next.items.map(item => {
        if (!item || typeof item !== 'object') return '';
        const name = item.name || '未命名徽章', image = safeURL(item.imageURL,true);
        const colors = [['--rb-tag',color(item.tagColor)],['--rb-text',color(item.textColor)],['--rb-border',color(item.borderColor)]].filter(([,value]) => value).map(([key,value]) => `${key}:${value}`).join(';');
        return `<li class="rb-thumb"><div class="rb-media"${colors ? ` style="${E(colors)}"` : ''}><span class="rb-media-fallback"${image ? ' hidden' : ''}>${glyph('image')}<span>无可用图片</span></span>${image ? `<img src="${E(image)}" alt="" loading="lazy" decoding="async" referrerpolicy="no-referrer" data-rb-img>` : ''}</div><strong>${E(name)}</strong><small>${E(groups.get(String(item.groupId)) || '未分组')}</small></li>`;
      }).join('');
      results.innerHTML = rendered ? `<ul class="rb-thumbs">${rendered}</ul>` : `<p class="rb-empty">${params.get('q') || chosen ? '没有找到符合条件的徽章。' : '这个徽章包没有可预览的徽章。'}</p>`;
      for (const img of results.querySelectorAll('[data-rb-img]')) if (img.complete && !img.naturalWidth) imageFallback(img);
      previewStatus.textContent = `共 ${count(next.total)} 个徽章，第 ${page} 页`;
      pager.hidden = lastPage < 2;
      $('[data-rb-page]').textContent = `${page} / ${lastPage} 页 · 共 ${count(next.total)} 个`;
      button('prev').disabled = page <= 1;
      button('next').disabled = page >= lastPage;
    } catch (error) {
      if (!alive() || previewSeq !== seq) return;
      results.innerHTML = `<div class="rb-empty"><span class="rb-error">${E(msg(error))}</span>${b('重新预览','preview-reload')}</div>`;
      previewStatus.textContent = '预览加载失败';
    } finally { if (alive() && previewSeq === seq) results.setAttribute('aria-busy','false'); }
  }

  function imageFallback(img) {
    img.previousElementSibling.hidden = false;
    img.remove();
  }
  on(results,'error',event => { if (event.target.matches?.('[data-rb-img]')) imageFallback(event.target); },{capture:true});

  // One batch at a time per mounted view; cap stalled work until manually resumed.
  function schedule() {
    if (!alive() || processTimer || running.size) return;
    const item = data.items.find(item => item.status === 'queued' && !pending.has(item.id) && !stopped.has(item.id));
    if (item) processTimer = setTimeout(() => {
      processTimer = undefined;
      if (alive() && lookup(item.id)?.status === 'queued' && !pending.has(item.id) && !stopped.has(item.id)) void process(item.id);
      else schedule();
    }, 250);
  }
  const signature = item => item ? `${item.status}:${item.assets}:${item.done}:${item.failed}` : '';
  const idleBatches = new Map();
  async function process(id) {
    if (running.size || pending.has(id) || lookup(id)?.status !== 'queued') return;
    stopped.delete(id);
    const before = signature(lookup(id));
    running.add(id);
    listPaint();
    try {
      await write('badges/process',{id});
      if (!alive()) return;
      if (!await refresh()) { stopped.set(id,'未能确认下载进度，请继续下载以重试。'); return; }
      if (before === signature(lookup(id))) {
        const n = (idleBatches.get(id) || 0) + 1;
        idleBatches.set(id,n);
        if (n >= 3) stopped.set(id,'多次处理未更新进度，请继续下载以重试。');
      } else {
        idleBatches.delete(id);
        if (selectedId === id && lookup(id)?.status === 'ready') void loadPreview();
      }
    } catch (error) { stopped.set(id,msg(error)); }
    finally { running.delete(id); if (alive()) { listPaint(); schedule(); } }
  }

  async function setActive(id) {
    if (activeBusy || id === data.activeId || (id && (!canActivate(lookup(id)) || pending.has(id)))) return;
    activeBusy = true;
    if (id) pending.add(id);
    listPaint();
    try {
      await write('badges/active',{id});
      if (!alive()) return;
      data.activeId = id;
      await refresh();
      flash(id ? '已切换当前徽章包，订阅地址不变。' : '已清除当前徽章包，订阅地址不变。');
    } catch (error) { flash(`切换失败：${msg(error)}`); }
    finally {
      activeBusy = false;
      if (id) pending.delete(id);
      if (alive()) { listPaint(); schedule(); }
    }
  }

  function showModal(label, html) {
    if (!dialog.open) returnFocus = root.ownerDocument.activeElement;
    dialog.innerHTML = `<header class="rb-dialog-head"><h2 id="rb-dialog-title">${E(label)}</h2>${b('关闭','close',{kind:'quiet'})}</header>${html}`;
    if (!dialog.open) dialog.showModal();
  }
  const hint = '<p class="rb-muted">直链保留原图地址；托管会分批下载图片，处理完成后再启用。</p>';
  const mode = (value = 'link', name = 'mode', label = '') => `<select name="${name}"${label ? ` aria-label="${E(label)}"` : ''}><option value="link"${value !== 'host'?' selected':''}>直链</option><option value="host"${value === 'host'?' selected':''}>图片托管</option></select>`;
  const field = (label, html) => `<label class="rb-field"><span>${E(label)}</span>${html}</label>`;
  const formAlert = '<p class="rb-error" data-rb-dialog-error role="alert"></p>';
  const submit = label => `<button type="submit" class="rb-btn rb-primary">${E(label)}</button>`;
  const setDialogError = text => { const box = dialog.querySelector('[data-rb-dialog-error]'); if (box) box.textContent = text; };
  function importForm() {
    importRows = [];
    showModal('导入徽章包',`<form class="rb-form" data-rb-form="stage">
      <fieldset class="rb-presets"><legend>仓库预设</legend>${presets.map(([file,label,note],i) => `<button type="button" class="rb-btn" data-rb-act="preset" data-rb-id="${i}"><span>${E(label)}</span><small>${E(note)}</small></button>`).join('')}</fieldset>
      ${field('徽章包 URL（每行一个）','<textarea name="urls" rows="3" placeholder="https://…/badges.json" spellcheck="false" autocapitalize="none" autofocus></textarea>')}
      ${field('本地 JSON 文件（可多选）','<input name="files" type="file" accept=".json,application/json" multiple>')}
      <div class="rb-form-grid">${field('默认交付方式',mode())}${field('本地文件的基础 URL（可选）','<input name="baseUrl" type="url" placeholder="https://…/" autocapitalize="none">')}</div>
      ${hint}<p class="rb-muted">URL 须为公开 HTTPS 地址；本地 JSON 始终使用托管模式。请确认徽章包的内容分级，含成人内容的包建议与通用包分开导入。</p>
      ${formAlert}<footer class="rb-actions">${submit('下一步：设置别名')}</footer>
    </form>`);
  }
  function stage(form) {
    const {urls,files,mode:delivery,baseUrl} = form.elements;
    const inputURLs = [...new Set(urls.value.split(/\r?\n/).map(v => v.trim()).filter(Boolean))];
    const inputFiles = [...files.files];
    if (!inputURLs.length && !inputFiles.length) { setDialogError('请填写至少一个 URL 或选择 JSON 文件。'); return; }
    if (baseUrl.value.trim() && inputFiles.length && !publicInput(baseUrl.value.trim())) { setDialogError('本地文件的基础 URL 必须是公开 HTTPS 地址。'); return; }
    importRows = [...inputURLs.map(url => ({url,label:url,mode:delivery.value})), ...inputFiles.map(file => ({file,label:file.name,baseUrl:baseUrl.value.trim(),mode:'host'}))];
    for (const row of importRows) {
      let name = row.label;
      if (row.url && safeURL(row.url)) {
        const link = new URL(row.url);
        name = link.pathname.split('/').filter(Boolean).pop() || link.hostname;
        try { name = decodeURIComponent(name); } catch {}
      }
      row.alias = name.replace(/\.json$/i,'').slice(0,120);
    }
    paintImports();
  }
  function paintImports(summary = '') {
    const finished = importRows.filter(row => row.done).length;
    showModal('确认导入',`<form class="rb-form" data-rb-form="import">
      <p class="rb-muted">每个徽章包独立导入。失败项可以修改后单独重试。</p>
      ${importRows.map((row,i) => `<section class="rb-import-row" aria-label="导入项 ${i+1}"><p>${E(row.label)}</p>
        ${row.done ? '<span class="rb-status rb-status-on">已导入</span>' : `<div class="rb-form-grid"><label class="rb-field"><span>别名</span><input name="alias-${i}" maxlength="120" value="${E(row.alias)}"></label>${row.file ? field('交付方式','<input value="图片托管（本地文件）" readonly>') : field('交付方式',mode(row.mode,`mode-${i}`))}</div>${!row.file && row.error ? field('修正 URL',`<input name="url-${i}" value="${E(row.url)}">`) : ''}${row.error ? `<small class="rb-error">${E(row.error)}</small>` : ''}`}
      </section>`).join('')}
      <p class="rb-muted" data-rb-import-status role="status" aria-live="polite">${E(summary)}</p>
      <footer class="rb-actions">${b(finished === importRows.length ? '完成' : '返回重选',finished === importRows.length ? 'close' : 'import',{kind:'quiet'})}${finished === importRows.length ? '' : submit(summary ? '重试未导入项' : '开始导入')}</footer>
    </form>`);
  }

  async function importItems(form) {
    let processed = 0, successes = 0;
    importRows.forEach((row,i) => {
      if (row.done) return;
      row.alias = form.elements[`alias-${i}`].value.trim();
      row.mode = row.file ? 'host' : form.elements[`mode-${i}`].value;
      if (form.elements[`url-${i}`]) row.url = row.label = form.elements[`url-${i}`].value.trim();
    });
    setModalBusy(true);
    const status = dialog.querySelector('[data-rb-import-status]');
    const total = importRows.filter(row => !row.done).length;
    try {
      for (const row of importRows) {
        if (!alive()) return;
        if (row.done) continue;
        status.textContent = `正在导入 ${processed+1}/${total}：${row.alias || row.label}`;
        try {
          let input;
          if (row.file) {
            if (row.file.size > 10 * 1024 * 1024) throw Error('本地徽章包不能超过 10 MiB。');
            input = {text:await row.file.text(),filename:row.file.name};
            if (row.baseUrl) input.baseUrl = row.baseUrl;
          } else {
            if (!publicInput(row.url)) throw Error('请输入公开 HTTPS 地址。');
            input = {url:row.url};
          }
          if (!alive()) return;
          await write('badges/import',{...input,mode:row.mode,...(row.alias ? {alias:row.alias} : {})});
          row.done = true; row.error = ''; successes++;
        } catch (error) { row.error = msg(error); }
        processed++;
      }
      if (alive() && successes) await refresh();
    } finally {
      setModalBusy(false);
      if (alive()) paintImports(`本次导入完成：${successes} 成功，${processed-successes} 失败。`);
    }
  }

  function setModalBusy(value) {
    modalBusy = value;
    for (const control of dialog.querySelectorAll('button,input,select,textarea')) control.disabled = value;
    dialog.setAttribute('aria-busy',String(value));
  }
  function editForm(item) {
    showModal('编辑徽章包',`<form class="rb-form" data-rb-form="edit" data-rb-id="${E(item.id)}">
      ${field('别名',`<input name="alias" value="${E(item.alias)}" maxlength="120" required autofocus>`)}
      ${field('交付方式',item.url ? mode(item.mode) : '<input value="图片托管（本地文件）" readonly>')}${hint}${item.id === data.activeId && item.mode === 'link' ? '<p class="rb-muted">切换为图片托管可能清除当前启用；下载完成后可重新设为当前。</p>' : ''}${formAlert}<footer class="rb-actions">${b('取消','close',{kind:'quiet'})}${submit('保存')}</footer>
    </form>`);
  }
  function deleteForm(item) {
    showModal('删除徽章包？',`<form class="rb-form" data-rb-form="delete" data-rb-id="${E(item.id)}">
      <p>将永久删除「${E(title(item))}」。${item.id === data.activeId ? '这是当前使用的徽章包，删除后固定订阅将不再指向该包。' : '其他徽章包不受影响。'}</p>
      ${formAlert}<footer class="rb-actions">${b('取消','close',{kind:'quiet',attributes:' autofocus'})}<button type="submit" class="rb-btn rb-danger-solid">确认删除</button></footer>
    </form>`);
  }

  async function update(id, fields, fromModal = false) {
    if (!lookup(id) || pending.has(id) || running.has(id)) return;
    pending.add(id);
    listPaint();
    if (fromModal) { setModalBusy(true); setDialogError(''); }
    try {
      await write('badges/update',{id,...fields});
      if (!alive()) return;
      if (fields.retry || fields.mode || fields.delete) { stopped.delete(id); idleBatches.delete(id); }
      if (fields.delete) {
        openRows.delete(id);
        if (data.activeId === id) data.activeId = '';
        data.items = data.items.filter(item => item.id !== id);
      }
      await refresh();
      if (alive() && fromModal) dialog.close();
      if (!fields.delete && selectedId === id) void loadPreview();
      flash(fields.delete ? '徽章包已删除。' : fields.retry ? '已请求重试。' : '徽章包已保存。');
    } catch (error) {
      if (fromModal) setDialogError(msg(error)); else flash(`操作失败：${msg(error)}`);
    } finally {
      pending.delete(id);
      if (fromModal) setModalBusy(false);
      if (alive()) { listPaint(); schedule(); }
    }
  }

  async function copyURL() {
    try {
      if (!navigator.clipboard?.writeText) throw Error();
      await navigator.clipboard.writeText(stableURL);
      flash('已复制固定订阅链接。');
    } catch {
      if (!alive()) return;
      showModal('复制订阅链接',`<div class="rb-form"><p class="rb-muted">当前环境无法自动复制，请长按或使用键盘复制。</p>${field('固定订阅地址',`<input data-rb-copy-value readonly value="${E(stableURL)}">`)}</div>`);
      const input = dialog.querySelector('[data-rb-copy-value]'); input.focus(); input.select();
    }
  }

  on(dialog,'close',() => {
    if (returnFocus?.isConnected) returnFocus.focus({preventScroll:true});
    else if (returnFocus?.dataset.rbAct) (button(returnFocus.dataset.rbAct,returnFocus.dataset.rbId) || button('import'))?.focus({preventScroll:true});
    importRows = [];
  });
  on(dialog,'cancel',event => { if (modalBusy) event.preventDefault(); });
  on(root,'click',event => {
    const control = event.target.closest('button[data-rb-act]');
    if (!control || control.disabled) return;
    const {rbAct:action,rbId:id} = control.dataset;
    const item = lookup(id);
    switch (action) {
      case 'import': importForm(); break;
      case 'preset': {
        const preset = presets[Number(id)], textarea = dialog.querySelector('[name="urls"]');
        if (!preset || !textarea) break;
        const url = presetBase + preset[0], values = textarea.value.trim().split(/\r?\n/).map(v => v.trim());
        if (!values.includes(url)) textarea.value = [textarea.value.trim(),url].filter(Boolean).join('\n');
        textarea.focus();
        textarea.setSelectionRange(textarea.value.length,textarea.value.length);
        break;
      }
      case 'close': if (!modalBusy) dialog.close(); break;
      case 'copy': void copyURL(); break;
      case 'clear': void setActive(''); break;
      case 'reload': void refresh(); break;
      case 'activate': void setActive(id); break;
      case 'preview': if (item) { selectPreview(id); listPaint(); } break;
      case 'preview-reload': void loadPreview(); break;
      case 'prev': if (page > 1) { page--; $('#rb-preview-title').focus({preventScroll:true}); void loadPreview(); } break;
      case 'next': if (page < lastPage) { page++; $('#rb-preview-title').focus({preventScroll:true}); void loadPreview(); } break;
      case 'retry': void update(id,{retry:true}); break;
      case 'process': stopped.delete(id); idleBatches.delete(id); if (running.size) { listPaint(); schedule(); } else void process(id); break;
      case 'edit': if (item) editForm(item); break;
      case 'delete': if (item) deleteForm(item); break;
    }
  });
  const newSearch = () => { clearTimeout(searchTimer); page = 1; void loadPreview(); };
  const scheduleSearch = () => { clearTimeout(searchTimer); previewSeq++; pager.hidden = true; searchTimer = setTimeout(newSearch,235); };
  on(query,'compositionstart',() => { composing = true; clearTimeout(searchTimer); });
  on(query,'compositionend',() => { composing = false; scheduleSearch(); });
  on(query,'input',event => { if (!event.isComposing && !composing) scheduleSearch(); });
  on(group,'change',newSearch);
  on(root,'submit',event => {
    const form = event.target, action = form.dataset.rbForm;
    if (!action) return;
    event.preventDefault();
    if (action === 'search') { if (!composing) newSearch(); return; }
    if (modalBusy) return;
    switch (action) {
      case 'stage': stage(form); break;
      case 'import': void importItems(form); break;
      case 'edit': {
        const item = lookup(form.dataset.rbId), alias = form.elements.alias.value.trim(), delivery = form.elements.mode?.value || item?.mode;
        if (!alias) { setDialogError('请输入别名。'); break; }
        if (item) void update(item.id,{alias,...(delivery !== item.mode ? {mode:delivery} : {})},true);
        break;
      }
      case 'delete': void update(form.dataset.rbId,{delete:true},true); break;
    }
  });
  const cleanup = () => {
    abort.abort();
    clearTimeout(searchTimer); clearTimeout(processTimer); clearTimeout(flashTimer);
    if (dialog.open) dialog.close();
    IS_MOUNTED.delete(root);
  };
  IS_MOUNTED.set(root,cleanup);
  void refresh();
  return cleanup;
}
window.RexBadges = {render,attach};
})();

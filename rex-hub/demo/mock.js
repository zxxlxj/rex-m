(() => {
'use strict';
const asset = name => new URL(`./${name}`, document.baseURI).href;
const dino = n => asset(`rex-dino-${String(n).padStart(2,'0')}.png`);
const stamp = (minutes = 0) => new Date(Date.now() + 28800000 - minutes * 60000).toISOString().replace('Z','+08:00');
const strings = value => Array.isArray(value) ? [...new Set(value.filter(x => typeof x === 'string'))] : [];
const text = (value, max = 120) => typeof value === 'string' ? value.trim().slice(0,max) : '';
const types = ['video','music','audiobook','shortDrama','unspecified'];
const fields = ['moduleName','moduleAuthor','sourceName','sourceAuthor'];
const rule = (input = {}) => ({enabled:input.enabled === true,contentTypes:strings(input.contentTypes).filter(t=>types.includes(t)),...Object.fromEntries(fields.map(k=>[k,text(input[k],256)]))});
const log = message => { state.logs.unshift({time:stamp(),message}); state.logs.splice(200); };
const problem = (message,status=400,code) => { throw Object.assign(new Error(message),{status,code}); };
const get = (items,id,name) => items.find(x=>x.id===id) || problem(`${name}不存在。`,404);
const pick = (from,keys) => Object.fromEntries(keys.filter(k=>Object.hasOwn(from,k)).map(k=>[k,from[k]]));
let serial=0;
const nextId = prefix => `${prefix}-${String(++serial).padStart(3,'0')}`;
const localIcon = value => {
  if(!value) return '';
  const match = String(value).match(/^(?:\/|\.\/)?rex-dino-(0[1-9]|1[0-9]|2[0-4])\.png$/);
  if(match) return dino(Number(match[1]));
  for(let i=1;i<=24;i++) if(value===dino(i)) return value;
  return dino(24);
};
const httpsURL = value => {
  try {
    const u = new URL(value);
    if(u.protocol==='https:'&&!u.username&&!u.password&&!u.hash) return u;
  } catch {}
  return problem('请输入不含凭据或片段的 HTTPS 地址。');
};
const state = {
  origin:location.origin,
  settings:{defaultRefreshMinutes:30,defaultDelivery:'link',defaultIcon:dino(3),defaultNewPolicy:'review'},
  categories:[
    {id:'film',name:'光影放映',autoRule:rule({enabled:true,contentTypes:['video']})},
    {id:'music',name:'音乐电台',autoRule:rule({enabled:true,contentTypes:['music']})},
    {id:'audio',name:'有声漫游',autoRule:rule({enabled:true,contentTypes:['audiobook']})},
    {id:'drama',name:'短剧剧场',autoRule:rule({enabled:true,contentTypes:['shortDrama']})},
    {id:'lab',name:'实验与自用',autoRule:rule({enabled:true,moduleName:'实验，测试'})},
    {id:'archive',name:'资料归档',autoRule:rule()}
  ],
  sources:[], distributions:[], logs:[]
};
const useMirror = (s,m) => !m.local && (m.delivery==='mirror'||m.delivery!=='link'&&s.delivery==='mirror');
function refreshMirror(m,minutes=0) {
  const hash=(Array.from(m.id,c=>c.codePointAt(0).toString(16)).join('')+'a77c1d').repeat(12).slice(0,64);
  m.mirror={url:asset(`files/${hash}.js`),hash,checkedAt:stamp(minutes),version:m.version,requiredVersion:m.requiredVersion,remoteUrl:m.url,...pick(m,['contentType','continuousPlay']),contentMetadataVersion:1};
}
function seedSource(id,label,author,art,rows,opts={}) {
  const base=`https://${id}.example`;
  const s={id,label,author,kind:'manifest',url:`${base}/collection.rex`,icon:dino(art),categoryId:'',newCategoryId:'',newPolicy:'review',refreshMinutes:30,delivery:'link',status:'正常',checkedAt:stamp(43),...opts};
  s.modules=rows.map(([key,title,type,version,extra={}],i)=>{
    const local=s.kind==='upload-modules';
    const m={id:key,title,author,description:`${title} · 演示模块`,version,requiredVersion:'0.1.0',url:local?asset(`files/${key}.js`):`${base}/modules/${key}.js`,icon:dino((art+i-1)%24+1),categoryId:'',delivery:'inherit',refreshMinutes:0,local,...(type?{contentType:type}:{}),...extra};
    if(useMirror(s,m)&&!m.pending) refreshMirror(m,31);
    return m;
  });
  state.sources.push(s);
}
seedSource('aurora','极光放映室','北窗工作室',1,[
  ['aurora-cinema','极光影院','video','1.4.2'],['island-docs','海岛纪录片','video','1.1.0'],
  ['orbit-films','轨道独立电影','video','0.9.4'],['horizon-anime','地平线动画馆','video','1.2.3'],
  ['midnight-screen','午夜片场','video','1.0.2',{pending:true}],['film-notes','电影手账实验','','0.4.1'],
  ['silent-clips','无声片段','video','0.8.0',{disabled:true}]
],{refreshMinutes:60,checkedAt:stamp(74)});
seedSource('tidal','潮汐电台','回声编辑部',6,[
  ['tidal-fm','潮汐 FM','music','2.1.0',{continuousPlay:true}],['neon-songs','霓虹歌单','music','1.3.0'],
  ['morning-jazz','晨间爵士','music','1.1.1'],['room-sessions','客厅现场','video','0.9.0',{categoryId:'music',delivery:'link'}]
],{delivery:'mirror',newPolicy:'auto',checkedAt:stamp(13)});
seedSource('paperboat','纸舟有声馆','纸舟读书会',11,[
  ['paper-tales','纸上旅人','audiobook','1.2.4',{continuousPlay:true}],['city-letters','街角来信','audiobook','1.0.6'],
  ['night-reading','夜航读书','audiobook','1.1.0',{continuousPlay:true}],['voice-notes','读书笔记','','0.7.0']
],{categoryId:'audio',checkedAt:stamp(26)});
seedSource('firefly','萤火短剧社','萤火创作组',16,[
  ['station-five','五号车站','shortDrama','1.3.2'],['sunset-shop','日落便利店','shortDrama','1.2.1'],
  ['weekend-mini','周末小剧场','shortDrama','0.8.1',{paused:true}]
],{paused:true,checkedAt:stamp(138),refreshMinutes:180});
seedSource('desk','桌面草稿箱','本地演示',21,[
  ['demo-prototype','播放器实验','','0.3.0'],['clip-index','剪辑索引','','1.0.0',{categoryId:'archive'}],
  ['preview-card','预览卡片','','0.6.2']
],{url:'',kind:'upload-modules',checkedAt:''});
const matches = (needle,values) => {
  const terms=needle.toLowerCase().split(/[,，\r\n]/).map(x=>x.trim()).filter(Boolean);
  return !terms.length||terms.some(x=>values.some(value=>String(value||'').toLowerCase().includes(x)));
};
const metadata = (s,m) => useMirror(s,m)&&m.mirror?.contentMetadataVersion===1?m.mirror:m;
function categoryOf(s,m) {
  const type=metadata(s,m).contentType||'unspecified';
  const values=[[m.title],[m.author],[s.label],s.author?[s.author]:s.modules.filter(x=>!x.removed).map(x=>x.author)];
  return m.categoryId||state.categories.find(({autoRule:r})=>r.enabled&&(r.contentTypes.length||fields.some(k=>r[k]))&&(!r.contentTypes.length||r.contentTypes.includes(type))&&fields.every((k,i)=>matches(r[k],values[i])))?.id||m.autoCategoryFallbackId||s.categoryId||'';
}
const snapshot = () => ({...state,sources:state.sources.map(s=>({...s,modules:s.modules.map(m=>({...m,effectiveCategoryId:categoryOf(s,m)}))}))});
const configKeys=['id','key','title','description','icon','enabled','mode','categoryIds','sourceIds','include','exclude','order'];
const config = d => pick(d,configKeys);
function preview(d,active=d) {
  const choices=new Map(), conflicts=[], blocked=new Set(), missingMirrors=[];
  for(const s of state.sources) for(const m of s.modules) {
    const ref=`${s.id}:${m.id}`, explicit=active.include.includes(ref);
    if(m.pending||m.disabled||m.removed||active.exclude.includes(ref)||!(explicit||active.mode==='rules'&&(active.sourceIds.includes(s.id)||active.categoryIds.includes(categoryOf(s,m))))) continue;
    const old=choices.get(m.id);
    if(old){
      conflicts.push({id:m.id,first:old.ref,second:ref,sources:[old.s.label,s.label],resolved:old.explicit!==explicit});
      if(old.explicit===explicit) blocked.add(m.id);
      else if(explicit) blocked.delete(m.id);
    }
    if(!old||explicit&&!old.explicit) choices.set(m.id,{s,m,ref,explicit});
  }
  const rows=[...choices.values()];
  if(active.order==='title') rows.sort((a,b)=>a.m.title.localeCompare(b.m.title,'zh-CN')||a.ref.localeCompare(b.ref));
  const widgets=rows.map(({s,m})=>{
    const mirror=useMirror(s,m)?m.mirror:null;
    if(useMirror(s,m)&&!mirror?.url) missingMirrors.push({id:m.id,title:m.title,source:s.label});
    return {...pick(m,['id','title','description','author','icon']),...pick(metadata(s,m),['contentType','continuousPlay','version','requiredVersion']),url:useMirror(s,m)?(mirror?.url?asset(`m/${active.key}/${encodeURIComponent(m.id)}.js`):''):m.url};
  });
  const {title,description}=active, icon=active.icon||asset('rex-mark.png');
  const keep=new Set(widgets.map(m=>m.id)), old=d.published?.widgets||[];
  const removed=old.filter(m=>!keep.has(m.id)).length;
  return {manifest:{name:title,title,description,icon,logo:icon,widgets},conflicts,blocked:[...blocked],missingMirrors,needsConfirmation:!widgets.length||removed>0&&(removed===old.length||removed>=3&&removed*2>=old.length)};
}
function publish(d,confirm=false,minutes=0) {
  const next=preview(d);
  if(next.blocked.length||next.missingMirrors.length) problem('请解决模块 ID 冲突或先检查托管模块。',409);
  if(next.needsConfirmation&&!confirm) problem('清单为空或检测到大量移除，请确认后再发布。',409,'confirm_publish');
  Object.assign(d,{active:config(d),published:next.manifest,publishedAt:stamp(minutes),publishWarning:''});
  return {ok:true,count:next.manifest.widgets.length};
}
function republish(allowRemoval=false) {
  for(const d of state.distributions) {
    if(!d.enabled||!d.active) continue;
    const next=preview(d,d.active);
    d.publishWarning=next.blocked.length?'模块 ID 冲突':next.missingMirrors.length?'等待托管模块首次下载':next.needsConfirmation&&!allowRemoval?'异常批量移除':'';
    if(d.publishWarning||JSON.stringify(next.manifest)===JSON.stringify(d.published)) continue;
    d.published=next.manifest;d.publishedAt=stamp();
    log(`自动更新「${d.active.title}」：${next.manifest.widgets.length} 个模块`);
  }
}
const dist = values => ({id:'',key:'',title:'',description:'',icon:'',enabled:true,mode:'rules',categoryIds:[],sourceIds:[],include:[],exclude:[],order:'title',published:null,...values});
state.distributions.push(
  dist({id:'weekend',key:'weekend-screening',title:'周末放映计划',description:'电影、纪录片与独立动画的精选清单。',icon:dino(4),categoryIds:['film']}),
  dist({id:'commute',key:'commute-radio',title:'通勤声景',description:'通勤路上的音乐电台与有声故事。',icon:dino(9),categoryIds:['music','audio'],exclude:['paperboat:voice-notes']}),
  dist({id:'mini',key:'mini-theatre',title:'口袋剧场',description:'手动挑选两部短剧，保留历史发布，当前已停用。',icon:dino(17),enabled:false,mode:'manual',order:'source',include:['firefly:station-five','firefly:sunset-shop']}),
  dist({id:'lab-draft',key:'lab-notes',title:'实验台 · 草稿',description:'验证本地模块的预览效果，尚未发布。',icon:dino(21),enabled:false,mode:'manual',include:['desk:demo-prototype']})
);
state.distributions.slice(0,3).forEach((d,i)=>publish(d,true,32+i*16));
state.logs=[
  [13,'检查「潮汐电台」：4 个模块，托管文件均为最新'],
  [26,'检查「纸舟有声馆」：4 个模块，无变更'],
  [32,'发布「周末放映计划」：4 个模块'],
  [48,'发布「通勤声景」：7 个模块'],
  [64,'发布「口袋剧场」：2 个模块'],
  [74,'检查「极光放映室」：发现 1 个待审核模块'],
  [105,'导入「桌面草稿箱」：3 个本地模块'],
  [138,'检查「萤火短剧社」：3 个模块，无变更']
].map(([minutes,message])=>({time:stamp(minutes),message}));
const sourceFields=['paused','categoryId','newCategoryId','newPolicy','delivery','refreshMinutes'];
const moduleFields=['paused','disabled','categoryId','delivery','refreshMinutes'];
const canCheck=s=>!s.paused&&(s.url||s.modules.some(m=>useMirror(s,m)&&!m.paused&&!m.pending));
function check(s,id) {
  const module=id?get(s.modules,id,'模块'):null;
  if(!canCheck(s)||module&&(module.paused||module.pending||!useMirror(s,module))) return false;
  s.checkedAt=stamp();s.status='正常';
  for(const m of module?[module]:s.modules) if(useMirror(s,m)&&!m.pending&&!m.paused&&!m.removed) refreshMirror(m);
  log(module?`检查托管「${module.title}」：文件已就绪`:`检查「${s.label}」：${s.modules.length} 个模块，已完成演示同步`);
  return true;
}
function removeSources(ids) {
  const deleted=state.sources.filter(s=>ids.includes(s.id)).length;
  state.sources=state.sources.filter(s=>!ids.includes(s.id));
  republish(true);log(`已删除 ${deleted} 个来源并更新分发`);
  return {ok:true,deleted};
}
function importSource(a) {
  const old=a.replaceId?get(state.sources,a.replaceId,'来源'):null;
  const url=a.url?httpsURL(a.url):null;
  const files=Array.isArray(a.files)?a.files.slice(0,20):[];
  if(!url&&!files.length) problem('请输入来源 URL 或选择文件。');
  const id=old?.id||nextId('source');
  const label=old?.label||(url?`${url.hostname} · 演示导入`:text(files[0]?.name)||'本地导入');
  const s={...state.settings,...old,id,label,author:'演示导入',kind:url?'manifest':'upload-modules',url:url?`https://${url.hostname}/demo.rex`:'',icon:dino(24),status:'正常',checkedAt:url?stamp():'',categoryId:a.categoryId||old?.categoryId||'',delivery:a.delivery||old?.delivery||state.settings.defaultDelivery,refreshMinutes:a.refreshMinutes||old?.refreshMinutes||state.settings.defaultRefreshMinutes,newPolicy:old?.newPolicy||state.settings.defaultNewPolicy};
  const meta=a.metadata||{};
  s.modules=(url?[{name:'远程模块样例'}]:files).map((file,i)=>{
    const suppliedId=text(meta.id,64);
    const m={id:i===0&&/^[\w.-]+$/.test(suppliedId)?suppliedId:`${id}-module-${i+1}`,title:text(meta.title)||text(file?.name).replace(/\.(rex\.js|js|rex)$/i,'')||'本地模块',author:text(meta.author)||s.author,version:text(meta.version)||'1.0.0',requiredVersion:text(meta.requiredVersion)||'0.1.0',local:!url,url:url?`https://modules.example/${id}-${i+1}.js`:asset(`files/${id}-${i+1}.js`),icon:localIcon(meta.icon)||s.icon,delivery:'inherit',categoryId:'',autoCategoryFallbackId:s.newCategoryId||'',refreshMinutes:0,...(types.includes(meta.contentType)?{contentType:meta.contentType}:{}),...(typeof meta.continuousPlay==='boolean'?{continuousPlay:meta.continuousPlay}:{})};
    if(useMirror(s,m)) refreshMirror(m);
    return m;
  });
  if(old) state.sources[state.sources.indexOf(old)]=s;
  else state.sources.push(s);
  republish(Boolean(old));log(`${old?'替换':'导入'}「${label}」：${s.modules.length} 个演示模块`);
  return {ok:true,source:{id}};
}
const badges={activeId:'field-notes',items:[]};
const badgeContents=new Map();
function badgesFor(groups,rows) {
  return {groups:groups.map(([id,name])=>({id,name})),items:rows.map(([groupId,name,n,tagColor])=>({groupId,name,imageURL:dino(n),tagColor,textColor:'#252439',borderColor:'#8275a4'}))};
}
function addBadge(id,alias,mode,url,contents,status='ready') {
  const assets=mode==='host'?contents.items.length:0;
  const badge={id,alias,mode,url,status,groups:contents.groups.length,filters:contents.items.length,assets,done:status==='ready'?assets:0,failed:0,error:''};
  badgeContents.set(id,contents);badges.items.push(badge);
  return badge;
}
const fieldNotes=badgesFor([['travel','旅途'],['moments','日常'],['night','星夜']],[
  ['travel','出发',1,'#e0ede7'],['travel','山野漫步',2,'#deedcc'],['travel','岛屿邮差',3,'#c7ebf1'],['travel','山间车站',4,'#f3dde9'],
  ['moments','今日精选',5,'#fff0bf'],['moments','午后放映',6,'#eadff6'],['moments','一封来信',7,'#ffdfcc'],['moments','书店寻宝',8,'#eadcbc'],
  ['night','银河旅人',9,'#d9deff'],['night','流星时刻',10,'#efddf4'],['night','守夜人',11,'#cfe8f5'],['night','月光慢行',12,'#ebe2ff']
]);
const studioStamps=badgesFor([['screen','银幕'],['sound','声场']],[
  ['screen','首映之夜',13,'#ffd9d8'],['screen','独立影展',14,'#e1d9fa'],['screen','幕后花絮',15,'#f8ebcd'],
  ['sound','无损声场',16,'#d6efe5'],['sound','电波回声',17,'#cfeaff'],['sound','午夜唱片',18,'#edddf8']
]);
const tinyExtras=badgesFor([['extras','特别收录']],[['extras','备用信标',19,'#d9e8ff'],['extras','周末限定',20,'#e2ecda'],['extras','旅行纪念',21,'#fff2bc']]);
addBadge('field-notes','旷野手帐','host','https://field-notes.example/badges.json',fieldNotes);
addBadge('studio-stamps','留声与银幕','link','https://studio-stamps.example/pack.json',studioStamps);
Object.assign(addBadge('tiny-extras','备用纪念章','host','https://tiny-extras.example/pack.json',tinyExtras,'error'),{error:'示例：图片处理未完成，可点击重试。',failed:1});
function badgePreview(params) {
  const id=params.get('id');get(badges.items,id,'徽章包');
  const {groups,items}=badgeContents.get(id), group=params.get('group'), q=text(params.get('q'),200).toLowerCase();
  const filtered=items.filter(item=>(!group||item.groupId===group)&&(!q||item.name.toLowerCase().includes(q)));
  const pageSize=8, page=Math.min(Math.max(1,Math.floor(Number(params.get('page')))||1),Math.max(1,Math.ceil(filtered.length/pageSize)));
  return {groups,items:filtered.slice((page-1)*pageSize,page*pageSize),total:filtered.length,page,pageSize};
}
function importBadges(a) {
  const url=a.url?httpsURL(a.url):null;
  const id=nextId('badges'), mode=!url||a.mode==='host'?'host':'link';
  let contents=studioStamps;
  if(!url) {
    let data;try { data=JSON.parse(a.text); } catch { problem('无法读取徽章 JSON。',422); }
    if(!Array.isArray(data?.groups)||!Array.isArray(data?.filters)) problem('徽章包必须包含 groups 和 filters 数组。',422);
    contents={groups:data.groups.filter(g=>g&&typeof g.id==='string').slice(0,100).map(g=>({id:text(g.id,160),name:text(g.name)||g.id})),items:data.filters.filter(f=>f&&typeof f.name==='string').slice(0,500).map((f,i)=>({name:text(f.name),groupId:text(f.groupId,160),imageURL:dino(i%24+1),...pick(f,['tagColor','textColor','borderColor'])}))};
  }
  const badge=addBadge(id,text(a.alias)||text(a.filename)||url?.hostname||'演示徽章',mode,url?`${url.origin}${url.pathname}`:'',contents,mode==='host'?'queued':'ready');
  return {ok:true,id:badge.id};
}
function badgeAction(path,a) {
  if(path==='badges/import') return importBadges(a);
  if(path==='badges/active'&&!a.id){badges.activeId='';return {ok:true};}
  if(!['badges/active','badges/process','badges/update'].includes(path)) return problem('演示接口不存在。',404);
  const item=get(badges.items,a.id,'徽章包');
  if(path==='badges/active') {
    if(item.status!=='ready') problem('徽章包尚未就绪。',409);
    badges.activeId=item.id;
  } else if(path==='badges/process') {
    Object.assign(item,{status:'ready',done:item.assets,failed:0,error:''});
  } else if(a.delete) {
    badges.items=badges.items.filter(x=>x!==item);badgeContents.delete(item.id);
    if(badges.activeId===item.id) badges.activeId='';
  } else {
    if(text(a.alias)) item.alias=text(a.alias);
    if(a.retry||item.url&&['host','link'].includes(a.mode)&&a.mode!==item.mode) {
      if(item.url&&a.mode) item.mode=a.mode;
      Object.assign(item,{status:item.mode==='host'?'queued':'ready',assets:item.mode==='host'?item.filters:0,done:0,failed:0,error:''});
      if(item.status!=='ready'&&badges.activeId===item.id) badges.activeId='';
    }
  }
  return {ok:true};
}
function updateCategory(a) {
  const c=a.id?get(state.categories,a.id,'分类'):null;
  if(a.delete) {
    if(!c) problem('请选择分类。');
    state.categories=state.categories.filter(x=>x!==c);
    for(const s of state.sources) {
      if(s.categoryId===c.id) s.categoryId='';if(s.newCategoryId===c.id) s.newCategoryId='';
      for(const m of s.modules) {if(m.categoryId===c.id) m.categoryId='';if(m.autoCategoryFallbackId===c.id) m.autoCategoryFallbackId='';}
    }
  } else {
    const name=text(a.name,60)||c?.name;
    if(!name) problem('请填写分类名称。');
    if(state.categories.some(x=>x!==c&&x.name===name)) problem('已有同名分类。',409);
    const autoRule=a.autoRule?rule(a.autoRule):c?.autoRule||rule();
    if(c) Object.assign(c,{name,autoRule});
    else state.categories.push({id:nextId('category'),name,autoRule});
  }
  republish(true);return {ok:true};
}
function updateDistribution(a) {
  const old=a.id?get(state.distributions,a.id,'分发'):null;
  if(a.delete) {
    if(!old) problem('请选择分发。');
    state.distributions=state.distributions.filter(x=>x!==old);
    return {ok:true};
  }
  const id=old?.id||nextId('distribution'), key=text(a.key,64)||old?.key||id;
  if(!/^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/.test(key)) problem('地址标识只能包含英文字母、数字、- 和 _，且以字母或数字开头。',422);
  if(state.distributions.some(x=>x!==old&&x.key===key)) problem('这个地址标识已被使用。',409);
  const title=text(a.title,100);if(!title) problem('请填写分发标题。');
  const d=dist({...old,id,key,title,description:text(a.description,500),icon:localIcon(a.icon),enabled:a.enabled===true,mode:a.mode==='manual'?'manual':'rules',order:a.order==='source'?'source':'title',...Object.fromEntries(['categoryIds','sourceIds','include','exclude'].map(k=>[k,strings(a[k])]))});
  if(a.publish) {const result=publish(d,a.confirmEmpty===true);log(`发布「${d.title}」：${result.count} 个模块`);}
  if(old) state.distributions[state.distributions.indexOf(old)]=d;
  else state.distributions.push(d);
  return {ok:true,id,key,published:a.publish===true};
}
function dispatch(path,method,params,a) {
  if(method==='GET') {
    if(path==='bootstrap') return {initialized:true,authenticated:true,state:snapshot()};
    if(path==='session') return {initialized:true,authenticated:true};
    if(path==='state') return snapshot();
    if(path==='preview') return preview(get(state.distributions,params.get('id'),'分发'));
    if(path==='badges') return badges;
    if(path==='badges/preview') return badgePreview(params);
  } else if(method==='POST') {
    switch(path) {
      case 'login': case 'setup': case 'password': case 'logout':
        return problem('公开演示无需登录，不支持密码或会话操作。',403);
      case 'icon': return {ok:true,url:dino(24)};
      case 'settings':
        Object.assign(state.settings,pick(a,['defaultRefreshMinutes','defaultDelivery','defaultNewPolicy']));
        if(Object.hasOwn(a,'defaultIcon')) state.settings.defaultIcon=localIcon(a.defaultIcon);
        return {ok:true};
      case 'source': return importSource(a);
      case 'source/update': {
        const s=get(state.sources,a.id,'来源');
        if(a.delete) return removeSources([s.id]);
        Object.assign(s,pick(a,sourceFields));republish(Object.hasOwn(a,'categoryId'));return {ok:true};
      }
      case 'source/batch': {
        const ids=strings(a.ids);
        if(a.action==='delete') return removeSources(ids);
        if(a.action!=='check') return problem('未知批量操作。');
        const checked=state.sources.filter(s=>ids.includes(s.id)&&check(s)).length;
        republish();return {ok:true,checked,failed:0,queued:0,skipped:ids.length-checked};
      }
      case 'sync': {
        const due=a.id?[get(state.sources,a.id,'来源')]:state.sources.filter(s=>canCheck(s)&&(!s.checkedAt||Date.now()-Date.parse(s.checkedAt)>=(s.refreshMinutes||30)*60000));
        const checked=due.filter(s=>check(s,a.moduleId)).length;
        if(!checked) log('检查到期来源：当前没有需要检查的来源');
        republish();return {ok:true,checked};
      }
      case 'module/update': {
        const s=get(state.sources,a.sourceId,'来源'), m=get(s.modules,a.id,'模块');
        Object.assign(m,pick(a,moduleFields));
        if(a.approve){m.pending=false;log(`审核通过「${m.title}」`);}
        if(m.removed&&!m.paused) s.modules=s.modules.filter(x=>x!==m);
        republish(Object.hasOwn(a,'categoryId'));return {ok:true};
      }
      case 'module/batch-category': {
        if(!Array.isArray(a.modules)||!a.modules.length) return problem('请选择模块。');
        const modules=new Set(a.modules.map(({sourceId,id})=>get(get(state.sources,sourceId,'来源').modules,id,'模块')));
        for(const m of modules) m.categoryId=text(a.categoryId);
        republish(true);log(`已批量调整 ${modules.size} 个模块的分类`);
        return {ok:true,count:modules.size};
      }
      case 'category': return updateCategory(a);
      case 'distribution': return updateDistribution(a);
      case 'publish': {
        const d=get(state.distributions,a.id,'分发'), result=publish(d,a.confirmEmpty===true);
        log(`发布「${d.title}」：${result.count} 个模块`);
        return result;
      }
      case 'badges/active': case 'badges/process': case 'badges/update': case 'badges/import': return badgeAction(path,a);
    }
  }
  return problem('演示接口不存在。',404);
}
const fetchOriginal=window.fetch.bind(window);
const json=(data,status=200)=>new Response(JSON.stringify(data),{status,headers:{'Content-Type':'application/json; charset=utf-8','Cache-Control':'no-store'}});
const demoAPI=new URL('./api/',document.baseURI).pathname;
window.fetch=async function(input,init) {
  const request=input instanceof Request?input:null;
  const url=new URL(request?.url??String(input),document.baseURI);
  const prefix=url.pathname.startsWith('/api/')?'/api/':url.pathname.startsWith(demoAPI)?demoAPI:'';
  if(!prefix) return fetchOriginal(input,init);
  const path=url.pathname.slice(prefix.length), method=String(init?.method??request?.method??'GET').toUpperCase();
  try {
    let a={};
    if(method==='POST'&&!['icon','login','setup','password','logout'].includes(path)) {
      try {
        const body=init?.body??(request?await request.clone().text():'');
        a=body?JSON.parse(body):{};
        if(!a||typeof a!=='object'||Array.isArray(a)) throw Error();
      } catch { return json({error:'请求数据不是 JSON 对象。'},400); }
    }
    return json(dispatch(path,method,url.searchParams,a));
  } catch(e) { return json({error:e.status?e.message:'演示操作失败。',...(e.code?{code:e.code}:{})},e.status||500); }
};
const root=document.getElementById('app');
if(root) {
  const hidePassword=()=>{const section=root.querySelector('form[data-form="password"]')?.closest('section');if(section) section.hidden=true;};
  new MutationObserver(hidePassword).observe(root,{childList:true,subtree:true});
  hidePassword();
}
})();

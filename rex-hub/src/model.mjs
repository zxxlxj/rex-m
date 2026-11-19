export const MAX_SOURCES = 20, MAX_ITEMS = 160, MAX_DISTS = 20;
export class Problem extends Error { constructor(status,message){super(message);this.status=status;} }
export function fail(status,message){throw new Problem(status,message);}
export function randomKey(){return Array.from(crypto.getRandomValues(new Uint8Array(18)),x=>x.toString(16).padStart(2,'0')).join('');}
export const keyOK = x => typeof x==='string' && /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/.test(x);
export const ref = (s,m) => `${s.id}:${m.id}`;
export function deliveryMode(s,m,fallback='link'){return m.delivery==='mirror'||m.delivery==='link'?m.delivery:(s.delivery||fallback);}
export const intervals=[5,15,30,60,180,360,720,1440];
export function applyNewPolicy(source,modules){
  const previous=new Map(source.modules.map(m=>[m.id,m]));
  return modules.map(m=>{
    const old=previous.get(m.id);
    if(old)return {...m,pending:!!old.pending,categoryId:old.categoryId||'',delivery:old.delivery,refreshMinutes:old.refreshMinutes,mirror:old.mirror};
    return {...m,pending:source.newPolicy!=='auto',categoryId:m.categoryId||source.newCategoryId||''};
  });
}
const has=(xs,x)=>xs.includes(x);
export function build(state,d,origin){
  const icon=d.icon||`${origin}/rex-mark.png`;
  const selected=new Map(); const conflicts=[]; const unresolved=new Set();
  for(const s of state.sources) for(const m of s.modules){
    const r=ref(s,m);
    if(m.disabled||m.pending||has(d.exclude,r)||!(has(d.include,r)||(d.mode==='rules'&&(has(d.sourceIds,s.id)||has(d.categoryIds,m.categoryId||s.categoryId))))) continue;
    const explicit=has(d.include,r), other=selected.get(m.id);
    if(!other){selected.set(m.id,{m,s,r,explicit});continue;}
    conflicts.push({id:m.id,first:other.r,second:r,sources:[other.s.label,s.label],resolved:explicit!==other.explicit});
    if(explicit===other.explicit) unresolved.add(m.id);
    if(explicit&&!other.explicit){selected.set(m.id,{m,s,r,explicit});unresolved.delete(m.id);}
  }
  let items=Array.from(selected.values());
  if(d.order==='title')items.sort((a,b)=>a.m.title.localeCompare(b.m.title,'zh-CN')||a.r.localeCompare(b.r));
  const missingMirrors=[], files=Object.create(null), refs=Object.create(null);
  const widgets=items.map(({m,s})=>{
    const mirror=deliveryMode(s,m,state.settings?.defaultDelivery)==='mirror' && !m.url.startsWith(`${origin}/files/`) && !m.url.startsWith(`${origin}/m/`);
    const file=mirror?m.mirror:null;
    if(mirror&&!file?.url)missingMirrors.push({id:m.id,title:m.title,source:s.label});
    if(file?.url)files[m.id]=file.url;
    refs[m.id]=ref(s,m);
    return {id:m.id,title:m.title,description:m.description||'',requiredVersion:file?.requiredVersion||m.requiredVersion,version:file?.version||m.version,author:m.author||'',icon:m.icon||'',url:mirror?(file?.url?`${origin}/m/${encodeURIComponent(d.key)}/${encodeURIComponent(m.id)}.js`:''):m.url};
  });
  return {manifest:{name:d.title,title:d.title,description:d.description||'',icon,logo:icon,widgets},files,refs,missingMirrors,conflicts,blocked:[...unresolved]};
}
export function blockedRemoval(old,next){
  if(!old?.widgets?.length)return false;
  const keys=new Set(next.widgets.map(m=>m.id));
  const gone=old.widgets.filter(m=>!keys.has(m.id)).length;
  return gone===old.widgets.length || (gone>=3 && gone*2>=old.widgets.length);
}
export function appendLog(st,message){st.logs.unshift({time:new Date().toISOString(),message});st.logs.length=Math.min(st.logs.length,200);}
export function publishedConfig(d){const {published,publishedAt,active,publishedFiles,publishedRefs,publishWarning,...config}=d;return structuredClone(config);}
export function recordPublish(d,next){
  d.published=next.manifest;d.publishedFiles=next.files;d.publishedRefs=next.refs;d.publishedAt=new Date().toISOString();d.publishWarning='';
}
export function republish(st,origin,{allowRemoval=false}={}){
  for(const d of st.distributions){
    if(!d.enabled||!d.active)continue;
    const next=build(st,d.active,origin);
    if(next.blocked.length || next.missingMirrors.length || (!allowRemoval&&blockedRemoval(d.published,next.manifest))){
      const reason=next.blocked.length?'模块 ID 冲突':next.missingMirrors.length?'等待托管模块首次下载':'异常批量移除';
      if(d.publishWarning!==reason)appendLog(st,`「${d.active.title}」暂停自动发布：${reason}`);
      d.publishWarning=reason;continue;
    }
    d.publishWarning='';
    if(JSON.stringify(d.published)!==JSON.stringify(next.manifest)||JSON.stringify(d.publishedFiles||{})!==JSON.stringify(next.files)||JSON.stringify(d.publishedRefs||{})!==JSON.stringify(next.refs)){
      recordPublish(d,next);
      appendLog(st,`自动更新「${d.active.title}」：${next.manifest.widgets.length} 个模块`);
    }
  }
}

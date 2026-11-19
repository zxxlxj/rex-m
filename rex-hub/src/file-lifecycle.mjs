const FILE = /^\/files\/[a-f0-9]{64}\.js$/;
const raw = url => {try {const p=new URL(url).pathname; return FILE.test(p)?p:'';}catch{return '';}};
export function ownedFile(url,origin){try{return new URL(url).origin===origin?raw(url):'';}catch{return '';}}
export function sourceFiles(s,origin){
  const out=new Set((s.fileHistory||[]).filter(p=>FILE.test(p)));
  for(const m of s.modules){for(const u of [m.url,m.mirror?.url]){const f=ownedFile(u,origin);if(f)out.add(f);}}
  return out;
}
export function markFiles(s,origin,previous){
  s.fileHistory=[...new Set([...sourceFiles(s,origin),...(previous?sourceFiles(previous,origin):[])])].slice(-5000);
  return s;
}
export function removeSource(st,s,origin){
  const files=sourceFiles(s,origin), ids=new Set(s.modules.map(m=>m.id));
  st.sources=st.sources.filter(x=>x!==s);
  const others=new Map();
  for(const x of st.sources)for(const m of x.modules){const a=others.get(m.id)||new Set();for(const u of [m.url,m.mirror?.url])if(u)a.add(u);others.set(m.id,a);}
  for(const d of st.distributions){
    const rs=d.publishedRefs||{};
    if(!d.published?.widgets)continue;
    const keep=d.published.widgets.filter(w=>{
      if(Object.hasOwn(rs,w.id))return !rs[w.id].startsWith(s.id+':');
      const u=Object.hasOwn(d.publishedFiles||{},w.id)?d.publishedFiles[w.id]:w.url;
      const path=ownedFile(u,origin);
      const matched=(path&&files.has(path))||s.modules.some(m=>m.id===w.id&&m.url===u);
      return !(ids.has(w.id)&&matched&&!others.get(w.id)?.has(u));
    });
    if(keep.length!==d.published.widgets.length){
      const ids=new Set(keep.map(x=>x.id));d.published={...d.published,widgets:keep};
      for(const key of ['publishedFiles','publishedRefs'])d[key]=Object.fromEntries(Object.entries(d[key]||{}).filter(([id])=>ids.has(id)));
      d.publishedAt=new Date().toISOString();
    }
  }
  const candidates=[...(st.fileDeletes||[]),...files];
  const shared=new Set(st.sources.flatMap(x=>[...sourceFiles(x,origin)]));
  st.fileDeletes=[...new Set(candidates)].filter(f=>!shared.has(f));
}
export function removableFiles(st,origin,limit=10){
  const live=new Set();
  for(const s of st.sources)for(const p of sourceFiles(s,origin))live.add(p);
  for(const d of st.distributions){for(const u of [...Object.values(d.publishedFiles||{}),...(d.published?.widgets||[]).map(w=>w.url)]){const p=ownedFile(u,origin);if(p)live.add(p);}}
  return (st.fileDeletes||[]).filter(x=>FILE.test(x)&&!live.has(x)).slice(0,limit);
}

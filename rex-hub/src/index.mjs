import { session, setup, login, logout, changePassword } from './auth.mjs';
import { ingest, refresh } from './sources.mjs';
import { mirrorSource, mirrorDue } from './mirror.mjs';
import { MAX_SOURCES, MAX_ITEMS, MAX_DISTS, fail, randomKey, keyOK, build, blockedRemoval, appendLog, publishedConfig, republish, applyNewPolicy, intervals, recordPublish } from './model.mjs';

const JSON_HEADERS={'Content-Type':'application/json; charset=utf-8','Cache-Control':'no-store','X-Content-Type-Options':'nosniff'};
const json=(data,status=200)=>new Response(JSON.stringify(data),{status,headers:JSON_HEADERS});
const empty=()=>({sources:[],categories:[],distributions:[],logs:[],origin:'',settings:{defaultRefreshMinutes:30,defaultDelivery:'link',defaultIcon:'',defaultNewPolicy:'review'}});
const uid=()=>crypto.randomUUID();
async function get(env){const row=await env.DB.prepare('SELECT revision,document FROM hub_state WHERE id=1').first();if(!row)throw new Error('Missing migrations');return {revision:row.revision,st:{...empty(),...JSON.parse(row.document)}};}
async function change(env,fn){
  for(let i=0;i<5;i++){
    const {revision,st}=await get(env), result=fn(st);
    const doc=JSON.stringify(st);if(new TextEncoder().encode(doc).length>1_500_000)fail(413,'管理数据超过容量限制，请减少来源或合集');
    const r=await env.DB.prepare('UPDATE hub_state SET document=?,revision=revision+1 WHERE id=1 AND revision=?').bind(doc,revision).run();
    if(r.meta.changes===1)return result;
  }
  fail(409,'后台状态正在更新，请重试');
}
function text(x,max,label,required=false){if(x==null)x='';if(typeof x!=='string'||x.length>max||(required&&!x.trim())||/[\x00-\x08\x0b\x0c\x0e-\x1f]/.test(x))fail(400,`${label}格式无效`);return x.trim();}
function by(rows,id,label){const found=rows.find(r=>r.id===id);if(!found)fail(404,`${label}不存在`);return found;}
function category(st,id){return id?by(st.categories,id,'分类').id:'';}
function list(x,max=500){if(x==null)return [];if(!Array.isArray(x)||x.length>max||x.some(v=>typeof v!=='string'||v.length>300))fail(400,'选择项格式无效');return [...new Set(x)];}
const originFor=(env,st,origin)=>env.PUBLIC_ORIGIN?.replace(/\/$/,'')||st.origin||origin;
function validIcon(s,origin){if(!s)return '';let u;try{u=new URL(s,origin);}catch{fail(400,'图标 URL 不合法');}if(!['https:'].includes(u.protocol)&&u.origin!==origin||u.username||u.password||u.hash)fail(400,'图标需使用 HTTPS');if(u.origin===origin&&!/^\/(rex-mark\.png|icons\/[a-f0-9]{64}\.(png|jpg|gif|webp))$/.test(u.pathname))fail(400,'站内图标 URL 不合法');return u.href;}
async function read(req,cap){
  if(Number(req.headers.get('Content-Length'))>cap)fail(413,'请求内容过大');
  if(!req.body)return new Uint8Array();
  const reader=req.body.getReader();let n=0;const parts=[];
  for(;;){const {done,value}=await reader.read();if(done)break;n+=value.length;if(n>cap){await reader.cancel();fail(413,'请求内容过大');}parts.push(value);}
  const result=new Uint8Array(n);let i=0;for(const part of parts){result.set(part,i);i+=part.length;}return result;
}
async function input(req,cap=256_000){
  if(!req.headers.get('Content-Type')?.toLowerCase().startsWith('application/json'))fail(415,'需要 JSON 请求');
  const data=await read(req,cap);let value;try{value=JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(data));}catch{fail(400,'无法读取 JSON');}
  if(!value||typeof value!=='object'||Array.isArray(value))fail(400,'需要 JSON 对象');return value;
}
async function uploadIcon(req,env,origin){
  const bytes=await read(req,2_000_000);const b=i=>bytes[i]; const magic=(i,s)=>Array.from(s).every((x,n)=>x.charCodeAt(0)===b(i+n));
  const ext=bytes.length>24 && (magic(0,'\x89PNG\r\n\x1a\n')?'png':b(0)===255&&b(1)===216&&b(2)===255?'jpg':magic(0,'GIF87a')||magic(0,'GIF89a')?'gif':magic(0,'RIFF')&&magic(8,'WEBP')?'webp':'');
  if(!ext)fail(415,'只接受 PNG、JPEG、WebP、GIF 图标');
  const h=Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',bytes)),x=>x.toString(16).padStart(2,'0')).join('');
  const key=`icons/${h}.${ext}`;await env.FILES.put(key,bytes);return json({url:`${origin}/${key}`});
}
async function publicFile(req,env,path){
  const icon=/^\/icons\/[a-f0-9]{64}\.(png|jpg|gif|webp)$/.exec(path);
  if(!icon&&!/^\/files\/[a-f0-9]{64}\.js$/.test(path))return new Response('Not found',{status:404});
  const key=path.slice(1);
  let result=req.method==='HEAD'?await env.FILES.head(key):await env.FILES.get(key);
  if(!result&&!icon)result=req.method==='HEAD'?await env.FILES.head(key.split('/')[1]):await env.FILES.get(key.split('/')[1]);
  if(!result)return new Response('Not found',{status:404,headers:{'Cache-Control':'no-store'}});
  const h={'Content-Type':icon?`image/${icon[1]==='jpg'?'jpeg':icon[1]}`:'text/plain; charset=utf-8','Content-Length':String(result.size),'Cache-Control':'public, max-age=86400, immutable','ETag':result.httpEtag,'X-Content-Type-Options':'nosniff','Content-Security-Policy':"default-src 'none'; sandbox"};
  if(!icon)h['Content-Disposition']='attachment; filename="module.rex.js"';
  return new Response(req.method==='HEAD'?null:result.body,{headers:h});
}
async function publicDistribution(req,env,path){
  const match=/^\/s\/([A-Za-z0-9][A-Za-z0-9_-]{0,63})\.rex$/.exec(path);
  const {st}=match?await get(env):{st:empty()};const d=st.distributions.find(x=>x.key===match?.[1]&&x.enabled&&x.published);
  if(!d)return new Response('Not found',{status:404,headers:{'Cache-Control':'no-store'}});
  const header={'Content-Type':'text/plain; charset=utf-8','Cache-Control':'private, no-cache','X-Content-Type-Options':'nosniff','Content-Security-Policy':"default-src 'none'; sandbox",'X-Robots-Tag':'noindex, nofollow','Referrer-Policy':'no-referrer'};
  return new Response(req.method==='HEAD'?null:JSON.stringify(d.published,null,2),{headers:header});
}
function logLabel(s){return String(s.label||'来源').slice(0,120);}
async function sync(env,requested,requestOrigin,moduleId){
  const lock=uid(), now=Date.now();
  const acquired=await env.DB.prepare('UPDATE hub_guard SET token=?,expires=? WHERE id=1 AND expires<=?').bind(lock,now+95_000,now).run();
  if(!acquired.meta.changes)fail(409,'已有同步任务在运行');
  try{
    const {st}=await get(env);const origin=originFor(env,st,requestOrigin);
    if(requested){const s=by(st.sources,requested,'来源');if(moduleId)by(s.modules,moduleId,'模块');}
    const collectionDue=s=>s.url?(Date.parse(s.checkedAt)||0)+(s.refreshMinutes||30)*60_000:Infinity;
    const due=s=>Math.min(collectionDue(s),mirrorDue(s,now,origin));
    const eligible=st.sources.filter(s=>!s.paused).map(s=>({...s,delivery:s.delivery??st.settings.defaultDelivery,refreshMinutes:s.refreshMinutes??st.settings.defaultRefreshMinutes,newPolicy:s.newPolicy??st.settings.defaultNewPolicy}));
    const candidates=requested?eligible.filter(s=>s.id===requested):eligible.filter(s=>due(s)<=now).sort((a,b)=>due(a)-due(b)).slice(0,2);
    const results=await Promise.all(candidates.map(async s=>{
      let next=s, error='';
      if(s.url&&!moduleId&&(requested||collectionDue(s)<=now)){
        try{const refreshed=await refresh(s,env,origin);next={...refreshed,modules:applyNewPolicy(s,refreshed.modules)};}
        catch(e){error=e.status&&e.status<500?e.message:'拉取失败，已保留上次有效结果';next={...s,status:error,checkedAt:new Date().toISOString()};}
      }
      if(origin&&(requested||mirrorDue(next,now)<=now))next=await mirrorSource(next,env,origin,{force:!!requested,moduleId});
      return {s,next,error};
    }));
    if(!results.length&&!requested)return {ok:true,checked:0,failed:0};
    return await change(env,current=>{
      for(const {s,next,error} of results){
        const index=current.sources.findIndex(x=>x.id===s.id);
        if(index<0||current.sources[index].paused||current.sources[index].edit!==s.edit)continue;
        if(next.modules.length>MAX_ITEMS)continue;
        const known=new Set(s.modules.map(m=>m.id));
        const added=next.modules.filter(m=>!known.has(m.id));
        if(error)appendLog(current,`「${logLabel(s)}」同步失败：${error}`);
        if(added.length)appendLog(current,`「${logLabel(s)}」新增 ${added.length} 个模块：${added.filter(m=>m.pending).length} 个待审核`);
        current.sources[index]=next;
      }
      if(origin)republish(current,origin);
      return {ok:true,checked:results.length,failed:results.filter(r=>r.error).length};
    });
  }finally{await env.DB.prepare('UPDATE hub_guard SET token=NULL,expires=0 WHERE id=1 AND token=?').bind(lock).run();}
}
function sourceOptions(target,a,module=false){
  if('delivery' in a){if(!(module?['inherit','link','mirror']:['link','mirror']).includes(a.delivery))fail(400,'分发方式无效');target.delivery=a.delivery;}
  if('refreshMinutes' in a){if(!intervals.includes(a.refreshMinutes)&&!(module&&a.refreshMinutes===0))fail(400,'刷新频率无效');target.refreshMinutes=a.refreshMinutes;}
}
function publish(st,d,origin,confirmed){
  const next=build(st,d,origin);
  if(next.blocked.length)fail(409,'请先解决同名模块冲突，再发布');
  if(next.missingMirrors.length)fail(409,`等待 ${next.missingMirrors.length} 个托管模块首次下载，请先检查来源或存为草稿`);
  if((!next.manifest.widgets.length||blockedRemoval(d.published,next.manifest))&&confirmed!==true){
    const e=new Error('集合为空或检测到大量移除，请确认后再发布');e.status=409;e.code='confirm_publish';throw e;
  }
  d.active=publishedConfig(d);recordPublish(d,next);
  appendLog(st,`发布「${d.title}」：${next.manifest.widgets.length} 个模块`);
  return {ok:true,count:next.manifest.widgets.length};
}
async function admin(req,env,url){
  const path=url.pathname, origin=url.origin;
  if(req.method==='POST'&&req.headers.get('Origin')!==origin)fail(403,'请求来源不匹配');
  if(path==='/api/session'&&req.method==='GET')return json(await session(req,env));
  if(req.method==='POST'&&path==='/api/setup')return setup(req,env,await input(req,16384));
  if(req.method==='POST'&&path==='/api/login')return login(req,env,await input(req,16384));
  if(req.method==='POST'&&path==='/api/logout')return logout(req,env,await input(req,16384));
  if(!(await session(req,env)).authenticated)fail(401,'请先登录');
  if(req.method==='GET'&&path==='/api/state')return json((await get(env)).st);
  if(req.method==='GET'&&path==='/api/preview'){
    const {st}=await get(env);const d=by(st.distributions,url.searchParams.get('id'),'分发');
    const next=build(st,d,originFor(env,st,origin));
    return json({...next,needsConfirmation:blockedRemoval(d.published,next.manifest)});
  }
  if(req.method!=='POST')fail(404,'接口不存在');
  if(path==='/api/icon')return uploadIcon(req,env,originFor(env,(await get(env)).st,origin));
  const a=await input(req,path==='/api/source'?5_800_000:256_000);
  if(path==='/api/password')return changePassword(req,env,a);
  if(path==='/api/settings')return json(await change(env,st=>{
    st.origin ||= origin;
    if(!intervals.includes(a.defaultRefreshMinutes)||!['link','mirror'].includes(a.defaultDelivery)||!['review','auto'].includes(a.defaultNewPolicy))fail(400,'默认设置无效');
    st.settings={defaultRefreshMinutes:a.defaultRefreshMinutes,defaultDelivery:a.defaultDelivery,defaultNewPolicy:a.defaultNewPolicy,defaultIcon:validIcon(text(a.defaultIcon,1200,'默认图标'),originFor(env,st,origin))};
    for(const s of st.sources)s.edit=uid();
    return {ok:true};
  }));
  if(path==='/api/sync')return json(await sync(env,a.id,origin,a.moduleId));
  if(path==='/api/source'){
    const {st}=await get(env);if(st.sources.length>=MAX_SOURCES&&!a.replaceId)fail(409,'已达到来源上限');
    category(st,a.categoryId);
    if(a.replaceId)by(st.sources,a.replaceId,'来源');
    let source=await ingest(a,env,originFor(env,st,origin));
    if(source.url||source.kind==='upload-index'){
      sourceOptions(source,{delivery:st.settings.defaultDelivery,refreshMinutes:st.settings.defaultRefreshMinutes,...a});
      source.newPolicy=st.settings.defaultNewPolicy;
    }
    if(source.modules.length>MAX_ITEMS)fail(409,'模块超过单个来源上限');
    if(a.replaceId){const old=by(st.sources,a.replaceId,'来源');if(old.url||source.url)fail(422,'替换上传仅用于本地文件来源');}
    else if(source.delivery==='mirror')source=await mirrorSource(source,env,originFor(env,st,origin),{force:true});
    return json(await change(env,current=>{
      current.origin ||= origin;
      category(current,source.categoryId);
      if(a.replaceId){
        const old=by(current.sources,a.replaceId,'来源');
        if(old.url || source.url)fail(422,'替换上传仅用于本地文件来源');
        const incoming=new Map(source.modules.map(m=>[m.id,m]));
        for(const m of old.modules){const n=incoming.get(m.id);if(m.paused)incoming.set(m.id,{...m,removed:!n});else if(n)Object.assign(n,{categoryId:m.categoryId,disabled:m.disabled,paused:false});}
        source.modules=[...incoming.values()];if(source.modules.length>MAX_ITEMS)fail(409,'模块超过单个来源上限');
        Object.assign(source,{id:old.id,paused:old.paused,categoryId:source.categoryId||old.categoryId});
        current.sources[current.sources.indexOf(old)]={...source,edit:uid()};
      }else{
        if(current.sources.length>=MAX_SOURCES)fail(409,'已达到来源上限');
        if(source.url&&current.sources.some(s=>s.url===source.url))fail(409,'这个来源地址已添加');
        current.sources.push({...source,edit:uid()});
      }
      appendLog(current,`已保存来源「${logLabel(source)}」：${source.modules.length} 个模块`);
      return {ok:true,source};
    }),201);
  }
  return json(await change(env,st=>{
    st.origin ||= origin;
    if(path==='/api/source/update'){
      const s=by(st.sources,a.id,'来源');
      if(a.delete===true)st.sources=st.sources.filter(x=>x!==s);
      else {
        if(typeof a.paused==='boolean')s.paused=a.paused;
        if('categoryId'in a)s.categoryId=category(st,a.categoryId);
        if('newPolicy'in a){if(!['review','auto'].includes(a.newPolicy))fail(400,'新增策略无效');s.newPolicy=a.newPolicy;}
        if('newCategoryId'in a)s.newCategoryId=category(st,a.newCategoryId);
        sourceOptions(s,a);
        s.edit=uid();
      }
    }else if(path==='/api/module/update'){
      const s=by(st.sources,a.sourceId,'来源'),m=by(s.modules,a.id,'模块');
      if(typeof a.paused==='boolean')m.paused=a.paused;
      if(typeof a.disabled==='boolean')m.disabled=a.disabled;
      if(a.approve===true)m.pending=false;
      sourceOptions(m,a,true);
      if('categoryId'in a)m.categoryId=category(st,a.categoryId);
      if(m.removed&&!m.paused)s.modules=s.modules.filter(x=>x!==m);
      s.edit=uid();
    }else if(path==='/api/category'){
      const c=a.id?by(st.categories,a.id,'分类'):null;
      if(a.delete===true){
        if(!c)fail(400,'需要分类 ID');st.categories=st.categories.filter(x=>x!==c);
        for(const s of st.sources){if(s.categoryId===c.id)s.categoryId='';if(s.newCategoryId===c.id)s.newCategoryId='';for(const m of [...s.modules,...(s.moduleOverrides||[])])if(m.categoryId===c.id)m.categoryId='';s.edit=uid();}
      }else{
        const name=text(a.name,60,'分类名',true);
        if(st.categories.some(x=>x!==c&&x.name===name))fail(409,'已有同名分类');
        if(c)c.name=name;else{if(st.categories.length>=80)fail(409,'已达到分类上限');st.categories.push({id:uid(),name});}
      }
    }else if(path==='/api/distribution'){
      let d=a.id?by(st.distributions,a.id,'分发'):null;
      if(a.delete===true){if(!d)fail(400,'需要分发 ID');st.distributions=st.distributions.filter(x=>x!==d);return {ok:true};}
      const key=text(a.key,64,'分发 key')||d?.key||randomKey();
      if(!keyOK(key))fail(422,'key 只能包含英文字母、数字、- 和 _，且以字母或数字开头');
      if(st.distributions.some(x=>x!==d&&x.key===key))fail(409,'这个 key 已被使用');
      if(!d){if(st.distributions.length>=MAX_DISTS)fail(409,'已达到分发上限');d={id:uid(),published:null,active:null};st.distributions.push(d);}
      const title=text(a.title,100,'分发标题',true);
      if(a.mode!=='rules'&&a.mode!=='manual')fail(400,'分发模式无效');
      Object.assign(d,{key,title,description:text(a.description,500,'描述'),icon:validIcon(text(a.icon,1200,'图标地址'),originFor(env,st,origin)),enabled:a.enabled===true,mode:a.mode,categoryIds:list(a.categoryIds),sourceIds:list(a.sourceIds),include:list(a.include),exclude:list(a.exclude),order:a.order==='source'?'source':'title'});
      if(a.publish===true)publish(st,d,originFor(env,st,origin),a.confirmEmpty);
      return {ok:true,id:d.id,key:d.key,published:a.publish===true};
    }else if(path==='/api/publish'){
      return publish(st,by(st.distributions,a.id,'分发'),originFor(env,st,origin),a.confirmEmpty);
    }else fail(404,'接口不存在');
    return {ok:true};
  }));
}

function fileBindings(env){
  if(env.FILES||!env.FILE_KV)return env;
  const kv=env.FILE_KV;
  async function get(key){const body=await kv.get(key,'arrayBuffer');return body===null?null:{body,size:body.byteLength,httpEtag:`"${key.split('/').at(-1)}"`};}
  return {...env,FILES:{
    async put(key,bytes){
      if(await kv.get(key,'arrayBuffer')!==null)return;
      try{await kv.put(key,bytes instanceof ArrayBuffer?bytes:bytes.slice().buffer);}catch(e){if(await kv.get(key,'arrayBuffer')===null)throw e;}
    },get,head:get
  }};
}
export default {
  async fetch(req,env){
    env=fileBindings(env);
    try{
      const url=new URL(req.url), path=url.pathname;
      if(path.startsWith('/api/'))return await admin(req,env,url);
      if(!['GET','HEAD'].includes(req.method))return new Response('Method not allowed',{status:405});
      if(path.startsWith('/s/'))return await publicDistribution(req,env,path);
      if(path.startsWith('/m/')){
        const m=/^\/m\/([A-Za-z0-9][A-Za-z0-9_-]{0,63})\/([A-Za-z0-9_][A-Za-z0-9_.-]{0,159})\.js$/.exec(path);
        const d=m?(await get(env)).st.distributions.find(d=>d.key===m[1]&&d.enabled&&d.published):null;
        const link=d&&Object.hasOwn(d.publishedFiles||{},m[2])?d.publishedFiles[m[2]]:'';
        const file=link&&/^\/files\/[a-f0-9]{64}\.js$/.test(new URL(link).pathname)?new URL(link).pathname:'';
        if(!file)return new Response('Not found',{status:404,headers:{'Cache-Control':'no-store'}});
        const result=await publicFile(req,env,file);
        result.headers.set('Cache-Control','private, no-cache');
        const etag=result.headers.get('ETag');
        if(result.ok&&etag&&req.headers.get('If-None-Match')?.split(',').some(x=>x.trim()===etag||x.trim()==='*')){void result.body?.cancel().catch(()=>{});return new Response(null,{status:304,headers:{ETag:etag,'Cache-Control':'private, no-cache'}});}
        return result;
      }
      if(path.startsWith('/files/')||path.startsWith('/icons/'))return await publicFile(req,env,path);
      const asset=await env.ASSETS.fetch(req);const response=new Response(asset.body,asset);
      response.headers.set('X-Content-Type-Options','nosniff');response.headers.set('Referrer-Policy','no-referrer');response.headers.set('X-Frame-Options','DENY');
      response.headers.set('Content-Security-Policy',"default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' https: data: blob:; connect-src 'self'; object-src 'none'; frame-ancestors 'none'; base-uri 'self'; form-action 'self'");
      return response;
    }catch(e){if(e?.status>=400&&e.status<500)return json({error:e.message,...(e.code==='confirm_publish'?{code:e.code}:{})},e.status);console.error('Worker request failed',e?.name);return json({error:'服务暂不可用，请检查绑定或稍后重试'},500);}
  },
  async scheduled(_event,env,ctx){ctx.waitUntil(sync(fileBindings(env),undefined,undefined).catch(e=>console.error('Cron sync failed',e?.name,e?.status||'')));}
};

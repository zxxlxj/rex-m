import assert from 'node:assert/strict';
import {test} from 'node:test';
import {readFileSync} from 'node:fs';
import {DatabaseSync} from 'node:sqlite';
import worker from '../src/index.mjs';
const origin='https://rex-deploy.example.com';
const dbSQL=['0001_hub.sql','0002_auth.sql'].map(x=>readFileSync(new URL('../migrations/'+x,import.meta.url),'utf8')).join('\n');
const secret='test-only-initialization-token-123';
function fixture(t,extra={}){const sqlite=new DatabaseSync(':memory:');t.after(()=>sqlite.close());sqlite.exec(dbSQL);
const prepare=(statement,args=[])=>({bind:(...args)=>prepare(statement,args),first:async()=>sqlite.prepare(statement).get(...args)??null,run:async()=>({meta:{changes:sqlite.prepare(statement).run(...args).changes}})});
const env={SETUP_TOKEN:secret,DB:{prepare,async batch(xs){sqlite.exec('BEGIN');try{const r=await Promise.all(xs.map(x=>x.run()));sqlite.exec('COMMIT');return r;}catch(e){sqlite.exec('ROLLBACK');throw e;}}},FILES:{storage:new Map(),async put(key,value){this.storage.set(key,value);},async get(key){const body=this.storage.get(key);return body?{body,size:body.length,httpEtag:'"test"'}:null;}}};
let cookie='';Object.assign(env,extra);return async (path,data,expected=200,{requestOrigin=origin}={})=>{const headers={Cookie:cookie,Origin:requestOrigin,'Content-Type':'application/json'};
const res=await worker.fetch(new Request(origin+path,{method:data===undefined?'GET':'POST',headers,body:data===undefined?undefined:JSON.stringify(data)}),env);
const payload=await res.text();assert.equal(res.status,expected,payload);if(res.headers.has('Set-Cookie'))cookie=res.headers.get('Set-Cookie').split(';')[0];
return {payload,parse:()=>JSON.parse(payload)};};}
const js=`var WidgetMetadata = {id:'test.alpha', title:'Alpha', version:'1.0.0', requiredVersion:'0.0.6', modules:[]};\nfunction loadList(){return [];}`;
const settings={title:'我的合集',enabled:true,mode:'rules',order:'title'};
test('setup, upload, independently reclassify, publish two keys and fetch module',async(t)=>{
const req=fixture(t);await req('/api/state',undefined,401);await req('/api/setup',{token:secret,password:'A long test password!'},403,{requestOrigin:'https://other.example.com'});await req('/api/setup',{token:secret,password:'A long test password!'},201);
await req('/api/category',{name:'电影'});await req('/api/category',{name:'动画'});
const {categories}= (await req('/api/state')).parse();
const {source}= (await req('/api/source',{categoryId:categories[0].id,files:[{name:'alpha.rex.js',text:js}]},201)).parse();
await req('/api/module/update',{sourceId:source.id,id:'test.alpha',categoryId:categories[1].id});
const d=(await req('/api/distribution',{...settings,key:'custom-key',categoryIds:[categories[1].id]})).parse();
const other=(await req('/api/distribution',{...settings,categoryIds:[categories[0].id]})).parse();assert.match(other.key,/^[a-f0-9]{36}$/);
await req('/s/custom-key.rex',undefined,404);
await req('/api/publish',{id:d.id});await req('/api/publish',{id:other.id},409);await req('/api/publish',{id:other.id,confirmEmpty:true});
const {widgets}=(await req('/s/custom-key.rex')).parse();assert.equal(widgets.length,1);assert.equal((await req(new URL(widgets[0].url).pathname)).payload,js);
assert.equal((await req(`/s/${other.key}.rex`)).parse().widgets.length,0);
await req('/api/distribution',{...settings,id:d.id,key:'renamed',categoryIds:[categories[1].id]});await req('/s/custom-key.rex',undefined,404);assert.equal((await req('/s/renamed.rex')).parse().widgets[0].id,'test.alpha');
});

test('upstream collection refresh keeps manual classification and honors prospective onboarding policy',async t=>{
  const original=globalThis.fetch;t.after(()=>{globalThis.fetch=original;});
  const row=(id,version='1.0.0')=>({id,title:id,version,requiredVersion:'0.0.6',url:`https://raw.githubusercontent.com/rex/project/main/${id}.js`});
  let remote=[row('original')];globalThis.fetch=async()=>Response.json({name:'上游',widgets:remote});
  const req=fixture(t);await req('/api/setup',{token:secret,password:'A long test password!'},201);
  await req('/api/category',{name:'旧模块'});await req('/api/category',{name:'新模块'});
  const {categories:[oldCategory,newCategory]}=(await req('/api/state')).parse();
  const {source:s}=(await req('/api/source',{url:'https://raw.githubusercontent.com/rex/project/main/all.rex'},201)).parse();
  await req('/api/source/update',{id:s.id,newPolicy:'review',newCategoryId:newCategory.id});
  await req('/api/module/update',{sourceId:s.id,id:'original',categoryId:oldCategory.id});
  const d=(await req('/api/distribution',{...settings,key:'new-content',categoryIds:[newCategory.id]})).parse();
  await req('/api/publish',{id:d.id,confirmEmpty:true});
  remote=[row('original','2.0.0'),row('waiting')];await req('/api/sync',{id:s.id});
  const [old,waiting]=(await req('/api/state')).parse().sources[0].modules;
  assert.equal(old.categoryId,oldCategory.id);assert.equal(old.version,'2.0.0');assert.equal(waiting.categoryId,newCategory.id);assert.equal(waiting.pending,true);
  assert.equal((await req('/s/new-content.rex')).parse().widgets.length,0);
  await req('/api/source/update',{id:s.id,newPolicy:'auto'});
  remote.push(row('automatic'));await req('/api/sync',{id:s.id});
  assert.deepEqual((await req('/s/new-content.rex')).parse().widgets.map(x=>x.id),['automatic']);
  await req('/api/module/update',{sourceId:s.id,id:'waiting',approve:true,categoryId:newCategory.id});
  await req('/api/publish',{id:d.id});assert.deepEqual((await req('/s/new-content.rex')).parse().widgets.map(x=>x.id),['automatic','waiting']);
});

test('downloaded JS is distributed via stable URL and save-and-publish is atomic',async t=>{
  const original=globalThis.fetch;t.after(()=>{globalThis.fetch=original;});
  const upstream='https://example.com/standalone.js';
  let version='1.0.0', offline=false;
  const bytes=()=>js.replace('1.0.0',version);
  globalThis.fetch=async ()=>{if(offline)return new Response(null,{status:502});return new Response(bytes());};
  const req=fixture(t);await req('/api/setup',{token:secret,password:'A long test password!'},201);
  const {source:s}=(await req('/api/source',{url:upstream,delivery:'mirror',refreshMinutes:15},201)).parse();
  const draft={...settings,key:'stable-files',sourceIds:[s.id],publish:true};
  const first=s.modules[0];
  if(!first.mirror?.url)await req('/api/distribution',draft,409);
  await req('/api/sync',{id:s.id});
  const d=(await req('/api/distribution',draft)).parse();
  assert.equal(d.published,true);
  const v1=(await req('/s/stable-files.rex')).parse().widgets[0];
  assert.equal(v1.url,origin+'/m/stable-files/test.alpha.js');
  assert.equal((await req(new URL(v1.url).pathname)).payload,bytes());
  await req('/api/distribution',{...draft,id:d.id,title:'未发布的规则',sourceIds:[],publish:false});
  version='1.0.1';await req('/api/sync',{id:s.id,moduleId:'test.alpha'});
  const v2=(await req('/s/stable-files.rex')).parse();
  assert.equal(v2.title,settings.title);assert.equal(v2.widgets[0].version,version);assert.equal(v2.widgets[0].url,v1.url);
  assert.equal((await req(new URL(v1.url).pathname)).payload,bytes());
  offline=true;await req('/api/sync',{id:s.id,moduleId:'test.alpha'});
  assert.equal((await req(new URL(v1.url).pathname)).payload,bytes());
  await req('/api/distribution',{...draft,id:d.id,sourceIds:[]},409);
  assert.equal((await req('/s/stable-files.rex')).parse().widgets.length,1);
});

test('dashboard defaults persist and password change invalidates existing sessions',async t=>{
 const req=fixture(t);const old='A long test password!', next='A different long password!';
 await req('/api/setup',{token:secret,password:old},201);
 await req('/api/settings',{defaultRefreshMinutes:60,defaultDelivery:'mirror',defaultNewPolicy:'auto',defaultIcon:''});
 assert.equal((await req('/api/state')).parse().settings.defaultRefreshMinutes,60);
 await req('/api/password',{currentPassword:'wrong',newPassword:next},403);
 await req('/api/password',{currentPassword:old,newPassword:next});
 assert.equal((await req('/api/session')).parse().authenticated,true);
 await req('/api/logout',{});await req('/api/login',{password:old},401);await req('/api/login',{password:next});
 assert.equal((await req('/api/session')).parse().authenticated,true);
});

test('deleting a source withdraws published widgets and removes only unshared hosted files',async t=>{
 const storage=new Map(), deleted=[];
 const req=fixture(t,{FILES:{async put(k,v){storage.set(k,v);},async get(k){const v=storage.get(k);return v?{body:v,size:v.length,httpEtag:'"test"'}:null;},async delete(k){deleted.push(k);storage.delete(k);}}});
 await req('/api/setup',{token:secret,password:'A long test password!'},201);
 const files=[{name:'alpha.js',text:js}];
 const a=(await req('/api/source',{files},201)).parse().source;
 const b=(await req('/api/source',{files},201)).parse().source;
 const path=new URL(a.modules[0].url).pathname;
 await req('/api/distribution',{...settings,key:'shared',sourceIds:[a.id],publish:true});
 await req('/api/source/update',{id:a.id,delete:true});
 assert.equal((await req('/s/shared.rex')).parse().widgets.length,0);
 assert.equal((await req(path)).payload,js);assert.equal(deleted.length,0);
 await req('/api/source/update',{id:b.id,delete:true});
 assert.equal(storage.size,0);assert.ok(deleted.includes(path.slice(1)));await req(path,undefined,404);
});

test('matching imports, batch checks and batch deletion update published rules without extra publish',async t=>{
 const orig=globalThis.fetch;t.after(()=>{globalThis.fetch=orig;});
 let version='1.0.0';
 globalThis.fetch=async u=>new Response(js.replace('test.alpha',`test.${new URL(u).pathname.slice(1,-3)}`).replace('1.0.0',version));
 const req=fixture(t);await req('/api/setup',{token:secret,password:'A long test password!'},201);
 await req('/api/category',{name:'自动分发'});const categoryId=(await req('/api/state')).parse().categories[0].id;
 await req('/api/distribution',{...settings,key:'auto-hub',categoryIds:[categoryId],publish:true,confirmEmpty:true});
 const local=(await req('/api/source',{categoryId,files:[{name:'local.js',text:js}]},201)).parse().source;
 assert.deepEqual((await req('/s/auto-hub.rex')).parse().widgets.map(m=>m.id),['test.alpha']);
 const ids=[];for(const id of ['beta','gamma','delta'])ids.push((await req('/api/source',{categoryId,url:`https://example.org/${id}.js`},201)).parse().source.id);
 const collection='https://example.org/set.rex';
 globalThis.fetch=async u=>u===collection?Response.json({icon:'./art.png',widgets:[]}):new Response(js.replace('test.alpha',`test.${new URL(u).pathname.slice(1,-3)}`).replace('1.0.0',version));
 const collectionSource=(await req('/api/source',{url:collection},201)).parse().source;
 assert.equal(collectionSource.icon,'https://example.org/art.png');
 assert.equal((await req('/s/auto-hub.rex')).parse().widgets.length,4);
 version='2.0.0';const result=(await req('/api/source/batch',{ids:[local.id,...ids],action:'check'})).parse();
 assert.equal(result.checked,2);assert.equal(result.queued,1);assert.equal(result.skipped,1);
 await req('/api/sync',{});assert.equal((await req('/s/auto-hub.rex')).parse().widgets.filter(m=>m.version===version).length,3);
 await req('/api/source/batch',{ids:[local.id,...ids],action:'delete'});
 assert.equal((await req('/s/auto-hub.rex')).parse().widgets.length,0);
});

test('Rex 0.0.7 content declarations survive upload, mirror and publish without guessing',async t=>{
 const old=globalThis.fetch;t.after(()=>{globalThis.fetch=old;});
 const withType=(id,type)=>js.replace('test.alpha',id).replace('modules:[]',`contentType:'${type}', continuousPlay:false, modules:[]`).replace('0.0.6','0.0.7');
 const req=fixture(t);await req('/api/setup',{token:secret,password:'A long test password!'},201);
 const index='https://example.com/types.rex', leaf='https://example.com/music.js';
 globalThis.fetch=async u=>u===index?Response.json({widgets:[{id:'test.music',title:'Music',version:'1',requiredVersion:'0.0.7',url:leaf}]}):new Response(withType('test.music','music'));
 const remote=(await req('/api/source',{url:index,delivery:'mirror'},201)).parse().source;
 assert.equal(remote.modules[0].mirror.contentType,'music');
 const local=(await req('/api/source',{files:[{name:'audio.js',text:withType('test.audio','audiobook')},{name:'drama.js',text:withType('test.drama','shortDrama')},{name:'old.js',text:js}]},201)).parse().source;
 await req('/api/distribution',{...settings,key:'types',sourceIds:[remote.id,local.id],publish:true});
 const widgets=Object.fromEntries((await req('/s/types.rex')).parse().widgets.map(m=>[m.id,m]));
 for(const [id,kind] of [['test.music','music'],['test.audio','audiobook'],['test.drama','shortDrama']]){
   assert.equal(widgets[id].contentType,kind);assert.equal(widgets[id].continuousPlay,false);assert.equal(widgets[id].requiredVersion,'0.0.7');
 }
 assert.ok(!Object.hasOwn(widgets['test.alpha'],'contentType'));
});

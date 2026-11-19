import assert from 'node:assert/strict';
import {readFileSync, existsSync} from 'node:fs';
import {test} from 'node:test';
import {DatabaseSync} from 'node:sqlite';
import {badgeApi,badgePublic,badgeTick} from '../src/badges.mjs';

const hub='https://rex.example.com', upstream='https://cdn.example.net';
const png=new Uint8Array([137,80,78,71,13,10,26,10,42]);
const make=(images)=>({title:'extra',groups:[{id:'g',name:'G',misc:true}],filters:images.map((imageURL,i)=>({name:`test ${i}`,groupId:'g',imageURL,pattern:'(?i)[ inert',tagColor:'#fff'}))});
function fixture(t) {
  const db=new DatabaseSync(':memory:'); t.after(()=>db.close());
  db.exec(readFileSync(new URL('../migrations/0003_badges.sql',import.meta.url),'utf8'));
  db.exec('PRAGMA foreign_keys=ON');
  const storage=new Map();
  const prepare=(query,args=[])=>({bind:(...args)=>prepare(query,args),query,args,
    first:async()=>db.prepare(query).get(...args)??null,all:async()=>({results:db.prepare(query).all(...args)}),
    run:async()=>({meta:{changes:db.prepare(query).run(...args).changes}})});
  const env={DB:{prepare,async batch(xs){db.exec('BEGIN');try {const out=xs.map(x=>/^SELECT/i.test(x.query)?{results:db.prepare(x.query).all(...x.args)}:{meta:{changes:db.prepare(x.query).run(...x.args).changes}});db.exec('COMMIT');return out;} catch(e){db.exec('ROLLBACK');throw e;}}},
    FILES:{async put(k,v){storage.set(k,v.slice());},async get(k){return storage.has(k)?{body:storage.get(k)}:null;},async delete(k){storage.delete(k);}}};
  const api=async(path,a,status=200)=>{const u=new URL(`/api/badges${path}`,hub);const r=await badgeApi(new Request(u,{method:a?'POST':'GET'}),env,u,a);const o=await r.json();assert.equal(r.status,status,JSON.stringify(o));return o;};
  const pub=(path,method='GET')=>{const u=new URL(path,hub);return badgePublic(new Request(u,{method}),env,u);};
  return {db,storage,env,api,pub};
}

test('host batch, failures and retry, scoped cleanup, and inert SVG hosting',async t=>{
  const {api,pub,env,storage}=fixture(t);
  let bad=true, count=0;
  const svg='<?xml version="1.0"?><!DOCTYPE svg PUBLIC "-//W3C//DTD SVG 1.1//EN" "http://www.w3.org/Graphics/SVG/1.1/DTD/svg11.dtd"><svg xmlns="http://www.w3.org/2000/svg" onload="alert(1)"/>';
  t.mock.method(globalThis,'fetch',async(input,opts)=>{
    assert.equal(opts.redirect,'manual');
    count++;
    if(String(input).endsWith('/2.png') && bad) return new Response('<html>not an image</html>');
    if(String(input).endsWith('.svg')) return new Response(svg,{headers:{'Content-Type':'text/plain'}});
    return new Response(png);
  });
  assert.equal((await pub('/badge.json')).status,404);
  const raw=make([...Array.from({length:8},(_,i)=>`./${i}.png`),'./badge.svg','./0.png','']);
  raw.extra={imageURL:'./badge.svg',other:17};
  const {id}=await api('/import',{text:JSON.stringify(raw),baseUrl:`${upstream}/packs/main.json`,filename:'demo.json',mode:'host'});
  const other=(await api('/import',{text:JSON.stringify(make([])),mode:'host'})).id;
  assert.equal((await api('')).items.find(p=>p.id===id).assets,9);
  assert.equal((await api(`/preview?id=${id}&q=TEST%208&group=g`)).items[0].imageURL,`${upstream}/packs/badge.svg`);
  await api('/active',{id},409);
  const first=(await api('/process',{id})).item;
  assert.equal(first.done,7);assert.equal(first.failed,1);assert.equal(first.status,'queued');assert.equal(count,8);
  await badgeTick(env);
  assert.equal((await api('')).items.find(p=>p.id===id).status,'error');
  assert.equal((await pub(`/badge-assets/${id}/1-0`)).status,404);
  bad=false; await api('/update',{id,retry:true});
  const last=(await api('/process',{id})).item;
  assert.equal(last.status,'ready');assert.equal(last.failed,0);assert.equal(count,10);
  await api('/active',{id});
  const published=await (await pub('/badge.json')).json();
  assert.equal(published.filters[0].pattern,raw.filters[0].pattern);
  assert.deepEqual(published.groups,raw.groups);
  assert.equal(published.extra.imageURL,published.filters[8].imageURL);assert.equal(published.extra.other,17);
  assert.equal(published.filters[0].imageURL,published.filters[9].imageURL);
  assert.equal(published.filters[10].imageURL,'');
  const s=await pub(published.filters[8].imageURL);
  assert.equal(s.headers.get('Content-Type'),'image/svg+xml');assert.match(s.headers.get('Content-Security-Policy'),/sandbox; default-src 'none'/);
  assert.equal(s.headers.get('X-Content-Type-Options'),'nosniff');assert.equal(await s.text(),svg);
  assert.equal((await pub(published.filters[8].imageURL,'HEAD')).body,null);
  assert.deepEqual(new Uint8Array(await (await pub(published.filters[0].imageURL)).arrayBuffer()),png);
  await api('/update',{id,mode:'link'},400);
  await api('/update',{id,delete:true}); assert.equal((await pub('/badge.json')).status,404);
  await badgeTick(env);assert.equal(storage.size,5);await badgeTick(env);
  assert.deepEqual([...storage.keys()],[`badge-source/${other}.json`,`badge-source/${other}.plan`]);
});

test('direct URLs, switching modes, lock and write-budget fencing', async t=>{
  const {api,env,pub,db,storage}=fixture(t);
  const raw=make(['./picture.png']);
  t.mock.method(globalThis,'fetch',async input=>{
    if(input===`${upstream}/start`)return new Response(null,{status:302,headers:{Location:'/final/main.json'}});
    if(input===`${upstream}/final/main.json`)return new Response(JSON.stringify(raw));
    assert.equal(input,`${upstream}/final/picture.png`);return new Response(png);
  });
  const {id}=await api('/import',{url:`${upstream}/start`,mode:'link'});
  assert.equal((await api(`/preview?id=${id}`)).items[0].imageURL,`${upstream}/final/picture.png`);
  await api('/active',{id}); assert.equal((await pub('/badge.json','HEAD')).headers.get('Location'),`${upstream}/start`);
  await api('/update',{id,mode:'host'}); assert.equal((await api('')).activeId,'');
  db.prepare('UPDATE badge_state SET lock_until=?').run(Date.now()+15_000);
  await api('/process',{id},409); await badgeTick(env);
  db.exec('UPDATE badge_state SET lock_until=0,puts=850');
  assert.equal((await api('/process',{id})).item.done,0);
  db.exec("UPDATE badge_state SET quota_day='2000-01-01'");
  await badgeTick(env); await api('/active',{id});
  const u=(await (await pub('/badge.json')).json()).filters[0].imageURL;
  await api('/update',{id,mode:'link'}); assert.equal((await pub('/badge.json')).status,302); assert.equal((await pub(u)).status,404);
  await api('/update',{id,mode:'host'},409);
  await badgeTick(env);assert.equal(storage.size,2);
  await api('/update',{id,mode:'host'}); await badgeTick(env); assert.equal((await api('')).items[0].done,1);
  assert.equal((await pub(u)).status,404);
  await api('/active',{id:''}); assert.equal((await api('')).activeId,'');
});

test('rejects unsafe initial and redirected URLs; journal resumes failed writes',async t=>{
  const {api,env,db,storage}=fixture(t);
  let requests=0;
  t.mock.method(globalThis,'fetch',async input=>{
    requests++;
    if(input.endsWith('/unsafe'))return new Response(null,{status:302,headers:{Location:'https://user:password@localhost/s'}});
    if(input.endsWith('/image'))return new Response(png);
    throw Error('Unintended fetch');
  });
  for (const url of ['https://127.0.0.1/a','https://[::1]/a','https://foo.local/a',`${upstream}/a?token=secret`,`${upstream}/%252e/a`]) await api('/import',{url,mode:'link'},400);
  assert.equal(requests,0);await api('/import',{url:`${upstream}/unsafe`,mode:'link'},400);assert.equal(requests,1);
  const {id}=await api('/import',{text:JSON.stringify(make([`${upstream}/image`])),mode:'host'});
  const put=env.FILES.put;
  env.FILES.put=async(k,v)=>{await put(k,v);throw new Error('transport lost');};
  assert.equal((await api('/process',{id})).item.failed,1);
  assert.equal(db.prepare('SELECT highwater FROM badge_packs WHERE id=?').get(id).highwater,1);
  await api('/update',{id,delete:true}); await badgeTick(env);assert.equal(storage.size,0);
});

const real='/tmp/rex-badges';
test('imports actual Rex badge packs and walks the 1556-image queue', {skip:!existsSync(`${real}/pppboom-adult.json`)}, async t=>{
  const {api,env,db}=fixture(t);
  const cases=[['badges-hybrid',12,55],['badges',15,251],['pppboom',41,727],['xinyue4capyplayer-general',13,493],['pppboom-adult',43,1556]];
  t.mock.method(globalThis,'fetch',async()=>new Response(png));
  for(const [filename,groups,assets] of cases){
    const text=readFileSync(`${real}/${filename}.json`,'utf8');
    const {id}=await api('/import',{filename,text,mode:'host'});
    const p=(await api('')).items.find(x=>x.id===id);
    assert.equal(p.groups,groups); assert.equal(p.assets,assets); assert.equal(p.filters,assets);
    if(assets===1556){
      // Exhaust the daily budget (including all 10 source and plan writes), then simulate the next UTC day.
      for(let i=0;i<106;i++)await api('/process',{id});
      assert.equal((await api('')).items.find(x=>x.id===id).done,840);
      db.exec("UPDATE badge_state SET quota_day='2000-01-01'");
      for(let i=0;i<90;i++)await api('/process',{id});
      assert.equal((await api('')).items.find(x=>x.id===id).status,'ready');
      await api('/active',{id});
    }
  }
});

import assert from 'node:assert/strict';
import {test} from 'node:test';
import {readFileSync} from 'node:fs';
import {DatabaseSync} from 'node:sqlite';
import {badgeApi,badgePublic,badgeTick} from '../src/badges.mjs';
const origin='https://hub.example.com', ext='https://assets.example.com/tag.svg';
test('badge hosts JSON and image, switches stable URL and removes owned objects',async t=>{
 const db=new DatabaseSync(':memory:');t.after(()=>db.close());db.exec(readFileSync(new URL('../migrations/0003_badges.sql',import.meta.url),'utf8'));
 const prepare=(q,args=[])=>({bind:(...a)=>prepare(q,a),first:async()=>db.prepare(q).get(...args)??null,all:async()=>({results:db.prepare(q).all(...args)}),run:async()=>({meta:{changes:db.prepare(q).run(...args).changes}})});
 const fs=new Map(),env={DB:{prepare,async batch(xs){db.exec('BEGIN');try{const rs=[];for(const x of xs){try{rs.push(await x.all());}catch{rs.push(await x.run());}}db.exec('COMMIT');return rs;}catch(e){db.exec('ROLLBACK');throw e;}}},FILES:{async put(k,v){fs.set(k,v);},async get(k){return fs.has(k)?{body:fs.get(k)}:null;},async delete(k){fs.delete(k);}}};

 env.DB.batch=async xs=>{db.exec('BEGIN');try{const out=[];for(const x of xs)out.push(await x.exec());db.exec('COMMIT');return out;}catch(e){db.exec('ROLLBACK');throw e;}};
 const prep=env.DB.prepare;env.DB.prepare=(q)=>{const wrap=x=>({...x,bind:(...a)=>wrap(x.bind(...a)),exec:()=>/^\s*SELECT\b/i.test(q)?x.all():x.run()});return wrap(prep(q));};
 const data={groups:[{id:'g',name:'分辨率'}],filters:[{id:'f',groupId:'g',name:'4K',imageURL:ext,pattern:'(?i)4k'}],custom:{keep:true}};
 const svg='<svg xmlns="http://www.w3.org/2000/svg" width="2" height="2"></svg>';
 const native=globalThis.fetch;t.after(()=>globalThis.fetch=native);globalThis.fetch=async u=>u===ext?new Response(svg):Response.json(data);
 const call=async (path,a,code=200)=>{const url=new URL(origin+'/api/badges'+path);const r=await badgeApi(new Request(url,{method:a===undefined?'GET':'POST'}),env,url,a);const result=await r.json();assert.equal(r.status,code,JSON.stringify(result));return result;};
 const pub=path=>{const u=new URL(path,origin);return badgePublic(new Request(u),env,u);};
 const {id}=await call('/import',{mode:'host',text:JSON.stringify(data),filename:'sample.json'});
 await call('/active',{id},409);await call('/process',{id});await call('/active',{id});
 const response=await pub('/badge.json');assert.equal(response.status,200);const manifest=await response.json();assert.equal(manifest.custom.keep,true);assert.equal(manifest.filters[0].pattern,data.filters[0].pattern);
 const image=await pub(manifest.filters[0].imageURL);assert.equal(image.headers.get('Content-Type'),'image/svg+xml');assert.match(image.headers.get('Content-Security-Policy'),/sandbox/);assert.equal(await image.text(),svg);
 const direct=await call('/import',{mode:'link',url:'https://assets.example.com/badge.json',alias:'普通版'});await call('/active',{id:direct.id});
 assert.equal((await pub('/badge.json')).headers.get('Location'),'https://assets.example.com/badge.json');
 await call('/update',{id,delete:true});await badgeTick(env);assert.ok([...fs.keys()].every(k=>!k.includes(id)));assert.equal((await pub(manifest.filters[0].imageURL)).status,404);
});

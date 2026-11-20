import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {runInNewContext} from 'node:vm';
import {test} from 'node:test';
const src=readFileSync(new URL('../public/sw.js',import.meta.url),'utf8');
test('anonymous external source icons reuse cache and failures can invalidate it',async()=>{
  const handlers={},data=new Map(),calls=[];
  const store={async match(r){return data.get(r.url)?.clone();},async put(r,response){data.set(r.url,response);},async keys(){return [...data.keys()].map(k=>new Request(k));},async delete(r){data.delete(typeof r==='string'?r:r.url);}};
  runInNewContext(src,{Date,URL,Request,Response,self:{location:{origin:'https://hub.example.com'},addEventListener(k,f){handlers[k]=f;}},caches:{open:async()=>store,keys:async()=>[]},fetch:async req=>{calls.push(req);return new Response('image',{headers:{'Content-Type':'image/png'}});}});
  const url='https://cdn.example.com/art.png';
  function go(target,kind='image',policy='same-origin'){
    const request=new Request(target,{mode:'no-cors',referrerPolicy:policy});Object.defineProperty(request,'destination',{value:kind});
    let out;handlers.fetch({request,respondWith(p){out=p;}});return out;
  }
  await Promise.all([go(url),go(url)]);await go(url);
  assert.equal(calls.length,1);assert.equal(calls[0].credentials,'omit');assert.equal(calls[0].referrerPolicy,'no-referrer');
  assert.equal(go(url,'script'),undefined);assert.equal(go(url,'image','no-referrer'),undefined);assert.equal(go(url+'?token=x'),undefined);
  assert.equal(go('https://hub.example.com/api/bootstrap'),undefined);
  let done;handlers.message({data:{type:'bad-upstream-icon',url},waitUntil(p){done=p;}});await done;await go(url);
  assert.equal(calls.length,2);
});

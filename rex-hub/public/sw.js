const CACHE='rex-hub-shell-0.0.9';
const ICONS='rex-hub-icons-v1';
const externalCache=()=>`rex-hub-upstream-icons-${Math.floor(Date.now()/604800000)}`;
const externalPending=new Map();
const SHELL=['/','/app.js','/badges.js','/liquid.js','/style.css','/distributions.css','/badges.css','/liquid.css','/pull-rex-collection.png','/rex-mark.png','/hub-mark.png','/manifest.webmanifest','/pwa-180.png','/pwa-192.png','/pwa-512.png','/pwa-maskable.png'];
const localArt=/^\/(?:rex-dino-(?:0[1-9]|1[0-9]|2[0-4])\.png|icons\/[a-f0-9]{64}\.(?:png|jpg|gif|webp))$/;
self.addEventListener('install',event=>event.waitUntil(caches.open(CACHE).then(cache=>cache.addAll(SHELL)).then(()=>self.skipWaiting())));
self.addEventListener('activate',event=>event.waitUntil((async()=>{for(const key of await caches.keys())if(key.startsWith('rex-hub-shell-')&&key!==CACHE)await caches.delete(key);await self.clients.claim();})()));
async function icon(req,path){
  const cache=await caches.open(ICONS), hit=await cache.match(path);
  if(hit)return hit;
  const response=await fetch(req);
  if(response.ok&&/^image\//i.test(response.headers.get('Content-Type')||'')&&!response.redirected){
    try{await cache.put(path,response.clone());const keys=await cache.keys();await Promise.all(keys.slice(0,Math.max(0,keys.length-96)).map(key=>cache.delete(key)));}catch{}
  }
  return response;
}
let prunedExternal;
async function upstream(req){
  const name=externalCache();
  if(prunedExternal!==name){prunedExternal=name;try{await Promise.all((await caches.keys()).filter(k=>k.startsWith('rex-hub-upstream-icons-')&&k!==name).map(k=>caches.delete(k)));}catch{}}
  const cache=await caches.open(name),hit=await cache.match(req);
  if(hit)return hit;
  let pending=externalPending.get(req.url);
  if(!pending){
    pending=(async()=>{
      const response=await fetch(new Request(req,{credentials:'omit',referrerPolicy:'no-referrer'}));
      if(response.type==='opaque'||response.ok&&/^image\//i.test(response.headers.get('Content-Type')||'')){
        try{await cache.put(req,response.clone());const keys=await cache.keys();await Promise.all(keys.slice(0,Math.max(0,keys.length-32)).map(key=>cache.delete(key)));}catch{}
      }
      return response;
    })();
    externalPending.set(req.url,pending);
    pending.finally(()=>externalPending.delete(req.url)).catch(()=>{});
  }
  return (await pending).clone();
}
self.addEventListener('message',event=>{
  if(event.data?.type!=='bad-upstream-icon'||typeof event.data.url!=='string')return;
  try{const u=new URL(event.data.url);if(u.protocol==='https:')event.waitUntil(caches.open(externalCache()).then(c=>c.delete(u.href)));}catch{}
});
self.addEventListener('fetch',event=>{
  const req=event.request,u=new URL(req.url);
  if(req.method!=='GET')return;
  if(u.origin!==self.location.origin){
    if(req.destination==='image'&&req.mode==='no-cors'&&u.protocol==='https:'&&!u.username&&!u.password&&[...u.searchParams.keys()].every(k=>/^(v|ver|version|raw|size|width|height|w|h)$/i.test(k))&&req.referrerPolicy==='same-origin')event.respondWith(upstream(req).catch(()=>Response.error()));
    return;
  }
  if(localArt.test(u.pathname)&&!u.search){event.respondWith(icon(req,u.pathname));return;}
  if(!SHELL.includes(u.pathname))return;
  event.respondWith((async()=>{
    const cache=await caches.open(CACHE);
    if(u.searchParams.has('v')&&u.pathname!=='/'){
      const hit=await cache.match(req);if(hit)return hit;
    }
    try{const response=await fetch(req);if(response.ok)try{await cache.put(req,response.clone());}catch{}return response;}
    catch(error){const saved=await cache.match(req)||await cache.match(u.pathname);if(saved)return saved;throw error;}
  })());
});

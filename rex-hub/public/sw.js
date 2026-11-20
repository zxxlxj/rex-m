const CACHE='rex-hub-shell-0.0.4-rex-collection';
const SHELL=['/','/app.js','/badges.js','/liquid.js','/style.css','/distributions.css','/badges.css','/liquid.css','/pull-rex-collection.png','/rex-mark.png','/hub-mark.png','/manifest.webmanifest','/pwa-180.png','/pwa-192.png','/pwa-512.png','/pwa-maskable.png'];
self.addEventListener('install',event=>event.waitUntil(caches.open(CACHE).then(cache=>cache.addAll(SHELL)).then(()=>self.skipWaiting())));
self.addEventListener('activate',event=>event.waitUntil((async()=>{for(const key of await caches.keys())if(key.startsWith('rex-hub-shell-')&&key!==CACHE)await caches.delete(key);await self.clients.claim();})()));
self.addEventListener('fetch',event=>{
  const req=event.request, u=new URL(req.url);

  if(req.method!=='GET'||u.origin!==self.location.origin||!SHELL.includes(u.pathname))return;
  event.respondWith((async()=>{
    const cache=await caches.open(CACHE);
    try {const response=await fetch(req);if(response.ok)await cache.put(u.pathname,response.clone());return response;}
    catch(error){const saved=await cache.match(u.pathname);if(saved)return saved;throw error;}
  })());
});

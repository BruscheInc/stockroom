// Stockroom service worker — cache the app shell, always hit the network for /api/ (live data).
const CACHE = "stockroom-v1";
const SHELL = ["./","./index.html","./manifest.webmanifest"];
self.addEventListener("install",(e)=>{ e.waitUntil(caches.open(CACHE).then(c=>c.addAll(SHELL)).then(()=>self.skipWaiting()).catch(()=>{})); });
self.addEventListener("activate",(e)=>{ e.waitUntil(caches.keys().then(ks=>Promise.all(ks.filter(k=>k!==CACHE).map(k=>caches.delete(k)))).then(()=>self.clients.claim())); });
self.addEventListener("fetch",(e)=>{
  const url=new URL(e.request.url);
  if(e.request.method!=="GET"||url.pathname.startsWith("/api/")) return; // live data + writes: network only
  e.respondWith(caches.match(e.request).then(hit=> hit || fetch(e.request).then(resp=>{ const cp=resp.clone(); caches.open(CACHE).then(c=>c.put(e.request,cp)).catch(()=>{}); return resp; }).catch(()=>caches.match("./index.html"))));
});

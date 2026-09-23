// Stockroom service worker — the app shell is fetched NETWORK-FIRST so a new deploy shows up on the
// next launch (the old cache-first shell meant a deployed change never reached an installed device
// until the cache name was bumped by hand). Cache is the offline fallback. /api/ is always live.
const CACHE = "stockroom-v30";
const SHELL = ["./", "./index.html", "./manifest.webmanifest"];
const isShell = (req, url) => req.mode === "navigate" || url.pathname === "/" || url.pathname.endsWith("/index.html");
self.addEventListener("install", (e) => { e.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting()).catch(() => {})); });
self.addEventListener("activate", (e) => { e.waitUntil(caches.keys().then((ks) => Promise.all(ks.filter((k) => k !== CACHE).map((k) => caches.delete(k)))).then(() => self.clients.claim())); });
self.addEventListener("message", (e) => { if (e.data === "skipWaiting") self.skipWaiting(); });
self.addEventListener("fetch", (e) => {
  const url = new URL(e.request.url);
  if (e.request.method !== "GET" || url.pathname.startsWith("/api/")) return;  // live data + writes: network only
  if (isShell(e.request, url)) {
    e.respondWith(
      fetch(e.request).then((resp) => { const cp = resp.clone(); caches.open(CACHE).then((c) => c.put("./index.html", cp)).catch(() => {}); return resp; })
        .catch(() => caches.match("./index.html").then((hit) => hit || caches.match("./")))
    );
    return;
  }
  e.respondWith(caches.match(e.request).then((hit) => hit || fetch(e.request).then((resp) => { const cp = resp.clone(); caches.open(CACHE).then((c) => c.put(e.request, cp)).catch(() => {}); return resp; }).catch(() => caches.match("./index.html"))));
});

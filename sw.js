const CACHE_NAME = "mei-velocity-shell-v1";
const APP_SHELL = ["/", "/index.html", "/styles.css", "/app.js", "/map-config.js", "/manifest.webmanifest", "/chat.html", "/chat.js", "/contact.html", "/fares.html", "/services.html", "/vehicles.html", "/assets/mei_logo.jpg", "/assets/mei-app-icon.svg"];
self.addEventListener("install", (event) => {
  event.waitUntil(caches.open(CACHE_NAME).then((cache) => cache.addAll(APP_SHELL)));
  self.skipWaiting();
});
self.addEventListener("activate", (event) => {
  event.waitUntil(caches.keys().then((keys) => Promise.all(keys.filter((key) => key.startsWith("mei-velocity-shell-") && key !== CACHE_NAME).map((key) => caches.delete(key)))));
  self.clients.claim();
});
self.addEventListener("fetch", (event) => {
  const request = event.request;
  const url = new URL(request.url);
  if (request.method !== "GET" || url.origin !== self.location.origin) return;
  const cacheKey = new Request(url.origin + url.pathname);
  event.respondWith(fetch(request).then((response) => {
    if (response.ok) {
      const copy = response.clone();
      caches.open(CACHE_NAME).then((cache) => cache.put(cacheKey, copy));
    }
    return response;
  }).catch(async () => {
    const cached = await caches.match(cacheKey);
    if (cached) return cached;
    if (request.mode === "navigate") return (await caches.match("/index.html")) || Response.error();
    return Response.error();
  }));
});

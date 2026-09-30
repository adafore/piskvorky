// sw.js – minimální service worker, jen aby appka splňovala podmínky pro
// "Nainstalovat" (Add to Home Screen / PWA) a fungovala i chvíli offline.
const CACHE_NAME = "piskvorky-v2";
const APP_SHELL = [
  "./",
  "./index.html",
  "./style.css",
  "./firebase-config.js",
  "./manifest.json",
  "./js/fb.js",
  "./js/util.js",
  "./js/gomoku.js",
  "./js/scheduling.js",
  "./js/state.js",
  "./js/matchview.js",
  "./js/app.js",
  "./assets/logo.png",
  "./assets/favicon.png",
  "./assets/icon-192.png",
  "./assets/icon-512.png",
  "./assets/banner.jpg",
  "./assets/trophy.png",
  "./assets/bg-grid.jpg"
];

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME)
      .then((cache) => cache.addAll(APP_SHELL))
      .catch(() => {})
  );
  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys().then((names) =>
      Promise.all(names.filter((n) => n !== CACHE_NAME).map((n) => caches.delete(n)))
    )
  );
  self.clients.claim();
});

self.addEventListener("fetch", (event) => {
  const req = event.request;
  if (req.method !== "GET" || new URL(req.url).origin !== self.location.origin) return;
  event.respondWith(
    fetch(req)
      .then((res) => {
        const copy = res.clone();
        caches.open(CACHE_NAME).then((cache) => cache.put(req, copy)).catch(() => {});
        return res;
      })
      .catch(() => caches.match(req).then((cached) => cached || caches.match("./index.html")))
  );
});

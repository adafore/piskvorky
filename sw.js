// sw.js – minimální service worker, jen aby appka splňovala podmínky pro
// "Nainstalovat" (Add to Home Screen / PWA) a fungovala i chvíli offline.
//
// Strategie: network-first (vždy se snaž stáhnout čerstvou verzi), a jen
// když síť selže, ber to z cache. Nezáměrně tak NIKDY neservíruje starý
// zaseklý JS jako hlavní zdroj, když je připojení k dispozici – to by u
// appky, co se bude časem opravovat, mohlo dělat víc škody než užitku.
//
// POZOR při přenasazení: pokud příště měníš app.js/style.css/atd., zvyš
// CACHE_NAME (např. na "piskvorky-v3") – jinak si prohlížeče uživatelů,
// co appku mají nainstalovanou, můžou nějakou dobu držet starou cache.
const CACHE_NAME = "piskvorky-v1";
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
      .catch(() => {}) // offline instalace / chybějící soubor appku nesmí rozbít
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
  // Jen vlastní (stejný origin) GET požadavky – Firestore/Firebase SDK
  // (jiné originy) necháváme čistě na síti, do těch service worker
  // vůbec nezasahuje.
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

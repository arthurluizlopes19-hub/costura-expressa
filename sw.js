// Service worker do Costura Expressa: deixa o app instalável e abre mesmo com internet fraca.
// Arquivos do próprio site: tenta a rede primeiro (sempre a versão mais nova) e usa a cópia guardada se cair.
// Banco de dados e outros sites (Firebase, fontes) passam direto, sem cache.
const CACHE = "costura-expressa-v1";
const ARQUIVOS = [
  "./",
  "./index.html",
  "./firebase-config.js",
  "./jsQR.min.js",
  "./qrcode.min.js",
  "./logo-costura-expressa.png",
  "./manifest.webmanifest",
  "./icons/icon-192.png",
  "./icons/icon-512.png"
];

self.addEventListener("install", (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(ARQUIVOS)).then(() => self.skipWaiting()));
});

self.addEventListener("activate", (e) => {
  e.waitUntil(
    caches.keys()
      .then((ks) => Promise.all(ks.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener("fetch", (e) => {
  const req = e.request;
  if (req.method !== "GET") return;
  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return;
  e.respondWith(
    fetch(req)
      .then((res) => {
        if (res && res.ok) {
          const copia = res.clone();
          caches.open(CACHE).then((c) => c.put(req, copia));
        }
        return res;
      })
      .catch(() =>
        caches.match(req).then((r) => r || (req.mode === "navigate" ? caches.match("./index.html") : undefined))
      )
  );
});

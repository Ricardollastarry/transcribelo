/* Guarda la app en el dispositivo para que abra rápido y también sin conexión.
   (La transcripción en directo sí necesita internet; grabar solo audio, no.) */
const CACHE = 'transcribelo-v2';
const SHELL = ['./', 'index.html', 'styles.css?v=2', 'app.js?v=2', 'manifest.webmanifest',
  'icons/icon.svg',
  'https://cdnjs.cloudflare.com/ajax/libs/jspdf/2.5.1/jspdf.umd.min.js'];
self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting()));
});
self.addEventListener('activate', (e) => {
  e.waitUntil(caches.keys().then((ks) => Promise.all(ks.filter((k) => k !== CACHE && k.startsWith('transcribelo-v')).map((k) => caches.delete(k))))
    .then(() => self.clients.claim()));
});
self.addEventListener('fetch', (e) => {
  if (e.request.method !== 'GET') return;
  const url = new URL(e.request.url);
  if (url.origin !== location.origin && url.host !== 'cdnjs.cloudflare.com') return;
  // Red primero (para recibir mejoras); si no hay conexión, lo guardado
  e.respondWith(
    Promise.race([fetch(e.request), new Promise((_, no) => setTimeout(() => no(new Error('lento')), 3000))]).then((r) => {
      if (r && r.ok) { const copy = r.clone(); caches.open(CACHE).then((c) => c.put(e.request, copy)); }
      return r;
    }).catch(() => caches.match(e.request).then((m) => m || caches.match(e.request, { ignoreSearch: true })).then((m) => m || caches.match('index.html')))
  );
});

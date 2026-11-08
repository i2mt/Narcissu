const SHELL_CACHE = 'narcissu-shell-v36';
const ASSET_CACHE = 'narcissu-assets-v2';
const SHELL_FILES = [
  './', './index.html', './styles.css', './app.js', './manifest.webmanifest',
  './data/story-gp32.json', './data/asset-manifest.json', './data/localization/fa.json',
  './data/localization/fa-historical-alignment-increment28.json',
  './data/localization/fa-revised-overlay-increment17.json',
  './data/localization/fa-revised-overlay-increment19.json',
  './data/localization/fa-revised-overlay-recovery.json',
  './data/localization/fa-revised-overlay-increment20.json',
  './data/localization/fa-recovered-chapter2-increment21.json',
  './data/localization/fa-recovered-chapter3-increment22.json',
  './data/localization/fa-recovered-chapter4-increment23.json',
  './data/localization/fa-recovered-chapter4-page44-increment24.json',
  './data/localization/fa-recovered-chapter4-page45-increment25.json',
  './data/localization/fa-recovered-chapter4-pages46-50-increment26.json',
  './data/localization/fa-recovered-chapter1-chapter3-increment27.json',
  './data/localization/fa-literary-proofread-increment29.json',
  './data/localization/fa-literary-proofread-increment30.json',
  './data/localization/fa-literary-proofread-increment31.json',
  './data/localization/fa-literary-proofread-increment32.json',
  './data/localization/fa-literary-proofread-increment33.json',
  './data/localization/fa-literary-proofread-increment34.json',
  './data/localization/fa-literary-proofread-increment35.json',
  './data/localization/fa-assistant-editorial-review-increment38.json',
  './fonts/NotoSans-Regular.ttf', './fonts/NotoSansArabic-Regular.ttf',
  './icons/narcissu-192.png', './icons/narcissu-512.png'
];
self.addEventListener('install', event => {
  event.waitUntil(caches.open(SHELL_CACHE).then(cache => cache.addAll(SHELL_FILES)).then(() => self.skipWaiting()));
});
self.addEventListener('activate', event => {
  event.waitUntil(caches.keys().then(keys => Promise.all(keys.filter(k => ![SHELL_CACHE, ASSET_CACHE].includes(k)).map(k => caches.delete(k)))).then(() => self.clients.claim()));
});
self.addEventListener('fetch', event => {
  const req = event.request;
  if (req.method !== 'GET' || new URL(req.url).origin !== self.location.origin) return;
  const url = new URL(req.url);
  if (url.pathname.includes('/assets/')) {
    event.respondWith(caches.open(ASSET_CACHE).then(async cache => {
      const cached = await cache.match(req);
      if (cached) return cached;
      try { const response = await fetch(req); if (response.ok) await cache.put(req, response.clone()); return response; }
      catch (err) { return new Response('Offline asset not cached yet.', {status: 503, statusText: 'Offline'}); }
    }));
    return;
  }
  event.respondWith(caches.match(req).then(async cached => {
    if (cached) return cached;
    try { const response = await fetch(req); if (response.ok && url.origin === self.location.origin) { const cache = await caches.open(SHELL_CACHE); cache.put(req, response.clone()); } return response; }
    catch (err) { return caches.match('./index.html'); }
  }));
});

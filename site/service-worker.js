const SHELL_CACHE = 'narcissu-shell-v46';
const ASSET_CACHE = 'narcissu-assets-v4';
const FONT_CACHE = 'narcissu-fonts-v1';
const FONT_HOSTS = new Set(['fonts.googleapis.com', 'fonts.gstatic.com']);
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
  './fonts/NotoSans-Regular.ttf', './fonts/NotoSansArabic-Regular.ttf', './fonts/NotoNaskhArabic-Regular.ttf', './fonts/NotoNaskhArabic-SemiBold.ttf', './fonts/Noto-Font-License.txt',
  './icons/narcissu-192.png', './icons/narcissu-512.png', './icons/fox-emblem-white.png'
];
self.addEventListener('install', event => {
  event.waitUntil(caches.open(SHELL_CACHE).then(cache => cache.addAll(SHELL_FILES)).then(() => self.skipWaiting()));
});
self.addEventListener('activate', event => {
  event.waitUntil(caches.keys().then(keys => Promise.all(keys.filter(k => k.startsWith('narcissu-') && ![SHELL_CACHE, ASSET_CACHE, FONT_CACHE].includes(k)).map(k => caches.delete(k)))).then(() => self.clients.claim()));
});
async function makeRangeResponse(fullResponse, rangeHeader) {
  const match = /^bytes=(\d*)-(\d*)$/i.exec(rangeHeader || '');
  if (!match) return fullResponse;
  const bytes = await fullResponse.clone().arrayBuffer();
  const total = bytes.byteLength;
  let start;
  let end;
  if (match[1] === '') {
    const suffixLength = Number(match[2]);
    if (!Number.isFinite(suffixLength) || suffixLength <= 0) {
      return new Response(null, { status: 416, headers: { 'Content-Range': `bytes */${total}` } });
    }
    start = Math.max(0, total - suffixLength);
    end = total - 1;
  } else {
    start = Number(match[1]);
    end = match[2] === '' ? total - 1 : Math.min(Number(match[2]), total - 1);
  }
  if (!Number.isFinite(start) || start < 0 || start >= total || end < start) {
    return new Response(null, { status: 416, headers: { 'Content-Range': `bytes */${total}` } });
  }
  const headers = new Headers(fullResponse.headers);
  // The cached body is already decoded by Fetch; do not retain stale transfer headers.
  headers.delete('Content-Encoding');
  headers.delete('Content-Range');
  headers.delete('Transfer-Encoding');
  headers.set('Accept-Ranges', 'bytes');
  headers.set('Content-Range', `bytes ${start}-${end}/${total}`);
  headers.set('Content-Length', String(end - start + 1));
  return new Response(bytes.slice(start, end + 1), { status: 206, statusText: 'Partial Content', headers });
}

async function handleFontRequest(request) {
  const cache = await caches.open(FONT_CACHE);
  const cached = await cache.match(request);
  if (cached) return cached;
  try {
    const response = await fetch(request);
    // Google Fonts serves CORS-enabled CSS and WOFF2 resources. Opaque responses
    // are deliberately not cached; the app keeps its bundled Noto fallback.
    if (response.ok && response.type !== 'opaque') {
      try { await cache.put(request, response.clone()); }
      catch (cacheError) { console.warn('Could not cache Persian font resource:', request.url, cacheError); }
    }
    return response;
  } catch (error) {
    if (cached) return cached;
    return new Response('Persian font is not cached yet.', { status: 503, statusText: 'Offline' });
  }
}

async function handleAssetRequest(request) {
  const cache = await caches.open(ASSET_CACHE);
  const fullRequest = new Request(request.url, { method: 'GET' });
  const rangeHeader = request.headers.get('range');
  const cachedFull = await cache.match(fullRequest);

  if (rangeHeader) {
    try {
      const response = await fetch(request);
      // Pass network partial responses through unchanged; Cache API must never store status 206.
      if (response.status === 206 || response.ok) return response;
      if (response.status >= 500 && cachedFull) return makeRangeResponse(cachedFull, rangeHeader);
      return response;
    } catch (error) {
      if (cachedFull) return makeRangeResponse(cachedFull, rangeHeader);
      return new Response('Offline asset not cached yet.', { status: 503, statusText: 'Offline' });
    }
  }

  if (cachedFull) return cachedFull;
  try {
    const response = await fetch(request);
    if (response.status === 200 && response.ok) {
      try { await cache.put(fullRequest, response.clone()); }
      catch (cacheError) { console.warn('Could not cache complete media asset:', request.url, cacheError); }
    }
    return response;
  } catch (error) {
    if (cachedFull) return cachedFull;
    return new Response('Offline asset not cached yet.', { status: 503, statusText: 'Offline' });
  }
}

self.addEventListener('fetch', event => {
  const req = event.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (FONT_HOSTS.has(url.hostname)) {
    event.respondWith(handleFontRequest(req));
    return;
  }
  if (url.origin !== self.location.origin) return;
  if (url.pathname.includes('/assets/') || url.pathname.includes('/mobile-assets/')) {
    event.respondWith(handleAssetRequest(req));
    return;
  }
  event.respondWith(caches.match(req).then(async cached => {
    if (cached) return cached;
    try {
      const response = await fetch(req);
      if (response.ok && response.status === 200 && url.origin === self.location.origin) {
        const cache = await caches.open(SHELL_CACHE);
        try { await cache.put(req, response.clone()); } catch (cacheError) {
          console.warn('Could not cache shell response:', req.url, cacheError);
        }
      }
      return response;
    } catch (err) {
      return caches.match('./index.html');
    }
  }));
});

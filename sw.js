// Offline support: the page itself is fetched network-first so updates show up straight away;
// everything else (samples, icons, fonts) is served from the cache and refreshed in the background.
const CACHE = 'caries-depth-v4';
const SAMPLES = ['dentin-middle', 'sound', 'enamel', 'dentin-deep', 'pulp', 'tester-1', 'tester-2', 'tester-3',
  'xray-enamel', 'xray-dentin', 'xray-pulp', 'xray-sound', 'opg', 'bitewing', 'premolar-dentin', 'incisor-dentin'];
const SHELL = ['./', 'index.html', 'manifest.webmanifest', 'css/app.css', 'js/templates.js', 'js/engine.js', 'js/analysis.js', 'js/worker.js', 'js/scan.js', 'js/app.js', 'js/xray.js', 'js/whole.js', 'js/upload.js', 'js/app-start.js', 'js/ai.js', 'icons/icon-192.png', 'icons/icon-512.png',
  ...SAMPLES.flatMap((s) => [`samples/${s}.jpg`, `samples/${s}-thumb.jpg`])];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting()));
});
self.addEventListener('activate', (e) => {
  e.waitUntil(caches.keys()
    .then((keys) => Promise.all(keys.filter((k) => k !== CACHE && k !== 'caries-share').map((k) => caches.delete(k))))
    .then(() => self.clients.claim()));
});
self.addEventListener('fetch', (e) => {
  const req = e.request;
  // "Share" from the phone's gallery into the installed app: keep the image, then open the page
  if (req.method === 'POST' && new URL(req.url).pathname.endsWith('/share-target')) {
    e.respondWith((async () => {
      try {
        const form = await req.formData(), file = form.get('image');
        if (file && file.size) await (await caches.open('caries-share')).put('shared-image', new Response(file, { headers: { 'content-type': file.type || 'image/jpeg' } }));
      } catch (err) { /* open the page anyway */ }
      return Response.redirect('./?shared=1', 303);
    })());
    return;
  }
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  const cacheable = url.origin === location.origin || /fonts\.(googleapis|gstatic)\.com$/.test(url.hostname);
  if (!cacheable) return;
  if (req.mode === 'navigate') {
    e.respondWith(fetch(req).then((res) => {
      const copy = res.clone();
      caches.open(CACHE).then((c) => c.put(req, copy));
      return res;
    }).catch(() => caches.match(req).then((r) => r || caches.match('index.html'))));
    return;
  }
  e.respondWith(caches.match(req).then((hit) => {
    const net = fetch(req).then((res) => {
      if (res.ok || res.type === 'opaque') { const copy = res.clone(); caches.open(CACHE).then((c) => c.put(req, copy)); }
      return res;
    }).catch(() => hit);
    return hit || net;
  }));
});

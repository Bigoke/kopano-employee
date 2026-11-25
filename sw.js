/* Kopano Employee web app: keeps the app's own files so it opens without a connection. Calls to Supabase are never
   cached (they go straight to the company's project). The cache name changes with every build, so an update is
   picked up the next time the app is opened. */
var CACHE = 'kopano-employee-1.56.0-032a0a02d2';
var FILES = ["./", "app.js", "apple-touch-icon.png", "favicon.png", "holidays.js", "i18n.js", "icon-192.png", "icon-512.png", "icon-maskable-512.png", "index.html", "kopano-icon.svg", "live.js", "manifest.webmanifest", "pwa.js", "style.css", "vendor/jsQR.js", "web.css"];
self.addEventListener('install', function (ev) {
  ev.waitUntil(caches.open(CACHE).then(function (c) { return c.addAll(FILES); }).then(function () { return self.skipWaiting(); }));
});
self.addEventListener('activate', function (ev) {
  ev.waitUntil(caches.keys().then(function (keys) {
    return Promise.all(keys.filter(function (k) { return k !== CACHE; }).map(function (k) { return caches.delete(k); }));
  }).then(function () { return self.clients.claim(); }));
});
self.addEventListener('fetch', function (ev) {
  var req = ev.request, url = new URL(req.url);
  if (req.method !== 'GET' || url.origin !== self.location.origin) return;
  // the newest files when online, the kept ones when offline
  ev.respondWith(fetch(req).then(function (res) {
    if (res.ok) { var copy = res.clone(); caches.open(CACHE).then(function (c) { c.put(req, copy); }); }
    return res;
  }).catch(function () {
    return caches.match(req, { ignoreSearch: true }).then(function (hit) { return hit || caches.match('./index.html'); });
  }));
});

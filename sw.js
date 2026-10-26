// Retirement worker. Replaces the app worker that phones already installed.
// ES5 on purpose: it has to parse on the same older WebViews as the worker it replaces.
// It deletes the app's caches, forces a fresh network load of the retired page, then unregisters.
var RETIRED = '<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Unavailable</title></head><body style="margin:0;min-height:100vh;display:flex;align-items:center;justify-content:center;background:#f2f4f7;color:#1c2430;font-family:-apple-system,BlinkMacSystemFont,sans-serif"><main style="max-width:28rem;padding:2rem;text-align:center"><h1 style="font-size:1.25rem;font-weight:600">This tool is no longer available</h1></main></body></html>';

function purge() {
  return caches.keys().then(function (keys) {
    return Promise.all(keys.filter(function (k) { return k.indexOf('orp-') === 0; }).map(function (k) { return caches.delete(k); }));
  });
}

self.addEventListener('install', function (e) {
  // Do not cache the app shell. Take over as soon as this file is installed.
  e.waitUntil(self.skipWaiting());
});

self.addEventListener('activate', function (e) {
  // Claim, drop caches, and reload open windows. Do not wait on those reloads:
  // waiting would deadlock, because the reload is fetched through this worker.
  e.waitUntil(purge().then(function () {
    return self.clients.claim();
  }).then(function () {
    return self.clients.matchAll({ type: 'window', includeUncontrolled: true });
  }).then(function (list) {
    list.forEach(function (c) {
      if (typeof c.navigate === 'function') c.navigate(c.url).catch(function () {});
    });
  }));
});

self.addEventListener('fetch', function (e) {
  // Only documents. Other requests (scripts, images) are left to the browser so a
  // still-cached app shell cannot be served from here.
  if (e.request.mode !== 'navigate' && e.request.destination !== 'document') return;
  e.respondWith(purge().then(function () {
    return fetch(e.request, { cache: 'reload' }).then(function (res) {
      // A missing subpath comes back as GitHub's 404 page. Some browsers will not
      // paint an error status for a navigation this worker answered, so return the
      // same HTML as a normal page. Successful responses (the retired page at the
      // root, and any real file) pass through untouched.
      if (res.ok) return res;
      return res.text().then(function (html) {
        return new Response(html || RETIRED, {
          status: 200,
          headers: { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' }
        });
      });
    }).catch(function () {
      return new Response(RETIRED, {
        status: 200,
        headers: { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' }
      });
    });
  }).then(function (res) {
    // Unregister after this document is on its way, so the next open is a normal
    // network load of the retired page and this worker is not left behind.
    self.registration.unregister();
    return res;
  }));
});

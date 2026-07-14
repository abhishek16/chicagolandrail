// App-shell cache (cache-first) + API passthrough with cached fallback.
// The API is on a different origin (the Worker); we don't cache cross-origin
// API responses in the SW — the app keeps its own last-good copy in memory.
const SHELL = "mct-shell-v5";
const SHELL_ASSETS = ["./", "./index.html", "./app.js", "./app.css", "./logic.js", "./config.js", "./manifest.webmanifest", "./icons/icon128.png", "./icons/icon32.png"];

self.addEventListener("install", e => {
  e.waitUntil(caches.open(SHELL).then(c => c.addAll(SHELL_ASSETS)).then(() => self.skipWaiting()));
});
self.addEventListener("activate", e => {
  e.waitUntil(
    caches.keys().then(keys => Promise.all(keys.filter(k => k !== SHELL).map(k => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});
self.addEventListener("fetch", e => {
  const url = new URL(e.request.url);
  if (url.origin !== location.origin) return; // let cross-origin API calls pass straight through
  e.respondWith(caches.match(e.request).then(hit => hit || fetch(e.request)));
});

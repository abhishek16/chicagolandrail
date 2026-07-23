// App-shell cache (cache-first) + API passthrough with cached fallback.
// The API is on a different origin (the Worker); we don't cache cross-origin
// API responses in the SW — the app keeps its own last-good copy in memory.
const SHELL = "mct-shell-v60";
const SHELL_ASSETS = [
  "./", "./index.html", "./app.js", "./app.css", "./logic.js", "./config.js", "./map.js", "./fonts.css",
  "./manifest.webmanifest", "./icons/icon192.png", "./icons/icon128.png", "./icons/icon32.png",
  "./fonts/overpass-400.woff2", "./fonts/overpass-600.woff2", "./fonts/overpass-700.woff2",
  "./fonts/overpass-mono-500.woff2", "./fonts/overpass-mono-700.woff2",
];

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

// ---- background push (works when the app is closed; installed PWA required) ----
self.addEventListener("push", e => {
  let d = {};
  try { d = e.data ? e.data.json() : {}; } catch { d = { body: e.data && e.data.text() }; }
  e.waitUntil(self.registration.showNotification(d.title || "Chicagoland Rail", {
    body: d.body || "",
    icon: "./icons/icon192.png",
    badge: "./icons/icon32.png",
    tag: d.tag,
    data: { url: d.url || "./" },
  }));
});
self.addEventListener("notificationclick", e => {
  e.notification.close();
  const target = (e.notification.data && e.notification.data.url) || "./";
  e.waitUntil(self.clients.matchAll({ type: "window", includeUncontrolled: true }).then(cs => {
    for (const c of cs) if ("focus" in c) return c.focus();
    return self.clients.openWindow(target);
  }));
});

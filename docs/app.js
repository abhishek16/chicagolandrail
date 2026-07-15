import { DEFAULT_SETTINGS, resolveDirection, overrideExpiry, expressHint, fmtCountdown, fmtLive } from "./logic.js";
import { API_BASE } from "./config.js";

const $ = s => document.querySelector(s);
const POLL_MS = 30000;

// ---------- state ----------
const store = {
  load() {
    try { return JSON.parse(localStorage.getItem("mct") || "{}"); } catch { return {}; }
  },
  save(s) { localStorage.setItem("mct", JSON.stringify(s)); },
};
let S = Object.assign({ routes: [], activeRouteId: null, settings: null, override: { active: false }, notify: false, reminders: [], briefing: null }, store.load());
const persist = () => store.save(S);

let lines = [], stations = [], lastData = {}, lastSeen = new Map(), pollTimer = null, tickTimer = null;
let ttDate = null;               // null = live board; "YYYY-MM-DD" = schedule for that day
let swReg = null;                // service-worker registration, for OS notifications
let notifiedAlerts = new Set();  // alert ids we've already notified about
let expandedStops = {};          // direction -> whether the hero's stop list is open
let meta = null;                 // /api/meta freshness, for the stale-data warning
let weatherCache = new Map();    // stationId -> { periods, at }
let oneOff = null;               // transient one-off trip (not saved), overrides active route
let ooStations = [];             // stations for the one-off line picker

// ---------- persistent offline cache (survives reload/underground) ----------
const cacheKey = id => "mct_cache_" + id;
function saveCache() {
  const r = activeRoute(); if (!r) return;
  try { localStorage.setItem(cacheKey(r.id), JSON.stringify({ data: lastData, savedAt: Date.now() })); } catch { /* quota */ }
}
function loadCache() {
  const r = activeRoute();
  lastData = {};
  if (!r) return;
  try {
    const c = JSON.parse(localStorage.getItem(cacheKey(r.id)) || "null");
    if (c && c.data) lastData = c.data;
  } catch { /* corrupt */ }
}
// Whole days since the GTFS static feed was last ingested (null if unknown).
function metaStaleDays() {
  if (!meta || !meta.ingestedAt) return null;
  return Math.floor((Date.now() - new Date(meta.ingestedAt).getTime()) / 86400000);
}

// Metra's per-line service-update accounts on X (twitter). Falls back to @Metra.
const X_HANDLES = {
  BNSF: "metraBNSF", "MD-N": "metraMDN", "MD-W": "metraMDW",
  "UP-N": "metraUPN", "UP-NW": "metraUPNW", "UP-W": "metraUPW",
  ME: "metraME", RI: "metraRI", SWS: "metraSWS", NCS: "metraNCS", HC: "metraHC",
};

// ---------- boot ----------
init();
async function init() {
  if ("serviceWorker" in navigator) navigator.serviceWorker.register("./sw.js").then(r => swReg = r).catch(() => {});
  try { lines = await api("/api/lines"); } catch { lines = []; }
  api("/api/meta").then(m => { meta = m; }).catch(() => {}); // for stale-data warning
  if (!activeRoute()) showSetup(); else showMain();
  syncPush(); // refresh push subscription + line list on load
}

function activeRoute() { return oneOff || S.routes.find(r => r.id === S.activeRouteId) || S.routes[0] || null; }
function settings() { return S.settings || DEFAULT_SETTINGS; }

// One quick retry with backoff smooths over cell-network blips on the train.
async function api(path, retries = 1) {
  for (let attempt = 0; ; attempt++) {
    try {
      const res = await fetch(API_BASE + path);
      if (!res.ok) throw new Error(`${path} → ${res.status}`);
      return await res.json();
    } catch (e) {
      if (attempt >= retries) throw e;
      await new Promise(r => setTimeout(r, 700 * (attempt + 1)));
    }
  }
}

async function apiPost(path, body) {
  const res = await fetch(API_BASE + path, {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`${path} → ${res.status}`);
  return res.json();
}

// ---------- background push (Web Push) ----------
function urlB64ToUint8(b64) {
  const pad = "=".repeat((4 - (b64.length % 4)) % 4);
  const s = (b64 + pad).replace(/-/g, "+").replace(/_/g, "/");
  const raw = atob(s);
  return Uint8Array.from([...raw].map(c => c.charCodeAt(0)));
}

// Subscribe (or refresh the subscribed line list) for background alerts.
async function subscribePush() {
  try {
    if (!("Notification" in window) || Notification.permission !== "granted") return;
    const reg = swReg || await navigator.serviceWorker.ready;
    if (!reg || !reg.pushManager) return;
    const { key } = await api("/api/push/key");
    if (!key) return;
    let sub = await reg.pushManager.getSubscription();
    if (!sub) sub = await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: urlB64ToUint8(key) });
    await apiPost("/api/push/subscribe", {
      subscription: sub.toJSON(),
      lines: [...new Set(S.routes.map(r => r.line))],
      reminders: S.reminders || [],
      briefing: S.briefing || null,
    });
  } catch { /* push unsupported/blocked — in-page notifications still work */ }
}

async function unsubscribePush() {
  try {
    const reg = swReg || await navigator.serviceWorker.ready;
    const sub = reg && reg.pushManager && await reg.pushManager.getSubscription();
    if (sub) { await apiPost("/api/push/unsubscribe", { endpoint: sub.endpoint }); await sub.unsubscribe(); }
  } catch { /* ignore */ }
}

// Keep the server's line list current whenever routes change (if alerts are on).
function syncPush() {
  if (S.notify && "Notification" in window && Notification.permission === "granted") subscribePush();
}

function lineColor(routeLine) {
  const l = lines.find(x => x.id === routeLine);
  return l ? l.color : "#005A45";
}
// "BNSF — Burlington Northern" so riders recognize the code and the full name.
function lineLabel(l) { return `${l.id} — ${l.name}`; }

// ============================================================
// SETUP VIEW
// ============================================================
function showSetup() {
  swapView("setup");
  const sel = $("#line");
  sel.innerHTML = `<option value="">Choose a line…</option>` +
    lines.map(l => `<option value="${l.id}">${esc(lineLabel(l))}</option>`).join("");
  if (!lines.length) $("#form-error").textContent = "Could not load lines — is the ingest done and KV bound?", $("#form-error").classList.remove("hidden");

  sel.onchange = async () => {
    stations = [];
    if (!sel.value) return;
    $("#home-list").innerHTML = $("#work-list").innerHTML = "";
    const data = await api(`/api/stops?route=${encodeURIComponent(sel.value)}`);
    stations = data.stations;
    const opts = stations.map(s => `<option value="${esc(s.name)}">`).join("");
    $("#home-list").innerHTML = opts; $("#work-list").innerHTML = opts;
  };

  const st = settings();
  $("#m0").value = st.morningWindow[0]; $("#m1").value = st.morningWindow[1];
  $("#e0").value = st.eveningWindow[0]; $("#e1").value = st.eveningWindow[1];
  ["m0", "m1", "e0", "e1"].forEach(id => $("#" + id).onchange = saveWindows); // auto-save, no button
  $("#notif-toggle").checked = !!S.notify;
  $("#notif-note").textContent = ("Notification" in window)
    ? "Get alerts for new delays, cancellations, and service alerts — even when the app is closed. On iPhone, first add this app to your Home Screen from Safari."
    : "This browser doesn't support notifications.";

  // One-off trip picker (transient, not saved).
  const ooSel = $("#oo-line");
  ooSel.innerHTML = `<option value="">Choose a line…</option>` +
    lines.map(l => `<option value="${l.id}">${esc(lineLabel(l))}</option>`).join("");
  ooSel.onchange = async () => {
    ooStations = []; $("#oo-from-list").innerHTML = $("#oo-to-list").innerHTML = "";
    if (!ooSel.value) return;
    try { ooStations = (await api(`/api/stops?route=${encodeURIComponent(ooSel.value)}`)).stations; } catch { ooStations = []; }
    const opts = ooStations.map(s => `<option value="${esc(s.name)}">`).join("");
    $("#oo-from-list").innerHTML = opts; $("#oo-to-list").innerHTML = opts;
  };
  $("#oo-go").onclick = () => {
    const err = $("#oo-error"); err.classList.add("hidden");
    const fail = m => { err.textContent = m; err.classList.remove("hidden"); };
    const find = name => {
      const n = (name || "").trim().toLowerCase(); if (!n) return null;
      return ooStations.find(s => s.name.toLowerCase() === n) || ooStations.find(s => s.name.toLowerCase().includes(n));
    };
    const line = ooSel.value, from = find($("#oo-from").value), to = find($("#oo-to").value);
    if (!line || !from || !to) return fail("Pick a line and valid from & to stations.");
    if (from.id === to.id) return fail("From and to must be different.");
    oneOff = { id: "__oneoff", line, home: from.id, homeName: from.name, work: to.id, workName: to.name, label: `${from.name} → ${to.name}` };
    showMain();
  };

  renderRouteList();
  $("#save-route").onclick = saveRoute;
  $("#setup-done").onclick = () => { if (activeRoute()) showMain(); };
  $("#notif-toggle").onchange = async e => {
    if (e.target.checked) {
      if (Notification.permission !== "granted") {
        const p = await Notification.requestPermission();
        if (p !== "granted") { e.target.checked = false; return; }
      }
      S.notify = true; persist();
      await subscribePush();
    } else {
      S.notify = false; persist();
      await unsubscribePush();
    }
  };
  try { setupReminders(); } catch (e) { console.error("reminders setup failed", e); }
  try { setupBriefing(); } catch (e) { console.error("briefing setup failed", e); }
}

// ---------- departure reminders (setup UI) ----------
function setupReminders() {
  const routeSel = $("#rem-route");
  const hasRoutes = S.routes.length > 0;
  routeSel.innerHTML = hasRoutes
    ? S.routes.map(r => `<option value="${r.id}">${esc(r.label)}</option>`).join("")
    : `<option value="">— save a route first —</option>`;
  let remTrains = []; // trains currently in the dropdown, looked up by value on add

  const loadTrains = async () => {
    const trainSel = $("#rem-train");
    remTrains = [];
    const r = S.routes.find(x => x.id === routeSel.value);
    if (!r) { trainSel.innerHTML = `<option value="">—</option>`; return; }
    const [from, to] = $("#rem-dir").value === "HW" ? [r.home, r.work] : [r.work, r.home];
    trainSel.innerHTML = `<option value="">Loading…</option>`;
    try {
      const data = await api(`/api/timetable?route=${encodeURIComponent(r.line)}&from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}&date=today`);
      remTrains = (data.trains || []).filter(t => t.depSec != null);
      trainSel.innerHTML = remTrains.length
        ? remTrains.map(t => `<option value="${t.depSec}">${esc(t.dep)} · ${t.class === "E" ? "Express" : "Local"} · Train ${esc(trainNoShort(t.trainNo))}</option>`).join("")
        : `<option value="">No trains found for this route</option>`;
    } catch { trainSel.innerHTML = `<option value="">Couldn't load trains — check connection</option>`; }
  };
  routeSel.onchange = loadTrains;
  $("#rem-dir").onchange = loadTrains;
  if (hasRoutes) loadTrains();

  $("#rem-add").onclick = () => {
    const err = $("#rem-error");
    const show = m => { err.textContent = m; err.classList.remove("hidden"); };
    err.classList.add("hidden");
    const r = S.routes.find(x => x.id === routeSel.value);
    if (!r) return show("Save a route above first, then set a reminder for it.");
    const trainSel = $("#rem-train");
    const depSec = Number(trainSel.value);          // read .value directly (reliable on iOS)
    const t = remTrains.find(x => Number(x.depSec) === depSec);
    if (!trainSel.value || !t) return show(remTrains.length ? "Choose a train from the list." : "Train list is still loading — try again in a moment.");
    const [from, to, fromName, toName] = $("#rem-dir").value === "HW"
      ? [r.home, r.work, r.homeName, r.workName]
      : [r.work, r.home, r.workName, r.homeName];
    S.reminders = S.reminders || [];
    S.reminders.push({
      id: "rem" + Date.now(), routeId: r.id, line: r.line,
      from, to, fromName, toName,
      depSec, trainNo: trainNoShort(t.trainNo), depLabel: t.dep,
      lead: Number($("#rem-lead").value),
      days: $("#rem-days").value === "all" ? [0, 1, 2, 3, 4, 5, 6] : [1, 2, 3, 4, 5],
    });
    persist(); renderReminderList(); syncPush();
    if (!S.notify) show("Reminder saved — turn on Notifications above to actually receive it.");
  };
  renderReminderList();
}

function renderReminderList() {
  const el = $("#reminder-list"); if (!el) return;
  el.innerHTML = (S.reminders || []).map(rem => `
    <div class="route-item">
      <div class="ri-main"><div class="name">${esc(rem.depLabel)} · Train ${esc(rem.trainNo)}</div>
        <div class="sub">${esc(rem.fromName)} → ${esc(rem.toName)} · ${rem.lead}m before · ${rem.days.length === 7 ? "daily" : "weekdays"}</div></div>
      <button class="ghost danger" data-id="${rem.id}">Remove</button>
    </div>`).join("");
  el.querySelectorAll("[data-id]").forEach(b => b.onclick = () => {
    S.reminders = (S.reminders || []).filter(x => x.id !== b.dataset.id);
    persist(); renderReminderList(); syncPush();
  });
}

// ---------- morning briefing (setup UI) ----------
function setupBriefing() {
  const routeSel = $("#brief-route");
  const hasRoutes = S.routes.length > 0;
  routeSel.innerHTML = hasRoutes
    ? S.routes.map(r => `<option value="${r.id}">${esc(r.label)}</option>`).join("")
    : `<option value="">— save a route first —</option>`;
  const b = S.briefing;
  $("#brief-toggle").checked = !!(b && b.enabled);
  if (b) { $("#brief-time").value = b.time || "06:45"; if (b.routeId) routeSel.value = b.routeId; }
  const note = m => { const el = $("#brief-note"); if (el) el.textContent = m; };

  const save = () => {
    const enabled = $("#brief-toggle").checked;
    if (enabled && !hasRoutes) { $("#brief-toggle").checked = false; note("Save a route above first to get a briefing."); return; }
    const r = S.routes.find(x => x.id === routeSel.value) || S.routes[0];
    const time = $("#brief-time").value || "06:45";
    const [h, m] = time.split(":").map(Number);
    S.briefing = enabled && r
      ? { enabled: true, time, timeSec: h * 3600 + m * 60, routeId: r.id, line: r.line,
          from: r.home, to: r.work, fromName: r.homeName, toName: r.workName, days: [1, 2, 3, 4, 5] }
      : null;
    persist(); syncPush();
    note(enabled && r
      ? `On — ${fmtTime12(time)} on weekdays, ${r.label}.${S.notify ? "" : " Turn on Notifications above to receive it."}`
      : "Off.");
  };
  $("#brief-toggle").onchange = save;
  $("#brief-time").onchange = save;
  routeSel.onchange = save;
  note(b && b.enabled ? `On — ${fmtTime12(b.time || "06:45")} on weekdays.` : "Off.");
}

function fmtTime12(hhmm) {
  const [h, m] = String(hhmm).split(":").map(Number);
  return `${h % 12 || 12}:${String(m).padStart(2, "0")} ${h < 12 ? "AM" : "PM"}`;
}

function findStation(name) {
  const n = (name || "").trim().toLowerCase();
  if (!n) return null; // empty input must not match the first station via .includes("")
  return stations.find(s => s.name.toLowerCase() === n) || stations.find(s => s.name.toLowerCase().includes(n));
}

// Returns true if a route was saved, false (with an inline error) if not.
function saveRoute() {
  const err = $("#form-error"); err.classList.add("hidden");
  const line = $("#line").value, home = findStation($("#home").value), work = findStation($("#work").value);
  const fail = m => { err.textContent = m; err.classList.remove("hidden"); return false; };
  if (!line || !home || !work) return fail("Pick a line and valid home & work stations.");
  if (home.id === work.id) return fail("Home and work stations must be different.");
  if (S.routes.length >= 5) return fail("Route limit reached (5). Remove one first.");
  const r = {
    id: "r" + Date.now(), line,
    home: home.id, homeName: home.name,
    work: work.id, workName: work.name,
    label: $("#label").value.trim() || `${home.name} ↔ ${work.name}`,
  };
  S.routes.push(r);
  S.activeRouteId = r.id; // the route you just added becomes the one you view
  persist();
  $("#home").value = $("#work").value = $("#label").value = "";
  syncPush();
  showMain(); // straight to the trains for the route you just saved
  return true;
}

function saveWindows() {
  S.settings = {
    ...settings(),
    morningWindow: [$("#m0").value || "05:00", $("#m1").value || "11:00"],
    eveningWindow: [$("#e0").value || "12:00", $("#e1").value || "23:59"],
  };
  persist();
}

function renderRouteList() {
  const el = $("#route-list");
  const has = S.routes.length;
  $("#route-count").textContent = has ? `(${S.routes.length}/5)` : "";
  el.innerHTML = has ? "" : `<p class="muted small">No routes yet — pick your line and stations below, then tap <b>Save route</b>.</p>`;
  const done = $("#setup-done");
  if (done) done.classList.toggle("hidden", !has);
  for (const r of S.routes) {
    const div = document.createElement("div");
    div.className = "route-item" + (r.id === S.activeRouteId ? " active" : "");
    div.innerHTML = `<div class="ri-main"><div class="name">${esc(r.label)}</div>
      <div class="sub">${esc(r.line)} · ${esc(r.homeName)} ↔ ${esc(r.workName)}${r.id === S.activeRouteId ? " · active" : ""}</div></div>
      <button class="ghost danger" data-a="del">Remove</button>
      <span class="ri-go" aria-hidden="true">›</span>`;
    // Tap the route to view its trains.
    div.querySelector(".ri-main").onclick = () => { oneOff = null; S.activeRouteId = r.id; persist(); showMain(); };
    div.querySelector(".ri-go").onclick = () => { oneOff = null; S.activeRouteId = r.id; persist(); showMain(); };
    div.querySelector('[data-a="del"]').onclick = e => {
      e.stopPropagation();
      S.routes = S.routes.filter(x => x.id !== r.id);
      if (S.activeRouteId === r.id) S.activeRouteId = S.routes[0]?.id || null;
      persist(); renderRouteList(); syncPush();
    };
    el.appendChild(div);
  }
}

// ============================================================
// MAIN VIEW
// ============================================================
function showMain() {
  swapView("main");
  const route = activeRoute();
  document.documentElement.style.setProperty("--line", lineColor(route.line));
  $("#route-picker").innerHTML =
    (oneOff ? `<option value="__oneoff" selected>One-off: ${esc(oneOff.label)}</option>` : "") +
    S.routes.map(r => `<option value="${r.id}" ${!oneOff && r.id === route.id ? "selected" : ""}>${esc(r.label)}</option>`).join("");
  $("#route-picker").onchange = e => {
    if (e.target.value === "__oneoff") return;
    oneOff = null;
    S.activeRouteId = e.target.value; persist(); lastSeen.clear(); notifiedAlerts.clear(); expandedStops = {}; showMain();
  };
  $("#settings-btn").onclick = () => { stopPolling(); showSetup(); };
  renderSocial(route);
  loadCache(); // hydrate last-good board so an offline open shows something
  startPolling();
}

// X (twitter) service-update feed for the active line — collapsed by default,
// embed loaded lazily on first expand, always with a plain link fallback.
function renderSocial(route) {
  const handle = X_HANDLES[route.line] || "Metra";
  $("#social").innerHTML = `
    <details class="social">
      <summary>&#128226; Service updates — <a href="https://x.com/${handle}" target="_blank" rel="noopener">@${handle}</a> on X</summary>
      <div class="social-body"><div class="muted small">Tap to load the latest posts…</div></div>
    </details>`;
  const det = $("#social details");
  det.addEventListener("toggle", () => { if (det.open) loadTimeline(det, handle); }, { once: true });
}

function loadTimeline(det, handle) {
  const body = det.querySelector(".social-body");
  const dark = window.matchMedia && window.matchMedia("(prefers-color-scheme: dark)").matches;
  body.innerHTML = `
    <a class="twitter-timeline" data-height="460" data-theme="${dark ? "dark" : "light"}"
       data-chrome="noheader nofooter transparent"
       href="https://twitter.com/${handle}?ref_src=twsrc%5Etfw">Posts by @${handle}</a>
    <p class="muted small social-fallback">Updates not showing? <a href="https://x.com/${handle}" target="_blank" rel="noopener">Open @${handle} on X →</a></p>`;
  loadWidgets()
    .then(() => window.twttr && window.twttr.widgets && window.twttr.widgets.load(body))
    .catch(() => {});
}

let widgetsPromise = null;
function loadWidgets() {
  if (window.twttr && window.twttr.widgets) return Promise.resolve();
  if (widgetsPromise) return widgetsPromise;
  widgetsPromise = new Promise((resolve, reject) => {
    const s = document.createElement("script");
    s.src = "https://platform.twitter.com/widgets.js";
    s.async = true; s.charset = "utf-8";
    s.onload = resolve; s.onerror = reject;
    document.head.appendChild(s);
  });
  return widgetsPromise;
}

// Segmented controls: view (live board / full schedule) + direction.
function renderControls(dir) {
  const r = activeRoute();
  const view = ttDate ? "schedule" : "live";
  $("#view-tabs").innerHTML = [["live", "● Live"], ["schedule", "🗓 Schedule"]]
    .map(([v, l]) => `<button data-v="${v}" class="${view === v ? "on" : ""}" role="tab" aria-selected="${view === v}">${l}</button>`).join("");
  $("#view-tabs").querySelectorAll("button").forEach(b =>
    b.onclick = () => { ttDate = b.dataset.v === "live" ? null : (ttDate || todayISO()); refresh(); });

  const opts = [
    ["BOTH", "&#8646; Both"],
    ["HW", `To ${esc(r.workName)}`],
    ["WH", `To ${esc(r.homeName)}`],
  ];
  $("#dir-tabs").innerHTML = opts
    .map(([v, l]) => `<button data-d="${v}" class="${dir === v ? "on" : ""}" role="tab" aria-selected="${dir === v}">${l}</button>`).join("");
  $("#dir-tabs").querySelectorAll("button").forEach(b => b.onclick = () => setDirection(b.dataset.d));
}

// Picking the natural direction clears the override; anything else pins the
// choice until the next direction-window boundary.
function setDirection(d) {
  const now = new Date();
  const modified = Object.values(lastData).some(x => x && x.serviceNote);
  const natural = resolveDirection(settings(), { active: false }, now, modified);
  S.override = d === natural
    ? { active: false }
    : { active: true, direction: d, expiresAt: overrideExpiry(settings(), now) };
  persist(); refresh();
}

function startPolling() {
  stopPolling();
  refresh();
  pollTimer = setInterval(() => { if (!document.hidden) refresh(); }, POLL_MS);
  tickTimer = setInterval(updateCountdowns, 1000);
  document.addEventListener("visibilitychange", onVisible);
}
function stopPolling() {
  clearInterval(pollTimer); clearInterval(tickTimer);
  document.removeEventListener("visibilitychange", onVisible);
}
function onVisible() { if (!document.hidden) refresh(); }

async function refresh() {
  const route = activeRoute();
  if (!route) return showSetup();

  const modified = Object.values(lastData).some(d => d && d.serviceNote);
  const dir = resolveDirection(settings(), S.override, new Date(), modified);
  const dirs = dir === "BOTH" ? ["HW", "WH"] : [dir];
  renderControls(dir);
  if (ttDate) return renderTimetable(dirs);

  let offline = false;
  for (const d of dirs) {
    const [from, to] = d === "HW" ? [route.home, route.work] : [route.work, route.home];
    try {
      const data = await api(`/api/next?route=${encodeURIComponent(route.line)}&from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}&count=3`);
      data.fetchedAt = Date.now();
      lastData[d] = data;
      maybeNotify(d, data);
    } catch {
      offline = true; // keep stale lastData[d] if we have it
    }
  }

  if (!offline) saveCache(); // persist last-good board for offline opens
  render(dirs, offline);
}

function render(dirs, offline) {
  const route = activeRoute();
  const first = lastData[dirs[0]];

  $("#route-title").innerHTML = dirs.length === 2
    ? `${esc(route.homeName)} <span class="arrow">⇆</span> ${esc(route.workName)}`
    : dirTitle(dirs[0]);

  // alerts (deduped across directions)
  const seen = new Set(); const alertHtml = [];
  for (const d of dirs) for (const a of (lastData[d]?.alerts || [])) {
    if (seen.has(a.id)) continue; seen.add(a.id);
    alertHtml.push(`<div class="alert">${esc(a.header)}${a.description ? ` — ${esc(a.description)}` : ""}</div>`);
  }
  $("#alerts").innerHTML = alertHtml.join("");

  // banner
  const b = $("#banner");
  const staleDays = metaStaleDays();
  if (offline) {
    const t = first ? new Date(first.fetchedAt).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" }) : null;
    b.textContent = t ? `Offline — showing data from ${t}.` : "Offline — no cached data yet.";
    b.className = "banner offline";
  } else if (staleDays != null && staleDays >= 2) {
    b.textContent = `Schedule data is ${staleDays} days old — times may be outdated.`;
    b.className = "banner";
  } else if (first && first.serviceNote) {
    b.textContent = "Modified schedule in effect today (holiday or special service).";
    b.className = "banner";
  } else if (first && first.realtime === false) {
    b.textContent = "Live updates temporarily unavailable — showing scheduled times.";
    b.className = "banner offline";
  } else b.className = "banner hidden";

  $("#content").innerHTML = dirs.map(d => sectionHtml(d)).join("") || `<div class="muted center">No data.</div>`;

  // Tap the hero card to expand/collapse its full stop list.
  $("#content").querySelectorAll(".hero[data-dir]").forEach(h => {
    h.onclick = () => {
      const dd = h.dataset.dir;
      expandedStops[dd] = !expandedStops[dd];
      h.classList.toggle("expanded", expandedStops[dd]);
      const panel = h.querySelector(".stops-panel");
      if (panel) panel.classList.toggle("open", expandedStops[dd]);
    };
  });

  dirs.forEach(loadWeather); // fill the weather line under each hero (async, optional)

  const anyAlert = seen.size > 0;
  const cancelledNext = dirs.some(d => lastData[d]?.trains?.[0]?.cancelled);
  updateBadge(bestTrain(dirs), anyAlert, cancelledNext, dirs);

  $("#updated").textContent = first ? `Updated ${new Date(first.fetchedAt).toLocaleTimeString([], { hour: "numeric", minute: "2-digit", second: "2-digit" })}` : "";
  $("#rt-status").innerHTML = first ? (first.realtime ? `<span class="live-dot">live</span>` : "scheduled only") : "";
}

// Full-day scheduled timetable for any date (incl. weekends) — no realtime merge.
async function renderTimetable(dirs) {
  const route = activeRoute();
  $("#route-title").innerHTML = dirs.length === 2
    ? `${esc(route.homeName)} <span class="arrow">⇆</span> ${esc(route.workName)}`
    : dirTitle(dirs[0]);
  $("#alerts").innerHTML = "";
  $("#banner").className = "banner hidden";

  const chips = quickDays().map(c =>
    `<button class="chip-day ${c.iso === ttDate ? "on" : ""}" data-iso="${c.iso}">${c.label}</button>`).join("");
  let html = `<div class="datebar">${chips}
    <input type="date" id="tt-date" min="${todayISO()}" max="${isoPlus(20)}" value="${ttDate}" aria-label="Pick a date"></div>`;

  let note = null;
  for (const d of dirs) {
    const [from, to] = d === "HW" ? [route.home, route.work] : [route.work, route.home];
    html += `<div class="direction-head">${dirTitle(d)}</div>`;
    try {
      const data = await api(`/api/timetable?route=${encodeURIComponent(route.line)}&from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}&date=${ttDate.replace(/-/g, "")}`);
      note = note || data.serviceNote;
      html += data.trains.length
        ? `<div class="list tt">` + data.trains.map(t => `
            <div class="row ${t.class === "E" ? "express" : ""}">
              <span class="dep">${t.dep}</span>
              <span class="meta">${t.class === "E"
                ? `<span class="chip E">Express</span> Train ${esc(trainNoShort(t.trainNo))}`
                : `Local · Train ${esc(trainNoShort(t.trainNo))}`}</span>
              <span class="right">→ ${t.arr}${t.durMin ? `<span class="dur">${fmtDur(t.durMin)}</span>` : ""}</span>
            </div>`).join("") + `</div>`
        : `<div class="muted" style="padding:8px 2px 14px">No service that day.</div>`;
    } catch {
      html += `<div class="muted" style="padding:8px 2px 14px">Couldn't load timetable.</div>`;
    }
  }
  $("#content").innerHTML = html;
  if (note) {
    const b = $("#banner");
    b.textContent = "Modified schedule (holiday or special service).";
    b.className = "banner";
  }
  $("#content").querySelectorAll(".chip-day").forEach(b => b.onclick = () => { ttDate = b.dataset.iso; refresh(); });
  $("#tt-date").onchange = e => { if (e.target.value) { ttDate = e.target.value; refresh(); } };
  $("#updated").textContent = new Date(ttDate + "T00:00").toLocaleDateString([], { weekday: "long", month: "short", day: "numeric" });
  $("#rt-status").textContent = "scheduled times";
  document.title = `${dirLabel(dirs)} · Schedule`;
}

// ---------- date helpers (local time; riders are in Chicago) ----------
function fmtISO(d) { return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`; }
function addDays(d, n) { const x = new Date(d); x.setDate(x.getDate() + n); return x; }
function todayISO() { return fmtISO(new Date()); }
function isoPlus(n) { return fmtISO(addDays(new Date(), n)); }
function quickDays() {
  const now = new Date();
  const nextDow = target => { let x = addDays(now, 1); for (let i = 0; i < 7; i++) { if (x.getDay() === target) return x; x = addDays(x, 1); } return now; };
  const raw = [
    { label: "Today", d: now }, { label: "Tomorrow", d: addDays(now, 1) },
    { label: "Sat", d: nextDow(6) }, { label: "Sun", d: nextDow(0) },
  ].map(o => ({ label: o.label, iso: fmtISO(o.d) }));
  const seen = new Set();
  return raw.filter(o => !seen.has(o.iso) && seen.add(o.iso)); // drop dupes (e.g. tomorrow == Sat)
}

function dirTitle(d) {
  const r = activeRoute();
  const [a, b] = d === "HW" ? [r.homeName, r.workName] : [r.workName, r.homeName];
  return `${esc(a)} <span class="arrow">→</span> ${esc(b)}`;
}

function sectionHtml(d) {
  const data = lastData[d];
  const head = `<div class="direction-head">${dirTitle(d)}</div>`;
  if (!data) return `${head}<div class="muted" style="padding:8px 2px 14px">Couldn't load this direction.</div>`;
  const trains = data.trains.filter(t => t.cancelled || t.depEpochMs > Date.now());
  if (!trains.length) return `${head}<div class="muted" style="padding:8px 2px 14px">No more trains today on this route.</div>`;

  const [next, ...rest] = trains;
  const hint = expressHint(trains.filter(t => !t.cancelled));
  const label = next.cancelled ? "Next scheduled train — cancelled"
    : next.class === "E" ? "Next express train" : "Next available train";

  return `${head}
    <div class="section-label">${label}</div>
    <div class="hero${expandedStops[d] ? " expanded" : ""}" data-dir="${d}">
      <div class="hero-head">
        <div class="hero-left">
          <div class="hero-chips"><span class="chip ${next.class}">${next.class === "E" ? "Express" : "Local"}</span>${statusPill(next)}</div>
          <div class="times">
            ${next.delayMin > 0 ? `<span class="was">${next.depScheduled}</span>` : ""}${next.dep}
            <span class="to">→ ${next.arr}</span>
          </div>
          <div class="hero-meta">Train ${esc(trainNoShort(next.trainNo))}${next.cancelled ? "" : `<span class="wx" data-wx="${d}"></span>`}</div>
        </div>
        <div class="hero-countdown">
          ${next.cancelled
            ? `<div class="cd-cancel">Cancelled</div>`
            : `<div class="flapboard" data-dep="${next.depEpochMs}">${flapTiles(next.depEpochMs)}</div>`}
        </div>
      </div>
      ${next.cancelled ? "" : journeyBar(data, next, d)}
      ${next.cancelled ? "" : stopsPanel(data, next, d)}
    </div>
    ${hint ? `<div class="hint">Express Train ${esc(trainNoShort(hint.trainNo))} leaves at ${hint.dep} (in ${hint.minutes} min) — worth waiting?</div>` : ""}
    <div class="list">
      ${rest.map(t => `
        <div class="row ${t.cancelled ? "cancelled" : ""}${t.delayMin > 0 ? " late" : ""}">
          <span class="dep">${t.delayMin > 0 ? `<span class="was">${t.depScheduled}</span>` : ""}${t.dep}</span>
          <span class="meta">${t.class === "E" ? "Express" : "Local"} · Train ${esc(trainNoShort(t.trainNo))}${miniStatus(t)}</span>
          <span class="right">${t.cancelled ? "Cancelled"
            : `<span data-dep="${t.depEpochMs}">${fmtCountdown(t.depEpochMs)}</span>${t.delayMin > 0 ? `<span class="delay">+${t.delayMin}m</span>` : ""}`}</span>
        </div>`).join("")}
    </div>`;
}

// Realtime status for a train: what the feed says vs the schedule.
function liveStatus(t) {
  if (t.cancelled) return { text: "Cancelled", cls: "st-cancel", live: false };
  if (!t.live) return { text: "Scheduled", cls: "st-sched", live: false };
  if (t.delayMin > 0) return { text: `${t.delayMin} min late`, cls: "st-late", live: true };
  return { text: "On time", cls: "st-ontime", live: true };
}
// Full pill for the hero card.
function statusPill(t) {
  const s = liveStatus(t);
  return `<span class="status-pill ${s.cls}">${s.live ? `<span class="pdot"></span>` : ""}${s.text}</span>`;
}
// Compact indicator for list rows — only shown when Metra is actively tracking.
function miniStatus(t) {
  if (t.cancelled || !t.live) return "";
  const s = liveStatus(t);
  return ` <span class="mini-status ${s.cls}"><span class="pdot"></span>${t.delayMin > 0 ? "late" : "on time"}</span>`;
}

// Journey bar: station ticks; live GPS marker if the positions feed has our train,
// otherwise time-interpolated progress once en route (marked "estimated").
function journeyBar(data, train, d) {
  let sts = data.stations || [];
  if (sts.length && sts[0].id !== (d === "HW" ? activeRoute().home : activeRoute().work)) sts = [...sts].reverse();
  const n = sts.length;
  if (n < 2) return "";

  let frac = null, mode = null;
  const pos = data.position && data.position.tripId === train.tripId ? data.position : null;
  if (pos) {
    let best = 0, bd = Infinity;
    sts.forEach((s, i) => {
      if (s.lat == null) return;
      const dd = (s.lat - pos.lat) ** 2 + (s.lon - pos.lon) ** 2;
      if (dd < bd) { bd = dd; best = i; }
    });
    frac = best / (n - 1); mode = "live";
  } else if (Date.now() > train.depEpochMs) {
    frac = Math.min(0.97, (Date.now() - train.depEpochMs) / Math.max(1, train.arrEpochMs - train.depEpochMs));
    mode = "estimated";
  }

  const W = 320, pad = 12;
  const x = i => pad + (W - 2 * pad) * (i / (n - 1));
  const ticks = sts.slice(1, -1).map((s, i) =>
    `<circle cx="${x(i + 1).toFixed(1)}" cy="20" r="2.6" fill="var(--line)" opacity="0.55"/>`).join("");
  const soon = train.depEpochMs - Date.now() < 15 * 60 * 1000 && frac === null;
  const marker = frac !== null
    ? `<g transform="translate(${(pad + (W - 2 * pad) * frac).toFixed(1)},20)">
         <circle r="7" fill="var(--line)" opacity="0.25"${mode === "live" ? ` class="pulse"` : ""}/>
         <circle r="4" fill="var(--line)"/></g>`
    : `<circle cx="${pad}" cy="20" r="6" fill="var(--line)" class="${soon ? "pulse" : ""}"/>`;

  return `<div class="journey">
    <svg viewBox="0 0 ${W} 40" role="img" aria-label="Journey progress">
      <line x1="${pad}" y1="20" x2="${W - pad}" y2="20" stroke="var(--line)" stroke-width="2.5" opacity="0.5"/>
      ${frac !== null ? `<line x1="${pad}" y1="20" x2="${(pad + (W - 2 * pad) * frac).toFixed(1)}" y2="20" stroke="var(--line)" stroke-width="2.5"/>` : ""}
      ${ticks}
      <rect x="${W - pad - 7}" y="13" width="14" height="14" rx="3.5" fill="var(--line)"/>
      ${marker}
    </svg>
    <div class="lbls"><span>${esc(sts[0].name)}</span><span>${esc(sts[n - 1].name)}</span></div>
    ${mode === "estimated" ? `<div class="est">position estimated from schedule</div>` : ""}
  </div>`;
}

// Expandable list of every station on the journey; the train's actual stops are
// highlighted with their scheduled time, skipped stations are dimmed.
function stopsPanel(data, train, d) {
  let sts = (data.stations || []).slice();
  if (!sts.length) return "";
  const fromId = d === "HW" ? activeRoute().home : activeRoute().work;
  if (sts[0].id !== fromId) sts.reverse(); // order stations in travel direction

  const times = {};
  for (const s of train.stops || []) times[s.id] = s.dep;
  const served = new Set((train.stops || []).map(s => s.id));

  const rows = sts.map(s => {
    const on = served.has(s.id);
    return `<div class="stop ${on ? "on" : "off"}">
      <span class="stop-name">${esc(s.name)}</span>
      <span class="stop-time">${on ? esc(times[s.id] || "•") : "skips"}</span>
    </div>`;
  }).join("");

  return `<div class="stops-toggle">All stops <span class="caret">▾</span></div>
    <div class="stops-panel${expandedStops[d] ? " open" : ""}"><div class="stops-inner">${rows}</div></div>`;
}

// ---------- weather at departure ----------
async function loadWeather(d) {
  const data = lastData[d];
  const next = data && data.trains && data.trains.find(t => !t.cancelled && t.depEpochMs > Date.now());
  const el = document.querySelector(`.wx[data-wx="${d}"]`);
  if (!next || !el) return;
  const fromId = d === "HW" ? activeRoute().home : activeRoute().work;
  const st = (data.stations || []).find(s => s.id === fromId);
  if (!st || st.lat == null) return;
  try {
    let wx = weatherCache.get(st.id);
    if (!wx || Date.now() - wx.at > 20 * 60 * 1000) {
      wx = { ...(await api(`/api/weather?lat=${st.lat}&lon=${st.lon}`)), at: Date.now() };
      weatherCache.set(st.id, wx);
    }
    const p = pickPeriod(wx.periods, next.depEpochMs);
    if (p) {
      const tip = `${p.sky}${p.precip ? ` · ${p.precip}% precip` : ""} at departure`;
      el.innerHTML = `<span class="wx-inner" title="${esc(tip)}">· ${weatherEmoji(p.sky, p.day)} ${p.temp}°</span>`;
    }
  } catch { /* weather is a bonus, never block the board */ }
}
// Map an NWS shortForecast to an emoji (day/night aware).
function weatherEmoji(sky, day) {
  const s = (sky || "").toLowerCase();
  if (/thunder|tstorm/.test(s)) return "⛈️";
  if (/snow|flurr|sleet|wintry|ice|blizzard/.test(s)) return "🌨️";
  if (/rain|shower|drizzle/.test(s)) return "🌧️";
  if (/fog|mist|haze|smoke/.test(s)) return "🌫️";
  if (/wind|breez/.test(s)) return "💨";
  if (/mostly (clear|sunny)/.test(s)) return day === false ? "🌙" : "🌤️";
  if (/partly (cloudy|sunny)|partly clear/.test(s)) return day === false ? "☁️" : "⛅";
  if (/mostly cloudy|overcast/.test(s)) return "🌥️";
  if (/cloud/.test(s)) return "☁️";
  if (/clear|sunny|fair/.test(s)) return day === false ? "🌙" : "☀️";
  return "🌡️";
}
function pickPeriod(periods, epochMs) {
  for (const p of periods || []) {
    const start = new Date(p.t).getTime();
    if (start <= epochMs && epochMs < start + 3600000) return p;
  }
  return (periods && periods[0]) || null;
}

// ---------- badge (favicon + title) ----------
function bestTrain(dirs) {
  let best = null;
  for (const d of dirs) {
    const t = (lastData[d]?.trains || []).find(x => !x.cancelled && x.depEpochMs > Date.now());
    if (t && (!best || t.depEpochMs < best.depEpochMs)) best = t;
  }
  return best;
}

// Short station label for the tab title: first word, but keep a trailing number
// so "Route 59" doesn't collapse to a bare "Route".
function shortStation(name) {
  const parts = String(name).split(" ");
  return parts[1] && /^\d/.test(parts[1]) ? `${parts[0]} ${parts[1]}` : parts[0];
}

// "A → B" for a single direction, "A ⇆ B" for both — matches the on-screen heading.
function dirLabel(dirs) {
  const r = activeRoute();
  if (!dirs || dirs.length === 2) return `${shortStation(r.homeName)} ⇆ ${shortStation(r.workName)}`;
  const [from, to] = dirs[0] === "HW" ? [r.homeName, r.workName] : [r.workName, r.homeName];
  return `${shortStation(from)} → ${shortStation(to)}`;
}

function updateBadge(next, hasAlert, cancelledNext, dirs) {
  const mins = next ? Math.max(0, Math.round((next.depEpochMs - Date.now()) / 60000)) : null;
  const text = next ? (mins > 99 ? "99+" : `${mins}${next.class}`) : "--";
  const color = cancelledNext ? "#B3261E" : hasAlert ? "#B45309" : next ? "#1D9E75" : "#8A8F98";

  const c = document.createElement("canvas"); c.width = c.height = 32;
  const g = c.getContext("2d");
  g.fillStyle = color;
  g.beginPath(); g.roundRect(0, 0, 32, 32, 7); g.fill();
  g.fillStyle = "#fff";
  g.font = `bold ${text.length > 2 ? 13 : 16}px -apple-system, sans-serif`;
  g.textAlign = "center"; g.textBaseline = "middle";
  g.fillText(text, 16, 17);
  $("#favicon").href = c.toDataURL("image/png");

  const label = dirLabel(dirs);
  document.title = next ? `${mins}m ${next.class} · ${label}` : `${label} · Chicagoland Rail`;
}

// ---------- notifications ----------
// Prefer the service worker's showNotification (renders as a real OS notification
// and lands in the notification center); fall back to page-context Notification.
function notify(title, body, tag) {
  const opts = { body, tag, icon: "icons/icon128.png", badge: "icons/icon32.png", renotify: false };
  if (swReg && swReg.showNotification) swReg.showNotification(title, opts).catch(() => {});
  else if ("Notification" in window) try { new Notification(title, opts); } catch { /* ignore */ }
}

function maybeNotify(d, data) {
  if (!S.notify || !("Notification" in window) || Notification.permission !== "granted") return;
  for (const t of data.trains || []) {
    const key = `${d}:${t.tripId}`;
    const prev = lastSeen.get(key) || { delayMin: 0, cancelled: false };
    if (t.cancelled && !prev.cancelled) {
      notify(`Train ${trainNoShort(t.trainNo)} cancelled`, `${data.from} → ${data.to}, scheduled ${t.depScheduled || t.dep}`, `cancel:${key}`);
    } else if (t.delayMin >= 3 && prev.delayMin < 3) {
      notify(`Train ${trainNoShort(t.trainNo)} delayed ${t.delayMin} min`, `Now departing ${t.dep}`, `delay:${key}`);
    }
    lastSeen.set(key, { delayMin: t.delayMin, cancelled: t.cancelled });
  }
  for (const a of data.alerts || []) {
    if (notifiedAlerts.has(a.id)) continue;
    notifiedAlerts.add(a.id);
    notify("Service alert", a.header + (a.description ? ` — ${a.description}` : ""), `alert:${a.id}`);
  }
}

// ---------- misc ----------
function updateCountdowns() {
  document.querySelectorAll("[data-dep]").forEach(el => {
    const dep = Number(el.dataset.dep);
    if (el.classList.contains("flapboard")) el.innerHTML = flapTiles(dep); // ticking flip-board
    else el.textContent = fmtCountdown(dep);                               // list rows
  });
}
function swapView(name) {
  $("#view-main").classList.toggle("hidden", name !== "main");
  $("#view-setup").classList.toggle("hidden", name !== "setup");
}
function esc(s) { return String(s).replace(/[&<>"]/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c])); }
// GTFS trip ids look like "BNSF_BN1283_V2_D"; riders know the train as "1283".
function trainNoShort(no) { const m = String(no).match(/\d{2,5}/); return m ? m[0] : String(no); }
function fmtDur(min) { const h = Math.floor(min / 60), m = min % 60; return h ? `${h}h ${m}m` : `${m}m`; }
// Live countdown as split-flap departure-board tiles (one card per character).
function flapTiles(epochMs) {
  return fmtLive(epochMs).split("").map(ch =>
    ch === ":" ? `<span class="flap colon">:</span>` : `<span class="flap">${ch}</span>`).join("");
}

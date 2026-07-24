import { DEFAULT_SETTINGS, resolveDirection, overrideExpiry, expressHint, fmtCountdown } from "./logic.js";
import { API_BASE, CF_ANALYTICS_TOKEN } from "./config.js";
import { createMap, lift } from "./map.js";

const WIZ_LINE = "#22C58B"; // bright default accent for the dark onboarding (before a line is picked)

// Relative luminance of a #rrggbb color (0 dark … 1 light).
function relLum(hex) {
  const n = parseInt(String(hex).replace("#", ""), 16);
  const f = v => { v /= 255; return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4; };
  return 0.2126 * f(n >> 16 & 255) + 0.7152 * f(n >> 8 & 255) + 0.0722 * f(n & 255);
}
// Theme the UI to a line: on the dark canvas lift the official color for contrast;
// on light, use the official color as-is (lifting only brightens it into neon on
// white). Ink (text that sits ON a --line fill) is chosen for readability — dark
// on bright lines (UP-NW yellow), white on the rest.
function applyLineTheme(rawColor) {
  const base = rawColor || WIZ_LINE;
  const c = resolvedTheme === "light" ? base : lift(base);
  const root = document.documentElement.style;
  root.setProperty("--line", c);
  root.setProperty("--line-ink", relLum(c) > 0.62 ? "#08141F" : "#FFFFFF");
}

const $ = s => document.querySelector(s);
const POLL_MS = 30000;
// Declared up here (not by the flap board below) because the visitor counter can
// paint during init() — before a bottom-of-file const would be initialized (TDZ).
const REDUCE_MOTION = window.matchMedia && window.matchMedia("(prefers-reduced-motion: reduce)").matches;
// Theme: user picks system/light/dark; resolvedTheme is the applied "light"|"dark".
const themeMedia = window.matchMedia ? window.matchMedia("(prefers-color-scheme: dark)") : null;
let resolvedTheme = "dark";

// scrollIntoView (especially with an options object) throws in some embedded
// browsers/webviews (and jsdom). A cosmetic scroll must never break a flow — one
// such throw between a map tap and pickWizLine was the "tapping a line does nothing"
// bug. Always route scrolls through this.
function scrollIntoViewSafe(el, opts) {
  try { if (el && el.scrollIntoView) el.scrollIntoView(opts); } catch { /* embedded browser */ }
}

// ---------- state ----------
const store = {
  load() {
    try { return JSON.parse(localStorage.getItem("mct") || "{}"); } catch { return {}; }
  },
  save(s) { localStorage.setItem("mct", JSON.stringify(s)); },
};
let S = Object.assign({ routes: [], activeRouteId: null, settings: null, override: { active: false }, notify: false, briefing: null, nudges: {}, visits: 0, alertsSeen: null }, store.load());
const persist = () => store.save(S);

let lines = [], lastData = {}, lastSeen = new Map(), pollTimer = null, tickTimer = null;
// Monotonic token for the active board request. Every refresh/timetable render
// captures the current value; after each await it bails if a newer request has
// started (e.g. the rider switched routes), so a slow response from the previous
// route can never write into lastData or paint the DOM. Strictly last-write-wins.
let reqSeq = 0;
let ttDate = null;               // null = live board; "YYYY-MM-DD" = schedule for that day
let swReg = null;                // service-worker registration, for OS notifications
let notifiedAlerts = new Set();  // alert ids we've already notified about
let meta = null;                 // /api/meta freshness, for the stale-data warning
let weatherCache = new Map();    // stationId -> { periods, at }
let oneOff = null;               // transient one-off trip (not saved), overrides active route
let stripReversed = {};          // per-direction reverse flag for the route diagram (point: reversible list)
let ooStations = [];             // stations for the one-off line picker
let lastVisitStats = null;       // last-known /api/visits stats for the About sheet
let lastFare = null;             // fare for the active route (for the fare sheet)

// ---------- persistent offline cache (survives reload/underground) ----------
const cacheKey = id => "mct_cache_" + id;
function saveCache() {
  const r = activeRoute(); if (!r) return;
  try { localStorage.setItem(cacheKey(r.id), JSON.stringify({ routeId: r.id, data: lastData, savedAt: Date.now() })); } catch { /* quota */ }
}
function loadCache() {
  const r = activeRoute();
  lastData = {};
  if (!r) return;
  try {
    const c = JSON.parse(localStorage.getItem(cacheKey(r.id)) || "null");
    // Only trust a cache stamped with this exact route — never show another route's board.
    if (c && c.data && c.routeId === r.id) lastData = c.data;
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
  initAnalytics();
  applyTheme(); // sync resolvedTheme + data-theme (the inline head script set it pre-paint)
  if (themeMedia) themeMedia.addEventListener("change", () => { if (themePref() === "system") applyTheme(); });
  if ("serviceWorker" in navigator) navigator.serviceWorker.register("./sw.js").then(r => swReg = r).catch(() => {});
  S.visits = (S.visits || 0) + 1; persist(); // paces the contextual briefing nudge
  initAbout();  // "Built by" sheet + live visitor counter
  pingVisit();  // count this browser once per Chicago day (non-blocking)
  try { lines = await api("/api/lines"); } catch { lines = []; }
  api("/api/meta").then(m => { meta = m; }).catch(() => {}); // for stale-data warning
  initOneOff();
  initFare();   // fare sheet (opened from the subtle fare strip)
  if (!activeRoute()) showWizard("boot"); else showMain();
  syncPush(); // refresh push subscription + line list on load
}

function activeRoute() { return oneOff || S.routes.find(r => r.id === S.activeRouteId) || S.routes[0] || null; }
function settings() { return S.settings || DEFAULT_SETTINGS; }

// Privacy-first, cookieless page analytics (Cloudflare Web Analytics). Loads only
// when a token is set in config.js — no personal data, no cookies, no consent
// banner needed; it just gives an aggregate visitor count.
function initAnalytics() {
  if (!CF_ANALYTICS_TOKEN) return;
  const s = document.createElement("script");
  s.defer = true;
  s.src = "https://static.cloudflareinsights.com/beacon.min.js";
  s.setAttribute("data-cf-beacon", JSON.stringify({ token: CF_ANALYTICS_TOKEN }));
  document.head.appendChild(s);
}

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
      reminders: [], // departure reminders removed; server keeps supporting the field
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
// "BNSF · BNSF Railway" so riders recognize the code and the full name.
function lineLabel(l) { return `${l.id} · ${l.name}`; }

// ============================================================
// SETUP VIEW
// ============================================================
// Settings page (routes, alerts, preferences). Route creation happens in the
// wizard — this page only lists, activates, and removes saved routes.
// opts.scrollTo → jump to a specific section (e.g. the cog goes to preferences).
function showSetup(opts = {}) {
  swapView("setup");
  const st = settings();
  $("#m0").value = st.morningWindow[0]; $("#m1").value = st.morningWindow[1];
  $("#e0").value = st.eveningWindow[0]; $("#e1").value = st.eveningWindow[1];
  $("#save-windows").onclick = () => { saveWindows(); flashOk("#win-ok"); };
  $("#notif-toggle").checked = !!S.notify;
  $("#notif-note").textContent = ("Notification" in window)
    ? "Get alerts for new delays, cancellations, and service alerts, even when the app is closed. On iPhone, first add this app to your Home Screen from Safari."
    : "This browser doesn't support notifications.";

  renderRouteList();
  // Appearance: system / light / dark
  const themeSeg = $("#theme-seg");
  if (themeSeg) themeSeg.querySelectorAll("button").forEach(b => b.onclick = () => setThemePref(b.dataset.themePref));
  syncThemeSeg();
  $("#add-route").onclick = () => showWizard("settings");
  $("#setup-done").onclick = () => { if (activeRoute()) showMain(); };
  // Erase-everything: two-tap confirm (native confirm() doesn't open in the Tesla browser).
  const rst = $("#reset-app");
  rst.onclick = () => {
    if (!rst.classList.contains("confirm")) {
      rst.classList.add("confirm"); rst.textContent = "Tap again to erase everything";
      rst._t = setTimeout(() => { rst.classList.remove("confirm"); rst.textContent = "Erase all data & start over"; }, 4000);
      return;
    }
    clearTimeout(rst._t);
    rst.classList.remove("confirm"); rst.textContent = "Erase all data & start over";
    resetApp();
  };
  $("#notif-toggle").onchange = async e => {
    if (e.target.checked) {
      if (Notification.permission !== "granted") {
        const p = await Notification.requestPermission();
        if (p !== "granted") { e.target.checked = false; return; }
      }
      S.notify = true; persist();
      updateGates({ scroll: true }); // unlock the briefing, scroll to it
      await subscribePush();
    } else {
      S.notify = false; persist();
      updateGates(); // re-lock the briefing
      await unsubscribePush();
    }
  };
  try { setupBriefing(); } catch (e) { console.error("briefing setup failed", e); }

  // Replace native <select>/<input type=time> popups with tap-friendly widgets
  // so every picker works in browsers that won't open native popups (Tesla).
  ["#brief-route"].forEach(s => enhanceSelect($(s)));
  ["#m0", "#m1", "#e0", "#e1", "#brief-time"].forEach(s => enhanceTime($(s)));
  updateGates(); // set initial locked/unlocked state (no scroll on first paint)
  if (opts.scrollTo) {
    const target = $(opts.scrollTo);
    if (target) setTimeout(() =>
      scrollIntoViewSafe(target, { behavior: REDUCE_MOTION ? "auto" : "smooth", block: "start" }), 60);
  }
}

// ---------- morning briefing (setup UI) ----------
function setupBriefing() {
  const routeSel = $("#brief-route");
  const hasRoutes = S.routes.length > 0;
  routeSel.innerHTML = hasRoutes
    ? S.routes.map(r => `<option value="${r.id}">${esc(r.label)}</option>`).join("")
    : `<option value="">Save a route first…</option>`;
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
      ? `On · ${fmtTime12(time)} on weekdays, ${r.label}.${S.notify ? "" : " Turn on Notifications above to receive it."}`
      : "Off.");
  };
  $("#brief-toggle").onchange = save;
  $("#brief-time").onchange = save;
  routeSel.onchange = save;
  note(b && b.enabled ? `On · ${fmtTime12(b.time || "06:45")} on weekdays.` : "Off.");
}

function fmtTime12(hhmm) {
  const [h, m] = String(hhmm).split(":").map(Number);
  return `${h % 12 || 12}:${String(m).padStart(2, "0")} ${h < 12 ? "AM" : "PM"}`;
}

// <option> markup for a station <select>, with a leading placeholder. Native
// selects work on every browser (incl. the Tesla in-car browser, which does not
// render <datalist> suggestions); the value is the GTFS stop id.
function stationOptions(sts) {
  return `<option value="">Choose a station…</option>` +
    sts.map(s => `<option value="${esc(s.id)}">${esc(s.name)}</option>`).join("");
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
  el.innerHTML = has ? "" : `<p class="muted small">No routes yet. Tap <b>Add a route</b> below.</p>`;
  const done = $("#setup-done");
  if (done) done.classList.toggle("hidden", !(has || oneOff));
  const add = $("#add-route");
  if (add) add.classList.toggle("hidden", S.routes.length >= 5); // route cap
  for (const r of S.routes) {
    const div = document.createElement("div");
    div.className = "route-item" + (r.id === S.activeRouteId ? " active" : "");
    div.innerHTML = `<span class="ri-dot" style="background:${esc(lineColor(r.line))}" aria-hidden="true"></span>
      <div class="ri-main"><div class="name">${esc(r.label)}</div>
      <div class="sub">${esc(r.line)} · ${esc(r.homeName)} ↔ ${esc(r.workName)}${r.id === S.activeRouteId ? " · active" : ""}</div></div>
      <button class="ghost danger" data-a="del">Remove</button>
      <span class="ri-go" aria-hidden="true">›</span>`;
    // Tap the route to view its trains.
    div.querySelector(".ri-main").onclick = () => { oneOff = null; S.activeRouteId = r.id; persist(); showMain(); };
    div.querySelector(".ri-go").onclick = () => { oneOff = null; S.activeRouteId = r.id; persist(); showMain(); };
    const del = div.querySelector('[data-a="del"]');
    del.onclick = e => {
      e.stopPropagation();
      // Two-tap confirm (native confirm() dialogs don't open in the Tesla browser).
      if (!del.classList.contains("confirm")) {
        del.classList.add("confirm"); del.textContent = "Remove?";
        del._t = setTimeout(() => { del.classList.remove("confirm"); del.textContent = "Remove"; }, 3500);
        return;
      }
      clearTimeout(del._t);
      S.routes = S.routes.filter(x => x.id !== r.id);
      // Cascade: the briefing tied to this route goes with it.
      if (S.briefing && S.briefing.routeId === r.id) S.briefing = null;
      if (S.activeRouteId === r.id) S.activeRouteId = S.routes[0]?.id || null;
      persist(); renderRouteList(); syncPush(); updateGates(); // re-lock if last route removed
      // Rebuild the briefing UI so its route picker drops the deleted route.
      try { setupBriefing(); } catch { /* section may be locked */ }
    };
    el.appendChild(div);
  }
}

// Settings sections stay locked until their prerequisite is met (a saved route,
// then notifications on); newly-met prerequisites unlock with a scroll + highlight.
function updateGates({ scroll = false } = {}) {
  const hasRoute = S.routes.length > 0;
  const notif = !!S.notify;
  const gates = [
    ["#sec-notif", hasRoute],
    ["#sec-briefing", hasRoute && notif],
  ];
  let unlocked = null;
  for (const [sel, open] of gates) {
    const el = $(sel); if (!el) continue;
    const was = el.classList.contains("locked");
    el.classList.toggle("locked", !open);
    if (was && open && !unlocked) unlocked = el; // first section that just opened
  }
  if (scroll && unlocked) {
    scrollIntoViewSafe(unlocked, { behavior: REDUCE_MOTION ? "auto" : "smooth", block: "start" });
    unlocked.classList.remove("just-unlocked"); void unlocked.offsetWidth; unlocked.classList.add("just-unlocked");
  }
}

// Briefly show a success note (e.g. "✓ Reminder added"), then fade it out.
function flashOk(sel) {
  const el = $(sel); if (!el) return;
  el.classList.remove("hidden");
  clearTimeout(el._t); el._t = setTimeout(() => el.classList.add("hidden"), 2500);
}

// Erase everything saved on this device and return to first-run onboarding.
async function resetApp() {
  try { await unsubscribePush(); } catch { /* best effort — server sub may already be gone */ }
  const gone = [];
  for (let i = 0; i < localStorage.length; i++) {
    const k = localStorage.key(i);
    if (k === "mct" || k.startsWith("mct_cache_")) gone.push(k);
  }
  gone.forEach(k => localStorage.removeItem(k));
  S = { routes: [], activeRouteId: null, settings: null, override: { active: false }, notify: false, briefing: null, nudges: {}, visits: 0, alertsSeen: null };
  oneOff = null; lastData = {}; ttDate = null; stripReversed = {};
  lastSeen.clear(); notifiedAlerts.clear(); expandedTrain = {}; stripReversed = {}; weatherCache.clear();
  showWizard("boot");
}

// ============================================================
// ONBOARDING WIZARD — a living map of Chicagoland: tap your line, tap your two
// stations, then opt into alerts. No dropdowns; the map is the picker.
// ============================================================
let wiz = null;        // { step, cameFrom: "boot"|"settings", line, sts, from, loading }
let wizMap = null;     // map controller (map.js) mounted across steps 1-3
let mapGeo = null;     // { stopsByLine } — every line's station geometry, for the system map

// Load every line's stations once (edge-cached), so the whole system can be drawn.
async function ensureMapGeo() {
  if (mapGeo) return mapGeo;
  const stopsByLine = {}, segmentsByLine = {}, shapesByLine = {};
  await Promise.all(lines.map(async l => {
    try {
      const d = await api(`/api/stops?route=${encodeURIComponent(l.id)}`);
      stopsByLine[l.id] = d.stations || [];
      segmentsByLine[l.id] = d.segments || [];
      shapesByLine[l.id] = d.shapes || []; // real track geometry (curves), when ingested
    } catch { stopsByLine[l.id] = []; segmentsByLine[l.id] = []; shapesByLine[l.id] = []; }
  }));
  mapGeo = { stopsByLine, segmentsByLine, shapesByLine };
  return mapGeo;
}

function showWizard(cameFrom = "boot") {
  wiz = { step: 1, cameFrom, sts: [] };
  wizMap = null; wizStationRev = false;
  swapView("wizard");
  applyLineTheme(WIZ_LINE);
  buildWizMap();   // async: draws the map when geometry arrives
  renderWizard();
}

async function buildWizMap() {
  const host = $("#wiz-map");
  if (!host) return;
  host.classList.add("loading");
  host.innerHTML = `<div class="lmap-load">Drawing the map…</div>`;
  try {
    const { stopsByLine, segmentsByLine, shapesByLine } = await ensureMapGeo();
    if (!wiz) return; // wizard was closed while geometry loaded
    wizMap = createMap(host, { lines, stopsByLine, segmentsByLine, shapesByLine, onLine: onMapLine, onStation: onMapStation, onHover: onMapHover });
    host.classList.remove("loading");
    applyMapState();
  } catch {
    host.classList.remove("loading");
    host.innerHTML = `<div class="lmap-load">Map unavailable offline — pick from the list below.</div>`;
  }
}

// Reflect the wizard's current step onto the map (focus + selected markers).
function applyMapState() {
  const host = $("#wiz-map");
  if (host) host.classList.toggle("hidden", wiz.step === 4);
  if (!wizMap) return;
  if (wiz.step === 1) wizMap.unfocus();
  else if (wiz.step >= 2 && wiz.line) {
    wizMap.focus(wiz.line);
    wizMap.select(wiz.line, { from: wiz.from && wiz.from.id });
  }
}

// Tapping a line goes straight to station selection. Don't highlight/scroll the
// step-1 card first: we leave step 1 immediately, and a throwing scrollIntoView (some
// browsers/webviews) would otherwise abort the tap before pickWizLine ran — the
// "tapping a line does nothing" bug, while hover (no scroll) kept working.
function onMapLine(id) { if (wiz && wiz.step === 1) pickWizLine(id); }
function onMapStation(lineId, sid) { if (wiz && (wiz.step === 2 || wiz.step === 3)) pickWizStation(sid); }
function onMapHover(id) { if (wiz && wiz.step === 1) highlightWizLine(id); }

// Highlight the line card matching a map hover/tap — the visible link between the
// map above and the list below. `scroll` nudges it into view when tapped.
function highlightWizLine(id, scroll = false) {
  const list = $("#wiz-list");
  if (!list) return;
  list.querySelectorAll(".wiz-row.hl").forEach(r => { r.classList.remove("hl"); r.style.borderColor = ""; r.style.boxShadow = ""; });
  if (!id) return;
  const row = [...list.querySelectorAll(".wiz-row:not(.saved)")].find(r => r.dataset.id === id);
  if (!row) return;
  const l = lines.find(x => x.id === id);
  row.classList.add("hl");
  if (l) { row.style.borderColor = l.color; row.style.boxShadow = `0 0 0 1px ${l.color}`; }
  if (scroll) scrollIntoViewSafe(row, { block: "nearest" });
}

function wizBack() {
  if (wiz.step === 3) { wiz.from = null; wiz.step = 2; return renderWizard(); }
  if (wiz.step === 2) {
    wiz.line = null; wiz.step = 1;
    applyLineTheme(WIZ_LINE);
    return renderWizard();
  }
  // step 1 → leave the wizard if there's somewhere to go back to
  if (wiz.cameFrom === "settings") return showSetup();
  if (activeRoute()) return showMain();
}

function renderWizard() {
  $("#wiz-dots").innerHTML = [1, 2, 3, 4]
    .map(i => `<span class="${i <= wiz.step ? "on" : ""}"></span>`).join("");
  // no back on true first-run step 1 (nowhere to go) or step 4 (route already saved)
  const canBack = wiz.step === 4 ? false
    : wiz.step > 1 || wiz.cameFrom === "settings" || !!activeRoute();
  $("#wiz-back").classList.toggle("invisible", !canBack);
  $("#wiz-back").onclick = wizBack;
  const filter = $("#wiz-filter");
  filter.value = "";
  filter.oninput = renderWizardList;
  filter.classList.toggle("hidden", wiz.step !== 2 && wiz.step !== 3); // stations only
  if (wiz.step === 1) {
    $("#wiz-title").textContent = "Tap your line";
    $("#wiz-sub").textContent = "Eleven lines cross Chicagoland. Tap yours on the map, or pick it below.";
  } else if (wiz.step === 2) {
    $("#wiz-title").textContent = "Tap your home station";
    $("#wiz-sub").textContent = `${wiz.line} · where you board in the morning.`;
  } else if (wiz.step === 3) {
    $("#wiz-title").textContent = "Tap where you're headed";
    $("#wiz-sub").textContent = `From ${wiz.from.name} · your destination on the line.`;
  } else {
    $("#wiz-title").textContent = "Never miss a train";
    $("#wiz-sub").textContent = "Choose what you'd like. Nothing turns on unless you say so; adjust anytime in Settings.";
  }
  applyMapState();
  if (wiz.step === 4) renderWizardFeatures(); else renderWizardList();
}

let wizStationRev = false; // station list order flip (default: toward downtown)

function renderWizardList() {
  const list = $("#wiz-list");
  const q = $("#wiz-filter").value.trim().toLowerCase();
  if (wiz.step === 1) {
    if (!lines.length) {
      list.innerHTML = `<div class="muted center">Couldn't load lines. Check your connection.<br><br><button class="ghost" id="wiz-retry">Try again</button></div>`;
      $("#wiz-retry").onclick = async () => {
        try { lines = await api("/api/lines"); } catch { /* stays empty */ }
        renderWizardList();
      };
      return;
    }
    // Saved routes shown up top as clearly-marked preferences you can jump back to,
    // plus a one-tap way to wipe everything and start clean.
    const saved = S.routes.length ? `
      <div class="wiz-saved">
        <div class="wiz-section-label">Your saved routes</div>
        ${S.routes.map(r => {
          const l = lines.find(x => x.id === r.line);
          return `<button class="wiz-row saved" data-rid="${esc(r.id)}">
            <span class="wiz-bar" style="background:${esc(l ? l.color : "#888")}"></span>
            <span class="wiz-txt"><span class="t">${esc(r.label)}</span><span class="s">${esc(r.line)} · ${esc(r.homeName)} ↔ ${esc(r.workName)}</span></span>
            <span class="wiz-go" aria-hidden="true">›</span>
          </button>`;
        }).join("")}
        <button class="ghost danger wiz-reset" id="wiz-reset">Reset &amp; Start Over</button>
      </div>
      <div class="wiz-section-label wiz-add-label">${S.routes.length >= 5 ? "Route limit reached (5)" : "Add another line"}</div>` : "";
    const lineCards = S.routes.length >= 5 ? "" : lines.map(l => `
      <button class="wiz-row" data-id="${esc(l.id)}">
        <span class="wiz-bar" style="background:${esc(l.color)}"></span>
        <span class="wiz-txt"><span class="t">${esc(l.id)}</span><span class="s">${esc(l.name)}</span></span>
        <span class="wiz-go" aria-hidden="true">›</span>
      </button>`).join("");
    list.innerHTML = saved + lineCards;
    list.querySelectorAll(".wiz-row.saved").forEach(b => b.onclick = () => {
      oneOff = null; S.activeRouteId = b.dataset.rid; persist(); wiz = null; showMain();
    });
    const rb = $("#wiz-reset");
    if (rb) twoTap(rb, "Tap again to reset", () => resetApp());
    // Two-way link: hovering a line card lights up its line on the map above,
    // mirroring how hovering the map highlights the card.
    list.querySelectorAll(".wiz-row:not(.saved)").forEach(b => {
      b.onclick = () => pickWizLine(b.dataset.id);
      b.onmouseenter = () => { if (wizMap) wizMap.hover(b.dataset.id); highlightWizLine(b.dataset.id); };
      b.onmouseleave = () => { if (wizMap) wizMap.hover(null); highlightWizLine(null); };
    });
    return;
  }
  if (wiz.loading) { list.innerHTML = `<div class="muted center">Loading stations…</div>`; return; }
  if (!wiz.sts.length) {
    list.innerHTML = `<div class="muted center">Couldn't load stations. Check your connection.<br><br><button class="ghost" id="wiz-retry">Try again</button></div>`;
    $("#wiz-retry").onclick = () => pickWizLine(wiz.line);
    return;
  }
  // Default order runs toward downtown (most riders' morning trip); flip to reverse.
  let ordered = orientDowntownLast(wiz.sts.slice());
  if (wizStationRev) ordered = [...ordered].reverse();
  // Step 3 pre-suggests the downtown terminal as the destination (one-tap Continue),
  // while still letting the rider pick any other station from the list.
  const sug = wiz.step === 3 ? suggestedDest() : null;
  const sts = ordered.filter(s =>
    (wiz.step === 2 || s.id !== wiz.from.id) && (!q || s.name.toLowerCase().includes(q)));
  const suggestHtml = sug ? `
    <div class="wiz-suggest">
      <div class="wiz-suggest-main"><span class="muted small">Suggested destination</span>
        <span class="wiz-suggest-name">${esc(sug.name)}</span></div>
      <button class="primary" id="wiz-confirm-dest">Continue</button>
    </div>
    <div class="wiz-section-label">or pick a different destination</div>` : "";
  const bar = `<div class="wiz-listbar">
    <span class="muted small">${wiz.step === 2 ? "Pick where you board" : "Any station on the line"}</span>
    <button class="wiz-rev" id="wiz-rev" title="Reverse order">⇅ Reverse</button></div>`;
  list.innerHTML = suggestHtml + bar + (sts.map(s => `
    <button class="wiz-row${sug && s.id === sug.id ? " suggested" : ""}" data-id="${esc(s.id)}">
      <span class="wiz-txt"><span class="t">${esc(s.name)}</span></span>
      <span class="wiz-go" aria-hidden="true">›</span>
    </button>`).join("") || `<div class="muted center">No stations match.</div>`);
  const cd = $("#wiz-confirm-dest");
  if (cd && sug) cd.onclick = () => pickWizStation(sug.id);
  $("#wiz-rev").onclick = () => { wizStationRev = !wizStationRev; renderWizardList(); };
  list.querySelectorAll(".wiz-row").forEach(b => b.onclick = () => pickWizStation(b.dataset.id));
}

// The most likely destination: the downtown terminal (unless the rider already
// boards there, in which case the far terminal).
function suggestedDest() {
  if (!wiz || !wiz.sts.length) return null;
  const oriented = orientDowntownLast(wiz.sts);
  const downtown = oriented[oriented.length - 1], far = oriented[0];
  const dest = (wiz.from && downtown.id !== wiz.from.id) ? downtown : far;
  return (wiz.from && dest.id === wiz.from.id) ? null : dest;
}

// Two-tap confirm (replaces confirm() dialogs, which the Tesla browser won't show).
function twoTap(btn, confirmText, action, ms = 4000) {
  const original = btn.textContent;
  let armed = false, timer = null;
  btn.onclick = () => {
    if (armed) { clearTimeout(timer); action(); return; }
    armed = true; btn.textContent = confirmText; btn.classList.add("confirm");
    timer = setTimeout(() => { armed = false; btn.textContent = original; btn.classList.remove("confirm"); }, ms);
  };
}

async function pickWizLine(id) {
  const l = lines.find(x => x.id === id);
  wiz.line = id;
  wiz.from = null;
  wiz.step = 2;
  if (l) applyLineTheme(l.color);
  const cached = mapGeo && mapGeo.stopsByLine[id];
  if (cached && cached.length) { wiz.sts = cached; wiz.loading = false; return renderWizard(); }
  wiz.loading = true;
  renderWizard();
  try { wiz.sts = (await api(`/api/stops?route=${encodeURIComponent(id)}`)).stations; }
  catch { wiz.sts = []; }
  wiz.loading = false;
  if (wiz && wiz.step === 2 && wiz.line === id) renderWizardList(); // still on this step
}

function pickWizStation(id) {
  const s = wiz.sts.find(x => x.id === id);
  if (!s) return;
  if (wiz.step === 3 && wiz.from && s.id === wiz.from.id) return; // can't get off where you boarded
  if (wiz.step === 2) { wiz.from = s; wiz.step = 3; renderWizard(); return; }
  if (S.routes.length >= 5) {
    $("#wiz-sub").textContent = "Route limit reached (5). Remove one in Settings first.";
    return;
  }
  const r = {
    id: "r" + Date.now(), line: wiz.line,
    home: wiz.from.id, homeName: wiz.from.name,
    work: s.id, workName: s.name,
    label: `${wiz.from.name} ↔ ${s.name}`,
  };
  S.routes.push(r);
  S.activeRouteId = r.id;
  persist(); syncPush();
  wiz.saved = r; // step 4 offers alerts + briefing for this route
  // Route saved; one last screen offers alerts, reminders, and the briefing.
  // Browsers without notification support (the Tesla) skip it: none of it can work there.
  if (!("Notification" in window)) return finishWizard();
  wiz.step = 4;
  renderWizard();
}

const WIZ_ICONS = [
  `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M6 16v-5a6 6 0 1 1 12 0v5l1.8 2H4.2z"/><path d="M10 20.5a2 2 0 0 0 4 0"/></svg>`,
  `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="8.2"/><path d="M12 7.5V12l3 1.8"/></svg>`,
  `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="4.2"/><path d="M12 3v2.2M12 18.8V21M3 12h2.2M18.8 12H21M5.6 5.6l1.6 1.6M16.8 16.8l1.6 1.6M18.4 5.6l-1.6 1.6M7.2 16.8l-1.6 1.6"/></svg>`,
];

// Step 4: opt in to alerts and/or the morning briefing. Nothing turns on unless
// the rider asks; everything here is also editable later under the settings cog.
function renderWizardFeatures() {
  const list = $("#wiz-list");
  const r = wiz.saved;
  const [bell, , sun] = WIZ_ICONS;
  list.innerHTML = `
    <div class="feat">${bell}<div><b>Delay alerts</b>
      <span>A push the moment your train is delayed or cancelled, even when the app is closed.</span>
      <label class="check"><input type="checkbox" id="wf-alerts"> Alert me about delays and cancellations</label>
    </div></div>
    <div class="feat">${sun}<div><b>Morning briefing</b>
      <span>One daily summary before you leave: your first trains and any alerts on the line.</span>
      <label class="check"><input type="checkbox" id="wf-brief"> Send me a morning briefing</label>
      <div id="wf-brief-cfg" class="feat-cfg hidden">
        <div class="grid2"><label>Time <input id="wf-brief-time" type="time" value="06:45"></label></div>
      </div>
    </div></div>
    <div class="feat-actions"><button id="wiz-finish" class="primary">Continue</button></div>
    <p id="wf-note" class="muted small center-note"></p>`;

  $("#wf-brief").onchange = e => $("#wf-brief-cfg").classList.toggle("hidden", !e.target.checked);
  enhanceTime($("#wf-brief-time"));

  const note = m => { $("#wf-note").textContent = m; };
  $("#wiz-finish").onclick = async () => {
    const n = S.nudges || (S.nudges = {});
    const wantAlerts = $("#wf-alerts").checked;
    const wantBrief = $("#wf-brief").checked;
    if (!wantAlerts && !wantBrief) {
      n.notif = n.notif || "skipped"; persist();
      return finishWizard();
    }
    // second tap after a denial proceeds without notifications
    if ($("#wiz-finish").dataset.denied) { persist(); return finishWizard(); }
    let granted = false;
    try { granted = (await Notification.requestPermission()) === "granted"; } catch { /* unsupported */ }
    if (!granted) {
      n.notif = "denied"; persist();
      note("Notifications are blocked in this browser, so these can't be delivered. You can enable them later in Settings.");
      $("#wiz-finish").dataset.denied = "1";
      $("#wiz-finish").textContent = "Continue without notifications";
      return;
    }
    S.notify = true; n.notif = "on";
    if (wantBrief) {
      const time = $("#wf-brief-time").value || "06:45";
      const [h, m] = time.split(":").map(Number);
      S.briefing = {
        enabled: true, time, timeSec: h * 3600 + m * 60, routeId: r.id, line: r.line,
        from: r.home, to: r.work, fromName: r.homeName, toName: r.workName, days: [1, 2, 3, 4, 5],
      };
    }
    persist(); subscribePush();
    finishWizard();
  };
}

function finishWizard() {
  wiz = null;
  showMain();
}

// ============================================================
// ONE-OFF TRIP SHEET (transient lookup, reachable from both views)
// ============================================================
function initOneOff() {
  const ooSel = $("#oo-line");
  ooSel.innerHTML = `<option value="">Choose a line…</option>` +
    lines.map(l => `<option value="${l.id}">${esc(lineLabel(l))}</option>`).join("");
  ooSel.onchange = async () => {
    ooStations = [];
    $("#oo-from").innerHTML = $("#oo-to").innerHTML = `<option value="">Choose a line first…</option>`;
    $("#oo-error").classList.add("hidden");
    if (!ooSel.value) return;
    try {
      ooStations = (await api(`/api/stops?route=${encodeURIComponent(ooSel.value)}`)).stations;
      $("#oo-from").innerHTML = $("#oo-to").innerHTML = stationOptions(ooStations);
    } catch {
      $("#oo-error").textContent = "Couldn't load stations. Check your connection.";
      $("#oo-error").classList.remove("hidden");
    }
  };
  $("#oo-go").onclick = () => {
    const err = $("#oo-error"); err.classList.add("hidden");
    const fail = m => { err.textContent = m; err.classList.remove("hidden"); };
    const line = ooSel.value;
    const from = ooStations.find(s => s.id === $("#oo-from").value);
    const to = ooStations.find(s => s.id === $("#oo-to").value);
    if (!line || !from || !to) return fail("Pick a line and both stations.");
    if (from.id === to.id) return fail("From and to must be different.");
    oneOff = { id: "__oneoff", line, home: from.id, homeName: from.name, work: to.id, workName: to.name, label: `${from.name} → ${to.name}` };
    closeOneOff();
    showMain();
  };
  ["#oo-line", "#oo-from", "#oo-to"].forEach(s => enhanceSelect($(s)));
  $("#oneoff-btn").onclick = openOneOff;
  $("#oo-open-setup").onclick = openOneOff;
  $("#oo-close").onclick = closeOneOff;
  $("#oo-modal").onclick = e => { if (e.target === $("#oo-modal")) closeOneOff(); };
  document.addEventListener("keydown", e => { if (e.key === "Escape") closeOneOff(); });
}
function openOneOff() { $("#oo-error").classList.add("hidden"); $("#oo-modal").classList.remove("hidden"); }
function closeOneOff() { $("#oo-modal").classList.add("hidden"); }

// ============================================================
// ABOUT SHEET + LIVE VISITOR COUNTER
// ============================================================
// The three "Built by" footers open one shared sheet; inside, today's visitor
// count rolls up on the app's own split-flap board. The count is global (Worker +
// KV); everything degrades quietly if those endpoints aren't reachable.

// This browser's current day in Chicago time, matching the server's day boundary.
function chicagoDay() {
  try { return new Intl.DateTimeFormat("en-CA", { timeZone: "America/Chicago" }).format(new Date()); }
  catch { return new Date().toISOString().slice(0, 10); }
}

// Count this browser as a visitor at most once per Chicago day (keeps the number
// reading as unique daily riders and stays well inside KV's write budget).
function pingVisit() {
  const today = chicagoDay();
  if (S.visitPing === today) { renderVisits(loadVisitStats()); return; } // already counted today
  apiPost("/api/visit", {}).then(stats => {
    S.visitPing = today; persist();
    cacheVisitStats(stats); renderVisits(stats);
  }).catch(() => { /* offline or endpoint not live yet — retry next boot */ });
}

function cacheVisitStats(stats) {
  if (!stats || typeof stats.today !== "number") return;
  lastVisitStats = stats;
  try { localStorage.setItem("mct_visits", JSON.stringify(stats)); } catch { /* quota */ }
}
function loadVisitStats() {
  if (lastVisitStats) return lastVisitStats;
  try { return JSON.parse(localStorage.getItem("mct_visits") || "null"); } catch { return null; }
}

function initAbout() {
  document.querySelectorAll(".built-by[data-about]").forEach(b => b.onclick = openAbout);
  const close = $("#about-close"), modal = $("#about-modal");
  if (close) close.onclick = closeAbout;
  if (modal) modal.onclick = e => { if (e.target === modal) closeAbout(); };
  document.addEventListener("keydown", e => { if (e.key === "Escape") closeAbout(); });
}
function openAbout() {
  const modal = $("#about-modal"); if (!modal) return;
  modal.classList.remove("hidden");
  renderVisits(loadVisitStats());                         // instant paint from cache
  api("/api/visits").then(stats => { cacheVisitStats(stats); renderVisits(stats); }).catch(() => {});
}
function closeAbout() { const m = $("#about-modal"); if (m) m.classList.add("hidden"); }

// Paint the counter block: big split-flap "today", a 7-day sparkline, all-time total.
function renderVisits(stats) {
  const wrap = $("#visits"); if (!wrap) return;
  if (!stats || typeof stats.today !== "number") { wrap.hidden = true; return; }
  wrap.hidden = false;

  const flap = $("#visits-flap");
  if (flap) {
    flap.setAttribute("aria-label", `${stats.today.toLocaleString()} ${stats.today === 1 ? "rider" : "riders"} aboard today`);
    paintFlapNumber(flap, String(Math.max(0, stats.today)));
  }
  renderVisitSpark($("#visits-spark"), stats.days || []);
  const tot = $("#visits-total");
  if (tot) tot.innerHTML = typeof stats.total === "number" ? `<b>${stats.total.toLocaleString()}</b> all-time` : "";
}

// Render a number onto a flap board and roll it up with a staggered Solari reveal
// (reuses the departure-board cards so it matches the countdown exactly).
function paintFlapNumber(el, digits) {
  el.innerHTML = digits.split("").map(() => cardOrColon("0")).join("");
  const cards = [...el.children];
  cards.forEach((card, i) => {
    const target = digits[i];
    if (target === "0") return;                              // card already reads 0
    if (REDUCE_MOTION) { flipCardTo(card, target); return; } // no stagger, land immediately
    setTimeout(() => flipCardTo(card, target), 140 + i * 110);
  });
}

// Tiny bar sparkline of the last several days; today's bar is highlighted.
function renderVisitSpark(svg, days) {
  if (!svg) return;
  const data = (days || []).slice(-7);
  if (data.length < 2) { svg.classList.add("hidden"); return; }
  svg.classList.remove("hidden");
  const W = 160, H = 34, gap = 5, cnt = data.length;
  const bw = (W - gap * (cnt - 1)) / cnt;
  const max = Math.max(1, ...data.map(d => d.count));
  svg.setAttribute("viewBox", `0 0 ${W} ${H}`);
  svg.innerHTML = data.map((d, i) => {
    const h = Math.max(2, Math.round((d.count / max) * (H - 4)));
    const x = i * (bw + gap), y = H - h, today = i === cnt - 1;
    return `<rect x="${x.toFixed(1)}" y="${y}" width="${bw.toFixed(1)}" height="${h}" rx="1.5" fill="var(--line)" opacity="${today ? 1 : 0.38}"><title>${d.count} on ${fmtVisitDay(d.date)}</title></rect>`;
  }).join("");
}
function fmtVisitDay(ymd) { // "20260721" -> "Jul 21"
  const y = +ymd.slice(0, 4), m = +ymd.slice(4, 6) - 1, d = +ymd.slice(6, 8);
  return new Date(Date.UTC(y, m, d)).toLocaleDateString("en-US", { month: "short", day: "numeric", timeZone: "UTC" });
}

// ============================================================
// FARES — a quiet "Fares & passes" link in the footer opens the full fare sheet
// (one-way / day pass / monthly + break-even, and weekend passes). Fares come from
// the Worker (/api/next + /api/timetable); the link hides quietly when unavailable.
// The fare is symmetric (priced by zone pair), so one link serves both directions
// and the one-off trip board, which reuses this same main view.
// ============================================================

// Metra prices are always to the cent on the fare chart ($6.75, $135.00).
function fareMoney(n) { return n == null ? "" : "$" + Number(n).toFixed(2); }
// "Zone 1–4" (or "Zone 3" when both ends sit in one zone).
function zoneLabel(pair) {
  if (!pair) return "";
  const [a, b] = String(pair).split("-");
  return a === b ? `Zone ${a}` : `Zone ${a}–${b}`;
}
function fmtFareAsOf(asOf) { // "2026-07" -> "Jul 2026"
  const m = /^(\d{4})-(\d{2})/.exec(String(asOf || ""));
  if (!m) return String(asOf || "");
  return new Date(Date.UTC(+m[1], +m[2] - 1, 1)).toLocaleDateString("en-US", { month: "short", year: "numeric", timeZone: "UTC" });
}

function initFare() {
  const link = $("#fare-link");
  if (link) link.onclick = openFare;
  const close = $("#fare-close"), modal = $("#fare-modal");
  if (close) close.onclick = closeFare;
  if (modal) modal.onclick = e => { if (e.target === modal) closeFare(); };
  document.addEventListener("keydown", e => { if (e.key === "Escape") closeFare(); });
}

// Show/hide the footer "Fares & passes" link and remember the fare for the sheet.
function renderFareLink(fare) {
  lastFare = fare && fare.oneWay != null ? fare : null;
  const link = $("#fare-link");
  if (link) link.classList.toggle("hidden", !lastFare);
}

function openFare() {
  const modal = $("#fare-modal"); if (!modal || !lastFare) return;
  renderFareSheet(lastFare);
  modal.classList.remove("hidden");
}
function closeFare() { const m = $("#fare-modal"); if (m) m.classList.add("hidden"); }

// One fare row. A null amount renders a muted "—" (Metra didn't price it / a data
// gap) rather than the row silently disappearing.
function fareRow(name, sub, amt) {
  return `<tr><td class="fare-name"><b>${esc(name)}</b><span class="fare-sub">${esc(sub)}</span></td>
    <td class="fare-amt${amt == null ? " na" : ""}">${amt == null ? "—" : fareMoney(amt)}</td></tr>`;
}

function renderFareSheet(fare) {
  const body = $("#fare-body"); if (!body) return;
  const r = activeRoute();
  const heading = r
    ? `${esc(r.homeName)} <span class="arrow">⇆</span> ${esc(r.workName)} · ${esc(zoneLabel(fare.zonePair))}`
    : esc(zoneLabel(fare.zonePair));
  // Zone-based commuter fares — always shown (missing ones read "—", never vanish).
  const commuter = [
    ["One-way", "single ride", fare.oneWay],
    ["Day Pass", "unlimited rides today", fare.day],
    ["Monthly Pass", "unlimited for the calendar month", fare.monthly],
  ].map(([n, s, a]) => fareRow(n, s, a)).join("");
  // Flat, systemwide weekend passes (only shown when we have them).
  const weekend = [
    ["Weekend Day Pass", "unlimited systemwide · Sat, Sun, or holiday", fare.weekendDay],
    ["Weekend Pass", "unlimited systemwide · Sat + Sun (Ventra app)", fare.weekend],
  ].filter(([, , a]) => a != null);
  const weekendHtml = weekend.length ? `
    <p class="fare-subhead">Weekends &amp; holidays</p>
    <table class="fare-table"><tbody>${weekend.map(([n, s, a]) => fareRow(n, s, a)).join("")}</tbody></table>` : "";
  body.innerHTML = `
    <p class="fare-route muted small">${heading}</p>
    <table class="fare-table"><tbody>${commuter}</tbody></table>
    ${fareTipHtml(fare)}
    ${weekendHtml}
    <p class="fare-foot muted small">Full fare (adult); reduced fares apply for seniors, riders with disabilities, K–12 students, and active-duty military. Weekend passes are a flat systemwide rate. Prices from Metra${fare.asOf ? `, as of ${esc(fmtFareAsOf(fare.asOf))}` : ""}.</p>`;
}

// "Ride N+ round trips a month? A Monthly pays for itself" + rough monthly saving
// at a typical ~20 commuting days. Break-even = ⌈monthly / (2·oneWay)⌉ round trips.
function fareTipHtml(fare) {
  if (fare.monthly == null || fare.oneWay == null) return "";
  const rt = fare.roundTrip || Math.round(fare.oneWay * 200) / 100;
  const be = fare.breakEvenRoundTrips || (rt > 0 ? Math.ceil(fare.monthly / rt) : null);
  if (!be) return "";
  const typical = 20;
  const save = Math.round(typical * rt - fare.monthly);
  const saveTxt = save > 0 ? ` At about ${typical} round trips a month you'd save roughly <b>$${save}</b>.` : "";
  return `<div class="fare-tip"><b>Ride ${be}+ round trips a month?</b> A Monthly pass pays for itself.${saveTxt}</div>`;
}

// ============================================================
// THEME (system / light / dark)
// ============================================================
// The preference is stored in S.theme; the applied value (resolvedTheme) is set as
// data-theme on <html>. A tiny inline script in index.html applies it before first
// paint (no flash); this keeps the in-memory state and accent in sync afterward.
function themePref() { return S.theme || "dark"; }
function resolveTheme(pref = themePref()) {
  if (pref === "light") return "light";
  if (pref === "dark") return "dark";
  return themeMedia && !themeMedia.matches ? "light" : "dark"; // system: matches === prefers dark
}
function applyTheme() {
  resolvedTheme = resolveTheme();
  document.documentElement.setAttribute("data-theme", resolvedTheme);
  const meta = $('meta[name="theme-color"]');
  if (meta) meta.setAttribute("content", resolvedTheme === "light" ? "#F2F5F9" : "#0A0F15");
  const r = activeRoute();
  if (r && lines.length) applyLineTheme(lineColor(r.line)); // re-tint accent for the new canvas
}
function setThemePref(pref) { S.theme = pref; persist(); applyTheme(); syncThemeSeg(); }
function syncThemeSeg() {
  const seg = $("#theme-seg"); if (!seg) return;
  seg.querySelectorAll("button").forEach(b => {
    const on = b.dataset.themePref === themePref();
    b.classList.toggle("on", on);
    b.setAttribute("aria-pressed", on ? "true" : "false");
  });
}

// ============================================================
// MAIN VIEW
// ============================================================
function showMain() {
  swapView("main");
  const route = activeRoute();
  applyLineTheme(lineColor(route.line));
  $("#route-picker").innerHTML =
    (oneOff ? `<option value="__oneoff" selected>One-off: ${esc(oneOff.label)}</option>` : "") +
    S.routes.map(r => `<option value="${r.id}" ${!oneOff && r.id === route.id ? "selected" : ""}>${esc(r.label)}</option>`).join("");
  $("#route-picker").onchange = e => {
    if (e.target.value === "__oneoff") return;
    oneOff = null;
    S.activeRouteId = e.target.value; persist(); lastSeen.clear(); notifiedAlerts.clear(); expandedTrain = {}; stripReversed = {}; showMain();
  };
  enhanceSelect($("#route-picker")); // tap-friendly dropdown (Tesla browser)
  const l = lines.find(x => x.id === route.line);
  $("#line-pill").innerHTML = `<span class="line-pill">
    <span class="lp-dot" style="background:${esc(lineColor(route.line))}"></span>
    <span class="lp-txt">${esc(l ? lineLabel(l) : route.line + " Line")}</span></span>`;
  // Back chevron AND the title both open line selection; cog opens notifications/settings.
  const toLines = () => { stopPolling(); showWizard("board"); };
  $("#back-btn").onclick = toLines;
  $("#route-title").onclick = toLines;
  $("#route-title").onkeydown = e => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); toLines(); } };
  $("#settings-btn").onclick = () => { stopPolling(); showSetup({ scrollTo: "#sec-notif" }); };
  renderSocial(route);
  renderFareLink(null); // clear any prior route's fare; render() refills once data lands
  loadCache(); // hydrate last-good board so an offline open shows something
  startPolling();
}

// X (twitter) service-update feed for the active line — collapsed by default,
// embed loaded lazily on first expand, always with a plain link fallback.
function renderSocial(route) {
  const handle = X_HANDLES[route.line] || "Metra";
  $("#social").innerHTML = `
    <details class="social">
      <summary>Service updates · <a href="https://x.com/${handle}" target="_blank" rel="noopener">@${handle}</a> on X</summary>
      <div class="social-body"><div class="muted small">Tap to load the latest posts…</div></div>
    </details>`;
  const det = $("#social details");
  det.addEventListener("toggle", () => { if (det.open) loadTimeline(det, handle); }, { once: true });
}

function loadTimeline(det, handle) {
  const body = det.querySelector(".social-body");
  body.innerHTML = `
    <a class="twitter-timeline" data-height="460" data-theme="dark"
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
  $("#view-tabs").innerHTML = [["live", "Live", true], ["schedule", "Schedule", false]]
    .map(([v, l, live]) => `<button data-v="${v}" class="${view === v ? "on" : ""}" role="tab" aria-selected="${view === v}">${live ? `<span class="tab-live"></span>` : ""}${l}</button>`).join("");
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
  if (!route) return showWizard("boot");

  const seq = ++reqSeq; // this refresh's token; a route switch bumps it and voids us
  const modified = Object.values(lastData).some(d => d && d.serviceNote);
  const dir = resolveDirection(settings(), S.override, new Date(), modified);
  const dirs = dir === "BOTH" ? ["HW", "WH"] : [dir];
  renderControls(dir);
  if (ttDate) return renderTimetable(dirs, seq);

  let offline = false;
  for (const d of dirs) {
    const [from, to] = d === "HW" ? [route.home, route.work] : [route.work, route.home];
    try {
      const data = await api(`/api/next?route=${encodeURIComponent(route.line)}&from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}&count=4`);
      if (seq !== reqSeq) return; // newer request started — this is a stale response, drop it
      data.fetchedAt = Date.now();
      lastData[d] = data;
      maybeNotify(d, data);
    } catch {
      offline = true; // keep stale lastData[d] if we have it
    }
  }

  if (seq !== reqSeq) return; // route/view changed while we awaited — don't paint stale data
  if (!offline) saveCache(); // persist last-good board for offline opens
  render(dirs, offline);
}

function render(dirs, offline) {
  const route = activeRoute();
  const first = lastData[dirs[0]];

  $("#route-title").innerHTML = dirs.length === 2
    ? `${esc(route.homeName)} <span class="arrow">⇆</span> ${esc(route.workName)}`
    : dirTitle(dirs[0]);

  // alerts → splash toasts: each new alert appears once, fades after 30s, and is
  // remembered for the rest of the (Chicago) day so it never nags on every poll.
  const seen = new Set(); const activeAlerts = [];
  for (const d of dirs) for (const a of (lastData[d]?.alerts || [])) {
    if (seen.has(a.id)) continue; seen.add(a.id);
    activeAlerts.push(a);
  }
  splashNewAlerts(activeAlerts);
  updateAlertChip(activeAlerts);

  // banner
  const b = $("#banner");
  const staleDays = metaStaleDays();
  if (offline) {
    const t = first ? new Date(first.fetchedAt).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" }) : null;
    b.textContent = t ? `Offline. Showing data from ${t}.` : "Offline. No cached data yet.";
    b.className = "banner offline";
  } else if (staleDays != null && staleDays >= 2) {
    b.textContent = `Schedule data is ${staleDays} days old. Times may be outdated.`;
    b.className = "banner";
  } else if (first && first.serviceNote) {
    b.textContent = "Modified schedule in effect today (holiday or special service).";
    b.className = "banner";
  } else if (first && first.realtime === false) {
    b.textContent = "Live updates temporarily unavailable. Showing scheduled times.";
    b.className = "banner offline";
  } else b.className = "banner hidden";

  paintContent(dirs, offline);
  renderFareLink(first && first.fare); // footer fares link (same fare for both directions)

  dirs.forEach(loadWeather); // fill the weather line under each hero (async, optional)
  renderNudge();             // contextual feature discovery (alerts, briefing)

  const anyAlert = seen.size > 0;
  const cancelledNext = dirs.some(d => lastData[d]?.trains?.[0]?.cancelled);
  updateBadge(bestTrain(dirs), anyAlert, cancelledNext, dirs);

  $("#updated").textContent = first ? `Updated ${new Date(first.fetchedAt).toLocaleTimeString([], { hour: "numeric", minute: "2-digit", second: "2-digit" })}` : "";
  $("#rt-status").innerHTML = first ? (first.realtime ? `<span class="live-dot">live</span>` : "scheduled only") : "";
}

// Paint the direction sections. Kept separate from render() so the route-strip
// reverse toggle can repaint from cached data without re-firing alert toasts.
function paintContent(dirs, offline) {
  $("#content").innerHTML = dirs.map(d => sectionHtml(d)).join("") || `<div class="muted center">No data.</div>`;
  // Hero "Stops & arrival times" toggle (collapsed by default).
  $("#content").querySelectorAll(".stops-toggle").forEach(b => b.onclick = e => {
    e.stopPropagation();
    const key = b.dataset.key;
    expandedTrain[key] = !expandedTrain[key];
    const wrap = b.closest(".stops-wrap");
    wrap.classList.toggle("open", expandedTrain[key]);
    b.setAttribute("aria-expanded", expandedTrain[key]);
    b.querySelector(".st-lbl").innerHTML = expandedTrain[key] ? "Hide stops" : "Stops &amp; arrival times";
    if (expandedTrain[key]) scrollStripToTrain(wrap);
  });
  // Subsequent trains: tap the row to expand its own stop list.
  $("#content").querySelectorAll(".trip-row").forEach(b => b.onclick = e => {
    e.stopPropagation();
    const key = b.dataset.key;
    expandedTrain[key] = !expandedTrain[key];
    b.closest(".trip").classList.toggle("open", expandedTrain[key]);
    b.setAttribute("aria-expanded", expandedTrain[key]);
  });
  // Reverse the stop order (repaint only — no refetch, no re-toast).
  $("#content").querySelectorAll(".rs-rev").forEach(b => b.onclick = e => {
    e.stopPropagation();
    stripReversed[b.dataset.dir] = !stripReversed[b.dataset.dir];
    paintContent(dirs, offline);
  });
  // Keep the train marker in view within any already-open hero strip.
  $("#content").querySelectorAll(".stops-wrap.open").forEach(scrollStripToTrain);
}
function scrollStripToTrain(wrap) {
  const body = wrap.querySelector(".rs-body"), m = wrap.querySelector(".rs-train");
  if (body && m) body.scrollTop = Math.max(0, parseFloat(m.style.top || "0") - body.clientHeight / 2);
}

// ---------- alert splash toasts (point: transient, once-per-day) ----------
function chicagoDayKey() {
  return new Intl.DateTimeFormat("en-CA", { timeZone: "America/Chicago", year: "numeric", month: "2-digit", day: "2-digit" })
    .format(new Date()).replace(/-/g, "");
}
function splashNewAlerts(alerts) {
  if (!alerts.length) return;
  const today = chicagoDayKey();
  let sa = S.alertsSeen;
  if (!sa || sa.day !== today) sa = S.alertsSeen = { day: today, ids: [] };
  let added = false;
  for (const a of alerts) {
    if (sa.ids.includes(a.id)) continue;
    sa.ids.push(a.id); added = true;
    showToast(a);
  }
  if (added) persist();
}
function showToast(a) {
  const wrap = $("#toasts"); if (!wrap) return;
  const el = document.createElement("div");
  el.className = "toast";
  el.innerHTML = `<span class="toast-ico">⚠</span>
    <div class="toast-body"><b>${esc(a.header)}</b>${a.description ? `<span>${esc(a.description)}</span>` : ""}</div>
    <button class="toast-x" aria-label="Dismiss">✕</button>`;
  wrap.appendChild(el);
  requestAnimationFrame(() => el.classList.add("in"));
  let gone = false;
  const dismiss = () => { if (gone) return; gone = true; el.classList.remove("in"); el.classList.add("out"); setTimeout(() => el.remove(), 400); };
  el.querySelector(".toast-x").onclick = dismiss;
  setTimeout(dismiss, 30000); // subtly disappear after 30s
}
// A small persistent chip so a missed splash can be re-opened.
function updateAlertChip(alerts) {
  const chip = $("#alert-chip"); if (!chip) return;
  if (!alerts.length) { chip.classList.add("hidden"); chip.onclick = null; return; }
  chip.classList.remove("hidden");
  chip.textContent = `⚠ ${alerts.length} service alert${alerts.length > 1 ? "s" : ""}`;
  chip.onclick = () => alerts.forEach(showToast);
}

// Downtown-terminal detection, so lists can default to "toward Chicago".
const DOWNTOWN_RE = /(union station|ogilvie|\botc\b|millennium|van buren|la ?salle|randolph|museum campus)/i;
function orientDowntownLast(sts) {
  if (sts.length < 2) return sts;
  const firstDT = DOWNTOWN_RE.test(sts[0].name), lastDT = DOWNTOWN_RE.test(sts[sts.length - 1].name);
  return (firstDT && !lastDT) ? [...sts].reverse() : sts;
}

// ---------- route diagram (vertical strip): readable stop names + live train ----------
// Every stop named with its time, board/arrive ends marked, skipped stops dimmed,
// and the train's position shown by a dot on the rail (status text lives in the
// header, so nothing overlaps a station name). Collapsed by default via stopsBlock.
const ROW_H = 34;
let expandedTrain = {}; // "dir:tripId" -> whether this train's stop list is open

function routeStripInner(data, train, d, withMarker) {
  let sts = (data.stations || []).slice();
  if (!sts.length) return "";
  const route = activeRoute();
  const fromId = d === "HW" ? route.home : route.work;
  const toId = d === "HW" ? route.work : route.home;
  if (sts[0].id !== fromId) sts.reverse();      // canonical order: origin → destination
  const n = sts.length;

  // train progress as a fraction along origin→destination (only for the next train)
  let frac = null, mode = null;
  if (withMarker) {
    const pos = data.position && data.position.tripId === train.tripId && data.position.lat != null ? data.position : null;
    if (pos) {
      let best = 0, bd = Infinity;
      sts.forEach((s, i) => { if (s.lat == null) return; const dd = (s.lat - pos.lat) ** 2 + (s.lon - pos.lon) ** 2; if (dd < bd) { bd = dd; best = i; } });
      frac = best / (n - 1); mode = "live";
    } else if (Date.now() >= train.depEpochMs && Date.now() < train.arrEpochMs) {
      frac = Math.min(0.98, (Date.now() - train.depEpochMs) / Math.max(1, train.arrEpochMs - train.depEpochMs)); mode = "est";
    } else if (Date.now() < train.depEpochMs) {
      frac = 0; mode = "pre";
    }
  }

  const served = new Set((train.stops || []).map(s => s.id));
  const times = {}; for (const s of (train.stops || [])) times[s.id] = s.dep;

  const reversed = !!stripReversed[d];
  const view = reversed ? [...sts].reverse() : sts;
  const fracView = frac == null ? null : (reversed ? 1 - frac : frac);

  const rows = view.map(s => {
    const isFrom = s.id === fromId, isTo = s.id === toId;
    const on = served.has(s.id) || isFrom || isTo;
    return `<div class="rs-stop ${on ? "on" : "off"}${isFrom ? " from" : ""}${isTo ? " to" : ""}">
      <span class="rs-rail"><span class="rs-dot"></span></span>
      <span class="rs-name">${esc(s.name)}</span>
      ${isFrom || isTo ? `<span class="rs-tag">${isFrom ? "board" : "arrive"}</span>` : ""}
      <span class="rs-time">${on ? esc(times[s.id] || "·") : "skips"}</span>
    </div>`;
  }).join("");

  let marker = "", status = "";
  if (fracView != null) {
    const y = fracView * (n - 1) * ROW_H + ROW_H / 2;
    marker = `<div class="rs-train ${mode}" style="top:${y.toFixed(0)}px"><span class="rs-train-dot ${mode === "live" ? "pulse" : ""}"></span></div>`;
    const stxt = mode === "live" ? "● live position" : mode === "est" ? "● en route" : `departs ${esc(train.dep)}`;
    status = `<span class="rs-status ${mode}">${stxt}</span>`;
  }

  return `<div class="rs" data-dir="${d}">
    <div class="rs-head">
      <span class="rs-head-title">${esc(view[0].name)} <span class="arrow">→</span> ${esc(view[n - 1].name)}</span>
      ${status}
      <button class="rs-rev" data-dir="${d}" title="Reverse order">⇅</button>
    </div>
    <div class="rs-body">${rows}${marker}</div>
  </div>`;
}

// Collapsible wrapper (stops hidden by default) used on the next-train hero.
function stopsBlock(data, train, d) {
  const inner = routeStripInner(data, train, d, true);
  if (!inner) return "";
  const key = d + ":" + train.tripId;
  const open = !!expandedTrain[key];
  return `<div class="stops-wrap${open ? " open" : ""}">
    <button class="stops-toggle" data-key="${esc(key)}" aria-expanded="${open}">
      <span class="st-lbl">${open ? "Hide stops" : "Stops &amp; arrival times"}</span><span class="caret">▾</span>
    </button>
    <div class="stops-collapse">${inner}</div>
  </div>`;
}

// Full-day scheduled timetable for any date (incl. weekends) — no realtime merge.
async function renderTimetable(dirs, seq = reqSeq) {
  const route = activeRoute();
  $("#route-title").innerHTML = dirs.length === 2
    ? `${esc(route.homeName)} <span class="arrow">⇆</span> ${esc(route.workName)}`
    : dirTitle(dirs[0]);
  $("#alerts").innerHTML = "";
  $("#banner").className = "banner hidden";

  const chips = quickDays().map(c =>
    `<button class="chip-day ${c.iso === ttDate ? "on" : ""}" data-iso="${c.iso}">${c.label}</button>`).join("");
  // Date picker as a dropdown of the next 21 days (native <input type=date>
  // popups don't open in the Tesla browser); quick chips above cover the common ones.
  const dateOpts = Array.from({ length: 21 }, (_, i) => addDays(new Date(), i)).map(dt => {
    const iso = fmtISO(dt);
    const label = dt.toLocaleDateString([], { weekday: "short", month: "short", day: "numeric" });
    return `<option value="${iso}"${iso === ttDate ? " selected" : ""}>${esc(label)}</option>`;
  }).join("");
  let html = `<div class="datebar">${chips}
    <select id="tt-date" aria-label="Pick a date">${dateOpts}</select></div>`;

  let note = null, fare = null;
  for (const d of dirs) {
    const [from, to] = d === "HW" ? [route.home, route.work] : [route.work, route.home];
    html += `<div class="direction-head">${dirTitle(d)}</div>`;
    try {
      const data = await api(`/api/timetable?route=${encodeURIComponent(route.line)}&from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}&date=${ttDate.replace(/-/g, "")}`);
      if (seq !== reqSeq) return; // route/date changed mid-load — abandon this stale timetable
      note = note || data.serviceNote;
      fare = fare || data.fare;
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
  if (seq !== reqSeq) return; // a newer route/view took over while we awaited — don't paint
  $("#content").innerHTML = html;
  renderFareLink(fare); // same fare applies to the scheduled board
  if (note) {
    const b = $("#banner");
    b.textContent = "Modified schedule (holiday or special service).";
    b.className = "banner";
  }
  $("#content").querySelectorAll(".chip-day").forEach(b => b.onclick = () => { ttDate = b.dataset.iso; refresh(); });
  $("#tt-date").onchange = e => { if (e.target.value) { ttDate = e.target.value; refresh(); } };
  enhanceSelect($("#tt-date")); // tap-friendly dropdown (Tesla browser)
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
  const label = next.cancelled ? "Next scheduled train · cancelled"
    : next.class === "E" ? "Next express train" : "Next available train";

  return `${head}
    <div class="section-label">${label}</div>
    <div class="hero" data-dir="${d}">
      <div class="hero-head">
        <div class="hero-left">
          <div class="hero-chips"><span class="chip ${next.class}">${next.class === "E" ? "Express" : "Local"}</span>${statusPill(next)}</div>
          <div class="times">
            ${next.delayMin > 0 ? `<span class="was">${next.depScheduled}</span>` : ""}${next.dep}
            <span class="to">→ ${next.arr}</span>
          </div>
          <div class="hero-meta">Train ${esc(trainNoShort(next.trainNo))}${next.cancelled ? "" : `<span class="wx" data-wx="${d}"></span>`}</div>
          ${next.cancelled ? "" : liveLocation(data, next)}
        </div>
        <div class="hero-countdown">
          ${next.cancelled
            ? `<div class="cd-cancel">Cancelled</div>`
            : `<div class="flapboard" data-dep="${next.depEpochMs}" data-sig="${flapSig(fmtFlap(next.depEpochMs))}">${flapCards(next.depEpochMs)}</div>`}
        </div>
      </div>
      ${next.cancelled ? "" : stopsBlock(data, next, d)}
    </div>
    ${hint ? `<div class="hint">Express Train ${esc(trainNoShort(hint.trainNo))} leaves at ${hint.dep} (in ${hint.minutes} min). Worth waiting?</div>` : ""}
    <div class="list">
      ${rest.map(t => {
        const key = d + ":" + t.tripId;
        const open = !!expandedTrain[key];
        return `<div class="trip${open ? " open" : ""}">
          <button class="row trip-row ${t.cancelled ? "cancelled" : ""}${t.delayMin > 0 ? " late" : ""}" data-key="${esc(key)}" aria-expanded="${open}">
            <span class="dep">${t.delayMin > 0 ? `<span class="was">${t.depScheduled}</span>` : ""}${t.dep}</span>
            <span class="meta">${t.class === "E" ? "Express" : "Local"} · Train ${esc(trainNoShort(t.trainNo))}${miniStatus(t)}</span>
            <span class="right">${t.cancelled ? "Cancelled"
              : `<span class="jt" title="Total journey time">${JT_ICON}${fmtDur(Math.round((t.arrEpochMs - t.depEpochMs) / 60000))}</span>`}<span class="caret">▾</span></span>
          </button>
          ${t.cancelled ? "" : `<div class="stops-collapse">${routeStripInner(data, t, d, false)}</div>`}
        </div>`;
      }).join("")}
    </div>`;
}

// Live location line in the hero: shown when Metra's positions feed is actively
// tracking this train (only running/imminent trains — future departures show the
// countdown instead). Surfaces "where's my train" without opening the diagram.
function liveLocation(data, train) {
  const p = data.position && data.position.tripId === train.tripId && data.position.lat != null ? data.position : null;
  if (!p) return "";
  const sts = (data.stations || []).filter(s => s.lat != null);
  let near = "";
  if (sts.length) {
    let best = sts[0], bd = Infinity;
    for (const s of sts) { const dd = (s.lat - p.lat) ** 2 + (s.lon - p.lon) ** 2; if (dd < bd) { bd = dd; best = s; } }
    near = ` · near ${esc(best.name)}`;
  }
  return `<div class="live-loc"><span class="live-pip"></span>Live now${near}</div>`;
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

// ---------- contextual feature discovery (one card at a time, never nagging) ----------
// Onboarding asks nothing beyond the route; power features are offered here, in
// context, after the rider has seen value. Each card is one-shot: any answer
// (including "Not now") is remembered and the card never returns.
function renderNudge() {
  const el = $("#nudge"); if (!el) return;
  el.innerHTML = "";
  if (oneOff) return; // a transient trip is not the moment to configure alerts
  const n = S.nudges || (S.nudges = {});

  // 1) Delay alerts — offered on the first board view.
  if (!S.notify && "Notification" in window && !n.notif) {
    el.innerHTML = `
      <div class="nudge">
        <div class="nudge-txt"><b>Never miss a delay</b>
        <span>Get alerts for delays and cancellations on your line, even when the app is closed.</span></div>
        <div class="nudge-btns"><button class="primary" id="nudge-yes">Enable alerts</button>
        <button class="ghost" id="nudge-no">Not now</button></div>
      </div>`;
    $("#nudge-yes").onclick = async () => {
      const p = await Notification.requestPermission();
      if (p === "granted") { S.notify = true; n.notif = "on"; persist(); subscribePush(); }
      else { n.notif = "denied"; persist(); }
      renderNudge();
    };
    $("#nudge-no").onclick = () => { n.notif = "dismissed"; persist(); renderNudge(); };
    return;
  }

  // 2) Morning briefing — offered once alerts are on and the app has proven itself.
  if (S.notify && !S.briefing && !n.brief && (S.visits || 0) >= 3) {
    el.innerHTML = `
      <div class="nudge">
        <div class="nudge-txt"><b>Start the day ahead of your train</b>
        <span>A morning briefing with your first departures and any alerts, before you leave.</span></div>
        <div class="nudge-btns"><button class="primary" id="nudge-yes">Set it up</button>
        <button class="ghost" id="nudge-no">No thanks</button></div>
      </div>`;
    $("#nudge-yes").onclick = () => {
      n.brief = "seen"; persist();
      stopPolling(); showSetup({ scrollTo: "#sec-briefing" });
    };
    $("#nudge-no").onclick = () => { n.brief = "dismissed"; persist(); renderNudge(); };
  }
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
    notify("Service alert", a.header + (a.description ? `. ${a.description}` : ""), `alert:${a.id}`);
  }
}

// ---------- misc ----------
function updateCountdowns() {
  document.querySelectorAll("[data-dep]").forEach(el => {
    const dep = Number(el.dataset.dep);
    if (el.classList.contains("flapboard")) updateFlap(el, dep); // animated flip-board
    else el.textContent = fmtCountdown(dep);                     // list rows
  });
}
function swapView(name) {
  $("#view-main").classList.toggle("hidden", name !== "main");
  $("#view-setup").classList.toggle("hidden", name !== "setup");
  $("#view-wizard").classList.toggle("hidden", name !== "wizard");
}
function esc(s) { return String(s).replace(/[&<>"]/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c])); }

// ---------- tap-friendly dropdown ----------
// The Tesla in-car browser (and some embedded webviews) won't open native
// <select> popups, so the rider can't pick anything and the app is unusable.
// Fix: keep the real <select> in the DOM as the source of truth — so every
// existing .value / .innerHTML / change-event path keeps working — but hide its
// native popup and drive it from a custom button + option list made of plain
// elements. A MutationObserver re-syncs the button label whenever options are
// (re)populated, so the many call sites that fill these selects need no changes.
function enhanceSelect(sel) {
  if (!sel || sel._enhanced) return;
  sel._enhanced = true;

  const wrap = document.createElement("span");
  wrap.className = "cs";
  sel.parentNode.insertBefore(wrap, sel);
  wrap.appendChild(sel);                 // native select stays, just visually hidden
  sel.classList.add("cs-native");

  const btn = document.createElement("button");
  btn.type = "button";
  btn.className = "cs-btn";
  btn.setAttribute("aria-haspopup", "listbox");
  btn.setAttribute("aria-expanded", "false");

  const panel = document.createElement("div");
  panel.className = "cs-panel";
  panel.setAttribute("role", "listbox");
  panel.hidden = true;
  wrap.appendChild(btn);
  wrap.appendChild(panel);

  const syncLabel = () => {
    const o = sel.selectedOptions && sel.selectedOptions[0];
    btn.innerHTML = `<span class="cs-text${sel.value ? "" : " cs-placeholder"}">${esc(o ? o.textContent : "")}</span><span class="cs-caret" aria-hidden="true">▾</span>`;
  };
  const close = () => {
    panel.hidden = true;
    btn.setAttribute("aria-expanded", "false");
    document.removeEventListener("click", onDoc, true);
  };
  const onDoc = e => { if (!wrap.contains(e.target)) close(); };
  const open = () => {
    panel.innerHTML = "";
    for (const o of sel.options) {
      if (o.value === "") continue;      // skip the "Choose…" placeholder row
      const row = document.createElement("div");
      row.className = "cs-opt" + (o.value === sel.value ? " sel" : "");
      row.setAttribute("role", "option");
      row.textContent = o.textContent;
      row.onclick = ev => {
        ev.preventDefault(); ev.stopPropagation();
        if (sel.value !== o.value) { sel.value = o.value; sel.dispatchEvent(new Event("change", { bubbles: true })); }
        syncLabel(); close();
      };
      panel.appendChild(row);
    }
    if (!panel.children.length) panel.innerHTML = `<div class="cs-opt cs-empty">No options yet</div>`;
    panel.hidden = false;
    btn.setAttribute("aria-expanded", "true");
    setTimeout(() => document.addEventListener("click", onDoc, true), 0);
  };
  btn.onclick = e => { e.preventDefault(); e.stopPropagation(); panel.hidden ? open() : close(); };

  syncLabel();
  sel.addEventListener("change", syncLabel);
  new MutationObserver(syncLabel).observe(sel, { childList: true }); // options repopulated → refresh label
}

// Custom time picker: hour + minute dropdowns (themselves tap-friendly via
// enhanceSelect) writing back to the hidden native <input type="time">, which
// stays as the data source so saveWindows/briefing code reads .value unchanged.
// Native time popups don't open in the Tesla browser.
function enhanceTime(input) {
  if (!input || input._enhanced) return;
  input._enhanced = true;
  input.classList.add("cs-native");

  const wrap = document.createElement("span");
  wrap.className = "cs-time";
  input.parentNode.insertBefore(wrap, input);
  wrap.appendChild(input);

  const pad = n => String(n).padStart(2, "0");
  const [h0, m0] = (input.value || "00:00").split(":").map(Number);
  const mins = [];
  for (let m = 0; m < 60; m += 5) mins.push(m);
  if (!mins.includes(m0)) { mins.push(m0); mins.sort((a, b) => a - b); } // keep off-step values like 23:59

  const hourSel = document.createElement("select");
  const minSel = document.createElement("select");
  hourSel.innerHTML = Array.from({ length: 24 }, (_, h) =>
    `<option value="${pad(h)}"${h === h0 ? " selected" : ""}>${pad(h)}</option>`).join("");
  minSel.innerHTML = mins.map(m =>
    `<option value="${pad(m)}"${m === m0 ? " selected" : ""}>${pad(m)}</option>`).join("");

  const colon = document.createElement("span");
  colon.className = "cs-time-colon"; colon.textContent = ":";
  wrap.appendChild(hourSel); wrap.appendChild(colon); wrap.appendChild(minSel);

  const commit = () => {
    input.value = `${hourSel.value}:${minSel.value}`;
    input.dispatchEvent(new Event("change", { bubbles: true })); // fires saveWindows / briefing save
  };
  hourSel.addEventListener("change", commit);
  minSel.addEventListener("change", commit);
  enhanceSelect(hourSel);
  enhanceSelect(minSel);
}
// GTFS trip ids look like "BNSF_BN1283_V2_D"; riders know the train as "1283".
function trainNoShort(no) { const m = String(no).match(/\d{2,5}/); return m ? m[0] : String(no); }
function fmtDur(min) { const h = Math.floor(min / 60), m = min % 60; return h ? `${h}h ${m}m` : `${m}m`; }
// Small clock glyph marking a journey duration.
const JT_ICON = `<svg class="jt-ico" width="12" height="12" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><circle cx="8" cy="8" r="6.4"/><path d="M8 4.6V8l2.4 1.4"/></svg>`;
// ---------- split-flap countdown board ----------
// REDUCE_MOTION is declared near the top of this file (the visitor counter needs
// it during init(), before this point in module evaluation).

// Padded MM:SS (or H:MM:SS) so the board keeps a fixed number of cards within an hour.
function fmtFlap(epochMs) {
  const s = Math.max(0, Math.floor((epochMs - Date.now()) / 1000));
  const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), sec = s % 60;
  const p = n => String(n).padStart(2, "0");
  return h > 0 ? `${h}:${p(m)}:${p(sec)}` : `${p(m)}:${p(sec)}`;
}
const flapSig = str => str.split("").map(c => (c === ":" ? ":" : "#")).join("");
function cardOrColon(ch) {
  return ch === ":"
    ? `<div class="flip-colon">:</div>`
    : `<div class="flip-card" data-ch="${ch}">
         <div class="top"><span>${ch}</span></div>
         <div class="bottom"><span>${ch}</span></div>
         <div class="flip-top"><span>${ch}</span></div>
         <div class="flip-bottom"><span>${ch}</span></div>
       </div>`;
}
const flapCards = epochMs => fmtFlap(epochMs).split("").map(cardOrColon).join("");

// Update a flapboard in place: flip only the cards whose character changed.
function updateFlap(el, epochMs) {
  const str = fmtFlap(epochMs);
  const sig = flapSig(str);
  if (el.dataset.sig !== sig) { el.innerHTML = str.split("").map(cardOrColon).join(""); el.dataset.sig = sig; return; }
  const nodes = el.children;
  str.split("").forEach((ch, i) => {
    const node = nodes[i];
    if (!node || ch === ":") return;
    if (node.dataset.ch !== ch) flipCardTo(node, ch);
  });
}
function flipCardTo(node, newCh) {
  const oldCh = node.dataset.ch;
  node.dataset.ch = newCh;
  const set = (sel, v) => { const s = node.querySelector(sel); if (s) s.textContent = v; };
  set(".top span", newCh); // new value waits behind the folding top card
  if (REDUCE_MOTION) { set(".bottom span", newCh); return; }
  set(".flip-top span", oldCh);
  set(".bottom span", oldCh);
  set(".flip-bottom span", newCh);
  node.classList.remove("flipping"); void node.offsetWidth; node.classList.add("flipping");
  clearTimeout(node._t);
  node._t = setTimeout(() => { set(".bottom span", node.dataset.ch); node.classList.remove("flipping"); }, 340);
}

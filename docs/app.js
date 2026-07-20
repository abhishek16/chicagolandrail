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
// Theme the UI to a line: lift the official color for contrast on the dark canvas,
// and choose ink (text that sits ON a --line fill) that stays readable — dark ink
// on bright lines (UP-NW yellow), white on the rest.
function applyLineTheme(rawColor) {
  const c = lift(rawColor || WIZ_LINE);
  const root = document.documentElement.style;
  root.setProperty("--line", c);
  root.setProperty("--line-ink", relLum(c) > 0.62 ? "#08141F" : "#FFFFFF");
}

const $ = s => document.querySelector(s);
const POLL_MS = 30000;

// ---------- state ----------
const store = {
  load() {
    try { return JSON.parse(localStorage.getItem("mct") || "{}"); } catch { return {}; }
  },
  save(s) { localStorage.setItem("mct", JSON.stringify(s)); },
};
let S = Object.assign({ routes: [], activeRouteId: null, settings: null, override: { active: false }, notify: false, reminders: [], briefing: null, nudges: {}, visits: 0, tour: null }, store.load());
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
let expandedStops = {};          // direction -> whether the hero's stop list is open
let meta = null;                 // /api/meta freshness, for the stale-data warning
let weatherCache = new Map();    // stationId -> { periods, at }
let oneOff = null;               // transient one-off trip (not saved), overrides active route
let boardMap = null, boardMapLine = null, boardStops = {}; // live-board route map + per-line geometry cache
let ooStations = [];             // stations for the one-off line picker

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
  if ("serviceWorker" in navigator) navigator.serviceWorker.register("./sw.js").then(r => swReg = r).catch(() => {});
  S.visits = (S.visits || 0) + 1; persist(); // paces the contextual briefing nudge
  try { lines = await api("/api/lines"); } catch { lines = []; }
  api("/api/meta").then(m => { meta = m; }).catch(() => {}); // for stale-data warning
  initOneOff();
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
      updateGates({ scroll: true }); // unlock reminders + briefing, scroll to them
      await subscribePush();
    } else {
      S.notify = false; persist();
      updateGates(); // re-lock reminders + briefing
      await unsubscribePush();
    }
  };
  try { setupReminders(); } catch (e) { console.error("reminders setup failed", e); }
  try { setupBriefing(); } catch (e) { console.error("briefing setup failed", e); }

  // Replace native <select>/<input type=time> popups with tap-friendly widgets
  // so every picker works in browsers that won't open native popups (Tesla).
  ["#rem-route", "#rem-dir", "#rem-train", "#rem-lead", "#rem-days", "#brief-route"]
    .forEach(s => enhanceSelect($(s)));
  ["#m0", "#m1", "#e0", "#e1", "#brief-time"].forEach(s => enhanceTime($(s)));
  updateGates(); // set initial locked/unlocked state (no scroll on first paint)
  if (opts.scrollTo) {
    const target = $(opts.scrollTo);
    if (target) setTimeout(() =>
      target.scrollIntoView({ behavior: REDUCE_MOTION ? "auto" : "smooth", block: "start" }), 60);
  }
}

// ---------- departure reminders (setup UI) ----------
function setupReminders() {
  const routeSel = $("#rem-route");
  const hasRoutes = S.routes.length > 0;
  routeSel.innerHTML = hasRoutes
    ? S.routes.map(r => `<option value="${r.id}">${esc(r.label)}</option>`).join("")
    : `<option value="">Save a route first…</option>`;
  let remTrains = []; // trains currently in the dropdown, looked up by value on add

  const loadTrains = async () => {
    const trainSel = $("#rem-train");
    remTrains = [];
    const r = S.routes.find(x => x.id === routeSel.value);
    if (!r) { trainSel.innerHTML = `<option value="">Save a route first…</option>`; return; }
    const [from, to] = $("#rem-dir").value === "HW" ? [r.home, r.work] : [r.work, r.home];
    trainSel.innerHTML = `<option value="">Loading…</option>`;
    const sched = remSchedFor($("#rem-days").value);
    const hint = $("#rem-sched"); if (hint) hint.textContent = sched.label;
    try {
      const data = await api(`/api/timetable?route=${encodeURIComponent(r.line)}&from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}&date=${sched.date}`);
      remTrains = (data.trains || []).filter(t => t.depSec != null);
      trainSel.innerHTML = remTrains.length
        ? remTrains.map(t => `<option value="${t.depSec}">${esc(t.dep)} · ${t.class === "E" ? "Express" : "Local"} · Train ${esc(trainNoShort(t.trainNo))}</option>`).join("")
        : `<option value="">No trains found for this route</option>`;
    } catch { trainSel.innerHTML = `<option value="">Couldn't load trains. Check connection</option>`; }
  };
  routeSel.onchange = loadTrains;
  $("#rem-dir").onchange = loadTrains;
  $("#rem-days").onchange = loadTrains; // weekday vs every-day lists different schedules
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
    if (!trainSel.value || !t) return show(remTrains.length ? "Choose a train from the list." : "Train list is still loading. Try again in a moment.");
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
    flashOk("#rem-ok");
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
      // Cascade: reminders and the briefing tied to this route go with it.
      S.reminders = (S.reminders || []).filter(x => x.routeId !== r.id);
      if (S.briefing && S.briefing.routeId === r.id) S.briefing = null;
      if (S.activeRouteId === r.id) S.activeRouteId = S.routes[0]?.id || null;
      persist(); renderRouteList(); syncPush(); updateGates(); // re-lock if last route removed
      // Rebuild the reminder/briefing UI so their route pickers drop the deleted route.
      try { setupReminders(); } catch { /* section may be locked */ }
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
    ["#sec-reminders", hasRoute && notif],
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
    unlocked.scrollIntoView({ behavior: REDUCE_MOTION ? "auto" : "smooth", block: "start" });
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
  S = { routes: [], activeRouteId: null, settings: null, override: { active: false }, notify: false, reminders: [], briefing: null, nudges: {}, visits: 0, tour: null };
  oneOff = null; lastData = {}; ttDate = null;
  lastSeen.clear(); notifiedAlerts.clear(); expandedStops = {}; weatherCache.clear();
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
  const entries = await Promise.all(lines.map(async l => {
    try { return [l.id, (await api(`/api/stops?route=${encodeURIComponent(l.id)}`)).stations]; }
    catch { return [l.id, []]; }
  }));
  mapGeo = { stopsByLine: Object.fromEntries(entries) };
  return mapGeo;
}

function showWizard(cameFrom = "boot") {
  wiz = { step: 1, cameFrom, sts: [] };
  wizMap = null;
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
    const { stopsByLine } = await ensureMapGeo();
    if (!wiz) return; // wizard was closed while geometry loaded
    wizMap = createMap(host, { lines, stopsByLine, onLine: onMapLine, onStation: onMapStation });
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

function onMapLine(id) { if (wiz && wiz.step === 1) pickWizLine(id); }
function onMapStation(lineId, sid) { if (wiz && (wiz.step === 2 || wiz.step === 3)) pickWizStation(sid); }

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
    list.innerHTML = lines.map(l => `
      <button class="wiz-row" data-id="${esc(l.id)}">
        <span class="wiz-bar" style="background:${esc(l.color)}"></span>
        <span class="wiz-txt"><span class="t">${esc(l.id)}</span><span class="s">${esc(l.name)}</span></span>
        <span class="wiz-go" aria-hidden="true">›</span>
      </button>`).join("");
    list.querySelectorAll(".wiz-row").forEach(b => b.onclick = () => pickWizLine(b.dataset.id));
    return;
  }
  if (wiz.loading) { list.innerHTML = `<div class="muted center">Loading stations…</div>`; return; }
  if (!wiz.sts.length) {
    list.innerHTML = `<div class="muted center">Couldn't load stations. Check your connection.<br><br><button class="ghost" id="wiz-retry">Try again</button></div>`;
    $("#wiz-retry").onclick = () => pickWizLine(wiz.line);
    return;
  }
  const sts = wiz.sts.filter(s =>
    (wiz.step === 2 || s.id !== wiz.from.id) && (!q || s.name.toLowerCase().includes(q)));
  list.innerHTML = sts.map(s => `
    <button class="wiz-row" data-id="${esc(s.id)}">
      <span class="wiz-txt"><span class="t">${esc(s.name)}</span></span>
      <span class="wiz-go" aria-hidden="true">›</span>
    </button>`).join("") || `<div class="muted center">No stations match.</div>`;
  list.querySelectorAll(".wiz-row").forEach(b => b.onclick = () => pickWizStation(b.dataset.id));
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
  wiz.saved = r; // step 4 configures reminders/briefing against this route
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

// Step 4: each feature is its own opt-in with its preferences asked right here.
// Nothing is enabled unless the rider turns it on.
function renderWizardFeatures() {
  const list = $("#wiz-list");
  const r = wiz.saved;
  const [bell, clock, sun] = WIZ_ICONS;
  list.innerHTML = `
    <div class="feat">${bell}<div><b>Delay alerts</b>
      <span>A push the moment your train is delayed or cancelled, even when the app is closed.</span>
      <label class="check"><input type="checkbox" id="wf-alerts"> Alert me about delays and cancellations</label>
    </div></div>
    <div class="feat">${clock}<div><b>Departure reminders</b>
      <span>A heads-up before a train you ride, live delay included.</span>
      <label class="check"><input type="checkbox" id="wf-rem"> Remind me before a train</label>
      <div id="wf-rem-cfg" class="feat-cfg hidden">
        <label>Direction <select id="wf-rem-dir">
          <option value="HW">To ${esc(r.workName)}</option>
          <option value="WH">To ${esc(r.homeName)}</option>
        </select></label>
        <label>Train <select id="wf-rem-train"><option value="">Loading trains…</option></select><span id="wf-rem-sched" class="sched-hint"></span></label>
        <div class="grid2">
          <label>Notify before <select id="wf-rem-lead"><option value="10">10 min</option><option value="15" selected>15 min</option><option value="20">20 min</option><option value="30">30 min</option></select></label>
          <label>Days <select id="wf-rem-days"><option value="wd">Weekdays</option><option value="all">Every day</option></select></label>
        </div>
      </div>
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

  let wfTrains = [];
  const loadTrains = async () => {
    const sel = $("#wf-rem-train");
    wfTrains = [];
    sel.innerHTML = `<option value="">Loading trains…</option>`;
    const [from, to] = $("#wf-rem-dir").value === "HW" ? [r.home, r.work] : [r.work, r.home];
    const sched = remSchedFor($("#wf-rem-days").value);
    $("#wf-rem-sched").textContent = sched.label;
    try {
      const data = await api(`/api/timetable?route=${encodeURIComponent(r.line)}&from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}&date=${sched.date}`);
      wfTrains = (data.trains || []).filter(t => t.depSec != null);
      sel.innerHTML = wfTrains.length
        ? wfTrains.map(t => `<option value="${t.depSec}">${esc(t.dep)} · ${t.class === "E" ? "Express" : "Local"} · Train ${esc(trainNoShort(t.trainNo))}</option>`).join("")
        : `<option value="">No trains found</option>`;
    } catch { sel.innerHTML = `<option value="">Couldn't load trains. Check connection</option>`; }
  };
  $("#wf-rem").onchange = e => {
    $("#wf-rem-cfg").classList.toggle("hidden", !e.target.checked);
    if (e.target.checked && !wfTrains.length) loadTrains();
  };
  $("#wf-rem-dir").onchange = loadTrains;
  $("#wf-rem-days").onchange = loadTrains; // weekday vs every-day lists different schedules
  $("#wf-brief").onchange = e => $("#wf-brief-cfg").classList.toggle("hidden", !e.target.checked);
  ["#wf-rem-dir", "#wf-rem-train", "#wf-rem-lead", "#wf-rem-days"].forEach(s => enhanceSelect($(s)));
  enhanceTime($("#wf-brief-time"));

  const note = m => { $("#wf-note").textContent = m; };
  $("#wiz-finish").onclick = async () => {
    const n = S.nudges || (S.nudges = {});
    const wantAlerts = $("#wf-alerts").checked;
    const wantRem = $("#wf-rem").checked;
    const wantBrief = $("#wf-brief").checked;
    if (!wantAlerts && !wantRem && !wantBrief) {
      n.notif = n.notif || "skipped"; persist();
      return finishWizard();
    }
    const remTrain = wantRem ? wfTrains.find(t => Number(t.depSec) === Number($("#wf-rem-train").value)) : null;
    if (wantRem && !remTrain) return note("Pick a train for the reminder, or untick it.");
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
    if (remTrain) {
      const [from, to, fromName, toName] = $("#wf-rem-dir").value === "HW"
        ? [r.home, r.work, r.homeName, r.workName]
        : [r.work, r.home, r.workName, r.homeName];
      S.reminders = S.reminders || [];
      S.reminders.push({
        id: "rem" + Date.now(), routeId: r.id, line: r.line,
        from, to, fromName, toName,
        depSec: Number(remTrain.depSec), trainNo: trainNoShort(remTrain.trainNo), depLabel: remTrain.dep,
        lead: Number($("#wf-rem-lead").value),
        days: $("#wf-rem-days").value === "all" ? [0, 1, 2, 3, 4, 5, 6] : [1, 2, 3, 4, 5],
      });
    }
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
    S.activeRouteId = e.target.value; persist(); lastSeen.clear(); notifiedAlerts.clear(); expandedStops = {}; showMain();
  };
  enhanceSelect($("#route-picker")); // tap-friendly dropdown (Tesla browser)
  const l = lines.find(x => x.id === route.line);
  $("#line-pill").innerHTML = `<span class="line-pill">
    <span class="lp-dot" style="background:${esc(lineColor(route.line))}"></span>
    <span class="lp-txt">${esc(l ? lineLabel(l) : route.line + " Line")}</span></span>`;
  // Back = manage routes (top of settings); cog = preferences (direction windows etc).
  $("#back-btn").onclick = () => { stopPolling(); showSetup(); };
  $("#settings-btn").onclick = () => { stopPolling(); showSetup({ scrollTo: "#sec-windows" }); };
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
      const data = await api(`/api/next?route=${encodeURIComponent(route.line)}&from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}&count=3`);
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

  // alerts (deduped across directions)
  const seen = new Set(); const alertHtml = [];
  for (const d of dirs) for (const a of (lastData[d]?.alerts || [])) {
    if (seen.has(a.id)) continue; seen.add(a.id);
    alertHtml.push(`<div class="alert">${esc(a.header)}${a.description ? `. ${esc(a.description)}` : ""}</div>`);
  }
  $("#alerts").innerHTML = alertHtml.join("");

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

  updateBoardMap(dirs);      // geographic route map with the live train position
  dirs.forEach(loadWeather); // fill the weather line under each hero (async, optional)
  renderNudge();             // contextual feature discovery (alerts, briefing)
  maybeStartTour();          // first board ever → skippable coach-mark walkthrough

  const anyAlert = seen.size > 0;
  const cancelledNext = dirs.some(d => lastData[d]?.trains?.[0]?.cancelled);
  updateBadge(bestTrain(dirs), anyAlert, cancelledNext, dirs);

  $("#updated").textContent = first ? `Updated ${new Date(first.fetchedAt).toLocaleTimeString([], { hour: "numeric", minute: "2-digit", second: "2-digit" })}` : "";
  $("#rt-status").innerHTML = first ? (first.realtime ? `<span class="live-dot">live</span>` : "scheduled only") : "";
}

// Geographic route map on the live board: the rider's line with their two
// stations marked and the next train shown at its live GPS position when Metra's
// positions feed is tracking it. Built once per line; only the dot updates on poll.
// Reuses the existing /api/next payload — no extra Metra calls.
async function updateBoardMap(dirs) {
  const host = $("#board-map");
  const route = activeRoute();
  if (!host) return;
  if (ttDate || !route) { host.classList.add("hidden"); return; }

  const seq = reqSeq;
  let stops = boardStops[route.line];
  if (!stops) {
    try { stops = (await api(`/api/stops?route=${encodeURIComponent(route.line)}`)).stations; }
    catch { host.classList.add("hidden"); return; }
    if (seq !== reqSeq || activeRoute() !== route || ttDate) return; // route/view changed while loading
    boardStops[route.line] = stops;
  }
  const geo = (stops || []).filter(s => s.lat != null && s.lon != null);
  if (geo.length < 2) { host.classList.add("hidden"); return; }

  if (boardMapLine !== route.line || !boardMap) {
    const l = lines.find(x => x.id === route.line) || { id: route.line, name: route.line, color: lineColor(route.line) };
    try {
      boardMap = createMap(host, { lines: [l], stopsByLine: { [route.line]: geo }, onLine: () => {}, onStation: () => {} });
    } catch { host.classList.add("hidden"); boardMap = null; return; }
    boardMap.focus(route.line);
    boardMapLine = route.line;
  }
  host.classList.remove("hidden");
  boardMap.select(route.line, { from: route.home, to: route.work });

  // Train dots: only where the positions feed is actually tracking the next train.
  const dots = []; let anyLive = false;
  for (const d of dirs) {
    const data = lastData[d];
    if (!data || !data.position || data.position.lat == null) continue;
    const nx = (data.trains || []).find(t => !t.cancelled && data.position.tripId === t.tripId);
    if (nx) { dots.push({ lat: data.position.lat, lon: data.position.lon }); anyLive = true; }
  }
  boardMap.setTrains(route.line, dots);

  let cap = host.querySelector(".board-map-cap");
  if (!cap) { cap = document.createElement("div"); cap.className = "board-map-cap"; host.appendChild(cap); }
  cap.innerHTML = anyLive
    ? `<span class="bm-live">● live train position</span><span>${esc(lineLabelShort(route))}</span>`
    : `<span class="bm-sched">${esc(route.homeName)} → ${esc(route.workName)}</span><span>${esc(lineLabelShort(route))}</span>`;
}
function lineLabelShort(route) {
  const l = lines.find(x => x.id === route.line);
  return l ? `${l.id}` : route.line;
}

// Full-day scheduled timetable for any date (incl. weekends) — no realtime merge.
async function renderTimetable(dirs, seq = reqSeq) {
  $("#board-map").classList.add("hidden"); // schedule view has no live map
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

  let note = null;
  for (const d of dirs) {
    const [from, to] = d === "HW" ? [route.home, route.work] : [route.work, route.home];
    html += `<div class="direction-head">${dirTitle(d)}</div>`;
    try {
      const data = await api(`/api/timetable?route=${encodeURIComponent(route.line)}&from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}&date=${ttDate.replace(/-/g, "")}`);
      if (seq !== reqSeq) return; // route/date changed mid-load — abandon this stale timetable
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
  if (seq !== reqSeq) return; // a newer route/view took over while we awaited — don't paint
  $("#content").innerHTML = html;
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
// Which schedule a reminder's train picker should list. A "Weekdays" reminder
// must offer weekday trains even when it's being set up on a weekend (today's
// timetable would miss every weekday train), so roll forward to the next
// weekday. "Every day" lists today's schedule.
function remSchedFor(daysVal) {
  let d = new Date();
  if (daysVal === "wd") while (d.getDay() === 0 || d.getDay() === 6) d = addDays(d, 1);
  const wd = d.getDay();
  return {
    date: fmtISO(d).replace(/-/g, ""),
    label: wd === 0 ? "Sunday schedule" : wd === 6 ? "Saturday schedule" : "Weekday schedule",
  };
}
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
            : `<div class="flapboard" data-dep="${next.depEpochMs}" data-sig="${flapSig(fmtFlap(next.depEpochMs))}">${flapCards(next.depEpochMs)}</div>`}
        </div>
      </div>
      ${next.cancelled ? "" : journeyBar(data, next, d)}
      ${next.cancelled ? "" : stopsPanel(data, next, d)}
    </div>
    ${hint ? `<div class="hint">Express Train ${esc(trainNoShort(hint.trainNo))} leaves at ${hint.dep} (in ${hint.minutes} min). Worth waiting?</div>` : ""}
    <div class="list">
      ${rest.map(t => `
        <div class="row ${t.cancelled ? "cancelled" : ""}${t.delayMin > 0 ? " late" : ""}">
          <span class="dep">${t.delayMin > 0 ? `<span class="was">${t.depScheduled}</span>` : ""}${t.dep}</span>
          <span class="meta">${t.class === "E" ? "Express" : "Local"} · Train ${esc(trainNoShort(t.trainNo))}${miniStatus(t)}</span>
          <span class="right">${t.cancelled ? "Cancelled"
            : `<span class="jt" title="Total journey time">${JT_ICON}${fmtDur(Math.round((t.arrEpochMs - t.depEpochMs) / 60000))}</span>`}</span>
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

// ---------- first-run tour (skippable coach marks over the live board) ----------
let tourOpen = false;

function maybeStartTour() {
  if (tourOpen || S.tour || oneOff || ttDate) return;
  if (!$("#content .hero")) return; // wait until a real board is on screen
  startTour();
}

function startTour() {
  const steps = [
    ["#content .hero", "Your next train", "Live countdown, delay status, and journey progress. Tap the card to see every stop."],
    ["#view-tabs", "Live or Schedule", "Flip between the live board and the full timetable for any day, weekends included."],
    ["#dir-tabs", "Direction", "Inbound, outbound, or both. It follows your morning and evening windows automatically."],
    ["#oneoff-btn", "One-off trips", "Heading somewhere unusual? Check any two stations without saving a route."],
    ["#settings-btn", "Settings", "Alerts, departure reminders, the morning briefing, and preferences live here."],
  ].filter(([sel]) => $(sel));
  if (!steps.length) { S.tour = "done"; persist(); return; }

  tourOpen = true;
  const el = document.createElement("div");
  el.id = "tour"; el.className = "tour-backdrop";
  el.innerHTML = `<div class="tour-ring"></div>
    <div class="tour-card"><b></b><p></p>
      <div class="tour-btns"><button class="ghost" id="tour-skip">Skip tour</button>
      <button class="primary" id="tour-next"></button></div>
    </div>`;
  document.body.appendChild(el);

  let idx = 0;
  const show = () => {
    const [sel, title, text] = steps[idx];
    const t = $(sel);
    if (!t) return next(); // board re-rendered under us — move on
    t.scrollIntoView({ block: "center", behavior: "auto" });
    const r = t.getBoundingClientRect(), pad = 6;
    const ring = el.querySelector(".tour-ring");
    ring.style.left = (r.left - pad) + "px";
    ring.style.top = (r.top - pad) + "px";
    ring.style.width = (r.width + 2 * pad) + "px";
    ring.style.height = (r.height + 2 * pad) + "px";
    el.querySelector("b").textContent = title;
    el.querySelector("p").textContent = text;
    $("#tour-next").textContent = idx === steps.length - 1 ? "Done" : `Next · ${idx + 1} of ${steps.length}`;
    const card = el.querySelector(".tour-card");
    card.style.left = Math.max(12, Math.min(r.left, window.innerWidth - 312)) + "px";
    const below = r.bottom + pad + 12;
    card.style.top = (below + 170 < window.innerHeight ? below : Math.max(12, r.top - pad - 170)) + "px";
  };
  const end = state => { S.tour = state; persist(); el.remove(); tourOpen = false; };
  const next = () => { idx++; idx >= steps.length ? end("done") : show(); };
  $("#tour-skip").onclick = () => end("skipped");
  $("#tour-next").onclick = next;
  show();
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
const REDUCE_MOTION = window.matchMedia && window.matchMedia("(prefers-reduced-motion: reduce)").matches;

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

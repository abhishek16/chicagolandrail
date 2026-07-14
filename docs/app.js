import { DEFAULT_SETTINGS, resolveDirection, overrideExpiry, expressHint, fmtCountdown } from "./logic.js";
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
let S = Object.assign({ routes: [], activeRouteId: null, settings: null, override: { active: false }, notify: false }, store.load());
const persist = () => store.save(S);

let lines = [], stations = [], lastData = {}, lastSeen = new Map(), pollTimer = null, tickTimer = null;
let ttDate = null;               // null = live board; "YYYY-MM-DD" = schedule for that day
let swReg = null;                // service-worker registration, for OS notifications
let notifiedAlerts = new Set();  // alert ids we've already notified about

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
  if (!activeRoute()) showSetup(); else showMain();
}

function activeRoute() { return S.routes.find(r => r.id === S.activeRouteId) || S.routes[0] || null; }
function settings() { return S.settings || DEFAULT_SETTINGS; }

async function api(path) {
  const res = await fetch(API_BASE + path);
  if (!res.ok) throw new Error(`${path} → ${res.status}`);
  return res.json();
}

function lineColor(routeLine) {
  const l = lines.find(x => x.id === routeLine);
  return l ? l.color : "#005A45";
}

// ============================================================
// SETUP VIEW
// ============================================================
function showSetup() {
  swapView("setup");
  const sel = $("#line");
  sel.innerHTML = `<option value="">Choose a line…</option>` +
    lines.map(l => `<option value="${l.id}">${esc(l.name)}</option>`).join("");
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
  $("#notif-toggle").checked = !!S.notify;
  $("#notif-note").textContent = ("Notification" in window)
    ? "Notifications appear only while a tab with this site is open."
    : "This browser doesn't support notifications.";

  renderRouteList();
  $("#save-route").onclick = saveRoute;
  $("#save-settings").onclick = saveSettings;
  $("#notif-toggle").onchange = async e => {
    if (e.target.checked && Notification.permission !== "granted") {
      const p = await Notification.requestPermission();
      if (p !== "granted") { e.target.checked = false; return; }
    }
    S.notify = e.target.checked; persist();
  };
}

function findStation(name) {
  const n = (name || "").trim().toLowerCase();
  return stations.find(s => s.name.toLowerCase() === n) || stations.find(s => s.name.toLowerCase().includes(n));
}

function saveRoute() {
  const err = $("#form-error"); err.classList.add("hidden");
  const line = $("#line").value, home = findStation($("#home").value), work = findStation($("#work").value);
  const fail = m => { err.textContent = m; err.classList.remove("hidden"); };
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
  if (!S.activeRouteId) S.activeRouteId = r.id;
  persist();
  $("#home").value = $("#work").value = $("#label").value = "";
  renderRouteList();
}

function renderRouteList() {
  const el = $("#route-list");
  $("#route-count").textContent = S.routes.length ? `(${S.routes.length}/5)` : "";
  el.innerHTML = S.routes.length ? "" : `<p class="muted small">No routes yet — add your commute below.</p>`;
  for (const r of S.routes) {
    const div = document.createElement("div");
    div.className = "route-item" + (r.id === S.activeRouteId ? " active" : "");
    div.innerHTML = `<div><div class="name">${esc(r.label)}</div>
      <div class="sub">${esc(r.line)} · ${esc(r.homeName)} ↔ ${esc(r.workName)}${r.id === S.activeRouteId ? " · active" : ""}</div></div>
      <div>${r.id !== S.activeRouteId ? `<button class="ghost" data-a="use">Use</button>` : ""}
      <button class="ghost danger" data-a="del">Remove</button></div>`;
    div.querySelectorAll("button").forEach(b => b.onclick = () => {
      if (b.dataset.a === "use") S.activeRouteId = r.id;
      else {
        S.routes = S.routes.filter(x => x.id !== r.id);
        if (S.activeRouteId === r.id) S.activeRouteId = S.routes[0]?.id || null;
      }
      persist(); renderRouteList();
    });
    el.appendChild(div);
  }
}

function saveSettings() {
  S.settings = {
    ...settings(),
    morningWindow: [$("#m0").value || "05:00", $("#m1").value || "11:00"],
    eveningWindow: [$("#e0").value || "12:00", $("#e1").value || "23:59"],
  };
  persist();
  if (activeRoute()) showMain();
  else { $("#saved-note").classList.remove("hidden"); setTimeout(() => $("#saved-note").classList.add("hidden"), 1500); }
}

// ============================================================
// MAIN VIEW
// ============================================================
function showMain() {
  swapView("main");
  const route = activeRoute();
  document.documentElement.style.setProperty("--line", lineColor(route.line));
  $("#route-picker").innerHTML = S.routes.map(r =>
    `<option value="${r.id}" ${r.id === route.id ? "selected" : ""}>${esc(r.label)}</option>`).join("");
  $("#route-picker").onchange = e => { S.activeRouteId = e.target.value; persist(); lastSeen.clear(); notifiedAlerts.clear(); showMain(); };
  $("#settings-btn").onclick = () => { stopPolling(); showSetup(); };
  renderSocial(route);
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
  $("#view-tabs").innerHTML = [["live", "Live"], ["schedule", "Schedule"]]
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
  if (offline) {
    const t = first ? new Date(first.fetchedAt).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" }) : null;
    b.textContent = t ? `Offline — showing data from ${t}.` : "Offline — no cached data yet.";
    b.className = "banner offline";
  } else if (first && first.serviceNote) {
    b.textContent = "Modified schedule in effect today (holiday or special service).";
    b.className = "banner";
  } else if (first && first.realtime === false) {
    b.textContent = "Live updates temporarily unavailable — showing scheduled times.";
    b.className = "banner offline";
  } else b.className = "banner hidden";

  $("#content").innerHTML = dirs.map(d => sectionHtml(d)).join("") || `<div class="muted center">No data.</div>`;

  const anyAlert = seen.size > 0;
  const cancelledNext = dirs.some(d => lastData[d]?.trains?.[0]?.cancelled);
  updateBadge(bestTrain(dirs), anyAlert, cancelledNext);

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
            <div class="row">
              <span class="dep">${t.dep}</span>
              <span class="meta">${t.class === "E" ? "Express" : "Local"} · Train ${esc(trainNoShort(t.trainNo))}</span>
              <span class="right">→ ${t.arr}</span>
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
    <div class="hero">
      <div class="hero-top">
        <span><span class="chip ${next.class}">${next.class === "E" ? "Express" : "Local"}</span>
        ${next.live ? `<span class="live-dot">live</span>` : ""}</span>
        <span class="train-no">Train ${esc(trainNoShort(next.trainNo))}</span>
      </div>
      <div class="times">
        ${next.delayMin > 0 ? `<span class="was">${next.depScheduled}</span>` : ""}${next.dep}
        <span class="to">→ ${next.arr}</span>
      </div>
      <div class="status-row">
        ${next.cancelled
          ? `<span class="cancelled-tag">Cancelled</span>`
          : `<span class="countdown" data-dep="${next.depEpochMs}">in ${fmtCountdown(next.depEpochMs)}</span>
             ${next.delayMin > 0 ? `<span class="delay">+${next.delayMin} min delay</span>` : ""}`}
      </div>
      ${next.cancelled ? "" : journeyBar(data, next, d)}
    </div>
    ${hint ? `<div class="hint">Express Train ${esc(trainNoShort(hint.trainNo))} leaves at ${hint.dep} (in ${hint.minutes} min) — worth waiting?</div>` : ""}
    <div class="list">
      ${rest.map(t => `
        <div class="row ${t.cancelled ? "cancelled" : ""}">
          <span class="dep">${t.dep}</span>
          <span class="meta">${t.class === "E" ? "Express" : "Local"} · Train ${esc(trainNoShort(t.trainNo))}</span>
          <span class="right">${t.cancelled ? "Cancelled"
            : `<span data-dep="${t.depEpochMs}">${fmtCountdown(t.depEpochMs)}</span>${t.delayMin > 0 ? `<span class="delay">+${t.delayMin}m</span>` : ""}`}</span>
        </div>`).join("")}
    </div>`;
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

// ---------- badge (favicon + title) ----------
function bestTrain(dirs) {
  let best = null;
  for (const d of dirs) {
    const t = (lastData[d]?.trains || []).find(x => !x.cancelled && x.depEpochMs > Date.now());
    if (t && (!best || t.depEpochMs < best.depEpochMs)) best = t;
  }
  return best;
}

function updateBadge(next, hasAlert, cancelledNext) {
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

  const r = activeRoute();
  document.title = next
    ? `${mins}m ${next.class} · ${r.homeName.split(" ")[0]} ⇆ ${r.workName.split(" ")[0]}`
    : "Chicagoland Rail";
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
    el.textContent = el.classList.contains("countdown") ? `in ${fmtCountdown(dep)}` : fmtCountdown(dep);
  });
}
function swapView(name) {
  $("#view-main").classList.toggle("hidden", name !== "main");
  $("#view-setup").classList.toggle("hidden", name !== "setup");
}
function esc(s) { return String(s).replace(/[&<>"]/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c])); }
// GTFS trip ids look like "BNSF_BN1283_V2_D"; riders know the train as "1283".
function trainNoShort(no) { const m = String(no).match(/\d{2,5}/); return m ? m[0] : String(no); }

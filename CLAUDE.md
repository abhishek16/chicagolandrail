# CLAUDE.md — Chicagoland Rail (build + deploy spec)

> **How to use this file.** Drop it at the root of an empty folder in VS Code and
> open Claude Code (VS Code Claude mode). Claude Code auto-loads a file named
> `CLAUDE.md` as context. Then tell it: **"Scaffold this project from CLAUDE.md,
> then walk me through deployment."** Every file's full contents are embedded
> below, so it can recreate the entire repo verbatim. The deployment runbook marks
> which steps Claude can run for you and which need you (API keys, dashboard
> clicks). If you already unzipped the provided project, Claude Code can use this
> as the operating manual instead of regenerating.

---

## 1. Mission

A free web app that shows a Metra rider their next trains for a saved commute,
with **live delays, cancellations, and line-specific service alerts**. Frontend is
static (GitHub Pages); a small Cloudflare Worker is the API.

## 2. Architecture (and why it's shaped this way)

```
Browser (GitHub Pages, docs/) ──fetch──► Cloudflare Worker (worker/)
   static site, no secrets                holds Metra key, decodes protobuf,
                                          only thing that contacts Metra
                                                     │
                                                     ▼
                                          Metra GTFS static + realtime feeds
```

- **GitHub Pages serves static files only** — it cannot hold a secret key or
  decode Metra's binary (protobuf) realtime feeds. So realtime needs a backend.
- **Metra's license forbids end-user devices calling Metra directly.** The Worker
  is the single proxy; browsers only ever hit the Worker. This keeps us compliant.
- **A public repo has no usable client secret.** Anything in `docs/` is
  world-readable. `docs/config.js` therefore contains only the Worker URL — never
  the Metra key. The Metra key lives solely in a Worker secret.
- Static GTFS is parsed daily by a **GitHub Actions** job (not a Worker cron —
  parsing a multi-MB zip exceeds Worker CPU limits) and written to **Workers KV**.
  The Worker reads KV at request time; realtime feeds are edge-cached 30s so any
  number of users = ~2 Metra calls/min per feed.

## 3. Hard guardrails (do not violate)

1. Never put the Metra API key in `docs/` or any committed frontend file. It goes
   only in the Worker secret (`wrangler secret put METRA_API_KEY`) and in GitHub
   Actions secrets for the ingest.
2. Never make the browser call `metrarr.com` / `metrarail.com` directly. All Metra
   access is server-side in the Worker.
3. Respect Metra polling: static zip fetched only when `published.txt` changes;
   realtime feeds no more than once per 30s (the Worker's edge cache enforces this).
4. **Validate the real feed before deploying logic.** Run
   `cd ingest && npm install && METRA_API_KEY=... node ingest.js --dry-run` and
   confirm the per-line table + BNSF express validation line look sane. Stop if
   station names don't resolve or express counts look wrong.
5. Keep all `docs/` asset paths **relative** (`./app.js`, `icons/...`) so the site
   works both at a project subpath (`user.github.io/repo/`) and a root user-site.
6. Preserve express rule = *more than 8 skipped intermediate stops between the
   rider's two stations* (`skipped > 8`). Time math is always `America/Chicago`.

## 4. Repo layout

```
.
├── CLAUDE.md                     (this file)
├── docs/                         GitHub Pages serves THIS folder
│   ├── index.html
│   ├── app.css
│   ├── app.js
│   ├── logic.js
│   ├── config.js                 ← edit API_BASE after Worker deploy
│   ├── sw.js
│   ├── manifest.webmanifest
│   └── icons/  (icon16/32/48/128/192/512.png)
├── worker/                       Cloudflare Worker API
│   ├── src/index.js              router + CORS
│   ├── src/static.js             schedule logic (KV)
│   ├── src/realtime.js           protobuf decode + merge
│   ├── wrangler.toml
│   └── package.json
├── ingest/                       GTFS → KV (runs in GitHub Actions)
│   ├── ingest.js
│   └── package.json
└── .github/workflows/gtfs-ingest.yml
```

## 5. Deployment runbook

Legend: **[you]** = human step (auth, keys, dashboard). **[claude]** = Claude Code
can run it. Do them in order.

1. **[you+claude]** Scaffold files from section 7. **[claude]** writes every file
   to its path exactly as given.
2. **[you]** Generate icons: run the script in section 6 (needs Python + Pillow, or
   ask Claude to convert to a Node/sharp equivalent). Or copy icons from the
   provided project zip.
3. **[you]** Validate feed (guardrail #4). Have your Metra API key ready.
4. **[you]** Deploy Worker:
   ```
   cd worker && npm install
   npx wrangler login                      # opens browser — you approve
   npx wrangler kv namespace create GTFS   # copy the id into wrangler.toml
   npx wrangler secret put METRA_API_KEY   # paste your key
   npx wrangler deploy                      # note the *.workers.dev URL
   ```
   **[claude]** can edit `wrangler.toml` with the KV id once you paste it.
5. **[you]** Create a GitHub repo and push. **[claude]** can run the git commands.
6. **[you]** Add GitHub Actions secrets (repo → Settings → Secrets → Actions):
   `CF_ACCOUNT_ID`, `CF_API_TOKEN` (perm: Workers KV Storage: Edit),
   `KV_NAMESPACE_ID`, `METRA_API_KEY`. Then Actions tab → **GTFS ingest** → Run.
7. **[you+claude]** Set `docs/config.js` `API_BASE` to the Worker URL; commit+push.
8. **[you]** Settings → Pages → Source: Deploy from a branch → `main` /`docs`.
   Site goes live at `https://<you>.github.io/<repo>/`.
9. **[you]** Lock CORS: set `ALLOWED_ORIGIN` in `wrangler.toml` to your Pages
   origin and `npx wrangler deploy` again.
10. **[you]** Verify: `curl <worker>/api/meta` returns a timestamp; open the site,
    onboard (line, home, work); "Add to Home Screen" on mobile to install the PWA.

**Human-in-the-loop gates** an agent cannot bypass: `wrangler login` OAuth, the KV
dashboard binding, providing the Metra key, GitHub Pages toggle. Claude Code should
pause and prompt you at each.

## 6. Icons

Binary PNGs can't be embedded as text. Generate simple ones (emerald rounded square
+ white train glyph) at sizes 16/32/48/128/192/512 into `docs/icons/`:

```python
# pip install pillow ; python make_icons.py
from PIL import Image, ImageDraw
GREEN=(0,90,69,255); WHITE=(255,255,255,255)
def make(s,p):
    img=Image.new("RGBA",(s,s),(0,0,0,0)); d=ImageDraw.Draw(img)
    d.rounded_rectangle([0,0,s-1,s-1],radius=max(2,s//6),fill=GREEN)
    d.rounded_rectangle([s*.24,s*.18,s*.76,s*.66],radius=max(1,int(s*.08)),fill=WHITE)
    d.rounded_rectangle([s*.32,s*.26,s*.68,s*.44],radius=max(1,int(s*.04)),fill=GREEN)
    lr=max(1,int(s*.045))
    d.ellipse([s*.31-lr,s*.55-lr,s*.31+lr,s*.55+lr],fill=GREEN)
    d.ellipse([s*.69-lr,s*.55-lr,s*.69+lr,s*.55+lr],fill=GREEN)
    lw=max(1,int(s*.05))
    d.line([s*.18,s*.80,s*.38,s*.70],fill=WHITE,width=lw)
    d.line([s*.82,s*.80,s*.62,s*.70],fill=WHITE,width=lw)
    img.save(p)
import os; os.makedirs("docs/icons",exist_ok=True)
for z in (16,32,48,128,192,512): make(z,f"docs/icons/icon{z}.png")
print("icons done")
```

## 7. Full source

Each block is one file. Write it to the exact path in the heading, verbatim.


### `docs/index.html`

````html
<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Chicagoland Rail</title>
  <meta name="description" content="Your next Chicagoland commuter train, with live delays and service alerts.">
  <link rel="manifest" href="manifest.webmanifest">
  <link rel="icon" id="favicon" href="icons/icon32.png">
  <meta name="theme-color" content="#005A45">
  <link rel="stylesheet" href="app.css">
</head>
<body>
  <div id="app">

    <!-- ============ MAIN VIEW ============ -->
    <div id="view-main" class="view hidden">
      <header>
        <div id="line-accent"></div>
        <div class="header-row">
          <select id="route-picker" aria-label="Switch route"></select>
          <div class="header-actions">
            <button id="reverse-btn" title="Reverse direction">&#8646;</button>
            <button id="settings-btn" title="Settings">&#9881;</button>
          </div>
        </div>
        <h1 id="route-title"></h1>
      </header>

      <div id="alerts"></div>
      <div id="banner" class="banner hidden"></div>
      <main id="content">
        <div class="muted center">Loading trains…</div>
      </main>
      <footer>
        <span id="updated"></span>
        <span id="rt-status"></span>
      </footer>
      <p class="disclaimer">Not affiliated with or endorsed by Metra. Schedule and service data provided by Metra.</p>
    </div>

    <!-- ============ ONBOARDING / SETTINGS VIEW ============ -->
    <div id="view-setup" class="view hidden">
      <header class="setup-header">
        <div id="line-accent-2"></div>
        <h1>Chicagoland Rail</h1>
        <p class="muted">Your next train, live delays, and service alerts — set up once.</p>
      </header>
      <main>
        <section>
          <h2>Your routes <span class="muted small" id="route-count"></span></h2>
          <div id="route-list"></div>
          <div class="card">
            <label>Line <select id="line"><option value="">Loading lines…</option></select></label>
            <label>Home station
              <input id="home" list="home-list" placeholder="Type to search…" autocomplete="off">
              <datalist id="home-list"></datalist>
            </label>
            <label>Work station
              <input id="work" list="work-list" placeholder="Type to search…" autocomplete="off">
              <datalist id="work-list"></datalist>
            </label>
            <label>Label (optional) <input id="label" placeholder="Daily commute"></label>
            <button id="save-route" class="primary">Save route</button>
            <p id="form-error" class="error hidden"></p>
          </div>
        </section>

        <section>
          <h2>Direction windows</h2>
          <div class="grid2">
            <label>Morning starts <input id="m0" type="time"></label>
            <label>Morning ends <input id="m1" type="time"></label>
            <label>Evening starts <input id="e0" type="time"></label>
            <label>Evening ends <input id="e1" type="time"></label>
          </div>
          <p class="muted small">Morning shows Home → Work, evening Work → Home. Outside those windows, weekends, and holidays show both directions.</p>
        </section>

        <section>
          <h2>Notifications</h2>
          <label class="check"><input type="checkbox" id="notif-toggle"> Notify me about new delays and cancellations while this page is open</label>
          <p id="notif-note" class="muted small"></p>
        </section>

        <div class="actions">
          <button id="save-settings" class="primary">Save &amp; view trains</button>
          <span id="saved-note" class="muted small hidden">Saved.</span>
        </div>
        <p class="disclaimer">Not affiliated with or endorsed by Metra. Schedule and service data provided by Metra.</p>
      </main>
    </div>

  </div>
  <script type="module" src="app.js"></script>
</body>
</html>
````


### `docs/app.css`

````css
:root {
  --bg: #FAFAF7;
  --surface: #FFFFFF;
  --text: #1B1F24;
  --muted: #6B7280;
  --border: #E4E4DE;
  --line: #005A45;               /* replaced at runtime with the route's official color */
  --express: #B45309;
  --green: #1D9E75;
  --amber: #B45309;
  --red: #B3261E;
  --board: "SF Mono", ui-monospace, "Cascadia Mono", Consolas, monospace;
}
@media (prefers-color-scheme: dark) {
  :root {
    --bg: #141619; --surface: #1E2126; --text: #ECEDEE;
    --muted: #9BA1A8; --border: #2D3138;
  }
}
* { box-sizing: border-box; margin: 0; }
html { -webkit-text-size-adjust: 100%; }
body {
  background: var(--bg); color: var(--text);
  font: 15px/1.5 -apple-system, "Segoe UI", Roboto, sans-serif;
  min-height: 100dvh;
}
#app { max-width: 520px; margin: 0 auto; min-height: 100dvh; display: flex; flex-direction: column; }
.view { display: flex; flex-direction: column; flex: 1; }
.hidden { display: none !important; }
.muted { color: var(--muted); }
.small { font-size: 12px; }
.center { text-align: center; padding: 40px 0; }
.error { color: var(--red); font-size: 13px; margin-top: 8px; }

/* ---- header ---- */
#line-accent, #line-accent-2 { height: 5px; background: var(--line); border-radius: 0 0 3px 3px; }
header { background: var(--surface); border-bottom: 1px solid var(--border); padding-bottom: 12px; }
.header-row { display: flex; justify-content: space-between; align-items: center; padding: 10px 16px 0; }
#route-picker {
  border: none; background: transparent; color: var(--muted);
  font-size: 13px; max-width: 220px; cursor: pointer;
}
.header-actions button {
  border: 1px solid var(--border); background: var(--surface); color: var(--text);
  border-radius: 8px; width: 34px; height: 34px; cursor: pointer; font-size: 16px; margin-left: 8px;
}
.header-actions button:hover { border-color: var(--line); }
#reverse-btn.active { background: var(--line); color: #fff; border-color: var(--line); }
h1 { padding: 8px 16px 0; font-size: 20px; font-weight: 650; letter-spacing: -0.01em; }
h1 .arrow { color: var(--line); }

/* ---- alerts + banners ---- */
#alerts { padding: 0; }
.alert {
  display: flex; gap: 10px; padding: 10px 16px; font-size: 13px;
  background: #FDF3E7; color: #7A4200; border-bottom: 1px solid #F0DFC2;
}
.alert::before { content: "⚠"; }
.alert.severe { background: #FBEAE9; color: #7A1410; border-bottom-color: #F0C9C6; }
@media (prefers-color-scheme: dark) {
  .alert { background: #3A2C12; color: #F0C060; border-bottom-color: #4A3A18; }
  .alert.severe { background: #3E1A18; color: #F2A09A; border-bottom-color: #582522; }
}
.banner { padding: 9px 16px; font-size: 13px; background: #FFF7E6; color: #7A4D00; border-bottom: 1px solid #F0E0BE; }
.banner.offline { background: transparent; color: var(--muted); border-bottom: 1px solid var(--border); }
@media (prefers-color-scheme: dark) { .banner { background: #3A2E12; color: #F0C060; border-bottom-color: #4A3A18; } }

/* ---- content ---- */
main#content { padding: 16px; flex: 1; }
.section-label {
  font-size: 11px; letter-spacing: 0.12em; text-transform: uppercase;
  color: var(--muted); margin: 6px 0 8px;
}
.direction-head { font-size: 14px; font-weight: 600; margin: 14px 0 6px; }
.direction-head .arrow { color: var(--line); }

.hero {
  background: var(--surface); border: 1px solid var(--border); border-radius: 14px;
  padding: 16px; margin-bottom: 12px;
}
.hero-top { display: flex; justify-content: space-between; align-items: baseline; gap: 8px; }
.chip {
  display: inline-block; font-size: 10px; font-weight: 700; letter-spacing: 0.08em;
  padding: 3px 9px; border-radius: 999px; text-transform: uppercase;
}
.chip.E { background: var(--express); color: #fff; }
.chip.L { background: var(--border); color: var(--muted); }
.train-no { font-size: 12px; color: var(--muted); }
.times {
  font-family: var(--board); font-variant-numeric: tabular-nums;
  font-size: 26px; font-weight: 600; margin: 10px 0 2px;
}
.times .to { color: var(--muted); font-size: 17px; font-weight: 400; }
.times .was { color: var(--muted); font-size: 13px; text-decoration: line-through; margin-right: 6px; }
.status-row { display: flex; gap: 12px; align-items: baseline; }
.countdown {
  font-family: var(--board); font-variant-numeric: tabular-nums;
  color: var(--green); font-size: 14px; font-weight: 600;
}
.delay { color: var(--amber); font-size: 13px; font-weight: 600; }
.cancelled-tag { color: var(--red); font-size: 13px; font-weight: 700; text-transform: uppercase; letter-spacing: 0.06em; }
.live-dot { color: var(--green); font-size: 11px; }
.live-dot::before { content: "●"; margin-right: 4px; animation: pulse 1.8s ease-in-out infinite; display: inline-block; }

/* ---- journey bar ---- */
.journey { margin: 14px 2px 2px; }
.journey svg { width: 100%; height: 40px; display: block; }
.journey .lbls { display: flex; justify-content: space-between; font-size: 11px; color: var(--muted); }
.pulse { animation: pulse 1.6s ease-in-out infinite; }
@keyframes pulse { 0%,100% { opacity: 1; } 50% { opacity: 0.25; } }
@media (prefers-reduced-motion: reduce) { .pulse, .live-dot::before { animation: none; } }
.journey .est { font-size: 10px; color: var(--muted); text-align: right; }

.hint { font-size: 13px; color: var(--express); margin: 0 0 12px; padding: 0 2px; }

.list { border-top: 1px solid var(--border); }
.row {
  display: grid; grid-template-columns: 82px 1fr auto; gap: 10px; align-items: center;
  padding: 11px 2px; border-bottom: 1px solid var(--border);
  font-family: var(--board); font-variant-numeric: tabular-nums; font-size: 14px;
}
.row .dep { font-weight: 600; }
.row .meta { font-size: 12px; color: var(--muted); font-family: -apple-system, "Segoe UI", Roboto, sans-serif; }
.row .right { text-align: right; font-size: 13px; color: var(--green); }
.row .right .delay { display: block; }
.row.cancelled .dep, .row.cancelled .meta { text-decoration: line-through; }
.row.cancelled .right { color: var(--red); }

footer {
  padding: 10px 16px calc(14px + env(safe-area-inset-bottom));
  font-size: 11px; color: var(--muted); display: flex; justify-content: space-between;
  border-top: 1px solid var(--border);
}

/* ---- setup view ---- */
.setup-header { padding-bottom: 16px; }
.setup-header h1 { padding-top: 14px; }
.setup-header p { padding: 4px 16px 0; }
#view-setup main { padding: 16px; flex: 1; }
#view-setup h2 { font-size: 15px; margin: 22px 0 10px; }
#view-setup section:first-child h2 { margin-top: 0; }
.card { background: var(--surface); border: 1px solid var(--border); border-radius: 14px; padding: 16px; }
label { display: block; font-size: 13px; color: var(--muted); margin-bottom: 14px; }
input, select {
  display: block; width: 100%; margin-top: 5px; padding: 10px 12px; font-size: 15px;
  background: var(--bg); color: var(--text); border: 1px solid var(--border); border-radius: 10px;
}
label.check { display: flex; gap: 10px; align-items: flex-start; color: var(--text); font-size: 14px; }
label.check input { width: auto; margin-top: 3px; }
button.primary {
  background: var(--line); color: #fff; border: none; border-radius: 10px;
  padding: 11px 20px; font-size: 14px; font-weight: 600; cursor: pointer;
}
button.ghost {
  background: transparent; color: var(--muted); border: 1px solid var(--border);
  border-radius: 8px; padding: 6px 12px; font-size: 12px; cursor: pointer;
}
button.ghost.danger { color: var(--red); }
.grid2 { display: grid; grid-template-columns: 1fr 1fr; gap: 0 14px; }
.actions { margin: 26px 0 30px; display: flex; align-items: center; gap: 12px; }
.route-item {
  display: flex; justify-content: space-between; align-items: center; gap: 8px;
  background: var(--surface); border: 1px solid var(--border); border-radius: 12px;
  padding: 12px 14px; margin-bottom: 8px;
}
.route-item.active { border-color: var(--line); }
.route-item .name { font-weight: 600; font-size: 14px; }
.route-item .sub { font-size: 12px; color: var(--muted); }

.disclaimer {
  padding: 8px 16px calc(14px + env(safe-area-inset-bottom));
  font-size: 10px; line-height: 1.5; color: var(--muted); text-align: center;
}
````


### `docs/logic.js`

````js
// Pure logic shared by background + popup. No chrome.* calls here.

export const DEFAULT_SETTINGS = {
  morningWindow: ["05:00", "11:00"],
  eveningWindow: ["12:00", "23:59"],
  reminderMinutes: 15, // used in Phase 3
};

export function minutesOfDay(d = new Date()) {
  return d.getHours() * 60 + d.getMinutes();
}

function parseHM(hm) {
  const [h, m] = hm.split(":").map(Number);
  return h * 60 + m;
}

// Returns "HW" (home→work), "WH", or "BOTH".
export function resolveDirection(settings, override, now = new Date(), serviceModified = false) {
  if (override && override.active && Date.now() < override.expiresAt) {
    return override.direction;
  }
  const day = now.getDay();
  if (day === 0 || day === 6 || serviceModified) return "BOTH"; // weekends + holiday-modified service
  const m = minutesOfDay(now);
  const [mStart, mEnd] = settings.morningWindow.map(parseHM);
  const [eStart, eEnd] = settings.eveningWindow.map(parseHM);
  if (m >= mStart && m < mEnd) return "HW";
  if (m >= eStart && m <= eEnd) return "WH";
  return "BOTH";
}

// Override lasts until the next window boundary (or midnight, whichever first).
export function overrideExpiry(settings, now = new Date()) {
  const m = minutesOfDay(now);
  const boundaries = [
    parseHM(settings.morningWindow[0]), parseHM(settings.morningWindow[1]),
    parseHM(settings.eveningWindow[0]), parseHM(settings.eveningWindow[1]),
    24 * 60,
  ].filter(b => b > m).sort((a, b) => a - b);
  const next = boundaries[0] ?? 24 * 60;
  const exp = new Date(now);
  exp.setHours(Math.floor(next / 60), next % 60, 0, 0);
  return exp.getTime();
}

// Badge state machine. `data` = { trains, fetchedAt } for the badge direction; may be null.
// Returns { text, color }.
export function badgeState({ onboarded, offline, data, overridden }) {
  const GRAY = "#8A8F98", GREEN = "#1D9E75";
  if (!onboarded) return { text: "SET", color: GRAY };
  const trains = data && data.trains ? data.trains.filter(t => t.depEpochMs > Date.now()) : [];
  if (!trains.length) {
    if (offline && !data) return { text: "?", color: GRAY };
    return { text: "--", color: GRAY };
  }
  const next = trains[0];
  const mins = Math.max(0, Math.round((next.depEpochMs - Date.now()) / 60000));
  let text = mins > 99 ? "99+" : `${mins}${next.class}`;
  if (overridden && text.length < 4) text = text; // "R" state shown via title, 4-char limit is tight
  return { text, color: GREEN };
}

// Upcoming trains still in the future, from cached payload.
export function upcoming(data) {
  if (!data || !data.trains) return [];
  return data.trains.filter(t => t.depEpochMs > Date.now());
}

// "Express in 22 min" hint when the next train is Local but an Express leaves within 30 min.
export function expressHint(trains) {
  if (!trains.length || trains[0].class === "E") return null;
  const ex = trains.find(t => t.class === "E");
  if (!ex) return null;
  const mins = Math.round((ex.depEpochMs - Date.now()) / 60000);
  return mins <= 30 ? { trainNo: ex.trainNo, minutes: mins } : null;
}

export function fmtCountdown(epochMs) {
  const s = Math.max(0, Math.floor((epochMs - Date.now()) / 1000));
  if (s >= 3600) return `${Math.floor(s / 3600)}h ${Math.floor((s % 3600) / 60)}m`;
  if (s >= 60) return `${Math.floor(s / 60)} min`;
  return `${s}s`;
}
````


### `docs/config.js`

````js
// After deploying the Worker, paste its URL here (no trailing slash).
// e.g. "https://metra-proxy.yourname.workers.dev"
export const API_BASE = "https://metra-proxy.YOUR-SUBDOMAIN.workers.dev";
````


### `docs/app.js`

````js
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

// ---------- boot ----------
init();
async function init() {
  if ("serviceWorker" in navigator) navigator.serviceWorker.register("./sw.js").catch(() => {});
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
  $("#route-picker").onchange = e => { S.activeRouteId = e.target.value; persist(); lastSeen.clear(); showMain(); };
  $("#settings-btn").onclick = () => { stopPolling(); showSetup(); };
  $("#reverse-btn").onclick = toggleReverse;
  startPolling();
}

function toggleReverse() {
  const now = new Date();
  const current = resolveDirection(settings(), S.override, now, false);
  const natural = resolveDirection(settings(), { active: false }, now, false);
  const isActive = S.override.active && Date.now() < S.override.expiresAt;
  const flipped = current === "HW" ? "WH" : current === "WH" ? "HW" : (natural === "HW" ? "WH" : "HW");
  S.override = isActive ? { active: false } : { active: true, direction: flipped, expiresAt: overrideExpiry(settings(), now) };
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
  const overridden = S.override.active && Date.now() < S.override.expiresAt;
  $("#reverse-btn").classList.toggle("active", overridden);
  const dir = resolveDirection(settings(), S.override, new Date(), modified);
  const dirs = dir === "BOTH" ? ["HW", "WH"] : [dir];

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

  render(dirs, offline, overridden);
}

function render(dirs, offline, overridden) {
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
  $("#rt-status").textContent = first ? (first.realtime ? "● live" : "scheduled only") : "";
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
        <span class="train-no">Train ${esc(next.trainNo)}</span>
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
    ${hint ? `<div class="hint">Express (Train ${esc(hint.trainNo)}) in ${hint.minutes} min — worth waiting?</div>` : ""}
    <div class="list">
      ${rest.map(t => `
        <div class="row ${t.cancelled ? "cancelled" : ""}">
          <span class="dep">${t.dep}</span>
          <span class="meta">${t.class === "E" ? "Express" : "Local"} · Train ${esc(t.trainNo)}</span>
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
function maybeNotify(d, data) {
  if (!S.notify || !("Notification" in window) || Notification.permission !== "granted") return;
  for (const t of data.trains || []) {
    const key = `${d}:${t.tripId}`;
    const prev = lastSeen.get(key) || { delayMin: 0, cancelled: false };
    if (t.cancelled && !prev.cancelled) {
      new Notification(`Train ${t.trainNo} cancelled`, { body: `${data.from} → ${data.to}, scheduled ${t.depScheduled || t.dep}`, icon: "icons/icon128.png" });
    } else if (t.delayMin >= 3 && prev.delayMin < 3) {
      new Notification(`Train ${t.trainNo} delayed ${t.delayMin} min`, { body: `Now departing ${t.dep}`, icon: "icons/icon128.png" });
    }
    lastSeen.set(key, { delayMin: t.delayMin, cancelled: t.cancelled });
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
````


### `docs/sw.js`

````js
// App-shell cache (cache-first) + API passthrough with cached fallback.
// The API is on a different origin (the Worker); we don't cache cross-origin
// API responses in the SW — the app keeps its own last-good copy in memory.
const SHELL = "mct-shell-v2";
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
````


### `docs/manifest.webmanifest`

````json
{
  "name": "Chicagoland Rail",
  "short_name": "ChiRail",
  "start_url": ".",
  "scope": ".",
  "display": "standalone",
  "background_color": "#16181C",
  "theme_color": "#005A45",
  "icons": [
    {
      "src": "icons/icon192.png",
      "sizes": "192x192",
      "type": "image/png"
    },
    {
      "src": "icons/icon512.png",
      "sizes": "512x512",
      "type": "image/png"
    }
  ]
}
````


### `worker/src/index.js`

````js
// Chicagoland Rail — standalone API Worker (Metra GTFS data).
// Frontend lives on GitHub Pages; this Worker holds the Metra key, decodes the
// realtime protobuf feeds, and is the only thing that contacts Metra.
//
// Because the frontend is a public static site, there is no client secret to
// protect (anything shipped to the browser is public). Access control here is:
//   - CORS locked to your GitHub Pages origin (browser enforcement)
//   - optional Cloudflare rate-limiting rule on the route (real quota control)
// The Metra API key stays server-side in a Worker secret regardless.

import { kv, json as baseJson, bad, nextScheduled, secToClock } from "./static.js";
import { fetchFeed, indexTripUpdates, delayAt, alertsForRoute, positionFor } from "./realtime.js";

function cors(env) {
  const origin = env.ALLOWED_ORIGIN || "*";
  return {
    "Access-Control-Allow-Origin": origin,
    "Access-Control-Allow-Methods": "GET, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
    "Access-Control-Max-Age": "86400",
    "Vary": "Origin",
  };
}

function json(env, data, status = 200, cacheSeconds = 0) {
  const res = baseJson(data, status, cacheSeconds);
  const h = cors(env);
  for (const k in h) res.headers.set(k, h[k]);
  return res;
}

export default {
  async fetch(request, env, ctx) {
    if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: cors(env) });
    if (request.method !== "GET") return json(env, { error: "method not allowed" }, 405);

    const url = new URL(request.url);
    const waitUntil = ctx.waitUntil.bind(ctx);

    try {
      switch (url.pathname) {
        case "/api/meta": {
          const meta = await env.GTFS.get("meta", "json");
          return json(env, meta || { error: "no data ingested yet" }, meta ? 200 : 503, 300);
        }
        case "/api/lines":
          return json(env, await kv(env, "lines"), 200, 86400);
        case "/api/stops": {
          const route = url.searchParams.get("route");
          if (!route) throw bad("route parameter required");
          const data = await kv(env, `stops:${route}`);
          return json(env, { route, stations: data.stations }, 200, 86400);
        }
        case "/api/alerts": {
          const route = url.searchParams.get("route");
          if (!route) throw bad("route parameter required");
          const feed = await fetchFeed(env, "alerts", waitUntil);
          return json(env, { route, alerts: alertsForRoute(feed, route) }, 200, 30);
        }
        case "/api/next":
          return handleNext(url, env, waitUntil);
        default:
          return json(env, { error: "not found" }, 404);
      }
    } catch (e) {
      return json(env, { error: e.message || String(e) }, e.status || 500);
    }
  },
};

async function handleNext(url, env, waitUntil) {
  const route = url.searchParams.get("route");
  const from = url.searchParams.get("from");
  const to = url.searchParams.get("to");
  const count = Math.min(Number(url.searchParams.get("count")) || 3, 10);
  if (!route || !from || !to) throw bad("route, from, to parameters required");

  const { trains, serviceNote, stations } = await nextScheduled(env, route, from, to, count + 2);

  let alerts = [], realtime = false, rtError = null, tuIndex = null;
  try {
    const [tuFeed, alertFeed] = await Promise.all([
      fetchFeed(env, "tripupdates", waitUntil),
      fetchFeed(env, "alerts", waitUntil),
    ]);
    tuIndex = indexTripUpdates(tuFeed);
    alerts = alertsForRoute(alertFeed, route);
    realtime = true;
  } catch (e) { rtError = e.message; }

  let merged = trains.map(t => {
    const rec = tuIndex ? tuIndex.get(t.tripId) : null;
    const delaySec = rec ? delayAt(rec, from) : null;
    const delayMin = delaySec != null ? Math.round(delaySec / 60) : 0;
    const shift = (delaySec || 0) * 1000;
    return {
      ...t,
      cancelled: !!(rec && rec.cancelled),
      live: !!rec,
      delayMin,
      depEpochMs: t.depEpochMs + shift,
      arrEpochMs: t.arrEpochMs + shift,
      depScheduled: t.dep,
      dep: delayMin > 0 ? clockFromEpoch(t.depEpochMs + shift) : t.dep,
      arr: delayMin > 0 ? clockFromEpoch(t.arrEpochMs + shift) : t.arr,
    };
  });

  merged = merged.filter(t => t.cancelled || t.depEpochMs > Date.now() - 30000).slice(0, count);

  let pos = null;
  if (realtime && merged.length) {
    try {
      const posFeed = await fetchFeed(env, "positions", waitUntil);
      pos = positionFor(posFeed, merged.filter(t => !t.cancelled).map(t => t.tripId));
    } catch { /* positions optional */ }
  }

  return json(env, {
    route, from, to,
    generatedAt: new Date().toISOString(),
    realtime, rtError, serviceNote, alerts, position: pos,
    stations: stations
      .filter(s => within(stations, s, from, to))
      .map(s => ({ id: s.id, name: s.name, lat: s.lat, lon: s.lon })),
    trains: merged,
  }, 200, 15);
}

function clockFromEpoch(ms) {
  return new Intl.DateTimeFormat("en-US", {
    timeZone: "America/Chicago", hour: "numeric", minute: "2-digit",
  }).format(new Date(ms));
}

function within(stations, s, from, to) {
  const ids = stations.map(x => x.id);
  const a = ids.indexOf(from), b = ids.indexOf(to);
  if (a === -1 || b === -1) return false;
  const i = ids.indexOf(s.id);
  return i >= Math.min(a, b) && i <= Math.max(a, b);
}
````


### `worker/src/static.js`

````js
// Static-schedule core shared by Pages Functions. Mirrors the Worker logic.

export function bad(msg) { const e = new Error(msg); e.status = 400; return e; }

export async function kv(env, key) {
  const v = await env.GTFS.get(key, "json");
  if (!v) { const e = new Error(`no data for ${key} — run ingest`); e.status = 503; throw e; }
  return v;
}

export function json(data, status = 200, cacheSeconds = 0) {
  const headers = { "Content-Type": "application/json" };
  if (cacheSeconds > 0) headers["Cache-Control"] = `public, max-age=${cacheSeconds}`;
  return new Response(JSON.stringify(data), { status, headers });
}

export function errResponse(e) {
  return json({ error: e.message || String(e) }, e.status || 500);
}

// ---- Chicago time ----

export function chicagoParts(date = new Date()) {
  const fmt = new Intl.DateTimeFormat("en-US", {
    timeZone: "America/Chicago", hour12: false,
    year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", second: "2-digit", weekday: "short",
  });
  const p = Object.fromEntries(fmt.formatToParts(date).map(x => [x.type, x.value]));
  const wd = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"].indexOf(p.weekday);
  return {
    dateStr: `${p.year}${p.month}${p.day}`,
    weekday: wd,
    nowSec: (Number(p.hour) % 24) * 3600 + Number(p.minute) * 60 + Number(p.second),
  };
}

export function shiftDate(dateStr, deltaDays) {
  const y = +dateStr.slice(0, 4), m = +dateStr.slice(4, 6) - 1, d = +dateStr.slice(6, 8);
  const dt = new Date(Date.UTC(y, m, d));
  dt.setUTCDate(dt.getUTCDate() + deltaDays);
  return { dateStr: dt.toISOString().slice(0, 10).replace(/-/g, ""), weekday: dt.getUTCDay() };
}

export function secToClock(sec) {
  const s = ((sec % 86400) + 86400) % 86400;
  const h24 = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60);
  const h12 = h24 % 12 || 12;
  return `${h12}:${String(m).padStart(2, "0")} ${h24 < 12 ? "AM" : "PM"}`;
}

// ---- Services + trip matching ----

export function activeServices(cal, dateStr, weekday) {
  const set = new Set();
  for (const [id, s] of Object.entries(cal.services)) {
    if (dateStr >= s.start && dateStr <= s.end && s.days[weekday]) set.add(id);
  }
  for (const ex of cal.ex[dateStr] || []) {
    ex.t === 1 ? set.add(ex.s) : set.delete(ex.s);
  }
  return set;
}

export function tripsBetween(sched, stopsData, from, to, services, dayOffsetSec) {
  const order = stopsData.order;
  const iF = order.indexOf(from), iT = order.indexOf(to);
  if (iF === -1 || iT === -1) throw bad("unknown stop id for this route");
  const lo = Math.min(iF, iT), hi = Math.max(iF, iT);
  const interStops = order.slice(lo + 1, hi);

  const out = [];
  for (const t of sched.trips) {
    if (!services.has(t.svc)) continue;
    let a = -1, b = -1;
    for (let i = 0; i < t.st.length; i++) {
      if (t.st[i][0] === from && a === -1) a = i;
      if (t.st[i][0] === to) b = i;
    }
    if (a === -1 || b === -1 || a >= b) continue;
    const served = new Set(t.st.map(x => x[0]));
    const skipped = interStops.reduce((n, s) => n + (served.has(s) ? 0 : 1), 0);
    out.push({
      tripId: t.id,
      trainNo: t.no,
      headsign: t.head,
      depSec: t.st[a][2] + dayOffsetSec,
      arrSec: t.st[b][1] + dayOffsetSec,
      class: skipped > 8 ? "E" : "L",
      skipped,
      interTotal: interStops.length,
    });
  }
  return out;
}

// Next N scheduled trains from `from` to `to`, including yesterday's after-midnight trips.
export async function nextScheduled(env, route, from, to, count = 5) {
  const [cal, sched, stopsData] = await Promise.all([
    kv(env, "cal"), kv(env, `sched:${route}`), kv(env, `stops:${route}`),
  ]);
  const now = chicagoParts();
  const y = shiftDate(now.dateStr, -1);

  const candidates = [
    ...tripsBetween(sched, stopsData, from, to, activeServices(cal, y.dateStr, y.weekday), -86400),
    ...tripsBetween(sched, stopsData, from, to, activeServices(cal, now.dateStr, now.weekday), 0),
  ].filter(t => t.depSec >= now.nowSec - 120); // keep just-departed trains 2 min for delay matching

  candidates.sort((a, b) => a.depSec - b.depSec);

  const nowMs = Date.now();
  const trains = candidates.slice(0, count + 3).map(t => ({
    tripId: t.tripId,
    trainNo: t.trainNo,
    headsign: t.headsign,
    dep: secToClock(t.depSec),
    arr: secToClock(t.arrSec),
    depEpochMs: nowMs + (t.depSec - now.nowSec) * 1000,
    arrEpochMs: nowMs + (t.arrSec - now.nowSec) * 1000,
    minutes: Math.max(0, Math.round((t.depSec - now.nowSec) / 60)),
    class: t.class,
    skipped: t.skipped,
    interTotal: t.interTotal,
  }));

  return {
    trains,
    serviceNote: (cal.ex[now.dateStr] || []).length ? "modified" : null,
    stations: stopsData.stations,
  };
}
````


### `worker/src/realtime.js`

````js
// GTFS-realtime: fetch Metra protobuf feeds (30s edge cache), decode, merge.

import GtfsRealtimeBindings from "gtfs-realtime-bindings";

const RT_BASE = "https://gtfspublic.metrarr.com/gtfs/public";

// Fetch a realtime feed with a 30-second shared cache so many users = one Metra call.
export async function fetchFeed(env, kind, waitUntil) {
  if (!env.METRA_API_KEY) { const e = new Error("METRA_API_KEY secret not set"); e.status = 503; throw e; }
  const cache = caches.default;
  const cacheKey = new Request(`https://rt-cache.internal/${kind}`);

  let res = await cache.match(cacheKey);
  if (!res) {
    const upstream = await fetch(`${RT_BASE}/${kind}?api_token=${env.METRA_API_KEY}`, {
      headers: { "User-Agent": "metra-smart-commuter-tracker" },
    });
    if (!upstream.ok) { const e = new Error(`Metra ${kind} feed → ${upstream.status}`); e.status = 502; throw e; }
    const buf = await upstream.arrayBuffer();
    res = new Response(buf, {
      headers: { "Cache-Control": "public, max-age=30", "Content-Type": "application/octet-stream" },
    });
    const put = cache.put(cacheKey, res.clone());
    if (waitUntil) waitUntil(put); else await put;
  }

  const bytes = new Uint8Array(await res.arrayBuffer());
  return GtfsRealtimeBindings.transit_realtime.FeedMessage.decode(bytes);
}

const CANCEL_VALUES = new Set([3, "CANCELED", "CANCELLED"]); // TripDescriptor.ScheduleRelationship.CANCELED

// Map of tripId → { cancelled, delayFor(stopId) } from the tripupdates feed.
export function indexTripUpdates(feed) {
  const byTrip = new Map();
  for (const entity of feed.entity || []) {
    const tu = entity.tripUpdate;
    if (!tu || !tu.trip) continue;
    const tripId = tu.trip.tripId;
    if (!tripId) continue;
    const cancelled = CANCEL_VALUES.has(tu.trip.scheduleRelationship);
    const stus = (tu.stopTimeUpdate || []).map(s => ({
      stopId: s.stopId,
      seq: s.stopSequence,
      depDelay: s.departure && s.departure.delay != null ? s.departure.delay : null,
      arrDelay: s.arrival && s.arrival.delay != null ? s.arrival.delay : null,
      depTime: s.departure && s.departure.time ? Number(s.departure.time) : null,
      arrTime: s.arrival && s.arrival.time ? Number(s.arrival.time) : null,
      skipped: CANCEL_VALUES.has(s.scheduleRelationship) || s.scheduleRelationship === 1 || s.scheduleRelationship === "SKIPPED",
    }));
    byTrip.set(tripId, { cancelled, tripDelay: tu.delay != null ? tu.delay : null, stus });
  }
  return byTrip;
}

// Delay in seconds at a given stop for a trip update record. Falls back to the
// closest preceding stop-time-update, then the trip-level delay.
export function delayAt(rec, stopId) {
  if (!rec) return null;
  let best = null;
  for (const s of rec.stus) {
    if (s.stopId === stopId) {
      return s.depDelay ?? s.arrDelay ?? rec.tripDelay ?? null;
    }
    if (s.depDelay != null || s.arrDelay != null) best = s.depDelay ?? s.arrDelay;
  }
  return best ?? rec.tripDelay ?? null;
}

// Alerts for one route: [{ id, header, description, effect, start, end }]
export function alertsForRoute(feed, routeId) {
  const out = [];
  for (const entity of feed.entity || []) {
    const a = entity.alert;
    if (!a) continue;
    const informed = a.informedEntity || [];
    const matches = informed.some(ie => ie.routeId === routeId);
    if (!matches) continue;
    out.push({
      id: entity.id,
      header: text(a.headerText),
      description: text(a.descriptionText),
      effect: a.effect ?? null,
    });
  }
  return out;
}

// First vehicle position matching any of the given trip ids: { tripId, lat, lon }
export function positionFor(feed, tripIds) {
  const wanted = new Set(tripIds);
  for (const entity of feed.entity || []) {
    const v = entity.vehicle;
    if (!v || !v.trip || !v.position) continue;
    if (wanted.has(v.trip.tripId)) {
      return { tripId: v.trip.tripId, lat: v.position.latitude, lon: v.position.longitude };
    }
  }
  return null;
}

function text(t) {
  if (!t || !t.translation || !t.translation.length) return "";
  const en = t.translation.find(x => !x.language || x.language.startsWith("en"));
  return (en || t.translation[0]).text || "";
}
````


### `worker/wrangler.toml`

````toml
name = "metra-proxy"
main = "src/index.js"
compatibility_date = "2026-06-01"

# 1) Create KV:  npx wrangler kv namespace create GTFS   → paste id below
[[kv_namespaces]]
binding = "GTFS"
id = "PASTE_KV_NAMESPACE_ID_HERE"

[vars]
# Set to your GitHub Pages origin to lock CORS (recommended before launch).
# Examples: "https://abhishek16.github.io"  (user site or project site share this origin)
# Leave "*" while testing.
ALLOWED_ORIGIN = "*"

# 2) Metra key as a secret:  npx wrangler secret put METRA_API_KEY
````


### `worker/package.json`

````json
{
  "name": "metra-proxy",
  "private": true,
  "type": "module",
  "scripts": { "dev": "wrangler dev", "deploy": "wrangler deploy" },
  "dependencies": { "gtfs-realtime-bindings": "^1.1.1" },
  "devDependencies": { "wrangler": "^4.0.0" }
}
````


### `ingest/ingest.js`

````js
// Metra GTFS static ingest.
// Fetches schedule.zip, precomputes per-line data, writes JSON blobs to Cloudflare Workers KV.
// Runs in GitHub Actions (daily cron) or locally. `node ingest.js --dry-run` validates
// the feed and prints a report without writing to KV.
//
// Env vars (required unless --dry-run):
//   CF_ACCOUNT_ID, CF_API_TOKEN, KV_NAMESPACE_ID
// Optional:
//   METRA_API_KEY   (sent as Bearer token if the static feed requires auth)
//   GTFS_ZIP_URL    (default: https://schedules.metrarail.com/gtfs/schedule.zip)
//   PUBLISHED_URL   (default: https://schedules.metrarail.com/gtfs/published.txt)

import AdmZip from "adm-zip";
import { parse } from "csv-parse/sync";

const ZIP_URL = process.env.GTFS_ZIP_URL || "https://schedules.metrarail.com/gtfs/schedule.zip";
const PUBLISHED_URL = process.env.PUBLISHED_URL || "https://schedules.metrarail.com/gtfs/published.txt";
const DRY_RUN = process.argv.includes("--dry-run");

function authHeaders() {
  const h = { "User-Agent": "metra-smart-commuter-tracker-ingest" };
  if (process.env.METRA_API_KEY) h["Authorization"] = `Bearer ${process.env.METRA_API_KEY}`;
  return h;
}

async function fetchBuffer(url) {
  const res = await fetch(url, { headers: authHeaders() });
  if (!res.ok) throw new Error(`Fetch ${url} failed: ${res.status}`);
  return Buffer.from(await res.arrayBuffer());
}

function readCsv(zip, name) {
  const entry = zip.getEntry(name);
  if (!entry) throw new Error(`Missing ${name} in GTFS zip`);
  return parse(entry.getData().toString("utf8"), {
    columns: true,
    skip_empty_lines: true,
    bom: true,
    trim: true,
  });
}

function hmsToSec(hms) {
  const [h, m, s] = hms.split(":").map(Number);
  return h * 3600 + m * 60 + (s || 0);
}

// Merge a trip's stop list into a canonical order using shared-neighbor insertion.
function mergeOrder(order, tripStops) {
  const pos = new Map(order.map((id, i) => [id, i]));
  for (let i = 0; i < tripStops.length; i++) {
    const id = tripStops[i];
    if (pos.has(id)) continue;
    // find nearest preceding stop in this trip that exists in canonical order
    let insertAfter = -1;
    for (let j = i - 1; j >= 0; j--) {
      if (pos.has(tripStops[j])) { insertAfter = pos.get(tripStops[j]); break; }
    }
    order.splice(insertAfter + 1, 0, id);
    pos.clear();
    order.forEach((sid, idx) => pos.set(sid, idx));
  }
  return order;
}

async function main() {
  console.log("Fetching published.txt ...");
  let publishedAt = "unknown";
  try {
    publishedAt = (await fetchBuffer(PUBLISHED_URL)).toString("utf8").trim();
    console.log("Schedule published:", publishedAt);
  } catch (e) {
    console.warn("Could not read published.txt:", e.message);
  }

  console.log("Fetching schedule.zip ...");
  const zip = new AdmZip(await fetchBuffer(ZIP_URL));

  const routes = readCsv(zip, "routes.txt");
  const stops = readCsv(zip, "stops.txt");
  const trips = readCsv(zip, "trips.txt");
  const stopTimes = readCsv(zip, "stop_times.txt");
  const calendar = readCsv(zip, "calendar.txt");
  let calendarDates = [];
  try { calendarDates = readCsv(zip, "calendar_dates.txt"); } catch { /* optional */ }

  console.log(`Parsed: ${routes.length} routes, ${stops.length} stops, ${trips.length} trips, ${stopTimes.length} stop_times`);

  const stopById = new Map(stops.map(s => [s.stop_id, s]));

  // Group stop_times by trip, ordered by stop_sequence
  const stByTrip = new Map();
  for (const st of stopTimes) {
    if (!stByTrip.has(st.trip_id)) stByTrip.set(st.trip_id, []);
    stByTrip.get(st.trip_id).push(st);
  }
  for (const arr of stByTrip.values()) arr.sort((a, b) => Number(a.stop_sequence) - Number(b.stop_sequence));

  // Calendar
  const cal = { services: {}, ex: {} };
  const DAYS = ["sunday", "monday", "tuesday", "wednesday", "thursday", "friday", "saturday"];
  for (const c of calendar) {
    cal.services[c.service_id] = {
      start: c.start_date,
      end: c.end_date,
      days: DAYS.map(d => c[d] === "1" ? 1 : 0), // index 0 = Sunday
    };
  }
  for (const cd of calendarDates) {
    (cal.ex[cd.date] ||= []).push({ s: cd.service_id, t: Number(cd.exception_type) }); // 1=add 2=remove
  }

  // Per-route builds
  const lines = [];
  const kvWrites = [];
  const report = [];

  for (const r of routes) {
    const routeId = r.route_id;
    lines.push({
      id: routeId,
      name: r.route_long_name || r.route_short_name || routeId,
      color: r.route_color ? `#${r.route_color}` : "#37414B",
      textColor: r.route_text_color ? `#${r.route_text_color}` : "#FFFFFF",
    });

    const routeTrips = trips.filter(t => t.route_id === routeId);
    // Canonical station order from direction 0 trips, longest first
    const dir0 = routeTrips
      .filter(t => t.direction_id !== "1")
      .map(t => (stByTrip.get(t.trip_id) || []).map(st => st.stop_id))
      .filter(a => a.length > 1)
      .sort((a, b) => b.length - a.length);
    let order = dir0.length ? [...dir0[0]] : [];
    for (const tripStops of dir0.slice(1)) mergeOrder(order, tripStops);
    // Also merge dir1 trips reversed, to catch stops only served one way
    const dir1 = routeTrips
      .filter(t => t.direction_id === "1")
      .map(t => (stByTrip.get(t.trip_id) || []).map(st => st.stop_id).reverse())
      .filter(a => a.length > 1)
      .sort((a, b) => b.length - a.length);
    for (const tripStops of dir1) mergeOrder(order, tripStops);

    const stations = order.map(id => {
      const s = stopById.get(id);
      return { id, name: s ? s.stop_name : id, lat: s ? Number(s.stop_lat) : null, lon: s ? Number(s.stop_lon) : null };
    });

    const compactTrips = routeTrips.map(t => {
      const st = stByTrip.get(t.trip_id) || [];
      return {
        id: t.trip_id,
        no: t.trip_short_name || t.trip_id,
        svc: t.service_id,
        dir: t.direction_id === "1" ? 1 : 0,
        head: t.trip_headsign || "",
        st: st.map(x => [x.stop_id, hmsToSec(x.arrival_time), hmsToSec(x.departure_time)]),
      };
    }).filter(t => t.st.length > 1);

    kvWrites.push({ key: `stops:${routeId}`, value: JSON.stringify({ order, stations }) });
    kvWrites.push({ key: `sched:${routeId}`, value: JSON.stringify({ trips: compactTrips }) });
    report.push({ routeId, stations: stations.length, trips: compactTrips.length });
  }

  kvWrites.push({ key: "lines", value: JSON.stringify(lines) });
  kvWrites.push({ key: "cal", value: JSON.stringify(cal) });
  kvWrites.push({ key: "meta", value: JSON.stringify({ publishedAt, ingestedAt: new Date().toISOString() }) });

  console.table(report);

  // ---- Validation: express classification sanity check (BNSF Naperville → Chicago) ----
  const bnsf = kvWrites.find(w => w.key.startsWith("sched:") && /bnsf/i.test(w.key));
  const bnsfStops = kvWrites.find(w => w.key.startsWith("stops:") && /bnsf/i.test(w.key));
  if (bnsf && bnsfStops) {
    const { trips: T } = JSON.parse(bnsf.value);
    const { order: O, stations: S } = JSON.parse(bnsfStops.value);
    const nap = S.find(s => /naperville/i.test(s.name));
    const cus = S.find(s => /union/i.test(s.name)) || S.find(s => /chicago/i.test(s.name));
    if (nap && cus) {
      const iF = O.indexOf(nap.id), iT = O.indexOf(cus.id);
      const lo = Math.min(iF, iT), hi = Math.max(iF, iT);
      const inter = O.slice(lo + 1, hi);
      let ex = 0, loc = 0;
      for (const t of T) {
        const ids = t.st.map(x => x[0]);
        const a = ids.indexOf(nap.id), b = ids.indexOf(cus.id);
        if (a === -1 || b === -1 || a >= b) continue;
        const served = new Set(ids);
        const skipped = inter.filter(s => !served.has(s)).length;
        skipped > 8 ? ex++ : loc++;
      }
      console.log(`\nValidation — BNSF ${nap.name} → ${cus.name}: ${inter.length} intermediate stations, ${ex} express trips, ${loc} local trips`);
    } else {
      console.warn("Validation skipped: could not find Naperville/Union Station stops by name.");
    }
  }

  if (DRY_RUN) {
    console.log("\nDry run complete. No KV writes performed.");
    return;
  }

  // ---- Bulk write to Cloudflare KV ----
  const { CF_ACCOUNT_ID, CF_API_TOKEN, KV_NAMESPACE_ID } = process.env;
  if (!CF_ACCOUNT_ID || !CF_API_TOKEN || !KV_NAMESPACE_ID) {
    throw new Error("Missing CF_ACCOUNT_ID / CF_API_TOKEN / KV_NAMESPACE_ID env vars");
  }
  const url = `https://api.cloudflare.com/client/v4/accounts/${CF_ACCOUNT_ID}/storage/kv/namespaces/${KV_NAMESPACE_ID}/bulk`;
  // KV bulk API accepts up to 10k pairs / 100MB; chunk defensively at 50 pairs
  for (let i = 0; i < kvWrites.length; i += 50) {
    const chunk = kvWrites.slice(i, i + 50);
    const res = await fetch(url, {
      method: "PUT",
      headers: { Authorization: `Bearer ${CF_API_TOKEN}`, "Content-Type": "application/json" },
      body: JSON.stringify(chunk),
    });
    const body = await res.json();
    if (!res.ok || !body.success) throw new Error(`KV bulk write failed: ${JSON.stringify(body.errors || body)}`);
    console.log(`KV: wrote ${chunk.length} keys (${i + chunk.length}/${kvWrites.length})`);
  }
  console.log("Ingest complete.");
}

main().catch(e => { console.error(e); process.exit(1); });
````


### `ingest/package.json`

````json
{
  "name": "metra-gtfs-ingest",
  "private": true,
  "type": "module",
  "engines": { "node": ">=20" },
  "scripts": {
    "ingest": "node ingest.js",
    "dry-run": "node ingest.js --dry-run"
  },
  "dependencies": {
    "adm-zip": "^0.5.14",
    "csv-parse": "^5.5.6"
  }
}
````


### `.github/workflows/gtfs-ingest.yml`

````yaml
name: GTFS ingest

on:
  schedule:
    - cron: "20 8 * * *"   # ~3:20 AM Central (UTC-based; DST shifts it 1h — acceptable)
  workflow_dispatch: {}     # manual runs

jobs:
  ingest:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          node-version: 20
      - run: npm install
        working-directory: ingest
      - run: node ingest.js
        working-directory: ingest
        env:
          CF_ACCOUNT_ID: ${{ secrets.CF_ACCOUNT_ID }}
          CF_API_TOKEN: ${{ secrets.CF_API_TOKEN }}
          KV_NAMESPACE_ID: ${{ secrets.KV_NAMESPACE_ID }}
          METRA_API_KEY: ${{ secrets.METRA_API_KEY }}
````

## 8. API reference (Worker)

| Endpoint | Purpose |
|---|---|
| `GET /api/lines` | Lines with official GTFS colors |
| `GET /api/stops?route=BNSF` | Ordered stations for a line |
| `GET /api/next?route=BNSF&from=X&to=Y&count=3` | The one the app uses: delay-merged trains + alerts + live position + journey stations |
| `GET /api/alerts?route=BNSF` | Alerts only |
| `GET /api/timetable?route=BNSF&from=X&to=Y&date=today\|tomorrow\|YYYYMMDD` | Full-day scheduled timetable for any date (incl. weekends), no realtime merge |
| `GET /api/weather?lat=&lon=` | Hourly forecast periods via api.weather.gov (edge-cached 30 min) |
| `GET /api/push/key` | VAPID public key for Web Push subscription |
| `POST /api/push/subscribe` | Body `{subscription, lines[], reminders[], briefing}` — register for background alerts |
| `POST /api/push/unsubscribe` | Body `{endpoint}` — remove a subscription |

**Background push:** a Worker cron (`*/15 * * * *`, see `wrangler.toml` `[triggers]`
— kept low-frequency to stay well inside the free tier) runs `poller.js`, which:
(a) diffs the realtime feed against `pushstate:<line>` in KV for new delays/alerts,
(b) fires per-user **departure reminders** (delay-aware, matched by `depSec` +
active service), and (c) **morning briefings**. Reminder/briefing config lives in the
`sub:<hash>` record; `lastFired` (per day) dedupes. Web Push = VAPID + RFC 8291
aes128gcm, all WebCrypto in `push.js`. Secrets: `VAPID_PRIVATE_JWK`; public key +
`VAPID_SUBJECT` are `[vars]`. iOS delivers Web Push only to a Safari-installed PWA
(iOS 16.4+), not to Chrome/other iOS browsers.
| `GET /api/meta` | Ingest freshness timestamp |

## 9. Conventions for future edits

- No build step, no framework — vanilla JS/CSS/HTML. Keep it that way.
- Pure logic lives in `docs/logic.js` (no `chrome.*`, no DOM) so it stays testable.
- Add Phase-3 features (weather via api.weather.gov, departure reminders, quiet
  hours) as additive modules; don't entangle them with the realtime merge.
- When adding a Worker endpoint, add its route in `worker/src/index.js` and keep
  CORS going through the `json(env, …)` helper.

## 10. Troubleshooting

- `/api/*` → 503 "no data": ingest hasn't run or KV isn't bound. Run the Action;
  confirm the `GTFS` binding id in `wrangler.toml`.
- `/api/alerts` → 502: Metra rejected the `?api_token=` param. In
  `worker/src/realtime.js` `fetchFeed`, send the key as a header instead
  (`Authorization: Bearer ...`) — one-line change.
- Site loads but no trains, console shows CORS error: `API_BASE` wrong in
  `config.js`, or `ALLOWED_ORIGIN` doesn't match your Pages origin.
- 404s for `app.js`/icons on Pages: a path went absolute (`/app.js`). All `docs/`
  paths must be relative.
- Favicon badge not updating: expected when the tab is fully discarded by the
  browser; it resumes on focus.

# Metra Smart Commuter Tracker — GitHub Pages edition

Frontend hosted free on **GitHub Pages**; the API runs on **one small Cloudflare
Worker** (free) that holds your Metra key, decodes the realtime feeds, and is the
only thing that ever contacts Metra (license-compliant).

```
Your phone/browser ─► GitHub Pages (docs/)  ── fetch ──►  Cloudflare Worker (worker/)
                       static site only                    holds key, decodes protobuf
                                                                     │
                                                                     ▼
                                                            Metra GTFS feeds
```

Why the Worker is unavoidable: GitHub Pages serves static files only. Realtime
delays/alerts need (a) your secret API key kept off the client and (b) protobuf
decoding — neither is possible in a pure static page, and calling Metra directly
from the browser would break their license.

Repo layout:
- `docs/` — the website (this is what GitHub Pages serves)
- `worker/` — the Cloudflare Worker API
- `ingest/` — parses Metra GTFS into the Worker's KV (runs in GitHub Actions daily)
- `.github/workflows/` — the daily ingest job

---

## Deploy

### 0. Validate the feed first (local, 5 min)
```bash
cd ingest && npm install
METRA_API_KEY=your_key node ingest.js --dry-run
```
Check the per-line table and the BNSF express validation line look right.

### 1. Deploy the Worker
```bash
cd worker && npm install
npx wrangler login
npx wrangler kv namespace create GTFS      # paste the id into wrangler.toml
npx wrangler secret put METRA_API_KEY      # your Metra key
npx wrangler deploy                        # note the https://metra-proxy.<you>.workers.dev URL
```
Recommended: in the Cloudflare dashboard add a rate-limit rule (~10 req/min per IP)
on the worker route. Since a public site has no usable client secret, that rule +
the CORS lock (step 4) are your real protection. The Metra key stays in the secret
either way.

### 2. Push this repo to GitHub and run the ingest
Repo → Settings → Secrets → Actions, add: `CF_ACCOUNT_ID`, `CF_API_TOKEN`
(permission: Workers KV Storage: Edit), `KV_NAMESPACE_ID`, `METRA_API_KEY`.
Actions tab → **GTFS ingest** → Run workflow. (Then runs daily ~3:20 AM Central.)

Verify: `curl https://metra-proxy.<you>.workers.dev/api/meta` → publish timestamp.

### 3. Point the site at your Worker
Edit `docs/config.js`:
```js
export const API_BASE = "https://metra-proxy.<you>.workers.dev";
```
Commit and push.

### 4. Turn on GitHub Pages
Repo → Settings → Pages → Source: **Deploy from a branch** → Branch: `main`,
Folder: **/docs** → Save. Your site appears at
`https://<you>.github.io/<repo>/` in a minute or two.

Then lock CORS: set `ALLOWED_ORIGIN = "https://<you>.github.io"` in
`worker/wrangler.toml` and `npx wrangler deploy` again.

### 5. Open it on your phone
Visit the Pages URL, complete onboarding (line, home, work). On iOS Safari or
Android Chrome, use "Add to Home Screen" to install it as an app.

---

## Features
Live delay-adjusted times (original struck through), cancellations labeled,
line-specific alert banners, express detection with "Express in X min" hint,
next-3 trains with live countdowns, journey bar with live/estimated position,
smart AM/PM direction with reverse override, up to 5 saved routes, dynamic
favicon + tab-title badge, opt-in delay/cancellation notifications (while a tab
is open), dark mode, offline shell.

## Notes
- **Public repo = no client secrets.** Anything in `docs/` (including `config.js`)
  is world-readable — that's fine, it only contains the Worker URL. Never put the
  Metra key anywhere in `docs/`.
- GitHub Pages URLs are case-sensitive and served under `/<repo>/`; all paths in
  the site are relative, so it works at a subpath or at a root user-site.
- Browser notifications fire only while a tab is open (no background push).
- If `/api/alerts` returns 502 on first deploy, Metra rejected the query-param
  token — switch the token to a header in `worker/src/realtime.js` (one marked line).
- Pure-static fallback (schedule only, no Worker, no alerts) is available on request.

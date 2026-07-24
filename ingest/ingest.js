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
import { buildFares } from "./fares.js";

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
  // Fares (GTFS-Fares v1). One-way prices live here; Day/Monthly are paired in fares.js.
  let fareAttributes = [], fareRules = [];
  try { fareAttributes = readCsv(zip, "fare_attributes.txt"); } catch { /* optional */ }
  try { fareRules = readCsv(zip, "fare_rules.txt"); } catch { /* optional */ }

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
      return {
        id,
        name: s ? s.stop_name : id,
        lat: s ? Number(s.stop_lat) : null,
        lon: s ? Number(s.stop_lon) : null,
        // zone_id drives fare lookup (Metra prices by zone pair). Kept as a string
        // ("1".."4"); null when the feed omits it so fare display just degrades.
        zone: s && s.zone_id != null && String(s.zone_id).trim() !== "" ? String(s.zone_id).trim() : null,
      };
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

  // System-wide fare table (route_id is blank in Metra's fare_rules → one table for all lines).
  const fares = buildFares(fareAttributes, fareRules);
  if (fares) kvWrites.push({ key: "fares", value: JSON.stringify(fares) });

  console.table(report);

  // ---- Validation: fare table (one-way from feed, Day/Monthly paired in fares.js) ----
  if (fares) {
    console.log(`\nFares (as of ${fares.asOf}, ${fares.currency}):`);
    console.table(Object.fromEntries(Object.entries(fares.byPair)
      .map(([pair, f]) => [pair, { oneWay: f.oneWay, dayPass: f.day, monthly: f.monthly }])));
  } else {
    console.warn("No fare table built — fare_attributes.txt / fare_rules.txt missing or empty.");
  }

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

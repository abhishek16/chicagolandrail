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
      stops: t.st.slice(a, b + 1).map(x => ({ id: x[0], depSec: x[2] })), // served stops in this segment
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
    stops: t.stops.map(s => ({ id: s.id, dep: secToClock(s.depSec) })),
  }));

  return {
    trains,
    serviceNote: (cal.ex[now.dateStr] || []).length ? "modified" : null,
    stations: stopsData.stations,
  };
}

// Full scheduled timetable for one service day. `dateStr` is YYYYMMDD (any day,
// including weekends/holidays); defaults to today in Chicago. Scheduled times
// only — no realtime merge.
export async function timetableFor(env, route, from, to, dateStr = null) {
  const [cal, sched, stopsData] = await Promise.all([
    kv(env, "cal"), kv(env, `sched:${route}`), kv(env, `stops:${route}`),
  ]);
  const base = dateStr || chicagoParts().dateStr;
  const day = shiftDate(base, 0); // normalizes + resolves the weekday for that date

  const trains = tripsBetween(sched, stopsData, from, to, activeServices(cal, day.dateStr, day.weekday), 0)
    .sort((a, b) => a.depSec - b.depSec)
    .map(t => ({
      trainNo: t.trainNo,
      dep: secToClock(t.depSec),
      arr: secToClock(t.arrSec),
      depSec: t.depSec,
      durMin: Math.max(0, Math.round((t.arrSec - t.depSec) / 60)),
      class: t.class,
      skipped: t.skipped,
    }));

  const fare = computeFare(await faresTable(env), stopsData.stations, from, to);
  return {
    route, from, to,
    date: day.dateStr,
    serviceNote: (cal.ex[day.dateStr] || []).length ? "modified" : null,
    trains,
    fare,
  };
}

// ---- Fares ----

// The precomputed fare table (ingest writes it). Missing → null, never throws, so
// fare display simply degrades to absent.
export async function faresTable(env) {
  try { return await env.GTFS.get("fares", "json"); } catch { return null; }
}

// Fare for a from→to trip, derived from the `fares` blob + station zones. Metra
// prices by zone pair (symmetric), so direction doesn't matter. Returns null when
// fares or either station's zone is unavailable. `breakEvenRoundTrips` = the number
// of round trips per month at which a Monthly pass matches pay-per-ride (⌈monthly /
// (2·oneWay)⌉); above it the Monthly wins.
export function computeFare(fares, stations, from, to) {
  if (!fares || !fares.byPair || !Array.isArray(stations)) return null;
  const zoneOf = id => {
    const s = stations.find(x => x.id === id);
    return s && s.zone != null && s.zone !== "" ? String(s.zone) : null;
  };
  const zf = zoneOf(from), zt = zoneOf(to);
  if (zf == null || zt == null) return null;
  const key = zf <= zt ? `${zf}-${zt}` : `${zt}-${zf}`; // must match ingest's pairKey()
  const f = fares.byPair[key];
  if (!f || f.oneWay == null) return null;
  const roundTrip = Math.round(f.oneWay * 200) / 100; // 2 · oneWay, cent-safe
  const breakEvenRoundTrips = f.monthly != null && roundTrip > 0 ? Math.ceil(f.monthly / roundTrip) : null;
  return {
    oneWay: f.oneWay, day: f.day, monthly: f.monthly,
    roundTrip, breakEvenRoundTrips,
    zonePair: key, currency: fares.currency || "USD", asOf: fares.asOf || null,
  };
}

// Chicagoland Rail — standalone API Worker (Metra GTFS data).
// Frontend is a static site on Cloudflare Pages; this Worker holds the Metra
// key, decodes the realtime protobuf feeds, and is the only thing that contacts
// Metra.
//
// Because the frontend is a public static site, there is no client secret to
// protect (anything shipped to the browser is public). Access control here is:
//   - CORS locked to an allowlist of your site origins (browser enforcement)
//   - optional Cloudflare rate-limiting rule on the route (real quota control)
// The Metra API key stays server-side in a Worker secret regardless.

import { kv, json as baseJson, bad, nextScheduled, timetableFor, secToClock, chicagoParts, shiftDate } from "./static.js";
import { fetchFeed, indexTripUpdates, delayAt, alertsForRoute, positionFor } from "./realtime.js";
import { runPushCycle } from "./poller.js";
import { weatherFor } from "./weather.js";

// CORS: ALLOWED_ORIGIN is a comma-separated allowlist. We echo the caller's
// Origin when it's on the list, so the Cloudflare Pages site, a future custom
// domain, and the old GitHub Pages origin can all be served at once without
// weakening to "*". A value of "*" allows any origin (testing only).
//
// Cloudflare Pages branch/hash previews (e.g. redesign.chicagolandrail.pages.dev)
// are also allowed automatically, so a preview deploy works without adding each
// subdomain to the secret. Only *.chicagolandrail.pages.dev matches — our own
// project — so this doesn't open the door to arbitrary origins.
const PAGES_PREVIEW = /^https:\/\/[a-z0-9-]+\.chicagolandrail\.pages\.dev$/i;
function allowedOrigin(env, request) {
  const reqOrigin = request.headers.get("Origin") || "";
  const list = String(env.ALLOWED_ORIGIN || "*").split(",").map(s => s.trim()).filter(Boolean);
  if (list.includes("*")) return "*";
  if (reqOrigin && (list.includes(reqOrigin) || PAGES_PREVIEW.test(reqOrigin))) return reqOrigin;
  return list[0] || "*"; // unlisted origin → the browser blocks it; send a stable default
}

function corsHeaders(origin) {
  return {
    "Access-Control-Allow-Origin": origin,
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
    "Access-Control-Max-Age": "86400",
    "Vary": "Origin",
  };
}

// CORS headers are applied centrally in fetch(); env is kept so callers are unchanged.
function json(env, data, status = 200, cacheSeconds = 0) {
  return baseJson(data, status, cacheSeconds);
}

export default {
  async fetch(request, env, ctx) {
    const res = await route(request, env, ctx);
    const h = corsHeaders(allowedOrigin(env, request));
    for (const k in h) res.headers.set(k, h[k]);
    return res;
  },

  // Cron trigger — send background push notifications for new delays/alerts.
  async scheduled(event, env, ctx) {
    ctx.waitUntil(runPushCycle(env));
  },
};

// All request routing; CORS headers are added by fetch() above.
async function route(request, env, ctx) {
  if (request.method === "OPTIONS") return new Response(null, { status: 204 });

  const url = new URL(request.url);
  const waitUntil = ctx.waitUntil.bind(ctx);

    try {
      if (request.method === "POST") {
        if (url.pathname === "/api/push/subscribe") return pushSubscribe(request, env);
        if (url.pathname === "/api/push/unsubscribe") return pushUnsubscribe(request, env);
        return json(env, { error: "not found" }, 404);
      }
      if (request.method !== "GET") return json(env, { error: "method not allowed" }, 405);
      switch (url.pathname) {
        case "/api/push/key":
          return json(env, { key: env.VAPID_PUBLIC || null }, 200, 3600);
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
        case "/api/timetable": {
          const route = url.searchParams.get("route");
          const from = url.searchParams.get("from");
          const to = url.searchParams.get("to");
          if (!route || !from || !to) throw bad("route, from, to parameters required");
          return json(env, await timetableFor(env, route, from, to, resolveDate(url.searchParams.get("date"))), 200, 300);
        }
        case "/api/weather": {
          const lat = Number(url.searchParams.get("lat")), lon = Number(url.searchParams.get("lon"));
          if (!Number.isFinite(lat) || !Number.isFinite(lon)) throw bad("lat, lon required");
          // Edge-cache 30 min per rounded coordinate → ~1 upstream call/station/30min.
          const ck = new Request(`https://wx-cache.internal/${lat.toFixed(3)},${lon.toFixed(3)}`);
          const hit = await caches.default.match(ck);
          if (hit) return json(env, await hit.json(), 200, 1800);
          const data = await weatherFor(lat.toFixed(4), lon.toFixed(4), env.VAPID_SUBJECT);
          waitUntil(caches.default.put(ck, new Response(JSON.stringify(data), {
            headers: { "Cache-Control": "public, max-age=1800", "Content-Type": "application/json" },
          })));
          return json(env, data, 200, 1800);
        }
        case "/api/next":
          return handleNext(url, env, waitUntil);
        case "/api/debug": {
          // TEMPORARY read-only diagnostic: is the realtime feed empty, or do its
          // trip IDs not match the static schedule? (Returns only trip-id strings.)
          const route = url.searchParams.get("route") || "BNSF";
          const [tu, pos] = await Promise.all([
            fetchFeed(env, "tripupdates", waitUntil),
            fetchFeed(env, "positions", waitUntil),
          ]);
          const tuTrips = (tu.entity || []).filter(e => e.tripUpdate).map(e => e.tripUpdate.trip && e.tripUpdate.trip.tripId).filter(Boolean);
          const posTrips = (pos.entity || []).filter(e => e.vehicle).map(e => e.vehicle.trip && e.vehicle.trip.tripId).filter(Boolean);
          const sched = await kv(env, `sched:${route}`);
          const schedIds = sched.trips.map(t => t.id);
          const schedSet = new Set(schedIds);
          return json(env, {
            route,
            tripupdates: { entities: (tu.entity || []).length, withTripId: tuTrips.length, sample: tuTrips.slice(0, 10) },
            positions: { entities: (pos.entity || []).length, withTripId: posTrips.length, sample: posTrips.slice(0, 10) },
            sched: { count: schedIds.length, sample: schedIds.slice(0, 10) },
            matches: { tripupdatesInSched: tuTrips.filter(id => schedSet.has(id)).length, positionsInSched: posTrips.filter(id => schedSet.has(id)).length },
          }, 200, 10);
        }
        default:
          return json(env, { error: "not found" }, 404);
      }
    } catch (e) {
      return json(env, { error: e.message || String(e) }, e.status || 500);
    }
}

async function sha256hex(s) {
  const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s));
  return [...new Uint8Array(buf)].map(b => b.toString(16).padStart(2, "0")).join("");
}

async function pushSubscribe(request, env) {
  const { subscription, lines, reminders, briefing } = await request.json();
  if (!subscription || !subscription.endpoint) throw bad("subscription with endpoint required");
  const key = "sub:" + await sha256hex(subscription.endpoint);
  // Preserve lastFired markers so a re-subscribe doesn't re-fire today's reminders.
  const prior = await env.GTFS.get(key, "json");
  const priorFired = {};
  for (const r of prior?.reminders || []) if (r.id) priorFired[r.id] = r.lastFired;
  const rems = (Array.isArray(reminders) ? reminders : []).map(r => ({ ...r, lastFired: priorFired[r.id] || r.lastFired || null }));
  const brief = briefing ? { ...briefing, lastFired: prior?.briefing?.lastFired || null } : null;
  await env.GTFS.put(key, JSON.stringify({ subscription, lines: Array.isArray(lines) ? lines : [], reminders: rems, briefing: brief, updatedAt: Date.now() }));
  return json(env, { ok: true });
}

async function pushUnsubscribe(request, env) {
  const { endpoint } = await request.json();
  if (!endpoint) throw bad("endpoint required");
  await env.GTFS.delete("sub:" + await sha256hex(endpoint));
  return json(env, { ok: true });
}

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

// Accepts "today", "tomorrow", "YYYYMMDD", or "YYYY-MM-DD"; returns YYYYMMDD.
function resolveDate(p) {
  if (!p || p === "today") return chicagoParts().dateStr;
  if (p === "tomorrow") return shiftDate(chicagoParts().dateStr, 1).dateStr;
  if (/^\d{8}$/.test(p)) return p;
  if (/^\d{4}-\d{2}-\d{2}$/.test(p)) return p.replace(/-/g, "");
  return chicagoParts().dateStr;
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

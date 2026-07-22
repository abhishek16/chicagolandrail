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
    byTrip.set(tripId, { cancelled, routeId: tu.trip.routeId || null, tripDelay: tu.delay != null ? tu.delay : null, stus });
  }
  return byTrip;
}

// Delay in seconds at a given stop for a trip update record. Prefers an explicit
// GTFS-realtime `delay`, but Metra usually sends only an absolute predicted `time`
// (no `delay` field), so we derive the delay from (predicted − scheduled) when the
// scheduled dep/arr seconds are supplied. Falls back to the closest stop-time-update
// with an explicit delay, then the trip-level delay.
export function delayAt(rec, stopId, schedDepSec = null, schedArrSec = null) {
  if (!rec) return null;
  let best = null;
  for (const s of rec.stus) {
    if (s.stopId === stopId) {
      if (s.depDelay != null) return s.depDelay;
      if (s.arrDelay != null) return s.arrDelay;
      if (s.depTime != null && schedDepSec != null) return s.depTime - schedDepSec;
      if (s.arrTime != null && schedArrSec != null) return s.arrTime - schedArrSec;
      return rec.tripDelay ?? null;
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

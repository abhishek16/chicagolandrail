// Background push cycle — runs from the Worker cron trigger. Fetches the Metra
// realtime feeds once, diffs each subscribed line against stored state in KV,
// and sends a push for newly cancelled trains, big new delays, and new alerts.

import { fetchFeed, indexTripUpdates, alertsForRoute } from "./realtime.js";
import { sendPush } from "./push.js";

const DELAY_THRESHOLD_MIN = 5;

export async function runPushCycle(env) {
  if (!env.VAPID_PRIVATE_JWK || !env.VAPID_PUBLIC) return { skipped: "no VAPID config" };

  const list = await env.GTFS.list({ prefix: "sub:" });
  if (!list.keys.length) return { subs: 0 };

  const subs = [];
  for (const k of list.keys) {
    const rec = await env.GTFS.get(k.name, "json");
    if (rec && rec.subscription) subs.push({ key: k.name, ...rec });
  }
  const wantedLines = new Set();
  for (const s of subs) for (const l of s.lines || []) wantedLines.add(l);
  if (!wantedLines.size) return { subs: subs.length, lines: 0 };

  let tuIndex, alertFeed;
  try {
    const [tuFeed, aFeed] = await Promise.all([fetchFeed(env, "tripupdates"), fetchFeed(env, "alerts")]);
    tuIndex = indexTripUpdates(tuFeed);
    alertFeed = aFeed;
  } catch (e) { return { error: e.message }; }

  const linesMeta = (await env.GTFS.get("lines", "json")) || [];
  const nameOf = id => (linesMeta.find(l => l.id === id) || {}).name || id;
  const gone = new Set();

  for (const line of wantedLines) {
    // Snapshot the current state of every trip on this line.
    const trips = {};
    for (const [tripId, rec] of tuIndex) {
      if ((rec.routeId || guessLine(tripId, wantedLines)) !== line) continue;
      let maxDelay = rec.tripDelay || 0;
      for (const s of rec.stus) { const d = s.depDelay ?? s.arrDelay; if (d != null && d > maxDelay) maxDelay = d; }
      trips[tripId] = { d: Math.round(maxDelay / 60), c: !!rec.cancelled };
    }
    const alerts = alertsForRoute(alertFeed, line);
    const alertIds = alerts.map(a => a.id);

    const prior = await env.GTFS.get(`pushstate:${line}`, "json");
    // Seed silently the first time we see a line, so users aren't hit with a
    // burst of "new" events for delays that were already in effect.
    if (!prior) {
      await env.GTFS.put(`pushstate:${line}`, JSON.stringify({ trips, alerts: alertIds }));
      continue;
    }

    const events = [];
    for (const [tripId, cur] of Object.entries(trips)) {
      const prev = prior.trips[tripId] || { d: 0, c: false };
      if (cur.c && !prev.c) events.push(`Train ${trainNo(tripId)} cancelled`);
      else if (cur.d >= DELAY_THRESHOLD_MIN && prev.d < DELAY_THRESHOLD_MIN) events.push(`Train ${trainNo(tripId)} delayed ${cur.d} min`);
    }
    for (const a of alerts) if (!prior.alerts.includes(a.id)) events.push(a.header || "Service alert");

    if (events.length) {
      const payload = {
        title: `${nameOf(line)} — service update`,
        body: events[0] + (events.length > 1 ? ` (+${events.length - 1} more)` : ""),
        tag: `line:${line}`, url: "./",
      };
      for (const s of subs) {
        if (!(s.lines || []).includes(line)) continue;
        try {
          const status = await sendPush(env, s.subscription, payload);
          if (status === 404 || status === 410) gone.add(s.key);
        } catch { /* ignore individual send failures */ }
      }
    }
    await env.GTFS.put(`pushstate:${line}`, JSON.stringify({ trips, alerts: alertIds }));
  }

  for (const key of gone) await env.GTFS.delete(key);
  return { subs: subs.length, lines: wantedLines.size, cleaned: gone.size };
}

function guessLine(tripId, lines) {
  for (const l of lines) if (tripId.startsWith(l)) return l;
  return null;
}
function trainNo(tripId) { const m = String(tripId).match(/\d{2,5}/); return m ? m[0] : tripId; }

// Background push cycle — runs from the Worker cron trigger. Fetches the Metra
// realtime feeds once, then: (a) diffs each subscribed line for new delays/alerts,
// (b) fires per-user departure reminders (delay-aware), and (c) morning briefings.

import { fetchFeed, indexTripUpdates, alertsForRoute, delayAt } from "./realtime.js";
import { chicagoParts, activeServices, secToClock } from "./static.js";
import { sendPush } from "./push.js";

const DELAY_THRESHOLD_MIN = 5;
const FIRE_WINDOW_SEC = 30 * 60; // fire at the first cron tick within 30 min of the target

export async function runPushCycle(env) {
  if (!env.VAPID_PRIVATE_JWK || !env.VAPID_PUBLIC) return { skipped: "no VAPID config" };

  const list = await env.GTFS.list({ prefix: "sub:" });
  if (!list.keys.length) return { subs: 0 };

  const subs = [];
  for (const k of list.keys) {
    const rec = await env.GTFS.get(k.name, "json");
    if (rec && rec.subscription) subs.push({ key: k.name, ...rec });
  }
  if (!subs.length) return { subs: 0 };

  let tuIndex, alertFeed;
  try {
    const [tuFeed, aFeed] = await Promise.all([fetchFeed(env, "tripupdates"), fetchFeed(env, "alerts")]);
    tuIndex = indexTripUpdates(tuFeed);
    alertFeed = aFeed;
  } catch (e) { return { error: e.message }; }

  const linesMeta = (await env.GTFS.get("lines", "json")) || [];
  const nameOf = id => (linesMeta.find(l => l.id === id) || {}).name || id;
  const gone = new Set();
  const cache = { sched: new Map(), cal: null };

  // ---- (a) line-level delay/alert pushes ----
  const wantedLines = new Set();
  for (const s of subs) for (const l of s.lines || []) wantedLines.add(l);
  for (const line of wantedLines) {
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
    if (!prior) { await env.GTFS.put(`pushstate:${line}`, JSON.stringify({ trips, alerts: alertIds })); continue; }

    const events = [];
    for (const [tripId, cur] of Object.entries(trips)) {
      const prev = prior.trips[tripId] || { d: 0, c: false };
      if (cur.c && !prev.c) events.push(`Train ${shortNo(tripId)} cancelled`);
      else if (cur.d >= DELAY_THRESHOLD_MIN && prev.d < DELAY_THRESHOLD_MIN) events.push(`Train ${shortNo(tripId)} delayed ${cur.d} min`);
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
        try { if ([404, 410].includes(await sendPush(env, s.subscription, payload))) gone.add(s.key); } catch { /* ignore */ }
      }
    }
    await env.GTFS.put(`pushstate:${line}`, JSON.stringify({ trips, alerts: alertIds }));
  }

  // ---- (b) reminders + (c) briefings, per subscriber ----
  const now = chicagoParts();
  for (const s of subs) {
    let changed = false;
    for (const rem of s.reminders || []) {
      if (!dueReminder(rem, now)) continue;
      const msg = await buildReminderMsg(env, cache, tuIndex, now, rem);
      if (msg) { try { if ([404, 410].includes(await sendPush(env, s.subscription, msg))) gone.add(s.key); } catch { /* ignore */ } }
      rem.lastFired = now.dateStr; changed = true;
    }
    if (s.briefing && s.briefing.enabled && dueBriefing(s.briefing, now)) {
      const msg = await buildBriefingMsg(env, cache, tuIndex, alertFeed, now, s.briefing);
      if (msg) { try { if ([404, 410].includes(await sendPush(env, s.subscription, msg))) gone.add(s.key); } catch { /* ignore */ } }
      s.briefing.lastFired = now.dateStr; changed = true;
    }
    if (changed && !gone.has(s.key)) {
      await env.GTFS.put(s.key, JSON.stringify({
        subscription: s.subscription, lines: s.lines, reminders: s.reminders, briefing: s.briefing, updatedAt: Date.now(),
      }));
    }
  }

  for (const key of gone) await env.GTFS.delete(key);
  return { subs: subs.length, lines: wantedLines.size, cleaned: gone.size };
}

// ---- reminder / briefing helpers ----

function dueReminder(rem, now) {
  if (!rem.days || !rem.days.includes(now.weekday)) return false;
  if (rem.lastFired === now.dateStr) return false;
  const target = rem.depSec - (rem.lead || 10) * 60;
  return now.nowSec >= target && now.nowSec - target < FIRE_WINDOW_SEC;
}
function dueBriefing(br, now) {
  if (!br.days || !br.days.includes(now.weekday)) return false;
  if (br.lastFired === now.dateStr) return false;
  return now.nowSec >= br.timeSec && now.nowSec - br.timeSec < FIRE_WINDOW_SEC;
}

async function loadSched(env, cache, line) {
  if (!cache.sched.has(line)) cache.sched.set(line, await env.GTFS.get(`sched:${line}`, "json"));
  return cache.sched.get(line);
}
async function loadCal(env, cache) {
  if (!cache.cal) cache.cal = await env.GTFS.get("cal", "json");
  return cache.cal;
}
// Find today's trip on `line` that departs `from` at `depSec` and reaches `to`.
function findTrip(sched, services, from, to, depSec) {
  for (const t of sched.trips || []) {
    if (!services.has(t.svc)) continue;
    let a = -1, b = -1;
    for (let i = 0; i < t.st.length; i++) { if (t.st[i][0] === from && a === -1) a = i; if (t.st[i][0] === to) b = i; }
    if (a === -1 || b === -1 || a >= b) continue;
    if (depSec == null || t.st[a][2] === depSec) return t;
  }
  return null;
}

async function buildReminderMsg(env, cache, tuIndex, now, rem) {
  const sched = await loadSched(env, cache, rem.line);
  const cal = await loadCal(env, cache);
  if (!sched || !cal) return null;
  const services = activeServices(cal, now.dateStr, now.weekday);
  const trip = findTrip(sched, services, rem.from, rem.to, rem.depSec);

  let statusLine = "";
  if (trip) {
    const rec = tuIndex.get(trip.id);
    if (rec && rec.cancelled) {
      return { title: `Train ${rem.trainNo} cancelled`, body: `Your ${rem.depLabel} ${rem.fromName} → ${rem.toName} is cancelled.`, tag: `rem:${rem.id}:${now.dateStr}`, url: "./" };
    }
    if (rec) {
      // scheduled dep as an epoch (now + seconds-of-day offset) so delayAt can use
      // Metra's absolute predicted time when there's no explicit `delay` field.
      const schedDep = Math.round(Date.now() / 1000) + (rem.depSec - now.nowSec);
      const d = delayAt(rec, rem.from, schedDep);
      const min = d != null ? Math.round(d / 60) : 0;
      statusLine = min > 0 ? ` Running ${min} min late.` : " On time.";
    }
  }
  return {
    title: `${rem.depLabel} to ${rem.toName}`,
    body: `Train ${rem.trainNo} from ${rem.fromName} leaves in ~${rem.lead || 10} min.${statusLine}`,
    tag: `rem:${rem.id}:${now.dateStr}`, url: "./",
  };
}

async function buildBriefingMsg(env, cache, tuIndex, alertFeed, now, br) {
  const sched = await loadSched(env, cache, br.line);
  const cal = await loadCal(env, cache);
  if (!sched || !cal) return null;
  const services = activeServices(cal, now.dateStr, now.weekday);

  let best = null;
  for (const t of sched.trips || []) {
    if (!services.has(t.svc)) continue;
    let a = -1, b = -1;
    for (let i = 0; i < t.st.length; i++) { if (t.st[i][0] === br.from && a === -1) a = i; if (t.st[i][0] === br.to) b = i; }
    if (a === -1 || b === -1 || a >= b) continue;
    const dep = t.st[a][2];
    if (dep >= now.nowSec && (!best || dep < best.dep)) best = { dep, trip: t };
  }
  const alerts = alertsForRoute(alertFeed, br.line);
  const alertNote = alerts.length ? ` ${alerts.length} service alert${alerts.length > 1 ? "s" : ""}.` : " No alerts.";

  if (!best) return { title: `Good morning`, body: `No more ${br.line} trains ${br.fromName} → ${br.toName} today.${alertNote}`, tag: `brief:${now.dateStr}`, url: "./" };

  let statusNote = "";
  const rec = tuIndex.get(best.trip.id);
  if (rec && rec.cancelled) statusNote = " (cancelled)";
  else if (rec) { const schedDep = Math.round(Date.now() / 1000) + (best.dep - now.nowSec); const d = delayAt(rec, br.from, schedDep); const min = d != null ? Math.round(d / 60) : 0; statusNote = min > 0 ? ` (+${min} min)` : " (on time)"; }

  return {
    title: `Good morning — next ${br.line}`,
    body: `${secToClock(best.dep)} Train ${shortNo(best.trip.no)}${statusNote} to ${br.toName}.${alertNote}`,
    tag: `brief:${now.dateStr}`, url: "./",
  };
}

function guessLine(tripId, lines) { for (const l of lines) if (tripId.startsWith(l)) return l; return null; }
function shortNo(no) { const m = String(no).match(/\d{2,5}/); return m ? m[0] : String(no); }

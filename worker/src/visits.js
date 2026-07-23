// Global visitor counter backed by Workers KV.
//
// Deliberately lightweight: the frontend pings /api/visit at most once per browser
// per Chicago day (a localStorage guard), so the number reads as "unique visitors
// that day" rather than raw page views, and writes stay far inside the KV free tier.
//
// KV has no atomic increment, so we read-modify-write. Because each browser writes
// at most once/day the contended window is tiny; a rare simultaneous first-visit
// could undercount by one, which is perfectly fine for a fun counter (it isn't
// billing). Keys live in the same GTFS namespace under a `visit:` prefix so they
// never collide with schedule/subscription data.

import { chicagoParts, shiftDate } from "./static.js";

const DAY_PREFIX = "visit:day:";   // visit:day:YYYYMMDD -> "N"
const TOTAL_KEY = "visit:total";   // "N" cumulative all-time

const n = v => { const x = parseInt(v, 10); return Number.isFinite(x) ? x : 0; };

// Count one visit for today (America/Chicago) and return fresh stats.
export async function registerVisit(env, days = 7) {
  const { dateStr } = chicagoParts();
  const dayKey = DAY_PREFIX + dateStr;
  const [dayRaw, totalRaw] = await Promise.all([env.GTFS.get(dayKey), env.GTFS.get(TOTAL_KEY)]);
  const today = n(dayRaw) + 1;
  const total = n(totalRaw) + 1;
  await Promise.all([
    env.GTFS.put(dayKey, String(today)),
    env.GTFS.put(TOTAL_KEY, String(total)),
  ]);
  return buildStats(env, days, { today, total });
}

// Read-only stats: today, all-time total, and the last `days` day counts (oldest first).
export async function getVisitStats(env, days = 7) {
  return buildStats(env, days, null);
}

async function buildStats(env, days, known) {
  const { dateStr } = chicagoParts();
  // Last `days` Chicago date strings, oldest first, ending with today.
  const dateList = [];
  let d = dateStr;
  for (let i = 0; i < days; i++) { dateList.unshift(d); d = shiftDate(d, -1).dateStr; }

  const [counts, totalRaw] = await Promise.all([
    Promise.all(dateList.map(ds => env.GTFS.get(DAY_PREFIX + ds))),
    env.GTFS.get(TOTAL_KEY),
  ]);
  const series = dateList.map((ds, i) => ({ date: ds, count: n(counts[i]) }));
  // On the write path, KV read-after-write is eventually consistent, so trust the
  // just-incremented values instead of the possibly-stale re-read for today.
  if (known) series[series.length - 1] = { date: dateStr, count: known.today };

  return {
    today: known ? known.today : series[series.length - 1].count,
    total: known ? known.total : n(totalRaw),
    days: series,
    updatedAt: new Date().toISOString(),
  };
}

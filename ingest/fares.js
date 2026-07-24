// Metra fare table builder (used by ingest.js; unit-tested standalone).
//
// The GTFS feed only carries the one-way full fare (fare_attributes + fare_rules,
// keyed on each stop's zone_id). Day Pass and Monthly Pass are NOT in the feed, so
// we pair them here to the one-way price that shares the same Metra fare column.
// Full-fare (adult), current as of 2026-07 (source: metra.com fare chart). The
// one-way prices come from the feed and update automatically on each ingest; if
// Metra's base one-way changes (e.g. the proposed 2026 increase), update the paired
// Day/Monthly values below to match.
export const PASS_BY_ONEWAY = {
  "3.75": { day: 7.50, monthly: 75.00 },   // Zone 1-2 column (and all 2-3-4 trips)
  "5.50": { day: 11.00, monthly: 110.00 }, // Zone 1-3 column
  "6.75": { day: 13.50, monthly: 135.00 }, // Zone 1-4 column
};
export const FARES_AS_OF = "2026-07";
export const FARES_SOURCE = "https://metra.com/fares";

// Build { asOf, source, currency, byPair } from GTFS fare_attributes + fare_rules.
// `byPair` maps a sorted "zoneA-zoneB" key → { oneWay, day, monthly } (day/monthly
// null when no supplement matches). Returns null if the feed carries no fare data.
export function buildFares(fareAttributes, fareRules) {
  const price = new Map(); // fare_id -> one-way price
  for (const f of fareAttributes || []) {
    const id = String(f.fare_id ?? "").trim();
    const p = Number(f.price);
    if (id && Number.isFinite(p)) price.set(id, p);
  }
  const byPair = {};
  for (const r of fareRules || []) {
    const o = String(r.origin_id ?? "").trim();
    const d = String(r.destination_id ?? "").trim();
    if (!o || !d) continue; // fare_rules without zone origin/destination aren't per-trip priceable
    const oneWay = price.get(String(r.fare_id ?? "").trim());
    if (oneWay == null) continue;
    const pass = PASS_BY_ONEWAY[oneWay.toFixed(2)] || null;
    const key = pairKey(o, d);
    byPair[key] = { oneWay, day: pass ? pass.day : null, monthly: pass ? pass.monthly : null };
  }
  return Object.keys(byPair).length
    ? { asOf: FARES_AS_OF, source: FARES_SOURCE, currency: "USD", byPair }
    : null;
}

// Canonical unordered zone-pair key. Build and lookup must use the same rule; a
// plain string compare is fine as long as it's consistent on both sides.
export function pairKey(a, b) {
  const x = String(a), y = String(b);
  return x <= y ? `${x}-${y}` : `${y}-${x}`;
}

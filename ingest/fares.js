// Metra fare table builder (used by ingest.js; unit-tested standalone).
//
// The GTFS feed only carries the one-way full fare (fare_attributes + fare_rules,
// keyed on each stop's zone_id). Everything else here — Day Pass, Monthly, and the
// flat weekend passes — is NOT in the feed and is maintained by hand below.
// Full-fare (adult), current as of 2026-07 (source: metra.com fare chart).
//
// Passes are keyed by *zone column*, NOT by the one-way price, so a one-way fare
// change in the feed can never silently orphan them. `expectOneWay` lets the ingest
// warn loudly when the feed's one-way for a column drifts from what these pass
// prices assume — a strong signal that Metra changed fares and the Day/Monthly (and
// probably the weekend) values below need updating. Update values (not keys) on a
// price change; update keys only if Metra adds/removes a fare zone.
export const PASS_BY_COLUMN = {
  "1-2": { expectOneWay: 3.75, day: 7.50,  monthly: 75.00 },  // zone 1-2 + every 2-3-4 suburb trip
  "1-3": { expectOneWay: 5.50, day: 11.00, monthly: 110.00 },
  "1-4": { expectOneWay: 6.75, day: 13.50, monthly: 135.00 },
};

// Flat, systemwide passes (any zone, any line) — also not in the GTFS feed.
export const WEEKEND_PASSES = {
  weekendDay: 7.00, // Saturday, Sunday, or Holiday Day Pass — unlimited systemwide that day
  weekend: 10.00,   // Weekend Pass (Ventra app) — unlimited systemwide Sat + Sun
};

export const FARES_AS_OF = "2026-07";
export const FARES_SOURCE = "https://metra.com/fares";

// Which Metra fare column a zone pair falls in. Trips touching downtown (zone 1)
// are priced by the farthest zone (1-3, 1-4); everything else uses the base column
// "1-2" (which also covers all 2-3-4 non-downtown trips). Robust to a one-way price
// change; an unknown far zone (e.g. a new "1-5") returns a key with no PASS_BY_COLUMN
// entry, which surfaces as a loud warning + graceful "unavailable" rather than a
// silent wrong price.
export function columnFor(zoneA, zoneB) {
  const a = String(zoneA), b = String(zoneB);
  const lo = a <= b ? a : b, hi = a <= b ? b : a;
  return lo === "1" && hi !== "1" && hi !== "2" ? `1-${hi}` : "1-2";
}

// Build { asOf, source, currency, byPair, flat } from GTFS fare_attributes +
// fare_rules. `byPair` maps a sorted "zoneA-zoneB" key → { oneWay, day, monthly }
// (day/monthly null when a column has no pass mapping). `flat` holds the systemwide
// weekend passes. `warn` is injectable for tests. Returns null if no fare data.
export function buildFares(fareAttributes, fareRules, warn = console.warn) {
  const price = new Map(); // fare_id -> one-way price
  for (const f of fareAttributes || []) {
    const id = String(f.fare_id ?? "").trim();
    const p = Number(f.price);
    if (id && Number.isFinite(p)) price.set(id, p);
  }
  const byPair = {};
  const missing = new Set(), drift = new Map();
  for (const r of fareRules || []) {
    const o = String(r.origin_id ?? "").trim();
    const d = String(r.destination_id ?? "").trim();
    if (!o || !d) continue; // fare_rules without zone origin/destination aren't per-trip priceable
    const oneWay = price.get(String(r.fare_id ?? "").trim());
    if (oneWay == null) continue;
    const col = columnFor(o, d);
    const pass = PASS_BY_COLUMN[col] || null;
    if (!pass) missing.add(col);
    else if (Math.abs(pass.expectOneWay - oneWay) > 0.001) drift.set(col, oneWay);
    byPair[pairKey(o, d)] = { oneWay, day: pass ? pass.day : null, monthly: pass ? pass.monthly : null };
  }
  for (const col of missing) {
    warn(`[fares] No Day/Monthly prices for zone column "${col}" — add it to PASS_BY_COLUMN in ingest/fares.js. Those passes will show as unavailable until you do.`);
  }
  for (const [col, oneWay] of drift) {
    warn(`[fares] One-way for column "${col}" is now $${oneWay.toFixed(2)} (pass table assumes $${PASS_BY_COLUMN[col].expectOneWay.toFixed(2)}). Day/Monthly (and likely the weekend passes) may be STALE — update PASS_BY_COLUMN + WEEKEND_PASSES in ingest/fares.js.`);
  }
  return Object.keys(byPair).length
    ? { asOf: FARES_AS_OF, source: FARES_SOURCE, currency: "USD", byPair, flat: { ...WEEKEND_PASSES } }
    : null;
}

// Canonical unordered zone-pair key. Build and lookup must use the same rule; a
// plain string compare is fine as long as it's consistent on both sides.
export function pairKey(a, b) {
  const x = String(a), y = String(b);
  return x <= y ? `${x}-${y}` : `${y}-${x}`;
}

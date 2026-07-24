// Build per-route track polylines from GTFS shapes.txt so the map can draw each
// line along its real geography (curves) instead of straight hops between stops.
//
// Metra ships one shape per physical path per direction, id'd `{ROUTE}_{IB|OB}_{N}`
// (IB/OB are reverses of the same track; a distinct N is a real branch — UP-NW _1
// Harvard vs _2 McHenry, ME _1/_2/_3, RI _1/_2). We collapse each inbound/outbound
// pair, keep distinct branches, and simplify each polyline (Douglas-Peucker) so the
// payload stays small. Output: { routeId: [ [[lat,lon],...], ... ] }.

// Perpendicular distance from p to segment a-b in lat/lon space (local, good enough).
function perpDist(p, a, b) {
  const ax = a[1], ay = a[0], bx = b[1], by = b[0], pxp = p[1], pyp = p[0];
  const dx = bx - ax, dy = by - ay, len2 = dx * dx + dy * dy;
  if (!len2) return Math.hypot(pxp - ax, pyp - ay);
  let t = ((pxp - ax) * dx + (pyp - ay) * dy) / len2;
  t = t < 0 ? 0 : t > 1 ? 1 : t;
  return Math.hypot(pxp - (ax + t * dx), pyp - (ay + t * dy));
}

// Ramer–Douglas–Peucker simplification (iterative, so deep shapes don't blow the stack).
export function rdp(points, eps) {
  if (points.length < 3) return points.slice();
  const keep = new Array(points.length).fill(false);
  keep[0] = keep[points.length - 1] = true;
  const stack = [[0, points.length - 1]];
  while (stack.length) {
    const [lo, hi] = stack.pop();
    let maxD = 0, idx = -1;
    for (let i = lo + 1; i < hi; i++) {
      const d = perpDist(points[i], points[lo], points[hi]);
      if (d > maxD) { maxD = d; idx = i; }
    }
    if (idx !== -1 && maxD > eps) { keep[idx] = true; stack.push([lo, idx], [idx, hi]); }
  }
  return points.filter((_, i) => keep[i]);
}

// Strip a direction indicator so an inbound/outbound pair collapses to one path.
// Unknown patterns keep their full id (→ no false merge; at worst a duplicate draw,
// which is harmless: subpaths share one <path> element, so overlaps don't stack).
export function dedupKey(shapeId) {
  return String(shapeId).replace(/_(IB|OB|NB|SB|EB|WB)(?=_|$)/i, "");
}

// eps ≈ 9m: keeps gentle rail curves visible (they'd flatten to near-straight at a
// coarser tolerance) while all 11 lines still total ~18 KB.
export function buildRouteShapes(shapesRows, tripsRows, { eps = 0.00008, round = 5 } = {}) {
  // shape_id -> ordered [[lat,lon],...]
  const poly = new Map();
  for (const r of shapesRows || []) {
    const id = r.shape_id;
    const lat = Number(r.shape_pt_lat), lon = Number(r.shape_pt_lon);
    if (!id || !Number.isFinite(lat) || !Number.isFinite(lon)) continue;
    if (!poly.has(id)) poly.set(id, []);
    poly.get(id).push([Number(r.shape_pt_sequence), lat, lon]);
  }
  for (const a of poly.values()) a.sort((x, y) => x[0] - y[0]);

  // route -> set of shape_ids it uses
  const byRoute = new Map();
  for (const t of tripsRows || []) {
    if (!t.shape_id || !poly.has(t.shape_id)) continue;
    if (!byRoute.has(t.route_id)) byRoute.set(t.route_id, new Set());
    byRoute.get(t.route_id).add(t.shape_id);
  }

  const q = 10 ** round, rnd = n => Math.round(n * q) / q;
  const out = {};
  for (const [route, ids] of byRoute) {
    // collapse IB/OB pairs → keep the longest polyline per direction-agnostic key
    const best = new Map();
    for (const id of ids) {
      const key = dedupKey(id);
      const cur = best.get(key);
      if (!cur || poly.get(id).length > poly.get(cur).length) best.set(key, id);
    }
    const polylines = [...best.values()]
      .map(id => rdp(poly.get(id).map(p => [p[1], p[2]]), eps).map(([la, lo]) => [rnd(la), rnd(lo)]))
      .filter(p => p.length > 1);
    if (polylines.length) out[route] = polylines;
  }
  return out;
}

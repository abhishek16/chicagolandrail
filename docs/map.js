// Living Map engine — a dependency-free SVG map of the Metra system, drawn from
// the real GTFS station geometry we already serve. No tile servers, no map
// libraries: one hand-styled vector we fully control (and can cache offline).
//
// createMap(host, { lines, stopsByLine, onLine, onStation }) → controller
//   controller.focus(lineId)        dim the system, light up one line, stations tappable
//   controller.unfocus()            back to the whole system
//   controller.select(lineId, {from, to})   draw board / destination markers
//   controller.setTrains(lineId, list)      live dots: [{ frac }] or [{ lat, lon }]
//   controller.element              the <svg> node
//
// Callbacks: onLine(lineId) when a line is tapped; onStation(lineId, stationId)
// when a station on the focused line is tapped.

const SVGNS = "http://www.w3.org/2000/svg";
const el = (name, attrs = {}) => {
  const n = document.createElementNS(SVGNS, name);
  for (const k in attrs) n.setAttribute(k, attrs[k]);
  return n;
};
const esc = s => String(s).replace(/[&<>"]/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
const r1 = n => Math.round(n * 10) / 10;

// Low-luminance official colors (Heritage maroon, deep blues) get lifted so they
// read against the dark water without losing their identity.
export function lift(hex) {
  const n = parseInt(String(hex).replace("#", ""), 16);
  const r = (n >> 16 & 255) / 255, g = (n >> 8 & 255) / 255, b = (n & 255) / 255;
  const lum = 0.2126 * r + 0.7152 * g + 0.0722 * b;
  if (lum >= 0.16) return hex;
  const f = Math.sqrt(0.16 / Math.max(lum, 0.01));
  const up = v => Math.min(255, Math.round(v * 255 * f));
  return "#" + [up(r), up(g), up(b)].map(v => v.toString(16).padStart(2, "0")).join("");
}

// Hand-approximated Lake Michigan shoreline (lat,lon), same projection as the lines.
const SHORE = [
  [42.75, -87.79], [42.55, -87.80], [42.40, -87.815], [42.25, -87.80],
  [42.12, -87.73], [42.00, -87.66], [41.955, -87.635], [41.89, -87.607],
  [41.85, -87.605], [41.78, -87.575], [41.73, -87.53], [41.66, -87.44],
  [41.60, -87.25], [41.55, -86.90],
];

export function createMap(host, { lines, stopsByLine, segmentsByLine = {}, onLine, onStation, onHover }) {
  const geo = {};
  for (const l of lines) geo[l.id] = (stopsByLine[l.id] || []).filter(s => s.lat != null && s.lon != null);
  const all = Object.values(geo).flat();
  if (!all.length) throw new Error("map: no station geometry");

  // ---- projection: equirectangular, x compressed by cos(latitude) ----
  const lats = all.map(s => s.lat), lons = all.map(s => s.lon);
  const minLat = Math.min(...lats), maxLat = Math.max(...lats);
  const minLon = Math.min(...lons), maxLon = Math.max(...lons);
  const kx = Math.cos((minLat + maxLat) / 2 * Math.PI / 180);
  const PAD = 46;
  const W = 1000;
  const spanX = (maxLon - minLon) * kx || 1, spanY = (maxLat - minLat) || 1;
  const s = (W - 2 * PAD) / spanX;              // fit width; height follows to avoid distortion
  const H = Math.round(spanY * s + 2 * PAD);
  const px = lon => PAD + (lon - minLon) * kx * s;
  const py = lat => PAD + (maxLat - lat) * s;
  const pt = st => [px(st.lon), py(st.lat)];

  // downtown hub: Chicago Union Station if present, else the most-shared endpoint
  const cus = all.find(s => /union/i.test(s.name)) || all[0];
  const [hx, hy] = pt(cus).map(r1);
  const d2hub = st => { const [x, y] = pt(st); return (x - hx) ** 2 + (y - hy) ** 2; };

  const svg = el("svg", { viewBox: `0 0 ${W} ${H}`, class: "lmap", role: "img", "aria-label": "Metra system map" });
  // Everything lives inside a camera group we can pan/scale (CSS-transitioned) to
  // zoom into a hovered/focused line so its station names become readable.
  const cam = el("g", { class: "lmap-cam" });
  svg.appendChild(cam);

  // ---- water ----
  // A uniform subtle-blue fill (no bounding-box gradient — that faded to near-bg
  // toward the east and looked half-empty when zoomed). The polygon runs far past
  // the frame in every direction so the whole area east of the shoreline stays
  // water at any zoom/pan; a non-scaling stroke keeps the coastline crisp.
  const FAR = 6000;
  const lake = "M " + SHORE.map(([la, lo]) => `${r1(px(lo))},${r1(py(la))}`).join(" L ")
    + ` L ${W + FAR},${H + FAR} L ${W + FAR},${-FAR} L ${r1(px(-87.79))},${-FAR} Z`;
  cam.appendChild(el("path", { class: "lmap-lake", d: lake, "vector-effect": "non-scaling-stroke" }));

  // ---- one <g> per line ----
  const groups = {};
  const lineInfo = {}; // id -> { name, from, to, color } for the hover caption
  let hoveredId = null; // last line the pointer was over (for tolerant tap-to-select)
  for (const l of lines) {
    const sts = geo[l.id];
    if (sts.length < 2) continue;
    const c = lift(l.color);
    // Draw the real track topology from branch segments (edges) when available, so a
    // Y-line draws both spurs; fall back to a single polyline through the stops.
    const coord = {}; for (const s of sts) coord[s.id] = pt(s).map(r1).join(",");
    const segs = (segmentsByLine[l.id] || []).filter(([a, b]) => coord[a] && coord[b]);
    const path = segs.length
      ? segs.map(([a, b]) => `M ${coord[a]} L ${coord[b]}`).join(" ")
      : "M " + sts.map(st => pt(st).map(r1).join(",")).join(" L ");
    const g = el("g", { class: "lmap-line", "data-id": l.id });
    g.style.setProperty("--c", c);
    // non-scaling-stroke keeps line/dot widths crisp (constant screen px) when zoomed
    g.appendChild(el("path", { class: "lmap-hit", d: path, "vector-effect": "non-scaling-stroke" }));
    g.appendChild(el("path", { class: "lmap-glow", d: path, "vector-effect": "non-scaling-stroke" }));
    g.appendChild(el("path", { class: "lmap-core", d: path, "vector-effect": "non-scaling-stroke" }));

    const stnEls = {};
    for (const st of sts) {
      const [x, y] = pt(st).map(r1);
      const dot = el("circle", { class: "lmap-stn", cx: x, cy: y, r: 2.1, "data-id": st.id, "vector-effect": "non-scaling-stroke" });
      g.appendChild(dot);
      const left = x > hx;
      const lbl = el("text", {
        class: "lmap-lbl", x: r1(x + (left ? -7 : 7)), y: r1(y + 3),
        "text-anchor": left ? "end" : "start", "data-id": st.id,
      });
      lbl.textContent = st.name;
      g.appendChild(lbl);
      stnEls[st.id] = { dot, lbl, x, y };
      // Select this station from the dot OR its name label (both, focused view only).
      // pointerup + click for the same robustness as line taps; a duplicate is a no-op
      // (the app's step guard ignores it). CSS makes the label clickable when focused.
      const pickStation = e => {
        if (!g.classList.contains("on")) return;      // only tappable while focused
        e.stopPropagation();
        onStation && onStation(l.id, st.id);
      };
      for (const node of [dot, lbl]) {
        node.addEventListener("pointerup", pickStation);
        node.addEventListener("click", pickStation);
      }
    }
    // terminal label (farthest from downtown) always visible on the system view;
    // `near` is the downtown end — both feed the hover caption's route.
    const ends = [sts[0], sts.at(-1)].sort((a, b) => d2hub(b) - d2hub(a));
    const far = ends[0], near = ends[1] || ends[0];
    lineInfo[l.id] = { name: l.name || l.id, from: far.name, to: near.name, color: c };
    const [tx, ty] = pt(far).map(r1);
    const tLeft = tx > hx;
    const term = el("text", { class: "lmap-term", x: r1(tx + (tLeft ? -9 : 9)), y: r1(ty + 3.5), "text-anchor": tLeft ? "end" : "start" });
    term.textContent = far.name;
    g.appendChild(term);

    const hit = g.querySelector(".lmap-hit");
    // Desktop hover just HIGHLIGHTS the line — it never moves the camera. (Zooming
    // on hover pans the map under a stationary cursor, which lands the cursor on a
    // different line and re-triggers → the jumping. The glide happens on tap/focus.)
    // hover also tells the app which line it is, so it can highlight the matching
    // card in the list below (a clear two-way link between map and picker).
    hit.addEventListener("mouseenter", () => { if (!svg.classList.contains("focus")) { hoveredId = l.id; ctrl.hover(l.id); onHover && onHover(l.id); } });
    hit.addEventListener("mouseleave", () => { if (!svg.classList.contains("focus")) { hoveredId = null; ctrl.hover(null); onHover && onHover(null); } });
    // SELECT on a direct tap of the hit path — the SAME element that reliably receives
    // the hover above — using the closure's l.id (never depends on bubbling to the svg,
    // Element.closest(), or hoveredId). Bind BOTH pointerup and click: a click is
    // canceled by the browser if the DOM under the pointer changes between down and up,
    // but pointerup still lands; whichever fires first flips the map to focus, and the
    // focus guard makes the other a no-op, so we never double-select.
    const pick = e => { if (!svg.classList.contains("focus")) { e.stopPropagation(); onLine && onLine(l.id); } };
    hit.addEventListener("pointerup", pick);
    hit.addEventListener("click", pick);
    cam.appendChild(g);
    groups[l.id] = { g, stnEls };
  }

  // ---- live-train layer (populated in the live view) ----
  const trainLayer = el("g", { class: "lmap-trains" });
  cam.appendChild(trainLayer);

  // ---- downtown hub marker ----
  cam.appendChild(el("circle", { class: "lmap-hub", cx: hx, cy: hy, r: 5.2 }));
  const hubLbl = el("text", { class: "lmap-hub-lbl", x: hx + 11, y: hy + 4 });
  hubLbl.textContent = "CHICAGO";
  cam.appendChild(hubLbl);

  host.innerHTML = "";
  host.appendChild(svg);

  // Keep label text a constant SCREEN size on any device: --px = viewBox units per
  // rendered CSS pixel. Labels are sized in viewBox units, so without this a wide
  // desktop map renders them tiny; with it they're the same px everywhere.
  function measure() {
    const w = svg.getBoundingClientRect().width;
    if (w > 0) svg.style.setProperty("--px", (W / w).toFixed(3));
  }
  if (typeof ResizeObserver !== "undefined") new ResizeObserver(measure).observe(svg);
  else if (typeof window !== "undefined" && window.addEventListener) window.addEventListener("resize", measure);
  if (typeof requestAnimationFrame !== "undefined") requestAnimationFrame(measure); else measure();

  // Click handling. On the focused view a stray water tap releases focus only where
  // that makes sense (off during onboarding, so it can't desync from the wizard).
  // On the SYSTEM view, a click selects a line — resolved from the click target's
  // group, falling back to the last-hovered line, so taps just off the thin hit
  // path still land (fixes "clicking the line does nothing").
  svg.addEventListener("click", e => {
    if (svg.classList.contains("focus")) { if (ctrl.releaseOnWater) ctrl.unfocus(); return; }
    const grp = e.target && e.target.closest ? e.target.closest(".lmap-line") : null;
    const id = (grp && grp.getAttribute("data-id")) || hoveredId;
    if (id) onLine && onLine(id);
  });

  // Bring a line (and the train/hub layers) to the top of the camera so it draws
  // above the dimmed system.
  function raiseLine(lineId) {
    const fg = groups[lineId] && groups[lineId].g;
    if (fg) cam.appendChild(fg);
    cam.appendChild(trainLayer);
    cam.appendChild(cam.querySelector(".lmap-hub"));
    cam.appendChild(hubLbl);
  }

  // Hide station labels that would overlap once zoomed, so the ones shown stay
  // readable (greedy: keep picked ends + terminals first, then along the line).
  // Positions are computed from each label's own bbox × the final camera transform,
  // so it's correct immediately (independent of the in-flight glide).
  function cullLabels(lineId, s, tx, ty) {
    const grp = groups[lineId]; if (!grp) return;
    const els = grp.stnEls, ids = Object.keys(els);
    for (const id of ids) els[id].lbl.classList.remove("culled");
    const picks = [...svg.querySelectorAll(".lmap-stn.from,.lmap-stn.to")].map(n => n.getAttribute("data-id"));
    const order = [...new Set([...picks, ids[0], ids[ids.length - 1], ...ids])];
    const placed = [];
    // Seed with the always-visible "CHICAGO" hub label so a line's downtown terminal
    // name is culled instead of overlapping it (the hover caption still names the route).
    try {
      const hb = hubLbl.getBBox();
      if (hb && hb.width) placed.push({ l: hb.x * s + tx, r: (hb.x + hb.width) * s + tx, t: hb.y * s + ty, b: (hb.y + hb.height) * s + ty });
    } catch { /* no layout (tests) */ }
    for (const id of order) {
      const lbl = els[id].lbl;
      let bb; try { bb = lbl.getBBox(); } catch { return; } // no layout (tests) → leave all shown
      if (!bb || !bb.width) return;
      const r = { l: bb.x * s + tx, r: (bb.x + bb.width) * s + tx, t: bb.y * s + ty, b: (bb.y + bb.height) * s + ty };
      const clash = placed.some(p => !(r.r < p.l - 4 || r.l > p.r + 4 || r.b < p.t - 3 || r.t > p.b + 3));
      if (clash) lbl.classList.add("culled"); else placed.push(r);
    }
  }

  // ---- interactive camera ----
  // On focus the line is fit to the view; the rider can then pinch / scroll / drag
  // to zoom into any stretch. The label cull re-runs (throttled) on every change,
  // so zooming into the crowded downtown reveals all of its station names.
  let focusedId = null;
  const view = { s: 1, tx: 0, ty: 0, fitS: 1 };
  let cullPending = false;
  const raf = typeof requestAnimationFrame !== "undefined" ? requestAnimationFrame : f => setTimeout(f, 16);
  const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));

  function applyView(animate) {
    cam.style.transition = animate ? "" : "none";
    cam.style.transform = `translate(${r1(view.tx)}px, ${r1(view.ty)}px) scale(${view.s.toFixed(4)})`;
    svg.style.setProperty("--inv", (1 / view.s).toFixed(4)); // labels stay a constant size
    if (cullPending) return;
    cullPending = true;
    raf(() => { cullPending = false; if (focusedId) cullLabels(focusedId, view.s, view.tx, view.ty); });
  }
  function fitView(lineId) {
    const b = ctrl.boundsOf(lineId); if (!b) return;
    const pad = 0.16, bw = Math.max(b.maxX - b.minX, 1), bh = Math.max(b.maxY - b.minY, 1);
    const s = Math.max(1.15, Math.min(Math.min((W * (1 - 2 * pad)) / bw, (H * (1 - 2 * pad)) / bh), 5));
    const cx = (b.minX + b.maxX) / 2, cy = (b.minY + b.maxY) / 2;
    view.fitS = s; view.s = s; view.tx = W / 2 - cx * s; view.ty = H / 2 - cy * s;
    svg.classList.add("zoomed");
    applyView(true);
  }
  function clampView() {
    const b = ctrl.boundsOf(focusedId); if (!b) return;
    const m = W * 0.35;
    const txA = -b.maxX * view.s + m, txB = W - b.minX * view.s - m;
    view.tx = clamp(view.tx, Math.min(txA, txB), Math.max(txA, txB));
    const tyA = -b.maxY * view.s + m, tyB = H - b.minY * view.s - m;
    view.ty = clamp(view.ty, Math.min(tyA, tyB), Math.max(tyA, tyB));
  }
  function zoomAt(factor, cx, cy) {
    const ns = clamp(view.s * factor, view.fitS * 0.95, view.fitS * 14);
    const wx = (cx - view.tx) / view.s, wy = (cy - view.ty) / view.s;
    view.s = ns; view.tx = cx - wx * ns; view.ty = cy - wy * ns;
    clampView(); applyView(false);
  }
  function panBy(dx, dy) { view.tx += dx; view.ty += dy; clampView(); applyView(false); }
  function clientToVB(clientX, clientY) {
    try {
      const p = svg.createSVGPoint(); p.x = clientX; p.y = clientY;
      const m = svg.getScreenCTM(); if (m) { const q = p.matrixTransform(m.inverse()); return [q.x, q.y]; }
    } catch { /* no layout (tests) */ }
    const rr = svg.getBoundingClientRect();
    return rr.width ? [(clientX - rr.left) / rr.width * W, (clientY - rr.top) / rr.height * H] : [W / 2, H / 2];
  }

  // ---- controller ----
  const ctrl = {
    element: svg,
    releaseOnWater: false,
    lift,
    projectFor(lineId) {
      // fractional distance 0..1 along a line → [x,y], for the live train dot
      const sts = geo[lineId] || [];
      const p = sts.map(pt), seg = []; let total = 0;
      for (let i = 1; i < p.length; i++) { const d = Math.hypot(p[i][0] - p[i - 1][0], p[i][1] - p[i - 1][1]); seg.push(d); total += d; }
      return frac => {
        let dist = Math.max(0, Math.min(1, frac)) * total, i = 0;
        while (i < seg.length && dist > seg[i]) dist -= seg[i++];
        if (i >= seg.length) return p.at(-1);
        const t = seg[i] ? dist / seg[i] : 0;
        return [p[i][0] + (p[i + 1][0] - p[i][0]) * t, p[i][1] + (p[i + 1][1] - p[i][1]) * t];
      };
    },
    focus(lineId) {
      svg.classList.add("focus");
      host.classList.add("lmap-focused");
      for (const id in groups) groups[id].g.classList.toggle("on", id === lineId);
      raiseLine(lineId);
      ctrl.zoomTo(lineId); // the one place the camera glides: after you pick a line
    },
    unfocus() {
      svg.classList.remove("focus");
      host.classList.remove("lmap-focused");
      for (const id in groups) groups[id].g.classList.remove("on", "hovering");
      ctrl.resetZoom();
      ctrl.select(null);
    },
    // hover = highlight + name the line (caption) + reveal its station names, so an
    // unsure rider can see what a line is and where it runs without looking away.
    // No raiseLine here: re-appending the hovered group churns the DOM under the cursor
    // and some browsers cancel the click that follows (the "tap does nothing" bug). The
    // picked line z-raises on focus() instead — a deliberate tap, not a passing hover.
    hover(lineId) {
      for (const id in groups) groups[id].g.classList.toggle("hovering", id === lineId);
      if (lineId) { showCaption(lineId); revealStops(lineId); } else { hideCaption(); }
    },
    zoomTo(lineId) { focusedId = lineId; fitView(lineId); },
    resetZoom() {
      focusedId = null;
      svg.querySelectorAll(".lmap-lbl.culled").forEach(n => n.classList.remove("culled"));
      view.s = 1; view.tx = 0; view.ty = 0; view.fitS = 1;
      cam.style.transition = ""; cam.style.transform = "";
      svg.style.setProperty("--inv", "1");
      svg.classList.remove("zoomed");
    },
    // exposed for the +/− controls and tests
    zoomAt, panBy, fitView, get view() { return view; },
    // mark board / destination stations on the focused line
    select(lineId, sel = {}) {
      svg.querySelectorAll(".lmap-stn.from,.lmap-stn.to").forEach(n => n.classList.remove("from", "to"));
      svg.querySelectorAll(".lmap-lbl.pick").forEach(n => n.classList.remove("pick"));
      if (!lineId || !groups[lineId]) return;
      const map = groups[lineId].stnEls;
      for (const kind of ["from", "to"]) {
        const sid = sel[kind];
        if (sid && map[sid]) { map[sid].dot.classList.add(kind); map[sid].lbl.classList.add("pick"); }
      }
    },
    setTrains(lineId, list = []) {
      trainLayer.innerHTML = "";
      const proj = ctrl.projectFor(lineId);
      for (const t of list) {
        const [x, y] = t.lat != null ? pt(t) : proj(t.frac || 0);
        const halo = el("circle", { class: "lmap-train-halo", cx: r1(x), cy: r1(y), r: 8.5 });
        const dot = el("circle", { class: "lmap-train", cx: r1(x), cy: r1(y), r: 4 });
        if (t.color) { halo.style.fill = t.color; dot.style.stroke = t.color; }
        trainLayer.appendChild(halo); trainLayer.appendChild(dot);
      }
    },
    // used by the onboarding to zoom/pan focus toward a line's bounding box (CSS transform)
    boundsOf(lineId) {
      const sts = geo[lineId] || [];
      if (!sts.length) return null;
      const xs = sts.map(s => px(s.lon)), ys = sts.map(s => py(s.lat));
      return { minX: Math.min(...xs), maxX: Math.max(...xs), minY: Math.min(...ys), maxY: Math.max(...ys), W, H };
    },
  };

  // ---- gestures (active only while a line is focused for station picking) ----
  const focused = () => svg.classList.contains("focus");
  svg.addEventListener("wheel", e => {
    if (!focused()) return;
    e.preventDefault();
    const [cx, cy] = clientToVB(e.clientX, e.clientY);
    zoomAt(e.deltaY < 0 ? 1.18 : 1 / 1.18, cx, cy);
  }, { passive: false });

  let pinchD = 0, panPt = null;
  const tdist = t => Math.hypot(t[0].clientX - t[1].clientX, t[0].clientY - t[1].clientY);
  svg.addEventListener("touchstart", e => {
    if (!focused()) return;
    if (e.touches.length === 2) { pinchD = tdist(e.touches); panPt = null; }
    else if (e.touches.length === 1) panPt = clientToVB(e.touches[0].clientX, e.touches[0].clientY);
  }, { passive: true });
  svg.addEventListener("touchmove", e => {
    if (!focused()) return;
    if (e.touches.length === 2 && pinchD) {
      e.preventDefault();
      const d = tdist(e.touches);
      const [cx, cy] = clientToVB((e.touches[0].clientX + e.touches[1].clientX) / 2, (e.touches[0].clientY + e.touches[1].clientY) / 2);
      zoomAt(d / pinchD, cx, cy); pinchD = d;
    } else if (e.touches.length === 1 && panPt) {
      const [cx, cy] = clientToVB(e.touches[0].clientX, e.touches[0].clientY);
      const dx = cx - panPt[0], dy = cy - panPt[1];
      if (Math.abs(dx) + Math.abs(dy) > 2) { e.preventDefault(); panBy(dx, dy); panPt = [cx, cy]; } // move = drag, not a tap
    }
  }, { passive: false });
  svg.addEventListener("touchend", () => { pinchD = 0; panPt = null; });

  // desktop drag-to-pan
  let mPt = null;
  svg.addEventListener("mousedown", e => { if (focused()) mPt = clientToVB(e.clientX, e.clientY); });
  if (typeof window !== "undefined" && window.addEventListener) {
    window.addEventListener("mousemove", e => { if (!mPt) return; const [cx, cy] = clientToVB(e.clientX, e.clientY); panBy(cx - mPt[0], cy - mPt[1]); mPt = [cx, cy]; });
    window.addEventListener("mouseup", () => { mPt = null; });
  }

  // ---- zoom controls + a one-line hint (shown only while focused) ----
  const ctrls = document.createElement("div");
  ctrls.className = "lmap-ctrls";
  ctrls.innerHTML = `<button type="button" class="lz-in" aria-label="Zoom in">+</button>
    <button type="button" class="lz-out" aria-label="Zoom out">−</button>
    <button type="button" class="lz-fit" aria-label="Fit the whole line">⤢</button>`;
  ctrls.querySelector(".lz-in").addEventListener("click", () => zoomAt(1.5, W / 2, H / 2));
  ctrls.querySelector(".lz-out").addEventListener("click", () => zoomAt(1 / 1.5, W / 2, H / 2));
  ctrls.querySelector(".lz-fit").addEventListener("click", () => focusedId && fitView(focusedId));
  host.appendChild(ctrls);
  const hint = document.createElement("div");
  hint.className = "lmap-hint";
  hint.textContent = "Pinch, scroll, or tap + to zoom in for every stop";
  host.appendChild(hint);

  // Hover caption (system view): names the hovered line and its route, so a rider who
  // isn't sure which line to pick can read it right off the map.
  const caption = document.createElement("div");
  caption.className = "lmap-caption";
  host.appendChild(caption);
  function showCaption(lineId) {
    const info = lineInfo[lineId];
    if (!info || svg.classList.contains("focus")) return;
    caption.textContent = "";
    const dot = document.createElement("span"); dot.className = "lmap-cap-dot"; dot.style.background = info.color;
    const name = document.createElement("span"); name.className = "lmap-cap-name"; name.textContent = info.name;
    const route = document.createElement("span"); route.className = "lmap-cap-route"; route.textContent = `${info.from} → ${info.to}`;
    caption.append(dot, name, route);
    caption.classList.add("show");
  }
  function hideCaption() { caption.classList.remove("show"); }
  // Reveal the hovered line's station names on the system view, culled so they don't
  // collide (getBBox is a no-op in tests → all names simply show, which is fine).
  function revealStops(lineId) {
    if (!lineId || svg.classList.contains("focus")) return;
    // Defer to the next frame: the labels just flipped from display:none, and getBBox
    // returns 0 that instant → cullLabels would bail and leave EVERY name shown (the
    // cluttered hover). Next frame they have real layout, so culling actually thins them.
    raf(() => {
      const g = groups[lineId] && groups[lineId].g;
      if (g && g.classList.contains("hovering") && !svg.classList.contains("focus")) cullLabels(lineId, view.s, view.tx, view.ty);
    });
  }

  return ctrl;
}

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

export function createMap(host, { lines, stopsByLine, onLine, onStation }) {
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
  const lake = "M " + SHORE.map(([la, lo]) => `${r1(px(lo))},${r1(py(la))}`).join(" L ")
    + ` L ${W + 60},${r1(py(41.55))} L ${W + 60},-60 L ${r1(px(-87.79))},-60 Z`;
  cam.appendChild(el("path", { class: "lmap-lake", d: lake }));

  // ---- one <g> per line ----
  const groups = {};
  for (const l of lines) {
    const sts = geo[l.id];
    if (sts.length < 2) continue;
    const c = lift(l.color);
    const path = "M " + sts.map(st => pt(st).map(r1).join(",")).join(" L ");
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
      dot.addEventListener("click", e => {
        if (!g.classList.contains("on")) return;      // only tappable while focused
        e.stopPropagation();
        onStation && onStation(l.id, st.id);
      });
    }
    // terminal label (farthest from downtown) always visible on the system view
    const far = [sts[0], sts.at(-1)].sort((a, b) => d2hub(b) - d2hub(a))[0];
    const [tx, ty] = pt(far).map(r1);
    const tLeft = tx > hx;
    const term = el("text", { class: "lmap-term", x: r1(tx + (tLeft ? -9 : 9)), y: r1(ty + 3.5), "text-anchor": tLeft ? "end" : "start" });
    term.textContent = far.name;
    g.appendChild(term);

    const hit = g.querySelector(".lmap-hit");
    hit.addEventListener("click", e => { e.stopPropagation(); onLine && onLine(l.id); });
    // Desktop hover: zoom into the line and reveal its station names (a preview of
    // the route). No-op on touch (no hover); focus() does the same on tap.
    hit.addEventListener("mouseenter", () => { if (!svg.classList.contains("focus")) ctrl.hover(l.id); });
    hit.addEventListener("mouseleave", () => { if (!svg.classList.contains("focus")) ctrl.hover(null); });
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

  // Tapping empty water releases focus — but only where that makes sense (a future
  // "explore" view). Off during onboarding, where Back drives the step/focus, so a
  // stray water tap can't desync the map from the wizard's current question.
  svg.addEventListener("click", () => { if (ctrl.releaseOnWater) ctrl.unfocus(); });

  // Bring a line (and the train/hub layers) to the top of the camera so it draws
  // above the dimmed system.
  function raiseLine(lineId) {
    const fg = groups[lineId] && groups[lineId].g;
    if (fg) cam.appendChild(fg);
    cam.appendChild(trainLayer);
    cam.appendChild(cam.querySelector(".lmap-hub"));
    cam.appendChild(hubLbl);
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
      for (const id in groups) groups[id].g.classList.toggle("on", id === lineId);
      raiseLine(lineId);
      ctrl.zoomTo(lineId); // zoom in so this line's station names are readable
    },
    unfocus() {
      svg.classList.remove("focus");
      for (const id in groups) groups[id].g.classList.remove("on", "hovering");
      ctrl.resetZoom();
      ctrl.select(null);
    },
    // desktop hover preview (system view): zoom into a line + show its names
    hover(lineId) {
      for (const id in groups) groups[id].g.classList.toggle("hovering", id === lineId);
      if (lineId) { raiseLine(lineId); ctrl.zoomTo(lineId); }
      else ctrl.resetZoom();
    },
    zoomTo(lineId) {
      const b = ctrl.boundsOf(lineId);
      if (!b) return;
      const pad = 0.14;
      const bw = Math.max(b.maxX - b.minX, 1), bh = Math.max(b.maxY - b.minY, 1);
      let s = Math.min((W * (1 - 2 * pad)) / bw, (H * (1 - 2 * pad)) / bh);
      s = Math.max(1.2, Math.min(s, 4));
      const cx = (b.minX + b.maxX) / 2, cy = (b.minY + b.maxY) / 2;
      cam.style.transform = `translate(${r1(W / 2 - cx * s)}px, ${r1(H / 2 - cy * s)}px) scale(${s.toFixed(3)})`;
      svg.style.setProperty("--inv", (1 / s).toFixed(3)); // counter-scale labels to keep them ~constant size
      svg.classList.add("zoomed");
    },
    resetZoom() {
      cam.style.transform = "";
      svg.style.setProperty("--inv", "1");
      svg.classList.remove("zoomed");
    },
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
  return ctrl;
}

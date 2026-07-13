// Pure logic shared by background + popup. No chrome.* calls here.

export const DEFAULT_SETTINGS = {
  morningWindow: ["05:00", "11:00"],
  eveningWindow: ["12:00", "23:59"],
  reminderMinutes: 15, // used in Phase 3
};

export function minutesOfDay(d = new Date()) {
  return d.getHours() * 60 + d.getMinutes();
}

function parseHM(hm) {
  const [h, m] = hm.split(":").map(Number);
  return h * 60 + m;
}

// Returns "HW" (home→work), "WH", or "BOTH".
export function resolveDirection(settings, override, now = new Date(), serviceModified = false) {
  if (override && override.active && Date.now() < override.expiresAt) {
    return override.direction;
  }
  const day = now.getDay();
  if (day === 0 || day === 6 || serviceModified) return "BOTH"; // weekends + holiday-modified service
  const m = minutesOfDay(now);
  const [mStart, mEnd] = settings.morningWindow.map(parseHM);
  const [eStart, eEnd] = settings.eveningWindow.map(parseHM);
  if (m >= mStart && m < mEnd) return "HW";
  if (m >= eStart && m <= eEnd) return "WH";
  return "BOTH";
}

// Override lasts until the next window boundary (or midnight, whichever first).
export function overrideExpiry(settings, now = new Date()) {
  const m = minutesOfDay(now);
  const boundaries = [
    parseHM(settings.morningWindow[0]), parseHM(settings.morningWindow[1]),
    parseHM(settings.eveningWindow[0]), parseHM(settings.eveningWindow[1]),
    24 * 60,
  ].filter(b => b > m).sort((a, b) => a - b);
  const next = boundaries[0] ?? 24 * 60;
  const exp = new Date(now);
  exp.setHours(Math.floor(next / 60), next % 60, 0, 0);
  return exp.getTime();
}

// Badge state machine. `data` = { trains, fetchedAt } for the badge direction; may be null.
// Returns { text, color }.
export function badgeState({ onboarded, offline, data, overridden }) {
  const GRAY = "#8A8F98", GREEN = "#1D9E75";
  if (!onboarded) return { text: "SET", color: GRAY };
  const trains = data && data.trains ? data.trains.filter(t => t.depEpochMs > Date.now()) : [];
  if (!trains.length) {
    if (offline && !data) return { text: "?", color: GRAY };
    return { text: "--", color: GRAY };
  }
  const next = trains[0];
  const mins = Math.max(0, Math.round((next.depEpochMs - Date.now()) / 60000));
  let text = mins > 99 ? "99+" : `${mins}${next.class}`;
  if (overridden && text.length < 4) text = text; // "R" state shown via title, 4-char limit is tight
  return { text, color: GREEN };
}

// Upcoming trains still in the future, from cached payload.
export function upcoming(data) {
  if (!data || !data.trains) return [];
  return data.trains.filter(t => t.depEpochMs > Date.now());
}

// "Express in 22 min" hint when the next train is Local but an Express leaves within 30 min.
export function expressHint(trains) {
  if (!trains.length || trains[0].class === "E") return null;
  const ex = trains.find(t => t.class === "E");
  if (!ex) return null;
  const mins = Math.round((ex.depEpochMs - Date.now()) / 60000);
  return mins <= 30 ? { trainNo: ex.trainNo, minutes: mins } : null;
}

export function fmtCountdown(epochMs) {
  const s = Math.max(0, Math.floor((epochMs - Date.now()) / 1000));
  if (s >= 3600) return `${Math.floor(s / 3600)}h ${Math.floor((s % 3600) / 60)}m`;
  if (s >= 60) return `${Math.floor(s / 60)} min`;
  return `${s}s`;
}

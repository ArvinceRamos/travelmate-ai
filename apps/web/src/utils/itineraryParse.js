// Single source of truth for reading saved itinerary text. Used by the
// itinerary page (display), the map (stops) and the editor (day headers).

const TIME = String.raw`\d{1,2}:\d{2}(?:\s*[AaPp]\.?[Mm]\.?)?`;
const TIME_LINE_RE = new RegExp(
  String.raw`^(?:(?:[-*•]|\d{1,2}[.)])\s+)?(${TIME})(?:\s*(?:–|—|-|to)\s*(${TIME}))?(?:\s*[-–—:]?\s+(.*))?$`,
  "i"
);
const DAY_HEADER_RE = /^(?:#{1,6}\s*)?Day\s+(\d+)\s*(?:[—–\-:]\s*.*)?$/i;
const MAP_JSON_START = "<<<MAP_STOPS_JSON>>>";
const MAP_JSON_END = "<<<END_MAP_STOPS_JSON>>>";

function cleanLine(raw = "") {
  return String(raw || "")
    .replace(/\*\*|__/g, "")
    .replace(/^#{1,6}\s+(?=Day\b)/i, "")
    .replace(/\s+/g, " ")
    .trim();
}

export function isDayHeader(line = "") {
  return DAY_HEADER_RE.test(cleanLine(line));
}

function dayNumberOf(line = "") {
  const m = cleanLine(line).match(DAY_HEADER_RE);
  return m ? Number(m[1]) : null;
}

function matchTimeLine(line) {
  const m = line.match(TIME_LINE_RE);
  if (!m) return null;
  const start = m[1].replace(/\s+/g, " ");
  const end = (m[2] || "").replace(/\s+/g, " ");
  const rest = String(m[3] || "").trim();
  // A bare single time ("10:00") followed by prose is a description, not a slot.
  if (!end && !rest) return null;
  return { start, end, rest };
}

function splitOneLine(rest) {
  const idx = rest.indexOf(" - ");
  if (idx === -1) return { place: rest.trim(), desc: "" };
  return { place: rest.slice(0, idx).trim(), desc: rest.slice(idx + 3).trim() };
}

function startsAppendix(line) {
  const t = line.replace(/^---\s*/, "").trim();
  return (
    /^---$/.test(line) ||
    /^#{0,3}\s*Estimated\s+Budget\s+Per\s+Person/i.test(t) ||
    /^Estimated\s+total\s*:/i.test(t)
  );
}

/**
 * Parse itinerary text into header lines, days with activities, and an
 * appendix (budget block). Supports both formats:
 *   09:00–11:00 - Place - Description          (one line)
 *   1. 07:00–10:00 / Place / Description       (three lines)
 */
export function parseItinerary(text = "") {
  const headerLines = [];
  const days = [];
  const appendixLines = [];
  if (!String(text || "").trim()) return { headerLines, days, appendixLines };

  let currentDay = null;
  let currentAct = null;
  let awaitingPlace = false;
  let inAppendix = false;
  let inMapJson = false;

  const ensureDay = () => {
    if (!currentDay) {
      currentDay = { day: 1, title: "Day 1", activities: [] };
      days.push(currentDay);
    }
    return currentDay;
  };

  for (const raw of String(text).split(/\r?\n/)) {
    const rawTrim = raw.trim();
    if (rawTrim.includes(MAP_JSON_START)) inMapJson = true;
    if (inMapJson) {
      if (rawTrim.includes(MAP_JSON_END)) inMapJson = false;
      continue;
    }

    const line = cleanLine(raw);
    if (!line) continue;
    if (/^Would you like to save this itinerary\??$/i.test(line)) continue;

    if (inAppendix || startsAppendix(line)) {
      inAppendix = true;
      const t = line.replace(/^---\s*/, "").trim();
      if (t && t !== "---") appendixLines.push(t);
      continue;
    }

    if (isDayHeader(line)) {
      currentDay = { day: dayNumberOf(line) || days.length + 1, title: line, activities: [] };
      days.push(currentDay);
      currentAct = null;
      awaitingPlace = false;
      continue;
    }

    const time = matchTimeLine(line);
    if (time) {
      const day = ensureDay();
      const { place, desc } = time.rest ? splitOneLine(time.rest) : { place: "", desc: "" };
      currentAct = { start: time.start, end: time.end, place, desc };
      day.activities.push(currentAct);
      awaitingPlace = !place;
      continue;
    }

    if (!currentDay) {
      headerLines.push(line);
      continue;
    }

    if (awaitingPlace && currentAct) {
      currentAct.place = line;
      awaitingPlace = false;
      continue;
    }

    if (currentAct) {
      currentAct.desc = currentAct.desc ? `${currentAct.desc} ${line}` : line;
      continue;
    }

    // Untimed notes before the first slot of a day.
    const acts = currentDay.activities;
    if (acts.length) {
      const last = acts[acts.length - 1];
      last.desc = last.desc ? `${last.desc} ${line}` : line;
    } else {
      acts.push({ start: "", end: "", place: "", desc: line });
    }
  }

  return { headerLines, days, appendixLines };
}

const LEG_PREFIX_RE = /^(?:(?:travel|transfer|drive|ride|ferry|fly|return|head|go)\s+(?:back\s+)?)?(?:from\s+)?/i;
const NOT_A_LEG_RE = /^(?:road|gateway|stairway|path|trail|bridge|way|door|ticket)$/i;

/** "Cebu City to Moalboal" → { from: "Cebu City", to: "Moalboal" }; "Return to X" → { from: null, to: "X" }. */
export function parseLeg(place = "") {
  const t = String(place || "").trim();
  const onlyTo = t.match(/^(?:travel|transfer|drive|ride|ferry|fly|return|head|go)\s+(?:back\s+)?to\s+(.+)$/i);
  if (onlyTo) return { from: null, to: onlyTo[1].trim() };

  const body = t.replace(LEG_PREFIX_RE, "");
  const m = body.match(/^(.+?)\s+(?:to|→|->)\s+(.+)$/i);
  if (!m) return null;
  const from = m[1].trim();
  const to = m[2].trim();
  const words = (s) => s.split(/\s+/).length;
  if (NOT_A_LEG_RE.test(from) || /^the\b/i.test(to)) return null;
  if (words(from) > 6 || words(to) > 6) return null;
  return { from, to };
}

/** Text sent to the geocoder for a place label. */
export function placeQuery(place = "") {
  return String(place || "")
    .replace(/\s*\([^)]*\)\s*/g, " ")
    .replace(/\s+area$/i, "")
    .replace(/\s+/g, " ")
    .trim();
}

/** Stable cache key for a geocoder query. */
export function placeKey(query = "") {
  return String(query || "")
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

/**
 * Every timed activity with a place becomes a stop, in order, numbered per
 * day from 1. Repeats across days are kept (one per day).
 */
export function itineraryStops(textOrParsed = "") {
  const parsed = typeof textOrParsed === "string" ? parseItinerary(textOrParsed) : textOrParsed;
  const stops = [];

  for (const day of parsed?.days || []) {
    let order = 0;
    for (const act of day.activities || []) {
      if (!act.start || !act.place) continue;
      order += 1;
      const leg = parseLeg(act.place);
      const target = leg ? leg.to : act.place;
      stops.push({
        id: `${day.day}-${order}`,
        day: day.day,
        order,
        start: act.start,
        end: act.end,
        place: act.place,
        desc: act.desc,
        query: placeQuery(target),
        fromQuery: leg?.from ? placeQuery(leg.from) : null,
        isTransfer: Boolean(leg),
      });
    }
  }

  return stops;
}

export function stopDays(stops = []) {
  return [...new Set(stops.map((s) => s.day))].sort((a, b) => a - b);
}

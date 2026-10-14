"use strict";

// CommonJS port of apps/web/src/utils/itineraryParse.js (parseItinerary and the
// timed-stop rule of itineraryStops). The reminder sweep must pick the same
// stops and labels as the browser, because notification IDs hash the label —
// keep the two files in sync.

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

function isDayHeader(line = "") {
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
function parseItinerary(text = "") {
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

/** Every timed activity with a place, in order: { day, start, end, place, desc }. */
function timedStops(text = "") {
  const stops = [];
  for (const day of parseItinerary(text).days) {
    for (const act of day.activities) {
      if (!act.start || !act.place) continue;
      stops.push({ day: day.day, start: act.start, end: act.end, place: act.place, desc: act.desc });
    }
  }
  return stops;
}

module.exports = { parseItinerary, isDayHeader, timedStops };

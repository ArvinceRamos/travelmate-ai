// Pure helpers for turning saved itinerary text into timed reminders.
// Kept free of React/Firebase so they can be tested with node:test.
import { itineraryStops } from "../../utils/itineraryParse.js";

export function parseISODateToLocalMidnight(iso) {
  const m = String(iso || "").match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!m) return null;
  const d = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
  d.setHours(0, 0, 0, 0);
  return d;
}

export function addDays(dateObj, days) {
  const d = new Date(dateObj);
  d.setDate(d.getDate() + days);
  return d;
}

export function parseTimeOnDateMs(hhmm, baseDate) {
  const raw = (hhmm || "").trim();
  if (!raw) return null;

  const m = raw.match(/(\d{1,2}):(\d{2})\s*(AM|PM)?/i);
  if (!m) return null;

  let h = parseInt(m[1], 10);
  const min = parseInt(m[2], 10);
  const ap = (m[3] || "").toUpperCase();

  if (ap === "PM" && h < 12) h += 12;
  if (ap === "AM" && h === 12) h = 0;

  const d = baseDate ? new Date(baseDate) : new Date();
  d.setHours(h, min, 0, 0);
  return d.getTime();
}

/**
 * One reminder per timed stop: { whenMs, timeLabel, endLabel, label, dayNum }.
 * Without a trip start date every stop is placed on today.
 */
export function extractTimedItemsByDay(text = "", tripStartISO = null) {
  const base = tripStartISO ? parseISODateToLocalMidnight(tripStartISO) : null;
  const out = [];

  for (const stop of itineraryStops(String(text || ""))) {
    const dayDate = base ? addDays(base, Math.max(0, stop.day - 1)) : null;
    // The parser accepts "p.m."; parseTimeOnDateMs only knows "PM".
    const whenMs = parseTimeOnDateMs(stop.start.replace(/\./g, ""), dayDate);
    if (!whenMs) continue;
    out.push({ whenMs, timeLabel: stop.start, endLabel: stop.end, label: stop.place, dayNum: stop.day });
  }

  out.sort((a, b) => a.whenMs - b.whenMs);
  return out;
}

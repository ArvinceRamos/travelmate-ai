// apps/web/src/utils/tripMeta.js

const MONTHS = {
  january: 0,
  jan: 0,
  february: 1,
  feb: 1,
  march: 2,
  mar: 2,
  april: 3,
  apr: 3,
  may: 4,
  june: 5,
  jun: 5,
  july: 6,
  jul: 6,
  august: 7,
  aug: 7,
  september: 8,
  sep: 8,
  sept: 8,
  october: 9,
  oct: 9,
  november: 10,
  nov: 10,
  december: 11,
  dec: 11,
};

// Words that should never become a "destination" / title.
const GENERIC_DEST_WORDS = new Set([
  "your",
  "my",
  "our",
  "the",
  "a",
  "an",
  "this",
  "that",
  "these",
  "those",
  "itinerary",
  "plan",
  "schedule",
  "trip",
  "travel",
  "saved",
]);

function pad2(n) {
  return String(n).padStart(2, "0");
}

function isoFromParts(year, monthIndex, day) {
  const d = new Date(year, monthIndex, day, 0, 0, 0, 0);
  if (Number.isNaN(d.getTime())) return null;
  const y = d.getFullYear();
  const m = pad2(d.getMonth() + 1);
  const dd = pad2(d.getDate());
  return `${y}-${m}-${dd}`;
}

function parseMonthDayToISO(monthWord, dayNum, yearGuess = new Date().getFullYear()) {
  const mi = MONTHS[String(monthWord || "").toLowerCase()];
  if (mi === undefined) return null;
  const day = Number(dayNum);
  if (!day || day < 1 || day > 31) return null;
  return isoFromParts(yearGuess, mi, day);
}

function clampDay(d) {
  const n = Number(d);
  if (!n || n < 1 || n > 31) return null;
  return n;
}

function normalizeMonthWord(word) {
  return String(word || "")
    .trim()
    .replace(/\.$/, "")
    .toLowerCase();
}

function monthIndexFromWord(word) {
  const mi = MONTHS[normalizeMonthWord(word)];
  return mi === undefined ? null : mi;
}

function parseISODateLiteral(s) {
  const m = String(s || "").match(/\b(\d{4})-(\d{2})-(\d{2})\b/);
  if (!m) return null;
  const y = Number(m[1]);
  const mo = Number(m[2]);
  const d = Number(m[3]);
  if (!y || !mo || !d) return null;
  return `${String(y).padStart(4, "0")}-${String(mo).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
}

function shiftYear(iso, deltaYears) {
  if (!iso) return null;
  const m = String(iso).match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!m) return null;
  const y = Number(m[1]) + deltaYears;
  return `${String(y).padStart(4, "0")}-${m[2]}-${m[3]}`;
}

function toISOFromPartsSafe(year, monthIndex, day) {
  try {
    return isoFromParts(year, monthIndex, day);
  } catch {
    return null;
  }
}

function chooseBaseYearForTextDates() {
  const today = new Date();
  return { year: today.getFullYear(), monthIndex: today.getMonth() };
}

/**
 * Extract month/day(/year) date candidates from itinerary text.
 * Returns candidates in the order they appear.
 */
function extractDateCandidates(text = "") {
  const t = String(text || "");
  const out = [];

  // 1) ISO dates
  const isoRe = /\b(\d{4})-(\d{2})-(\d{2})\b/g;
  for (const m of t.matchAll(isoRe)) {
    const iso = parseISODateLiteral(m[0]);
    if (iso) out.push({ iso, hasExplicitYear: true, pos: m.index ?? 0 });
  }

  // 2) Ranges: "March 10–12" (same month)
  const sameMonthRangeRe =
    /\b(January|Jan|February|Feb|March|Mar|April|Apr|May|June|Jun|July|Jul|August|Aug|September|Sep|Sept|October|Oct|November|Nov|December|Dec)\s+(\d{1,2})\s*[–-]\s*(\d{1,2})(?:\s*,?\s*(\d{4}))?\b/gi;
  for (const m of t.matchAll(sameMonthRangeRe)) {
    const mi = monthIndexFromWord(m[1]);
    const d1 = clampDay(m[2]);
    const d2 = clampDay(m[3]);
    if (mi === null || !d1 || !d2) continue;
    const y = m[4] ? Number(m[4]) : null;
    out.push({ monthIndex: mi, day: d1, year: y, hasExplicitYear: !!y, pos: m.index ?? 0 });
    out.push({ monthIndex: mi, day: d2, year: y, hasExplicitYear: !!y, pos: (m.index ?? 0) + 1 });
  }

  // 3) Ranges: "March 10 - March 12" / "March 10 – Apr 2" / "March 10 to March 12"
  const fullRangeRe =
    /\b(January|Jan|February|Feb|March|Mar|April|Apr|May|June|Jun|July|Jul|August|Aug|September|Sep|Sept|October|Oct|November|Nov|December|Dec)\s+(\d{1,2})(?:\s*,?\s*(\d{4}))?\s*(?:[–-]|to)\s*(January|Jan|February|Feb|March|Mar|April|Apr|May|June|Jun|July|Jul|August|Aug|September|Sep|Sept|October|Oct|November|Nov|December|Dec)?\s*(\d{1,2})(?:\s*,?\s*(\d{4}))?\b/gi;
  for (const m of t.matchAll(fullRangeRe)) {
    const mi1 = monthIndexFromWord(m[1]);
    const d1 = clampDay(m[2]);
    const y1 = m[3] ? Number(m[3]) : null;
    const mi2 = monthIndexFromWord(m[4] || m[1]);
    const d2 = clampDay(m[5]);
    const y2 = m[6] ? Number(m[6]) : null;
    if (mi1 === null || mi2 === null || !d1 || !d2) continue;
    out.push({ monthIndex: mi1, day: d1, year: y1, hasExplicitYear: !!y1, pos: m.index ?? 0 });
    out.push({ monthIndex: mi2, day: d2, year: y2, hasExplicitYear: !!y2, pos: (m.index ?? 0) + 1 });
  }

  // 4) Single dates: "Day 1 – March 10" / "March 10" / "March 10, 2026"
  const singleRe =
    /\b(January|Jan|February|Feb|March|Mar|April|Apr|May|June|Jun|July|Jul|August|Aug|September|Sep|Sept|October|Oct|November|Nov|December|Dec)\s+(\d{1,2})(?:\s*,?\s*(\d{4}))?\b/gi;
  for (const m of t.matchAll(singleRe)) {
    const mi = monthIndexFromWord(m[1]);
    const d = clampDay(m[2]);
    if (mi === null || !d) continue;
    const y = m[3] ? Number(m[3]) : null;
    out.push({ monthIndex: mi, day: d, year: y, hasExplicitYear: !!y, pos: m.index ?? 0 });
  }

  out.sort((a, b) => (a.pos ?? 0) - (b.pos ?? 0));
  return out;
}

function resolveCandidateISOSequence(cands) {
  if (!Array.isArray(cands) || !cands.length) return [];

  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const { year: baseYear, monthIndex: nowMi } = chooseBaseYearForTextDates();

  let runningYear = baseYear;
  let prevMi = null;
  const resolved = [];

  for (const c of cands) {
    if (c.iso) {
      resolved.push({ iso: c.iso, hasExplicitYear: true });
      const mm = String(c.iso).match(/^(\d{4})-(\d{2})-(\d{2})$/);
      if (mm) {
        runningYear = Number(mm[1]);
        prevMi = Number(mm[2]) - 1;
      }
      continue;
    }

    const mi = c.monthIndex;
    const day = c.day;

    if (c.year) {
      runningYear = c.year;
      prevMi = mi;
      const iso = toISOFromPartsSafe(runningYear, mi, day);
      if (iso) resolved.push({ iso, hasExplicitYear: true });
      continue;
    }

    // Heuristic for Dec saving upcoming Jan trip.
    if (prevMi === null && nowMi === 11 && mi <= 1) {
      runningYear = baseYear + 1;
    }

    // Heuristic for cross-year within the same itinerary: Dec -> Jan.
    if (prevMi !== null && mi < prevMi) {
      runningYear += 1;
    }

    const iso = toISOFromPartsSafe(runningYear, mi, day);
    if (iso) resolved.push({ iso, hasExplicitYear: false });
    prevMi = mi;
  }

  // If all years were inferred and the end date looks far in the past, shift forward 1 year.
  const hasAnyExplicitYear = resolved.some((r) => r.hasExplicitYear);
  if (!hasAnyExplicitYear && resolved.length) {
    const dates = resolved
      .map((r) => new Date(`${r.iso}T00:00:00`))
      .filter((d) => !Number.isNaN(d.getTime()));
    if (dates.length) {
      const max = new Date(Math.max(...dates.map((d) => d.getTime())));
      const sevenDaysAgo = new Date(today);
      sevenDaysAgo.setDate(sevenDaysAgo.getDate() - 7);
      if (max.getTime() < sevenDaysAgo.getTime()) {
        return resolved
          .map((r) => ({ ...r, iso: shiftYear(r.iso, 1) }))
          .filter((r) => !!r.iso);
      }
    }
  }

  return resolved;
}

function formatDateRangeTitle(dest, startISO, endISO) {
  const destination = (dest || "").trim();
  if (!destination) return null;

  if (!startISO || !endISO) return `${destination}`;

  const s = new Date(`${startISO}T00:00:00`);
  const e = new Date(`${endISO}T00:00:00`);
  if (Number.isNaN(s.getTime()) || Number.isNaN(e.getTime())) return `${destination}`;

  const sameMonth = s.getMonth() === e.getMonth() && s.getFullYear() === e.getFullYear();

  const optsMonth = { month: "long" };
  const monthName = s.toLocaleString(undefined, optsMonth);

  const sDay = s.getDate();
  const eDay = e.getDate();

  if (sameMonth) {
    return `${destination} • ${monthName} ${sDay}–${eDay}`;
  }

  const sMonth = s.toLocaleString(undefined, { month: "long" });
  const eMonth = e.toLocaleString(undefined, { month: "long" });
  return `${destination} • ${sMonth} ${sDay}–${eMonth} ${eDay}`;
}

function cleanDestinationCandidate(raw) {
  const s = String(raw || "")
    .replace(/^[^A-Za-z]+/, "")
    .trim();
  if (!s) return null;

  // Drop leading generic words: "Your Bantayan" -> "Bantayan"
  const parts = s.split(/\s+/).filter(Boolean);
  while (parts.length && GENERIC_DEST_WORDS.has(parts[0].toLowerCase())) {
    parts.shift();
  }
  const out = parts.join(" ").trim();
  if (!out) return null;
  if (GENERIC_DEST_WORDS.has(out.toLowerCase())) return null;
  return out;
}

function extractDestination(text = "") {
  const t = String(text || "");

  // Prefer patterns like: "Manila 3-day itinerary", "3-day Manila itinerary", "Cebu City 2D1N"
  let m =
    t.match(/\b([A-Z][A-Za-z]+(?:\s+[A-Z][A-Za-z]+){0,3})\s+(?:\d+\s*[- ]?(?:day|days|night|nights)|\d+d\d+n|\d+d\d+n)\b/i) ||
    t.match(/\b(?:\d+\s*[- ]?(?:day|days|night|nights)|\d+d\d+n)\s+(?:trip\s+to\s+)?([A-Z][A-Za-z]+(?:\s+[A-Z][A-Za-z]+){0,3})\b/i);

  if (m?.[1]) {
    const cand = cleanDestinationCandidate(m[1]);
    if (cand) return cand;
  }

  // If your itinerary uses "in <Place>" early
  m = t.match(/\bin\s+([A-Z][A-Za-z]+(?:\s+[A-Z][A-Za-z]+){0,3})\b/);
  if (m?.[1]) {
    const cand = cleanDestinationCandidate(m[1]);
    if (cand) return cand;
  }

  // Fallback: first bold title line like **Manila 3-day itinerary**
  m = t.match(/\*\*([^*]{3,60})\*\*/);
  if (m?.[1]) {
    const candidate = m[1].trim();
    // Strip generic words
    const cleaned = candidate.replace(/\b(itinerary|plan|schedule)\b/gi, "").trim();
    const cand = cleanDestinationCandidate(cleaned);
    if (cand && cand.length <= 36) return cand;
  }

  return null;
}

function extractDateRange(text = "") {
  const candidates = extractDateCandidates(text);
  const resolved = resolveCandidateISOSequence(candidates);
  const isos = resolved.map((r) => r.iso).filter(Boolean);
  if (!isos.length) return { startISO: null, endISO: null };

  const dates = isos
    .map((iso) => ({ iso, d: new Date(`${iso}T00:00:00`) }))
    .filter((x) => !Number.isNaN(x.d.getTime()));
  if (!dates.length) return { startISO: null, endISO: null };

  dates.sort((a, b) => a.d.getTime() - b.d.getTime());
  return { startISO: dates[0].iso, endISO: dates[dates.length - 1].iso };
}

export function extractTripMetaFromText(itineraryText = "") {
  const destination = extractDestination(itineraryText);
  const { startISO, endISO } = extractDateRange(itineraryText);

  return {
    destination: destination || null,
    startISO: startISO || null,
    endISO: endISO || null,
  };
}

export function buildItineraryTitle({ itineraryText = "", tripStartISO = null, tripEndISO = null } = {}) {
  const meta = extractTripMetaFromText(itineraryText);
  const destination = meta.destination || null;

  const startISO = tripStartISO || meta.startISO;
  const endISO = tripEndISO || meta.endISO;

  if (!destination) return null;

  return formatDateRangeTitle(destination, startISO, endISO);
}

export function titleLooksBad(title = "") {
  const t = String(title || "").trim();
  if (!t) return true;

  const lower = t.toLowerCase();

  // Never allow single generic words like "your".
  if (GENERIC_DEST_WORDS.has(lower)) return true;

  // Very common generic titles
  if (/^(saved\s+itinerary|itinerary|plan|travel\s*plan|schedule)$/i.test(t)) return true;

  // Bad titles often start with “I’ll / Got it / Sure / Here’s…”
  if (/^(i['’]ll|i will|got it|sure|here['’]s|okay|alright)\b/i.test(t)) return true;

  // Too long = likely sentence
  if (t.length > 60) return true;

  // Doesn’t contain the bullet separator or dates (our new format)
  if (!t.includes("•")) return true;

  return false;
}
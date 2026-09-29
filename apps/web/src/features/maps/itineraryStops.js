function cleanLine(line = "") {
  return String(line || "")
    .replace(/\*\*/g, "")
    .replace(/^\s*[-*•]\s+/, "")
    .replace(/\s+/g, " ")
    .trim();
}

function looksLikeDayHeader(line = "") {
  return /^\s*(?:#{1,6}\s*)?Day\s+(\d+)\b/i.test(String(line || ""));
}

function extractDayNumber(line = "") {
  const m = String(line || "").match(/^\s*(?:#{1,6}\s*)?Day\s+(\d+)\b/i);
  return m ? Number(m[1]) : null;
}

function stripLeadingTime(line = "") {
  return String(line || "")
    .replace(
      /^\s*\d{1,2}:\d{2}\s*(?:AM|PM)?\s*(?:–|-|to)\s*\d{1,2}:\d{2}\s*(?:AM|PM)?\s*(?:[:\-–—]\s*)?/i,
      ""
    )
    .replace(/^\s*(Morning|Afternoon|Evening|Night)\s*[:\-–—]?\s*/i, "")
    .trim();
}

function splitCandidates(text = "") {
  return String(text || "")
    .split(/,|•|\||\bthen\b|\band then\b/gi)
    .map((part) => cleanLine(part))
    .filter(Boolean);
}

function normalizeCandidate(text = "") {
  let t = cleanLine(text);
  t = stripLeadingTime(t);

  t = t
    .replace(/^(visit|go to|head to|stop at|explore|check out|travel to|walk to|ride to)\s+/i, "")
    .replace(/\s+\(.*?\)\s*$/g, "")
    .replace(/\s+-\s+.*$/g, "")
    .trim();

  if (!t || t.length < 4) return "";

  const badPatterns = [
  // meals / generic
  /^breakfast$/i,
  /^lunch$/i,
  /^dinner$/i,
  /^free time$/i,
  /^shopping$/i,

  // pure logistics (these should NOT become pins)
  /^travel\b/i,
  /^travel to\b/i,
  /^travel back\b/i,
  /^commute\b/i,
  /^ride\b/i,
  /^walk\b/i,
  /^drive\b/i,
  /^transfer\b/i,
  /^go home\b/i,
  /^back home\b/i,
  /^rest\b/i,
  /^rest at\b/i,

  // arrival/departure/transport hubs (also NOT pins)
  /^arrival\b/i,
  /^arrive\b/i,
  /^departure\b/i,
  /\btransfer\b/i,
  /\bairport\b/i,
  /\bterminal\b/i,
  /\bport\b/i,

  // check-in/out
  /^hotel check-?in$/i,
  /^check-?in$/i,
  /^check-?out$/i,

  // vague non-places / activity verbs
  /^explore\b/i,
];

  if (badPatterns.some((rx) => rx.test(t))) return "";

  // reject long descriptive sentences — map queries should be place-like
  const wordCount = t.split(" ").filter(Boolean).length;
  if (wordCount > 14) return "";

  // reject fragments that are clearly descriptions, not place names
  if (/\b(best|ideal|perfect|great|good|enjoy|try|sample|famous|known for|avoid|arrive early|check|verify|reserve)\b/i.test(t) && wordCount > 4) return "";

  return t;
}

export function parseItineraryStops(text = "") {
  const src = String(text || "");
  if (!src.trim()) return { days: [], all: [], detectedDays: 0 };

  const lines = src.split("\n");
  const sections = [];
  let current = { day: 1, lines: [] };
  let sawExplicitDay = false;

  for (const raw of lines) {
    const line = cleanLine(raw);
    if (!line) continue;

    if (looksLikeDayHeader(line)) {
      sawExplicitDay = true;
      if (current.lines.length) sections.push(current);
      current = { day: extractDayNumber(line) || 1, lines: [] };
      continue;
    }

    // Skip itinerary header lines — these are not stops
    if (/^.+•\s+[A-Za-z]{3,9}\s+\d{1,2}(?:–\d{1,2}|–[A-Za-z]{3,9}\s+\d{1,2})/.test(line)) continue;
    if (/^Trip dates:\s*/i.test(line)) continue;
    if (/^Base:\s*/i.test(line)) continue;
    if (/^Note:\s*/i.test(line)) continue;

    current.lines.push(line);
  }

  if (current.lines.length) sections.push(current);

  if (!sawExplicitDay) {
    sections.length = 0;
    sections.push({
      day: 1,
      lines: lines.map(cleanLine).filter(Boolean),
    });
  }

  const mergedByDay = new Map();

  for (const section of sections) {
    const day = Number(section.day) || 1;
    const collected = mergedByDay.get(day) || [];

    for (const line of section.lines) {
      // Strict TravelMate format: HH:MM–HH:MM - Place Name - Description
      const strictMatch = line.match(/^\d{2}:\d{2}[–-]\d{2}:\d{2}\s+-\s+(.+?)\s+-\s+.+$/);
      if (strictMatch) {
        const place = normalizeCandidate(strictMatch[1]);
        if (place) collected.push(place);
        continue;
      }

      const stripped = stripLeadingTime(line);
      const parts = splitCandidates(stripped);

const normalizedParts = parts
  .map((p) => normalizeCandidate(p))
  .filter(Boolean);

// Pick the best “place-like” candidate from this line.
// Heuristic: prefer 2–6 words (POIs), avoid activity words.
const best = normalizedParts.sort((a, b) => {
  const wa = a.split(" ").length;
  const wb = b.split(" ").length;

  const score = (s, w) => {
    const lower = s.toLowerCase();
    let sc = 0;

    // prefer POI-ish length
    if (w >= 2 && w <= 6) sc += 3;
    if (w === 1) sc -= 1;
    if (w > 10) sc -= 3;

    // penalize activity terms
    if (/\b(tour|crawl|stroll|walk|explore|visit)\b/.test(lower)) sc -= 2;

    // reward strong POI tokens
    if (/\b(museum|church|basilica|park|fort|restaurant|cafe|lookout|temple)\b/.test(lower)) sc += 2;

    return sc;
  };

  return score(b, wb) - score(a, wa);
})[0];

if (best) collected.push(best);
    }

    mergedByDay.set(day, collected);
  }

  const days = Array.from(mergedByDay.entries())
    .map(([day, candidates]) => ({
      day,
      candidates: [...new Set(candidates)],
    }))
    .sort((a, b) => a.day - b.day);

  const all = [...new Set(days.flatMap((d) => d.candidates))];

  return {
    days,
    all,
    detectedDays: days.length,
  };
}
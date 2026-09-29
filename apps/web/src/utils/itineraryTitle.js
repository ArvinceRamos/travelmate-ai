function titleCaseWords(s) {
  return String(s || "")
    .trim()
    .replace(/\s+/g, " ")
    .split(" ")
    .map((w) => (w ? w[0].toUpperCase() + w.slice(1) : w))
    .join(" ");
}

function formatMonthDayRangeWithYear(tripStartISO, tripEndISO) {
  if (!tripStartISO || !tripEndISO) return "";

  const [ys, ms, ds] = String(tripStartISO).split("-").map((x) => Number(x));
  const [ye, me, de] = String(tripEndISO).split("-").map((x) => Number(x));
  if (!ys || !ms || !ds || !ye || !me || !de) return "";

  const monthNames = [
    "January",
    "February",
    "March",
    "April",
    "May",
    "June",
    "July",
    "August",
    "September",
    "October",
    "November",
    "December",
  ];

  const monthStart = monthNames[ms - 1] || "";
  const monthEnd = monthNames[me - 1] || "";

  // Same year
  if (ys === ye) {
    // Same month
    if (ms === me) {
      // Same day
      if (ds === de) return `${monthStart} ${ds}, ${ys}`;
      return `${monthStart} ${ds}–${de}, ${ys}`;
    }
    return `${monthStart} ${ds} – ${monthEnd} ${de}, ${ys}`;
  }

  // Cross-year
  return `${monthStart} ${ds}, ${ys} – ${monthEnd} ${de}, ${ye}`;
}

function daysBetweenInclusive(tripStartISO, tripEndISO) {
  if (!tripStartISO || !tripEndISO) return null;
  const a = new Date(tripStartISO + "T00:00:00");
  const b = new Date(tripEndISO + "T00:00:00");
  if (Number.isNaN(a.getTime()) || Number.isNaN(b.getTime())) return null;

  const diffMs = b.getTime() - a.getTime();
  const diffDays = Math.round(diffMs / (1000 * 60 * 60 * 24));
  return diffDays >= 0 ? diffDays + 1 : null;
}

function parsePlaceFromPrompt(prompt = "") {
  const p = String(prompt || "").trim();
  if (!p) return "";

  // Common patterns:
  // "Make a 3-day Manila itinerary..."
  // "Palawan 5 days: El Nido + Coron ..."
  // "Boracay 3 days"
  // Prefer first location-like phrase after removing leading commands.

  const cleaned = p
    .replace(/^make\s+(me\s+)?(a\s+)?/i, "")
    .replace(/^create\s+(me\s+)?(a\s+)?/i, "")
    .replace(/^plan\s+(me\s+)?(a\s+)?/i, "")
    .replace(/\bitinerary\b/i, "")
    .replace(/\btrip\b/i, "")
    .replace(/\btravel\s*plan\b/i, "")
    .trim();

  // If there's a colon, take left side as "topic"
  const left = cleaned.split(":")[0].trim();

  // Remove leading day count phrases like "3-day", "5 days", etc.
  const withoutDays = left
    .replace(/^\d{1,2}\s*[- ]?\s*(day|days|night|nights)\s*/i, "")
    .replace(/^\d{1,2}\s*[- ]?\s*/i, "")
    .trim();

  // Take first 1-4 capitalized words as place (fallback)
  // e.g. "El Nido + Coron" -> "El Nido"
  const plusSplit = withoutDays.split("+")[0].trim();
  const andSplit = plusSplit.split("&")[0].trim();

  // If it contains "in <place>"
  const inMatch = andSplit.match(/\bin\s+([A-Za-z][\w-]+(?:\s+[A-Za-z][\w-]+){0,3})/i);
  if (inMatch?.[1]) return titleCaseWords(inMatch[1]);

  // Remove extra descriptors in parentheses
  const noParen = andSplit.replace(/\([^)]*\)/g, "").trim();

  // Choose first chunk before comma
  const base = noParen.split(",")[0].trim();

  // If it's too long, take first 4 words
  const words = base.split(/\s+/).filter(Boolean);
  const short = words.slice(0, 4).join(" ").trim();

  return titleCaseWords(short);
}

/**
 * Create saved itinerary title:
 * PLACE • X days • Month Day–Day, YEAR
 *
 * Examples:
 * - "Manila • 3 days • February 3–5, 2027"
 * - "Palawan • 5 days • March 23–27, 2026"
 */
export function deriveItineraryTitle({ prompt = "", tripStart = null, tripEnd = null }) {
  const place = parsePlaceFromPrompt(prompt) || "Trip";
  const days = daysBetweenInclusive(tripStart, tripEnd);

  const daysLabel = days ? `${days} ${days === 1 ? "day" : "days"}` : "";
  const dateLabel = tripStart && tripEnd ? formatMonthDayRangeWithYear(tripStart, tripEnd) : "";

  const parts = [place, daysLabel, dateLabel].filter(Boolean);
  return parts.join(" • ");
}
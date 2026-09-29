/**
 * Heuristic itinerary detection:
 * We don't need “perfect AI detection” — we just need a stable rule
 * to decide when to ask: “Would you like to save this itinerary?”
 *
 * Key goals:
 * - Trigger ONLY for real day-by-day / time-block itineraries
 * - Avoid triggering for transport-only guidance, short lists, or generic tips
 * - Be stable + predictable across different writing styles
 */

export function detectItineraryText(text = "") {
  const t = String(text || "").trim();
  if (!t) return false;

  const lines = t.split("\n").map((l) => l.trim()).filter(Boolean);

  // ---------- Strong signals ----------
  // IMPORTANT (product rule):
  // Only treat something as an itinerary if it is a *multi-day* schedule.
  // A single-day “Morning/Afternoon/Evening” plan is *not* a saveable itinerary here.

  // "Day 1", "Day 2" etc. Count them (must be >= 2)
  const dayMatches = t.match(/\bDay\s*\d+\b/gi) || [];
  const hasMultiDay = dayMatches.length >= 2;

  // "Day 1:" headers (must be >= 2)
  const dayHeaderMatches = t.match(/^\s*Day\s*\d+\s*:/gmi) || [];
  const hasMultiDayHeaders = dayHeaderMatches.length >= 2;

  // Morning/Afternoon/Evening/Night blocks (must be >= 2)
  const blockMatches = t.match(/\b(Morning|Afternoon|Evening|Night)\b/gi) || [];
  const hasMultiBlocks = blockMatches.length >= 2;

  // Explicit time ranges like "9:00 AM - 11:00 AM" (must be >= 2)
  const timeRangeMatches12h =
    t.match(/\b\d{1,2}(:\d{2})?\s?(AM|PM)\b\s?(–|-|to)\s?\b\d{1,2}(:\d{2})?\s?(AM|PM)\b/gi) || [];

  // ✅ NEW: 24-hour ranges like "09:00–10:00" or "9:00 - 11:30"
  // - allows optional spaces
  // - supports –, -, and "to"
  const timeRangeMatches24h =
    t.match(/\b\d{1,2}:\d{2}\b\s?(–|-|to)\s?\b\d{1,2}:\d{2}\b/gi) || [];

  const hasMultiTimeRanges = timeRangeMatches12h.length + timeRangeMatches24h.length >= 2;

  // Bullets or numbered steps (helpful but not enough alone)
  const hasBullets = /(^|\n)\s*[-*•]\s+/.test(t);
  const hasNumbered = /(^|\n)\s*\d+\.\s+/.test(t);

  // ---------- Medium signals ----------
  // Plan verbs usually present in itineraries
  const hasPlanVerbs =
    /\b(visit|explore|go to|head to|stop at|check out|have lunch|lunch|dinner|breakfast|walk to|spend time|start at|end at|arrive|check[-\s]*in|check[-\s]*out)\b/i.test(
      t
    );

  // ---------- Negative filter: transport-only replies ----------
  // If the message is dominated by commute words and lacks itinerary structure, don't trigger.
  const transportWords =
    t.match(
      /\b(ride|bus|jeep|jeepney|train|metro|subway|ferry|terminal|platform|transfer|route|fare|stop|station|taxi|grab|uber|tricycle|van|shuttle)\b/gi
    ) || [];
  const transportHeavy = transportWords.length >= 6;

  const hasAnyItineraryStructure = hasMultiDay || hasMultiDayHeaders || hasMultiBlocks || hasMultiTimeRanges;
  if (transportHeavy && !hasAnyItineraryStructure) return false;

  // ---------- Length gate ----------
  // Avoid triggering on short replies even if they include some structure words.
  const longEnough = t.length >= 260 || lines.length >= 10;

  // ---------- Decision ----------
  // Definition (app rule):
  // - MUST be multi-day (Day 1 + Day 2 ...)
  // - MUST include time-based activity structure (either time ranges OR day-part blocks)
  // - MUST look like a schedule (bullets/numbering or plan verbs)
  const hasDays = hasMultiDay || hasMultiDayHeaders;
  const hasTimeStructure = hasMultiTimeRanges || hasMultiBlocks;
  const looksScheduled = hasBullets || hasNumbered || hasPlanVerbs;

  return hasDays && hasTimeStructure && looksScheduled && longEnough;
}

export function detectSaveableItineraryText(text = "") {
  const t = String(text || "").trim();
  if (!t) return false;

  if (/^Updated\s+Day\s+\d+\s+only\b/i.test(t)) return false;
  if (/\bTrip summary before I build it\b/i.test(t)) return false;
  if (/\b(?:stays to check|restaurant recommendations|coffee shops?|nearby options)\b/i.test(t)) return false;

  const clean = t
    .replace(/<<<MAP_STOPS_JSON>>>[\s\S]*?<<<END_MAP_STOPS_JSON>>>/g, "")
    .trim();
  const lines = clean.split("\n").map((line) => line.trim()).filter(Boolean);
  const firstLine = lines[0] || "";
  const hasTitle = Boolean(firstLine) && !/^Trip dates:/i.test(firstLine) && !/^Day\s+\d+\b/i.test(firstLine);
  const hasTripDates = /^Trip dates:\s*\d{4}-\d{2}-\d{2}\s+to\s+\d{4}-\d{2}-\d{2}/im.test(clean);
  const hasBase = /^Base:\s*.+/im.test(clean);
  const hasBudget = /\bBudget:\s*(budget|mid[-\s]?range|luxury)\b/i.test(clean);
  const dayMatches = clean.match(/(^|\n)Day\s+\d+\s+[—-]/g) || [];
  const timeRanges =
    (clean.match(/\b\d{1,2}:\d{2}\b\s?(?:–|-|to)\s?\b\d{1,2}:\d{2}\b/g) || []).length +
    (clean.match(/\b\d{1,2}(:\d{2})?\s?(?:AM|PM)\b\s?(?:–|-|to)\s?\b\d{1,2}(:\d{2})?\s?(?:AM|PM)\b/gi) || []).length;

  return hasTitle && hasTripDates && hasBase && hasBudget && dayMatches.length >= 2 && timeRanges >= 2;
}

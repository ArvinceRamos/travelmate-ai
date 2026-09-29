const {
  llmChat,
  dedupeAccommodationListsInReply,
  stripOrphanSaveItineraryPrompt,
} = require("../services/llm.service");

// Worldwide-safe normalizer: when the LLM emits a paragraph-style trip
// summary ("Destination: X Origin: Y Dates: Z Duration: ...") instead of the
// required bulleted markdown, split the inline fields back into one bullet
// per field. The fields are detected by the standard set of labels TravelMate
// always uses; no place names are hard-coded.
const TRIP_SUMMARY_FIELD_LABELS = [
  "Destination",
  "Origin",
  "Dates",
  "Date",
  "Duration",
  "Travelers",
  "Travellers",
  "Style",
  "Theme",
  "Pre-trip travel",
  "Overnight",
  "Itinerary start point",
  "Start time",
  "Start",
  "Budget",
  "Hotel/base",
  "Hotel / base",
  "Base",
  "Accommodation",
  "Accommodation budget",
  "Transport",
  "Route note",
  "Beach rule",
  "Scope note",
  "Meals",
  "Special requests",
  "Special request",
];

function bulletizeInlineTripSummary(text = "") {
  const raw = String(text || "");
  if (!raw) return raw;
  // Only act on replies that look like a trip summary.
  if (!/\b(?:Trip summary|Updated trip summary|trip summary I['’]ll use|here['’]s the trip summary)\b/i.test(raw)) {
    return raw;
  }
  const labelAlt = TRIP_SUMMARY_FIELD_LABELS
    .map((label) => label.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"))
    .join("|");
  // Field-boundary regex: `<Label>:` inside a single line, with the value
  // being everything up to the next `<Label>:` or end-of-line.
  const inlineFieldRx = new RegExp(
    String.raw`(?:^|\s)(${labelAlt})\s*:\s*([^\n]*?)(?=\s+(?:${labelAlt})\s*:|\s*$)`,
    "gi",
  );
  const lines = raw.split(/\r?\n/);
  const rebuilt = lines.map((line) => {
    const trimmed = line.trim();
    // Already a bullet, or just the heading/confirmation line — leave as-is.
    if (!trimmed) return line;
    if (/^[-*]\s/.test(trimmed)) return line;
    if (/^\*?\*?(?:Trip summary|Updated trip summary)/i.test(trimmed)) return line;
    if (/^(?:Ready for|Should I|Shall I|Want me to|Generate)\b/i.test(trimmed)) return line;
    // Count distinct field labels in this line. If there are 2+ on a single
    // line, the LLM produced the paragraph format — split into bullets.
    const matches = [...trimmed.matchAll(inlineFieldRx)];
    if (matches.length < 2) return line;
    const bullets = matches
      .map((m) => {
        const label = String(m[1] || "").trim();
        const value = String(m[2] || "").trim();
        if (!label || !value) return "";
        return `- **${label}:** ${value}`;
      })
      .filter(Boolean);
    return bullets.length ? bullets.join("\n") : line;
  });
  return rebuilt.join("\n");
}

function dedupeConsecutiveParagraphs(text = "") {
  const raw = String(text || "");
  if (!raw.trim()) return raw;

  const paragraphs = raw.split(/\n\s*\n/);
  const kept = [];
  for (const paragraph of paragraphs) {
    const trimmed = String(paragraph || "").trim();
    if (!trimmed) continue;
    const previous = kept.length ? String(kept[kept.length - 1] || "").trim() : "";
    if (previous && previous === trimmed) continue;
    kept.push(trimmed);
  }
  return kept.join("\n\n");
}

function messageLooksLikeTripBlueprint(message = {}) {
  if (message?.role !== "assistant") return false;
  const text = String(message.content || "");
  return /\btrip summary\b/i.test(text) &&
    /\bShould I generate (?:the full itinerary|this itinerary|the updated \d{1,2}-day itinerary) now\??/i.test(text);
}

function messageLooksLikeGeneratedItinerary(message = {}) {
  if (message?.role !== "assistant") return false;
  const text = String(message.content || "");
  if (/<<<MAP_STOPS_JSON>>>/i.test(text)) return true;
  return /^Day\s+\d+\s+[\u2014-]/im.test(text) &&
    /\d{2}:\d{2}\u2013\d{2}:\d{2}\s+-\s+.+?\s+-\s+.+/m.test(text);
}

function messageLooksLikeBlueprintConfirmation(message = {}) {
  if (message?.role !== "user") return false;
  const text = String(message.content || "")
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  if (/^(?:yes|yes please|yep|yeah|yup|sure|ok|okay|please|go|go ahead|proceed|do it|sige|ge|okay na|buhata na|padayon|sige na|ok ra)$/.test(text)) {
    return true;
  }
  return /^(?:(?:yes|yes please|yep|yeah|yup|sure|ok|okay|please|go ahead|proceed|do it)\s+)?(?:generate|genrate|geneate|generte|henerate|build|make|create)(?:\s+(?:the\s+)?(?:full\s+)?itinerary|\s+it)?(?:\s+now)?$/.test(text);
}

function getAlwaysKeepConversationIndices(messages = []) {
  const keep = new Set();

  for (let i = messages.length - 1; i >= 0; i -= 1) {
    if (messageLooksLikeTripBlueprint(messages[i])) {
      keep.add(i);
      break;
    }
  }

  for (let i = messages.length - 1; i >= 1; i -= 1) {
    if (messageLooksLikeBlueprintConfirmation(messages[i]) && messageLooksLikeTripBlueprint(messages[i - 1])) {
      keep.add(i - 1);
      keep.add(i);
      break;
    }
  }

  for (let i = messages.length - 1; i >= 0; i -= 1) {
    if (messageLooksLikeGeneratedItinerary(messages[i])) {
      keep.add(i);
      break;
    }
  }

  return keep;
}

function trimConversationPreservingTripState(messages = [], maxMessages = 40) {
  const list = Array.isArray(messages) ? messages : [];
  if (list.length <= maxMessages) return list;

  const keep = new Set();
  list.forEach((m, index) => {
    if (m?.role === "system") keep.add(index);
  });
  for (const index of getAlwaysKeepConversationIndices(list)) keep.add(index);

  for (let i = list.length - 1; i >= 0 && keep.size < maxMessages; i -= 1) {
    keep.add(i);
  }

  return list.filter((_, index) => keep.has(index));
}

function isValidTripStatePlaceHint(value = "") {
  const raw = String(value || "").trim();
  if (!raw) return false;
  if (/[?]/.test(raw)) return false;

  const words = raw.split(/\s+/).filter(Boolean);
  if (words.length < 1 || words.length > 5) return false;

  const normalized = raw
    .toLowerCase()
    .replace(/[^a-z0-9\s'-]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  if (!normalized) return false;

  if (/^(?:go|do|please|yes|no|sure|ok|okay|give|show|plan|make|build|create)\b/.test(normalized)) {
    return false;
  }
  if (/\b(?:for|with|to|near|around)$/.test(normalized)) {
    return false;
  }

  return true;
}

function sanitizeTripStatePlaceHints(tripState = {}) {
  const sanitized = { ...(tripState && typeof tripState === "object" ? tripState : {}) };
  for (const field of ["area", "city"]) {
    const value = String(sanitized[field] || "").trim();
    if (!value) continue;
    if (!isValidTripStatePlaceHint(value)) {
      console.log(`[intake] rejected trip_state.${field} as user-message text:`, { value });
      delete sanitized[field];
    }
  }
  return sanitized;
}

async function chatHandler(req, res) {
  try {
    const message = (req.body?.message || "").trim();
    const messages = Array.isArray(req.body?.messages) ? req.body.messages : null;

    if (!message && !messages?.length) {
      return res.status(400).json({ reply: "Please type a travel question." });
    }

    let normalizedMessages =
      messages?.length
        ? messages
        : [
            {
              role: "user",
              content: message,
            },
          ];
    normalizedMessages = trimConversationPreservingTripState(normalizedMessages, 40);

    // Forward app context (timezone, date, location) and user profile to llmChat
    const rawTripState = req.body?.trip_state && typeof req.body.trip_state === "object" ? req.body.trip_state : {};
    const tripState = sanitizeTripStatePlaceHints(rawTripState);
    const appContext = tripState.app_context && typeof tripState.app_context === "object" ? tripState.app_context : {};
    const rawLocation = tripState.location && typeof tripState.location === "object" ? tripState.location : null;
    const userProfile = tripState.userProfile && typeof tripState.userProfile === "object" ? tripState.userProfile : null;

    // Reshape flat { lat, lng, ... } into the nested structure llmChat expects:
    // { exact: { lat, lng }, typedArea: "...", selectedPlace: { ... } }
    const locationContext = {};
    if (rawLocation && Number.isFinite(Number(rawLocation.lat)) && Number.isFinite(Number(rawLocation.lng))) {
      locationContext.exact = {
        lat: Number(rawLocation.lat),
        lng: Number(rawLocation.lng),
      };
    }
    if (tripState.area) {
      locationContext.typedArea = String(tripState.area);
    }
    if (tripState.selectedPlace && typeof tripState.selectedPlace === "object") {
      locationContext.selectedPlace = tripState.selectedPlace;
    }

    let rawReply = await llmChat(normalizedMessages, {
      appContext: { ...appContext, location: locationContext },
      userProfile,
      tripState,
    });

    if (/Updated\s+Day/i.test(rawReply) && !/<<<MAP_STOPS_JSON>>>/i.test(rawReply)) {
      rawReply = await llmChat(
        [
          ...normalizedMessages,
          { role: "assistant", content: rawReply },
          {
            role: "system",
            content:
              "Your previous reply only showed a day patch. Reprint the complete itinerary now: header + every day + MAP_STOPS_JSON + 'Would you like to save this itinerary?'.",
          },
          {
            role: "user",
            content: "Reprint the complete itinerary now.",
          },
        ],
        {
          appContext: { ...appContext, location: locationContext },
          userProfile,
          tripState,
        }
      );
    }

    // Strip duplicate accommodation/lodging lists. The LLM occasionally
    // produces two stay lists in the same reply (one summary + one
    // "Under PHP X" repeat). Keep the first list only.
    let reply = rawReply;
    try {
      const next = dedupeAccommodationListsInReply(rawReply);
      if (next && next !== rawReply) reply = next;
    } catch (e) {
      console.warn("[chat] lodging dedupe failed:", String(e?.message || e || ""));
    }

    // Fix #5: Strip "Would you like to save this itinerary?" from any reply
    // that isn't a final, saveable itinerary. The frontend uses that exact
    // phrase to render the Save/Edit/Not now buttons; without this guard
    // those buttons appear on trip summaries, draft updates, hotel
    // recommendations, and partial Day-N edit confirmations.
    try {
      const stripped = stripOrphanSaveItineraryPrompt(reply);
      if (stripped && stripped !== reply) reply = stripped;
    } catch (e) {
      console.warn("[chat] orphan save-prompt strip failed:", String(e?.message || e || ""));
    }

    // Guarantee bulleted trip-summary format even if the LLM emitted a
    // paragraph version. Worldwide-safe — operates on the standard field
    // labels only.
    try {
      const bulleted = bulletizeInlineTripSummary(reply);
      if (bulleted && bulleted !== reply) reply = bulleted;
    } catch (e) {
      console.warn("[chat] trip-summary bulletizer failed:", String(e?.message || e || ""));
    }

    reply = dedupeConsecutiveParagraphs(reply);

    return res.json({ reply });
  } catch (err) {
    console.error("chatHandler error:", err);
    return res.status(500).json({
      reply: `Backend error: ${err?.message || "Unknown error"}`,
    });
  }
}

module.exports = { chatHandler, dedupeConsecutiveParagraphs };

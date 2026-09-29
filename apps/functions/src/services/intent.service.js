"use strict";

const { settingsFor } = require("./aiProvider.service");

const DEFAULT_INTENT_MODEL = settingsFor().model;
const INTENT_ROUTER_TIMEOUT_MS = 6000;
const MAX_CONTEXT_MESSAGES = 10;
const MAX_MESSAGE_CHARS = 1500;

const INTENT_VALUES = [
  "itinerary_planning",
  "itinerary_edit",
  "itinerary_followup",
  "place_search",
  "specific_place_status",
  "route_guidance",
  "accommodation_recommendation",
  "budget_or_cost_question",
  "packing_or_travel_advice",
  "saved_profile_question",
  "booking_transaction_request",
  "non_travel",
  "unclear",
];

const NEXT_ACTION_VALUES = [
  "answer_directly",
  "ask_clarifying_question",
  "use_live_places",
  "use_route_guidance",
  "generate_itinerary",
  "edit_itinerary",
  "refuse_booking_only",
  "refuse_non_travel",
  "fallback_regex",
];

const MISSING_FIELD_VALUES = [
  "destination",
  "duration",
  "date",
  "travelers",
  "theme",
  "budget",
  "origin",
  "start_time",
  "base_area",
  "transport",
  "breakfast",
  "place_name",
  "place_type",
  "route_origin",
  "route_destination",
];

const RISK_FLAG_VALUES = [
  "booking_or_payment",
  "needs_live_data",
  "location_missing",
  "ambiguous_followup",
  "possible_non_travel",
  "low_confidence",
];

const SEMANTIC_INTENT_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: [
    "intent",
    "confidence",
    "isFollowUp",
    "nextAction",
    "shouldUseLivePlaces",
    "shouldGenerateItinerary",
    "missingFields",
    "riskFlags",
    "entities",
    "contextReferences",
    "rationale",
  ],
  properties: {
    intent: { type: "string", enum: INTENT_VALUES },
    confidence: { type: "number", minimum: 0, maximum: 1 },
    isFollowUp: { type: "boolean" },
    nextAction: { type: "string", enum: NEXT_ACTION_VALUES },
    shouldUseLivePlaces: { type: "boolean" },
    shouldGenerateItinerary: { type: "boolean" },
    missingFields: {
      type: "array",
      items: { type: "string", enum: MISSING_FIELD_VALUES },
    },
    riskFlags: {
      type: "array",
      items: { type: "string", enum: RISK_FLAG_VALUES },
    },
    entities: {
      type: "object",
      additionalProperties: false,
      required: [
        "destination",
        "origin",
        "dateText",
        "dateIso",
        "durationDays",
        "travelers",
        "budget",
        "theme",
        "placeName",
        "placeType",
        "routeOrigin",
        "routeDestination",
      ],
      properties: {
        destination: { type: ["string", "null"] },
        origin: { type: ["string", "null"] },
        dateText: { type: ["string", "null"] },
        dateIso: { type: ["string", "null"] },
        durationDays: { type: ["number", "null"] },
        travelers: { type: ["string", "null"] },
        budget: { type: ["string", "null"] },
        theme: { type: ["string", "null"] },
        placeName: { type: ["string", "null"] },
        placeType: { type: ["string", "null"] },
        routeOrigin: { type: ["string", "null"] },
        routeDestination: { type: ["string", "null"] },
      },
    },
    contextReferences: {
      type: "object",
      additionalProperties: false,
      required: ["lastPlace", "hasActiveItinerary", "hasActiveRoute"],
      properties: {
        lastPlace: { type: ["string", "null"] },
        hasActiveItinerary: { type: "boolean" },
        hasActiveRoute: { type: "boolean" },
      },
    },
    rationale: {
      type: "string",
      description: "One short non-sensitive reason for the selected intent.",
    },
  },
};

function getSemanticIntentRouterMode() {
  const raw = String(process.env.SEMANTIC_INTENT_ROUTER_MODE || "").trim().toLowerCase();
  if (["off", "shadow", "route"].includes(raw)) return raw;
  return process.env.FUNCTIONS_EMULATOR === "true" || process.env.FIREBASE_EMULATOR_HUB
    ? "shadow"
    : "shadow";
}

function truncateText(value, max = MAX_MESSAGE_CHARS) {
  const text = String(value || "").replace(/\s+/g, " ").trim();
  if (!text) return "";
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

function compactMessages(messages = []) {
  return [...messages]
    .filter((m) => m && (m.role === "user" || m.role === "assistant") && m.content)
    .slice(-MAX_CONTEXT_MESSAGES)
    .map((m) => ({
      role: m.role,
      content: truncateText(m.content),
    }));
}

function compactContext({ appContext = {}, continuity = {}, placesContext = null } = {}) {
  return {
    timezone: String(appContext?.timezone || "").trim() || null,
    todayISO: String(appContext?.todayISO || "").trim() || null,
    hasExactLocation: Boolean(appContext?.location?.exact),
    typedArea: truncateText(appContext?.location?.typedArea || "", 160) || null,
    selectedPlace:
      truncateText(appContext?.location?.selectedPlace?.anchorText || "", 220) || null,
    regexFollowUpIntent: String(continuity?.followUpIntent || "").trim() || null,
    hasActiveItinerary: Boolean(continuity?.itineraryContext?.hasActiveItinerary),
    hasActiveRoute: Boolean(continuity?.activeRouteContext),
    activeRoute: continuity?.activeRouteContext
      ? {
          origin: truncateText(continuity.activeRouteContext.origin || "", 160) || null,
          destination: truncateText(continuity.activeRouteContext.destination || "", 160) || null,
        }
      : null,
    placesContext: placesContext
      ? {
          query: truncateText(placesContext.query || "", 220) || null,
          lastSpecificPlaceName:
            truncateText(placesContext.lastSpecificPlaceName || "", 180) || null,
          placeType: truncateText(placesContext.placeType?.type || "", 80) || null,
          areaHint: truncateText(placesContext.areaHint || "", 160) || null,
        }
      : null,
  };
}

function normalizeIntentResult(value) {
  if (!value || typeof value !== "object") return null;

  const confidence = Number(value.confidence);
  const intent = INTENT_VALUES.includes(value.intent) ? value.intent : "unclear";
  const nextAction = NEXT_ACTION_VALUES.includes(value.nextAction)
    ? value.nextAction
    : "fallback_regex";

  return {
    intent,
    confidence: Number.isFinite(confidence) ? Math.max(0, Math.min(1, confidence)) : 0,
    isFollowUp: Boolean(value.isFollowUp),
    nextAction,
    shouldUseLivePlaces: Boolean(value.shouldUseLivePlaces),
    shouldGenerateItinerary: Boolean(value.shouldGenerateItinerary),
    missingFields: Array.isArray(value.missingFields)
      ? value.missingFields.filter((field) => MISSING_FIELD_VALUES.includes(field))
      : [],
    riskFlags: Array.isArray(value.riskFlags)
      ? value.riskFlags.filter((flag) => RISK_FLAG_VALUES.includes(flag))
      : [],
    entities: value.entities && typeof value.entities === "object" ? value.entities : {},
    contextReferences:
      value.contextReferences && typeof value.contextReferences === "object"
        ? value.contextReferences
        : {},
    rationale: truncateText(value.rationale || "", 240),
  };
}

function normalizeShortIntentText(value = "") {
  return String(value || "")
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function tokenCount(value = "") {
  const text = normalizeShortIntentText(value);
  return text ? text.split(/\s+/).filter(Boolean).length : 0;
}

function levenshteinDistance(a = "", b = "") {
  const left = String(a || "");
  const right = String(b || "");
  if (left === right) return 0;
  if (!left) return right.length;
  if (!right) return left.length;
  const prev = Array.from({ length: right.length + 1 }, (_, index) => index);
  const curr = Array(right.length + 1).fill(0);
  for (let i = 1; i <= left.length; i += 1) {
    curr[0] = i;
    for (let j = 1; j <= right.length; j += 1) {
      const cost = left[i - 1] === right[j - 1] ? 0 : 1;
      curr[j] = Math.min(
        curr[j - 1] + 1,
        prev[j] + 1,
        prev[j - 1] + cost
      );
    }
    for (let j = 0; j <= right.length; j += 1) prev[j] = curr[j];
  }
  return prev[right.length];
}

function matchesAny(message = "", phrases = [], options = {}) {
  const cleanComparable = (value = "") => normalizeShortIntentText(value)
    .replace(/\b(?:please|pls|plz|lang|na)\b/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  const normalized = cleanComparable(message);
  if (!normalized) return false;
  const tokens = normalized.split(/\s+/).filter(Boolean);
  for (const phrase of phrases) {
    const p = cleanComparable(phrase);
    if (!p) continue;
    if (normalized === p || normalized.includes(p)) return true;
    if (options.allowTypos === true && !p.includes(" ") && tokens.some((token) => levenshteinDistance(token, p) <= 2)) {
      return true;
    }
  }
  return false;
}

function containsEnglishPlaceName(message = "") {
  const raw = String(message || "").trim();
  const normalized = normalizeShortIntentText(raw);
  if (!normalized) return false;
  if (/\b(?:garden|falls|beach|mall|market|park|cafe|coffee|restaurant|airport|church|basilica|fort|cross|temple|shrine|hotel|resort|island|city|pier|port|terminal)\b/i.test(normalized)) {
    return true;
  }
  return /\b[A-Z][a-z]+(?:\s+[A-Z][a-z]+){1,3}\b/.test(raw);
}

function buildDeterministicIntentResult(intent, subtype, nextAction) {
  return {
    intent,
    subtype,
    confidence: 0.99,
    isFollowUp: true,
    nextAction,
    shouldUseLivePlaces: false,
    shouldGenerateItinerary: false,
    missingFields: [],
    riskFlags: [],
    entities: {},
    contextReferences: {
      lastPlace: null,
      hasActiveItinerary: true,
      hasActiveRoute: false,
    },
    rationale: `Deterministic short active-itinerary ${subtype} routing.`,
  };
}

async function classifyTravelIntent({
  client,
  messages = [],
  lastUser = "",
  appContext = {},
  continuity = {},
  placesContext = null,
} = {}) {
  if (!client || !lastUser) return null;

  const hasActiveItinerary = Boolean(continuity?.itineraryContext?.hasActiveItinerary);
  if (hasActiveItinerary) {
    const activeAddEditRx = /^(?:add|include|put|insert|throw\s+in|squeeze\s+in|can\s+you\s+add|could\s+you\s+add|please\s+add|i\s+want\s+to\s+(?:visit|see|go\s+to|add))\s+/i;
    const activeRemoveEditRx = /^(?:remove|drop|delete|take\s+out|cut|skip|kuhaa|tangtang)\s+/i;
    if (activeAddEditRx.test(String(lastUser || "").trim()) || activeRemoveEditRx.test(String(lastUser || "").trim())) {
      return buildDeterministicIntentResult("itinerary_edit", "active_add_remove", "edit_itinerary");
    }

    const cebuanoConfirm = ["sige", "ge", "okay na", "buhata na", "padayon", "sige na", "ok ra"];
    const cebuanoEdit = ["pulihi", "usba", "kuhaa", "ayaw na", "hay ambot"];
    const englishConfirm = ["yes", "yse", "yep", "ok", "okay", "sure", "go", "do it", "proceed", "sounds good"];
    const shortEnough = tokenCount(lastUser) <= 4;
    const hasEditCue = /\b(?:remove|delete|drop|replace|change|edit|fix|pulihi|usba|kuhaa|ayaw\s+na|hay\s+ambot)\b/i.test(
      normalizeShortIntentText(lastUser)
    );

    if ((shortEnough && matchesAny(lastUser, cebuanoEdit)) || hasEditCue) {
      return buildDeterministicIntentResult("itinerary_edit", "short_cebuano", "edit_itinerary");
    }
    if (
      shortEnough &&
      (matchesAny(lastUser, cebuanoConfirm) || matchesAny(lastUser, englishConfirm, { allowTypos: true }))
    ) {
      return buildDeterministicIntentResult("itinerary_followup", "edit_confirm", "edit_itinerary");
    }
    if (shortEnough && !containsEnglishPlaceName(lastUser)) {
      return buildDeterministicIntentResult("itinerary_followup", "clarify", "answer_directly");
    }
  }

  const model = String(
    process.env.AI_MODEL || DEFAULT_INTENT_MODEL
  ).trim();

  const classifierMessages = [
    {
      role: "system",
      content:
        "You are TravelMate's semantic intent router. Classify the user's latest travel-app message using conversation context. Do not answer the user. Return only the structured schema. Prefer meaning over keywords. If the user is continuing an active trip, place, route, or itinerary flow with a short reply, mark it as a follow-up.",
    },
    {
      role: "user",
      content: JSON.stringify({
        latestUserMessage: truncateText(lastUser, 2000),
        recentConversation: compactMessages(messages),
        appAndConversationContext: compactContext({
          appContext,
          continuity,
          placesContext,
        }),
        intentDefinitions: {
          itinerary_planning: "The user wants to start or continue building a new trip plan or itinerary.",
          itinerary_edit: "The user wants to modify the active itinerary.",
          itinerary_followup: "The user asks about, confirms, rejects, or continues the active itinerary.",
          place_search: "The user wants recommendations or search results for places, food, hotels, attractions, or nearby options.",
          specific_place_status: "The user asks about one specific place's hours, open status, branch, address, or availability-like status.",
          route_guidance: "The user asks how to get from one place to another or asks route follow-up questions.",
          accommodation_recommendation: "The user wants hotels, hostels, resorts, lodging, or where-to-stay recommendations, not a day-by-day itinerary.",
          budget_or_cost_question: "The user asks about travel cost, budget, price range, total, or affordability.",
          packing_or_travel_advice: "The user asks general travel advice such as packing, safety, etiquette, SIM cards, or best time.",
          saved_profile_question: "The user asks about their saved preferences, profile, interests, or memory.",
          booking_transaction_request: "The user asks to book, reserve, pay, purchase, or complete a transaction.",
          non_travel: "The user asks for something outside travel assistance.",
          unclear: "The intent cannot be determined confidently.",
        },
      }),
    },
  ];

  const completion = await client.chat.completions.create(
    {
      model,
      messages: classifierMessages,
      temperature: 0.1,
      max_completion_tokens: 600,
      response_format: {
        type: "json_schema",
        json_schema: {
          name: "travelmate_semantic_intent",
          strict: true,
          schema: SEMANTIC_INTENT_SCHEMA,
        },
      },
    },
    { timeout: INTENT_ROUTER_TIMEOUT_MS }
  );

  const content = completion?.choices?.[0]?.message?.content || "";
  if (!content) return null;

  try {
    return normalizeIntentResult(JSON.parse(content));
  } catch (error) {
    console.warn("[semantic-intent] failed to parse structured output", {
      err: String(error?.message || error || ""),
    });
    return null;
  }
}

async function classifyTravelIntentShadow(args = {}) {
  const mode = getSemanticIntentRouterMode();
  if (mode === "off") return null;

  try {
    const result = await classifyTravelIntent(args);
    if (result) {
      console.log("[semantic-intent]", {
        mode,
        intent: result.intent,
        confidence: result.confidence,
        isFollowUp: result.isFollowUp,
        nextAction: result.nextAction,
        missingFields: result.missingFields,
        shouldUseLivePlaces: result.shouldUseLivePlaces,
        shouldGenerateItinerary: result.shouldGenerateItinerary,
        riskFlags: result.riskFlags,
        rationale: result.rationale,
      });
    }
    return result;
  } catch (error) {
    console.warn("[semantic-intent] shadow classification failed", {
      err: String(error?.message || error || ""),
    });
    return null;
  }
}

module.exports = {
  classifyTravelIntent,
  classifyTravelIntentShadow,
  getSemanticIntentRouterMode,
  SEMANTIC_INTENT_SCHEMA,
};

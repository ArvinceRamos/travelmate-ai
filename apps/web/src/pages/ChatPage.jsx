import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useLocation, useNavigate, useParams } from "react-router-dom";
import toast from "react-hot-toast";
import { sendChat } from "../services/apiClient";
import { useAuth } from "../hooks/useAuth";
import { useGeolocation } from "../hooks/useGeolocation";
import { addMessage, createChat, getChat, setChatTitleOnce, subscribeMessages } from "../services/chatService";
import ChatPanel from "../components/chat/ChatPanel.jsx";
import AuthModal from "../components/auth/AuthModal.jsx";
import { useChatUi } from "../store/chatUiContext.jsx";
import { useItinerary } from "../features/itinerary/itineraryStore.jsx";
import { detectSaveableItineraryText } from "../utils/itineraryDetect";
import { deriveItineraryTitle } from "../utils/itineraryTitle";
import { useMaps } from "../features/maps/mapsStore.jsx";
import { useComposerDraft } from "../store/composerDraftContext.jsx";
import { getChatRequestKey, isChatRequestActive, useChatRequests } from "../store/chatRequestContext.jsx";

const GREETINGS = ["Where are you traveling?", "How can I help you today?", "What's on your mind?"];
const SUBTITLE = "Your AI-driven travel planning assistant";

const SUGGESTIONS = [
  {
    emoji: "🍜",
    title: "3-day Manila itinerary",
    subtitle: "Food + history, mid-range budget",
    prompt: "Make a 3-day Manila itinerary (food + history, mid-range budget).",
  },
  {
    emoji: "🏝️",
    title: "Weekend Cebu plan",
    subtitle: "Beaches + city highlights + commute tips",
    prompt: "Weekend Cebu plan: beaches + city highlights + commute tips.",
  },
  {
    emoji: "🏔️",
    title: "Baguio day trip",
    subtitle: "Best route + timing + food stops",
    prompt: "Baguio day trip from Manila: route options + timing + food stops.",
  },
  {
    emoji: "🚤",
    title: "Palawan 5 days",
    subtitle: "El Nido + Coron, balanced itinerary",
    prompt: "Palawan 5 days: El Nido + Coron (balanced itinerary).",
  },
  {
    emoji: "🏄",
    title: "Siargao 3 days",
    subtitle: "Surf-friendly + best time to visit",
    prompt: "Siargao 3 days: best time to go + surfing-friendly plan.",
  },
  {
    emoji: "🛡️",
    title: "Solo travel safety",
    subtitle: "Cebu City night transport tips",
    prompt: "Solo traveler safety tips for Cebu City (night transport + areas to avoid).",
  },
];

const MAP_JSON_START = "<<<MAP_STOPS_JSON>>>";
const MAP_JSON_END = "<<<END_MAP_STOPS_JSON>>>";

const DEVICE_LOCATION_TRIGGER_RX =
  /\b(?:near me|nearby|around me|close to me|near my location|from here|open nearby|closest to me|nearest to me|use my current location|based on my location)\b/i;

function normalizeTypedAreaAlias(value = "") {
  const trimmed = String(value || "").trim();
  const key = trimmed.toLowerCase().replace(/[^a-z0-9]+/g, " ").replace(/\s+/g, " ").trim();
  if (/^lapu\s*2$/.test(key) || /^lapu\s+lapu(?:\s+city)?$/.test(key)) {
    return "Lapu-Lapu City";
  }
  return trimmed;
}

function cleanTypedAreaCandidate(value = "") {
  return normalizeTypedAreaAlias(
    String(value || "")
      .split(/[?!;]|\b(?:please|pls|plz|thanks?|thank you)\b/i)[0]
      .replace(/^(?:the|a|an)\s+/i, "")
      .replace(/\b(open now|open nearby|currently open|right now|open late|walking distance|inside this area only|inside the area only|from here|nearest|closest)\b/gi, "")
      .replace(/\s+/g, " ")
      .trim()
      .replace(/[.,:-]+$/, "")
  );
}

function isGenericDeviceLocationAnchor(value = "") {
  return ["me", "here", "near", "around", "close to", "nearest", "closest", "near me", "nearby", "my location", "current location", "my current location"].includes(
    String(value || "").trim().toLowerCase()
  );
}

function extractProximityPlaceAnchor(text) {
  const raw = String(text || "").trim();
  if (!raw) return "";

  const m = raw.match(
    /\b(?:nearby|near|around|close\s+to|closest\s+to|nearest\s+to|nearest|closest)\s+(?:the\s+|a\s+|an\s+)?([\p{L}\p{N}][\p{L}\p{N}&'’./ -]{0,80})/iu
  );
  const candidate = cleanTypedAreaCandidate(m ? m[1] : "");
  if (!candidate) return "";
  if (isGenericDeviceLocationAnchor(candidate)) return "";
  if (isCommandOnlyAreaCandidate(candidate)) return "";
  if (/^(?:coffee|coffee shops?|cafes?|restaurants?|food|hotels?|hostels?|places?|branches?)$/i.test(candidate)) return "";
  return candidate;
}

function isItineraryRepairOrHoursFollowUp(text) {
  const raw = String(text || "");
  return (
    /\b(?:regenerate|regen|rebuild|recreate|redo|repair|fix|resolve|honor|honour|respect|enforce|reschedule|re-?plan|re-?make|re-?do|re-?build|re-?generate)\b/i.test(raw) ||
    /\b(?:provider[- ]?supported|provider[- ]?backed|provider\s+hours|opening\s+hours|operating\s+hours|business\s+hours|closing\s+hours|closing\s+time|valid\s+(?:itinerary|plan|hours|times?))\b/i.test(raw) ||
    /\baround\s+(?:the\s+)?(?:provider|opening|operating|business|supported)(?:[- ]?supported)?\s*(?:opening\s+)?hours\b/i.test(raw) ||
    /\b(?:no\s+(?:time|schedule|schedul(?:e|ing)|hours|opening)\s*conflicts?|conflict[- ]?free|without\s+conflicts?)\b/i.test(raw) ||
    /\b(?:in|to|from)\s+the\s+(?:itinerary|plan|trip|schedule)\b/i.test(raw)
  );
}

function classifyLocationIntent(text) {
  const raw = String(text || "").trim();
  if (!raw || isItineraryRepairOrHoursFollowUp(raw)) return { mode: "none", anchor: "" };

  const anchor = extractProximityPlaceAnchor(raw);
  if (anchor) return { mode: "typed_anchor", anchor };

  const typedArea = extractTypedAreaHint(raw);
  if (typedArea) return { mode: "typed_anchor", anchor: typedArea };

  if (DEVICE_LOCATION_TRIGGER_RX.test(raw)) return { mode: "gps", anchor: "" };
  if (/\b(?:near|around|close\s+to|closest\s+to|nearest\s+to|nearest|closest)\s*(?:[.?!,;:]|please|pls|plz)?\s*$/i.test(raw)) {
    return { mode: "clarify_area", anchor: "" };
  }

  return { mode: "none", anchor: "" };
}

function looksLikeLocationRequiredNearbyQuery(text) {
  return classifyLocationIntent(text).mode === "gps";
}

function looksLikeDeviceLocationIntent(text) {
  return classifyLocationIntent(text).mode === "gps";
}

function looksLikeCurrentLocationQuestion(text) {
  return /\b(?:use my current location|based on my location)\b/i.test(String(text || ""));
}

function looksLikeDeviceLocationSuppression(text) {
  return /\b(?:i(?:'m| am)\s+not\s+asking\s+(?:near\s+me|for\s+(?:my|device|current)\s+location)|not\s+asking\s+near\s+me|i\s+mean\s+near\s+[\p{L}\p{N}])/iu.test(
    String(text || "")
  );
}

function looksLikeDeviceLocationSuppressionReset(text) {
  return /\b(?:near me|use my current location)\b/i.test(String(text || ""));
}

const PLACES_CONTINUATION_RX =
  /^(?:show(?:\s+me)?(?:\s+\d+)?(?:\s+more)?|\d+\s+more|more|more please|another|another one|other options|more options|closest|nearest|open late|open now|currently open|24\s*hours?|24\/7|cheapest|best value|how many more|how many can you add)$/i;

function looksLikePlacesContinuationMessage(text) {
  return PLACES_CONTINUATION_RX.test(String(text || "").trim());
}

function hasRecentTrustedNearbyContext(messages = []) {
  const recentUserMessages = [...(Array.isArray(messages) ? messages : [])]
    .filter((entry) => entry?.role === "user")
    .slice(-6);

  return recentUserMessages.some((entry) => {
    const content = String(entry?.content || "").trim();
    if (!content) return false;
    return looksLikeLocationRequiredNearbyQuery(content);
  });
}

function isCommandOnlyAreaCandidate(value = "") {
  const normalized = String(value || "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/gi, " ")
    .replace(/\s+/g, " ")
    .trim();

  if (!normalized) return false;

  return (
    /^(more|more please|another|another one|other options?|more options?|show me more|give me more)$/.test(normalized) ||
    /^(closest|nearest|open now|currently open|open late|from here|cheapest|lowest price|best value)$/.test(normalized) ||
    /^(which|what|who|where|when|why|how)\s+(?:one|ones|is|are|branch|branches|place|places)\b/.test(normalized) ||
    /^(is|are|do|does|did|can|could|would|should)\b/.test(normalized) ||
    /^(tell me|show me|give me|provide me|check if|confirm if)\b/.test(normalized)
  );
}

function extractTypedAreaHint(text) {
  const raw = String(text || "").trim();
  if (!raw) return "";
  if (looksLikeCurrentLocationQuestion(raw)) return "";

  const cleanAreaCandidate = (value = "") =>
    normalizeTypedAreaAlias(
      String(value || "")
        .replace(/^(?:could|can|would)\s+you\s+(?:please\s+)?(?:check|confirm|tell\s+me|look\s+up)\s+(?:if|whether)\s+/i, "")
        .replace(/^(?:provide|give|show|tell)\s+me\s+(?:the\s+)?(?:place|places|branch|branches|location|locations)\s+(?:of|for)\s+/i, "")
        .replace(/\b(open now|open nearby|currently open|right now|open late|walking distance|inside this area only|inside the area only|from here|nearest|closest)\b/gi, "")
        .replace(/\s+/g, " ")
        .trim()
        .replace(/[.,;-]+$/, "")
    );

  const isGenericLocationWord = (value = "") =>
    ["me", "here", "near", "around", "close to", "nearest", "closest", "my location", "current location", "near me", "nearby"].includes(
      String(value || "").trim().toLowerCase()
    );

  const isQuestionLikeFragment = (value = "") =>
    /^(which|what|who|where|when|why|how|is|are|do|does|did|can|could|would|should|tell me|show me|give me|provide me|check if|confirm if)\b/i.test(
      String(value || "").trim()
    );

  const m =
    raw.match(/\bnear me in\s+([\p{L}\p{N}][\p{L}\p{N}&'’./ -]{0,80})/iu) ||
    raw.match(/\b(?:nearby|near|around|close\s+to|closest\s+to|nearest\s+to|nearest|closest)\s+(?!me\b|my\s+location\b|current\s+location\b|here\b)([\p{L}\p{N}][\p{L}\p{N}&'’./ -]{0,80})/iu) ||
    raw.match(/\bin\s+([\p{L}\p{N}][\p{L}\p{N}&'’./ -]{0,80})/iu) ||
    raw.match(/\bat\s+([\p{L}\p{N}][\p{L}\p{N}&'’./ -]{0,80})/iu);

  const candidate = cleanAreaCandidate(m ? m[1] : "");
  if (candidate && !isGenericLocationWord(candidate) && !isCommandOnlyAreaCandidate(candidate) && !isQuestionLikeFragment(candidate)) {
    return candidate;
  }

  const bare = cleanAreaCandidate(raw);
  if (!bare) return "";
  if (isGenericLocationWord(bare)) return "";
  if (isCommandOnlyAreaCandidate(bare)) return "";
  if (isQuestionLikeFragment(bare)) return "";
  if (/\b(cafe|cafes|coffee|coffee shop|coffee shops|restaurant|restaurants|bakery|bakeries|bar|bars|hotel|hotels|hostel|hostels|pharmacy|pharmacies|convenience store|convenience stores)\b/i.test(bare)) {
    return "";
  }

  const wordCount = bare.split(/\s+/).filter(Boolean).length;
  if (wordCount >= 1 && wordCount <= 6) {
    return bare;
  }

  return "";
}

function extractParenthesizedPlaceContext(text) {
  const raw = String(text || "").trim();
  if (!raw) return null;

  const m = raw.match(/^([^()]+?)\s*\(([^()]+)\)/);
  if (!m) return null;

  const label = String(m[1] || "").trim();
  const address = String(m[2] || "").trim();

  if (!label && !address) return null;

  return {
    label,
    address,
    anchorText: [label, address].filter(Boolean).join(", "),
  };
}

function buildTrustedLocationTripState(baseTripState = {}, location, typedArea = "") {
  const nextTripState = {
    ...(baseTripState && typeof baseTripState === "object" ? baseTripState : {}),
  };

  if (typedArea) {
    nextTripState.area = typedArea;
    nextTripState.city = nextTripState.city || typedArea;
  }

  if (location && Number.isFinite(Number(location.lat)) && Number.isFinite(Number(location.lng))) {
    nextTripState.location = {
      lat: Number(location.lat),
      lng: Number(location.lng),
      accuracyMeters: Number.isFinite(Number(location.accuracyMeters)) ? Number(location.accuracyMeters) : null,
      capturedAt: Number(location.capturedAt || Date.now()),
      source: String(location.source || "device"),
      permissionState: String(location.permissionState || "granted"),
      trustedExact: location.trustedExact === true || String(location.permissionState || "").toLowerCase() === "granted",
    };

    nextTripState.deviceLocation = nextTripState.location;
    nextTripState.app_context = {
      ...(nextTripState.app_context && typeof nextTripState.app_context === "object" ? nextTripState.app_context : {}),
      location: nextTripState.location,
    };
  }

  return nextTripState;
}

const THREAD_LOCATION_PREFIX = "tm_thread_trusted_location_v1:";
const THREAD_PENDING_STATE_PREFIX = "tm_thread_pending_state_v1:";
const GUEST_THREAD_TOKEN_KEY = "tm_guest_thread_token_v1";
const THREAD_PENDING_MAX_AGE_MS = 20 * 60 * 1000;

function makeGuestThreadToken() {
  return `${Date.now()}_${Math.random().toString(36).slice(2, 10)}`;
}

function getGuestThreadToken() {
  if (typeof window === "undefined") return "guest";

  let token = window.sessionStorage.getItem(GUEST_THREAD_TOKEN_KEY);
  if (!token) {
    token = makeGuestThreadToken();
    window.sessionStorage.setItem(GUEST_THREAD_TOKEN_KEY, token);
  }

  return token;
}

function rotateGuestThreadToken() {
  if (typeof window === "undefined") return;
  window.sessionStorage.setItem(GUEST_THREAD_TOKEN_KEY, makeGuestThreadToken());
}

function getThreadLocationStorageKey(chatId = null) {
  return chatId
    ? `${THREAD_LOCATION_PREFIX}chat:${chatId}`
    : `${THREAD_LOCATION_PREFIX}guest:${getGuestThreadToken()}`;
}

function getThreadPendingStateStorageKey(chatId = null) {
  return chatId
    ? `${THREAD_PENDING_STATE_PREFIX}chat:${chatId}`
    : `${THREAD_PENDING_STATE_PREFIX}guest:${getGuestThreadToken()}`;
}

function readThreadTrustedLocation(chatId = null, maxAgeMs = 5 * 60 * 1000) {
  if (typeof window === "undefined") return null;

  try {
    const raw = JSON.parse(window.sessionStorage.getItem(getThreadLocationStorageKey(chatId)) || "null");
    if (!raw || typeof raw !== "object") return null;

    const lat = Number(raw.lat);
    const lng = Number(raw.lng);
    const capturedAt = Number(raw.capturedAt || 0);

    if (!Number.isFinite(lat) || !Number.isFinite(lng) || !Number.isFinite(capturedAt) || capturedAt <= 0) {
      return null;
    }

    if (Date.now() - capturedAt > maxAgeMs) {
      return null;
    }

    return {
      lat,
      lng,
      accuracyMeters: Number.isFinite(Number(raw.accuracyMeters)) ? Number(raw.accuracyMeters) : null,
      capturedAt,
      source: String(raw.source || "device"),
      permissionState: "granted",
      trustedExact: true,
    };
  } catch {
    return null;
  }
}

function writeThreadTrustedLocation(chatId = null, location = null) {
  if (typeof window === "undefined") return;
  if (!location || !Number.isFinite(Number(location.lat)) || !Number.isFinite(Number(location.lng))) return;

  const value = {
    lat: Number(location.lat),
    lng: Number(location.lng),
    accuracyMeters: Number.isFinite(Number(location.accuracyMeters)) ? Number(location.accuracyMeters) : null,
    capturedAt: Number(location.capturedAt || Date.now()),
    source: String(location.source || "device"),
    permissionState: "granted",
    trustedExact: true,
  };

  try {
    window.sessionStorage.setItem(getThreadLocationStorageKey(chatId), JSON.stringify(value));
  } catch {
    // ignore storage failures
  }
}

function readThreadPendingState(chatId = null, maxAgeMs = THREAD_PENDING_MAX_AGE_MS) {
  if (typeof window === "undefined") return { busy: false };

  try {
    const raw = JSON.parse(window.sessionStorage.getItem(getThreadPendingStateStorageKey(chatId)) || "null");
    if (!raw || typeof raw !== "object") return { busy: false };

    const updatedAt = Number(raw.updatedAt || 0);
    const busy = raw.busy === true;

    if (!busy) return { busy: false };
    if (!Number.isFinite(updatedAt) || updatedAt <= 0) return { busy: false };
    if (Date.now() - updatedAt > maxAgeMs) return { busy: false };

    return { busy: true, updatedAt };
  } catch {
    return { busy: false };
  }
}

function writeThreadPendingState(chatId = null, value = {}) {
  if (typeof window === "undefined") return;

  const nextValue = {
    busy: value?.busy === true,
    updatedAt: Number(value?.updatedAt || Date.now()),
  };

  try {
    window.sessionStorage.setItem(getThreadPendingStateStorageKey(chatId), JSON.stringify(nextValue));
  } catch {
    // ignore storage failures
  }
}

function clampChatTitle(text) {
  const t = (text || "").trim();
  if (!t) return "New chat";
  return t.length <= 48 ? t : `${t.slice(0, 48)}…`;
}

function isGreeting(text) {
  const t = String(text || "").trim().toLowerCase();
  return ["hi", "hello", "hey", "yo", "good morning", "good afternoon", "good evening"].includes(t);
}

function isAssistantIdentityQuestion(text) {
  const t = String(text || "")
    .trim()
    .toLowerCase()
    .replace(/[?!.,]+/g, " ")
    .replace(/\s+/g, " ");

  return /^(hi|hello|hey|yo)\s+(what is your name|what's your name|who are you|what are you)(\s+again)?\b/.test(t) ||
    /^(what is your name|what's your name|who are you|what are you|what should i call you|can you tell me your name)(\s+again)?\b/.test(t);
}

function isMeaninglessTopic(text) {
  const t = String(text || "").trim().toLowerCase();
  if (!t) return true;
  if (isGreeting(t)) return true;
  if (["help", "travel", "itinerary", "plan", "trip", "hello there"].includes(t)) return true;
  return false;
}

function firstMeaningfulUserMessage(history = []) {
  for (const m of Array.isArray(history) ? history : []) {
    if (m?.role !== "user") continue;
    const c = String(m?.content || "").trim();
    if (!c) continue;
    if (!isMeaninglessTopic(c)) return c;
  }
  return "";
}

function looksLikeItineraryRequest(text) {
  const t = String(text || "").toLowerCase();

  // Guard: accommodation recommendations are NOT itinerary requests
  const isAccommodationRec =
    /\b(recommend|suggest|list|show|find|give me|compare)\b/i.test(t) &&
    /\b(accommodation|accommodations|hotel|hotels|hostel|hostels|place to stay|places to stay|lodging|guesthouse|inn|resort|where to stay)\b/i.test(t) &&
    !/\b(itinerary|day[- ]by[- ]day|travel plan|trip plan|schedule|day plan)\b/i.test(t);
  if (isAccommodationRec) return false;

  // Guard: budget feasibility questions are NOT itinerary requests
  const isBudgetQuestion =
    /\b(budget|afford|realistic|feasible|enough|too expensive|too cheap)\b/i.test(t) &&
    /\b(total|weekend|trip|stay|food|transport|₱|php|peso)\b/i.test(t) &&
    !/\b(itinerary|day[- ]by[- ]day|travel plan|trip plan|schedule|day plan)\b/i.test(t);
  if (isBudgetQuestion) return false;

  const hasItineraryWords = /\b(itinerary|day[-\s]*by[-\s]*day|travel plan|trip plan|schedule)\b/.test(t);
  const hasPlanVerb = /\b(make|create|build|plan|draft|generate)\b/.test(t);
  const hasDuration = /\b\d+\s*(day|days|night|nights)\b/.test(t) || /\b\d+d\d+n\b/.test(t);
  const hasWeekend = /\bweekend\b/.test(t);
  const isHereNow = /\b(right now|today|currently here|i'm here|im here|already here)\b/.test(t);

  if (hasItineraryWords) return true;

  if (hasDuration || hasWeekend) {
    if (hasPlanVerb) return true;
    return true;
  }

  if (isHereNow && (hasPlanVerb || hasDuration || hasWeekend)) return true;

  return false;
}

function isDirectContextQuestion(text) {
  const t = String(text || "").trim().toLowerCase();
  if (!t) return false;

  if (/^where am i\b/.test(t)) return true;
  if (/where am i right now/.test(t)) return true;
  if (/where did i say i am/.test(t)) return true;

  if (/what did i say\b/.test(t)) return true;
  if (/what did i ask\b/.test(t)) return true;
  if (/remind me\b/.test(t)) return true;
  if (/what.*(plan|itinerary).*again\b/.test(t)) return true;

  return false;
}

function localTodayISO() {
  const d = new Date();
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

function extractTripDatesFromAssistant(answerText) {
  const t = String(answerText || "");

  const iso = t.match(/Trip dates:\s*(\d{4}-\d{2}-\d{2})\s*to\s*(\d{4}-\d{2}-\d{2})/i);
  if (iso) return { tripStart: iso[1], tripEnd: iso[2] };

  const placeholder = t.match(/Trip dates:\s*\[today[’']s iso date\]\s*to\s*\[today[’']s iso date\]/i);
  if (placeholder) {
    const today = localTodayISO();
    return { tripStart: today, tripEnd: today };
  }

  const labelIdx = t.toLowerCase().indexOf("trip dates:");
  if (labelIdx >= 0) {
    const window = t.slice(labelIdx, labelIdx + 160);
    const dates = window.match(/\b\d{4}-\d{2}-\d{2}\b/g) || [];
    if (dates.length >= 2) return { tripStart: dates[0], tripEnd: dates[1] };
  }

  return { tripStart: null, tripEnd: null };
}

function extractMapStopsJson(replyText = "") {
  const t = String(replyText || "");
  const start = t.indexOf(MAP_JSON_START);
  const end = t.indexOf(MAP_JSON_END);

  if (start === -1 || end === -1 || end <= start) {
    return { anchor: null, mapStops: null, cleanText: t };
  }

  const jsonRaw = t.slice(start + MAP_JSON_START.length, end).trim();
  let parsed = null;

  try {
    parsed = JSON.parse(jsonRaw);
  } catch {
    parsed = null;
  }

  const cleanText = (t.slice(0, start) + t.slice(end + MAP_JSON_END.length)).trim();

  const anchor = parsed?.anchor && typeof parsed.anchor === "object" ? parsed.anchor : null;
  const mapStops = Array.isArray(parsed?.mapStops) ? parsed.mapStops : null;

  return { anchor, mapStops, cleanText };
}

function inferTripDatesFallbackFromPrompt(promptText) {
  const p = String(promptText || "").toLowerCase();

  const todaySignals = /\b(today only|today\b|right now|currently here|i’m here|im here|already here)\b/.test(p);
  const multiDay = /\b\d+\s*(day|days|night|nights)\b/.test(p) || /\bweekend\b/.test(p);

  if (todaySignals && !multiDay) {
    const today = localTodayISO();
    return { tripStart: today, tripEnd: today };
  }

  return { tripStart: null, tripEnd: null };
}

function extractHeaderTitleFromAssistant(answerText) {
  const raw = String(answerText || "").trim();
  if (!raw) return null;
  const firstLine = raw.split("\n")[0]?.trim();
  if (!firstLine) return null;

  if (!firstLine.includes("•")) return null;
  if (firstLine.length > 80) return null;

  return firstLine;
}

function isSaveItineraryIntent(text, previousAssistantText = "") {
  const t = String(text || "").trim().toLowerCase();
  if (!t) return false;

  const explicitSaveCommand =
    /^(?:please\s+)?save(?:\s+(?:it|this|that|the itinerary|this itinerary|the trip))?\.?$/i.test(t) ||
    /^(?:i want to|can you|could you|please)\s+save\b/i.test(t);

  if (explicitSaveCommand) return true;

  const previousAssistantAskedToSave =
    /\b(would you like to save|do you want to save|save this itinerary)\b/i.test(String(previousAssistantText || ""));

  return previousAssistantAskedToSave &&
    ["yes", "y", "yeah", "yep", "sure", "okay", "ok", "go ahead", "please do"].includes(t);
}


function isEditItineraryIntent(text) {
  const t = String(text || "").trim().toLowerCase();
  if (!t) return false;

  // If the message contains specific edit instructions, it should go to the backend
  // not be intercepted with a generic "tell me what you want to change" response
  const hasSpecificInstructions =
    /\b(add|remove|delete|swap|replace|move|keep|insert|reduce|improve)\b/i.test(t) &&
    /\b(day\s*\d|temple|restaurant|stop|backtracking|tops|lookout|sunset|breakfast|lunch|dinner)\b/i.test(t);
  if (hasSpecificInstructions) return false;

  return /\b(edit|change|update|modify|revise)\b/.test(t) && /\b(itinerary|plan|schedule)\b/.test(t);
}

function looksLikeConflictQuestion(text) {
  const t = String(text || "").trim().toLowerCase();
  if (!t) return false;
  return /\b(why|how come|how is|what conflict|what's the conflict|whats the conflict|explain the conflict|why conflict|why is it|not the same|not even the same|different dates|doesn't conflict|doesnt conflict|shouldn't conflict|shouldnt conflict)\b/i.test(t) &&
    /\b(conflict|date|dates|overlap|block|blocked)\b/i.test(t);
}

function isDismissItineraryIntent(text) {
  const t = String(text || "").trim().toLowerCase();
  if (!t) return false;

  if (["no", "n", "nope", "nah", "not now", "later"].includes(t)) return true;
  return /\b(not now|later|dont save|don't save|skip|dismiss)\b/.test(t);
}

function looksLikeItineraryReplyLoose(replyText) {
  const t = String(replyText || "");
  if (!t.trim()) return false;

  const hasTripDatesLine = /Trip dates:/i.test(t);

  const timeRanges24 = t.match(/\b\d{1,2}:\d{2}\b\s*(?:–|-|to)\s*\b\d{1,2}:\d{2}\b/g) || [];
  const timeRanges12 =
    t.match(/\b\d{1,2}(:\d{2})?\s*(?:AM|PM)\b\s*(?:–|-|to)\s*\b\d{1,2}(:\d{2})?\s*(?:AM|PM)\b/gi) || [];
  const hasEnoughTimeRanges = timeRanges24.length + timeRanges12.length >= 2;

  const blocks = t.match(/\b(Morning|Afternoon|Evening)\b/gi) || [];
  const hasBlocks = blocks.length >= 2;

  const hasDay = /\bDay\s*1\b/i.test(t) || /\bDay\s*\d+\b/i.test(t);

  const longEnough = t.length >= 220;

  return longEnough && (hasEnoughTimeRanges || hasBlocks) && (hasTripDatesLine || hasDay);
}

function shouldNudgeForMissingItinerary({ userAskedItinerary, replyText }) {
  if (!userAskedItinerary) return false;

  const t = String(replyText || "").trim();
  if (!t) return true;

  if (looksLikeItineraryReplyLoose(t)) return false;

  // The backend now drives all trip-setup questions (destination, duration,
  // origin for islands, travelers, date, theme) and also returns the
  // Layla-style trip summary card before generating. If the backend reply
  // is itself a question or the summary card, do NOT inject a second
  // client-side "Quick check" bubble — that was the source of the
  // piggybacked budget+fixed-time question users were complaining about.
  const isBackendClarifier =
    /\?\s*$/.test(t) ||
    /\bquick one\b/i.test(t) ||
    /\bhow many days\b/i.test(t) ||
    /\bwho (?:are|is) (?:you )?travel(?:ing|ling) with\b/i.test(t) ||
    /\bwhat (?:date|month) are you going\b/i.test(t) ||
    /\bare you already (?:in|on|near)\b/i.test(t) ||
    /\bcoming from\b/i.test(t) ||
    /\bwhich city, island, or province\b/i.test(t) ||
    /\bwhat style of trip\b/i.test(t) ||
    /\b(should i generate the full itinerary|here'?s the trip summary before i build it)\b/i.test(t) ||
    /^trip summary\b/i.test(t) ||
    /\borigin assumption:/i.test(t);
  if (isBackendClarifier) return false;

  const isShort = t.length < 180;
  const asksForInfo =
    /\b(tell me|what is your|what's your|what are your|need|please share|provide)\b/i.test(t) &&
    /\b(budget|dates|when|time|duration|days|nights)\b/i.test(t);

  const refusal = /\b(can’t help with bookings|cannot help with bookings|no bookings|no reservations)\b/i.test(t);

  return !refusal && (isShort || asksForInfo);
}

function isFooterInstructionMessage(text) {
  const t = String(text || "").trim().toLowerCase();
  return t === "use **save / edit / not now** above." || t === "use save / edit / not now above.";
}

function isPendingResolvedMessage(text) {
  const t = String(text || "").trim().toLowerCase();

  if (!t) return false;
  if (t.includes("saved — you can view it in **saved itinerary**.".toLowerCase())) return true;
  if (t.includes("saved - you can view it in **saved itinerary**.".toLowerCase())) return true;
  if (t.includes("okay. tell me what you want to plan next.".toLowerCase())) return true;
  if (t.includes("sure — tell me what you want to change".toLowerCase())) return true;
  if (t.includes("sure - tell me what you want to change".toLowerCase())) return true;

  return false;
}

function rebuildPendingFromMessages(history = []) {
  if (!Array.isArray(history) || history.length === 0) return null;

  let latestCandidate = null;

  for (let i = 0; i < history.length; i += 1) {
    const msg = history[i];
    if (msg?.role !== "assistant") continue;

    const raw = String(msg?.content || "");
    const cleanText = extractMapStopsJson(raw).cleanText;

    const itineraryish = detectSaveableItineraryText(cleanText);
    if (!itineraryish) continue;

    let resolved = false;

    for (let j = i + 1; j < history.length; j += 1) {
      const later = history[j];
      const laterText = String(later?.content || "");

      if (isPendingResolvedMessage(laterText)) {
        resolved = true;
        break;
      }
    }

    latestCandidate = {
      cleanText,
      resolved,
      index: i,
    };
  }

  if (!latestCandidate || latestCandidate.resolved) return null;

  const itineraryText = latestCandidate.cleanText;
  const nextUserPrompt =
    [...history]
      .slice(0, latestCandidate.index)
      .reverse()
      .find((m) => m?.role === "user" && String(m?.content || "").trim())?.content || "";

  let { tripStart, tripEnd } = extractTripDatesFromAssistant(itineraryText);

  if (!tripStart || !tripEnd) {
    const fallback = inferTripDatesFallbackFromPrompt(nextUserPrompt);
    tripStart = tripStart || fallback.tripStart;
    tripEnd = tripEnd || fallback.tripEnd;
  }

  const headerTitle = extractHeaderTitleFromAssistant(itineraryText);
  const finalTitle =
    headerTitle ||
    deriveItineraryTitle({
      prompt: nextUserPrompt,
      tripStart,
      tripEnd,
    });

  const { anchor, mapStops, cleanText } = extractMapStopsJson(itineraryText);

  return {
    title: finalTitle,
    text: cleanText,
    tripStart,
    tripEnd,
    tripTimeText: null,
    prompt: nextUserPrompt,
    anchor: anchor || null,
    mapStops: mapStops || null,
  };
}

export default function ChatPage() {
  const { user, loading } = useAuth();
  const { chatId } = useParams();
  const nav = useNavigate();
  const location = useLocation();

  const { setHasMessages } = useChatUi();
  const { pending, setPending, savePending, deleteItinerary } = useItinerary();

  const [messages, setMessages] = useState([]);
  const [localBusy, setLocalBusy] = useState(false);
  const [itineraryBusy, setItineraryBusy] = useState(false);
  const [conflictInfo, setConflictInfo] = useState(null);
  const [awaitingNewDates, setAwaitingNewDates] = useState(false);
  const [optimisticMessages, setOptimisticMessages] = useState([]);
  const [authModalOpen, setAuthModalOpen] = useState(false);
  const [authModalMode, setAuthModalMode] = useState("login");
  const [locationPrompt, setLocationPrompt] = useState(null);
  const [locationBusy, setLocationBusy] = useState(false);

  const { requestCurrentLocation, getCachedLocation, getLocationPermissionState, LOCATION_MAX_AGE_MS } = useGeolocation();
  const { setPreviewFromReply } = useMaps();
  const { setActiveChatId: setComposerActiveChatId } = useComposerDraft();
  const {
    inFlightByChatId,
    startChatRequest,
    completeChatRequest,
    failChatRequest,
  } = useChatRequests();

  const [activeChatId, setActiveChatId] = useState(chatId || null);
  const [ownershipOk, setOwnershipOk] = useState(false);
  const activeRequest = inFlightByChatId[getChatRequestKey(activeChatId || chatId || null)] || null;
  const busy = localBusy || isChatRequestActive(activeRequest);
  const setBusy = setLocalBusy;

  const messagesRef = useRef([]);
  useEffect(() => {
    messagesRef.current = messages;
  }, [messages]);

  const chatIdRef = useRef(chatId || null);
  useEffect(() => {
    chatIdRef.current = chatId || null;
    setComposerActiveChatId(chatId || null);
  }, [chatId, setComposerActiveChatId]);

  const busyRef = useRef(false);
  useEffect(() => {
    busyRef.current = busy;
    writeThreadPendingState(activeChatId || chatIdRef.current, {
      busy,
      updatedAt: Date.now(),
    });
  }, [busy, activeChatId]);

  const createChatPromiseRef = useRef(null);
  const sendLocksRef = useRef(new Set());
  const mountedRef = useRef(true);
  const isStartingFirstChatRef = useRef(false);
  const deviceLocationSuppressedByChatRef = useRef(new Map());

  useEffect(() => {
    mountedRef.current = true;

    return () => {
      mountedRef.current = false;
    };
  }, []);

  const prevRouteChatIdRef = useRef(chatId || null);
  useEffect(() => {
    const prev = prevRouteChatIdRef.current;
    const next = chatId || null;

    if (prev !== next) {
      const keepFirstSendUi = !prev && !!next && isStartingFirstChatRef.current;

      if (!keepFirstSendUi) {
        setMessages([]);
        messagesRef.current = [];
        setBusy(false);
        setItineraryBusy(false);
        setOptimisticMessages([]);
        setOwnershipOk(false);
        setPending?.(null);
      } else {
        setOwnershipOk(false);
      }
    }

    prevRouteChatIdRef.current = next;
  }, [chatId, setPending]);

  useEffect(() => {
  if (!loading && user) {
    setAuthModalOpen(false);
  }
}, [loading, user]);

useEffect(() => {
  const qs = new URLSearchParams(location.search || "");
  const authMode = qs.get("auth");

  if (!authMode) return;
  if (loading) return;
  if (user) return;

  setAuthModalMode(authMode === "signup" ? "signup" : "login");
  setAuthModalOpen(true);

  qs.delete("auth");
  const next = qs.toString();
  nav(`${location.pathname}${next ? `?${next}` : ""}`, { replace: true });
}, [location.key, loading, user, nav, location.pathname, location.search]);

  useEffect(() => {
    const nextId = chatId || null;
    setActiveChatId(nextId);
    chatIdRef.current = nextId;

    if (nextId) {
      const restoredPendingState = readThreadPendingState(nextId);
      setBusy(restoredPendingState.busy === true);
      return;
    }

    const forceNew = sessionStorage.getItem("tm_force_new_chat") === "1";
    const isNewParam = new URLSearchParams(location.search).has("new");

    if (forceNew || isNewParam) {
      sessionStorage.removeItem("tm_force_new_chat");
      sessionStorage.removeItem("tm_guest_messages");

      setMessages([]);
      messagesRef.current = [];
      setBusy(false);
      setOptimisticMessages([]);
      setOwnershipOk(false);
      setPending?.(null);
      setLocationPrompt(null);

      writeThreadPendingState(null, { busy: false, updatedAt: Date.now() });
      rotateGuestThreadToken();
      sendLocksRef.current.clear();
      createChatPromiseRef.current = null;
      chatIdRef.current = null;

      if (isNewParam) nav("/chat", { replace: true });
      return;
    }

    const restoredPendingState = readThreadPendingState(null);
    setBusy(restoredPendingState.busy === true);

    setOwnershipOk(false);
    if (user) {
      setMessages([]);
      messagesRef.current = [];
      setOptimisticMessages([]);
      setPending?.(null);
      sendLocksRef.current.clear();
      createChatPromiseRef.current = null;
      chatIdRef.current = null;
    }
  }, [chatId, location.search, nav, user, setPending]);

  useEffect(() => {
    if (loading) return;
    if (!user && chatId) nav("/chat", { replace: true });
  }, [loading, user, chatId, nav]);

  const visibleMessages = useMemo(() => {
    if (messages.length > 0) return messages;
    if (optimisticMessages.length > 0) return optimisticMessages;
    return [];
  }, [messages, optimisticMessages]);

  useEffect(() => setHasMessages(visibleMessages.length > 0), [visibleMessages.length, setHasMessages]);

  const greeting = useMemo(() => GREETINGS[Math.floor(Math.random() * GREETINGS.length)], [chatId, user]);

  useEffect(() => {
    let cancelled = false;
    setOwnershipOk(false);

    (async () => {
      if (!user || !activeChatId) return;
      try {
        const chat = await getChat(activeChatId);
        if (cancelled) return;
        if (!chat || chat.uid !== user.uid) {
          nav("/chat", { replace: true });
          return;
        }
        setOwnershipOk(true);
      } catch {
        if (cancelled) return;
        nav("/chat", { replace: true });
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [user, activeChatId, nav]);

  useEffect(() => {
    if (!user || !activeChatId || !ownershipOk) return;

    const unsub = subscribeMessages(
      activeChatId,
      (rows) => {
        const normalized = rows.map((m) => {
          const role = m.role === "assistant" ? "assistant" : "user";
          const raw = m.content || "";
          const content = role === "assistant" ? extractMapStopsJson(raw).cleanText : raw;
          return { role, content };
        });

        setMessages(normalized);
        if (normalized.length > 0) setOptimisticMessages([]);
      },
      () => nav("/chat", { replace: true })
    );

    return () => unsub?.();
  }, [user, activeChatId, ownershipOk, nav]);

  useEffect(() => {
    if (busy) return;

    const restoredPending = rebuildPendingFromMessages(messages);
    const currentPendingText = String(pending?.text || "").trim();
    const restoredPendingText = String(restoredPending?.text || "").trim();

    if (!restoredPending && pending) {
      setPending(null);
      return;
    }

    if (restoredPending && restoredPendingText !== currentPendingText) {
      setPending(restoredPending);
    }
  }, [messages, busy, pending, setPending]);

  async function getOrCreateChatId() {
    if (!user) return null;

    if (chatIdRef.current) return chatIdRef.current;
    if (createChatPromiseRef.current) return createChatPromiseRef.current;

    createChatPromiseRef.current = (async () => {
      const id = await createChat(user.uid);

      chatIdRef.current = id;

      setActiveChatId(id);
      nav(`/chat/${id}`, { replace: true });

      return id;
    })();

    try {
      return await createChatPromiseRef.current;
    } finally {
      createChatPromiseRef.current = null;
    }
  }

  function shouldAppendLocalMessage(chatIdForced) {
    const target = chatIdForced || null;
    const current = chatIdRef.current || null;
    return target === current;
  }

  async function addAssistant(chatIdForced, content, options = {}) {
    if (!options.skipLocal && shouldAppendLocalMessage(chatIdForced)) {
      setMessages((prev) => [...prev, { role: "assistant", content }]);
    }
    if (!user) return;
    if (!chatIdForced) return;
    try {
      await addMessage(chatIdForced, "assistant", content);
    } catch {}
  }

  async function addUser(chatIdForced, content, options = {}) {
    if (!options.skipLocal && shouldAppendLocalMessage(chatIdForced)) {
      setMessages((prev) => [...prev, { role: "user", content }]);
    }
    if (!user) return;
    if (!chatIdForced) return;
    try {
      await addMessage(chatIdForced, "user", content);
    } catch {}
  }

  async function onSaveItinerary() {
    if (!pending?.text || itineraryBusy) return;

    if (!user) {
      toast.error("Log in to save this itinerary.");
      nav("/chat?auth=login", { replace: true });
      return;
    }

    if (!pending.tripStart || !pending.tripEnd) {
      await addAssistant(
        chatIdRef.current,
        "I can’t save this itinerary yet because it’s missing **Trip dates (start + end)**. Please regenerate it with ISO dates like:\n\nTrip dates: 2026-03-10 to 2026-03-10"
      );
      return;
    }

    setItineraryBusy(true);
    try {
      const res = await savePending({ uid: user.uid, title: pending.title });

      if (res?.ok === false && res?.reason === "past-date") {
        await addAssistant(
          chatIdRef.current,
          "Saving is blocked because the trip dates are already in the past. Edit the dates, then tap **Save** again."
        );
        return;
      }

      if (res?.ok === false && res?.reason === "date-conflict") {
        const c = res.conflictWith;
        setConflictInfo(c);
        await addAssistant(
          chatIdRef.current,
          `Date conflict with **${c.title}** (${c.tripStart} → ${c.tripEnd}).\n\nChoose an option below to resolve this.`
        );
        return;
      }

      if (res?.ok === true) {
        setConflictInfo(null);
        setAwaitingNewDates(false);
        await addAssistant(chatIdRef.current, "Saved — you can view it in **Saved Itinerary**.");
        setPending(null);
        return;
      }

      await addAssistant(
        chatIdRef.current,
        "I didn’t receive a clear save confirmation. If it didn’t save, tap **Save** again."
      );
    } finally {
      setItineraryBusy(false);
    }
  }

  async function onEditItinerary() {
    if (!pending?.text) return;

    await addAssistant(
      chatIdRef.current,
      "Sure — tell me what you want to change (dates, base, budget, or a fixed time like 18:30)."
    );
  }

  async function onDismissItinerary() {
    setPending(null);
    setConflictInfo(null);
    setAwaitingNewDates(false);
    await addAssistant(chatIdRef.current, "Okay. Tell me what you want to plan next.");
  }

  async function onReplaceConflict() {
    if (!conflictInfo?.id || !pending?.text || !user) return;
    setItineraryBusy(true);
    const replacedTitle = conflictInfo.title || "saved itinerary";
    try {
      await deleteItinerary(conflictInfo.id);
      setConflictInfo(null);
      const res = await savePending({
        uid: user.uid,
        title: pending.title,
        skipConflictCheck: true,
      });
      if (res?.ok === true) {
        await addAssistant(chatIdRef.current, `Replaced **${replacedTitle}** — new itinerary saved. View it in **Saved Itinerary**.`);
        setPending(null);
      } else {
        await addAssistant(chatIdRef.current, "Something went wrong after replacing. Tap **Save** to try again.");
      }
    } finally {
      setItineraryBusy(false);
    }
  }

  async function onChangeDates() {
    setConflictInfo(null);
    setAwaitingNewDates(true);
    await addAssistant(
      chatIdRef.current,
      "Sure — tell me the new dates you'd like (e.g. **March 31 to April 2**) and I'll regenerate the itinerary."
    );
  }

  async function onSaveAsDraft() {
    if (!pending?.text || !user) return;
    setItineraryBusy(true);
    try {
      const res = await savePending({ uid: user.uid, title: pending.title, asDraft: true });
      if (res?.ok === true) {
        setConflictInfo(null);
        setPending(null);
        await addAssistant(chatIdRef.current, "Saved as a **draft** (no dates assigned). You can edit the dates later in **Saved Itinerary**.");
      } else {
        await addAssistant(chatIdRef.current, "Couldn't save as draft. Try again.");
      }
    } finally {
      setItineraryBusy(false);
    }
  }

  const continueSendWithTripState = useCallback(
    async (msg, tripStateOverrides = {}) => {
      const directContextQ = isDirectContextQuestion(msg);

      const startedNewPersistedChat = !!user && !chatIdRef.current;

      if (startedNewPersistedChat) {
        isStartingFirstChatRef.current = true;
        setOptimisticMessages((prev) => [...prev, { role: "user", content: msg }]);
      }

      const id = user ? await getOrCreateChatId() : null;

      writeThreadPendingState(id || chatIdRef.current, {
        busy: true,
        updatedAt: Date.now(),
      });

      const trustedLocationFromTripState =
        tripStateOverrides?.location ||
        tripStateOverrides?.deviceLocation ||
        tripStateOverrides?.app_context?.location ||
        null;

      if (trustedLocationFromTripState) {
        writeThreadTrustedLocation(id || chatIdRef.current, trustedLocationFromTripState);
      }

      async function ensureChatTitleOnce() {
        if (!user || !id) return;
        try {
          const chat = await getChat(id);
          const currentTitle = String(chat?.title || "").trim();
          const isGeneric = !currentTitle || currentTitle === "New chat";
          if (!isGeneric) return;

          const nextTitleSource = firstMeaningfulUserMessage([...messagesRef.current, { role: "user", content: msg }]);
          const nextTitle = clampChatTitle(nextTitleSource || msg);
          await setChatTitleOnce(id, nextTitle);
        } catch {}
      }

      if (isAssistantIdentityQuestion(msg)) {
        const identityText =
          "I’m TravelMate AI, your travel assistant. I can help with destinations, itineraries, routes, food, nearby places, and places to stay.";
        if (user && id) {
          await addUser(id, msg, { skipLocal: startedNewPersistedChat });
          await addAssistant(id, identityText);
        } else {
          setMessages((prev) => [...prev, { role: "user", content: msg }]);
          setMessages((prev) => [...prev, { role: "assistant", content: identityText }]);
        }
        return;
      }

      if (isGreeting(msg)) {
        const greetText =
          "Hey! 👋 Where are you traveling (city/island), and when? If you share budget (budget/mid-range/luxury), I’ll tailor it.";
        if (user && id) {
          await addUser(id, msg, { skipLocal: startedNewPersistedChat });
          await addAssistant(id, greetText);
        } else {
          setMessages((prev) => [...prev, { role: "user", content: msg }]);
          setMessages((prev) => [...prev, { role: "assistant", content: greetText }]);
        }
        return;
      }


      if (pending?.text) {
        if (conflictInfo && looksLikeConflictQuestion(msg)) {
          if (user) await addUser(id, msg, { skipLocal: startedNewPersistedChat });
          else setMessages((prev) => [...prev, { role: "user", content: msg }]);

          await ensureChatTitleOnce();
          await addAssistant(
            chatIdRef.current,
            `The conflict is with **${conflictInfo.title}** which has dates ${conflictInfo.tripStart} → ${conflictInfo.tripEnd}. Your new itinerary's dates fall within that range.\n\nIf the existing itinerary's dates look wrong (e.g. a typo in the year), you can **Replace it** to delete the old one and save the new one, or go to **Saved Itinerary** to fix the dates on the old one first.`
          );
          return;
        }

        const lastAssistantTextForSave =
          [...messagesRef.current].reverse().find((m) => m?.role === "assistant")?.content || "";

        if (isSaveItineraryIntent(msg, lastAssistantTextForSave)) {
          if (user) await addUser(id, msg, { skipLocal: startedNewPersistedChat });
          else setMessages((prev) => [...prev, { role: "user", content: msg }]);

          await ensureChatTitleOnce();
          await onSaveItinerary();
          return;
        }

        if (isEditItineraryIntent(msg)) {
          if (user) await addUser(id, msg, { skipLocal: startedNewPersistedChat });
          else setMessages((prev) => [...prev, { role: "user", content: msg }]);

          await ensureChatTitleOnce();
          await onEditItinerary();
          return;
        }

        if (isDismissItineraryIntent(msg)) {
          if (user) await addUser(id, msg, { skipLocal: startedNewPersistedChat });
          else setMessages((prev) => [...prev, { role: "user", content: msg }]);

          await ensureChatTitleOnce();
          await onDismissItinerary();
          return;
        }
      }

      if (user) await addUser(id, msg, { skipLocal: startedNewPersistedChat });
      else setMessages((prev) => [...prev, { role: "user", content: msg }]);

      await ensureChatTitleOnce();

      let effectiveMsg = msg;
      if (awaitingNewDates && pending?.text) {
        effectiveMsg = `Edit the itinerary: change the dates to start on ${msg}. Keep the same stops and structure.`;
        setAwaitingNewDates(false);
      }

      const history = [...messagesRef.current, { role: "user", content: effectiveMsg }];

      const trip_state = {
        ui: { hasSaveButtons: !!pending?.text },
        save: { status: "unknown" },
        ...(tripStateOverrides && typeof tripStateOverrides === "object" ? tripStateOverrides : {}),
        app_context: {
          ...(tripStateOverrides?.app_context && typeof tripStateOverrides.app_context === "object"
            ? tripStateOverrides.app_context
            : {}),
        },
      };

      const requestChatId = id || chatIdRef.current || null;
      const requestId = `${Date.now()}_${Math.random().toString(36).slice(2, 10)}`;
      const chatAbortController = new AbortController();
      startChatRequest(requestChatId, {
        requestId,
        abortController: chatAbortController,
      });

      let reply;
      try {
        reply = await sendChat({ messages: history, trip_state }, {}, { signal: chatAbortController.signal });
        writeThreadPendingState(requestChatId, {
          busy: false,
          updatedAt: Date.now(),
        });

        const extractedForUi = extractMapStopsJson(reply);
        const replyForUi = extractedForUi.cleanText;
        setPreviewFromReply({ chatId: requestChatId || null, replyText: reply });

        if (user) await addAssistant(requestChatId, replyForUi);
        else setMessages((prev) => [...prev, { role: "assistant", content: replyForUi }]);

        const itineraryish = detectSaveableItineraryText(reply);

        if (!directContextQ && itineraryish && shouldAppendLocalMessage(requestChatId)) {
          let { tripStart, tripEnd } = extractTripDatesFromAssistant(reply);

          if (!tripStart || !tripEnd) {
            const fallback = inferTripDatesFallbackFromPrompt(msg);
            tripStart = tripStart || fallback.tripStart;
            tripEnd = tripEnd || fallback.tripEnd;
          }

          const headerTitle = extractHeaderTitleFromAssistant(reply);

          const finalTitle =
            headerTitle ||
            deriveItineraryTitle({
              prompt: msg,
              tripStart,
              tripEnd,
            });

          const { anchor, mapStops, cleanText } = extractMapStopsJson(reply);

          setAwaitingNewDates(false);
          setConflictInfo(null);
          setPending({
            title: finalTitle,
            text: cleanText,
            tripStart,
            tripEnd,
            tripTimeText: null,
            prompt: msg,
            anchor: anchor || null,
            mapStops: mapStops || null,
          });
        }

        completeChatRequest(requestChatId, requestId);
      } catch (err) {
        failChatRequest(requestChatId, requestId, err?.message || String(err || ""));
        try {
          err.chatId = requestChatId;
        } catch {}
        throw err;
      } finally {
        writeThreadPendingState(requestChatId, {
          busy: false,
          updatedAt: Date.now(),
        });
      }

    },
    [pending, user, onSaveItinerary, onEditItinerary, onDismissItinerary, setPending, startChatRequest, completeChatRequest, failChatRequest, setPreviewFromReply]
  );

  const denyLocationPrompt = useCallback(async () => {
    const pendingPrompt = locationPrompt;
    setLocationPrompt(null);

    if (!pendingPrompt?.message) return;

    const permissionState = await getLocationPermissionState();
    const fallbackReply =
      permissionState === "denied"
        ? "Location access is off, so I can’t use your exact device location right now. Enter your area, barangay, district, landmark, or select a place on the map, and I’ll keep the results in the right area."
        : "I can help with nearby places, but I don’t have your exact device location yet. Enter your area, barangay, district, landmark, or select a place on the map, and I’ll keep the results in the right area.";

    const startedNewPersistedChat = !!user && !chatIdRef.current;
    const id = user ? await getOrCreateChatId() : null;

    if (user && id) {
      await addUser(id, pendingPrompt.message, { skipLocal: startedNewPersistedChat });
      await addAssistant(id, fallbackReply);
      return;
    }

    setMessages((prev) => [...prev, { role: "user", content: pendingPrompt.message }]);
    setMessages((prev) => [...prev, { role: "assistant", content: fallbackReply }]);
  }, [locationPrompt, user, getLocationPermissionState]);

  const allowLocationPrompt = useCallback(async () => {
    if (!locationPrompt?.message || locationBusy) return;

    setLocationBusy(true);
    setBusy(true);
    try {
      const location = await requestCurrentLocation({ maxAgeMs: LOCATION_MAX_AGE_MS });
      writeThreadTrustedLocation(chatIdRef.current, location);

      const nextTripState = buildTrustedLocationTripState(
        locationPrompt.tripState || {},
        location,
        locationPrompt.typedArea || ""
      );

      setLocationPrompt(null);
      await continueSendWithTripState(locationPrompt.message, nextTripState);
    } catch (e) {
      if (/denied/i.test(String(e?.message || ""))) {
        await denyLocationPrompt();
      } else {
        toast.error(e?.message || "Couldn’t get your current location.");
      }
    } finally {
      setLocationBusy(false);
      setBusy(false);
    }
  }, [locationPrompt, locationBusy, requestCurrentLocation, LOCATION_MAX_AGE_MS, continueSendWithTripState, denyLocationPrompt]);

  async function onSend(userMessage) {
    const msg = (userMessage || "").trim();
    if (!msg) return;

    const lockKey = getChatRequestKey(chatIdRef.current || activeChatId || null);
    if (sendLocksRef.current.has(lockKey)) return;
    sendLocksRef.current.add(lockKey);

    try {
      if (busy) return;
      setBusy(true);

      const locationSuppressionKey = chatIdRef.current || activeChatId || "guest";
      if (looksLikeDeviceLocationSuppression(msg)) {
        deviceLocationSuppressedByChatRef.current.set(locationSuppressionKey, true);
      } else if (looksLikeDeviceLocationSuppressionReset(msg)) {
        deviceLocationSuppressedByChatRef.current.delete(locationSuppressionKey);
      }

      const deviceLocationSuppressed =
        deviceLocationSuppressedByChatRef.current.get(locationSuppressionKey) === true;
      const typedArea = extractTypedAreaHint(msg);
      const locationIntent = classifyLocationIntent(msg);
      if (locationIntent.mode === "clarify_area") {
        const clarifyText =
          "Which area should I search near? For example: near IT Park, around Ayala Cebu, or near Session Road in Baguio.";
        const startedNewPersistedChat = !!user && !chatIdRef.current;
        if (startedNewPersistedChat) {
          isStartingFirstChatRef.current = true;
          setOptimisticMessages((prev) => [...prev, { role: "user", content: msg }]);
        }
        const id = user ? await getOrCreateChatId() : null;
        if (user && id) {
          await addUser(id, msg, { skipLocal: startedNewPersistedChat });
          await addAssistant(id, clarifyText);
        } else {
          setMessages((prev) => [...prev, { role: "user", content: msg }]);
          setMessages((prev) => [...prev, { role: "assistant", content: clarifyText }]);
        }
        return;
      }
      const nearbyNeedsTrustedLocation =
        !deviceLocationSuppressed && locationIntent.mode === "gps";
      const currentLocationQuestion =
        !deviceLocationSuppressed && looksLikeCurrentLocationQuestion(msg);
      const explicitDeviceLocationIntent =
        !deviceLocationSuppressed && looksLikeDeviceLocationIntent(msg);
      const placesContinuationMessage = looksLikePlacesContinuationMessage(msg);

      const recentPlaceAnchor =
        [...messagesRef.current]
          .slice(-12)
          .reverse()
          .filter((entry) => entry?.role === "user")
          .map((entry) => extractParenthesizedPlaceContext(entry?.content || ""))
          .find(Boolean) || null;

      const currentPlaceAnchor = extractParenthesizedPlaceContext(msg);
      const selectedPlaceContext = currentPlaceAnchor || recentPlaceAnchor || null;

      const shouldReadTrustedLocation =
        explicitDeviceLocationIntent ||
        (placesContinuationMessage && !nearbyNeedsTrustedLocation && !deviceLocationSuppressed);

      const freshLocation = shouldReadTrustedLocation
        ? (readThreadTrustedLocation(chatIdRef.current, LOCATION_MAX_AGE_MS) ||
            (await getCachedLocation(LOCATION_MAX_AGE_MS)))
        : null;

      const hasFreshTrustedLocation =
        Boolean(freshLocation) &&
        Number.isFinite(Number(freshLocation?.lat)) &&
        Number.isFinite(Number(freshLocation?.lng));

      const shouldCarrySelectedPlaceContext =
        Boolean(selectedPlaceContext) &&
        !nearbyNeedsTrustedLocation &&
        !currentLocationQuestion;

      const needsPromptForExactLocation =
        (nearbyNeedsTrustedLocation || explicitDeviceLocationIntent) &&
        !hasFreshTrustedLocation;

      if (needsPromptForExactLocation) {
        setLocationPrompt({
          message: msg,
          typedArea,
          tripState: {
            ui: { hasSaveButtons: !!pending?.text },
            save: { status: "unknown" },
            app_context: {
              ...(shouldCarrySelectedPlaceContext
                ? {
                    selectedPlace: selectedPlaceContext,
                  }
                : {}),
              ...(deviceLocationSuppressed ? { suppressDeviceLocation: true } : {}),
            },
          },
        });
        return;
      }

      const baseLocationForRequest = hasFreshTrustedLocation ? freshLocation : null;

      const tripStateOverrides = buildTrustedLocationTripState(
        {
          ui: { hasSaveButtons: !!pending?.text },
          save: { status: "unknown" },
          app_context: {
            ...(shouldCarrySelectedPlaceContext
              ? {
                  selectedPlace: selectedPlaceContext,
                }
              : {}),
            ...(deviceLocationSuppressed ? { suppressDeviceLocation: true } : {}),
          },
        },
        freshLocation,
        typedArea
      );

      const isNearbyQuery =
        nearbyNeedsTrustedLocation ||
        explicitDeviceLocationIntent ||
        (placesContinuationMessage && hasFreshTrustedLocation);

      if (
        isNearbyQuery &&
        baseLocationForRequest &&
        !tripStateOverrides?.location &&
        !tripStateOverrides?.app_context?.location
      ) {
        const carried = buildTrustedLocationTripState(
          tripStateOverrides || {},
          baseLocationForRequest,
          ""
        );
        await continueSendWithTripState(msg, carried);
      } else {
        await continueSendWithTripState(msg, tripStateOverrides);
      }
    } catch (e) {
      const errorChatId = e?.chatId ?? chatIdRef.current ?? activeChatId ?? null;
      if (e?.name !== "AbortError" && mountedRef.current) {
        writeThreadPendingState(errorChatId, {
          busy: false,
          updatedAt: Date.now(),
        });
        setOptimisticMessages([]);
        if (shouldAppendLocalMessage(errorChatId)) {
          setMessages((prev) => [...prev, { role: "assistant", content: e?.message || "Sorry — something went wrong." }]);
        }
      }
    } finally {
      if (mountedRef.current) {
        const finalChatId = chatIdRef.current || activeChatId || null;
        writeThreadPendingState(finalChatId, {
          busy: false,
          updatedAt: Date.now(),
        });
        setBusy(false);
        isStartingFirstChatRef.current = false;
        setTimeout(() => {
          sendLocksRef.current.delete(lockKey);
        }, 150);
      }
    }
  }

  const showLandingStyle = !user || visibleMessages.length === 0;

return (
  <>
    <ChatPanel
      greeting={showLandingStyle ? greeting : ""}
      subtitle={showLandingStyle ? SUBTITLE : ""}
      suggestions={showLandingStyle ? SUGGESTIONS : []}
      messages={visibleMessages}
      busy={busy}
      onSend={onSend}
      disabled={false}
      autoFocusKey={activeChatId || "guest"}
      showLandingStyle={showLandingStyle}
      pendingItinerary={pending}
      showItineraryActions={!!pending?.text || !!conflictInfo}
      onSaveItinerary={() => onSaveItinerary()}
      onEditItinerary={onEditItinerary}
      onDismissItinerary={onDismissItinerary}
      onReplaceConflict={onReplaceConflict}
      onChangeDates={onChangeDates}
      onSaveAsDraft={onSaveAsDraft}
      conflictInfo={conflictInfo}
      itineraryBusy={itineraryBusy}
      canSaveItinerary={!!user}
      showGuestAuthBar={false}
    />

    <AuthModal
      open={authModalOpen}
      mode={authModalMode}
      onClose={() => setAuthModalOpen(false)}
    />

    {locationPrompt ? (
      <div className="tm-modalOverlay" role="dialog" aria-modal="true" aria-labelledby="tm-location-permission-title">
        <div className="tm-locationPromptCard">
          <h2 id="tm-location-permission-title" className="tm-locationPromptTitle">
            Allow location access?
          </h2>
          <p className="tm-locationPromptText">
            TravelMate AI uses your location only for nearby travel help like “near me”, “from here”, and “open nearby”.
          </p>
          <div className="tm-locationPromptActions">
            <button
              type="button"
              className="tm-locationPromptBtn tm-locationPromptBtn--secondary"
              onClick={() => denyLocationPrompt()}
              disabled={locationBusy}
            >
              Not now
            </button>
            <button
              type="button"
              className="tm-locationPromptBtn tm-locationPromptBtn--primary"
              onClick={() => allowLocationPrompt()}
              disabled={locationBusy}
            >
              {locationBusy ? "Allowing…" : "Allow"}
            </button>
          </div>
        </div>
      </div>
    ) : null}
  </>
);
}

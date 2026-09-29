// ⚠️ DEPRECATED — The active chat endpoint lives in index.js /v1/chat.
// Do NOT mount this router. Kept for reference only.
const express = require("express");
const admin = require("firebase-admin");
const { llmChat } = require("../services/llm.service");

const router = express.Router();

function normalizeMessages(body) {
  if (Array.isArray(body?.messages) && body.messages.length) {
    return body.messages
      .map((m) => ({
        role: m?.role === "assistant" ? "assistant" : "user",
        content: String(m?.content || "").trim(),
      }))
      .filter((m) => m.content);
  }

  const msg = String(body?.message || "").trim();
  return msg ? [{ role: "user", content: msg }] : [];
}

async function verifyUserFromReq(req) {
  const h = req.headers.authorization || "";
  const m = String(h).match(/^Bearer\s+(.+)$/i);

  if (!m) {
    console.log("[chat] no bearer token found");
    return null;
  }

  try {
    return await admin.auth().verifyIdToken(m[1]);
  } catch (e) {
    console.error("[chat] verifyIdToken failed:", e);
    return null;
  }
}

function arr(value) {
  return Array.isArray(value) ? value.filter(Boolean).map((x) => String(x).trim()).filter(Boolean) : [];
}

function buildTravelProfileSystemMessage(profileDoc) {
  if (!profileDoc || typeof profileDoc !== "object") return null;

  const displayName = String(profileDoc.displayName || "").trim();
  const homeBase = String(profileDoc.homeBase || "").trim();
  const bio = String(profileDoc.bio || "").trim();
  const travelProfile = profileDoc.travelProfile || {};
  const aiProfileContext = String(profileDoc.aiProfileContext || travelProfile.summary || "").trim();

  const preferences = arr(travelProfile.travelPreferences || profileDoc.travelPreferences);
  const interests = arr(travelProfile.interests || profileDoc.interests);
  const travelStyle = String(travelProfile.travelStyle || profileDoc.travelStyle || "").trim();
  const budgetStyle = String(travelProfile.budgetStyle || profileDoc.budgetStyle || "").trim();
  const personalTravelNotes = String(
    travelProfile.personalTravelNotes || profileDoc.personalTravelNotes || ""
  ).trim();

  const lines = [
    displayName ? `Traveler name: ${displayName}` : null,
    homeBase ? `Home base: ${homeBase}` : null,
    bio ? `Profile bio: ${bio}` : null,
    preferences.length ? `Travel preferences: ${preferences.join(", ")}` : null,
    interests.length ? `Interests: ${interests.join(", ")}` : null,
    travelStyle ? `Travel style: ${travelStyle}` : null,
    budgetStyle ? `Budget style: ${budgetStyle}` : null,
    personalTravelNotes ? `Personal travel notes: ${personalTravelNotes}` : null,
    aiProfileContext ? `AI profile summary: ${aiProfileContext}` : null,
    "Use this traveler profile to personalize all travel answers, especially itinerary pace, budget framing, food suggestions, attraction choices, and recommendation tone.",
    "If the user asks about their saved travel preferences, interests, travel style, budget style, or personal travel notes, answer directly from this profile.",
    "Treat this profile as user-provided saved settings for this traveler.",
    "Do not say you do not have access to their preferences if this profile is present.",
    "Do not mention the profile unless the user asks. Blend it naturally into normal travel responses.",
  ].filter(Boolean);

  if (!lines.length) return null;

  return {
    role: "system",
    content: `TRAVELER PROFILE CONTEXT\n${lines.join("\n")}`,
  };
}

function getZonedDateTimeParts(timeZone = "Asia/Manila") {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hourCycle: "h23",
  }).formatToParts(new Date());

  const read = (type) => parts.find((p) => p.type === type)?.value || "";
  const year = read("year");
  const month = read("month");
  const day = read("day");
  const hour = read("hour");
  const minute = read("minute");
  const second = read("second");

  return {
    todayISO: `${year}-${month}-${day}`,
    nowISO: `${year}-${month}-${day}T${hour}:${minute}:${second}`,
  };
}

const TRUSTED_LOCATION_MAX_AGE_MS = 5 * 60 * 1000;

function normalizeLatLng(source) {
  if (!source || typeof source !== "object") return null;

  const latRaw = source.lat ?? source.latitude;
  const lngRaw = source.lng ?? source.longitude;

  const lat = Number(latRaw);
  const lng = Number(lngRaw);

  if (!Number.isFinite(lat) || !Number.isFinite(lng)) return null;
  if (lat < -90 || lat > 90 || lng < -180 || lng > 180) return null;

  const permissionState = String(source.permissionState || source.permission || "").trim().toLowerCase() || null;
  const trustedExact = source.trustedExact === true || source.isTrustedExact === true;
  const capturedAt = Number.isFinite(Number(source.capturedAt)) ? Number(source.capturedAt) : null;
  const sourceKind = String(source.source || "").trim().toLowerCase() || null;

  return {
    lat,
    lng,
    capturedAt,
    source: sourceKind,
    permissionState,
    trustedExact: trustedExact || (permissionState === "granted" && sourceKind === "device"),
  };
}

function normalizeSelectedPlaceContext(source) {
  if (!source || typeof source !== "object") return null;

  const label = String(source.label || source.name || "").trim();
  const address = String(source.address || source.formattedAddress || "").trim();
  const anchorText = String(source.anchorText || [label, address].filter(Boolean).join(", ")).trim();

  if (!anchorText) return null;

  return {
    label,
    address,
    anchorText,
  };
}

function isFreshTrustedExactLocation(value) {
  if (!value || value.trustedExact !== true) return false;
  if (value.permissionState !== "granted") return false;
  if (!Number.isFinite(Number(value.capturedAt))) return false;
  return Date.now() - Number(value.capturedAt) <= TRUSTED_LOCATION_MAX_AGE_MS;
}

function normalizeSelectedPlace(value) {
  if (!value || typeof value !== "object") return null;

  const label = String(value.label || value.name || "").trim();
  const address = String(value.address || value.formattedAddress || "").trim();
  const anchorText = String(value.anchorText || [label, address].filter(Boolean).join(", ")).trim();

  const location =
    normalizeLatLng(value.location) ||
    normalizeLatLng(value.coords) ||
    normalizeLatLng(value.geometry?.location) ||
    normalizeLatLng({
      lat: value.lat ?? value.latitude,
      lng: value.lng ?? value.longitude,
    }) ||
    null;

  if (!label && !address && !anchorText && !location) return null;

  return {
    label,
    address,
    anchorText,
    location,
  };
}

function extractLocationContext(req) {
  const tripState = req.body?.trip_state || {};
  const appContext = tripState?.app_context || {};

  const exactCandidates = [
    normalizeLatLng(appContext?.location),
    normalizeLatLng(appContext?.coords),
    normalizeLatLng(tripState?.location),
    normalizeLatLng(tripState?.coords),
    normalizeLatLng(tripState?.deviceLocation),
    normalizeLatLng(tripState?.userLocation),
    normalizeLatLng(req.body?.location),
  ].filter(Boolean);

  const exact = exactCandidates.find((item) => isFreshTrustedExactLocation(item)) || null;

  const typedArea = String(
    tripState?.area ||
    tripState?.city ||
    tripState?.district ||
    appContext?.area ||
    appContext?.city ||
    ""
  ).trim();

  const selectedPlace =
    normalizeSelectedPlace(appContext?.selectedPlace) ||
    normalizeSelectedPlace(tripState?.selectedPlace) ||
    normalizeSelectedPlace(req.body?.selectedPlace) ||
    null;

  return {
    exact,
    typedArea,
    selectedPlace,
  };
}

router.post("/chat", async (req, res) => {
  try {
    const trip_state = req.body?.trip_state || {};
    const msgs = normalizeMessages(req.body);

    if (!msgs.length) {
      return res.status(400).json({ reply: "Please type a travel question." });
    }

    const tz = String(trip_state?.app_context?.timezone || trip_state?.timezone || "").trim() || "Asia/Manila";
    const trustedNow = getZonedDateTimeParts(tz);
    const locationContext = extractLocationContext(req);

    const contextParts = [
      `Device timezone (IANA): ${tz}`,
      `Trusted local date (today): ${trustedNow.todayISO}`,
      `Trusted local datetime (now): ${trustedNow.nowISO}`,
      "Use the trusted local date above as 'today' when the user says today/right now/tomorrow/in N days.",
      "When the user gives month/day without a year (e.g., Oct 20–23), infer the year from trusted local 'today' so the dates are not in the past.",
      locationContext.exact
        ? `Exact app location is available (coordinates provided to backend for nearby searches, do not repeat them to the user)`
        : null,
      locationContext.selectedPlace?.anchorText
        ? `Selected place context from app: ${locationContext.selectedPlace.anchorText}`
        : null,
      !locationContext.exact && locationContext.typedArea
        ? `Typed area/city context from app: ${locationContext.typedArea}`
        : null,
      !locationContext.exact
        ? "If the user asks 'near me' and exact app location is missing, do not pretend to know their exact location."
        : null,
    ].filter(Boolean);

    const contextSystemMessage = {
      role: "system",
      content: `APP DATE CONTEXT\n${contextParts.join("\n")}`,
    };

    const decoded = await verifyUserFromReq(req);
    let profileSystemMessage = null;
    let profileData = null;

    console.log("[chat] auth header present:", !!req.headers.authorization);
    console.log("[chat] decoded uid:", decoded?.uid || null);

    if (decoded?.uid) {
      try {
        const snap = await admin.firestore().collection("users").doc(decoded.uid).get();
        console.log("[chat] user doc exists:", snap.exists);

        if (snap.exists) {
          profileData = snap.data() || null;
          console.log("[chat] loaded user doc keys:", Object.keys(profileData || {}));
          console.log("[chat] travelProfile:", profileData?.travelProfile || null);
          console.log("[chat] travelPreferences root:", profileData?.travelPreferences || null);
          console.log("[chat] interests root:", profileData?.interests || null);
          console.log("[chat] aiProfileContext:", profileData?.aiProfileContext || null);

          profileSystemMessage = buildTravelProfileSystemMessage(profileData);
          console.log("[chat] profileSystemMessage built:", !!profileSystemMessage);
        }
      } catch (e) {
        console.error("[chat] failed to load profile:", e);
        profileSystemMessage = null;
        profileData = null;
      }
    } else {
      console.log("[chat] no decoded user; profile context not injected");
    }

    const assembled = [contextSystemMessage];
    if (profileSystemMessage) assembled.push(profileSystemMessage);
    assembled.push(...msgs);

    console.log("[chat] assembled message count:", assembled.length);
    console.log("[chat] injected profile context:", !!profileSystemMessage);
    console.log("[chat] exact location available:", !!locationContext.exact);

    const reply = await llmChat(assembled, {
      userProfile: profileData,
      appContext: {
        timezone: tz,
        todayISO: trustedNow.todayISO,
        nowISO: trustedNow.nowISO,
        location: locationContext,
      },
    });

    return res.json({ reply });
  } catch (err) {
    return res.status(500).json({
      reply: `AI error: ${err.message}`,
    });
  }
});

module.exports = router;
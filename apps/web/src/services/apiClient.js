import { auth } from "./firebase";

const PROJECT_ID = import.meta.env.VITE_FIREBASE_PROJECT_ID || "demo-travelmate";
const REGION = import.meta.env.VITE_FUNCTIONS_REGION || "asia-southeast1";
const USE_EMULATORS = import.meta.env.VITE_USE_FIREBASE_EMULATORS !== "false";

const BASE_URL = USE_EMULATORS
  ? `http://127.0.0.1:5001/${PROJECT_ID}/${REGION}/api`
  : (import.meta.env.VITE_API_BASE_URL || "");

console.log("[apiClient] BASE_URL =", BASE_URL);

async function readBodySafe(res) {
  const text = await res.text().catch(() => "");
  try {
    return { json: JSON.parse(text), text };
  } catch {
    return { json: null, text };
  }
}

function buildAppContext() {
  const now = new Date();
  const inferredTz =
    (typeof Intl !== "undefined" && Intl.DateTimeFormat
      ? Intl.DateTimeFormat().resolvedOptions().timeZone
      : "") || "Asia/Manila";

  return {
    timezone: inferredTz,
    todayISO: now.toISOString().slice(0, 10),
    nowISO: now.toISOString(),
  };
}

function buildPayload(input, trip_state = {}) {
  const safeTripState = trip_state && typeof trip_state === "object" ? trip_state : {};

  if (typeof input === "string") {
    return {
      message: input,
      trip_state: {
        ...safeTripState,
        app_context: {
          ...buildAppContext(),
          ...(safeTripState.app_context && typeof safeTripState.app_context === "object"
            ? safeTripState.app_context
            : {}),
        },
      },
    };
  }

  if (input && typeof input === "object") {
    const incomingTrip =
      input.trip_state && typeof input.trip_state === "object"
        ? input.trip_state
        : {};

    return {
      ...input,
      trip_state: {
        ...incomingTrip,
        ...safeTripState,
        app_context: {
          ...buildAppContext(),
          ...(incomingTrip.app_context && typeof incomingTrip.app_context === "object"
            ? incomingTrip.app_context
            : {}),
          ...(safeTripState.app_context && typeof safeTripState.app_context === "object"
            ? safeTripState.app_context
            : {}),
        },
      },
    };
  }

  return {
    message: "",
    trip_state: {
      ...safeTripState,
      app_context: {
        ...buildAppContext(),
        ...(safeTripState.app_context && typeof safeTripState.app_context === "object"
          ? safeTripState.app_context
          : {}),
      },
    },
  };
}

async function postJson(endpoint, payload, extraHeaders = {}, options = {}) {
  let res;

  const authHeaders = { ...extraHeaders };
  try {
    const currentUser = auth.currentUser;
    if (currentUser && !authHeaders.Authorization) {
      const idToken = await currentUser.getIdToken();
      if (idToken) authHeaders.Authorization = `Bearer ${idToken}`;
    }
  } catch {}

  try {
    res = await fetch(`${BASE_URL}${endpoint}`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...authHeaders,
      },
      body: JSON.stringify(payload),
      signal: options.signal,
    });
  } catch (err) {
    if (err?.name === "AbortError") throw err;
    throw new Error("I'm having trouble connecting right now. Please check your internet and try again in a moment.");
  }

  const { json, text } = await readBodySafe(res);

  if (!res.ok) {
    const msg =
      json?.error || json?.message || text || `Request failed (${res.status})`;
    throw new Error(msg);
  }

  return { json, text };
}

export async function getApiJson(endpoint, options = {}) {
  let headers = {};
  try {
    const currentUser = auth.currentUser;
    if (currentUser) {
      const idToken = await currentUser.getIdToken();
      if (idToken) headers.Authorization = `Bearer ${idToken}`;
    }
  } catch {}

  const response = await fetch(`${BASE_URL}${endpoint}`, {
    headers,
    signal: options.signal,
  });
  const { json, text } = await readBodySafe(response);
  if (!response.ok) {
    const error = new Error(json?.error || json?.message || text || `Request failed (${response.status})`);
    error.status = response.status;
    error.retryAfter = response.headers.get("Retry-After");
    throw error;
  }
  return json;
}

export async function sendChat(input, trip_state = {}, options = {}) {
  const payload = buildPayload(input, trip_state);
  const { json } = await postJson("/v1/chat", payload, {}, options);

  const reply = json?.reply;
  if (typeof reply !== "string") {
    throw new Error("Backend response missing `reply`.");
  }

  return reply;
}

export async function sendChatWithMeta(input, trip_state = {}, options = {}) {
  const payload = buildPayload(input, trip_state);
  const { json } = await postJson("/v1/chat", payload, {}, options);

  const reply = json?.reply;
  if (typeof reply !== "string") {
    throw new Error("Backend response missing `reply`.");
  }

  return {
    reply,
    meta: json?.meta || null,
  };
}

export async function serverLogout(idToken) {
  try {
    const { json } = await postJson(
      "/v1/logout",
      {},
      idToken ? { Authorization: `Bearer ${idToken}` } : {}
    );
    return { ok: json?.ok === true };
  } catch (e) {
    return { ok: false, reason: e?.message || "network" };
  }
}

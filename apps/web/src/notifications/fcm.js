// apps/web/src/notifications/fcm.js
import { initializeApp, getApps } from "firebase/app";
import { getMessaging, getToken, onMessage, isSupported } from "firebase/messaging";

const TOKEN_KEY = "tm_fcm_token_v1";

export function getStoredFcmToken() {
  try {
    return localStorage.getItem(TOKEN_KEY) || "";
  } catch {
    return "";
  }
}

export function clearStoredFcmToken() {
  try {
    localStorage.removeItem(TOKEN_KEY);
  } catch {}
}

function saveStoredFcmToken(token) {
  try {
    localStorage.setItem(TOKEN_KEY, token);
  } catch {}
}

// ✅ Helper to clean token for use as Firestore document ID
function cleanTokenForDocId(token) {
  return token.replace(/:/g, '_').replace(/\./g, '_');
}

function cfgFromEnv() {
  const cfg = {
    apiKey: import.meta.env.VITE_FIREBASE_API_KEY,
    authDomain: import.meta.env.VITE_FIREBASE_AUTH_DOMAIN,
    projectId: import.meta.env.VITE_FIREBASE_PROJECT_ID,
    storageBucket: import.meta.env.VITE_FIREBASE_STORAGE_BUCKET,
    messagingSenderId: import.meta.env.VITE_FIREBASE_MESSAGING_SENDER_ID,
    appId: import.meta.env.VITE_FIREBASE_APP_ID,
  };

  for (const [k, v] of Object.entries(cfg)) {
    if (!v) throw new Error(`[FCM] Missing env ${k}. Put it in apps/web/.env then restart dev server.`);
  }

  return cfg;
}

// ✅ This is the function your NotificationsPage calls
export async function enableWebPush({ debug = false, onToken, onForegroundMessage } = {}) {
  const supported = await isSupported().catch(() => false);
  if (!supported) return { ok: false, reason: "This browser does not support web push messaging." };

  // Must be triggered by a user click
  const permission = await Notification.requestPermission();
  if (permission !== "granted") {
    return {
      ok: false,
      reason: permission === "denied" ? "Notifications are blocked for this site." : "Permission not granted.",
      permission,
    };
  }

  const app = getApps().length ? getApps()[0] : initializeApp(cfgFromEnv());
  const messaging = getMessaging(app);

  // IMPORTANT: module SW (your generated /public/firebase-messaging-sw.js)
  let swReg;
  try {
    swReg = await navigator.serviceWorker.register("/firebase-messaging-sw.js", { type: "module" });
  } catch (e) {
    return {
      ok: false,
      reason: "Service worker registration failed. Ensure /firebase-messaging-sw.js exists (not 404).",
      error: e?.message || String(e),
    };
  }

  const vapidKey = import.meta.env.VITE_FIREBASE_VAPID_KEY;
  if (!vapidKey) return { ok: false, reason: "Missing VITE_FIREBASE_VAPID_KEY in apps/web/.env" };

  let token;
  try {
    token = await getToken(messaging, { vapidKey, serviceWorkerRegistration: swReg });
  } catch (e) {
    return {
      ok: false,
      reason: "getToken failed. Usually permission/VAPID/SW mismatch.",
      error: e?.message || String(e),
    };
  }

  if (!token) return { ok: false, reason: "No FCM token returned." };

  saveStoredFcmToken(token);

  if (debug) console.log("[FCM] Token:", token);
  
  // ✅ Pass both original token and cleaned version
  onToken?.({
    original: token,
    clean: cleanTokenForDocId(token)
  });

  onMessage(messaging, (payload) => {
    if (debug) console.log("[FCM] Foreground message:", payload);
    onForegroundMessage?.(payload);
  });

  return { 
    ok: true, 
    token: {
      original: token,
      clean: cleanTokenForDocId(token)
    }
  };
}
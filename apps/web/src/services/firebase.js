import { initializeApp } from "firebase/app";
import {
  getAuth,
  GoogleAuthProvider,
  connectAuthEmulator,
  initializeAuth,
  browserLocalPersistence,
  browserSessionPersistence,
  indexedDBLocalPersistence,
  browserPopupRedirectResolver,
} from "firebase/auth";
import { getFirestore, connectFirestoreEmulator } from "firebase/firestore";
import { getStorage, connectStorageEmulator } from "firebase/storage";
import { getFunctions, connectFunctionsEmulator } from "firebase/functions";

const firebaseConfig = {
  apiKey: import.meta.env.VITE_FIREBASE_API_KEY,
  authDomain: import.meta.env.VITE_FIREBASE_AUTH_DOMAIN,
  projectId: import.meta.env.VITE_FIREBASE_PROJECT_ID,
  storageBucket: import.meta.env.VITE_FIREBASE_STORAGE_BUCKET,
  messagingSenderId: import.meta.env.VITE_FIREBASE_MESSAGING_SENDER_ID,
  appId: import.meta.env.VITE_FIREBASE_APP_ID,
};

const IS_DEV = import.meta.env.DEV;
const USE_EMULATORS = import.meta.env.VITE_USE_FIREBASE_EMULATORS === "true";

function debugLog(...args) {
  if (IS_DEV) {
    console.log(...args);
  }
}

function debugWarn(...args) {
  if (IS_DEV) {
    console.warn(...args);
  }
}

function validateFirebaseConfig(cfg) {
  const missing = Object.entries(cfg)
    .filter(([_, v]) => !v || String(v).trim() === "")
    .map(([k]) => k);

  if (missing.length) {
    const message =
      `[TravelMate] Missing Firebase env values: ${missing.join(", ")}. ` +
      "Make sure apps/web/.env contains VITE_FIREBASE_* values and restart Vite.";

    if (IS_DEV) {
      console.error(message);
    }

    throw new Error(message);
  }

  debugLog("[TravelMate] Firebase config validated");
}

validateFirebaseConfig(firebaseConfig);

const app = initializeApp(firebaseConfig);

// IMPORTANT: initialize auth with browserLocalPersistence FIRST so every tab
// reads/writes the same storage from the very first tick. The previous default
// (indexedDBLocalPersistence) caused new tabs to fire onAuthStateChanged with
// `null` before authService's setPersistence call moved state to localStorage,
// which made AppShell think the user was logged out and redirect.
export const auth = initializeAuth(app, {
  persistence: [
    browserLocalPersistence,
    indexedDBLocalPersistence,
    browserSessionPersistence,
  ],
  popupRedirectResolver: browserPopupRedirectResolver,
});
export const db = getFirestore(app);
export const storage = getStorage(app);
export const functions = getFunctions(app, "asia-southeast1");

// Prevent duplicate emulator connections during HMR
let emulatorsConnected = false;

function connectFirebaseEmulators() {
  if (!USE_EMULATORS) {
    debugLog("[TravelMate] Using live Firebase services");
    return;
  }

  if (emulatorsConnected) {
    return;
  }

  debugLog("[TravelMate] Connecting to Firebase Emulators...");

  try {
    connectFirestoreEmulator(db, "127.0.0.1", 8080);
    debugLog("[TravelMate] Firestore emulator connected (127.0.0.1:8080)");
  } catch (e) {
    debugWarn(
      "[TravelMate] Firestore emulator connection skipped/already connected:",
      e?.message || e
    );
  }

  try {
    connectAuthEmulator(auth, "http://127.0.0.1:9099", { disableWarnings: true });
    debugLog("[TravelMate] Auth emulator connected (127.0.0.1:9099)");
  } catch (e) {
    debugWarn(
      "[TravelMate] Auth emulator connection skipped/already connected:",
      e?.message || e
    );
  }

  try {
    connectFunctionsEmulator(functions, "127.0.0.1", 5001);
    debugLog("[TravelMate] Functions emulator connected (127.0.0.1:5001)");
  } catch (e) {
    debugWarn(
      "[TravelMate] Functions emulator connection skipped/already connected:",
      e?.message || e
    );
  }

  try {
    connectStorageEmulator(storage, "127.0.0.1", 9199);
    debugLog("[TravelMate] Storage emulator connected (127.0.0.1:9199)");
  } catch (e) {
    debugWarn(
      "[TravelMate] Storage emulator connection skipped/already connected:",
      e?.message || e
    );
  }

  emulatorsConnected = true;
  debugLog("[TravelMate] Emulator setup finished");
}

connectFirebaseEmulators();

// Create ONE provider and reuse it everywhere
export const googleProvider = new GoogleAuthProvider();
googleProvider.setCustomParameters({ prompt: "select_account" });

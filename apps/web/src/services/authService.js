// apps/web/src/services/authService.js
import { getApp, getApps, initializeApp } from "firebase/app";
import {
  browserLocalPersistence,
  createUserWithEmailAndPassword,
  fetchSignInMethodsForEmail,
  getAdditionalUserInfo,
  getRedirectResult,
  getAuth,
  reload,
  sendEmailVerification,
  setPersistence,
  signInWithEmailAndPassword,
  signInWithPopup,
  signInWithRedirect,
  signOut,
  updateProfile,
} from "firebase/auth";
import { doc, getDoc, serverTimestamp, setDoc } from "firebase/firestore";
import { auth, db, googleProvider } from "./firebase";

const OBVIOUS_FAKE_LOCAL_PARTS = new Set([
  "test",
  "testing",
  "tester",
  "sample",
  "demo",
  "fake",
  "asdf",
  "qwerty",
  "admin",
  "user",
  "temp",
  "temporary",
  "trial",
  "guest",
]);

const VERIFICATION_PROBE_APP_NAME = "travelmate-auth-verification-probe";

let authPersistencePromise = null;
let verificationProbeAuth = null;

function normalizeEmail(email) {
  return String(email || "").trim().toLowerCase();
}

function getLocalPart(email) {
  const normalized = normalizeEmail(email);
  const atIndex = normalized.indexOf("@");
  if (atIndex <= 0) return "";
  return normalized.slice(0, atIndex);
}

function looksObviouslyFakeEmail(email) {
  const localPart = getLocalPart(email);
  if (!localPart) return false;

  if (OBVIOUS_FAKE_LOCAL_PARTS.has(localPart)) return true;
  if (/^(test|fake|demo|sample|asdf|qwerty|admin|user)[._-]?\d{0,4}$/.test(localPart)) return true;

  return false;
}

function hasPasswordProvider(user) {
  const providers = Array.isArray(user?.providerData) ? user.providerData : [];
  return providers.some((item) => item?.providerId === "password");
}

function friendlyAuthError(err) {
  const code = err?.code || "";

  if (code === "tm/email-not-verified") return "Verify your email first. Check spam.";
  if (code === "auth/email-already-in-use") return "That email is already in use. Try logging in instead.";
  if (code === "auth/invalid-email") return "Please enter a valid email address.";
  if (code === "auth/weak-password") return "Password is too weak. Use at least 6 characters.";
  if (code === "auth/wrong-password" || code === "auth/invalid-credential") return "Incorrect email or password.";
  if (code === "auth/user-not-found") return "No account found for that email.";
  if (code === "auth/popup-closed-by-user") return "Google sign-in was closed before finishing.";
  if (code === "auth/popup-blocked") {
    return "Your browser blocked the Google sign-in window. We will continue with a secure redirect instead.";
  }
  if (code === "auth/cancelled-popup-request") return "Another Google sign-in window was already open. Please try again.";
  if (code === "auth/network-request-failed") return "Network error. Please check your connection and try again.";
  if (code === "auth/unauthorized-domain") return "This domain is not authorized for Google sign-in in Firebase Auth yet.";
  if (code === "auth/operation-not-allowed") return "This sign-in method is not enabled for this Firebase project yet.";
  if (code === "auth/too-many-requests") return "Too many attempts. Please wait a bit and try again.";

  return err?.message || "Authentication failed.";
}

async function ensureAuthPersistence() {
  if (!authPersistencePromise) {
    authPersistencePromise = setPersistence(auth, browserLocalPersistence).catch((err) => {
      authPersistencePromise = null;
      throw err;
    });
  }

  await authPersistencePromise;
}

function getVerificationProbeAuth() {
  if (verificationProbeAuth) {
    return verificationProbeAuth;
  }

  const existingApp = getApps().find((app) => app.name === VERIFICATION_PROBE_APP_NAME);
  const probeApp = existingApp || initializeApp(getApp().options, VERIFICATION_PROBE_APP_NAME);

  verificationProbeAuth = getAuth(probeApp);
  return verificationProbeAuth;
}

async function signInWithProbeAuth(email, password) {
  const probeAuth = getVerificationProbeAuth();
  const result = await signInWithEmailAndPassword(probeAuth, normalizeEmail(email), password);
  await reload(result.user);
  return {
    auth: probeAuth,
    user: result.user,
  };
}

async function signOutProbeAuth() {
  const probeAuth = getVerificationProbeAuth();

  if (!probeAuth.currentUser) return;
  await signOut(probeAuth);
}

function buildProfilePayload(user, { provider, isNewUser, verificationRequired = false }) {
  const providers = Array.isArray(user?.providerData)
    ? user.providerData.map((item) => item?.providerId).filter(Boolean)
    : [];

  return {
    uid: user.uid,
    displayName: user.displayName || "",
    email: user.email || null,
    photoURL: user.photoURL || null,
    providers,
    lastLoginAt: serverTimestamp(),
    updatedAt: serverTimestamp(),
    account: {
      primaryProvider: provider || providers[0] || null,
      emailVerified: !!user.emailVerified,
      emailVerificationRequired: !!verificationRequired,
      lastSignInMethod: provider || providers[0] || null,
    },
    ...(isNewUser
      ? {
          createdAt: serverTimestamp(),
        }
      : {}),
  };
}

async function ensureUserProfileDocument(user, options = {}) {
  if (!user?.uid) return;

  const profileRef = doc(db, "users", user.uid);
  const existingSnap = await getDoc(profileRef);
  const payload = buildProfilePayload(user, {
    provider: options.provider,
    isNewUser: options.isNewUser || !existingSnap.exists(),
    verificationRequired: options.verificationRequired,
  });

  await setDoc(profileRef, payload, { merge: true });
}

export async function validateSignupEmailLegitimacy(email) {
  const normalized = normalizeEmail(email);

  if (!normalized) {
    return { ok: false, message: "Please enter your email." };
  }

  if (looksObviouslyFakeEmail(normalized)) {
    return {
      ok: false,
      message: "Please use your real email address. Obvious placeholder emails are not allowed.",
    };
  }

  return { ok: true, message: "" };
}

export async function loginWithEmail(email, password) {
  try {
    await ensureAuthPersistence();

    const res = await signInWithEmailAndPassword(auth, normalizeEmail(email), password);
    await reload(res.user);

    if (hasPasswordProvider(res.user) && !res.user.emailVerified) {
    await signOut(auth);

    const error = new Error("Verify your email first. Check spam.");
    error.code = "tm/email-not-verified";
    throw error;
  }

    await ensureUserProfileDocument(res.user, {
      provider: "password",
      isNewUser: false,
      verificationRequired: false,
    });

    return {
      user: res.user,
      requiresEmailVerification: false,
    };
  } catch (err) {
    throw new Error(friendlyAuthError(err));
  }
}

export async function signupWithEmail(email, password, name) {
  const normalizedEmail = normalizeEmail(email);
  const legitimacy = await validateSignupEmailLegitimacy(normalizedEmail);

  if (!legitimacy.ok) {
    throw new Error(legitimacy.message);
  }

  try {
    await ensureAuthPersistence();

    const existingMethods = await fetchSignInMethodsForEmail(auth, normalizedEmail);
    if (existingMethods.length > 0) {
      throw new Error("That email is already in use. Try logging in instead.");
    }

    const res = await createUserWithEmailAndPassword(auth, normalizedEmail, password);

    if (name?.trim()) {
      await updateProfile(res.user, { displayName: name.trim() });
      await reload(res.user);
    }

    await sendEmailVerification(res.user);

    const currentUser = auth.currentUser || res.user;

    await signOut(auth);

    return {
      user: currentUser,
      email: normalizedEmail,
      requiresEmailVerification: true,
      nextStep: "verify_email",
      message: "Your account is almost ready. Please verify your email address to continue. Check your inbox or spam folder for the verification link.",
    };
  } catch (err) {
    throw new Error(friendlyAuthError(err));
  }
}

export async function resendVerificationEmail(email, password) {
  const normalizedEmail = normalizeEmail(email);

  if (!normalizedEmail) {
    throw new Error("Please enter your email first.");
  }

  if (!password) {
    throw new Error("Please enter your password to resend the verification email.");
  }

  try {
    const { user } = await signInWithProbeAuth(normalizedEmail, password);

    if (user.emailVerified) {
      await signOutProbeAuth();
      throw new Error("This email is already verified. You can continue now.");
    }

    await sendEmailVerification(user);
    await signOutProbeAuth();

    return { sent: true };
  } catch (err) {
    try {
      await signOutProbeAuth();
    } catch {
      // ignore sign-out cleanup errors from the probe auth session
    }

    throw new Error(friendlyAuthError(err));
  }
}

export async function completeVerifiedEmailLogin(email, password) {
  const normalizedEmail = normalizeEmail(email);

  if (!normalizedEmail || !password) {
    throw new Error("Please enter your email and password first.");
  }

  try {
    const { user: probeUser } = await signInWithProbeAuth(normalizedEmail, password);

    if (!probeUser.emailVerified) {
      await signOutProbeAuth();
      return {
        verified: false,
        user: null,
      };
    }

    await signOutProbeAuth();

    return {
      verified: true,
      user: null,
      nextStep: "login",
      message: "Email verified successfully. You can now log in.",
    };
  } catch (err) {
    try {
      await signOutProbeAuth();
    } catch {
      // ignore sign-out cleanup errors from the probe auth session
    }

    throw new Error(friendlyAuthError(err));
  }
}

export async function authenticateWithGoogle() {
  try {
    await ensureAuthPersistence();

    const res = await signInWithPopup(auth, googleProvider);
    const info = getAdditionalUserInfo(res);

    await ensureUserProfileDocument(res.user, {
      provider: "google.com",
      isNewUser: !!info?.isNewUser,
      verificationRequired: false,
    });

    return {
      user: res.user,
      isNewUser: !!info?.isNewUser,
      pendingRedirect: false,
    };
  } catch (err) {
    if (err?.code === "auth/popup-blocked" || err?.code === "auth/cancelled-popup-request") {
      await ensureAuthPersistence();
      await signInWithRedirect(auth, googleProvider);
      return {
        user: null,
        isNewUser: false,
        pendingRedirect: true,
      };
    }

    throw new Error(friendlyAuthError(err));
  }
}

export async function consumeGoogleRedirectResult() {
  try {
    await ensureAuthPersistence();

    const res = await getRedirectResult(auth);
    if (!res?.user) return null;

    const info = getAdditionalUserInfo(res);
    await ensureUserProfileDocument(res.user, {
      provider: "google.com",
      isNewUser: !!info?.isNewUser,
      verificationRequired: false,
    });

    return {
      user: res.user,
      isNewUser: !!info?.isNewUser,
      pendingRedirect: false,
    };
  } catch (err) {
    throw new Error(friendlyAuthError(err));
  }
}

export async function logout() {
  await signOut(auth);
}
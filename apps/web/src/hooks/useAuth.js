import { useEffect, useState } from "react";
import { onAuthStateChanged } from "firebase/auth";
import { auth } from "../services/firebase";

const authStore = {
  initialized: false,
  loading: true,
  user: null,
  listeners: new Set(),
  unsubscribe: null,
  pendingNullTimer: null,
  intentionalLogout: false,
};

const CROSS_TAB_NULL_DEBOUNCE_MS = 1500;

function hasPendingEmailVerification() {
  try {
    return !!sessionStorage.getItem("tm_pending_email_verification_v1");
  } catch {
    return false;
  }
}

function hasPasswordProvider(user) {
  const providers = Array.isArray(user?.providerData) ? user.providerData : [];
  return providers.some((item) => item?.providerId === "password");
}

function emitAuthState() {
  for (const listener of authStore.listeners) {
    listener({
      user: authStore.user,
      loading: authStore.loading,
    });
  }
}

function applyResolvedUser(resolvedUser) {
  if (
    resolvedUser &&
    hasPasswordProvider(resolvedUser) &&
    !resolvedUser.emailVerified &&
    hasPendingEmailVerification()
  ) {
    authStore.user = null;
    authStore.loading = false;
    emitAuthState();
    return;
  }

  authStore.user = resolvedUser;
  authStore.loading = false;
  emitAuthState();
}

function ensureAuthListener() {
  if (authStore.initialized) return;

  authStore.initialized = true;
  authStore.loading = true;

  // logoutFlow() dispatches "tm_logout" right before signOut(auth). Use that
  // signal to mark the next null tick as intentional so we apply it instantly
  // without the cross-tab debounce below.
  if (typeof window !== "undefined") {
    window.addEventListener("tm_logout", () => {
      authStore.intentionalLogout = true;
    });
  }

  // Use onAuthStateChanged (not onIdTokenChanged) so we do not react to
  // token refreshes / cross-tab Firebase sync events. Those were causing the
  // original tab to briefly re-render as "logged out" when a second tab was
  // opened via right-click -> Open link in new tab.
  authStore.unsubscribe = onAuthStateChanged(auth, (user) => {
    const resolvedUser = user || null;

    if (authStore.pendingNullTimer) {
      clearTimeout(authStore.pendingNullTimer);
      authStore.pendingNullTimer = null;
    }

    // Extra guard: if Firebase still has a currentUser but this callback
    // fired with null (can happen during cross-tab sync), ignore the null
    // tick so the UI does not flash a false logged-out state.
    if (!resolvedUser && auth.currentUser) {
      return;
    }

    // Cross-tab sync (opening a new tab) can briefly fire null on the
    // original tab while Firebase rebuilds its leader-election state. If we
    // had a user a moment ago and this null was NOT triggered by an
    // intentional logout, defer the decision and re-check shortly.
    if (!resolvedUser && authStore.user && !authStore.intentionalLogout) {
      authStore.pendingNullTimer = setTimeout(() => {
        authStore.pendingNullTimer = null;
        if (!auth.currentUser) {
          applyResolvedUser(null);
        }
      }, CROSS_TAB_NULL_DEBOUNCE_MS);
      return;
    }

    if (!resolvedUser) {
      authStore.intentionalLogout = false;
    }

    applyResolvedUser(resolvedUser);
  });
}

export function useAuth() {
  const [state, setState] = useState(() => ({
    user: authStore.user,
    loading: authStore.loading,
  }));

  useEffect(() => {
    ensureAuthListener();

    const listener = (nextState) => {
      setState(nextState);
    };

    authStore.listeners.add(listener);

    setState({
      user: authStore.user,
      loading: authStore.loading,
    });

    return () => {
      authStore.listeners.delete(listener);
    };
  }, []);

  return state;
}
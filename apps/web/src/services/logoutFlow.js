// apps/web/src/services/logoutFlow.js

import { auth } from "./firebase";
import { logout as firebaseLogout } from "./authService";
import { serverLogout } from "./apiClient";
import { broadcastLogout, clearTravelMateStorage } from "../utils/logout";

/**
 * Full logout flow:
 * - Immediately clears UI state + storage (privacy)
 * - Best-effort server token invalidation
 * - Firebase signOut
 */
export async function logoutFlow() {
  // 1) Clear UI immediately (prevents chat flash / privacy leaks)
  broadcastLogout();
  clearTravelMateStorage();

  // 2) Best-effort token revoke on backend (if available)
  try {
    const token = await auth.currentUser?.getIdToken?.();
    if (token) await serverLogout(token);
  } catch {
    // ignore
  }

  // 3) Sign out client
  try {
    await firebaseLogout();
  } catch {
    // ignore
  }
}
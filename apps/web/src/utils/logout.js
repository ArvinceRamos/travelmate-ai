// apps/web/src/utils/logout.js

export function clearTravelMateStorage() {
  // Clear ONLY TravelMate keys so we don't nuke unrelated apps running on same domain.
  try {
    const rm = (store) => {
      const keys = [];
      for (let i = 0; i < store.length; i++) {
        const k = store.key(i);
        if (k && k.startsWith("tm_")) keys.push(k);
      }
      keys.forEach((k) => store.removeItem(k));
    };

    rm(window.localStorage);
    rm(window.sessionStorage);
  } catch {
    // ignore
  }
}

export function broadcastLogout() {
  try {
    window.dispatchEvent(new Event("tm_logout"));
  } catch {
    // ignore
  }
}
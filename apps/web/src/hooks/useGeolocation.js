import { useCallback } from "react";

const LOCATION_CACHE_KEY = "tm_device_location_v1";
const DEFAULT_MAX_AGE_MS = 5 * 60 * 1000;

function normalizeCachedLocation(value) {
  if (!value || typeof value !== "object") return null;

  const lat = Number(value.lat ?? value.latitude);
  const lng = Number(value.lng ?? value.longitude);
  const capturedAt = Number(value.capturedAt || value.timestamp || 0);
  const accuracyMeters = Number(value.accuracyMeters ?? value.accuracy ?? NaN);
  const source = String(value.source || "device").trim() || "device";

  if (!Number.isFinite(lat) || !Number.isFinite(lng)) return null;
  if (lat < -90 || lat > 90 || lng < -180 || lng > 180) return null;
  if (!Number.isFinite(capturedAt) || capturedAt <= 0) return null;

  return {
    lat,
    lng,
    accuracyMeters: Number.isFinite(accuracyMeters) ? accuracyMeters : null,
    capturedAt,
    source,
    permissionState: String(value.permissionState || value.permission || "").trim().toLowerCase() || null,
    trustedExact: value.trustedExact === true,
  };
}

function readCachedLocation() {
  if (typeof window === "undefined") return null;

  try {
    return normalizeCachedLocation(JSON.parse(window.sessionStorage.getItem(LOCATION_CACHE_KEY) || "null"));
  } catch {
    return null;
  }
}

function writeCachedLocation(value) {
  if (typeof window === "undefined") return;

  try {
    window.sessionStorage.setItem(LOCATION_CACHE_KEY, JSON.stringify(value));
  } catch {
    // ignore storage failures
  }
}

function clearCachedLocation() {
  if (typeof window === "undefined") return;

  try {
    window.sessionStorage.removeItem(LOCATION_CACHE_KEY);
  } catch {
    // ignore storage failures
  }
}

function isFreshLocation(value, maxAgeMs = DEFAULT_MAX_AGE_MS) {
  const normalized = normalizeCachedLocation(value);
  if (!normalized) return false;
  return Date.now() - normalized.capturedAt <= maxAgeMs;
}

async function getPermissionState() {
  if (typeof navigator === "undefined" || !navigator.permissions?.query) {
    return "unknown";
  }

  try {
    const status = await navigator.permissions.query({ name: "geolocation" });
    return String(status?.state || "unknown");
  } catch {
    return "unknown";
  }
}

export function useGeolocation() {
  const getLocationPermissionState = useCallback(async () => {
    return getPermissionState();
  }, []);

  const getCachedLocation = useCallback(async (maxAgeMs = DEFAULT_MAX_AGE_MS) => {
    const permissionState = await getPermissionState();

    if (permissionState === "denied") {
      clearCachedLocation();
      return null;
    }

    if (permissionState !== "granted") {
      return null;
    }

    const cached = readCachedLocation();
    if (!isFreshLocation(cached, maxAgeMs)) return null;

    return {
      ...cached,
      permissionState: "granted",
      trustedExact: true,
      source: String(cached?.source || "device"),
    };
  }, []);

  const requestCurrentLocation = useCallback(
    async ({ maxAgeMs = DEFAULT_MAX_AGE_MS, timeoutMs = 12000, highAccuracy = true } = {}) => {
      const permissionState = await getPermissionState();

      if (permissionState === "denied") {
        clearCachedLocation();
        throw new Error("Location access was denied.");
      }

      const freshCached = readCachedLocation();
      if (permissionState === "granted" && isFreshLocation(freshCached, maxAgeMs)) {
        return freshCached;
      }

      return new Promise((resolve, reject) => {
        if (typeof navigator === "undefined" || !navigator.geolocation) {
          reject(new Error("Location services are not available in this browser."));
          return;
        }

        navigator.geolocation.getCurrentPosition(
          (pos) => {
            const next = {
              lat: Number(pos.coords.latitude),
              lng: Number(pos.coords.longitude),
              accuracyMeters: Number.isFinite(Number(pos.coords.accuracy))
                ? Number(pos.coords.accuracy)
                : null,
              capturedAt: Date.now(),
              source: "device",
              permissionState: "granted",
              trustedExact: true,
            };

            writeCachedLocation(next);
            resolve(next);
          },
          (err) => {
            if (err?.code === 1) {
              clearCachedLocation();
              reject(new Error("Location access was denied."));
              return;
            }

            reject(new Error(err?.message || "Couldn’t get your current location."));
          },
          {
            enableHighAccuracy: highAccuracy,
            timeout: timeoutMs,
            maximumAge: 0,
          }
        );
      });
    },
    []
  );

  return {
    getCachedLocation,
    requestCurrentLocation,
    clearCachedLocation,
    isFreshLocation,
    getLocationPermissionState,
    LOCATION_MAX_AGE_MS: DEFAULT_MAX_AGE_MS,
  };
}

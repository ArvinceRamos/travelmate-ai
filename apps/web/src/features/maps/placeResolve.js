const CACHE_KEY = "tm_map_place_resolve_v1";
const TTL_MS = 7 * 24 * 60 * 60 * 1000;
const MAX_ITEMS = 200;

function safeJsonParse(raw) {
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

function normalizeKey(query = "", opts = {}) {
  const q = String(query || "")
    .trim()
    .toLowerCase()
    .replace(/\s+/g, " ")
    .slice(0, 180);

  const lat = Number(opts?.center?.lat);
  const lng = Number(opts?.center?.lng);
  const radius = Number(opts?.radiusMeters);

  // Keep stable but not overly specific
  const keyObj = {
    q,
    lat: Number.isFinite(lat) ? Number(lat.toFixed(4)) : null,
    lng: Number.isFinite(lng) ? Number(lng.toFixed(4)) : null,
    r: Number.isFinite(radius) ? Math.min(50000, Math.max(0, Math.round(radius))) : null,
  };

  return JSON.stringify(keyObj);
}

function readCache() {
  if (typeof window === "undefined") return {};
  const raw = window.localStorage?.getItem(CACHE_KEY);
  const parsed = safeJsonParse(raw || "");
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
  return parsed;
}

function writeCache(next) {
  if (typeof window === "undefined") return;
  try {
    window.localStorage?.setItem(CACHE_KEY, JSON.stringify(next));
  } catch {
    // ignore quota/private mode
  }
}

function isFresh(ts) {
  return Number.isFinite(ts) && Date.now() - ts <= TTL_MS;
}

function pruneCache(cache) {
  const entries = Object.entries(cache || {}).filter(([, value]) => {
    return value && typeof value === "object" && isFresh(value.ts);
  });

  entries.sort((a, b) => (b[1]?.ts || 0) - (a[1]?.ts || 0));

  const next = {};
  for (const [key, value] of entries.slice(0, MAX_ITEMS)) {
    next[key] = value;
  }
  return next;
}

export function getCachedPlace(query = "", opts = {}) {
  const key = normalizeKey(query, opts);
  if (!key) return null;

  const cache = pruneCache(readCache());
  const row = cache[key];
  if (!row || !isFresh(row.ts)) return null;

  return row.place || null;
}

export function cachePlace(query = "", place = null, opts = {}) {
  const key = normalizeKey(query, opts);
  if (!key || !place) return;

  const cache = pruneCache(readCache());
  const next = {
    ...cache,
    [key]: {
      ts: Date.now(),
      place,
    },
  };

  writeCache(pruneCache(next));
}
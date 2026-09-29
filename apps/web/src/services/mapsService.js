const PHOTON_URL = (
  import.meta.env.VITE_PHOTON_BASE_URL || "https://photon.komoot.io/api/"
).replace(/\/?$/, "/");
const CACHE_TTL_MS = 5 * 60 * 1000;
const CACHE_MAX_ITEMS = 100;
const placeCache = new Map();

function normalizeCenter(center) {
  const lat = Number(center?.lat);
  const lng = Number(center?.lng);
  return Number.isFinite(lat) && Number.isFinite(lng) ? { lat, lng } : null;
}

function cacheKey(query, center, limit, radiusMeters, restrictToCircle) {
  const normalizedCenter = normalizeCenter(center);
  return JSON.stringify({
    query: String(query || "").trim().toLowerCase().replace(/\s+/g, " "),
    lat: normalizedCenter ? Number(normalizedCenter.lat.toFixed(2)) : null,
    lng: normalizedCenter ? Number(normalizedCenter.lng.toFixed(2)) : null,
    limit,
    radiusMeters: Number(radiusMeters) || 0,
    restrictToCircle: Boolean(restrictToCircle),
  });
}

function mapFeature(feature) {
  const properties = feature?.properties || {};
  const [lng, lat] = feature?.geometry?.coordinates || [];
  if (!Number.isFinite(Number(lat)) || !Number.isFinite(Number(lng))) return null;

  const name = String(
    properties.name ||
      properties.street ||
      properties.city ||
      properties.state ||
      properties.country ||
      "Unnamed place"
  ).trim();
  const address = String(properties.label || name).trim();

  return {
    id:
      properties.osm_type && properties.osm_id
        ? `${properties.osm_type}:${properties.osm_id}`
        : `${lat},${lng}`,
    name,
    address,
    rating: null,
    openNow: null,
    position: { lat: Number(lat), lng: Number(lng) },
  };
}

function distanceMeters(a, b) {
  const toRadians = (degrees) => (degrees * Math.PI) / 180;
  const dLat = toRadians(b.lat - a.lat);
  const dLng = toRadians(b.lng - a.lng);
  const lat1 = toRadians(a.lat);
  const lat2 = toRadians(b.lat);
  const h =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLng / 2) ** 2;
  return 6371000 * 2 * Math.atan2(Math.sqrt(h), Math.sqrt(1 - h));
}

function remember(key, places) {
  placeCache.set(key, { timestamp: Date.now(), places });
  if (placeCache.size > CACHE_MAX_ITEMS) {
    placeCache.delete(placeCache.keys().next().value);
  }
}

export async function placesTextSearch({
  query,
  center = null,
  radiusMeters = 50000,
  maxResultCount = 10,
  restrictToCircle = false,
  signal,
} = {}) {
  const cleanQuery = String(query || "").trim();
  if (!cleanQuery) return { ok: false, reason: "empty-query" };

  const limit = Math.min(20, Math.max(1, Number(maxResultCount) || 10));
  const normalizedCenter = normalizeCenter(center);
  const key = cacheKey(cleanQuery, normalizedCenter, limit, radiusMeters, restrictToCircle);
  const cached = placeCache.get(key);

  if (cached && Date.now() - cached.timestamp < CACHE_TTL_MS) {
    return { ok: true, places: cached.places, fromCache: true };
  }

  const params = new URLSearchParams({
    q: cleanQuery,
    limit: String(limit),
    lang: "en",
  });

  if (normalizedCenter) {
    params.set("lat", String(normalizedCenter.lat));
    params.set("lon", String(normalizedCenter.lng));
    params.set("zoom", "12");
  }

  try {
    const response = await fetch(`${PHOTON_URL}?${params}`, {
      headers: { Accept: "application/json" },
      signal,
    });

    if (!response.ok) {
      return {
        ok: false,
        reason: response.status === 429 ? "rate-limited" : "http-error",
        status: response.status,
      };
    }

    const data = await response.json();
    let places = (Array.isArray(data?.features) ? data.features : [])
      .map(mapFeature)
      .filter(Boolean);

    if (restrictToCircle && normalizedCenter) {
      const radius = Math.max(0, Number(radiusMeters) || 0);
      places = places.filter(
        (place) => distanceMeters(normalizedCenter, place.position) <= radius
      );
    }

    remember(key, places);
    return { ok: true, places, fromCache: false };
  } catch (error) {
    if (error?.name === "AbortError") return { ok: false, reason: "aborted" };
    return { ok: false, reason: "network-error" };
  }
}

export async function resolvePlaceLatLng({
  query,
  center = null,
  radiusMeters = 50000,
  restrictToCircle = false,
  signal,
} = {}) {
  const result = await placesTextSearch({
    query,
    center,
    radiusMeters,
    maxResultCount: 5,
    restrictToCircle,
    signal,
  });

  if (!result.ok) return result;
  if (!result.places.length) return { ok: false, reason: "no-results" };

  return {
    ok: true,
    place: result.places[0],
    fromCache: result.fromCache,
  };
}

export async function placesAutocomplete({ query, center = null, limit = 8, signal } = {}) {
  const result = await placesTextSearch({ query, center, maxResultCount: limit, signal });
  if (!result.ok) return { ok: false, reason: result.reason };
  return {
    ok: true,
    suggestions: result.places.map((place) => {
      const description = place.address || place.name;
      const main = place.name || description;
      return {
        placeId: place.id,
        description,
        main,
        secondary: description.startsWith(main)
          ? description.slice(main.length).replace(/^,\s*/, "")
          : description,
        position: place.position,
      };
    }),
  };
}

export function clearPlacesCache() {
  placeCache.clear();
}

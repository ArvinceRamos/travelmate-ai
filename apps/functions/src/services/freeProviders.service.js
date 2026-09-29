"use strict";

const CACHE_TTL_MS = Number(process.env.FREE_PROVIDER_CACHE_TTL_MS) || 5 * 60_000;
const CACHE_MAX_ITEMS = 250;
const cache = new Map();
let nominatimQueue = Promise.resolve();
let nominatimLastRequestAt = 0;

class ProviderError extends Error {
  constructor(message, status = 502, retryAfter = null) {
    super(message);
    this.name = "ProviderError";
    this.status = status;
    this.retryAfter = retryAfter;
  }
}

function cacheGet(key) {
  const item = cache.get(key);
  if (!item) return null;
  if (item.expiresAt <= Date.now()) {
    cache.delete(key);
    return null;
  }
  return item.value;
}

function cacheSet(key, value, ttlMs = CACHE_TTL_MS) {
  cache.delete(key);
  cache.set(key, { value, expiresAt: Date.now() + ttlMs });
  while (cache.size > CACHE_MAX_ITEMS) cache.delete(cache.keys().next().value);
  return value;
}

function cacheKey(prefix, value) {
  return `${prefix}:${JSON.stringify(value)}`;
}

async function fetchJson(url, options = {}, timeoutMs = 8_000) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, {
      ...options,
      signal: options.signal || controller.signal,
      headers: { Accept: "application/json", ...(options.headers || {}) },
    });
    if (!response.ok) {
      const retryAfter = response.headers.get("retry-after");
      const status = response.status === 429 ? 429 : response.status === 504 ? 504 : 502;
      throw new ProviderError(
        response.status === 429
          ? "Free map service is rate-limited. Please retry shortly."
          : response.status === 504
            ? "Free map service timed out. Please retry shortly."
            : "Free map service is temporarily unavailable.",
        status,
        retryAfter
      );
    }
    return await response.json();
  } catch (error) {
    if (error instanceof ProviderError) throw error;
    if (error?.name === "AbortError") {
      throw new ProviderError("Free map service timed out. Please retry shortly.", 504);
    }
    throw new ProviderError("Could not connect to the free map service.", 502);
  } finally {
    clearTimeout(timeout);
  }
}

function featureToPlace(feature) {
  const properties = feature?.properties || {};
  const [longitude, latitude] = feature?.geometry?.coordinates || [];
  if (!Number.isFinite(Number(latitude)) || !Number.isFinite(Number(longitude))) return null;
  const name = String(properties.name || properties.street || properties.city || "Unnamed place").trim();
  return {
    id: properties.osm_type && properties.osm_id ? `${properties.osm_type}:${properties.osm_id}` : `${latitude},${longitude}`,
    name,
    address: String(properties.label || name).trim(),
    location: { lat: Number(latitude), lng: Number(longitude) },
    rating: null,
    userRatingCount: null,
    openNow: null,
    openingHours: null,
    provider: "photon",
  };
}

async function photonSearch(query, { lat, lon, limit = 10, signal } = {}) {
  const q = String(query || "").trim();
  if (!q || q.length > 200) throw new ProviderError("Search query must be 1-200 characters.", 400);
  const boundedLimit = Math.min(20, Math.max(1, Number(limit) || 10));
  const key = cacheKey("photon", { q: q.toLowerCase(), lat, lon, limit: boundedLimit });
  const cached = cacheGet(key);
  if (cached) return cached;
  const base = (process.env.PHOTON_BASE_URL || "https://photon.komoot.io/api/").replace(/\/$/, "");
  const params = new URLSearchParams({ q, limit: String(boundedLimit), lang: "en" });
  if (Number.isFinite(Number(lat)) && Number.isFinite(Number(lon))) {
    params.set("lat", String(lat));
    params.set("lon", String(lon));
    params.set("zoom", "12");
  }
  const data = await fetchJson(`${base}?${params}`, { signal });
  const places = (Array.isArray(data?.features) ? data.features : []).map(featureToPlace).filter(Boolean);
  return cacheSet(key, places, 60_000);
}

function nominatimRequest(url) {
  const request = nominatimQueue.then(async () => {
    const waitMs = Math.max(0, 1000 - (Date.now() - nominatimLastRequestAt));
    if (waitMs) await new Promise((resolve) => setTimeout(resolve, waitMs));
    nominatimLastRequestAt = Date.now();
    return fetchJson(url, {
      headers: {
        "User-Agent": process.env.NOMINATIM_USER_AGENT || "TravelmateAI/1.0 (contact: configure-NOMINATIM_CONTACT)",
      },
    });
  });
  nominatimQueue = request.catch(() => undefined);
  return request;
}

async function nominatimSearch(query, limit = 5) {
  const text = String(query || "").trim();
  if (!text || text.length > 200) throw new ProviderError("Search query must be 1-200 characters.", 400);
  const boundedLimit = Math.min(10, Math.max(1, Number(limit) || 5));
  const key = cacheKey("nominatim-search", [text.toLowerCase(), boundedLimit]);
  const cached = cacheGet(key);
  if (cached) return cached;

  const base = (process.env.NOMINATIM_BASE_URL || "https://nominatim.openstreetmap.org").replace(/\/$/, "");
  const params = new URLSearchParams({
    format: "jsonv2",
    q: text,
    addressdetails: "1",
    limit: String(boundedLimit),
  });
  const rows = await nominatimRequest(`${base}/search?${params}`);
  const results = (Array.isArray(rows) ? rows : []).map((row) => {
    const lat = Number(row.lat);
    const lon = Number(row.lon);
    if (!Number.isFinite(lat) || !Number.isFinite(lon)) return null;
    const addressDetails = row.address || {};
    return {
      id: row.osm_type && row.osm_id ? `${String(row.osm_type).toLowerCase()}:${row.osm_id}` : String(row.place_id || ""),
      name: String(row.name || row.display_name || "Unnamed place").split(",")[0].trim(),
      address: String(row.display_name || "").trim() || null,
      location: { lat, lng: lon },
      city: String(addressDetails.city || addressDetails.town || addressDetails.village || addressDetails.municipality || addressDetails.county || "").trim() || null,
      country: String(addressDetails.country || "").trim() || null,
      countryCode: String(addressDetails.country_code || "").trim().toUpperCase() || null,
      resultType: String(row.type || row.class || "").trim() || null,
      rating: null,
      userRatingCount: null,
      openNow: null,
      openingHours: null,
      provider: "nominatim",
    };
  }).filter(Boolean);
  return cacheSet(key, results, 24 * 60 * 60_000);
}

async function reverseGeocode(lat, lon) {
  const latitude = Number(lat);
  const longitude = Number(lon);
  if (!Number.isFinite(latitude) || !Number.isFinite(longitude)) {
    throw new ProviderError("Valid latitude and longitude are required.", 400);
  }
  const key = cacheKey("nominatim-reverse", [latitude.toFixed(5), longitude.toFixed(5)]);
  const cached = cacheGet(key);
  if (cached) return cached;
  const base = (process.env.NOMINATIM_BASE_URL || "https://nominatim.openstreetmap.org").replace(/\/$/, "");
  const params = new URLSearchParams({ format: "jsonv2", lat: String(latitude), lon: String(longitude), zoom: "18" });
  const data = await nominatimRequest(`${base}/reverse?${params}`);
  const result = { address: String(data?.display_name || "").trim() || null };
  return cacheSet(key, result, 24 * 60 * 60_000);
}

async function nearbyPlaces(lat, lon, radiusMeters = 1000, limit = 20) {
  const latitude = Number(lat);
  const longitude = Number(lon);
  if (!Number.isFinite(latitude) || !Number.isFinite(longitude)) throw new ProviderError("Valid coordinates are required.", 400);
  const radius = Math.min(5000, Math.max(100, Number(radiusMeters) || 1000));
  const boundedLimit = Math.min(30, Math.max(1, Number(limit) || 20));
  const key = cacheKey("overpass", [latitude.toFixed(3), longitude.toFixed(3), radius, boundedLimit]);
  const cached = cacheGet(key);
  if (cached) return cached;
  const base = (process.env.OVERPASS_BASE_URL || "https://overpass-api.de/api/interpreter").replace(/\/$/, "");
  const query = `[out:json][timeout:8];(node(around:${radius},${latitude},${longitude})[name];way(around:${radius},${latitude},${longitude})[name];);out center ${boundedLimit};`;
  const data = await fetchJson(base, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ data: query }),
  }, 10_000);
  const places = (Array.isArray(data?.elements) ? data.elements : []).slice(0, boundedLimit).map((item) => {
    const latValue = Number(item.lat ?? item.center?.lat);
    const lonValue = Number(item.lon ?? item.center?.lon);
    if (!Number.isFinite(latValue) || !Number.isFinite(lonValue)) return null;
    const tags = item.tags || {};
    const name = String(tags.name || "Unnamed place");
    return {
      id: `${item.type}:${item.id}`,
      name,
      address: [tags["addr:street"], tags["addr:housenumber"], tags["addr:city"]].filter(Boolean).join(", ") || null,
      location: { lat: latValue, lng: lonValue },
      rating: null,
      userRatingCount: null,
      openNow: null,
      openingHours: tags.opening_hours || null,
      provider: "overpass",
    };
  }).filter(Boolean);
  return cacheSet(key, places, 10 * 60_000);
}

async function route(positions, profile = "driving") {
  if (!Array.isArray(positions) || positions.length < 2 || positions.length > 20) {
    throw new ProviderError("A route needs 2-20 coordinate points.", 400);
  }
  const valid = positions.map((point) => ({ lat: Number(point.lat), lng: Number(point.lng) }));
  if (valid.some((point) => !Number.isFinite(point.lat) || !Number.isFinite(point.lng))) {
    throw new ProviderError("Route coordinates are invalid.", 400);
  }
  const selectedProfile = ["driving", "foot", "cycling"].includes(profile) ? profile : null;
  if (!selectedProfile) throw new ProviderError("That travel mode is unavailable for this routing service.", 400);
  const key = cacheKey("osrm", [selectedProfile, valid]);
  const cached = cacheGet(key);
  if (cached) return cached;
  const base = (process.env.OSRM_BASE_URL || "https://router.project-osrm.org").replace(/\/$/, "");
  const coordinates = valid.map((point) => `${point.lng},${point.lat}`).join(";");
  const params = new URLSearchParams({ overview: "full", geometries: "geojson", steps: "true" });
  const data = await fetchJson(`${base}/route/v1/${selectedProfile}/${coordinates}?${params}`);
  if (data?.code !== "Ok" || !data?.routes?.[0]) throw new ProviderError("No route was found for those locations.", 404);
  return cacheSet(key, data.routes[0], 60_000);
}

async function currentWeather(lat, lon) {
  const latitude = Number(lat);
  const longitude = Number(lon);
  if (!Number.isFinite(latitude) || !Number.isFinite(longitude)) throw new ProviderError("Valid coordinates are required.", 400);
  const key = cacheKey("open-meteo", [latitude.toFixed(2), longitude.toFixed(2)]);
  const cached = cacheGet(key);
  if (cached) return cached;
  const base = (process.env.OPEN_METEO_BASE_URL || "https://api.open-meteo.com/v1/forecast").replace(/\/$/, "");
  const params = new URLSearchParams({ latitude: String(latitude), longitude: String(longitude), current: "temperature_2m,relative_humidity_2m,apparent_temperature,weather_code,wind_speed_10m", timezone: "auto" });
  const data = await fetchJson(`${base}?${params}`);
  const current = data?.current;
  if (!current) throw new ProviderError("Weather data is temporarily unavailable.", 502);
  const result = {
    latitude: data.latitude,
    longitude: data.longitude,
    temperatureC: current.temperature_2m ?? null,
    feelsLikeC: current.apparent_temperature ?? null,
    humidityPercent: current.relative_humidity_2m ?? null,
    windSpeedKmh: current.wind_speed_10m ?? null,
    weatherCode: current.weather_code ?? null,
    time: current.time || null,
    attribution: "Weather data by Open-Meteo.com (CC BY 4.0)",
  };
  return cacheSet(key, result, 10 * 60_000);
}

function clearProviderCache() {
  cache.clear();
}

function sendProviderError(res, error, fallback) {
  const status = Number(error?.status);
  if (error?.retryAfter) res.set("Retry-After", String(error.retryAfter));
  return res.status(status >= 400 && status <= 599 ? status : 502).json({
    ok: false,
    error: String(error?.message || fallback),
  });
}

module.exports = { ProviderError, photonSearch, nominatimSearch, reverseGeocode, nearbyPlaces, route, currentWeather, clearProviderCache, sendProviderError };

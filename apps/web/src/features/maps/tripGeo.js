// Geocoded stop locations stored on the itinerary doc as `mapGeo`, so a trip
// is geocoded once and later opens draw pins without network calls.
//
// mapGeo = {
//   v: 1,
//   anchor: { label, lat, lng } | { label, missing: true },
//   places: [{ k, q, lat, lng, name } | { k, q, missing: true, r }],
// }
// `r` is the resolver version that gave up on a place; misses from an older
// resolver are dropped on read so the current one retries them once.
// `k` is placeKey(query); stops look their coordinates up by that key, so the
// same place on several days is geocoded once and edits only resolve new text.

import { placeKey } from "../../utils/itineraryParse.js";

export const MAP_GEO_VERSION = 1;
export const RESOLVER_VERSION = 2;
const NEAR_BASE_KM = 150;
const MIN_TRIP_RADIUS_KM = 150;
const OUTLIER_FACTOR = 4;

function isNum(n) {
  return typeof n === "number" && Number.isFinite(n);
}

export function distanceKm(a, b) {
  if (!a || !b || !isNum(a.lat) || !isNum(a.lng) || !isNum(b.lat) || !isNum(b.lng)) return Infinity;
  const rad = (d) => (d * Math.PI) / 180;
  const dLat = rad(b.lat - a.lat);
  const dLng = rad(b.lng - a.lng);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.sin(dLng / 2) ** 2;
  return 6371 * 2 * Math.atan2(Math.sqrt(h), Math.sqrt(1 - h));
}

/** Coordinates already known for an itinerary: saved mapGeo plus any located AI mapStops. */
export function readMapGeo(itinerary) {
  const raw = itinerary?.mapGeo;
  const places = {};
  let anchor = null;

  if (raw?.v === MAP_GEO_VERSION) {
    for (const p of Array.isArray(raw.places) ? raw.places : []) {
      if (!p?.k) continue;
      if (p.missing) {
        if ((Number(p.r) || 1) >= RESOLVER_VERSION) places[p.k] = { q: p.q || "", missing: true };
      }
      else if (isNum(p.lat) && isNum(p.lng)) places[p.k] = { q: p.q || "", lat: p.lat, lng: p.lng, name: p.name || "" };
    }
    const a = raw.anchor;
    if (a?.label && (a.missing || (isNum(a.lat) && isNum(a.lng)))) anchor = a;
  }

  for (const s of Array.isArray(itinerary?.mapStops) ? itinerary.mapStops : []) {
    const k = placeKey(s?.label);
    const lat = Number(s?.location?.lat);
    const lng = Number(s?.location?.lng);
    if (k && !places[k] && isNum(lat) && isNum(lng)) {
      places[k] = { q: String(s.label), lat, lng, name: String(s.label) };
    }
  }

  return { anchor, places };
}

/** Unique geocoder queries needed by a list of stops, keyed by placeKey. */
export function stopQueries(stops = []) {
  const out = new Map();
  for (const s of stops) {
    for (const q of [s.query, s.fromQuery]) {
      const k = placeKey(q);
      if (k && !out.has(k)) out.set(k, q);
    }
  }
  return out;
}

/** Serializable mapGeo for the doc, keeping only places the stops still use. */
export function buildMapGeo({ anchor, places, queries }) {
  const list = [];
  for (const [k, q] of queries) {
    const p = places[k];
    if (!p) continue;
    list.push(p.missing ? { k, q, missing: true, r: RESOLVER_VERSION } : { k, q, lat: p.lat, lng: p.lng, name: p.name || "" });
  }
  return { v: MAP_GEO_VERSION, anchor: anchor || null, places: list };
}

function median(values) {
  const v = [...values].sort((a, b) => a - b);
  const mid = Math.floor(v.length / 2);
  return v.length % 2 ? v[mid] : (v[mid - 1] + v[mid]) / 2;
}

const AIRPORT_RE = /\b(airport|airfield)\b/;
const MAX_DRIVE_LEG_KM = 150;

export function isAirportQuery(query) {
  return AIRPORT_RE.test(placeKey(query));
}

/**
 * Splits route points into road runs for OSRM (at most `maxPoints` each,
 * neighbours sharing an endpoint) and straight "jump" legs that no road
 * covers: airport to airport (a flight) or longer than 150 km.
 * Points are { lat, lng, airport }.
 */
export function routeSegments(points = [], { maxPoints = 20 } = {}) {
  const segments = [];
  const pushRun = (run) => {
    for (let s = 0; s < run.length - 1; s += maxPoints - 1) {
      segments.push({ type: "drive", points: run.slice(s, s + maxPoints) });
    }
  };
  let run = points.slice(0, 1);
  for (let i = 1; i < points.length; i++) {
    const a = points[i - 1];
    const b = points[i];
    if ((a.airport && b.airport) || distanceKm(a, b) > MAX_DRIVE_LEG_KM) {
      pushRun(run);
      segments.push({ type: "jump", points: [a, b] });
      run = [b];
    } else {
      run.push(b);
    }
  }
  pushRun(run);
  return segments;
}

function sharedWords(query, name, ignore = null) {
  const words = new Set(placeKey(query).split(" ").filter((w) => w.length > 2 && !ignore?.has(w)));
  return placeKey(name).split(" ").filter((w) => words.has(w)).length;
}

const GENERIC_WORDS = new Set([
  "the", "and", "beach", "resort", "hotel", "inn", "city", "town", "park", "island", "restaurant",
  "cafe", "bar", "market", "public", "street", "road", "boulevard", "mall", "church", "falls", "bay",
  "point", "center", "centre", "international", "airport", "port", "pier", "terminal", "station",
]);
const HUB_RE = /\b(airport|airfield|seaport|port|pier|wharf|terminal|station)\b/;

// A far hit is still trusted when the geocoder's own name clearly is the stop: every
// distinctive word of the name is in the stop ("General Antonio Luna" is not "General
// Luna Boulevard"). A name equal to the query text was copied from it (AI mapStops).
function strongMatch(p) {
  if (!p.name || !p.q || p.name === p.q) return false;
  const queryWords = new Set(placeKey(p.q).split(" "));
  const nameWords = placeKey(p.name).split(" ").filter((w) => w.length > 2 && !GENERIC_WORDS.has(w));
  if (!nameWords.every((w) => queryWords.has(w))) return false;
  const shared = sharedWords(p.q, p.name, GENERIC_WORDS);
  return shared >= 2 || (shared >= 1 && HUB_RE.test(placeKey(p.q)) && HUB_RE.test(placeKey(p.name)));
}

/**
 * Keys whose location is far outside the area the rest of the trip covers
 * (usually a same-name place in another region). The area is the median
 * centre of the resolved stops with a radius of 4× the median distance,
 * never smaller than 150 km. Far hits that strongly match their stop's name
 * (e.g. the departure airport on another island) are kept.
 */
export function tripOutlierKeys(places = {}, keys = []) {
  const pts = keys.map((k) => [k, places[k]]).filter(([, p]) => p && !p.missing);
  if (pts.length < 3) return new Set();
  const centre = { lat: median(pts.map(([, p]) => p.lat)), lng: median(pts.map(([, p]) => p.lng)) };
  const dists = pts.map(([k, p]) => [k, p, distanceKm(centre, p)]);
  const limit = Math.max(MIN_TRIP_RADIUS_KM, OUTLIER_FACTOR * median(dists.map(([, , d]) => d)));
  return new Set(dists.filter(([, p, d]) => d > limit && !strongMatch(p)).map(([k]) => k));
}

/** Hits near the trip base first; among those, the name sharing most words with the query (ties keep search order). */
export function pickHit(query, hits = [], center = null) {
  const near = center ? hits.filter((h) => distanceKm(center, h.position) <= NEAR_BASE_KM) : [];
  const pool = near.length ? near : hits;
  let best = pool[0];
  for (const h of pool) if (sharedWords(query, h.name) > sharedWords(query, best.name)) best = h;
  return best;
}

/**
 * Geocode the anchor (if unknown) and every query not in `known`.
 * `search(query, { center, base, signal })` returns [{ name, position: { lat, lng } }].
 * Results stream through onAnchor/onPlace; network errors leave the key
 * unresolved so it is retried next time, while "no match" is stored.
 */
export async function resolveTripPlaces({
  queries,
  known = {},
  anchor = null,
  anchorLabel = "",
  search,
  signal,
  onAnchor,
  onPlace,
  concurrency = 3,
}) {
  let base = anchor;
  if (anchorLabel && (!base || base.label !== anchorLabel)) {
    try {
      const hits = await search(anchorLabel, { signal });
      if (signal?.aborted) return;
      const hit = hits[0]?.position;
      base = hit ? { label: anchorLabel, lat: hit.lat, lng: hit.lng } : { label: anchorLabel, missing: true };
      onAnchor?.(base);
    } catch {
      if (signal?.aborted) return;
    }
  }

  const center = base && !base.missing ? { lat: base.lat, lng: base.lng } : null;
  const todo = [...queries].filter(([k]) => !known[k]);
  let next = 0;

  const worker = async () => {
    while (next < todo.length && !signal?.aborted) {
      const [k, q] = todo[next++];
      try {
        const hits = await search(q, { center, base: anchorLabel, signal });
        if (signal?.aborted) return;
        const pick = pickHit(q, hits, center);
        onPlace?.(
          k,
          pick?.position
            ? { q, lat: pick.position.lat, lng: pick.position.lng, name: pick.name || q }
            : { q, missing: true }
        );
      } catch {
        if (signal?.aborted) return;
      }
    }
  };

  await Promise.all(Array.from({ length: Math.min(concurrency, todo.length) }, worker));
}

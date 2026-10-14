// Suggestions that need no network: the user's recent picks and stops from
// their saved trips that already have coordinates. Shown from the first letter.

import { placeKey } from "../../utils/itineraryParse.js";
import { distanceKm, readMapGeo, tripOutlierKeys } from "./tripGeo.js";

const RECENTS_MAX = 20;
const RECENTS_PREFIX = "tm_place_recents_v1:";

function storage() {
  try {
    return typeof window !== "undefined" ? window.localStorage : null;
  } catch {
    return null;
  }
}

function validPosition(p) {
  return p && Number.isFinite(Number(p.lat)) && Number.isFinite(Number(p.lng));
}

export function loadRecents(userKey) {
  if (!userKey) return [];
  try {
    const list = JSON.parse(storage()?.getItem(RECENTS_PREFIX + userKey) || "[]");
    return Array.isArray(list) ? list.filter((r) => r?.description && validPosition(r.position)) : [];
  } catch {
    return [];
  }
}

export function saveRecent(userKey, item) {
  if (!userKey || !item?.description || !validPosition(item.position)) return;
  const row = {
    placeId: item.placeId || "",
    description: item.description,
    main: item.main || item.description,
    secondary: item.kind === "trip" ? "" : item.secondary || "",
    position: { lat: Number(item.position.lat), lng: Number(item.position.lng) },
  };
  const k = suggestionKey(row);
  const next = [row, ...loadRecents(userKey).filter((r) => suggestionKey(r) !== k)].slice(0, RECENTS_MAX);
  try {
    storage()?.setItem(RECENTS_PREFIX + userKey, JSON.stringify(next));
  } catch {}
}

/** Located stops of every saved itinerary, one row per place. */
export function tripPlaceRows(itineraries = []) {
  const rows = new Map();
  for (const it of Array.isArray(itineraries) ? itineraries : []) {
    const { places } = readMapGeo(it);
    const outliers = tripOutlierKeys(places, Object.keys(places));
    for (const [k, p] of Object.entries(places)) {
      if (p.missing || outliers.has(k) || rows.has(k)) continue;
      rows.set(k, {
        placeId: `trip:${k}`,
        description: p.q || p.name,
        main: p.q || p.name,
        secondary: String(it.title || "").trim(),
        position: { lat: p.lat, lng: p.lng },
        kind: "trip",
      });
    }
  }
  return [...rows.values()];
}

export function suggestionKey(item) {
  const name = placeKey(item?.main || item?.description);
  const pos = item?.position;
  return validPosition(pos) ? `${name}|${Number(pos.lat).toFixed(3)},${Number(pos.lng).toFixed(3)}` : name;
}

/** Every query word must start a word of the row's name or address. */
export function matchesQuery(query, item) {
  const qWords = placeKey(query).split(" ").filter(Boolean);
  if (!qWords.length) return false;
  const words = placeKey(`${item.main || ""} ${item.description || ""}`).split(" ");
  return qWords.every((q) => words.some((w) => w.startsWith(q)));
}

/** Recents first, then trip stops nearest the map centre (when given). */
export function localMatches(query, { recents = [], tripRows = [], limit = 5, center = null } = {}) {
  const out = [];
  const trips = center
    ? tripRows
        .map((r) => [r, distanceKm(center, r.position)])
        .sort((a, b) => a[1] - b[1])
        .map(([r]) => r)
    : tripRows;
  const rows = [...recents.map((r) => ({ ...r, kind: "recent" })), ...trips];
  for (const r of rows) {
    if (out.length >= limit) break;
    if (matchesQuery(query, r) && !out.some((o) => samePlace(o, r))) out.push(r);
  }
  return out;
}

// Same name within ~500 m: providers place one POI a little differently.
function samePlace(a, b) {
  if (placeKey(a.main || a.description) !== placeKey(b.main || b.description)) return false;
  if (!validPosition(a.position) || !validPosition(b.position)) return true;
  return distanceKm(a.position, b.position) < 0.5;
}

/** Local rows first, then remote rows that are not already listed. */
export function mergeSuggestions(local = [], remote = []) {
  return [...local, ...remote.filter((r) => !local.some((l) => samePlace(l, r)))];
}

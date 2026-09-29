import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useLocation, useNavigate, useSearchParams } from "react-router-dom";

import { useComposerDraft } from "../store/composerDraftContext";
import { useMaps } from "../features/maps/mapsStore.jsx";
import { useItinerary } from "../features/itinerary/itineraryStore.jsx";
import PlacesAutocompleteInput from "../features/maps/PlacesAutocompleteInput.jsx";
import MapView from "../features/maps/MapView.jsx";
import { parseItineraryStops } from "../features/maps/itineraryStops.js";
import { cachePlace, getCachedPlace } from "../features/maps/placeResolve.js";
import { placesTextSearch, resolvePlaceLatLng } from "../services/mapsService.js";
import { getApiJson } from "../services/apiClient.js";

const DEFAULT_MAP_CENTER = { lat: 20, lng: 0 };
const DEFAULT_MAP_ZOOM = 2;
const MAP_STATE_KEY = "tm_map_state_v1";
async function photonSearch(query, { center, limit = 10, signal } = {}) {
  const result = await placesTextSearch({ query, center, maxResultCount: limit, signal });
  if (!result.ok) {
    if (result.reason === "aborted") return [];
    throw new Error(result.reason === "rate-limited"
      ? "Place search is busy. Please try again shortly."
      : "Place search is temporarily unavailable.");
  }
  return result.places;
}

async function photonLookup(query, options = {}) {
  const result = await resolvePlaceLatLng({ query, center: options.center, signal: options.signal });
  return result.ok ? result.place : null;
}

async function reverseGeocodeNominatim(position) {
  const params = new URLSearchParams({ lat: String(position.lat), lon: String(position.lng) });
  const result = await getApiJson(`/v1/maps/reverse?${params}`);
  return result?.data?.address || null;
}

function osrmProfileForMode(mode) {
  const profiles = {
    DRIVING: "driving",
    WALKING: "foot",
    BICYCLING: "cycling",
  };
  return profiles[mode] || "";
}

async function requestOsrmRoute(positions, mode = "DRIVING", signal) {
  const profiles = { DRIVING: "driving", WALKING: "foot", BICYCLING: "cycling" };
  const profile = profiles[mode];
  if (!profile) {
    throw new Error(
      mode === "TRANSIT"
        ? "Transit directions are unavailable with this free routing service."
        : "Motorcycle-specific routing is unavailable with this free routing service."
    );
  }

  const params = new URLSearchParams({
    profile,
    coordinates: positions.map(({ lat, lng }) => `${lng},${lat}`).join(";"),
  });
  const result = await getApiJson(`/v1/routes/route?${params}`, { signal });
  return result.data;
}

function formatDistanceFromMeters(meters) {
  const value = Number(meters);
  if (!Number.isFinite(value) || value <= 0) return "";
  return value >= 1000 ? `${(value / 1000).toFixed(1)} km` : `${Math.round(value)} m`;
}

function formatArrivalFromSeconds(seconds) {
  if (!Number.isFinite(seconds) || seconds <= 0) return "";
  const arrival = new Date(Date.now() + seconds * 1000);
  return new Intl.DateTimeFormat(undefined, { hour: "numeric", minute: "2-digit" }).format(arrival);
}

function shortLabel(text, max = 22) {
  const t = (text || "").trim();
  if (!t) return "";
  return t.length > max ? `${t.slice(0, max - 1)}…` : t;
}

function formatDurationTextFromSeconds(seconds) {
  const s = Number(seconds);
  if (!Number.isFinite(s) || s <= 0) return "";

  const totalMin = Math.max(1, Math.round(s / 60));
  const h = Math.floor(totalMin / 60);
  const m = totalMin % 60;

  if (h > 0 && m > 0) return `${h} hr ${m} min`;
  if (h > 0) return `${h} hr`;
  return `${m} min`;
}

function getLegPinsFromInputs({ originCoords, destinationCoords }) {
  const start =
    originCoords && Number.isFinite(originCoords.lat) && Number.isFinite(originCoords.lng)
      ? { lat: originCoords.lat, lng: originCoords.lng }
      : null;

  const end =
    destinationCoords && Number.isFinite(destinationCoords.lat) && Number.isFinite(destinationCoords.lng)
      ? { lat: destinationCoords.lat, lng: destinationCoords.lng }
      : null;

  return start || end ? { start, end } : null;
}

function safeJsonParse(raw) {
  try {
    return raw ? JSON.parse(raw) : null;
  } catch {
    return null;
  }
}

function clamp(n, min, max) {
  const v = Number(n);
  if (!Number.isFinite(v)) return min;
  return Math.min(max, Math.max(min, v));
}

function isItineraryMarker(marker) {
  return Boolean(marker?.label && marker?.query);
}

function approxDistanceKm(a, b) {
  if (!a || !b) return Infinity;
  const dx = Number(a.lat) - Number(b.lat);
  const dy = Number(a.lng) - Number(b.lng);
  if (!Number.isFinite(dx) || !Number.isFinite(dy)) return Infinity;
  return Math.sqrt(dx * dx + dy * dy) * 111;
}

function deriveAnchorLabel(itinerary) {
  const title = String(itinerary?.title || "").trim();
  const text = String(itinerary?.text || "").trim();

  let base = "";
  if (title.includes("•")) base = title.split("•")[0].trim();
  else base = title;

  if (!base || base.length < 3 || /^(trip|itinerary|saved itinerary)$/i.test(base)) {
    const m = text.match(/\bBase:\s*([^•\n\r]+)/i);
    if (m && m[1]) base = String(m[1]).trim();
  }

  if (!base) {
    const first = text.split(/\r?\n/)[0] || "";
    if (first.includes("•")) base = first.split("•")[0].trim();
  }

  base = String(base || "").trim();
  if (!base) return "";

  const lower = `${title}\n${text}`.toLowerCase();
  const phHint =
    /\bphp\b/.test(lower) ||
    /\bphilippin/.test(lower) ||
    /\bmanila\b|\bcebu\b|\bdavao\b|\bbaguio\b|\bboracay\b|\bsiargao\b|\bintramuros\b|\brizal park\b|\broxas\b/.test(lower);

  if (/,/.test(base)) return base;
  if (phHint) return `${base}, Philippines`;
  return base;
}

function extractCoordsFromText(text = "") {
  const raw = String(text || "");
  const m = raw.match(/Coordinates:\s*(-?\d+(?:\.\d+)?)\s*,\s*(-?\d+(?:\.\d+)?)/i);
  if (!m) return null;

  const lat = Number(m[1]);
  const lng = Number(m[2]);

  if (!Number.isFinite(lat) || !Number.isFinite(lng)) return null;
  return { lat, lng };
}

function extractAddressFromText(text = "") {
  const raw = String(text || "");
  const m = raw.match(/Address:\s*(.+)/i);
  return m ? String(m[1] || "").trim() : "";
}

function extractPlaceNameFromStatusReply(text = "") {
  const raw = String(text || "").trim();
  const firstLine = raw.split(/\r?\n/)[0] || "";

  const m =
    firstLine.match(/^(.+?)\s+appears to be\s+/i) ||
    firstLine.match(/^I found\s+(.+?),\s+but/i) ||
    firstLine.match(/^(.+?)\s+does not currently look operational/i);

  return m ? String(m[1] || "").trim() : "";
}

function parseMapUrl(url = "") {
  const raw = String(url || "").trim();
  if (!raw) return { query: "", coords: null };

  try {
    const parsed = new URL(raw);
    const query = ["query", "q", "destination", "search"]
      .map((key) => String(parsed.searchParams.get(key) || "").trim())
      .find(Boolean) || "";
    const osmLat = Number(parsed.searchParams.get("mlat"));
    const osmLng = Number(parsed.searchParams.get("mlon"));
    const osmCoordinates =
      Number.isFinite(osmLat) && Number.isFinite(osmLng)
        ? `${osmLat},${osmLng}`
        : parsed.hash.match(/map=\d+\/(-?\d+(?:\.\d+)?)\/(-?\d+(?:\.\d+)?)/)?.slice(1).join(",");
    const coordinateText =
      ["ll", "center", "query", "q"]
        .map((key) => String(parsed.searchParams.get(key) || "").trim())
        .find((value) => /^-?\d+(?:\.\d+)?\s*,\s*-?\d+(?:\.\d+)?$/.test(value)) ||
      osmCoordinates ||
      parsed.pathname.match(/@(-?\d+(?:\.\d+)?),(-?\d+(?:\.\d+)?)/)?.slice(1).join(",");

    if (coordinateText) {
      const [lat, lng] = coordinateText.split(",").map(Number);
      if (Number.isFinite(lat) && Number.isFinite(lng)) {
        return { query: "", coords: { lat, lng } };
      }
    }

    return { query, coords: null };
  } catch {
    return { query: "", coords: null };
  }
}

function formatPopupRating(rating) {
  const value = Number(rating);
  if (!Number.isFinite(value) || value <= 0) return "Rating unavailable";
  return `⭐ ${value.toFixed(1)}`;
}

function formatPopupOpenState(openNow) {
  if (typeof openNow !== "boolean") return "Hours unavailable";
  return openNow ? "Open now" : "Closed now";
}

function formatPopupCoords(position) {
  const lat = Number(position?.lat);
  const lng = Number(position?.lng);
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) return "";
  return `${lat.toFixed(6)}, ${lng.toFixed(6)}`;
}

function formatPopupAddress(address) {
  const value = String(address || "").trim();
  if (!value) return "Address unavailable";
  return value;
}

export default function MapPage() {
  const navigate = useNavigate();
  const location = useLocation();
  const [searchParams, setSearchParams] = useSearchParams();

  const { setDraft } = useComposerDraft();
  const { mapIntent, clearIntent } = useMaps();
  const { items: itineraryItems } = useItinerary();

  const [search, setSearch] = useState("");
  const [markers, setMarkers] = useState([]);
  const [activeMarker, setActiveMarker] = useState(null);
  const [error, setError] = useState("");
  const [mapCenter, setMapCenter] = useState(DEFAULT_MAP_CENTER);
  const [mapZoom, setMapZoom] = useState(DEFAULT_MAP_ZOOM);

  const [origin, setOrigin] = useState("");
  const [destination, setDestination] = useState("");
  const [clickTarget, setClickTarget] = useState("origin");

  const [originCoords, setOriginCoords] = useState(null);
  const [destinationCoords, setDestinationCoords] = useState(null);
  const [userLocation, setUserLocation] = useState(null);

  const [travelMode, setTravelMode] = useState("DRIVING");

  const [directions, setDirections] = useState(null);
  const [showDirectionsRenderer, setShowDirectionsRenderer] = useState(false);
  const [routePins, setRoutePins] = useState(null);
  const [routeMeta, setRouteMeta] = useState(null);

  const [routeOpen, setRouteOpen] = useState(false);
  const [directionsPanelOpen, setDirectionsPanelOpen] = useState(false);

  const [itineraryPanelOpen, setItineraryPanelOpen] = useState(false);
  const [selectedItineraryId, setSelectedItineraryId] = useState(null);
  const [dayFilter, setDayFilter] = useState("all");
  const [itineraryBusy, setItineraryBusy] = useState(false);
  const [itineraryError, setItineraryError] = useState("");
  const [itineraryPins, setItineraryPins] = useState([]);

  const [itineraryRouteOn, setItineraryRouteOn] = useState(true);
  const [itineraryDirections, setItineraryDirections] = useState(null);
  const [showItineraryRenderer, setShowItineraryRenderer] = useState(false);

  const [itineraryAnchor, setItineraryAnchor] = useState(null);

  const mapRef = useRef(null);
  const [mapReady, setMapReady] = useState(false);

  const directionsRequestIdRef = useRef(0);
  const itineraryRouteRequestIdRef = useRef(0);
  const itineraryAbortRef = useRef(null);

  const onMapReady = useCallback((map) => {
    mapRef.current = map;
    setMapReady(true);
  }, []);

  const activePlaceText = useMemo(() => {
    if (!activeMarker) return "";
    const name = (activeMarker.name || "").trim();
    const addr = (activeMarker.address || "").trim();
    return addr ? `${name}, ${addr}` : name;
  }, [activeMarker]);

  const focusMapOnPoint = useCallback((coords, zoom = 17) => {
    if (!coords || !Number.isFinite(coords.lat) || !Number.isFinite(coords.lng)) return;

    setMapCenter(coords);
    setMapZoom(zoom);

    try {
      mapRef.current?.setView([coords.lat, coords.lng], zoom);
    } catch {}
  }, []);

  const visibleSearchMarkers = useMemo(() => {
    if (routeOpen) return activeMarker && !isItineraryMarker(activeMarker) ? [activeMarker] : [];
    return markers;
  }, [routeOpen, markers, activeMarker]);

  const selectedItinerary = useMemo(() => {
    const list = Array.isArray(itineraryItems) ? itineraryItems : [];
    if (!selectedItineraryId) return null;
    return list.find((x) => x.id === selectedItineraryId) || null;
  }, [itineraryItems, selectedItineraryId]);

  const parsedStops = useMemo(() => {
    if (!selectedItinerary?.text) return { days: [], all: [], detectedDays: 0 };
    return parseItineraryStops(selectedItinerary.text);
  }, [selectedItinerary?.text]);

  const dayOptions = useMemo(() => {
    const mapStops = Array.isArray(selectedItinerary?.mapStops) ? selectedItinerary.mapStops : null;

    if (mapStops && mapStops.length) {
      const seen = new Set();
      const unique = [];

      for (const s of mapStops) {
        const day = Number(s?.day);
        if (!Number.isFinite(day) || day <= 0) continue;
        if (seen.has(day)) continue;
        seen.add(day);
        unique.push({ day, label: `Day ${day}` });
      }

      unique.sort((a, b) => a.day - b.day);
      return unique;
    }

    const rawDays = Array.isArray(parsedStops?.days) ? parsedStops.days : [];
    const seen = new Set();
    const unique = [];

    for (const item of rawDays) {
      const day = Number(item?.day);
      if (!Number.isFinite(day) || day <= 0) continue;
      if (seen.has(day)) continue;
      seen.add(day);
      unique.push({ day, label: `Day ${day}` });
    }

    unique.sort((a, b) => a.day - b.day);
    return unique;
  }, [selectedItinerary?.mapStops, parsedStops]);

  const itineraryCandidates = useMemo(() => {
    if (!selectedItinerary) return [];

    const mapStops = Array.isArray(selectedItinerary?.mapStops) ? selectedItinerary.mapStops : null;

    if (mapStops && mapStops.length) {
      const anchorQuery = String(selectedItinerary?.anchor?.query || "").trim();
      const anchorCity = String(selectedItinerary?.anchor?.city || "").trim();
      const anchorCountry = String(selectedItinerary?.anchor?.country || "").trim();

      const normalized = mapStops
        .map((s) => {
          const day = Number(s?.day);
          const order = Number(s?.order);
          const label = String(s?.label || "").trim();
          const area = String(s?.area || "").trim();
          const city = String(s?.city || "").trim() || anchorCity;
          const country = String(s?.country || "").trim() || anchorCountry;
          const query = String(s?.query || "").trim();
          const placeId = String(s?.placeId || "").trim();
          const location =
            s?.location && Number.isFinite(Number(s.location.lat)) && Number.isFinite(Number(s.location.lng))
              ? { lat: Number(s.location.lat), lng: Number(s.location.lng) }
              : null;

          if (!Number.isFinite(day) || day <= 0) return null;
          if (!Number.isFinite(order) || order <= 0) return null;
          if (!label) return null;

          const fallbackParts = [label];
          if (area) fallbackParts.push(area);
          if (city) fallbackParts.push(city);
          if (country) fallbackParts.push(country);
          else if (anchorQuery) fallbackParts.push(anchorQuery);

          const finalQuery = query || fallbackParts.filter(Boolean).join(", ");
          if (!finalQuery) return null;

          return {
            isStructured: true,
            day,
            order,
            query: finalQuery,
            label,
            placeId: placeId || null,
            location,
          };
        })
        .filter(Boolean)
        .sort((a, b) => (a.day - b.day) || (a.order - b.order));

      // Deduplicate: keep only the first occurrence of each label per day
      const seenLabels = new Set();
      const deduped = normalized.filter((s) => {
        const key = `${s.day}::${s.label.toLowerCase()}`;
        if (seenLabels.has(key)) return false;
        seenLabels.add(key);
        return true;
      });

      if (dayFilter === "all") return deduped;

      const dayNum = Number(dayFilter);
      if (!Number.isFinite(dayNum) || dayNum <= 0) return deduped;

      return deduped.filter((s) => s.day === dayNum);
    }

    if (!selectedItinerary?.text) return [];

    const raw =
      dayFilter === "all"
        ? parsedStops.all || []
        : (() => {
            const dayNum = Number(dayFilter);
            if (!Number.isFinite(dayNum) || dayNum <= 0) return parsedStops.all || [];
            const day = (parsedStops.days || []).find((d) => d.day === dayNum);
            return day?.candidates || [];
          })();

    const list = Array.isArray(raw) ? raw : [];
    return list.map((text, idx) => ({
      isStructured: false,
      day: dayFilter === "all" ? null : Number(dayFilter) || null,
      order: idx + 1,
      query: String(text || "").trim(),
    }));
  }, [selectedItinerary, selectedItinerary?.mapStops, selectedItinerary?.text, parsedStops, dayFilter]);

  const clearRoute = useCallback(() => {
    directionsRequestIdRef.current += 1;
    setShowDirectionsRenderer(false);
    setDirections(null);
    setRoutePins(null);
    setRouteMeta(null);
  }, []);

  const clearItineraryRoute = useCallback((invalidate = true) => {
    if (invalidate) itineraryRouteRequestIdRef.current += 1;
    setShowItineraryRenderer(false);
    setItineraryDirections(null);
  }, []);

  const clearDirectionsInputs = useCallback(() => {
    setOrigin("");
    setDestination("");
    setOriginCoords(null);
    setDestinationCoords(null);
    setClickTarget("origin");
  }, []);

  const clearAllDirections = useCallback(() => {
    clearRoute();
    clearDirectionsInputs();
    setUserLocation(null);
    setError("");
    setClickTarget("origin");
  }, [clearRoute, clearDirectionsInputs]);

  const clearItineraryView = useCallback(() => {
    clearItineraryRoute();
    setSelectedItineraryId(null);
    setDayFilter("all");
    setItineraryPins([]);
    setItineraryError("");
    setActiveMarker(null);
    setItineraryAnchor(null);
    setItineraryPanelOpen(false);

    const params = new URLSearchParams(searchParams);
    params.delete("itineraryId");
    params.delete("day");
    setSearchParams(params, { replace: true });
  }, [clearItineraryRoute, searchParams, setSearchParams]);

  const updateOrigin = useCallback(
    (v) => {
      const next = String(v || "");
      setOrigin(next);
      setOriginCoords(null);
      setDestinationCoords(null);
      clearRoute();
      setClickTarget(next.trim() ? "destination" : "origin");
    },
    [clearRoute]
  );

  const geocodeLatLng = useCallback((coords) => reverseGeocodeNominatim(coords), []);

  const geocodeAddressToCoords = useCallback(async (address) => {
    try {
      const place = await photonLookup(address);
      return place?.position || null;
    } catch {
      return null;
    }
  }, []);

  const updateDestination = useCallback(
    (v) => {
      const next = String(v || "");
      setDestination(next);
      setDestinationCoords(null);
      clearRoute();
      setClickTarget(next.trim() ? "locked" : "destination");
    },
    [clearRoute]
  );

  const selectDestination = useCallback(
    async (selection) => {
      const next = String(
        typeof selection === "string" ? selection : selection?.description || ""
      ).trim();
      setDestination(next);
      clearRoute();

      if (!next) {
        setDestinationCoords(null);
        setClickTarget("destination");
        return;
      }

      const coords = selection?.position || (await geocodeAddressToCoords(next));
      setDestinationCoords(coords || null);
      setClickTarget("locked");
    },
    [clearRoute, geocodeAddressToCoords]
  );

  const useCurrentLocation = useCallback(() => {
    if (!navigator.geolocation) {
      setError("Geolocation is not supported in this browser.");
      return;
    }

    setError("");

    navigator.geolocation.getCurrentPosition(
      (pos) => {
        const coords = { lat: pos.coords.latitude, lng: pos.coords.longitude };
        setUserLocation(coords);
        setOriginCoords(coords);
        setOrigin("Current location");
        setClickTarget("destination");
        clearRoute();
        setRouteOpen(true);

        focusMapOnPoint(coords, 14);
      },
      (err) => {
        if (err?.code === 1) setError("Location permission denied. Allow it in the browser site settings.");
        else setError("Couldn’t get your current location.");
      },
      { enableHighAccuracy: true, timeout: 10000 }
    );
  }, [clearRoute]);

  const handleSearch = useCallback(
    async (qOverride) => {
      const q = String(qOverride ?? search).trim();
      if (!q) return;

      setError("");
      const searchCenter =
        Number(mapCenter.lat) === DEFAULT_MAP_CENTER.lat &&
        Number(mapCenter.lng) === DEFAULT_MAP_CENTER.lng
          ? undefined
          : mapCenter;

      try {
        const mapped = await photonSearch(q, { center: searchCenter, limit: 10 });
        if (!mapped.length) {
          setError("No results found.");
          setMarkers([]);
          setActiveMarker(null);
          return;
        }

        setMarkers(mapped);
        setActiveMarker(mapped[0]);
        focusMapOnPoint(mapped[0].position, 14);
      } catch (error) {
        setMarkers([]);
        setActiveMarker(null);
        setError(error?.message || "Place search is temporarily unavailable.");
      }
    },
    [search, mapCenter, focusMapOnPoint]
  );

  const openDirections = useCallback(() => {
    clearItineraryView();
    setRouteOpen(true);
    setDirectionsPanelOpen(true);
    setActiveMarker(null);

    if (!destination.trim() && activePlaceText) {
      setDestination(activePlaceText);
      setDestinationCoords(null);
      setClickTarget(originCoords || origin.trim() ? "locked" : "origin");
    }
  }, [destination, activePlaceText, clearItineraryView, originCoords, origin]);

  const buildRoute = useCallback(
    async (modeOverride) => {
      const destinationText = destination.trim();
      const originText = origin.trim();
      const hasOrigin = Boolean(originCoords || originText);
      if (!hasOrigin || !destinationText) return;

      const effectiveMode = modeOverride || travelMode;
      clearRoute();
      setError("");
      const requestId = directionsRequestIdRef.current;

      try {
        const startPosition = originCoords || userLocation;
        const endPosition = destinationCoords;
        const startPlace = startPosition
          ? { position: startPosition }
          : await photonLookup(originText, { center: mapCenter });
        const endPlace = endPosition
          ? { position: endPosition }
          : await photonLookup(destinationText, { center: mapCenter });

        if (!startPlace?.position || !endPlace?.position) {
          throw new Error(
            "Couldn’t find one of those locations. Choose a search suggestion or try a fuller place name."
          );
        }

        const route = await requestOsrmRoute(
          [startPlace.position, endPlace.position],
          effectiveMode
        );
        if (requestId !== directionsRequestIdRef.current) return;

        const coordinates = route.geometry?.coordinates || [];
        if (coordinates.length < 2) {
          throw new Error("No route was found for those locations.");
        }

        setOriginCoords(startPlace.position);
        setDestinationCoords(endPlace.position);
        setDirections(route);
        setShowDirectionsRenderer(true);
        setRoutePins({
          start: startPlace.position,
          end: endPlace.position,
        });
        setRouteMeta({
          durationText: formatDurationTextFromSeconds(route.duration),
          distanceText: formatDistanceFromMeters(route.distance),
          arrivalText: formatArrivalFromSeconds(route.duration),
          isTraffic: false,
          trafficUnavailable: true,
        });
        setClickTarget("locked");

        const routePositions = coordinates.map(([lng, lat]) => [lat, lng]);
        mapRef.current?.fitBounds(routePositions, {
          padding: [48, 48],
          maxZoom: 16,
        });
      } catch (error) {
        if (requestId !== directionsRequestIdRef.current) return;
        setShowDirectionsRenderer(false);
        setDirections(null);
        setRoutePins(
          getLegPinsFromInputs({
            originCoords: originCoords || userLocation,
            destinationCoords,
          })
        );
        setRouteMeta(null);
        setClickTarget("destination");
        setError(error?.message || "Couldn’t build that route. Please try again.");
      }
    },
    [
      origin,
      destination,
      originCoords,
      destinationCoords,
      userLocation,
      mapCenter,
      clearRoute,
      travelMode,
    ]
  );

  const handleTravelModeChange = useCallback(
    (nextMode) => {
      if (!osrmProfileForMode(nextMode)) {
        setError(
          nextMode === "TRANSIT"
            ? "Transit directions are unavailable with this free routing service."
            : "Motorcycle-specific routing is unavailable with this free routing service."
        );
        return;
      }
      if (travelMode === nextMode) return;

      setTravelMode(nextMode);

      const hasOrigin = Boolean(originCoords || origin.trim());
      const hasDest = Boolean(destination.trim());

      if (routeOpen && hasOrigin && hasDest) {
        buildRoute(nextMode);
      }
    },
    [travelMode, routeOpen, originCoords, origin, destination, buildRoute]
  );

  useEffect(
    () => () => {
      itineraryAbortRef.current?.abort?.();
    },
    []
  );

  const shareToChat = useCallback(
    (place) => {
      const msg = `Add this location to my trip: ${place?.name || place?.query || "a place"}${place?.address ? ` (${place.address})` : ""}`;
      setDraft(msg);
      navigate("/chat");
    },
    [setDraft, navigate]
  );

  const openDirectionsFromMarker = useCallback(
    (place) => {
      if (!place) return;

      clearItineraryView();
      setRouteOpen(true);
      setDirectionsPanelOpen(true);
      setActiveMarker(null);

      const nextDestination = String(place.address || place.name || place.query || "").trim();
      if (nextDestination) {
        setDestination(nextDestination);
      }

      if (
        place?.position &&
        Number.isFinite(Number(place.position.lat)) &&
        Number.isFinite(Number(place.position.lng))
      ) {
        setDestinationCoords({
          lat: Number(place.position.lat),
          lng: Number(place.position.lng),
        });
      } else {
        setDestinationCoords(null);
      }

      setClickTarget(originCoords || origin.trim() ? "locked" : "origin");
    },
    [clearItineraryView, originCoords, origin]
  );

  const handleMapClick = useCallback(
    async (coords) => {
      if (!routeOpen || clickTarget === "locked") return;
      if (!Number.isFinite(coords?.lat) || !Number.isFinite(coords?.lng)) return;

      const label = (await geocodeLatLng(coords)) || "Dropped pin";

      if (clickTarget === "origin") {
        setOriginCoords(coords);
        setOrigin(label);
        setDestination("");
        setDestinationCoords(null);
        clearRoute();
        setClickTarget("destination");
        return;
      }

      if (clickTarget === "destination") {
        setDestination(label);
        setDestinationCoords(coords);
        clearRoute();
        setClickTarget("locked");
      }
    },
    [routeOpen, clickTarget, clearRoute, geocodeLatLng]
  );

  const applySelectedItinerary = useCallback(
    (nextId, { openPanel } = {}) => {
      const id = nextId || null;
      setSelectedItineraryId(id);
      setItineraryError("");
      setItineraryPins([]);
      clearItineraryRoute();
      setActiveMarker(null);
      if (openPanel) setItineraryPanelOpen(true);

      const params = new URLSearchParams(searchParams);
      if (id) params.set("itineraryId", id);
      else params.delete("itineraryId");

      if (id && dayFilter !== "all") params.set("day", String(dayFilter));
      else params.delete("day");

      setSearchParams(params, { replace: true });
    },
    [dayFilter, searchParams, setSearchParams, clearItineraryRoute]
  );

  const fitToPins = useCallback((pins) => {
    const coords = (Array.isArray(pins) ? pins : [])
      .map((pin) => pin?.position)
      .filter(
        (position) =>
          position &&
          Number.isFinite(position.lat) &&
          Number.isFinite(position.lng)
      );

    if (!coords.length || !mapRef.current) return;
    if (coords.length === 1) {
      mapRef.current.setView([coords[0].lat, coords[0].lng], 14);
      return;
    }

    mapRef.current.fitBounds(
      coords.map((position) => [position.lat, position.lng]),
      { padding: [48, 48], maxZoom: 16 }
    );
  }, []);

  const resolvePlaceFromQuery = useCallback(
    async (query, { signal, center, radiusMeters = 50000, restrictToCircle = true } = {}) => {
      const q = String(query || "").trim();
      if (!q || q.length < 4) return null;

      const badQueryPatterns = [/^breakfast$/i, /^lunch$/i, /^dinner$/i, /^rest$/i, /^free time$/i, /^shopping$/i, /^travel$/i, /^commute$/i];
      if (badQueryPatterns.some((rx) => rx.test(q))) return null;

      const c =
        center &&
        Number.isFinite(center.lat) &&
        Number.isFinite(center.lng) &&
        !(Number(center.lat) === DEFAULT_MAP_CENTER.lat && Number(center.lng) === DEFAULT_MAP_CENTER.lng)
          ? center
          : undefined;
      const radius = clamp(radiusMeters, 0, 50000);

      const cached = getCachedPlace(q, { center: c, radiusMeters: radius });
      if (cached) return cached;

      try {
        const places = await photonSearch(q, { center: c, limit: 5, signal });
        if (signal?.aborted) return null;
        const place = places.find(
          (candidate) =>
            !restrictToCircle ||
            !c ||
            approxDistanceKm(candidate.position, c) <= radius / 1000
        );
        if (!place) return null;

        cachePlace(q, place, { center: c, radiusMeters: radius });
        return place;
      } catch {
        return null;
      }
    },
    []
  );

  const buildItineraryRoute = useCallback(
    async (pins) => {
      const coords = (Array.isArray(pins) ? pins : [])
        .map((pin) => pin?.position)
        .filter(
          (position) =>
            position &&
            Number.isFinite(position.lat) &&
            Number.isFinite(position.lng)
        )
        .slice(0, 10);

      clearItineraryRoute(false);
      const requestId = itineraryRouteRequestIdRef.current + 1;
      itineraryRouteRequestIdRef.current = requestId;
      if (coords.length < 2) return;

      try {
        const route = await requestOsrmRoute(coords, "DRIVING");
        if (requestId !== itineraryRouteRequestIdRef.current) return;
        setItineraryDirections(route);
        setShowItineraryRenderer(true);
      } catch (error) {
        if (requestId !== itineraryRouteRequestIdRef.current) return;
        setItineraryDirections(null);
        setShowItineraryRenderer(false);
        setItineraryError(
          error?.message || "Couldn’t draw the itinerary route. Please try again."
        );
      }
    },
    [clearItineraryRoute]
  );

  useEffect(() => {
    const urlId = searchParams.get("itineraryId");
    const urlDay = searchParams.get("day");

    if (urlDay) {
      const n = Number(urlDay);
      if (urlDay === "all") setDayFilter("all");
      else if (Number.isFinite(n) && n > 0) setDayFilter(n);
    }

    if (urlId) {
      setSelectedItineraryId(urlId);
      setItineraryPanelOpen(true);
      return;
    }

    const stored = safeJsonParse(typeof window !== "undefined" ? window.localStorage.getItem(MAP_STATE_KEY) : null);
    const storedId = stored?.selectedItineraryId || null;
    const storedDay = stored?.dayFilter;

    if (storedDay === "all") setDayFilter("all");
    else if (Number.isFinite(Number(storedDay)) && Number(storedDay) > 0) setDayFilter(Number(storedDay));

    if (storedId) {
      setSelectedItineraryId(storedId);
      setItineraryPanelOpen(!!stored?.panelOpen);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    if (typeof window === "undefined") return;

    const state = {
      selectedItineraryId: selectedItineraryId || null,
      dayFilter: dayFilter || "all",
      panelOpen: !!itineraryPanelOpen,
      v: 1,
    };

    try {
      window.localStorage.setItem(MAP_STATE_KEY, JSON.stringify(state));
    } catch {}
  }, [selectedItineraryId, dayFilter, itineraryPanelOpen]);

  useEffect(() => {
    const urlId = searchParams.get("itineraryId");
    const urlDay = searchParams.get("day");

    if (urlDay === "all") {
      setDayFilter("all");
    } else {
      const n = Number(urlDay);
      if (Number.isFinite(n) && n > 0) setDayFilter(n);
      else if (!urlDay) setDayFilter("all");
    }

    if (urlId) {
      setSelectedItineraryId(urlId);
      setItineraryPanelOpen(true);
    } else {
      setSelectedItineraryId(null);
    }
  }, [searchParams]);

  useEffect(() => {
    if (!mapReady) return;
    if (!mapIntent) return;

    const sourceText = String(mapIntent.sourceText || "").trim();
    const label = String(mapIntent.label || "").trim();
    const directQuery = String(mapIntent.query || "").trim();
    const parsedUrl = parseMapUrl(mapIntent.url || "");
    const coordsFromText = extractCoordsFromText(sourceText);
    const coords = coordsFromText || parsedUrl.coords || null;

    const placeName =
      extractPlaceNameFromStatusReply(sourceText) ||
      label ||
      directQuery ||
      "";

    const address = extractAddressFromText(sourceText);

    if (coords) {
      const marker = {
        id: `intent-${Date.now()}`,
        name: placeName || "Selected place",
        address: address || "",
        rating: null,
        openNow: null,
        position: coords,
      };

      setMarkers([marker]);
      setActiveMarker(marker);
      setSearch(placeName || address || `${coords.lat}, ${coords.lng}`);
      setError("");
      focusMapOnPoint(coords, 17);
      clearIntent();
      return;
    }

    const fallbackQuery = parsedUrl.query || directQuery || placeName || address;
    if (fallbackQuery) {
      setSearch(fallbackQuery);
      setTimeout(() => handleSearch(fallbackQuery), 50);
    }

    clearIntent();
  }, [mapReady, mapIntent, handleSearch, clearIntent, focusMapOnPoint]);

  useEffect(() => {
    const st = location?.state;
    const id = st?.itineraryId;
    if (!id) return;

    const params = new URLSearchParams(searchParams);
    params.set("itineraryId", id);
    setSearchParams(params, { replace: true });

    setSelectedItineraryId(id);
    setItineraryPanelOpen(true);
  }, [location?.state, searchParams, setSearchParams]);

  useEffect(() => {
    let cancelled = false;

    async function run() {
      if (!mapReady) return;
      if (!selectedItinerary?.id) {
        setItineraryAnchor(null);
        return;
      }

      const label =
        String(selectedItinerary?.anchor?.query || "").trim() ||
        deriveAnchorLabel(selectedItinerary);
      let center = DEFAULT_MAP_CENTER;

      try {
        const place = await photonLookup(label, { center: mapCenter });
        if (place?.position) center = place.position;
      } catch {}

      if (cancelled) return;

      setItineraryAnchor({ label, center });
      mapRef.current?.setView([center.lat, center.lng], 12);
    }

    run();

    return () => {
      cancelled = true;
    };
  }, [
    mapReady,
    selectedItinerary?.id,
    selectedItinerary?.anchor?.query,
    selectedItinerary?.title,
    selectedItinerary?.text,
    selectedItinerary?.mapStops,
    mapCenter,
  ]);

  useEffect(() => {
    if (!mapReady) return;
    if (!selectedItineraryId) return;

    const it = selectedItinerary;
    const hasMapStops = Array.isArray(it?.mapStops) && it.mapStops.length > 0;
    const hasText = !!String(it?.text || "").trim();

    if (!hasMapStops && !hasText) {
      clearItineraryRoute();
      setItineraryPins([]);
      setItineraryError("This itinerary has no content to map.");
      return;
    }

    const anchorCenter = itineraryAnchor?.center || DEFAULT_MAP_CENTER;
    const anchorLabel = itineraryAnchor?.label || deriveAnchorLabel(it) || "";
    const candidates = itineraryCandidates;

    if (!candidates.length) {
      clearItineraryRoute();
      setItineraryPins([]);
      setItineraryError(
        "No mappable stops found in this itinerary. Try editing stops to include clearer place names like “Fort Santiago, Manila” instead of generic activity lines."
      );
      return;
    }

    setItineraryBusy(true);
    setItineraryError("");

    try {
      itineraryAbortRef.current?.abort?.();
    } catch {}

    const controller = new AbortController();
    itineraryAbortRef.current = controller;

    const run = async () => {
      try {
        const maxPins = clamp(candidates.length, 1, 50);
        const subset = candidates.slice(0, maxPins);

        const resolved = [];
        let idx = 0;

        const workers = new Array(3).fill(0).map(async () => {
          while (idx < subset.length) {
            const myIndex = idx;
            idx += 1;

            const item = subset[myIndex];
            const baseQuery = String(item?.query || "").trim();
            if (!baseQuery) continue;

            const q = item?.isStructured ? baseQuery : anchorLabel ? `${baseQuery}, ${anchorLabel}` : baseQuery;

            const place = item?.location
              ? {
                  id: item?.placeId || q,
                  name: item?.label || q,
                  address: q,
                  position: item.location,
                }
              : await resolvePlaceFromQuery(q, {
                  signal: controller.signal,
                  center: anchorCenter,
                  radiusMeters: 50000,
                  restrictToCircle: true,
                });

            if (place?.position) {
              const roughKm = approxDistanceKm(place.position, anchorCenter);
              if (roughKm > 80) continue;

              resolved.push({
                key: `${q}::${place.id || place.name}`,
                order: Number(item?.order) || myIndex + 1,
                query: q,
                name: place.name || q,
                address: place.address || "",
                rating: place.rating,
                openNow: place.openNow,
                position: place.position,
                label: "0",
                day: item?.day ?? (dayFilter === "all" ? null : Number(dayFilter)),
              });
            }
          }
        });

        await Promise.allSettled(workers);

        if (controller.signal.aborted) return;

        resolved.sort((a, b) => (a.order ?? 0) - (b.order ?? 0));
        resolved.forEach((p, i) => {
          p.label = String(i + 1);
        });

        if (!resolved.length) {
          clearItineraryRoute();
          setItineraryPins([]);
          setItineraryError("We couldn’t locate any stops for this itinerary. Try editing stops to include clearer place names.");
          return;
        }

        setItineraryPins(resolved);
        fitToPins(resolved);

        if (itineraryRouteOn) {
          buildItineraryRoute(resolved);
        } else {
          clearItineraryRoute();
        }
      } finally {
        if (!controller.signal.aborted) setItineraryBusy(false);
      }
    };

    run();

    return () => {
      clearItineraryRoute();

      try {
        controller.abort();
      } catch {}
    };
  }, [
    mapReady,
    selectedItineraryId,
    selectedItinerary,
    itineraryCandidates,
    itineraryAnchor,
    resolvePlaceFromQuery,
    fitToPins,
    itineraryRouteOn,
    buildItineraryRoute,
    dayFilter,
    clearItineraryRoute,
  ]);

  const originPreview = originCoords ? "Current location" : origin || "";
  const destPreview = destination || "";
  const originIsCurrentLocation = origin.trim().toLowerCase() === "current location" && !!userLocation;
  const itineraryTitle = selectedItinerary?.title || "Itinerary";
  const hasItineraryView = Boolean(selectedItineraryId);

  return (
    <div className="tm-mapPage">
      <div className="tm-mapSurface">
        {(error || itineraryError) && <div className="tm-mapNotice">{error || itineraryError}</div>}

        <div className="tm-mapWrap tm-mapWrap--full">
          <div className="tm-mapOverlay" aria-label="Map controls">
            <div className="tm-mapOverlay__stack">
              <div className="tm-mapSearch tm-mapTopBar tm-mapSearch--withDropdown tm-mapSearch--overlay">
                <PlacesAutocompleteInput
                  inputId="tm_place_search"
                  value={search}
                  onChange={setSearch}
                  onSelect={(it) => setSearch(it.description)}
                  placeholder="Search a city, landmark, or place…"
                />

                <button
                  type="button"
                  className={`tm-mapIconBtn ${itineraryPanelOpen ? "is-active" : ""}`}
                  onClick={() => {
                    setItineraryPanelOpen((v) => {
                      const next = !v;
                      if (next) {
                        clearAllDirections();
                        setRouteOpen(false);
                        setDirectionsPanelOpen(false);
                        setActiveMarker(null);
                      }
                      return next;
                    });
                  }}
                  aria-label="Open itineraries"
                  title="Itineraries"
                >
                  🗂️
                </button>

                <button
                  type="button"
                  className={`tm-mapIconBtn ${routeOpen || directionsPanelOpen ? "is-active" : ""}`}
                  onClick={() => {
                    if (routeOpen) {
                      setDirectionsPanelOpen((v) => !v);
                      setItineraryPanelOpen(false);
                      setActiveMarker(null);
                    } else {
                      openDirections();
                    }
                  }}
                  aria-label="Open directions"
                  title="Directions"
                >
                  🧭
                </button>

                <button
                  type="button"
                  className="tm-mapIconBtn tm-mapIconBtn--primary"
                  onClick={() => handleSearch()}
                  aria-label="Search places"
                  title="Search"
                >
                  🔍
                </button>
              </div>

              {itineraryPanelOpen && (
                <div className="tm-itMapPanel" aria-label="Itineraries">
                  <div className="tm-itMapPanel__top">
                    <div className="tm-itMapPanel__title">Itineraries on Map</div>
                    <div className="tm-itMapPanel__actions">
                      <button type="button" className="tm-clearBtn tm-clearBtn--mini" onClick={clearItineraryView} title="Clear itinerary view">
                        Clear
                      </button>
                      <button
                        type="button"
                        className="tm-clearBtn tm-clearBtn--mini"
                        onClick={() => setItineraryPanelOpen(false)}
                        aria-label="Close itineraries panel"
                        title="Close"
                      >
                        ✕
                      </button>
                    </div>
                  </div>

                  <div className="tm-itMapPanel__body tm-itMapPanel__body--split">
                    <div className="tm-itMapPanel__listArea">
                      <div className="tm-itMapPanel__label">Select itinerary</div>

                      <div className="tm-itMapList" role="list">
                        {(Array.isArray(itineraryItems) ? itineraryItems : []).length === 0 ? (
                          <div className="tm-itMapEmpty muted">No saved itineraries yet.</div>
                        ) : (
                          (Array.isArray(itineraryItems) ? itineraryItems : []).map((it) => {
                            const isActive = it.id === selectedItineraryId;
                            return (
                              <button
                                key={it.id}
                                type="button"
                                className={`tm-itMapRow ${isActive ? "is-active" : ""}`}
                                onClick={() => {
                                  setDayFilter("all");
                                  applySelectedItinerary(it.id, { openPanel: true });
                                }}
                                role="listitem"
                              >
                                <div className="tm-itMapRow__title">{it.title || "Saved itinerary"}</div>
                                <div className="tm-itMapRow__sub muted">
                                  {it.tripStart && it.tripEnd ? `${it.tripStart} → ${it.tripEnd}` : "No dates"}
                                </div>
                              </button>
                            );
                          })
                        )}
                      </div>
                    </div>

                    <div className="tm-itMapPanel__viewArea">
                      {selectedItineraryId ? (
                        <div className="tm-itMapPanel__section">
                          <div className="tm-itMapPanel__label">Viewing</div>

                          <div className="tm-itMapNow">
                            <div className="tm-itMapNow__title">{itineraryTitle}</div>
                            <div className="tm-itMapNow__sub muted">
                              {selectedItinerary?.tripStart && selectedItinerary?.tripEnd
                                ? `${selectedItinerary.tripStart} → ${selectedItinerary.tripEnd}`
                                : "No dates"}
                            </div>
                          </div>

                          <div className="tm-itMapControls">
                            <div className="tm-itMapSeg" role="tablist" aria-label="Day filter">
                              <button
                                type="button"
                                className={`tm-itMapSegBtn ${dayFilter === "all" ? "is-active" : ""}`}
                                onClick={() => {
                                  setDayFilter("all");
                                  const params = new URLSearchParams(searchParams);
                                  if (selectedItineraryId) params.set("itineraryId", selectedItineraryId);
                                  params.delete("day");
                                  setSearchParams(params, { replace: true });
                                }}
                                role="tab"
                                aria-selected={dayFilter === "all"}
                              >
                                All days
                              </button>

                              {dayOptions.map((d) => (
                                <button
                                  key={d.day}
                                  type="button"
                                  className={`tm-itMapSegBtn ${Number(dayFilter) === d.day ? "is-active" : ""}`}
                                  onClick={() => {
                                    setDayFilter(d.day);
                                    const params = new URLSearchParams(searchParams);
                                    if (selectedItineraryId) params.set("itineraryId", selectedItineraryId);
                                    params.set("day", String(d.day));
                                    setSearchParams(params, { replace: true });
                                  }}
                                  role="tab"
                                  aria-selected={Number(dayFilter) === d.day}
                                >
                                  {d.label}
                                </button>
                              ))}
                            </div>

                            <label className="tm-itMapToggle">
                              <input type="checkbox" checked={!!itineraryRouteOn} onChange={(e) => setItineraryRouteOn(e.target.checked)} />
                              <span>Route</span>
                            </label>
                          </div>

                          <div className="tm-itMapPanel__hint muted">
                            {itineraryBusy
                              ? "Mapping itinerary stops…"
                              : itineraryPins.length
                                ? `${itineraryPins.length} stop${itineraryPins.length > 1 ? "s" : ""} shown`
                                : "No stops resolved for this view."}
                          </div>
                        </div>
                      ) : (
                        <div className="tm-itMapPanel__section">
                          <div className="tm-itMapPanel__label">Viewing</div>
                          <div className="tm-itMapEmpty muted">Select a saved itinerary to view stops on the map.</div>
                        </div>
                      )}
                    </div>
                  </div>
                </div>
              )}

              {directionsPanelOpen && (
                <div className="tm-routePanel tm-routePanel--directions" aria-label="Directions">
                  <div className="tm-routePanel__top tm-routePanel__top--directions">
                    <div className="tm-routeModes" role="tablist" aria-label="Travel mode">
                      <button type="button" className={`tm-routeModeBtn ${travelMode === "DRIVING" ? "is-active" : ""}`} onClick={() => handleTravelModeChange("DRIVING")}>
                        🚗
                      </button>
                      <button
                        type="button"
                        className={`tm-routeModeBtn ${travelMode === "TWO_WHEELER" ? "is-active" : ""}`}
                        onClick={() => handleTravelModeChange("TWO_WHEELER")}
                      >
                        🛵
                      </button>
                      <button type="button" className={`tm-routeModeBtn ${travelMode === "TRANSIT" ? "is-active" : ""}`} onClick={() => handleTravelModeChange("TRANSIT")}>
                        🚌
                      </button>
                      <button type="button" className={`tm-routeModeBtn ${travelMode === "WALKING" ? "is-active" : ""}`} onClick={() => handleTravelModeChange("WALKING")}>
                        🚶
                      </button>
                      <button
                        type="button"
                        className={`tm-routeModeBtn ${travelMode === "BICYCLING" ? "is-active" : ""}`}
                        onClick={() => handleTravelModeChange("BICYCLING")}
                      >
                        🚲
                      </button>
                    </div>

                    <div className="tm-routePanel__actions">
                      <button type="button" className="tm-clearBtn tm-clearBtn--mini" onClick={clearAllDirections} aria-label="Clear directions" title="Clear">
                        Clear
                      </button>
                      <button
                        type="button"
                        className="tm-clearBtn tm-clearBtn--mini"
                        onClick={() => {
                          setDirectionsPanelOpen(false);
                          setActiveMarker(null);
                        }}
                        aria-label="Close directions"
                        title="Close"
                      >
                        ✕
                      </button>
                    </div>
                  </div>

                  <div className="tm-routePanel__body tm-routePanel__body--directions">
                    <div className="tm-routeFieldBlock">
                      <div className="tm-routeFieldHeader">
                        <div className="tm-routeLabel">Origin</div>
                        <button type="button" className="tm-routeLinkBtn" onClick={useCurrentLocation} title="Use your current location as origin">
                          Use current location
                        </button>
                      </div>

                      <div className="tm-routeRow">
                        <div className="tm-routePin" aria-hidden>
                          ○
                        </div>
                        <PlacesAutocompleteInput
                          inputId="tm_route_origin"
                          value={origin}
                          onChange={updateOrigin}
                          onSelect={(it) => {
                            updateOrigin(it.description);
                            setOriginCoords(it.position || null);
                            setClickTarget("destination");
                          }}
                          placeholder="Choose starting point, or click on the map…"
                          className="tm-routeInput"
                          dropdownClassName="tm-autoDropdown tm-autoDropdown--route"
                        />
                      </div>
                    </div>

                    <div className="tm-routeFieldBlock">
                      <div className="tm-routeFieldHeader">
                        <div className="tm-routeLabel">Destination</div>
                      </div>

                      <div className="tm-routeRow">
                        <div className="tm-routePin tm-routePin--dest" aria-hidden>
                          📍
                        </div>
                        <PlacesAutocompleteInput
                          inputId="tm_route_destination"
                          value={destination}
                          onChange={updateDestination}
                          onSelect={selectDestination}
                          placeholder="Choose destination…"
                          className="tm-routeInput"
                          dropdownClassName="tm-autoDropdown tm-autoDropdown--route"
                        />
                      </div>
                    </div>

                    <div className="tm-routeActionRow tm-routeActionRow--tight">
                      <button className="tm-mapSearchBtn tm-routeBtn" onClick={() => buildRoute()}>
                        Directions
                      </button>

                      <div className="tm-routeMeta tm-routeMeta--compact" aria-label="Route info">
                        <div className="tm-routeMetaTop">
                          <span className="tm-routeMetaStrong">
                            {shortLabel(originPreview, 18) || "Origin"} → {shortLabel(destPreview, 18) || "Destination"}
                          </span>
                        </div>
                        {routeMeta?.durationText ? (
                          <div className="tm-routeMetaSub">
                            ETA {routeMeta.durationText}
                            {routeMeta.trafficUnavailable ? " • Traffic data unavailable" : ""}
                            {routeMeta.isEstimate ? ` • ${routeMeta.estimateLabel || "estimate"}` : ""}
                            {routeMeta.distanceText ? ` • ${routeMeta.distanceText}` : ""}
                            {routeMeta.arrivalText ? ` • Arrive ~${routeMeta.arrivalText}` : ""}
                          </div>
                        ) : (
                          <div className="tm-routeMetaSub">
                            {clickTarget === "origin"
                              ? "Click the map to set origin, then click again to set destination."
                              : clickTarget === "destination"
                                ? "Origin set. Click the map to set destination, or type it below."
                                : "Route locked. Tap Clear to pick a new origin and destination."}
                          </div>
                        )}
                      </div>
                    </div>
                  </div>
                </div>
              )}
            </div>
          </div>

          <MapView
            center={mapCenter}
            zoom={mapZoom}
            onReady={onMapReady}
            onMapClick={handleMapClick}
            onMarkerClick={setActiveMarker}
            onPopupClose={() => setActiveMarker(null)}
            markers={[
              ...visibleSearchMarkers.map((marker) => ({
                ...marker,
                id: marker.id || marker.key,
                label: routeOpen ? "B" : marker.label,
              })),
              ...itineraryPins.map((pin) => ({
                ...pin,
                id: pin.id || pin.key,
              })),
              ...(userLocation
                ? [{ id: "user-location", name: "Your location", position: userLocation, label: "You" }]
                : []),
              ...(routeOpen && originCoords && !originIsCurrentLocation && !routePins?.start
                ? [{ id: "route-origin", name: origin, position: originCoords, label: "A" }]
                : []),
              ...(routePins?.start && !originIsCurrentLocation
                ? [{ id: "route-start", name: origin, position: routePins.start, label: "A" }]
                : []),
              ...(routePins?.end
                ? [{ id: "route-end", name: destination, position: routePins.end, label: "B" }]
                : []),
              ...(!routePins?.end && destinationCoords
                ? [{ id: "route-destination", name: destination, position: destinationCoords, label: "B" }]
                : []),
            ]}
            activeMarker={
              activeMarker
                ? { ...activeMarker, id: activeMarker.id || activeMarker.key }
                : null
            }
            routePaths={[
              ...(routeOpen && showDirectionsRenderer && directions?.geometry?.coordinates?.length > 1
                ? [{
                    id: "manual-route",
                    positions: directions.geometry.coordinates.map(([lng, lat]) => [lat, lng]),
                    color: "#087f8c",
                  }]
                : []),
              ...(!routeOpen && itineraryRouteOn && showItineraryRenderer && itineraryDirections?.geometry?.coordinates?.length > 1
                ? [{
                    id: "itinerary-route",
                    positions: itineraryDirections.geometry.coordinates.map(([lng, lat]) => [lat, lng]),
                    color: "#00a98f",
                  }]
                : []),
            ]}
            popupContent={
              activeMarker?.position ? (
                <div className="tm-popup">
                  <div className="tm-popupHeader">
                    <div className="tm-popupHeaderText">
                      <div className="tm-popupTitle">
                        {isItineraryMarker(activeMarker)
                          ? "Stop " + activeMarker.label + ": " + activeMarker.name
                          : activeMarker.name}
                      </div>

                      {isItineraryMarker(activeMarker) && (activeMarker.day || activeMarker.query) ? (
                        <div className="tm-popupMeta">
                          {activeMarker.day ? "Day " + activeMarker.day : ""}
                          {activeMarker.day && activeMarker.query ? " • " : ""}
                          {activeMarker.query || ""}
                        </div>
                      ) : null}
                    </div>

                    <button type="button" className="tm-popupClose" onClick={() => setActiveMarker(null)} aria-label="Close place popup" title="Close">
                      ✕
                    </button>
                  </div>

                  <div className="tm-popupStatusRow">
                    <span className="tm-popupBadge">{formatPopupRating(activeMarker.rating)}</span>
                    <span
                      className={
                        "tm-popupBadge " +
                        (activeMarker.openNow === true
                          ? "is-open"
                          : activeMarker.openNow === false
                            ? "is-closed"
                            : "")
                      }
                    >
                      {formatPopupOpenState(activeMarker.openNow)}
                    </span>
                  </div>

                  <div className="tm-popupAddress">
                    {formatPopupAddress(activeMarker.address)}
                  </div>

                  <div className="tm-popupActions">
                    <button className="tm-miniBtn" onClick={() => shareToChat(activeMarker)}>
                      Share to chat
                    </button>
                    <button className="tm-miniBtn tm-miniBtn--primary" onClick={() => openDirectionsFromMarker(activeMarker)}>
                      Directions
                    </button>
                    {hasItineraryView ? (
                      <button className="tm-miniBtn" onClick={clearItineraryView}>
                        Exit itinerary view
                      </button>
                    ) : null}
                  </div>
                </div>
              ) : null
            }
          />
        </div>
      </div>
    </div>
  );
}

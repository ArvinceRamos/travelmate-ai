import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useLocation, useNavigate, useSearchParams } from "react-router-dom";

import { useComposerDraft } from "../store/composerDraftContext";
import { useMaps } from "../features/maps/mapsStore.jsx";
import { useItinerary } from "../features/itinerary/itineraryStore.jsx";
import PlacesAutocompleteInput from "../features/maps/PlacesAutocompleteInput.jsx";
import MapView from "../features/maps/MapView.jsx";
import Icon from "../components/common/Icon.jsx";
import { itineraryStops, placeKey, stopDays } from "../utils/itineraryParse.js";
import {
  buildMapGeo,
  distanceKm,
  readMapGeo,
  resolveTripPlaces,
  stopQueries,
  tripOutlierKeys,
} from "../features/maps/tripGeo.js";
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

// Itinerary stops go through the backend's Nominatim queue (~1 s each); public Photon
// can take 10+ s per lookup. Photon stays as the fallback when the backend fails or finds nothing.
async function geocodeTripStop(query, { center, signal } = {}) {
  try {
    const params = new URLSearchParams({ q: query, limit: "5" });
    if (center) {
      params.set("lat", String(center.lat));
      params.set("lon", String(center.lng));
    }
    const result = await getApiJson(`/v1/places/geocode?${params}`, { signal });
    const hits = (result?.data?.places || [])
      .filter((p) => Number.isFinite(p?.location?.lat) && Number.isFinite(p?.location?.lng))
      .map((p) => ({ name: p.name, address: p.address, position: p.location }));
    if (hits.length) return hits;
  } catch (error) {
    if (signal?.aborted) throw error;
  }
  return photonSearch(query, { center, limit: 5, signal });
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

function isItineraryMarker(marker) {
  return Boolean(marker?.label && marker?.query);
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
  const { items: itineraryItems, saveMapGeo } = useItinerary();

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
  const [itineraryError, setItineraryError] = useState("");
  const [liveGeo, setLiveGeo] = useState({ id: null, anchor: null, places: {}, done: false });

  const [itineraryRouteOn, setItineraryRouteOn] = useState(true);
  const [itineraryDirections, setItineraryDirections] = useState(null);
  const [showItineraryRenderer, setShowItineraryRenderer] = useState(false);

  const mapRef = useRef(null);
  const [mapReady, setMapReady] = useState(false);

  const directionsRequestIdRef = useRef(0);
  const itineraryRouteRequestIdRef = useRef(0);
  const itineraryRouteCacheRef = useRef(new Map());
  const fittedViewRef = useRef("");
  const topBarRef = useRef(null);
  const itineraryPanelRef = useRef(null);

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

  const showItineraryLayer = itineraryPanelOpen && Boolean(selectedItineraryId);

  const visibleSearchMarkers = useMemo(() => {
    if (showItineraryLayer) return [];
    if (routeOpen) return activeMarker && !isItineraryMarker(activeMarker) ? [activeMarker] : [];
    return markers;
  }, [showItineraryLayer, routeOpen, markers, activeMarker]);

  const selectedItinerary = useMemo(() => {
    const list = Array.isArray(itineraryItems) ? itineraryItems : [];
    if (!selectedItineraryId) return null;
    return list.find((x) => x.id === selectedItineraryId) || null;
  }, [itineraryItems, selectedItineraryId]);

  const tripStops = useMemo(() => itineraryStops(selectedItinerary?.text || ""), [selectedItinerary?.text]);
  const tripQueries = useMemo(() => stopQueries(tripStops), [tripStops]);

  const storedGeo = useMemo(
    () => readMapGeo(selectedItinerary),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [selectedItinerary?.mapGeo, selectedItinerary?.mapStops]
  );
  const storedGeoRef = useRef(storedGeo);
  storedGeoRef.current = storedGeo;

  const liveGeoForTrip = liveGeo.id && liveGeo.id === selectedItineraryId ? liveGeo : null;
  const itineraryBusy = showItineraryLayer && Boolean(liveGeoForTrip) && !liveGeoForTrip.done;

  const tripGeo = useMemo(
    () => ({
      anchor: liveGeoForTrip?.anchor || storedGeo.anchor,
      places: liveGeoForTrip ? { ...storedGeo.places, ...liveGeoForTrip.places } : storedGeo.places,
    }),
    [storedGeo, liveGeoForTrip]
  );

  const anchorLabel = useMemo(
    () =>
      selectedItinerary
        ? String(selectedItinerary.anchor?.query || "").trim() || deriveAnchorLabel(selectedItinerary)
        : "",
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [selectedItinerary?.id, selectedItinerary?.anchor?.query, selectedItinerary?.title, selectedItinerary?.text]
  );

  const dayOptions = useMemo(
    () => stopDays(tripStops).map((day) => ({ day, label: `Day ${day}` })),
    [tripStops]
  );

  // Stops in view: per-day numbering (1..N) for one day, 1..N across the trip for "All days".
  const viewStops = useMemo(() => {
    const outliers = tripOutlierKeys(tripGeo.places, [...tripQueries.keys()]);
    const locate = (query) => {
      const k = placeKey(query);
      const p = tripGeo.places[k];
      if (!p) return { status: liveGeoForTrip?.done ? "missing" : "pending" };
      if (p.missing || outliers.has(k)) return { status: "missing" };
      return { status: "found", position: { lat: p.lat, lng: p.lng }, matchedName: p.name || "" };
    };
    const dayNum = dayFilter === "all" ? null : Number(dayFilter);
    const list = dayNum ? tripStops.filter((s) => s.day === dayNum) : tripStops;

    return list.map((s, i) => {
      const from = s.fromQuery ? locate(s.fromQuery) : null;
      return {
        ...s,
        ...locate(s.query),
        key: `${selectedItineraryId}:${s.id}`,
        number: dayNum ? s.order : i + 1,
        fromPosition: from?.status === "found" ? from.position : null,
      };
    });
  }, [tripStops, tripQueries, tripGeo, liveGeoForTrip?.done, dayFilter, selectedItineraryId]);

  const itineraryPins = useMemo(
    () =>
      viewStops
        .filter((s) => s.status === "found")
        .map((s) => ({
          id: s.key,
          key: s.key,
          label: String(s.number),
          query: s.place,
          name: s.place,
          address: s.matchedName,
          position: s.position,
          day: s.day,
          time: s.end ? `${s.start}–${s.end}` : s.start,
          fromQuery: s.isTransfer ? s.fromQuery : null,
        })),
    [viewStops]
  );

  // A transfer leg ("Cebu City to Moalboal") starts the route at its origin.
  const itineraryRouteCoords = useMemo(() => {
    const pts = [];
    for (const s of viewStops) {
      if (s.status !== "found") continue;
      const prev = pts[pts.length - 1];
      if (s.fromPosition && (!prev || distanceKm(prev, s.fromPosition) > 2)) pts.push(s.fromPosition);
      pts.push(s.position);
    }
    return pts.slice(0, 20);
  }, [viewStops]);
  const itineraryRouteKey = itineraryRouteCoords.map((p) => `${p.lng.toFixed(5)},${p.lat.toFixed(5)}`).join(";");

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
    setItineraryError("");
    setActiveMarker(null);
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
      setItineraryPanelOpen(false);
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

  const showSearchResult = useCallback(
    (suggestion) => {
      if (!suggestion?.position) return;
      const marker = {
        id: suggestion.placeId || `search-${Date.now()}`,
        name: suggestion.main || suggestion.description,
        address: suggestion.description || "",
        rating: null,
        openNow: null,
        position: suggestion.position,
      };
      setError("");
      setItineraryPanelOpen(false);
      setMarkers([marker]);
      setActiveMarker(marker);
      focusMapOnPoint(marker.position, 15);
    },
    [focusMapOnPoint]
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

  // Space taken by the search bar and itinerary panel, so pins aren't fitted underneath them.
  const overlayPadding = useCallback(() => {
    const pad = { tl: [48, 48], br: [48, 48] };
    const map = mapRef.current?.getContainer?.()?.getBoundingClientRect();
    if (!map) return pad;
    const bar = topBarRef.current?.getBoundingClientRect();
    if (bar) pad.tl[1] = Math.max(48, bar.bottom - map.top + 24);
    const panel = itineraryPanelRef.current?.getBoundingClientRect();
    if (panel) {
      const bottomSheet = panel.left - map.left < 24 && panel.right > map.right - 24;
      if (bottomSheet) pad.br[1] = Math.max(48, map.bottom - panel.top + 24);
      else pad.tl[0] = Math.max(48, panel.right - map.left + 24);
    }
    if (map.width - pad.tl[0] - pad.br[0] < 80) pad.tl[0] = pad.br[0] = 48;
    if (map.height - pad.tl[1] - pad.br[1] < 80) pad.tl[1] = pad.br[1] = 48;
    return pad;
  }, []);

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
    const { tl, br } = overlayPadding();
    const bounds = coords.map((position) => [position.lat, position.lng]);
    if (coords.length === 1) bounds.push(bounds[0]);

    mapRef.current.fitBounds(bounds, {
      paddingTopLeft: tl,
      paddingBottomRight: br,
      maxZoom: coords.length === 1 ? 14 : 16,
    });
  }, [overlayPadding]);

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

  // Geocode only stops with no saved location, show pins as they resolve, then save once.
  useEffect(() => {
    const id = selectedItinerary?.id;
    if (!showItineraryLayer || !id) return;

    const { anchor, places: known } = storedGeoRef.current;
    if (![...tripQueries.keys()].some((k) => !known[k])) {
      setLiveGeo((prev) =>
        prev.id === id ? (prev.done ? prev : { ...prev, done: true }) : { id, anchor: null, places: {}, done: true }
      );
      return;
    }

    const controller = new AbortController();
    const found = { anchor, places: {} };
    let dirty = false;
    setLiveGeo({ id, anchor: null, places: {}, done: false });

    resolveTripPlaces({
      queries: tripQueries,
      known,
      anchor,
      anchorLabel,
      search: geocodeTripStop,
      signal: controller.signal,
      onAnchor: (a) => {
        found.anchor = a;
        dirty = true;
        setLiveGeo((prev) => (prev.id === id ? { ...prev, anchor: a } : prev));
      },
      onPlace: (k, p) => {
        found.places[k] = p;
        dirty = true;
        setLiveGeo((prev) => (prev.id === id ? { ...prev, places: { ...prev.places, [k]: p } } : prev));
      },
    }).finally(() => {
      if (!controller.signal.aborted) {
        setLiveGeo((prev) => (prev.id === id ? { ...prev, done: true } : prev));
      }
      if (dirty) {
        const mapGeo = buildMapGeo({
          anchor: found.anchor,
          places: { ...known, ...found.places },
          queries: tripQueries,
        });
        saveMapGeo(id, mapGeo).catch((err) => console.warn("Saving map locations failed:", err?.message || err));
      }
    });

    return () => controller.abort();
  }, [showItineraryLayer, selectedItinerary?.id, tripQueries, anchorLabel, saveMapGeo]);

  // Fit once on the first pins of a view, and again when all stops are resolved.
  const itineraryViewKey = showItineraryLayer ? `${selectedItineraryId}|${dayFilter}` : "";
  useEffect(() => {
    if (!mapReady || !itineraryViewKey) {
      fittedViewRef.current = "";
      return;
    }
    if (itineraryPins.length) {
      const tag = `${itineraryViewKey}|${itineraryBusy ? "partial" : "all"}`;
      if (fittedViewRef.current === tag) return;
      fittedViewRef.current = tag;
      const legStarts = viewStops.filter((s) => s.fromPosition).map((s) => ({ position: s.fromPosition }));
      fitToPins([...itineraryPins, ...legStarts]);
      return;
    }
    const a = tripGeo.anchor;
    const tag = `${itineraryViewKey}|anchor`;
    if (itineraryBusy && a && !a.missing && fittedViewRef.current !== tag) {
      fittedViewRef.current = tag;
      mapRef.current?.setView([a.lat, a.lng], 11);
    }
  }, [mapReady, itineraryViewKey, itineraryPins, viewStops, itineraryBusy, tripGeo.anchor, fitToPins]);

  useEffect(() => {
    setItineraryError("");
    if (!showItineraryLayer || !itineraryRouteOn || itineraryBusy || itineraryRouteCoords.length < 2) {
      clearItineraryRoute();
      return;
    }

    const cached = itineraryRouteCacheRef.current.get(itineraryRouteKey);
    if (cached) {
      setItineraryDirections(cached);
      setShowItineraryRenderer(true);
      return;
    }

    clearItineraryRoute(false);
    const requestId = itineraryRouteRequestIdRef.current + 1;
    itineraryRouteRequestIdRef.current = requestId;

    requestOsrmRoute(itineraryRouteCoords, "DRIVING")
      .then((route) => {
        if (requestId !== itineraryRouteRequestIdRef.current) return;
        itineraryRouteCacheRef.current.set(itineraryRouteKey, route);
        setItineraryDirections(route);
        setShowItineraryRenderer(true);
      })
      .catch((err) => {
        if (requestId !== itineraryRouteRequestIdRef.current) return;
        clearItineraryRoute(false);
        setItineraryError(err?.message || "Couldn’t draw the itinerary route. Please try again.");
      });

    return () => {
      itineraryRouteRequestIdRef.current += 1;
    };
    // itineraryRouteKey stands in for itineraryRouteCoords
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [showItineraryLayer, itineraryRouteOn, itineraryBusy, itineraryRouteKey, clearItineraryRoute]);

  const originPreview = originCoords ? "Current location" : origin || "";
  const destPreview = destination || "";
  const originIsCurrentLocation = origin.trim().toLowerCase() === "current location" && !!userLocation;
  const itineraryTitle = selectedItinerary?.title || "Itinerary";
  const hasItineraryView = showItineraryLayer;
  const mapNotice = error || (showItineraryLayer ? itineraryError : "");
  const foundStopCount = viewStops.filter((s) => s.status === "found").length;
  const stopGroups = viewStops.reduce((groups, stop) => {
    const last = groups[groups.length - 1];
    if (last && last.day === stop.day) last.stops.push(stop);
    else groups.push({ day: stop.day, stops: [stop] });
    return groups;
  }, []);

  const focusStop = (stop) => {
    const pin = itineraryPins.find((p) => p.id === stop.key);
    if (!pin) return;
    const map = mapRef.current;
    if (!map) return;
    const zoom = Math.max(map.getZoom(), 15);
    const { tl, br } = overlayPadding();
    // Phones (bottom sheet, landscape) leave too little height for the popup; show the pin alone.
    setActiveMarker(map.getSize().y - tl[1] - br[1] >= 300 ? pin : null);
    const offset = [(tl[0] - br[0]) / 2, (tl[1] - br[1]) / 2];
    const point = map.project([pin.position.lat, pin.position.lng], zoom).subtract(offset);
    map.setView(map.unproject(point, zoom), zoom);
  };

  return (
    <div className="tm-mapPage">
      <div className="tm-mapSurface">
        {mapNotice && <div className="tm-mapNotice">{mapNotice}</div>}

        <div className="tm-mapWrap tm-mapWrap--full">
          <div className="tm-mapOverlay" aria-label="Map controls">
            <div className="tm-mapOverlay__stack">
              <div ref={topBarRef} className="tm-mapSearch tm-mapTopBar tm-mapSearch--withDropdown tm-mapSearch--overlay">
                <PlacesAutocompleteInput
                  inputId="tm_place_search"
                  value={search}
                  onChange={setSearch}
                  onSelect={(it) => {
                    setSearch(it.description);
                    showSearchResult(it);
                  }}
                  placeholder="Search a city, landmark, or place…"
                />

                <button
                  type="button"
                  className={`tm-mapIconBtn ${itineraryPanelOpen ? "is-active" : ""}`}
                  onClick={() => {
                    const next = !itineraryPanelOpen;
                    if (next) {
                      clearAllDirections();
                      setRouteOpen(false);
                      setDirectionsPanelOpen(false);
                      setActiveMarker(null);
                      setMarkers([]);
                    }
                    setItineraryPanelOpen(next);
                  }}
                  aria-label="Open itineraries"
                  title="Itineraries"
                >
                  <Icon name="calendar" />
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
                  <Icon name="directions" />
                </button>

                <button
                  type="button"
                  className="tm-mapIconBtn tm-mapIconBtn--primary"
                  onClick={() => handleSearch()}
                  aria-label="Search places"
                  title="Search"
                >
                  <Icon name="search" strokeWidth={2.2} />
                </button>
              </div>

              {itineraryPanelOpen && (
                <div ref={itineraryPanelRef} className="tm-itMapPanel" aria-label="Itineraries">
                  <div className="tm-itMapPanel__top">
                    <div className="tm-itMapPanel__title">Itineraries on Map</div>
                    <div className="tm-itMapPanel__actions">
                      <button type="button" className="tm-clearBtn tm-clearBtn--mini" onClick={clearItineraryView} title="Clear itinerary view">
                        Clear
                      </button>
                      <button
                        type="button"
                        className="tm-clearBtn tm-clearBtn--mini"
                        onClick={() => {
                          setItineraryPanelOpen(false);
                          setActiveMarker(null);
                        }}
                        aria-label="Close itineraries panel"
                        title="Close"
                      >
                        <Icon name="close" size={18} />
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

                          <div className="tm-itMapPanel__hint muted" aria-live="polite">
                            {!tripStops.length
                              ? "No timed stops found in this itinerary. Edit it to add lines like “09:00–11:00 - Fort Santiago - …”."
                              : itineraryBusy
                                ? `Locating stops… ${foundStopCount} of ${viewStops.length}`
                                : `${foundStopCount} of ${viewStops.length} stop${viewStops.length === 1 ? "" : "s"} on the map`}
                          </div>

                          {stopGroups.length ? (
                            <div className="tm-itMapStops">
                              {stopGroups.map((group) => (
                                <div key={group.day} className="tm-itMapStops__group">
                                  {dayFilter === "all" ? <div className="tm-itMapStops__day">Day {group.day}</div> : null}
                                  <ol className="tm-itMapStops__list">
                                    {group.stops.map((stop) => (
                                      <li key={stop.key}>
                                        <button
                                          type="button"
                                          className={`tm-itMapStop is-${stop.status}`}
                                          onClick={() => focusStop(stop)}
                                          disabled={stop.status !== "found"}
                                        >
                                          <span className="tm-itMapStop__num" aria-hidden="true">{stop.number}</span>
                                          <span className="tm-itMapStop__body">
                                            <span className="tm-itMapStop__place">{stop.place}</span>
                                            <span className="tm-itMapStop__meta">
                                              {stop.end ? `${stop.start}–${stop.end}` : stop.start}
                                              {stop.isTransfer ? " · Transfer" : ""}
                                              {stop.status === "missing" ? " · Not found on map" : ""}
                                              {stop.status === "pending" ? " · Locating…" : ""}
                                            </span>
                                          </span>
                                        </button>
                                      </li>
                                    ))}
                                  </ol>
                                </div>
                              ))}
                            </div>
                          ) : null}
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
                      <button type="button" className={`tm-routeModeBtn ${travelMode === "DRIVING" ? "is-active" : ""}`} aria-label="Drive" aria-selected={travelMode === "DRIVING"} role="tab" onClick={() => handleTravelModeChange("DRIVING")}>
                        <Icon name="car" />
                      </button>
                      <button
                        type="button"
                        className={`tm-routeModeBtn ${travelMode === "TWO_WHEELER" ? "is-active" : ""}`}
                        aria-label="Two-wheeler"
                        aria-selected={travelMode === "TWO_WHEELER"}
                        role="tab"
                        onClick={() => handleTravelModeChange("TWO_WHEELER")}
                      >
                        <Icon name="scooter" />
                      </button>
                      <button type="button" className={`tm-routeModeBtn ${travelMode === "TRANSIT" ? "is-active" : ""}`} aria-label="Transit" aria-selected={travelMode === "TRANSIT"} role="tab" onClick={() => handleTravelModeChange("TRANSIT")}>
                        <Icon name="bus" />
                      </button>
                      <button type="button" className={`tm-routeModeBtn ${travelMode === "WALKING" ? "is-active" : ""}`} aria-label="Walk" aria-selected={travelMode === "WALKING"} role="tab" onClick={() => handleTravelModeChange("WALKING")}>
                        <Icon name="walk" />
                      </button>
                      <button
                        type="button"
                        className={`tm-routeModeBtn ${travelMode === "BICYCLING" ? "is-active" : ""}`}
                        aria-label="Cycle"
                        aria-selected={travelMode === "BICYCLING"}
                        role="tab"
                        onClick={() => handleTravelModeChange("BICYCLING")}
                      >
                        <Icon name="bike" />
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
                        <Icon name="close" size={18} />
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
                        <span className="tm-routePin" aria-hidden="true" />
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
                        <span className="tm-routePin tm-routePin--dest" aria-hidden="true" />
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
                      <button className="tm-mapSearchBtn tm-routeBtn" type="button" onClick={() => buildRoute()}>
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
              ...(showItineraryLayer ? itineraryPins : []),
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
                    color: "#0E3B2B",
                  }]
                : []),
              ...(!routeOpen && showItineraryLayer && itineraryRouteOn && showItineraryRenderer && itineraryDirections?.geometry?.coordinates?.length > 1
                ? [{
                    id: "itinerary-route",
                    positions: itineraryDirections.geometry.coordinates.map(([lng, lat]) => [lat, lng]),
                    color: "#00724A",
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

                      {isItineraryMarker(activeMarker) ? (
                        <div className="tm-popupMeta">
                          {[
                            activeMarker.day ? `Day ${activeMarker.day}` : "",
                            activeMarker.time || "",
                            activeMarker.fromQuery ? `Transfer from ${activeMarker.fromQuery}` : "",
                          ]
                            .filter(Boolean)
                            .join(" • ")}
                        </div>
                      ) : null}
                    </div>

                    <button type="button" className="tm-popupClose" onClick={() => setActiveMarker(null)} aria-label="Close place popup" title="Close">
                      <Icon name="close" size={16} />
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

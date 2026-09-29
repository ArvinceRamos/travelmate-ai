import { useEffect } from "react";
import L from "leaflet";
import {
  MapContainer,
  Marker,
  Polyline,
  Popup,
  TileLayer,
  useMap,
  useMapEvents,
} from "react-leaflet";
import "leaflet/dist/leaflet.css";

const DEFAULT_CENTER = [20, 0];
const TILE_URL =
  import.meta.env.VITE_OSM_TILE_URL ||
  "https://tile.openstreetmap.org/{z}/{x}/{y}.png";
const TILE_ATTRIBUTION =
  '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap contributors</a>';

function escapeHtml(value) {
  return String(value ?? "").replace(/[&<>"']/g, (char) => {
    const entities = {
      "&": "&amp;",
      "<": "&lt;",
      ">": "&gt;",
      '"': "&quot;",
      "'": "&#39;",
    };
    return entities[char];
  });
}

function markerIcon(label) {
  return L.divIcon({
    className: "tm-leafletMarkerWrap",
    html: `<span class="tm-leafletMarker">${escapeHtml(label)}</span>`,
    iconSize: [32, 38],
    iconAnchor: [16, 34],
    popupAnchor: [0, -32],
  });
}

function MapEvents({ onMapClick }) {
  useMapEvents({
    click(event) {
      onMapClick?.({ lat: event.latlng.lat, lng: event.latlng.lng });
    },
  });
  return null;
}

function MapReady({ onReady }) {
  const map = useMap();

  useEffect(() => {
    onReady?.(map);
  }, [map, onReady]);

  return null;
}

export default function MapView({
  center = { lat: DEFAULT_CENTER[0], lng: DEFAULT_CENTER[1] },
  zoom = 2,
  markers = [],
  activeMarker = null,
  popupContent = null,
  routePaths = [],
  onReady,
  onMapClick,
  onMarkerClick,
  onPopupClose,
}) {
  const centerPosition =
    Number.isFinite(Number(center?.lat)) && Number.isFinite(Number(center?.lng))
      ? [Number(center.lat), Number(center.lng)]
      : DEFAULT_CENTER;

  return (
    <MapContainer
      className="tm-leafletMap"
      center={centerPosition}
      zoom={zoom}
      scrollWheelZoom
    >
      <MapReady onReady={onReady} />
      <MapEvents onMapClick={onMapClick} />
      <TileLayer url={TILE_URL} attribution={TILE_ATTRIBUTION} maxZoom={19} />

      {routePaths.map((route, index) => (
        <Polyline
          key={route.id || `route-${index}`}
          positions={route.positions}
          pathOptions={{ color: route.color || "#087f8c", weight: 5, opacity: 0.85 }}
        />
      ))}

      {markers
        .filter(
          (marker) =>
            Number.isFinite(Number(marker?.position?.lat)) &&
            Number.isFinite(Number(marker?.position?.lng))
        )
        .map((marker, index) => (
          <Marker
            key={marker.id || `${marker.position.lat},${marker.position.lng}-${index}`}
            position={[Number(marker.position.lat), Number(marker.position.lng)]}
            icon={markerIcon(marker.label || "")}
            eventHandlers={{ click: () => onMarkerClick?.(marker) }}
          >
            {activeMarker?.id === marker.id ? (
              <Popup closeButton={false} eventHandlers={{ remove: onPopupClose }}>
                {popupContent || marker.name || marker.query || "Selected place"}
              </Popup>
            ) : null}
          </Marker>
        ))}
    </MapContainer>
  );
}

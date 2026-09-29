import React, { createContext, useCallback, useContext, useMemo, useState } from "react";

const MAP_JSON_START = "<<<MAP_STOPS_JSON>>>";
const MAP_JSON_END = "<<<END_MAP_STOPS_JSON>>>";

function extractMapStopsFromReply(replyText) {
  const text = String(replyText || "");
  const start = text.indexOf(MAP_JSON_START);
  const end = text.indexOf(MAP_JSON_END);

  if (start === -1 || end === -1 || end <= start) {
    return { anchor: null, mapStops: null, cleanText: text };
  }

  const jsonRaw = text.slice(start + MAP_JSON_START.length, end).trim();
  let parsed = null;
  try {
    parsed = JSON.parse(jsonRaw);
  } catch {
    parsed = null;
  }

  const cleanText = (text.slice(0, start) + text.slice(end + MAP_JSON_END.length)).trim();
  const anchor = parsed && typeof parsed.anchor === "object" ? parsed.anchor : null;
  const mapStops = Array.isArray(parsed?.mapStops) ? parsed.mapStops : null;

  return { anchor, mapStops, cleanText };
}

const MapsContext = createContext(null);

export function MapsProvider({ children }) {
  const [mapIntent, setMapIntent] = useState(null);
  const [preview, setPreview] = useState(null);

  const setPreviewFromReply = useCallback(({ chatId = null, replyText }) => {
    const parsed = extractMapStopsFromReply(replyText);
    setPreview(
      parsed.anchor || (Array.isArray(parsed.mapStops) && parsed.mapStops.length > 0)
        ? {
            chatId: chatId || null,
            anchor: parsed.anchor,
            stops: parsed.mapStops || [],
            cleanReply: parsed.cleanText,
          }
        : null
    );
  }, []);

  const clearPreview = useCallback(() => setPreview(null), []);

  const api = useMemo(
    () => ({
      mapIntent,
      preview,
      openPlace: (intent) => setMapIntent({ ...intent, ts: Date.now() }),
      clearIntent: () => setMapIntent(null),
      setPreviewFromReply,
      clearPreview,
    }),
    [mapIntent, preview, setPreviewFromReply, clearPreview]
  );

  return <MapsContext.Provider value={api}>{children}</MapsContext.Provider>;
}

export function useMaps() {
  const ctx = useContext(MapsContext);
  if (!ctx) throw new Error("useMaps must be used within <MapsProvider>");
  return ctx;
}

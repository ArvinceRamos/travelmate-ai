import React, { useEffect, useMemo, useRef, useState } from "react";
import { peekPlacesAutocomplete, placesAutocomplete } from "../../services/mapsService.js";
import { loadRecents, localMatches, mergeSuggestions, saveRecent } from "./localSuggestions.js";

const MIN_REMOTE_LENGTH = 2;
const DEBOUNCE_MS = 120;
const SLOW_MS = 4000;
const MAX_ROWS = 8;
const EMPTY = [];

async function fetchSuggestions(query, biasCenter, signal) {
  const result = await placesAutocomplete({ query, center: biasCenter, limit: MAX_ROWS, signal });
  if (!result.ok) {
    if (result.reason === "aborted") return [];
    throw new Error(
      result.reason === "rate-limited"
        ? "Place search is busy. Please try again shortly."
        : "Place search is temporarily unavailable."
    );
  }
  return result.suggestions;
}

export default function PlacesAutocompleteInput({
  value,
  onChange,
  onSelect,
  onSubmit,
  placeholder,
  disabled = false,
  biasCenter = null,
  recentsKey = "",
  localPlaces = EMPTY,
  className = "tm-mapSearchInput",
  dropdownClassName = "tm-autoDropdown",
  inputId,
}) {
  const [open, setOpen] = useState(false);
  const [remote, setRemote] = useState([]);
  const [activeIdx, setActiveIdx] = useState(-1);
  const [busy, setBusy] = useState(false);
  const [slow, setSlow] = useState(false);
  const [err, setErr] = useState("");
  const [recents, setRecents] = useState(() => loadRecents(recentsKey));

  const wrapRef = useRef(null);
  const reqSeq = useRef(0);
  const pickedRef = useRef("");

  const q = String(value || "").trim();

  useEffect(() => {
    setRecents(loadRecents(recentsKey));
  }, [recentsKey]);

  useEffect(() => {
    function onDocMouseDown(e) {
      if (!wrapRef.current) return;
      if (!wrapRef.current.contains(e.target)) {
        setOpen(false);
        setActiveIdx(-1);
      }
    }
    function onKeyDown(e) {
      if (e.key === "Escape") {
        setOpen(false);
        setActiveIdx(-1);
      }
    }
    document.addEventListener("mousedown", onDocMouseDown);
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("mousedown", onDocMouseDown);
      document.removeEventListener("keydown", onKeyDown);
    };
  }, []);

  useEffect(() => {
    const seq = ++reqSeq.current;
    const controller = new AbortController();
    setActiveIdx(-1);
    setSlow(false);

    if (q.length < MIN_REMOTE_LENGTH || q === pickedRef.current) {
      if (q.length < MIN_REMOTE_LENGTH) setRemote([]);
      setBusy(false);
      setErr("");
      return () => controller.abort();
    }

    const cached = peekPlacesAutocomplete({ query: q, center: biasCenter, limit: MAX_ROWS });
    if (cached) {
      setRemote(cached);
      setBusy(false);
      setErr("");
      return () => controller.abort();
    }

    // Keep the previous suggestions on screen until the new ones arrive.
    setBusy(true);
    const slowTimer = setTimeout(() => {
      if (seq === reqSeq.current) setSlow(true);
    }, SLOW_MS);
    const debounceTimer = setTimeout(async () => {
      setErr("");
      try {
        const mapped = await fetchSuggestions(q, biasCenter, controller.signal);
        if (seq !== reqSeq.current) return;
        setRemote(mapped);
        setActiveIdx(-1);
      } catch (error) {
        if (controller.signal.aborted || seq !== reqSeq.current) return;
        setRemote([]);
        setActiveIdx(-1);
        setErr(error?.message || "Place search is temporarily unavailable.");
      } finally {
        if (seq === reqSeq.current && !controller.signal.aborted) {
          clearTimeout(slowTimer);
          setBusy(false);
          setSlow(false);
        }
      }
    }, DEBOUNCE_MS);

    return () => {
      clearTimeout(debounceTimer);
      clearTimeout(slowTimer);
      controller.abort();
    };
  }, [q, biasCenter?.lat, biasCenter?.lng]);

  const items = useMemo(() => {
    if (!q) return [];
    const local = localMatches(q, { recents, tripRows: localPlaces, limit: 4, center: biasCenter });
    return mergeSuggestions(local, remote).slice(0, MAX_ROWS);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [q, recents, localPlaces, remote, biasCenter?.lat, biasCenter?.lng]);

  function pick(item) {
    if (!item) return;
    pickedRef.current = String(item.description || "").trim();
    if (recentsKey) {
      saveRecent(recentsKey, item);
      setRecents(loadRecents(recentsKey));
    }
    onSelect?.(item);
    setOpen(false);
    setActiveIdx(-1);
  }

  const status = err
    ? err
    : busy && slow
      ? onSubmit
        ? "Search is slow right now, press Enter to search"
        : "Search is slow right now…"
      : busy && remote.length === 0
        ? "Searching…"
        : "";
  const showDropdown = open && Boolean(q) && (items.length > 0 || Boolean(status));

  return (
    <div ref={wrapRef} className="tm-autoWrap">
      <input
        id={inputId}
        className={className}
        value={value}
        onChange={(e) => {
          onChange?.(e.target.value);
          setOpen(true);
        }}
        placeholder={placeholder}
        aria-label={placeholder}
        disabled={disabled}
        autoComplete="off"
        onFocus={() => setOpen(true)}
        onKeyDown={(e) => {
          if (e.key === "Enter") {
            if (open && activeIdx >= 0 && items[activeIdx]) {
              e.preventDefault();
              pick(items[activeIdx]);
            } else if (onSubmit && q) {
              e.preventDefault();
              setOpen(false);
              setActiveIdx(-1);
              onSubmit(q);
            }
            return;
          }
          if (!open || items.length === 0) return;

          if (e.key === "ArrowDown") {
            e.preventDefault();
            setActiveIdx((i) => Math.min(items.length - 1, i + 1));
          }
          if (e.key === "ArrowUp") {
            e.preventDefault();
            setActiveIdx((i) => Math.max(0, i - 1));
          }
        }}
        aria-autocomplete="list"
        aria-expanded={showDropdown}
        aria-controls={inputId ? `${inputId}__list` : undefined}
      />

      {showDropdown && (
        <div className={dropdownClassName} role="listbox" id={inputId ? `${inputId}__list` : undefined}>
          {items.map((it, idx) => {
            const tag = it.kind === "recent" ? "Recent" : it.kind === "trip" ? "Your trip" : "";
            const sub = [tag, it.secondary].filter(Boolean).join(" · ");
            return (
              <button
                key={`${it.placeId}-${idx}`}
                type="button"
                className={idx === activeIdx ? "tm-autoItem tm-autoItem--active" : "tm-autoItem"}
                role="option"
                aria-selected={idx === activeIdx}
                onMouseDown={(e) => e.preventDefault()}
                onClick={() => pick(it)}
              >
                <div className="tm-autoMain">{it.main}</div>
                {sub ? <div className="tm-autoSub">{sub}</div> : null}
              </button>
            );
          })}
          {status ? <div className="tm-autoItem tm-autoItem--muted" role="status">{status}</div> : null}
          {items.some((it) => it.provider === "geoapify") ? (
            <div className="tm-autoFooter">
              Powered by{" "}
              <a href="https://www.geoapify.com/" target="_blank" rel="noopener noreferrer">Geoapify</a>
            </div>
          ) : null}
        </div>
      )}
    </div>
  );
}

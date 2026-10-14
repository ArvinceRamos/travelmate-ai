import React, { useEffect, useRef, useState } from "react";
import { peekPlacesAutocomplete, placesAutocomplete } from "../../services/mapsService.js";

const MIN_QUERY_LENGTH = 3;
const DEBOUNCE_MS = 200;

async function fetchPhotonSuggestions(query, biasCenter, signal) {
  const result = await placesAutocomplete({ query, center: biasCenter, limit: 8, signal });
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
  placeholder,
  disabled = false,
  biasCenter = null,
  className = "tm-mapSearchInput",
  dropdownClassName = "tm-autoDropdown",
  inputId,
}) {
  const [open, setOpen] = useState(false);
  const [items, setItems] = useState([]);
  const [activeIdx, setActiveIdx] = useState(-1);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");

  const wrapRef = useRef(null);
  const reqSeq = useRef(0);
  const timerRef = useRef(null);
  const pickedRef = useRef("");

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
    const q = String(value || "").trim();
    const seq = ++reqSeq.current;
    const controller = new AbortController();
    if (timerRef.current) clearTimeout(timerRef.current);

    if (q.length < MIN_QUERY_LENGTH || q === pickedRef.current) {
      if (q.length < MIN_QUERY_LENGTH) setItems([]);
      setActiveIdx(-1);
      setBusy(false);
      setErr("");
      return () => controller.abort();
    }

    const cached = peekPlacesAutocomplete({ query: q, center: biasCenter, limit: 8 });
    if (cached) {
      setItems(cached);
      setActiveIdx(-1);
      setBusy(false);
      setErr("");
      return () => controller.abort();
    }

    // Keep the previous suggestions on screen until the new ones arrive.
    setBusy(true);
    timerRef.current = setTimeout(async () => {
      setErr("");

      try {
        const mapped = await fetchPhotonSuggestions(q, biasCenter, controller.signal);
        if (seq !== reqSeq.current) return;
        setItems(mapped);
        setActiveIdx(-1);
      } catch (error) {
        if (controller.signal.aborted || seq !== reqSeq.current) return;
        setItems([]);
        setActiveIdx(-1);
        setErr(error?.message || "Place search is temporarily unavailable.");
      } finally {
        if (seq === reqSeq.current && !controller.signal.aborted) setBusy(false);
      }
    }, DEBOUNCE_MS);

    return () => {
      if (timerRef.current) clearTimeout(timerRef.current);
      controller.abort();
    };
  }, [value, biasCenter?.lat, biasCenter?.lng]);

  function pick(item) {
    if (!item) return;
    pickedRef.current = String(item.description || "").trim();
    onSelect?.(item);
    setOpen(false);
    setActiveIdx(-1);
  }

  const showDropdown = open && (busy || items.length > 0 || !!err);

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
          if (!open || items.length === 0) return;

          if (e.key === "ArrowDown") {
            e.preventDefault();
            setActiveIdx((i) => Math.min(items.length - 1, i + 1));
          }
          if (e.key === "ArrowUp") {
            e.preventDefault();
            setActiveIdx((i) => Math.max(0, i - 1));
          }
          if (e.key === "Enter" && activeIdx >= 0) {
            e.preventDefault();
            pick(items[activeIdx]);
          }
        }}
        aria-autocomplete="list"
        aria-expanded={showDropdown}
        aria-controls={inputId ? `${inputId}__list` : undefined}
      />

      {showDropdown && (
        <div className={dropdownClassName} role="listbox" id={inputId ? `${inputId}__list` : undefined}>
          {busy && items.length === 0 ? (
            <div className="tm-autoItem tm-autoItem--muted">Searching…</div>
          ) : err ? (
            <div className="tm-autoItem tm-autoItem--muted">{err}</div>
          ) : (
            items.map((it, idx) => (
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
                {it.secondary ? <div className="tm-autoSub">{it.secondary}</div> : null}
              </button>
            ))
          )}
        </div>
      )}
    </div>
  );
}

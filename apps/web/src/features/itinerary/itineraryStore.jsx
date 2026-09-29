import React, {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import {
  addDoc,
  collection,
  deleteDoc,
  doc,
  onSnapshot,
  orderBy,
  query,
  serverTimestamp,
  updateDoc,
  where,
} from "firebase/firestore";
import { db } from "../../services/firebase";
import { useAuth } from "../../hooks/useAuth";
import { deriveItineraryTitle } from "../../utils/itineraryTitle";
import { buildItineraryTitle, extractTripMetaFromText, titleLooksBad } from "../../utils/tripMeta";

const ItineraryContext = createContext(null);

function toDayMs(iso) {
  if (!iso) return null;
  const m = String(iso).match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!m) return null;
  const d = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}

function rangesOverlap(aStartIso, aEndIso, bStartIso, bEndIso) {
  const aS = toDayMs(aStartIso);
  const aE = toDayMs(aEndIso);
  const bS = toDayMs(bStartIso);
  const bE = toDayMs(bEndIso);
  if (!aS || !aE || !bS || !bE) return false;
  return aS <= bE && aE >= bS;
}

function sortByMostRecent(rows) {
  const list = Array.isArray(rows) ? [...rows] : [];
  list.sort((a, b) => {
    const at = a?.updatedAtMs ?? a?.createdAtMs ?? 0;
    const bt = b?.updatedAtMs ?? b?.createdAtMs ?? 0;
    return bt - at;
  });
  return list;
}

/** Block saving trips that already ended */
function isPastTrip(tripEndISO) {
  if (!tripEndISO) return false;
  const endMs = toDayMs(tripEndISO);
  if (!endMs) return false;

  const today = new Date();
  today.setHours(0, 0, 0, 0);
  return endMs < today.getTime();
}

export function ItineraryProvider({ children }) {
  const { user, loading } = useAuth();

  const [pending, setPending] = useState(null); // { title, text, tripStart, tripEnd, tripTimeText, prompt }
  const [items, setItems] = useState([]);
  const [activeId, setActiveId] = useState(null);

  const unsubRef = useRef(null);
  const backfilledIdsRef = useRef(new Set());

  const subscribeUserItineraries = useCallback((uid) => {
    if (!uid) return () => {};

    const indexedQuery = query(
      collection(db, "itineraries"),
      where("uid", "==", uid),
      orderBy("updatedAt", "desc")
    );

    const fallbackQuery = query(collection(db, "itineraries"), where("uid", "==", uid));

    const startFallback = () =>
      onSnapshot(
        fallbackQuery,
        (snap) => {
          const rows = snap.docs.map((d) => ({ id: d.id, ...d.data() }));
          setItems(sortByMostRecent(rows));
        },
        (err2) => {
          console.error("subscribeUserItineraries(fallback):", err2.code, err2.message);
          setItems([]);
        }
      );

    return onSnapshot(
      indexedQuery,
      (snap) => {
        const rows = snap.docs.map((d) => ({ id: d.id, ...d.data() }));
        setItems(rows);

        // ✅ Backfill missing tripStart/tripEnd + repair bad titles (safe; no infinite update loops)
        try {
          const toUpdate = [];
          for (const it of rows) {
            const id = it?.id;
            if (!id) continue;
            if (backfilledIdsRef.current.has(id)) continue;

            const text = String(it?.text || "");
            if (!text.trim()) continue;

            const missingDates = !it.tripStart || !it.tripEnd;
            const badTitle = !it.title || titleLooksBad(it.title);

            if (!missingDates && !badTitle) continue;

            const inferred = extractTripMetaFromText(text);
            const nextTripStart = it.tripStart || inferred.startISO || null;
            const nextTripEnd = it.tripEnd || inferred.endISO || null;

            const nextTitle =
              badTitle
                ? buildItineraryTitle({
                    itineraryText: text,
                    tripStartISO: nextTripStart,
                    tripEndISO: nextTripEnd,
                  }) ||
                  deriveItineraryTitle({
                    prompt: inferred.destination || "",
                    tripStart: nextTripStart,
                    tripEnd: nextTripEnd,
                  }) ||
                  it.title ||
                  "Saved itinerary"
                : it.title;

            const patch = {
              ...(nextTripStart && nextTripStart !== it.tripStart ? { tripStart: nextTripStart } : {}),
              ...(nextTripEnd && nextTripEnd !== it.tripEnd ? { tripEnd: nextTripEnd } : {}),
              ...(nextTitle && nextTitle !== it.title ? { title: nextTitle } : {}),
            };

            if (Object.keys(patch).length) {
              backfilledIdsRef.current.add(id);
              toUpdate.push(
                updateDoc(doc(db, "itineraries", id), {
                  ...patch,
                  updatedAt: serverTimestamp(),
                  updatedAtMs: Date.now(),
                })
              );
            }
          }
          if (toUpdate.length) Promise.allSettled(toUpdate);
        } catch {}
      },
      (err) => {
        console.error("subscribeUserItineraries(indexed):", err.code, err.message);

        if (err?.code === "failed-precondition") {
          try {
            unsubRef.current?.();
          } catch {}
          unsubRef.current = startFallback();
        } else {
          setItems([]);
        }
      }
    );
  }, []);

  useEffect(() => {
    if (loading) return;

    try {
      unsubRef.current?.();
    } catch {}
    unsubRef.current = null;

    if (!user?.uid) {
      setItems([]);
      setActiveId(null);
      backfilledIdsRef.current = new Set();
      return;
    }

    backfilledIdsRef.current = new Set();

    unsubRef.current = subscribeUserItineraries(user.uid);
    return () => {
      try {
        unsubRef.current?.();
      } catch {}
    };
  }, [loading, user?.uid, subscribeUserItineraries]);

  const savePending = useCallback(
    async ({ uid, title, skipConflictCheck = false, asDraft = false } = {}) => {
      if (!pending?.text) return null;
      if (!uid) return { ok: false, reason: "not-signed-in" };

      // ✅ Auto-infer tripStart/tripEnd from itinerary text if missing
      const inferred = extractTripMetaFromText(pending.text || "");
      const finalTripStart = asDraft ? null : (pending.tripStart || inferred.startISO || null);
      const finalTripEnd = asDraft ? null : (pending.tripEnd || inferred.endISO || null);

      if (!asDraft) {
        // ✅ Prevent saving if trip already ended
        if (finalTripEnd && isPastTrip(finalTripEnd)) {
          return { ok: false, reason: "past-date" };
        }

        // ✅ Date conflict check uses inferred range too
        if (!skipConflictCheck && finalTripStart && finalTripEnd) {
          const conflict = (items || []).find((it) =>
            rangesOverlap(finalTripStart, finalTripEnd, it.tripStart, it.tripEnd)
          );
          if (conflict) {
            const repairedConflictTitle =
              titleLooksBad(conflict.title)
                ? buildItineraryTitle({
                    itineraryText: conflict.text || "",
                    tripStartISO: conflict.tripStart,
                    tripEndISO: conflict.tripEnd,
                  }) || "Saved itinerary"
                : conflict.title;
            return {
              ok: false,
              reason: "date-conflict",
              conflictWith: {
                id: conflict.id,
                title: repairedConflictTitle || "Saved itinerary",
                tripStart: conflict.tripStart,
                tripEnd: conflict.tripEnd,
              },
            };
          }
        }
      }

      const now = serverTimestamp();
      const nowMs = Date.now();

      // ✅ Build title from extracted destination + dates
      const inferredForTitle = extractTripMetaFromText(pending.text || "");
      const fromText = buildItineraryTitle({
        itineraryText: pending.text || "",
        tripStartISO: finalTripStart,
        tripEndISO: finalTripEnd,
      });

      const fromPrompt = deriveItineraryTitle({
        prompt: pending.prompt || inferredForTitle.destination || "",
        tripStart: finalTripStart,
        tripEnd: finalTripEnd,
      });

      // Prefer computed title; only use passed-in title if not generic/bad.
      let autoTitle =
        fromText ||
        (title && !titleLooksBad(title) ? title : null) ||
        fromPrompt ||
        "Saved itinerary";

      if (titleLooksBad(autoTitle)) autoTitle = fromText || fromPrompt || "Trip";
      if (asDraft) autoTitle = `[Draft] ${autoTitle}`;

      const docPayload = {
        uid,
        title: String(autoTitle || "Saved itinerary").trim() || "Saved itinerary",
        text: String(pending.text || ""),
        createdAt: now,
        updatedAt: now,
        createdAtMs: nowMs,
        updatedAtMs: nowMs,
        done: false,

        tripStart: finalTripStart,
        tripEnd: finalTripEnd,
        tripTimeText: pending.tripTimeText || null,

        // ✅ NEW: structured map data (preferred by Maps for accuracy)
        mapStops: pending.mapStops || null,
        anchor: pending.anchor || null,
      };

      const ref = await addDoc(collection(db, "itineraries"), docPayload);

      setItems((prev) => sortByMostRecent([{ id: ref.id, ...docPayload }, ...(prev || [])]));
      setPending(null);
      setActiveId(ref.id);

      return { ok: true, id: ref.id, ...docPayload };
    },
    [pending, items]
  );

  const deleteItinerary = useCallback(
    async (id) => {
      if (!id) return;
      await deleteDoc(doc(db, "itineraries", id));
      setItems((prev) => (Array.isArray(prev) ? prev.filter((x) => x.id !== id) : []));
      if (activeId === id) setActiveId(null);
    },
    [activeId]
  );

  const updateItinerary = useCallback(async (id, patch) => {
    if (!id) return;

    const next = {
      ...(patch || {}),
      updatedAt: serverTimestamp(),
      updatedAtMs: Date.now(),
    };

    await updateDoc(doc(db, "itineraries", id), next);

    setItems((prev) =>
      (Array.isArray(prev) ? prev : []).map((x) =>
        x.id === id ? { ...x, ...patch, updatedAtMs: next.updatedAtMs } : x
      )
    );
  }, []);

  const toggleDone = useCallback(
    async (id) => {
      const row = (Array.isArray(items) ? items : []).find((x) => x.id === id);
      if (!row) return;
      await updateItinerary(id, { done: !row.done });
    },
    [items, updateItinerary]
  );

  const value = useMemo(
    () => ({
      pending,
      setPending,
      items,
      activeId,
      setActiveId,
      subscribeUserItineraries,
      savePending,
      deleteItinerary,
      updateItinerary,
      toggleDone,

      // back-compat aliases
      saved: items,
      deleteById: deleteItinerary,
    }),
    [
      pending,
      items,
      activeId,
      subscribeUserItineraries,
      savePending,
      deleteItinerary,
      updateItinerary,
      toggleDone,
    ]
  );

  return <ItineraryContext.Provider value={value}>{children}</ItineraryContext.Provider>;
}

export function useItinerary() {
  const ctx = useContext(ItineraryContext);
  if (!ctx) throw new Error("useItinerary must be used within <ItineraryProvider>");
  return ctx;
}

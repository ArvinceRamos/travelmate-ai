// apps/web/src/features/notifications/notificationsStore.jsx
import React, { createContext, useContext, useEffect, useMemo, useRef, useState } from "react";
import {
  collection,
  doc,
  getDocs,
  limit,
  onSnapshot,
  orderBy,
  query,
  serverTimestamp,
  setDoc,
  updateDoc,
  where,
  writeBatch,
} from "firebase/firestore";

import { db } from "../../services/firebase";
import { useAuth } from "../../hooks/useAuth";

/*
  TravelMate Notifications

  - Logged out: best-effort local notifications (localStorage + timers)
  - Logged in: Firestore-backed:
      users/{uid}/reminderSources/{itineraryId}   (client writes)
      users/{uid}/notifications/{notifId}        (client writes)
      users/{uid}/pushTokens/{token}             (client writes)

  IMPORTANT:
  - UI expects consistent fields:
      sourceItineraryId, title, body, timeLabel, endLabel, whenMs, scheduledDateTimeMs, type, read/done/deleted
*/

const LS_KEY = "tm_notifications_settings";
const LS_SCHEDULED = "tm_notifications_scheduled";
const LS_FEED = "tm_notifications_feed";
const LS_SOURCES = "tm_notifications_sources"; // reminder-enabled itineraries

// Keep due notifications eligible for browser popups for a while after the scheduled time.
// This prevents "blink-and-miss" behavior when the page is backgrounded or the scheduler drifts.
const DUE_LEAD_MS = 60 * 1000; // 1 min early
const OVERDUE_KEEP_MS = 15 * 60 * 1000; // 15 min after

const FOREGROUND_TICK_MS = 15 * 1000;

const MAX_NOTIFS_PER_ENABLE = 350;
const GENERATE_WINDOW_DAYS = 4;

function loadJson(key, fallback) {
  try {
    const v = localStorage.getItem(key);
    if (!v) return fallback;
    return JSON.parse(v);
  } catch {
    return fallback;
  }
}

function saveJson(key, value) {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch {}
}

function nowMs() {
  return Date.now();
}

function toDayMs(iso) {
  if (!iso) return null;
  const m = String(iso).match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!m) return null;
  const d = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}

function isPastTrip(tripEndISO) {
  const endMs = toDayMs(tripEndISO);
  if (!endMs) return false;
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  return endMs < today.getTime();
}

function parseISODateToLocalMidnight(iso) {
  const m = String(iso || "").match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!m) return null;
  const d = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
  d.setHours(0, 0, 0, 0);
  return d;
}

function addDays(dateObj, days) {
  const d = new Date(dateObj);
  d.setDate(d.getDate() + days);
  return d;
}

function parseTimeOnDateMs(hhmm, baseDate) {
  const raw = (hhmm || "").trim();
  if (!raw) return null;

  const m = raw.match(/(\d{1,2}):(\d{2})\s*(AM|PM)?/i);
  if (!m) return null;

  let h = parseInt(m[1], 10);
  const min = parseInt(m[2], 10);
  const ap = (m[3] || "").toUpperCase();

  if (ap === "PM" && h < 12) h += 12;
  if (ap === "AM" && h === 12) h = 0;

  const d = baseDate ? new Date(baseDate) : new Date();
  d.setHours(h, min, 0, 0);
  return d.getTime();
}

function localDateISOFromMs(ms) {
  try {
    const d = new Date(ms);
    const y = d.getFullYear();
    const m = String(d.getMonth() + 1).padStart(2, "0");
    const day = String(d.getDate()).padStart(2, "0");
    return `${y}-${m}-${day}`;
  } catch {
    return null;
  }
}

function cleanLine(rawLine) {
  return String(rawLine || "")
    .replace(/^\s*[-*•]\s+/, "")
    .replace(/\*\*/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

// More tolerant: allow "-" or "–" or "to"
function parseTimeRangeLine(line) {
  const s = cleanLine(line);
  if (!s) return null;

  const m = s.match(
    /^(\d{1,2}:\d{2}\s*(?:AM|PM)?)\s*(?:–|-|to)\s*(\d{1,2}:\d{2}\s*(?:AM|PM)?)\s*(?:[:\-–—]\s*)?(.*)$/i
  );
  if (!m) return null;

  const start = String(m[1] || "").trim();
  const end = String(m[2] || "").trim();
  const label = String(m[3] || "").trim();
  if (!label) return null;

  return { start, end, label };
}

function extractTimedItems(text = "", baseDate = null) {
  const lines = (text || "").split("\n");
  const items = [];

  for (const rawLine of lines) {
    const parsed = parseTimeRangeLine(rawLine);
    if (!parsed) continue;

    const whenMs = parseTimeOnDateMs(parsed.start, baseDate);
    if (!whenMs) continue;

    items.push({ whenMs, timeLabel: parsed.start, endLabel: parsed.end, label: parsed.label });
  }

  items.sort((a, b) => a.whenMs - b.whenMs);
  return items;
}

export function extractTimedItemsByDay(text = "", tripStartISO = null) {
  const src = String(text || "");
  const base = tripStartISO ? parseISODateToLocalMidnight(tripStartISO) : null;
  if (!base) return extractTimedItems(src, null);

  const lines = src.split("\n");
  const sections = [];
  let current = { dayNum: 1, lines: [] };

  for (const line of lines) {
    const m = line.match(/^\s*(?:#{1,6}\s*)?Day\s*(\d+)\b/i);
    if (m) {
      if (current.lines.length) sections.push(current);
      current = { dayNum: Math.max(1, Number(m[1] || 1)), lines: [] };
      continue;
    }
    current.lines.push(line);
  }
  if (current.lines.length) sections.push(current);

  if (!sections.length) sections.push({ dayNum: 1, lines });

  const out = [];
  for (const sec of sections) {
    const dayIndex = Math.max(0, (sec.dayNum || 1) - 1);
    const dayDate = addDays(base, dayIndex);
    const dayText = sec.lines.join("\n");
    const items = extractTimedItems(dayText, dayDate);
    out.push(...items.map((i) => ({ ...i, dayNum: sec.dayNum })));
  }

  out.sort((a, b) => a.whenMs - b.whenMs);
  return out;
}

function extractPeriodItems(dayText = "", baseDate = null, periodTimes = null) {
  const cfg = periodTimes || { morning: "09:00", afternoon: "14:00", evening: "19:00" };
  const out = [];

  const lines = String(dayText || "").split("\n");
  for (const rawLine of lines) {
    const line = String(rawLine || "").trim();
    if (!line) continue;

    const m = line.match(/^\s*(Morning|Afternoon|Evening)\b\s*[:\-–]?\s*(.*)$/i);
    if (!m) continue;

    const period = String(m[1] || "").toLowerCase();
    const rest = String(m[2] || "").trim();

    const hhmm =
      cfg?.[period] || (period === "morning" ? "09:00" : period === "afternoon" ? "14:00" : "19:00");

    const whenMs = parseTimeOnDateMs(hhmm, baseDate);
    if (!whenMs) continue;

    out.push({
      whenMs,
      timeLabel: `${period[0].toUpperCase()}${period.slice(1)}`,
      endLabel: null,
      label: rest || `${period[0].toUpperCase()}${period.slice(1)} plan`,
      period,
    });
  }

  out.sort((a, b) => a.whenMs - b.whenMs);
  return out;
}

export function extractPeriodItemsByDay(text = "", tripStartISO = null, periodTimes = null) {
  const src = String(text || "");
  const base = tripStartISO ? parseISODateToLocalMidnight(tripStartISO) : null;
  if (!base) return extractPeriodItems(src, null, periodTimes);

  const lines = src.split("\n");
  const sections = [];
  let current = { dayNum: 1, lines: [] };

  for (const line of lines) {
    const m = line.match(/^\s*(?:#{1,6}\s*)?Day\s*(\d+)\b/i);
    if (m) {
      if (current.lines.length) sections.push(current);
      current = { dayNum: Math.max(1, Number(m[1] || 1)), lines: [] };
      continue;
    }
    current.lines.push(line);
  }
  if (current.lines.length) sections.push(current);

  if (!sections.length) sections.push({ dayNum: 1, lines });

  const out = [];
  for (const sec of sections) {
    const dayIndex = Math.max(0, (sec.dayNum || 1) - 1);
    const dayDate = addDays(base, dayIndex);
    const dayText = sec.lines.join("\n");
    const items = extractPeriodItems(dayText, dayDate, periodTimes);
    out.push(...items.map((i) => ({ ...i, dayNum: sec.dayNum })));
  }

  out.sort((a, b) => a.whenMs - b.whenMs);
  return out;
}

function normalizeNotificationDoc(id, data) {
  const d = data || {};
  const whenMs = d.scheduledDateTimeMs ?? d.whenMs ?? d.createdAtMs ?? null;

  const itineraryId = d.itineraryId || d.sourceItineraryId || d.itineraryID || null;
  const itineraryTitle = d.itineraryTitle || d.title || null;
  const body = d.body || d.label || d.message || "";

  return {
    id,
    sourceItineraryId: itineraryId || "__unknown",
    itineraryId: itineraryId || "__unknown",
    title: itineraryTitle || "Reminder",
    body,
    label: d.label || "",
    type: d.type || "time-based",
    whenMs: d.whenMs ?? whenMs ?? null,
    scheduledDateTimeMs: d.scheduledDateTimeMs ?? whenMs ?? null,
    timeLabel: d.timeLabel || null,
    endLabel: d.endLabel || null,
    dayNum: typeof d.dayNum === "number" ? d.dayNum : null,

    read: !!d.read,
    done: !!d.done,
    deleted: !!d.deleted,

    createdAtMs: d.createdAtMs ?? null,
    readAtMs: d.readAtMs ?? null,
    doneAtMs: d.doneAtMs ?? null,
    deletedAtMs: d.deletedAtMs ?? null,
  };
}

function hashShort(str) {
  let h = 2166136261;
  const s = String(str || "");
  for (let i = 0; i < s.length; i += 1) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return (h >>> 0).toString(36).slice(0, 6);
}

function buildNotificationId(itineraryId, whenMs, label) {
  const base = `${itineraryId || "it"}_${whenMs || 0}_${hashShort(label)}`;
  return base.slice(0, 120);
}

function isDueNow(n, now) {
  const when = n?.scheduledDateTimeMs ?? n?.whenMs ?? null;
  if (typeof when !== "number") return false;
  return when <= now + DUE_LEAD_MS && when >= now - OVERDUE_KEEP_MS;
}

const NotificationsContext = createContext(null);

export function NotificationsProvider({ children }) {
  const { user } = useAuth();

  const [settings, setSettings] = useState(() =>
    loadJson(LS_KEY, {
      enabled: true,
      leaveNow: true,
      weather: true,
      timezone: false,
      periodTimes: { morning: "09:00", afternoon: "14:00", evening: "19:00" },
      browserPushEnabled: false,
    })
  );

  const [scheduled, setScheduled] = useState(() => loadJson(LS_SCHEDULED, []));
  const [feed, setFeed] = useState(() => loadJson(LS_FEED, []));
  const [sources, setSources] = useState(() => loadJson(LS_SOURCES, []));
  const timersRef = useRef([]);

  const alertedRef = useRef(new Set());

  useEffect(() => {
    saveJson(LS_KEY, settings);
  }, [settings]);

  useEffect(() => {
    if (user) return;
    saveJson(LS_SCHEDULED, scheduled);
  }, [scheduled, user]);

  useEffect(() => {
    if (user) return;
    saveJson(LS_FEED, feed);
  }, [feed, user]);

  useEffect(() => {
    if (user) return;
    saveJson(LS_SOURCES, sources);
  }, [sources, user]);

  useEffect(() => {
    if (!user) return;

    const sourcesRef = collection(db, "users", user.uid, "reminderSources");
    const qSources = query(sourcesRef, orderBy("updatedAtMs", "desc"), limit(200));
    const unsubSources = onSnapshot(
      qSources,
      (snap) => {
        // Only show enabled sources in the UI.
        const list = snap.docs
          .map((d) => ({ id: d.id, ...d.data() }))
          .filter((s) => s?.enabled !== false);
        setSources(list);
      },
      () => {}
    );

    const notifRef = collection(db, "users", user.uid, "notifications");
    const qFeed = query(notifRef, orderBy("createdAtMs", "desc"), limit(600));
    const unsubFeed = onSnapshot(
      qFeed,
      (snap) => {
        const list = snap.docs.map((d) => normalizeNotificationDoc(d.id, d.data()));
        setFeed(list);
      },
      () => {}
    );

    return () => {
      unsubSources?.();
      unsubFeed?.();
    };
  }, [user]);

  function clearTimers() {
    timersRef.current.forEach((t) => clearTimeout(t));
    timersRef.current = [];
  }

  useEffect(() => {
    if (user) return;
    clearTimers();
    if (!settings.enabled) return;

    const upcoming = (scheduled || []).filter((q) => q.type === "time-based" && q.whenMs > nowMs());
    for (const it of upcoming) {
      const delay = Math.max(0, it.whenMs - nowMs());
      const t = setTimeout(() => {
        setFeed((prev) => [
          normalizeNotificationDoc(`${it.id || "n"}-${it.whenMs}`, {
            itineraryId: it.itineraryId || "__unknown",
            itineraryTitle: it.itineraryTitle || "Itinerary",
            label: it.label || "",
            type: it.type || "time-based",
            whenMs: it.whenMs,
            scheduledDateTimeMs: it.scheduledDateTimeMs ?? it.whenMs,
            timeLabel: it.timeLabel || null,
            endLabel: it.endLabel || null,
            createdAtMs: Date.now(),
            updatedAtMs: Date.now(),
            read: false,
            done: false,
            deleted: false,
          }),
          ...(prev || []),
        ]);
      }, delay);
      timersRef.current.push(t);
    }
  }, [scheduled, settings.enabled, user]);

  useEffect(() => {
    if (!settings.enabled) return;

    const tick = () => {
      const now = Date.now();
      if (typeof Notification === "undefined" || Notification.permission !== "granted") return;

      const list = Array.isArray(feed) ? feed : [];
      for (const n of list) {
        if (!n || n.deleted || n.done) continue;
        if (n.read) continue;
        if (!isDueNow(n, now)) continue;

        if (alertedRef.current.has(n.id)) continue;
        alertedRef.current.add(n.id);

        try {
          const title = n.title || "TravelMate reminder";
          const body = n.body || n.label || "Reminder due now";
          new Notification(title, { body });
        } catch {}
      }
    };

    tick();
    const t = setInterval(tick, FOREGROUND_TICK_MS);

    const onVis = () => {
      if (document.visibilityState === "visible") tick();
    };
    window.addEventListener("focus", onVis);
    document.addEventListener("visibilitychange", onVis);

    return () => {
      clearInterval(t);
      window.removeEventListener("focus", onVis);
      document.removeEventListener("visibilitychange", onVis);
    };
  }, [feed, settings.enabled]);

  async function writeNotificationsForItinerary({
    uid,
    sourceItineraryId,
    sourceTitle,
    itineraryText,
    tripStartISO,
    tripEndISO,
    daysLabel,
  }) {
    const startBase = parseISODateToLocalMidnight(tripStartISO);
    const endBase = parseISODateToLocalMidnight(tripEndISO);
    if (!startBase || !endBase) return { ok: false, reason: "bad-dates" };

    const timed = extractTimedItemsByDay(itineraryText, tripStartISO);
    const mode = timed.length ? "time-based" : "time-slot";
    const items = timed.length ? timed : extractPeriodItemsByDay(itineraryText, tripStartISO, settings?.periodTimes);

    const now = Date.now();
    const windowEnd = addDays(new Date(), GENERATE_WINDOW_DAYS).getTime();
    const tripEndMs = endBase.getTime() + 24 * 60 * 60 * 1000 - 1;
    const maxMs = Math.min(windowEnd, tripEndMs);

    const filtered = items
      .filter((i) => typeof i.whenMs === "number")
      .filter((i) => i.whenMs >= now - 2 * 60 * 1000)
      .filter((i) => i.whenMs <= maxMs)
      .slice(0, MAX_NOTIFS_PER_ENABLE);

    const notifCol = collection(db, "users", uid, "notifications");
    const createdAtMs = Date.now();

    const chunks = [];
    for (let i = 0; i < filtered.length; i += 450) chunks.push(filtered.slice(i, i + 450));

    for (const chunk of chunks) {
      const batch = writeBatch(db);
      for (const it of chunk) {
        const id = buildNotificationId(sourceItineraryId, it.whenMs, it.label);
        const ref = doc(notifCol, id);

        batch.set(
          ref,
          {
            itineraryId: sourceItineraryId,
            sourceItineraryId,
            itineraryTitle: sourceTitle || "Itinerary",
            title: sourceTitle || "Itinerary",
            daysLabel: daysLabel || null,

            label: it.label || "",
            body: it.label || "",
            type: mode,

            whenMs: it.whenMs,
            scheduledDateTimeMs: it.whenMs,
            timeLabel: it.timeLabel || null,
            endLabel: it.endLabel || null,
            dayNum: typeof it.dayNum === "number" ? it.dayNum : null,

            read: false,
            done: false,
            deleted: false,

            createdAtMs,
            updatedAtMs: Date.now(),
            createdAt: serverTimestamp(),
            updatedAt: serverTimestamp(),
          },
          { merge: true }
        );
      }
      await batch.commit();
    }

    return { ok: true, count: filtered.length };
  }

  // ✅ Soft-delete all notifications for an itinerary (rules allow update, but not delete)
  async function softDeleteNotificationsForItinerary(uid, sourceItineraryId) {
    const notifCol = collection(db, "users", uid, "notifications");
    const q = query(notifCol, where("sourceItineraryId", "==", sourceItineraryId), limit(600));
    const snap = await getDocs(q);

    if (snap.empty) return { ok: true, updated: 0 };

    const now = Date.now();
    const chunks = [];
    const docs = snap.docs;

    for (let i = 0; i < docs.length; i += 450) chunks.push(docs.slice(i, i + 450));

    let updated = 0;

    for (const chunk of chunks) {
      const batch = writeBatch(db);
      chunk.forEach((d) => {
        batch.update(d.ref, { deleted: true, deletedAtMs: now, updatedAtMs: now });
      });
      await batch.commit();
      updated += chunk.length;
    }

    return { ok: true, updated };
  }

  const value = useMemo(() => {
    return {
      settings,
      setSettings,
      scheduled,
      feed,
      sources,

      savePushToken: async (token) => {
  if (!user) return { ok: false, reason: "not-signed-in" };
  
  // Handle both string token and object with original/clean
  const originalToken = typeof token === 'string' ? token : token?.original || token;
  const cleanId = typeof token === 'string' 
    ? token.replace(/:/g, '_').replace(/\./g, '_')
    : (token?.clean || token.replace(/:/g, '_').replace(/\./g, '_'));
  
  if (!originalToken) return { ok: false, reason: "missing-token" };
  
  try {
    await setDoc(
      doc(db, "users", user.uid, "pushTokens", cleanId),
      { 
        token: originalToken,
        originalToken: originalToken,
        cleanId: cleanId,
        updatedAtMs: Date.now(), 
        updatedAt: serverTimestamp() 
      },
      { merge: true }
    );
    return { ok: true };
  } catch (error) {
    console.error("Failed to save push token:", error);
    return { ok: false, reason: "firestore-write-failed", error: String(error) };
  }
},

      markRead: async (id) => {
        if (!id) return;
        if (user) {
          await updateDoc(doc(db, "users", user.uid, "notifications", id), {
            read: true,
            readAtMs: Date.now(),
            updatedAtMs: Date.now(),
          });
          return;
        }
        setFeed((prev) => (prev || []).map((n) => (n.id === id ? { ...n, read: true, readAtMs: Date.now() } : n)));
      },

      markDone: async (id) => {
        if (!id) return;
        if (user) {
          await updateDoc(doc(db, "users", user.uid, "notifications", id), {
            done: true,
            doneAtMs: Date.now(),
            updatedAtMs: Date.now(),
          });
          return;
        }
        setFeed((prev) => (prev || []).map((n) => (n.id === id ? { ...n, done: true, doneAtMs: Date.now() } : n)));
      },

      deleteFeedItem: async (id) => {
        if (!id) return;
        if (user) {
          await updateDoc(doc(db, "users", user.uid, "notifications", id), {
            deleted: true,
            deletedAtMs: Date.now(),
            updatedAtMs: Date.now(),
          });
          return;
        }
        setFeed((prev) => (prev || []).filter((n) => n.id !== id));
      },

      deleteNotification: async (id) => {
        if (!id) return;
        if (user) {
          await updateDoc(doc(db, "users", user.uid, "notifications", id), {
            deleted: true,
            deletedAtMs: Date.now(),
            updatedAtMs: Date.now(),
          });
          return;
        }
        setFeed((prev) => (prev || []).filter((n) => n.id !== id));
      },

      enableItineraryReminders: async ({
  itineraryText,
  tripStartISO = null,
  tripEndISO = null,
  sourceItineraryId,
  sourceTitle,
  daysLabel = null,
}) => {
  if (!tripStartISO || !tripEndISO) return { ok: false, reason: "missing-dates" };
  if (!sourceItineraryId) return { ok: false, reason: "missing-itinerary-id" };
  if (isPastTrip(tripEndISO)) return { ok: false, reason: "past-date" };

  // ✅ SIGNED-IN MODE:
  // Only write reminderSources from the client.
  // Do NOT create users/{uid}/notifications from the client (rules are strict and will reject).
  // Cloud Function reminderWorker will create notifications when due.
  if (user) {
    try {
      await setDoc(
        doc(db, "users", user.uid, "reminderSources", sourceItineraryId),
        {
          itineraryId: sourceItineraryId,
          title: sourceTitle || "Itinerary",
          daysLabel: daysLabel || null,

          tripStartISO,
          tripEndISO,
          itineraryText: String(itineraryText || ""),
          periodTimes: settings?.periodTimes || { morning: "09:00", afternoon: "14:00", evening: "19:00" },

          tzOffsetMinutes: new Date().getTimezoneOffset(),
          tzName: Intl.DateTimeFormat().resolvedOptions().timeZone || null,

          enabled: true,

          // Clear any previous disable markers (if user re-enabled).
          disabledAtMs: null,
          disabledAt: null,

          enabledAtMs: Date.now(),
          updatedAtMs: Date.now(),
          enabledAt: serverTimestamp(),
          updatedAt: serverTimestamp(),
        },
        { merge: true }
      );

      return { ok: true, mode: "server" };
    } catch (e) {
      // Prevent "Uncaught (in promise)" and give a useful reason to the caller.
      return {
        ok: false,
        reason: "firestore-write-failed",
        error: String(e?.message || e),
      };
    }
  }

        // Logged-out mode
        const timed = extractTimedItemsByDay(itineraryText, tripStartISO);
        const mode = timed.length ? "time-based" : "time-slot";
        const items = timed.length ? timed : extractPeriodItemsByDay(itineraryText, tripStartISO, settings?.periodTimes);

        const payload = items.map((i) => {
          const baseId = `${sourceItineraryId || "it"}-${i.whenMs}-${i.label}`;
          const dayISO = localDateISOFromMs(i.whenMs);

          return {
            id: baseId.slice(0, 200),
            type: mode,
            whenMs: i.whenMs,
            scheduledDateTimeMs: i.whenMs,
            timeLabel: i.timeLabel || null,
            endLabel: i.endLabel || null,
            label: i.label || "",
            dayISO,
            itineraryId: sourceItineraryId,
            itineraryTitle: sourceTitle || "Itinerary",
          };
        });

        setSources((prev) => {
          const exists = (prev || []).some((p) => p.id === sourceItineraryId);
          if (exists) return prev || [];
          return [
            {
              id: sourceItineraryId,
              itineraryId: sourceItineraryId,
              title: sourceTitle || "Itinerary",
              tripStartISO,
              tripEndISO,
              enabledAtMs: Date.now(),
            },
            ...(prev || []),
          ];
        });

        setScheduled((prev) => {
          const map = new Map();
          (prev || []).forEach((x) => map.set(x.id, x));
          payload.forEach((x) => map.set(x.id, x));
          return Array.from(map.values()).sort((a, b) => a.whenMs - b.whenMs);
        });

        return { ok: true, mode: "local" };
      },

      // ✅ Disable reminders:
      // - soft-disable reminderSources doc (update/merge; avoids delete-rule mismatches)
      // - soft-delete notifications docs (update only; allowed)
      disableItineraryReminders: async (sourceItineraryId) => {
        if (!sourceItineraryId) return { ok: false };

        if (user) {
          await setDoc(
            doc(db, "users", user.uid, "reminderSources", sourceItineraryId),
            {
              enabled: false,
              disabledAtMs: Date.now(),
              updatedAtMs: Date.now(),
              disabledAt: serverTimestamp(),
              updatedAt: serverTimestamp(),
            },
            { merge: true }
          );
          await softDeleteNotificationsForItinerary(user.uid, sourceItineraryId);
          return { ok: true, mode: "server" };
        }

        setSources((prev) => (prev || []).filter((s) => String(s.id || s.itineraryId) !== String(sourceItineraryId)));
        setScheduled((prev) => (prev || []).filter((q) => String(q.itineraryId || "") !== String(sourceItineraryId)));
        return { ok: true, mode: "local" };
      },

      // Back-compat alias used by NotificationsPage
      removeItineraryReminders: async (sourceItineraryId) => {
        if (!sourceItineraryId) return { ok: false };
        if (user) {
          await setDoc(
            doc(db, "users", user.uid, "reminderSources", sourceItineraryId),
            {
              enabled: false,
              disabledAtMs: Date.now(),
              updatedAtMs: Date.now(),
              disabledAt: serverTimestamp(),
              updatedAt: serverTimestamp(),
            },
            { merge: true }
          );
          await softDeleteNotificationsForItinerary(user.uid, sourceItineraryId);
          return { ok: true, mode: "server" };
        }
        setSources((prev) => (prev || []).filter((s) => String(s.id || s.itineraryId) !== String(sourceItineraryId)));
        setScheduled((prev) => (prev || []).filter((q) => String(q.itineraryId || "") !== String(sourceItineraryId)));
        return { ok: true, mode: "local" };
      },

      markAllRead: async () => {
        if (user) {
          const notifRef = collection(db, "users", user.uid, "notifications");
          const qFeed = query(notifRef, orderBy("createdAtMs", "desc"), limit(600));
          const snap = await getDocs(qFeed);

          const batch = writeBatch(db);
          snap.docs.forEach((d) =>
            batch.update(d.ref, { read: true, readAtMs: Date.now(), updatedAtMs: Date.now() })
          );
          await batch.commit();
          return;
        }
        setFeed((prev) => (prev || []).map((n) => ({ ...n, read: true, readAtMs: Date.now() })));
      },
    };
  }, [feed, scheduled, settings, sources, user]);

  return <NotificationsContext.Provider value={value}>{children}</NotificationsContext.Provider>;
}

export function useNotifications() {
  return useContext(NotificationsContext);
}
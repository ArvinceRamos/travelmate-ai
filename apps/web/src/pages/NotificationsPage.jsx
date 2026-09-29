// apps/web/src/pages/NotificationsPage.jsx
import React, { useEffect, useMemo, useRef, useState } from "react";
import { useLocation, useNavigate } from "react-router-dom";
import Card from "../components/common/Card.jsx";
import {
  useNotifications,
  extractTimedItemsByDay,
  extractPeriodItemsByDay,
} from "../features/notifications/notificationsStore.jsx";
import { enableWebPush, getStoredFcmToken } from "../notifications/fcm.js";

const BANNER_KEY = "tm_notifications_banner_v4";
const BANNER_TTL_MS = 5 * 60 * 1000; // 5 minutes

const DUE_LEAD_MS = 60 * 1000;
const OVERDUE_KEEP_MS = 15 * 60 * 1000;

const NOW_TICK_MS = 15 * 1000; // 15 seconds

function safeLoadBanner() {
  try {
    const raw = sessionStorage.getItem(BANNER_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    if (!parsed?.createdAtMs) return null;
    if (Date.now() - parsed.createdAtMs > BANNER_TTL_MS) return null;
    return parsed;
  } catch {
    return null;
  }
}

function safeSaveBanner(banner) {
  try {
    sessionStorage.setItem(BANNER_KEY, JSON.stringify(banner));
  } catch {}
}

function safeClearBanner() {
  try {
    sessionStorage.removeItem(BANNER_KEY);
  } catch {}
}

function parseISODateMs(iso) {
  try {
    if (!iso) return null;
    const d = new Date(`${iso}T00:00:00`);
    const t = d.getTime();
    return Number.isNaN(t) ? null : t;
  } catch {
    return null;
  }
}

function formatRelative(ms, nowMs) {
  const diff = ms - nowMs;
  const abs = Math.abs(diff);
  const mins = Math.round(abs / 60000);

  if (mins < 1) return diff >= 0 ? "now" : "just now";
  if (mins < 60) return diff >= 0 ? `in ${mins}m` : `${mins}m ago`;
  const hrs = Math.round(mins / 60);
  if (hrs < 48) return diff >= 0 ? `in ${hrs}h` : `${hrs}h ago`;
  const days = Math.round(hrs / 24);
  return diff >= 0 ? `in ${days}d` : `${days}d ago`;
}

function isVisibleNow(n, nowMs) {
  if (!n || n.deleted) return false;
  if (n.done) return false;

  const when = n.scheduledDateTimeMs ?? n.whenMs ?? null;
  if (!when) return true;

  return when <= nowMs + DUE_LEAD_MS && when >= nowMs - OVERDUE_KEEP_MS;
}

function notifIcon(n) {
  const type = String(n?.type || "");
  if (type === "time-based") return "⏰";
  if (type === "time-slot") return "🕒";
  return "🔔";
}

function clamp(s, max = 120) {
  const t = String(s || "").trim();
  if (!t) return "";
  return t.length > max ? `${t.slice(0, max - 1)}…` : t;
}

function toUpcomingItemsFromSource(source, nowMs) {
  if (!source?.itineraryText || !source?.tripStartISO) return [];
  const text = String(source.itineraryText || "");
  const tripStartISO = String(source.tripStartISO || "");
  if (!text.trim() || !tripStartISO) return [];

  const timed = extractTimedItemsByDay(text, tripStartISO);
  const mode = timed.length ? "time-based" : "time-slot";
  const items = timed.length ? timed : extractPeriodItemsByDay(text, tripStartISO, source.periodTimes || null);

  const upcoming = items
    .map((i) => ({
      whenMs: i.whenMs,
      timeLabel: i.timeLabel || null,
      endLabel: i.endLabel || null,
      label: i.label || "",
      dayNum: i.dayNum || 1,
      type: mode,
    }))
    .filter((x) => typeof x.whenMs === "number" && x.whenMs > nowMs + DUE_LEAD_MS)
    .sort((a, b) => a.whenMs - b.whenMs)
    .slice(0, 12);

  return upcoming;
}

function onRowKeyActivate(e, fn) {
  if (e.key === "Enter" || e.key === " ") {
    e.preventDefault();
    fn?.();
  }
}

export default function NotificationsPage() {
  const location = useLocation();
  const nav = useNavigate();

  const {
    settings,
    setSettings,
    savePushToken,
    sources,
    feed,
    markRead,
    markDone,
    deleteFeedItem,
    removeItineraryReminders,
  } = useNotifications();

  const [banner, setBanner] = useState(() => safeLoadBanner());
  const [fcmToken, setFcmToken] = useState(() => getStoredFcmToken());

  const [activeItineraryId, setActiveItineraryId] = useState(null);

  const [hideRead, setHideRead] = useState(() => {
    try {
      return localStorage.getItem("tm_notifications_hideRead") === "true";
    } catch {
      return false;
    }
  });

  const [hideDone, setHideDone] = useState(() => {
    try {
      return localStorage.getItem("tm_notifications_hideDone") === "true";
    } catch {
      return false;
    }
  });

  useEffect(() => {
    try {
      localStorage.setItem("tm_notifications_hideRead", String(hideRead));
    } catch {}
  }, [hideRead]);

  useEffect(() => {
    try {
      localStorage.setItem("tm_notifications_hideDone", String(hideDone));
    } catch {}
  }, [hideDone]);

  const [menu, setMenu] = useState({ open: false, id: null, x: 0, y: 0 });
  const menuRef = useRef(null);

  const [sourceMenu, setSourceMenu] = useState({ open: false, itineraryId: null, x: 0, y: 0 });
  const sourceMenuRef = useRef(null);

  const [nowTick, setNowTick] = useState(Date.now());

  useEffect(() => {
    const t = setInterval(() => setNowTick(Date.now()), NOW_TICK_MS);

    function onVis() {
      if (document.visibilityState === "visible") setNowTick(Date.now());
    }
    window.addEventListener("focus", onVis);
    document.addEventListener("visibilitychange", onVis);

    return () => {
      clearInterval(t);
      window.removeEventListener("focus", onVis);
      document.removeEventListener("visibilitychange", onVis);
    };
  }, []);

  useEffect(() => {
    const st = location?.state;
    if (st && st.from === "itinerary") {
      const nextBanner = {
        createdAtMs: Date.now(),
        scheduledFor: st.scheduledFor || "Itinerary",
        itineraryId: st.itineraryId || null,
        permission: st.permission || null,
        blocked: !!st.blocked,
      };
      safeSaveBanner(nextBanner);
      setBanner(nextBanner);
      if (st.itineraryId) setActiveItineraryId(st.itineraryId);
    } else {
      const restored = safeLoadBanner();
      if (restored) setBanner(restored);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [location?.key]);

  useEffect(() => {
    function onDocDown(e) {
      if (menu.open) {
        const el = menuRef.current;
        if (!el || !el.contains(e.target)) setMenu({ open: false, id: null, x: 0, y: 0 });
      }
      if (sourceMenu.open) {
        const el2 = sourceMenuRef.current;
        if (!el2 || !el2.contains(e.target)) setSourceMenu({ open: false, itineraryId: null, x: 0, y: 0 });
      }
    }
    function onKey(e) {
      if (e.key === "Escape") {
        setMenu({ open: false, id: null, x: 0, y: 0 });
        setSourceMenu({ open: false, itineraryId: null, x: 0, y: 0 });
      }
    }
    document.addEventListener("mousedown", onDocDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDocDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [menu.open, sourceMenu.open]);

  const sortedSources = useMemo(() => {
    const list = Array.isArray(sources) ? [...sources] : [];
    list.sort((a, b) => {
      const aStart = parseISODateMs(a.tripStartISO) ?? Number.POSITIVE_INFINITY;
      const bStart = parseISODateMs(b.tripStartISO) ?? Number.POSITIVE_INFINITY;
      if (aStart !== bStart) return aStart - bStart;
      return (b.updatedAtMs ?? b.enabledAtMs ?? 0) - (a.updatedAtMs ?? a.enabledAtMs ?? 0);
    });
    return list;
  }, [sources]);

  useEffect(() => {
    if (activeItineraryId) return;
    if (sortedSources.length) setActiveItineraryId(sortedSources[0].itineraryId);
  }, [activeItineraryId, sortedSources]);

  const activeSource = useMemo(() => {
    if (!activeItineraryId) return null;
    return sortedSources.find((s) => s.itineraryId === activeItineraryId) || null;
  }, [sortedSources, activeItineraryId]);

  const scopedFeed = useMemo(() => {
    const list = Array.isArray(feed) ? feed : [];
    return activeItineraryId ? list.filter((n) => n.sourceItineraryId === activeItineraryId) : list;
  }, [feed, activeItineraryId]);

  const feedCountForActive = useMemo(() => scopedFeed.filter((n) => !n.deleted).length, [scopedFeed]);

  const dueNow = useMemo(() => {
    const list = scopedFeed
      .filter((n) => !n.deleted)
      .filter((n) => (hideDone ? !n.done : true))
      .filter((n) => (hideRead ? !n.read : true))
      .filter((n) => isVisibleNow(n, nowTick));

    list.sort((a, b) => {
      const aw = a.scheduledDateTimeMs ?? a.whenMs ?? a.createdAtMs ?? 0;
      const bw = b.scheduledDateTimeMs ?? b.whenMs ?? b.createdAtMs ?? 0;
      return bw - aw;
    });
    return list;
  }, [scopedFeed, hideDone, hideRead, nowTick]);

  const unreadDueCount = useMemo(() => dueNow.filter((n) => !n.read).length, [dueNow]);

  const upcoming = useMemo(
    () => (activeSource ? toUpcomingItemsFromSource(activeSource, nowTick) : []),
    [activeSource, nowTick]
  );

  const leftBadges = useMemo(() => {
    const map = new Map();
    const list = Array.isArray(feed) ? feed : [];
    for (const n of list) {
      if (!n || n.deleted || n.done) continue;
      if (!isVisibleNow(n, nowTick)) continue;
      if (n.read) continue;
      const k = n.sourceItineraryId || "__unknown";
      map.set(k, (map.get(k) || 0) + 1);
    }
    return map;
  }, [feed, nowTick]);

  async function onEnableBrowserNotif() {
    try {
      const out = await enableWebPush({
        debug: true,
        onToken: async (t) => {
          setFcmToken(t);
          try {
            await savePushToken?.(t);
          } catch {}
        },
      });

      try {
        setSettings?.({ ...settings, browserPushEnabled: out?.ok ? true : settings?.browserPushEnabled });
      } catch {}
    } catch {}
  }

  function dismissBanner() {
    safeClearBanner();
    setBanner(null);
  }

  function openNotifMenu(e, notifId) {
    e.preventDefault();
    e.stopPropagation();
    const rect = e.currentTarget.getBoundingClientRect();
    setMenu({ open: true, id: notifId, x: Math.round(rect.right), y: Math.round(rect.bottom + 6) });
  }

  function openSourceMenu(e, itineraryId) {
    e.preventDefault();
    e.stopPropagation();
    const rect = e.currentTarget.getBoundingClientRect();
    setSourceMenu({ open: true, itineraryId, x: Math.round(rect.right), y: Math.round(rect.bottom + 6) });
  }

  async function actRead(id) {
    try {
      await markRead(id);
    } catch {
    } finally {
      setMenu({ open: false, id: null, x: 0, y: 0 });
    }
  }

  async function actDone(id) {
    try {
      await markDone(id);
    } catch {
    } finally {
      setMenu({ open: false, id: null, x: 0, y: 0 });
    }
  }

  async function actDelete(id) {
    try {
      await deleteFeedItem(id);
    } catch {
    } finally {
      setMenu({ open: false, id: null, x: 0, y: 0 });
    }
  }

  async function disableReminders(itineraryId) {
    const id = itineraryId || activeItineraryId;
    if (!id) return;
    const ok = window.confirm("Disable reminders for this itinerary?");
    if (!ok) return;

    try {
      await removeItineraryReminders(id);
    } catch {
    } finally {
      setSourceMenu({ open: false, itineraryId: null, x: 0, y: 0 });
      if (activeItineraryId === id) {
        const next = sortedSources.find((s) => s.itineraryId !== id)?.itineraryId || null;
        setActiveItineraryId(next);
      }
    }
  }

  function goToItinerary(itineraryId) {
    setSourceMenu({ open: false, itineraryId: null, x: 0, y: 0 });
    nav("/itinerary", { state: { focusItineraryId: itineraryId || null } });
  }

  return (
    <div className="tm-notificationsPage tm-pageFull">
      <div className="tm-notificationsGrid tm-notificationsGrid--v3">
        <div className="tm-notifCol">
          <Card title="Reminders">
            <div className="tm-notifPane">
              {banner ? (
                <div className="tm-notifBanner" role="status">
                  <div className="tm-notifBanner__row">
                    <div className="tm-notifBanner__title">Reminders enabled for: {banner.scheduledFor}</div>
                    <button className="tm-notifBanner__x" type="button" onClick={dismissBanner} aria-label="Dismiss">
                      ×
                    </button>
                  </div>
                  {banner.blocked ? (
                    <div className="tm-notifBanner__sub">Browser notifications are blocked. You’ll still get in-app reminders.</div>
                  ) : banner.permission === "granted" ? (
                    <div className="tm-notifBanner__sub">Browser notifications are allowed for this site.</div>
                  ) : null}
                </div>
              ) : null}

              <div className="tm-notifHeaderRow">
                <button className="tm-miniBtn" type="button" onClick={onEnableBrowserNotif}>
                  Enable browser notifications
                </button>
                {fcmToken ? <span className="tm-notifDatePill">Push ready</span> : null}

                <button className="tm-miniBtn" type="button" onClick={() => nav("/itinerary")}>
                  Manage itineraries
                </button>

                <button className="tm-miniBtn" type="button" onClick={() => setNowTick(Date.now())}>
                  Refresh
                </button>
              </div>

              <div className="tm-notifPaneScroll tm-notifPaneScroll--left">
                {sortedSources.length === 0 ? (
                  <div className="muted">
                    No reminder-enabled itineraries yet. Go to <b>Saved Itinerary</b> and enable reminders.
                  </div>
                ) : (
                  <div className="tm-notifSourceList">
                    {sortedSources.map((s) => {
                      const isActive = s.itineraryId === activeItineraryId;
                      const badge = leftBadges.get(s.itineraryId) || 0;
                      const subtitle = s.tripStartISO && s.tripEndISO ? `${s.tripStartISO} → ${s.tripEndISO}` : "Reminders enabled";

                      return (
                        <div
                          key={s.itineraryId}
                          className={`tm-notifSourceItem ${isActive ? "tm-notifSourceItem--active" : ""}`}
                        >
                          <div
                            className={`tm-itineraryRow tm-notifSourceRow ${isActive ? "tm-itineraryRow--active" : ""}`}
                            role="button"
                            tabIndex={0}
                            onClick={() => setActiveItineraryId(s.itineraryId)}
                            onKeyDown={(e) => onRowKeyActivate(e, () => setActiveItineraryId(s.itineraryId))}
                          >
                            <div className="tm-notifSourceRow__top">
                              <div className="tm-itineraryRow__title tm-notifSourceRow__title">
                                {s.title || "Itinerary"}
                                {s.daysLabel ? <span className="tm-notifBullet">•</span> : null}
                                {s.daysLabel ? <span className="tm-notifDays">{s.daysLabel}</span> : null}
                              </div>

                              <div className="tm-notifSourceRow__right">
                                {badge ? <span className="tm-notifBadge">{badge}</span> : null}
                                <button
                                  className="tm-notifKebab tm-notifKebab--sm"
                                  type="button"
                                  aria-label="More"
                                  onClick={(e) => openSourceMenu(e, s.itineraryId)}
                                >
                                  ⋯
                                </button>
                              </div>
                            </div>

                            <div className="tm-itineraryRow__sub tm-notifSourceRow__sub">{subtitle}</div>
                          </div>
                        </div>
                      );
                    })}
                  </div>
                )}
              </div>
            </div>
          </Card>
        </div>

        <div className="tm-notifCol">
          <Card title="Notifications">
            {!activeItineraryId ? (
              <div className="muted">Select an itinerary on the left.</div>
            ) : (
              <div className="tm-notifPane">
                <div className="tm-notifRightTop">
                  <div className="tm-notifCounts">
                    <span className="tm-notifCountPill">{unreadDueCount} unread</span>
                    <span className="tm-notifCountPill tm-notifCountPill--muted">{dueNow.length} due now</span>
                  </div>

                  <div className="tm-notifRightActions">
                    <label className="tm-toggleRow tm-toggleRow--compact" title="Hide read notifications">
                      <input type="checkbox" checked={hideRead} onChange={(e) => setHideRead(e.target.checked)} />
                      <span>Hide read</span>
                    </label>
                    <label className="tm-toggleRow tm-toggleRow--compact" title="Hide completed notifications">
                      <input type="checkbox" checked={hideDone} onChange={(e) => setHideDone(e.target.checked)} />
                      <span>Hide done</span>
                    </label>
                  </div>
                </div>

                <div className="tm-notifPaneScroll tm-notifPaneScroll--right">
                  <div className="tm-notifSection">
                    <div className="tm-notifSection__head">
                      <div className="tm-notifSection__title">Due now</div>
                      <div className="tm-notifSection__hint">Shows when it’s time (early by ~1 min, stays for ~15 min).</div>
                    </div>

                    {dueNow.length === 0 ? (
                      <div className="muted" style={{ marginTop: 6 }}>
                        {feedCountForActive === 0 ? (
                          <>
                            No reminders generated yet for this itinerary.
                            <br />
                            If you just enabled reminders, wait a few seconds, or tap <b>Refresh</b>.
                          </>
                        ) : (
                          <>No reminders due yet.</>
                        )}
                      </div>
                    ) : (
                      <div className="tm-notifList" style={{ marginTop: 10 }}>
                        {dueNow.map((n) => {
                          const when = n.scheduledDateTimeMs ?? n.whenMs ?? n.createdAtMs ?? null;
                          const rel = when ? formatRelative(when, nowTick) : "";
                          const body = n.body || n.label || "";
                          const title = n.title || "Reminder";

                          return (
                            <div
                              key={n.id}
                              className={`tm-notifCard ${n.read ? "tm-notifCard--read" : "tm-notifCard--unread"}`}
                              onClick={async () => {
                                if (n.read) return;
                                try {
                                  await markRead(n.id);
                                } catch {}
                              }}
                              role="button"
                              tabIndex={0}
                            >
                              <div className="tm-notifCard__left">
                                <div className="tm-notifIcon" aria-hidden="true">
                                  {notifIcon(n)}
                                </div>
                                <div className="tm-notifMain">
                                  <div className="tm-notifTitleRow">
                                    <div className="tm-notifTitle">{clamp(title, 64)}</div>
                                    {rel ? <div className="tm-notifMeta">{rel}</div> : null}
                                  </div>
                                  <div className="tm-notifBody">{body}</div>
                                  {n.timeLabel ? (
                                    <div className="tm-notifSub">
                                      {n.timeLabel}
                                      {n.endLabel ? `–${n.endLabel}` : ""}
                                    </div>
                                  ) : null}
                                </div>
                              </div>

                              <button className="tm-notifKebab" type="button" onClick={(e) => openNotifMenu(e, n.id)}>
                                ⋯
                              </button>
                            </div>
                          );
                        })}
                      </div>
                    )}
                  </div>

                  <div className="tm-notifSection tm-notifSection--upcoming">
                    <div className="tm-notifSection__head">
                      <div className="tm-notifSection__title">Upcoming</div>
                      <div className="tm-notifSection__hint">Preview of next reminders.</div>
                    </div>

                    {upcoming.length === 0 ? (
                      <div className="muted" style={{ marginTop: 6 }}>
                        No upcoming items detected.
                      </div>
                    ) : (
                      <div className="tm-upcomingList">
                        {upcoming.map((u, idx) => {
                          const rel = typeof u.whenMs === "number" ? formatRelative(u.whenMs, nowTick) : "";
                          return (
                            <div key={`${u.whenMs}-${idx}`} className="tm-upcomingRow">
                              <div className="tm-upcomingRow__time">
                                <div className="tm-upcomingRow__when">{u.timeLabel || "Scheduled"}</div>
                                <div className="tm-upcomingRow__rel">{rel}</div>
                              </div>
                              <div className="tm-upcomingRow__label">{u.label || ""}</div>
                            </div>
                          );
                        })}
                      </div>
                    )}
                  </div>
                </div>
              </div>
            )}
          </Card>
        </div>
      </div>

      {menu.open ? (
        <div
          className="tm-notifMenu"
          ref={menuRef}
          style={{ left: menu.x, top: menu.y, position: "fixed", zIndex: 60 }}
        >
          <button className="tm-notifMenu__item" type="button" onClick={() => actRead(menu.id)}>
            Mark as read
          </button>
          <button className="tm-notifMenu__item" type="button" onClick={() => actDone(menu.id)}>
            Mark as done
          </button>
          <button className="tm-notifMenu__item tm-notifMenu__item--danger" type="button" onClick={() => actDelete(menu.id)}>
            Delete
          </button>
        </div>
      ) : null}

      {sourceMenu.open ? (
        <div
          className="tm-notifMenu"
          ref={sourceMenuRef}
          style={{ left: sourceMenu.x, top: sourceMenu.y, position: "fixed", zIndex: 60 }}
        >
          <button className="tm-notifMenu__item" type="button" onClick={() => goToItinerary(sourceMenu.itineraryId)}>
            View itinerary
          </button>
          <button
            className="tm-notifMenu__item tm-notifMenu__item--danger"
            type="button"
            onClick={() => disableReminders(sourceMenu.itineraryId)}
          >
            Disable reminders
          </button>
        </div>
      ) : null}
    </div>
  );
}
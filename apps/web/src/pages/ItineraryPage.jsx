import React, { useEffect, useMemo, useState } from "react";
import Card from "../components/common/Card.jsx";
import { useItinerary } from "../features/itinerary/itineraryStore";
import { useNotifications } from "../features/notifications/notificationsStore.jsx";
import { useNavigate } from "react-router-dom";
import { buildItineraryTitle, extractTripMetaFromText, titleLooksBad } from "../utils/tripMeta";

function parseItinerary(text) {
  if (!text) return { headerLines: [], days: [], appendixLines: [] };

  const lines = String(text).split(/\r?\n/);
  const headerLines = [];
  const days = [];
  const appendixLines = [];
  let currentDay = null;
  let inHeader = true;
  let inAppendix = false;

  const dayRe = /^Day\s+\d+\s*[—\-–].+$/i;
  const timeRe = /^(\d{1,2}:\d{2})\s*[-–]\s*(\d{1,2}:\d{2})\s+[-–]\s+(.+)$/;

  for (const raw of lines) {
    const line = raw.trim();
    if (!line) continue;
    if (/^Would you like to save this itinerary\??$/i.test(line)) continue;

    const appendixLine = line.replace(/^---\s*/, "").trim();
    const startsAppendix =
      /^---$/.test(line) ||
      /^#{0,3}\s*\*?\*?Estimated\s+Budget\s+Per\s+Person\*?\*?/i.test(appendixLine) ||
      /^\*?\*?Estimated\s+total\s*:/i.test(appendixLine);

    if (startsAppendix || inAppendix) {
      inHeader = false;
      inAppendix = true;
      if (appendixLine && !/^---$/.test(appendixLine)) appendixLines.push(appendixLine);
      continue;
    }

    if (dayRe.test(line)) {
      inHeader = false;
      currentDay = { title: line, activities: [] };
      days.push(currentDay);
      continue;
    }

    if (inHeader) {
      headerLines.push(line);
      continue;
    }

    const tm = line.match(timeRe);
    if (tm && currentDay) {
      const rest = tm[3];
      const sepIdx = rest.indexOf(" - ");
      const place = sepIdx > -1 ? rest.slice(0, sepIdx).trim() : rest.trim();
      const desc = sepIdx > -1 ? rest.slice(sepIdx + 3).trim() : "";
      currentDay.activities.push({ start: tm[1], end: tm[2], place, desc });
      continue;
    }

    if (currentDay && currentDay.activities.length > 0) {
      const last = currentDay.activities[currentDay.activities.length - 1];
      last.desc = last.desc ? `${last.desc} ${line}` : line;
    } else if (currentDay) {
      currentDay.activities.push({ start: "", end: "", place: "", desc: line });
    }
  }

  return { headerLines, days, appendixLines };
}

function parseAppendixLine(line) {
  const cleaned = String(line || "")
    .trim()
    .replace(/^#{1,3}\s*/, "")
    .replace(/^[-•]\s*/, "")
    .replace(/\*\*/g, "")
    .trim();

  if (!cleaned) return { type: "empty", text: "" };
  if (/^Estimated\s+Budget\s+Per\s+Person$/i.test(cleaned)) {
    return { type: "heading", text: "Estimated Budget Per Person" };
  }

  const totalMatch = cleaned.match(/^Estimated\s+total\s*:\s*(.+)$/i);
  if (totalMatch) return { type: "total", label: "Estimated total", value: totalMatch[1].trim() };

  const itemMatch = cleaned.match(/^([^:]+):\s*(.+)$/);
  if (itemMatch) return { type: "item", label: itemMatch[1].trim(), value: itemMatch[2].trim() };

  return { type: "text", text: cleaned };
}

let dayIdCounter = 0;
function makeDayId() {
  dayIdCounter += 1;
  return `day-${Date.now()}-${dayIdCounter}`;
}

function parseEditDraft(text) {
  const lines = String(text || "").split(/\r?\n/);
  let base = "";
  let style = "";
  let budget = "";
  const days = [];
  let currentDay = null;

  const dayRe = /^Day\s+\d+\s*[—\-–].+$/i;

  for (const raw of lines) {
    const line = raw.trim();

    if (dayRe.test(line)) {
      currentDay = { id: makeDayId(), title: line, body: "" };
      days.push(currentDay);
      continue;
    }

    if (currentDay) {
      currentDay.body = currentDay.body ? `${currentDay.body}\n${raw}` : raw;
      continue;
    }

    if (line) {
      const parts = line.split(/\s*•\s*/);
      for (const part of parts) {
        const m = part.match(/^([^:]+):\s*(.+)$/);
        if (m) {
          const key = m[1].trim().toLowerCase();
          const value = m[2].trim();
          if (key === "base") base = value;
          else if (key === "style") style = value;
          else if (key === "budget") budget = value;
        }
      }
    }
  }

  days.forEach((day) => {
    day.body = day.body.replace(/\s+$/g, "");
  });

  return { base, style, budget, days };
}

function serializeEditDraft(opts) {
  const out = [];

  if (opts.title) out.push(opts.title);

  if (opts.tripStart && opts.tripEnd) {
    out.push(`Trip dates: ${opts.tripStart} to ${opts.tripEnd}`);
  }

  const headerParts = [];
  if (opts.base) headerParts.push(`Base: ${opts.base}`);
  if (opts.style) headerParts.push(`Style: ${opts.style}`);
  if (opts.budget) headerParts.push(`Budget: ${opts.budget}`);
  if (headerParts.length) out.push(headerParts.join(" • "));

  for (const day of opts.days) {
    const title = day.title.trim();
    const body = day.body.trim();
    if (title) out.push(title);
    if (body) out.push(body);
  }

  return out.join("\n");
}

function ItineraryView({ text, done }) {
  const { headerLines, days, appendixLines } = useMemo(() => parseItinerary(text), [text]);


  if (!text || (!headerLines.length && !days.length)) {
    return <div className="muted tm-itineraryEmpty">No itinerary text yet.</div>;
  }

  return (
    <div className={`tm-itineraryView ${done ? "tm-itineraryView--done" : ""}`}>
      {headerLines.length > 0 ? (
        <div className="tm-itineraryHeaderBox">
          {headerLines.map((line, i) => {
            const parts = line.split(/\s*•\s*/);
            return (
              <div key={i} className="tm-itineraryHeaderBox__line">
                {parts.map((part, j) => {
                  const m = part.match(/^([^:]+):\s*(.+)$/);
                  return (
                    <span key={j} className="tm-itineraryChip">
                      {m ? (
                        <>
                          <span className="tm-itineraryChip__key">{m[1]}</span>
                          <span className="tm-itineraryChip__val">{m[2]}</span>
                        </>
                      ) : (
                        <span className="tm-itineraryChip__plain">{part}</span>
                      )}
                    </span>
                  );
                })}
              </div>
            );
          })}
        </div>
      ) : null}

      <div className="tm-itineraryDays">
        {days.map((day, i) => (
          <section key={i} className="tm-itineraryDay">
            <h3 className="tm-itineraryDay__title">{day.title}</h3>
            <ol className="tm-itineraryDay__list">
              {day.activities.map((act, j) => (
                <li key={j} className="tm-itineraryActivity">
                  {act.start || act.end ? (
                    <div className="tm-itineraryActivity__time">
                      <span>{act.start}</span>
                      {act.end ? <span className="tm-itineraryActivity__timeSep">–</span> : null}
                      <span>{act.end}</span>
                    </div>
                  ) : (
                    <div className="tm-itineraryActivity__time tm-itineraryActivity__time--empty" />
                  )}
                  <div className="tm-itineraryActivity__body">
                    {act.place ? <div className="tm-itineraryActivity__place">{act.place}</div> : null}
                    {act.desc ? <div className="tm-itineraryActivity__desc">{act.desc}</div> : null}
                  </div>
                </li>
              ))}
            </ol>
          </section>
        ))}
      </div>

      {appendixLines.length > 0 ? (
        <div className="tm-itineraryAppendix">
          {appendixLines.map((line, i) => {
            const parsed = parseAppendixLine(line);
            if (parsed.type === "heading") {
              return <h3 key={i} className="tm-itineraryAppendix__title">{parsed.text}</h3>;
            }
            if (parsed.type === "total") {
              return (
                <div key={i} className="tm-itineraryAppendix__total">
                  <span>{parsed.label}</span>
                  <strong>{parsed.value}</strong>
                </div>
              );
            }
            if (parsed.type === "item") {
              return (
                <div key={i} className="tm-itineraryAppendix__row">
                  <span>{parsed.label}</span>
                  <strong>{parsed.value}</strong>
                </div>
              );
            }
            return parsed.text ? <div key={i} className="tm-itineraryAppendix__text">{parsed.text}</div> : null;
          })}
        </div>
      ) : null}
    </div>
  );
}

function computeDaysLabel(tripStart, tripEnd) {
  try {
    if (!tripStart || !tripEnd) return null;
    const s = new Date(`${tripStart}T00:00:00`);
    const e = new Date(`${tripEnd}T00:00:00`);
    if (Number.isNaN(s.getTime()) || Number.isNaN(e.getTime())) return null;
    const diff = Math.round((e.getTime() - s.getTime()) / (24 * 60 * 60 * 1000));
    const days = Math.max(1, diff + 1);
    return `${days} day${days > 1 ? "s" : ""}`;
  } catch {
    return null;
  }
}

function getTodayISO() {
  const now = new Date();
  return [
    now.getFullYear(),
    String(now.getMonth() + 1).padStart(2, "0"),
    String(now.getDate()).padStart(2, "0"),
  ].join("-");
}

function isTripEnded(tripEnd) {
  if (!tripEnd) return false;
  return tripEnd < getTodayISO();
}

async function requestBrowserNotificationPermission() {
  if (typeof window === "undefined" || typeof Notification === "undefined") {
    return { ok: false, status: "unsupported" };
  }

  if (Notification.permission === "granted") return { ok: true, status: "granted" };
  if (Notification.permission === "denied") return { ok: false, status: "denied" };

  try {
    const p = await Notification.requestPermission();
    return { ok: p === "granted", status: p };
  } catch {
    return { ok: false, status: "error" };
  }
}

export default function ItineraryPage() {
  const { items, activeId, setActiveId, deleteItinerary, updateItinerary, toggleDone } = useItinerary();
  const { enableItineraryReminders } = useNotifications();
  const nav = useNavigate();

  const saved = Array.isArray(items) ? items : [];
  const effectiveActiveId = activeId || saved?.[0]?.id || null;

  const active = useMemo(() => {
    if (!saved.length) return null;
    return saved.find((x) => x.id === effectiveActiveId) || saved[0] || null;
  }, [saved, effectiveActiveId]);

  const activeTripEnded = useMemo(() => isTripEnded(active?.tripEnd), [active?.tripEnd]);

  const [editingId, setEditingId] = useState(null);
  const [draftTitle, setDraftTitle] = useState("");
  const [draftTripStart, setDraftTripStart] = useState("");
  const [draftTripEnd, setDraftTripEnd] = useState("");
  const [draftBase, setDraftBase] = useState("");
  const [draftTripStyle, setDraftTripStyle] = useState("");
  const [draftBudget, setDraftBudget] = useState("");
  const [draftDays, setDraftDays] = useState([]);
  const [savingEdit, setSavingEdit] = useState(false);
  const [draftError, setDraftError] = useState(null);
  const [remindersBusy, setRemindersBusy] = useState(false);
  const [feedback, setFeedback] = useState(null);
  const [confirmDeleteId, setConfirmDeleteId] = useState(null);
  const [confirmRemoveDayId, setConfirmRemoveDayId] = useState(null);

  useEffect(() => {
    let cancelled = false;

    async function fixMetaIfNeeded() {
      if (!active?.id) return;

      const text = String(active.text || "");
      if (!text.trim()) return;

      const inferred = extractTripMetaFromText(text);

      const nextTripStart = active.tripStart || inferred.startISO || null;
      const nextTripEnd = active.tripEnd || inferred.endISO || null;

      const nextTitle =
        !active.title || titleLooksBad(active.title)
          ? buildItineraryTitle({
              itineraryText: text,
              tripStartISO: nextTripStart,
              tripEndISO: nextTripEnd,
            }) || active.title || "Saved itinerary"
          : active.title;

      const needsUpdate =
        (nextTripStart && nextTripStart !== active.tripStart) ||
        (nextTripEnd && nextTripEnd !== active.tripEnd) ||
        (nextTitle && nextTitle !== active.title);

      if (!needsUpdate || cancelled) return;

      await updateItinerary(active.id, {
        ...(nextTitle ? { title: nextTitle } : {}),
        ...(nextTripStart ? { tripStart: nextTripStart } : {}),
        ...(nextTripEnd ? { tripEnd: nextTripEnd } : {}),
      });
    }

    fixMetaIfNeeded();

    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [active?.id]);

  function startEdit(it) {
    const parsed = parseEditDraft(it.text || "");

    setEditingId(it.id);
    setDraftTitle(it.title || "");
    setDraftTripStart(it.tripStart || "");
    setDraftTripEnd(it.tripEnd || "");
    setDraftBase(parsed.base);
    setDraftTripStyle(parsed.style);
    setDraftBudget(parsed.budget);
    setDraftDays(parsed.days);
    setSavingEdit(false);
    setDraftError(null);
    setConfirmDeleteId(null);
    setConfirmRemoveDayId(null);
    setFeedback(null);
  }

  function cancelEdit() {
    setEditingId(null);
    setDraftTitle("");
    setDraftTripStart("");
    setDraftTripEnd("");
    setDraftBase("");
    setDraftTripStyle("");
    setDraftBudget("");
    setDraftDays([]);
    setSavingEdit(false);
    setDraftError(null);
    setConfirmRemoveDayId(null);
  }

  async function saveEdit() {
    if (!editingId || savingEdit) return;

    const trimmedTitle = draftTitle.trim();
    const serialized = serializeEditDraft({
      title: trimmedTitle,
      tripStart: draftTripStart.trim(),
      tripEnd: draftTripEnd.trim(),
      base: draftBase.trim(),
      style: draftTripStyle.trim(),
      budget: draftBudget.trim(),
      days: draftDays,
    });

    if (!trimmedTitle) {
      setDraftError("Title is required.");
      return;
    }

    if (!serialized.trim()) {
      setDraftError("Itinerary details cannot be empty.");
      return;
    }

    setSavingEdit(true);
    setDraftError(null);

    try {
      await updateItinerary(editingId, {
        title: trimmedTitle,
        tripStart: draftTripStart.trim() || null,
        tripEnd: draftTripEnd.trim() || null,
        text: serialized,
      });

      setFeedback({ type: "success", message: "Itinerary updated." });
      cancelEdit();
    } catch (error) {
      setDraftError(error instanceof Error ? error.message : "Unable to save itinerary changes.");
    } finally {
      setSavingEdit(false);
    }
  }

  async function onEnableNotifications() {
    if (!active || remindersBusy) return;

    setRemindersBusy(true);
    setFeedback(null);

    try {
      let tripStart = active.tripStart || null;
      let tripEnd = active.tripEnd || null;

      if (!tripStart || !tripEnd) {
        const inferred = extractTripMetaFromText(active.text || "");
        tripStart = tripStart || inferred.startISO || null;
        tripEnd = tripEnd || inferred.endISO || null;

        if (tripStart && tripEnd) {
          await updateItinerary(active.id, { tripStart, tripEnd });
        }
      }

      if (!tripStart || !tripEnd) {
        setFeedback({
          type: "error",
          message: "Reminders require a trip date range. Add or keep clear trip dates in this itinerary first.",
        });
        return;
      }

      if (isTripEnded(tripEnd)) {
        setFeedback({
          type: "error",
          message: "This trip has already ended. Edit dates to enable reminders.",
        });
        return;
      }

      const perm = await requestBrowserNotificationPermission();
      const blocked = perm.status === "denied" || perm.status === "unsupported";

      const out = await enableItineraryReminders({
        itineraryText: active.text,
        tripStartISO: tripStart,
        tripEndISO: tripEnd,
        sourceItineraryId: active.id,
        sourceTitle: active.title || "Itinerary",
        daysLabel: computeDaysLabel(tripStart, tripEnd),
      });

      if (out?.ok === false && out?.reason === "past-date") {
        setFeedback({
          type: "error",
          message: "This trip has already ended. Edit dates to enable reminders.",
        });
        return;
      }

      if (out?.ok === false) {
        setFeedback({
          type: "error",
          message: "Could not enable reminders. Check that this itinerary has valid dates and clear time blocks.",
        });
        return;
      }

      nav("/notifications", {
        state: {
          from: "itinerary",
          itineraryId: active.id,
          scheduledFor: active.title || "Itinerary",
          permission: perm.status || null,
          blocked,
        },
      });
    } finally {
      setRemindersBusy(false);
    }
  }

  function onViewOnMap() {
    if (!active?.id) return;
    nav(`/map?itineraryId=${encodeURIComponent(active.id)}&day=all`, {
      state: { from: "itinerary", itineraryId: active.id },
    });
  }

  async function onConfirmDelete(it) {
    await deleteItinerary(it.id);
    setConfirmDeleteId(null);
    setFeedback({ type: "success", message: "Itinerary deleted." });
  }

  const actionHint = useMemo(() => {
    if (!active) return "";
    if (activeTripEnded) return "This trip has already ended. Edit dates to enable reminders.";
    if (!active.tripStart || !active.tripEnd) return "Reminders work best when this itinerary has clear trip dates.";
    return "Use View on Map to see stops and route flow for this itinerary.";
  }, [active, activeTripEnded]);

  return (
    <div className="tm-itineraryPage tm-pageFull">
      <div className="tm-itineraryCols">
        <div className="tm-itineraryList">
          <Card title="Saved Itineraries">
            <div className="tm-itineraryListContent">
              {saved.length === 0 ? (
                <div className="muted">No saved itineraries yet. Ask for an itinerary in Chat, then save it.</div>
              ) : (
                <div className="tm-itineraryItems">
                  {saved.map((it) => {
                    const isActive = it.id === effectiveActiveId;
                    const ended = isTripEnded(it.tripEnd);

                    return (
                      <button
                        key={it.id}
                        type="button"
                        className={`tm-itineraryRow ${isActive ? "tm-itineraryRow--active" : ""} ${
                          it.done ? "tm-itineraryRow--done" : ""
                        }`}
                        onClick={() => {
                          setActiveId(it.id);
                          setConfirmDeleteId(null);
                          setFeedback(null);
                        }}
                      >
                        <div className="tm-itineraryRow__top">
                          <div className={`tm-itineraryRow__title ${it.done ? "tm-itineraryRow__title--done" : ""}`}>
                            {it.title || "Saved itinerary"}
                          </div>
                          <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
                            {it.done ? <span className="tm-pill">Done</span> : null}
                            {ended ? <span className="tm-pill">Ended</span> : null}
                          </div>
                        </div>

                        <div className="tm-itineraryRow__sub">
                          {it.tripStart && it.tripEnd ? (
                            <div className="tm-itineraryRow__dates">
                              {it.tripStart} → {it.tripEnd}
                            </div>
                          ) : (
                            <div className="tm-itineraryRow__dates muted">No dates</div>
                          )}
                        </div>
                      </button>
                    );
                  })}
                </div>
              )}
            </div>
          </Card>
        </div>

        <div className="tm-itineraryDetail">
          <Card title={active ? active.title || "Itinerary" : "Itinerary"}>
            {!active ? (
              <div className="muted">Select an itinerary on the left.</div>
            ) : (
              <div className="tm-itineraryDetailContent">
                {feedback ? (
                  <div
                    className={`tm-mapNotice ${
                      feedback.type === "error"
                        ? "tm-mapNotice--error"
                        : feedback.type === "success"
                          ? "tm-mapNotice--success"
                          : ""
                    }`}
                  >
                    {feedback.message}
                  </div>
                ) : null}

                <div className="tm-itineraryActions">
                  <button
                    className="tm-miniBtn"
                    type="button"
                    onClick={onViewOnMap}
                    disabled={!active?.text}
                    title={!active?.text ? "No itinerary text" : "View stops on the map"}
                  >
                    View on Map
                  </button>

                  <button
                    className="tm-miniBtn"
                    type="button"
                    onClick={onEnableNotifications}
                    disabled={!active?.text || remindersBusy || activeTripEnded}
                    title={
                      activeTripEnded
                        ? "This trip has already ended. Edit dates to enable reminders."
                        : !active?.text
                          ? "No itinerary text"
                          : ""
                    }
                  >
                    {remindersBusy ? "Enabling…" : "Enable reminders"}
                  </button>

                  <button className="tm-miniBtn" type="button" onClick={() => startEdit(active)}>
                    Edit
                  </button>

                  <button className="tm-miniBtn" type="button" onClick={() => toggleDone(active.id)}>
                    {active.done ? "Mark not done" : "Mark done"}
                  </button>

                  <button
                    className={`tm-miniBtn tm-miniBtn--danger ${confirmDeleteId === active.id ? "is-active" : ""}`}
                    type="button"
                    onClick={() => setConfirmDeleteId((prev) => (prev === active.id ? null : active.id))}
                  >
                    {confirmDeleteId === active.id ? "Cancel delete" : "Delete"}
                  </button>
                </div>

                <div className="muted tm-itineraryHint">{actionHint}</div>

                {confirmDeleteId === active.id ? (
                  <div className="tm-mapNotice tm-mapNotice--error">
                    <div style={{ marginBottom: 8 }}>
                      Delete <strong>{active.title || "this itinerary"}</strong>? This cannot be undone.
                    </div>
                    <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
                      <button className="tm-miniBtn tm-miniBtn--danger" type="button" onClick={() => onConfirmDelete(active)}>
                        Confirm delete
                      </button>
                      <button className="tm-miniBtn" type="button" onClick={() => setConfirmDeleteId(null)}>
                        Keep itinerary
                      </button>
                    </div>
                  </div>
                ) : null}

                <div className="tm-itineraryDetailScroll">
                  {editingId === active.id ? (
                    <div className="tm-itineraryEditor">
                      {draftError ? <div className="tm-itineraryEditor__error">{draftError}</div> : null}

                      <label className="tm-field">
                        <div className="tm-field__label">Title</div>
                        <input
                          className="tm-textInput"
                          value={draftTitle}
                          onChange={(e) => setDraftTitle(e.target.value)}
                          placeholder="Itinerary title"
                          disabled={savingEdit}
                        />
                      </label>

                      <div className="tm-itineraryEditor__row">
                        <label className="tm-field">
                          <div className="tm-field__label">Start Date</div>
                          <input
                            className="tm-textInput"
                            value={draftTripStart}
                            onChange={(e) => setDraftTripStart(e.target.value)}
                            placeholder="YYYY-MM-DD"
                            disabled={savingEdit}
                          />
                        </label>

                        <label className="tm-field">
                          <div className="tm-field__label">End Date</div>
                          <input
                            className="tm-textInput"
                            value={draftTripEnd}
                            onChange={(e) => setDraftTripEnd(e.target.value)}
                            placeholder="YYYY-MM-DD"
                            disabled={savingEdit}
                          />
                        </label>
                      </div>

                      <div className="tm-field">
                        <div className="tm-field__label">Trip basics</div>
                        <div className="tm-itineraryEditor__tripBasics">
                          <label className="tm-field">
                            <div className="tm-field__subLabel">Base</div>
                            <input
                              className="tm-textInput"
                              value={draftBase}
                              onChange={(e) => setDraftBase(e.target.value)}
                              placeholder="e.g. Ermita"
                              disabled={savingEdit}
                            />
                          </label>

                          <label className="tm-field">
                            <div className="tm-field__subLabel">Style</div>
                            <input
                              className="tm-textInput"
                              value={draftTripStyle}
                              onChange={(e) => setDraftTripStyle(e.target.value)}
                              placeholder="e.g. time-based"
                              disabled={savingEdit}
                            />
                          </label>

                          <label className="tm-field">
                            <div className="tm-field__subLabel">Budget</div>
                            <input
                              className="tm-textInput"
                              value={draftBudget}
                              onChange={(e) => setDraftBudget(e.target.value)}
                              placeholder="e.g. mid-range"
                              disabled={savingEdit}
                            />
                          </label>
                        </div>
                      </div>

                      <div className="tm-itineraryEditor__daysHeader">
                        <div className="tm-field__label">Days</div>
                        <button
                          className="tm-editorAddDayBtn"
                          type="button"
                          onClick={() => {
                            const nextNumber = draftDays.length + 1;
                            setDraftDays((prev) => [
                              ...prev,
                              { id: makeDayId(), title: `Day ${nextNumber} — `, body: "" },
                            ]);
                            setConfirmRemoveDayId(null);
                          }}
                          disabled={savingEdit}
                        >
                          + Add day
                        </button>
                      </div>

                      {draftDays.length === 0 ? (
                        <div className="tm-editorDaysEmpty">
                          No days yet. Click "+ Add day" to start building this itinerary.
                        </div>
                      ) : (
                        <div className="tm-editorDaysList">
                          {draftDays.map((day, index) => (
                            <div key={day.id} className="tm-editorDayCard">
                              <div className="tm-editorDayCard__header">
                                <div className="tm-editorDayBar" />
                                <input
                                  className="tm-editorDayTitleInput"
                                  value={day.title}
                                  onChange={(e) => {
                                    const value = e.target.value;
                                    setDraftDays((prev) =>
                                      prev.map((item) => (item.id === day.id ? { ...item, title: value } : item))
                                    );
                                  }}
                                  placeholder={`Day ${index + 1} — `}
                                  disabled={savingEdit}
                                />
                                <button
                                  className="tm-editorRemoveDayBtn"
                                  type="button"
                                  onClick={() =>
                                    setConfirmRemoveDayId((prev) => (prev === day.id ? null : day.id))
                                  }
                                  disabled={savingEdit}
                                >
                                  Remove
                                </button>
                              </div>

                              {confirmRemoveDayId === day.id ? (
                                <div className="tm-editorDayConfirm">
                                  <div className="tm-editorDayConfirm__text">
                                    Are you sure you want to delete {day.title.trim() || `Day ${index + 1}`}?
                                  </div>
                                  <div className="tm-editorDayConfirm__actions">
                                    <button
                                      className="tm-miniBtn tm-miniBtn--danger"
                                      type="button"
                                      onClick={() => {
                                        setDraftDays((prev) => prev.filter((item) => item.id !== day.id));
                                        setConfirmRemoveDayId(null);
                                      }}
                                      disabled={savingEdit}
                                    >
                                      Delete day
                                    </button>
                                    <button
                                      className="tm-miniBtn"
                                      type="button"
                                      onClick={() => setConfirmRemoveDayId(null)}
                                      disabled={savingEdit}
                                    >
                                      Cancel
                                    </button>
                                  </div>
                                </div>
                              ) : null}

                              <textarea
                                className="tm-textArea tm-editorDayBodyInput"
                                value={day.body}
                                onChange={(e) => {
                                  const value = e.target.value;
                                  setDraftDays((prev) =>
                                    prev.map((item) => (item.id === day.id ? { ...item, body: value } : item))
                                  );
                                }}
                                placeholder="09:00-11:00 - Place name - Description..."
                                rows={5}
                                spellCheck={false}
                                disabled={savingEdit}
                              />
                            </div>
                          ))}
                        </div>
                      )}

                      <div className="tm-itineraryEditorActions">
                        <button className="tm-miniBtn" type="button" onClick={saveEdit} disabled={savingEdit}>
                          {savingEdit ? "Saving..." : "Save changes"}
                        </button>
                        <button className="tm-miniBtn" type="button" onClick={cancelEdit} disabled={savingEdit}>
                          Cancel
                        </button>
                      </div>
                    </div>
                  ) : (
                    <ItineraryView text={active.text || ""} done={active.done} />
                  )}
                </div>
              </div>
            )}
          </Card>
        </div>
      </div>
    </div>
  );
}

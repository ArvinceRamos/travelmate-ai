import React, { useEffect, useRef, useState } from "react";
import toast from "react-hot-toast";
import MessageBubble from "./MessageBubble.jsx";

function isNearBottom(el, threshold = 160) {
  const distance = el.scrollHeight - el.scrollTop - el.clientHeight;
  return distance < threshold;
}

function ThinkingBubble() {
  return (
    <div className="tm-msg tm-msg--assistant" aria-live="polite" aria-label="TravelMate AI is thinking">
      <div className="tm-msg__avatar">
        <img src="/assets/travelmate-logo.png" alt="TravelMate AI" className="tm-msg__avatar-img" />
      </div>

      <div className="tm-msg__body">
        <div className="tm-thinkingCard">
          <div className="tm-thinkingCard__top">
            <span className="tm-thinkingCard__badge">TravelMate AI</span>
            <span className="tm-thinkingCard__status">Thinking</span>
          </div>

          <div className="tm-thinkingCard__title">Thinking…</div>

          <div className="tm-thinkingCard__lines" aria-hidden="true">
            <span className="tm-thinkingCard__line tm-thinkingCard__line--lg" />
            <span className="tm-thinkingCard__line tm-thinkingCard__line--md" />
            <span className="tm-thinkingCard__line tm-thinkingCard__line--sm" />
          </div>
        </div>
      </div>
    </div>
  );
}

export default function MessageList({
  messages,
  busy = false,
  pendingItinerary,
  showItineraryActions = false,
  onSaveItinerary,
  onEditItinerary,
  onDismissItinerary,
  onReplaceConflict,
  onChangeDates,
  onSaveAsDraft,
  conflictInfo = null,
  itineraryBusy = false,
  canSave = true,
}) {
  const ref = useRef(null);
  const bottomRef = useRef(null);
  const [autoScroll, setAutoScroll] = useState(true);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;

    const onScroll = () => setAutoScroll(isNearBottom(el));
    el.addEventListener("scroll", onScroll, { passive: true });
    return () => el.removeEventListener("scroll", onScroll);
  }, []);

  useEffect(() => {
    if (autoScroll) bottomRef.current?.scrollIntoView({ behavior: "smooth", block: "end" });
  }, [messages.length, busy, autoScroll]);

  function requireAuth(message) {
    if (canSave) return true;
    toast.error(message || "Please sign in first.");
    return false;
  }

  return (
    <div className="tm-logWrap">
      <div ref={ref} className={`tm-log ${messages.length === 0 ? "tm-log--empty" : ""}`.trim()}>
        <div className="tm-logInner">
          {messages.map((m, i) => {
            const shouldShowActions =
              !!pendingItinerary?.text &&
              showItineraryActions &&
              m.role === "assistant" &&
              String(m.content || "").trim() === String(pendingItinerary.text || "").trim();

            const isConflictMessage = !!conflictInfo && m.role === "assistant" && i === messages.length - 1;

            const footer = shouldShowActions ? (
              <div className="tm-msgFooterCard">
                <div className="tm-itineraryInlineActions" role="group" aria-label="Itinerary actions">
                  <button
                    type="button"
                    className="tm-miniBtn tm-miniBtn--primary"
                    onClick={() => {
                      if (!requireAuth("Log in to save this itinerary.")) return;
                      onSaveItinerary?.();
                    }}
                    disabled={itineraryBusy}
                    title={canSave ? "Save this itinerary" : "Log in to save this itinerary"}
                  >
                    Save
                  </button>

                  <button
                    type="button"
                    className="tm-miniBtn"
                    onClick={() => {
                      onEditItinerary?.();
                    }}
                    disabled={itineraryBusy}
                    title="Edit this itinerary"
                  >
                    Edit
                  </button>

                  <button
                    type="button"
                    className="tm-miniBtn"
                    onClick={() => {
                      onDismissItinerary?.();
                    }}
                    disabled={itineraryBusy}
                    title="Dismiss"
                  >
                    Not now
                  </button>
                </div>
              </div>
            ) : isConflictMessage ? (
              <div className="tm-msgFooterCard">
                <div className="tm-itinFooterHint">Resolve the date conflict:</div>
                <div className="tm-itineraryInlineActions" role="group" aria-label="Conflict resolution">
                  <button
                    type="button"
                    className="tm-miniBtn tm-miniBtn--danger"
                    onClick={() => onReplaceConflict?.()}
                    disabled={itineraryBusy}
                    title={`Replace ${conflictInfo?.title || "conflicting itinerary"}`}
                  >
                    Replace it
                  </button>

                  <button
                    type="button"
                    className="tm-miniBtn"
                    onClick={() => onChangeDates?.()}
                    disabled={itineraryBusy}
                    title="Change dates and regenerate"
                  >
                    Change dates
                  </button>

                  <button
                    type="button"
                    className="tm-miniBtn"
                    onClick={() => onSaveAsDraft?.()}
                    disabled={itineraryBusy}
                    title="Save without dates as a draft"
                  >
                    Save as draft
                  </button>
                </div>
              </div>
            ) : null;

            return <MessageBubble key={i} role={m.role} content={m.content} footer={footer} />;
          })}

          {busy ? <ThinkingBubble /> : null}

          <div ref={bottomRef} />
        </div>
      </div>
    </div>
  );
}
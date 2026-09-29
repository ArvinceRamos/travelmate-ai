import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import MessageList from "./MessageList.jsx";
import VoiceInputButton from "./VoiceInputButton.jsx";
import VoiceMode from "./VoiceMode.jsx";
import { useComposerDraft } from "../../store/composerDraftContext.jsx";

function isSpeechSupported() {
  if (typeof window === "undefined") return false;
  return "webkitSpeechRecognition" in window || "SpeechRecognition" in window;
}

export default function ChatPanel({
  greeting,
  subtitle,
  suggestions = [],
  messages = [],
  busy = false,
  disabled = false,
  onSend,
  autoFocusKey,
  showLandingStyle = true,

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
  canSaveItinerary = true,
  showGuestAuthBar = false,
}) {
  const { draft, setDraft } = useComposerDraft();
  const taRef = useRef(null);
  const [voiceModeOpen, setVoiceModeOpen] = useState(false);
  const voiceBaseRef = useRef("");
  const draftRef = useRef("");

  useEffect(() => {
    taRef.current?.focus?.();
  }, [autoFocusKey]);

  useEffect(() => {
    draftRef.current = draft;
  }, [draft]);

  useEffect(() => {
    const el = taRef.current;
    if (!el) return;

    el.style.height = "0px";
    const scrollH = el.scrollHeight;
    const nextHeight = Math.min(scrollH, 180);
    el.style.height = `${Math.max(nextHeight, 28)}px`;
    el.style.overflowY = scrollH > 180 ? "auto" : "hidden";
  }, [draft]);

  const showLandingContent = showLandingStyle && messages.length === 0;
  const canSend = useMemo(() => !disabled && !busy && draft.trim().length > 0, [disabled, busy, draft]);
  const micSupported = useMemo(() => isSpeechSupported(), []);

  const handleSend = useCallback(async () => {
    const msg = draft.trim();
    if (!msg) return;
    setDraft("");
    await onSend?.(msg);
    taRef.current?.focus?.();
  }, [draft, onSend, setDraft]);

  function onKeyDown(e) {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      if (canSend) handleSend();
    }
  }

  function onPickSuggestion(prompt) {
    setDraft(prompt);
    taRef.current?.focus?.();
  }

  function onVoiceStart() {
    voiceBaseRef.current = (draftRef.current || "").trim();
  }

  function onVoiceInterim(text) {
    const interim = String(text || "").trim();
    const base = voiceBaseRef.current || "";
    if (!interim) {
      setDraft(base);
      return;
    }
    setDraft(base ? `${base} ${interim}` : interim);
  }

  function onVoiceText(text) {
    const finalText = String(text || "").trim();
    const base = voiceBaseRef.current || "";
    if (!finalText) {
      voiceBaseRef.current = "";
      return;
    }
    setDraft(base ? `${base} ${finalText}` : finalText);
    voiceBaseRef.current = "";
    taRef.current?.focus?.();
  }

  return (
    <div className="tm-chatPage">
      <div className="tm-chatSurface">
        <MessageList
          messages={messages}
          busy={busy}
          pendingItinerary={pendingItinerary}
          showItineraryActions={showItineraryActions}
          onSaveItinerary={onSaveItinerary}
          onEditItinerary={onEditItinerary}
          onDismissItinerary={onDismissItinerary}
          onReplaceConflict={onReplaceConflict}
          onChangeDates={onChangeDates}
          onSaveAsDraft={onSaveAsDraft}
          conflictInfo={conflictInfo}
          itineraryBusy={itineraryBusy}
          canSave={canSaveItinerary}
        />

        {showLandingContent && (
          <div className="tm-empty" aria-label="Starter prompts">
            <div className="tm-empty__title">{greeting}</div>
              <div className="tm-empty__subtitle">{subtitle}</div>

              <div className="tm-suggestionsGrid">
              {suggestions.map((s) => (
                <button
                  key={s.prompt}
                  className="tm-suggestionCard"
                  onClick={() => onPickSuggestion(s.prompt)}
                  type="button"
                  disabled={busy}
                >
                  <div className="tm-suggestionEmoji" aria-hidden>
                    {s.emoji}
                  </div>
                  <div className="tm-suggestionText">
                    <div className="tm-suggestionTitle">{s.title}</div>
                    <div className="tm-suggestionSubtitle">{s.subtitle}</div>
                  </div>
                </button>
              ))}
            </div>
          </div>
        )}

        <div className="tm-composer" aria-label="Message composer">
          <div className="tm-composerInner">
            <div className="tm-composer__row">
              <textarea
                ref={taRef}
                className="tm-input"
                value={draft}
                onChange={(e) => setDraft(e.target.value)}
                onKeyDown={onKeyDown}
                placeholder={disabled ? "Sign in to start chatting…" : "Ask a travel question…"}
                rows={1}
                disabled={disabled}
              />

              <div className="tm-actions">
                <VoiceInputButton
                  disabled={disabled || busy || !micSupported}
                  onStart={onVoiceStart}
                  onInterim={onVoiceInterim}
                  onText={onVoiceText}
                  onError={() => {}}
                />
                {draft.trim().length === 0 && micSupported ? (
                  <button
                    className="tm-waveBtn"
                    onClick={() => setVoiceModeOpen(true)}
                    disabled={disabled || busy}
                    type="button"
                    aria-label="Start voice mode"
                    title="Voice mode"
                  >
                    <svg viewBox="0 0 24 24" className="tm-waveIcon" aria-hidden="true" focusable="false">
                      <rect x="3" y="10" width="2" height="4" rx="1" fill="currentColor" />
                      <rect x="7" y="7" width="2" height="10" rx="1" fill="currentColor" />
                      <rect x="11" y="4" width="2" height="16" rx="1" fill="currentColor" />
                      <rect x="15" y="7" width="2" height="10" rx="1" fill="currentColor" />
                      <rect x="19" y="10" width="2" height="4" rx="1" fill="currentColor" />
                    </svg>
                  </button>
                ) : (
                  <button className="tm-sendBtn" onClick={handleSend} disabled={!canSend} type="button" aria-label="Send">
                    <span aria-hidden>➤</span>
                  </button>
                )}
              </div>
            </div>

            <div className="tm-disclaimer">TravelMate AI can make mistakes. Consider checking important information.</div>
          </div>
        </div>
      </div>

      <VoiceMode
        open={voiceModeOpen}
        messages={messages}
        busy={busy}
        onSend={onSend}
        onClose={() => setVoiceModeOpen(false)}
      />
    </div>
  );
}
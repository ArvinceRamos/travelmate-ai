import React, { useCallback, useEffect, useRef, useState } from "react";
import { useVoiceInput } from "../../hooks/useVoiceInput.js";

function getPreferredVoice() {
  if (typeof window === "undefined" || !("speechSynthesis" in window)) return null;
  const voices = window.speechSynthesis.getVoices() || [];
  if (!voices.length) return null;
  const byQuality = voices.find((v) => /natural|neural|online|enhanced/i.test(v.name));
  const byEnglish = voices.find((v) => /^en/i.test(v.lang));
  return byQuality || byEnglish || voices[0] || null;
}

function plainTextForSpeech(raw = "") {
  return String(raw || "")
    .replace(/<<<MAP_STOPS_JSON>>>[\s\S]*?<<<END_MAP_STOPS_JSON>>>/g, "")
    .replace(/```[\s\S]*?```/g, "")
    .replace(/`[^`]+`/g, "")
    .replace(/!\[[^\]]*\]\([^)]*\)/g, "")
    .replace(/\[([^\]]+)\]\([^)]*\)/g, "$1")
    .replace(/\*\*([^*]+)\*\*/g, "$1")
    .replace(/\*([^*]+)\*/g, "$1")
    .replace(/_([^_]+)_/g, "$1")
    .replace(/^#{1,6}\s+/gm, "")
    .replace(/[•▪●]/g, ", ")
    .replace(/\s+/g, " ")
    .trim();
}

function speakText(text, onEnd) {
  if (typeof window === "undefined" || !("speechSynthesis" in window)) {
    onEnd?.();
    return null;
  }
  try {
    window.speechSynthesis.cancel();
  } catch {}
  const u = new SpeechSynthesisUtterance(String(text || ""));
  const v = getPreferredVoice();
  if (v) u.voice = v;
  u.rate = 1.0;
  u.pitch = 1.0;
  u.onend = () => onEnd?.();
  u.onerror = () => onEnd?.();
  try {
    window.speechSynthesis.speak(u);
  } catch {
    onEnd?.();
  }
  return u;
}

const SILENCE_MS = 2500;

export default function VoiceMode({ open, messages = [], busy = false, onSend, onClose }) {
  const { supported, listening, interimText, start, stop } = useVoiceInput({
    lang: "en-PH",
    interim: true,
    continuous: true,
  });

  const [status, setStatus] = useState("idle");
  const [lastUser, setLastUser] = useState("");
  const [lastAssistant, setLastAssistant] = useState("");
  const [errorText, setErrorText] = useState("");

  const baselineIndexRef = useRef(-1);
  const mountedRef = useRef(false);
  const bufferRef = useRef("");
  const silenceTimerRef = useRef(null);
  const finalizingRef = useRef(false);

  useEffect(() => {
    if (!open) return;
    baselineIndexRef.current = messages.length - 1;
    mountedRef.current = true;
    try {
      window.speechSynthesis?.getVoices?.();
    } catch {}
    return () => {
      mountedRef.current = false;
    };
  }, [open]);

  useEffect(() => {
    if (open) return;
    try {
      stop();
    } catch {}
    try {
      window.speechSynthesis?.cancel?.();
    } catch {}
    if (silenceTimerRef.current) {
      clearTimeout(silenceTimerRef.current);
      silenceTimerRef.current = null;
    }
    bufferRef.current = "";
    finalizingRef.current = false;
    setStatus("idle");
    setErrorText("");
    setLastUser("");
    setLastAssistant("");
  }, [open, stop]);

  const clearSilenceTimer = useCallback(() => {
    if (silenceTimerRef.current) {
      clearTimeout(silenceTimerRef.current);
      silenceTimerRef.current = null;
    }
  }, []);

  const finalizeTurn = useCallback(async () => {
    clearSilenceTimer();
    const text = bufferRef.current.trim();
    bufferRef.current = "";
    if (!text) {
      setStatus("idle");
      return;
    }
    finalizingRef.current = true;
    setLastUser(text);
    setLastAssistant("");
    setStatus("thinking");
    try {
      stop();
    } catch {}
    try {
      await onSend?.(text);
    } catch {
      setErrorText("Something went wrong. Tap End to exit.");
      setStatus("idle");
    } finally {
      setTimeout(() => {
        finalizingRef.current = false;
      }, 250);
    }
  }, [clearSilenceTimer, stop, onSend]);

  const scheduleFinalize = useCallback(() => {
    clearSilenceTimer();
    silenceTimerRef.current = setTimeout(() => {
      finalizeTurn();
    }, SILENCE_MS);
  }, [clearSilenceTimer, finalizeTurn]);

  const beginListen = useCallback(() => {
    if (!supported) {
      setErrorText("Voice mode isn't supported in this browser. Try Chrome or Edge.");
      setStatus("idle");
      return;
    }
    setErrorText("");
    bufferRef.current = "";
    clearSilenceTimer();
    setStatus("listening");
    start({
      onInterimText: () => {
        clearSilenceTimer();
      },
      onFinalText: (text) => {
        const clean = String(text || "").trim();
        if (!clean) return;
        bufferRef.current = bufferRef.current ? `${bufferRef.current} ${clean}` : clean;
        scheduleFinalize();
      },
      onError: (m) => {
        if (finalizingRef.current) return;
        const s = String(m || "").toLowerCase();
        if (s.includes("no-speech") || s.includes("aborted")) {
          setStatus("idle");
          return;
        }
        setErrorText(m || "Voice input error.");
        setStatus("idle");
      },
    });
  }, [start, supported, clearSilenceTimer, scheduleFinalize]);

  useEffect(() => {
    if (!open) return;
    if (status !== "idle") return;
    if (busy) return;
    const t = setTimeout(() => {
      if (mountedRef.current && open && !busy) {
        beginListen();
      }
    }, 400);
    return () => clearTimeout(t);
  }, [open, status, busy, beginListen]);

  useEffect(() => {
    if (!open) return;
    if (status !== "thinking") return;
    if (busy) return;
    if (messages.length - 1 <= baselineIndexRef.current) return;

    let found = null;
    for (let i = messages.length - 1; i > baselineIndexRef.current; i -= 1) {
      const m = messages[i];
      if (m?.role === "assistant") {
        found = m;
        break;
      }
    }
    if (!found) return;

    const plain = plainTextForSpeech(found.content);
    baselineIndexRef.current = messages.length - 1;

    if (!plain) {
      setStatus("idle");
      return;
    }

    setLastAssistant(plain);
    setStatus("speaking");

    speakText(plain, () => {
      if (!mountedRef.current) return;
      setStatus("idle");
    });
  }, [messages, status, busy, open]);

  const handleEnd = useCallback(() => {
    if (silenceTimerRef.current) {
      clearTimeout(silenceTimerRef.current);
      silenceTimerRef.current = null;
    }
    bufferRef.current = "";
    try {
      stop();
    } catch {}
    try {
      window.speechSynthesis?.cancel?.();
    } catch {}
    setStatus("idle");
    onClose?.();
  }, [stop, onClose]);

  const handleTapCenter = useCallback(() => {
    if (status === "speaking") {
      try {
        window.speechSynthesis?.cancel?.();
      } catch {}
      setStatus("idle");
      return;
    }
    if (status === "listening") {
      finalizeTurn();
      return;
    }
    if (status === "idle" && !busy) {
      beginListen();
    }
  }, [status, busy, finalizeTurn, beginListen]);

  if (!open) return null;

  const statusLabel =
    status === "listening"
      ? "Listening… (tap to send)"
      : status === "thinking"
      ? "Thinking…"
      : status === "speaking"
      ? "Speaking… (tap to interrupt)"
      : busy
      ? "Please wait…"
      : "Tap to talk";

  return (
    <div className="tm-voiceMode" role="dialog" aria-modal="true" aria-label="TravelMate Voice">
      <div className="tm-voiceMode__header">
        <div className="tm-voiceMode__title">
          <span className="tm-voiceMode__brand">TravelMate</span>
          <span className="tm-voiceMode__sub">Voice</span>
        </div>
      </div>

      <div className="tm-voiceMode__body">
        {lastUser ? (
          <div className="tm-voiceMode__bubble tm-voiceMode__bubble--user">
            “{lastUser}”
          </div>
        ) : null}
        {lastAssistant ? (
          <div className="tm-voiceMode__bubble tm-voiceMode__bubble--assistant">
            {lastAssistant}
          </div>
        ) : null}
        {!lastUser && !lastAssistant ? (
          <div className="tm-voiceMode__hint">Say something to start…</div>
        ) : null}
        {interimText && status === "listening" ? (
          <div className="tm-voiceMode__interim">{interimText}</div>
        ) : null}
        {errorText ? (
          <div className="tm-voiceMode__error">{errorText}</div>
        ) : null}
      </div>

      <div className="tm-voiceMode__controls">
        <button
          type="button"
          className={`tm-voiceMode__orb tm-voiceMode__orb--${status}`}
          onClick={handleTapCenter}
          aria-label={statusLabel}
        >
          <span className="tm-voiceMode__orbInner">
            <span className="tm-voiceMode__bar" />
            <span className="tm-voiceMode__bar" />
            <span className="tm-voiceMode__bar" />
            <span className="tm-voiceMode__bar" />
            <span className="tm-voiceMode__bar" />
          </span>
        </button>
        <div className="tm-voiceMode__status" aria-live="polite">{statusLabel}</div>
        <button
          type="button"
          className="tm-voiceMode__end"
          onClick={handleEnd}
        >
          End
        </button>
      </div>
    </div>
  );
}
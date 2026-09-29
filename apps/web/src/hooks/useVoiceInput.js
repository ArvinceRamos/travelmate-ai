import { useCallback, useMemo, useRef, useState } from "react";

function getSpeechRecognitionCtor() {
  if (typeof window === "undefined") return null;
  return window.SpeechRecognition || window.webkitSpeechRecognition || null;
}

/**
 * Web Speech API (SpeechRecognition) wrapper.
 *
 * Notes:
 * - Works best in Chromium browsers (Chrome/Edge).
 * - Requires HTTPS (or localhost) and microphone permission.
 * - Speech-to-text only (no external API keys).
 */
export function useVoiceInput({ lang = "en-PH", interim = true, continuous = false } = {}) {
  const SR = useMemo(() => getSpeechRecognitionCtor(), []);
  const recRef = useRef(null);

  const [listening, setListening] = useState(false);
  const [interimText, setInterimText] = useState("");

  const supported = !!SR;

  const stop = useCallback(() => {
    try {
      recRef.current?.stop?.();
    } catch {
      // ignore
    }
  }, []);

  const start = useCallback(
    ({ onFinalText, onInterimText, onStart, onError } = {}) => {
      if (!SR) {
        onError?.("Voice input not supported in this browser.");
        return;
      }

      stop();

      const rec = new SR();
      recRef.current = rec;

      rec.lang = lang;
      rec.interimResults = !!interim;
      rec.continuous = !!continuous;
      rec.maxAlternatives = 1;

      setInterimText("");
      setListening(true);
      onStart?.();

      rec.onresult = (e) => {
        let finalText = "";
        let interimChunk = "";

        for (let i = e.resultIndex; i < e.results.length; i++) {
          const r = e.results[i];
          const t = (r?.[0]?.transcript || "").trim();
          if (!t) continue;
          if (r.isFinal) finalText += (finalText ? " " : "") + t;
          else interimChunk += (interimChunk ? " " : "") + t;
        }

        if (interim) setInterimText(interimChunk);
        if (interimChunk) onInterimText?.(interimChunk);
        if (finalText) {
          setInterimText("");
          onFinalText?.(finalText);
        }
      };

      rec.onerror = (evt) => {
        const msg = evt?.error ? `Voice input error: ${evt.error}` : "Voice input error";
        onError?.(msg);
        setListening(false);
        setInterimText("");
      };

      rec.onend = () => {
        setListening(false);
        setInterimText("");
      };

      try {
        rec.start();
      } catch (e) {
        onError?.(e?.message || "Could not start voice input");
        setListening(false);
        setInterimText("");
      }
    },
    [SR, interim, lang, stop]
  );

  return {
    supported,
    listening,
    interimText,
    start,
    stop
  };
}

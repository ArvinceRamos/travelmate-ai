import React from "react";
import { useVoiceInput } from "../../hooks/useVoiceInput.js";

function MicIcon() {
  return (
    <svg
      className="tm-micIcon"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
    >
      <rect x="9" y="4" width="6" height="10" rx="3" />
      <path d="M6 11a6 6 0 0 0 12 0" />
      <line x1="12" y1="17" x2="12" y2="20" />
      <line x1="9.5" y1="20" x2="14.5" y2="20" />
    </svg>
  );
}

export default function VoiceInputButton({ disabled = false, onText, onInterim, onStart, onError }) {
  const { supported, listening, start, stop } = useVoiceInput({
    lang: "en-PH",
    interim: true,
  });

  function onClick() {
    if (disabled) return;

    if (!supported) {
      onError?.("Voice input isn’t supported in this browser. Try Chrome/Edge.");
      return;
    }

    if (listening) {
      stop();
      return;
    }

    start({
      onStart: () => onStart?.(),
      onFinalText: (t) => onText?.(t),
      onInterimText: (t) => onInterim?.(t),
      onError: (m) => onError?.(m),
    });
  }

  const label = listening ? "Stop voice input" : "Start voice input";

  return (
    <button
      className={listening ? "tm-iconBtn tm-iconBtn--active" : "tm-iconBtn"}
      onClick={onClick}
      disabled={disabled}
      title={label}
      aria-label={label}
      type="button"
    >
      <MicIcon />
    </button>
  );
}
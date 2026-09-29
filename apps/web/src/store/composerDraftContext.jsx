import React, { createContext, useCallback, useContext, useMemo, useRef, useState } from "react";

const NEW_CHAT_KEY = "__new_chat__";

const ComposerDraftContext = createContext(null);

export function ComposerDraftProvider({ children }) {
  const [draftsByChatKey, setDraftsByChatKey] = useState({});
  const activeChatKeyRef = useRef(NEW_CHAT_KEY);
  const [activeChatKey, setActiveChatKey] = useState(NEW_CHAT_KEY);

  const draft = draftsByChatKey[activeChatKey] || "";

  const setDraft = useCallback((value) => {
    const key = activeChatKeyRef.current;
    setDraftsByChatKey((prev) => {
      const currentValue = prev[key] || "";
      const resolved = typeof value === "function" ? value(currentValue) : value;
      const normalized = String(resolved || "");
      if (!normalized && !prev[key]) return prev;
      const next = { ...prev };
      if (normalized) {
        next[key] = normalized;
      } else {
        delete next[key];
      }
      return next;
    });
  }, []);

  const setActiveChatId = useCallback((chatId) => {
    const key = chatId ? String(chatId) : NEW_CHAT_KEY;
    activeChatKeyRef.current = key;
    setActiveChatKey(key);
  }, []);

  const value = useMemo(
    () => ({ draft, setDraft, setActiveChatId }),
    [draft, setDraft, setActiveChatId]
  );

  return <ComposerDraftContext.Provider value={value}>{children}</ComposerDraftContext.Provider>;
}

export function useComposerDraft() {
  const ctx = useContext(ComposerDraftContext);
  if (!ctx) throw new Error("useComposerDraft must be used inside <ComposerDraftProvider>.");
  return ctx;
}

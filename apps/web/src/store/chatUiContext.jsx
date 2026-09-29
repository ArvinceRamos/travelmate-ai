import React, { createContext, useContext, useMemo, useState } from "react";

const ChatUiContext = createContext(null);

export function ChatUiProvider({ children }) {
  const [hasMessages, setHasMessages] = useState(false);

  const value = useMemo(() => ({ hasMessages, setHasMessages }), [hasMessages]);
  return <ChatUiContext.Provider value={value}>{children}</ChatUiContext.Provider>;
}

export function useChatUi() {
  const ctx = useContext(ChatUiContext);
  if (!ctx) throw new Error("useChatUi must be used inside <ChatUiProvider>.");
  return ctx;
}

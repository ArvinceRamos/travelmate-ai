import React, { createContext, useCallback, useContext, useMemo, useRef, useState } from "react";

const GUEST_CHAT_REQUEST_KEY = "__guest_chat_request__";

const ChatRequestContext = createContext(null);

export function getChatRequestKey(chatId) {
  const normalized = String(chatId || "").trim();
  return normalized || GUEST_CHAT_REQUEST_KEY;
}

export function isChatRequestActive(request) {
  return request?.status === "thinking" || request?.status === "streaming";
}

export function ChatRequestProvider({ children }) {
  const controllersRef = useRef({});
  const inFlightRef = useRef({});
  const [inFlightByChatId, setInFlightByChatId] = useState({});

  const writeInFlight = useCallback((producer) => {
    setInFlightByChatId((prev) => {
      const next = producer(prev);
      inFlightRef.current = next;
      return next;
    });
  }, []);

  const startChatRequest = useCallback(
    (chatId, { requestId, abortController, partialText = "" } = {}) => {
      const key = getChatRequestKey(chatId);
      const nextRequestId = requestId || `${Date.now()}_${Math.random().toString(36).slice(2, 10)}`;
      const previousController = controllersRef.current[key];
      if (previousController && !previousController.signal?.aborted) {
        previousController.abort();
      }
      if (abortController) controllersRef.current[key] = abortController;

      writeInFlight((prev) => ({
        ...prev,
        [key]: {
          status: "thinking",
          startedAt: Date.now(),
          partialText,
          requestId: nextRequestId,
        },
      }));

      return nextRequestId;
    },
    [writeInFlight]
  );

  const updateChatRequest = useCallback(
    (chatId, requestId, patch = {}) => {
      const key = getChatRequestKey(chatId);
      writeInFlight((prev) => {
        const current = prev[key];
        if (!current || current.requestId !== requestId) return prev;
        return {
          ...prev,
          [key]: {
            ...current,
            ...patch,
            updatedAt: Date.now(),
          },
        };
      });
    },
    [writeInFlight]
  );

  const completeChatRequest = useCallback(
    (chatId, requestId) => {
      const key = getChatRequestKey(chatId);
      const current = inFlightRef.current[key];
      if (!current || current.requestId !== requestId) return;
      delete controllersRef.current[key];
      writeInFlight((prev) => {
        const latest = prev[key];
        if (!latest || latest.requestId !== requestId) return prev;
        return {
          ...prev,
          [key]: {
            ...latest,
            status: "done",
            completedAt: Date.now(),
          },
        };
      });
    },
    [writeInFlight]
  );

  const failChatRequest = useCallback(
    (chatId, requestId, errorMessage = "") => {
      const key = getChatRequestKey(chatId);
      const current = inFlightRef.current[key];
      if (!current || current.requestId !== requestId) return;
      delete controllersRef.current[key];
      writeInFlight((prev) => {
        const latest = prev[key];
        if (!latest || latest.requestId !== requestId) return prev;
        return {
          ...prev,
          [key]: {
            ...latest,
            status: "error",
            errorMessage: String(errorMessage || ""),
            completedAt: Date.now(),
          },
        };
      });
    },
    [writeInFlight]
  );

  const cancelChatRequest = useCallback(
    (chatId) => {
      const key = getChatRequestKey(chatId);
      const controller = controllersRef.current[key];
      if (controller && !controller.signal?.aborted) controller.abort();
      delete controllersRef.current[key];
      writeInFlight((prev) => {
        if (!prev[key]) return prev;
        return {
          ...prev,
          [key]: {
            ...prev[key],
            status: "error",
            errorMessage: "cancelled",
            completedAt: Date.now(),
          },
        };
      });
    },
    [writeInFlight]
  );

  const value = useMemo(
    () => ({
      inFlightByChatId,
      startChatRequest,
      updateChatRequest,
      completeChatRequest,
      failChatRequest,
      cancelChatRequest,
    }),
    [
      inFlightByChatId,
      startChatRequest,
      updateChatRequest,
      completeChatRequest,
      failChatRequest,
      cancelChatRequest,
    ]
  );

  return <ChatRequestContext.Provider value={value}>{children}</ChatRequestContext.Provider>;
}

export function useChatRequests() {
  const ctx = useContext(ChatRequestContext);
  if (!ctx) throw new Error("useChatRequests must be used inside <ChatRequestProvider>.");
  return ctx;
}

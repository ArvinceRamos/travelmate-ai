import React, { Suspense, lazy, useEffect } from "react";
import { Routes, Route, Navigate, useLocation } from "react-router-dom";
import { Toaster } from "react-hot-toast";

import { ComposerDraftProvider } from "./store/composerDraftContext.jsx";
import { ChatRequestProvider } from "./store/chatRequestContext.jsx";
import { ChatUiProvider } from "./store/chatUiContext.jsx";
import { MapsProvider } from "./features/maps/mapsStore.jsx";
import { ItineraryProvider } from "./features/itinerary/itineraryStore.jsx";
import { NotificationsProvider } from "./features/notifications/notificationsStore.jsx";

import AppShell from "./components/layout/AppShell.jsx";
import Topbar from "./components/layout/Topbar.jsx";
import { useAuth } from "./hooks/useAuth";

import ChatPage from "./pages/ChatPage.jsx";

const loadMapPage = () => import("./pages/MapPage.jsx");
const loadItineraryPage = () => import("./pages/ItineraryPage.jsx");
const loadNotificationsPage = () => import("./pages/NotificationsPage.jsx");
const loadSettingsPage = () => import("./pages/SettingsPage.jsx");

const MapPage = lazy(loadMapPage);
const ItineraryPage = lazy(loadItineraryPage);
const NotificationsPage = lazy(loadNotificationsPage);
const SettingsPage = lazy(loadSettingsPage);
const LoggedOut = lazy(() => import("./pages/LoggedOut.jsx"));

function PageFallback() {
  return <div className="muted" style={{ padding: 24 }}>Loading…</div>;
}

function AppShellLayout({ children }) {
  return (
    <AppShell>
      <Suspense fallback={<PageFallback />}>{children}</Suspense>
    </AppShell>
  );
}

// Fetch the other pages once the first screen is idle so switching tabs doesn't wait on the network.
function usePrefetchPages() {
  useEffect(() => {
    const prefetch = () => {
      for (const load of [loadItineraryPage, loadMapPage, loadNotificationsPage, loadSettingsPage]) {
        load().catch(() => {});
      }
    };
    if ("requestIdleCallback" in window) {
      const id = window.requestIdleCallback(prefetch, { timeout: 4000 });
      return () => window.cancelIdleCallback(id);
    }
    const id = window.setTimeout(prefetch, 2000);
    return () => window.clearTimeout(id);
  }, []);
}

function ProtectedAppRoute({ children }) {
  const { user, loading } = useAuth();
  const location = useLocation();

  if (loading) {
    return null;
  }

  if (!user) {
    const next = `${location.pathname}${location.search || ""}`;
    return <Navigate to={`/chat?auth=login&next=${encodeURIComponent(next)}`} replace />;
  }

  return <AppShellLayout>{children}</AppShellLayout>;
}

function GuestChatLayout({ children }) {
  return (
    <div style={{ minHeight: "100dvh", height: "100dvh", display: "flex", flexDirection: "column", overflow: "hidden" }}>
      <Topbar sidebarOpen={false} onToggleSidebar={() => {}} />
      <div style={{ flex: 1, minHeight: 0, minWidth: 0, display: "flex", overflow: "hidden" }}>
        {children}
      </div>
    </div>
  );
}

function ChatRoute() {
  const { user, loading } = useAuth();

  if (loading) {
    return null;
  }

  if (!user) {
    return (
      <GuestChatLayout>
        <ChatPage />
      </GuestChatLayout>
    );
  }

  return (
    <AppShellLayout>
      <ChatPage />
    </AppShellLayout>
  );
}

export default function App() {
  usePrefetchPages();

  return (
    <ComposerDraftProvider>
      <ChatRequestProvider>
        <ChatUiProvider>
          <MapsProvider>
            <ItineraryProvider>
              <NotificationsProvider>
                <Toaster position="top-right" toastOptions={{ duration: 3500 }} />
                <Suspense fallback={null}>
                  <Routes>
                    <Route path="/logged-out" element={<LoggedOut />} />

                    <Route path="/chat" element={<ChatRoute />} />
                    <Route path="/chat/:chatId" element={<ChatRoute />} />

                    <Route
                      path="/map"
                      element={
                        <ProtectedAppRoute>
                          <MapPage />
                        </ProtectedAppRoute>
                      }
                    />

                    <Route
                      path="/itinerary"
                      element={
                        <ProtectedAppRoute>
                          <ItineraryPage />
                        </ProtectedAppRoute>
                      }
                    />

                    <Route
                      path="/notifications"
                      element={
                        <ProtectedAppRoute>
                          <NotificationsPage />
                        </ProtectedAppRoute>
                      }
                    />

                    <Route
                      path="/settings"
                      element={
                        <ProtectedAppRoute>
                          <SettingsPage />
                        </ProtectedAppRoute>
                      }
                    />

                    <Route path="*" element={<Navigate to="/chat" replace />} />
                  </Routes>
                </Suspense>
              </NotificationsProvider>
            </ItineraryProvider>
          </MapsProvider>
        </ChatUiProvider>
      </ChatRequestProvider>
    </ComposerDraftProvider>
  );
}

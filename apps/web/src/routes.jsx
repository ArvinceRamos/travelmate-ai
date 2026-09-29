import ChatPage from "./pages/ChatPage.jsx";
import MapPage from "./pages/MapPage.jsx";
import ItineraryPage from "./pages/ItineraryPage.jsx";
import NotificationsPage from "./pages/NotificationsPage.jsx";
import SettingsPage from "./pages/SettingsPage.jsx";
import LoggedOut from "./pages/LoggedOut.jsx";

export const appRoutes = [
  { path: "/chat", label: "Chat", Component: ChatPage },
  { path: "/chat/:chatId", label: "Chat", Component: ChatPage },
  { path: "/map", label: "Map", Component: MapPage },
  { path: "/itinerary", label: "Itinerary", Component: ItineraryPage },
  { path: "/notifications", label: "Notifications", Component: NotificationsPage },
  { path: "/settings", label: "Settings", Component: SettingsPage }
  ,{ path: "/logged-out", label: "Logged out", Component: LoggedOut }
];
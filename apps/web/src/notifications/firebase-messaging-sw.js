/* apps/web/src/notifications/firebase-messaging-sw.js */
import { initializeApp } from "firebase/app";
import { getMessaging, onBackgroundMessage } from "firebase/messaging/sw";

initializeApp({
  apiKey: "__VITE_FIREBASE_API_KEY__",
  authDomain: "__VITE_FIREBASE_AUTH_DOMAIN__",
  projectId: "__VITE_FIREBASE_PROJECT_ID__",
  storageBucket: "__VITE_FIREBASE_STORAGE_BUCKET__",
  messagingSenderId: "__VITE_FIREBASE_MESSAGING_SENDER_ID__",
  appId: "__VITE_FIREBASE_APP_ID__"
});

const messaging = getMessaging();

// Background notifications (tab closed or in background)
onBackgroundMessage(messaging, (payload) => {
  const title = payload?.notification?.title || "TravelMate AI";
  const options = {
    body: payload?.notification?.body || "New update",
    icon: "/favicon.ico",
    data: payload?.data || {}
  };

  self.registration.showNotification(title, options);
});
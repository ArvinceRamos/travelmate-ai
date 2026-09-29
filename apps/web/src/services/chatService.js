import {
  addDoc,
  collection,
  deleteDoc,
  doc,
  getDocs,
  getDoc,
  limit,
  onSnapshot,
  orderBy,
  query,
  serverTimestamp,
  setDoc,
  updateDoc,
  where,
} from "firebase/firestore";
import { db } from "./firebase";

// Create chat
export async function createChat(uid) {
  const ref = await addDoc(collection(db, "chats"), {
    uid,
    title: "New chat",
    titled: false, // ✅ add this
    createdAt: serverTimestamp(),
    updatedAt: serverTimestamp(),
  });
  return ref.id;
}

// Sidebar list (realtime) - scoped query (requires composite index)
export function subscribeChats(uid, cb) {
  const q = query(
    collection(db, "chats"),
    where("uid", "==", uid),
    orderBy("updatedAt", "desc"),
    limit(50)
  );

  return onSnapshot(
    q,
    (snap) => {
      const rows = snap.docs.map((d) => ({ id: d.id, ...d.data() }));
      cb(rows);
    },
    (err) => {
      console.error("subscribeChats:", err.code, err.message);
      cb([]);
    }
  );
}

// Realtime messages for a chat
export function subscribeMessages(chatId, cb, onDenied) {
  const q = query(
    collection(db, "chats", chatId, "messages"),
    orderBy("createdAt", "asc"),
    limit(300)
  );

  return onSnapshot(
    q,
    (snap) => {
      const msgs = snap.docs.map((d) => ({ id: d.id, ...d.data() }));
      cb(msgs);
    },
    (err) => {
      console.error("subscribeMessages:", err.code, err.message);
      cb([]);

      if (err.code === "permission-denied") {
        onDenied?.();
      }
    }
  );
}

const MAP_JSON_START = "<<<MAP_STOPS_JSON>>>";
const MAP_JSON_END = "<<<END_MAP_STOPS_JSON>>>";

function stripMapStopsJson(text) {
  const t = String(text || "");
  const start = t.indexOf(MAP_JSON_START);
  const end = t.indexOf(MAP_JSON_END);
  if (start === -1 || end === -1 || end <= start) return t;
  return (t.slice(0, start) + t.slice(end + MAP_JSON_END.length)).trim();
}

// Add message
export async function addMessage(chatId, role, content) {
  const text = String(content || "");
  const cleanText = role === "assistant" ? stripMapStopsJson(text) : text;

  await addDoc(collection(db, "chats", chatId, "messages"), {
    role,
    content: text,
    createdAt: serverTimestamp(),
  });

  await updateDoc(doc(db, "chats", chatId), {
    updatedAt: serverTimestamp(),
    lastMessagePreview: cleanText.slice(0, 200),
  });
}

// ✅ Title ONCE (ChatGPT-style)
export async function setChatTitleOnce(chatId, title) {
  const chatRef = doc(db, "chats", chatId);
  const snap = await getDoc(chatRef);
  if (!snap.exists()) return;

  const data = snap.data();
  if (data?.titled) return; // already titled

  await setDoc(
    chatRef,
    {
      title,
      titled: true,
      updatedAt: serverTimestamp(),
    },
    { merge: true }
  );
}

// (Optional) Keep this if you still want manual rename from Sidebar
export async function setChatTitle(chatId, title) {
  await setDoc(
    doc(db, "chats", chatId),
    { title, updatedAt: serverTimestamp() },
    { merge: true }
  );
}

// Delete chat + messages
export async function deleteChat(chatId) {
  const msgsCol = collection(db, "chats", chatId, "messages");
  const snap = await getDocs(msgsCol);
  await Promise.all(snap.docs.map((d) => deleteDoc(d.ref)));

  await deleteDoc(doc(db, "chats", chatId));
}

// Optional: get chat
export async function getChat(chatId) {
  const snap = await getDoc(doc(db, "chats", chatId));
  if (!snap.exists()) return null;
  return { id: snap.id, ...snap.data() };
}

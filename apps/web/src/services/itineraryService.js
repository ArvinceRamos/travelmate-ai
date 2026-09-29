import {
  addDoc,
  collection,
  deleteDoc,
  doc,
  onSnapshot,
  orderBy,
  query,
  serverTimestamp,
  updateDoc,
  where,
} from "firebase/firestore";
import { db } from "./firebase";

export async function saveItinerary(uid, itinerary) {
  const nowMs = Date.now();

  const ref = await addDoc(collection(db, "itineraries"), {
    uid,
    chatId: itinerary.chatId ?? null,
    title: String(itinerary.title || "Saved itinerary").trim() || "Saved itinerary",
    prompt: String(itinerary.prompt || "").trim(),
    text: String(itinerary.text || "").trim(),
    tripStart: itinerary.tripStart ?? null,
    tripEnd: itinerary.tripEnd ?? null,
    anchor: itinerary.anchor ?? null,
    mapStops: itinerary.mapStops ?? null,
    done: false,
    createdAt: serverTimestamp(),
    updatedAt: serverTimestamp(),
    createdAtMs: nowMs,
    updatedAtMs: nowMs,
  });

  return { id: ref.id, uid, ...itinerary };
}

export async function updateItinerary(id, patch) {
  await updateDoc(doc(db, "itineraries", id), {
    ...patch,
    updatedAt: serverTimestamp(),
    updatedAtMs: Date.now(),
  });
}

export function subscribeItineraries(uid, cb) {
  const q = query(
    collection(db, "itineraries"),
    where("uid", "==", uid),
    orderBy("updatedAt", "desc")
  );

  return onSnapshot(
    q,
    (snap) => {
      const rows = snap.docs.map((d) => ({ id: d.id, ...d.data() }));
      cb(rows);
    },
    (err) => {
      console.error("subscribeItineraries:", err.code, err.message);
      cb([]);
    }
  );
}

export async function deleteItinerary(id) {
  await deleteDoc(doc(db, "itineraries", id));
}
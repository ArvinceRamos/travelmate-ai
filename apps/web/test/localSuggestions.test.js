import { test } from "node:test";
import assert from "node:assert/strict";

import {
  loadRecents,
  localMatches,
  matchesQuery,
  mergeSuggestions,
  saveRecent,
  tripPlaceRows,
} from "../src/features/maps/localSuggestions.js";

const SM_J = { placeId: "osm:1", description: "SM J Mall, Mandaue, Cebu", main: "SM J Mall", secondary: "Mandaue, Cebu", position: { lat: 10.33, lng: 123.94 } };
const SM_SEASIDE = { placeId: "osm:2", description: "SM Seaside City Cebu", main: "SM Seaside City Cebu", secondary: "", position: { lat: 10.28, lng: 123.88 } };

test("every query word must start a word of the place", () => {
  assert.ok(matchesQuery("s", SM_J));
  assert.ok(matchesQuery("sm j", SM_J));
  assert.ok(matchesQuery("mandaue sm", SM_J));
  assert.ok(!matchesQuery("sm j", SM_SEASIDE));
  assert.ok(!matchesQuery("all", SM_J), "prefixes only, not substrings");
});

test("trip stops with coordinates become rows; misses, far outliers and repeats do not", () => {
  const rows = tripPlaceRows([
    {
      title: "Siargao Escape",
      mapGeo: {
        v: 1,
        places: [
          { k: "kermit", q: "Kermit Siargao", lat: 9.788, lng: 126.16, name: "Kermit" },
          { k: "shaka", q: "Shaka Siargao", missing: true, r: 2 },
          { k: "cloud 9", q: "Cloud 9", lat: 9.813, lng: 126.17, name: "Cloud 9" },
          { k: "sayak", q: "Sayak Airport", lat: 9.859, lng: 126.015, name: "Sayak Airport" },
          { k: "gl", q: "General Luna Boulevard", lat: 18.252, lng: 120.611, name: "General Antonio Luna" },
        ],
      },
    },
    { title: "Again", mapGeo: { v: 1, places: [{ k: "kermit", q: "Kermit Siargao", lat: 9.788, lng: 126.16 }] } },
  ]);
  assert.deepEqual(rows.map((r) => r.main), ["Kermit Siargao", "Cloud 9", "Sayak Airport"]);
  assert.equal(rows[0].secondary, "Siargao Escape");
  assert.equal(rows[0].kind, "trip");
});

test("recents come before trip stops, local rows before remote ones, without duplicates", () => {
  const trip = { ...SM_SEASIDE, placeId: "trip:sm", kind: "trip" };
  const local = localMatches("sm", { recents: [SM_J], tripRows: [trip, { ...SM_J, kind: "trip" }] });
  assert.deepEqual(local.map((r) => [r.main, r.kind]), [["SM J Mall", "recent"], ["SM Seaside City Cebu", "trip"]]);

  const nearSeaside = localMatches("sm", { tripRows: [{ ...SM_J, kind: "trip" }, trip], center: { lat: 10.28, lng: 123.88 } });
  assert.deepEqual(nearSeaside.map((r) => r.main), ["SM Seaside City Cebu", "SM J Mall"], "nearest trip stop first");

  const nearCopy ={ ...SM_J, placeId: "geoapify:1", position: { lat: 10.331, lng: 123.941 } };
  const sameNameElsewhere = { ...SM_J, placeId: "geoapify:2", position: { lat: 14.6, lng: 121.0 } };
  const merged = mergeSuggestions(local, [nearCopy, sameNameElsewhere]);
  assert.deepEqual(merged.map((r) => r.placeId), ["osm:1", "trip:sm", "geoapify:2"]);
});

test("recents are per user, newest first, capped, and survive missing storage", () => {
  const store = new Map();
  globalThis.window = {
    localStorage: {
      getItem: (k) => (store.has(k) ? store.get(k) : null),
      setItem: (k, v) => store.set(k, String(v)),
    },
  };
  try {
    for (let i = 0; i < 25; i++) {
      saveRecent("u1", { ...SM_J, main: `Place ${i}`, description: `Place ${i}` });
    }
    saveRecent("u1", { ...SM_J, main: "Place 3", description: "Place 3" });
    const list = loadRecents("u1");
    assert.equal(list.length, 20);
    assert.equal(list[0].main, "Place 3");
    assert.equal(list.filter((r) => r.main === "Place 3").length, 1);
    assert.deepEqual(loadRecents("u2"), []);

    store.set("tm_place_recents_v1:u1", "{not json");
    assert.deepEqual(loadRecents("u1"), []);
  } finally {
    delete globalThis.window;
  }
  assert.deepEqual(loadRecents("u1"), []);
});

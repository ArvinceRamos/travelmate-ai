import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import { itineraryStops } from "../src/utils/itineraryParse.js";
import {
  buildMapGeo,
  pickHit,
  readMapGeo,
  resolveTripPlaces,
  stopQueries,
  tripOutlierKeys,
} from "../src/features/maps/tripGeo.js";

const panagsama = readFileSync(new URL("./fixtures/panagsama.txt", import.meta.url), "utf8");
const MOALBOAL = { lat: 9.94, lng: 123.39 };

function fakeSearch(table, calls = []) {
  return async (q) => {
    calls.push(q);
    const hit = table[q];
    if (hit instanceof Error) throw hit;
    return hit ? [{ name: q, position: hit }] : [];
  };
}

test("stopQueries dedupes repeated places and includes transfer origins", () => {
  const queries = stopQueries(itineraryStops(panagsama));
  assert.ok(queries.has("cebu city"));
  assert.ok(queries.has("moalboal"));
  assert.equal([...queries.values()].filter((q) => q === "Panagsama Beach").length, 1);
});

test("resolveTripPlaces only geocodes unknown places and records misses", async () => {
  const calls = [];
  const queries = new Map([
    ["panagsama beach", "Panagsama Beach"],
    ["cebu city", "Cebu City"],
    ["french bakery o delices", "French Bakery Ô Délices"],
    ["kawasan falls", "Kawasan Falls"],
  ]);
  const placed = {};
  let anchor = null;

  await resolveTripPlaces({
    queries,
    known: { "panagsama beach": { lat: 9.95, lng: 123.37 } },
    anchorLabel: "Moalboal, Philippines",
    search: fakeSearch(
      {
        "Moalboal, Philippines": MOALBOAL,
        "Cebu City": { lat: 10.32, lng: 123.89 },
        "Kawasan Falls": new Error("rate-limited"),
      },
      calls
    ),
    onAnchor: (a) => (anchor = a),
    onPlace: (k, p) => (placed[k] = p),
  });

  assert.deepEqual(anchor, { label: "Moalboal, Philippines", ...MOALBOAL });
  assert.ok(!calls.includes("Panagsama Beach"));
  assert.equal(placed["cebu city"].lat, 10.32);
  assert.deepEqual(placed["french bakery o delices"], { q: "French Bakery Ô Délices", missing: true });
  assert.equal(placed["kawasan falls"], undefined, "network errors are retried later, not stored");
});

test("Cebu City (~90 km from Moalboal) is kept; a same-name match abroad is an outlier", () => {
  const places = {
    a: { lat: 9.95, lng: 123.37 },
    b: { lat: 9.94, lng: 123.39 },
    c: { lat: 9.81, lng: 123.38 },
    cebu: { lat: 10.32, lng: 123.89 },
    abroad: { lat: 11.96, lng: 121.92 },
    gone: { missing: true },
  };
  const out = tripOutlierKeys(places, Object.keys(places));
  assert.deepEqual([...out], ["abroad"]);
});

test("mapGeo round-trips and drops places no stop uses", () => {
  const queries = new Map([["moalboal", "Moalboal"], ["badian", "Badian"]]);
  const geo = buildMapGeo({
    anchor: { label: "Moalboal, Philippines", ...MOALBOAL },
    places: {
      moalboal: { lat: 9.94, lng: 123.39, name: "Moalboal" },
      badian: { missing: true },
      stale: { lat: 1, lng: 2 },
    },
    queries,
  });
  assert.equal(geo.places.length, 2);

  const back = readMapGeo({ mapGeo: geo });
  assert.equal(back.anchor.label, "Moalboal, Philippines");
  assert.equal(back.places.moalboal.lat, 9.94);
  assert.equal(back.places.badian.missing, true);
  assert.equal(back.places.stale, undefined);
});

test("located AI mapStops seed the cache", () => {
  const { places } = readMapGeo({
    mapStops: [{ day: 1, order: 1, label: "Kawasan Falls", location: { lat: 9.8, lng: 123.37 } }],
  });
  assert.equal(places["kawasan falls"].lat, 9.8);
});

test("pickHit prefers nearby hits whose name matches the stop", () => {
  const hits = [
    { name: "Moalboal spa & massage", position: { lat: 9.95, lng: 123.366 } },
    { name: "Panagsama Beach", position: { lat: 9.947, lng: 123.366 } },
    { name: "Panagsama Beach Resort", position: { lat: 14.6, lng: 121.0 } },
  ];
  assert.equal(pickHit("Moalboal Panagsama Beach", hits, MOALBOAL).name, "Panagsama Beach");
  assert.equal(pickHit("Badian", hits.slice(0, 1), MOALBOAL).name, "Moalboal spa & massage");
  assert.equal(pickHit("Rizal Park", hits.slice(2), MOALBOAL).name, "Panagsama Beach Resort");
});

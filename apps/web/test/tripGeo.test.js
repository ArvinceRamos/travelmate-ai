import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import { itineraryStops } from "../src/utils/itineraryParse.js";
import {
  buildMapGeo,
  pickHit,
  readMapGeo,
  resolveTripPlaces,
  routeSegments,
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

test("a far hit that clearly names the stop (departure airport) is not an outlier", () => {
  const SIARGAO = { lat: 9.79, lng: 126.16 };
  const base = {
    kermit: { q: "Kermit", name: "Kermit", ...SIARGAO },
    cloud9: { q: "Cloud 9", name: "Cloud 9", lat: 9.81, lng: 126.17 },
    sayak: { q: "Sayak Airport", name: "Siargao Airport", lat: 9.86, lng: 126.01 },
  };
  const isOutlier = (p) => tripOutlierKeys({ ...base, far: p }, [...Object.keys(base), "far"]).has("far");

  assert.ok(!isOutlier({ q: "Mactan-Cebu International Airport", name: "Mactan–Cebu International Airport", lat: 10.31, lng: 123.98 }), "airport kept");
  assert.ok(isOutlier({ q: "Pacifico Beach", name: "Pacifico Beach Resort", lat: 14.6, lng: 121.0 }), "only one meaningful word shared");
  assert.ok(isOutlier({ q: "Magpupungko Rock Pools", name: "Magpupungko Rock Pools", lat: 14.6, lng: 121.0 }), "a name copied from the query proves nothing");
  assert.ok(isOutlier({ q: "Sayak Airport", name: "Ninoy Aquino International Airport", lat: 14.51, lng: 121.02 }), "a different airport is still an outlier");
  assert.ok(isOutlier({ q: "General Luna Boulevard", name: "General Antonio Luna", lat: 18.25, lng: 120.61 }), "extra distinctive word in the name");
});

test("misses from an older resolver are dropped on read so they are retried once", async () => {
  const back = readMapGeo({
    mapGeo: {
      v: 1,
      places: [
        { k: "kermit siargao", q: "Kermit Siargao", missing: true },
        { k: "general luna public market", q: "General Luna Public Market", missing: true, r: 2 },
        { k: "cloud 9", q: "Cloud 9", lat: 9.81, lng: 126.17, name: "Cloud 9" },
      ],
    },
  });
  assert.equal(back.places["kermit siargao"], undefined);
  assert.equal(back.places["general luna public market"].missing, true);
  assert.equal(back.places["cloud 9"].lat, 9.81);

  const calls = [];
  const queries = new Map([
    ["kermit siargao", "Kermit Siargao"],
    ["general luna public market", "General Luna Public Market"],
    ["cloud 9", "Cloud 9"],
  ]);
  const placed = {};
  await resolveTripPlaces({
    queries,
    known: back.places,
    search: fakeSearch({ "Kermit Siargao": { lat: 9.788, lng: 126.16 } }, calls),
    onPlace: (k, p) => (placed[k] = p),
  });
  assert.deepEqual(calls, ["Kermit Siargao"]);

  const geo = buildMapGeo({ places: { ...back.places, ...placed, "kermit siargao": { missing: true } }, queries });
  assert.deepEqual(geo.places.find((p) => p.k === "kermit siargao"), {
    k: "kermit siargao",
    q: "Kermit Siargao",
    missing: true,
    r: 2,
  });
});

test("routeSegments splits flights and very long legs out of the road route", () => {
  const cebuAirport = { lat: 10.31, lng: 123.98, airport: true };
  const sayak = { lat: 9.86, lng: 126.01, airport: true };
  const kermit = { lat: 9.788, lng: 126.16 };
  const cloud9 = { lat: 9.81, lng: 126.17 };
  const cebuCity = { lat: 10.32, lng: 123.89 };

  const segs = routeSegments([cebuCity, cebuAirport, sayak, kermit, cloud9]);
  assert.deepEqual(segs.map((s) => [s.type, s.points.length]), [["drive", 2], ["jump", 2], ["drive", 3]]);
  assert.equal(segs[1].points[0], cebuAirport);

  assert.deepEqual(routeSegments([cebuCity, kermit]).map((s) => s.type), ["jump"], "> 150 km without airports");
  assert.deepEqual(routeSegments([kermit]), []);

  const many = Array.from({ length: 25 }, (_, i) => ({ lat: 9.8 + i * 0.001, lng: 126.1 }));
  const chunks = routeSegments(many);
  assert.deepEqual(chunks.map((s) => s.points.length), [20, 6]);
  assert.equal(chunks[0].points[19], chunks[1].points[0], "chunks share an endpoint");
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

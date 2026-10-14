"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const providers = require("../src/services/freeProviders.service");

const row = (name, lat, lon) => ({
  osm_type: "node", osm_id: 7, name, display_name: `${name}, Baguio, Philippines`, lat: String(lat), lon: String(lon),
});

function mockNominatim(handler) {
  const originalFetch = global.fetch;
  const oldBase = process.env.NOMINATIM_BASE_URL;
  process.env.NOMINATIM_BASE_URL = "https://nominatim.contract.test";
  providers.clearProviderCache();
  const urls = [];
  global.fetch = async (url) => {
    const parsed = new URL(String(url));
    if (parsed.origin !== "https://nominatim.contract.test") return originalFetch(url);
    urls.push(parsed);
    return new Response(JSON.stringify(handler(parsed)), { status: 200, headers: { "Content-Type": "application/json" } });
  };
  return {
    urls,
    originalFetch,
    restore() {
      global.fetch = originalFetch;
      if (oldBase === undefined) delete process.env.NOMINATIM_BASE_URL;
      else process.env.NOMINATIM_BASE_URL = oldBase;
      providers.clearProviderCache();
    },
  };
}

test("geocodePlace searches a bounded box around the trip base first", async () => {
  const mock = mockNominatim(() => [row("Burnham Park", 16.41, 120.59)]);
  try {
    const places = await providers.geocodePlace("Burnham Park", { lat: "16.4", lon: "120.6", limit: "3" });
    assert.equal(mock.urls.length, 1);
    assert.equal(mock.urls[0].searchParams.get("viewbox"), "120.100,16.900,121.100,15.900");
    assert.equal(mock.urls[0].searchParams.get("bounded"), "1");
    assert.equal(mock.urls[0].searchParams.get("limit"), "3");
    assert.deepEqual(places[0].location, { lat: 16.41, lng: 120.59 });
    assert.equal(places[0].provider, "nominatim");
  } finally {
    mock.restore();
  }
});

test("geocodePlace falls back to an unbounded search when the box has no match", async () => {
  const mock = mockNominatim((url) => (url.searchParams.has("viewbox") ? [] : [row("Far Away Falls", 10.3, 123.9)]));
  try {
    const places = await providers.geocodePlace("Far Away Falls", { lat: 16.4, lon: 120.6 });
    assert.equal(mock.urls.length, 2);
    assert.equal(mock.urls[1].searchParams.has("viewbox"), false);
    assert.equal(places[0].name, "Far Away Falls");
  } finally {
    mock.restore();
  }
});

test("geocodePlace ignores missing or invalid coordinates and caches per box", async () => {
  const mock = mockNominatim(() => [row("Session Road", 16.41, 120.6)]);
  try {
    await providers.geocodePlace("Session Road", { lat: "", lon: "" });
    await providers.geocodePlace("Session Road", { lat: "999", lon: "120.6" });
    assert.equal(mock.urls.length, 1);
    assert.equal(mock.urls[0].searchParams.has("viewbox"), false);
    await providers.geocodePlace("Session Road", { lat: 16.4, lon: 120.6 });
    assert.equal(mock.urls.length, 2);
    assert.equal(mock.urls[1].searchParams.has("viewbox"), true);
  } finally {
    mock.restore();
  }
});

test("GET /v1/places/geocode returns places and rejects bad queries", async () => {
  const { app } = require("../app");
  const mock = mockNominatim(() => [row("Mines View Park", 16.42, 120.63)]);
  const server = app.listen(0);
  try {
    await new Promise((resolve) => server.once("listening", resolve));
    const base = `http://127.0.0.1:${server.address().port}`;

    const ok = await mock.originalFetch(`${base}/v1/places/geocode?q=Mines%20View%20Park&lat=16.4&lon=120.6`);
    assert.equal(ok.status, 200);
    const body = await ok.json();
    assert.equal(body.ok, true);
    assert.equal(body.data.places[0].name, "Mines View Park");
    assert.deepEqual(body.data.places[0].location, { lat: 16.42, lng: 120.63 });
    assert.equal(mock.urls[0].searchParams.get("bounded"), "1");

    const empty = await mock.originalFetch(`${base}/v1/places/geocode?q=`);
    assert.equal(empty.status, 400);
    const tooLong = await mock.originalFetch(`${base}/v1/places/geocode?q=${"a".repeat(201)}`);
    assert.equal(tooLong.status, 400);
  } finally {
    await new Promise((resolve) => server.close(resolve));
    mock.restore();
  }
});

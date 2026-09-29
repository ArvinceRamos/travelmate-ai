"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const providers = require("../src/services/freeProviders.service");

test("Photon normalizes places without inventing ratings or opening status and caches results", async () => {
  providers.clearProviderCache();
  const originalFetch = global.fetch;
  let calls = 0;
  process.env.PHOTON_BASE_URL = "https://photon.test/api/";
  global.fetch = async () => {
    calls += 1;
    return new Response(JSON.stringify({
      features: [{
        properties: { osm_type: "node", osm_id: 42, name: "Test Cafe", label: "Test Cafe, Cebu" },
        geometry: { coordinates: [123.9, 10.3] },
      }],
    }), { status: 200, headers: { "Content-Type": "application/json" } });
  };

  try {
    const first = await providers.photonSearch("test cafe", { limit: 2 });
    const second = await providers.photonSearch("test cafe", { limit: 2 });
    assert.equal(first[0].rating, null);
    assert.equal(first[0].openNow, null);
    assert.deepEqual(first[0].location, { lat: 10.3, lng: 123.9 });
    assert.deepEqual(second, first);
    assert.equal(calls, 1);
  } finally {
    global.fetch = originalFetch;
  }
});

test("provider HTTP 429 is preserved with Retry-After", async () => {
  providers.clearProviderCache();
  const originalFetch = global.fetch;
  global.fetch = async () => new Response("busy", { status: 429, headers: { "Retry-After": "3" } });
  try {
    await assert.rejects(providers.currentWeather(10, 123), (error) => {
      assert.equal(error.status, 429);
      assert.equal(error.retryAfter, "3");
      return true;
    });
  } finally {
    global.fetch = originalFetch;
  }
});

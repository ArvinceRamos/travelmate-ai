"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const maps = require("../src/services/maps.service");
const planner = require("../src/services/llm.service");
const freeProviders = require("../src/services/freeProviders.service");

test("place search keeps the frontend shape and leaves unsupported facts unknown", async () => {
  const originalFetch = global.fetch;
  const originalBaseUrl = process.env.PHOTON_BASE_URL;
  process.env.PHOTON_BASE_URL = "https://photon.contract.test/api/";
  freeProviders.clearProviderCache();
  global.fetch = async () => new Response(JSON.stringify({
    features: [{
      properties: { osm_type: "node", osm_id: 17, name: "Sample Cafe", label: "Sample Cafe, Cebu City" },
      geometry: { coordinates: [123.9, 10.3] },
    }],
  }), { status: 200, headers: { "Content-Type": "application/json" } });

  try {
    const results = await maps.searchTextPlaces("Sample Cafe in Cebu City");
    assert.equal(results.length, 1);
    assert.deepEqual(results[0].location, { lat: 10.3, lng: 123.9 });
    assert.equal(results[0].name, "Sample Cafe");
    assert.equal(results[0].provider, "photon");
    assert.equal(results[0].rating, null);
    assert.equal(results[0].userRatingCount, null);
    assert.equal(results[0].openNow, null);
    assert.equal(results[0].openingHours, null);
    assert.equal(results[0].isOperational, null);
  } finally {
    global.fetch = originalFetch;
    if (originalBaseUrl === undefined) delete process.env.PHOTON_BASE_URL;
    else process.env.PHOTON_BASE_URL = originalBaseUrl;
    freeProviders.clearProviderCache();
  }
});

test("planner strips the save prompt from non-final itinerary replies", () => {
  const draft = "I have a draft route.\n\nWould you like to save this itinerary?";
  assert.equal(planner.stripOrphanSaveItineraryPrompt(draft), "I have a draft route.");
});

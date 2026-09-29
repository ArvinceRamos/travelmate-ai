"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const providers = require("../src/services/freeProviders.service");

test("Nominatim lookup uses its configured endpoint and User-Agent, then caches normalized results", async () => {
  const originalFetch = global.fetch;
  const oldBase = process.env.NOMINATIM_BASE_URL;
  const oldAgent = process.env.NOMINATIM_USER_AGENT;
  process.env.NOMINATIM_BASE_URL = "https://nominatim.contract.test";
  process.env.NOMINATIM_USER_AGENT = "TravelmateTest/1.0 (test@example.invalid)";
  providers.clearProviderCache();
  let calls = 0;
  let requestUrl = "";
  let requestAgent = "";
  global.fetch = async (url, options) => {
    calls += 1;
    requestUrl = String(url);
    requestAgent = options.headers["User-Agent"];
    return new Response(JSON.stringify([{
      place_id: 5,
      osm_type: "way",
      osm_id: 42,
      name: "Sample Park",
      display_name: "Sample Park, Cebu City, Philippines",
      lat: "10.3",
      lon: "123.9",
    }]), { status: 200, headers: { "Content-Type": "application/json" } });
  };

  try {
    const first = await providers.nominatimSearch("Sample Park", 3);
    const second = await providers.nominatimSearch("Sample Park", 3);
    assert.match(requestUrl, /^https:\/\/nominatim\.contract\.test\/search\?/);
    assert.equal(requestAgent, "TravelmateTest/1.0 (test@example.invalid)");
    assert.equal(calls, 1);
    assert.deepEqual(first[0].location, { lat: 10.3, lng: 123.9 });
    assert.equal(first[0].id, "way:42");
    assert.equal(first[0].provider, "nominatim");
    assert.equal(first[0].rating, null);
    assert.equal(first[0].openNow, null);
    assert.deepEqual(second, first);
  } finally {
    global.fetch = originalFetch;
    if (oldBase === undefined) delete process.env.NOMINATIM_BASE_URL;
    else process.env.NOMINATIM_BASE_URL = oldBase;
    if (oldAgent === undefined) delete process.env.NOMINATIM_USER_AGENT;
    else process.env.NOMINATIM_USER_AGENT = oldAgent;
    providers.clearProviderCache();
  }
});

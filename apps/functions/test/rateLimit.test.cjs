"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { rateLimit } = require("../src/middleware/rateLimit");

function request(ip, uid) {
  return { ip, _verifiedUid: uid, socket: {} };
}

function response() {
  return {
    headers: {},
    statusCode: 200,
    set(name, value) { this.headers[name] = value; return this; },
    status(value) { this.statusCode = value; return this; },
    json(value) { this.body = value; return this; },
  };
}

test("AI rate limit is shared by IP across authenticated user IDs", () => {
  const limiter = rateLimit({ windowMs: 60_000, maxRequests: 1, keyByIp: true });
  const ip = `198.51.100.${(process.pid % 200) + 1}`;
  let nextCalls = 0;
  const next = () => { nextCalls += 1; };

  limiter(request(ip, "user-one"), response(), next);
  const limitedResponse = response();
  limiter(request(ip, "user-two"), limitedResponse, next);

  assert.equal(nextCalls, 1);
  assert.equal(limitedResponse.statusCode, 429);
  assert.ok(Number(limitedResponse.headers["Retry-After"]) > 0);

  limiter(request(`${ip}-other`, "user-two"), response(), next);
  assert.equal(nextCalls, 2);
});

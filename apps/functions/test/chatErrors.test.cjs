"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("path");
const { AIProviderError } = require("../src/services/aiProvider.service");

// Replace the planner so the route's error handling can be tested without real providers.
let plannerError = null;
const llmPath = require.resolve(path.join(__dirname, "../src/services/llm.service"));
require.cache[llmPath] = {
  id: llmPath,
  filename: llmPath,
  loaded: true,
  exports: { llmChat: async () => { throw plannerError; } },
};
const { app } = require("../app");

async function postChat() {
  const server = app.listen(0);
  try {
    await new Promise((resolve) => server.once("listening", resolve));
    const res = await fetch(`http://127.0.0.1:${server.address().port}/v1/chat`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Forwarded-For": `10.9.${Math.floor(Math.random() * 250)}.1` },
      body: JSON.stringify({ messages: [{ role: "user", content: "tokyo" }] }),
    });
    return { status: res.status, retryAfter: res.headers.get("retry-after"), body: await res.json() };
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
}

test("a dead model returns 503 with a friendly message and no provider text", async () => {
  plannerError = new AIProviderError("All AI providers failed.", { status: 503 });
  plannerError.primaryError = new AIProviderError("models/gemini-2.5-flash is no longer available", { status: 404 });
  plannerError.fallbackError = new AIProviderError("The model llama-3.3-70b-versatile does not exist", { status: 404 });
  const res = await postChat();
  assert.equal(res.status, 503);
  assert.equal(res.body.ok, false);
  assert.match(res.body.error, /temporarily unavailable/);
  assert.doesNotMatch(JSON.stringify(res.body), /llama|gemini|does not exist|model/i);
});

test("a rate-limited provider returns 429 with Retry-After", async () => {
  plannerError = new AIProviderError("All AI providers failed.", { status: 429, retryAfter: "20" });
  const res = await postChat();
  assert.equal(res.status, 429);
  assert.equal(res.retryAfter, "20");
  assert.match(res.body.error, /busy/);
});

test("a single provider 404 is reported as 503, and unexpected errors hide their message", async () => {
  plannerError = new AIProviderError("The model foo does not exist", { status: 404 });
  const dead = await postChat();
  assert.equal(dead.status, 503);
  assert.doesNotMatch(dead.body.error, /foo/);

  plannerError = new TypeError("Cannot read properties of undefined (reading 'x')");
  const crash = await postChat();
  assert.equal(crash.status, 500);
  assert.doesNotMatch(crash.body.error, /Cannot read/);
});

test("app.js exports the Express app as its default export for Vercel", () => {
  const exported = require("../app");
  assert.equal(typeof exported, "function");
  assert.equal(exported.app, exported);
  assert.equal(typeof exported.runReminderSweep, "function");
});

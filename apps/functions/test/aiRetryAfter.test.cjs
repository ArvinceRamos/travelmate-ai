"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { callChatCompletion } = require("../src/services/llm.service");

test("AI retry waits for the provider Retry-After value", async () => {
  const originalSetTimeout = global.setTimeout;
  const waits = [];
  let calls = 0;
  global.setTimeout = (callback, delay) => {
    waits.push(delay);
    callback();
    return 0;
  };

  try {
    const client = {
      chat: {
        completions: {
          create: async () => {
            calls += 1;
            if (calls === 1) throw Object.assign(new Error("rate limited"), { status: 429, retryAfter: "2" });
            return { choices: [{ message: { content: "Recovered" } }] };
          },
        },
      },
    };
    const reply = await callChatCompletion(client, {
      model: "test-model",
      messages: [{ role: "user", content: "hello" }],
      temperature: 0,
      max_completion_tokens: 32,
    });
    assert.equal(reply, "Recovered");
    assert.deepEqual(waits, [2000]);
    assert.equal(calls, 2);
  } finally {
    global.setTimeout = originalSetTimeout;
  }
});

"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { getAIClient } = require("../src/services/aiProvider.service");

const validJson = JSON.stringify({ ok: true, count: 2 });

for (const provider of ["gemini", "ollama"]) {
  test(`${provider} requests JSON mode and returns validated JSON`, async () => {
    const old = { ...process.env };
    const originalFetch = global.fetch;
    process.env.AI_PROVIDER = provider;
    process.env.AI_MODEL = "test-model";
    process.env.AI_BASE_URL = "https://provider.test";
    process.env.GEMINI_API_KEY = "test-gemini-key";
    let requestBody;
    global.fetch = async (url, options) => {
      requestBody = { url: String(url), body: JSON.parse(options.body) };
      const payload = provider === "gemini"
        ? { candidates: [{ content: { parts: [{ text: validJson }] } }] }
        : { message: { content: validJson } };
      return new Response(JSON.stringify(payload), { status: 200 });
    };

    try {
      const result = await getAIClient().chat.completions.create({
        model: "test-model",
        messages: [{ role: "user", content: "return JSON" }],
        response_format: { type: "json_object" },
      });
      assert.deepEqual(JSON.parse(result.choices[0].message.content), { ok: true, count: 2 });
      if (provider === "gemini") assert.equal(requestBody.body.generationConfig.responseMimeType, "application/json");
      if (provider === "ollama") assert.equal(requestBody.body.format, "json");
    } finally {
      global.fetch = originalFetch;
      for (const key of Object.keys(process.env)) {
        if (!(key in old)) delete process.env[key];
      }
      Object.assign(process.env, old);
    }
  });
}

test("AI adapter rejects malformed JSON instead of passing it downstream", async () => {
  const originalFetch = global.fetch;
  process.env.AI_PROVIDER = "ollama";
  process.env.AI_BASE_URL = "http://ollama.test";
  global.fetch = async () => new Response(JSON.stringify({ message: { content: "not-json" } }), { status: 200 });
  try {
    await assert.rejects(
      getAIClient().chat.completions.create({
        model: "test-model",
        messages: [{ role: "user", content: "return JSON" }],
        response_format: { type: "json_object" },
      }),
      /invalid JSON/
    );
  } finally {
    global.fetch = originalFetch;
  }
});

test("AI providers preserve json_schema requests and validate their JSON response", async () => {
  const old = { ...process.env };
  const originalFetch = global.fetch;
  const schema = { type: "object", required: ["ok"], properties: { ok: { type: "boolean" } } };
  for (const provider of ["gemini", "ollama"]) {
    process.env.AI_PROVIDER = provider;
    process.env.AI_BASE_URL = "https://provider.test";
    process.env.GEMINI_API_KEY = "test-gemini-key";
    let sent;
    global.fetch = async (_url, options) => {
      sent = JSON.parse(options.body);
      const payload = provider === "gemini"
        ? { candidates: [{ content: { parts: [{ text: '{"ok":true}' }] } }] }
        : { message: { content: '{"ok":true}' } };
      return new Response(JSON.stringify(payload), { status: 200 });
    };
    try {
      const result = await getAIClient().chat.completions.create({
        messages: [{ role: "user", content: "Return JSON." }],
        response_format: { type: "json_schema", json_schema: { name: "result", strict: true, schema } },
      });
      assert.deepEqual(JSON.parse(result.choices[0].message.content), { ok: true });
      if (provider === "gemini") assert.equal(sent.generationConfig.responseMimeType, "application/json");
      if (provider === "ollama") assert.deepEqual(sent.format, schema);
    } finally {
      global.fetch = originalFetch;
      for (const key of Object.keys(process.env)) if (!(key in old)) delete process.env[key];
      Object.assign(process.env, old);
    }
  }
});

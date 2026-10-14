"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { getAIClient } = require("../src/services/aiProvider.service");

const validJson = JSON.stringify({ ok: true, count: 2 });

for (const provider of ["openai", "gemini", "ollama"]) {
  test(`${provider} requests JSON mode and returns validated JSON`, async () => {
    const old = { ...process.env };
    const originalFetch = global.fetch;
    process.env.AI_PROVIDER = provider;
    process.env.AI_MODEL = "test-model";
    process.env.AI_BASE_URL = "https://provider.test";
    process.env.GEMINI_API_KEY = "test-gemini-key";
    process.env.OPENAI_API_KEY = "test-openai-key";
    let requestBody;
    global.fetch = async (url, options) => {
      requestBody = { url: String(url), body: JSON.parse(options.body) };
      const payload = provider === "gemini"
        ? { candidates: [{ content: { parts: [{ text: validJson }] } }] }
        : provider === "openai"
          ? { choices: [{ message: { content: validJson } }] }
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
      if (provider === "openai") {
        assert.equal(requestBody.url, "https://provider.test/chat/completions");
        assert.equal(requestBody.body.response_format.type, "json_object");
      }
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
  for (const provider of ["openai", "gemini", "ollama"]) {
    process.env.AI_PROVIDER = provider;
    process.env.AI_BASE_URL = "https://provider.test";
    process.env.GEMINI_API_KEY = "test-gemini-key";
    process.env.OPENAI_API_KEY = "test-openai-key";
    let sent;
    global.fetch = async (_url, options) => {
      sent = JSON.parse(options.body);
      const payload = provider === "gemini"
        ? { candidates: [{ content: { parts: [{ text: '{"ok":true}' }] } }] }
        : provider === "openai"
          ? { choices: [{ message: { content: '{"ok":true}' } }] }
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
      if (provider === "openai") {
        assert.equal(sent.response_format.type, "json_schema");
        assert.deepEqual(sent.response_format.json_schema.schema, schema);
      }
      if (provider === "ollama") assert.deepEqual(sent.format, schema);
    } finally {
      global.fetch = originalFetch;
      for (const key of Object.keys(process.env)) if (!(key in old)) delete process.env[key];
      Object.assign(process.env, old);
    }
  }
});

test("OpenAI quota errors fall back to Gemini using backend-only provider credentials", async () => {
  const old = { ...process.env };
  const originalFetch = global.fetch;
  process.env.AI_PROVIDER = "openai";
  process.env.AI_MODEL = "gpt-4o-mini";
  process.env.OPENAI_API_KEY = "server-openai-test-key";
  process.env.AI_FALLBACK_PROVIDER = "gemini";
  process.env.GEMINI_API_KEY = "server-gemini-test-key";
  const seen = [];
  global.fetch = async (url, options) => {
    seen.push({ url: String(url), headers: options.headers });
    if (String(url).includes("api.openai.com")) {
      return new Response(JSON.stringify({ error: { message: "Insufficient quota" } }), {
        status: 429,
        headers: { "Retry-After": "7" },
      });
    }
    return new Response(JSON.stringify({ candidates: [{ content: { parts: [{ text: "Free fallback reply" }] } }] }), { status: 200 });
  };

  try {
    const result = await getAIClient().chat.completions.create({
      messages: [{ role: "user", content: "Plan a trip" }],
    });
    assert.equal(result.choices[0].message.content, "Free fallback reply");
    assert.equal(seen.length, 2);
    assert.equal(seen[0].headers.Authorization, "Bearer server-openai-test-key");
    assert.match(seen[1].url, /generativelanguage\.googleapis\.com/);
    assert.equal(seen[1].headers["x-goog-api-key"], "server-gemini-test-key");
    assert.ok(!seen[1].url.includes("key="));
  } finally {
    global.fetch = originalFetch;
    for (const key of Object.keys(process.env)) if (!(key in old)) delete process.env[key];
    Object.assign(process.env, old);
  }
});

test("Gemini failures fall back to Groq through its OpenAI-compatible endpoint", async () => {
  const old = { ...process.env };
  const originalFetch = global.fetch;
  process.env.AI_PROVIDER = "gemini";
  process.env.GEMINI_API_KEY = "server-gemini-test-key";
  process.env.AI_FALLBACK_PROVIDER = "groq";
  process.env.GROQ_API_KEY = "server-groq-test-key";
  delete process.env.AI_BASE_URL;
  delete process.env.AI_MODEL;
  const seen = [];
  global.fetch = async (url, options) => {
    seen.push({ url: String(url), headers: options.headers, body: JSON.parse(options.body) });
    if (String(url).includes("generativelanguage.googleapis.com")) {
      return new Response(JSON.stringify({ error: { message: "quota" } }), { status: 429 });
    }
    return new Response(JSON.stringify({ choices: [{ message: { content: '{"ok":true}' } }] }), { status: 200 });
  };

  try {
    const result = await getAIClient().chat.completions.create({
      messages: [{ role: "user", content: "Return JSON." }],
      response_format: { type: "json_schema", json_schema: { name: "r", schema: { type: "object" } } },
    });
    assert.deepEqual(JSON.parse(result.choices[0].message.content), { ok: true });
    assert.equal(seen.length, 2);
    assert.equal(seen[1].url, "https://api.groq.com/openai/v1/chat/completions");
    assert.equal(seen[1].headers.Authorization, "Bearer server-groq-test-key");
    assert.equal(seen[1].body.model, "openai/gpt-oss-120b");
    assert.equal(seen[1].body.reasoning_effort, "low");
    assert.equal(seen[1].body.response_format.type, "json_schema");
  } finally {
    global.fetch = originalFetch;
    for (const key of Object.keys(process.env)) if (!(key in old)) delete process.env[key];
    Object.assign(process.env, old);
  }
});

async function withProviders(env, handler, run) {
  const old = { ...process.env };
  const originalFetch = global.fetch;
  for (const key of ["AI_MODEL", "AI_BASE_URL", "AI_FALLBACK_MODEL", "AI_FALLBACK_BASE_URL", "AI_FALLBACK_PROVIDER"]) delete process.env[key];
  Object.assign(process.env, env);
  const seen = [];
  global.fetch = async (url, options) => {
    const call = { url: String(url), headers: options.headers, body: JSON.parse(options.body) };
    seen.push(call);
    return handler(call);
  };
  try {
    await run(seen);
  } finally {
    global.fetch = originalFetch;
    for (const key of Object.keys(process.env)) if (!(key in old)) delete process.env[key];
    Object.assign(process.env, old);
  }
}

const geminiReply = (text) => new Response(JSON.stringify({ candidates: [{ content: { parts: [{ text }] } }] }), { status: 200 });

test("Gemini gets nullable JSON schemas through responseJsonSchema without null enum values", async () => {
  const schema = {
    type: "object",
    additionalProperties: false,
    required: ["budget"],
    properties: { budget: { type: ["string", "null"], enum: ["budget", "luxury", null] } },
  };
  await withProviders({ AI_PROVIDER: "gemini", GEMINI_API_KEY: "k" }, () => geminiReply('{"budget":null}'), async (seen) => {
    await getAIClient().chat.completions.create({
      messages: [{ role: "user", content: "Return JSON." }],
      response_format: { type: "json_schema", json_schema: { name: "r", strict: true, schema } },
    });
    const config = seen[0].body.generationConfig;
    assert.equal(config.responseSchema, undefined);
    assert.equal(config.responseJsonSchema.additionalProperties, false);
    assert.deepEqual(config.responseJsonSchema.properties.budget, { type: ["string", "null"], enum: ["budget", "luxury"] });
    assert.deepEqual(schema.properties.budget.enum, ["budget", "luxury", null]);
    assert.match(seen[0].url, /models\/gemini-3\.5-flash-lite:generateContent$/);
  });
});

test("Groq models without json_schema support are asked for plain JSON mode", async () => {
  await withProviders(
    { AI_PROVIDER: "groq", GROQ_API_KEY: "k", AI_MODEL: "llama-4-scout" },
    () => new Response(JSON.stringify({ choices: [{ message: { content: '{"ok":true}' } }] }), { status: 200 }),
    async (seen) => {
      await getAIClient().chat.completions.create({
        messages: [{ role: "user", content: "Return JSON." }],
        response_format: { type: "json_schema", json_schema: { name: "r", schema: { type: "object" } } },
      });
      assert.equal(seen[0].body.response_format.type, "json_object");
      assert.equal(seen[0].body.reasoning_effort, undefined);
    }
  );
});

test("a second model on the same provider works as the fallback", async () => {
  await withProviders(
    { AI_PROVIDER: "gemini", GEMINI_API_KEY: "k", AI_FALLBACK_PROVIDER: "gemini", AI_FALLBACK_MODEL: "gemini-3.1-flash-lite" },
    (call) => call.url.includes("gemini-3.5-flash-lite")
      ? new Response(JSON.stringify({ error: { message: "quota" } }), { status: 429 })
      : geminiReply("Fallback reply"),
    async (seen) => {
      const result = await getAIClient().chat.completions.create({ messages: [{ role: "user", content: "Hi" }] });
      assert.equal(result.choices[0].message.content, "Fallback reply");
      assert.match(seen[1].url, /models\/gemini-3\.1-flash-lite:generateContent$/);
    }
  );
});

test("when both providers fail the error keeps both causes and prefers a 429 status", async () => {
  const fail = (status, message, headers = {}) => new Response(JSON.stringify({ error: { message } }), { status, headers });
  await withProviders(
    { AI_PROVIDER: "gemini", GEMINI_API_KEY: "k", AI_FALLBACK_PROVIDER: "groq", GROQ_API_KEY: "g" },
    (call) => call.url.includes("generativelanguage") ? fail(404, "model not found") : fail(429, "slow down", { "Retry-After": "12" }),
    async () => {
      const error = await getAIClient().chat.completions.create({ messages: [{ role: "user", content: "Hi" }] }).catch((e) => e);
      assert.equal(error.name, "AIProviderError");
      assert.equal(error.status, 429);
      assert.equal(error.retryAfter, "12");
      assert.equal(error.primaryError.status, 404);
      assert.equal(error.primaryError.message, "model not found");
      assert.equal(error.fallbackError.status, 429);
      assert.doesNotMatch(error.message, /model|quota|llama/i);
    }
  );
  await withProviders(
    { AI_PROVIDER: "gemini", GEMINI_API_KEY: "k", AI_FALLBACK_PROVIDER: "groq", GROQ_API_KEY: "g" },
    () => fail(404, "The model llama-3.3-70b-versatile does not exist"),
    async () => {
      const error = await getAIClient().chat.completions.create({ messages: [{ role: "user", content: "Hi" }] }).catch((e) => e);
      assert.equal(error.status, 503);
    }
  );
});

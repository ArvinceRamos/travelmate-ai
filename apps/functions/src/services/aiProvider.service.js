"use strict";

const logger = require("firebase-functions/logger");

class AIProviderError extends Error {
  constructor(message, { status = 502, retryAfter = null } = {}) {
    super(message);
    this.name = "AIProviderError";
    this.status = status;
    this.retryAfter = retryAfter;
  }
}

function providerDefaultBase(provider) {
  if (provider === "openai") return "https://api.openai.com/v1";
  if (provider === "groq") return "https://api.groq.com/openai/v1";
  if (provider === "gemini") return "https://generativelanguage.googleapis.com/v1beta";
  return "http://127.0.0.1:11434";
}

function providerDefaultModel(provider) {
  if (provider === "openai") return "gpt-4o-mini";
  if (provider === "gemini") return "gemini-3.5-flash-lite";
  if (provider === "groq") return "openai/gpt-oss-120b";
  return "qwen2.5:7b";
}

function settingsFor(provider, fallback = false) {
  const prefix = fallback ? "AI_FALLBACK_" : "AI_";
  const selected = String(provider || process.env.AI_PROVIDER || "ollama").trim().toLowerCase();
  const baseUrl = String(
    process.env[`${prefix}BASE_URL`] ||
      (fallback ? "" : process.env.AI_BASE_URL) ||
      providerDefaultBase(selected)
  ).replace(/\/+$/, "");
  const model = String(
    process.env[`${prefix}MODEL`] || (fallback ? "" : process.env.AI_MODEL) || providerDefaultModel(selected)
  ).trim();
  const apiKey = selected === "openai"
    ? process.env.OPENAI_API_KEY || ""
    : selected === "gemini"
      ? process.env.GEMINI_API_KEY || ""
      : selected === "groq"
        ? process.env.GROQ_API_KEY || ""
        : "";
  return { provider: selected, baseUrl, model, apiKey };
}

function validateJsonMode(content, responseFormat) {
  if (!responseFormat || !["json_object", "json_schema"].includes(responseFormat.type)) return;
  try {
    const value = JSON.parse(content);
    if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Expected a JSON object");
  } catch {
    throw new AIProviderError("The AI provider returned invalid JSON.", { status: 502 });
  }
}

function schemaFromFormat(responseFormat) {
  return responseFormat?.type === "json_schema"
    ? responseFormat.json_schema?.schema || null
    : null;
}

// Gemini's responseJsonSchema accepts standard JSON Schema (nullable type arrays,
// additionalProperties) but only string/number enum values; nulls stay allowed via the type.
function geminiJsonSchema(schema) {
  if (Array.isArray(schema)) return schema.map(geminiJsonSchema);
  if (!schema || typeof schema !== "object") return schema;
  const out = {};
  for (const [key, value] of Object.entries(schema)) {
    out[key] = key === "enum" && Array.isArray(value)
      ? value.filter((item) => item !== null)
      : geminiJsonSchema(value);
  }
  return out;
}

async function fetchProvider(url, options, timeoutMs = 45_000) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, { ...options, signal: controller.signal });
    const text = await response.text();
    let data = null;
    try { data = text ? JSON.parse(text) : null; } catch {}
    if (!response.ok) {
      const retryAfter = response.headers.get("retry-after");
      throw new AIProviderError(
        response.status === 429
          ? "The AI provider is rate-limited. Please retry shortly."
          : String(data?.error?.message || data?.error || "AI provider request failed."),
        { status: response.status, retryAfter }
      );
    }
    return data;
  } catch (error) {
    if (error instanceof AIProviderError) throw error;
    if (error?.name === "AbortError") throw new AIProviderError("The AI provider request timed out.", { status: 504 });
    throw new AIProviderError("Could not connect to the AI provider.", { status: 502 });
  } finally {
    clearTimeout(timeout);
  }
}

async function requestCompletion(settings, request, timeoutMs) {
  const { provider, baseUrl, model, apiKey } = settings;
  const responseFormat = request.response_format;
  if (provider !== "ollama" && !apiKey) {
    throw new AIProviderError(`Missing ${provider.toUpperCase()}_API_KEY on the backend.`, { status: 503 });
  }

  let content;
  if (provider === "openai" || provider === "groq") {
    // Groq supports json_schema only on its gpt-oss models; ask the others for plain JSON mode.
    const gptOss = /gpt-oss/i.test(model);
    const format = provider === "groq" && !gptOss && responseFormat?.type === "json_schema" ? { type: "json_object" } : responseFormat;
    const data = await fetchProvider(`${baseUrl}/chat/completions`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        model,
        messages: request.messages,
        temperature: request.temperature,
        max_completion_tokens: request.max_completion_tokens,
        // gpt-oss reasons before answering and those tokens count against max_completion_tokens.
        ...(gptOss ? { reasoning_effort: "low" } : {}),
        ...(format ? { response_format: format } : {}),
      }),
    }, timeoutMs);
    content = data?.choices?.[0]?.message?.content;
  } else if (provider === "gemini") {
    const system = request.messages.filter((message) => message.role === "system").map((message) => message.content).join("\n\n");
    const contents = request.messages.filter((message) => message.role !== "system").map((message) => ({
      role: message.role === "assistant" ? "model" : "user",
      parts: [{ text: String(message.content || "") }],
    }));
    const generationConfig = {
      temperature: request.temperature,
      maxOutputTokens: request.max_completion_tokens,
      ...(responseFormat?.type === "json_object" || responseFormat?.type === "json_schema"
        ? { responseMimeType: "application/json" }
        : {}),
      ...(schemaFromFormat(responseFormat) ? { responseJsonSchema: geminiJsonSchema(schemaFromFormat(responseFormat)) } : {}),
    };
    const data = await fetchProvider(`${baseUrl}/models/${encodeURIComponent(model)}:generateContent`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-goog-api-key": apiKey },
      body: JSON.stringify({
        ...(system ? { systemInstruction: { parts: [{ text: system }] } } : {}),
        contents,
        generationConfig,
      }),
    }, timeoutMs);
    content = (data?.candidates?.[0]?.content?.parts || []).map((part) => part.text || "").join("");
  } else if (provider === "ollama") {
    const data = await fetchProvider(`${baseUrl}/api/chat`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model,
        messages: request.messages,
        stream: false,
        ...(responseFormat?.type === "json_object" ? { format: "json" } : {}),
        ...(schemaFromFormat(responseFormat) ? { format: schemaFromFormat(responseFormat) } : {}),
        options: { temperature: request.temperature, num_predict: request.max_completion_tokens },
      }),
    }, timeoutMs);
    content = data?.message?.content;
  } else {
    throw new AIProviderError(`Unsupported AI_PROVIDER: ${provider}`, { status: 400 });
  }

  const normalizedContent = String(content || "").trim();
  if (!normalizedContent) throw new AIProviderError("The AI provider returned an empty response.", { status: 502 });
  validateJsonMode(normalizedContent, responseFormat);
  return { choices: [{ message: { content: normalizedContent } }] };
}

function failureDetails(settings, error) {
  return {
    provider: settings.provider,
    model: settings.model,
    status: Number(error?.status) || null,
    message: String(error?.message || error || "").slice(0, 300),
  };
}

async function complete(request, options = {}) {
  const primary = settingsFor(process.env.AI_PROVIDER || "ollama");
  const timeoutMs = Number(options?.timeout) || undefined;
  try {
    return await requestCompletion(primary, request, timeoutMs);
  } catch (primaryError) {
    const fallbackProvider = String(process.env.AI_FALLBACK_PROVIDER || "").trim().toLowerCase();
    const fallback = fallbackProvider ? settingsFor(fallbackProvider, true) : null;
    // A second model on the same provider (e.g. another Gemini Flash-Lite) has its own free quota.
    if (!fallback || (fallback.provider === primary.provider && fallback.model === primary.model)) {
      logger.warn("[ai] provider failed", failureDetails(primary, primaryError));
      throw primaryError;
    }
    try {
      return await requestCompletion(fallback, request, timeoutMs);
    } catch (fallbackError) {
      logger.warn("[ai] primary and fallback providers failed", {
        primary: failureDetails(primary, primaryError),
        fallback: failureDetails(fallback, fallbackError),
      });
      const rateLimited = [primaryError, fallbackError].find((error) => error?.status === 429);
      const timedOut = primaryError?.status === 504 && fallbackError?.status === 504;
      const error = new AIProviderError("All AI providers failed.", {
        status: rateLimited ? 429 : timedOut ? 504 : 503,
        retryAfter: rateLimited?.retryAfter || null,
      });
      error.primaryError = primaryError;
      error.fallbackError = fallbackError;
      throw error;
    }
  }
}

function getAIClient() {
  return { chat: { completions: { create: complete } } };
}

module.exports = { AIProviderError, getAIClient, complete, settingsFor, validateJsonMode };

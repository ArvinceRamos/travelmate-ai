"use strict";

class AIProviderError extends Error {
  constructor(message, { status = 502, retryAfter = null } = {}) {
    super(message);
    this.name = "AIProviderError";
    this.status = status;
    this.retryAfter = retryAfter;
  }
}

function providerDefaultBase(provider) {
  if (provider === "gemini") return "https://generativelanguage.googleapis.com/v1beta";
  return "http://127.0.0.1:11434";
}

function providerDefaultModel(provider) {
  if (provider === "gemini") return "gemini-2.5-flash";
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
  const apiKey = selected === "gemini" ? process.env.GEMINI_API_KEY || "" : "";
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

async function requestCompletion(settings, request) {
  const { provider, baseUrl, model, apiKey } = settings;
  const responseFormat = request.response_format;
  if (provider !== "ollama" && !apiKey) {
    throw new AIProviderError(`Missing ${provider.toUpperCase()}_API_KEY on the backend.`, { status: 503 });
  }

  let content;
  if (provider === "gemini") {
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
      ...(schemaFromFormat(responseFormat) ? { responseSchema: schemaFromFormat(responseFormat) } : {}),
    };
    const params = new URLSearchParams({ key: apiKey });
    const data = await fetchProvider(`${baseUrl}/models/${encodeURIComponent(model)}:generateContent?${params}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        ...(system ? { systemInstruction: { parts: [{ text: system }] } } : {}),
        contents,
        generationConfig,
      }),
    });
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
    });
    content = data?.message?.content;
  } else {
    throw new AIProviderError(`Unsupported AI_PROVIDER: ${provider}`, { status: 400 });
  }

  const normalizedContent = String(content || "").trim();
  if (!normalizedContent) throw new AIProviderError("The AI provider returned an empty response.", { status: 502 });
  validateJsonMode(normalizedContent, responseFormat);
  return { choices: [{ message: { content: normalizedContent } }] };
}

async function complete(request) {
  const primary = settingsFor(process.env.AI_PROVIDER || "ollama");
  try {
    return await requestCompletion(primary, request);
  } catch (primaryError) {
    const fallbackProvider = String(process.env.AI_FALLBACK_PROVIDER || "").trim().toLowerCase();
    if (!fallbackProvider || fallbackProvider === primary.provider) throw primaryError;
    const fallback = settingsFor(fallbackProvider, true);
    return requestCompletion(fallback, request);
  }
}

function getAIClient() {
  return { chat: { completions: { create: complete } } };
}

module.exports = { AIProviderError, getAIClient, complete, settingsFor, validateJsonMode };

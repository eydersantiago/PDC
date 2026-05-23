import type { OllamaGenerateRequest, OllamaGenerateResponse } from "./types.js";

const LOCAL_OLLAMA_HOSTS = new Set(["127.0.0.1", "localhost", "::1"]);

function getAbortSignal(timeoutMs: number) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  return { signal: controller.signal, clear: () => clearTimeout(timer) };
}

export function normalizeOllamaBaseUrl(value: string) {
  const baseUrl = value.trim().replace(/\/+$/, "");
  const parsed = new URL(baseUrl);
  const hostname = parsed.hostname.replace(/^\[|\]$/g, "");

  if (!LOCAL_OLLAMA_HOSTS.has(hostname)) {
    throw new Error(
      "OLLAMA_BASE_URL debe apuntar a localhost/127.0.0.1 para no exponer Ollama publicamente.",
    );
  }

  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new Error("OLLAMA_BASE_URL debe usar http o https.");
  }

  return baseUrl;
}

export async function generateWithOllama(params: {
  baseUrl: string;
  model: string;
  prompt: string;
  images?: string[];
  options?: Record<string, unknown>;
  context?: number;
  timeoutMs: number;
  maxOutputChars?: number | null;
}) {
  const payload: OllamaGenerateRequest = {
    model: params.model,
    prompt: params.prompt,
    stream: false,
  };

  if (params.images?.length) {
    payload.images = params.images;
  }

  const options = {
    ...(params.context ? { num_ctx: params.context } : {}),
    ...(params.options || {}),
  };

  if (Object.keys(options).length > 0) {
    payload.options = options;
  }

  const timeout = getAbortSignal(params.timeoutMs);
  let bodyText = "";

  try {
    const response = await fetch(`${params.baseUrl}/api/generate`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
      signal: timeout.signal,
    });

    bodyText = await response.text();
    if (!response.ok) {
      throw new Error(`Ollama HTTP ${response.status}: ${bodyText.slice(0, 1000)}`);
    }
  } catch (error) {
    if (timeout.signal.aborted) {
      throw new Error(`Timeout llamando a Ollama despues de ${params.timeoutMs} ms.`);
    }
    throw error;
  } finally {
    timeout.clear();
  }

  let data: OllamaGenerateResponse;
  try {
    data = JSON.parse(bodyText) as OllamaGenerateResponse;
  } catch {
    return params.maxOutputChars
      ? bodyText.slice(0, Math.max(1, params.maxOutputChars))
      : bodyText;
  }

  const output = typeof data.response === "string"
    ? data.response
    : JSON.stringify(data);

  return params.maxOutputChars
    ? output.slice(0, Math.max(1, params.maxOutputChars))
    : output;
}

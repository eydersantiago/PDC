import OpenAI from "openai";
import {
  createDiagnosticLogger,
  durationMs,
  errorSummary,
  shortId,
  textStats,
} from "./src/services/diagnostics.js";
import type { AgentRunDiagnostics } from "./src/services/service-bus-agent.js";
import {
  ADACEEN_SYSTEM_PROMPT,
  resolveTextGeneration,
  type ResolvedTextGeneration,
  type TextGenerationOptions,
} from "./src/services/text-generation.js";

// Revision de precision (21/10/2026): el texto se pide sin el agente generico de antes (su
// formato contradecia el de cada prompt), con perfil de generacion (temperatura, tope de salida,
// JSON) y con la ventana de contexto explicita. Con Ollama se usa su API nativa (/api/chat), la
// unica que acepta num_ctx: por la compatible con OpenAI, Ollama usa su ventana por defecto y
// corta en silencio el comienzo de un prompt largo. Con otro servidor (llama-server del cluster
// de Mac, que ya fija -c) se usa la API compatible con OpenAI.

function buildOpenAiCompatibleBaseUrl() {
  const explicit = process.env.OPENAI_BASE?.trim();
  if (explicit) return explicit;

  const ollamaBase = process.env.OLLAMA_BASE_URL?.trim();
  if (ollamaBase) {
    const clean = ollamaBase.replace(/\/+$/g, "");
    return clean.endsWith("/v1") ? clean : `${clean}/v1`;
  }

  return "http://127.0.0.1:11434/v1";
}

/** Base de la API nativa de Ollama, o "" si el servidor no es Ollama (TEXT_MODEL_API=openai). */
export function resolveOllamaNativeBase(envVars: NodeJS.ProcessEnv = process.env) {
  const api = String(envVars.TEXT_MODEL_API || "").trim().toLowerCase();
  if (api === "openai") return "";
  const ollamaBase = String(envVars.OLLAMA_BASE_URL || "").trim();
  if (ollamaBase) return ollamaBase.replace(/\/+$/g, "").replace(/\/v1$/, "");
  if (api === "ollama") {
    return buildOpenAiCompatibleBaseUrl().replace(/\/+$/g, "").replace(/\/v1$/, "");
  }
  // Sin OLLAMA_BASE_URL: Ollama solo si OPENAI_BASE apunta a su puerto por defecto.
  const openAiBase = String(envVars.OPENAI_BASE || "").trim();
  if (!openAiBase || /:11434(\/|$)/.test(openAiBase)) {
    return (openAiBase || "http://127.0.0.1:11434").replace(/\/+$/g, "").replace(/\/v1$/, "");
  }
  return "";
}

const baseURL = buildOpenAiCompatibleBaseUrl();
const apiKey = process.env.OPENAI_API_KEY || "dummy";
const modelId = process.env.MODEL_TEXT || process.env.OLLAMA_MODEL || "qwen2.5-coder:7b";

let openAiClient: { baseURL: string; client: OpenAI } | null = null;
/** El cliente de la API compatible con OpenAI; la URL se lee al crearlo (las pruebas la cambian). */
function getOpenAiClient() {
  const currentBaseUrl = buildOpenAiCompatibleBaseUrl();
  if (!openAiClient || openAiClient.baseURL !== currentBaseUrl) {
    openAiClient = { baseURL: currentBaseUrl, client: new OpenAI({ apiKey, baseURL: currentBaseUrl }) };
  }
  return openAiClient.client;
}

const textLog = createDiagnosticLogger("run-text", {
  modelId,
  baseURL,
});

/**
 * Cuerpo de /api/chat de Ollama para un pedido (exportado para las pruebas). stream: true solo
 * para la respuesta en vivo (01-11-2026, job.stream); sin el, igual que siempre.
 */
export function buildOllamaChatBody(input: string, settings: ResolvedTextGeneration, model = modelId, stream = false) {
  return {
    model,
    stream,
    keep_alive: -1,
    messages: [
      { role: "system", content: ADACEEN_SYSTEM_PROMPT },
      { role: "user", content: input },
    ],
    ...(settings.json ? { format: "json" } : {}),
    options: {
      num_ctx: settings.numCtx,
      temperature: settings.temperature,
      top_p: settings.topP,
      top_k: settings.topK,
      repeat_penalty: settings.repeatPenalty,
      num_predict: settings.maxTokens,
      ...(settings.seed !== null ? { seed: settings.seed } : {}),
    },
  };
}

type OllamaChatResponse = {
  message?: { content?: unknown };
  done_reason?: unknown;
  prompt_eval_count?: unknown;
  eval_count?: unknown;
};

function textModelTimeoutMs(override?: number) {
  if (override && override > 0) return override;
  return Math.max(30000, Number(process.env.TEXT_MODEL_TIMEOUT_MS) || 300000);
}

async function runOllamaNative(base: string, input: string, settings: ResolvedTextGeneration, timeoutOverride?: number) {
  const timeoutMs = textModelTimeoutMs(timeoutOverride);
  const response = await fetch(`${base}/api/chat`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(buildOllamaChatBody(input, settings)),
    signal: AbortSignal.timeout(timeoutMs),
  });
  const bodyText = await response.text();
  if (!response.ok) throw new Error(`Ollama /api/chat HTTP ${response.status}: ${bodyText.slice(0, 300)}`);
  const data = JSON.parse(bodyText) as OllamaChatResponse;
  return {
    text: String(data.message?.content ?? ""),
    finishReason: String(data.done_reason ?? ""),
    promptTokens: Number(data.prompt_eval_count) || 0,
    outputTokens: Number(data.eval_count) || 0,
  };
}

/** Una linea del NDJSON de /api/chat con stream: true. */
type OllamaChatChunk = OllamaChatResponse & { done?: unknown; error?: unknown };

/**
 * Lee un cuerpo NDJSON por lineas completas (las que llegan cortadas entre dos trozos se juntan).
 * Exportado para las pruebas.
 */
export async function* readNdjsonLines(body: ReadableStream<Uint8Array>) {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      let newline = buffer.indexOf("\n");
      while (newline >= 0) {
        const line = buffer.slice(0, newline).trim();
        buffer = buffer.slice(newline + 1);
        if (line) yield line;
        newline = buffer.indexOf("\n");
      }
    }
    buffer += decoder.decode();
    if (buffer.trim()) yield buffer.trim();
  } finally {
    reader.releaseLock();
  }
}

/**
 * /api/chat con stream: true (respuesta en vivo, 01-11-2026): va juntando el texto y avisa con el
 * acumulado. Al final, lo mismo que sin stream: el texto completo, done_reason y los tokens de la
 * ultima linea. El plazo (AbortSignal.timeout) corta tambien la lectura del cuerpo.
 */
async function runOllamaNativeStream(
  base: string,
  input: string,
  settings: ResolvedTextGeneration,
  onText: (accumulated: string) => void,
  timeoutOverride?: number,
) {
  const timeoutMs = textModelTimeoutMs(timeoutOverride);
  const response = await fetch(`${base}/api/chat`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(buildOllamaChatBody(input, settings, modelId, true)),
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!response.ok || !response.body) {
    const bodyText = await response.text().catch(() => "");
    throw new Error(`Ollama /api/chat HTTP ${response.status}: ${bodyText.slice(0, 300)}`);
  }
  let text = "";
  let finishReason = "";
  let promptTokens = 0;
  let outputTokens = 0;
  for await (const line of readNdjsonLines(response.body)) {
    let chunk: OllamaChatChunk;
    try {
      chunk = JSON.parse(line) as OllamaChatChunk;
    } catch {
      throw new Error(`Ollama /api/chat devolvio una linea que no es JSON: ${line.slice(0, 120)}`);
    }
    if (chunk.error) throw new Error(`Ollama /api/chat: ${String(chunk.error).slice(0, 300)}`);
    const piece = String(chunk.message?.content ?? "");
    if (piece) {
      text += piece;
      safeNotify(onText, text);
    }
    if (chunk.done === true) {
      finishReason = String(chunk.done_reason ?? "");
      promptTokens = Number(chunk.prompt_eval_count) || 0;
      outputTokens = Number(chunk.eval_count) || 0;
    }
  }
  return { text, finishReason, promptTokens, outputTokens };
}

/** Un aviso de texto parcial nunca tumba la generacion. */
function safeNotify(onText: (accumulated: string) => void, text: string) {
  try {
    onText(text);
  } catch {
    // El que publica los parciales ya cuenta sus fallos.
  }
}

async function runOpenAiCompatible(input: string, settings: ResolvedTextGeneration, timeoutOverride?: number) {
  const completion = await getOpenAiClient().chat.completions.create({
    model: modelId,
    messages: [
      { role: "system", content: ADACEEN_SYSTEM_PROMPT },
      { role: "user", content: input },
    ],
    temperature: settings.temperature,
    top_p: settings.topP,
    max_tokens: settings.maxTokens,
    ...(settings.seed !== null ? { seed: settings.seed } : {}),
    ...(settings.json ? { response_format: { type: "json_object" as const } } : {}),
  }, { timeout: textModelTimeoutMs(timeoutOverride) });
  const choice = completion.choices[0];
  return {
    text: String(choice?.message?.content ?? ""),
    finishReason: String(choice?.finish_reason ?? ""),
    promptTokens: Number(completion.usage?.prompt_tokens) || 0,
    outputTokens: Number(completion.usage?.completion_tokens) || 0,
  };
}

/** Lo mismo por la API compatible con OpenAI (llama-server de las Mac), con stream: true. */
async function runOpenAiCompatibleStream(
  input: string,
  settings: ResolvedTextGeneration,
  onText: (accumulated: string) => void,
  timeoutOverride?: number,
) {
  const stream = await getOpenAiClient().chat.completions.create({
    model: modelId,
    messages: [
      { role: "system", content: ADACEEN_SYSTEM_PROMPT },
      { role: "user", content: input },
    ],
    temperature: settings.temperature,
    top_p: settings.topP,
    max_tokens: settings.maxTokens,
    stream: true,
    ...(settings.seed !== null ? { seed: settings.seed } : {}),
    ...(settings.json ? { response_format: { type: "json_object" as const } } : {}),
    // El timeout del SDK solo cubre hasta las cabeceras: la senal corta tambien la lectura del
    // cuerpo (un servidor que deja de mandar tokens no deja el trabajo colgado).
  }, { timeout: textModelTimeoutMs(timeoutOverride), signal: AbortSignal.timeout(textModelTimeoutMs(timeoutOverride)) });
  let text = "";
  let finishReason = "";
  let promptTokens = 0;
  let outputTokens = 0;
  for await (const chunk of stream) {
    const choice = chunk.choices?.[0];
    const piece = String(choice?.delta?.content ?? "");
    if (piece) {
      text += piece;
      safeNotify(onText, text);
    }
    if (choice?.finish_reason) finishReason = String(choice.finish_reason);
    if (chunk.usage) {
      promptTokens = Number(chunk.usage.prompt_tokens) || promptTokens;
      outputTokens = Number(chunk.usage.completion_tokens) || outputTokens;
    }
  }
  return { text, finishReason, promptTokens, outputTokens };
}

export async function runText(
  input: string,
  diagnostics: AgentRunDiagnostics = {},
  generation: TextGenerationOptions = {},
  /** Tope de espera de este pedido (ms); sin el, TEXT_MODEL_TIMEOUT_MS (300 s). */
  timeoutMs?: number,
  /**
   * Respuesta en vivo (01-11-2026): con este aviso el modelo responde por partes (stream) y se
   * avisa con el texto acumulado; el valor devuelto es el mismo que sin el. Sin el, como siempre.
   */
  onText?: (accumulatedText: string) => void,
) {
  const startedAt = Date.now();
  const settings = resolveTextGeneration(generation);
  const nativeBase = resolveOllamaNativeBase();
  const logger = textLog.child({
    requestId: shortId(diagnostics.requestId, 64),
    route: diagnostics.route || "",
    scope: diagnostics.scope || "",
    profile: settings.profile,
    api: nativeBase ? "ollama" : "openai",
    stream: Boolean(onText),
  });
  logger.info("text.model.start", {
    input: textStats(input),
    numCtx: settings.numCtx,
    temperature: settings.temperature,
    maxTokens: settings.maxTokens,
    json: settings.json,
  });

  try {
    const result = onText
      ? (nativeBase
        ? await runOllamaNativeStream(nativeBase, input, settings, onText, timeoutMs)
        : await runOpenAiCompatibleStream(input, settings, onText, timeoutMs))
      : (nativeBase
        ? await runOllamaNative(nativeBase, input, settings, timeoutMs)
        : await runOpenAiCompatible(input, settings, timeoutMs));
    if (!result.text.trim()) throw new Error("Sin salida del modelo");
    // prompt_eval_count cerca de num_ctx: el prompt casi no cupo (Ollama corta el comienzo).
    const nearContextLimit = result.promptTokens > 0 && result.promptTokens >= settings.numCtx - 64;
    const log = nearContextLimit || result.finishReason === "length" ? logger.warn : logger.info;
    log.call(logger, "text.model.done", {
      durationMs: durationMs(startedAt),
      promptTokens: result.promptTokens,
      outputTokens: result.outputTokens,
      finishReason: result.finishReason,
      nearContextLimit,
      output: textStats(result.text),
    });
    return result.text;
  } catch (error) {
    logger.error("text.model.failed", {
      durationMs: durationMs(startedAt),
      error: errorSummary(error),
    });
    throw error;
  }
}

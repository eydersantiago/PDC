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

let openAiClient: OpenAI | null = null;
function getOpenAiClient() {
  if (!openAiClient) openAiClient = new OpenAI({ apiKey, baseURL });
  return openAiClient;
}

const textLog = createDiagnosticLogger("run-text", {
  modelId,
  baseURL,
});

/** Cuerpo de /api/chat de Ollama para un pedido (exportado para las pruebas). */
export function buildOllamaChatBody(input: string, settings: ResolvedTextGeneration, model = modelId) {
  return {
    model,
    stream: false,
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

export async function runText(
  input: string,
  diagnostics: AgentRunDiagnostics = {},
  generation: TextGenerationOptions = {},
  /** Tope de espera de este pedido (ms); sin el, TEXT_MODEL_TIMEOUT_MS (300 s). */
  timeoutMs?: number,
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
  });
  logger.info("text.model.start", {
    input: textStats(input),
    numCtx: settings.numCtx,
    temperature: settings.temperature,
    maxTokens: settings.maxTokens,
    json: settings.json,
  });

  try {
    const result = nativeBase
      ? await runOllamaNative(nativeBase, input, settings, timeoutMs)
      : await runOpenAiCompatible(input, settings, timeoutMs);
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

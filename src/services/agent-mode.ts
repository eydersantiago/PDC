import fsp from "node:fs/promises";
import path from "node:path";
import { runImage } from "../../runImage.js";
import { runText } from "../../runText.js";
import { env, isAzureMode, isQueueMode } from "../config/env.js";
import {
  createDiagnosticLogger,
  durationMs,
  errorSummary,
  shortId,
  textStats,
} from "./diagnostics.js";
import {
  runQueueAgentJob,
  runQueueAgentJobDetailed,
  type AgentRunDiagnostics,
} from "./service-bus-agent.js";
import { serializableGeneration, type TextGenerationOptions } from "./text-generation.js";
import { stripForeignScript } from "./text-utils.js";
import { requestGpuStart, TUTOR_UNAVAILABLE_MESSAGE, tutorStartingMessage } from "./gpu-autostart.js";
import { isQueueSuspect } from "./queue-health.js";
import { aliveWorkerProgress, isInferenceKnownDown } from "./worker-heartbeat.js";
import {
  describeWorker,
  recordWorker,
  type WorkerIdentity,
} from "./worker-identity.js";

type UploadedImage = {
  path: string;
  mimetype?: string;
  originalname?: string;
};

async function parseJsonResponse(response: Response, label: string) {
  const bodyText = await response.text();
  if (!response.ok) {
    throw new Error(`${label} HTTP ${response.status}: ${bodyText}`);
  }

  try {
    return JSON.parse(bodyText) as {
      output_text?: unknown;
      worker?: { id?: unknown } | null;
    };
  } catch {
    throw new Error(`${label} devolvio una respuesta no JSON`);
  }
}

/**
 * Igual que runTextByMode, pero ademas devuelve quien atendio el job.
 *
 * En modo queue el id lo pone el worker (QUEUE_WORKER_ID) y llega dentro
 * del resultado. En modo azure se propaga el que reporte el backend
 * remoto, de forma que un encadenado azure -> queue sigue diciendo la
 * verdad sobre la maquina que puso la GPU.
 */
/**
 * Sustituto del modelo para pruebas y para la demo reproducible
 * (scripts/demo-escenarios.ts): permite correr los escenarios sin GPU.
 * En produccion siempre es null.
 */
/**
 * El camino de inferencia esta caido (A12.10); quien llama usa su respaldo.
 * code gpu_encendiendo (28-10-2026): no habia servidor vivo y ya se pidio encender la GPU
 * (gpu-autostart.ts): quien llama le dice al estudiante que vuelva en 2 o 3 minutos.
 */
export class InferenceUnavailableError extends Error {
  readonly code: "sin_worker" | "gpu_encendiendo";
  constructor(message: string, code: "sin_worker" | "gpu_encendiendo" = "sin_worker") {
    super(message);
    this.name = "InferenceUnavailableError";
    this.code = code;
  }
}

/** El tutor no respondio porque la GPU se esta encendiendo (no porque fallara). */
export function isTutorStartingError(error: unknown) {
  return error instanceof InferenceUnavailableError && error.code === "gpu_encendiendo";
}

/**
 * Que decirle al estudiante cuando no hay servidor del modelo: que vuelva en 2 o 3 minutos (la GPU
 * enciende) o que el tutor no esta disponible. Vacio para otros fallos del modelo (el overlay sigue
 * con sus pistas generales, como antes).
 */
export function describeTutorOutage(error: unknown, now: Date = new Date()) {
  if (isTutorStartingError(error)) return tutorStartingMessage(now);
  if (error instanceof InferenceUnavailableError) return TUTOR_UNAVAILABLE_MESSAGE;
  return "";
}

/**
 * Sin servidor vivo: no se encola (la respuesta no llegaria). Si el pedido es de alguien
 * identificado (wakeGpu: sesion o cliente de VS Code) y GPU_AUTOSTART esta activo, se pide encender
 * una GPU y el error dice si quedo encendiendose. Un pedido anonimo (/run-text) no la despierta.
 */
async function inferenceDownError(kind: "texto" | "imagen", wakeGpu: boolean) {
  const start = wakeGpu ? await requestGpuStart(`pedido de ${kind} sin servidor vivo`) : null;
  if (start?.state === "starting") {
    return new InferenceUnavailableError(`Ningun worker de GPU tiene latido reciente: se esta encendiendo ${start.vm || "una GPU"}.`, "gpu_encendiendo");
  }
  return new InferenceUnavailableError(`Ningun worker de GPU tiene latido reciente: no se encola el job${start ? ` (no se pudo encender: ${start.detail})` : ""}.`);
}

export type TextModelOverride = (
  input: string,
  diagnostics: AgentRunDiagnostics,
  generation?: TextGenerationOptions,
) => Promise<string>;
let textModelOverride: TextModelOverride | null = null;

export function setTextModelOverrideForTests(override: TextModelOverride | null) {
  textModelOverride = override;
}

export function hasTextModelOverride() {
  return textModelOverride !== null;
}

export async function runTextByModeDetailed(
  input: string,
  diagnostics: AgentRunDiagnostics = {},
  generation?: TextGenerationOptions,
  /**
   * timeoutMs: tope de espera de este pedido (el reintento de /suggest-tab no puede pasarse del
   * de VS Code). wakeGpu: sin servidor vivo, pedir encender la GPU (pedido de un estudiante
   * identificado; ver inferenceDownError).
   */
  options: { timeoutMs?: number; wakeGpu?: boolean } = {},
): Promise<{ outputText: string; worker: WorkerIdentity }> {
  const timeoutMs = Number.isFinite(Number(options.timeoutMs)) && Number(options.timeoutMs) > 0
    ? Math.max(1000, Math.floor(Number(options.timeoutMs)))
    : undefined;
  if (textModelOverride) {
    const outputText = stripForeignScript(await textModelOverride(input, diagnostics, generation));
    return { outputText, worker: describeWorker("local-prueba", { mode: "local" }) };
  }
  const startedAt = Date.now();
  const logger = createDiagnosticLogger("agent-mode", {
    kind: "text",
    mode: env.targetMode,
    requestId: shortId(diagnostics.requestId, 64),
    route: diagnostics.route || "",
    scope: diagnostics.scope || "",
  });
  logger.info("agent.text.start", {
    input: textStats(input),
  });

  try {
    let output = "";
    let workerId = "";
    if (isQueueMode()) {
      if (isInferenceKnownDown()) {
        throw await inferenceDownError("texto", options.wakeGpu === true);
      }
      // La cola no esta llegando al worker (queue-health.ts): mejor el respaldo ya que 120 s de espera.
      if (isQueueSuspect({ progressNow: aliveWorkerProgress() })) {
        throw new InferenceUnavailableError("La cola no esta llegando al worker de GPU (sin respuesta reciente): se usa el respaldo.");
      }
      const result = await runQueueAgentJobDetailed({
        kind: "text",
        inputText: input,
        generation,
        diagnostics,
        ...(timeoutMs ? { timeoutMs } : {}),
      });
      output = result.outputText;
      workerId = result.workerId || "";
    } else if (!isAzureMode()) {
      output = await runText(input, diagnostics, generation, timeoutMs);
    } else {
      if (!env.azureServer) {
        throw new Error("Falta AZURE_SERVER_URL para AGENT_TARGET=azure");
      }

      const azureStartedAt = Date.now();
      logger.info("agent.text.azure.request.start", {
        azureServer: env.azureServer,
      });
      const response = await fetch(`${env.azureServer}/run-text`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          ...(diagnostics.requestId ? { "x-request-id": diagnostics.requestId } : {}),
        },
        body: JSON.stringify({ input_as_text: input, ...(serializableGeneration(generation) ? { generation: serializableGeneration(generation) } : {}) }),
        ...(timeoutMs ? { signal: AbortSignal.timeout(timeoutMs) } : {}),
      });
      logger.info("agent.text.azure.request.done", {
        durationMs: durationMs(azureStartedAt),
        status: response.status,
        ok: response.ok,
      });

      const data = await parseJsonResponse(response, "Azure /run-text");
      output = String(data.output_text ?? "");
      // Si el backend remoto ya reporta worker, esa es la maquina real.
      workerId = String(data.worker?.id ?? "") || "azure";
    }

    // Sin caracteres chinos colados en la respuesta en espanol (text-utils.ts).
    output = stripForeignScript(output);
    const worker = describeWorker(workerId, { mode: env.targetMode });
    recordWorker(worker);
    logger.info("agent.text.done", {
      durationMs: durationMs(startedAt),
      output: textStats(output),
      worker: worker.id || worker.provider,
    });
    return { outputText: output, worker };
  } catch (error) {
    logger.error("agent.text.failed", {
      durationMs: durationMs(startedAt),
      error: errorSummary(error),
    });
    throw error;
  }
}

export async function runTextByMode(
  input: string,
  diagnostics: AgentRunDiagnostics = {},
  generation?: TextGenerationOptions,
) {
  const result = await runTextByModeDetailed(input, diagnostics, generation);
  return result.outputText;
}

export async function runImageByMode(
  file: UploadedImage,
  prompt: string,
  diagnostics: AgentRunDiagnostics = {},
) {
  const startedAt = Date.now();
  const logger = createDiagnosticLogger("agent-mode", {
    kind: "image",
    mode: env.targetMode,
    requestId: shortId(diagnostics.requestId, 64),
    route: diagnostics.route || "",
  });
  logger.info("agent.image.start", {
    prompt: textStats(prompt),
    mimetype: file.mimetype || "",
    originalname: file.originalname || "",
  });

  try {
    let output = "";
    if (isQueueMode()) {
      if (isInferenceKnownDown()) {
        throw await inferenceDownError("imagen", false);
      }
      if (isQueueSuspect({ progressNow: aliveWorkerProgress() })) {
        throw new InferenceUnavailableError("La cola no esta llegando al worker de GPU: no se encola la imagen.");
      }
      const image = await fsp.readFile(file.path);
      output = await runQueueAgentJob({
        kind: "image",
        prompt,
        imageBase64: image.toString("base64"),
        imageMimeType: file.mimetype || "application/octet-stream",
        imageName: file.originalname || path.basename(file.path),
        diagnostics,
      });
    } else if (!isAzureMode()) {
      output = await runImage(file.path, prompt, diagnostics);
    } else {
      if (!env.azureServer) {
        throw new Error("Falta AZURE_SERVER_URL para AGENT_TARGET=azure");
      }

      const image = await fsp.readFile(file.path);
      const form = new FormData();
      form.set(
        "image",
        new Blob([image], { type: file.mimetype || "application/octet-stream" }),
        file.originalname || path.basename(file.path),
      );
      form.set("prompt", prompt);

      const azureStartedAt = Date.now();
      logger.info("agent.image.azure.request.start", {
        azureServer: env.azureServer,
        imageBytes: image.length,
      });
      const response = await fetch(`${env.azureServer}/run-image`, {
        method: "POST",
        headers: {
          ...(diagnostics.requestId ? { "x-request-id": diagnostics.requestId } : {}),
        },
        body: form,
      });
      logger.info("agent.image.azure.request.done", {
        durationMs: durationMs(azureStartedAt),
        status: response.status,
        ok: response.ok,
      });

      const data = await parseJsonResponse(response, "Azure /run-image");
      output = String(data.output_text ?? "");
    }

    logger.info("agent.image.done", {
      durationMs: durationMs(startedAt),
      output: textStats(output),
    });
    return output;
  } catch (error) {
    logger.error("agent.image.failed", {
      durationMs: durationMs(startedAt),
      error: errorSummary(error),
    });
    throw error;
  }
}

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
import { isInferenceKnownDown } from "./worker-heartbeat.js";
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
/** El camino de inferencia esta caido (A12.10); quien llama usa su respaldo. */
export class InferenceUnavailableError extends Error {
  readonly code = "sin_worker";
  constructor(message: string) {
    super(message);
    this.name = "InferenceUnavailableError";
  }
}

export type TextModelOverride = (input: string, diagnostics: AgentRunDiagnostics) => Promise<string>;
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
): Promise<{ outputText: string; worker: WorkerIdentity }> {
  if (textModelOverride) {
    const outputText = await textModelOverride(input, diagnostics);
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
        throw new InferenceUnavailableError("Ningun worker de GPU tiene latido reciente: no se encola el job.");
      }
      const result = await runQueueAgentJobDetailed({
        kind: "text",
        inputText: input,
        diagnostics,
      });
      output = result.outputText;
      workerId = result.workerId || "";
    } else if (!isAzureMode()) {
      output = await runText(input, diagnostics);
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
        body: JSON.stringify({ input_as_text: input }),
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

export async function runTextByMode(input: string, diagnostics: AgentRunDiagnostics = {}) {
  const result = await runTextByModeDetailed(input, diagnostics);
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

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
import { runQueueAgentJob, type AgentRunDiagnostics } from "./service-bus-agent.js";

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
    return JSON.parse(bodyText) as { output_text?: unknown };
  } catch {
    throw new Error(`${label} devolvio una respuesta no JSON`);
  }
}

export async function runTextByMode(input: string, diagnostics: AgentRunDiagnostics = {}) {
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
    if (isQueueMode()) {
      output = await runQueueAgentJob({
        kind: "text",
        inputText: input,
        diagnostics,
      });
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
    }

    logger.info("agent.text.done", {
      durationMs: durationMs(startedAt),
      output: textStats(output),
    });
    return output;
  } catch (error) {
    logger.error("agent.text.failed", {
      durationMs: durationMs(startedAt),
      error: errorSummary(error),
    });
    throw error;
  }
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

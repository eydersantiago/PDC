// src/runImage.ts
import fs from "node:fs/promises";
import path from "node:path";
import {
  createDiagnosticLogger,
  durationMs,
  errorSummary,
  shortId,
  textStats,
} from "./src/services/diagnostics.js";
import type { AgentRunDiagnostics } from "./src/services/service-bus-agent.js";

export async function runImage(imagePath: string, prompt: string, diagnostics: AgentRunDiagnostics = {}) {
  const startedAt = Date.now();
  const abs = path.resolve(imagePath);
  const b64 = (await fs.readFile(abs)).toString("base64"); // base64 puro

  const model = process.env.MODEL_VISION || process.env.OLLAMA_VISION_MODEL || "qwen2.5vl:7b-gpu";
  const base  = process.env.OLLAMA_URL || process.env.OLLAMA_BASE_URL || "http://127.0.0.1:11434";
  const visionNumGpu = Math.max(0, Number(process.env.OLLAMA_VISION_NUM_GPU || 24) || 24);
  const visionNumCtx = Math.max(256, Number(process.env.OLLAMA_VISION_NUM_CTX || 768) || 768);
  const visionNumBatch = Math.max(8, Number(process.env.OLLAMA_VISION_NUM_BATCH || 24) || 24);
  const logger = createDiagnosticLogger("run-image", {
    model,
    base,
    requestId: shortId(diagnostics.requestId, 64),
    route: diagnostics.route || "",
  });
  logger.info("image.model.start", {
    imagePath: abs,
    imageBytesApprox: Math.floor((b64.length * 3) / 4),
    prompt: textStats(prompt),
    options: {
      numGpu: visionNumGpu,
      numCtx: visionNumCtx,
      numBatch: visionNumBatch,
    },
  });

  try {
    const requestStartedAt = Date.now();
    const res = await fetch(`${base}/api/chat`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model,
        // 👇 desactiva streaming para que devuelva un JSON único
        stream: false,
        messages: [
          {
            role: "user",
            // 👇 content es STRING (no array)
            content: prompt || "Describe la imagen en 5 puntos y da 3 recomendaciones.",
            // 👇 imágenes: array de base64 PURO (sin data:image/...;base64,)
            images: [b64],
          }
        ],
        options: {
          temperature: 0.2,
          num_ctx: visionNumCtx,
          num_batch: visionNumBatch,
          ...(visionNumGpu > 0 ? { num_gpu: visionNumGpu } : {}),
        }
      }),
    });
    logger.info("image.model.http.done", {
      durationMs: durationMs(requestStartedAt),
      status: res.status,
      ok: res.ok,
    });

    if (!res.ok) throw new Error(`Vision HTTP ${res.status}: ${await res.text()}`);
    const data = await res.json(); // ahora sí es JSON
    const output = String(data?.message?.content ?? data?.response ?? "");
    logger.info("image.model.done", {
      durationMs: durationMs(startedAt),
      output: textStats(output),
    });
    return output;
  } catch (error) {
    logger.error("image.model.failed", {
      durationMs: durationMs(startedAt),
      error: errorSummary(error),
    });
    throw error;
  }
}

// Canario de la cola (examen 28-10-2026): ver src/services/queue-health.ts.
// Cada CANARY_TICK_MS revisa si toca probar la cola con un job de texto minimo. Solo en modo
// queue con latidos configurados, y solo si hubo pedidos reales en la ultima media hora.
import { env } from "../config/env.js";
import { createDiagnosticLogger, errorSummary } from "./diagnostics.js";
import {
  CANARY_TICK_MS,
  CANARY_TIMEOUT_MS,
  noteCanaryEnd,
  noteCanaryStart,
  shouldSendCanary,
} from "./queue-health.js";
import { runQueueAgentJobDetailed } from "./service-bus-agent.js";
import { countAliveWorkers } from "./worker-heartbeat.js";

const logger = createDiagnosticLogger("queue-canary", {});

export async function runQueueCanaryOnce(nowMs = Date.now()) {
  if (!shouldSendCanary({ nowMs, aliveWorkers: countAliveWorkers(nowMs) })) return null;
  noteCanaryStart(nowMs);
  const startedAt = Date.now();
  try {
    const result = await runQueueAgentJobDetailed({
      kind: "text",
      inputText: "Responde solo con la palabra: ok",
      generation: { temperature: 0, maxTokens: 4 },
      timeoutMs: CANARY_TIMEOUT_MS,
      canary: true,
      diagnostics: { route: "queue-canary", scope: "salud-cola", source: "canario" },
    });
    noteCanaryEnd(true);
    logger.info("queue.canary.ok", { durationMs: Date.now() - startedAt, workerId: result.workerId });
    return true;
  } catch (error) {
    noteCanaryEnd(false);
    logger.warn("queue.canary.failed", { durationMs: Date.now() - startedAt, error: errorSummary(error) });
    return false;
  }
}

/** Arranca el canario (una vez por proceso). Devuelve la funcion que lo detiene. */
export function startQueueCanary() {
  if (env.targetMode !== "queue" || !env.workerHeartbeatToken || !env.queueCanaryEnabled) return () => {};
  const timer = setInterval(() => {
    void runQueueCanaryOnce().catch(() => {});
  }, CANARY_TICK_MS);
  timer.unref?.();
  return () => clearInterval(timer);
}

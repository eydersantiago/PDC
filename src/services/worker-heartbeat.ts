import { timingSafeEqual } from "node:crypto";
import { env } from "../config/env.js";
import { describeWorker, type WorkerIdentity } from "./worker-identity.js";

/**
 * Latido de los workers de GPU (A15.4).
 *
 * /api/agent/backend decia quien atendio el ULTIMO job, pero no si hay
 * alguien escuchando la cola ahora (limitacion anotada en la operacion del
 * worker de GPU; ver docs/operacion/runbook.md). Cada worker manda un latido
 * cada ~30 s; un worker esta vivo si su ultimo latido cae dentro de
 * WORKER_HEARTBEAT_STALE_MS.
 *
 * El registro vive en memoria del App Service: con una sola instancia basta,
 * y si el servicio reinicia los workers reaparecen en su siguiente latido.
 */

export type WorkerHeartbeatInput = {
  workerId: string;
  model?: string;
  jobsProcessed?: number;
  lastJobAt?: string;
  startedAt?: string;
};

export type ListeningWorker = WorkerIdentity & {
  lastSeenAt: string;
  alive: boolean;
  model: string;
  jobsProcessed: number | null;
  lastJobAt: string | null;
  startedAt: string | null;
};

type Entry = {
  workerId: string;
  model: string;
  jobsProcessed: number | null;
  lastJobAt: string | null;
  startedAt: string | null;
  lastSeenMs: number;
};

const registry = new Map<string, Entry>();
const MAX_WORKERS = 50;

function cleanIso(value: unknown) {
  if (!value) return null;
  const parsed = new Date(String(value));
  return Number.isNaN(parsed.getTime()) ? null : parsed.toISOString();
}

export function isHeartbeatTokenValid(token: unknown) {
  const expected = env.workerHeartbeatToken;
  const received = String(token || "");
  if (!expected || !received) return false;
  const a = Buffer.from(expected);
  const b = Buffer.from(received);
  return a.length === b.length && timingSafeEqual(a, b);
}

export function recordWorkerHeartbeat(input: WorkerHeartbeatInput, nowMs = Date.now()) {
  const workerId = String(input.workerId || "").trim().slice(0, 80);
  if (!workerId) return null;
  if (!registry.has(workerId) && registry.size >= MAX_WORKERS) {
    // Se descarta el mas viejo para no crecer sin limite.
    const oldest = [...registry.values()].sort((a, b) => a.lastSeenMs - b.lastSeenMs)[0];
    if (oldest) registry.delete(oldest.workerId);
  }
  const jobs = Number(input.jobsProcessed);
  const entry: Entry = {
    workerId,
    model: String(input.model || "").slice(0, 80),
    jobsProcessed: Number.isFinite(jobs) ? Math.max(0, Math.round(jobs)) : null,
    lastJobAt: cleanIso(input.lastJobAt),
    startedAt: cleanIso(input.startedAt),
    lastSeenMs: nowMs,
  };
  registry.set(workerId, entry);
  return entry;
}

export function listListeningWorkers(nowMs = Date.now()): ListeningWorker[] {
  return [...registry.values()]
    .sort((a, b) => b.lastSeenMs - a.lastSeenMs)
    .map((entry) => ({
      ...describeWorker(entry.workerId, { mode: env.targetMode }),
      lastSeenAt: new Date(entry.lastSeenMs).toISOString(),
      alive: nowMs - entry.lastSeenMs <= env.workerHeartbeatStaleMs,
      model: entry.model,
      jobsProcessed: entry.jobsProcessed,
      lastJobAt: entry.lastJobAt,
      startedAt: entry.startedAt,
    }));
}

export function countAliveWorkers(nowMs = Date.now()) {
  return listListeningWorkers(nowMs).filter((worker) => worker.alive).length;
}

/**
 * A12.10: en modo queue, si los workers ya mandaron latidos y ninguno sigue
 * vivo, la GPU esta caida y no tiene sentido esperar el timeout de la cola.
 * Sin latidos registrados (token sin configurar o servicio recien reiniciado)
 * no se sabe, y se intenta como siempre.
 */
export function isInferenceKnownDown(nowMs = Date.now()) {
  if (env.targetMode !== "queue" || !env.workerHeartbeatToken) return false;
  const workers = listListeningWorkers(nowMs);
  return workers.length > 0 && workers.every((worker) => !worker.alive);
}

export function resetWorkerHeartbeatsForTests() {
  registry.clear();
}

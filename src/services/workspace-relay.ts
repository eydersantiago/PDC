// Camino Azure -> VM de editores sin IP publica (A15.3).
//
// La VM de editores no tiene IP publica (politica vmExternalIpAccess) y el App
// Service no puede abrirle conexiones. En modo "relay" las peticiones de PDC
// al agente quedan en esta cola en memoria y el propio agente las recoge con
// sondeo largo (GET /api/workspaces/agent/next) por HTTPS de salida, que la VM
// si tiene por Cloud NAT; luego devuelve cada respuesta (POST
// /api/workspaces/agent/responses). Para workspace-provider.ts es lo mismo que
// llamar al agente por HTTP: recibe { status, json } o un timeout.
//
// La cola vive en memoria, igual que el registro de latidos de los workers:
// supone una sola instancia del App Service (la del piloto).
import { randomUUID } from "node:crypto";
import type { AgentCallResult } from "./workspace-provider.js";

export type RelayMethod = "GET" | "POST";

export type RelayJob = {
  id: string;
  method: RelayMethod;
  path: string;
  body?: unknown;
  createdAt: string;
};

export type RelayResponse = { id: string; status: number; json: unknown };

type Waiting = {
  job: RelayJob;
  resolve: (result: AgentCallResult) => void;
  timer: ReturnType<typeof setTimeout>;
  delivered: boolean;
};

export type WorkspaceRelayOptions = {
  now?: () => number;
  /** Sin sondeos del agente en este tiempo, se responde "unreachable" de inmediato. */
  staleAfterMs?: number;
  /** Trabajos que se entregan por sondeo. */
  batchSize?: number;
};

export function createWorkspaceRelay(options: WorkspaceRelayOptions = {}) {
  const now = options.now || Date.now;
  const staleAfterMs = options.staleAfterMs ?? 60_000;
  const batchSize = options.batchSize ?? 10;
  const waiting = new Map<string, Waiting>();
  const queue: string[] = [];
  const pollers: Array<(jobs: RelayJob[]) => void> = [];
  let lastPollAt = 0;

  function isAgentOnline() {
    return pollers.length > 0 || (lastPollAt > 0 && now() - lastPollAt <= staleAfterMs);
  }

  function takeJobs() {
    const jobs: RelayJob[] = [];
    while (queue.length && jobs.length < batchSize) {
      const id = queue.shift() as string;
      const entry = waiting.get(id);
      if (!entry || entry.delivered) continue;
      entry.delivered = true;
      jobs.push(entry.job);
    }
    return jobs;
  }

  function wakePoller() {
    while (pollers.length && queue.length) {
      const jobs = takeJobs();
      if (!jobs.length) break;
      const poller = pollers.shift() as (jobs: RelayJob[]) => void;
      poller(jobs);
    }
  }

  /** Lo que usa workspace-provider en lugar de fetch al agente. */
  function request(method: RelayMethod, path: string, body: unknown, timeoutMs: number): Promise<AgentCallResult> {
    if (!isAgentOnline()) {
      return Promise.resolve({ kind: "unreachable", detail: "el agente de la VM no se ha conectado al relay" });
    }
    return new Promise<AgentCallResult>((resolve) => {
      const job: RelayJob = { id: randomUUID(), method, path, ...(body === undefined ? {} : { body }), createdAt: new Date(now()).toISOString() };
      const timer = setTimeout(() => {
        waiting.delete(job.id);
        resolve({ kind: "timeout" });
      }, Math.max(1, timeoutMs));
      waiting.set(job.id, { job, resolve, timer, delivered: false });
      queue.push(job.id);
      wakePoller();
    });
  }

  /**
   * Sondeo largo del agente: trabajos pendientes o [] tras waitMs. Si el
   * agente corta la conexion (signal), el sondeo se retira de la espera.
   */
  function nextJobs(waitMs: number, signal?: AbortSignal): Promise<RelayJob[]> {
    lastPollAt = now();
    const ready = takeJobs();
    if (ready.length || waitMs <= 0 || signal?.aborted) return Promise.resolve(ready);
    return new Promise<RelayJob[]>((resolve) => {
      let settled = false;
      const deliver = (jobs: RelayJob[]) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        signal?.removeEventListener("abort", onAbort);
        lastPollAt = now();
        resolve(jobs);
      };
      const withdraw = () => {
        const index = pollers.indexOf(deliver);
        if (index >= 0) pollers.splice(index, 1);
        deliver([]);
      };
      const onAbort = () => withdraw();
      const timer = setTimeout(withdraw, waitMs);
      signal?.addEventListener("abort", onAbort, { once: true });
      pollers.push(deliver);
    });
  }

  /** Devuelve a la cola trabajos que no alcanzaron a llegar al agente (conexion cortada). */
  function requeue(jobs: RelayJob[]) {
    for (const job of [...jobs].reverse()) {
      const entry = waiting.get(job.id);
      if (!entry) continue;
      entry.delivered = false;
      queue.unshift(job.id);
    }
    wakePoller();
  }

  /** Respuestas del agente; devuelve cuantas se entregaron a una peticion viva. */
  function respond(responses: RelayResponse[]) {
    lastPollAt = now();
    let accepted = 0;
    for (const response of responses) {
      const entry = waiting.get(response.id);
      if (!entry) continue;
      waiting.delete(response.id);
      clearTimeout(entry.timer);
      entry.resolve({ kind: "response", status: response.status, json: response.json });
      accepted += 1;
    }
    return accepted;
  }

  function status() {
    return {
      online: isAgentOnline(),
      lastPollAt: lastPollAt ? new Date(lastPollAt).toISOString() : null,
      pending: queue.length,
      waiting: waiting.size,
      pollers: pollers.length,
    };
  }

  function close() {
    for (const entry of waiting.values()) {
      clearTimeout(entry.timer);
      entry.resolve({ kind: "unreachable", detail: "relay cerrado" });
    }
    waiting.clear();
    queue.splice(0);
    for (const poller of pollers.splice(0)) poller([]);
  }

  return { request, nextJobs, requeue, respond, status, isAgentOnline, close };
}

export type WorkspaceRelay = ReturnType<typeof createWorkspaceRelay>;

/** Relay unico del proceso (el App Service del piloto corre una instancia). */
export const workspaceRelay = createWorkspaceRelay();

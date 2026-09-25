// Rutas del entorno por tunel de VS Code (fase 3 de docs/workspaces-tunnel.md).
//
//   GET  /api/workspaces/provider                 publica: { ok, provider: "tunnel" | "codespaces" }
//   POST /api/workspaces/prepare  { repoFullName, force? }
//   GET  /api/workspaces/status?repoFullName=...
//        -> { ok, provider: "tunnel", status: "ready" | "device_code" | "pending" | "error",
//             workspace: { login, tunnelName, webUrl, repoFullName },
//             deviceCode?: { userCode, verificationUrl, expiresAt }, message?, code? }
//
// prepare y status exigen sesion. Con el proveedor "codespaces" responden 409
// y la extension sigue con Codespaces. Los fallos del agente de la VM salen con
// HTTP 200 y status "error" (+ message legible): asi la extension deja de
// consultar y le muestra el motivo al estudiante en vez de esperar 12 min.
// Los transitorios (agente desconectado, sin respuesta, VM encendiendose)
// llevan retryable: true y la extension 0.7.11 sigue esperando.
//
// prepare crea (o reutiliza si le quedan mas de 7 dias) una sesion editor
// "tunnel" y la manda al agente en editorSession: la VM la escribe para VS
// Code y el estudiante no pega nada (docs/arquitectura/acceso-simplificado.md, 2.3).
import { createHash, timingSafeEqual } from "node:crypto";
import type express from "express";
import { z } from "zod";
import { env } from "../config/env.js";
import type { AppDatabase } from "../db/database.js";
import type { BehaviorEventInput } from "../types/app.js";
import { trimText } from "../services/text-utils.js";
import {
  buildWorkspaceErrorPayload,
  buildWorkspaceInfo,
  createWorkspaceService,
  normalizeRepoFullName,
  WorkspaceRequestError,
  type WorkspaceEditorSession,
  type WorkspaceProviderDeps,
  type WorkspaceStatusPayload,
} from "../services/workspace-provider.js";
import { editorSessionTtlMs } from "./editor-auth-routes.js";
import { errorMessage, getRequestBaseUrl, resolveSession, type AppSession } from "./route-utils.js";

export type WorkspaceRouteDeps = WorkspaceProviderDeps & {
  /** URL publica del backend para la sesion del editor (por defecto PUBLIC_BASE_URL o la peticion). */
  publicBaseUrl?: string;
  editorSessionTtlMs?: number;
};

const relayResponsesSchema = z.object({
  responses: z.array(z.object({
    id: z.string().uuid(),
    status: z.number().int().min(100).max(599),
    json: z.unknown().optional(),
  })).min(1).max(20),
});

const prepareSchema = z.object({
  repoFullName: z.string().max(240),
  force: z.boolean().optional(),
});

const TRACK_TTL_MS = 30 * 60 * 1000;
const TRACK_MAX = 1000;
const DAY_MS = 24 * 60 * 60 * 1000;
// Una sesion "tunnel" se reutiliza mientras le queden mas de 7 dias.
const EDITOR_SESSION_REUSE_MIN_MS = 7 * DAY_MS;
const EDITOR_SESSION_LABEL = "tunnel";

type TrackedPreparation = {
  startedAt: number;
  force: boolean;
  deviceCodeLogged: boolean;
  /** El POST no llego al agente (desconectado o VM apagada): se reenvia en status. */
  dispatchPending: boolean;
  /** force del reenvio: el original, o false si se reenvia por not_found. */
  resendForce: boolean;
  /** Reenvio en curso: las consultas que llegan mientras tanto esperan el mismo. */
  redispatch?: Promise<{ payload: WorkspaceStatusPayload; delivered: boolean }>;
  /** Ya se registro un fallo transitorio de esta preparacion. */
  transientFailureLogged: boolean;
  /** Primer codigo transitorio visto (agent_unreachable, agent_timeout, vm_starting); "" si ninguno. */
  waitedFor: string;
  /** Ya se reenvio una vez el prepare porque el agente respondio not_found tras la espera. */
  lostPrepareResent: boolean;
};

// La extension (fetchJsonWithTimeout) muestra `error` cuando el HTTP no es 2xx.
function withErrorField(payload: WorkspaceStatusPayload) {
  return payload.ok ? payload : { ...payload, error: payload.message || "No se pudo preparar el editor." };
}

function errorBody(code: string, message: string, repoFullName = "", login = "") {
  return withErrorField(buildWorkspaceErrorPayload(code, message, buildWorkspaceInfo(login, repoFullName)));
}

function codespacesBody() {
  const message = "El proveedor de entornos activo es Codespaces: el editor se prepara con el flujo de Codespaces.";
  return { ok: false, provider: "codespaces" as const, status: "error" as const, code: "provider_codespaces", message, error: message };
}

function unauthorizedBody() {
  return { ok: false, status: "error" as const, code: "unauthorized", message: "Sesion no valida.", error: "Sesion no valida." };
}

function readQueryString(value: unknown) {
  return typeof value === "string" ? value : "";
}

const LOCAL_HOST_RE = /^(127\.0\.0\.1|localhost|\[::1\])$/i;

function validBackendUrl(value: string) {
  try {
    const url = new URL(value);
    if ((url.protocol !== "https:" && url.protocol !== "http:") || url.username || url.password) return "";
    // El agente de la VM solo acepta http hacia la propia maquina (PDC local).
    // Sin PUBLIC_BASE_URL, detras del proxy de Azure la peticion puede llegar
    // como http si falta x-forwarded-proto: fuera de localhost (y sin puerto
    // propio) se pasa a https, que es lo unico que sirve el App Service.
    const protocol = url.protocol === "http:" && !LOCAL_HOST_RE.test(url.hostname) && !url.port ? "https:" : url.protocol;
    return `${protocol}//${url.host}${url.pathname}`.replace(/\/+$/, "");
  } catch {
    return "";
  }
}

export function registerWorkspaceRoutes(
  app: express.Express,
  database: AppDatabase,
  deps: WorkspaceRouteDeps = {},
) {
  const service = createWorkspaceService(database, deps);
  const now = deps.now || Date.now;
  // userId:repo -> inicio de la preparacion. Sirve para registrar una sola vez
  // el codigo de dispositivo y cuanto tardo el editor en quedar listo, aunque
  // la extension consulte status cada 3 s.
  const tracked = new Map<string, TrackedPreparation>();

  function trackKey(session: AppSession, repoFullName: string) {
    return `${session.user.id}:${repoFullName.toLowerCase()}`;
  }

  function pruneTracked() {
    const limit = now() - TRACK_TTL_MS;
    for (const [key, entry] of tracked) {
      if (entry.startedAt < limit) tracked.delete(key);
    }
    if (tracked.size > TRACK_MAX) tracked.clear();
  }

  async function recordEvent(session: AppSession, event: BehaviorEventInput) {
    try {
      await database.recordBehaviorEvents({ sessionId: session.id, user: session.user, events: [event] });
    } catch {
      // La telemetria nunca debe bloquear la preparacion del entorno.
    }
  }

  // Sesion editor "tunnel" para la VM. Si algo falla, prepare sigue sin ella:
  // el editor se prepara igual y VS Code se puede conectar a mano.
  async function buildEditorSession(session: AppSession, req: express.Request): Promise<WorkspaceEditorSession | undefined> {
    // Solo si la sesion llego por x-session-id (la extension): con la cookie
    // sola, otra pagina podria elegir el backendUrl con x-forwarded-host.
    if (trimText(req.header("x-session-id")) !== session.id) return undefined;
    const backendUrl = validBackendUrl(getRequestBaseUrl(req, deps.publicBaseUrl ?? env.publicBaseUrl));
    if (!backendUrl) return undefined;
    try {
      const editor = await database.findReusableEditorSession({
        userId: session.user.id,
        label: EDITOR_SESSION_LABEL,
        minExpiresAt: new Date(Date.now() + EDITOR_SESSION_REUSE_MIN_MS),
      }) || await database.createEditorSession({
        userId: session.user.id,
        label: EDITOR_SESSION_LABEL,
        ttlMs: deps.editorSessionTtlMs ?? editorSessionTtlMs(),
      });
      if (!editor?.expiresAt) return undefined;
      return {
        sessionId: editor.id,
        backendUrl,
        expiresAt: editor.expiresAt,
        userName: session.user.displayName,
        userEmail: session.user.email,
      };
    } catch (error) {
      console.warn("[workspaces] no se pudo preparar la sesion del editor:", errorMessage(error));
      return undefined;
    }
  }

  // Reenvia el POST /workspaces de una preparacion abierta. Un solo reenvio a
  // la vez aunque la extension consulte cada 3 s; si tampoco llega, el
  // siguiente status lo vuelve a intentar.
  function resendPrepare(entry: TrackedPreparation, session: AppSession, req: express.Request, repoFullName: string) {
    entry.redispatch = entry.redispatch || service.dispatch({
      userId: session.user.id,
      repoFullName,
      force: entry.resendForce,
      editorSession: () => buildEditorSession(session, req),
      freshLogin: false,
    }).then((result) => {
      entry.dispatchPending = !result.delivered;
      return result;
    }).finally(() => {
      entry.redispatch = undefined;
    });
    return entry.redispatch;
  }

  async function recordOutcome(session: AppSession, repoFullName: string, payload: WorkspaceStatusPayload) {
    const key = trackKey(session, repoFullName);
    const entry = tracked.get(key);
    if (!entry) return;
    const durationMs = Math.max(0, now() - entry.startedAt);
    if (payload.retryable && !entry.waitedFor) entry.waitedFor = payload.code || "retryable";

    if (payload.status === "error" && payload.retryable) {
      // Transitorio: la extension 0.7.11 sigue esperando, asi que la
      // preparacion sigue abierta (un "listo" posterior tambien se registra).
      // El fallo se anota una sola vez, marcado como reintentable:
      // metadata.retryable y metadata.reason pasan la lista blanca de
      // telemetry_events, asi el dataset del piloto separa estas esperas de
      // los fallos terminales.
      if (entry.transientFailureLogged) return;
      entry.transientFailureLogged = true;
      await recordEvent(session, {
        source: "backend",
        category: "error",
        eventType: entry.force ? "prepare_environment_retry_failed" : "prepare_environment_failed",
        repoFullName,
        value: `${payload.code || "error"}: ${payload.message || ""}`.slice(0, 1000),
        durationMs,
        metadata: {
          provider: "tunnel",
          force: entry.force,
          code: payload.code || null,
          reason: payload.code || "error",
          retryable: true,
        },
      });
      return;
    }

    if (payload.status === "ready") {
      tracked.delete(key);
      await recordEvent(session, {
        source: "backend",
        category: "codespace",
        eventType: "tunnel_workspace_ready",
        repoFullName,
        value: "tunnel",
        durationMs,
        // reason: listo tras una espera transitoria (VM apagada o encendiendose).
        metadata: {
          provider: "tunnel",
          force: entry.force,
          deviceCode: entry.deviceCodeLogged,
          ...(entry.waitedFor ? { reason: entry.waitedFor } : {}),
        },
      });
      return;
    }

    if (payload.status === "device_code" && !entry.deviceCodeLogged) {
      entry.deviceCodeLogged = true;
      await recordEvent(session, {
        source: "backend",
        category: "codespace",
        eventType: "tunnel_workspace_device_code",
        repoFullName,
        value: "tunnel",
        durationMs,
        metadata: { provider: "tunnel", force: entry.force },
      });
      return;
    }

    if (payload.status === "error") {
      tracked.delete(key);
      await recordEvent(session, {
        source: "backend",
        category: "error",
        eventType: entry.force ? "prepare_environment_retry_failed" : "prepare_environment_failed",
        repoFullName,
        value: `${payload.code || "error"}: ${payload.message || ""}`.slice(0, 1000),
        durationMs,
        metadata: { provider: "tunnel", force: entry.force, code: payload.code || null, reason: payload.code || "error" },
      });
    }
  }

  app.get("/api/workspaces/provider", (_req, res) => {
    const provider = service.config.provider;
    return res.json(provider === "tunnel"
      ? { ok: true, provider, agentConfigured: service.isAgentConfigured() }
      : { ok: true, provider });
  });

  app.post("/api/workspaces/prepare", async (req, res) => {
    let session: AppSession | null = null;
    let repoFullName = "";
    try {
      session = await resolveSession(database, req);
      if (!session) return res.status(401).json(unauthorizedBody());
      if (service.config.provider !== "tunnel") return res.status(409).json(codespacesBody());

      const parsed = prepareSchema.safeParse(req.body ?? {});
      repoFullName = parsed.success ? normalizeRepoFullName(parsed.data.repoFullName) : "";
      if (!parsed.success || !repoFullName) {
        return res.status(400).json(errorBody(
          "invalid_request",
          "Envia repoFullName (owner/nombre del repositorio de GitHub) y, si quieres rehacer el entorno, force: true.",
        ));
      }
      const force = parsed.data.force === true;

      pruneTracked();
      const entry: TrackedPreparation = {
        startedAt: now(),
        force,
        deviceCodeLogged: false,
        dispatchPending: false,
        resendForce: force,
        transientFailureLogged: false,
        waitedFor: "",
        lostPrepareResent: false,
      };
      tracked.set(trackKey(session, repoFullName), entry);
      await recordEvent(session, {
        source: "backend",
        category: "codespace",
        eventType: force ? "prepare_environment_retry_started" : "prepare_environment_started",
        repoFullName,
        value: "tunnel",
        metadata: { provider: "tunnel", force },
      });

      const current = session;
      const { payload, delivered } = await service.dispatch({
        userId: session.user.id,
        repoFullName,
        force,
        editorSession: () => buildEditorSession(current, req),
      });
      entry.dispatchPending = !delivered;
      await recordOutcome(session, repoFullName, payload);
      return res.status(200).json(withErrorField(payload));
    } catch (error) {
      if (error instanceof WorkspaceRequestError) {
        const payload = buildWorkspaceErrorPayload(error.code, error.message, buildWorkspaceInfo(error.login, repoFullName));
        if (session && repoFullName) await recordOutcome(session, repoFullName, payload);
        return res.status(error.httpStatus).json(withErrorField(payload));
      }
      console.error("[workspaces] prepare fallo inesperado:", error);
      const payload = buildWorkspaceErrorPayload(
        "internal_error",
        "Error interno del backend al preparar el editor. Intenta de nuevo.",
        buildWorkspaceInfo("", repoFullName),
      );
      if (session && repoFullName) await recordOutcome(session, repoFullName, payload);
      return res.status(500).json(withErrorField(payload));
    }
  });

  app.get("/api/workspaces/status", async (req, res) => {
    let repoFullName = "";
    try {
      const session = await resolveSession(database, req);
      if (!session) return res.status(401).json(unauthorizedBody());
      if (service.config.provider !== "tunnel") return res.status(409).json(codespacesBody());

      repoFullName = normalizeRepoFullName(readQueryString(req.query.repoFullName));
      if (!repoFullName) {
        return res.status(400).json(errorBody("invalid_request", "Falta repoFullName (owner/nombre) en la consulta."));
      }

      let payload: WorkspaceStatusPayload;
      try {
        const entry = tracked.get(trackKey(session, repoFullName));
        if (entry?.dispatchPending) {
          // El prepare no llego al agente (VM apagada o agente desconectado):
          // se reenvia aqui, asi la espera termina sola cuando la VM vuelve.
          payload = (await resendPrepare(entry, session, req, repoFullName)).payload;
        } else {
          payload = await service.status({ userId: session.user.id, repoFullName });
          if (entry && entry.waitedFor && !entry.lostPrepareResent && payload.status === "error" && payload.code === "not_found") {
            // Red de seguridad: tras una espera (VM apagada, agente caido) el
            // POST pudo perderse aunque pareciera entregado (se entrego a un
            // sondeo muerto o vencio por tiempo). Si el agente no conoce al
            // estudiante, se reenvia una vez en vez de cortar la espera; sin
            // force, porque no hay nada que rehacer.
            entry.lostPrepareResent = true;
            entry.resendForce = false;
            payload = (await resendPrepare(entry, session, req, repoFullName)).payload;
          }
        }
      } catch (error) {
        if (!(error instanceof WorkspaceRequestError)) throw error;
        payload = buildWorkspaceErrorPayload(error.code, error.message, buildWorkspaceInfo(error.login, repoFullName));
        await recordOutcome(session, repoFullName, payload);
        return res.status(error.httpStatus).json(withErrorField(payload));
      }
      await recordOutcome(session, repoFullName, payload);
      return res.status(200).json(withErrorField(payload));
    } catch (error) {
      console.error("[workspaces] status fallo inesperado:", error);
      return res.status(500).json(errorBody(
        "internal_error",
        "Error interno del backend al consultar el editor. Intenta de nuevo.",
        repoFullName,
      ));
    }
  });

  // --- Relay para la VM sin IP publica (A15.3) ------------------------------
  // El agente de la VM llama aqui por HTTPS de salida con su token (el mismo
  // WORKSPACE_AGENT_TOKEN): recoge las peticiones pendientes y devuelve las
  // respuestas. Ver src/services/workspace-relay.ts.
  function agentAuthorized(req: express.Request) {
    const expected = service.config.agentToken;
    const received = String(req.header("x-agent-token") || "");
    if (!expected || !received) return false;
    const digest = (value: string) => createHash("sha256").update(value).digest();
    return timingSafeEqual(digest(expected), digest(received));
  }

  app.get("/api/workspaces/agent/next", async (req, res) => {
    if (!agentAuthorized(req)) return res.status(401).json({ ok: false, error: "Token del agente invalido." });
    const waitSeconds = Math.min(25, Math.max(0, Number(readQueryString(req.query.wait)) || 0));
    const controller = new AbortController();
    res.on("close", () => {
      if (!res.writableFinished) controller.abort();
    });
    const jobs = await service.relay.nextJobs(waitSeconds * 1000, controller.signal);
    if (controller.signal.aborted) {
      // El agente corto la conexion: lo recogido vuelve a la cola.
      service.relay.requeue(jobs);
      return;
    }
    return res.json({ ok: true, jobs });
  });

  app.post("/api/workspaces/agent/responses", (req, res) => {
    if (!agentAuthorized(req)) return res.status(401).json({ ok: false, error: "Token del agente invalido." });
    const parsed = relayResponsesSchema.safeParse(req.body || {});
    if (!parsed.success) return res.status(400).json({ ok: false, error: "Respuestas invalidas." });
    const accepted = service.relay.respond(parsed.data.responses.map((item) => ({ id: item.id, status: item.status, json: item.json ?? null })));
    return res.json({ ok: true, accepted });
  });

  app.get("/api/workspaces/agent/status", async (req, res) => {
    const session = await resolveSession(database, req).catch(() => null);
    if (!agentAuthorized(req) && (!session || (session.user.role !== "teacher" && session.user.role !== "admin"))) {
      return res.status(403).json({ ok: false, error: "Solo docentes, administradores o el agente." });
    }
    return res.json({
      ok: true,
      provider: service.config.provider,
      transport: service.config.transport,
      agentConfigured: service.isAgentConfigured(),
      relay: service.config.transport === "relay" ? service.relay.status() : null,
    });
  });
}

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
import { createHash, timingSafeEqual } from "node:crypto";
import type express from "express";
import { z } from "zod";
import type { AppDatabase } from "../db/database.js";
import type { BehaviorEventInput } from "../types/app.js";
import {
  buildWorkspaceErrorPayload,
  buildWorkspaceInfo,
  createWorkspaceService,
  normalizeRepoFullName,
  WorkspaceRequestError,
  type WorkspaceProviderDeps,
  type WorkspaceStatusPayload,
} from "../services/workspace-provider.js";
import { resolveSession, type AppSession } from "./route-utils.js";

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

type TrackedPreparation = {
  startedAt: number;
  force: boolean;
  deviceCodeLogged: boolean;
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

export function registerWorkspaceRoutes(
  app: express.Express,
  database: AppDatabase,
  deps: WorkspaceProviderDeps = {},
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

  async function recordOutcome(session: AppSession, repoFullName: string, payload: WorkspaceStatusPayload) {
    const key = trackKey(session, repoFullName);
    const entry = tracked.get(key);
    if (!entry) return;
    const durationMs = Math.max(0, now() - entry.startedAt);

    if (payload.status === "ready") {
      tracked.delete(key);
      await recordEvent(session, {
        source: "backend",
        category: "codespace",
        eventType: "tunnel_workspace_ready",
        repoFullName,
        value: "tunnel",
        durationMs,
        metadata: { provider: "tunnel", force: entry.force, deviceCode: entry.deviceCodeLogged },
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
        metadata: { provider: "tunnel", force: entry.force, code: payload.code || null },
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
      tracked.set(trackKey(session, repoFullName), { startedAt: now(), force, deviceCodeLogged: false });
      await recordEvent(session, {
        source: "backend",
        category: "codespace",
        eventType: force ? "prepare_environment_retry_started" : "prepare_environment_started",
        repoFullName,
        value: "tunnel",
        metadata: { provider: "tunnel", force },
      });

      const payload = await service.prepare({ userId: session.user.id, repoFullName, force });
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
        payload = await service.status({ userId: session.user.id, repoFullName });
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

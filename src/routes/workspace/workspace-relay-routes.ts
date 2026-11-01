// Relay para la VM sin IP publica (A15.3): peticiones pendientes, respuestas y estado del agente.
import { createHash, timingSafeEqual } from "node:crypto";
import type express from "express";
import { z } from "zod";
import type { AppDatabase } from "../../db/database.js";
import { registerWorkspaceBackupRoutes } from "./workspace-backup-routes.js";
import { registerWorkspaceProgressRoutes } from "./workspace-progress-routes.js";
import { type WorkspaceService } from "../../services/workspace/workspace-provider.js";
import { isStaffRole, resolveSession } from "../route-utils.js";

const relayResponsesSchema = z.object({
  responses: z.array(z.object({
    id: z.string().uuid(),
    status: z.number().int().min(100).max(599),
    json: z.unknown().optional(),
  })).min(1).max(20),
});

export function readQueryString(value: unknown) {
  return typeof value === "string" ? value : "";
}

export function registerWorkspaceAgentRelayRoutes(app: express.Express, database: AppDatabase, service: WorkspaceService) {
  // --- Relay para la VM sin IP publica (A15.3) ------------------------------
  // El agente de la VM llama aqui por HTTPS de salida con su token (el mismo
  // WORKSPACE_AGENT_TOKEN): recoge las peticiones pendientes y devuelve las
  // respuestas. Ver src/services/workspace/workspace-relay.ts.
  function agentAuthorized(req: express.Request) {
    const expected = service.config.agentToken;
    const received = String(req.header("x-agent-token") || "");
    if (!expected || !received) return false;
    const digest = (value: string) => createHash("sha256").update(value).digest();
    return timingSafeEqual(digest(expected), digest(received));
  }

  // La copia de respaldo de la VM avisa con el mismo token (28-10-2026), y el avance de los
  // talleres tambien (29-10-2026).
  registerWorkspaceBackupRoutes(app, database, agentAuthorized);
  registerWorkspaceProgressRoutes(app, database, agentAuthorized);

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
    if (!agentAuthorized(req) && (!session || !isStaffRole(session.user.role))) {
      return res.status(403).json({ ok: false, error: "Solo docentes, administradores o el agente." });
    }
    const state = await service.providerState();
    return res.json({
      ok: true,
      provider: state.provider,
      providerSource: state.source,
      transport: service.config.transport,
      agentConfigured: service.isAgentConfigured(),
      relay: service.config.transport === "relay" ? service.relay.status() : null,
    });
  });
}

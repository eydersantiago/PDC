// «Iniciar clase» desde la tuerca del administrador o el docente (navegador 0.7.21):
//
//   GET  /api/admin/clase/estado    estado de cada VM (GPU y editores), agente de editores,
//                                   servidores del modelo vivos y `ready`
//   POST /api/admin/clase/iniciar   enciende la VM de editores (si el proveedor activo es
//                                   tunnel) y una GPU (la primera de CLASS_GPU_VMS que acepte);
//                                   responde el mismo estado con `actions` y `message`
//
// Administrador o docente (misma comprobacion que PUT /api/admin/workspace-provider).
// Nunca apaga nada. Sin credenciales de Google Cloud o sin VMs configuradas responde 409
// con el motivo. La logica esta en src/services/class-start.ts.
import type express from "express";
import { env } from "../config/env.js";
import type { AppDatabase } from "../db/database.js";
import { getDefaultClassStarter, type ClassContext, type ClassStarter } from "../services/class-start.js";
import { countAliveWorkers } from "../services/worker-heartbeat.js";
import { resolveWorkspaceConfig } from "../services/workspace-provider.js";
import { readWorkspaceProviderChoice, resolveWorkspaceProviderState } from "../services/workspace-provider-choice.js";
import { workspaceRelay } from "../services/workspace-relay.js";
import { errorMessage, resolveManagerSession } from "./route-utils.js";

export type ClassRouteDeps = {
  /** Encendido de la clase (por defecto, segun CLASS_GPU_VMS y WORKSPACE_VM_*). null = sin configurar. */
  starter?: ClassStarter | null;
  /** Motivo con starter null (pruebas); por defecto el del entorno. */
  problem?: string;
};

const FORBIDDEN_MESSAGE = "Solo el administrador o el docente inician la clase.";

/** Contexto de produccion: el entorno activo (/api/health), el relay del agente y los latidos. */
export function productionClassContext(database: AppDatabase): () => Promise<ClassContext> {
  return async () => {
    const workspace = resolveWorkspaceProviderState(env.workspaceProvider, await readWorkspaceProviderChoice(database));
    const relayTransport = resolveWorkspaceConfig().transport === "relay";
    return {
      provider: workspace.provider,
      // En modo directo el backend no sabe si el agente escucha: null.
      agentOnline: relayTransport ? workspaceRelay.isAgentOnline() : null,
      workersAlive: countAliveWorkers(),
    };
  };
}

export function registerClassRoutes(app: express.Express, database: AppDatabase, deps: ClassRouteDeps = {}) {
  function resolveStarter() {
    if (deps.starter !== undefined) {
      return { starter: deps.starter, problem: deps.problem || "«Iniciar clase» no esta configurado en este backend." };
    }
    return getDefaultClassStarter(productionClassContext(database));
  }

  function notConfigured(res: express.Response, problem: string) {
    return res.status(409).json({ ok: false, configured: false, code: "class_start_not_configured", error: problem, message: problem });
  }

  app.get("/api/admin/clase/estado", async (req, res) => {
    try {
      if (!(await resolveManagerSession(database, req, res, FORBIDDEN_MESSAGE))) return;
      const { starter, problem } = resolveStarter();
      if (!starter) return notConfigured(res, problem);
      return res.json(await starter.status());
    } catch (error) {
      return res.status(500).json({ ok: false, error: errorMessage(error) });
    }
  });

  app.post("/api/admin/clase/iniciar", async (req, res) => {
    try {
      const session = await resolveManagerSession(database, req, res, FORBIDDEN_MESSAGE);
      if (!session) return;
      const { starter, problem } = resolveStarter();
      if (!starter) return notConfigured(res, problem);
      const outcome = await starter.start(`${session.user.displayName} (${session.user.role}, ${session.user.id})`);
      console.info(`[clase] iniciar por ${session.user.id}: ${outcome.actions.join(", ") || "nada que encender"}; ${outcome.message}`);
      return res.json(outcome);
    } catch (error) {
      return res.status(500).json({ ok: false, error: errorMessage(error) });
    }
  });
}

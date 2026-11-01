// Rutas del editor en la nube: registerWorkspaceRoutes registra, en este orden, proveedor, preparar y estado, y el relay de la VM.
// Rutas del entorno por tunel de VS Code (fase 3 de docs/workspaces-tunnel.md).
//
//   GET  /api/workspaces/provider                 publica: { ok, provider: "tunnel" | "codespaces" }
//   POST /api/workspaces/prepare  { repoFullName, force?, reconnect? }
//        reconnect (0.8.1, el punto de restauracion): la VM cierra la sesion del tunel (la
//        cuenta de GitHub que autorizo el codigo) y pide un codigo nuevo, sin tocar los
//        archivos. Para cuando vscode.dev no encuentra el tunel porque se autorizo con otra
//        cuenta. Una VM con el agente anterior responde code "reconnect_unsupported".
//   GET  /api/workspaces/status?repoFullName=...
//        -> { ok, provider: "tunnel", status: "ready" | "device_code" | "pending" | "error",
//             workspace: { login, tunnelName, webUrl, repoFullName },
//             deviceCode?: { userCode, verificationUrl, expiresAt }, message?, code? }
//
//   GET  /api/admin/workspace-provider           administrador o docente: entorno activo, de
//                                                 donde sale y estado del agente
//   PUT  /api/admin/workspace-provider  { provider: "tunnel" | "codespaces" | "server" }
//        administrador o docente (0.7.19): elige el entorno de los estudiantes (uno para
//        todo el piloto) desde la tuerca de la extension; "server" vuelve a
//        ADACEEN_WORKSPACE_PROVIDER. "tunnel" sin WORKSPACE_AGENT_TOKEN responde 409
//        (agent_not_configured).
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
// status con el editor listo hace lo mismo si el usuario no tiene esa sesion
// (tras «Salir», que desactiva las sesiones editor): el agente reescribe el
// archivo antes de que el navegador abra vscode.dev.
import type express from "express";
import type { AppDatabase } from "../../db/database.js";
import { createWorkspaceService } from "../../services/workspace/workspace-provider.js";
import { type WorkspaceProviderDeps } from "../../services/workspace/workspace-config.js";
import { createWorkspacePreparationTracker } from "./workspace-preparation-tracker.js";
import { registerWorkspaceProviderRoutes } from "./workspace-provider-routes.js";
import { registerWorkspaceAgentRelayRoutes } from "./workspace-relay-routes.js";
import { registerWorkspacePrepareStatusRoutes } from "./workspace-prepare-routes.js";

export type WorkspaceRouteDeps = WorkspaceProviderDeps & {
  /** URL publica del backend para la sesion del editor (por defecto PUBLIC_BASE_URL o la peticion). */
  publicBaseUrl?: string;
  editorSessionTtlMs?: number;
};

export function registerWorkspaceRoutes(
  app: express.Express,
  database: AppDatabase,
  deps: WorkspaceRouteDeps = {},
) {
  const service = createWorkspaceService(database, deps);
  const now = deps.now || Date.now;
  const tracker = createWorkspacePreparationTracker(database, deps, service, now);
  registerWorkspaceProviderRoutes(app, database, service, now);
  registerWorkspacePrepareStatusRoutes(app, database, service, now, tracker);
  registerWorkspaceAgentRelayRoutes(app, database, service);
}


// Rutas del proveedor de entornos: el activo y el que elige el administrador o el docente (0.7.19).
import type express from "express";
import type { AppDatabase } from "../../db/database.js";
import { type WorkspaceService } from "../../services/workspace/workspace-provider.js";
import { normalizeWorkspaceProviderRequest, saveWorkspaceProviderChoice, type WorkspaceProviderRequest } from "../../services/workspace/workspace-provider-choice.js";
import { errorMessage, resolveManagerSession } from "../route-utils.js";

const PROVIDER_LABELS: Record<"tunnel" | "codespaces", string> = {
  tunnel: "editor en la nube (túnel de VS Code)",
  codespaces: "GitHub Codespaces",
};

// Mensaje para la linea de estado de la extension tras elegir el entorno (0.7.19).
function providerChangedMessage(request: WorkspaceProviderRequest, provider: "tunnel" | "codespaces") {
  const target = request === "server"
    ? `lo que diga el servidor (${PROVIDER_LABELS[provider]})`
    : PROVIDER_LABELS[provider];
  return `Entorno de los estudiantes: ${target}. Lo verán al recargar la página o en unos minutos.`;
}

const AGENT_NOT_CONFIGURED_MESSAGE =
  "Para usar el editor en la nube falta conectar la VM de editores una vez: corre bash deploy/produccion.sh aplicar en Cloud Shell.";

const VM_OFF_WARNING =
  "La VM de editores está apagada: enciéndela antes de la clase con bash deploy/clase.sh iniciar.";

export function registerWorkspaceProviderRoutes(app: express.Express, database: AppDatabase, service: WorkspaceService, now: () => number) {
  app.get("/api/workspaces/provider", async (_req, res) => {
    const provider = await service.currentProvider();
    return res.json(provider === "tunnel"
      ? { ok: true, provider, agentConfigured: service.isAgentConfigured() }
      : { ok: true, provider });
  });

  // --- Entorno de los estudiantes elegido por el administrador o el docente (0.7.19) ---
  // La tuerca de la extension lo muestra y lo cambia sin tocar las variables de Azure.
  async function adminProviderBody() {
    const state = await service.providerState();
    const relayTransport = service.config.transport === "relay";
    return {
      ok: true as const,
      ...state,
      agentConfigured: service.isAgentConfigured(),
      // En modo directo el backend no sabe si el agente escucha: null.
      agentOnline: relayTransport ? service.relay.isAgentOnline() : null,
      transport: service.config.transport,
      vmAutostart: Boolean(service.autostart),
    };
  }

  // Misma comprobacion que «Iniciar clase» (class-routes.ts): route-utils.resolveManagerSession.
  function resolveWorkspaceManagerSession(req: express.Request, res: express.Response) {
    return resolveManagerSession(database, req, res, "Solo el administrador o el docente eligen el entorno de los estudiantes.");
  }

  app.get("/api/admin/workspace-provider", async (req, res) => {
    try {
      if (!(await resolveWorkspaceManagerSession(req, res))) return;
      return res.json(await adminProviderBody());
    } catch (error) {
      return res.status(500).json({ ok: false, error: errorMessage(error) });
    }
  });

  app.put("/api/admin/workspace-provider", async (req, res) => {
    try {
      const session = await resolveWorkspaceManagerSession(req, res);
      if (!session) return;
      const request = normalizeWorkspaceProviderRequest((req.body ?? {}).provider);
      if (!request) {
        return res.status(400).json({ ok: false, error: "provider debe ser tunnel, codespaces o server." });
      }
      // Sin token del agente el editor en la nube no puede prepararse: se avisa aqui y no
      // cuando un estudiante pulse «Preparar mi editor». Volver al servidor siempre se puede.
      if (request === "tunnel" && !service.isAgentConfigured()) {
        return res.status(409).json({
          ok: false,
          code: "agent_not_configured",
          error: AGENT_NOT_CONFIGURED_MESSAGE,
          message: AGENT_NOT_CONFIGURED_MESSAGE,
        });
      }
      await saveWorkspaceProviderChoice(database, request, session.user.id, now());
      const body = await adminProviderBody();
      console.info(`[workspaces] entorno de los estudiantes: ${request} (activo ${body.provider}) por ${session.user.id}`);
      const vmOff = body.provider === "tunnel" && body.agentOnline === false && !body.vmAutostart;
      return res.json({
        ...body,
        message: providerChangedMessage(request, body.provider),
        ...(vmOff ? { warning: VM_OFF_WARNING } : {}),
      });
    } catch (error) {
      return res.status(500).json({ ok: false, error: errorMessage(error) });
    }
  });
}

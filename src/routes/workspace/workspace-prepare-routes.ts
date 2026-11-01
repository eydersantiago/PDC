// Rutas POST /api/workspaces/prepare y GET /api/workspaces/status del editor en la nube.
import type express from "express";
import { z } from "zod";
import type { AppDatabase } from "../../db/database.js";
import { workspaceVmStartupCommand } from "../../services/workspace/workspace-vm-commands.js";
import { type WorkspaceService } from "../../services/workspace/workspace-provider.js";
import { buildWorkspaceErrorPayload, buildWorkspaceInfo } from "../../services/workspace/workspace-agent-result.js";
import { normalizeRepoFullName, WorkspaceRequestError, type WorkspaceStatusPayload } from "../../services/workspace/workspace-config.js";
import { isStaffRole, resolveSession, type AppSession } from "../route-utils.js";
import { type WorkspacePreparationTracker, type TrackedPreparation } from "./workspace-preparation-tracker.js";
import { readQueryString } from "./workspace-relay-routes.js";

const prepareSchema = z.object({
  repoFullName: z.string().max(240),
  force: z.boolean().optional(),
  reconnect: z.boolean().optional(),
});

// status reenvia un prepare pendiente solo mientras la extension puede seguir esperando
// (12 min de consultas, mas margen): despues, un status cualquiera no lo resucita (p. ej.
// un «Rehacer» con la VM apagada que respaldaria la carpeta horas despues).
const RESEND_WINDOW_MS = 15 * 60 * 1000;

// La extension (fetchJsonWithTimeout) muestra `error` cuando el HTTP no es 2xx.
function withErrorField(payload: WorkspaceStatusPayload) {
  return payload.ok ? payload : { ...payload, error: payload.message || "No se pudo preparar el editor." };
}

// Docente y administrador no tienen a quien "avisar" (0.7.20): para los errores que
// ellos mismos resuelven, el mensaje dice que hacer. El estudiante ve el de siempre.
export function workspacePayloadForRole(payload: WorkspaceStatusPayload, role: string | undefined): WorkspaceStatusPayload {
  if (payload.ok || !isStaffRole(role)) return payload;
  const login = payload.workspace?.login || "";
  let message = "";
  if (payload.code === "login_not_allowed") {
    message = `La cuenta de GitHub ${login || "conectada"} no esta en WORKSPACE_ALLOWED_LOGINS del backend. ` +
      "Agregala a esa lista (o pon * para todas) en la configuracion del App Service de Azure; el backend se reinicia solo.";
  } else if (payload.code === "agent_unreachable") {
    message = "La VM de editores esta apagada: enciendela con bash deploy/clase.sh iniciar en Cloud Shell. Esta ventana seguira esperando.";
  } else if (payload.code === "agent_unauthorized") {
    message = "La VM de editores rechazo la conexion del backend: el token del agente no coincide. Corre bash deploy/produccion.sh aplicar en Cloud Shell.";
  } else if (payload.code === "reconnect_unsupported") {
    message = "La VM de editores tiene el agente anterior a 0.8.1 (no sabe reconectar). Actualizala desde Cloud Shell: " +
      `${workspaceVmStartupCommand()} y vuelve a pulsar «Reconectar».`;
  }
  return message ? { ...payload, message } : payload;
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

export function registerWorkspacePrepareStatusRoutes(app: express.Express, database: AppDatabase, service: WorkspaceService, now: () => number, tracker: WorkspacePreparationTracker) {
  const { tracked, dispatchWithEditorSession, trackKey, pruneTracked, recordEvent, rewriteEditorSessionIfMissing, resendPrepare, recordOutcome } = tracker;

  app.post("/api/workspaces/prepare", async (req, res) => {
    let session: AppSession | null = null;
    let repoFullName = "";
    try {
      session = await resolveSession(database, req);
      if (!session) return res.status(401).json(unauthorizedBody());
      if ((await service.currentProvider()) !== "tunnel") return res.status(409).json(codespacesBody());

      const parsed = prepareSchema.safeParse(req.body ?? {});
      repoFullName = parsed.success ? normalizeRepoFullName(parsed.data.repoFullName) : "";
      if (!parsed.success || !repoFullName) {
        return res.status(400).json(errorBody(
          "invalid_request",
          "Envia repoFullName (owner/nombre del repositorio de GitHub) y, si quieres rehacer el entorno, force: true.",
        ));
      }
      const force = parsed.data.force === true;
      const reconnect = parsed.data.reconnect === true;

      pruneTracked();
      const entry: TrackedPreparation = {
        startedAt: now(),
        force,
        deviceCodeLogged: false,
        dispatchPending: false,
        resendForce: force,
        reconnect,
        transientFailureLogged: false,
        waitedFor: "",
        lostPrepareResent: false,
      };
      tracked.set(trackKey(session, repoFullName), entry);
      await recordEvent(session, {
        source: "backend",
        category: "codespace",
        eventType: force || reconnect ? "prepare_environment_retry_started" : "prepare_environment_started",
        repoFullName,
        value: "tunnel",
        // mode "reconnect": el estudiante pidio reconectar el editor con su cuenta de GitHub.
        metadata: { provider: "tunnel", force, ...(reconnect ? { mode: "reconnect" } : {}) },
      });

      const { payload, delivered } = await dispatchWithEditorSession(session, req, { repoFullName, force, reconnect });
      entry.dispatchPending = !delivered;
      await recordOutcome(session, repoFullName, payload);
      return res.status(200).json(withErrorField(workspacePayloadForRole(payload, session.user.role)));
    } catch (error) {
      if (error instanceof WorkspaceRequestError) {
        const payload = buildWorkspaceErrorPayload(error.code, error.message, buildWorkspaceInfo(error.login, repoFullName));
        if (session && repoFullName) await recordOutcome(session, repoFullName, payload);
        return res.status(error.httpStatus).json(withErrorField(workspacePayloadForRole(payload, session?.user.role)));
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
      if ((await service.currentProvider()) !== "tunnel") return res.status(409).json(codespacesBody());

      repoFullName = normalizeRepoFullName(readQueryString(req.query.repoFullName));
      if (!repoFullName) {
        return res.status(400).json(errorBody("invalid_request", "Falta repoFullName (owner/nombre) en la consulta."));
      }

      // passive=1: la extension solo mira si ya hay editor (al entrar en la pagina del
      // repositorio). Ni reenvia prepares, ni enciende la VM, ni toca la telemetria de
      // una preparacion abierta (otra pestana puede estar esperandola).
      const passive = readQueryString(req.query.passive) === "1";
      let payload: WorkspaceStatusPayload;
      try {
        const key = trackKey(session, repoFullName);
        const tracking = tracked.get(key);
        const stale = tracking ? now() - tracking.startedAt > RESEND_WINDOW_MS : false;
        // Fuera de la ventana la extension ya no espera esa preparacion: se olvida
        // (ni reenvio, ni un «listo» horas despues con su force y su duracion).
        if (tracking && stale && !passive) tracked.delete(key);
        const entry = tracking && !passive && !stale ? tracking : undefined;
        if (entry?.dispatchPending) {
          // El prepare no llego al agente (VM apagada o agente desconectado):
          // se reenvia aqui, asi la espera termina sola cuando la VM vuelve.
          payload = (await resendPrepare(entry, session, req, repoFullName)).payload;
        } else {
          payload = await service.status({ userId: session.user.id, repoFullName, passive });
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
          // passive solo mira: la sesion de VS Code la renueva el primer clic (prepare).
          if (payload.status === "ready" && !passive) {
            await rewriteEditorSessionIfMissing(session, req, repoFullName, payload.workspace?.login || "");
          }
        }
      } catch (error) {
        if (!(error instanceof WorkspaceRequestError)) throw error;
        payload = buildWorkspaceErrorPayload(error.code, error.message, buildWorkspaceInfo(error.login, repoFullName));
        if (!passive) await recordOutcome(session, repoFullName, payload);
        return res.status(error.httpStatus).json(withErrorField(workspacePayloadForRole(payload, session.user.role)));
      }
      if (!passive) await recordOutcome(session, repoFullName, payload);
      return res.status(200).json(withErrorField(workspacePayloadForRole(payload, session.user.role)));
    } catch (error) {
      console.error("[workspaces] status fallo inesperado:", error);
      return res.status(500).json(errorBody(
        "internal_error",
        "Error interno del backend al consultar el editor. Intenta de nuevo.",
        repoFullName,
      ));
    }
  });
}

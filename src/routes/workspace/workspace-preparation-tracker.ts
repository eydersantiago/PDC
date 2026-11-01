// Editor en la nube: seguimiento de cada preparacion (userId:repo), sesion de VS Code para la VM, reenvios y eventos.
import type express from "express";
import { env } from "../../config/env.js";
import type { AppDatabase } from "../../db/database.js";
import type { BehaviorEventInput } from "../../types/app.js";
import { trimText } from "../../services/shared/text-utils.js";
import { type WorkspaceService } from "../../services/workspace/workspace-provider.js";
import { type WorkspaceEditorSession, type WorkspaceStatusPayload } from "../../services/workspace/workspace-config.js";
import { editorSessionTtlMs } from "../auth/editor-auth-routes.js";
import { errorMessage, getRequestBaseUrl, type AppSession } from "../route-utils.js";
import { type WorkspaceRouteDeps } from "./workspace-routes.js";

const TRACK_TTL_MS = 30 * 60 * 1000;

const TRACK_MAX = 1000;

const DAY_MS = 24 * 60 * 60 * 1000;

// Una sesion "tunnel" se reutiliza mientras le queden mas de 7 dias.
const EDITOR_SESSION_REUSE_MIN_MS = 7 * DAY_MS;

const EDITOR_SESSION_LABEL = "tunnel";

export type TrackedPreparation = {
  startedAt: number;
  force: boolean;
  deviceCodeLogged: boolean;
  /** El POST no llego al agente (desconectado o VM apagada): se reenvia en status. */
  dispatchPending: boolean;
  /** force del reenvio: el original, o false si se reenvia por not_found. */
  resendForce: boolean;
  /** Reconectar (0.8.1): el reenvio (VM apagada al pedirlo) tambien reconecta. */
  reconnect: boolean;
  /** Reenvio en curso: las consultas que llegan mientras tanto esperan el mismo. */
  redispatch?: Promise<{ payload: WorkspaceStatusPayload; delivered: boolean }>;
  /** Ya se registro un fallo transitorio de esta preparacion. */
  transientFailureLogged: boolean;
  /** Primer codigo transitorio visto (agent_unreachable, agent_timeout, vm_starting); "" si ninguno. */
  waitedFor: string;
  /** Ya se reenvio una vez el prepare porque el agente respondio not_found tras la espera. */
  lostPrepareResent: boolean;
};

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

export function createWorkspacePreparationTracker(database: AppDatabase, deps: WorkspaceRouteDeps, service: WorkspaceService, now: () => number) {
  // userId:repo -> inicio de la preparacion. Sirve para registrar una sola vez
  // el codigo de dispositivo y cuanto tardo el editor en quedar listo, aunque
  // la extension consulte status cada 3 s.
  const tracked = new Map<string, TrackedPreparation>();
  // Login de GitHub -> usuario de ADACEEN cuya sesion de VS Code le mando el backend a la VM por
  // ultima vez. Varias cuentas de ADACEEN con el mismo GitHub (las cuentas de prueba por rol,
  // src/services/accounts/test-accounts.ts) comparten el editor ws-<login>: al volver a una cuenta, status
  // reescribe la sesion aunque la suya siga vigente, para que VS Code no quede con la otra. En
  // memoria: tras un reinicio no se sabe y status hace lo de antes. Con un GitHub por estudiante
  // (el piloto) el dueño siempre es el mismo y nada cambia.
  const editorSessionOwners = new Map<string, string>();

  type DispatchInput = Parameters<typeof service.dispatch>[0];
  async function dispatchWithEditorSession(session: AppSession, req: express.Request, input: Omit<DispatchInput, "userId" | "editorSession">) {
    let sent = false;
    const result = await service.dispatch({
      ...input,
      userId: session.user.id,
      editorSession: async () => {
        const editor = await buildEditorSession(session, req);
        sent = Boolean(editor);
        return editor;
      },
    });
    const login = trimText(result.payload.workspace?.login).toLowerCase();
    if (sent && login && result.delivered && result.payload.ok) {
      if (editorSessionOwners.size >= TRACK_MAX && !editorSessionOwners.has(login)) editorSessionOwners.clear();
      editorSessionOwners.set(login, session.user.id);
    }
    return result;
  }

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

  // «Salir» (en este navegador o en otro) desactiva las sesiones editor, pero
  // la VM conserva la vieja en editor-session.json, y «Abrir mi editor» solo
  // consulta status si el editor guardado es reciente (hallazgo 5a). Con el
  // editor listo y sin una sesion "tunnel" que prepare reutilizaria, se
  // reenvia el prepare (idempotente: el agente escribe la sesion nueva y
  // responde sin relanzar nada) antes de contestar, asi VS Code abre ya
  // conectado. Si falla, status responde igual que antes.
  // Tambien si la VM tiene la sesion de otra cuenta de ADACEEN con el mismo GitHub
  // (editorSessionOwners).
  async function rewriteEditorSessionIfMissing(session: AppSession, req: express.Request, repoFullName: string, login: string) {
    if (trimText(req.header("x-session-id")) !== session.id) return;
    try {
      const reusable = await database.findReusableEditorSession({
        userId: session.user.id,
        label: EDITOR_SESSION_LABEL,
        minExpiresAt: new Date(Date.now() + EDITOR_SESSION_REUSE_MIN_MS),
      });
      const owner = editorSessionOwners.get(trimText(login).toLowerCase());
      if (reusable && (!owner || owner === session.user.id)) return;
      await dispatchWithEditorSession(session, req, {
        repoFullName,
        force: false,
        freshLogin: false,
      });
    } catch (error) {
      console.warn("[workspaces] no se pudo renovar la sesion del editor en status:", errorMessage(error));
    }
  }

  // Reenvia el POST /workspaces de una preparacion abierta. Un solo reenvio a
  // la vez aunque la extension consulte cada 3 s; si tampoco llega, el
  // siguiente status lo vuelve a intentar.
  function resendPrepare(entry: TrackedPreparation, session: AppSession, req: express.Request, repoFullName: string) {
    entry.redispatch = entry.redispatch || dispatchWithEditorSession(session, req, {
      repoFullName,
      force: entry.resendForce,
      reconnect: entry.reconnect,
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

  return { tracked, dispatchWithEditorSession, trackKey, pruneTracked, recordEvent, rewriteEditorSessionIfMissing, resendPrepare, recordOutcome };
}

export type WorkspacePreparationTracker = ReturnType<typeof createWorkspacePreparationTracker>;

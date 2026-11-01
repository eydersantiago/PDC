// Editores en la nube: traduce la respuesta del agente de la VM (o su ausencia) al contrato del navegador.
import { trimText } from "../shared/text-utils.js";
import { type WorkspaceState, type WorkspaceEditorEntry, isRecord, normalizeRepoFullName, type WorkspaceInfo, buildTunnelName, buildTunnelWebUrl, type WorkspaceStatusPayload } from "./workspace-config.js";

export const DEFAULT_VERIFICATION_URL = "https://github.com/login/device";

const MAX_EDITORS = 50;

const TUNNEL_NAME_RE = /^[a-z0-9][a-z0-9-]{0,39}$/;

const USER_CODE_RE = /^[A-Z0-9][A-Z0-9-]{3,15}$/;

export function cleanMessage(value: unknown, max = 500) {
  const text = trimText(typeof value === "string" ? value : "").replace(/\s+/g, " ");
  return text.length > max ? `${text.slice(0, max - 3)}...` : text;
}

function cleanCode(value: unknown) {
  const code = trimText(typeof value === "string" ? value : "");
  return /^[a-z0-9_]{1,60}$/.test(code) ? code : "";
}

function normalizeState(value: unknown): WorkspaceState | null {
  return value === "ready" || value === "device_code" || value === "pending" || value === "error" ? value : null;
}

function validTunnelName(value: unknown) {
  const name = trimText(value).toLowerCase();
  return TUNNEL_NAME_RE.test(name) ? name : "";
}

// Defensa en profundidad: solo se manda al estudiante a vscode.dev/tunnel/<nombre>/...
function validWebUrl(value: unknown, tunnelName: string) {
  const url = trimText(value);
  if (!url || url.length > 300) return "";
  try {
    const parsed = new URL(url);
    const prefix = `/tunnel/${tunnelName}/`;
    return parsed.protocol === "https:" && parsed.host === "vscode.dev" && parsed.pathname.startsWith(prefix) && !parsed.username
      ? url
      : "";
  } catch {
    return "";
  }
}

function validVerificationUrl(value: unknown) {
  const url = trimText(value);
  return /^https:\/\/(github\.com|microsoft\.com)\/[A-Za-z0-9/_-]{1,60}$/i.test(url) ? url : DEFAULT_VERIFICATION_URL;
}

function validIsoDate(value: unknown) {
  const text = trimText(value);
  return text && Number.isFinite(Date.parse(text)) ? new Date(text).toISOString() : null;
}

// repos del agente (0.7.20) -> editors: solo owner/nombre validos y URLs de ese tunel.
function validEditors(value: unknown, tunnelName: string): WorkspaceEditorEntry[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const editors: WorkspaceEditorEntry[] = [];
  const seen = new Set<string>();
  for (const item of value) {
    if (!isRecord(item)) continue;
    const repoFullName = normalizeRepoFullName(item.repo);
    const webUrl = validWebUrl(item.webUrl, tunnelName);
    if (!repoFullName || !webUrl || seen.has(repoFullName.toLowerCase())) continue;
    seen.add(repoFullName.toLowerCase());
    editors.push({ repoFullName, webUrl });
    if (editors.length >= MAX_EDITORS) break;
  }
  return editors;
}

export function buildWorkspaceInfo(login: string, repoFullName: string): WorkspaceInfo {
  return login
    ? { login, tunnelName: buildTunnelName(login), webUrl: buildTunnelWebUrl(login), repoFullName }
    : { login: "", tunnelName: "", webUrl: "", repoFullName };
}

export function buildWorkspaceErrorPayload(
  code: string,
  message: string,
  workspace: WorkspaceInfo,
  options: { retryable?: boolean } = {},
): WorkspaceStatusPayload {
  return {
    ok: false,
    provider: "tunnel",
    status: "error",
    workspace,
    message,
    code,
    ...(options.retryable ? { retryable: true } : {}),
  };
}

export const VM_STARTING_MESSAGE = "Encendiendo la VM de editores (1-2 min)...";

export const AGENT_UNREACHABLE_MESSAGE = "El editor esta apagado. Avisa al docente; esta ventana seguira esperando.";

/** La VM se esta encendiendo: pendiente, no error (la extension sigue consultando). */
export function buildVmStartingPayload(workspace: WorkspaceInfo): WorkspaceStatusPayload {
  return {
    ok: true,
    provider: "tunnel",
    status: "pending",
    workspace,
    code: "vm_starting",
    retryable: true,
    message: VM_STARTING_MESSAGE,
  };
}

export type AgentCallResult =
  | { kind: "response"; status: number; json: unknown }
  | { kind: "timeout" }
  | { kind: "unreachable"; detail: string };

// Traduce la respuesta del agente (o su ausencia) al contrato del navegador.
/**
 * Reconectar (0.8.1): el agente de la VM anterior ignora reconnect y responde como un
 * prepare normal (con el tunel listo a nombre de la otra cuenta, otra vez «no se encuentra»).
 * El agente nuevo marca su respuesta con reconnect: true.
 */
export const RECONNECT_UNSUPPORTED_MESSAGE =
  "Tu editor en la nube todavia no puede reconectarse solo: la VM de editores esta desactualizada. Avisa al docente.";

export function agentIgnoredReconnect(result: AgentCallResult) {
  return result.kind === "response"
    && result.status >= 200
    && result.status < 300
    && isRecord(result.json)
    && result.json.reconnect !== true;
}

export function mapAgentResult(
  result: AgentCallResult,
  context: { login: string; repoFullName: string },
): WorkspaceStatusPayload {
  const base = buildWorkspaceInfo(context.login, context.repoFullName);

  if (result.kind === "timeout") {
    return buildWorkspaceErrorPayload(
      "agent_timeout",
      "La VM de editores no respondio a tiempo. Intenta de nuevo en un momento.",
      base,
      { retryable: true },
    );
  }
  if (result.kind === "unreachable") {
    return buildWorkspaceErrorPayload("agent_unreachable", AGENT_UNREACHABLE_MESSAGE, base, { retryable: true });
  }

  const body = isRecord(result.json) ? result.json : {};
  const message = cleanMessage(body.message);
  const agentCode = cleanCode(body.code);
  // repos del agente: tambien en 404/409 (el repositorio pedido aun no esta, pero
  // los demas se pueden ofrecer en «Tus repositorios en el editor»).
  const editors = validEditors(body.repos, validTunnelName(body.tunnelName) || base.tunnelName);
  const withEditors = <T extends WorkspaceStatusPayload>(payload: T): T => (editors ? { ...payload, editors } : payload);

  if (result.status === 401 || result.status === 403) {
    return buildWorkspaceErrorPayload(
      "agent_unauthorized",
      "La VM de editores rechazo la conexion del backend (configuracion). Avisa al docente.",
      base,
    );
  }
  if (result.status === 429) {
    return buildWorkspaceErrorPayload(
      "agent_busy",
      message || "La VM de editores esta ocupada preparando otros entornos. Intenta de nuevo en un minuto.",
      base,
    );
  }
  if (result.status === 404 && agentCode === "not_found") {
    return withEditors(buildWorkspaceErrorPayload(
      "not_found",
      message || "Todavia no hay un editor preparado para tu cuenta. Pulsa Preparar mi editor.",
      base,
    ));
  }
  // 409 busy_other_repo (0.7.20): la VM esta terminando otro repositorio de
  // este usuario. Reintentable: la extension sigue esperando y, como dispatch lo
  // cuenta como no entregado, cada status reenvia el prepare hasta que la VM lo acepta.
  if (result.status === 409 && agentCode === "busy_other_repo" && message) {
    return withEditors(buildWorkspaceErrorPayload(agentCode, message, base, { retryable: true }));
  }
  // 400 (entrada rechazada) y 409 (agente anterior: otro repo ya clonado):
  // el mensaje del agente ya esta escrito para el estudiante.
  if ((result.status === 400 || result.status === 409) && body.state === "error" && message) {
    return withEditors(buildWorkspaceErrorPayload(agentCode || "agent_rejected", message, base));
  }
  if (result.status < 200 || result.status >= 300) {
    return buildWorkspaceErrorPayload(
      "agent_error",
      `La VM de editores respondio con un error (HTTP ${result.status}). Intenta de nuevo o avisa al docente.`,
      base,
    );
  }

  const state = normalizeState(body.state);
  if (!state) {
    return buildWorkspaceErrorPayload(
      "agent_invalid_response",
      "La VM de editores respondio algo inesperado. Avisa al docente.",
      base,
    );
  }

  const tunnelName = validTunnelName(body.tunnelName) || base.tunnelName;
  const workspace: WorkspaceInfo = {
    login: context.login,
    tunnelName,
    webUrl: validWebUrl(body.webUrl, tunnelName) || buildTunnelWebUrl(context.login, tunnelName),
    repoFullName: context.repoFullName,
  };

  // Consulta solo por login (agente anterior, o PDC en modo de compatibilidad):
  // el agente puede responder por OTRO repositorio. Un "ready" de otro repo no
  // abre este: la extension pasa por prepare, que lo clona en su carpeta.
  const answeredRepo = normalizeRepoFullName(body.repo);
  if (state === "ready" && answeredRepo && context.repoFullName
    && answeredRepo.toLowerCase() !== context.repoFullName.toLowerCase()) {
    return withEditors(buildWorkspaceErrorPayload(
      "not_found",
      `${context.repoFullName} todavia no esta en tu editor. Pulsa Abrir en mi editor y ADACEEN lo clona.`,
      { ...base, tunnelName },
    ));
  }

  if (state === "error") {
    return withEditors(buildWorkspaceErrorPayload(
      agentCode || "agent_state_error",
      message || "No se pudo preparar el editor en la VM.",
      workspace,
    ));
  }

  if (state === "device_code") {
    const userCode = trimText(body.deviceCode).toUpperCase();
    if (!USER_CODE_RE.test(userCode)) {
      return withEditors({
        ok: true,
        provider: "tunnel",
        status: "pending",
        workspace,
        message: message || "Esperando el codigo de autorizacion de GitHub...",
      });
    }
    return withEditors({
      ok: true,
      provider: "tunnel",
      status: "device_code",
      workspace,
      deviceCode: {
        userCode,
        verificationUrl: validVerificationUrl(body.verificationUrl),
        expiresAt: validIsoDate(body.expiresAt),
      },
      ...(message ? { message } : {}),
    });
  }

  return withEditors({ ok: true, provider: "tunnel", status: state, workspace, ...(message ? { message } : {}) });
}

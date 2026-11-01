// Editores en la nube: tipos del contrato, configuracion, error del pedido y nombres validos (login, repositorio, tunel).
import { env } from "../../config/env.js";
import { type VmAutostarter } from "../infra/gcp-compute.js";
import { trimText } from "../shared/text-utils.js";
import { type WorkspaceRelay } from "./workspace-relay.js";

export type WorkspaceProviderName = "tunnel" | "codespaces";

export type WorkspaceState = "ready" | "device_code" | "pending" | "error";

export type WorkspaceAgentTransport = "direct" | "relay";

export type WorkspaceConfig = {
  provider: WorkspaceProviderName;
  /** direct: HTTP a agentUrl. relay: el agente recoge las peticiones (VM sin IP publica). */
  transport: WorkspaceAgentTransport;
  agentUrl: string;
  agentToken: string;
  agentTimeoutMs: number;
  allowedLogins: string[];
  githubApiBaseUrl: string;
};

export type WorkspaceInfo = {
  login: string;
  tunnelName: string;
  webUrl: string;
  repoFullName: string;
};

export type WorkspaceDeviceCode = {
  userCode: string;
  verificationUrl: string;
  expiresAt: string | null;
};

/** Un repositorio que ya esta en el editor del estudiante (0.7.20). */
export type WorkspaceEditorEntry = {
  repoFullName: string;
  webUrl: string;
};

export type WorkspaceStatusPayload = {
  ok: boolean;
  provider: "tunnel";
  status: WorkspaceState;
  workspace: WorkspaceInfo;
  deviceCode?: WorkspaceDeviceCode;
  message?: string;
  code?: string;
  retryable?: boolean;
  /** Repositorios ya clonados en la VM para este estudiante (agente 0.7.20 o posterior). */
  editors?: WorkspaceEditorEntry[];
};

/**
 * Sesion editor que la VM escribe en /home/ws-<login>/.adaceen/editor-session.json
 * para que VS Code del tunel quede vinculado sin pasos (seccion 2.3).
 */
export type WorkspaceEditorSession = {
  sessionId: string;
  backendUrl: string;
  expiresAt: string;
  userName: string;
  userEmail: string;
};

export type FetchLike = (url: string, init?: RequestInit) => Promise<Response>;

/**
 * Login de GitHub (y su id numerico, si se conoce: es publico y sirve para el
 * correo noreply ID+login@users.noreply.github.com de los commits en la VM).
 */
export type GithubLoginReader = (accessToken: string) => Promise<string | { login: string; id?: number }>;

/**
 * Lo que GitHub dice de un repositorio (consultado con el token del usuario, que
 * tiene su propio cupo de peticiones; el token no sale de aqui): visible (y si es
 * privado), no visible (404: no existe o es privado sin acceso) o desconocido
 * (GitHub no respondio: se sigue y la VM intenta el clon publico).
 */
export type GithubRepoAccess =
  | { state: "visible"; private: boolean; fullName: string }
  | { state: "not_visible" }
  | { state: "unknown" };

export type GithubRepoAccessReader = (accessToken: string, repoFullName: string) => Promise<GithubRepoAccess>;

export type WorkspaceProviderDeps = {
  fetch?: FetchLike;
  readGithubLogin?: GithubLoginReader;
  /** Acceso al repositorio (por defecto GET /repos/{owner}/{repo} con el token del estudiante). */
  readGithubRepoAccess?: GithubRepoAccessReader;
  config?: Partial<WorkspaceConfig>;
  now?: () => number;
  /** Cola del modo relay (por defecto la del proceso). */
  relay?: WorkspaceRelay;
  /** Encendido de la VM (por defecto segun WORKSPACE_VM_AUTOSTART; null = apagado). */
  autostart?: VmAutostarter | null;
};

// La carpeta de un repositorio en la VM (parse.mjs, normalizarCarpeta).
const FOLDER_RE = /^[A-Za-z0-9_][A-Za-z0-9._-]{0,99}$/;

// Regla de nuevo-tunel.sh: ws-<login> tiene que caber en un usuario Linux.
const WORKSPACE_LOGIN_RE = /^[a-z0-9][a-z0-9-]{0,27}$/;

const REPO_OWNER_RE = /^[A-Za-z0-9][A-Za-z0-9-]{0,38}$/;

const REPO_NAME_RE = /^[A-Za-z0-9._-]{1,100}$/;

// Error previo a hablar con el agente (sin GitHub, login fuera del piloto,
// agente sin configurar...). httpStatus es el codigo que debe usar la ruta.
export class WorkspaceRequestError extends Error {
  readonly code: string;
  readonly httpStatus: number;
  readonly login: string;

  constructor(code: string, message: string, httpStatus: number, login = "") {
    super(message);
    this.name = "WorkspaceRequestError";
    this.code = code;
    this.httpStatus = httpStatus;
    this.login = login;
  }
}

export function resolveWorkspaceConfig(overrides: Partial<WorkspaceConfig> = {}): WorkspaceConfig {
  const envTransport = env.workspaceAgentTransport === "direct" || env.workspaceAgentTransport === "relay"
    ? env.workspaceAgentTransport
    : null;
  const agentUrl = overrides.agentUrl ?? env.workspaceAgentUrl;
  const merged: WorkspaceConfig = {
    provider: env.workspaceProvider,
    // Sin eleccion explicita: directo si hay URL del agente, relay si no.
    transport: envTransport || (trimText(agentUrl) ? "direct" : "relay"),
    agentUrl: env.workspaceAgentUrl,
    agentToken: env.workspaceAgentToken,
    agentTimeoutMs: env.workspaceAgentTimeoutMs,
    allowedLogins: env.workspaceAllowedLogins,
    githubApiBaseUrl: env.githubApiBaseUrl,
    ...overrides,
  };
  return {
    ...merged,
    provider: merged.provider === "tunnel" ? "tunnel" : "codespaces",
    transport: merged.transport === "relay" ? "relay" : "direct",
    agentUrl: trimText(merged.agentUrl).replace(/\/+$/, ""),
    agentToken: trimText(merged.agentToken),
    agentTimeoutMs: Number.isFinite(merged.agentTimeoutMs) && merged.agentTimeoutMs > 0 ? merged.agentTimeoutMs : 15_000,
    allowedLogins: normalizeAllowedLogins(merged.allowedLogins),
    githubApiBaseUrl: trimText(merged.githubApiBaseUrl).replace(/\/+$/, "") || "https://api.github.com",
  };
}

// Lista del piloto en minusculas. Vacia o con "*" = cualquier usuario activo
// de ADACEEN con GitHub conectado (sin mantener la lista a mano).
function normalizeAllowedLogins(values: string[] | undefined) {
  const logins = (values || []).map((login) => trimText(login).toLowerCase()).filter(Boolean);
  return logins.includes("*") ? [] : logins;
}

// Login de GitHub en minusculas, o "" si nuevo-tunel.sh no lo aceptaria.
export function normalizeWorkspaceLogin(value: unknown) {
  const login = trimText(value).toLowerCase();
  return WORKSPACE_LOGIN_RE.test(login) ? login : "";
}

// "owner/nombre" valido para GitHub (sin .git), o "".
export function normalizeRepoFullName(value: unknown) {
  const match = trimText(value).match(/^([^/\s]+)\/([^/\s]+?)(?:\.git)?$/);
  if (!match) return "";
  const [, owner, name] = match;
  if (!REPO_OWNER_RE.test(owner) || !REPO_NAME_RE.test(name) || name === "." || name === "..") return "";
  return `${owner}/${name}`;
}

// Misma regla que nuevo-tunel.sh: Dev Tunnels limita el nombre a 20 caracteres.
export function buildTunnelName(login: string) {
  return `ad-${login.slice(0, 17)}`;
}

// Sin carpeta, ~/proyecto: lo de antes de 0.7.20 (un repositorio por estudiante).
export function buildTunnelWebUrl(login: string, tunnelName = buildTunnelName(login), folder = "proyecto") {
  const safeFolder = FOLDER_RE.test(folder) && !/\.bak-\d/.test(folder) ? folder : "proyecto";
  return `https://vscode.dev/tunnel/${tunnelName}/home/ws-${login}/${safeFolder}`;
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

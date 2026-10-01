// Entornos de los estudiantes por VS Code Tunnels (fase 3 de docs/workspaces-tunnel.md).
//
// PDC no crea el tunel: le pide al agente HTTP de la VM de editores
// (deploy/gcp/workspaces/agente/) que corra nuevo-tunel.sh para el login de
// GitHub del estudiante, y traduce su respuesta al contrato que ya habla la
// extension de navegador (browser-ext-prod/services/workspace.service.js):
//
//   { ok, provider: "tunnel", status: "ready" | "device_code" | "pending" | "error",
//     workspace: { login, tunnelName, webUrl, repoFullName },
//     deviceCode?: { userCode, verificationUrl, expiresAt }, message?, code?, retryable? }
//
// retryable: true marca los errores transitorios del agente (desconectado,
// sin respuesta a tiempo, VM encendiendose): la extension 0.7.11 sigue
// consultando en vez de cortar la espera. Las anteriores lo ignoran.
//
// `fetch`, el lector del login de GitHub y el autoencendido de la VM son
// inyectables para probar sin red.
//
// Que proveedor esta activo lo decide ADACEEN_WORKSPACE_PROVIDER, salvo que un
// administrador o docente elija otro en la tuerca de la extension (0.7.19,
// workspace-provider-choice.ts): providerState() y currentProvider().
//
// Un editor, varios repositorios (0.7.20): el estado se pide por repositorio
// (GET /workspaces/<login>?repo=owner/nombre) y webUrl abre la carpeta de ese
// repositorio en el mismo tunel; editors trae los que ya estan en la VM. Antes
// de pedirle a la VM un repositorio se comprueba con GitHub que el estudiante lo
// vea (mensaje claro si no) y, si es privado, se manda su token para clonarlo.
import { createHash } from "node:crypto";
import { env } from "../config/env.js";
import type { AppDatabase } from "../db/database.js";
import { getDefaultVmAutostarter, type VmAutostarter } from "./gcp-compute.js";
import { trimText } from "./text-utils.js";
import { readWorkspaceProviderChoice, resolveWorkspaceProviderState } from "./workspace-provider-choice.js";
import { workspaceRelay, type WorkspaceRelay } from "./workspace-relay.js";

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
export type GithubLoginReader = (accessToken: string) => Promise<string>;

/**
 * Lo que GitHub dice de un repositorio con el token del estudiante:
 * visible (y si es privado), no visible (404: no existe o no tiene acceso) o
 * desconocido (GitHub no respondio: se sigue y la VM lo intenta con el token).
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

// getAppSetting: el entorno que se eligio en la tuerca (0.7.19). Opcional para las pruebas
// que pasan una base falsa: sin el, manda config.provider.
type WorkspaceDatabase = Pick<AppDatabase, "getGithubUserTokenForUser"> & Partial<Pick<AppDatabase, "getAppSetting">>;

export const DEFAULT_VERIFICATION_URL = "https://github.com/login/device";
const GITHUB_TIMEOUT_MS = 10_000;
const LOGIN_CACHE_TTL_MS = 5 * 60 * 1000;
const LOGIN_CACHE_MAX = 500;
const REPO_ACCESS_CACHE_TTL_MS = 5 * 60 * 1000;
// Agente anterior a 0.7.20 detras del relay: rechaza GET con ?repo=. Se le
// consulta solo por login un rato antes de volver a probar.
const LEGACY_AGENT_RETRY_MS = 10 * 60 * 1000;
const MAX_EDITORS = 50;
// La carpeta de un repositorio en la VM (parse.mjs, normalizarCarpeta).
const FOLDER_RE = /^[A-Za-z0-9_][A-Za-z0-9._-]{0,99}$/;

// Regla de nuevo-tunel.sh: ws-<login> tiene que caber en un usuario Linux.
const WORKSPACE_LOGIN_RE = /^[a-z0-9][a-z0-9-]{0,27}$/;
const REPO_OWNER_RE = /^[A-Za-z0-9][A-Za-z0-9-]{0,38}$/;
const REPO_NAME_RE = /^[A-Za-z0-9._-]{1,100}$/;
const TUNNEL_NAME_RE = /^[a-z0-9][a-z0-9-]{0,39}$/;
const USER_CODE_RE = /^[A-Z0-9][A-Z0-9-]{3,15}$/;

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

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function cleanMessage(value: unknown, max = 500) {
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
    return buildWorkspaceErrorPayload(
      "not_found",
      message || "Todavia no hay un editor preparado para tu cuenta. Pulsa Preparar mi editor.",
      base,
    );
  }
  // 409 busy_other_repo (0.7.20): la VM esta terminando otro repositorio de
  // este estudiante; en segundos sigue con este. Reintentable: la extension
  // sigue esperando y status reenvia el prepare cuando el otro termina.
  if (result.status === 409 && agentCode === "busy_other_repo" && message) {
    return buildWorkspaceErrorPayload(agentCode, message, base, { retryable: true });
  }
  // 400 (entrada rechazada) y 409 (agente anterior: otro repo ya clonado):
  // el mensaje del agente ya esta escrito para el estudiante.
  if ((result.status === 400 || result.status === 409) && body.state === "error" && message) {
    return buildWorkspaceErrorPayload(agentCode || "agent_rejected", message, base);
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
  const editors = validEditors(body.repos, tunnelName);
  const withEditors = <T extends WorkspaceStatusPayload>(payload: T): T => (editors ? { ...payload, editors } : payload);

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

// Lee el cuerpo dentro de la misma ventana de tiempo: un cuerpo que no llega
// tambien cuenta como timeout.
async function requestJson(fetchImpl: FetchLike, url: string, init: RequestInit, timeoutMs: number) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetchImpl(url, { ...init, signal: controller.signal });
    const text = await response.text();
    let json: unknown = null;
    try {
      json = text ? JSON.parse(text) : null;
    } catch {
      json = null;
    }
    return { status: response.status, json };
  } finally {
    clearTimeout(timer);
  }
}

function isAbortError(error: unknown) {
  const name = error && typeof error === "object" && "name" in error ? String((error as { name?: unknown }).name) : "";
  return name === "AbortError" || name === "TimeoutError";
}

// Lector por defecto: GET {githubApiBaseUrl}/user con el token OAuth del estudiante.
export function createGithubLoginReader(fetchImpl: FetchLike, githubApiBaseUrl: string): GithubLoginReader {
  return async (accessToken: string) => {
    let result: { status: number; json: unknown };
    try {
      result = await requestJson(fetchImpl, `${githubApiBaseUrl}/user`, {
        headers: {
          Accept: "application/vnd.github+json",
          "X-GitHub-Api-Version": "2022-11-28",
          "User-Agent": "adaceen-workspaces/1.0",
          Authorization: `Bearer ${accessToken}`,
        },
      }, GITHUB_TIMEOUT_MS);
    } catch {
      throw new WorkspaceRequestError(
        "github_unavailable",
        "No se pudo verificar tu cuenta de GitHub (GitHub no respondio). Intenta de nuevo en unos segundos.",
        200,
      );
    }
    if (result.status === 401) {
      throw new WorkspaceRequestError(
        "github_token_invalid",
        "Tu conexion con GitHub ya no es valida. Vuelve a conectar tu cuenta de GitHub en ADACEEN.",
        409,
      );
    }
    const login = isRecord(result.json) ? trimText(result.json.login) : "";
    if (result.status < 200 || result.status >= 300 || !login) {
      throw new WorkspaceRequestError(
        "github_unavailable",
        `No se pudo verificar tu cuenta de GitHub (HTTP ${result.status}). Intenta de nuevo en unos segundos.`,
        200,
      );
    }
    return login;
  };
}

// Lector por defecto: GET {githubApiBaseUrl}/repos/{owner}/{repo} con el token del
// estudiante. 404 = no existe o su cuenta no lo ve (privado sin acceso, o el token
// sin el scope repo). Un fallo de red o un 5xx no detiene nada: "unknown".
export function createGithubRepoAccessReader(fetchImpl: FetchLike, githubApiBaseUrl: string): GithubRepoAccessReader {
  return async (accessToken: string, repoFullName: string) => {
    const [owner, name] = repoFullName.split("/");
    let result: { status: number; json: unknown };
    try {
      result = await requestJson(fetchImpl, `${githubApiBaseUrl}/repos/${encodeURIComponent(owner)}/${encodeURIComponent(name)}`, {
        headers: {
          Accept: "application/vnd.github+json",
          "X-GitHub-Api-Version": "2022-11-28",
          "User-Agent": "adaceen-workspaces/1.0",
          Authorization: `Bearer ${accessToken}`,
        },
      }, GITHUB_TIMEOUT_MS);
    } catch {
      return { state: "unknown" };
    }
    if (result.status === 401) {
      throw new WorkspaceRequestError(
        "github_token_invalid",
        "Tu conexion con GitHub ya no es valida. Vuelve a conectar tu cuenta de GitHub en ADACEEN.",
        409,
      );
    }
    if (result.status === 404) return { state: "not_visible" };
    if (result.status === 403) {
      // La organizacion (p. ej. la de GitHub Classroom) tiene restringidas las
      // apps OAuth y no aprobo la de ADACEEN: el clon con ese token tambien
      // fallaria. Otro 403 (limite de peticiones) no dice nada del repositorio.
      const apiMessage = isRecord(result.json) ? trimText(result.json.message) : "";
      if (/oauth app access restrictions/i.test(apiMessage)) {
        throw new WorkspaceRequestError(
          "org_oauth_restricted",
          `La organizacion ${owner} todavia no aprobo ADACEEN para sus repositorios privados. Pidele al docente (dueno de la organizacion) que lo apruebe en GitHub: Settings > Third-party Access > OAuth app policy. Tambien puedes solicitarlo tu al conectar GitHub.`,
          409,
        );
      }
      return { state: "unknown" };
    }
    if (result.status < 200 || result.status >= 300 || !isRecord(result.json)) return { state: "unknown" };
    const fullName = normalizeRepoFullName(result.json.full_name) || repoFullName;
    return { state: "visible", private: result.json.private === true, fullName };
  };
}

function hasRepoScope(scopes: unknown) {
  return String(scopes || "").split(/[\s,]+/).some((scope) => scope === "repo");
}

export function createWorkspaceService(database: WorkspaceDatabase, deps: WorkspaceProviderDeps = {}) {
  const config = resolveWorkspaceConfig(deps.config);
  const fetchImpl: FetchLike = deps.fetch || ((url, init) => fetch(url, init));
  const readGithubLogin = deps.readGithubLogin || createGithubLoginReader(fetchImpl, config.githubApiBaseUrl);
  // GET /repos/{owner}/{repo} con el token del estudiante (inyectable en las pruebas).
  const readGithubRepoAccess = deps.readGithubRepoAccess || createGithubRepoAccessReader(fetchImpl, config.githubApiBaseUrl);
  const now = deps.now || Date.now;
  const relay = deps.relay || workspaceRelay;
  const autostart = deps.autostart === undefined ? getDefaultVmAutostarter() : deps.autostart;
  const loginCache = new Map<string, { login: string; expiresAt: number }>();
  const repoAccessCache = new Map<string, { access: GithubRepoAccess; expiresAt: number }>();
  // Agente anterior (relay que rechaza ?repo=): hasta cuando se le pregunta solo por login.
  let legacyAgentUntil = 0;

  function isAgentConfigured() {
    return config.transport === "relay"
      ? Boolean(config.agentToken)
      : Boolean(config.agentUrl && config.agentToken);
  }

  function rememberLogin(key: string, login: string) {
    if (loginCache.size >= LOGIN_CACHE_MAX) {
      const current = now();
      for (const [cachedKey, entry] of loginCache) {
        if (entry.expiresAt <= current) loginCache.delete(cachedKey);
      }
      if (loginCache.size >= LOGIN_CACHE_MAX) loginCache.clear();
    }
    loginCache.set(key, { login, expiresAt: now() + LOGIN_CACHE_TTL_MS });
  }

  // Login de GitHub del estudiante a partir de su token OAuth guardado.
  // prepare lo valida siempre contra GitHub; status usa una cache corta para no
  // llamar a GitHub cada 3 s mientras la extension consulta.
  async function resolveStudentLogin(userId: string, options: { fresh: boolean }) {
    return (await resolveStudent(userId, options)).login;
  }

  async function resolveStudent(userId: string, options: { fresh: boolean }) {
    const token = await database.getGithubUserTokenForUser(userId);
    const accessToken = trimText(token?.accessToken);
    if (!accessToken) {
      throw new WorkspaceRequestError(
        "github_not_connected",
        "Conecta tu cuenta de GitHub en ADACEEN: el editor se registra a tu nombre.",
        409,
      );
    }

    const cacheKey = `${userId}:${createHash("sha256").update(accessToken).digest("hex").slice(0, 16)}`;
    const cached = loginCache.get(cacheKey);
    let rawLogin: string;
    if (!options.fresh && cached && cached.expiresAt > now()) {
      rawLogin = cached.login;
    } else {
      rawLogin = await readGithubLogin(accessToken);
      rememberLogin(cacheKey, rawLogin);
    }

    const login = normalizeWorkspaceLogin(rawLogin);
    if (!login) {
      throw new WorkspaceRequestError(
        "login_unsupported",
        `Tu usuario de GitHub (${cleanMessage(rawLogin, 60)}) no es compatible con el editor por tunel (maximo 28 caracteres: letras, digitos y guiones). Pide ayuda al docente.`,
        409,
        trimText(rawLogin).toLowerCase(),
      );
    }
    if (config.allowedLogins.length && !config.allowedLogins.includes(login)) {
      throw new WorkspaceRequestError(
        "login_not_allowed",
        `La cuenta de GitHub ${login} no esta en la lista del piloto. Pide al docente que la agregue.`,
        403,
        login,
      );
    }
    return { login, accessToken, scopes: trimText((token as { scopes?: unknown } | null)?.scopes) };
  }

  // ¿El estudiante ve el repositorio en GitHub? Cache corta por usuario y repo:
  // status reenvia el prepare mientras la VM arranca. Solo se guarda "visible":
  // quien acaba de aceptar la invitacion de Classroom o de reconectar GitHub
  // no tiene que esperar a que venza la cache.
  async function checkRepoAccess(userId: string, accessToken: string, repoFullName: string) {
    const key = `${userId}:${repoFullName.toLowerCase()}`;
    const cached = repoAccessCache.get(key);
    if (cached && cached.expiresAt > now()) return cached.access;
    const access = await readGithubRepoAccess(accessToken, repoFullName);
    if (access.state === "visible") {
      if (repoAccessCache.size >= LOGIN_CACHE_MAX) repoAccessCache.clear();
      repoAccessCache.set(key, { access, expiresAt: now() + REPO_ACCESS_CACHE_TTL_MS });
    }
    return access;
  }

  async function callAgent(method: "GET" | "POST", path: string, body?: unknown): Promise<AgentCallResult> {
    if (config.transport === "relay") {
      // A15.3: la VM no tiene IP publica; el agente recoge la peticion por HTTPS de salida.
      return relay.request(method, path, body, config.agentTimeoutMs);
    }
    try {
      const { status, json } = await requestJson(fetchImpl, `${config.agentUrl}${path}`, {
        method,
        headers: {
          Accept: "application/json",
          "x-agent-token": config.agentToken,
          // Si el agente se publica con Dev Tunnels, evita la pagina intermedia anti-phishing.
          "X-Tunnel-Skip-AntiPhishing-Page": "true",
          ...(body === undefined ? {} : { "Content-Type": "application/json; charset=utf-8" }),
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      }, config.agentTimeoutMs);
      return { kind: "response", status, json };
    } catch (error) {
      if (isAbortError(error)) return { kind: "timeout" };
      return { kind: "unreachable", detail: String(error) };
    }
  }

  function logAgentProblem(action: string, login: string, result: AgentCallResult, payload: WorkspaceStatusPayload) {
    if (payload.ok) return;
    const detail = result.kind === "response"
      ? `HTTP ${result.status} ${isRecord(result.json) ? cleanMessage(result.json.detail || result.json.message, 300) : ""}`
      : result.kind === "unreachable" ? result.detail : "timeout";
    console.warn(`[workspaces] ${action} login=${login} code=${payload.code || ""} ${detail}`.trim());
  }

  function ensureAgentConfigured() {
    if (!isAgentConfigured()) {
      throw new WorkspaceRequestError(
        "agent_not_configured",
        config.transport === "relay"
          ? "El editor por tunel esta activo pero el backend no tiene WORKSPACE_AGENT_TOKEN para la VM de editores. Avisa al docente."
          : "El editor por tunel esta activo pero el backend no tiene configurada la VM de editores (WORKSPACE_AGENT_URL / WORKSPACE_AGENT_TOKEN). Avisa al docente.",
        503,
      );
    }
  }

  // Sin respuesta del agente (desconectado o sin contestar a tiempo) y con
  // autoencendido: se mira la VM y se enciende si esta apagada. vmOff dice si
  // la peticion no pudo llegar al agente porque la VM no estaba encendida.
  async function withAutostart(result: AgentCallResult, payload: WorkspaceStatusPayload, workspace: WorkspaceInfo) {
    if (!autostart || (result.kind !== "unreachable" && result.kind !== "timeout")) {
      return { payload, vmOff: false };
    }
    const outcome = await autostart.ensureStarted();
    if (outcome.state !== "starting") return { payload, vmOff: false };
    return { payload: buildVmStartingPayload(workspace), vmOff: outcome.vmStatus !== "RUNNING" };
  }

  /**
   * POST /workspaces al agente. delivered = false cuando la peticion seguro
   * no llego (agente desconectado o VM apagada): la ruta la reenvia en el
   * siguiente status, cuando el agente vuelva.
   */
  async function dispatch(input: {
    userId: string;
    repoFullName: string;
    force: boolean;
    /** Se llama despues de validar el login: no se crean sesiones para quien no puede preparar. */
    editorSession?: () => Promise<WorkspaceEditorSession | undefined>;
    freshLogin?: boolean;
  }) {
    ensureAgentConfigured();
    const student = await resolveStudent(input.userId, { fresh: input.freshLogin !== false });
    const { login } = student;
    // Antes de despertar a la VM: si GitHub no le muestra el repositorio, el clon
    // fallaria igual. Mensaje claro aqui, sin esperar a la VM.
    const access = await checkRepoAccess(input.userId, student.accessToken, input.repoFullName);
    if (access.state === "not_visible") {
      const scopeHint = hasRepoScope(student.scopes)
        ? "Revisa que el repositorio exista y que tu cuenta tenga acceso (si es de una organizacion o de GitHub Classroom, acepta primero la invitacion)."
        : "Si es privado, vuelve a conectar tu cuenta de GitHub en ADACEEN: la conexion actual no tiene permiso para repositorios privados.";
      throw new WorkspaceRequestError(
        "repo_not_accessible",
        `GitHub no muestra ${input.repoFullName} para tu cuenta ${login}. ${scopeHint}`,
        409,
        login,
      );
    }
    // El token del estudiante solo viaja si hace falta: repositorio privado o
    // GitHub sin responder (mejor clonar con el que fallar si era privado).
    const cloneToken = access.state === "visible" && !access.private ? undefined : student.accessToken;
    const editorSession = input.editorSession ? await input.editorSession() : undefined;
    const result = await callAgent("POST", "/workspaces", {
      login,
      repo: input.repoFullName,
      force: input.force,
      ...(editorSession ? { editorSession } : {}),
      ...(cloneToken ? { cloneToken } : {}),
    });
    const mapped = mapAgentResult(result, { login, repoFullName: input.repoFullName });
    logAgentProblem("prepare", login, result, mapped);
    const { payload, vmOff } = await withAutostart(result, mapped, mapped.workspace);
    return { payload, delivered: result.kind !== "unreachable" && !vmOff };
  }

  async function prepare(input: {
    userId: string;
    repoFullName: string;
    force: boolean;
    editorSession?: () => Promise<WorkspaceEditorSession | undefined>;
  }) {
    return (await dispatch(input)).payload;
  }

  // Agente 0.7.20: estado del editor de ESE repositorio. Uno anterior detras del
  // relay rechaza la consulta (403 route_not_allowed): se le pregunta solo por
  // login (lo de antes) y no se le vuelve a probar en un rato.
  async function callAgentStatus(login: string, repoFullName: string) {
    const plainPath = `/workspaces/${encodeURIComponent(login)}`;
    if (now() < legacyAgentUntil) return callAgent("GET", plainPath);
    const result = await callAgent("GET", `${plainPath}?repo=${encodeURIComponent(repoFullName)}`);
    const rejected = result.kind === "response"
      && result.status === 403
      && isRecord(result.json)
      && result.json.code === "route_not_allowed";
    if (!rejected) return result;
    legacyAgentUntil = now() + LEGACY_AGENT_RETRY_MS;
    console.warn("[workspaces] el agente de la VM es anterior a 0.7.20 (sin estado por repositorio): reinicia la VM para actualizarlo.");
    return callAgent("GET", plainPath);
  }

  async function status(input: { userId: string; repoFullName: string }) {
    ensureAgentConfigured();
    const login = await resolveStudentLogin(input.userId, { fresh: false });
    const result = await callAgentStatus(login, input.repoFullName);
    const mapped = mapAgentResult(result, { login, repoFullName: input.repoFullName });
    logAgentProblem("status", login, result, mapped);
    return (await withAutostart(result, mapped, mapped.workspace)).payload;
  }

  /**
   * Entorno activo (0.7.19): el que se eligio en la tuerca de la extension o, sin
   * eleccion, config.provider (ADACEEN_WORKSPACE_PROVIDER). Las rutas lo consultan en
   * cada peticion: cambiarlo no necesita reiniciar el App Service.
   */
  async function providerState() {
    return resolveWorkspaceProviderState(config.provider, await readWorkspaceProviderChoice(database, now()));
  }

  async function currentProvider() {
    return (await providerState()).provider;
  }

  return { config, isAgentConfigured, providerState, currentProvider, dispatch, prepare, status, relay, autostart };
}

export type WorkspaceService = ReturnType<typeof createWorkspaceService>;

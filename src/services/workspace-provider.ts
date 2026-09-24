// Entornos de los estudiantes por VS Code Tunnels (fase 3 de docs/workspaces-tunnel.md).
//
// PDC no crea el tunel: le pide al agente HTTP de la VM de editores
// (deploy/gcp/workspaces/agente/) que corra nuevo-tunel.sh para el login de
// GitHub del estudiante, y traduce su respuesta al contrato que ya habla la
// extension de navegador (browser-ext-prod/services/workspace.service.js):
//
//   { ok, provider: "tunnel", status: "ready" | "device_code" | "pending" | "error",
//     workspace: { login, tunnelName, webUrl, repoFullName },
//     deviceCode?: { userCode, verificationUrl, expiresAt }, message?, code? }
//
// `fetch` y el lector del login de GitHub son inyectables para probar sin red.
import { createHash } from "node:crypto";
import { env } from "../config/env.js";
import type { AppDatabase } from "../db/database.js";
import { trimText } from "./text-utils.js";

export type WorkspaceProviderName = "tunnel" | "codespaces";
export type WorkspaceState = "ready" | "device_code" | "pending" | "error";

export type WorkspaceConfig = {
  provider: WorkspaceProviderName;
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

export type WorkspaceStatusPayload = {
  ok: boolean;
  provider: "tunnel";
  status: WorkspaceState;
  workspace: WorkspaceInfo;
  deviceCode?: WorkspaceDeviceCode;
  message?: string;
  code?: string;
};

export type FetchLike = (url: string, init?: RequestInit) => Promise<Response>;
export type GithubLoginReader = (accessToken: string) => Promise<string>;

export type WorkspaceProviderDeps = {
  fetch?: FetchLike;
  readGithubLogin?: GithubLoginReader;
  config?: Partial<WorkspaceConfig>;
  now?: () => number;
};

type WorkspaceDatabase = Pick<AppDatabase, "getGithubUserTokenForUser">;

export const DEFAULT_VERIFICATION_URL = "https://github.com/login/device";
const GITHUB_TIMEOUT_MS = 10_000;
const LOGIN_CACHE_TTL_MS = 5 * 60 * 1000;
const LOGIN_CACHE_MAX = 500;

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
  const merged: WorkspaceConfig = {
    provider: env.workspaceProvider,
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
    agentUrl: trimText(merged.agentUrl).replace(/\/+$/, ""),
    agentToken: trimText(merged.agentToken),
    agentTimeoutMs: Number.isFinite(merged.agentTimeoutMs) && merged.agentTimeoutMs > 0 ? merged.agentTimeoutMs : 15_000,
    allowedLogins: (merged.allowedLogins || []).map((login) => trimText(login).toLowerCase()).filter(Boolean),
    githubApiBaseUrl: trimText(merged.githubApiBaseUrl).replace(/\/+$/, "") || "https://api.github.com",
  };
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

export function buildTunnelWebUrl(login: string, tunnelName = buildTunnelName(login)) {
  return `https://vscode.dev/tunnel/${tunnelName}/home/ws-${login}/proyecto`;
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

export function buildWorkspaceInfo(login: string, repoFullName: string): WorkspaceInfo {
  return login
    ? { login, tunnelName: buildTunnelName(login), webUrl: buildTunnelWebUrl(login), repoFullName }
    : { login: "", tunnelName: "", webUrl: "", repoFullName };
}

export function buildWorkspaceErrorPayload(
  code: string,
  message: string,
  workspace: WorkspaceInfo,
): WorkspaceStatusPayload {
  return { ok: false, provider: "tunnel", status: "error", workspace, message, code };
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
    );
  }
  if (result.kind === "unreachable") {
    return buildWorkspaceErrorPayload(
      "agent_unreachable",
      "No se pudo contactar la VM de editores (puede estar apagada). Intenta de nuevo en un momento o avisa al docente.",
      base,
    );
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
      message || "Todavia no hay un editor preparado para tu cuenta. Pulsa Preparar entorno.",
      base,
    );
  }
  // 400 (entrada rechazada) y 409 (otro repo ya clonado o en preparacion):
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

  if (state === "error") {
    return buildWorkspaceErrorPayload(
      agentCode || "agent_state_error",
      message || "No se pudo preparar el editor en la VM.",
      workspace,
    );
  }

  if (state === "device_code") {
    const userCode = trimText(body.deviceCode).toUpperCase();
    if (!USER_CODE_RE.test(userCode)) {
      return {
        ok: true,
        provider: "tunnel",
        status: "pending",
        workspace,
        message: message || "Esperando el codigo de autorizacion de GitHub...",
      };
    }
    return {
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
    };
  }

  return { ok: true, provider: "tunnel", status: state, workspace, ...(message ? { message } : {}) };
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

export function createWorkspaceService(database: WorkspaceDatabase, deps: WorkspaceProviderDeps = {}) {
  const config = resolveWorkspaceConfig(deps.config);
  const fetchImpl: FetchLike = deps.fetch || ((url, init) => fetch(url, init));
  const readGithubLogin = deps.readGithubLogin || createGithubLoginReader(fetchImpl, config.githubApiBaseUrl);
  const now = deps.now || Date.now;
  const loginCache = new Map<string, { login: string; expiresAt: number }>();

  function isAgentConfigured() {
    return Boolean(config.agentUrl && config.agentToken);
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
    return login;
  }

  async function callAgent(method: "GET" | "POST", path: string, body?: unknown): Promise<AgentCallResult> {
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
        "El editor por tunel esta activo pero el backend no tiene configurada la VM de editores (WORKSPACE_AGENT_URL / WORKSPACE_AGENT_TOKEN). Avisa al docente.",
        503,
      );
    }
  }

  async function prepare(input: { userId: string; repoFullName: string; force: boolean }) {
    ensureAgentConfigured();
    const login = await resolveStudentLogin(input.userId, { fresh: true });
    const result = await callAgent("POST", "/workspaces", {
      login,
      repo: input.repoFullName,
      force: input.force,
    });
    const payload = mapAgentResult(result, { login, repoFullName: input.repoFullName });
    logAgentProblem("prepare", login, result, payload);
    return payload;
  }

  async function status(input: { userId: string; repoFullName: string }) {
    ensureAgentConfigured();
    const login = await resolveStudentLogin(input.userId, { fresh: false });
    const result = await callAgent("GET", `/workspaces/${encodeURIComponent(login)}`);
    const payload = mapAgentResult(result, { login, repoFullName: input.repoFullName });
    logAgentProblem("status", login, result, payload);
    return payload;
  }

  return { config, isAgentConfigured, prepare, status };
}

export type WorkspaceService = ReturnType<typeof createWorkspaceService>;

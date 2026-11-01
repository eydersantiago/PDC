// Editores en la nube: lectores de GitHub (login del estudiante y acceso al repositorio) y pedidos JSON con tiempo limite.
import { trimText } from "../shared/text-utils.js";
import { isRecord, normalizeRepoFullName, type FetchLike, type GithubLoginReader, WorkspaceRequestError, type GithubRepoAccessReader } from "./workspace-config.js";

const GITHUB_TIMEOUT_MS = 10_000;

// Lee el cuerpo dentro de la misma ventana de tiempo: un cuerpo que no llega
// tambien cuenta como timeout.
export async function requestJson(fetchImpl: FetchLike, url: string, init: RequestInit, timeoutMs: number) {
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

export function isAbortError(error: unknown) {
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
    const id = isRecord(result.json) ? result.json.id : undefined;
    return typeof id === "number" && Number.isSafeInteger(id) && id > 0 ? { login, id } : login;
  };
}

export function normalizeGithubUser(value: string | { login: string; id?: number }) {
  if (typeof value === "string") return { login: value, id: undefined as number | undefined };
  const id = typeof value?.id === "number" && Number.isSafeInteger(value.id) && value.id > 0 ? value.id : undefined;
  return { login: trimText(value?.login), id };
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
    // 403 (limite de peticiones u organizacion con las apps OAuth restringidas) no
    // dice si el repositorio es publico: se sigue y el clon publico de la VM decide.
    if (result.status < 200 || result.status >= 300 || !isRecord(result.json)) return { state: "unknown" };
    const fullName = normalizeRepoFullName(result.json.full_name) || repoFullName;
    return { state: "visible", private: result.json.private === true, fullName };
  };
}

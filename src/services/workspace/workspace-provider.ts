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
// repositorio en el mismo tunel; editors trae los que ya estan en la VM. Sirve a
// cualquiera con sesion (estudiante, docente o administrador) y a cualquier
// repositorio, con una salvedad: tiene que ser PUBLICO. Antes de pedirle a la VM
// un repositorio se comprueba con GitHub: privado -> 409 repo_private, no
// encontrado -> 409 repo_not_accessible. La VM clona siempre sin credenciales:
// ningun token de GitHub sale del backend.
import { createHash } from "node:crypto";
import type { AppDatabase } from "../../db/database.js";
import { getDefaultVmAutostarter } from "../infra/gcp-compute.js";
import { trimText } from "../shared/text-utils.js";
import { readWorkspaceProviderChoice, resolveWorkspaceProviderState } from "./workspace-provider-choice.js";
import { workspaceRelay } from "./workspace-relay.js";
import { isRecord, type WorkspaceInfo, type WorkspaceStatusPayload, type FetchLike, WorkspaceRequestError, type WorkspaceProviderDeps, resolveWorkspaceConfig, type GithubRepoAccess, normalizeWorkspaceLogin, type WorkspaceEditorSession } from "./workspace-config.js";
import { cleanMessage, type AgentCallResult, buildVmStartingPayload, mapAgentResult, agentIgnoredReconnect, buildWorkspaceErrorPayload, RECONNECT_UNSUPPORTED_MESSAGE } from "./workspace-agent-result.js";
import { createGithubLoginReader, createGithubRepoAccessReader, normalizeGithubUser, requestJson, isAbortError } from "./workspace-github.js";

// getAppSetting: el entorno que se eligio en la tuerca (0.7.19). Opcional para las pruebas
// que pasan una base falsa: sin el, manda config.provider.
type WorkspaceDatabase = Pick<AppDatabase, "getGithubUserTokenForUser"> & Partial<Pick<AppDatabase, "getAppSetting">>;

const LOGIN_CACHE_TTL_MS = 5 * 60 * 1000;
const LOGIN_CACHE_MAX = 500;
const REPO_ACCESS_CACHE_TTL_MS = 5 * 60 * 1000;
// Agente anterior a 0.7.20 detras del relay: rechaza GET con ?repo=. Se le
// consulta solo por login un rato antes de volver a probar.
const LEGACY_AGENT_RETRY_MS = 10 * 60 * 1000;

export function createWorkspaceService(database: WorkspaceDatabase, deps: WorkspaceProviderDeps = {}) {
  const config = resolveWorkspaceConfig(deps.config);
  const fetchImpl: FetchLike = deps.fetch || ((url, init) => fetch(url, init));
  const readGithubLogin = deps.readGithubLogin || createGithubLoginReader(fetchImpl, config.githubApiBaseUrl);
  // GET /repos/{owner}/{repo} con el token del estudiante (inyectable en las pruebas).
  const readGithubRepoAccess = deps.readGithubRepoAccess || createGithubRepoAccessReader(fetchImpl, config.githubApiBaseUrl);
  const now = deps.now || Date.now;
  const relay = deps.relay || workspaceRelay;
  const autostart = deps.autostart === undefined ? getDefaultVmAutostarter() : deps.autostart;
  const loginCache = new Map<string, { login: string; id?: number; expiresAt: number }>();
  const repoAccessCache = new Map<string, { access: GithubRepoAccess; expiresAt: number }>();
  // Agente anterior (relay que rechaza ?repo=): hasta cuando se le pregunta solo por login.
  let legacyAgentUntil = 0;

  function isAgentConfigured() {
    return config.transport === "relay"
      ? Boolean(config.agentToken)
      : Boolean(config.agentUrl && config.agentToken);
  }

  function rememberLogin(key: string, user: { login: string; id?: number }) {
    if (loginCache.size >= LOGIN_CACHE_MAX) {
      const current = now();
      for (const [cachedKey, entry] of loginCache) {
        if (entry.expiresAt <= current) loginCache.delete(cachedKey);
      }
      if (loginCache.size >= LOGIN_CACHE_MAX) loginCache.clear();
    }
    loginCache.set(key, { ...user, expiresAt: now() + LOGIN_CACHE_TTL_MS });
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
    let user: { login: string; id?: number };
    if (!options.fresh && cached && cached.expiresAt > now()) {
      user = { login: cached.login, id: cached.id };
    } else {
      user = normalizeGithubUser(await readGithubLogin(accessToken));
      rememberLogin(cacheKey, user);
    }
    const rawLogin = user.login;

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
    return { login, accessToken, githubUserId: user.id };
  }

  // ¿El repositorio es publico? Cache corta por usuario y repo: status reenvia el
  // prepare mientras la VM arranca. Solo se guarda el "publico": quien acaba de
  // hacer publico su repositorio no tiene que esperar a que venza la cache.
  async function checkRepoAccess(userId: string, accessToken: string, repoFullName: string) {
    const key = `${userId}:${repoFullName.toLowerCase()}`;
    const cached = repoAccessCache.get(key);
    if (cached && cached.expiresAt > now()) return cached.access;
    const access = await readGithubRepoAccess(accessToken, repoFullName);
    if (access.state === "visible" && !access.private) {
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
    // Esperado y reintentable: la extension lo reenvia cada 3 s mientras la VM termina otro repo.
    if (payload.code === "busy_other_repo") return;
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
    /**
     * Reconectar (0.8.1): la VM cierra la sesion del tunel (la cuenta de GitHub que autorizo
     * el codigo) y pide un codigo nuevo. Los archivos del estudiante no se tocan.
     */
    reconnect?: boolean;
    /** Se llama despues de validar el login: no se crean sesiones para quien no puede preparar. */
    editorSession?: () => Promise<WorkspaceEditorSession | undefined>;
    freshLogin?: boolean;
  }) {
    ensureAgentConfigured();
    const student = await resolveStudent(input.userId, { fresh: input.freshLogin !== false });
    const { login } = student;
    // Solo repositorios publicos. Antes de despertar a la VM: un privado (o uno
    // que GitHub no muestra) fallaria igual en el clon. Mensaje claro aqui.
    const access = await checkRepoAccess(input.userId, student.accessToken, input.repoFullName);
    if (access.state === "visible" && access.private) {
      throw new WorkspaceRequestError(
        "repo_private",
        `${input.repoFullName} es privado. El editor en la nube de ADACEEN solo abre repositorios publicos: hazlo publico en GitHub (Settings > General > Danger Zone > Change visibility) o usa «Abrir en VS Code de este equipo».`,
        409,
        login,
      );
    }
    if (access.state === "not_visible") {
      throw new WorkspaceRequestError(
        "repo_not_accessible",
        `GitHub no encuentra ${input.repoFullName} como repositorio publico. Revisa el enlace: el editor en la nube de ADACEEN solo abre repositorios publicos.`,
        409,
        login,
      );
    }
    const editorSession = input.editorSession ? await input.editorSession() : undefined;
    // Sin credenciales: la VM hace un clon publico. githubUserId (publico) solo
    // arma el correo noreply de la identidad de git.
    const result = await callAgent("POST", "/workspaces", {
      login,
      repo: input.repoFullName,
      force: input.force,
      ...(input.reconnect ? { reconnect: true } : {}),
      ...(editorSession ? { editorSession } : {}),
      ...(student.githubUserId ? { githubUserId: student.githubUserId } : {}),
    });
    let mapped = mapAgentResult(result, { login, repoFullName: input.repoFullName });
    if (input.reconnect && agentIgnoredReconnect(result)) {
      console.warn("[workspaces] el agente de la VM es anterior a 0.8.1 (sin reconnect): reinicia la VM para actualizarlo.");
      mapped = buildWorkspaceErrorPayload("reconnect_unsupported", RECONNECT_UNSUPPORTED_MESSAGE, mapped.workspace);
    }
    logAgentProblem("prepare", login, result, mapped);
    const { payload, vmOff } = await withAutostart(result, mapped, mapped.workspace);
    // busy_other_repo: la VM no acepto este repositorio (termina otro del mismo
    // usuario). Cuenta como no entregado: cada status lo reenvia hasta que lo acepta.
    const accepted = payload.code !== "busy_other_repo";
    return { payload, delivered: result.kind !== "unreachable" && !vmOff && accepted };
  }

  async function prepare(input: {
    userId: string;
    repoFullName: string;
    force: boolean;
    reconnect?: boolean;
    editorSession?: () => Promise<WorkspaceEditorSession | undefined>;
  }) {
    return (await dispatch(input)).payload;
  }

  // Agente 0.7.20: estado del editor de ESE repositorio. Uno anterior detras del
  // relay rechaza la consulta (403 route_not_allowed): se le pregunta solo por
  // login (lo de antes) y no se le vuelve a probar en un rato.
  async function callAgentStatus(login: string, repoFullName: string) {
    const plainPath = `/workspaces/${encodeURIComponent(login)}`;
    if (now() < legacyAgentUntil) {
      const legacy = await callAgent("GET", plainPath);
      // La VM se actualizo (el agente nuevo siempre responde folder): se vuelve a
      // preguntar por repositorio desde ya.
      if (legacy.kind === "response" && isRecord(legacy.json) && typeof legacy.json.folder === "string") {
        legacyAgentUntil = 0;
        return callAgent("GET", `${plainPath}?repo=${encodeURIComponent(repoFullName)}`);
      }
      return legacy;
    }
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

  /**
   * passive: solo mirar (la extension, al entrar en la pagina de un repositorio, busca
   * un editor ya preparado). No enciende la VM: eso queda para un clic del usuario.
   */
  async function status(input: { userId: string; repoFullName: string; passive?: boolean }) {
    ensureAgentConfigured();
    const login = await resolveStudentLogin(input.userId, { fresh: false });
    const result = await callAgentStatus(login, input.repoFullName);
    const mapped = mapAgentResult(result, { login, repoFullName: input.repoFullName });
    if (!input.passive) logAgentProblem("status", login, result, mapped);
    if (input.passive) return mapped;
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

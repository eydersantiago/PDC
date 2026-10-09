// Encendido de VMs de Google Cloud desde el backend: la VM de editores sola
// cuando un estudiante pide su editor (docs/arquitectura/acceso-simplificado.md,
// seccion 5) y, con «Iniciar clase» (0.7.21, src/services/class-start.ts), una
// GPU y la VM de editores a pedido del docente.
//
// Credenciales (resolveGcpCredentials), dos modos:
//   key:        GCP_SERVICE_ACCOUNT_JSON, clave JSON (o base64) de una cuenta con
//               solo compute.instances.get/start sobre esas VMs.
//   federation: sin clave (la organizacion puede prohibir crearlas). Con
//               GCP_WORKLOAD_IDENTITY_AUDIENCE, GCP_SERVICE_ACCOUNT_EMAIL y
//               GCP_AZURE_TOKEN_RESOURCE el backend pide el token de la identidad
//               administrada del App Service (IDENTITY_ENDPOINT/IDENTITY_HEADER, o
//               IMDS en una VM de Azure) y Google lo canjea en STS por un token de
//               la cuenta de servicio (deploy/gcp/crear-federacion-autoencendido.sh).
//   Si estan las dos, gana la clave y se avisa.
//
// Autoencendido (createVmAutostarter): con WORKSPACE_VM_AUTOSTART=gcp y
// WORKSPACE_VM_PROJECT/ZONE/NAME, cuando prepare/status no llegan al agente se
// consulta la VM en la API de Compute Engine y, si esta apagada, se pide
// instances.start (como mucho una vez cada 2 minutos). Si se la ve apagandose
// (STOPPING: alguien la apago, p. ej. deploy/clase.sh terminar), no se enciende
// sola durante 15 min. Sin esa configuracion no hace nada y todo sigue igual.
//
// `fetch` y el proveedor del token de acceso son inyectables para probar sin red.
import { ExternalAccountClient, JWT, type BaseExternalAccountClient } from "google-auth-library";
import { env } from "../config/env.js";
import { trimText } from "./text-utils.js";
import type { FetchLike } from "./workspace-provider.js";

export type GcpKeyCredentials = {
  mode: "key";
  /** Clave JSON de la cuenta de servicio (texto JSON o base64). */
  credentialsJson: string;
};

export type GcpFederationCredentials = {
  mode: "federation";
  /** //iam.googleapis.com/projects/<numero>/locations/global/workloadIdentityPools/<pool>/providers/<proveedor> */
  audience: string;
  /** Cuenta de servicio que se impersona (la del autoencendido). */
  serviceAccountEmail: string;
  /** Audience que se le pide a la identidad administrada de Azure (p. ej. api://adaceen-gcp). */
  azureTokenResource: string;
};

export type GcpCredentials = GcpKeyCredentials | GcpFederationCredentials;
export type GcpAuthMode = GcpCredentials["mode"];

export type VmAutostartConfig = {
  project: string;
  zone: string;
  name: string;
  /** Clave JSON de la cuenta de servicio (modo key). Vacia en modo federation o con token inyectado. */
  credentialsJson?: string;
  /** Federacion de identidades (modo federation): sin clave. */
  federation?: GcpFederationCredentials;
};

export type VmAutostartDeps = {
  fetch?: FetchLike;
  now?: () => number;
  /** Token OAuth2 para la API de Compute (por defecto, segun las credenciales de la configuracion). */
  getAccessToken?: () => Promise<string>;
  computeBaseUrl?: string;
  /** Pausa minima entre dos instances.start. */
  startCooldownMs?: number;
  /** Cuanto se reutiliza el ultimo estado leido (la extension consulta cada 3 s). */
  checkCacheMs?: number;
  /** Tras pedir el encendido, cuanto se sigue diciendo "encendiendo" aunque la VM ya figure RUNNING. */
  bootGraceMs?: number;
  /**
   * Tras ver la VM apagandose (STOPPING), cuanto no se la vuelve a encender:
   * alguien la apago a proposito (deploy/clase.sh terminar) y las ventanas
   * que siguen esperando no deben prenderla otra vez.
   */
  stopHoldMs?: number;
  timeoutMs?: number;
};

/**
 * starting:  la VM esta arrancando (o se acaba de pedir el encendido).
 * running:   la VM esta encendida: el problema es el agente, no la VM.
 * unavailable: no se pudo consultar o encender (credenciales, permisos, red).
 */
export type VmAutostartOutcome =
  | { state: "starting"; vmStatus: string; startRequested: boolean }
  | { state: "running"; vmStatus: string }
  | { state: "unavailable"; reason: string };

const COMPUTE_SCOPE = "https://www.googleapis.com/auth/compute";
const RESOURCE_NAME_RE = /^[a-z]([-a-z0-9]{0,61}[a-z0-9])?$/;
const PROJECT_RE = /^[a-z][-a-z0-9.:]{4,61}[a-z0-9]$/;
const WORKLOAD_IDENTITY_AUDIENCE_RE = /^\/\/iam\.googleapis\.com\/projects\/\d+\/locations\/global\/workloadIdentityPools\/[a-z0-9-]+\/providers\/[a-z0-9-]+$/;
const SERVICE_ACCOUNT_EMAIL_RE = /^[a-z][a-z0-9-]{4,28}[a-z0-9]@[a-z][-a-z0-9.:]{4,61}[a-z0-9]\.iam\.gserviceaccount\.com$/;

// Estados de Compute Engine en los que la VM esta de camino a RUNNING.
export const BOOTING_STATES: ReadonlySet<string> = new Set(["PROVISIONING", "STAGING", "REPAIRING"]);
// Estados en los que instances.start la enciende.
export const STARTABLE_STATES: ReadonlySet<string> = new Set(["TERMINATED", "STOPPED"]);

type ServiceAccountKey = { client_email: string; private_key: string };

/** Lee la clave de la cuenta de servicio (JSON o base64 del JSON). */
export function parseServiceAccountJson(raw: string): ServiceAccountKey | null {
  const text = trimText(raw);
  if (!text) return null;
  const candidates = [text];
  if (!text.startsWith("{")) {
    try {
      candidates.push(Buffer.from(text, "base64").toString("utf8").trim());
    } catch {
      // no era base64
    }
  }
  for (const candidate of candidates) {
    try {
      const parsed = JSON.parse(candidate) as Partial<ServiceAccountKey>;
      const clientEmail = trimText(parsed?.client_email);
      const privateKey = typeof parsed?.private_key === "string" ? parsed.private_key.replace(/\\n/g, "\n") : "";
      if (clientEmail && privateKey.includes("PRIVATE KEY")) {
        return { client_email: clientEmail, private_key: privateKey };
      }
    } catch {
      // se prueba el siguiente formato
    }
  }
  return null;
}

export type GcpCredentialsSource = {
  credentialsJson?: string;
  workloadIdentityAudience?: string;
  serviceAccountEmail?: string;
  azureTokenResource?: string;
};

const FEDERATION_VARIABLES = "GCP_WORKLOAD_IDENTITY_AUDIENCE, GCP_SERVICE_ACCOUNT_EMAIL y GCP_AZURE_TOKEN_RESOURCE";

/**
 * Credenciales de Google Cloud desde el entorno (pura, sin red).
 * - credentials null y problem "": no hay ninguna configurada.
 * - problem: la federacion esta pedida pero incompleta o invalida (que falta, sin valores).
 * - warning: hay clave y federacion a la vez (se usa la clave).
 */
export function resolveGcpCredentials(source: GcpCredentialsSource = {
  credentialsJson: env.gcpServiceAccountJson,
  workloadIdentityAudience: env.gcpWorkloadIdentityAudience,
  serviceAccountEmail: env.gcpServiceAccountEmail,
  azureTokenResource: env.gcpAzureTokenResource,
}): { credentials: GcpCredentials | null; problem: string; warning: string } {
  const audience = trimText(source.workloadIdentityAudience);
  const serviceAccountEmail = trimText(source.serviceAccountEmail).toLowerCase();
  const azureTokenResource = trimText(source.azureTokenResource);
  const federationRequested = Boolean(audience || serviceAccountEmail || azureTokenResource);

  if (parseServiceAccountJson(source.credentialsJson || "")) {
    return {
      credentials: { mode: "key", credentialsJson: source.credentialsJson || "" },
      problem: "",
      warning: federationRequested
        ? "GCP_SERVICE_ACCOUNT_JSON y la federacion de identidades estan las dos: se usa la clave. Borra GCP_SERVICE_ACCOUNT_JSON del App Service para pasar a la federacion (sin clave)."
        : "",
    };
  }
  if (!federationRequested) return { credentials: null, problem: "", warning: "" };

  const missing = [
    WORKLOAD_IDENTITY_AUDIENCE_RE.test(audience) ? "" : "GCP_WORKLOAD_IDENTITY_AUDIENCE",
    SERVICE_ACCOUNT_EMAIL_RE.test(serviceAccountEmail) ? "" : "GCP_SERVICE_ACCOUNT_EMAIL",
    azureTokenResource && !/\s/.test(azureTokenResource) ? "" : "GCP_AZURE_TOKEN_RESOURCE",
  ].filter(Boolean);
  if (missing.length) {
    return {
      credentials: null,
      problem: `federacion de identidades con Google Cloud incompleta: faltan o no son validas ${missing.join(", ")}.`,
      warning: "",
    };
  }
  return { credentials: { mode: "federation", audience, serviceAccountEmail, azureTokenResource }, problem: "", warning: "" };
}

export type AzureIdentityEnv = {
  /** IDENTITY_ENDPOINT: lo pone App Service en el proceso. */
  identityEndpoint?: string;
  /** IDENTITY_HEADER: secreto por proceso que exige ese endpoint. */
  identityHeader?: string;
};

/** Variables de la identidad administrada que Azure pone en el proceso (vacias fuera de App Service). */
export function readAzureIdentityEnv(source: NodeJS.ProcessEnv = process.env): AzureIdentityEnv {
  return { identityEndpoint: trimText(source.IDENTITY_ENDPOINT), identityHeader: trimText(source.IDENTITY_HEADER) };
}

export const AZURE_IMDS_TOKEN_URL = "http://169.254.169.254/metadata/identity/oauth2/token";

/**
 * Configuracion de cuenta externa (external_account) para google-auth-library, sin red:
 * la libreria pide el token de Azure a `credential_source.url` con esas cabeceras, lo
 * canjea en STS por uno federado y con ese impersona a la cuenta de servicio.
 * Con IDENTITY_ENDPOINT e IDENTITY_HEADER (App Service) usa ese endpoint; si faltan,
 * el IMDS de Azure (VM o Container Apps).
 */
export function buildFederationCredentialJson(credentials: GcpFederationCredentials, azure: AzureIdentityEnv = {}) {
  const identityEndpoint = trimText(azure.identityEndpoint);
  const identityHeader = trimText(azure.identityHeader);
  const resource = encodeURIComponent(credentials.azureTokenResource);
  const appService = Boolean(identityEndpoint && identityHeader);
  const url = appService
    ? `${identityEndpoint}${identityEndpoint.includes("?") ? "&" : "?"}api-version=2019-08-01&resource=${resource}`
    : `${AZURE_IMDS_TOKEN_URL}?api-version=2018-02-01&resource=${resource}`;
  const headers: Record<string, string> = appService ? { "X-IDENTITY-HEADER": identityHeader } : { Metadata: "true" };
  return {
    type: "external_account" as const,
    audience: credentials.audience,
    subject_token_type: "urn:ietf:params:oauth:token-type:jwt",
    token_url: "https://sts.googleapis.com/v1/token",
    service_account_impersonation_url: `https://iamcredentials.googleapis.com/v1/projects/-/serviceAccounts/${credentials.serviceAccountEmail}:generateAccessToken`,
    credential_source: {
      url,
      headers,
      format: { type: "json" as const, subject_token_field_name: "access_token" },
    },
  };
}

/** Proveedor del token OAuth2 de Compute segun el modo de credenciales. */
export function createGcpTokenProvider(credentials: GcpCredentials, azure: AzureIdentityEnv = readAzureIdentityEnv()): () => Promise<string> {
  if (credentials.mode === "key") {
    const key = parseServiceAccountJson(credentials.credentialsJson);
    let client: JWT | null = null;
    return async () => {
      if (!key) throw new Error("clave de la cuenta de servicio invalida");
      client = client || new JWT({ email: key.client_email, key: key.private_key, scopes: [COMPUTE_SCOPE] });
      const { token } = await client.getAccessToken();
      if (!token) throw new Error("la cuenta de servicio no entrego token de acceso");
      return token;
    };
  }
  let client: BaseExternalAccountClient | null = null;
  return async () => {
    if (!client) {
      const created = ExternalAccountClient.fromJSON({ ...buildFederationCredentialJson(credentials, azure), scopes: [COMPUTE_SCOPE] });
      if (!created) throw new Error("no se pudo crear el cliente de la federacion de identidades");
      client = created;
    }
    const { token } = await client.getAccessToken();
    if (!token) throw new Error("la federacion de identidades no entrego token de acceso");
    return token;
  };
}

/** Modo de autenticacion de una configuracion de VM (null si solo hay token inyectado). */
export function authModeOf(config: Pick<VmAutostartConfig, "credentialsJson" | "federation">): GcpAuthMode | null {
  if (parseServiceAccountJson(config.credentialsJson || "")) return "key";
  return config.federation ? "federation" : null;
}

function tokenProviderFor(config: VmAutostartConfig) {
  const mode = authModeOf(config);
  if (mode === "federation" && config.federation) return createGcpTokenProvider(config.federation);
  return createGcpTokenProvider({ mode: "key", credentialsJson: config.credentialsJson || "" });
}

/**
 * Configuracion del autoencendido desde el entorno; null si esta apagado.
 * Si esta pedido pero incompleto, devuelve el motivo para avisar en el log;
 * warning cuando hay clave y federacion a la vez.
 */
export function resolveVmAutostartConfig(source: {
  mode?: string;
  project?: string;
  zone?: string;
  name?: string;
} & GcpCredentialsSource = {
  mode: env.workspaceVmAutostart,
  project: env.workspaceVmProject,
  zone: env.workspaceVmZone,
  name: env.workspaceVmName,
  credentialsJson: env.gcpServiceAccountJson,
  workloadIdentityAudience: env.gcpWorkloadIdentityAudience,
  serviceAccountEmail: env.gcpServiceAccountEmail,
  azureTokenResource: env.gcpAzureTokenResource,
}): { config: VmAutostartConfig | null; problem: string; warning: string } {
  const mode = trimText(source.mode).toLowerCase();
  if (!mode || mode === "off" || mode === "0" || mode === "false") return { config: null, problem: "", warning: "" };
  if (mode !== "gcp") return { config: null, problem: `WORKSPACE_VM_AUTOSTART=${mode} no es valido (usa gcp o dejalo vacio).`, warning: "" };
  const project = trimText(source.project);
  const zone = trimText(source.zone);
  const name = trimText(source.name);
  const gcp = resolveGcpCredentials(source);
  const missing = [
    PROJECT_RE.test(project) ? "" : "WORKSPACE_VM_PROJECT",
    RESOURCE_NAME_RE.test(zone) ? "" : "WORKSPACE_VM_ZONE",
    RESOURCE_NAME_RE.test(name) ? "" : "WORKSPACE_VM_NAME",
    gcp.credentials ? "" : `GCP_SERVICE_ACCOUNT_JSON (o la federacion: ${FEDERATION_VARIABLES})`,
  ].filter(Boolean);
  if (missing.length) {
    const detail = gcp.problem ? ` ${gcp.problem}` : "";
    return { config: null, problem: `WORKSPACE_VM_AUTOSTART=gcp pero faltan o no son validas: ${missing.join(", ")}.${detail}`, warning: gcp.warning };
  }
  const config: VmAutostartConfig = gcp.credentials?.mode === "federation"
    ? { project, zone, name, credentialsJson: "", federation: gcp.credentials }
    : { project, zone, name, credentialsJson: source.credentialsJson || "" };
  return { config, problem: "", warning: gcp.warning };
}

async function readJson(response: Response) {
  const text = await response.text().catch(() => "");
  try {
    return text ? JSON.parse(text) as Record<string, unknown> : {};
  } catch {
    return {};
  }
}

// ---------------------------------------------------------------- cliente de Compute

export type ComputeInstanceRef = { project: string; zone: string; name: string };

export type ComputeReadResult =
  | { ok: true; vmStatus: string }
  | { ok: false; reason: string };

export type ComputeStartResult =
  | { accepted: true }
  | { accepted: false; reason: string; capacity: boolean };

export type ComputeClientDeps = {
  getAccessToken: () => Promise<string>;
  fetch?: FetchLike;
  computeBaseUrl?: string;
  timeoutMs?: number;
};

// Motivos por los que un instances.start no enciende y vale probar otra VM:
// sin cupo en la zona (stockout) o sin cuota (GPUS_ALL_REGIONS es 1 en el piloto).
const CAPACITY_RE = /ZONE_RESOURCE_POOL_EXHAUSTED|QUOTA_EXCEEDED|quotaExceeded|RESOURCE_EXHAUSTED|STOCKOUT|does not have enough resources|resourceNotAvailable|Quota .* exceeded|GPUS_ALL_REGIONS/i;

/** Texto corto del error que devuelve la API de Compute (codigos y mensaje, sin tokens). */
export function describeComputeError(json: Record<string, unknown>) {
  const error = json?.error;
  if (!error || typeof error !== "object") return "";
  const details = error as { message?: unknown; errors?: unknown };
  const parts: string[] = [];
  if (Array.isArray(details.errors)) {
    for (const item of details.errors) {
      const reason = trimText((item as { reason?: unknown })?.reason);
      if (reason && !parts.includes(reason)) parts.push(reason);
    }
  }
  const message = trimText(details.message).replace(/\s+/g, " ").slice(0, 240);
  if (message) parts.push(message);
  return parts.join(": ");
}

export function isCapacityProblem(text: string) {
  return CAPACITY_RE.test(text);
}

function reasonOf(error: unknown) {
  const name = error && typeof error === "object" && "name" in error ? String((error as { name?: unknown }).name) : "";
  return name === "AbortError" ? "timeout de la API de Compute" : String(error).slice(0, 200);
}

/**
 * Llamadas minimas a la API de Compute Engine (instances.get e instances.start).
 * Nunca lanza: red, timeout o token fallido salen como motivo.
 */
export function createComputeClient(deps: ComputeClientDeps) {
  const fetchImpl: FetchLike = deps.fetch || ((url, init) => fetch(url, init));
  const computeBaseUrl = (deps.computeBaseUrl || "https://compute.googleapis.com/compute/v1").replace(/\/+$/, "");
  const timeoutMs = deps.timeoutMs ?? 10_000;

  function instanceUrl(ref: ComputeInstanceRef) {
    return `${computeBaseUrl}/projects/${encodeURIComponent(ref.project)}/zones/${encodeURIComponent(ref.zone)}/instances/${encodeURIComponent(ref.name)}`;
  }

  async function call(method: "GET" | "POST", url: string) {
    const token = await deps.getAccessToken();
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const response = await fetchImpl(url, {
        method,
        headers: { Authorization: `Bearer ${token}`, Accept: "application/json" },
        signal: controller.signal,
      });
      return { status: response.status, json: await readJson(response) };
    } finally {
      clearTimeout(timer);
    }
  }

  async function getStatus(ref: ComputeInstanceRef): Promise<ComputeReadResult> {
    try {
      const instance = await call("GET", instanceUrl(ref));
      if (instance.status < 200 || instance.status >= 300) {
        return { ok: false, reason: `instances.get HTTP ${instance.status}` };
      }
      return { ok: true, vmStatus: trimText(instance.json.status).toUpperCase() || "DESCONOCIDO" };
    } catch (error) {
      return { ok: false, reason: reasonOf(error) };
    }
  }

  async function start(ref: ComputeInstanceRef): Promise<ComputeStartResult> {
    try {
      const started = await call("POST", `${instanceUrl(ref)}/start`);
      if (started.status >= 200 && started.status < 300) return { accepted: true };
      const detail = describeComputeError(started.json);
      const reason = `instances.start HTTP ${started.status}${detail ? ` (${detail})` : ""}`;
      return { accepted: false, reason, capacity: isCapacityProblem(detail) };
    } catch (error) {
      return { accepted: false, reason: reasonOf(error), capacity: false };
    }
  }

  return { getStatus, start, instanceUrl };
}

export type ComputeClient = ReturnType<typeof createComputeClient>;

// ---------------------------------------------------------------- autoencendido

export function createVmAutostarter(config: VmAutostartConfig, deps: VmAutostartDeps = {}) {
  const now = deps.now || Date.now;
  const compute = createComputeClient({
    fetch: deps.fetch,
    getAccessToken: deps.getAccessToken || tokenProviderFor(config),
    computeBaseUrl: deps.computeBaseUrl,
    timeoutMs: deps.timeoutMs,
  });
  const startCooldownMs = deps.startCooldownMs ?? 2 * 60 * 1000;
  const checkCacheMs = deps.checkCacheMs ?? 10_000;
  const bootGraceMs = deps.bootGraceMs ?? 5 * 60 * 1000;
  // Algo mas que la espera de la extension (12 min) para que no la encienda.
  const stopHoldMs = deps.stopHoldMs ?? 15 * 60 * 1000;
  const ref: ComputeInstanceRef = { project: config.project, zone: config.zone, name: config.name };
  const authMode = authModeOf(config);

  // Ultimo instances.start pedido (pausa de 2 min) y si Compute lo acepto:
  // mientras dura la pausa solo se dice "encendiendo" si el ultimo fue aceptado.
  let lastStartAt = 0;
  let lastStartAccepted = false;
  let lastStartProblem = "";
  let lastStoppingAt = 0;
  let lastWarned = "";
  let lastCheck: { at: number; outcome: VmAutostartOutcome } | null = null;
  let inFlight: Promise<VmAutostartOutcome> | null = null;

  async function check(): Promise<VmAutostartOutcome> {
    const instance = await compute.getStatus(ref);
    if (!instance.ok) return { state: "unavailable", reason: instance.reason };
    const vmStatus = instance.vmStatus;

    if (vmStatus === "RUNNING") {
      // Recien encendida: el agente tarda un poco en conectarse.
      return now() - lastStartAt < bootGraceMs
        ? { state: "starting", vmStatus, startRequested: false }
        : { state: "running", vmStatus };
    }
    if (BOOTING_STATES.has(vmStatus)) return { state: "starting", vmStatus, startRequested: false };
    if (vmStatus === "STOPPING") {
      // Alguien la esta apagando: no se enciende otra vez enseguida.
      lastStoppingAt = now();
      return { state: "unavailable", reason: "la VM se esta apagando" };
    }
    if (!STARTABLE_STATES.has(vmStatus)) {
      return { state: "unavailable", reason: `la VM esta en ${vmStatus}` };
    }
    if (lastStoppingAt && now() - lastStoppingAt < stopHoldMs) {
      return { state: "unavailable", reason: "la VM se apago hace poco; no se enciende sola todavia" };
    }
    if (now() - lastStartAt < startCooldownMs) {
      // Pausa entre dos start: "encendiendo" solo si el ultimo fue aceptado;
      // si fallo (permisos, cuota), el estudiante debe ver "avisa al docente".
      return lastStartAccepted
        ? { state: "starting", vmStatus, startRequested: false }
        : { state: "unavailable", reason: lastStartProblem || "el ultimo instances.start fallo" };
    }

    lastStartAt = now();
    lastStartAccepted = false;
    lastStartProblem = "instances.start sin respuesta";
    const started = await compute.start(ref);
    if (!started.accepted) {
      lastStartProblem = started.reason;
      return { state: "unavailable", reason: lastStartProblem };
    }
    lastStartAccepted = true;
    lastStartProblem = "";
    console.info(`[workspaces] encendiendo la VM de editores ${config.name} (estaba ${vmStatus}).`);
    return { state: "starting", vmStatus, startRequested: true };
  }

  /**
   * Consulta la VM y la enciende si hace falta. Nunca lanza: los fallos
   * salen como "unavailable" y el backend responde como sin autoencendido.
   */
  async function ensureStarted(): Promise<VmAutostartOutcome> {
    if (lastCheck && now() - lastCheck.at < checkCacheMs) return lastCheck.outcome;
    if (inFlight) return inFlight;
    inFlight = check()
      .catch((error: unknown): VmAutostartOutcome => ({ state: "unavailable", reason: reasonOf(error) }))
      .then((outcome) => {
        // Un aviso por cambio de motivo (las ventanas consultan cada 3 s).
        const warning = outcome.state === "unavailable" ? outcome.reason : "";
        if (warning && warning !== lastWarned) {
          console.warn(`[workspaces] autoencendido de la VM no disponible: ${warning}`);
        }
        lastWarned = warning;
        lastCheck = { at: now(), outcome };
        return outcome;
      })
      .finally(() => {
        inFlight = null;
      });
    return inFlight;
  }

  return { config, authMode, ensureStarted };
}

export type VmAutostarter = ReturnType<typeof createVmAutostarter>;

let defaultAutostarter: VmAutostarter | null | undefined;

/** Autoencendido del proceso segun el entorno (null si esta apagado o incompleto). */
export function getDefaultVmAutostarter() {
  if (defaultAutostarter !== undefined) return defaultAutostarter;
  const { config, problem, warning } = resolveVmAutostartConfig();
  if (problem) console.warn(`[config] ${problem} El autoencendido de la VM queda apagado.`);
  if (warning) console.warn(`[config] ${warning}`);
  defaultAutostarter = config ? createVmAutostarter(config) : null;
  if (defaultAutostarter) {
    console.info(`[config] autoencendido de la VM de editores ${config?.name} con credenciales de Google Cloud en modo ${defaultAutostarter.authMode}.`);
  }
  return defaultAutostarter;
}

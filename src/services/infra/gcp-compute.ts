// Encendido de VMs de Google Cloud desde el backend: la VM de editores sola
// cuando un estudiante pide su editor (docs/arquitectura/acceso-simplificado.md,
// seccion 5) y, con «Iniciar clase» (0.7.21, src/services/infra/class-start.ts), una
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
import { env, isOffSwitch } from "../../config/env.js";
import { trimText } from "../shared/text-utils.js";
import type { FetchLike } from "../workspace/workspace-config.js";
import { type GcpFederationCredentials, type GcpAuthMode, parseServiceAccountJson, createGcpTokenProvider, type GcpCredentialsSource, resolveGcpCredentials } from "./gcp-credentials.js";
import { createComputeClient, type ComputeInstanceRef, reasonOf } from "./gcp-compute-client.js";

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

const RESOURCE_NAME_RE = /^[a-z]([-a-z0-9]{0,61}[a-z0-9])?$/;
const PROJECT_RE = /^[a-z][-a-z0-9.:]{4,61}[a-z0-9]$/;

// Estados de Compute Engine en los que la VM esta de camino a RUNNING.
export const BOOTING_STATES: ReadonlySet<string> = new Set(["PROVISIONING", "STAGING", "REPAIRING"]);
// Estados en los que instances.start la enciende.
export const STARTABLE_STATES: ReadonlySet<string> = new Set(["TERMINATED", "STOPPED"]);

const FEDERATION_VARIABLES = "GCP_WORKLOAD_IDENTITY_AUDIENCE, GCP_SERVICE_ACCOUNT_EMAIL y GCP_AZURE_TOKEN_RESOURCE";

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
  if (!mode || isOffSwitch(mode)) return { config: null, problem: "", warning: "" };
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

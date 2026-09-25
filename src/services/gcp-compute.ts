// Encendido automatico de la VM de editores (docs/arquitectura/acceso-simplificado.md, seccion 5).
//
// Opcional: con WORKSPACE_VM_AUTOSTART=gcp, WORKSPACE_VM_PROJECT/ZONE/NAME y
// GCP_SERVICE_ACCOUNT_JSON (clave de una cuenta con solo
// compute.instances.get/start sobre esa VM), cuando prepare/status no llegan
// al agente se consulta la VM en la API de Compute Engine y, si esta apagada,
// se pide instances.start (como mucho una vez cada 2 minutos). Si se la ve
// apagandose (STOPPING: alguien la apago, p. ej. deploy/clase.sh terminar),
// no se enciende sola durante 15 min. Sin esa configuracion no hace nada y
// todo sigue igual.
//
// `fetch` y el proveedor del token de acceso son inyectables para probar sin red.
import { JWT } from "google-auth-library";
import { env } from "../config/env.js";
import { trimText } from "./text-utils.js";
import type { FetchLike } from "./workspace-provider.js";

export type VmAutostartConfig = {
  project: string;
  zone: string;
  name: string;
  /** Clave JSON de la cuenta de servicio (texto JSON o base64). */
  credentialsJson: string;
};

export type VmAutostartDeps = {
  fetch?: FetchLike;
  now?: () => number;
  /** Token OAuth2 para la API de Compute (por defecto, JWT de la cuenta de servicio). */
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

// Estados de Compute Engine en los que la VM esta de camino a RUNNING.
const BOOTING_STATES = new Set(["PROVISIONING", "STAGING", "REPAIRING"]);
// Estados en los que instances.start la enciende.
const STARTABLE_STATES = new Set(["TERMINATED", "STOPPED"]);

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

/**
 * Configuracion del autoencendido desde el entorno; null si esta apagado.
 * Si esta pedido pero incompleto, devuelve el motivo para avisar en el log.
 */
export function resolveVmAutostartConfig(source: {
  mode?: string;
  project?: string;
  zone?: string;
  name?: string;
  credentialsJson?: string;
} = {
  mode: env.workspaceVmAutostart,
  project: env.workspaceVmProject,
  zone: env.workspaceVmZone,
  name: env.workspaceVmName,
  credentialsJson: env.gcpServiceAccountJson,
}): { config: VmAutostartConfig | null; problem: string } {
  const mode = trimText(source.mode).toLowerCase();
  if (!mode || mode === "off" || mode === "0" || mode === "false") return { config: null, problem: "" };
  if (mode !== "gcp") return { config: null, problem: `WORKSPACE_VM_AUTOSTART=${mode} no es valido (usa gcp o dejalo vacio).` };
  const project = trimText(source.project);
  const zone = trimText(source.zone);
  const name = trimText(source.name);
  const missing = [
    PROJECT_RE.test(project) ? "" : "WORKSPACE_VM_PROJECT",
    RESOURCE_NAME_RE.test(zone) ? "" : "WORKSPACE_VM_ZONE",
    RESOURCE_NAME_RE.test(name) ? "" : "WORKSPACE_VM_NAME",
    parseServiceAccountJson(source.credentialsJson || "") ? "" : "GCP_SERVICE_ACCOUNT_JSON",
  ].filter(Boolean);
  if (missing.length) {
    return { config: null, problem: `WORKSPACE_VM_AUTOSTART=gcp pero faltan o no son validas: ${missing.join(", ")}.` };
  }
  return { config: { project, zone, name, credentialsJson: source.credentialsJson || "" }, problem: "" };
}

function defaultTokenProvider(credentialsJson: string) {
  const key = parseServiceAccountJson(credentialsJson);
  let client: JWT | null = null;
  return async () => {
    if (!key) throw new Error("clave de la cuenta de servicio invalida");
    client = client || new JWT({ email: key.client_email, key: key.private_key, scopes: [COMPUTE_SCOPE] });
    const { token } = await client.getAccessToken();
    if (!token) throw new Error("la cuenta de servicio no entrego token de acceso");
    return token;
  };
}

async function readJson(response: Response) {
  const text = await response.text().catch(() => "");
  try {
    return text ? JSON.parse(text) as Record<string, unknown> : {};
  } catch {
    return {};
  }
}

export function createVmAutostarter(config: VmAutostartConfig, deps: VmAutostartDeps = {}) {
  const fetchImpl: FetchLike = deps.fetch || ((url, init) => fetch(url, init));
  const now = deps.now || Date.now;
  const getAccessToken = deps.getAccessToken || defaultTokenProvider(config.credentialsJson);
  const computeBaseUrl = (deps.computeBaseUrl || "https://compute.googleapis.com/compute/v1").replace(/\/+$/, "");
  const startCooldownMs = deps.startCooldownMs ?? 2 * 60 * 1000;
  const checkCacheMs = deps.checkCacheMs ?? 10_000;
  const bootGraceMs = deps.bootGraceMs ?? 5 * 60 * 1000;
  // Algo mas que la espera de la extension (12 min) para que no la encienda.
  const stopHoldMs = deps.stopHoldMs ?? 15 * 60 * 1000;
  const timeoutMs = deps.timeoutMs ?? 10_000;
  const instanceUrl = `${computeBaseUrl}/projects/${encodeURIComponent(config.project)}/zones/${encodeURIComponent(config.zone)}/instances/${encodeURIComponent(config.name)}`;

  // Ultimo instances.start pedido (pausa de 2 min) y si Compute lo acepto:
  // mientras dura la pausa solo se dice "encendiendo" si el ultimo fue aceptado.
  let lastStartAt = 0;
  let lastStartAccepted = false;
  let lastStartProblem = "";
  let lastStoppingAt = 0;
  let lastWarned = "";
  let lastCheck: { at: number; outcome: VmAutostartOutcome } | null = null;
  let inFlight: Promise<VmAutostartOutcome> | null = null;

  async function call(method: "GET" | "POST", url: string) {
    const token = await getAccessToken();
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

  async function check(): Promise<VmAutostartOutcome> {
    const instance = await call("GET", instanceUrl);
    if (instance.status < 200 || instance.status >= 300) {
      return { state: "unavailable", reason: `instances.get HTTP ${instance.status}` };
    }
    const vmStatus = trimText(instance.json.status).toUpperCase() || "DESCONOCIDO";

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
    const started = await call("POST", `${instanceUrl}/start`);
    if (started.status < 200 || started.status >= 300) {
      lastStartProblem = `instances.start HTTP ${started.status}`;
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
      .catch((error: unknown): VmAutostartOutcome => {
        const name = error && typeof error === "object" && "name" in error ? String((error as { name?: unknown }).name) : "";
        return { state: "unavailable", reason: name === "AbortError" ? "timeout de la API de Compute" : String(error).slice(0, 200) };
      })
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

  return { config, ensureStarted };
}

export type VmAutostarter = ReturnType<typeof createVmAutostarter>;

let defaultAutostarter: VmAutostarter | null | undefined;

/** Autoencendido del proceso segun el entorno (null si esta apagado o incompleto). */
export function getDefaultVmAutostarter() {
  if (defaultAutostarter !== undefined) return defaultAutostarter;
  const { config, problem } = resolveVmAutostartConfig();
  if (problem) console.warn(`[config] ${problem} El autoencendido de la VM queda apagado.`);
  defaultAutostarter = config ? createVmAutostarter(config) : null;
  return defaultAutostarter;
}

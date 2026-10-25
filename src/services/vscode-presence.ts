// VS Code de cada usuario visto por el backend (25/10/2026): la guia del navegador comprueba
// que la extension ADACEEN de VS Code este instalada en el editor (tunel) y en la ultima version.
// Toda llamada de VS Code trae x-adaceen-worker-id ("adaceen-vscode-<remoto>") y, desde la
// 0.0.37, x-adaceen-vscode-version. Se guarda por usuario y por tipo de editor (el tunel de
// vscode.dev, VS Code instalado o Codespaces): un estudiante con VS Code abierto en la Mac y en
// el tunel no hace que uno tape al otro. Vive en memoria (el App Service corre una sola
// instancia, deploy/produccion.sh lo revisa): se rehace sola con la siguiente llamada (VS Code
// consulta cada 8 s) y no guarda nada del estudiante en la base de datos.
import { cleanExtensionVersion, compareExtensionVersions } from "./chrome-web-store.js";

export const VSCODE_VERSION_HEADER = "x-adaceen-vscode-version";
const WORKER_PREFIX = "adaceen-vscode-";
/** Visto hace menos que esto: VS Code sigue abierto. */
export const VSCODE_PRESENCE_FRESH_MS = 90_000;
/** Pasado esto se olvida (una clase no dura tanto). */
const PRESENCE_TTL_MS = 6 * 60 * 60_000;
const MAX_USERS = 5_000;

/** Donde corre la extension: el tunel de vscode.dev, VS Code instalado, Codespaces u otro remoto. */
export const VSCODE_HOSTS = ["tunnel", "local", "codespaces", "other"] as const;
export type VscodeHost = (typeof VSCODE_HOSTS)[number];

export type VscodePresence = { version: string; host: VscodeHost; seenAt: number };

// Usuario -> tipo de editor -> lo ultimo que se vio. El Map de afuera queda ordenado por la
// ultima llamada (el mas viejo primero) para descartar al llegar al tope.
const presences = new Map<string, Map<VscodeHost, VscodePresence>>();

/** "tunnel", "local", "codespaces" u "other" ("" si la llamada no es de la extension de VS Code). */
export function vscodeHostFromWorkerId(workerId: unknown): VscodeHost | "" {
  const id = typeof workerId === "string" ? workerId.trim().toLowerCase() : "";
  if (!id.startsWith(WORKER_PREFIX)) return "";
  const remote = id.slice(WORKER_PREFIX.length).replace(/[^a-z0-9-]/g, "").slice(0, 40);
  if (!remote || remote === "local") return "local";
  if (remote === "tunnel") return "tunnel";
  if (remote.includes("codespaces")) return "codespaces";
  return "other";
}

/** ¿Es uno de los tipos de editor que se guardan? (la ruta valida ?host= con esto). */
export function isVscodeHost(value: unknown): value is VscodeHost {
  return typeof value === "string" && (VSCODE_HOSTS as readonly string[]).includes(value);
}

function forgetStale(now: number) {
  for (const [userId, hosts] of presences) {
    for (const [host, presence] of hosts) {
      if (now - presence.seenAt > PRESENCE_TTL_MS) hosts.delete(host);
    }
    if (!hosts.size) presences.delete(userId);
  }
}

/** Anota una llamada de VS Code con sesion (la hace el middleware de sesion). */
export function recordVscodePresence(userId: string, workerId: unknown, version: unknown, now = Date.now()) {
  const host = vscodeHostFromWorkerId(workerId);
  if (!userId || !host) return;
  if (!presences.has(userId) && presences.size >= MAX_USERS) {
    forgetStale(now);
    if (presences.size >= MAX_USERS) {
      const oldest = presences.keys().next().value;
      if (oldest !== undefined) presences.delete(oldest);
    }
  }
  const hosts = presences.get(userId) || new Map<VscodeHost, VscodePresence>();
  presences.delete(userId); // al final del Map: el mas viejo queda primero
  hosts.set(host, { version: cleanExtensionVersion(version), host, seenAt: now });
  presences.set(userId, hosts);
}

/**
 * Lo ultimo que se vio de VS Code de ese usuario en ese tipo de editor o, sin tipo, en
 * cualquiera (el mas reciente). null si no se vio o ya se olvido.
 */
export function readVscodePresence(userId: string, host?: VscodeHost, now = Date.now()): VscodePresence | null {
  const hosts = presences.get(userId);
  if (!hosts) return null;
  let found: VscodePresence | null = null;
  for (const [key, presence] of hosts) {
    if (now - presence.seenAt > PRESENCE_TTL_MS) {
      hosts.delete(key);
      continue;
    }
    if (host ? key === host : !found || presence.seenAt > found.seenAt) found = presence;
  }
  if (!hosts.size) presences.delete(userId);
  return host ? (found?.host === host ? found : null) : found;
}

/** Solo las pruebas. */
export function clearVscodePresences() {
  presences.clear();
}

export type VscodeExtensionStatus = "up_to_date" | "outdated" | "unknown_version" | "not_seen";

export type VscodeExtensionDescription = {
  status: VscodeExtensionStatus;
  latest_version: string;
  version: string;
  host: VscodeHost | "";
  seen_at: string;
  fresh: boolean;
};

/**
 * Lo que la guia muestra: sin VS Code visto, «not_seen»; visto sin version (anterior a la
 * 0.0.37), «unknown_version»; con una version menor que la publicada, «outdated».
 */
export function describeVscodeExtension(presence: VscodePresence | null, latestVersion: string, now = Date.now()): VscodeExtensionDescription {
  const latest = cleanExtensionVersion(latestVersion);
  let status: VscodeExtensionStatus = "not_seen";
  if (presence) {
    if (!presence.version) status = "unknown_version";
    else if (latest && compareExtensionVersions(presence.version, latest) < 0) status = "outdated";
    else status = "up_to_date";
  }
  return {
    status,
    latest_version: latest,
    version: presence?.version || "",
    host: presence?.host || "",
    seen_at: presence ? new Date(presence.seenAt).toISOString() : "",
    fresh: !!presence && now - presence.seenAt <= VSCODE_PRESENCE_FRESH_MS,
  };
}

/**
 * Todos los tipos de editor en que se vio a VS Code de ese usuario, para el estado de la
 * sesion (la linea «VS Code» de Inicio elige el de la pagina: el tunel en vscode.dev,
 * Codespaces en github.dev). `latest` es el tipo visto mas recientemente ("" si ninguno).
 */
export function describeVscodeExtensionsByHost(userId: string, latestVersion: string, now = Date.now()) {
  const hosts: Partial<Record<VscodeHost, VscodeExtensionDescription>> = {};
  for (const host of VSCODE_HOSTS) {
    const presence = readVscodePresence(userId, host, now);
    if (presence) hosts[host] = describeVscodeExtension(presence, latestVersion, now);
  }
  return {
    latest_version: cleanExtensionVersion(latestVersion),
    latest: readVscodePresence(userId, undefined, now)?.host || "",
    hosts,
  };
}

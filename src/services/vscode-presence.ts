// VS Code de cada usuario visto por el backend (25/10/2026): la guia del navegador comprueba
// que la extension ADACEEN de VS Code este instalada en el editor (tunel) y en la ultima version.
//
// Cada llamada de VS Code 0.0.37 o posterior dice donde corre (x-adaceen-editor-host) y que
// version es (x-adaceen-client-version); las anteriores solo traen x-adaceen-worker-id
// ("adaceen-vscode-<remoto>"). Las cabeceras se leen en src/routes/vscode-presence-routes.ts:
// aqui llegan valores. Se guarda por usuario y por tipo de editor (el tunel de vscode.dev, VS Code
// instalado o Codespaces): un estudiante con VS Code abierto en la Mac y en el tunel no hace que
// uno tape al otro. Vive en memoria (el App Service corre una sola instancia, deploy/produccion.sh
// lo revisa): se rehace sola con la siguiente llamada (VS Code consulta cada 8 s) y no guarda nada
// del estudiante en la base de datos.
import { cleanExtensionVersion, compareExtensionVersions } from "./extension-version.js";

/** Visto hace menos que esto: VS Code sigue abierto (`online`). */
export const VSCODE_ONLINE_WINDOW_MS = 90_000;
/** Pasado esto se olvida (una clase no dura tanto). */
const PRESENCE_TTL_MS = 6 * 60 * 60_000;
const MAX_USERS = 5_000;
const WORKER_PREFIX = "adaceen-vscode-";

/** Donde corre la extension: el tunel de vscode.dev, VS Code instalado, Codespaces u otro remoto. */
export const VSCODE_HOSTS = ["tunnel", "local", "codespaces", "other"] as const;
export type VscodeHost = (typeof VSCODE_HOSTS)[number];

/** Una llamada de la extension de VS Code: donde corre y que version es ("" en la 0.0.36 o anterior). */
export type VscodeClient = { host: VscodeHost; version: string };

export type VscodePresence = { version: string; host: VscodeHost; seenAt: number };

// Usuario -> tipo de editor -> lo ultimo que se vio. El Map de afuera queda ordenado por la
// ultima llamada (el mas viejo primero) para descartar al llegar al tope.
const presences = new Map<string, Map<VscodeHost, VscodePresence>>();

function hostFromRemoteName(remote: string): VscodeHost {
  if (!remote || remote === "local") return "local";
  if (remote === "tunnel" || remote.startsWith("tunnel")) return "tunnel";
  if (remote.includes("codespaces")) return "codespaces";
  return "other";
}

function cleanToken(value: unknown) {
  return typeof value === "string" ? value.trim().toLowerCase().replace(/[^a-z0-9-]/g, "").slice(0, 40) : "";
}

/** x-adaceen-editor-host de VS Code 0.0.37 (local, tunnel, codespaces o remote); null si no viene. */
export function vscodeHostFromEditorHost(value: unknown): VscodeHost | null {
  const host = cleanToken(value);
  return host ? hostFromRemoteName(host) : null;
}

/** x-adaceen-worker-id de VS Code ("adaceen-vscode-<remoto>"); null si la llamada no es de VS Code. */
export function vscodeHostFromWorkerId(workerId: unknown): VscodeHost | null {
  const id = typeof workerId === "string" ? workerId.trim().toLowerCase() : "";
  if (!id.startsWith(WORKER_PREFIX)) return null;
  return hostFromRemoteName(cleanToken(id.slice(WORKER_PREFIX.length)));
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

/** Anota una llamada de VS Code con sesion (la hace createVscodePresenceMiddleware). */
export function recordVscodePresence(userId: string, client: VscodeClient, now = Date.now()) {
  if (!userId || !client || !isVscodeHost(client.host)) return;
  if (!presences.has(userId) && presences.size >= MAX_USERS) {
    forgetStale(now);
    if (presences.size >= MAX_USERS) {
      const oldest = presences.keys().next().value;
      if (oldest !== undefined) presences.delete(oldest);
    }
  }
  const hosts = presences.get(userId) || new Map<VscodeHost, VscodePresence>();
  presences.delete(userId); // al final del Map: el mas viejo queda primero
  hosts.set(client.host, { version: cleanExtensionVersion(client.version), host: client.host, seenAt: now });
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

/**
 *   up_to_date       la version vista es la publicada (o posterior)
 *   outdated         la version vista es anterior a la publicada
 *   unknown_version  se vio VS Code sin version (0.0.36 o anterior)
 *   latest_unknown   se vio con version, pero no se pudo leer la publicada: no se comparo nada
 *   not_seen         no se vio VS Code (o ya se olvido)
 */
export type VscodeExtensionStatus = "up_to_date" | "outdated" | "unknown_version" | "latest_unknown" | "not_seen";

/**
 * La extension de VS Code en un tipo de editor, en camelCase como el estado de la sesion, con
 * null donde no hay dato. `online`: vista en los ultimos 90 s (VS Code sigue abierto).
 */
export type VscodeExtensionReport =
  | { status: "not_seen"; host: VscodeHost | null; version: null; latestVersion: string | null; seenAt: null; online: false }
  | {
    status: Exclude<VscodeExtensionStatus, "not_seen">;
    host: VscodeHost;
    version: string | null;
    latestVersion: string | null;
    seenAt: string;
    online: boolean;
  };

export type DescribeVscodeExtensionOptions = {
  now?: number;
  /** El tipo de editor que se pregunto: un «not_seen» lo devuelve en `host`. */
  requestedHost?: VscodeHost;
};

export function describeVscodeExtension(
  presence: VscodePresence | null,
  latestVersion: string,
  { now = Date.now(), requestedHost }: DescribeVscodeExtensionOptions = {},
): VscodeExtensionReport {
  const latest = cleanExtensionVersion(latestVersion) || null;
  if (!presence) {
    return { status: "not_seen", host: requestedHost ?? null, version: null, latestVersion: latest, seenAt: null, online: false };
  }
  const version = presence.version || null;
  let status: Exclude<VscodeExtensionStatus, "not_seen">;
  if (!version) status = "unknown_version";
  else if (!latest) status = "latest_unknown";
  else status = compareExtensionVersions(version, latest) < 0 ? "outdated" : "up_to_date";
  return {
    status,
    host: presence.host,
    version,
    latestVersion: latest,
    seenAt: new Date(presence.seenAt).toISOString(),
    online: now - presence.seenAt <= VSCODE_ONLINE_WINDOW_MS,
  };
}

/** `state.vscodeExtension` del estado de la sesion. */
export type VscodeExtensionsByHost = {
  latestVersion: string | null;
  /** El tipo de editor en que se vio a VS Code mas recientemente (null si en ninguno). */
  lastSeenHost: VscodeHost | null;
  hosts: Partial<Record<VscodeHost, VscodeExtensionReport>>;
};

/**
 * Todos los tipos de editor en que se vio a VS Code de ese usuario, para el estado de la
 * sesion (la linea «VS Code» de Inicio elige el de la pagina: el tunel en vscode.dev,
 * Codespaces en github.dev).
 */
export function describeVscodeExtensionsByHost(userId: string, latestVersion: string, now = Date.now()): VscodeExtensionsByHost {
  const hosts: Partial<Record<VscodeHost, VscodeExtensionReport>> = {};
  for (const host of VSCODE_HOSTS) {
    const presence = readVscodePresence(userId, host, now);
    if (presence) hosts[host] = describeVscodeExtension(presence, latestVersion, { now });
  }
  return {
    latestVersion: cleanExtensionVersion(latestVersion) || null,
    lastSeenHost: readVscodePresence(userId, undefined, now)?.host ?? null,
    hosts,
  };
}

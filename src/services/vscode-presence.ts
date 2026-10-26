// VS Code de cada usuario visto por el backend (25/10/2026): la guia del navegador comprueba
// que la extension ADACEEN de VS Code este instalada en el editor (tunel) y en la ultima version.
//
// Cada llamada de VS Code 0.0.37 o posterior dice donde corre (x-adaceen-editor-host) y que
// version es (x-adaceen-client-version); las anteriores solo traen x-adaceen-worker-id
// ("adaceen-vscode-<remoto>"). Las cabeceras se leen en src/routes/vscode-presence-routes.ts:
// aqui llegan valores. Se guarda por usuario y por tipo de editor (el tunel de vscode.dev, VS Code
// instalado, Codespaces u otro remoto): un estudiante con VS Code abierto en la Mac y en el tunel
// no hace que uno tape al otro. Vive en memoria (el App Service corre una sola instancia,
// deploy/produccion.sh lo revisa): se rehace sola con la siguiente llamada (VS Code consulta cada
// 8 s) y no guarda nada del estudiante en la base de datos.
import { cleanExtensionVersion, compareExtensionVersions } from "./extension-version.js";

/** Vista hace menos que esto: VS Code sigue abierto (`online`). */
export const VSCODE_ONLINE_WINDOW_MS = 90_000;
/** La primera version de la extension que dice su version en cada llamada. */
export const FIRST_VERSION_REPORTING_ITSELF = "0.0.37";
/** Pasado esto se olvida (una clase no dura tanto). */
const PRESENCE_TTL_MS = 6 * 60 * 60_000;
const MAX_USERS = 5_000;
const WORKER_PREFIX = "adaceen-vscode-";

/**
 * Tipo de editor, los mismos valores que manda VS Code en x-adaceen-editor-host y en la
 * telemetria (metadata.editorHost): el tunel de vscode.dev, VS Code instalado, Codespaces u
 * otro remoto (SSH, WSL, contenedor).
 */
export const EDITOR_HOSTS = ["tunnel", "local", "codespaces", "remote"] as const;
export type EditorHost = (typeof EDITOR_HOSTS)[number];

/** Una llamada de la extension de VS Code: donde corre y que version es (null en la 0.0.36 o anterior). */
export type VscodeClient = { editorHost: EditorHost; version: string | null };

export type VscodePresence = { version: string | null; editorHost: EditorHost; seenAt: number };

// Usuario -> tipo de editor -> lo ultimo que se vio. El Map de afuera queda ordenado por la
// ultima llamada (el mas viejo primero) para descartar al llegar al tope.
const presences = new Map<string, Map<EditorHost, VscodePresence>>();

function editorHostFromRemoteName(remote: string): EditorHost {
  if (!remote || remote === "local") return "local";
  if (remote === "tunnel" || remote.startsWith("tunnel")) return "tunnel";
  if (remote.includes("codespaces")) return "codespaces";
  return "remote";
}

function cleanToken(value: unknown) {
  return typeof value === "string" ? value.trim().toLowerCase().replace(/[^a-z0-9-]/g, "").slice(0, 40) : "";
}

/** x-adaceen-editor-host de VS Code 0.0.37 (local, tunnel, codespaces o remote); null si no viene. */
export function editorHostFromHeader(value: unknown): EditorHost | null {
  const token = cleanToken(value);
  return token ? editorHostFromRemoteName(token) : null;
}

/** x-adaceen-worker-id de VS Code ("adaceen-vscode-<remoto>"); null si la llamada no es de VS Code. */
export function editorHostFromWorkerId(workerId: unknown): EditorHost | null {
  const id = typeof workerId === "string" ? workerId.trim().toLowerCase() : "";
  if (!id.startsWith(WORKER_PREFIX)) return null;
  return editorHostFromRemoteName(cleanToken(id.slice(WORKER_PREFIX.length)));
}

/** ¿Es uno de los tipos de editor que se guardan? (la ruta valida ?editorHost= con esto). */
export function isEditorHost(value: unknown): value is EditorHost {
  return typeof value === "string" && (EDITOR_HOSTS as readonly string[]).includes(value);
}

function forgetStale(now: number) {
  for (const [userId, byEditorHost] of presences) {
    for (const [editorHost, presence] of byEditorHost) {
      if (now - presence.seenAt > PRESENCE_TTL_MS) byEditorHost.delete(editorHost);
    }
    if (!byEditorHost.size) presences.delete(userId);
  }
}

/** Anota una llamada de VS Code con sesion (la hace createVscodePresenceMiddleware). */
export function recordVscodePresence(userId: string, client: VscodeClient, now = Date.now()) {
  if (!userId || !client || !isEditorHost(client.editorHost)) return;
  if (!presences.has(userId) && presences.size >= MAX_USERS) {
    forgetStale(now);
    if (presences.size >= MAX_USERS) {
      const oldest = presences.keys().next().value;
      if (oldest !== undefined) presences.delete(oldest);
    }
  }
  const byEditorHost = presences.get(userId) || new Map<EditorHost, VscodePresence>();
  presences.delete(userId); // al final del Map: el mas viejo queda primero
  byEditorHost.set(client.editorHost, { version: cleanExtensionVersion(client.version) || null, editorHost: client.editorHost, seenAt: now });
  presences.set(userId, byEditorHost);
}

/**
 * Lo ultimo que se vio de VS Code de ese usuario en ese tipo de editor o, sin tipo, en
 * cualquiera (el mas reciente). null si no se vio o ya se olvido.
 */
export function readVscodePresence(userId: string, editorHost?: EditorHost, now = Date.now()): VscodePresence | null {
  const byEditorHost = presences.get(userId);
  if (!byEditorHost) return null;
  let found: VscodePresence | null = null;
  for (const [key, presence] of byEditorHost) {
    if (now - presence.seenAt > PRESENCE_TTL_MS) {
      byEditorHost.delete(key);
      continue;
    }
    if (editorHost ? key === editorHost : !found || presence.seenAt > found.seenAt) found = presence;
  }
  if (!byEditorHost.size) presences.delete(userId);
  return editorHost ? (found?.editorHost === editorHost ? found : null) : found;
}

/** Solo las pruebas. */
export function clearVscodePresences() {
  presences.clear();
}

/**
 *   up_to_date              la version vista es la publicada (o posterior)
 *   outdated                la version vista es anterior a la publicada; o no dijo su version y
 *                           la publicada ya la dice (FIRST_VERSION_REPORTING_ITSELF): es anterior
 *   version_not_reported    no dijo su version y no se puede deducir si es anterior
 *   latest_version_unknown  dijo su version, pero no se pudo leer la publicada: no se comparo nada
 *   not_seen                no se vio VS Code (o ya se olvido)
 */
export type VscodeExtensionStatus = "up_to_date" | "outdated" | "version_not_reported" | "latest_version_unknown" | "not_seen";

/** La extension de VS Code vista en un tipo de editor; null donde no hay dato. */
export type SeenVscodeExtensionReport = {
  status: Exclude<VscodeExtensionStatus, "not_seen">;
  editorHost: EditorHost;
  version: string | null;
  latestVersion: string | null;
  lastSeenAt: string;
  /** Vista en los ultimos 90 s: VS Code sigue abierto. */
  online: boolean;
};

export type UnseenVscodeExtensionReport = {
  status: "not_seen";
  /** El tipo de editor que se pregunto (null sin tipo). */
  editorHost: EditorHost | null;
  version: null;
  latestVersion: string | null;
  lastSeenAt: null;
  online: false;
};

export type VscodeExtensionReport = SeenVscodeExtensionReport | UnseenVscodeExtensionReport;

function statusOf(version: string | null, latest: string | null): Exclude<VscodeExtensionStatus, "not_seen"> {
  if (!version) {
    return latest && compareExtensionVersions(latest, FIRST_VERSION_REPORTING_ITSELF) >= 0 ? "outdated" : "version_not_reported";
  }
  if (!latest) return "latest_version_unknown";
  return compareExtensionVersions(version, latest) < 0 ? "outdated" : "up_to_date";
}

function describeSeen(presence: VscodePresence, latest: string | null, now: number): SeenVscodeExtensionReport {
  return {
    status: statusOf(presence.version, latest),
    editorHost: presence.editorHost,
    version: presence.version,
    latestVersion: latest,
    lastSeenAt: new Date(presence.seenAt).toISOString(),
    online: now - presence.seenAt <= VSCODE_ONLINE_WINDOW_MS,
  };
}

export type DescribeVscodeExtensionOptions = {
  /** Sin tipo: el editor en que se vio a VS Code mas recientemente. */
  editorHost?: EditorHost;
  now?: number;
};

/** La extension de VS Code de ese usuario en ese tipo de editor (o en el mas reciente). */
export function describeVscodeExtensionForUser(
  userId: string,
  latestVersion: string | null,
  { editorHost, now = Date.now() }: DescribeVscodeExtensionOptions = {},
): VscodeExtensionReport {
  const latest = cleanExtensionVersion(latestVersion) || null;
  const presence = readVscodePresence(userId, editorHost, now);
  if (!presence) {
    return { status: "not_seen", editorHost: editorHost ?? null, version: null, latestVersion: latest, lastSeenAt: null, online: false };
  }
  return describeSeen(presence, latest, now);
}

/** `state.vscodeExtension` del estado de la sesion. */
export type VscodeExtensionsByEditorHost = {
  latestVersion: string | null;
  /** El tipo de editor en que se vio a VS Code mas recientemente (null si en ninguno). */
  lastSeenEditorHost: EditorHost | null;
  byEditorHost: Partial<Record<EditorHost, SeenVscodeExtensionReport>>;
};

/**
 * Todos los tipos de editor en que se vio a VS Code de ese usuario, para el estado de la
 * sesion (la linea «VS Code» de Inicio elige el de la pagina: el tunel en vscode.dev,
 * Codespaces en github.dev).
 */
export function describeVscodeExtensionsByEditorHost(userId: string, latestVersion: string | null, now = Date.now()): VscodeExtensionsByEditorHost {
  const latest = cleanExtensionVersion(latestVersion) || null;
  const byEditorHost: Partial<Record<EditorHost, SeenVscodeExtensionReport>> = {};
  for (const editorHost of EDITOR_HOSTS) {
    const presence = readVscodePresence(userId, editorHost, now);
    if (presence) byEditorHost[editorHost] = describeSeen(presence, latest, now);
  }
  return {
    latestVersion: latest,
    lastSeenEditorHost: readVscodePresence(userId, undefined, now)?.editorHost ?? null,
    byEditorHost,
  };
}

// Entorno de los estudiantes elegido por el administrador en la tuerca de la extension de
// navegador (0.7.19): "tunnel" (editor en la nube por VS Code Tunnels) o "codespaces".
// Se guarda en app_settings (clave workspace_provider) y manda sobre
// ADACEEN_WORKSPACE_PROVIDER; con "server" (o sin fila) manda la variable, como antes.
//
// La extension consulta /api/workspaces/status cada 3 s y /api/health lo leen /empezar y
// deploy/clase.sh: una cache corta por base de datos evita una consulta en cada peticion.
// Guardar la renueva, asi con la unica instancia del App Service (docs/operacion/despliegue.md)
// el cambio se ve enseguida; con varias, en CHOICE_CACHE_TTL_MS como mucho.
import type { AppDatabase } from "../db/database.js";

export const WORKSPACE_PROVIDER_SETTING_KEY = "workspace_provider";
export const CHOICE_CACHE_TTL_MS = 15_000;

type ProviderName = "tunnel" | "codespaces";

/** Lo que puede elegir el administrador: un proveedor o "server" (volver a la variable). */
export type WorkspaceProviderRequest = ProviderName | "server";

export type StoredWorkspaceProviderChoice = {
  /** null: manda el servidor (no hay fila o la ultima eleccion fue "server"). */
  choice: ProviderName | null;
  /** Ultimo cambio desde la extension (tambien cuando se volvio a "server"). */
  updatedAt: string | null;
  updatedBy: string | null;
};

export type WorkspaceProviderState = {
  /** El activo: el que usan la extension, /empezar y deploy/clase.sh. */
  provider: ProviderName;
  /** admin: lo eligio el administrador en la extension; server: ADACEEN_WORKSPACE_PROVIDER. */
  source: "admin" | "server";
  /** ADACEEN_WORKSPACE_PROVIDER (o el config de las pruebas): lo que configura deploy/produccion.sh. */
  serverProvider: ProviderName;
  choice: ProviderName | null;
  updatedAt: string | null;
  updatedBy: string | null;
};

type ChoiceDatabase = Partial<Pick<AppDatabase, "getAppSetting" | "setAppSetting">>;

const EMPTY: StoredWorkspaceProviderChoice = Object.freeze({ choice: null, updatedAt: null, updatedBy: null });
const cache = new WeakMap<object, { value: StoredWorkspaceProviderChoice; expiresAt: number }>();

function normalizeProvider(value: unknown): ProviderName | null {
  const text = typeof value === "string" ? value.trim().toLowerCase() : "";
  return text === "tunnel" || text === "codespaces" ? text : null;
}

/** "tunnel", "codespaces" o "server"; cualquier otra cosa, null. */
export function normalizeWorkspaceProviderRequest(value: unknown): WorkspaceProviderRequest | null {
  const text = typeof value === "string" ? value.trim().toLowerCase() : "";
  return text === "server" ? "server" : normalizeProvider(text);
}

function fromSetting(setting: Awaited<ReturnType<NonNullable<ChoiceDatabase["getAppSetting"]>>>): StoredWorkspaceProviderChoice {
  if (!setting) return EMPTY;
  return {
    choice: normalizeProvider(setting.value),
    updatedAt: setting.updatedAt || null,
    updatedBy: setting.updatedByName || null,
  };
}

/**
 * Eleccion guardada (con cache corta). Sin la tabla o con la base caida un momento responde
 * lo ultimo que sabia (o "manda el servidor"), sin romper /api/health ni el editor.
 */
export async function readWorkspaceProviderChoice(database: ChoiceDatabase, now = Date.now()): Promise<StoredWorkspaceProviderChoice> {
  if (!database || typeof database.getAppSetting !== "function") return EMPTY;
  const cached = cache.get(database);
  if (cached && cached.expiresAt > now) return cached.value;
  let value: StoredWorkspaceProviderChoice;
  try {
    value = fromSetting(await database.getAppSetting(WORKSPACE_PROVIDER_SETTING_KEY));
  } catch (error) {
    value = cached?.value ?? EMPTY;
    console.warn(`[workspaces] no se pudo leer el entorno elegido por el administrador: ${String(error)}`);
  }
  cache.set(database, { value, expiresAt: now + CHOICE_CACHE_TTL_MS });
  return value;
}

/** Guarda la eleccion del administrador ("server" tambien queda guardado: quien y cuando). */
export async function saveWorkspaceProviderChoice(
  database: ChoiceDatabase,
  request: WorkspaceProviderRequest,
  userId: string,
  now = Date.now(),
): Promise<StoredWorkspaceProviderChoice> {
  if (!database || typeof database.setAppSetting !== "function") {
    throw new Error("Esta base de datos no guarda ajustes del sistema.");
  }
  const value = fromSetting(await database.setAppSetting(WORKSPACE_PROVIDER_SETTING_KEY, request, userId));
  cache.set(database, { value, expiresAt: now + CHOICE_CACHE_TTL_MS });
  return value;
}

export function resolveWorkspaceProviderState(serverProvider: string, stored: StoredWorkspaceProviderChoice): WorkspaceProviderState {
  const server: ProviderName = serverProvider === "tunnel" ? "tunnel" : "codespaces";
  return {
    provider: stored.choice || server,
    source: stored.choice ? "admin" : "server",
    serverProvider: server,
    choice: stored.choice,
    updatedAt: stored.updatedAt,
    updatedBy: stored.updatedBy,
  };
}

/** Pruebas: olvida la cache de esa base (como si fuera otra instancia del backend). */
export function forgetWorkspaceProviderChoice(database: object) {
  cache.delete(database);
}

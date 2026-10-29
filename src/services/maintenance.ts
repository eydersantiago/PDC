// Aviso «Estamos actualizando» para los despliegues (28-10-2026).
//
// El administrador lo enciende antes de subir un cambio (PUT /api/admin/maintenance o el boton del
// monitor del docente) y lo apaga al verificar. Mientras esta encendido, el tutor responde el aviso
// en vez de una pista (overlay y VS Code, sin registrar decisiones del tutor), /api/health lo dice y
// /empezar lo muestra. Vive en app_settings: sobrevive al reinicio del App Service que trae el
// despliegue. Se apaga solo al vencer (por defecto 30 min, maximo 4 h), para que un olvido no deje
// a los estudiantes sin tutor. El aviso dentro de las extensiones llega con sus versiones nuevas.
import type { AppSetting } from "../db/rows.js";
import { trimText } from "./text-utils.js";

export const MAINTENANCE_SETTING_KEY = "maintenance_notice";
export const DEFAULT_MAINTENANCE_MESSAGE =
  "Estamos actualizando ADACEEN. El tutor vuelve en unos minutos; mientras tanto puedes seguir programando en tu editor.";
export const DEFAULT_MAINTENANCE_MINUTES = 30;
export const MAX_MAINTENANCE_MINUTES = 240;
const CACHE_MS = 10_000;

export type MaintenanceNotice = {
  active: boolean;
  message: string;
  startedAt: string | null;
  until: string | null;
  by: string | null;
};

type SettingsDatabase = {
  getAppSetting(key: string): Promise<AppSetting | null>;
  setAppSetting(key: string, value: string | null, updatedByUserId: string | null): Promise<AppSetting | null>;
};

const OFF: MaintenanceNotice = { active: false, message: DEFAULT_MAINTENANCE_MESSAGE, startedAt: null, until: null, by: null };
const cache = new WeakMap<object, { at: number; stored: MaintenanceNotice }>();

function parseStored(setting: AppSetting | null): MaintenanceNotice {
  if (!setting?.value) return OFF;
  try {
    const value = JSON.parse(setting.value) as Partial<MaintenanceNotice>;
    return {
      active: value.active === true,
      message: trimText(value.message) || DEFAULT_MAINTENANCE_MESSAGE,
      startedAt: trimText(value.startedAt) || null,
      until: trimText(value.until) || null,
      by: trimText(value.by) || setting.updatedByName || null,
    };
  } catch {
    return OFF;
  }
}

/** Encendido y sin vencer a esta hora. */
export function isMaintenanceActive(notice: MaintenanceNotice, now = Date.now()) {
  return notice.active && (!notice.until || Date.parse(notice.until) > now);
}

/** El aviso vigente (cache de 10 s: lo consultan todos los pedidos al tutor). Nunca lanza. */
export async function readMaintenance(database: SettingsDatabase, now = Date.now()): Promise<MaintenanceNotice> {
  if (!database || typeof database.getAppSetting !== "function") return OFF;
  const cached = cache.get(database);
  let stored = cached && now - cached.at < CACHE_MS ? cached.stored : null;
  if (!stored) {
    try {
      stored = parseStored(await database.getAppSetting(MAINTENANCE_SETTING_KEY));
    } catch (error) {
      console.warn(`[aviso] no se pudo leer el aviso de actualizacion: ${String(error)}`);
      stored = cached?.stored ?? OFF;
    }
    cache.set(database, { at: now, stored });
  }
  return isMaintenanceActive(stored, now) ? stored : { ...stored, active: false };
}

/** Enciende o apaga el aviso. minutes: cuanto dura (1..240; por defecto 30). */
export async function setMaintenance(
  database: SettingsDatabase,
  input: { active: boolean; message?: string; minutes?: number; user: { id: string; displayName: string } },
  now = Date.now(),
): Promise<MaintenanceNotice> {
  const minutes = Math.max(1, Math.min(MAX_MAINTENANCE_MINUTES, Math.round(Number(input.minutes) || DEFAULT_MAINTENANCE_MINUTES)));
  const notice: MaintenanceNotice = input.active
    ? {
      active: true,
      message: trimText(input.message).slice(0, 400) || DEFAULT_MAINTENANCE_MESSAGE,
      startedAt: new Date(now).toISOString(),
      until: new Date(now + minutes * 60_000).toISOString(),
      by: trimText(input.user.displayName).slice(0, 120) || null,
    }
    : { ...OFF, by: trimText(input.user.displayName).slice(0, 120) || null };
  await database.setAppSetting(MAINTENANCE_SETTING_KEY, JSON.stringify(notice), input.user.id);
  cache.set(database, { at: now, stored: notice });
  console.info(`[aviso] ${input.active ? `encendido hasta ${notice.until}` : "apagado"} por ${input.user.displayName} (${input.user.id}).`);
  return notice;
}

/** Lo que responde el tutor de VS Code con el aviso encendido (formato de /suggest-tab, sin «Aplicar:»). */
export function buildMaintenanceSuggestionMarkdown(notice: MaintenanceNotice) {
  return [
    "1) Resumen:",
    `- ${notice.message}`,
    "",
    "2) Sugerencias del codigo:",
    "- Guarda tu trabajo y sigue con el siguiente paso; vuelve a pedir la sugerencia en unos minutos.",
    "",
    "5) Riesgos:",
    "- Motivo de control: ADACEEN se esta actualizando; no se inventa una sugerencia.",
  ].join("\n");
}

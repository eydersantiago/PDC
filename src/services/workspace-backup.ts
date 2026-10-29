// «Ultimo respaldo» del trabajo de los estudiantes (28-10-2026).
//
// La VM de editores copia cada 15 min, a un bucket de Google Cloud, lo que cambio en las carpetas de
// cada estudiante (deploy/gcp/workspaces/respaldo-ws.py; se activa con deploy/gcp/respaldos.sh
// activar). Al terminar cada copia avisa aqui con el token del agente (POST
// /api/workspaces/backup-report): cuando fue, cuantos estudiantes, cuantos cambiaron y si fallo.
// Se guarda en app_settings (el ultimo informe) y lo ven el administrador en el monitor del docente
// y cualquiera en /api/health (sin nombres ni rutas). El codigo de los estudiantes nunca pasa por
// el backend.
import { z } from "zod";
import type { AppSetting } from "../db/rows.js";

export const WORKSPACE_BACKUP_SETTING_KEY = "workspace_backup_last";
const CACHE_MS = 30_000;

export const backupReportSchema = z.object({
  /** Cuando termino la copia (ISO). */
  finishedAt: z.string().max(40),
  ok: z.boolean(),
  students: z.number().int().min(0).max(100_000),
  changed: z.number().int().min(0).max(100_000),
  uploaded: z.number().int().min(0).max(100_000),
  failed: z.number().int().min(0).max(100_000).default(0),
  bytes: z.number().int().min(0).max(1e13).default(0),
  durationMs: z.number().int().min(0).max(86_400_000).default(0),
  /** gs://<bucket> (no es secreto). */
  bucket: z.string().max(120).default(""),
  problem: z.string().max(300).default(""),
});

export type BackupReport = z.infer<typeof backupReportSchema> & { receivedAt: string };

type SettingsDatabase = {
  getAppSetting(key: string): Promise<AppSetting | null>;
  setAppSetting(key: string, value: string | null, updatedByUserId: string | null): Promise<AppSetting | null>;
};

const cache = new WeakMap<object, { at: number; report: BackupReport | null }>();

export async function saveBackupReport(database: SettingsDatabase, input: z.infer<typeof backupReportSchema>, now = Date.now()) {
  const finished = Date.parse(input.finishedAt);
  const report: BackupReport = {
    ...input,
    finishedAt: Number.isNaN(finished) ? new Date(now).toISOString() : new Date(finished).toISOString(),
    receivedAt: new Date(now).toISOString(),
  };
  await database.setAppSetting(WORKSPACE_BACKUP_SETTING_KEY, JSON.stringify(report), null);
  cache.set(database, { at: now, report });
  if (!report.ok) console.warn(`[respaldo] la copia de las ${report.finishedAt} fallo: ${report.problem || `${report.failed} estudiante(s) sin copia`}`);
  return report;
}

/** El ultimo informe de la VM, o null si nunca llego uno. Nunca lanza. */
export async function readBackupReport(database: SettingsDatabase, now = Date.now()): Promise<BackupReport | null> {
  if (!database || typeof database.getAppSetting !== "function") return null;
  const cached = cache.get(database);
  if (cached && now - cached.at < CACHE_MS) return cached.report;
  let report: BackupReport | null = null;
  try {
    const setting = await database.getAppSetting(WORKSPACE_BACKUP_SETTING_KEY);
    report = setting?.value ? JSON.parse(setting.value) as BackupReport : null;
  } catch {
    report = cached?.report ?? null;
  }
  cache.set(database, { at: now, report });
  return report;
}

/** Para /api/health: sin bucket ni detalle, solo cuando y como salio. */
export function describeBackupForHealth(report: BackupReport | null) {
  if (!report) return { last_at: null, ok: null, students: null, changed: null };
  return { last_at: report.finishedAt, ok: report.ok, students: report.students, changed: report.changed };
}

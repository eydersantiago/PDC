// Lo que pasa con cada informe de avance de la VM (POST /api/workspaces/progress-report,
// 02-11-2026): se guarda (lo que ven el docente y el estudiante) y, con las cuentas leidas UNA vez,
// se deja la historia para el analisis y se arman los codigos del analisis para las entregas.
//
// Cada parte falla por su lado: si no se guarda el informe, lanza (la VM lo reintenta en 10 min);
// si no se pueden leer las cuentas, el informe queda guardado y history y analysisCodes van en
// null (la VM no toca las entregas de ese taller); si solo falla la historia, los codigos igual
// salen. El log dice cuantos codigos se entregaron, nunca cuales ni de quien.
import type { AnalyticsStudentIdentity } from "../db/repos/analytics.js";
import { analysisCodesByLogin, recordWorkshopSnapshotsForIdentities, type SnapshotDatabase, type SnapshotSummary } from "./analytics/learning-analytics.js";
import { saveProgressReport, type ProgressReport, type ProgressReportInput } from "./progress/workshop-progress.js";

export type ProgressIngestDatabase = Parameters<typeof saveProgressReport>[0] & SnapshotDatabase;
type IngestLog = Pick<Console, "info" | "warn">;

export type ProgressIngestResult = {
  report: ProgressReport;
  /** Resumen de la historia, o null si no se pudo guardar. */
  history: SnapshotSummary | null;
  /** Login -> codigo del analisis de quien tiene la carpeta, o null si no se pudieron leer las cuentas. */
  analysisCodes: Record<string, string> | null;
};

function reason(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}

export async function ingestProgressReport(
  database: ProgressIngestDatabase,
  input: ProgressReportInput,
  log: IngestLog = console,
): Promise<ProgressIngestResult> {
  const report = await saveProgressReport(database, input);
  let identities: AnalyticsStudentIdentity[] | null = null;
  try {
    identities = await database.listStudentAnalyticsIdentities();
  } catch (error) {
    log.warn("[avance] no se leyeron las cuentas: sin historia ni codigos del analisis:", reason(error));
    return { report, history: null, analysisCodes: null };
  }
  // Historia para la analitica (seudonimos, solo lo que cambio). Si falla, el monitor no depende de ella.
  const history = await recordWorkshopSnapshotsForIdentities(database, report, identities).catch((error) => {
    log.warn("[avance] no se guardo la historia del informe:", reason(error));
    return null;
  });
  const analysisCodes = analysisCodesByLogin(report, identities);
  log.info(`[avance] codigos del analisis entregados a la VM: ${Object.keys(analysisCodes).length}`);
  return { report, history, analysisCodes };
}

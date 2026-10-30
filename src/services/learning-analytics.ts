// Analitica de aprendizaje (29-10-2026): datos por estudiante para Excel y Power BI, seudonimizados.
//
// - Historia del avance del taller: cada informe de la VM (POST /api/workspaces/progress-report) deja
//   una foto por estudiante SOLO si cambio algo, con el seudonimo de la telemetria (actor_anon_id =
//   HMAC de "user:<id>" con TELEMETRY_SALT) y no con el login de GitHub. Asi la curva de avance se
//   cruza con las ayudas del tutor sin datos personales.
// - Reidentificacion dentro de ADACEEN («¿Quien es este codigo?»): el administrador (todos) o el
//   docente (sus estudiantes) pasa UN codigo y recibe el nombre y el codigo estudiantil. Cada consulta
//   queda registrada y hay un tope por hora: no hay forma de bajar la tabla codigo <-> nombre. El
//   consentimiento del piloto (docs/piloto/consentimiento.md) dice que el nombre y el correo no
//   hacen parte del conjunto que se analiza y que la lista nombre <-> cuenta no se exporta.
import { createHash } from "node:crypto";
import type {
  AnalyticsStudentIdentity,
  PseudonymCandidate,
  WorkshopSnapshot,
  WorkshopSnapshotRow,
} from "../db/repos/analytics.js";
import type { AppUser } from "../types/app.js";
import { toCsvText } from "./csv.js";
import { isSampleAccountId, sampleActorAnonIds } from "./sample-accounts.js";
import { pseudonymize } from "./telemetry.js";
import type { ProgressReport, WorkshopStudentEntry } from "./workshop-progress.js";

/** actor_anon_id de la telemetria: 20 hex. */
export const PSEUDONYM_PATTERN = /^[0-9a-f]{20}$/;
/** Consultas de reidentificacion por persona y por hora (uno a la vez, no en bloque). */
export const PSEUDONYM_LOOKUPS_PER_HOUR = 30;

/** El mismo seudonimo que actorAnonId(actorFromSession(...)) en la telemetria. */
export function studentPseudonym(userId: string) {
  return pseudonymize(`user:${userId}`);
}

/** Huella de lo que se mide de un estudiante (sin la nota): cambia solo si cambia el avance. */
export function snapshotFingerprint(entry: Pick<WorkshopStudentEntry,
  "started" | "percent" | "compiles" | "done" | "partial" | "missing" | "files" | "outside" | "lastChangeAt">) {
  const canonical = JSON.stringify([
    entry.started,
    entry.percent,
    entry.compiles ?? null,
    [...entry.done].sort(),
    [...entry.partial].sort(),
    [...entry.missing].sort(),
    entry.files ?? 0,
    entry.outside ?? 0,
    entry.lastChangeAt ?? null,
  ]);
  return createHash("sha256").update(canonical).digest("hex").slice(0, 16);
}

export type SnapshotPlan = {
  snapshots: WorkshopSnapshot[];
  /** Ya estaba igual en la ultima foto. */
  unchanged: number;
  /** Login de la VM sin estudiante en la base (no se puede seudonimizar con su id). */
  unlinked: number;
  /** Cuentas de muestra: fuera del analisis. */
  sample: number;
  /** Con nota (reusado por plazo, pendiente o error): no es una medicion nueva. */
  stale: number;
};

/** Decide que fotos guardar. Puro: sin base de datos. */
export function planWorkshopSnapshots(
  report: ProgressReport,
  identities: AnalyticsStudentIdentity[],
  lastFingerprints: ReadonlyMap<string, string>,
): SnapshotPlan {
  // Si dos cuentas tienen el mismo login, gana la ultima de la lista (la que lo vinculo despues).
  const byLogin = new Map<string, AnalyticsStudentIdentity>();
  for (const identity of identities) {
    if (identity.githubLogin) byLogin.set(identity.githubLogin, identity);
  }
  const plan: SnapshotPlan = { snapshots: [], unchanged: 0, unlinked: 0, sample: 0, stale: 0 };
  const capturedAt = report.generatedAt || report.receivedAt;
  const seen = new Set<string>();
  for (const entry of report.students) {
    const identity = byLogin.get(entry.login.toLowerCase());
    if (!identity) {
      plan.unlinked += 1;
      continue;
    }
    if (isSampleAccountId(identity.userId)) {
      plan.sample += 1;
      continue;
    }
    if (entry.note) {
      plan.stale += 1;
      continue;
    }
    const actorAnonId = studentPseudonym(identity.userId);
    if (seen.has(actorAnonId)) continue;
    seen.add(actorAnonId);
    const fingerprint = snapshotFingerprint(entry);
    if (lastFingerprints.get(actorAnonId) === fingerprint) {
      plan.unchanged += 1;
      continue;
    }
    plan.snapshots.push({
      taller: report.taller,
      actorAnonId,
      teacherAnonId: identity.teacherUserId ? pseudonymize(`user:${identity.teacherUserId}`) : "",
      capturedAt,
      started: entry.started,
      percent: entry.percent,
      compiles: entry.compiles ?? null,
      done: entry.done,
      partial: entry.partial,
      missing: entry.missing,
      files: entry.files ?? 0,
      outside: entry.outside ?? 0,
      lastChangeAt: entry.lastChangeAt ?? null,
      fingerprint,
    });
  }
  return plan;
}

export type SnapshotDatabase = {
  listStudentAnalyticsIdentities(): Promise<AnalyticsStudentIdentity[]>;
  listWorkshopLastFingerprints(taller: string): Promise<Map<string, string>>;
  saveWorkshopSnapshots(snapshots: WorkshopSnapshot[]): Promise<number>;
};

/** Guarda la historia de un informe ya validado. Devuelve el resumen (sin logins ni nombres). */
export async function recordWorkshopSnapshots(database: SnapshotDatabase, report: ProgressReport) {
  const [identities, last] = await Promise.all([
    database.listStudentAnalyticsIdentities(),
    database.listWorkshopLastFingerprints(report.taller),
  ]);
  const plan = planWorkshopSnapshots(report, identities, last);
  const saved = await database.saveWorkshopSnapshots(plan.snapshots);
  return { saved, unchanged: plan.unchanged, unlinked: plan.unlinked, sample: plan.sample, stale: plan.stale };
}

/** Las cuentas de muestra quedan fuera de las vistas de analisis (deploy/bi/vistas-bi.sql). */
export async function syncAnalyticsExclusions(database: {
  replaceAnalyticsExcludedActors(anonIds: Iterable<string>, reason?: string): Promise<number>;
}) {
  return database.replaceAnalyticsExcludedActors(sampleActorAnonIds(), "muestra");
}

// ---------------------------------------------------------------------------
// Reidentificacion
// ---------------------------------------------------------------------------

export type PseudonymLookupResult =
  | { status: "invalid" }
  | { status: "limit"; retryAfterMinutes: number }
  | { status: "not_found" }
  | {
    status: "found";
    student: { displayName: string; studentCode: string | null; mergedIntoDisplayName: string | null; sample: boolean };
  };

export type PseudonymDatabase = {
  listPseudonymCandidates(viewer: AppUser): Promise<PseudonymCandidate[]>;
  getStudentCodeForUser(userId: string): Promise<string | null>;
  recordPseudonymLookup(viewerUserId: string, code: string, found: boolean): Promise<void>;
  countPseudonymLookupsSince(viewerUserId: string, sinceIso: string): Promise<number>;
};

export function normalizePseudonym(value: unknown) {
  const text = String(value ?? "").trim().toLowerCase();
  return PSEUDONYM_PATTERN.test(text) ? text : "";
}

/**
 * Un codigo -> nombre y codigo estudiantil, dentro del alcance del visor. Un codigo fuera de su
 * alcance responde not_found (no confirma que exista). Cada consulta valida queda registrada.
 */
export async function resolvePseudonym(
  database: PseudonymDatabase,
  viewer: AppUser,
  rawCode: unknown,
  now = Date.now(),
): Promise<PseudonymLookupResult> {
  if (viewer.role !== "admin" && viewer.role !== "teacher") return { status: "not_found" };
  const code = normalizePseudonym(rawCode);
  if (!code) return { status: "invalid" };
  const since = new Date(now - 60 * 60 * 1000).toISOString();
  const used = await database.countPseudonymLookupsSince(viewer.id, since);
  if (used >= PSEUDONYM_LOOKUPS_PER_HOUR) return { status: "limit", retryAfterMinutes: 60 };

  const candidates = await database.listPseudonymCandidates(viewer);
  const match = candidates.find((candidate) => studentPseudonym(candidate.userId) === code) || null;
  await database.recordPseudonymLookup(viewer.id, code, Boolean(match));
  if (!match) return { status: "not_found" };
  const studentCode = match.studentCode
    || (match.mergedIntoUserId ? await database.getStudentCodeForUser(match.mergedIntoUserId) : null);
  return {
    status: "found",
    student: {
      displayName: match.displayName,
      studentCode,
      mergedIntoDisplayName: match.mergedIntoDisplayName,
      sample: isSampleAccountId(match.userId),
    },
  };
}

// ---------------------------------------------------------------------------
// Exporte (CSV para Excel y Power BI)
// ---------------------------------------------------------------------------

const BOGOTA_DATE = new Intl.DateTimeFormat("en-CA", { timeZone: "America/Bogota", year: "numeric", month: "2-digit", day: "2-digit" });
const BOGOTA_TIME = new Intl.DateTimeFormat("en-GB", { timeZone: "America/Bogota", hour: "2-digit", minute: "2-digit", hour12: false });

/** Fecha y hora de Bogota (AAAA-MM-DD y HH:MM) para agrupar en Excel sin convertir zonas. */
export function bogotaParts(iso: string | null) {
  if (!iso) return { fecha: "", hora: "" };
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return { fecha: "", hora: "" };
  return { fecha: BOGOTA_DATE.format(date), hora: BOGOTA_TIME.format(date) };
}

export const SNAPSHOT_CSV_HEADER = [
  "captured_at", "fecha", "hora", "taller", "actor_anon_id", "teacher_anon_id", "started", "percent", "compiles",
  "done_count", "partial_count", "missing_count", "done", "partial", "missing", "files", "outside", "last_change_at",
];

export const SNAPSHOT_POINTS_CSV_HEADER = ["captured_at", "fecha", "hora", "taller", "actor_anon_id", "teacher_anon_id", "punto", "estado"];

/** Una fila por foto (ancho): lo que pide una tabla dinamica de avance por estudiante y fecha. */
export function snapshotsToCsv(rows: WorkshopSnapshotRow[]) {
  return toCsvText(SNAPSHOT_CSV_HEADER, rows.map((row) => ({
    captured_at: row.capturedAt,
    ...bogotaParts(row.capturedAt),
    taller: row.taller,
    actor_anon_id: row.actorAnonId,
    teacher_anon_id: row.teacherAnonId,
    started: row.started,
    percent: row.percent,
    compiles: row.compiles === null ? "" : row.compiles,
    done_count: row.done.length,
    partial_count: row.partial.length,
    missing_count: row.missing.length,
    done: row.done.join("|"),
    partial: row.partial.join("|"),
    missing: row.missing.join("|"),
    files: row.files,
    outside: row.outside,
    last_change_at: row.lastChangeAt || "",
  })));
}

/** Una fila por foto y punto (largo): para ver que historia de usuario se demora cada quien. */
export function snapshotPointsToCsv(rows: WorkshopSnapshotRow[]) {
  const out: Array<Record<string, unknown>> = [];
  for (const row of rows) {
    const base = {
      captured_at: row.capturedAt,
      ...bogotaParts(row.capturedAt),
      taller: row.taller,
      actor_anon_id: row.actorAnonId,
      teacher_anon_id: row.teacherAnonId,
    };
    for (const [estado, points] of [["hecho", row.done], ["parcial", row.partial], ["falta", row.missing]] as const) {
      for (const punto of points) out.push({ ...base, punto, estado });
    }
  }
  return toCsvText(SNAPSHOT_POINTS_CSV_HEADER, out);
}

export const POINT_DEFINITIONS_CSV_HEADER = ["taller", "punto", "hu", "texto", "peso"];

/** Los puntos del taller (lo que vale cada uno), para unir con el exporte largo. */
export function pointDefinitionsToCsv(report: Pick<ProgressReport, "taller" | "points"> | null) {
  const rows = report ? report.points.map((point) => ({ taller: report.taller, punto: point.id, hu: point.hu, texto: point.texto, peso: point.peso })) : [];
  return toCsvText(POINT_DEFINITIONS_CSV_HEADER, rows);
}

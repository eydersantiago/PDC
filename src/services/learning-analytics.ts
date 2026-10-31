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
import { normalizeGithubLogin } from "./github-repo-ref.js";
import { isSampleAccountId, sampleActorAnonIds } from "./sample-accounts.js";
import { normalizeStudentCode } from "./student-code.js";
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
  /** El mismo login en dos cuentas distintas: no se adivina de quien es (se aparta). */
  ambiguous: number;
};

/**
 * Hora de la foto: la del calculo en la VM (generatedAt), salvo que venga del futuro o de hace mas de
 * un dia respecto a cuando llego; entonces la de llegada. Asi un reloj malo no esconde ni eterniza filas.
 */
export function snapshotTime(generatedAt: string, receivedAt: string) {
  const received = Date.parse(receivedAt);
  const generated = Date.parse(generatedAt);
  if (Number.isNaN(received)) return Number.isNaN(generated) ? new Date().toISOString() : new Date(generated).toISOString();
  if (Number.isNaN(generated) || generated > received + 5 * 60_000 || generated < received - 24 * 60 * 60_000) {
    return new Date(received).toISOString();
  }
  return new Date(generated).toISOString();
}

/** Decide que fotos guardar. Puro: sin base de datos. */
export function planWorkshopSnapshots(
  report: ProgressReport,
  identities: AnalyticsStudentIdentity[],
  lastFingerprints: ReadonlyMap<string, string>,
): SnapshotPlan {
  // Un login -> una cuenta. Si lo tienen dos cuentas distintas (la de la lista y una nueva sin unir,
  // o una de muestra con el login de un estudiante), no se adivina: se aparta como ambiguo.
  const byLogin = new Map<string, AnalyticsStudentIdentity | null>();
  for (const identity of identities) {
    if (!identity.githubLogin) continue;
    const previous = byLogin.get(identity.githubLogin);
    if (previous === undefined) byLogin.set(identity.githubLogin, identity);
    else if (previous && previous.userId !== identity.userId) byLogin.set(identity.githubLogin, null);
  }
  const plan: SnapshotPlan = { snapshots: [], unchanged: 0, unlinked: 0, sample: 0, stale: 0, ambiguous: 0 };
  const capturedAt = snapshotTime(report.generatedAt, report.receivedAt);
  const seen = new Set<string>();
  for (const entry of report.students) {
    const identity = byLogin.get(normalizeGithubLogin(entry.login));
    if (identity === undefined) {
      plan.unlinked += 1;
      continue;
    }
    if (identity === null) {
      plan.ambiguous += 1;
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
  return { saved, unchanged: plan.unchanged, unlinked: plan.unlinked, sample: plan.sample, stale: plan.stale, ambiguous: plan.ambiguous };
}

/**
 * Fuera de las vistas de analisis (deploy/bi/vistas-bi.sql) y del exporte: las cuentas de muestra
 * (motivo «muestra») y las del equipo que el investigador anote en ANALYTICS_EXCLUDE_EMAILS (motivo
 * «plan»: las mismas de cuentasPrueba del plan del piloto, por ejemplo E1 y E2 de la prueba de inicio a fin).
 */
export async function syncAnalyticsExclusions(database: {
  replaceAnalyticsExcludedActors(anonIds: Iterable<string>, reason?: string): Promise<number>;
  findLoginUserId(email: string): Promise<string | null>;
}, excludedEmails: readonly string[] = []) {
  await database.replaceAnalyticsExcludedActors(sampleActorAnonIds(), "muestra");
  const planIds: string[] = [];
  for (const email of excludedEmails) {
    const userId = await database.findLoginUserId(email);
    if (userId) planIds.push(studentPseudonym(userId));
  }
  return database.replaceAnalyticsExcludedActors(planIds, "plan");
}

// ---------------------------------------------------------------------------
// Reidentificacion
// ---------------------------------------------------------------------------

export type PseudonymLookupResult =
  | { status: "forbidden" }
  | { status: "invalid" }
  | { status: "limit"; retryAfterMinutes: number }
  | { status: "not_found"; direction: "codigo" | "estudiante" }
  | {
    status: "found";
    direction: "codigo";
    student: { displayName: string; studentCode: string | null; mergedIntoDisplayName: string | null; sample: boolean };
  }
  | {
    status: "found";
    direction: "estudiante";
    student: { displayName: string; analysisCode: string; mergedCodes: string[] };
  };

export type PseudonymDatabase = {
  listPseudonymCandidates(viewer: AppUser): Promise<PseudonymCandidate[]>;
  getStudentCodeForUser(userId: string): Promise<string | null>;
  startPseudonymLookup(viewerUserId: string, direction: "codigo" | "estudiante", code: string): Promise<string>;
  finishPseudonymLookup(id: string, result: { found: boolean; outcome: "encontrado" | "no-encontrado" | "tope"; code: string }): Promise<void>;
  countPseudonymLookupsSince(viewerUserId: string, sinceIso: string): Promise<number>;
};

/** Solo un docente o un administrador real: las cuentas de muestra (claves compartidas) no reidentifican ni exportan. */
export function canUseAnalytics(viewer: Pick<AppUser, "id" | "role">) {
  return (viewer.role === "admin" || viewer.role === "teacher") && !isSampleAccountId(viewer.id);
}

export function normalizePseudonym(value: unknown) {
  const text = String(value ?? "").trim().toLowerCase();
  return PSEUDONYM_PATTERN.test(text) ? text : "";
}

/**
 * De a uno, en los dos sentidos y dentro del alcance del visor (el docente, sus estudiantes):
 *  - un codigo del analisis (20 hex) -> nombre y codigo estudiantil (para ubicarlo en el SIRA);
 *  - un codigo estudiantil (7 digitos, o con el programa) -> nombre y codigo del analisis.
 * Fuera de su alcance responde not_found (no confirma que exista). Cada consulta se anota antes de
 * contar el tope, asi que el tope vale tambien con pedidos en paralelo.
 */
export async function resolvePseudonym(
  database: PseudonymDatabase,
  viewer: AppUser,
  rawInput: unknown,
  now = Date.now(),
): Promise<PseudonymLookupResult> {
  if (!canUseAnalytics(viewer)) return { status: "forbidden" };
  const code = normalizePseudonym(rawInput);
  const studentCode = code ? null : normalizeStudentCode(rawInput);
  if (!code && !studentCode) return { status: "invalid" };
  const direction = code ? "codigo" as const : "estudiante" as const;

  const lookupId = await database.startPseudonymLookup(viewer.id, direction, code);
  const used = await database.countPseudonymLookupsSince(viewer.id, new Date(now - 60 * 60 * 1000).toISOString());
  if (used > PSEUDONYM_LOOKUPS_PER_HOUR) {
    await database.finishPseudonymLookup(lookupId, { found: false, outcome: "tope", code });
    return { status: "limit", retryAfterMinutes: 60 };
  }

  const candidates = await database.listPseudonymCandidates(viewer);
  if (direction === "codigo") {
    const match = candidates.find((candidate) => studentPseudonym(candidate.userId) === code) || null;
    await database.finishPseudonymLookup(lookupId, { found: Boolean(match), outcome: match ? "encontrado" : "no-encontrado", code });
    if (!match) return { status: "not_found", direction };
    const ownCode = match.studentCode
      || (match.mergedIntoUserId ? await database.getStudentCodeForUser(match.mergedIntoUserId) : null);
    return {
      status: "found",
      direction,
      student: {
        displayName: match.displayName,
        studentCode: ownCode,
        mergedIntoDisplayName: match.mergedIntoDisplayName,
        sample: isSampleAccountId(match.userId),
      },
    };
  }

  // El codigo estudiantil es de la cuenta que prevalece; sus cuentas unidas tienen otro seudonimo
  // (su telemetria vieja), que tambien se devuelve para no perder esa parte del analisis.
  const match = candidates.find((candidate) => candidate.studentCode === studentCode && !candidate.mergedIntoUserId) || null;
  const analysisCode = match ? studentPseudonym(match.userId) : "";
  await database.finishPseudonymLookup(lookupId, { found: Boolean(match), outcome: match ? "encontrado" : "no-encontrado", code: analysisCode });
  if (!match) return { status: "not_found", direction };
  return {
    status: "found",
    direction,
    student: {
      displayName: match.displayName,
      analysisCode,
      mergedCodes: candidates.filter((candidate) => candidate.mergedIntoUserId === match.userId).map((candidate) => studentPseudonym(candidate.userId)),
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

/** Texto libre en una celda: si empieza como formula de Excel (= + - @ tab), va con ' adelante. */
export function spreadsheetSafeText(value: unknown) {
  const text = String(value ?? "");
  return /^[=+\-@\t\r]/.test(text) ? `'${text}` : text;
}

/** Los puntos del taller (lo que vale cada uno), para unir con el exporte largo. */
export function pointDefinitionsToCsv(report: Pick<ProgressReport, "taller" | "points"> | null) {
  const rows = report
    ? report.points.map((point) => ({ taller: report.taller, punto: point.id, hu: spreadsheetSafeText(point.hu), texto: spreadsheetSafeText(point.texto), peso: point.peso }))
    : [];
  return toCsvText(POINT_DEFINITIONS_CSV_HEADER, rows);
}

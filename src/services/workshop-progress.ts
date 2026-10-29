// Avance de los estudiantes en un taller (29-10-2026; el primero: el Sistema bancario, el taller
// de bonificación de FPOO).
//
// La VM de editores revisa cada 10 min la carpeta del taller en el home de cada estudiante
// (deploy/gcp/workspaces/avance-ws.py, con los puntos de deploy/gcp/workspaces/talleres/*.json)
// y avisa aqui con el token del agente (POST /api/workspaces/progress-report): por login de
// GitHub, el porcentaje, que puntos faltan, si compila y cuando cambio por ultima vez. Nunca el
// codigo. Se guarda el ultimo informe de cada taller en app_settings y se cruza con los
// estudiantes por su login de GitHub (github_user_tokens): lo ven el docente (los suyos) y el
// administrador en el monitor y en «Estudiantes». Es una estimacion, no la nota.
import { z } from "zod";
import type { AppSetting } from "../db/rows.js";
import { isSampleAccountId } from "./sample-accounts.js";

export const WORKSHOP_PROGRESS_KEY_PREFIX = "workshop_progress:";
export const WORKSHOP_PROGRESS_INDEX_KEY = "workshop_progress_index";
const CACHE_MS = 30_000;
/** Sin informe nuevo en este tiempo, el avance se muestra como desactualizado (la VM no avisa). */
export const WORKSHOP_PROGRESS_STALE_MS = 45 * 60 * 1000;

const SLUG = /^[a-z0-9][a-z0-9._-]{0,79}$/;
const POINT_ID = /^[a-z0-9][a-z0-9-]{0,59}$/;
// Igual que avance-ws.py: el login de GitHub de /home/ws-<login>.
const LOGIN = /^[a-z0-9][a-z0-9-]{0,38}$/;
const pointIds = z.array(z.string().regex(POINT_ID)).max(100).default([]);

export const progressReportSchema = z.object({
  taller: z.string().regex(SLUG),
  titulo: z.string().max(120).default(""),
  generatedAt: z.string().max(40),
  points: z.array(z.object({
    id: z.string().regex(POINT_ID),
    hu: z.string().max(40).default(""),
    texto: z.string().max(160).default(""),
    peso: z.number().min(0).max(100),
  })).min(1).max(100),
  students: z.array(z.object({
    login: z.string().regex(LOGIN),
    started: z.boolean(),
    percent: z.number().int().min(0).max(100),
    compiles: z.boolean().nullable().default(null),
    done: pointIds,
    partial: pointIds,
    missing: pointIds,
    files: z.number().int().min(0).max(100_000).default(0),
    lastChangeAt: z.string().max(40).nullable().default(null),
  })).max(5000),
});

export type ProgressReportInput = z.infer<typeof progressReportSchema>;
export type ProgressReport = ProgressReportInput & { receivedAt: string };
export type WorkshopPoint = ProgressReport["points"][number];
export type WorkshopStudentEntry = ProgressReport["students"][number];

type SettingsDatabase = {
  getAppSetting(key: string): Promise<AppSetting | null>;
  setAppSetting(key: string, value: string | null, updatedByUserId: string | null): Promise<AppSetting | null>;
};

const cache = new WeakMap<object, Map<string, { at: number; report: ProgressReport | null }>>();
// Entrada de la cache con el taller mas reciente (no choca con un slug: lleva espacios).
const LATEST_KEY = " mas reciente ";

function cacheFor(database: object) {
  let map = cache.get(database);
  if (!map) {
    map = new Map();
    cache.set(database, map);
  }
  return map;
}

function isoOrNull(value: string | null | undefined) {
  if (!value) return null;
  const time = Date.parse(value);
  return Number.isNaN(time) ? null : new Date(time).toISOString();
}

export async function saveProgressReport(database: SettingsDatabase, input: ProgressReportInput, now = Date.now()) {
  const known = new Set(input.points.map((point) => point.id));
  const report: ProgressReport = {
    ...input,
    generatedAt: isoOrNull(input.generatedAt) || new Date(now).toISOString(),
    // Un login aparece una vez (el ultimo gana) y solo con puntos que el informe declara.
    students: [...new Map(input.students.map((student) => [student.login, {
      ...student,
      done: student.done.filter((id) => known.has(id)),
      partial: student.partial.filter((id) => known.has(id)),
      missing: student.missing.filter((id) => known.has(id)),
      lastChangeAt: isoOrNull(student.lastChangeAt),
    }])).values()],
    receivedAt: new Date(now).toISOString(),
  };
  await database.setAppSetting(WORKSHOP_PROGRESS_KEY_PREFIX + report.taller, JSON.stringify(report), null);
  const index = await listWorkshops(database);
  const others = index.filter((item) => item.taller !== report.taller);
  await database.setAppSetting(
    WORKSHOP_PROGRESS_INDEX_KEY,
    JSON.stringify([{ taller: report.taller, titulo: report.titulo, receivedAt: report.receivedAt }, ...others].slice(0, 20)),
    null,
  );
  cacheFor(database).set(report.taller, { at: now, report });
  cacheFor(database).set(LATEST_KEY, { at: now, report: { taller: report.taller } as ProgressReport });
  return report;
}

/** Talleres con informe, el mas reciente primero. Nunca lanza. */
export async function listWorkshops(database: SettingsDatabase): Promise<Array<{ taller: string; titulo: string; receivedAt: string }>> {
  try {
    const setting = await database.getAppSetting(WORKSHOP_PROGRESS_INDEX_KEY);
    const parsed = setting?.value ? JSON.parse(setting.value) : [];
    return Array.isArray(parsed)
      ? parsed.filter((item) => item && typeof item.taller === "string" && SLUG.test(item.taller))
      : [];
  } catch {
    return [];
  }
}

/** El ultimo informe de un taller (o del mas reciente si no se dice cual), o null. Nunca lanza. */
export async function readProgressReport(database: SettingsDatabase, taller = "", now = Date.now()): Promise<ProgressReport | null> {
  if (!database || typeof database.getAppSetting !== "function") return null;
  const map = cacheFor(database);
  let slug = taller.trim().toLowerCase();
  if (!slug) {
    // El taller mas reciente, tambien en cache (/api/health lo pide en cada lectura).
    const latest = map.get(LATEST_KEY);
    if (latest && now - latest.at < CACHE_MS) {
      slug = latest.report?.taller || "";
    } else {
      slug = (await listWorkshops(database))[0]?.taller || "";
      map.set(LATEST_KEY, { at: now, report: slug ? ({ taller: slug } as ProgressReport) : null });
    }
  }
  if (!slug || !SLUG.test(slug)) return null;
  const cached = map.get(slug);
  if (cached && now - cached.at < CACHE_MS) return cached.report;
  let report: ProgressReport | null = null;
  try {
    const setting = await database.getAppSetting(WORKSHOP_PROGRESS_KEY_PREFIX + slug);
    report = setting?.value ? JSON.parse(setting.value) as ProgressReport : null;
  } catch {
    report = cached?.report ?? null;
  }
  map.set(slug, { at: now, report });
  return report;
}

/** Para /api/health: sin logins ni porcentajes, solo cuando llego y de cuantos. */
export function describeWorkshopProgressForHealth(report: ProgressReport | null) {
  if (!report) return { taller: null, last_at: null, students: null, started: null };
  return {
    taller: report.taller,
    last_at: report.receivedAt,
    students: report.students.length,
    started: report.students.filter((student) => student.started).length,
  };
}

export type WorkshopStudentRef = {
  userId: string;
  displayName: string;
  email: string;
  teacherDisplayName: string | null;
  isActive: boolean;
  githubLogin: string | null;
};

export type WorkshopStatus = "sin-editor" | "sin-carpeta" | "en-curso";

export type WorkshopStudentRow = {
  userId: string;
  displayName: string;
  email: string;
  teacherDisplayName: string | null;
  sampleAccount: boolean;
  githubLogin: string | null;
  /** sin-editor: no ha vinculado GitHub (no tiene editor); sin-carpeta: tiene editor pero no la carpeta del taller. */
  status: WorkshopStatus;
  percent: number | null;
  compiles: boolean | null;
  done: number;
  partial: number;
  /** Lo que falta o va a medias, de mas peso a menos (id, HU y texto). */
  pending: Array<{ id: string; hu: string; texto: string; partial: boolean }>;
  lastChangeAt: string | null;
};

export type WorkshopProgressView = {
  taller: string;
  titulo: string;
  generatedAt: string;
  receivedAt: string;
  /** La VM no ha avisado en WORKSHOP_PROGRESS_STALE_MS (apagada o sin el timer). */
  stale: boolean;
  points: Array<WorkshopPoint & { done: number; partial: number }>;
  summary: {
    /** Estudiantes reales (sin cuentas de muestra) en el alcance de quien mira. */
    students: number;
    started: number;
    averagePercent: number | null;
    compiling: number;
    /** Avance promedio por HU entre los que empezaron, en el orden del taller. */
    byHu: Array<{ hu: string; percent: number }>;
  };
  students: WorkshopStudentRow[];
};

function entryFor(report: ProgressReport, login: string | null) {
  if (!login) return null;
  const key = login.trim().toLowerCase();
  return report.students.find((student) => student.login === key) || null;
}

/** Lo que va en cada fila de «Estudiantes» (GET /api/admin/students). */
export function workshopCellFor(report: ProgressReport | null, githubLogin: string | null) {
  if (!report) return null;
  const entry = entryFor(report, githubLogin);
  return {
    taller: report.taller,
    titulo: report.titulo,
    status: (!githubLogin ? "sin-editor" : entry?.started ? "en-curso" : "sin-carpeta") as WorkshopStatus,
    percent: entry?.started ? entry.percent : null,
    compiles: entry?.started ? entry.compiles : null,
    lastChangeAt: entry?.started ? entry.lastChangeAt : null,
  };
}

/**
 * Cruza el informe de la VM con los estudiantes que ve quien mira. Los que empezaron, de menos
 * avance a mas (el docente ve primero a quien necesita ayuda); luego sin carpeta y sin editor;
 * las cuentas de muestra al final y fuera del resumen.
 */
export function buildWorkshopProgressView(
  report: ProgressReport,
  students: WorkshopStudentRef[],
  now = Date.now(),
): WorkshopProgressView {
  const weight = new Map(report.points.map((point) => [point.id, point.peso]));
  const pointById = new Map(report.points.map((point) => [point.id, point]));
  const rows: WorkshopStudentRow[] = students.map((student) => {
    const entry = entryFor(report, student.githubLogin);
    const started = Boolean(entry?.started);
    const pendingIds = started && entry ? [...entry.missing, ...entry.partial] : [];
    const partialSet = new Set(entry?.partial || []);
    return {
      userId: student.userId,
      displayName: student.displayName,
      email: student.email,
      teacherDisplayName: student.teacherDisplayName,
      sampleAccount: isSampleAccountId(student.userId),
      githubLogin: student.githubLogin,
      status: !student.githubLogin ? "sin-editor" : started ? "en-curso" : "sin-carpeta",
      percent: started && entry ? entry.percent : null,
      compiles: started && entry ? entry.compiles : null,
      done: started && entry ? entry.done.length : 0,
      partial: started && entry ? entry.partial.length : 0,
      pending: pendingIds
        .sort((a, b) => (weight.get(b) || 0) - (weight.get(a) || 0))
        .map((id) => ({ id, hu: pointById.get(id)?.hu || "", texto: pointById.get(id)?.texto || id, partial: partialSet.has(id) })),
      lastChangeAt: started && entry ? entry.lastChangeAt : null,
    };
  });
  const rank = (row: WorkshopStudentRow) => (row.sampleAccount ? 10 : 0) + (row.status === "en-curso" ? 0 : row.status === "sin-carpeta" ? 1 : 2);
  rows.sort((a, b) => rank(a) - rank(b)
    || (a.percent ?? 0) - (b.percent ?? 0)
    || a.displayName.localeCompare(b.displayName, "es"));

  const real = rows.filter((row) => !row.sampleAccount);
  const started = real.filter((row) => row.status === "en-curso");
  const startedLogins = new Set(started.map((row) => row.githubLogin?.toLowerCase()));
  const startedEntries = report.students.filter((entry) => entry.started && startedLogins.has(entry.login));
  const points = report.points.map((point) => ({
    ...point,
    done: startedEntries.filter((entry) => entry.done.includes(point.id)).length,
    partial: startedEntries.filter((entry) => entry.partial.includes(point.id)).length,
  }));
  const huOrder: string[] = [];
  const huTotals = new Map<string, { weight: number; achieved: number }>();
  for (const point of points) {
    const hu = point.hu || "Otros";
    if (!huTotals.has(hu)) {
      huOrder.push(hu);
      huTotals.set(hu, { weight: 0, achieved: 0 });
    }
    const totals = huTotals.get(hu)!;
    totals.weight += point.peso;
    if (startedEntries.length) totals.achieved += point.peso * (point.done + point.partial / 2) / startedEntries.length;
  }
  const generated = Date.parse(report.receivedAt || report.generatedAt);
  return {
    taller: report.taller,
    titulo: report.titulo || report.taller,
    generatedAt: report.generatedAt,
    receivedAt: report.receivedAt,
    stale: Number.isNaN(generated) || now - generated > WORKSHOP_PROGRESS_STALE_MS,
    points,
    summary: {
      students: real.length,
      started: started.length,
      averagePercent: started.length
        ? Math.round(started.reduce((sum, row) => sum + (row.percent || 0), 0) / started.length)
        : null,
      compiling: started.filter((row) => row.compiles === true).length,
      byHu: startedEntries.length
        ? huOrder.map((hu) => {
          const totals = huTotals.get(hu)!;
          return { hu, percent: totals.weight ? Math.round(100 * totals.achieved / totals.weight) : 0 };
        })
        : [],
    },
    students: rows,
  };
}

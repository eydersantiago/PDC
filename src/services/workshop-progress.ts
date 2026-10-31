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
import { normalizeGithubLogin, parseGithubRepoRef, sameGithubRepo, type GithubRepoRef } from "./github-repo-ref.js";

export const WORKSHOP_PROGRESS_KEY_PREFIX = "workshop_progress:";
export const WORKSHOP_PROGRESS_INDEX_KEY = "workshop_progress_index";
const CACHE_MS = 30_000;
/** Sin informe nuevo en este tiempo, el avance se muestra como desactualizado (la VM no avisa). */
export const WORKSHOP_PROGRESS_STALE_MS = 45 * 60 * 1000;

const SLUG = /^[a-z0-9][a-z0-9._-]{0,79}$/;
/** Nombre de un taller (el mismo que acepta el informe de la VM). */
export const WORKSHOP_SLUG = SLUG;
const POINT_ID = /^[a-z0-9][a-z0-9-]{0,59}$/;
// Igual que avance-ws.py: el login de GitHub de /home/ws-<login>.
const LOGIN = /^[a-z0-9][a-z0-9-]{0,38}$/;
const pointIds = z.array(z.string().regex(POINT_ID)).max(100).default([]);

export const progressReportSchema = z.object({
  taller: z.string().regex(SLUG),
  titulo: z.string().max(120).default(""),
  /** usuario/repositorio del ejercicio, si la VM lo manda (para elegir el taller desde VS Code). */
  repo: z.string().max(140).optional(),
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
    /** .h/.cpp fuera de src/ e include/ (el Makefile del taller no los compila). */
    outside: z.number().int().min(0).max(100_000).default(0),
    lastChangeAt: z.string().max(40).nullable().default(null),
    /** tiempo: su calculo paso el plazo; pendiente: no alcanzo en esta corrida; error: no se pudo. */
    note: z.enum(["tiempo", "pendiente", "error"]).optional(),
  })).max(5000),
});

export type ProgressReportInput = z.infer<typeof progressReportSchema>;
export type ProgressReport = ProgressReportInput & { receivedAt: string };
export type WorkshopPoint = ProgressReport["points"][number];
export type WorkshopStudentEntry = ProgressReport["students"][number];

/** Lo que hace falta para leer los informes (los guarda app_settings). */
export type ProgressReportReader = {
  getAppSetting(key: string): Promise<AppSetting | null>;
};

type SettingsDatabase = ProgressReportReader & {
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
export async function listWorkshops(database: ProgressReportReader): Promise<Array<{ taller: string; titulo: string; receivedAt: string }>> {
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
export async function readProgressReport(database: ProgressReportReader, taller = "", now = Date.now()): Promise<ProgressReport | null> {
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

/** Un punto que falta o va a medias (lo que se le muestra al docente y al estudiante). */
export type PendingPoint = { id: string; hu: string; texto: string; partial: boolean };

/**
 * Estado de un estudiante en un taller: sin GitHub vinculado no tiene editor (la VM informa por
 * login); con editor, en curso si la VM ve su carpeta del taller.
 */
export function workshopStatusFor(githubLogin: string | null, entry: Pick<WorkshopStudentEntry, "started"> | null): WorkshopStatus {
  if (!githubLogin) return "sin-editor";
  return entry?.started ? "en-curso" : "sin-carpeta";
}

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
  pending: PendingPoint[];
  lastChangeAt: string | null;
  /** Por que el dato puede no estar al dia (tiempo, pendiente o error en la VM). */
  note: string | null;
  /** Archivos de codigo fuera de src/ (make no los compila). */
  outside: number;
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

/** La VM no ha avisado en WORKSHOP_PROGRESS_STALE_MS (apagada o sin el timer): el dato puede estar viejo. */
export function isReportStale(report: Pick<ProgressReport, "receivedAt" | "generatedAt">, now = Date.now()) {
  const received = Date.parse(report.receivedAt || report.generatedAt);
  return Number.isNaN(received) || now - received > WORKSHOP_PROGRESS_STALE_MS;
}

/** La entrada de un login de GitHub en el informe (sin distinguir mayusculas), o null. */
export function entryFor(report: ProgressReport, login: string | null) {
  if (!login) return null;
  const key = normalizeGithubLogin(login);
  return report.students.find((student) => student.login === key) || null;
}

/** Lo que va en cada fila de «Estudiantes» (GET /api/admin/students). */
export function workshopCellFor(report: ProgressReport | null, githubLogin: string | null) {
  if (!report) return null;
  const entry = entryFor(report, githubLogin);
  return {
    taller: report.taller,
    titulo: report.titulo,
    status: workshopStatusFor(githubLogin, entry),
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
  // Solo cuentas activas: una desactivada ya no esta en el curso.
  const rows: WorkshopStudentRow[] = students.filter((student) => student.isActive).map((student) => {
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
      status: workshopStatusFor(student.githubLogin, entry),
      percent: started && entry ? entry.percent : null,
      compiles: started && entry ? entry.compiles : null,
      done: started && entry ? entry.done.length : 0,
      partial: started && entry ? entry.partial.length : 0,
      pending: pendingIds
        .sort((a, b) => (weight.get(b) || 0) - (weight.get(a) || 0))
        .map((id) => ({ id, hu: pointById.get(id)?.hu || "", texto: pointById.get(id)?.texto || id, partial: partialSet.has(id) })),
      lastChangeAt: started && entry ? entry.lastChangeAt : null,
      note: entry?.note || null,
      outside: started && entry ? entry.outside || 0 : 0,
    };
  });
  const rank = (row: WorkshopStudentRow) => (row.sampleAccount ? 10 : 0) + (row.status === "en-curso" ? 0 : row.status === "sin-carpeta" ? 1 : 2);
  rows.sort((a, b) => rank(a) - rank(b)
    || (a.percent ?? 0) - (b.percent ?? 0)
    || a.displayName.localeCompare(b.displayName, "es"));

  const real = rows.filter((row) => !row.sampleAccount);
  const started = real.filter((row) => row.status === "en-curso");
  const startedLogins = new Set(started.map((row) => normalizeGithubLogin(row.githubLogin)));
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
  return {
    taller: report.taller,
    titulo: report.titulo || report.taller,
    generatedAt: report.generatedAt,
    receivedAt: report.receivedAt,
    stale: isReportStale(report, now),
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

// --- Que taller corresponde a un pedido (GET /api/workshop-progress/me) -----------------------

/** El informe elegido y como: por el repositorio pedido, por el tema del piloto o el mas reciente. */
export type WorkshopMatch = { report: ProgressReport; matchedBy: "repo" | "pilot" | "latest" };

/** El informe es del repositorio: por su campo repo o, sin el, por el nombre (= el taller). */
export function workshopMatchesRepo(report: Pick<ProgressReport, "taller" | "repo">, repo: GithubRepoRef | null) {
  if (!repo) return false;
  const declared = parseGithubRepoRef(report.repo);
  if (declared) return sameGithubRepo(declared, repo);
  return repo.name.toLowerCase() === report.taller;
}

/**
 * El taller de un pedido, de los informes (el mas reciente primero). Con repoFullName, solo el de
 * ese repositorio (null si ninguno lo es: nada de caer en otro taller); sin el, el del repositorio
 * del tema del piloto o, si no, el mas reciente. null si no hay informes.
 */
export function pickWorkshopReport(
  reports: ProgressReport[],
  options: { repoFullName?: string; pilotRepoFullName?: string },
): WorkshopMatch | null {
  if (String(options.repoFullName || "").trim()) {
    const wanted = parseGithubRepoRef(options.repoFullName);
    const report = reports.find((item) => workshopMatchesRepo(item, wanted));
    return report ? { report, matchedBy: "repo" } : null;
  }
  const pilotRepo = parseGithubRepoRef(options.pilotRepoFullName);
  const byPilot = pilotRepo ? reports.find((item) => workshopMatchesRepo(item, pilotRepo)) : null;
  if (byPilot) return { report: byPilot, matchedBy: "pilot" };
  return reports[0] ? { report: reports[0], matchedBy: "latest" } : null;
}

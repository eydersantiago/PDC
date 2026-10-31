// El avance propio de un estudiante en el taller, para su VS Code (30-10-2026):
//
//   GET /api/workshop-progress/me[?repoFullName=<usuario/repositorio>]   (repo es un alias)
//   -> { ok: true, status, progress }
//
// status: «sin-editor» (no vinculo GitHub: la VM informa por login), «sin-taller» (no hay informe
// del taller, o ninguno es del repositorio pedido), «sin-carpeta» (hay informe pero la VM no ve su
// carpeta del taller) o «en-curso» (progress trae su avance). progress es null salvo en
// «en-curso». Solo la entrada del login de GitHub de quien pregunta: nunca la de otro.
//
// El taller: con repoFullName, el informe de ese repositorio (su campo repo o, sin el, el nombre
// del repositorio igual al taller); si ninguno lo es, sin-taller (nada de caer en otro taller).
// Sin repoFullName: el del repositorio del tema del piloto del docente o, si no, el mas reciente.
// matchedBy dice cual de los tres fue.
import { parseGithubRepoRef, sameGithubRepo, type GithubRepoRef } from "./github-repo-ref.js";
import {
  entryFor,
  isReportStale,
  listWorkshops,
  readProgressReport,
  type ProgressReport,
  type ProgressReportReader,
} from "./workshop-progress.js";

/** Lo que falta (o va a medias) que se le muestra al estudiante, en el orden del taller. */
export const MY_PROGRESS_PENDING_MAX = 8;

export type MyWorkshopStatus = "sin-editor" | "sin-taller" | "sin-carpeta" | "en-curso";

export type MyWorkshopProgress = {
  taller: string;
  titulo: string;
  /** Porcentaje ponderado por el peso de cada punto (lo calcula la VM). */
  percent: number;
  compiles: boolean | null;
  /** Puntos hechos, a medias y del taller: cuentas simples, sin pesos. */
  done: number;
  partial: number;
  total: number;
  /** Lo que falta o va a medias, en el orden del taller, a lo sumo MY_PROGRESS_PENDING_MAX. */
  pending: Array<{ id: string; hu: string; texto: string; partial: boolean }>;
  /** Cuantos faltan o van a medias en total (antes del tope de pending). */
  pendingCount: number;
  stale: boolean;
  receivedAt: string;
  lastChangeAt: string | null;
  matchedBy: "repo" | "pilot" | "latest";
};

export type MyWorkshopProgressReply = { status: MyWorkshopStatus; progress: MyWorkshopProgress | null };

/** Lo que el calculo necesita de la base (AppDatabase lo cumple). */
export type MyWorkshopProgressPort = ProgressReportReader & {
  getGithubLoginForUser(userId: string): Promise<string | null>;
  getPilotTopic(teacherUserId: string): Promise<{ repoFullName: string } | null>;
};

/** Quien pregunta: el usuario de la sesion. */
export type MyWorkshopProgressUser = { id: string; role: string; teacherUserId?: string | null };

/** El informe es del repositorio: por su campo repo o, sin el, por el nombre (= el taller). */
export function workshopMatchesRepo(report: Pick<ProgressReport, "taller" | "repo">, repo: GithubRepoRef | null) {
  if (!repo) return false;
  const declared = parseGithubRepoRef(report.repo);
  if (declared) return sameGithubRepo(declared, repo);
  return repo.name.toLowerCase() === report.taller;
}

/**
 * El taller de un pedido, de los informes (el mas reciente primero), y como se eligio. null si
 * no hay informes o si se pidio un repositorio y ninguno es de el.
 */
export function pickWorkshopReport(
  reports: ProgressReport[],
  options: { repoFullName?: string; pilotRepoFullName?: string },
): { report: ProgressReport; matchedBy: MyWorkshopProgress["matchedBy"] } | null {
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

/** El avance de un login en un informe; null si no aparece o la VM no ve su carpeta del taller. */
export function buildMyWorkshopProgress(
  report: ProgressReport,
  githubLogin: string | null,
  matchedBy: MyWorkshopProgress["matchedBy"],
  now = Date.now(),
): MyWorkshopProgress | null {
  const entry = entryFor(report, githubLogin);
  if (!entry || !entry.started) return null;
  const partial = new Set(entry.partial);
  const pendingIds = new Set([...entry.missing, ...entry.partial]);
  const pending = report.points
    .filter((point) => pendingIds.has(point.id))
    .map((point) => ({ id: point.id, hu: point.hu, texto: point.texto, partial: partial.has(point.id) }));
  return {
    taller: report.taller,
    titulo: report.titulo || report.taller,
    percent: entry.percent,
    compiles: entry.compiles,
    done: entry.done.length,
    partial: entry.partial.length,
    total: report.points.length,
    pending: pending.slice(0, MY_PROGRESS_PENDING_MAX),
    pendingCount: pending.length,
    stale: isReportStale(report, now),
    receivedAt: report.receivedAt,
    lastChangeAt: entry.lastChangeAt,
    matchedBy,
  };
}

/** El repositorio del tema del piloto que ve quien pregunta: el de su docente, o el suyo si es docente. */
async function pilotRepoFor(port: MyWorkshopProgressPort, user: MyWorkshopProgressUser) {
  const teacherUserId = user.role === "student" ? String(user.teacherUserId || "").trim()
    : user.role === "teacher" ? user.id
      : "";
  if (!teacherUserId) return "";
  const topic = await port.getPilotTopic(teacherUserId).catch(() => null);
  return topic?.repoFullName || "";
}

/** GET /api/workshop-progress/me: el avance de quien pregunta (ver arriba). Nunca el de otro. */
export async function resolveMyWorkshopProgress(
  port: MyWorkshopProgressPort,
  user: MyWorkshopProgressUser,
  repoFullName = "",
  now = Date.now(),
): Promise<MyWorkshopProgressReply> {
  const login = await port.getGithubLoginForUser(user.id);
  if (!login) return { status: "sin-editor", progress: null };
  const workshops = await listWorkshops(port);
  const reports = (await Promise.all(workshops.map((item) => readProgressReport(port, item.taller, now))))
    .filter((report): report is ProgressReport => Boolean(report));
  const picked = pickWorkshopReport(reports, {
    repoFullName,
    pilotRepoFullName: repoFullName ? "" : await pilotRepoFor(port, user),
  });
  if (!picked) return { status: "sin-taller", progress: null };
  const progress = buildMyWorkshopProgress(picked.report, login, picked.matchedBy, now);
  return progress ? { status: "en-curso", progress } : { status: "sin-carpeta", progress: null };
}

// El avance propio de un estudiante en el taller, para su VS Code (30-10-2026):
//
//   GET /api/workshop-progress/me[?repoFullName=<usuario/repositorio>]
//   -> { ok: true, status, progress }
//
// status: «sin-editor» (no vinculo GitHub: la VM informa por login), «sin-taller» (no hay informe
// del taller, o ninguno es del repositorio pedido), «sin-carpeta» (hay informe pero la VM no ve su
// carpeta del taller) o «en-curso» (progress trae su avance). progress es null salvo en
// «en-curso». Solo la entrada del login de GitHub de quien pregunta: nunca la de otro.
//
// El taller lo elige pickWorkshopReport (workshop-progress.ts): con repoFullName, el informe de ese
// repositorio y ningun otro; sin el, el del tema del piloto o el mas reciente. matchedBy dice cual.
import {
  entryFor,
  isReportStale,
  listWorkshops,
  pickWorkshopReport,
  readProgressReport,
  workshopStatusFor,
  type PendingPoint,
  type ProgressReport,
  type ProgressReportReader,
  type WorkshopMatch,
  type WorkshopStatus,
} from "./workshop-progress.js";

/** Lo que falta (o va a medias) que se le muestra al estudiante, en el orden del taller. */
export const MY_PROGRESS_PENDING_MAX = 8;

export type MyWorkshopStatus = WorkshopStatus | "sin-taller";

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
  pending: PendingPoint[];
  /** Cuantos faltan o van a medias en total (antes del tope de pending). */
  pendingCount: number;
  stale: boolean;
  receivedAt: string;
  lastChangeAt: string | null;
  matchedBy: WorkshopMatch["matchedBy"];
};

export type MyWorkshopProgressReply = { status: MyWorkshopStatus; progress: MyWorkshopProgress | null };

/** Lo que el calculo necesita de la base (AppDatabase lo cumple). */
export type MyWorkshopProgressPort = ProgressReportReader & {
  getGithubLoginForUser(userId: string): Promise<string | null>;
  getPilotTopicForUser(user: MyWorkshopProgressUser): Promise<{ repoFullName: string } | null>;
};

/** Quien pregunta: el usuario de la sesion. */
export type MyWorkshopProgressUser = { id: string; role: string; teacherUserId?: string | null };

/** El avance de una entrada que la VM ve en curso. */
export function buildMyWorkshopProgress(match: WorkshopMatch, githubLogin: string, now = Date.now()): MyWorkshopProgress | null {
  const { report } = match;
  const entry = entryFor(report, githubLogin);
  if (!entry || workshopStatusFor(githubLogin, entry) !== "en-curso") return null;
  const partial = new Set(entry.partial);
  const pendingIds = new Set([...entry.missing, ...entry.partial]);
  const pending: PendingPoint[] = report.points
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
    matchedBy: match.matchedBy,
  };
}

/** GET /api/workshop-progress/me: el avance de quien pregunta (ver arriba). Nunca el de otro. */
export async function resolveMyWorkshopProgress(
  port: MyWorkshopProgressPort,
  user: MyWorkshopProgressUser,
  repoFullName = "",
  now = Date.now(),
): Promise<MyWorkshopProgressReply> {
  const login = await port.getGithubLoginForUser(user.id);
  if (!login) return { status: workshopStatusFor(login, null), progress: null };
  const workshops = await listWorkshops(port);
  const reports = (await Promise.all(workshops.map((item) => readProgressReport(port, item.taller, now))))
    .filter((report): report is ProgressReport => Boolean(report));
  const pilotTopic = repoFullName ? null : await port.getPilotTopicForUser(user).catch(() => null);
  const match = pickWorkshopReport(reports, { repoFullName, pilotRepoFullName: pilotTopic?.repoFullName || "" });
  if (!match) return { status: "sin-taller", progress: null };
  const progress = buildMyWorkshopProgress(match, login, now);
  return progress ? { status: "en-curso", progress } : { status: workshopStatusFor(login, null), progress: null };
}

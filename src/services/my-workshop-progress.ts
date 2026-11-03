// El avance propio de un estudiante en el taller, para su VS Code (30-10-2026):
//
//   GET /api/workshop-progress/me[?repoFullName=<usuario/repositorio>][&avisos=aparte]
//   -> { ok: true, status, progress }
//
// status: «sin-editor» (no vinculo GitHub: la VM informa por login), «sin-taller» (no hay informe
// del taller, o ninguno es del repositorio pedido), «sin-carpeta» (hay informe pero la VM no ve su
// carpeta del taller) o «en-curso» (progress trae su avance). progress es null salvo en
// «en-curso». Solo la entrada del login de GitHub de quien pregunta: nunca la de otro.
//
// El taller lo elige pickWorkshopReport (workshop-progress.ts): con repoFullName, el informe de ese
// repositorio y ningun otro; sin el, el del tema del piloto o el mas reciente. matchedBy dice cual.
//
// Avisos del revisor (02-11-2026): van en progress.codeNotices (con el texto para el estudiante).
// VS Code 0.0.38 no conoce ese campo, asi que por defecto los avisos van TAMBIEN al comienzo de
// pending como «aviso-<id>» (legacyPendingWithNotices): la 0.0.38 los muestra bajo «Te falta:».
// Un cliente nuevo pide ?avisos=aparte y recibe pending y pendingCount solo con puntos del taller.
import { studentNoticeText, type CodeNoticeView } from "./code-notices.js";
import {
  codeNoticeViewsFor,
  entryFor,
  isReportStale,
  listWorkshops,
  NOTICE_POINT_PREFIX,
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
/** El lector de VS Code 0.0.38 recorta el id de cada elemento de pending a 40. */
const PENDING_ID_MAX = 40;

export type MyWorkshopStatus = WorkshopStatus | "sin-taller";

/**
 * Como van los avisos: «dentro-de-pending» (por defecto, para VS Code <= 0.0.38: tambien al
 * comienzo de pending) o «aparte» (?avisos=aparte: solo en codeNotices). El primero se quita
 * cuando ningun estudiante del piloto tenga una version anterior a la que pide aparte.
 */
export type NoticeDelivery = "dentro-de-pending" | "aparte";

/** El modo de la consulta (?avisos=): solo «aparte» cambia algo. */
export function noticeDeliveryFrom(value: unknown): NoticeDelivery {
  return value === "aparte" ? "aparte" : "dentro-de-pending";
}

/** Como se arma la respuesta: el repositorio pedido, el modo de los avisos y el reloj. */
export type MyWorkshopProgressOptions = { repoFullName?: string; delivery?: NoticeDelivery; now?: number };

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
  /**
   * Lo que falta o va a medias, en el orden del taller, a lo sumo MY_PROGRESS_PENDING_MAX. En el
   * modo «dentro-de-pending» empieza con los avisos («aviso-<id>», hu «Aviso»), dentro del mismo tope.
   */
  pending: PendingPoint[];
  /** Cuantos hay en total antes del tope: puntos (aparte) o avisos y puntos (dentro-de-pending). */
  pendingCount: number;
  /** Avisos del revisor con el texto para el estudiante (Class con mayuscula...). */
  codeNotices: CodeNoticeView[];
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

/**
 * Solo para VS Code <= 0.0.38, que no lee codeNotices: los avisos como los primeros elementos de
 * pending («aviso-<id>», hu «Aviso», partial false), dentro del tope de 8 y contados en
 * pendingCount. Ningun punto de un taller empieza por «aviso-» (lo rechaza el esquema).
 */
export function legacyPendingWithNotices(points: readonly PendingPoint[], notices: readonly CodeNoticeView[]): PendingPoint[] {
  return [
    ...notices.map((notice) => ({ id: `${NOTICE_POINT_PREFIX}${notice.id}`.slice(0, PENDING_ID_MAX), hu: "Aviso", texto: notice.texto, partial: false })),
    ...points,
  ];
}

/** El avance de una entrada que la VM ve en curso. */
export function buildMyWorkshopProgress(
  match: WorkshopMatch,
  githubLogin: string,
  { delivery = "dentro-de-pending", now = Date.now() }: Omit<MyWorkshopProgressOptions, "repoFullName"> = {},
): MyWorkshopProgress | null {
  const { report } = match;
  const entry = entryFor(report, githubLogin);
  if (!entry || workshopStatusFor(githubLogin, entry) !== "en-curso") return null;
  const partial = new Set(entry.partial);
  const pendingIds = new Set([...entry.missing, ...entry.partial]);
  const points: PendingPoint[] = report.points
    .filter((point) => pendingIds.has(point.id))
    .map((point) => ({ id: point.id, hu: point.hu, texto: point.texto, partial: partial.has(point.id) }));
  const codeNotices = codeNoticeViewsFor(entry, studentNoticeText);
  const pending = delivery === "aparte" ? points : legacyPendingWithNotices(points, codeNotices);
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
    codeNotices,
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
  { repoFullName = "", delivery = "dentro-de-pending", now = Date.now() }: MyWorkshopProgressOptions = {},
): Promise<MyWorkshopProgressReply> {
  const login = await port.getGithubLoginForUser(user.id);
  if (!login) return { status: workshopStatusFor(login, null), progress: null };
  const workshops = await listWorkshops(port);
  const reports = (await Promise.all(workshops.map((item) => readProgressReport(port, item.taller, now))))
    .filter((report): report is ProgressReport => Boolean(report));
  const pilotTopic = repoFullName ? null : await port.getPilotTopicForUser(user).catch(() => null);
  const match = pickWorkshopReport(reports, { repoFullName, pilotRepoFullName: pilotTopic?.repoFullName || "" });
  if (!match) return { status: "sin-taller", progress: null };
  const progress = buildMyWorkshopProgress(match, login, { delivery, now });
  return progress ? { status: "en-curso", progress } : { status: workshopStatusFor(login, null), progress: null };
}

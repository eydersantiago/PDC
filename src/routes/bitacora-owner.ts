// Dueño de la bitácora (0.7.22): la bitácora es de cada docente (sus estudiantes ven la de su
// docente). El docente gestiona la suya; el administrador gestiona la de un docente que elige con
// teacherUserId (en la consulta, en el cuerpo o en el formulario multipart), como en el tema del
// piloto. Sin teacherUserId (o con uno que ya no está activo), consultar el estado o la plantilla
// usa el docente de las cuentas nuevas; los cambios (subir, registro manual, fechas, exportar y
// borrar) piden el docente explícito. El RAG del docente (src/routes/rag-routes.ts) usa la misma
// regla con resolveManagedTeacher.
import type { AppDatabase } from "../db/database.js";
import { trimText } from "../services/text-utils.js";
import type { AppSession } from "./route-utils.js";

export type BitacoraOwner = { id: string; displayName: string; email: string };
export type BitacoraTeacherOption = { id: string; email: string; displayName: string };

export type BitacoraOwnerResult =
  | { ok: true; owner: BitacoraOwner; teachers?: BitacoraTeacherOption[] }
  | { ok: false; status: number; error: string; teachers?: BitacoraTeacherOption[] };

export async function resolveBitacoraOwner(
  database: AppDatabase,
  session: AppSession,
  requestedTeacherUserId: unknown,
  options: { deniedMessage: string; fallbackToDefault?: boolean },
): Promise<BitacoraOwnerResult> {
  return resolveManagedTeacher(database, session, requestedTeacherUserId, {
    ...options,
    noTeachersError: "No hay docentes activos: crea uno en «Usuarios» antes de cargar una bitácora.",
    missingError: "Elige el docente dueño de la bitácora (teacherUserId).",
  });
}

/**
 * Docente cuyos datos se gestionan: el docente, los suyos (aunque mande otro teacherUserId); el
 * administrador, los del docente activo que elige; cualquier otro rol, 403 con deniedMessage.
 * fallbackToDefault (consultar): sin docente elegido usa el de las cuentas nuevas o el primero.
 */
export async function resolveManagedTeacher(
  database: AppDatabase,
  session: AppSession,
  requestedTeacherUserId: unknown,
  options: { deniedMessage: string; fallbackToDefault?: boolean; noTeachersError: string; missingError: string },
): Promise<BitacoraOwnerResult> {
  const user = session.user;
  if (user.role === "teacher") {
    return { ok: true, owner: { id: user.id, displayName: user.displayName, email: user.email } };
  }
  if (user.role !== "admin") {
    return { ok: false, status: 403, error: options.deniedMessage };
  }
  const teachers = await database.listActivePilotTeachers();
  if (!teachers.length) {
    return { ok: false, status: 404, error: options.noTeachersError, teachers };
  }
  const requested = trimText(typeof requestedTeacherUserId === "string" ? requestedTeacherUserId : "");
  let chosen = requested ? teachers.find((teacher) => teacher.id === requested) : undefined;
  // Consultar (fallbackToDefault) cae al docente por defecto; cambiar algo no adivina el docente.
  if (requested && !chosen && !options.fallbackToDefault) {
    return { ok: false, status: 404, error: "Ese docente no existe o está inactivo.", teachers };
  }
  if (!chosen && options.fallbackToDefault) {
    const fallbackId = (await database.getDefaultTeacherChoice()).teacherUserId || "";
    chosen = teachers.find((teacher) => teacher.id === fallbackId) || teachers[0];
  }
  if (!chosen) {
    return { ok: false, status: 400, error: options.missingError, teachers };
  }
  return { ok: true, owner: { id: chosen.id, displayName: chosen.displayName, email: chosen.email }, teachers };
}

/** teacherUserId de la consulta (?teacherUserId=) o del cuerpo JSON/multipart, el que venga. */
export function readRequestedTeacherUserId(req: { query?: unknown; body?: unknown }): string {
  const query = (req.query && typeof req.query === "object" ? req.query : {}) as Record<string, unknown>;
  const body = (req.body && typeof req.body === "object" ? req.body : {}) as Record<string, unknown>;
  const value = typeof query.teacherUserId === "string" && query.teacherUserId
    ? query.teacherUserId
    : (typeof body.teacherUserId === "string" ? body.teacherUserId : "");
  return trimText(value).slice(0, 120);
}

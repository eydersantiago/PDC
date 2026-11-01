// Docente cuyo RAG se gestiona (requireRagManager) y cursos RAG que ve cada usuario.
import type express from "express";
import type { AppDatabase } from "../../db/database.js";
import { DEFAULT_RAG_COURSE_CODE, RAG_COURSES, getRagCourse, normalizeRagCourseCode, normalizeRagCourseCodes } from "../../services/rag/rag-courses.js";
import { readRequestedTeacherUserId, resolveManagedTeacher } from "../bitacora/bitacora-owner.js";
import { resolveSession } from "../route-utils.js";

export function getCoursesForUser(user: { role: string; assignedCourseCodes?: string[] }) {
  if (user.role !== "student") {
    return RAG_COURSES;
  }

  const assignedCodes = normalizeRagCourseCodes(user.assignedCourseCodes, {
    fallbackToDefault: true,
    knownOnly: true,
  });
  const assignedSet = new Set(assignedCodes);
  return RAG_COURSES.filter((course) => assignedSet.has(course.code));
}

export function resolveCourseCodeForUser(
  user: { role: string; assignedCourseCodes?: string[] },
  requestedCourseCode: string | null | undefined,
) {
  const requested = normalizeRagCourseCode(requestedCourseCode || DEFAULT_RAG_COURSE_CODE);
  if (user.role !== "student") {
    return getRagCourse(requested)?.code || DEFAULT_RAG_COURSE_CODE;
  }

  const allowed = getCoursesForUser(user);
  if (allowed.some((course) => course.code === requested)) {
    return requested;
  }
  return allowed[0]?.code || DEFAULT_RAG_COURSE_CODE;
}

export function createRagManagerResolver(database: AppDatabase) {
  // Docente cuyo RAG se gestiona (navegador 0.7.22): el docente, el suyo; el administrador, el del
  // docente que elige con teacherUserId (consulta, cuerpo JSON o formulario), como la bitacora
  // (src/routes/bitacora/bitacora-owner.ts). Consultar sin el usa el docente de las cuentas nuevas; cargar,
  // retirar o cambiar algo lo pide. Las fuentes que carga el administrador quedan en el RAG de ese
  // docente (scope teacher) con created_by_user_id del administrador.
  async function requireRagManager(
    req: express.Request,
    res: express.Response,
    action: string,
    options: { fallbackToDefault?: boolean } = {},
  ) {
    const session = await resolveSession(database, req);
    if (!session) {
      res.status(401).json({ ok: false, error: "Sesion no valida." });
      return null;
    }
    const resolved = await resolveManagedTeacher(database, session, readRequestedTeacherUserId(req), {
      deniedMessage: `Solo docentes pueden ${action}.`,
      fallbackToDefault: options.fallbackToDefault,
      noTeachersError: "No hay docentes activos: crea uno en «Usuarios» antes de gestionar su RAG.",
      missingError: "Elige el docente dueño del RAG (teacherUserId).",
    });
    if (!resolved.ok) {
      res.status(resolved.status).json({ ok: false, error: resolved.error, ...(resolved.teachers ? { teachers: resolved.teachers } : {}) });
      return null;
    }
    return {
      session,
      teacherUserId: resolved.owner.id,
      // Solo el administrador recibe la lista para elegir docente.
      teachers: session.user.role === "admin" ? resolved.teachers || [] : null,
    };
  }

  return requireRagManager;
}

export type RagManagerResolver = ReturnType<typeof createRagManagerResolver>;

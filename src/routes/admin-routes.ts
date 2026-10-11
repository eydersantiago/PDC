import type express from "express";
import { z } from "zod";
import type { AppDatabase } from "../db/database.js";
import { normalizeRagCourseCodes } from "../services/rag-courses.js";
import { trimText } from "../services/text-utils.js";
import { errorMessage, resolveSession } from "./route-utils.js";

const adminManagedUserRoleSchema = z.enum(["student", "teacher"]);
const assignedCourseCodesSchema = z.array(z.string().max(120)).max(10).optional();

const adminCreateUserSchema = z.object({
  role: adminManagedUserRoleSchema,
  email: z.string().email(),
  displayName: z.string().min(2).max(120),
  password: z.string().min(6).max(120),
  teacherUserId: z.string().max(120).nullable().optional(),
  assignedCourseCodes: assignedCourseCodesSchema,
}).strict();

const adminUpdateUserSchema = z.object({
  role: adminManagedUserRoleSchema.optional(),
  email: z.string().email().optional(),
  displayName: z.string().min(2).max(120).optional(),
  password: z.string().min(6).max(120).optional(),
  teacherUserId: z.string().max(120).nullable().optional(),
  isActive: z.boolean().optional(),
  assignedCourseCodes: assignedCourseCodesSchema,
}).strict();

// «Importar lista» (navegador 0.7.21): estudiantes de un curso de Campus por correo. El
// docente importa a su grupo; el administrador elige el docente (o va el de las cuentas nuevas).
const importCourseMembersSchema = z.object({
  teacherUserId: z.string().max(120).nullable().optional(),
  courseCode: z.string().max(40),
  students: z.array(z.object({
    email: z.string().trim().email(),
    displayName: z.string().max(200).optional(),
  }).strict()).min(1).max(300),
}).strict();

// Docente de las cuentas nuevas (navegador 0.7.21); null vuelve al profesor activo mas antiguo.
const defaultTeacherSchema = z.object({
  teacherUserId: z.string().trim().max(120).nullable(),
}).strict();

function canManageUsers(role: string | undefined) {
  return role === "admin" || role === "teacher";
}

export function registerAdminRoutes(app: express.Express, database: AppDatabase) {
  app.get("/api/admin/users", async (req, res) => {
    try {
      const session = await resolveSession(database, req);
      if (!session || !canManageUsers(session.user.role)) {
        return res.status(403).json({ ok: false, error: "Solo administradores o docentes pueden gestionar usuarios." });
      }

      const managed = await database.listManagedUsers(session.user);
      return res.json({
        ok: true,
        users: managed.users,
        teachers: managed.teachers,
        // Solo el administrador elige el docente de las cuentas nuevas.
        ...(session.user.role === "admin" ? { defaultTeacher: await database.getDefaultTeacherChoice() } : {}),
      });
    } catch (error) {
      return res.status(500).json({ ok: false, error: String(error) });
    }
  });

  app.post("/api/admin/users", async (req, res) => {
    try {
      const session = await resolveSession(database, req);
      if (!session || !canManageUsers(session.user.role)) {
        return res.status(403).json({ ok: false, error: "Solo administradores o docentes pueden crear usuarios." });
      }

      const parsed = adminCreateUserSchema.parse(req.body || {});
      const createdUser = await database.createManagedUser({
        ...parsed,
        role: session.user.role === "teacher" ? "student" : parsed.role,
        teacherUserId: session.user.role === "teacher" ? session.user.id : parsed.teacherUserId,
        assignedCourseCodes: normalizeRagCourseCodes(parsed.assignedCourseCodes, {
          fallbackToDefault: true,
          knownOnly: true,
        }),
        assignedByUserId: session.user.id,
      });
      return res.json({ ok: true, user: createdUser });
    } catch (error) {
      return res.status(400).json({ ok: false, error: errorMessage(error) });
    }
  });

  /**
   * «Importar lista» (navegador 0.7.21): crea o actualiza, por correo, a los estudiantes de un
   * curso (ver importCourseMembers). Responde cuantos se crearon, cuales cambiaron de docente o
   * sumaron el curso, cuales ya estaban y cuales no se tocaron y por que.
   */
  app.post("/api/admin/users/import", async (req, res) => {
    try {
      const session = await resolveSession(database, req);
      if (!session || !canManageUsers(session.user.role)) {
        return res.status(403).json({ ok: false, error: "Solo administradores o docentes pueden importar usuarios." });
      }
      const parsed = importCourseMembersSchema.safeParse(req.body || {});
      if (!parsed.success) {
        return res.status(400).json({ ok: false, error: "La lista debe traer entre 1 y 300 estudiantes con un correo valido." });
      }
      const courseCode = normalizeRagCourseCodes([parsed.data.courseCode], { knownOnly: true, fallbackToDefault: false })[0];
      if (!courseCode) {
        return res.status(400).json({ ok: false, error: "Curso desconocido." });
      }
      const result = await database.importCourseMembers({
        teacherUserId: session.user.role === "teacher" ? session.user.id : parsed.data.teacherUserId,
        courseCode,
        students: parsed.data.students,
        assignedByUserId: session.user.id,
        viewer: session.user,
      });
      return res.json({ ok: true, ...result });
    } catch (error) {
      return res.status(400).json({ ok: false, error: errorMessage(error) });
    }
  });

  /**
   * Docente de las cuentas nuevas (navegador 0.7.21): quien entra por primera vez con Google, o
   * se crea sin docente, queda con el; tambien es el de quien no tiene docente (por ejemplo, la
   * politica y el RAG del administrador). Solo el administrador.
   */
  app.put("/api/admin/default-teacher", async (req, res) => {
    try {
      const session = await resolveSession(database, req);
      if (!session || session.user.role !== "admin") {
        return res.status(403).json({ ok: false, error: "Solo el administrador elige el docente de las cuentas nuevas." });
      }
      const parsed = defaultTeacherSchema.safeParse(req.body || {});
      if (!parsed.success) {
        return res.status(400).json({ ok: false, error: "Indica teacherUserId (o null para el profesor mas antiguo)." });
      }
      const defaultTeacher = await database.setDefaultTeacher(parsed.data.teacherUserId || null, session.user.id);
      return res.json({ ok: true, defaultTeacher });
    } catch (error) {
      return res.status(400).json({ ok: false, error: errorMessage(error) });
    }
  });

  app.put("/api/admin/users/:userId", async (req, res) => {
    try {
      const session = await resolveSession(database, req);
      if (!session || !canManageUsers(session.user.role)) {
        return res.status(403).json({ ok: false, error: "Solo administradores o docentes pueden editar usuarios." });
      }

      const userId = trimText(req.params.userId);
      if (!userId) {
        return res.status(400).json({ ok: false, error: "userId requerido." });
      }

      const parsed = adminUpdateUserSchema.parse(req.body || {});
      const updatedUser = await database.updateManagedUser(userId, {
        ...parsed,
        role: session.user.role === "teacher" ? "student" : parsed.role,
        teacherUserId: session.user.role === "teacher" ? session.user.id : parsed.teacherUserId,
        assignedCourseCodes: parsed.assignedCourseCodes === undefined
          ? undefined
          : normalizeRagCourseCodes(parsed.assignedCourseCodes, {
            fallbackToDefault: true,
            knownOnly: true,
          }),
        assignedByUserId: session.user.id,
      }, { viewer: session.user });
      return res.json({ ok: true, user: updatedUser });
    } catch (error) {
      return res.status(400).json({ ok: false, error: errorMessage(error) });
    }
  });

  app.delete("/api/admin/users/:userId", async (req, res) => {
    try {
      const session = await resolveSession(database, req);
      if (!session || !canManageUsers(session.user.role)) {
        return res.status(403).json({ ok: false, error: "Solo administradores o docentes pueden eliminar usuarios." });
      }

      const userId = trimText(req.params.userId);
      if (!userId) {
        return res.status(400).json({ ok: false, error: "userId requerido." });
      }

      const deactivatedUser = await database.deactivateManagedUser(userId, { viewer: session.user });
      return res.json({ ok: true, user: deactivatedUser });
    } catch (error) {
      return res.status(400).json({ ok: false, error: String(error) });
    }
  });
}

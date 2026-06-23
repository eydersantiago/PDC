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

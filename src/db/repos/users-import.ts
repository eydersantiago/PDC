// AppDatabase: importar la lista de un curso y eliminar varios estudiantes a la vez.
// Metodos movidos sin cambios desde src/db/repos/users.ts; la clase va entre ManagedUsersDatabase y PolicyDatabase.
import { randomBytes } from "node:crypto";
import type { AppUser } from "../../types/app.js";
import { trimText } from "../../services/shared/text-utils.js";
import { normalizeRagCourseCode } from "../../services/rag/rag-courses.js";
import { normalizeStudentCode, STUDENT_CODE_FORMAT_MESSAGE } from "../../services/auth/student-code.js";
import { ManagedUsersDatabase } from "./users-admin.js";

/** POST /api/admin/users/import: como quedo cada correo de la lista. */
/**
 * Eliminar varios estudiantes (0.7.22, «Usuarios»): quien nunca entro se borra del todo (asi se
 * puede volver a importar con el nombre correcto); quien ya entro se desactiva y conserva sus
 * datos del piloto; el resto se informa sin tocarlo.
 */
export type ManagedStudentRemovalEntry = { id: string; email: string; displayName: string; reason?: string };

export type ManagedStudentRemovalResult = {
  deleted: ManagedStudentRemovalEntry[];
  deactivated: ManagedStudentRemovalEntry[];
  skipped: ManagedStudentRemovalEntry[];
};

// Filas que puede tener un estudiante que nunca entro (importado o creado a mano): se borran
// antes de su fila de users, en la misma transaccion.
const NEVER_SIGNED_IN_STUDENT_CLEANUP = [
  "delete from student_access_requests where target_user_id = $1 or source_user_id = $1",
  "delete from user_login_emails where user_id = $1",
  "delete from student_codes where user_id = $1",
  "delete from rag_student_lots where student_user_id = $1",
  "delete from pilot_assignments where student_user_id = $1",
  "delete from student_quizzes where user_id = $1",
  "delete from user_privacy_acceptances where user_id = $1",
  "delete from user_course_assignments where user_id = $1",
  "update users set merged_into_user_id = null where merged_into_user_id = $1",
];

export type CourseMemberImportResult = {
  teacherUserId: string;
  courseCode: string;
  created: Array<{ id: string; email: string; displayName: string }>;
  /** changes: "docente" y/o "curso". */
  updated: Array<{ id: string; email: string; displayName: string; changes: string[] }>;
  unchanged: Array<{ id: string; email: string; displayName: string }>;
  skipped: Array<{ email: string; displayName: string; reason: string }>;
  /** 0.7.22: codigos de la lista que quedaron en su cuenta y los que no (ya eran de otra). */
  codes: { assigned: number; conflicts: Array<{ email: string; studentCode: string; reason: string }> };
};

export class CourseMembersDatabase extends ManagedUsersDatabase {
  /**
   * «Importar lista» de «Usuarios» (navegador 0.7.21): los estudiantes de un curso de Campus
   * quedan como miembros de un docente y un curso, buscados por correo. Los que no existen se
   * crean como estudiantes con una clave al azar (entran con Google; quien deba entrar con
   * correo y clave la recibe en «Editar»). Los estudiantes que ya existen pasan a ese docente y
   * suman el curso sin perder los que tenian; nombre y clave no cambian. Docentes,
   * administradores y cuentas desactivadas no se tocan y vuelven en skipped con el motivo; un
   * docente solo importa a su grupo (no se lleva estudiantes de otro). Se puede repetir: quien
   * ya estaba igual sale en unchanged.
   */
  async importCourseMembers(input: {
    teacherUserId?: string | null;
    courseCode: string;
    students: Array<{ email: string; displayName?: string | null; studentCode?: string | null }>;
    assignedByUserId: string;
    viewer: AppUser;
  }): Promise<CourseMemberImportResult> {
    const viewerIsTeacher = input.viewer.role === "teacher";
    const teacherUserId = viewerIsTeacher
      ? input.viewer.id
      : await this.resolveTeacherUserId(input.teacherUserId || null);
    const courseCode = normalizeRagCourseCode(input.courseCode);
    const result: CourseMemberImportResult = {
      teacherUserId,
      courseCode,
      created: [],
      updated: [],
      unchanged: [],
      skipped: [],
      codes: { assigned: 0, conflicts: [] },
    };
    // Codigo de la lista (si Campus lo trae): queda en la cuenta si esta libre y la cuenta no
    // tiene uno; si es de otra cuenta, se informa y no se mueve.
    const applyListCode = async (userId: string, email: string, rawCode: string | null | undefined) => {
      if (rawCode == null || trimText(rawCode) === "") return;
      const code = normalizeStudentCode(rawCode);
      if (!code) {
        result.codes.conflicts.push({ email, studentCode: trimText(rawCode), reason: STUDENT_CODE_FORMAT_MESSAGE });
        return;
      }
      const current = await this.getStudentCodeForUser(userId);
      if (current === code) return;
      if (current) {
        result.codes.conflicts.push({ email, studentCode: code, reason: `Su cuenta ya tiene el codigo ${current}.` });
        return;
      }
      const ownerId = await this.getStudentCodeOwnerId(code);
      if (ownerId) {
        const owner = await this.findUserWithStatus(ownerId);
        result.codes.conflicts.push({ email, studentCode: code, reason: `Ese codigo ya es de ${owner?.user.displayName || "otra cuenta"}.` });
        return;
      }
      if (await this.insertStudentCode(code, userId, input.assignedByUserId)) result.codes.assigned += 1;
    };
    const seen = new Set<string>();
    for (const student of input.students) {
      const email = trimText(student.email).toLowerCase();
      const displayName = trimText(student.displayName).replace(/\s+/g, " ").slice(0, 120);
      if (!email || seen.has(email)) continue;
      seen.add(email);
      try {
        // Por el correo principal o por un correo de acceso extra (0.7.22): un Gmail unido a la
        // cuenta institucional no vuelve a crear una cuenta al repetir la importacion.
        const found = await this.findLoginAccount(email);
        const existing = found
          ? {
            id: found.user.id,
            role: found.user.role,
            display_name: found.user.displayName,
            teacher_user_id: found.user.teacherUserId,
            is_active: found.isActive,
          }
          : null;
        if (!existing) {
          const created = await this.createManagedUser({
            role: "student",
            email,
            displayName: displayName.length >= 2 ? displayName : email.split("@")[0],
            password: randomBytes(24).toString("base64url"),
            teacherUserId,
            assignedCourseCodes: [courseCode],
            assignedByUserId: input.assignedByUserId,
          });
          await applyListCode(created.id, email, student.studentCode);
          result.created.push({ id: created.id, email, displayName: created.displayName });
          continue;
        }
        const entry = { id: existing.id, email, displayName: existing.display_name };
        if (existing.role !== "student") {
          result.skipped.push({
            email,
            displayName: existing.display_name,
            reason: existing.role === "teacher" ? "Es docente en ADACEEN." : "Es administrador en ADACEEN.",
          });
          continue;
        }
        if (!existing.is_active) {
          result.skipped.push({
            email,
            displayName: existing.display_name,
            reason: "La cuenta esta desactivada: activala en la lista si debe entrar.",
          });
          continue;
        }
        if (viewerIsTeacher && existing.teacher_user_id && existing.teacher_user_id !== teacherUserId) {
          result.skipped.push({
            email,
            displayName: existing.display_name,
            reason: "Es estudiante de otro docente: pide al administrador que lo cambie.",
          });
          continue;
        }
        await applyListCode(existing.id, email, student.studentCode);
        const currentCodes = await this.listAssignedCourseCodesForUser(existing.id, "student");
        const changes: string[] = [];
        if (existing.teacher_user_id !== teacherUserId) changes.push("docente");
        if (!currentCodes.includes(courseCode)) changes.push("curso");
        if (!changes.length) {
          result.unchanged.push(entry);
          continue;
        }
        await this.updateManagedUser(existing.id, {
          teacherUserId,
          assignedCourseCodes: changes.includes("curso") ? [...currentCodes, courseCode] : undefined,
          assignedByUserId: input.assignedByUserId,
        }, { viewer: viewerIsTeacher ? input.viewer : undefined });
        result.updated.push({ ...entry, changes });
      } catch (error) {
        result.skipped.push({
          email,
          displayName,
          reason: error instanceof Error ? error.message : String(error),
        });
      }
    }
    return result;
  }

  async removeManagedStudents(userIds: string[], options: { viewer: AppUser }): Promise<ManagedStudentRemovalResult> {
    const result: ManagedStudentRemovalResult = { deleted: [], deactivated: [], skipped: [] };
    const viewerTeacherId = options.viewer.role === "teacher" ? options.viewer.id : "";
    const seen = new Set<string>();
    for (const rawId of userIds) {
      const userId = trimText(rawId);
      if (!userId || seen.has(userId)) continue;
      seen.add(userId);
      const found = await this.pool.query<{ id: string; role: string; email: string; display_name: string; teacher_user_id: string | null; is_active: boolean }>(
        `
        select u.id, r.code as role, u.email, u.display_name, u.teacher_user_id, u.is_active
        from users u
        join roles r on r.id = u.role_id
        where u.id = $1
        limit 1
        `,
        [userId],
      );
      const row = found.rows[0];
      if (!row) {
        result.skipped.push({ id: userId, email: "", displayName: "", reason: "No existe." });
        continue;
      }
      const entry = { id: row.id, email: row.email, displayName: row.display_name };
      if (row.role !== "student") {
        result.skipped.push({ ...entry, reason: "No es estudiante: los docentes se eliminan uno a uno." });
        continue;
      }
      if (viewerTeacherId && row.teacher_user_id !== viewerTeacherId) {
        result.skipped.push({ ...entry, reason: "Es estudiante de otro docente." });
        continue;
      }
      if (!(await this.hasEverSignedIn(row.id))) {
        try {
          await this.withTransaction(async (client) => {
            for (const statement of NEVER_SIGNED_IN_STUDENT_CLEANUP) await client.query(statement, [row.id]);
            await client.query("delete from users where id = $1", [row.id]);
          });
          result.deleted.push(entry);
          continue;
        } catch {
          // Algo mas apunta a la cuenta (datos que no se esperaban): se desactiva en vez de borrarla.
          if (!row.is_active) {
            result.skipped.push({ ...entry, reason: "Ya estaba desactivada y tiene datos asociados." });
            continue;
          }
          await this.deactivateManagedUser(row.id, { viewer: options.viewer });
          result.deactivated.push({ ...entry, reason: "Tiene datos asociados: se desactivó." });
          continue;
        }
      }
      if (!row.is_active) {
        result.skipped.push({ ...entry, reason: "Ya estaba desactivada." });
        continue;
      }
      await this.deactivateManagedUser(row.id, { viewer: options.viewer });
      result.deactivated.push({ ...entry, reason: "Ya entró: se desactivó y conserva sus datos del piloto." });
    }
    return result;
  }
}

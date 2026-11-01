// AppDatabase: crear, editar y desactivar usuarios administrados.
// Metodos movidos sin cambios desde src/db/repos/users.ts; la clase va entre StudentAccessDatabase y CourseMembersDatabase.
import { randomUUID } from "node:crypto";
import { hashPassword, mapManagedUserRow } from "../rows.js";
import type { ManagedUserRow } from "../rows.js";
import type { AppUser, UserRoleCode } from "../../types/app.js";
import { trimText } from "../../services/shared/text-utils.js";
import { normalizeStudentCode, STUDENT_CODE_FORMAT_MESSAGE } from "../../services/auth/student-code.js";
import { StudentAccessDatabase } from "./users-access.js";

export class ManagedUsersDatabase extends StudentAccessDatabase {
  async createManagedUser(input: {
    /** Solo para datos sinteticos reproducibles (ensayo tecnico); el API no lo recibe. */
    id?: string;
    role: "student" | "teacher";
    email: string;
    displayName: string;
    password: string;
    teacherUserId?: string | null;
    assignedCourseCodes?: unknown;
    assignedByUserId?: string | null;
    /** Solo estudiantes (0.7.22): codigo de 7 digitos; si ya es de otra cuenta, no se crea. */
    studentCode?: string | null;
  }) {
    const role = input.role === "teacher" ? "teacher" : "student";
    const email = input.email.trim().toLowerCase();
    const sameEmail = await this.findLoginAccount(email);
    if (sameEmail) {
      throw new Error(sameEmail.user.email.toLowerCase() === email
        ? "Ya existe una cuenta con ese correo."
        : `Ese correo ya es un acceso de ${sameEmail.user.displayName}.`);
    }
    let studentCode: string | null = null;
    if (role === "student" && input.studentCode != null && trimText(input.studentCode) !== "") {
      studentCode = normalizeStudentCode(input.studentCode);
      if (!studentCode) throw new Error(STUDENT_CODE_FORMAT_MESSAGE);
      if (await this.getStudentCodeOwnerId(studentCode)) {
        throw new Error(`El codigo ${studentCode} ya es de otra cuenta.`);
      }
    }
    const roleId = await this.getRoleIdByCode(role);
    const teacherUserId = role === "student"
      ? await this.resolveTeacherUserId(input.teacherUserId)
      : null;

    const created = await this.pool.query<ManagedUserRow>(
      `
      with inserted as (
        insert into users (
          id,
          role_id,
          teacher_user_id,
          email,
          display_name,
          password_hash,
          is_active
        )
        values ($1, $2, $3, $4, $5, $6, true)
        returning
          id,
          role_id,
          teacher_user_id,
          email,
          display_name,
          is_active,
          created_at
      )
      select
        i.id,
        r.code as role,
        i.email,
        i.display_name,
        i.teacher_user_id,
        teacher.display_name as teacher_display_name,
        i.is_active,
        i.created_at
      from inserted i
      join roles r on r.id = i.role_id
      left join users teacher on teacher.id = i.teacher_user_id
      `,
      [
        input.id?.trim() || randomUUID(),
        roleId,
        teacherUserId,
        email,
        input.displayName.trim(),
        hashPassword(input.password),
      ],
    );

    const row = created.rows[0];
    if (!row) {
      throw new Error("No se pudo crear el usuario.");
    }

    if (row.role === "teacher") {
      await this.ensureTeacherPolicyExists(row.id);
      row.assigned_course_codes = [];
    } else {
      row.assigned_course_codes = await this.setUserCourseAssignments(
        row.id,
        input.assignedCourseCodes,
        input.assignedByUserId || null,
      );
      if (studentCode) await this.insertStudentCode(studentCode, row.id, input.assignedByUserId || null);
    }

    return this.withIdentity(mapManagedUserRow(row));
  }

  async updateManagedUser(userId: string, input: {
    role?: "student" | "teacher";
    email?: string;
    displayName?: string;
    password?: string;
    teacherUserId?: string | null;
    isActive?: boolean;
    assignedCourseCodes?: unknown;
    assignedByUserId?: string | null;
    /** Solo estudiantes (0.7.22): null o "" lo quita. Necesita options.viewer. */
    studentCode?: string | null;
  }, options?: {
    viewer?: AppUser;
  }) {
    const existingResult = await this.pool.query<{
      id: string;
      role: UserRoleCode;
      email: string;
      display_name: string;
      teacher_user_id: string | null;
      is_active: boolean;
    }>(
      `
      select
        u.id,
        r.code as role,
        u.email,
        u.display_name,
        u.teacher_user_id,
        u.is_active
      from users u
      join roles r on r.id = u.role_id
      where u.id = $1
      limit 1
      `,
      [userId],
    );

    const existing = existingResult.rows[0];
    if (!existing) {
      throw new Error("Usuario no encontrado.");
    }
    if (existing.role === "admin") {
      throw new Error("No se puede editar un usuario administrador desde este flujo.");
    }
    if (options?.viewer?.role === "teacher") {
      if (existing.role !== "student" || existing.teacher_user_id !== options.viewer.id) {
        throw new Error("Solo puedes editar estudiantes asignados a tu cuenta docente.");
      }
    }

    const nextRole = options?.viewer?.role === "teacher"
      ? "student"
      : (input.role === "teacher" || input.role === "student" ? input.role : existing.role);
    const roleId = await this.getRoleIdByCode(nextRole);
    const nextTeacherUserId = options?.viewer?.role === "teacher"
      ? options.viewer.id
      : nextRole === "student"
      ? await this.resolveTeacherUserId(
        input.teacherUserId === undefined ? existing.teacher_user_id : input.teacherUserId,
        { excludeUserId: userId },
      )
      : null;
    const nextEmail = input.email == null
      ? existing.email
      : input.email.trim().toLowerCase();
    const nextDisplayName = input.displayName == null
      ? existing.display_name
      : input.displayName.trim();
    const nextPasswordHash = input.password && input.password.trim().length > 0
      ? hashPassword(input.password)
      : null;
    const nextIsActive = input.isActive == null
      ? existing.is_active
      : input.isActive;
    // El codigo se revisa antes que el resto (si choca con otra cuenta, no se aplica nada) y se
    // guarda despues (si la edicion falla, el codigo tampoco cambia).
    const changesCode = input.studentCode !== undefined && existing.role === "student" && nextRole === "student";
    if (changesCode) {
      if (!options?.viewer) throw new Error("Falta quien edita el codigo.");
      const wanted = input.studentCode == null || trimText(input.studentCode) === "" ? null : normalizeStudentCode(input.studentCode);
      if (input.studentCode != null && trimText(input.studentCode) !== "" && !wanted) throw new Error(STUDENT_CODE_FORMAT_MESSAGE);
      const ownerId = wanted ? await this.getStudentCodeOwnerId(wanted) : null;
      if (ownerId && ownerId !== userId) {
        const owner = await this.findUserWithStatus(ownerId);
        throw new Error(`El codigo ${wanted} ya es de ${owner?.user.displayName || "otra cuenta"}. Si es la misma persona, desactiva la cuenta que sobra.`);
      }
    }
    if (nextEmail !== existing.email.toLowerCase()) {
      const other = await this.findLoginAccount(nextEmail);
      if (other && other.user.id !== userId) {
        throw new Error(`Ese correo ya es de ${other.user.displayName}.`);
      }
    }

    const updated = await this.pool.query<ManagedUserRow>(
      `
      with updated_user as (
        update users
        set
          role_id = $2,
          teacher_user_id = $3,
          email = $4,
          display_name = $5,
          password_hash = coalesce($6, password_hash),
          is_active = $7
        where id = $1
        returning
          id,
          role_id,
          teacher_user_id,
          email,
          display_name,
          is_active,
          created_at
      )
      select
        uu.id,
        r.code as role,
        uu.email,
        uu.display_name,
        uu.teacher_user_id,
        teacher.display_name as teacher_display_name,
        uu.is_active,
        uu.created_at
      from updated_user uu
      join roles r on r.id = uu.role_id
      left join users teacher on teacher.id = uu.teacher_user_id
      `,
      [
        userId,
        roleId,
        nextTeacherUserId,
        nextEmail,
        nextDisplayName,
        nextPasswordHash,
        nextIsActive,
      ],
    );

    const row = updated.rows[0];
    if (!row) {
      throw new Error("No se pudo actualizar el usuario.");
    }

    if (row.role === "teacher") {
      await this.ensureTeacherPolicyExists(row.id);
      await this.pool.query(`delete from user_course_assignments where user_id = $1`, [row.id]);
      row.assigned_course_codes = [];
    } else {
      row.assigned_course_codes = input.assignedCourseCodes === undefined
        ? await this.listAssignedCourseCodesForUser(row.id, row.role)
        : await this.setUserCourseAssignments(
          row.id,
          input.assignedCourseCodes,
          input.assignedByUserId || options?.viewer?.id || null,
        );
    }

    // Desactivar o cambiar de rol cierra sus sesiones: al volver a entrar ve lo de su rol (y un
    // estudiante nuevo escribe su codigo). Un docente no tiene codigo de estudiante.
    if (!row.is_active || existing.role !== row.role) {
      await this.pool.query(
        `update app_sessions set is_active = false, last_seen_at = now() where user_id = $1`,
        [row.id],
      );
    }
    if (row.role !== "student") {
      await this.pool.query(`delete from student_codes where user_id = $1`, [row.id]);
    }
    if (changesCode && options?.viewer) {
      await this.setStudentCode(row.id, input.studentCode ?? null, options.viewer);
    }

    return this.withIdentity(mapManagedUserRow(row));
  }

  async deactivateManagedUser(userId: string, options?: {
    viewer?: AppUser;
  }) {
    // En tres pasos (buscar, desactivar, leer) en vez de un UPDATE ... FROM con CTE: ese
    // RETURNING tenia «id» ambiguo y pg-mem tampoco lo ejecutaba (0.7.22).
    const target = await this.pool.query<{ id: string }>(
      `
      select u.id
      from users u
      join roles r on r.id = u.role_id
      where u.id = $1
        and r.code in ('student', 'teacher')
        and (
          $2 = ''
          or (
            r.code = 'student'
            and u.teacher_user_id = $2
          )
        )
      limit 1
      `,
      [userId, options?.viewer?.role === "teacher" ? options.viewer.id : ""],
    );
    if (target.rows[0]) {
      await this.pool.query(`update users set is_active = false where id = $1`, [target.rows[0].id]);
    }
    const updated = await this.pool.query<ManagedUserRow>(
      `
      select
        u.id,
        r.code as role,
        u.email,
        u.display_name,
        u.teacher_user_id,
        teacher.display_name as teacher_display_name,
        u.is_active,
        u.created_at
      from users u
      join roles r on r.id = u.role_id
      left join users teacher on teacher.id = u.teacher_user_id
      where u.id = $1
      `,
      [target.rows[0]?.id || ""],
    );

    const row = updated.rows[0];
    if (!row) {
      throw new Error("Usuario no encontrado o no administrable.");
    }

    await this.pool.query(
      `update app_sessions set is_active = false, last_seen_at = now() where user_id = $1`,
      [row.id],
    );
    row.assigned_course_codes = await this.listAssignedCourseCodesForUser(row.id, row.role);

    return this.withIdentity(mapManagedUserRow(row));
  }
}

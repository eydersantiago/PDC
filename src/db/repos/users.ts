// AppDatabase, parte 3 de 12: usuarios administrados (listar, crear, editar, desactivar) con sus cursos y lotes de RAG.
// Metodos movidos sin cambios desde src/db/database.ts. Cadena: DatabaseCore -> AuthDatabase -> UsersDatabase -> PolicyDatabase -> RagLotsDatabase -> RagSourcesDatabase -> GithubDatabase -> WorkspaceDatabase -> PilotDatabase -> TelemetryDatabase -> ProgressDatabase -> QuizDatabase -> AppDatabase
// (cada clase extiende a la anterior; db.metodo() sigue igual). private pasa a protected solo si otra clase lo usa.
import { randomBytes, randomUUID } from "node:crypto";
import { hashPassword, mapManagedUserRow, mapRagLotRow } from "../rows.js";
import type { ManagedUser, ManagedUserRow, RagLotRow } from "../rows.js";
import type { AppUser, UserRoleCode } from "../../types/app.js";
import { trimText } from "../../services/text-utils.js";
import { normalizeRagCourseCode } from "../../services/rag-courses.js";
import { resolveEffectiveLot } from "../../services/rag-lots.js";
import type { EffectiveRagLot } from "../../services/rag-lots.js";
import { countActiveDemoAccounts as countActiveDemoAccountsIn } from "../../services/demo-accounts.js";
import { AuthDatabase } from "./auth.js";

/** POST /api/admin/users/import: como quedo cada correo de la lista. */
export type CourseMemberImportResult = {
  teacherUserId: string;
  courseCode: string;
  created: Array<{ id: string; email: string; displayName: string }>;
  /** changes: "docente" y/o "curso". */
  updated: Array<{ id: string; email: string; displayName: string; changes: string[] }>;
  unchanged: Array<{ id: string; email: string; displayName: string }>;
  skipped: Array<{ email: string; displayName: string; reason: string }>;
};

export class UsersDatabase extends AuthDatabase {
  /** Cuantas cuentas demo (src/services/demo-accounts.ts) siguen activas; lo informa /api/health. */
  async countActiveDemoAccounts() {
    return countActiveDemoAccountsIn(this.pool);
  }

  private async hydrateManagedUserCourseCodes(rows: ManagedUserRow[]) {
    for (const row of rows) {
      row.assigned_course_codes = await this.listAssignedCourseCodesForUser(row.id, row.role);
    }
    return rows;
  }

  async listManagedUsers(viewer?: AppUser) {
    const teacherScopeId = viewer?.role === "teacher" ? viewer.id : "";
    const usersResult = await this.pool.query<ManagedUserRow>(
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
      where r.code in ('student', 'teacher')
        and (
          $1 = ''
          or (
            r.code = 'student'
            and u.teacher_user_id = $1
          )
        )
      order by
        case r.code
          when 'teacher' then 0
          else 1
        end,
        u.display_name asc
      `,
      [teacherScopeId],
    );

    const teachersResult = await this.pool.query<{
      id: string;
      email: string;
      display_name: string;
    }>(
      `
      select
        u.id,
        u.email,
        u.display_name
      from users u
      join roles r on r.id = u.role_id
      where r.code = 'teacher'
        and u.is_active = true
        and ($1 = '' or u.id = $1)
      order by u.display_name asc
      `,
      [teacherScopeId],
    );
    const hydratedUsers = await this.hydrateManagedUserCourseCodes(usersResult.rows);
    const users = hydratedUsers.map(mapManagedUserRow);
    await this.attachRagLotsToManagedUsers(users, teacherScopeId);

    return {
      users,
      teachers: teachersResult.rows.map((row) => ({
        id: row.id,
        email: row.email,
        displayName: row.display_name,
      })),
    };
  }

  /**
   * «RAG aplicado» (0.7.15): por estudiante y curso, el lote que le llega (asignado,
   * activo del curso o la base), resuelto con los lotes de su docente.
   */
  private async attachRagLotsToManagedUsers(users: ManagedUser[], teacherScopeId: string) {
    const students = users.filter((user) => user.role === "student");
    if (!students.length) return;
    const lotsResult = await this.pool.query<RagLotRow>(
      `
      select id, teacher_user_id, course_code, name, description, includes_base, is_active, created_at, updated_at
      from rag_lots
      where is_active = true and ($1 = '' or teacher_user_id = $1)
      `,
      [teacherScopeId],
    );
    const settingsResult = await this.pool.query<{ teacher_user_id: string; course_code: string; active_lot_id: string | null }>(
      `select teacher_user_id, course_code, active_lot_id from rag_course_lot_settings where ($1 = '' or teacher_user_id = $1)`,
      [teacherScopeId],
    );
    const studentLotsResult = await this.pool.query<{ student_user_id: string; course_code: string; lot_id: string }>(
      `select student_user_id, course_code, lot_id from rag_student_lots`,
    );
    const lots = lotsResult.rows.map(mapRagLotRow);
    const activeByTeacherCourse = new Map<string, string>();
    for (const row of settingsResult.rows) {
      const lotId = trimText(row.active_lot_id || "");
      if (lotId) activeByTeacherCourse.set(`${row.teacher_user_id}|${normalizeRagCourseCode(row.course_code)}`, lotId);
    }
    const studentLotByCourse = new Map<string, string>();
    for (const row of studentLotsResult.rows) {
      studentLotByCourse.set(`${row.student_user_id}|${normalizeRagCourseCode(row.course_code)}`, row.lot_id);
    }
    for (const student of students) {
      const teacherId = trimText(student.teacherUserId || "");
      const teacherLots = lots.filter((lot) => lot.teacherUserId === teacherId);
      const ragLots: Record<string, { lotId: string; lotName: string; origin: EffectiveRagLot["origin"] }> = {};
      for (const courseCode of student.assignedCourseCodes) {
        const code = normalizeRagCourseCode(courseCode);
        const effective = resolveEffectiveLot({
          courseCode: code,
          lots: teacherLots,
          activeLotId: activeByTeacherCourse.get(`${teacherId}|${code}`) || null,
          studentLotId: studentLotByCourse.get(`${student.id}|${code}`) || null,
        });
        ragLots[code] = { lotId: effective.lotId, lotName: effective.name, origin: effective.origin };
      }
      student.ragLots = ragLots;
    }
  }

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
  }) {
    const role = input.role === "teacher" ? "teacher" : "student";
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
        input.email.trim().toLowerCase(),
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
    }

    return mapManagedUserRow(row);
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

    if (!row.is_active) {
      await this.pool.query(
        `update app_sessions set is_active = false, last_seen_at = now() where user_id = $1`,
        [row.id],
      );
    }

    return mapManagedUserRow(row);
  }

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
    students: Array<{ email: string; displayName?: string | null }>;
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
    };
    const seen = new Set<string>();
    for (const student of input.students) {
      const email = trimText(student.email).toLowerCase();
      const displayName = trimText(student.displayName).replace(/\s+/g, " ").slice(0, 120);
      if (!email || seen.has(email)) continue;
      seen.add(email);
      try {
        const existingResult = await this.pool.query<{
          id: string;
          role: UserRoleCode;
          display_name: string;
          teacher_user_id: string | null;
          is_active: boolean;
        }>(
          `
          select u.id, r.code as role, u.display_name, u.teacher_user_id, u.is_active
          from users u
          join roles r on r.id = u.role_id
          where lower(u.email) = $1
          limit 1
          `,
          [email],
        );
        const existing = existingResult.rows[0];
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

  async deactivateManagedUser(userId: string, options?: {
    viewer?: AppUser;
  }) {
    const updated = await this.pool.query<ManagedUserRow>(
      `
      with target as (
        select
          u.id,
          u.role_id,
          u.teacher_user_id,
          u.email,
          u.display_name,
          u.created_at
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
      ),
      updated_user as (
        update users
        set is_active = false
        from target t
        where users.id = t.id
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
      [userId, options?.viewer?.role === "teacher" ? options.viewer.id : ""],
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

    return mapManagedUserRow(row);
  }
}

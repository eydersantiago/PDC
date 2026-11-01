// AppDatabase, parte 3 de 12: usuarios administrados (listar, identidad, codigo de estudiante, administradores configurados) con sus cursos y lotes de RAG; siguen users-access.ts, users-admin.ts y users-import.ts.
// Metodos movidos sin cambios desde src/db/database.ts. Cadena: DatabaseCore -> AuthDatabase -> UsersDatabase -> PolicyDatabase -> RagLotsDatabase -> RagSourcesDatabase -> GithubDatabase -> WorkspaceDatabase -> PilotDatabase -> TelemetryDatabase -> ProgressDatabase -> QuizDatabase -> AppDatabase
// (cada clase extiende a la anterior; db.metodo() sigue igual). private pasa a protected solo si otra clase lo usa.
import { randomBytes } from "node:crypto";
import { hashPassword, mapManagedUserRow, mapRagLotRow, verifyPassword } from "../rows.js";
import type { ManagedUser, ManagedUserRow, RagLotRow } from "../rows.js";
import type { AppUser, UserRoleCode } from "../../types/app.js";
import { trimText } from "../../services/shared/text-utils.js";
import { normalizeRagCourseCode } from "../../services/rag/rag-courses.js";
import { resolveEffectiveLot } from "../../services/rag/rag-lots.js";
import type { EffectiveRagLot } from "../../services/rag/rag-lots.js";
import { countActiveDemoAccounts as countActiveDemoAccountsIn } from "../../services/accounts/demo-accounts.js";
import { countActiveTestAccounts as countActiveTestAccountsIn } from "../../services/accounts/test-accounts.js";
import { countActiveDemoRouteAccounts as countActiveDemoRouteAccountsIn } from "../../services/accounts/demo-route-accounts.js";
import {
  adminEmailRejection,
  emptyConfiguredAdminsReport,
  teacherWithStudentsReason,
  type ConfiguredAdminsReport,
} from "../../services/auth/configured-admins.js";
import {
  normalizeStudentCode, STUDENT_CODE_FORMAT_MESSAGE
} from "../../services/auth/student-code.js";
import { AuthDatabase } from "./auth.js";

export class UsersDatabase extends AuthDatabase {
  /** Cuantas cuentas demo (src/services/accounts/demo-accounts.ts) siguen activas; lo informa /api/health. */
  async countActiveDemoAccounts() {
    return countActiveDemoAccountsIn(this.pool);
  }

  /** Cuantas cuentas de prueba (src/services/accounts/test-accounts.ts) estan activas; lo informa /api/health. */
  async countActiveTestAccounts() {
    return countActiveTestAccountsIn(this.pool);
  }

  /** Cuantas cuentas demo por ruta (src/services/accounts/demo-route-accounts.ts) estan activas; lo informa /api/health. */
  async countActiveDemoRouteAccounts() {
    return countActiveDemoRouteAccountsIn(this.pool);
  }

  /**
   * ADACEEN_ADMIN_EMAILS (src/services/auth/configured-admins.ts): pasa a administrador las cuentas
   * activas de esos correos, sin docente asignado, y cierra sus sesiones. No crea cuentas ni baja
   * a nadie de rol. Si la cuenta entraba con la clave por defecto de las cuentas de Google, le pone
   * una al azar. Lo llama cada arranque (AppDatabase.syncConfiguredAdmins) antes de cerrar las
   * cuentas demo.
   */
  async promoteConfiguredAdmins(
    emails: readonly string[],
    options: { googleDefaultPassword?: string } = {},
  ): Promise<ConfiguredAdminsReport> {
    const report = emptyConfiguredAdminsReport();
    if (!emails.length) return report;
    const adminRoleId = await this.getRoleIdByCode("admin");
    const googleDefaultPassword = String(options.googleDefaultPassword || "");
    for (const email of emails) {
      const rejection = adminEmailRejection(email);
      if (rejection) {
        report.skipped.push({ email, reason: rejection });
        continue;
      }
      const found = await this.pool.query<{ id: string; role: UserRoleCode; is_active: boolean; password_hash: string }>(
        `
        select u.id, r.code as role, u.is_active, u.password_hash
        from users u
        join roles r on r.id = u.role_id
        where lower(u.email) = lower($1)
        limit 1
        `,
        [email],
      );
      const row = found.rows[0];
      if (!row) {
        report.missing.push(email);
        continue;
      }
      if (!row.is_active) {
        report.inactive.push(email);
        continue;
      }
      if (row.role === "admin") {
        report.alreadyAdmin.push(email);
        continue;
      }
      if (row.role === "teacher") {
        const students = await this.pool.query<{ count: string }>(
          `select count(*)::text as count from users where teacher_user_id = $1`,
          [row.id],
        );
        const count = Number(students.rows[0]?.count || 0);
        if (count > 0) {
          report.skipped.push({ email, reason: teacherWithStudentsReason(count) });
          continue;
        }
      }
      const passwordReset = Boolean(googleDefaultPassword) && verifyPassword(googleDefaultPassword, row.password_hash);
      await this.pool.query(`update users set role_id = $2, teacher_user_id = null where id = $1`, [row.id, adminRoleId]);
      if (passwordReset) {
        await this.pool.query(`update users set password_hash = $2 where id = $1`, [row.id, hashPassword(randomBytes(24).toString("base64url"))]);
      }
      await this.pool.query(`update app_sessions set is_active = false where user_id = $1 and is_active = true`, [row.id]);
      report.promoted.push({ email, previousRole: row.role, passwordReset });
    }
    return report;
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
        and u.merged_into_user_id is null
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
    await this.attachIdentityToManagedUsers(users);

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
   * Codigo de estudiante, correos de acceso extra y si ya entro (0.7.22). Tres consultas para
   * toda la lista, sin JOIN (pg-mem).
   */
  protected async attachIdentityToManagedUsers(users: ManagedUser[]) {
    if (!users.length) return;
    const codes = await this.pool.query<{ code: string; user_id: string }>(`select code, user_id from student_codes`);
    const aliases = await this.pool.query<{ email: string; user_id: string }>(
      `select email, user_id from user_login_emails order by email asc`,
    );
    const sessions = await this.pool.query<{ user_id: string }>(`select distinct user_id from app_sessions`);
    const codeByUser = new Map(codes.rows.map((row) => [row.user_id, row.code]));
    const signedIn = new Set(sessions.rows.map((row) => row.user_id));
    const emailsByUser = new Map<string, string[]>();
    for (const row of aliases.rows) {
      const list = emailsByUser.get(row.user_id) || [];
      list.push(row.email);
      emailsByUser.set(row.user_id, list);
    }
    for (const user of users) {
      user.studentCode = user.role === "student" ? codeByUser.get(user.id) || null : null;
      user.loginEmails = emailsByUser.get(user.id) || [];
      user.hasSignedIn = signedIn.has(user.id);
    }
  }

  /** Un usuario administrado con su codigo y sus correos (respuesta de crear y editar). */
  protected async withIdentity(user: ManagedUser): Promise<ManagedUser> {
    await this.attachIdentityToManagedUsers([user]);
    return user;
  }

  /**
   * El docente (de sus estudiantes) o el administrador ponen, cambian o quitan el codigo de un
   * estudiante. Un codigo que ya es de otra cuenta no se mueve: si es la misma persona, se une
   * con la solicitud o desactivando la sobrante. Quitarlo cierra sus sesiones (lo vuelve a
   * escribir al entrar).
   */
  async setStudentCode(userId: string, rawCode: string | null, viewer: AppUser) {
    const found = await this.findUserWithStatus(userId);
    if (!found || found.user.role !== "student") throw new Error("Solo los estudiantes tienen codigo.");
    if (viewer.role === "teacher" && found.user.teacherUserId !== viewer.id) {
      throw new Error("Solo puedes editar estudiantes asignados a tu cuenta docente.");
    }
    if (viewer.role !== "teacher" && viewer.role !== "admin") throw new Error("Sin permiso para editar codigos.");
    const current = await this.getStudentCodeForUser(userId);
    if (rawCode === null || trimText(rawCode) === "") {
      if (!current) return;
      await this.pool.query(`delete from student_codes where user_id = $1`, [userId]);
      await this.pool.query(
        `update app_sessions set is_active = false, last_seen_at = now() where user_id = $1`,
        [userId],
      );
      return;
    }
    const code = normalizeStudentCode(rawCode);
    if (!code) throw new Error(STUDENT_CODE_FORMAT_MESSAGE);
    if (current === code) return;
    const ownerId = await this.getStudentCodeOwnerId(code);
    if (ownerId && ownerId !== userId) {
      const owner = await this.findUserWithStatus(ownerId);
      throw new Error(`El codigo ${code} ya es de ${owner?.user.displayName || "otra cuenta"}. Si es la misma persona, desactiva la cuenta que sobra.`);
    }
    if (current) await this.pool.query(`delete from student_codes where user_id = $1`, [userId]);
    if (!(await this.insertStudentCode(code, userId, viewer.id))) {
      throw new Error(`El codigo ${code} ya es de otra cuenta.`);
    }
  }

  /** Quita un correo de acceso extra de una cuenta (el correo principal no se quita aqui). */
  async removeLoginEmail(userId: string, email: string, viewer: AppUser) {
    const found = await this.findUserWithStatus(userId);
    if (!found) throw new Error("Usuario no encontrado.");
    if (viewer.role === "teacher" && (found.user.role !== "student" || found.user.teacherUserId !== viewer.id)) {
      throw new Error("Solo puedes editar estudiantes asignados a tu cuenta docente.");
    }
    if (viewer.role !== "teacher" && viewer.role !== "admin") throw new Error("Sin permiso para editar accesos.");
    const result = await this.pool.query(
      `delete from user_login_emails where email = $1 and user_id = $2`,
      [trimText(email).toLowerCase(), userId],
    );
    if (!result.rowCount) throw new Error("Ese correo no es un acceso de esta cuenta.");
    // Quien entro con ese correo (por ejemplo, aprobado por error) sale ya; el dueño vuelve a entrar.
    await this.pool.query(
      `update app_sessions set is_active = false, last_seen_at = now() where user_id = $1 and is_active = true`,
      [userId],
    );
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
}

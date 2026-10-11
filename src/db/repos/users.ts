// AppDatabase, parte 3 de 12: usuarios administrados (listar, crear, editar, desactivar) con sus cursos y lotes de RAG.
// Metodos movidos sin cambios desde src/db/database.ts. Cadena: DatabaseCore -> AuthDatabase -> UsersDatabase -> PolicyDatabase -> RagLotsDatabase -> RagSourcesDatabase -> GithubDatabase -> WorkspaceDatabase -> PilotDatabase -> TelemetryDatabase -> ProgressDatabase -> QuizDatabase -> AppDatabase
// (cada clase extiende a la anterior; db.metodo() sigue igual). private pasa a protected solo si otra clase lo usa.
import { randomBytes, randomUUID } from "node:crypto";
import { hashPassword, mapManagedUserRow, mapRagLotRow, verifyPassword } from "../rows.js";
import type { ManagedUser, ManagedUserRow, RagLotRow } from "../rows.js";
import type { AppUser, UserRoleCode } from "../../types/app.js";
import { trimText } from "../../services/text-utils.js";
import { normalizeRagCourseCode } from "../../services/rag-courses.js";
import { resolveEffectiveLot } from "../../services/rag-lots.js";
import type { EffectiveRagLot } from "../../services/rag-lots.js";
import { countActiveDemoAccounts as countActiveDemoAccountsIn } from "../../services/demo-accounts.js";
import {
  adminEmailRejection,
  emptyConfiguredAdminsReport,
  teacherWithStudentsReason,
  type ConfiguredAdminsReport,
} from "../../services/configured-admins.js";
import {
  normalizeStudentCode,
  STUDENT_CODE_FORMAT_MESSAGE,
  type StudentAccessRequest,
} from "../../services/student-code.js";
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
  /** 0.7.22: codigos de la lista que quedaron en su cuenta y los que no (ya eran de otra). */
  codes: { assigned: number; conflicts: Array<{ email: string; studentCode: string; reason: string }> };
};

export class UsersDatabase extends AuthDatabase {
  /** Cuantas cuentas demo (src/services/demo-accounts.ts) siguen activas; lo informa /api/health. */
  async countActiveDemoAccounts() {
    return countActiveDemoAccountsIn(this.pool);
  }

  /**
   * ADACEEN_ADMIN_EMAILS (src/services/configured-admins.ts): pasa a administrador las cuentas
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
   * Solicitudes pendientes de entrar con un correo nuevo a la cuenta de un codigo (0.7.22). El
   * docente ve las de sus estudiantes; el administrador, todas.
   */
  async listStudentAccessRequests(viewer: AppUser): Promise<StudentAccessRequest[]> {
    const result = await this.pool.query<{
      id: string;
      email: string;
      display_name: string;
      student_code: string;
      status: string;
      created_at: string | Date;
      target_user_id: string;
      source_user_id: string | null;
    }>(
      `
      select id, email, display_name, student_code, status, created_at, target_user_id, source_user_id
      from student_access_requests
      where status = 'pending'
      order by created_at asc
      `,
    );
    const requests: StudentAccessRequest[] = [];
    for (const row of result.rows) {
      const target = await this.findUserWithStatus(row.target_user_id);
      if (!target) continue;
      if (viewer.role === "teacher" && target.user.teacherUserId !== viewer.id) continue;
      if (viewer.role !== "teacher" && viewer.role !== "admin") continue;
      const source = row.source_user_id ? await this.findUserWithStatus(row.source_user_id) : null;
      // El docente no ve los datos de una cuenta de otro grupo (solo que existe).
      const foreignSource = !!source && viewer.role === "teacher" && source.user.teacherUserId !== viewer.id;
      requests.push({
        id: row.id,
        email: row.email,
        displayName: row.display_name,
        studentCode: row.student_code,
        status: "pending",
        createdAt: new Date(row.created_at).toISOString(),
        target: {
          id: target.user.id,
          displayName: target.user.displayName,
          email: target.user.email,
          teacherUserId: target.user.teacherUserId,
        },
        source: source
          ? {
            id: foreignSource ? "" : source.user.id,
            displayName: foreignSource ? "Cuenta de otro grupo" : source.user.displayName,
            email: foreignSource ? "" : source.user.email,
            hasSignedIn: await this.hasEverSignedIn(source.user.id),
            otherGroup: foreignSource,
          }
          : null,
      });
    }
    return requests;
  }

  /**
   * Aprobar: el correo pasa a ser otro acceso de la cuenta del codigo (y la cuenta que ya tenia
   * ese correo, si existe, se une a ella). Rechazar: ese correo con ese codigo no vuelve a pedir.
   */
  async decideStudentAccessRequest(requestId: string, decision: "approve" | "reject", viewer: AppUser, expectedStudentCode?: string | null) {
    const result = await this.pool.query<{
      id: string;
      email: string;
      status: string;
      student_code: string;
      target_user_id: string;
      source_user_id: string | null;
    }>(
      `select id, email, status, student_code, target_user_id, source_user_id from student_access_requests where id = $1 limit 1`,
      [requestId],
    );
    const row = result.rows[0];
    if (!row) throw new Error("Solicitud no encontrada.");
    if (row.status !== "pending") throw new Error("Esa solicitud ya se decidio.");
    // La solicitud de un correo se actualiza si vuelve con otro codigo: se decide la que se vio.
    if (expectedStudentCode && expectedStudentCode !== row.student_code) {
      throw new Error("La solicitud cambio mientras la mirabas: recarga la lista.");
    }
    if (viewer.role !== "teacher" && viewer.role !== "admin") throw new Error("Sin permiso.");
    const target = await this.findUserWithStatus(row.target_user_id);
    if (!target) throw new Error("La cuenta del codigo ya no existe.");
    if (viewer.role === "teacher" && target.user.teacherUserId !== viewer.id) {
      throw new Error("Solo puedes decidir solicitudes de tus estudiantes.");
    }
    if (decision === "approve") {
      if (!target.isActive) throw new Error("La cuenta del codigo esta desactivada: activala antes de aprobar.");
      // Lo de la solicitud tiene que seguir igual: el codigo en la misma cuenta y el correo sin
      // haber entrado a otra (si entro, por ejemplo con su propio codigo, ya no se une nada).
      if ((await this.getStudentCodeOwnerId(row.student_code)) !== row.target_user_id) {
        throw new Error("Ese codigo ya no es de esa cuenta: rechaza la solicitud.");
      }
      const current = await this.findLoginAccount(row.email);
      if (current && current.user.id !== row.target_user_id && current.user.id !== row.source_user_id) {
        throw new Error("Ese correo ya entra a otra cuenta: rechaza la solicitud.");
      }
      const source = row.source_user_id ? await this.findUserWithStatus(row.source_user_id) : null;
      if (source && viewer.role === "teacher" && source.user.teacherUserId !== viewer.id) {
        throw new Error("Ese correo ya tiene una cuenta de otro grupo: solo el administrador puede unirlas.");
      }
      await this.mergeLoginEmailInto({
        email: row.email,
        targetUserId: row.target_user_id,
        sourceUserId: row.source_user_id,
        approvedByUserId: viewer.id,
      });
    }
    const status = decision === "approve" ? "approved" : "rejected";
    await this.closePendingAccessRequest(row.email, status, viewer.id);
    return { id: row.id, status };
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

    return this.withIdentity(mapManagedUserRow(row));
  }
}

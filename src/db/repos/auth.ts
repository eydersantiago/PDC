// AppDatabase, parte 2 de 12: entrar (correo y Google) y codigo de estudiante; siguen auth-sign-in.ts y auth-sessions.ts.
// Metodos movidos sin cambios desde src/db/database.ts. Cadena: DatabaseCore -> AuthDatabase -> UsersDatabase -> PolicyDatabase -> RagLotsDatabase -> RagSourcesDatabase -> GithubDatabase -> WorkspaceDatabase -> PilotDatabase -> TelemetryDatabase -> ProgressDatabase -> QuizDatabase -> AppDatabase
// (cada clase extiende a la anterior; db.metodo() sigue igual). private pasa a protected solo si otra clase lo usa.
import { randomUUID } from "node:crypto";
import type { AppUser, UserRoleCode } from "../../types/app.js";
import { hashPassword, mapActiveUserRow, verifyPassword } from "../rows.js";
import type { ActiveUserRow, CreateSessionOptions } from "../rows.js";
import { DEFAULT_RAG_COURSE_CODE } from "../../services/rag/rag-courses.js";
import { trimText } from "../../services/shared/text-utils.js";
import { isSampleAccountId } from "../../services/accounts/sample-accounts.js";
import {
  INSTITUTIONAL_EMAIL_DOMAIN,
  isInstitutionalEmail, personNamesEqual,
  personNameTokens
} from "../../services/auth/student-code.js";
import { DatabaseCore } from "./core.js";

export class AuthDatabase extends DatabaseCore {
  /**
   * Usuario activo con ese correo y clave, sin abrir sesion (el login HTTP decide antes si al
   * estudiante le falta el codigo). Solo el correo principal: los correos de acceso extra
   * (user_login_emails) entran con Google.
   */
  async verifyPasswordUser(email: string, password: string): Promise<AppUser | null> {
    const result = await this.pool.query<{
      user_id: string;
      teacher_user_id: string | null;
      email: string;
      display_name: string;
      password_hash: string;
      role: UserRoleCode;
    }>(
      `
      select
        u.id as user_id,
        u.teacher_user_id,
        u.email,
        u.display_name,
        u.password_hash,
        r.code as role
      from users u
      join roles r on r.id = u.role_id
      where lower(u.email) = lower($1)
        and u.is_active = true
      limit 1
      `,
      [email],
    );

    const row = result.rows[0];
    if (!row) return null;
    if (!verifyPassword(password, row.password_hash)) return null;
    return {
      id: row.user_id,
      role: row.role,
      email: row.email,
      displayName: row.display_name,
      teacherUserId: row.teacher_user_id,
    };
  }

  /**
   * Sesion directa con correo y clave, sin pedir el codigo de estudiante: la usan las pruebas y
   * los scripts. El login HTTP (/api/auth/login) pasa por resolveStudentSignIn.
   */
  async authenticateUser(email: string, password: string, options: { kind?: "browser" | "cli" } = {}) {
    const user = await this.verifyPasswordUser(email, password);
    if (!user) return null;
    return this.createSessionForUser(user, { kind: options.kind === "cli" ? "cli" : "browser" });
  }

  /**
   * Sesion directa con Google, sin pedir el codigo de estudiante (pruebas y scripts). El login
   * HTTP (/api/auth/google-login) pasa por resolveStudentSignIn.
   */
  async authenticateGoogleUser(input: {
    email: string;
    displayName: string;
    defaultPassword: string;
    kind?: "browser" | "cli";
  }) {
    const sessionOptions: CreateSessionOptions = { kind: input.kind === "cli" ? "cli" : "browser" };
    const existing = await this.findLoginAccount(input.email);
    if (existing) {
      if (!existing.isActive) {
        throw new Error("El usuario existe pero esta inactivo. Contacta al administrador.");
      }
      return this.createSessionForUser(existing.user, sessionOptions);
    }
    const created = await this.createGoogleStudent(input);
    return this.createSessionForUser(created, sessionOptions);
  }

  /** Estudiante nuevo que llega con Google: docente de las cuentas nuevas y el curso por defecto. */
  protected async createGoogleStudent(input: { email: string; displayName: string; defaultPassword: string }): Promise<AppUser> {
    const normalizedEmail = input.email.trim().toLowerCase();
    const normalizedDisplayName = input.displayName.trim();
    const role: UserRoleCode = "student";
    const roleId = await this.getRoleIdByCode(role);
    const defaultTeacherUserId = await this.getDefaultTeacherId();
    const created = await this.pool.query<{
      id: string;
      teacher_user_id: string | null;
      email: string;
      display_name: string;
    }>(
      `
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
        teacher_user_id,
        email,
        display_name
      `,
      [
        randomUUID(),
        roleId,
        defaultTeacherUserId,
        normalizedEmail,
        normalizedDisplayName || normalizedEmail.split("@")[0] || "Estudiante",
        hashPassword(input.defaultPassword),
      ],
    );

    const row = created.rows[0];
    if (!row) {
      throw new Error("No se pudo crear el usuario desde Google.");
    }
    await this.setUserCourseAssignments(row.id, [DEFAULT_RAG_COURSE_CODE], null);
    return {
      id: row.id,
      role,
      email: row.email,
      displayName: row.display_name,
      teacherUserId: row.teacher_user_id,
    };
  }

  // ---- Codigo de estudiante como identidad (navegador 0.7.22, src/services/auth/student-code.ts) ----

  /** Usuario por id con su estado (activo o no), o null. */
  protected async findUserWithStatus(userId: string): Promise<{ user: AppUser; isActive: boolean } | null> {
    const result = await this.pool.query<ActiveUserRow & { is_active: boolean }>(
      `
      select
        u.id as user_id,
        u.teacher_user_id,
        u.email,
        u.display_name,
        r.code as role,
        u.is_active
      from users u
      join roles r on r.id = u.role_id
      where u.id = $1
      limit 1
      `,
      [userId],
    );
    const row = result.rows[0];
    return row ? { user: mapActiveUserRow(row), isActive: row.is_active === true } : null;
  }

  /**
   * Cuenta con la que entra un correo: primero los correos de acceso extra (user_login_emails),
   * luego el correo principal. Devuelve tambien las desactivadas (para decir por que no entra).
   */
  protected async findLoginAccount(email: string): Promise<{ user: AppUser; isActive: boolean } | null> {
    const normalized = trimText(email).toLowerCase();
    if (!normalized) return null;
    const alias = await this.pool.query<{ user_id: string }>(
      `select user_id from user_login_emails where email = $1 limit 1`,
      [normalized],
    );
    if (alias.rows[0]) {
      const linked = await this.findUserWithStatus(alias.rows[0].user_id);
      if (linked) return linked;
    }
    const result = await this.pool.query<{ id: string }>(
      `select id from users where lower(email) = $1 limit 1`,
      [normalized],
    );
    return result.rows[0] ? this.findUserWithStatus(result.rows[0].id) : null;
  }

  /** Id de la cuenta con la que entra ese correo (principal o de acceso extra), o null. */
  async findLoginUserId(email: string): Promise<string | null> {
    return (await this.findLoginAccount(email))?.user.id || null;
  }

  async getStudentCodeForUser(userId: string): Promise<string | null> {
    const result = await this.pool.query<{ code: string }>(
      `select code from student_codes where user_id = $1 limit 1`,
      [userId],
    );
    return result.rows[0]?.code || null;
  }

  /**
   * Estudiante identificado (examen 28-10-2026): tiene codigo de estudiante o entra con un correo
   * institucional (el principal o uno de acceso extra). Google ya verifico ese correo y en Univalle
   * es de una sola persona, asi que basta para entrar sin escribir el codigo. Con Gmail sigue
   * haciendo falta el codigo: es lo que dice quien es.
   */
  async isStudentIdentified(userId: string): Promise<boolean> {
    if (await this.getStudentCodeForUser(userId)) return true;
    const primary = await this.pool.query<{ email: string }>(`select email from users where id = $1 limit 1`, [userId]);
    if (isInstitutionalEmail(primary.rows[0]?.email || "")) return true;
    const aliases = await this.pool.query<{ email: string }>(`select email from user_login_emails where user_id = $1`, [userId]);
    return aliases.rows.some((row) => isInstitutionalEmail(row.email));
  }

  /** Ids de los estudiantes identificados (codigo o correo institucional), para filtrar en bloque. */
  protected async listIdentifiedStudentIds(): Promise<Set<string>> {
    const ids = new Set<string>();
    const coded = await this.pool.query<{ user_id: string }>(`select user_id from student_codes`);
    for (const row of coded.rows) ids.add(row.user_id);
    const institutional = await this.pool.query<{ id: string }>(
      `select id from users where lower(email) like $1`,
      [`%@${INSTITUTIONAL_EMAIL_DOMAIN}`],
    );
    for (const row of institutional.rows) ids.add(row.id);
    const aliases = await this.pool.query<{ user_id: string }>(
      `select user_id from user_login_emails where lower(email) like $1`,
      [`%@${INSTITUTIONAL_EMAIL_DOMAIN}`],
    );
    for (const row of aliases.rows) ids.add(row.user_id);
    return ids;
  }

  protected async getStudentCodeOwnerId(code: string): Promise<string | null> {
    const result = await this.pool.query<{ user_id: string }>(
      `select user_id from student_codes where code = $1 limit 1`,
      [code],
    );
    return result.rows[0]?.user_id || null;
  }

  /** Si la cuenta abrio alguna vez una sesion (navegador, consola o editor). */
  /**
   * Filas de la lista que esperan a su estudiante: estudiantes activos que nunca entraron, sin codigo
   * y sin correo institucional (los importados con el Gmail de Campus), sin cuentas de muestra. Sin
   * subconsultas correlacionadas (pg-mem): tres lecturas y el filtro aqui.
   */
  protected async listUnclaimedRosterStudents(): Promise<Array<{ id: string; email: string; displayName: string; teacherUserId: string | null }>> {
    const [students, signedIn, coded, aliases] = await Promise.all([
      this.pool.query<{ id: string; email: string; display_name: string; teacher_user_id: string | null }>(
        `select id, email, display_name, teacher_user_id from users where role_id = 'role-student' and is_active = true`,
      ),
      this.pool.query<{ user_id: string }>(`select distinct user_id from app_sessions`),
      this.pool.query<{ user_id: string }>(`select user_id from student_codes`),
      this.pool.query<{ user_id: string }>(`select user_id from user_login_emails where lower(email) like $1`, [`%@${INSTITUTIONAL_EMAIL_DOMAIN}`]),
    ]);
    const taken = new Set([...signedIn.rows, ...coded.rows, ...aliases.rows].map((row) => row.user_id));
    return students.rows
      .filter((row) => !taken.has(row.id) && !isInstitutionalEmail(row.email) && !isSampleAccountId(row.id))
      .map((row) => ({ id: row.id, email: row.email, displayName: row.display_name, teacherUserId: row.teacher_user_id }));
  }

  /**
   * La unica fila de la lista que espera a alguien con exactamente ese nombre (personNamesEqual: sin
   * codigo que diga cual es, no basta un nombre parecido), o null si no hay o hay varias.
   *
   * Revision del 29-10-2026: sin codigo que diga cual fila es, el nombre tiene que bastar solo. Se
   * exigen al menos 3 palabras distintas (sin conectores: «Ana de la Cruz» son 2) y que NINGUN otro
   * estudiante activo, de cualquier grupo y haya entrado o no, tenga ese mismo nombre. Si no, se
   * crea la cuenta nueva como antes (y el panel marca el posible duplicado).
   */
  protected async findRosterRowByName(displayName: string): Promise<string | null> {
    if (personNameTokens(displayName).length < 3) return null;
    const matches = (await this.listUnclaimedRosterStudents()).filter((row) => personNamesEqual(displayName, row.displayName));
    if (matches.length !== 1) return null;
    const everyone = await this.pool.query<{ id: string; display_name: string }>(
      `select id, display_name from users where role_id = 'role-student' and is_active = true`,
    );
    const sameName = everyone.rows.filter((row) => !isSampleAccountId(row.id) && personNamesEqual(displayName, row.display_name));
    return sameName.length === 1 && sameName[0].id === matches[0].id ? matches[0].id : null;
  }

  protected async hasEverSignedIn(userId: string): Promise<boolean> {
    const result = await this.pool.query<{ id: string }>(
      `select id from app_sessions where user_id = $1 limit 1`,
      [userId],
    );
    return result.rows.length > 0;
  }

  /** Guarda el codigo de la cuenta; false si el codigo ya es de otra (o la cuenta ya tiene uno). */
  protected async insertStudentCode(code: string, userId: string, assignedByUserId: string | null): Promise<boolean> {
    const existing = await this.pool.query<{ code: string; user_id: string }>(
      `select code, user_id from student_codes where code = $1 or user_id = $2`,
      [code, userId],
    );
    if (existing.rows.length) {
      return existing.rows.some((row) => row.code === code && row.user_id === userId);
    }
    try {
      await this.pool.query(
        `insert into student_codes (code, user_id, assigned_by_user_id) values ($1, $2, $3)`,
        [code, userId, assignedByUserId],
      );
      return true;
    } catch {
      // Otra peticion lo guardo entre la consulta y el insert (llave primaria o unique).
      return (await this.getStudentCodeOwnerId(code)) === userId;
    }
  }
}

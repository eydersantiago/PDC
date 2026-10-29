// AppDatabase, parte 2 de 12: entrar (correo y Google), sesiones, emparejar el editor y buscar usuarios.
// Metodos movidos sin cambios desde src/db/database.ts. Cadena: DatabaseCore -> AuthDatabase -> UsersDatabase -> PolicyDatabase -> RagLotsDatabase -> RagSourcesDatabase -> GithubDatabase -> WorkspaceDatabase -> PilotDatabase -> TelemetryDatabase -> ProgressDatabase -> QuizDatabase -> AppDatabase
// (cada clase extiende a la anterior; db.metodo() sigue igual). private pasa a protected solo si otra clase lo usa.
import { randomUUID } from "node:crypto";
import type { AppUser, UserRoleCode } from "../../types/app.js";
import { hashPassword, mapActiveUserRow, mapSessionRow, verifyPassword } from "../rows.js";
import type { ActiveUserRow, CreateSessionOptions, SessionRow } from "../rows.js";
import { DEFAULT_RAG_COURSE_CODE } from "../../services/rag-courses.js";
import { trimText } from "../../services/text-utils.js";
import { isSampleAccountId } from "../../services/sample-accounts.js";
import {
  INSTITUTIONAL_EMAIL_DOMAIN,
  isInstitutionalEmail,
  maskEmail,
  normalizeStudentCode,
  personNamesEqual,
  personNameTokens,
  personNamesMatch,
  type StudentSignInResult,
} from "../../services/student-code.js";
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

  // ---- Codigo de estudiante como identidad (navegador 0.7.22, src/services/student-code.ts) ----

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

  /**
   * El correo pasa a ser otro acceso de la cuenta que prevalece (target). Si ese correo era de
   * otra cuenta (source, por ejemplo una importada de Campus), esa cuenta se une: sus correos
   * entran a target, su vinculo de GitHub pasa si target no tiene uno, queda desactivada con
   * merged_into_user_id, sin sesiones y sin cohorte. Sus eventos siguen con su id: sin codigo no
   * tuvo cohorte, asi que la limpieza del piloto ya los descarta (D4, sin condicion).
   * Nunca mueve un correo que ya entra a una tercera cuenta ni une una cuenta con codigo propio.
   */
  protected async mergeLoginEmailInto(input: {
    email: string;
    targetUserId: string;
    sourceUserId: string | null;
    approvedByUserId: string | null;
  }) {
    const email = trimText(input.email).toLowerCase();
    const target = await this.findUserWithStatus(input.targetUserId);
    if (!target) throw new Error("La cuenta del codigo ya no existe.");
    const sourceId = trimText(input.sourceUserId || "") || null;
    const current = await this.findLoginAccount(email);
    if (current && current.user.id !== input.targetUserId && current.user.id !== sourceId) {
      throw new Error("Ese correo ya entra a otra cuenta: no se puede unir.");
    }
    const source = sourceId && sourceId !== input.targetUserId ? await this.findUserWithStatus(sourceId) : null;
    if (source && await this.getStudentCodeForUser(source.user.id)) {
      throw new Error("La cuenta de ese correo ya tiene su propio codigo: es otra persona o hay que corregir el codigo a mano.");
    }
    const addAlias = async (aliasEmail: string) => {
      const clean = trimText(aliasEmail).toLowerCase();
      if (!clean || clean === target.user.email.toLowerCase()) return;
      await this.pool.query(
        `insert into user_login_emails (email, user_id, approved_by_user_id) values ($1, $2, $3) on conflict (email) do nothing`,
        [clean, input.targetUserId, input.approvedByUserId],
      );
      const row = await this.pool.query<{ user_id: string }>(`select user_id from user_login_emails where email = $1`, [clean]);
      const owner = row.rows[0]?.user_id;
      if (owner === input.targetUserId) return;
      if (source && owner === source.user.id) {
        await this.pool.query(
          `update user_login_emails set user_id = $2, approved_by_user_id = $3 where email = $1`,
          [clean, input.targetUserId, input.approvedByUserId],
        );
        return;
      }
      throw new Error("Ese correo ya entra a otra cuenta: no se puede unir.");
    };
    await addAlias(email);
    if (!source) return;
    await addAlias(source.user.email);
    await this.pool.query(
      `update user_login_emails set user_id = $2 where user_id = $1`,
      [source.user.id, input.targetUserId],
    );
    // El vinculo de GitHub (editor por GitHub en VS Code) pasa si la cuenta que queda no tiene.
    const targetGithub = await this.pool.query<{ id: string }>(
      `select id from github_user_tokens where user_id = $1 limit 1`,
      [input.targetUserId],
    );
    if (!targetGithub.rows.length) {
      await this.pool.query(`update github_user_tokens set user_id = $2 where user_id = $1`, [source.user.id, input.targetUserId]);
    }
    await this.pool.query(
      `update users set is_active = false, merged_into_user_id = $2 where id = $1`,
      [source.user.id, input.targetUserId],
    );
    await this.pool.query(
      `update app_sessions set is_active = false, last_seen_at = now() where user_id = $1`,
      [source.user.id],
    );
    await this.pool.query(`delete from pilot_assignments where student_user_id = $1`, [source.user.id]);
  }

  /** Id de la solicitud pendiente de un correo: una sola por correo, tambien con dos entradas a la vez. */
  protected pendingAccessRequestId(email: string) {
    return `pending:${trimText(email).toLowerCase()}`;
  }

  /**
   * Cierra la solicitud pendiente de un correo (al decidirla o porque ese correo ya entro de otra
   * forma): deja de ser «pending:<correo>» y queda con su estado. Devuelve si habia una.
   */
  protected async closePendingAccessRequest(email: string, status: "approved" | "rejected" | "superseded", decidedByUserId: string | null) {
    const result = await this.pool.query(
      `
      update student_access_requests
      set id = $2, status = $3, decided_at = now(), decided_by_user_id = $4
      where id = $1 and status = 'pending'
      `,
      [this.pendingAccessRequestId(email), randomUUID(), status, decidedByUserId],
    );
    return (result.rowCount || 0) > 0;
  }

  /**
   * Solicitud pendiente para entrar con un correo nuevo a la cuenta de un codigo (una por
   * correo, id «pending:<correo>»: si vuelve con otro codigo, se actualiza). Devuelve su fecha.
   */
  protected async upsertStudentAccessRequest(input: {
    email: string;
    displayName: string;
    studentCode: string;
    targetUserId: string;
    sourceUserId: string | null;
  }): Promise<string> {
    const id = this.pendingAccessRequestId(input.email);
    await this.pool.query(
      `
      insert into student_access_requests (id, email, display_name, student_code, target_user_id, source_user_id, status, created_at)
      values ($1, $2, $3, $4, $5, $6, 'pending', $7)
      on conflict (id) do update set
        display_name = excluded.display_name,
        student_code = excluded.student_code,
        target_user_id = excluded.target_user_id,
        source_user_id = excluded.source_user_id
      `,
      [id, input.email, input.displayName, input.studentCode, input.targetUserId, input.sourceUserId, new Date()],
    );
    const row = await this.pool.query<{ created_at: string | Date }>(
      `select created_at from student_access_requests where id = $1`,
      [id],
    );
    return new Date(row.rows[0]?.created_at || Date.now()).toISOString();
  }

  /**
   * Entrada de un correo ya verificado (Google o clave) con el codigo que escribio, si lo
   * escribio. Decide la cuenta (src/services/student-code.ts) y no abre la sesion: la abre la
   * ruta con openSessionForUser.
   *   - Docentes y administradores entran sin codigo.
   *   - Un estudiante con codigo entra; el codigo que mande se ignora.
   *   - Sin codigo: lo pide, tambien a un correo institucional nuevo (examen del 28-10-2026: 27 de
   *     39 estudiantes estaban en la lista con su Gmail de Campus; quien entro con el institucional
   *     cayo en una cuenta nueva y su fila de la lista quedo «Sin actividad»).
   *   - Con un codigo libre, queda en su cuenta. Si el correo es nuevo: un institucional va a su
   *     fila de la lista si una sola fila que nunca entro tiene exactamente su nombre
   *     (findRosterRowByName); si no, se crea la cuenta (create trae la clave de Google).
   *   - Con el codigo de otra cuenta: se une sola si esa cuenta nunca entro, el correo es nuevo (no
   *     tiene cuenta) y el nombre de quien llega coincide con el de la lista (personNamesMatch); si
   *     no, queda pendiente de aprobacion del docente.
   * Al entrar, se cierra la solicitud pendiente de ese correo (ya no hace falta decidirla).
   */
  async resolveStudentSignIn(input: {
    email: string;
    displayName: string;
    studentCode?: unknown;
    /** Login con clave: la cuenta ya verificada. */
    knownUserId?: string;
    /** Login con Google: con que clave crear la cuenta si el correo es nuevo. */
    create?: { defaultPassword: string };
  }, attempt = 0): Promise<StudentSignInResult> {
    const email = trimText(input.email).toLowerCase();
    const displayName = trimText(input.displayName).replace(/\s+/g, " ").slice(0, 120);
    const account = input.knownUserId
      ? await this.findUserWithStatus(input.knownUserId)
      : await this.findLoginAccount(email);
    if (account && !account.isActive) return { status: "inactive" };
    const ok = async (userId: string, extra: { created?: boolean; linkedEmail?: boolean } = {}): Promise<StudentSignInResult> => {
      await this.closePendingAccessRequest(email, "superseded", null);
      return { status: "ok", userId, created: extra.created === true, linkedEmail: extra.linkedEmail === true };
    };
    if (account && account.user.role !== "student") return ok(account.user.id);
    if (account && await this.isStudentIdentified(account.user.id)) return ok(account.user.id);

    const codeTyped = input.studentCode != null && trimText(String(input.studentCode)) !== "";
    if (!codeTyped) {
      return {
        status: "student_code_required",
        displayName: account?.user.displayName || displayName || email.split("@")[0] || "",
        email,
      };
    }
    const code = normalizeStudentCode(input.studentCode);
    if (!code) return { status: "invalid_code" };

    const ownerId = await this.getStudentCodeOwnerId(code);
    if (!ownerId) {
      const rosterId = !account && input.create && isInstitutionalEmail(email)
        ? await this.findRosterRowByName(displayName)
        : null;
      if (account) {
        if (await this.insertStudentCode(code, account.user.id, null)) return ok(account.user.id);
      } else if (rosterId) {
        if (await this.insertStudentCode(code, rosterId, null)) {
          await this.mergeLoginEmailInto({ email, targetUserId: rosterId, sourceUserId: null, approvedByUserId: null });
          return ok(rosterId, { linkedEmail: true });
        }
      } else if (input.create) {
        const created = await this.createGoogleStudent({ email, displayName, defaultPassword: input.create.defaultPassword });
        if (await this.insertStudentCode(code, created.id, null)) return ok(created.id, { created: true });
        // Otro se quedo con el codigo en el mismo instante: la cuenta recien creada sobra y se
        // borra (no tiene nada), para que este correo pueda volver a intentarlo.
        await this.pool.query(`delete from user_course_assignments where user_id = $1`, [created.id]);
        await this.pool.query(`delete from users where id = $1`, [created.id]);
      } else {
        return { status: "student_code_required", displayName, email };
      }
      if (attempt > 0) throw new Error("No se pudo guardar el codigo de estudiante. Intenta de nuevo.");
      return this.resolveStudentSignIn(input, attempt + 1);
    }

    const owner = await this.findUserWithStatus(ownerId);
    if (!owner || !owner.isActive) return { status: "inactive" };
    // Un codigo que quedo en una cuenta que ya no es de estudiante no da acceso a ella.
    if (owner.user.role !== "student") return { status: "code_unavailable" };
    if (account && account.user.id === owner.user.id) return ok(owner.user.id);

    const last = await this.pool.query<{ status: string }>(
      `
      select status
      from student_access_requests
      where email = $1 and student_code = $2 and status in ('pending', 'approved', 'rejected')
      order by created_at desc
      limit 1
      `,
      [email, code],
    );
    if (last.rows[0]?.status === "rejected") return { status: "rejected" };

    const sourceUserId = account?.user.id || null;
    const ownerSignedIn = await this.hasEverSignedIn(owner.user.id);
    // Solo una cuenta que alguien creo con ese codigo (docente, administrador o importacion), no
    // una que otro correo acaba de crear escribiendolo.
    const assigned = await this.pool.query<{ assigned_by_user_id: string | null }>(
      `select assigned_by_user_id from student_codes where code = $1 limit 1`,
      [code],
    );
    const codeFromRoster = !!assigned.rows[0]?.assigned_by_user_id;
    // Se une solo a la cuenta de la lista que nunca entro: un correo institucional nuevo (como
    // siempre) o, desde el examen del 28-10-2026, un Gmail cuando la cuenta de la lista tampoco es
    // institucional (la importada con el Gmail de Campus). Si la cuenta de la lista es institucional,
    // su dueño entra con Google institucional sin codigo: un Gmail ajeno con ese codigo no se la
    // queda. Una cuenta en uso sigue pidiendo aprobacion.
    const linkAllowed = isInstitutionalEmail(email) || !isInstitutionalEmail(owner.user.email);
    // Y solo si el nombre de quien llega es el de la lista: el codigo de un compañero no basta.
    const sameName = personNamesMatch(displayName, owner.user.displayName);
    if (!ownerSignedIn && codeFromRoster && !sourceUserId && linkAllowed && sameName) {
      await this.mergeLoginEmailInto({ email, targetUserId: owner.user.id, sourceUserId: null, approvedByUserId: null });
      return ok(owner.user.id, { linkedEmail: true });
    }
    const requestedAt = await this.upsertStudentAccessRequest({
      email,
      displayName: displayName || account?.user.displayName || "",
      studentCode: code,
      targetUserId: owner.user.id,
      sourceUserId,
    });
    return { status: "pending_approval", maskedEmail: maskEmail(owner.user.email), requestedAt };
  }

  /** Sesion de navegador o consola para una cuenta activa (despues de resolveStudentSignIn). */
  async openSessionForUser(userId: string, options: { kind?: "browser" | "cli" } = {}) {
    const found = await this.findUserWithStatus(userId);
    if (!found || !found.isActive) throw new Error("El usuario existe pero esta inactivo. Contacta al administrador.");
    return this.createSessionForUser(found.user, { kind: options.kind === "cli" ? "cli" : "browser" });
  }

  /** Estudiante activo sin codigo: no abre sesiones (tampoco de editor). */
  async studentLacksCode(userId: string): Promise<boolean> {
    const found = await this.findUserWithStatus(userId);
    if (!found || found.user.role !== "student") return false;
    return !(await this.isStudentIdentified(userId));
  }

  /**
   * Cierra las sesiones abiertas de estudiantes sin codigo (cada arranque): las de antes de la
   * 0.7.22 vuelven a pedir el codigo. Sin subconsultas correlacionadas (pg-mem).
   */
  async closeSessionsOfStudentsWithoutCode(): Promise<number> {
    const withCode = await this.listIdentifiedStudentIds();
    const open = await this.pool.query<{ user_id: string }>(
      `
      select distinct s.user_id
      from app_sessions s
      join users u on u.id = s.user_id
      where s.is_active = true
        and u.role_id = 'role-student'
      `,
    );
    let closed = 0;
    for (const row of open.rows) {
      if (withCode.has(row.user_id)) continue;
      const result = await this.pool.query(
        `update app_sessions set is_active = false, last_seen_at = now() where user_id = $1 and is_active = true`,
        [row.user_id],
      );
      closed += result.rowCount || 0;
    }
    return closed;
  }

  async getSession(sessionId: string) {
    // Las sesiones vencidas (editor) se rechazan igual que las inactivas.
    const result = await this.pool.query<SessionRow>(
      `
      select
        s.id as session_id,
        s.created_at,
        s.last_seen_at,
        s.kind,
        s.expires_at,
        s.label,
        u.id as user_id,
        r.code as role,
        u.email,
        u.display_name,
        u.teacher_user_id
      from app_sessions s
      join users u on u.id = s.user_id
      join roles r on r.id = u.role_id
      where s.id = $1
        and s.is_active = true
        and (s.expires_at is null or s.expires_at > now())
        and u.is_active = true
      limit 1
      `,
      [sessionId],
    );

    const row = result.rows[0];
    if (!row) return null;

    await this.pool.query(
      `update app_sessions set last_seen_at = now() where id = $1`,
      [sessionId],
    );

    row.last_seen_at = new Date().toISOString();
    row.assigned_course_codes = await this.listAssignedCourseCodesForUser(row.user_id, row.role);
    return mapSessionRow(row);
  }

  async logoutSession(sessionId: string) {
    await this.pool.query(
      `update app_sessions set is_active = false, last_seen_at = now() where id = $1`,
      [sessionId],
    );
  }

  /** Desvincula VS Code: desactiva todas las sesiones editor del usuario. */
  async deactivateEditorSessionsForUser(userId: string) {
    const result = await this.pool.query(
      `update app_sessions set is_active = false, last_seen_at = now() where user_id = $1 and kind = 'editor' and is_active = true`,
      [userId],
    );
    return result.rowCount || 0;
  }

  /**
   * Crea una sesion editor (VS Code) para un usuario activo. Devuelve null si
   * el usuario no existe o esta inactivo.
   */
  async createEditorSession(input: { userId: string; label: string; ttlMs: number }) {
    const user = await this.getActiveUserById(input.userId);
    if (!user) return null;
    // Sin codigo de estudiante no hay sesiones (0.7.22): tampoco la del editor.
    if (user.role === "student" && !(await this.isStudentIdentified(user.id))) return null;
    return this.createSessionForUser(user, {
      kind: "editor",
      label: input.label,
      expiresAt: new Date(Date.now() + Math.max(60_000, input.ttlMs)),
    });
  }

  /**
   * Sesion editor con esa etiqueta que siga activa al menos hasta minExpiresAt
   * (la mas lejana). La usa prepare para no crear una sesion en cada clic.
   */
  async findReusableEditorSession(input: { userId: string; label: string; minExpiresAt: Date }) {
    const found = await this.pool.query<{ id: string }>(
      `
      select id
      from app_sessions
      where user_id = $1
        and kind = 'editor'
        and label = $2
        and is_active = true
        and expires_at > $3
      order by expires_at desc
      limit 1
      `,
      [input.userId, input.label, input.minExpiresAt],
    );
    const sessionId = found.rows[0]?.id;
    return sessionId ? this.getSession(sessionId) : null;
  }

  /**
   * Guarda un codigo de emparejamiento (solo su hash). Pedir uno nuevo
   * invalida los no usados del mismo usuario; de paso se borran los vencidos
   * hace mas de un dia.
   */
  async createEditorPairingCode(input: { userId: string; codeHash: string; expiresAt: Date }) {
    await this.pool.query(
      `delete from editor_pairing_codes where user_id = $1 and used_at is null`,
      [input.userId],
    );
    await this.pool.query(
      `delete from editor_pairing_codes where expires_at < $1`,
      [new Date(Date.now() - 24 * 60 * 60 * 1000)],
    );
    await this.pool.query(
      `insert into editor_pairing_codes (code_hash, user_id, expires_at) values ($1, $2, $3)`,
      [input.codeHash, input.userId, input.expiresAt],
    );
  }

  /** Canje atomico: devuelve el usuario del codigo o null si no existe, ya se uso o vencio. */
  async claimEditorPairingCode(codeHash: string) {
    const result = await this.pool.query<{ user_id: string }>(
      `
      update editor_pairing_codes
      set used_at = now()
      where code_hash = $1
        and used_at is null
        and expires_at > now()
      returning user_id
      `,
      [codeHash],
    );
    return result.rows[0]?.user_id || null;
  }

  /**
   * Usuario activo de ADACEEN cuya cuenta de GitHub (vinculada por el OAuth
   * de ADACEEN) tiene ese login, sin distinguir mayusculas. Si hay varias
   * filas, gana la actualizada mas recientemente.
   */
  async findUserByGithubLogin(login: string): Promise<AppUser | null> {
    const clean = trimText(login);
    if (!clean) return null;
    const result = await this.pool.query<ActiveUserRow>(
      `
      select
        u.id as user_id,
        u.teacher_user_id,
        u.email,
        u.display_name,
        r.code as role
      from github_user_tokens t
      join users u on u.id = t.user_id
      join roles r on r.id = u.role_id
      where lower(t.account_login) = lower($1)
        and u.is_active = true
      order by t.updated_at desc
      limit 1
      `,
      [clean],
    );
    const row = result.rows[0];
    return row ? mapActiveUserRow(row) : null;
  }

  async getActiveUserById(userId: string): Promise<AppUser | null> {
    const result = await this.pool.query<ActiveUserRow>(
      `
      select
        u.id as user_id,
        u.teacher_user_id,
        u.email,
        u.display_name,
        r.code as role
      from users u
      join roles r on r.id = u.role_id
      where u.id = $1
        and u.is_active = true
      limit 1
      `,
      [userId],
    );
    const row = result.rows[0];
    return row ? mapActiveUserRow(row) : null;
  }
}

// AppDatabase: entrada del estudiante con codigo (unir correos, solicitudes de acceso pendientes y resolveStudentSignIn).
// Metodos movidos sin cambios desde src/db/repos/auth.ts; la clase va entre AuthDatabase y AuthSessionsDatabase.
import { randomUUID } from "node:crypto";
import { trimText } from "../../services/shared/text-utils.js";
import { isInstitutionalEmail, maskEmail, normalizeStudentCode, personNamesMatch, type StudentSignInResult } from "../../services/auth/student-code.js";
import { AuthDatabase } from "./auth.js";

export class StudentSignInDatabase extends AuthDatabase {
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
   * escribio. Decide la cuenta (src/services/auth/student-code.ts) y no abre la sesion: la abre la
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
}

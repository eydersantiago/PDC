// AppDatabase: sesiones (abrir, leer, cerrar), sesiones de VS Code, codigos de emparejamiento y buscar usuarios.
// Metodos movidos sin cambios desde src/db/repos/auth.ts; la clase va entre StudentSignInDatabase y UsersDatabase.
import type { AppUser } from "../../types/app.js";
import { mapActiveUserRow, mapSessionRow } from "../rows.js";
import type { ActiveUserRow, SessionRow } from "../rows.js";
import { trimText } from "../../services/shared/text-utils.js";
import { StudentSignInDatabase } from "./auth-sign-in.js";

export class AuthSessionsDatabase extends StudentSignInDatabase {
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

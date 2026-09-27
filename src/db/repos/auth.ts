// AppDatabase, parte 2 de 12: entrar (correo y Google), sesiones, emparejar el editor y buscar usuarios.
// Metodos movidos sin cambios desde src/db/database.ts. Cadena: DatabaseCore -> AuthDatabase -> UsersDatabase -> PolicyDatabase -> RagLotsDatabase -> RagSourcesDatabase -> GithubDatabase -> WorkspaceDatabase -> PilotDatabase -> TelemetryDatabase -> ProgressDatabase -> QuizDatabase -> AppDatabase
// (cada clase extiende a la anterior; db.metodo() sigue igual). private pasa a protected solo si otra clase lo usa.
import { randomUUID } from "node:crypto";
import type { AppUser, UserRoleCode } from "../../types/app.js";
import { hashPassword, mapActiveUserRow, mapSessionRow, verifyPassword } from "../rows.js";
import type { ActiveUserRow, CreateSessionOptions, SessionRow } from "../rows.js";
import { DEFAULT_RAG_COURSE_CODE } from "../../services/rag-courses.js";
import { trimText } from "../../services/text-utils.js";
import { DatabaseCore } from "./core.js";

export class AuthDatabase extends DatabaseCore {
  async authenticateUser(email: string, password: string, options: { kind?: "browser" | "cli" } = {}) {
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

    return this.createSessionForUser({
      id: row.user_id,
      role: row.role,
      email: row.email,
      displayName: row.display_name,
      teacherUserId: row.teacher_user_id,
    }, { kind: options.kind === "cli" ? "cli" : "browser" });
  }

  async authenticateGoogleUser(input: {
    email: string;
    displayName: string;
    defaultPassword: string;
    kind?: "browser" | "cli";
  }) {
    const sessionOptions: CreateSessionOptions = { kind: input.kind === "cli" ? "cli" : "browser" };
    const normalizedEmail = input.email.trim().toLowerCase();
    const normalizedDisplayName = input.displayName.trim();

    const existingResult = await this.pool.query<{
      user_id: string;
      teacher_user_id: string | null;
      email: string;
      display_name: string;
      role: UserRoleCode;
      is_active: boolean;
    }>(
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
      where lower(u.email) = lower($1)
      limit 1
      `,
      [normalizedEmail],
    );

    const existing = existingResult.rows[0];
    if (existing) {
      if (!existing.is_active) {
        throw new Error("El usuario existe pero esta inactivo. Contacta al administrador.");
      }
      return this.createSessionForUser({
        id: existing.user_id,
        role: existing.role,
        email: existing.email,
        displayName: existing.display_name,
        teacherUserId: existing.teacher_user_id,
      }, sessionOptions);
    }

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

    return this.createSessionForUser({
      id: row.id,
      role,
      email: row.email,
      displayName: row.display_name,
      teacherUserId: row.teacher_user_id,
    }, sessionOptions);
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

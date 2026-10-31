// AppDatabase, parte 7 de 12: GitHub App (instalaciones), OAuth de usuario y estado del devcontainer por repositorio.
// Metodos movidos sin cambios desde src/db/database.ts. Cadena: DatabaseCore -> AuthDatabase -> UsersDatabase -> PolicyDatabase -> RagLotsDatabase -> RagSourcesDatabase -> GithubDatabase -> WorkspaceDatabase -> PilotDatabase -> TelemetryDatabase -> ProgressDatabase -> QuizDatabase -> AppDatabase
// (cada clase extiende a la anterior; db.metodo() sigue igual). private pasa a protected solo si otra clase lo usa.
import { randomUUID } from "node:crypto";
import { normalizeRepoKey, toIso } from "../rows.js";
import type { GithubInstallStateRow, GithubInstallationRow, GithubOAuthStateRow, GithubRepoBootstrapRow, GithubUserTokenRow } from "../rows.js";
import type { AppUser } from "../../types/app.js";
import type { WorkshopStudentRef } from "../../services/workshop-progress.js";
import { RagSourcesDatabase } from "./rag-sources.js";
import { normalizeGithubLogin } from "../../services/github-repo-ref.js";

export class GithubDatabase extends RagSourcesDatabase {
  async createGithubInstallState(input: {
    userId: string;
    sessionId: string | null;
    repoFullName: string;
    state: string;
    ttlMinutes?: number;
  }) {
    const ttlMinutes = Number.isFinite(input.ttlMinutes)
      ? Math.max(2, Math.min(90, Math.floor(Number(input.ttlMinutes))))
      : 20;
    const expiresAt = new Date(Date.now() + ttlMinutes * 60 * 1000).toISOString();

    await this.pool.query(
      `
      insert into github_app_install_states (
        id,
        state,
        session_id,
        user_id,
        repo_full_name,
        expires_at
      )
      values (
        $1,
        $2,
        $3,
        $4,
        $5,
        $6::timestamptz
      )
      `,
      [
        randomUUID(),
        input.state,
        input.sessionId,
        input.userId,
        input.repoFullName,
        expiresAt,
      ],
    );
  }

  async consumeGithubInstallState(state: string) {
    const result = await this.pool.query<GithubInstallStateRow>(
      `
      update github_app_install_states
      set consumed_at = now()
      where state = $1
        and consumed_at is null
        and expires_at >= now()
      returning
        state,
        session_id,
        user_id,
        repo_full_name,
        expires_at
      `,
      [state],
    );

    const row = result.rows[0];
    if (!row) return null;

    return {
      state: row.state,
      sessionId: row.session_id,
      userId: row.user_id,
      repoFullName: row.repo_full_name,
      expiresAt: toIso(row.expires_at),
    };
  }

  async upsertGithubInstallation(input: {
    installationId: string;
    userId: string;
    accountLogin: string;
    accountType: string;
    repositorySelection: string;
  }) {
    const result = await this.pool.query<GithubInstallationRow>(
      `
      insert into github_app_installations (
        id,
        installation_id,
        user_id,
        account_login,
        account_type,
        repository_selection
      )
      values ($1, $2, $3, $4, $5, $6)
      on conflict (installation_id) do update
      set
        user_id = excluded.user_id,
        account_login = excluded.account_login,
        account_type = excluded.account_type,
        repository_selection = excluded.repository_selection,
        updated_at = now()
      returning
        installation_id,
        user_id,
        account_login,
        account_type,
        repository_selection,
        created_at,
        updated_at
      `,
      [
        randomUUID(),
        input.installationId,
        input.userId,
        input.accountLogin,
        input.accountType,
        input.repositorySelection,
      ],
    );

    const row = result.rows[0];
    return {
      installationId: row.installation_id,
      userId: row.user_id,
      accountLogin: row.account_login,
      accountType: row.account_type,
      repositorySelection: row.repository_selection,
      createdAt: toIso(row.created_at),
      updatedAt: toIso(row.updated_at),
    };
  }

  async getLatestGithubInstallationForUser(userId: string) {
    const result = await this.pool.query<GithubInstallationRow>(
      `
      select
        installation_id,
        user_id,
        account_login,
        account_type,
        repository_selection,
        created_at,
        updated_at
      from github_app_installations
      where user_id = $1
      order by updated_at desc
      limit 1
      `,
      [userId],
    );

    const row = result.rows[0];
    if (!row) return null;

    return {
      installationId: row.installation_id,
      userId: row.user_id,
      accountLogin: row.account_login,
      accountType: row.account_type,
      repositorySelection: row.repository_selection,
      createdAt: toIso(row.created_at),
      updatedAt: toIso(row.updated_at),
    };
  }

  async getGithubInstallationForUserById(userId: string, installationId: string) {
    const result = await this.pool.query<GithubInstallationRow>(
      `
      select
        installation_id,
        user_id,
        account_login,
        account_type,
        repository_selection,
        created_at,
        updated_at
      from github_app_installations
      where user_id = $1
        and installation_id = $2
      limit 1
      `,
      [userId, installationId],
    );

    const row = result.rows[0];
    if (!row) return null;

    return {
      installationId: row.installation_id,
      userId: row.user_id,
      accountLogin: row.account_login,
      accountType: row.account_type,
      repositorySelection: row.repository_selection,
      createdAt: toIso(row.created_at),
      updatedAt: toIso(row.updated_at),
    };
  }

  async createGithubOAuthState(input: {
    state: string;
    sessionId: string;
    userId: string;
    repoFullName?: string;
    ttlMinutes?: number;
  }) {
    const expiresAt = new Date(Date.now() + Math.max(1, input.ttlMinutes || 10) * 60 * 1000);
    await this.pool.query(
      `
      insert into github_oauth_states (
        id,
        state,
        session_id,
        user_id,
        repo_full_name,
        expires_at
      )
      values ($1, $2, $3, $4, $5, $6)
      `,
      [
        randomUUID(),
        input.state,
        input.sessionId,
        input.userId,
        normalizeRepoKey(input.repoFullName || ""),
        expiresAt,
      ],
    );
  }

  async consumeGithubOAuthState(state: string) {
    const result = await this.pool.query<GithubOAuthStateRow>(
      `
      update github_oauth_states
      set consumed_at = now()
      where state = $1
        and consumed_at is null
        and expires_at >= now()
      returning
        state,
        session_id,
        user_id,
        repo_full_name,
        expires_at
      `,
      [state],
    );

    const row = result.rows[0];
    if (!row) return null;

    return {
      state: row.state,
      sessionId: row.session_id,
      userId: row.user_id,
      repoFullName: row.repo_full_name,
      expiresAt: toIso(row.expires_at),
    };
  }

  async upsertGithubUserToken(input: {
    userId: string;
    accountLogin: string;
    accountEmail?: string;
    accessToken: string;
    tokenType?: string;
    scopes?: string;
  }) {
    const result = await this.pool.query<GithubUserTokenRow>(
      `
      insert into github_user_tokens (
        id,
        user_id,
        account_login,
        account_email,
        access_token,
        token_type,
        scopes
      )
      values ($1, $2, $3, $4, $5, $6, $7)
      on conflict (user_id) do update
      set
        account_login = excluded.account_login,
        account_email = excluded.account_email,
        access_token = excluded.access_token,
        token_type = excluded.token_type,
        scopes = excluded.scopes,
        updated_at = now()
      returning
        user_id,
        account_login,
        account_email,
        access_token,
        token_type,
        scopes,
        created_at,
        updated_at
      `,
      [
        randomUUID(),
        input.userId,
        input.accountLogin,
        input.accountEmail || "",
        input.accessToken,
        input.tokenType || "bearer",
        input.scopes || "",
      ],
    );

    const row = result.rows[0];
    return {
      userId: row.user_id,
      accountLogin: row.account_login,
      accountEmail: row.account_email,
      accessToken: row.access_token,
      tokenType: row.token_type,
      scopes: row.scopes,
      createdAt: toIso(row.created_at),
      updatedAt: toIso(row.updated_at),
    };
  }

  /**
   * Estudiantes que ve quien mira (el docente, los suyos; el administrador, todos), con el login
   * de GitHub que vincularon (null si no). Para el avance de los talleres (29-10-2026): la VM de
   * editores informa por login (/home/ws-<login>). Nunca devuelve el token.
   */
  async listStudentGithubLogins(viewer: AppUser): Promise<WorkshopStudentRef[]> {
    if (viewer.role !== "teacher" && viewer.role !== "admin") return [];
    const teacherScopeId = viewer.role === "teacher" ? viewer.id : "";
    const result = await this.pool.query<{
      id: string;
      email: string;
      display_name: string;
      teacher_display_name: string | null;
      is_active: boolean;
      account_login: string | null;
    }>(
      `
      select
        u.id,
        u.email,
        u.display_name,
        teacher.display_name as teacher_display_name,
        u.is_active,
        g.account_login
      from users u
      join roles r on r.id = u.role_id
      left join users teacher on teacher.id = u.teacher_user_id
      left join github_user_tokens g on g.user_id = u.id
      where r.code = 'student'
        and u.merged_into_user_id is null
        and ($1 = '' or u.teacher_user_id = $1)
      order by u.display_name asc
      `,
      [teacherScopeId],
    );
    return result.rows.map((row) => ({
      userId: row.id,
      displayName: row.display_name,
      email: row.email,
      teacherDisplayName: row.teacher_display_name || null,
      isActive: Boolean(row.is_active),
      githubLogin: normalizeGithubLogin(row.account_login) || null,
    }));
  }

  /**
   * Login de GitHub que vinculo un usuario (en minusculas), o null. Sin el token: para cruzar al
   * usuario con el informe de avance de la VM (GET /api/workshop-progress/me, 30-10-2026).
   */
  async getGithubLoginForUser(userId: string): Promise<string | null> {
    if (!userId) return null;
    const result = await this.pool.query<{ account_login: string | null }>(
      `
      select account_login
      from github_user_tokens
      where user_id = $1
      limit 1
      `,
      [userId],
    );
    return normalizeGithubLogin(result.rows[0]?.account_login) || null;
  }

  async getGithubUserTokenForUser(userId: string) {
    const result = await this.pool.query<GithubUserTokenRow>(
      `
      select
        user_id,
        account_login,
        account_email,
        access_token,
        token_type,
        scopes,
        created_at,
        updated_at
      from github_user_tokens
      where user_id = $1
      limit 1
      `,
      [userId],
    );

    const row = result.rows[0];
    if (!row) return null;

    return {
      userId: row.user_id,
      accountLogin: row.account_login,
      accountEmail: row.account_email,
      accessToken: row.access_token,
      tokenType: row.token_type,
      scopes: row.scopes,
      createdAt: toIso(row.created_at),
      updatedAt: toIso(row.updated_at),
    };
  }

  async getGithubRepoBootstrapState(userId: string, repoFullName: string) {
    const repoKey = normalizeRepoKey(repoFullName);
    if (!repoKey) return null;

    const result = await this.pool.query<GithubRepoBootstrapRow>(
      `
      select
        user_id,
        repo_full_name,
        is_bootstrapped,
        source,
        details,
        created_at,
        updated_at
      from github_repo_bootstrap_states
      where user_id = $1
        and repo_full_name = $2
      limit 1
      `,
      [userId, repoKey],
    );

    const row = result.rows[0];
    if (!row) return null;

    return {
      userId: row.user_id,
      repoFullName: row.repo_full_name,
      isBootstrapped: row.is_bootstrapped,
      source: row.source,
      details: row.details,
      createdAt: toIso(row.created_at),
      updatedAt: toIso(row.updated_at),
    };
  }

  async getLatestGithubRepoBootstrapStateByRepo(repoFullName: string) {
    const repoKey = normalizeRepoKey(repoFullName);
    if (!repoKey) return null;

    const result = await this.pool.query<GithubRepoBootstrapRow>(
      `
      select
        user_id,
        repo_full_name,
        is_bootstrapped,
        source,
        details,
        created_at,
        updated_at
      from github_repo_bootstrap_states
      where repo_full_name = $1
      order by updated_at desc
      limit 1
      `,
      [repoKey],
    );

    const row = result.rows[0];
    if (!row) return null;

    return {
      userId: row.user_id,
      repoFullName: row.repo_full_name,
      isBootstrapped: row.is_bootstrapped,
      source: row.source,
      details: row.details,
      createdAt: toIso(row.created_at),
      updatedAt: toIso(row.updated_at),
    };
  }

  async upsertGithubRepoBootstrapState(input: {
    userId: string;
    repoFullName: string;
    isBootstrapped: boolean;
    source?: string;
    details?: string;
  }) {
    const repoKey = normalizeRepoKey(input.repoFullName);
    if (!repoKey) {
      throw new Error("repoFullName requerido para guardar estado de bootstrap.");
    }

    const result = await this.pool.query<GithubRepoBootstrapRow>(
      `
      insert into github_repo_bootstrap_states (
        id,
        user_id,
        repo_full_name,
        is_bootstrapped,
        source,
        details
      )
      values ($1, $2, $3, $4, $5, $6)
      on conflict (user_id, repo_full_name) do update
      set
        is_bootstrapped = excluded.is_bootstrapped,
        source = excluded.source,
        details = excluded.details,
        updated_at = now()
      returning
        user_id,
        repo_full_name,
        is_bootstrapped,
        source,
        details,
        created_at,
        updated_at
      `,
      [
        randomUUID(),
        input.userId,
        repoKey,
        input.isBootstrapped,
        String(input.source || "").trim(),
        String(input.details || "").trim(),
      ],
    );

    const row = result.rows[0];
    return {
      userId: row.user_id,
      repoFullName: row.repo_full_name,
      isBootstrapped: row.is_bootstrapped,
      source: row.source,
      details: row.details,
      createdAt: toIso(row.created_at),
      updatedAt: toIso(row.updated_at),
    };
  }
}

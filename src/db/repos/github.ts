// AppDatabase, parte 7 de 12: GitHub App (estado de instalacion e instalaciones); siguen el OAuth de usuario y el devcontainer en github-tokens.ts.
// Metodos movidos sin cambios desde src/db/database.ts. Cadena: DatabaseCore -> AuthDatabase -> UsersDatabase -> PolicyDatabase -> RagLotsDatabase -> RagSourcesDatabase -> GithubDatabase -> WorkspaceDatabase -> PilotDatabase -> TelemetryDatabase -> ProgressDatabase -> QuizDatabase -> AppDatabase
// (cada clase extiende a la anterior; db.metodo() sigue igual). private pasa a protected solo si otra clase lo usa.
import { randomUUID } from "node:crypto";
import { toIso } from "../rows.js";
import type { GithubInstallStateRow, GithubInstallationRow } from "../rows.js";
import { RagSourcesWriteDatabase } from "./rag-sources-write.js";

export class GithubDatabase extends RagSourcesWriteDatabase {
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
}

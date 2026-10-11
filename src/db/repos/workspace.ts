// AppDatabase, parte 8 de 12: privacidad, consentimiento del espacio de trabajo, pestana activa, rack del contexto del proyecto
// y ajustes del sistema (app_settings, 0.7.19: el entorno de los estudiantes que elige el administrador; 0.7.21: el docente de las cuentas nuevas).
// Metodos movidos sin cambios desde src/db/database.ts. Cadena: DatabaseCore -> AuthDatabase -> UsersDatabase -> PolicyDatabase -> RagLotsDatabase -> RagSourcesDatabase -> GithubDatabase -> WorkspaceDatabase -> PilotDatabase -> TelemetryDatabase -> ProgressDatabase -> QuizDatabase -> AppDatabase
// (cada clase extiende a la anterior; db.metodo() sigue igual). private pasa a protected solo si otra clase lo usa.
import { randomUUID } from "node:crypto";
import { toIso } from "../rows.js";
import type { AppSetting, PrivacyAcceptance, UserActiveTabRow, WorkspaceConsentRow } from "../rows.js";
import { trimText } from "../../services/text-utils.js";
import { DEFAULT_TEACHER_SETTING_KEY } from "./core.js";
import { GithubDatabase } from "./github.js";

/** GET /api/admin/users (defaultTeacher) y PUT /api/admin/default-teacher. */
export type DefaultTeacherChoice = {
  teacherUserId: string | null;
  chosenTeacherUserId: string | null;
  /** admin: se usa el que eligio el administrador; oldest: el profesor activo mas antiguo. */
  source: "admin" | "oldest";
  /** El elegido ya no es un profesor activo (se usa el mas antiguo). */
  chosenInactive: boolean;
  updatedAt: string | null;
  updatedByName: string | null;
};

type AppSettingRow = {
  setting_key: string;
  setting_value: string;
  updated_by_user_id: string | null;
  updated_at: string | Date;
  updated_by_name: string | null;
};

export class WorkspaceDatabase extends GithubDatabase {
  /** Ajuste del sistema (app_settings) con el nombre de quien lo cambio, o null si no hay fila. */
  async getAppSetting(key: string): Promise<AppSetting | null> {
    const result = await this.pool.query<AppSettingRow>(
      `
      select s.setting_key, s.setting_value, s.updated_by_user_id, s.updated_at, u.display_name as updated_by_name
      from app_settings s
      left join users u on u.id = s.updated_by_user_id
      where s.setting_key = $1
      `,
      [key],
    );
    const row = result.rows[0];
    if (!row) return null;
    return {
      key: row.setting_key,
      value: row.setting_value,
      updatedByUserId: row.updated_by_user_id || null,
      updatedByName: row.updated_by_name || null,
      updatedAt: toIso(row.updated_at),
    };
  }

  /**
   * Guarda un ajuste del sistema; con value null lo borra (vuelve a mandar la variable del
   * servidor). Devuelve la fila como queda, o null si se borro.
   */
  async setAppSetting(key: string, value: string | null, updatedByUserId: string | null): Promise<AppSetting | null> {
    if (value === null) {
      await this.pool.query("delete from app_settings where setting_key = $1", [key]);
      return null;
    }
    await this.pool.query(
      `
      insert into app_settings (setting_key, setting_value, updated_by_user_id, updated_at)
      values ($1, $2, $3, now())
      on conflict (setting_key) do update
      set setting_value = excluded.setting_value,
          updated_by_user_id = excluded.updated_by_user_id,
          updated_at = excluded.updated_at
      `,
      [key, value, updatedByUserId],
    );
    return this.getAppSetting(key);
  }

  /**
   * Docente de las cuentas nuevas (navegador 0.7.21; ver getDefaultTeacherId): el que eligio el
   * administrador en «Usuarios» (chosenTeacherUserId) y el que de verdad se usa
   * (teacherUserId: el elegido si sigue activo; si no, el profesor activo mas antiguo).
   */
  async getDefaultTeacherChoice(): Promise<DefaultTeacherChoice> {
    const setting = await this.getAppSetting(DEFAULT_TEACHER_SETTING_KEY);
    const effectiveId = (await this.getDefaultTeacherId()) || null;
    const chosenId = trimText(setting?.value || "") || null;
    const chosenInUse = Boolean(chosenId && chosenId === effectiveId);
    return {
      teacherUserId: effectiveId,
      chosenTeacherUserId: chosenId,
      source: chosenInUse ? "admin" : "oldest",
      chosenInactive: Boolean(chosenId && !chosenInUse),
      updatedAt: setting?.updatedAt || null,
      updatedByName: setting?.updatedByName || null,
    };
  }

  /** Elige el docente de las cuentas nuevas (un profesor activo) o, con null, vuelve al mas antiguo. */
  async setDefaultTeacher(teacherUserId: string | null, updatedByUserId: string) {
    const id = trimText(teacherUserId || "");
    if (id) await this.resolveTeacherUserId(id);
    await this.setAppSetting(DEFAULT_TEACHER_SETTING_KEY, id || null, updatedByUserId || null);
    return this.getDefaultTeacherChoice();
  }

  /**
   * Ultima version de la politica de privacidad que acepto el usuario (en
   * cualquier navegador o equipo), con la fecha en que la acepto por primera
   * vez. Las versiones son fechas AAAA-MM-DD: la mayor es la mas nueva, asi
   * aceptar despues una version anterior no la baja. Sin aceptacion, null.
   */
  async getPrivacyAcceptance(userId: string): Promise<PrivacyAcceptance> {
    if (!userId) return { version: null, acceptedAt: null };
    const result = await this.pool.query<{ policy_version: string; accepted_at: string | Date }>(
      `
      select policy_version, accepted_at
      from user_privacy_acceptances
      where user_id = $1
      order by policy_version desc
      limit 1
      `,
      [userId],
    );
    const row = result.rows[0];
    if (!row) return { version: null, acceptedAt: null };
    return { version: row.policy_version || null, acceptedAt: row.accepted_at ? toIso(row.accepted_at) : null };
  }

  /**
   * Registra que el usuario acepto esa version. Aceptarla de nuevo (otro
   * navegador, la migracion de la extension) no cambia la fecha: queda la de
   * la primera vez. Quien llama valida que la version exista.
   */
  async savePrivacyAcceptance(userId: string, version: string): Promise<PrivacyAcceptance> {
    await this.pool.query(
      `
      insert into user_privacy_acceptances (user_id, policy_version, accepted_at)
      values ($1, $2, now())
      on conflict (user_id, policy_version) do nothing
      `,
      [userId, version],
    );
    return this.getPrivacyAcceptance(userId);
  }

  async getWorkspaceConsent(userId: string) {
    const result = await this.pool.query<WorkspaceConsentRow>(
      `
      select
        user_id,
        can_read,
        can_modify,
        can_analyze,
        granted_at,
        updated_at
      from user_workspace_consents
      where user_id = $1
      limit 1
      `,
      [userId],
    );

    const row = result.rows[0];
    if (!row) {
      return {
        userId,
        canRead: false,
        canModify: false,
        canAnalyze: false,
        granted: false,
        grantedAt: null,
        updatedAt: null,
      };
    }

    const granted = row.can_read && row.can_modify && row.can_analyze;
    return {
      userId: row.user_id,
      canRead: row.can_read,
      canModify: row.can_modify,
      canAnalyze: row.can_analyze,
      granted,
      grantedAt: row.granted_at ? toIso(row.granted_at) : null,
      updatedAt: row.updated_at ? toIso(row.updated_at) : null,
    };
  }

  async upsertWorkspaceConsent(
    userId: string,
    input: {
      canRead: boolean;
      canModify: boolean;
      canAnalyze: boolean;
    },
  ) {
    const shouldMarkGranted = input.canRead && input.canModify && input.canAnalyze;

    const result = await this.pool.query<WorkspaceConsentRow>(
      `
      insert into user_workspace_consents (
        id,
        user_id,
        can_read,
        can_modify,
        can_analyze,
        granted_at,
        updated_at
      )
      values ($1, $2, $3, $4, $5, now(), now())
      on conflict (user_id) do update
      set
        can_read = excluded.can_read,
        can_modify = excluded.can_modify,
        can_analyze = excluded.can_analyze,
        granted_at = case
          when excluded.can_read = true and excluded.can_modify = true and excluded.can_analyze = true
            then now()
          else user_workspace_consents.granted_at
        end,
        updated_at = now()
      returning
        user_id,
        can_read,
        can_modify,
        can_analyze,
        granted_at,
        updated_at
      `,
      [
        randomUUID(),
        userId,
        input.canRead,
        input.canModify,
        input.canAnalyze,
      ],
    );

    const row = result.rows[0];
    return {
      userId: row.user_id,
      canRead: row.can_read,
      canModify: row.can_modify,
      canAnalyze: row.can_analyze,
      granted: row.can_read && row.can_modify && row.can_analyze,
      grantedAt: shouldMarkGranted ? toIso(row.granted_at) : null,
      updatedAt: toIso(row.updated_at),
    };
  }

  async getActiveTabForUser(userId: string) {
    const result = await this.pool.query<UserActiveTabRow>(
      `
      select
        user_id,
        session_id,
        tab_id,
        tab_url,
        tab_title,
        view_context,
        is_active,
        seen_at,
        created_at,
        updated_at
      from user_active_tabs
      where user_id = $1
      limit 1
      `,
      [userId],
    );

    const row = result.rows[0];
    if (!row) return null;

    return {
      userId: row.user_id,
      sessionId: row.session_id,
      tabId: row.tab_id,
      tabUrl: row.tab_url,
      tabTitle: row.tab_title,
      viewContext: row.view_context,
      isActive: row.is_active,
      seenAt: toIso(row.seen_at),
      createdAt: toIso(row.created_at),
      updatedAt: toIso(row.updated_at),
    };
  }

  async saveActiveTabForUser(input: {
    userId: string;
    sessionId?: string | null;
    tabId: string;
    tabUrl: string;
    tabTitle: string;
    viewContext?: string;
    isActive?: boolean;
  }) {
    const normalizedUserId = trimText(input.userId);
    if (!normalizedUserId) {
      throw new Error("userId requerido para guardar estado de pestaña activa.");
    }

    const isActive = input.isActive !== false;
    const result = await this.pool.query<UserActiveTabRow>(
      `
      insert into user_active_tabs (
        id,
        user_id,
        session_id,
        tab_id,
        tab_url,
        tab_title,
        view_context,
        is_active,
        seen_at,
        updated_at
      )
      values ($1, $2, $3, $4, $5, $6, $7, $8, now(), now())
      on conflict (user_id) do update
      set
        session_id = excluded.session_id,
        tab_id = excluded.tab_id,
        tab_url = excluded.tab_url,
        tab_title = excluded.tab_title,
        view_context = excluded.view_context,
        is_active = excluded.is_active,
        seen_at = now(),
        updated_at = now()
      returning
        user_id,
        session_id,
        tab_id,
        tab_url,
        tab_title,
        view_context,
        is_active,
        seen_at,
        created_at,
        updated_at
      `,
      [
        randomUUID(),
        normalizedUserId,
        trimText(input.sessionId || "" ) || null,
        trimText(input.tabId),
        trimText(input.tabUrl),
        trimText(input.tabTitle),
        trimText(input.viewContext || ""),
        isActive,
      ],
    );

    const row = result.rows[0];
    if (!row) return null;
    return {
      userId: row.user_id,
      sessionId: row.session_id,
      tabId: row.tab_id,
      tabUrl: row.tab_url,
      tabTitle: row.tab_title,
      viewContext: row.view_context,
      isActive: row.is_active,
      seenAt: toIso(row.seen_at),
      createdAt: toIso(row.created_at),
      updatedAt: toIso(row.updated_at),
    };
  }

  /**
   * Marca inactiva la pestana activa del usuario. Con tabId solo si esa es la activa: la
   * pestana que se oculta ya no borra a la que tomo el foco (A12.12). Sin tabId (clientes
   * viejos) se comporta como antes.
   */
  async clearActiveTabForUser(userId: string, tabId = "") {
    const result = await this.pool.query<UserActiveTabRow>(
      `
      update user_active_tabs
      set
        is_active = false,
        seen_at = now(),
        updated_at = now()
      where user_id = $1
        and ($2 = '' or tab_id = $2)
      returning
        user_id,
        session_id,
        tab_id,
        tab_url,
        tab_title,
        view_context,
        is_active,
        seen_at,
        created_at,
        updated_at
      `,
      [userId, tabId],
    );

    const row = result.rows[0];
    if (!row) return null;
    return {
      userId: row.user_id,
      sessionId: row.session_id,
      tabId: row.tab_id,
      tabUrl: row.tab_url,
      tabTitle: row.tab_title,
      viewContext: row.view_context,
      isActive: row.is_active,
      seenAt: toIso(row.seen_at),
      createdAt: toIso(row.created_at),
      updatedAt: toIso(row.updated_at),
    };
  }

  async saveProjectContextRack(input: {
    sessionId: string;
    userId: string;
    source: string;
    repoFullName: string;
    branch: string;
    totalEntries: number;
    totalFiles: number;
    totalFolders: number;
    files: string[];
    folders: string[];
    activeFilePath: string;
    activeCodeSnippet: string;
    activeSuggestion?: string;
    replacementOptions?: unknown[];
    generatedAt?: string;
  }) {
    const result = await this.pool.query<{ id: string }>(
      `
      insert into project_context_racks (
        id,
        session_id,
        user_id,
        source,
        repo_full_name,
        branch,
        total_entries,
        total_files,
        total_folders,
        files,
        folders,
        active_file_path,
        active_code_snippet,
        active_suggestion,
        replacement_options,
        generated_at
      )
      values (
        $1,
        $2,
        $3,
        $4,
        $5,
        $6,
        $7,
        $8,
        $9,
        $10::jsonb,
        $11::jsonb,
        $12,
        $13,
        $14,
        $15::jsonb,
        coalesce($16::timestamptz, now())
      )
      returning id
      `,
      [
        randomUUID(),
        input.sessionId,
        input.userId,
        input.source,
        input.repoFullName,
        input.branch,
        input.totalEntries,
        input.totalFiles,
        input.totalFolders,
        JSON.stringify(input.files),
        JSON.stringify(input.folders),
        input.activeFilePath,
        input.activeCodeSnippet,
        trimText(input.activeSuggestion || ""),
        JSON.stringify(Array.isArray(input.replacementOptions) ? input.replacementOptions : []),
        input.generatedAt || null,
      ],
    );

    return result.rows[0]?.id || null;
  }
}

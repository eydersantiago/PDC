import { randomUUID, scryptSync, timingSafeEqual } from "node:crypto";
import { Pool } from "pg";
import { newDb } from "pg-mem";
import { env } from "../config/env.js";
import { seedRoles, seedTeacherPolicy, seedUsers } from "./seeds.js";
import { schemaStatements } from "./schema.js";
import type { AppSession, AppUser, TeacherPolicy, TelemetryItem, UserRoleCode } from "../types/app.js";

type SessionRow = {
  session_id: string;
  created_at: string | Date;
  last_seen_at: string | Date;
  user_id: string;
  role: UserRoleCode;
  email: string;
  display_name: string;
  teacher_user_id: string | null;
};

type PolicyRow = {
  id: string;
  teacher_user_id: string;
  policy_name: string;
  outcome: string;
  tone: TeacherPolicy["tone"];
  frequency: TeacherPolicy["frequency"];
  help_level: TeacherPolicy["helpLevel"];
  allow_mini_quiz: boolean;
  strict_no_solution: boolean;
  max_hints_per_exercise: number | null;
  fallback_message: string;
  custom_instruction: string;
  allowed_interventions: TeacherPolicy["allowedInterventions"];
  allowed_topics: TeacherPolicy["allowedTopics"];
  event_rules: TeacherPolicy["eventRules"];
  updated_at: string | Date;
};

type WorkspaceConsentRow = {
  user_id: string;
  can_read: boolean;
  can_modify: boolean;
  can_analyze: boolean;
  granted_at: string | Date;
  updated_at: string | Date;
};

type GithubInstallStateRow = {
  state: string;
  session_id: string | null;
  user_id: string;
  repo_full_name: string;
  expires_at: string | Date;
};

type GithubInstallationRow = {
  installation_id: string;
  user_id: string;
  account_login: string;
  account_type: string;
  repository_selection: string;
  created_at: string | Date;
  updated_at: string | Date;
};

type GithubRepoBootstrapRow = {
  user_id: string;
  repo_full_name: string;
  is_bootstrapped: boolean;
  source: string;
  details: string;
  created_at: string | Date;
  updated_at: string | Date;
};

type ManagedUserRow = {
  id: string;
  role: UserRoleCode;
  email: string;
  display_name: string;
  teacher_user_id: string | null;
  teacher_display_name: string | null;
  is_active: boolean;
  created_at: string | Date;
};

function toIso(value: string | Date) {
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
}

function normalizeRepoKey(repoFullName: string) {
  return String(repoFullName || "").trim().toLowerCase();
}

function mapSessionRow(row: SessionRow): AppSession {
  return {
    id: row.session_id,
    createdAt: toIso(row.created_at),
    lastSeenAt: toIso(row.last_seen_at),
    user: {
      id: row.user_id,
      role: row.role,
      email: row.email,
      displayName: row.display_name,
      teacherUserId: row.teacher_user_id,
    },
  };
}

function mapPolicyRow(row: PolicyRow): TeacherPolicy {
  return {
    id: row.id,
    teacherUserId: row.teacher_user_id,
    policyName: row.policy_name,
    outcome: row.outcome,
    tone: row.tone,
    frequency: row.frequency,
    helpLevel: row.help_level,
    allowMiniQuiz: row.allow_mini_quiz,
    strictNoSolution: row.strict_no_solution,
    maxHintsPerExercise: row.max_hints_per_exercise,
    fallbackMessage: row.fallback_message,
    customInstruction: row.custom_instruction,
    allowedInterventions: Array.isArray(row.allowed_interventions) ? row.allowed_interventions : [],
    allowedTopics: Array.isArray(row.allowed_topics) ? row.allowed_topics : [],
    eventRules: row.event_rules || {},
    updatedAt: toIso(row.updated_at),
  };
}

function verifyPassword(rawPassword: string, storedHash: string) {
  const [salt, hash] = String(storedHash || "").split(":");
  if (!salt || !hash) return false;

  const derived = scryptSync(rawPassword, salt, 64);
  const stored = Buffer.from(hash, "hex");
  if (stored.length !== derived.length) return false;
  return timingSafeEqual(stored, derived);
}

function hashPassword(rawPassword: string) {
  const salt = randomUUID().replace(/-/g, "");
  const derived = scryptSync(rawPassword, salt, 64).toString("hex");
  return `${salt}:${derived}`;
}

function mapManagedUserRow(row: ManagedUserRow) {
  return {
    id: row.id,
    role: row.role,
    email: row.email,
    displayName: row.display_name,
    teacherUserId: row.teacher_user_id,
    teacherDisplayName: row.teacher_display_name,
    isActive: row.is_active,
    createdAt: toIso(row.created_at),
  };
}

export class AppDatabase {
  readonly pool: Pool;
  readonly provider: "postgres" | "memory-postgres";

  constructor(pool: Pool, provider: "postgres" | "memory-postgres") {
    this.pool = pool;
    this.provider = provider;
  }

  async initialize() {
    for (const statement of schemaStatements) {
      await this.pool.query(statement);
    }

    await this.seed();
  }

  async close() {
    await this.pool.end();
  }

  async authenticateUser(email: string, password: string) {
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

    const user: AppUser = {
      id: row.user_id,
      role: row.role,
      email: row.email,
      displayName: row.display_name,
      teacherUserId: row.teacher_user_id,
    };

    const sessionId = randomUUID();
    const inserted = await this.pool.query<SessionRow>(
      `
      insert into app_sessions (id, user_id)
      values ($1, $2)
      returning
        id as session_id,
        created_at,
        last_seen_at,
        $2::text as user_id,
        $3::text as role,
        $4::text as email,
        $5::text as display_name,
        $6::text as teacher_user_id
      `,
      [
        sessionId,
        user.id,
        user.role,
        user.email,
        user.displayName,
        user.teacherUserId,
      ],
    );

    return mapSessionRow(inserted.rows[0]);
  }

  async getSession(sessionId: string) {
    const result = await this.pool.query<SessionRow>(
      `
      select
        s.id as session_id,
        s.created_at,
        s.last_seen_at,
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
    return mapSessionRow(row);
  }

  async logoutSession(sessionId: string) {
    await this.pool.query(
      `update app_sessions set is_active = false, last_seen_at = now() where id = $1`,
      [sessionId],
    );
  }

  async listManagedUsers() {
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
      order by
        case r.code
          when 'teacher' then 0
          else 1
        end,
        u.display_name asc
      `,
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
      order by u.display_name asc
      `,
    );

    return {
      users: usersResult.rows.map(mapManagedUserRow),
      teachers: teachersResult.rows.map((row) => ({
        id: row.id,
        email: row.email,
        displayName: row.display_name,
      })),
    };
  }

  async createManagedUser(input: {
    role: "student" | "teacher";
    email: string;
    displayName: string;
    password: string;
    teacherUserId?: string | null;
  }) {
    const role = input.role === "teacher" ? "teacher" : "student";
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
        randomUUID(),
        roleId,
        teacherUserId,
        input.email.trim().toLowerCase(),
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
    }

    return mapManagedUserRow(row);
  }

  async updateManagedUser(userId: string, input: {
    role?: "student" | "teacher";
    email?: string;
    displayName?: string;
    password?: string;
    teacherUserId?: string | null;
    isActive?: boolean;
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

    const nextRole = input.role === "teacher" || input.role === "student"
      ? input.role
      : existing.role;
    const roleId = await this.getRoleIdByCode(nextRole);
    const nextTeacherUserId = nextRole === "student"
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

    const updated = await this.pool.query<ManagedUserRow>(
      `
      with updated_user as (
        update users u
        set
          role_id = $2,
          teacher_user_id = $3,
          email = $4,
          display_name = $5,
          password_hash = coalesce($6, u.password_hash),
          is_active = $7
        where u.id = $1
        returning
          u.id,
          u.role_id,
          u.teacher_user_id,
          u.email,
          u.display_name,
          u.is_active,
          u.created_at
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
    }

    if (!row.is_active) {
      await this.pool.query(
        `update app_sessions set is_active = false, last_seen_at = now() where user_id = $1`,
        [row.id],
      );
    }

    return mapManagedUserRow(row);
  }

  async deactivateManagedUser(userId: string) {
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
        limit 1
      ),
      updated_user as (
        update users u
        set is_active = false
        from target t
        where u.id = t.id
        returning
          u.id,
          u.role_id,
          u.teacher_user_id,
          u.email,
          u.display_name,
          u.is_active,
          u.created_at
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
      [userId],
    );

    const row = updated.rows[0];
    if (!row) {
      throw new Error("Usuario no encontrado o no administrable.");
    }

    await this.pool.query(
      `update app_sessions set is_active = false, last_seen_at = now() where user_id = $1`,
      [row.id],
    );

    return mapManagedUserRow(row);
  }

  async getTeacherPolicyForUser(user: AppUser) {
    const teacherUserId = user.role === "teacher"
      ? user.id
      : user.teacherUserId || await this.getDefaultTeacherId();

    if (!teacherUserId) return null;

    const result = await this.pool.query<PolicyRow>(
      `
      select
        id,
        teacher_user_id,
        policy_name,
        outcome,
        tone,
        frequency,
        help_level,
        allow_mini_quiz,
        strict_no_solution,
        max_hints_per_exercise,
        fallback_message,
        custom_instruction,
        allowed_interventions,
        allowed_topics,
        event_rules,
        updated_at
      from teacher_policies
      where teacher_user_id = $1
      limit 1
      `,
      [teacherUserId],
    );

    const row = result.rows[0];
    return row ? mapPolicyRow(row) : null;
  }

  async updateTeacherPolicy(teacherUserId: string, input: Partial<TeacherPolicy>) {
    const current = await this.getTeacherPolicyForUser({
      id: teacherUserId,
      role: "teacher",
      email: "",
      displayName: "",
      teacherUserId: null,
    });
    if (!current) {
      throw new Error("No existe politica activa para este docente.");
    }

    const nextPolicy: TeacherPolicy = {
      ...current,
      ...input,
      teacherUserId,
      updatedAt: new Date().toISOString(),
    };

    const result = await this.pool.query<PolicyRow>(
      `
      update teacher_policies
      set
        policy_name = $2,
        outcome = $3,
        tone = $4,
        frequency = $5,
        help_level = $6,
        allow_mini_quiz = $7,
        strict_no_solution = $8,
        max_hints_per_exercise = $9,
        fallback_message = $10,
        custom_instruction = $11,
        allowed_interventions = $12::jsonb,
        allowed_topics = $13::jsonb,
        event_rules = $14::jsonb,
        updated_at = now()
      where teacher_user_id = $1
      returning
        id,
        teacher_user_id,
        policy_name,
        outcome,
        tone,
        frequency,
        help_level,
        allow_mini_quiz,
        strict_no_solution,
        max_hints_per_exercise,
        fallback_message,
        custom_instruction,
        allowed_interventions,
        allowed_topics,
        event_rules,
        updated_at
      `,
      [
        teacherUserId,
        nextPolicy.policyName,
        nextPolicy.outcome,
        nextPolicy.tone,
        nextPolicy.frequency,
        nextPolicy.helpLevel,
        nextPolicy.allowMiniQuiz,
        nextPolicy.strictNoSolution,
        nextPolicy.maxHintsPerExercise,
        nextPolicy.fallbackMessage,
        nextPolicy.customInstruction,
        JSON.stringify(nextPolicy.allowedInterventions),
        JSON.stringify(nextPolicy.allowedTopics),
        JSON.stringify(nextPolicy.eventRules),
      ],
    );

    return mapPolicyRow(result.rows[0]);
  }

  async getHintUsage(studentUserId: string, exerciseKey: string) {
    const result = await this.pool.query<{ hint_count: number }>(
      `
      select hint_count
      from student_exercise_progress
      where student_user_id = $1 and exercise_key = $2
      limit 1
      `,
      [studentUserId, exerciseKey],
    );

    return result.rows[0]?.hint_count || 0;
  }

  async incrementHintUsage(studentUserId: string, exerciseKey: string) {
    const existing = await this.pool.query<{ id: string; hint_count: number }>(
      `
      select id, hint_count
      from student_exercise_progress
      where student_user_id = $1 and exercise_key = $2
      limit 1
      `,
      [studentUserId, exerciseKey],
    );

    if (existing.rows[0]) {
      await this.pool.query(
        `
        update student_exercise_progress
        set hint_count = hint_count + 1, last_intervention_at = now()
        where id = $1
        `,
        [existing.rows[0].id],
      );
      return existing.rows[0].hint_count + 1;
    }

    await this.pool.query(
      `
      insert into student_exercise_progress (id, student_user_id, exercise_key, hint_count)
      values ($1, $2, $3, 1)
      `,
      [randomUUID(), studentUserId, exerciseKey],
    );
    return 1;
  }

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
        coalesce($14::timestamptz, now())
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
        input.generatedAt || null,
      ],
    );

    return result.rows[0]?.id || null;
  }

  async recordTelemetry(input: {
    sessionId: string;
    studentUserId: string | null;
    teacherUserId: string | null;
    eventType: string;
    interventionType: string;
    detailLevel: string;
    policyName: string;
    exerciseKey: string | null;
    blocked: boolean;
    reason: string;
    contextSummary: string;
    policySnapshot: object;
  }) {
    const id = randomUUID();

    await this.pool.query(
      `
      insert into intervention_telemetry (
        id,
        session_id,
        student_user_id,
        teacher_user_id,
        event_type,
        intervention_type,
        detail_level,
        policy_name,
        exercise_key,
        blocked,
        reason,
        context_summary,
        policy_snapshot
      )
      values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13::jsonb)
      `,
      [
        id,
        input.sessionId,
        input.studentUserId,
        input.teacherUserId,
        input.eventType,
        input.interventionType,
        input.detailLevel,
        input.policyName,
        input.exerciseKey,
        input.blocked,
        input.reason,
        input.contextSummary,
        JSON.stringify(input.policySnapshot),
      ],
    );

    return id;
  }

  async listTelemetryForTeacher(teacherUserId: string, limit = 10) {
    const result = await this.pool.query<{
      id: string;
      session_id: string;
      student_user_id: string | null;
      teacher_user_id: string | null;
      event_type: string;
      intervention_type: string;
      detail_level: string;
      policy_name: string;
      exercise_key: string | null;
      blocked: boolean;
      reason: string;
      context_summary: string;
      created_at: string | Date;
      student_name: string | null;
    }>(
      `
      select
        t.id,
        t.session_id,
        t.student_user_id,
        t.teacher_user_id,
        t.event_type,
        t.intervention_type,
        t.detail_level,
        t.policy_name,
        t.exercise_key,
        t.blocked,
        t.reason,
        t.context_summary,
        t.created_at,
        s.display_name as student_name
      from intervention_telemetry t
      left join users s on s.id = t.student_user_id
      where t.teacher_user_id = $1
      order by t.created_at desc
      limit $2
      `,
      [teacherUserId, limit],
    );

    return result.rows.map<TelemetryItem>((row) => ({
      id: row.id,
      sessionId: row.session_id,
      studentUserId: row.student_user_id,
      teacherUserId: row.teacher_user_id,
      eventType: row.event_type as TelemetryItem["eventType"],
      interventionType: row.intervention_type as TelemetryItem["interventionType"],
      detailLevel: row.detail_level as TelemetryItem["detailLevel"],
      policyName: row.policy_name,
      exerciseKey: row.exercise_key,
      blocked: row.blocked,
      reason: row.reason,
      contextSummary: row.context_summary,
      createdAt: toIso(row.created_at),
      studentName: row.student_name,
    }));
  }

  private async seed() {
    await this.pool.query("begin");
    try {
      for (const role of seedRoles) {
        await this.pool.query(
          `
          insert into roles (id, code, name)
          values ($1, $2, $3)
          on conflict (id) do nothing
          `,
          [role.id, role.code, role.name],
        );
      }

      for (const user of seedUsers) {
        await this.pool.query(
          `
          insert into users (id, role_id, teacher_user_id, email, display_name, password_hash)
          values ($1, $2, $3, $4, $5, $6)
          on conflict (id) do nothing
          `,
          [
            user.id,
            user.roleId,
            user.teacherUserId,
            user.email,
            user.displayName,
            user.passwordHash,
          ],
        );
      }

      await this.pool.query(
        `
        insert into teacher_policies (
          id,
          teacher_user_id,
          policy_name,
          outcome,
          tone,
          frequency,
          help_level,
          allow_mini_quiz,
          strict_no_solution,
          max_hints_per_exercise,
          fallback_message,
          custom_instruction,
          allowed_interventions,
          allowed_topics,
          event_rules
        )
        values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13::jsonb, $14::jsonb, $15::jsonb)
        on conflict (teacher_user_id) do nothing
        `,
        [
          seedTeacherPolicy.id,
          seedTeacherPolicy.teacherUserId,
          seedTeacherPolicy.policyName,
          seedTeacherPolicy.outcome,
          seedTeacherPolicy.tone,
          seedTeacherPolicy.frequency,
          seedTeacherPolicy.helpLevel,
          seedTeacherPolicy.allowMiniQuiz,
          seedTeacherPolicy.strictNoSolution,
          seedTeacherPolicy.maxHintsPerExercise,
          seedTeacherPolicy.fallbackMessage,
          seedTeacherPolicy.customInstruction,
          JSON.stringify(seedTeacherPolicy.allowedInterventions),
          JSON.stringify(seedTeacherPolicy.allowedTopics),
          JSON.stringify(seedTeacherPolicy.eventRules),
        ],
      );

      await this.pool.query("commit");
    } catch (error) {
      await this.pool.query("rollback");
      throw error;
    }
  }

  private async getRoleIdByCode(roleCode: UserRoleCode) {
    const result = await this.pool.query<{ id: string }>(
      `
      select id
      from roles
      where code = $1
      limit 1
      `,
      [roleCode],
    );
    const roleId = result.rows[0]?.id;
    if (!roleId) {
      throw new Error(`Rol no encontrado: ${roleCode}`);
    }
    return roleId;
  }

  private async resolveTeacherUserId(
    candidateTeacherUserId: string | null | undefined,
    options?: {
      excludeUserId?: string;
    },
  ) {
    const candidate = String(candidateTeacherUserId || "").trim();
    const excludedUserId = String(options?.excludeUserId || "").trim();
    if (candidate) {
      if (excludedUserId && candidate === excludedUserId) {
        throw new Error("Debes asignar un profesor diferente al usuario que se esta editando.");
      }
      const checkTeacher = await this.pool.query<{ id: string }>(
        `
        select u.id
        from users u
        join roles r on r.id = u.role_id
        where u.id = $1
          and u.is_active = true
          and r.code = 'teacher'
        limit 1
        `,
        [candidate],
      );
      if (!checkTeacher.rows[0]) {
        throw new Error("teacherUserId invalido. Debe ser un profesor activo.");
      }
      return candidate;
    }

    const defaultTeacherId = await this.getDefaultTeacherId(excludedUserId);
    if (!defaultTeacherId) {
      throw new Error("No hay profesores activos para asignar al estudiante.");
    }
    return defaultTeacherId;
  }

  private async ensureTeacherPolicyExists(teacherUserId: string) {
    await this.pool.query(
      `
      insert into teacher_policies (
        id,
        teacher_user_id,
        policy_name,
        outcome,
        tone,
        frequency,
        help_level,
        allow_mini_quiz,
        strict_no_solution,
        max_hints_per_exercise,
        fallback_message,
        custom_instruction,
        allowed_interventions,
        allowed_topics,
        event_rules
      )
      values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13::jsonb, $14::jsonb, $15::jsonb)
      on conflict (teacher_user_id) do nothing
      `,
      [
        randomUUID(),
        teacherUserId,
        seedTeacherPolicy.policyName,
        seedTeacherPolicy.outcome,
        seedTeacherPolicy.tone,
        seedTeacherPolicy.frequency,
        seedTeacherPolicy.helpLevel,
        seedTeacherPolicy.allowMiniQuiz,
        seedTeacherPolicy.strictNoSolution,
        seedTeacherPolicy.maxHintsPerExercise,
        seedTeacherPolicy.fallbackMessage,
        seedTeacherPolicy.customInstruction,
        JSON.stringify(seedTeacherPolicy.allowedInterventions),
        JSON.stringify(seedTeacherPolicy.allowedTopics),
        JSON.stringify(seedTeacherPolicy.eventRules),
      ],
    );
  }

  private async getDefaultTeacherId(excludeUserId?: string) {
    const excluded = String(excludeUserId || "").trim();
    const result = await this.pool.query<{ id: string }>(
      `
      select u.id
      from users u
      join roles r on r.id = u.role_id
      where r.code = 'teacher'
        and u.is_active = true
        and ($1 = '' or u.id <> $1)
      order by u.created_at asc
      limit 1
      `,
      [excluded],
    );

    return result.rows[0]?.id || null;
  }
}

export async function createDatabase() {
  if (env.databaseUrl) {
    const pool = new Pool({
      connectionString: env.databaseUrl,
      ssl: env.databaseSslMode === "require"
        ? { rejectUnauthorized: false }
        : undefined,
    });

    const database = new AppDatabase(pool, "postgres");
    await database.initialize();
    return database;
  }

  const inMemoryDb = newDb({
    autoCreateForeignKeyIndices: true,
  });
  const adapter = inMemoryDb.adapters.createPg();
  const pool = new adapter.Pool() as Pool;
  const database = new AppDatabase(pool, "memory-postgres");
  await database.initialize();
  return database;
}

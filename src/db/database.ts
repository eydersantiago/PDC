import { createHash, randomUUID, scryptSync, timingSafeEqual } from "node:crypto";
import { readFile, readdir } from "node:fs/promises";
import { resolve } from "node:path";
import { drizzle } from "drizzle-orm/node-postgres";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import { Pool } from "pg";
import { newDb } from "pg-mem";
import { env } from "../config/env.js";
import { seedRoles, seedTeacherPolicy, seedUsers } from "./seeds.js";
import type {
  AppSession,
  AppUser,
  ProjectMemory,
  ProjectMemoryFile,
  ProjectMemoryMetrics,
  ProjectMemorySummary,
  PrivacyPolicyStatus,
  TeacherPolicy,
  TeacherStudentOverview,
  TelemetryItem,
  UserRoleCode,
} from "../types/app.js";

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

type ProjectMemoryRow = {
  id: string;
  owner_user_id: string;
  workspace_key: string;
  repo_full_name: string;
  branch: string;
  project_label: string;
  snapshot_json: Record<string, unknown> | null;
  files_json: Array<Record<string, unknown>> | null;
  metrics_json: Record<string, unknown> | null;
  saved_by: string;
  last_activity_at: string | Date;
  created_at: string | Date;
  updated_at: string | Date;
};

type PrivacyAcceptanceRow = {
  accepted_at: string | Date;
};

type StudentOverviewUserRow = {
  id: string;
  email: string;
  display_name: string;
  created_at: string | Date;
};

type StudentTelemetryStatsRow = {
  telemetry_count: number | string;
  blocked_count: number | string;
  last_activity_at: string | Date | null;
};

type StudentHintStatsRow = {
  total_hints: number | string | null;
  exercises_with_hints: number | string;
  last_hint_at: string | Date | null;
};

type StudentProjectStatsRow = {
  metrics_json: Record<string, unknown> | null;
  project_label: string;
  repo_full_name: string;
  updated_at: string | Date;
  last_activity_at: string | Date;
};

function toIso(value: string | Date) {
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
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

function normalizeProjectMetrics(raw: unknown): ProjectMemoryMetrics {
  const value = raw && typeof raw === "object"
    ? raw as Record<string, unknown>
    : {};

  return {
    suggestionsReceived: Math.max(0, Number(value.suggestionsReceived) || 0),
    suggestionsAccepted: Math.max(0, Number(value.suggestionsAccepted) || 0),
    errorsDetected: Math.max(0, Number(value.errorsDetected) || 0),
    quizzesTaken: Math.max(0, Number(value.quizzesTaken) || 0),
  };
}

function normalizeProjectFiles(raw: unknown): ProjectMemoryFile[] {
  if (!Array.isArray(raw)) return [];

  return raw
    .map((item) => item && typeof item === "object" ? item as Record<string, unknown> : null)
    .filter((item): item is Record<string, unknown> => !!item)
    .map((item) => ({
      path: String(item.path || "").trim(),
      language: String(item.language || "").trim(),
      lineCount: Math.max(0, Number(item.lineCount) || 0),
      content: String(item.content || ""),
      capturedAt: String(item.capturedAt || ""),
    }))
    .filter((item) => item.path.length > 0);
}

function normalizeProjectSnapshot(raw: unknown) {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    return {} as Record<string, unknown>;
  }
  return raw as Record<string, unknown>;
}

function mapProjectMemoryRow(row: ProjectMemoryRow): ProjectMemory {
  return {
    id: row.id,
    ownerUserId: row.owner_user_id,
    workspaceKey: row.workspace_key,
    repoFullName: row.repo_full_name,
    branch: row.branch,
    projectLabel: row.project_label,
    snapshot: normalizeProjectSnapshot(row.snapshot_json),
    files: normalizeProjectFiles(row.files_json),
    metrics: normalizeProjectMetrics(row.metrics_json),
    savedBy: row.saved_by || "manual",
    lastActivityAt: toIso(row.last_activity_at),
    createdAt: toIso(row.created_at),
    updatedAt: toIso(row.updated_at),
  };
}

function mapProjectMemorySummaryRow(row: ProjectMemoryRow): ProjectMemorySummary {
  return {
    id: row.id,
    ownerUserId: row.owner_user_id,
    workspaceKey: row.workspace_key,
    repoFullName: row.repo_full_name,
    branch: row.branch,
    projectLabel: row.project_label,
    metrics: normalizeProjectMetrics(row.metrics_json),
    savedBy: row.saved_by || "manual",
    lastActivityAt: toIso(row.last_activity_at),
    createdAt: toIso(row.created_at),
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

function stripSslModeParam(connectionString: string) {
  try {
    const parsed = new URL(connectionString);
    parsed.searchParams.delete("sslmode");
    return parsed.toString();
  } catch {
    return connectionString;
  }
}

function maxIsoDate(values: Array<string | null>) {
  const timestamps = values
    .filter((value): value is string => Boolean(value))
    .map((value) => new Date(value).getTime())
    .filter((value) => Number.isFinite(value));

  if (timestamps.length === 0) return null;
  return new Date(Math.max(...timestamps)).toISOString();
}

function createEmptyProjectMetrics(): ProjectMemoryMetrics {
  return {
    suggestionsReceived: 0,
    suggestionsAccepted: 0,
    errorsDetected: 0,
    quizzesTaken: 0,
  };
}

function addProjectMetrics(left: ProjectMemoryMetrics, right: ProjectMemoryMetrics): ProjectMemoryMetrics {
  return {
    suggestionsReceived: left.suggestionsReceived + right.suggestionsReceived,
    suggestionsAccepted: left.suggestionsAccepted + right.suggestionsAccepted,
    errorsDetected: left.errorsDetected + right.errorsDetected,
    quizzesTaken: left.quizzesTaken + right.quizzesTaken,
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
    await this.runMigrations();
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

  async getPrivacyPolicyStatus(userId: string, policyVersion: string, policyUrl: string): Promise<PrivacyPolicyStatus> {
    const result = await this.pool.query<PrivacyAcceptanceRow>(
      `
      select accepted_at
      from privacy_policy_acceptances
      where user_id = $1
        and policy_version = $2
      limit 1
      `,
      [userId, policyVersion],
    );

    const acceptedAt = result.rows[0]?.accepted_at || null;
    return {
      url: policyUrl,
      version: policyVersion,
      accepted: Boolean(acceptedAt),
      acceptedAt: acceptedAt ? toIso(acceptedAt) : null,
    };
  }

  async acceptPrivacyPolicy(input: {
    userId: string;
    policyVersion: string;
    policyUrl: string;
    userAgent: string;
    ipAddress: string;
  }) {
    const result = await this.pool.query<PrivacyAcceptanceRow>(
      `
      insert into privacy_policy_acceptances (
        id,
        user_id,
        policy_version,
        policy_url,
        accepted_user_agent,
        accepted_ip
      )
      values ($1, $2, $3, $4, $5, $6)
      on conflict (user_id, policy_version)
      do update set
        policy_url = excluded.policy_url,
        accepted_user_agent = excluded.accepted_user_agent,
        accepted_ip = excluded.accepted_ip,
        accepted_at = now()
      returning accepted_at
      `,
      [
        randomUUID(),
        input.userId,
        input.policyVersion,
        input.policyUrl,
        input.userAgent.slice(0, 600),
        input.ipAddress.slice(0, 120),
      ],
    );

    return {
      url: input.policyUrl,
      version: input.policyVersion,
      accepted: true,
      acceptedAt: toIso(result.rows[0].accepted_at),
    } satisfies PrivacyPolicyStatus;
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

  async listStudentsForTeacher(teacherUserId: string, limit = 100): Promise<TeacherStudentOverview[]> {
    const students = await this.pool.query<StudentOverviewUserRow>(
      `
      select
        u.id,
        u.email,
        u.display_name,
        u.created_at
      from users u
      join roles r on r.id = u.role_id
      where r.code = 'student'
        and u.teacher_user_id = $1
        and u.is_active = true
      order by u.display_name asc, u.email asc
      limit $2
      `,
      [teacherUserId, Math.max(1, Math.min(limit, 200))],
    );

    const output: TeacherStudentOverview[] = [];

    for (const student of students.rows) {
      const telemetry = await this.pool.query<StudentTelemetryStatsRow>(
        `
        select
          count(*) as telemetry_count,
          coalesce(sum(case when blocked then 1 else 0 end), 0) as blocked_count,
          max(created_at) as last_activity_at
        from intervention_telemetry
        where teacher_user_id = $1
          and student_user_id = $2
        `,
        [teacherUserId, student.id],
      );

      const hints = await this.pool.query<StudentHintStatsRow>(
        `
        select
          coalesce(sum(hint_count), 0) as total_hints,
          count(*) as exercises_with_hints,
          max(last_intervention_at) as last_hint_at
        from student_exercise_progress
        where student_user_id = $1
        `,
        [student.id],
      );

      const projects = await this.pool.query<StudentProjectStatsRow>(
        `
        select
          metrics_json,
          project_label,
          repo_full_name,
          updated_at,
          last_activity_at
        from project_memories
        where owner_user_id = $1
        order by updated_at desc
        limit 50
        `,
        [student.id],
      );

      const projectMetrics = projects.rows.reduce<ProjectMemoryMetrics>(
        (acc, row) => addProjectMetrics(acc, normalizeProjectMetrics(row.metrics_json)),
        createEmptyProjectMetrics(),
      );
      const latestProject = projects.rows[0] || null;
      const telemetryRow = telemetry.rows[0];
      const hintRow = hints.rows[0];
      const latestProjectAt = latestProject ? toIso(latestProject.updated_at) : null;

      output.push({
        id: student.id,
        displayName: student.display_name,
        email: student.email,
        createdAt: toIso(student.created_at),
        lastActivityAt: maxIsoDate([
          telemetryRow?.last_activity_at ? toIso(telemetryRow.last_activity_at) : null,
          hintRow?.last_hint_at ? toIso(hintRow.last_hint_at) : null,
          latestProjectAt,
        ]),
        telemetryCount: Math.max(0, Number(telemetryRow?.telemetry_count) || 0),
        blockedCount: Math.max(0, Number(telemetryRow?.blocked_count) || 0),
        totalHints: Math.max(0, Number(hintRow?.total_hints) || 0),
        exercisesWithHints: Math.max(0, Number(hintRow?.exercises_with_hints) || 0),
        projectCount: projects.rows.length,
        latestProjectLabel: latestProject
          ? latestProject.project_label || latestProject.repo_full_name || "Proyecto"
          : "",
        latestProjectAt,
        metrics: projectMetrics,
      });
    }

    return output;
  }

  async saveProjectMemory(input: {
    ownerUserId: string;
    workspaceKey: string;
    repoFullName: string;
    branch: string;
    projectLabel: string;
    snapshot: Record<string, unknown>;
    files: ProjectMemoryFile[];
    metrics: ProjectMemoryMetrics;
    savedBy?: string;
    lastActivityAt?: string;
  }) {
    const insertedId = randomUUID();
    const sanitizedFiles = Array.isArray(input.files)
      ? input.files
        .map((file) => ({
          path: String(file.path || "").trim(),
          language: String(file.language || "").trim(),
          lineCount: Math.max(0, Number(file.lineCount) || 0),
          content: String(file.content || ""),
          capturedAt: String(file.capturedAt || new Date().toISOString()),
        }))
        .filter((file) => file.path.length > 0)
      : [];

    const result = await this.pool.query<ProjectMemoryRow>(
      `
      insert into project_memories (
        id,
        owner_user_id,
        workspace_key,
        repo_full_name,
        branch,
        project_label,
        snapshot_json,
        files_json,
        metrics_json,
        saved_by,
        last_activity_at
      )
      values ($1, $2, $3, $4, $5, $6, $7::jsonb, $8::jsonb, $9::jsonb, $10, $11::timestamptz)
      on conflict (owner_user_id, workspace_key)
      do update set
        repo_full_name = excluded.repo_full_name,
        branch = excluded.branch,
        project_label = excluded.project_label,
        snapshot_json = excluded.snapshot_json,
        files_json = excluded.files_json,
        metrics_json = excluded.metrics_json,
        saved_by = excluded.saved_by,
        last_activity_at = excluded.last_activity_at,
        updated_at = now()
      returning
        id,
        owner_user_id,
        workspace_key,
        repo_full_name,
        branch,
        project_label,
        snapshot_json,
        files_json,
        metrics_json,
        saved_by,
        last_activity_at,
        created_at,
        updated_at
      `,
      [
        insertedId,
        input.ownerUserId,
        input.workspaceKey,
        input.repoFullName,
        input.branch,
        input.projectLabel,
        JSON.stringify(input.snapshot || {}),
        JSON.stringify(sanitizedFiles),
        JSON.stringify(normalizeProjectMetrics(input.metrics)),
        String(input.savedBy || "manual"),
        input.lastActivityAt || new Date().toISOString(),
      ],
    );

    return mapProjectMemoryRow(result.rows[0]);
  }

  async getProjectMemory(ownerUserId: string, workspaceKey: string) {
    const result = await this.pool.query<ProjectMemoryRow>(
      `
      select
        id,
        owner_user_id,
        workspace_key,
        repo_full_name,
        branch,
        project_label,
        snapshot_json,
        files_json,
        metrics_json,
        saved_by,
        last_activity_at,
        created_at,
        updated_at
      from project_memories
      where owner_user_id = $1
        and workspace_key = $2
      limit 1
      `,
      [ownerUserId, workspaceKey],
    );

    const row = result.rows[0];
    return row ? mapProjectMemoryRow(row) : null;
  }

  async listProjectMemories(ownerUserId: string, limit = 10) {
    const result = await this.pool.query<ProjectMemoryRow>(
      `
      select
        id,
        owner_user_id,
        workspace_key,
        repo_full_name,
        branch,
        project_label,
        snapshot_json,
        files_json,
        metrics_json,
        saved_by,
        last_activity_at,
        created_at,
        updated_at
      from project_memories
      where owner_user_id = $1
      order by last_activity_at desc
      limit $2
      `,
      [ownerUserId, Math.max(1, Math.min(limit, 30))],
    );

    return result.rows.map(mapProjectMemoryRow);
  }

  async listProjectMemorySummaries(ownerUserId: string, limit = 10) {
    const result = await this.pool.query<ProjectMemoryRow>(
      `
      select
        id,
        owner_user_id,
        workspace_key,
        repo_full_name,
        branch,
        project_label,
        metrics_json,
        saved_by,
        last_activity_at,
        created_at,
        updated_at
      from project_memories
      where owner_user_id = $1
      order by last_activity_at desc
      limit $2
      `,
      [ownerUserId, Math.max(1, Math.min(limit, 50))],
    );

    return result.rows.map(mapProjectMemorySummaryRow);
  }

  async updateProjectMemoryTitle(ownerUserId: string, workspaceKey: string, projectLabel: string) {
    const cleanTitle = String(projectLabel || "").trim();
    if (!cleanTitle) {
      throw new Error("El titulo del proyecto no puede estar vacio.");
    }

    const result = await this.pool.query<ProjectMemoryRow>(
      `
      update project_memories
      set
        project_label = $3,
        updated_at = now()
      where owner_user_id = $1
        and workspace_key = $2
      returning
        id,
        owner_user_id,
        workspace_key,
        repo_full_name,
        branch,
        project_label,
        snapshot_json,
        files_json,
        metrics_json,
        saved_by,
        last_activity_at,
        created_at,
        updated_at
      `,
      [ownerUserId, workspaceKey, cleanTitle],
    );

    const row = result.rows[0];
    return row ? mapProjectMemoryRow(row) : null;
  }

  async deleteProjectMemory(ownerUserId: string, workspaceKey: string) {
    const result = await this.pool.query<{ id: string }>(
      `
      delete from project_memories
      where owner_user_id = $1
        and workspace_key = $2
      returning id
      `,
      [ownerUserId, workspaceKey],
    );

    return Boolean(result.rows[0]?.id);
  }

  private async runMigrations() {
    const migrationsFolder = resolve(process.cwd(), "drizzle");

    if (this.provider === "memory-postgres") {
      await this.runSqlMigrationsForMemory(migrationsFolder);
      return;
    }

    await this.bootstrapLegacySchemaIfNeeded(migrationsFolder);
    const db = drizzle(this.pool);
    await migrate(db, { migrationsFolder });
  }

  private async runSqlMigrationsForMemory(migrationsFolder: string) {
    const entries = await readdir(migrationsFolder, { withFileTypes: true });
    const sqlFiles = entries
      .filter((entry) => entry.isFile() && entry.name.endsWith(".sql"))
      .map((entry) => entry.name)
      .sort((a, b) => a.localeCompare(b));

    for (const fileName of sqlFiles) {
      const filePath = resolve(migrationsFolder, fileName);
      const sqlText = await readFile(filePath, "utf8");
      const statements = sqlText
        .split("--> statement-breakpoint")
        .map((statement) => statement.trim())
        .filter(Boolean);

      for (const statement of statements) {
        await this.pool.query(statement);
      }
    }
  }

  private async bootstrapLegacySchemaIfNeeded(migrationsFolder: string) {
    const legacySchema = await this.pool.query<{
      roles_table: string | null;
      users_table: string | null;
      drizzle_migrations_table: string | null;
    }>(
      `
      select
        to_regclass('public.roles')::text as roles_table,
        to_regclass('public.users')::text as users_table,
        to_regclass('drizzle.__drizzle_migrations')::text as drizzle_migrations_table
      `,
    );

    const row = legacySchema.rows[0];
    const hasLegacyTables = Boolean(row?.roles_table && row?.users_table);
    const hasMigrationTable = Boolean(row?.drizzle_migrations_table);

    if (!hasLegacyTables || hasMigrationTable) return;

    await this.pool.query(`create schema if not exists drizzle`);
    await this.pool.query(`
      create table if not exists drizzle.__drizzle_migrations (
        id serial primary key,
        hash text not null,
        created_at bigint
      )
    `);

    const journalPath = resolve(migrationsFolder, "meta", "_journal.json");
    const journalRaw = await readFile(journalPath, "utf8");
    const journal = JSON.parse(journalRaw) as {
      entries?: Array<{ when?: number; tag?: string }>;
    };

    for (const entry of journal.entries || []) {
      if (!entry.tag) continue;
      const sqlPath = resolve(migrationsFolder, `${entry.tag}.sql`);
      const sqlText = await readFile(sqlPath, "utf8");
      const hash = createHash("sha256").update(sqlText).digest("hex");

      await this.pool.query(
        `
        insert into drizzle.__drizzle_migrations (hash, created_at)
        select $1, $2
        where not exists (
          select 1 from drizzle.__drizzle_migrations where hash = $1
        )
        `,
        [hash, entry.when || Date.now()],
      );
    }
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

  private async getDefaultTeacherId() {
    const result = await this.pool.query<{ id: string }>(
      `
      select u.id
      from users u
      join roles r on r.id = u.role_id
      where r.code = 'teacher'
      order by u.created_at asc
      limit 1
      `,
    );

    return result.rows[0]?.id || null;
  }
}

export async function createDatabase() {
  if (env.databaseUrl) {
    const useSsl = env.databaseSslMode === "require";
    const pool = new Pool({
      connectionString: useSsl ? stripSslModeParam(env.databaseUrl) : env.databaseUrl,
      ssl: useSsl
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

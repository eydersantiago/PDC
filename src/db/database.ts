import { createHash, randomUUID, scryptSync, timingSafeEqual } from "node:crypto";
import fsp from "node:fs/promises";
import path from "node:path";
import { Pool } from "pg";
import { newDb } from "pg-mem";
import { env } from "../config/env.js";
import { seedRoles, seedTeacherPolicy, seedUsers } from "./seeds.js";
import { schemaStatements } from "./schema.js";
import {
  DEFAULT_RAG_COURSE_CODE,
  normalizeRagCourseCode,
  normalizeRagCourseCodes,
  ragCourseMetadata,
} from "../services/rag-courses.js";
import { buildRagChunksForSource } from "../services/rag-sources.js";
import { trimText } from "../services/text-utils.js";
import type {
  AppSession,
  AppUser,
  BehaviorEventCategory,
  BehaviorEventInput,
  BehaviorEventItem,
  BehaviorEventSource,
  BehaviorEventSummaryItem,
  RagSource,
  RagSourceChunk,
  RagSourceChunkInput,
  RagSourceScope,
  TeacherPolicy,
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
  assigned_course_codes?: unknown;
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

type UserActiveTabRow = {
  user_id: string;
  session_id: string | null;
  tab_id: string;
  tab_url: string;
  tab_title: string;
  view_context: string;
  is_active: boolean;
  seen_at: string | Date;
  created_at: string | Date;
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

type GithubOAuthStateRow = {
  state: string;
  session_id: string | null;
  user_id: string;
  repo_full_name: string;
  expires_at: string | Date;
};

type GithubUserTokenRow = {
  user_id: string;
  account_login: string;
  account_email: string;
  access_token: string;
  token_type: string;
  scopes: string;
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
  assigned_course_codes?: unknown;
};

type CourseAssignmentRow = {
  user_id: string;
  course_code: string;
};

type BehaviorEventRow = {
  id: string;
  user_id: string;
  teacher_user_id: string | null;
  session_id: string | null;
  source: BehaviorEventSource;
  category: BehaviorEventCategory;
  event_type: string;
  page_context: string;
  repo_full_name: string;
  branch: string;
  file_path: string;
  language: string;
  subject_id: string;
  event_value: string;
  duration_ms: number | null;
  count_value: number;
  metadata: Record<string, unknown>;
  occurred_at: string | Date;
  created_at: string | Date;
  student_name?: string | null;
};

type BehaviorEventSummaryRow = {
  user_id: string;
  student_name?: string | null;
  teacher_user_id: string | null;
  source: BehaviorEventSource;
  category: BehaviorEventCategory;
  event_type: string;
  total_events: number | string;
  total_count: number | string;
  total_duration_ms: number | string | null;
  average_duration_ms: number | string | null;
  first_occurred_at: string | Date;
  last_occurred_at: string | Date;
};

type RagSourceRow = {
  id: string;
  scope: RagSourceScope;
  teacher_user_id: string | null;
  source_key: string;
  title: string;
  source_type: string;
  file_name: string;
  mime_type: string;
  content_sha256: string;
  content_text: string;
  metadata: Record<string, unknown>;
  is_active: boolean;
  created_by_user_id: string | null;
  created_at: string | Date;
  updated_at: string | Date;
};

type RagSourceChunkRow = {
  id: string;
  source_id: string;
  scope: RagSourceScope;
  teacher_user_id: string | null;
  source_key: string;
  source_title: string;
  source_type: string;
  file_name: string;
  mime_type: string;
  source_metadata: Record<string, unknown>;
  is_active: boolean;
  chunk_index: number;
  content_text: string;
  search_text: string;
  token_count: number;
  char_start: number;
  char_end: number;
  page_start: number | null;
  page_end: number | null;
  citation_label: string;
  metadata: Record<string, unknown>;
  created_at: string | Date;
};

function toIso(value: string | Date) {
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
}

function normalizeRepoKey(repoFullName: string) {
  return String(repoFullName || "").trim().toLowerCase();
}

function mapSessionRow(row: SessionRow): AppSession {
  const assignedCourseCodes = normalizeAssignedCourseCodes(row.assigned_course_codes, row.role);
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
      assignedCourseCodes,
      activeCourseCode: assignedCourseCodes[0] || null,
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
  const assignedCourseCodes = normalizeAssignedCourseCodes(row.assigned_course_codes, row.role);
  return {
    id: row.id,
    role: row.role,
    email: row.email,
    displayName: row.display_name,
    teacherUserId: row.teacher_user_id,
    teacherDisplayName: row.teacher_display_name,
    assignedCourseCodes,
    isActive: row.is_active,
    createdAt: toIso(row.created_at),
  };
}

function mapBehaviorEventRow(row: BehaviorEventRow): BehaviorEventItem {
  return {
    id: row.id,
    userId: row.user_id,
    teacherUserId: row.teacher_user_id,
    sessionId: row.session_id,
    source: row.source,
    category: row.category,
    eventType: row.event_type,
    pageContext: row.page_context,
    repoFullName: row.repo_full_name,
    branch: row.branch,
    filePath: row.file_path,
    language: row.language,
    subjectId: row.subject_id,
    value: row.event_value,
    durationMs: row.duration_ms == null ? null : Number(row.duration_ms),
    count: Number(row.count_value) || 1,
    metadata: row.metadata && typeof row.metadata === "object" ? row.metadata : {},
    occurredAt: toIso(row.occurred_at),
    createdAt: toIso(row.created_at),
    studentName: row.student_name || null,
  };
}

function mapBehaviorSummaryRow(row: BehaviorEventSummaryRow): BehaviorEventSummaryItem {
  const totalEvents = Number(row.total_events) || 0;
  const totalCount = Number(row.total_count) || 0;
  const totalDurationMs = Number(row.total_duration_ms) || 0;
  const averageDuration = row.average_duration_ms == null ? null : Number(row.average_duration_ms);
  return {
    userId: row.user_id,
    studentName: row.student_name || null,
    teacherUserId: row.teacher_user_id,
    source: row.source,
    category: row.category,
    eventType: row.event_type,
    totalEvents,
    totalCount,
    totalDurationMs,
    averageDurationMs: Number.isFinite(averageDuration) ? averageDuration : null,
    firstOccurredAt: toIso(row.first_occurred_at),
    lastOccurredAt: toIso(row.last_occurred_at),
  };
}

function safeJsonObject(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function mapRagSourceRow(row: RagSourceRow): RagSource {
  return {
    id: row.id,
    scope: row.scope,
    teacherUserId: row.teacher_user_id,
    sourceKey: row.source_key,
    title: row.title,
    sourceType: row.source_type,
    fileName: row.file_name,
    mimeType: row.mime_type,
    contentSha256: row.content_sha256,
    contentText: row.content_text,
    metadata: safeJsonObject(row.metadata),
    isActive: row.is_active,
    createdByUserId: row.created_by_user_id,
    createdAt: toIso(row.created_at),
    updatedAt: toIso(row.updated_at),
  };
}

function mapRagChunkRow(row: RagSourceChunkRow): RagSourceChunk {
  return {
    id: row.id,
    sourceId: row.source_id,
    scope: row.scope,
    teacherUserId: row.teacher_user_id,
    sourceKey: row.source_key,
    sourceTitle: row.source_title,
    sourceType: row.source_type,
    fileName: row.file_name,
    mimeType: row.mime_type,
    sourceMetadata: safeJsonObject(row.source_metadata),
    isActive: row.is_active,
    chunkIndex: Number(row.chunk_index) || 0,
    contentText: row.content_text,
    searchText: row.search_text,
    tokenCount: Number(row.token_count) || 0,
    charStart: Number(row.char_start) || 0,
    charEnd: Number(row.char_end) || 0,
    pageStart: row.page_start == null ? null : Number(row.page_start),
    pageEnd: row.page_end == null ? null : Number(row.page_end),
    citationLabel: row.citation_label,
    metadata: safeJsonObject(row.metadata),
    createdAt: toIso(row.created_at),
  };
}

function seedEntryText(entry: Record<string, unknown>) {
  return [
    entry.id,
    entry.title,
    entry.description,
    entry.role,
    entry.category,
    entry.week == null ? "" : `Semana ${entry.week}`,
    entry.date,
    entry.source_pdf,
    entry.path,
    entry.original_url,
    entry.download_url,
    entry.rag_use,
  ]
    .map((value) => trimText(String(value ?? "")))
    .filter(Boolean)
    .join("\n");
}

function contentHash(value: string) {
  return createHash("sha256").update(value).digest("hex");
}

function estimateRagTokenCount(value: string) {
  const words = trimText(value).split(/\s+/).filter(Boolean).length;
  return Math.max(1, Math.ceil(words * 1.25));
}

function optionalPositiveInteger(value: unknown) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) return null;
  return Math.round(parsed);
}

function normalizeAssignedCourseCodes(value: unknown, role: UserRoleCode = "student") {
  return normalizeRagCourseCodes(value, {
    fallbackToDefault: role === "student",
    knownOnly: true,
  });
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

    return this.createSessionForUser({
      id: row.user_id,
      role: row.role,
      email: row.email,
      displayName: row.display_name,
      teacherUserId: row.teacher_user_id,
    });
  }

  async authenticateGoogleUser(input: {
    email: string;
    displayName: string;
    defaultPassword: string;
  }) {
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
      });
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
    });
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
    row.assigned_course_codes = await this.listAssignedCourseCodesForUser(row.user_id, row.role);
    return mapSessionRow(row);
  }

  async logoutSession(sessionId: string) {
    await this.pool.query(
      `update app_sessions set is_active = false, last_seen_at = now() where id = $1`,
      [sessionId],
    );
  }

  private async listAssignedCourseCodesForUser(userId: string, role: UserRoleCode = "student") {
    const result = await this.pool.query<CourseAssignmentRow>(
      `
      select user_id, course_code
      from user_course_assignments
      where user_id = $1
      order by
        case course_code when $2 then 0 else 1 end,
        course_code asc
      `,
      [userId, DEFAULT_RAG_COURSE_CODE],
    );

    return normalizeAssignedCourseCodes(result.rows.map((row) => row.course_code), role);
  }

  private async hydrateManagedUserCourseCodes(rows: ManagedUserRow[]) {
    for (const row of rows) {
      row.assigned_course_codes = await this.listAssignedCourseCodesForUser(row.id, row.role);
    }
    return rows;
  }

  private async setUserCourseAssignments(
    userId: string,
    courseCodes: unknown,
    assignedByUserId: string | null,
  ) {
    const codes = normalizeRagCourseCodes(courseCodes, {
      fallbackToDefault: true,
      knownOnly: true,
    });

    await this.pool.query(
      `delete from user_course_assignments where user_id = $1`,
      [userId],
    );

    for (const courseCode of codes) {
      await this.pool.query(
        `
        insert into user_course_assignments (
          id,
          user_id,
          course_code,
          assigned_by_user_id,
          created_at
        )
        values ($1, $2, $3, $4, now())
        on conflict (user_id, course_code) do nothing
        `,
        [randomUUID(), userId, courseCode, assignedByUserId],
      );
    }

    return codes;
  }

  async listManagedUsers(viewer?: AppUser) {
    const teacherScopeId = viewer?.role === "teacher" ? viewer.id : "";
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
        and (
          $1 = ''
          or (
            r.code = 'student'
            and u.teacher_user_id = $1
          )
        )
      order by
        case r.code
          when 'teacher' then 0
          else 1
        end,
        u.display_name asc
      `,
      [teacherScopeId],
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
        and ($1 = '' or u.id = $1)
      order by u.display_name asc
      `,
      [teacherScopeId],
    );
    const hydratedUsers = await this.hydrateManagedUserCourseCodes(usersResult.rows);

    return {
      users: hydratedUsers.map(mapManagedUserRow),
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
    assignedCourseCodes?: unknown;
    assignedByUserId?: string | null;
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
      row.assigned_course_codes = [];
    } else {
      row.assigned_course_codes = await this.setUserCourseAssignments(
        row.id,
        input.assignedCourseCodes,
        input.assignedByUserId || null,
      );
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
    assignedCourseCodes?: unknown;
    assignedByUserId?: string | null;
  }, options?: {
    viewer?: AppUser;
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
    if (options?.viewer?.role === "teacher") {
      if (existing.role !== "student" || existing.teacher_user_id !== options.viewer.id) {
        throw new Error("Solo puedes editar estudiantes asignados a tu cuenta docente.");
      }
    }

    const nextRole = options?.viewer?.role === "teacher"
      ? "student"
      : (input.role === "teacher" || input.role === "student" ? input.role : existing.role);
    const roleId = await this.getRoleIdByCode(nextRole);
    const nextTeacherUserId = options?.viewer?.role === "teacher"
      ? options.viewer.id
      : nextRole === "student"
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
        update users
        set
          role_id = $2,
          teacher_user_id = $3,
          email = $4,
          display_name = $5,
          password_hash = coalesce($6, password_hash),
          is_active = $7
        where id = $1
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
      await this.pool.query(`delete from user_course_assignments where user_id = $1`, [row.id]);
      row.assigned_course_codes = [];
    } else {
      row.assigned_course_codes = input.assignedCourseCodes === undefined
        ? await this.listAssignedCourseCodesForUser(row.id, row.role)
        : await this.setUserCourseAssignments(
          row.id,
          input.assignedCourseCodes,
          input.assignedByUserId || options?.viewer?.id || null,
        );
    }

    if (!row.is_active) {
      await this.pool.query(
        `update app_sessions set is_active = false, last_seen_at = now() where user_id = $1`,
        [row.id],
      );
    }

    return mapManagedUserRow(row);
  }

  async deactivateManagedUser(userId: string, options?: {
    viewer?: AppUser;
  }) {
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
          and (
            $2 = ''
            or (
              r.code = 'student'
              and u.teacher_user_id = $2
            )
          )
        limit 1
      ),
      updated_user as (
        update users
        set is_active = false
        from target t
        where users.id = t.id
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
      [userId, options?.viewer?.role === "teacher" ? options.viewer.id : ""],
    );

    const row = updated.rows[0];
    if (!row) {
      throw new Error("Usuario no encontrado o no administrable.");
    }

    await this.pool.query(
      `update app_sessions set is_active = false, last_seen_at = now() where user_id = $1`,
      [row.id],
    );
    row.assigned_course_codes = await this.listAssignedCourseCodesForUser(row.id, row.role);

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

  async listRagSourcesForUser(
    user: AppUser | null,
    limit = 100,
    options?: {
      courseCode?: string;
      includeAllCourses?: boolean;
    },
  ) {
    const sourceLimit = Math.max(1, Math.min(300, Math.round(Number(limit) || 100)));
    const courseCode = normalizeRagCourseCode(options?.courseCode || DEFAULT_RAG_COURSE_CODE);
    const teacherUserId = user
      ? user.role === "teacher"
        ? user.id
        : user.teacherUserId || await this.getDefaultTeacherId()
      : null;

    const result = await this.pool.query<RagSourceRow>(
      `
      select
        id,
        scope,
        teacher_user_id,
        source_key,
        title,
        source_type,
        file_name,
        mime_type,
        content_sha256,
        content_text,
        metadata,
        is_active,
        created_by_user_id,
        created_at,
        updated_at
      from rag_sources
      where is_active = true
        and (
          scope = 'default'
          or (
            $1 <> ''
            and scope = 'teacher'
            and teacher_user_id = $1
          )
        )
      order by
        case scope when 'teacher' then 0 else 1 end,
        created_at desc,
        title asc
      limit $2
      `,
      [teacherUserId || "", sourceLimit],
    );

    const sources = result.rows.map(mapRagSourceRow);
    if (options?.includeAllCourses) return this.hydrateRagSourcesWithChunks(sources);

    const filteredSources = sources.filter((source) => {
      const metadataCourseCode = normalizeRagCourseCode(
        String(source.metadata.courseCode || source.metadata.course_code || DEFAULT_RAG_COURSE_CODE),
      );
      return metadataCourseCode === courseCode;
    });

    return this.hydrateRagSourcesWithChunks(filteredSources);
  }

  private async hydrateRagSourcesWithChunks(sources: RagSource[]) {
    for (const source of sources) {
      source.chunks = await this.listRagChunksForSource(source.id, env.ragMaxChunksPerSource);
    }
    return sources;
  }

  private buildVirtualRagChunks(source: RagSource): RagSourceChunk[] {
    const chunks = buildRagChunksForSource({
      title: source.title,
      sourceType: source.sourceType,
      fileName: source.fileName,
      sourceKey: source.sourceKey,
      contentText: source.contentText,
      metadata: source.metadata,
    });

    return chunks.map((chunk) => ({
      id: `${source.id}:chunk:${chunk.chunkIndex}`,
      sourceId: source.id,
      scope: source.scope,
      teacherUserId: source.teacherUserId,
      sourceKey: source.sourceKey,
      sourceTitle: source.title,
      sourceType: source.sourceType,
      fileName: source.fileName,
      mimeType: source.mimeType,
      sourceMetadata: source.metadata,
      isActive: source.isActive,
      chunkIndex: chunk.chunkIndex,
      contentText: chunk.contentText,
      searchText: chunk.searchText,
      tokenCount: chunk.tokenCount,
      charStart: chunk.charStart,
      charEnd: chunk.charEnd,
      pageStart: chunk.pageStart,
      pageEnd: chunk.pageEnd,
      citationLabel: chunk.citationLabel,
      metadata: chunk.metadata,
      createdAt: source.createdAt,
    }));
  }

  async listRagChunksForUser(
    user: AppUser | null,
    limit = 600,
    options?: {
      courseCode?: string;
      includeAllCourses?: boolean;
    },
  ) {
    const chunkLimit = Math.max(1, Math.min(1200, Math.round(Number(limit) || 600)));
    const sources = await this.listRagSourcesForUser(user, 300, options);
    const chunks: RagSourceChunk[] = [];

    for (const source of sources) {
      const sourceChunks = source.chunks?.length
        ? source.chunks
        : await this.listRagChunksForSource(source.id, Math.max(1, Math.min(env.ragMaxChunksPerSource, chunkLimit)));
      chunks.push(...(sourceChunks.length ? sourceChunks : this.buildVirtualRagChunks(source)));
      if (chunks.length >= chunkLimit) break;
    }

    return chunks.slice(0, chunkLimit);
  }

  async getRagSourceForUser(
    user: AppUser | null,
    sourceId: string,
    options?: {
      courseCode?: string;
      includeAllCourses?: boolean;
    },
  ) {
    const cleanSourceId = trimText(sourceId);
    if (!cleanSourceId) return null;

    const sources = await this.listRagSourcesForUser(user, 300, options);
    return sources.find((source) => source.id === cleanSourceId) || null;
  }

  async getRagSourceForViewer(
    sourceId: string,
    options?: {
      courseCode?: string;
    },
  ) {
    const cleanSourceId = trimText(sourceId);
    if (!cleanSourceId) return null;

    const result = await this.pool.query<RagSourceRow>(
      `
      select
        id,
        scope,
        teacher_user_id,
        source_key,
        title,
        source_type,
        file_name,
        mime_type,
        content_sha256,
        content_text,
        metadata,
        is_active,
        created_by_user_id,
        created_at,
        updated_at
      from rag_sources
      where id = $1
        and is_active = true
      limit 1
      `,
      [cleanSourceId],
    );

    const source = result.rows[0] ? mapRagSourceRow(result.rows[0]) : null;
    if (!source) return null;

    const expectedCourseCode = trimText(options?.courseCode)
      ? normalizeRagCourseCode(String(options?.courseCode))
      : "";
    if (expectedCourseCode) {
      const sourceCourseCode = normalizeRagCourseCode(
        String(source.metadata.courseCode || source.metadata.course_code || DEFAULT_RAG_COURSE_CODE),
      );
      if (sourceCourseCode !== expectedCourseCode) return null;
    }

    const hydratedSources = await this.hydrateRagSourcesWithChunks([source]);
    return hydratedSources[0] || source;
  }

  private async listRagChunksForSource(sourceId: string, limit: number) {
    const chunkLimit = Math.max(1, Math.min(env.ragMaxChunksPerSource, Math.round(Number(limit) || env.ragMaxChunksPerSource)));
    const result = await this.pool.query<RagSourceChunkRow>(
      `
      select
        c.id,
        c.source_id,
        s.scope,
        s.teacher_user_id,
        s.source_key,
        s.title as source_title,
        s.source_type,
        s.file_name,
        s.mime_type,
        s.metadata as source_metadata,
        s.is_active,
        c.chunk_index,
        c.content_text,
        c.search_text,
        c.token_count,
        c.char_start,
        c.char_end,
        c.page_start,
        c.page_end,
        c.citation_label,
        c.metadata,
        c.created_at
      from rag_source_chunks c
      join rag_sources s on s.id = c.source_id
      where c.source_id = $1
        and s.is_active = true
      order by c.chunk_index asc
      limit $2
      `,
      [sourceId, chunkLimit],
    );

    return result.rows.map(mapRagChunkRow);
  }

  private async replaceRagSourceChunks(
    source: RagSource,
    chunkInputs?: RagSourceChunkInput[],
  ) {
    const chunks = chunkInputs?.length
      ? chunkInputs
      : buildRagChunksForSource({
        title: source.title,
        sourceType: source.sourceType,
        fileName: source.fileName,
        sourceKey: source.sourceKey,
        contentText: source.contentText,
        metadata: source.metadata,
      });

    await this.pool.query(
      `delete from rag_source_chunks where source_id = $1`,
      [source.id],
    );

    for (const chunk of chunks.slice(0, env.ragMaxChunksPerSource)) {
      await this.pool.query(
        `
        insert into rag_source_chunks (
          id,
          source_id,
          chunk_index,
          content_text,
          search_text,
          token_count,
          char_start,
          char_end,
          page_start,
          page_end,
          citation_label,
          metadata,
          created_at
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
          $10,
          $11,
          $12::jsonb,
          now()
        )
        on conflict (source_id, chunk_index) do update
        set
          content_text = excluded.content_text,
          search_text = excluded.search_text,
          token_count = excluded.token_count,
          char_start = excluded.char_start,
          char_end = excluded.char_end,
          page_start = excluded.page_start,
          page_end = excluded.page_end,
          citation_label = excluded.citation_label,
          metadata = excluded.metadata
        `,
        [
          `${source.id}:chunk:${chunk.chunkIndex}`,
          source.id,
          chunk.chunkIndex,
          chunk.contentText,
          chunk.searchText,
          chunk.tokenCount,
          chunk.charStart,
          chunk.charEnd,
          chunk.pageStart,
          chunk.pageEnd,
          chunk.citationLabel,
          JSON.stringify(chunk.metadata || {}),
        ],
      );
    }

    return chunks.length;
  }

  async createTeacherRagSource(input: {
    teacherUserId: string;
    createdByUserId: string;
    sourceKey?: string;
    title: string;
    sourceType: string;
    fileName: string;
    mimeType: string;
    contentText: string;
    metadata: Record<string, unknown>;
    chunks?: RagSourceChunkInput[];
  }) {
    const contentText = trimText(input.contentText);
    const sourceKey = trimText(input.sourceKey)
      || trimText(input.fileName)
      || randomUUID();
    const result = await this.pool.query<RagSourceRow>(
      `
      insert into rag_sources (
        id,
        scope,
        teacher_user_id,
        source_key,
        title,
        source_type,
        file_name,
        mime_type,
        content_sha256,
        content_text,
        metadata,
        is_active,
        created_by_user_id,
        created_at,
        updated_at
      )
      values (
        $1,
        'teacher',
        $2,
        $3,
        $4,
        $5,
        $6,
        $7,
        $8,
        $9,
        $10::jsonb,
        true,
        $11,
        now(),
        now()
      )
      returning
        id,
        scope,
        teacher_user_id,
        source_key,
        title,
        source_type,
        file_name,
        mime_type,
        content_sha256,
        content_text,
        metadata,
        is_active,
        created_by_user_id,
        created_at,
        updated_at
      `,
      [
        randomUUID(),
        input.teacherUserId,
        sourceKey,
        trimText(input.title).slice(0, 260) || sourceKey,
        trimText(input.sourceType).slice(0, 80) || "document",
        trimText(input.fileName).slice(0, 500),
        trimText(input.mimeType).slice(0, 160),
        contentHash(contentText),
        contentText,
        JSON.stringify(input.metadata || {}),
        input.createdByUserId,
      ],
    );

    const source = mapRagSourceRow(result.rows[0]);
    await this.replaceRagSourceChunks(source, input.chunks);
    source.chunks = await this.listRagChunksForSource(source.id, env.ragMaxChunksPerSource);
    return source;
  }

  async deactivateTeacherRagSource(sourceId: string, teacherUserId: string) {
    const result = await this.pool.query<{ id: string }>(
      `
      update rag_sources
      set is_active = false, updated_at = now()
      where id = $1
        and scope = 'teacher'
        and teacher_user_id = $2
        and is_active = true
      returning id
      `,
      [sourceId, teacherUserId],
    );

    return Boolean(result.rows[0]);
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

  async clearActiveTabForUser(userId: string) {
    const result = await this.pool.query<UserActiveTabRow>(
      `
      update user_active_tabs
      set
        is_active = false,
        seen_at = now(),
        updated_at = now()
      where user_id = $1
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

  async recordBehaviorEvents(input: {
    sessionId: string;
    user: AppUser;
    events: BehaviorEventInput[];
  }) {
    const stored: BehaviorEventItem[] = [];
    const teacherUserId = input.user.role === "student"
      ? input.user.teacherUserId
      : null;

    for (const event of input.events) {
      let durationMs: number | null = null;
      if (event.durationMs != null && Number.isFinite(Number(event.durationMs))) {
        durationMs = Math.max(0, Math.round(Number(event.durationMs)));
      }
      const count = Number.isFinite(Number(event.count))
        ? Math.max(1, Math.min(100000, Math.round(Number(event.count))))
        : 1;
      const metadata = event.metadata && typeof event.metadata === "object"
        ? event.metadata
        : {};

      const result = await this.pool.query<BehaviorEventRow>(
        `
        insert into user_behavior_events (
          id,
          user_id,
          teacher_user_id,
          session_id,
          source,
          category,
          event_type,
          page_context,
          repo_full_name,
          branch,
          file_path,
          language,
          subject_id,
          event_value,
          duration_ms,
          count_value,
          metadata,
          occurred_at
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
          $10,
          $11,
          $12,
          $13,
          $14,
          $15,
          $16,
          $17::jsonb,
          coalesce($18::timestamptz, now())
        )
        returning
          id,
          user_id,
          teacher_user_id,
          session_id,
          source,
          category,
          event_type,
          page_context,
          repo_full_name,
          branch,
          file_path,
          language,
          subject_id,
          event_value,
          duration_ms,
          count_value,
          metadata,
          occurred_at,
          created_at
        `,
        [
          randomUUID(),
          input.user.id,
          teacherUserId,
          input.sessionId,
          event.source,
          event.category,
          trimText(event.eventType).slice(0, 120),
          trimText(event.pageContext).slice(0, 120),
          trimText(event.repoFullName).slice(0, 240),
          trimText(event.branch).slice(0, 160),
          trimText(event.filePath).slice(0, 700),
          trimText(event.language).slice(0, 120),
          trimText(event.subjectId).slice(0, 220),
          trimText(event.value).slice(0, 1000),
          durationMs,
          count,
          JSON.stringify(metadata),
          trimText(event.occurredAt) || null,
        ],
      );

      const row = result.rows[0];
      if (row) {
        stored.push(mapBehaviorEventRow(row));
      }
    }

    return stored;
  }

  async listBehaviorEventsForViewer(input: {
    viewer: AppUser;
    targetUserId?: string;
    category?: string;
    eventType?: string;
    source?: string;
    repoFullName?: string;
    since?: string;
    limit?: number;
  }) {
    const limit = Math.max(1, Math.min(100, Math.round(Number(input.limit) || 50)));
    const result = await this.pool.query<BehaviorEventRow>(
      `
      select
        e.id,
        e.user_id,
        e.teacher_user_id,
        e.session_id,
        e.source,
        e.category,
        e.event_type,
        e.page_context,
        e.repo_full_name,
        e.branch,
        e.file_path,
        e.language,
        e.subject_id,
        e.event_value,
        e.duration_ms,
        e.count_value,
        e.metadata,
        e.occurred_at,
        e.created_at
      from user_behavior_events e
      where (
          $1 = 'admin'
          or e.user_id = $2
          or ($1 = 'teacher' and e.teacher_user_id = $2)
        )
        and ($3 = '' or e.user_id = $3)
        and ($4 = '' or e.category = $4)
        and ($5 = '' or e.event_type = $5)
        and ($6 = '' or e.source = $6)
        and ($7 = '' or lower(e.repo_full_name) = lower($7))
        and ($8::timestamptz is null or e.occurred_at >= $8::timestamptz)
      order by e.occurred_at desc, e.created_at desc
      limit $9
      `,
      [
        input.viewer.role,
        input.viewer.id,
        trimText(input.targetUserId),
        trimText(input.category),
        trimText(input.eventType),
        trimText(input.source),
        trimText(input.repoFullName),
        trimText(input.since) || null,
        limit,
      ],
    );

    return result.rows.map(mapBehaviorEventRow);
  }

  async summarizeBehaviorEventsForViewer(input: {
    viewer: AppUser;
    targetUserId?: string;
    category?: string;
    source?: string;
    repoFullName?: string;
    since?: string;
    limit?: number;
  }) {
    const limit = Math.max(1, Math.min(200, Math.round(Number(input.limit) || 100)));
    const result = await this.pool.query<BehaviorEventSummaryRow>(
      `
      select
        e.user_id,
        e.teacher_user_id,
        e.source,
        e.category,
        e.event_type,
        count(*)::text as total_events,
        coalesce(sum(e.count_value), 0)::text as total_count,
        coalesce(sum(e.duration_ms), 0)::text as total_duration_ms,
        avg(e.duration_ms)::text as average_duration_ms,
        min(e.occurred_at) as first_occurred_at,
        max(e.occurred_at) as last_occurred_at
      from user_behavior_events e
      where (
          $1 = 'admin'
          or e.user_id = $2
          or ($1 = 'teacher' and e.teacher_user_id = $2)
        )
        and ($3 = '' or e.user_id = $3)
        and ($4 = '' or e.category = $4)
        and ($5 = '' or e.source = $5)
        and ($6 = '' or lower(e.repo_full_name) = lower($6))
        and ($7::timestamptz is null or e.occurred_at >= $7::timestamptz)
      group by
        e.user_id,
        e.teacher_user_id,
        e.source,
        e.category,
        e.event_type
      order by max(e.occurred_at) desc
      limit $8
      `,
      [
        input.viewer.role,
        input.viewer.id,
        trimText(input.targetUserId),
        trimText(input.category),
        trimText(input.source),
        trimText(input.repoFullName),
        trimText(input.since) || null,
        limit,
      ],
    );

    return result.rows.map(mapBehaviorSummaryRow);
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

  private async createSessionForUser(user: AppUser) {
    const sessionId = randomUUID();
    const previousSessions = await this.pool.query<{ count: string }>(
      `select count(*)::text as count from app_sessions where user_id = $1`,
      [user.id],
    );
    await this.pool.query(
      `update app_sessions set is_active = false where user_id = $1`,
      [user.id],
    );
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
    const row = inserted.rows[0];
    row.assigned_course_codes = await this.listAssignedCourseCodesForUser(user.id, user.role);

    return {
      ...mapSessionRow(row),
      isFirstLogin: Number(previousSessions.rows[0]?.count || 0) === 0,
    };
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
      await this.setUserCourseAssignments("user-student-demo", [DEFAULT_RAG_COURSE_CODE], "user-teacher-demo");

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

      await this.seedDefaultRagSources();

      await this.pool.query("commit");
    } catch (error) {
      await this.pool.query("rollback");
      throw error;
    }
  }

  private async seedDefaultRagSources() {
    const seedPath = path.isAbsolute(env.ragSeedPath)
      ? env.ragSeedPath
      : path.resolve(process.cwd(), env.ragSeedPath);
    const raw = await fsp.readFile(seedPath, "utf8").catch((error: NodeJS.ErrnoException) => {
      if (error.code !== "ENOENT") {
        console.warn(`[rag] No se pudo leer seed default ${seedPath}: ${String(error)}`);
      }
      return "";
    });
    if (!trimText(raw)) return;

    const lines = raw
      .split(/\r?\n/)
      .map((line) => trimText(line))
      .filter(Boolean);

    for (const line of lines) {
      let entry: Record<string, unknown>;
      try {
        entry = JSON.parse(line) as Record<string, unknown>;
      } catch {
        continue;
      }

      const sourceKey = trimText(String(entry.id ?? "")) || `seed-${contentHash(line).slice(0, 16)}`;
      const title = trimText(String(entry.title ?? "")) || sourceKey;
      const sourceType = trimText(String(entry.type ?? entry.source_type ?? "seed"));
      const fileName = trimText(String(entry.suggested_name ?? entry.path ?? title));
      const contentText = seedEntryText(entry);
      const metadata = {
        ...entry,
        ...ragCourseMetadata(DEFAULT_RAG_COURSE_CODE),
        seeded_from: env.ragSeedPath,
      };

      const result = await this.pool.query<RagSourceRow>(
        `
        insert into rag_sources (
          id,
          scope,
          teacher_user_id,
          source_key,
          title,
          source_type,
          file_name,
          mime_type,
          content_sha256,
          content_text,
          metadata,
          is_active,
          created_by_user_id,
          created_at,
          updated_at
        )
        values (
          $1,
          'default',
          null,
          $2,
          $3,
          $4,
          $5,
          '',
          $6,
          $7,
          $8::jsonb,
          true,
          null,
          now(),
          now()
        )
        on conflict (id) do update
        set
          scope = 'default',
          teacher_user_id = null,
          source_key = excluded.source_key,
          title = excluded.title,
          source_type = excluded.source_type,
          file_name = excluded.file_name,
          content_sha256 = excluded.content_sha256,
          content_text = excluded.content_text,
          metadata = excluded.metadata,
          is_active = true,
          updated_at = now()
        returning
          id,
          scope,
          teacher_user_id,
          source_key,
          title,
          source_type,
          file_name,
          mime_type,
          content_sha256,
          content_text,
          metadata,
          is_active,
          created_by_user_id,
          created_at,
          updated_at
        `,
        [
          sourceKey,
          sourceKey,
          title.slice(0, 260),
          sourceType.slice(0, 80) || "seed",
          fileName.slice(0, 500),
          contentHash(contentText),
          contentText,
          JSON.stringify(metadata),
        ],
      );
      const source = result.rows[0] ? mapRagSourceRow(result.rows[0]) : null;
      if (source) {
        await this.replaceRagSourceChunks(source, buildRagChunksForSource({
          title: source.title,
          sourceType: source.sourceType,
          fileName: source.fileName,
          sourceKey: source.sourceKey,
          contentText: source.contentText,
          metadata: source.metadata,
        }));
      }
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

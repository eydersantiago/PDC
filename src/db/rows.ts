// Base de datos: tipos de filas, mapeadores de filas y utilidades compartidas por las clases de src/db/repos/.
// Movido sin cambios desde src/db/database.ts (solo se agrego "export" a lo que no lo tenia).
import { createHash, randomUUID, scryptSync, timingSafeEqual } from "node:crypto";
import type { AppSession, AppSessionKind, AppUser, BehaviorEventCategory, BehaviorEventItem, BehaviorEventSource, BehaviorEventSummaryItem, RagSource, RagSourceChunk, RagSourceScope, TeacherPolicy, UserRoleCode } from "../types/app.js";
import { normalizeQuizSettings } from "../services/quiz-settings.js";
import { normalizeCodeApplicationSettings, normalizeEventRules } from "../services/policy-settings.js";
import type { EffectiveRagLot, RagLot } from "../services/rag-lots.js";
import { normalizeRagCourseCode, normalizeRagCourseCodes } from "../services/rag-courses.js";
import { trimText } from "../services/text-utils.js";

export type SessionRow = {
  session_id: string;
  created_at: string | Date;
  last_seen_at: string | Date;
  user_id: string;
  role: UserRoleCode;
  email: string;
  display_name: string;
  teacher_user_id: string | null;
  assigned_course_codes?: unknown;
  kind?: string | null;
  expires_at?: string | Date | null;
  label?: string | null;
};

export type ActiveUserRow = {
  user_id: string;
  teacher_user_id: string | null;
  email: string;
  display_name: string;
  role: UserRoleCode;
};

export type CreateSessionOptions = {
  kind?: AppSessionKind;
  label?: string | null;
  expiresAt?: Date | null;
};

// Sesiones editor activas que se conservan por usuario (varios equipos a la
// vez: tunel, Mac del laboratorio, VS Code de la casa). Las mas viejas se
// desactivan al crear una nueva, para que la tabla no crezca sin limite.
export const MAX_ACTIVE_EDITOR_SESSIONS = 10;

export function normalizeSessionKind(value: unknown): AppSessionKind {
  return value === "editor" || value === "cli" ? value : "browser";
}

export type PolicyRow = {
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
  quiz_settings?: unknown;
  code_application_settings?: unknown;
  updated_at: string | Date;
};

/** Ultima politica de privacidad aceptada por el usuario (payload privacy de login y me). */
export type PrivacyAcceptance = {
  version: string | null;
  acceptedAt: string | null;
};

/** Fila de app_settings con el nombre de quien la cambio (null si ya no existe el usuario). */
export type AppSetting = {
  key: string;
  value: string;
  updatedByUserId: string | null;
  updatedByName: string | null;
  updatedAt: string;
};

export type WorkspaceConsentRow = {
  user_id: string;
  can_read: boolean;
  can_modify: boolean;
  can_analyze: boolean;
  granted_at: string | Date;
  updated_at: string | Date;
};

export type UserActiveTabRow = {
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

export type GithubInstallStateRow = {
  state: string;
  session_id: string | null;
  user_id: string;
  repo_full_name: string;
  expires_at: string | Date;
};

export type GithubInstallationRow = {
  installation_id: string;
  user_id: string;
  account_login: string;
  account_type: string;
  repository_selection: string;
  created_at: string | Date;
  updated_at: string | Date;
};

export type GithubOAuthStateRow = {
  state: string;
  session_id: string | null;
  user_id: string;
  repo_full_name: string;
  expires_at: string | Date;
};

export type GithubUserTokenRow = {
  user_id: string;
  account_login: string;
  account_email: string;
  access_token: string;
  token_type: string;
  scopes: string;
  created_at: string | Date;
  updated_at: string | Date;
};

export type GithubRepoBootstrapRow = {
  user_id: string;
  repo_full_name: string;
  is_bootstrapped: boolean;
  source: string;
  details: string;
  created_at: string | Date;
  updated_at: string | Date;
};

export type ManagedUserRow = {
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

export type CourseAssignmentRow = {
  user_id: string;
  course_code: string;
};

export type BehaviorEventRow = {
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

export type BehaviorEventSummaryRow = {
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

export type RagSourceRow = {
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

export type RagSourceChunkRow = {
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

export function toIso(value: string | Date) {
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
}

export function normalizeRepoKey(repoFullName: string) {
  return String(repoFullName || "").trim().toLowerCase();
}

export function mapSessionRow(row: SessionRow): AppSession {
  const assignedCourseCodes = normalizeAssignedCourseCodes(row.assigned_course_codes, row.role);
  return {
    id: row.session_id,
    createdAt: toIso(row.created_at),
    lastSeenAt: toIso(row.last_seen_at),
    kind: normalizeSessionKind(row.kind),
    expiresAt: row.expires_at ? toIso(row.expires_at) : null,
    label: row.label || null,
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

export function mapActiveUserRow(row: ActiveUserRow): AppUser {
  return {
    id: row.user_id,
    role: row.role,
    email: row.email,
    displayName: row.display_name,
    teacherUserId: row.teacher_user_id,
  };
}

export function mapPolicyRow(row: PolicyRow): TeacherPolicy {
  return {
    id: row.id,
    teacherUserId: row.teacher_user_id,
    policyName: row.policy_name,
    outcome: row.outcome,
    tone: row.tone,
    frequency: row.frequency,
    helpLevel: row.help_level,
    allowMiniQuiz: row.allow_mini_quiz,
    quizSettings: normalizeQuizSettings(row.quiz_settings),
    codeApplication: normalizeCodeApplicationSettings(row.code_application_settings),
    strictNoSolution: row.strict_no_solution,
    maxHintsPerExercise: row.max_hints_per_exercise,
    fallbackMessage: row.fallback_message,
    customInstruction: row.custom_instruction,
    allowedInterventions: Array.isArray(row.allowed_interventions) ? row.allowed_interventions : [],
    allowedTopics: Array.isArray(row.allowed_topics) ? row.allowed_topics : [],
    eventRules: normalizeEventRules(row.event_rules),
    updatedAt: toIso(row.updated_at),
  };
}

export function verifyPassword(rawPassword: string, storedHash: string) {
  const [salt, hash] = String(storedHash || "").split(":");
  if (!salt || !hash) return false;

  const derived = scryptSync(rawPassword, salt, 64);
  const stored = Buffer.from(hash, "hex");
  if (stored.length !== derived.length) return false;
  return timingSafeEqual(stored, derived);
}

export function hashPassword(rawPassword: string) {
  const salt = randomUUID().replace(/-/g, "");
  const derived = scryptSync(rawPassword, salt, 64).toString("hex");
  return `${salt}:${derived}`;
}

export type ManagedUser = {
  id: string;
  role: string;
  email: string;
  displayName: string;
  teacherUserId: string | null;
  teacherDisplayName: string | null;
  assignedCourseCodes: string[];
  isActive: boolean;
  createdAt: string;
  /** Solo estudiantes: lote de RAG que les aplica por curso (0.7.15). */
  ragLots: Record<string, { lotId: string; lotName: string; origin: EffectiveRagLot["origin"] }>;
};

export function mapManagedUserRow(row: ManagedUserRow): ManagedUser {
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
    ragLots: {},
  };
}

export function mapBehaviorEventRow(row: BehaviorEventRow): BehaviorEventItem {
  return {
    id: row.id,
    userId: row.user_id,
    teacherUserId: row.teacher_user_id,
    // Nunca sale el id de sesion: con el se actua como el estudiante (las
    // sesiones editor duran 30 dias) y el docente lista estos eventos.
    sessionId: null,
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

export function mapBehaviorSummaryRow(row: BehaviorEventSummaryRow): BehaviorEventSummaryItem {
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

export function safeJsonObject(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

export type RagLotRow = {
  id: string;
  teacher_user_id: string;
  course_code: string;
  name: string;
  description: string;
  includes_base: boolean;
  is_active: boolean;
  created_at: string | Date;
  updated_at: string | Date;
};

export function mapRagLotRow(row: RagLotRow): RagLot {
  return {
    id: row.id,
    teacherUserId: row.teacher_user_id,
    courseCode: normalizeRagCourseCode(row.course_code),
    name: row.name,
    description: row.description || "",
    includesBase: row.includes_base !== false,
    isActive: row.is_active !== false,
    createdAt: toIso(row.created_at),
    updatedAt: toIso(row.updated_at),
  };
}

export function mapRagSourceRow(row: RagSourceRow): RagSource {
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

export function mapRagChunkRow(row: RagSourceChunkRow): RagSourceChunk {
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

export function seedEntryText(entry: Record<string, unknown>) {
  return [
    entry.id,
    entry.title,
    entry.description,
    entry.content,
    entry.courseCode,
    entry.courseName,
    entry.role,
    entry.category,
    entry.authors,
    entry.publisher,
    entry.year,
    entry.edition,
    entry.isbn,
    entry.access_status,
    entry.license,
    entry.topics,
    entry.keywords,
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

export function contentHash(value: string) {
  return createHash("sha256").update(value).digest("hex");
}

export function estimateRagTokenCount(value: string) {
  const words = trimText(value).split(/\s+/).filter(Boolean).length;
  return Math.max(1, Math.ceil(words * 1.25));
}

export function optionalPositiveInteger(value: unknown) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) return null;
  return Math.round(parsed);
}

export function normalizeAssignedCourseCodes(value: unknown, role: UserRoleCode = "student") {
  return normalizeRagCourseCodes(value, {
    fallbackToDefault: role === "student",
    knownOnly: true,
  });
}

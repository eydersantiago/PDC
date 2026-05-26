import { sql } from "drizzle-orm";
import { AnyPgColumn, boolean, integer, jsonb, pgTable, text, timestamp, unique } from "drizzle-orm/pg-core";

export const roles = pgTable("roles", {
  id: text("id").primaryKey(),
  code: text("code").notNull().unique(),
  name: text("name").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export const users = pgTable("users", {
  id: text("id").primaryKey(),
  roleId: text("role_id").notNull().references(() => roles.id),
  teacherUserId: text("teacher_user_id").references((): AnyPgColumn => users.id),
  email: text("email").notNull().unique(),
  displayName: text("display_name").notNull(),
  passwordHash: text("password_hash").notNull(),
  isActive: boolean("is_active").notNull().default(true),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export const appSessions = pgTable("app_sessions", {
  id: text("id").primaryKey(),
  userId: text("user_id").notNull().references(() => users.id),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  lastSeenAt: timestamp("last_seen_at", { withTimezone: true }).notNull().defaultNow(),
  isActive: boolean("is_active").notNull().default(true),
});

export const privacyPolicyAcceptances = pgTable(
  "privacy_policy_acceptances",
  {
    id: text("id").primaryKey(),
    userId: text("user_id").notNull().references(() => users.id),
    policyVersion: text("policy_version").notNull(),
    policyUrl: text("policy_url").notNull().default(""),
    acceptedUserAgent: text("accepted_user_agent").notNull().default(""),
    acceptedIp: text("accepted_ip").notNull().default(""),
    acceptedAt: timestamp("accepted_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    unique("privacy_policy_acceptances_user_version_unique").on(table.userId, table.policyVersion),
  ],
);

export const teacherPolicies = pgTable("teacher_policies", {
  id: text("id").primaryKey(),
  teacherUserId: text("teacher_user_id").notNull().unique().references(() => users.id),
  policyName: text("policy_name").notNull(),
  outcome: text("outcome").notNull(),
  tone: text("tone").notNull(),
  frequency: text("frequency").notNull(),
  helpLevel: text("help_level").notNull(),
  allowMiniQuiz: boolean("allow_mini_quiz").notNull().default(true),
  strictNoSolution: boolean("strict_no_solution").notNull().default(true),
  maxHintsPerExercise: integer("max_hints_per_exercise"),
  fallbackMessage: text("fallback_message").notNull(),
  customInstruction: text("custom_instruction").notNull().default(""),
  allowedInterventions: jsonb("allowed_interventions").$type<string[]>().notNull().default(sql`'[]'::jsonb`),
  allowedTopics: jsonb("allowed_topics").$type<string[]>().notNull().default(sql`'[]'::jsonb`),
  eventRules: jsonb("event_rules").$type<Record<string, unknown>>().notNull().default(sql`'{}'::jsonb`),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

export const studentExerciseProgress = pgTable(
  "student_exercise_progress",
  {
    id: text("id").primaryKey(),
    studentUserId: text("student_user_id").notNull().references(() => users.id),
    exerciseKey: text("exercise_key").notNull(),
    hintCount: integer("hint_count").notNull().default(0),
    lastInterventionAt: timestamp("last_intervention_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    unique("student_exercise_progress_student_user_exercise_unique").on(table.studentUserId, table.exerciseKey),
  ],
);

export const interventionTelemetry = pgTable("intervention_telemetry", {
  id: text("id").primaryKey(),
  sessionId: text("session_id").notNull().references(() => appSessions.id),
  studentUserId: text("student_user_id").references(() => users.id),
  teacherUserId: text("teacher_user_id").references(() => users.id),
  eventType: text("event_type").notNull(),
  interventionType: text("intervention_type").notNull(),
  detailLevel: text("detail_level").notNull(),
  policyName: text("policy_name").notNull(),
  exerciseKey: text("exercise_key"),
  blocked: boolean("blocked").notNull().default(false),
  reason: text("reason").notNull().default(""),
  contextSummary: text("context_summary").notNull().default(""),
  policySnapshot: jsonb("policy_snapshot").$type<Record<string, unknown>>().notNull().default(sql`'{}'::jsonb`),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export const projectMemories = pgTable(
  "project_memories",
  {
    id: text("id").primaryKey(),
    ownerUserId: text("owner_user_id").notNull().references(() => users.id),
    workspaceKey: text("workspace_key").notNull(),
    repoFullName: text("repo_full_name").notNull(),
    branch: text("branch").notNull().default(""),
    projectLabel: text("project_label").notNull().default(""),
    snapshotJson: jsonb("snapshot_json").$type<Record<string, unknown>>().notNull().default(sql`'{}'::jsonb`),
    filesJson: jsonb("files_json").$type<Record<string, unknown>[]>().notNull().default(sql`'[]'::jsonb`),
    metricsJson: jsonb("metrics_json").$type<Record<string, unknown>>().notNull().default(sql`'{"suggestionsReceived":0,"suggestionsAccepted":0,"errorsDetected":0,"quizzesTaken":0}'::jsonb`),
    savedBy: text("saved_by").notNull().default("manual"),
    lastActivityAt: timestamp("last_activity_at", { withTimezone: true }).notNull().defaultNow(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    unique("project_memories_owner_workspace_unique").on(table.ownerUserId, table.workspaceKey),
  ],
);

export const jobs = pgTable("jobs", {
  id: text("id").primaryKey(),
  userId: text("user_id").references(() => users.id),
  kind: text("kind").notNull(),
  model: text("model"),
  status: text("status").notNull(),
  inputJson: jsonb("input_json").$type<Record<string, unknown> | string | unknown[]>().notNull(),
  minVramGb: integer("min_vram_gb"),
  assignedWorkerId: text("assigned_worker_id"),
  error: text("error"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  startedAt: timestamp("started_at", { withTimezone: true }),
  completedAt: timestamp("completed_at", { withTimezone: true }),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

export const jobResults = pgTable(
  "job_results",
  {
    id: text("id").primaryKey(),
    jobId: text("job_id").notNull().references(() => jobs.id),
    outputJson: jsonb("output_json").$type<unknown>(),
    outputText: text("output_text"),
    workerId: text("worker_id"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    unique("job_results_job_id_unique").on(table.jobId),
  ],
);

export const workerNodes = pgTable("worker_nodes", {
  workerId: text("worker_id").primaryKey(),
  workerRole: text("worker_role"),
  hostname: text("hostname"),
  status: text("status").notNull().default("online"),
  vramGb: integer("vram_gb"),
  observedVramGb: integer("observed_vram_gb"),
  supportedModels: jsonb("supported_models").$type<string[]>().default(sql`'[]'::jsonb`),
  ollamaStatus: jsonb("ollama_status").$type<Record<string, unknown>>().default(sql`'{}'::jsonb`),
  maxParallelJobs: integer("max_parallel_jobs"),
  lastSeenAt: timestamp("last_seen_at", { withTimezone: true }).notNull().defaultNow(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

export const usageCounters = pgTable(
  "usage_counters",
  {
    id: text("id").primaryKey(),
    userId: text("user_id"),
    period: text("period").notNull(),
    jobsCount: integer("jobs_count").notNull().default(0),
    charsIn: integer("chars_in").notNull().default(0),
    charsOut: integer("chars_out").notNull().default(0),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    unique("usage_counters_user_period_unique").on(table.userId, table.period),
  ],
);

export type MentorPageContext = "campus" | "github" | "unknown";

export type LearningGoalId =
  | "oop_basics"
  | "encapsulation"
  | "inheritance"
  | "debugging"
  | "github_flow";

export type GithubMentorPageType =
  | "campus"
  | "campus_course"
  | "campus_courses"
  | "github_code"
  | "github_general"
  | "codespace"
  | "other";

export type GithubMentorContext = {
  url?: string;
  title?: string;
  pageContext?: MentorPageContext;
  pageType?: GithubMentorPageType;
  repoOwner?: string;
  repoName?: string;
  repoFullName?: string;
  branch?: string;
  filePath?: string;
  languageHint?: string;
  activityTitle?: string;
  activityDeadline?: string;
  learningGoal?: LearningGoalId;
  courseCode?: string;
  ragCourseCode?: string;
  selection?: string;
  visibleError?: string;
  codeSnippet?: string;
  codeLineCount?: number;
};

export type GithubMentorResult = {
  ideas: string[];
  searches: string[];
  guide: string[];
  welcome_message: string;
  analysis_summary: string;
};

export type UserRoleCode = "student" | "teacher" | "admin";

export type InterventionType =
  | "explanation"
  | "hint"
  | "example"
  | "mini_quiz"
  | "controlled_message";

export type PolicyEventType =
  | "compile_error"
  | "runtime_error"
  | "concept_question"
  | "design_block"
  | "workflow_guidance"
  | "insufficient_context"
  | "out_of_domain"
  /** Sugerencias de VS Code sin error ni pregunta conceptual (canal /suggest-tab). */
  | "code_suggestion";

export type PolicyDetailLevel = "brief" | "guided" | "progressive";

export type PolicyRule = {
  enabled: boolean;
  interventionType: InterventionType;
  detailLevel: PolicyDetailLevel;
  activationThreshold: number;
  maxUsesPerSession: number | null;
};

export type TeacherPolicy = {
  id: string;
  teacherUserId: string;
  policyName: string;
  outcome: string;
  tone: "warm" | "direct" | "socratic";
  frequency: "low" | "medium" | "high";
  helpLevel: "progressive" | "hint_only" | "partial_example";
  allowMiniQuiz: boolean;
  /** Cuando y como sale el mini quiz (ver src/services/quiz-settings.ts). */
  quizSettings: QuizSettings;
  /** Si VS Code puede aplicar codigo del tutor y con que limites (ver src/services/policy-settings.ts). */
  codeApplication: CodeApplicationSettings;
  strictNoSolution: boolean;
  maxHintsPerExercise: number | null;
  fallbackMessage: string;
  customInstruction: string;
  allowedInterventions: InterventionType[];
  allowedTopics: string[];
  eventRules: Record<PolicyEventType, PolicyRule>;
  updatedAt: string;
};

export type QuizTrigger = "after_accept" | "teacher_launch";

export type CodeApplicationSettings = {
  /** Si el estudiante puede aplicar en su archivo el codigo que sugiere el tutor. */
  allowed: boolean;
  /** Maximo de lineas cambiadas por aplicacion (1..200). */
  maxLines: number;
  /** Cada aplicacion cuenta contra maxHintsPerExercise del archivo. */
  countsAsHint: boolean;
  /** VS Code pide confirmacion aunque el estudiante tenga auto-aplicar activo. */
  requireConfirmation: boolean;
};

/** Etapa de ayuda que el motor eligio para una intervencion (A2.2: pista 1, pista 2, ejemplo parcial...). */
export type HelpStage = "hint_1" | "hint_2" | "partial_example" | "explanation" | "mini_quiz" | "controlled";

/** Codigo corto y estable del motivo de una decision del tutor (para telemetria y analisis). */
export type DecisionReasonCode =
  | "ok"
  | "rule_disabled"
  | "insufficient_context"
  | "out_of_domain"
  | "hint_limit_reached"
  | "controlled_message"
  | "code_application_disabled"
  | "code_application_too_large"
  | "code_application_limit_reached"
  | "model_error_fallback"
  | "pilot_no_tutor";

export type QuizSettings = {
  /** Momentos en que puede salir un quiz. Por defecto, los dos. */
  triggers: QuizTrigger[];
  /** Tras aceptar sugerencias: uno cada N aceptadas (1 = siempre). */
  everyNAccepts: number;
  /** Maximo de quices tras aceptar por estudiante en 12 h; null = sin limite. */
  maxPerSession: number | null;
  /** Si falla la opcion multiple, pedir una explicacion abierta. */
  followUpOnWrong: boolean;
};

export type StudentQuizStatus = "pending" | "followup" | "done" | "skipped" | "expired";

export type StudentQuizRecord = {
  id: string;
  clientKey: string;
  userId: string | null;
  teacherUserId: string | null;
  sessionId: string | null;
  trigger: QuizTrigger;
  launchId: string | null;
  status: StudentQuizStatus;
  language: string;
  filePath: string;
  topic: string;
  question: string;
  options: string[];
  correctIndex: number;
  explanation: string;
  followupQuestion: string;
  chosenIndex: number | null;
  correct: boolean | null;
  followupAnswer: string;
  followupScore: number | null;
  followupFeedback: string;
  codeContext: Record<string, unknown>;
  createdAt: string;
  answeredAt: string | null;
  completedAt: string | null;
};

export type QuizLaunchRecord = {
  id: string;
  teacherUserId: string;
  courseCode: string;
  topic: string;
  question: string;
  options: string[];
  correctIndex: number;
  explanation: string;
  followupQuestion: string;
  active: boolean;
  createdAt: string;
  expiresAt: string | null;
};

export type AppUser = {
  id: string;
  role: UserRoleCode;
  email: string;
  displayName: string;
  teacherUserId: string | null;
  assignedCourseCodes?: string[];
  activeCourseCode?: string | null;
};

export type AppSession = {
  id: string;
  user: AppUser;
  createdAt: string;
  lastSeenAt: string;
  isFirstLogin?: boolean;
};

export type RagSourceScope = "default" | "teacher";

export type RagSource = {
  id: string;
  scope: RagSourceScope;
  teacherUserId: string | null;
  sourceKey: string;
  title: string;
  sourceType: string;
  fileName: string;
  mimeType: string;
  contentSha256: string;
  contentText: string;
  metadata: Record<string, unknown>;
  isActive: boolean;
  createdByUserId: string | null;
  createdAt: string;
  updatedAt: string;
  chunks?: RagSourceChunk[];
};

export type RagSourceChunk = {
  id: string;
  sourceId: string;
  scope: RagSourceScope;
  teacherUserId: string | null;
  sourceKey: string;
  sourceTitle: string;
  sourceType: string;
  fileName: string;
  mimeType: string;
  sourceMetadata: Record<string, unknown>;
  isActive: boolean;
  chunkIndex: number;
  contentText: string;
  searchText: string;
  tokenCount: number;
  charStart: number;
  charEnd: number;
  pageStart: number | null;
  pageEnd: number | null;
  citationLabel: string;
  metadata: Record<string, unknown>;
  createdAt: string;
};

export type RagSourceChunkInput = {
  chunkIndex: number;
  contentText: string;
  searchText: string;
  tokenCount: number;
  charStart: number;
  charEnd: number;
  pageStart: number | null;
  pageEnd: number | null;
  citationLabel: string;
  metadata: Record<string, unknown>;
};

export type RagCitation = {
  marker: string;
  label: string;
  sourceId: string;
  chunkId: string;
  title: string;
  fileName: string;
  pageStart: number | null;
  pageEnd: number | null;
  url: string;
};

export type RagContextItem = {
  id: string;
  sourceId: string;
  chunkId: string;
  scope: RagSourceScope;
  title: string;
  sourceType: string;
  fileName: string;
  excerpt: string;
  score: number;
  ftsScore: number;
  semanticScore: number;
  usageReason: string;
  matchedTerms: string[];
  isOpenable: boolean;
  citation: RagCitation;
  citationLabel: string;
  pageStart: number | null;
  pageEnd: number | null;
  chunkIndex: number;
  metadata: Record<string, unknown>;
};

export type TelemetryItem = {
  id: string;
  sessionId: string;
  studentUserId: string | null;
  teacherUserId: string | null;
  eventType: PolicyEventType;
  interventionType: InterventionType;
  detailLevel: PolicyDetailLevel;
  policyName: string;
  exerciseKey: string | null;
  blocked: boolean;
  reason: string;
  contextSummary: string;
  createdAt: string;
  studentName: string | null;
};

export type BehaviorEventSource =
  | "browser_extension"
  | "vscode_extension"
  | "backend"
  | "system";

export type BehaviorEventCategory =
  | "suggestion"
  | "cursor_idle"
  | "codespace"
  | "github_pr"
  | "navigation"
  | "project_context"
  | "intervention"
  | "error"
  | "workflow"
  // v1.1
  | "tutor"
  | "signal"
  | "code_application"
  | "quiz";

export type BehaviorEventInput = {
  source: BehaviorEventSource;
  category: BehaviorEventCategory;
  eventType: string;
  pageContext?: MentorPageContext | GithubMentorPageType | string;
  repoFullName?: string;
  branch?: string;
  filePath?: string;
  language?: string;
  subjectId?: string;
  value?: string;
  durationMs?: number | null;
  count?: number | null;
  metadata?: Record<string, unknown>;
  occurredAt?: string;
  // Telemetria v1.1 (se copian a telemetry_events; ver src/services/telemetry.ts)
  schemaVersion?: string;
  seq?: number | null;
  clientSessionId?: string;
  decisionId?: string;
  latencyMs?: number | null;
  /** Hash del error; el texto nunca se guarda. */
  errorHash?: string;
  contextHash?: string;
};

export type BehaviorEventItem = BehaviorEventInput & {
  id: string;
  userId: string;
  teacherUserId: string | null;
  sessionId: string | null;
  durationMs: number | null;
  count: number;
  occurredAt: string;
  createdAt: string;
  studentName?: string | null;
};

export type BehaviorEventSummaryItem = {
  userId: string;
  studentName: string | null;
  teacherUserId: string | null;
  source: BehaviorEventSource;
  category: BehaviorEventCategory;
  eventType: string;
  totalEvents: number;
  totalCount: number;
  totalDurationMs: number;
  averageDurationMs: number | null;
  firstOccurredAt: string;
  lastOccurredAt: string;
};

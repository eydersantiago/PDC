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
  | "out_of_domain";

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
  strictNoSolution: boolean;
  maxHintsPerExercise: number | null;
  fallbackMessage: string;
  customInstruction: string;
  allowedInterventions: InterventionType[];
  allowedTopics: string[];
  eventRules: Record<PolicyEventType, PolicyRule>;
  updatedAt: string;
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
  | "workflow";

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

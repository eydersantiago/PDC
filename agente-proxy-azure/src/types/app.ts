export type MentorPageContext = "campus" | "github" | "unknown";

export type LearningGoalId =
  | "oop_basics"
  | "encapsulation"
  | "inheritance"
  | "debugging"
  | "github_flow";

export type GithubMentorPageType =
  | "campus"
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
  learningGoal?: LearningGoalId;
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
};

export type AppSession = {
  id: string;
  user: AppUser;
  createdAt: string;
  lastSeenAt: string;
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

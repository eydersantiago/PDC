// Progreso por estudiante: filas que lee la base y forma del resumen y del detalle para el panel del docente.
import { type PresenceState } from "../analytics/real-activity.js";

export type StudentProfileRow = {
  id: string;
  email: string;
  displayName: string;
  isActive: boolean;
  createdAt: string;
  teacherUserId: string | null;
  teacherDisplayName: string | null;
  assignedCourseCodes: string[];
};

export type SessionAggregateRow = {
  user_id: string;
  kind: string;
  total: string;
  active_total: string;
  first_seen_at: string | Date | null;
  last_seen_at: string | Date | null;
};

export type InterventionAggregateRow = {
  user_id: string;
  total: string;
  blocked_total: string;
  hints: string;
  explanations: string;
  examples: string;
  mini_quizzes: string;
  last_at: string | Date | null;
};

export type QuizAggregateRow = {
  user_id: string;
  total: string;
  answered: string;
  correct_total: string;
  scored: string;
  followup_sum: string;
  skipped: string;
  last_at: string | Date | null;
};

export type ActivityAggregateRow = {
  user_id: string;
  /** browser_extension, vscode_extension o backend (filas anteriores: ausente). */
  source?: string | null;
  category: string;
  total: string;
  duration_ms: string;
  last_at: string | Date | null;
};

export type ExerciseAggregateRow = {
  user_id: string;
  exercises: string;
  hints: string;
  last_at: string | Date | null;
};

export type PilotCohortRow = {
  student_user_id: string;
  cohort: string;
};

export type StudentSessionItem = {
  kind: string;
  label: string | null;
  createdAt: string;
  lastSeenAt: string;
  expiresAt: string | null;
  isActive: boolean;
  durationMinutes: number;
};

export type StudentInterventionItem = {
  id: string;
  eventType: string;
  interventionType: string;
  detailLevel: string;
  policyName: string;
  exerciseKey: string | null;
  blocked: boolean;
  reason: string;
  contextSummary: string;
  createdAt: string;
};

export type StudentQuizItem = {
  id: string;
  trigger: string;
  status: string;
  topic: string;
  question: string;
  language: string;
  filePath: string;
  answered: boolean;
  correct: boolean | null;
  chosenOption: string | null;
  correctOption: string | null;
  followupAnswered: boolean;
  followupScore: number | null;
  followupFeedback: string;
  createdAt: string;
  answeredAt: string | null;
  completedAt: string | null;
};

export type StudentExerciseItem = {
  exerciseKey: string;
  hintCount: number;
  lastInterventionAt: string;
};

export type StudentActivityItem = {
  category: string;
  eventType: string;
  source: string;
  totalEvents: number;
  totalCount: number;
  totalDurationMs: number;
  lastOccurredAt: string;
};

export type QuizGrade = {
  /** 0 a 100; null sin quices respondidos ni seguimientos calificados. */
  score: number | null;
  /** Equivalente en la escala 0 a 5 (una decimal). */
  scale5: number | null;
  level: "alto" | "medio" | "bajo" | "sin_datos";
  label: string;
  correctRate: number | null;
  averageFollowUpScore: number | null;
  /** Como se calculo, para mostrarlo en el panel. */
  formula: string;
};

/** Otra cuenta que parece ser de la misma persona (mismo nombre): se marca, no se une sola. */
export type PossibleDuplicate = {
  otherUserId: string;
  otherDisplayName: string;
  otherEmail: string;
  /** Por que se marca, en una frase para el docente. */
  reason: string;
};

/** Un estudiante con sus posibles duplicados (UsersDatabase.listPossibleDuplicateStudents). */
export type PossibleDuplicateGroup = {
  userId: string;
  displayName: string;
  email: string;
  hasSignedIn: boolean;
  duplicates: PossibleDuplicate[];
};

export type StudentPresence = {
  state: PresenceState;
  label: string;
  /** Ultima vez con el tutor, en el editor y con solo la pestana (o la sesion) abierta. */
  tutorAt: string | null;
  editorAt: string | null;
  tabAt: string | null;
};

export type StudentProgressSummary = {
  id: string;
  displayName: string;
  email: string;
  isActive: boolean;
  createdAt: string;
  /** Cuenta demo, de prueba o de ruta demo: fuera de los totales. */
  sampleAccount: boolean;
  presence: StudentPresence;
  possibleDuplicates: PossibleDuplicate[];
  teacherUserId: string | null;
  teacherDisplayName: string | null;
  assignedCourseCodes: string[];
  pilotCohort: string | null;
  sessions: {
    total: number;
    browser: number;
    editor: number;
    cli: number;
    active: number;
    firstSeenAt: string | null;
    lastSeenAt: string | null;
    /** Actividad real (tutor o editor) en los ultimos 15 minutos: ver presence. */
    activeNow: boolean;
  };
  interventions: {
    total: number;
    blocked: number;
    hints: number;
    explanations: number;
    examples: number;
    miniQuizzes: number;
    lastAt: string | null;
  };
  quizzes: {
    total: number;
    answered: number;
    correct: number;
    correctRate: number | null;
    followUps: number;
    averageFollowUpScore: number | null;
    skipped: number;
    lastAt: string | null;
  };
  activity: {
    events: number;
    byCategory: Record<string, number>;
    totalDurationMs: number;
    lastAt: string | null;
  };
  exercises: {
    total: number;
    hints: number;
    lastAt: string | null;
  };
  grade: QuizGrade;
  /** Ultima actividad real: intervenciones, quices y eventos de tutor o editor (no la sesion abierta). */
  lastActivityAt: string | null;
};

/** Totales sin las cuentas de muestra. */
export type StudentProgressTotals = {
  students: number;
  activeNow: number;
  /** Con ADACEEN abierto en 15 min pero sin actividad real. */
  tabOnly: number;
  /** Cuentas de muestra en la lista (no suman en ningun otro total). */
  sampleAccounts: number;
  /** Estudiantes marcados como posible cuenta duplicada. */
  possibleDuplicates: number;
  withQuizzes: number;
  averageGrade: number | null;
  interventions: number;
  blocked: number;
};

export type TimelinePoint = {
  day: string;
  sessions: number;
  interventions: number;
  quizzes: number;
};

export type StudentProgressDetail = {
  student: StudentProgressSummary;
  sessions: StudentSessionItem[];
  interventions: StudentInterventionItem[];
  quizzes: StudentQuizItem[];
  activity: StudentActivityItem[];
  exercises: StudentExerciseItem[];
  timeline: TimelinePoint[];
};

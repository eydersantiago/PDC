import type { AppUser, StudentQuizRecord } from "../types/app.js";
import { classifyActivity, isRealActivity, PRESENCE_LABELS, type PresenceState } from "./real-activity.js";
import { isSampleAccountId } from "./sample-accounts.js";
import { trimText } from "./text-utils.js";

/**
 * Progreso por estudiante para el panel del docente y del administrador
 * (pestana "Estudiantes" del overlay). Junta, por estudiante, lo que ya
 * guarda el backend en tablas distintas:
 *
 *  - app_sessions: sesiones del navegador, del editor (VS Code) y de consola;
 *  - intervention_telemetry: decisiones del tutor (pistas, explicaciones, bloqueos);
 *  - student_quizzes: mini-quices con su respuesta y la nota del seguimiento;
 *  - user_behavior_events: actividad por categoria (tutor, sugerencias, quiz...);
 *  - student_exercise_progress: pistas usadas por ejercicio;
 *  - pilot_assignments: cohorte del piloto AB/BA.
 *
 * Las funciones de este modulo son puras: reciben filas ya leidas y devuelven
 * el resumen. Las consultas estan en db/database.ts (listStudentProgressRows
 * y getStudentProgressDetailRows).
 *
 * Desde el examen del 28-10-2026, «activo ahora» es actividad real en 15 min (con el tutor o en
 * el editor, src/services/real-activity.ts), no una sesion que el overlay renueva solo cada 9 s;
 * quien solo tiene la pestana abierta sale como «Solo pestaña abierta». Las cuentas de muestra
 * (src/services/sample-accounts.ts) salen marcadas y al final, fuera de los totales.
 */

export const RECENT_ACTIVITY_WINDOW_MS = 15 * 60 * 1000;
export const TIMELINE_DAYS = 14;

/** Peso de cada componente en la nota de quices (0 a 100). */
export const QUIZ_GRADE_WEIGHTS = Object.freeze({ correctRate: 0.6, followUp: 0.4 });

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

function toInt(value: unknown) {
  const parsed = Number.parseInt(String(value ?? "0"), 10);
  return Number.isFinite(parsed) ? parsed : 0;
}

function toIsoOrNull(value: string | Date | null | undefined) {
  if (value === null || value === undefined || value === "") return null;
  const date = value instanceof Date ? value : new Date(value);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

function laterIso(a: string | null, b: string | null) {
  if (!a) return b;
  if (!b) return a;
  return Date.parse(a) >= Date.parse(b) ? a : b;
}

function earlierIso(a: string | null, b: string | null) {
  if (!a) return b;
  if (!b) return a;
  return Date.parse(a) <= Date.parse(b) ? a : b;
}

export function canViewStudentProgress(viewer: Pick<AppUser, "role">) {
  return viewer.role === "admin" || viewer.role === "teacher";
}

export function canViewStudent(viewer: Pick<AppUser, "id" | "role">, student: Pick<StudentProfileRow, "teacherUserId">) {
  if (viewer.role === "admin") return true;
  if (viewer.role === "teacher") return student.teacherUserId === viewer.id;
  return false;
}

/**
 * Nota de quices: 60 % del porcentaje de aciertos y 40 % de la nota promedio
 * de la pregunta de seguimiento (0 a 100). Si solo hay una de las dos, vale
 * esa sola. Sin datos, null.
 */
export function computeQuizGrade(input: {
  answered: number;
  correct: number;
  scored: number;
  followupSum: number;
}): QuizGrade {
  const correctRate = input.answered > 0 ? Math.round((input.correct / input.answered) * 100) : null;
  const averageFollowUpScore = input.scored > 0 ? Math.round(input.followupSum / input.scored) : null;
  let score: number | null = null;
  let formula = "Sin quices respondidos.";
  if (correctRate !== null && averageFollowUpScore !== null) {
    score = Math.round(correctRate * QUIZ_GRADE_WEIGHTS.correctRate + averageFollowUpScore * QUIZ_GRADE_WEIGHTS.followUp);
    formula = `${Math.round(QUIZ_GRADE_WEIGHTS.correctRate * 100)} % aciertos (${correctRate}) + ${Math.round(QUIZ_GRADE_WEIGHTS.followUp * 100)} % seguimiento (${averageFollowUpScore}).`;
  } else if (correctRate !== null) {
    score = correctRate;
    formula = `Solo aciertos (${correctRate} %): no hay seguimientos calificados.`;
  } else if (averageFollowUpScore !== null) {
    score = averageFollowUpScore;
    formula = `Solo seguimiento (${averageFollowUpScore}): no hay respuestas de opcion multiple.`;
  }
  const scale5 = score === null ? null : Math.round((score / 20) * 10) / 10;
  const level: QuizGrade["level"] = score === null
    ? "sin_datos"
    : score >= 80 ? "alto" : score >= 60 ? "medio" : "bajo";
  const label = level === "sin_datos" ? "Sin quices" : level === "alto" ? "Alto" : level === "medio" ? "Medio" : "Bajo";
  return { score, scale5, level, label, correctRate, averageFollowUpScore, formula };
}

export function buildStudentProgressSummaries(input: {
  students: StudentProfileRow[];
  sessions: SessionAggregateRow[];
  interventions: InterventionAggregateRow[];
  quizzes: QuizAggregateRow[];
  activity: ActivityAggregateRow[];
  exercises: ExerciseAggregateRow[];
  pilot: PilotCohortRow[];
  /** Posibles duplicados (UsersDatabase.listPossibleDuplicateStudents). */
  duplicates?: PossibleDuplicateGroup[];
  now?: Date;
}): { students: StudentProgressSummary[]; totals: StudentProgressTotals } {
  const now = input.now ?? new Date();
  const byId = new Map<string, StudentProgressSummary>();
  const duplicatesById = new Map((input.duplicates || []).map((group) => [group.userId, group.duplicates]));
  // Ultimo evento de cada clase de actividad por estudiante (real-activity.ts).
  const lastByKind = new Map<string, { tutor: string | null; editor: string | null; tab: string | null }>();

  for (const student of input.students) {
    lastByKind.set(student.id, { tutor: null, editor: null, tab: null });
    byId.set(student.id, {
      id: student.id,
      displayName: student.displayName,
      email: student.email,
      isActive: student.isActive,
      createdAt: student.createdAt,
      sampleAccount: isSampleAccountId(student.id),
      presence: { state: "none", label: PRESENCE_LABELS.none, tutorAt: null, editorAt: null, tabAt: null },
      possibleDuplicates: duplicatesById.get(student.id) || [],
      teacherUserId: student.teacherUserId,
      teacherDisplayName: student.teacherDisplayName,
      assignedCourseCodes: [...student.assignedCourseCodes],
      pilotCohort: null,
      sessions: { total: 0, browser: 0, editor: 0, cli: 0, active: 0, firstSeenAt: null, lastSeenAt: null, activeNow: false },
      interventions: { total: 0, blocked: 0, hints: 0, explanations: 0, examples: 0, miniQuizzes: 0, lastAt: null },
      quizzes: { total: 0, answered: 0, correct: 0, correctRate: null, followUps: 0, averageFollowUpScore: null, skipped: 0, lastAt: null },
      activity: { events: 0, byCategory: {}, totalDurationMs: 0, lastAt: null },
      exercises: { total: 0, hints: 0, lastAt: null },
      grade: computeQuizGrade({ answered: 0, correct: 0, scored: 0, followupSum: 0 }),
      lastActivityAt: null,
    });
  }

  for (const row of input.pilot) {
    const student = byId.get(row.student_user_id);
    if (student) student.pilotCohort = trimText(row.cohort) || null;
  }

  for (const row of input.sessions) {
    const student = byId.get(row.user_id);
    if (!student) continue;
    const total = toInt(row.total);
    const kind = trimText(row.kind) || "browser";
    student.sessions.total += total;
    if (kind === "editor") student.sessions.editor += total;
    else if (kind === "cli") student.sessions.cli += total;
    else student.sessions.browser += total;
    student.sessions.active += toInt(row.active_total);
    student.sessions.firstSeenAt = earlierIso(student.sessions.firstSeenAt, toIsoOrNull(row.first_seen_at));
    student.sessions.lastSeenAt = laterIso(student.sessions.lastSeenAt, toIsoOrNull(row.last_seen_at));
  }

  for (const row of input.interventions) {
    const student = byId.get(row.user_id);
    if (!student) continue;
    student.interventions.total += toInt(row.total);
    student.interventions.blocked += toInt(row.blocked_total);
    student.interventions.hints += toInt(row.hints);
    student.interventions.explanations += toInt(row.explanations);
    student.interventions.examples += toInt(row.examples);
    student.interventions.miniQuizzes += toInt(row.mini_quizzes);
    student.interventions.lastAt = laterIso(student.interventions.lastAt, toIsoOrNull(row.last_at));
  }

  const quizInputs = new Map<string, { answered: number; correct: number; scored: number; followupSum: number }>();
  for (const row of input.quizzes) {
    const student = byId.get(row.user_id);
    if (!student) continue;
    const answered = toInt(row.answered);
    const correct = toInt(row.correct_total);
    const scored = toInt(row.scored);
    const followupSum = toInt(row.followup_sum);
    student.quizzes.total += toInt(row.total);
    student.quizzes.answered += answered;
    student.quizzes.correct += correct;
    student.quizzes.followUps += scored;
    student.quizzes.skipped += toInt(row.skipped);
    student.quizzes.lastAt = laterIso(student.quizzes.lastAt, toIsoOrNull(row.last_at));
    const acc = quizInputs.get(row.user_id) || { answered: 0, correct: 0, scored: 0, followupSum: 0 };
    acc.answered += answered;
    acc.correct += correct;
    acc.scored += scored;
    acc.followupSum += followupSum;
    quizInputs.set(row.user_id, acc);
  }

  for (const row of input.activity) {
    const student = byId.get(row.user_id);
    if (!student) continue;
    const total = toInt(row.total);
    const category = trimText(row.category) || "otros";
    student.activity.events += total;
    student.activity.byCategory[category] = (student.activity.byCategory[category] || 0) + total;
    student.activity.totalDurationMs += toInt(row.duration_ms);
    student.activity.lastAt = laterIso(student.activity.lastAt, toIsoOrNull(row.last_at));
    const last = lastByKind.get(row.user_id);
    if (last) {
      const kind = classifyActivity({ source: row.source, category });
      last[kind] = laterIso(last[kind], toIsoOrNull(row.last_at));
    }
  }

  for (const row of input.exercises) {
    const student = byId.get(row.user_id);
    if (!student) continue;
    student.exercises.total += toInt(row.exercises);
    student.exercises.hints += toInt(row.hints);
    student.exercises.lastAt = laterIso(student.exercises.lastAt, toIsoOrNull(row.last_at));
  }

  const students = [...byId.values()];
  for (const student of students) {
    const quiz = quizInputs.get(student.id) || { answered: 0, correct: 0, scored: 0, followupSum: 0 };
    student.grade = computeQuizGrade(quiz);
    student.quizzes.correctRate = student.grade.correctRate;
    student.quizzes.averageFollowUpScore = student.grade.averageFollowUpScore;
    const last = lastByKind.get(student.id) || { tutor: null, editor: null, tab: null };
    const tutorAt = laterIso(last.tutor, student.interventions.lastAt);
    const tabAt = laterIso(last.tab, student.sessions.lastSeenAt);
    const recent = (iso: string | null) => iso !== null && now.getTime() - Date.parse(iso) <= RECENT_ACTIVITY_WINDOW_MS;
    const state: PresenceState = recent(tutorAt) ? "tutor" : recent(last.editor) ? "editor" : recent(tabAt) ? "tab" : "none";
    student.presence = { state, label: PRESENCE_LABELS[state], tutorAt, editorAt: last.editor, tabAt };
    student.sessions.activeNow = isRealActivity(state);
    student.lastActivityAt = [
      tutorAt,
      last.editor,
      student.quizzes.lastAt,
    ].reduce<string | null>((latest, value) => laterIso(latest, value), null);
  }

  // Las cuentas de muestra al final; despues, primero los activos ahora, luego por ultima
  // actividad y por nombre.
  students.sort((a, b) => {
    if (a.sampleAccount !== b.sampleAccount) return a.sampleAccount ? 1 : -1;
    if (a.sessions.activeNow !== b.sessions.activeNow) return a.sessions.activeNow ? -1 : 1;
    const ta = a.lastActivityAt ? Date.parse(a.lastActivityAt) : 0;
    const tb = b.lastActivityAt ? Date.parse(b.lastActivityAt) : 0;
    if (ta !== tb) return tb - ta;
    return a.displayName.localeCompare(b.displayName, "es");
  });

  const real = students.filter((student) => !student.sampleAccount);
  const graded = real.filter((student) => student.grade.score !== null);
  const totals: StudentProgressTotals = {
    students: real.length,
    activeNow: real.filter((student) => student.sessions.activeNow).length,
    tabOnly: real.filter((student) => student.presence.state === "tab").length,
    sampleAccounts: students.length - real.length,
    possibleDuplicates: real.filter((student) => student.possibleDuplicates.length > 0).length,
    withQuizzes: real.filter((student) => student.quizzes.total > 0).length,
    averageGrade: graded.length
      ? Math.round(graded.reduce((sum, student) => sum + (student.grade.score || 0), 0) / graded.length)
      : null,
    interventions: real.reduce((sum, student) => sum + student.interventions.total, 0),
    blocked: real.reduce((sum, student) => sum + student.interventions.blocked, 0),
  };

  return { students, totals };
}

export function toStudentQuizItem(quiz: StudentQuizRecord): StudentQuizItem {
  const chosen = quiz.chosenIndex !== null && quiz.chosenIndex >= 0 ? quiz.options[quiz.chosenIndex] ?? null : null;
  const correct = quiz.correctIndex >= 0 ? quiz.options[quiz.correctIndex] ?? null : null;
  return {
    id: quiz.id,
    trigger: quiz.trigger,
    status: quiz.status,
    topic: quiz.topic,
    question: quiz.question,
    language: quiz.language,
    filePath: quiz.filePath,
    answered: quiz.chosenIndex !== null,
    correct: quiz.correct,
    chosenOption: chosen,
    correctOption: correct,
    followupAnswered: !!quiz.followupAnswer,
    followupScore: quiz.followupScore,
    followupFeedback: quiz.followupFeedback,
    createdAt: quiz.createdAt,
    answeredAt: quiz.answeredAt,
    completedAt: quiz.completedAt,
  };
}

function dayKey(iso: string) {
  return iso.slice(0, 10);
}

/** Actividad por dia de los ultimos TIMELINE_DAYS dias (con los registros recibidos). */
export function buildTimeline(input: {
  sessions: Array<{ createdAt: string }>;
  interventions: Array<{ createdAt: string }>;
  quizzes: Array<{ createdAt: string }>;
  now?: Date;
  days?: number;
}): TimelinePoint[] {
  const now = input.now ?? new Date();
  const days = Math.max(1, Math.min(90, input.days ?? TIMELINE_DAYS));
  const points = new Map<string, TimelinePoint>();
  for (let offset = days - 1; offset >= 0; offset -= 1) {
    const date = new Date(now.getTime() - offset * 24 * 60 * 60 * 1000);
    const day = dayKey(date.toISOString());
    points.set(day, { day, sessions: 0, interventions: 0, quizzes: 0 });
  }
  const bump = (items: Array<{ createdAt: string }>, field: "sessions" | "interventions" | "quizzes") => {
    for (const item of items) {
      const point = points.get(dayKey(item.createdAt));
      if (point) point[field] += 1;
    }
  };
  bump(input.sessions, "sessions");
  bump(input.interventions, "interventions");
  bump(input.quizzes, "quizzes");
  return [...points.values()];
}

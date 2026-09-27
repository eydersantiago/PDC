// Base de datos: filas, columnas y mapeadores de los quices.
// Movido sin cambios desde src/db/database.ts (solo se agrego "export" a lo que no lo tenia).
import type { QuizLaunchRecord, StudentQuizRecord, StudentQuizStatus, TeacherQuizRecord } from "../types/app.js";
import { toIso } from "./rows.js";
import { trimText } from "../services/text-utils.js";

export type StudentQuizRow = {
  id: string;
  client_key: string;
  user_id: string | null;
  teacher_user_id: string | null;
  session_id: string | null;
  trigger_kind: string;
  launch_id: string | null;
  status: string;
  language: string;
  file_path: string;
  topic: string;
  question: string;
  choices: unknown;
  correct_index: number;
  explanation: string;
  followup_question: string;
  chosen_index: number | null;
  correct: boolean | null;
  followup_answer: string;
  followup_score: number | null;
  followup_feedback: string;
  code_context: unknown;
  created_at: string | Date;
  answered_at: string | Date | null;
  completed_at: string | Date | null;
};

export type QuizLaunchRow = {
  id: string;
  teacher_user_id: string;
  course_code: string;
  topic: string;
  question: string;
  choices: unknown;
  correct_index: number;
  explanation: string;
  followup_question: string;
  active: boolean;
  created_at: string | Date;
  expires_at: string | Date | null;
  custom_quiz_id?: string | null;
};

export type TeacherQuizRow = {
  id: string;
  teacher_user_id: string;
  course_code: string;
  topic: string;
  question: string;
  choices: unknown;
  correct_index: number;
  explanation: string;
  followup_question: string;
  is_active: boolean;
  created_at: string | Date;
  updated_at: string | Date;
};

export const TEACHER_QUIZ_COLUMNS = `
  id, teacher_user_id, course_code, topic, question, choices, correct_index, explanation,
  followup_question, is_active, created_at, updated_at
`;

export const STUDENT_QUIZ_COLUMNS = `
  id, client_key, user_id, teacher_user_id, session_id, trigger_kind, launch_id, status,
  language, file_path, topic, question, choices, correct_index, explanation, followup_question,
  chosen_index, correct, followup_answer, followup_score, followup_feedback, code_context,
  created_at, answered_at, completed_at
`;

export const QUIZ_LAUNCH_COLUMNS = `
  id, teacher_user_id, course_code, topic, question, choices, correct_index, explanation,
  followup_question, active, created_at, expires_at, custom_quiz_id
`;

export function toStringArray(value: unknown) {
  return Array.isArray(value) ? value.map((item) => String(item)) : [];
}

export function toRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

export function mapStudentQuizRow(row: StudentQuizRow): StudentQuizRecord {
  return {
    id: row.id,
    clientKey: row.client_key,
    userId: row.user_id,
    teacherUserId: row.teacher_user_id,
    sessionId: row.session_id,
    trigger: row.trigger_kind === "teacher_launch" ? "teacher_launch" : "after_accept",
    launchId: row.launch_id,
    status: (["pending", "followup", "done", "skipped", "expired"].includes(row.status)
      ? row.status
      : "pending") as StudentQuizStatus,
    language: row.language,
    filePath: row.file_path,
    topic: row.topic,
    question: row.question,
    options: toStringArray(row.choices),
    correctIndex: Number(row.correct_index),
    explanation: row.explanation,
    followupQuestion: row.followup_question,
    chosenIndex: row.chosen_index === null || row.chosen_index === undefined ? null : Number(row.chosen_index),
    correct: row.correct === null || row.correct === undefined ? null : row.correct === true,
    followupAnswer: row.followup_answer,
    followupScore: row.followup_score === null || row.followup_score === undefined ? null : Number(row.followup_score),
    followupFeedback: row.followup_feedback,
    codeContext: toRecord(row.code_context),
    createdAt: toIso(row.created_at),
    answeredAt: row.answered_at ? toIso(row.answered_at) : null,
    completedAt: row.completed_at ? toIso(row.completed_at) : null,
  };
}

export function mapQuizLaunchRow(row: QuizLaunchRow): QuizLaunchRecord {
  return {
    id: row.id,
    teacherUserId: row.teacher_user_id,
    courseCode: row.course_code,
    topic: row.topic,
    question: row.question,
    options: toStringArray(row.choices),
    correctIndex: Number(row.correct_index),
    explanation: row.explanation,
    followupQuestion: row.followup_question,
    active: row.active === true,
    createdAt: toIso(row.created_at),
    expiresAt: row.expires_at ? toIso(row.expires_at) : null,
    customQuizId: trimText(row.custom_quiz_id || ""),
  };
}

export function mapTeacherQuizRow(row: TeacherQuizRow): TeacherQuizRecord {
  return {
    id: row.id,
    teacherUserId: row.teacher_user_id,
    courseCode: row.course_code,
    topic: row.topic,
    question: row.question,
    options: toStringArray(row.choices),
    correctIndex: Number(row.correct_index),
    explanation: row.explanation,
    followupQuestion: row.followup_question,
    isActive: row.is_active === true,
    createdAt: toIso(row.created_at),
    updatedAt: toIso(row.updated_at),
  };
}

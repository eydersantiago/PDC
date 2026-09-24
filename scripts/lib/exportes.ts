import { fileExtension, pseudonymize } from "../../src/services/telemetry.js";

/**
 * Exportacion de los intentos del mini quiz (student_quizzes) para el
 * analisis: el actor se seudonimiza con la misma funcion que telemetry_events
 * (client_key ya viene como user:<id> o client:<id>), y se dejan fuera la
 * pregunta, las opciones, la respuesta abierta, el codigo y la ruta.
 */

export type QuizDbRow = {
  id: string;
  client_key: string;
  teacher_user_id: string | null;
  trigger_kind: string;
  launch_id: string | null;
  status: string;
  language: string;
  file_path: string;
  topic: string;
  correct_index: number;
  chosen_index: number | null;
  correct: boolean | null;
  followup_score: number | null;
  created_at: string | Date;
  answered_at: string | Date | null;
  completed_at: string | Date | null;
};

export const QUIZ_COLUMNS = [
  "id",
  "actor_anon_id",
  "actor_kind",
  "teacher_anon_id",
  "trigger_kind",
  "launch_id",
  "status",
  "language",
  "file_ext",
  "topic",
  "correct_index",
  "chosen_index",
  "correct",
  "followup_score",
  "created_at",
  "answered_at",
  "completed_at",
  "seconds_to_answer",
] as const;

function iso(value: string | Date | null) {
  if (!value) return null;
  const date = value instanceof Date ? value : new Date(value);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

/** Intento del quiz sin pregunta, opciones, respuesta abierta, codigo ni ruta. */
export function quizExportRecord(row: QuizDbRow) {
  const created = iso(row.created_at);
  const answered = iso(row.answered_at);
  return {
    id: row.id,
    actor_anon_id: pseudonymize(row.client_key),
    actor_kind: row.client_key.startsWith("user:") ? "user" : "client",
    teacher_anon_id: row.teacher_user_id ? pseudonymize(`user:${row.teacher_user_id}`) : "",
    trigger_kind: row.trigger_kind,
    launch_id: row.launch_id || "",
    status: row.status,
    language: row.language,
    file_ext: fileExtension(row.file_path),
    topic: row.topic,
    correct_index: row.correct_index,
    chosen_index: row.chosen_index,
    correct: row.correct,
    followup_score: row.followup_score,
    created_at: created,
    answered_at: answered,
    completed_at: iso(row.completed_at),
    seconds_to_answer: created && answered ? Math.round((Date.parse(answered) - Date.parse(created)) / 1000) : null,
  };
}

export function quizzesToCsv(records: Array<ReturnType<typeof quizExportRecord>>) {
  const cellOf = (value: unknown) => {
    if (value === null || value === undefined) return "";
    const text = String(value);
    return /[",\n\r]/.test(text) ? `"${text.replace(/"/g, "\"\"")}"` : text;
  };
  return `${[QUIZ_COLUMNS.join(","), ...records.map((record) => QUIZ_COLUMNS.map((column) => cellOf(record[column])).join(","))].join("\n")}\n`;
}

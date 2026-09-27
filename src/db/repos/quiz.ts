// AppDatabase, parte 12 de 12: mini quices de estudiantes, lanzamientos en clase y banco de quices del docente.
// Metodos movidos sin cambios desde src/db/database.ts. Cadena: DatabaseCore -> AuthDatabase -> UsersDatabase -> PolicyDatabase -> RagLotsDatabase -> RagSourcesDatabase -> GithubDatabase -> WorkspaceDatabase -> PilotDatabase -> TelemetryDatabase -> ProgressDatabase -> QuizDatabase -> AppDatabase
// (cada clase extiende a la anterior; db.metodo() sigue igual). private pasa a protected solo si otra clase lo usa.
import { randomUUID } from "node:crypto";
import type { QuizTrigger, StudentQuizStatus } from "../../types/app.js";
import { QUIZ_LAUNCH_COLUMNS, STUDENT_QUIZ_COLUMNS, TEACHER_QUIZ_COLUMNS, mapQuizLaunchRow, mapStudentQuizRow, mapTeacherQuizRow } from "../quiz-rows.js";
import type { QuizLaunchRow, StudentQuizRow, TeacherQuizRow } from "../quiz-rows.js";
import { trimText } from "../../services/text-utils.js";
import { ProgressDatabase } from "./progress.js";

export class QuizDatabase extends ProgressDatabase {
  async createStudentQuiz(input: {
    clientKey: string;
    userId: string | null;
    teacherUserId: string | null;
    sessionId: string | null;
    trigger: QuizTrigger;
    launchId: string | null;
    language: string;
    filePath: string;
    topic: string;
    question: string;
    options: string[];
    correctIndex: number;
    explanation: string;
    followupQuestion: string;
    codeContext: Record<string, unknown>;
  }) {
    const result = await this.pool.query<StudentQuizRow>(
      `
      insert into student_quizzes (
        id, client_key, user_id, teacher_user_id, session_id, trigger_kind, launch_id, status,
        language, file_path, topic, question, choices, correct_index, explanation,
        followup_question, code_context
      )
      values ($1, $2, $3, $4, $5, $6, $7, 'pending', $8, $9, $10, $11, $12::jsonb, $13, $14, $15, $16::jsonb)
      returning ${STUDENT_QUIZ_COLUMNS}
      `,
      [
        randomUUID(),
        input.clientKey,
        input.userId,
        input.teacherUserId,
        input.sessionId,
        input.trigger,
        input.launchId,
        input.language,
        input.filePath,
        input.topic,
        input.question,
        JSON.stringify(input.options),
        input.correctIndex,
        input.explanation,
        input.followupQuestion,
        JSON.stringify(input.codeContext || {}),
      ],
    );
    return mapStudentQuizRow(result.rows[0]);
  }

  async getStudentQuiz(id: string) {
    const result = await this.pool.query<StudentQuizRow>(
      `select ${STUDENT_QUIZ_COLUMNS} from student_quizzes where id = $1 limit 1`,
      [id],
    );
    return result.rows[0] ? mapStudentQuizRow(result.rows[0]) : null;
  }

  async saveStudentQuizAnswer(id: string, input: { chosenIndex: number; correct: boolean; status: StudentQuizStatus }) {
    const now = new Date().toISOString();
    const result = await this.pool.query<StudentQuizRow>(
      `
      update student_quizzes
      set chosen_index = $2, correct = $3, status = $4, answered_at = $5::timestamptz, completed_at = $6::timestamptz
      where id = $1
      returning ${STUDENT_QUIZ_COLUMNS}
      `,
      [id, input.chosenIndex, input.correct, input.status, now, input.status === "done" ? now : null],
    );
    return mapStudentQuizRow(result.rows[0]);
  }

  async saveStudentQuizFollowUp(id: string, input: { answer: string; score: number | null; feedback: string }) {
    const result = await this.pool.query<StudentQuizRow>(
      `
      update student_quizzes
      set followup_answer = $2, followup_score = $3, followup_feedback = $4, status = 'done',
          completed_at = $5::timestamptz
      where id = $1
      returning ${STUDENT_QUIZ_COLUMNS}
      `,
      [id, input.answer, input.score, input.feedback, new Date().toISOString()],
    );
    return mapStudentQuizRow(result.rows[0]);
  }

  async setStudentQuizStatus(id: string, status: StudentQuizStatus) {
    const result = await this.pool.query<StudentQuizRow>(
      `
      update student_quizzes
      set status = $2, completed_at = $3::timestamptz
      where id = $1
      returning ${STUDENT_QUIZ_COLUMNS}
      `,
      [id, status, new Date().toISOString()],
    );
    return mapStudentQuizRow(result.rows[0]);
  }

  /** Un quiz nuevo tras aceptar sustituye al que el estudiante dejo abierto. */
  async expireOpenStudentQuizzes(clientKey: string, trigger: QuizTrigger) {
    await this.pool.query(
      `
      update student_quizzes
      set status = 'expired', completed_at = $3::timestamptz
      where client_key = $1 and trigger_kind = $2 and status in ('pending', 'followup')
      `,
      [clientKey, trigger, new Date().toISOString()],
    );
  }

  async countStudentQuizzesSince(clientKey: string, sinceIso: string, trigger: QuizTrigger) {
    const result = await this.pool.query<{ total: string }>(
      `
      select count(*)::text as total
      from student_quizzes
      where client_key = $1 and trigger_kind = $2 and created_at >= $3::timestamptz
      `,
      [clientKey, trigger, sinceIso],
    );
    return Number(result.rows[0]?.total || 0);
  }

  async findLatestOpenStudentQuiz(clientKey: string, sinceIso: string) {
    const result = await this.pool.query<StudentQuizRow>(
      `
      select ${STUDENT_QUIZ_COLUMNS}
      from student_quizzes
      where client_key = $1 and status in ('pending', 'followup') and created_at >= $2::timestamptz
      order by created_at desc
      limit 1
      `,
      [clientKey, sinceIso],
    );
    return result.rows[0] ? mapStudentQuizRow(result.rows[0]) : null;
  }

  async findStudentQuizForLaunch(clientKey: string, launchId: string) {
    const result = await this.pool.query<StudentQuizRow>(
      `
      select ${STUDENT_QUIZ_COLUMNS}
      from student_quizzes
      where client_key = $1 and launch_id = $2
      order by created_at desc
      limit 1
      `,
      [clientKey, launchId],
    );
    return result.rows[0] ? mapStudentQuizRow(result.rows[0]) : null;
  }

  async listStudentQuizzesForTeacher(teacherUserId: string, limit = 2000) {
    const result = await this.pool.query<StudentQuizRow>(
      `
      select ${STUDENT_QUIZ_COLUMNS}
      from student_quizzes
      where teacher_user_id = $1
      order by created_at desc
      limit $2
      `,
      [teacherUserId, Math.max(1, Math.min(10000, limit))],
    );
    return result.rows.map(mapStudentQuizRow);
  }

  /** Lanza un quiz para la clase; el anterior activo del mismo docente se cierra. */
  async createQuizLaunch(input: {
    teacherUserId: string;
    courseCode: string;
    topic: string;
    question: string;
    options: string[];
    correctIndex: number;
    explanation: string;
    followupQuestion: string;
    expiresAt: string | null;
    customQuizId?: string;
  }) {
    await this.pool.query(
      `update quiz_launches set active = false where teacher_user_id = $1 and active = true`,
      [input.teacherUserId],
    );
    const result = await this.pool.query<QuizLaunchRow>(
      `
      insert into quiz_launches (
        id, teacher_user_id, course_code, topic, question, choices, correct_index,
        explanation, followup_question, active, expires_at, custom_quiz_id
      )
      values ($1, $2, $3, $4, $5, $6::jsonb, $7, $8, $9, true, $10::timestamptz, $11)
      returning ${QUIZ_LAUNCH_COLUMNS}
      `,
      [
        randomUUID(),
        input.teacherUserId,
        input.courseCode,
        input.topic,
        input.question,
        JSON.stringify(input.options),
        input.correctIndex,
        input.explanation,
        input.followupQuestion,
        input.expiresAt,
        trimText(input.customQuizId || ""),
      ],
    );
    return mapQuizLaunchRow(result.rows[0]);
  }

  // ---- Banco de quices del docente (0.7.15) ----

  async listTeacherQuizzes(teacherUserId: string, limit = 200) {
    const result = await this.pool.query<TeacherQuizRow>(
      `
      select ${TEACHER_QUIZ_COLUMNS}
      from teacher_quizzes
      where teacher_user_id = $1 and is_active = true
      order by created_at desc
      limit $2
      `,
      [teacherUserId, Math.max(1, Math.min(500, limit))],
    );
    return result.rows.map(mapTeacherQuizRow);
  }

  async getTeacherQuiz(id: string) {
    const result = await this.pool.query<TeacherQuizRow>(
      `select ${TEACHER_QUIZ_COLUMNS} from teacher_quizzes where id = $1 limit 1`,
      [trimText(id)],
    );
    return result.rows[0] ? mapTeacherQuizRow(result.rows[0]) : null;
  }

  async createTeacherQuiz(input: {
    teacherUserId: string;
    courseCode: string;
    topic: string;
    question: string;
    options: string[];
    correctIndex: number;
    explanation: string;
    followupQuestion: string;
  }) {
    const result = await this.pool.query<TeacherQuizRow>(
      `
      insert into teacher_quizzes (
        id, teacher_user_id, course_code, topic, question, choices, correct_index,
        explanation, followup_question, is_active, created_at, updated_at
      )
      values ($1, $2, $3, $4, $5, $6::jsonb, $7, $8, $9, true, now(), now())
      returning ${TEACHER_QUIZ_COLUMNS}
      `,
      [
        randomUUID(),
        input.teacherUserId,
        input.courseCode,
        input.topic,
        input.question,
        JSON.stringify(input.options),
        input.correctIndex,
        input.explanation,
        input.followupQuestion,
      ],
    );
    return mapTeacherQuizRow(result.rows[0]);
  }

  async updateTeacherQuiz(id: string, teacherUserId: string, input: {
    courseCode: string;
    topic: string;
    question: string;
    options: string[];
    correctIndex: number;
    explanation: string;
    followupQuestion: string;
  }) {
    const result = await this.pool.query<TeacherQuizRow>(
      `
      update teacher_quizzes
      set course_code = $3, topic = $4, question = $5, choices = $6::jsonb, correct_index = $7,
          explanation = $8, followup_question = $9, updated_at = now()
      where id = $1 and teacher_user_id = $2 and is_active = true
      returning ${TEACHER_QUIZ_COLUMNS}
      `,
      [
        trimText(id),
        teacherUserId,
        input.courseCode,
        input.topic,
        input.question,
        JSON.stringify(input.options),
        input.correctIndex,
        input.explanation,
        input.followupQuestion,
      ],
    );
    return result.rows[0] ? mapTeacherQuizRow(result.rows[0]) : null;
  }

  async retireTeacherQuiz(id: string, teacherUserId: string) {
    const result = await this.pool.query<{ id: string }>(
      `update teacher_quizzes set is_active = false, updated_at = now() where id = $1 and teacher_user_id = $2 and is_active = true returning id`,
      [trimText(id), teacherUserId],
    );
    return result.rows.length > 0;
  }

  async getActiveQuizLaunch(teacherUserId: string, nowIso: string) {
    const result = await this.pool.query<QuizLaunchRow>(
      `
      select ${QUIZ_LAUNCH_COLUMNS}
      from quiz_launches
      where teacher_user_id = $1
        and active = true
        and (expires_at is null or expires_at > $2::timestamptz)
      order by created_at desc
      limit 1
      `,
      [teacherUserId, nowIso],
    );
    return result.rows[0] ? mapQuizLaunchRow(result.rows[0]) : null;
  }

  async listQuizLaunches(teacherUserId: string, limit = 10) {
    const result = await this.pool.query<QuizLaunchRow>(
      `
      select ${QUIZ_LAUNCH_COLUMNS}
      from quiz_launches
      where teacher_user_id = $1
      order by created_at desc
      limit $2
      `,
      [teacherUserId, Math.max(1, Math.min(100, limit))],
    );
    return result.rows.map(mapQuizLaunchRow);
  }

  async closeQuizLaunch(id: string, teacherUserId: string) {
    const result = await this.pool.query<{ id: string }>(
      `
      update quiz_launches
      set active = false
      where id = $1 and teacher_user_id = $2
      returning id
      `,
      [id, teacherUserId],
    );
    return result.rows.length > 0;
  }
}

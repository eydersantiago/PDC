// AppDatabase, parte 4 de 12: politica del docente.
// Metodos movidos sin cambios desde src/db/database.ts. Cadena: DatabaseCore -> AuthDatabase -> UsersDatabase -> PolicyDatabase -> RagLotsDatabase -> RagSourcesDatabase -> GithubDatabase -> WorkspaceDatabase -> PilotDatabase -> TelemetryDatabase -> ProgressDatabase -> QuizDatabase -> AppDatabase
// (cada clase extiende a la anterior; db.metodo() sigue igual). private pasa a protected solo si otra clase lo usa.
import type { AppUser, TeacherPolicy } from "../../types/app.js";
import { mapPolicyRow } from "../rows.js";
import type { PolicyRow } from "../rows.js";
import { mergeCodeApplicationSettings, normalizeCodeApplicationSettings, normalizeEventRules } from "../../services/policy-settings.js";
import { normalizeQuizSettings } from "../../services/quiz-settings.js";
import { UsersDatabase } from "./users.js";

export class PolicyDatabase extends UsersDatabase {
  async getTeacherPolicyForUser(user: AppUser) {
    const teacherUserId = user.role === "teacher"
      ? user.id
      : user.teacherUserId || await this.getDefaultTeacherId();

    if (!teacherUserId) return null;

    const result = await this.pool.query<PolicyRow>(
      `
      select
        id,
        teacher_user_id,
        policy_name,
        outcome,
        tone,
        frequency,
        help_level,
        allow_mini_quiz,
        strict_no_solution,
        max_hints_per_exercise,
        fallback_message,
        custom_instruction,
        allowed_interventions,
        allowed_topics,
        event_rules,
        quiz_settings,
        code_application_settings,
        updated_at
      from teacher_policies
      where teacher_user_id = $1
      limit 1
      `,
      [teacherUserId],
    );

    const row = result.rows[0];
    return row ? mapPolicyRow(row) : null;
  }

  async updateTeacherPolicy(
    teacherUserId: string,
    input: Partial<Omit<TeacherPolicy, "eventRules" | "codeApplication">> & {
      eventRules?: Partial<TeacherPolicy["eventRules"]>;
      codeApplication?: Partial<TeacherPolicy["codeApplication"]>;
    },
  ) {
    const current = await this.getTeacherPolicyForUser({
      id: teacherUserId,
      role: "teacher",
      email: "",
      displayName: "",
      teacherUserId: null,
    });
    if (!current) {
      throw new Error("No existe politica activa para este docente.");
    }

    const nextPolicy: TeacherPolicy = {
      ...current,
      ...input,
      codeApplication: mergeCodeApplicationSettings(current.codeApplication, input.codeApplication),
      eventRules: normalizeEventRules({ ...current.eventRules, ...(input.eventRules || {}) }),
      teacherUserId,
      updatedAt: new Date().toISOString(),
    };

    const result = await this.pool.query<PolicyRow>(
      `
      update teacher_policies
      set
        policy_name = $2,
        outcome = $3,
        tone = $4,
        frequency = $5,
        help_level = $6,
        allow_mini_quiz = $7,
        strict_no_solution = $8,
        max_hints_per_exercise = $9,
        fallback_message = $10,
        custom_instruction = $11,
        allowed_interventions = $12::jsonb,
        allowed_topics = $13::jsonb,
        event_rules = $14::jsonb,
        quiz_settings = $15::jsonb,
        code_application_settings = $16::jsonb,
        updated_at = now()
      where teacher_user_id = $1
      returning
        id,
        teacher_user_id,
        policy_name,
        outcome,
        tone,
        frequency,
        help_level,
        allow_mini_quiz,
        strict_no_solution,
        max_hints_per_exercise,
        fallback_message,
        custom_instruction,
        allowed_interventions,
        allowed_topics,
        event_rules,
        quiz_settings,
        code_application_settings,
        updated_at
      `,
      [
        teacherUserId,
        nextPolicy.policyName,
        nextPolicy.outcome,
        nextPolicy.tone,
        nextPolicy.frequency,
        nextPolicy.helpLevel,
        nextPolicy.allowMiniQuiz,
        nextPolicy.strictNoSolution,
        nextPolicy.maxHintsPerExercise,
        nextPolicy.fallbackMessage,
        nextPolicy.customInstruction,
        JSON.stringify(nextPolicy.allowedInterventions),
        JSON.stringify(nextPolicy.allowedTopics),
        JSON.stringify(nextPolicy.eventRules),
        JSON.stringify(normalizeQuizSettings(nextPolicy.quizSettings)),
        JSON.stringify(normalizeCodeApplicationSettings(nextPolicy.codeApplication)),
      ],
    );

    return mapPolicyRow(result.rows[0]);
  }

  // --- Mini quiz ------------------------------------------------------------

  /** Politica del primer docente, sin JOIN (funciona tambien con pg-mem). */
  async getFirstTeacherPolicy() {
    const result = await this.pool.query<PolicyRow>(
      `
      select
        id, teacher_user_id, policy_name, outcome, tone, frequency, help_level, allow_mini_quiz,
        strict_no_solution, max_hints_per_exercise, fallback_message, custom_instruction,
        allowed_interventions, allowed_topics, event_rules, quiz_settings, code_application_settings, updated_at
      from teacher_policies
      order by updated_at asc
      limit 1
      `,
    );
    return result.rows[0] ? mapPolicyRow(result.rows[0]) : null;
  }
}

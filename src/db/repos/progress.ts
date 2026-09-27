// AppDatabase, parte 11 de 12: progreso de estudiantes (lista y detalle).
// Metodos movidos sin cambios desde src/db/database.ts. Cadena: DatabaseCore -> AuthDatabase -> UsersDatabase -> PolicyDatabase -> RagLotsDatabase -> RagSourcesDatabase -> GithubDatabase -> WorkspaceDatabase -> PilotDatabase -> TelemetryDatabase -> ProgressDatabase -> QuizDatabase -> AppDatabase
// (cada clase extiende a la anterior; db.metodo() sigue igual). private pasa a protected solo si otra clase lo usa.
import type { AppUser } from "../../types/app.js";
import type { ActivityAggregateRow, ExerciseAggregateRow, InterventionAggregateRow, PilotCohortRow, QuizAggregateRow, SessionAggregateRow, StudentProfileRow } from "../../services/student-progress.js";
import { STUDENT_QUIZ_COLUMNS, mapStudentQuizRow } from "../quiz-rows.js";
import type { StudentQuizRow } from "../quiz-rows.js";
import { normalizeSessionKind, toIso } from "../rows.js";
import { trimText } from "../../services/text-utils.js";
import { TelemetryDatabase } from "./telemetry.js";

export class ProgressDatabase extends TelemetryDatabase {
  /**
   * Filas para el panel "Estudiantes" (services/student-progress.ts). El
   * docente solo ve a sus estudiantes; el administrador, a todos. Cada
   * consulta agrupa una tabla por estudiante y el servicio las junta. Las
   * sumas van con CASE (pg-mem no tiene FILTER), los conteos salen como
   * texto, igual que en summarizeBehaviorEventsForViewer, y las filas sin
   * estudiante (anonimos) se descartan en el servicio: pg-mem devuelve vacio
   * si se combina "is not null" con el filtro por docente.
   */
  async listStudentProgressRows(viewer: AppUser) {
    const teacherScopeId = viewer.role === "teacher" ? viewer.id : "";
    const managed = await this.listManagedUsers(viewer);
    const students: StudentProfileRow[] = managed.users
      .filter((user) => user.role === "student")
      .map((user) => ({
        id: user.id,
        email: user.email,
        displayName: user.displayName,
        isActive: user.isActive,
        createdAt: user.createdAt,
        teacherUserId: user.teacherUserId,
        teacherDisplayName: user.teacherDisplayName,
        assignedCourseCodes: user.assignedCourseCodes,
      }));

    const [sessions, interventions, quizzes, activity, exercises, pilot] = await Promise.all([
      this.pool.query<SessionAggregateRow>(
        `
        select
          user_id,
          kind,
          count(*)::text as total,
          sum(case when is_active then 1 else 0 end)::text as active_total,
          min(created_at) as first_seen_at,
          max(last_seen_at) as last_seen_at
        from app_sessions
        group by user_id, kind
        `,
      ),
      this.pool.query<InterventionAggregateRow>(
        `
        select
          student_user_id as user_id,
          count(*)::text as total,
          sum(case when blocked then 1 else 0 end)::text as blocked_total,
          sum(case when intervention_type = 'hint' then 1 else 0 end)::text as hints,
          sum(case when intervention_type = 'explanation' then 1 else 0 end)::text as explanations,
          sum(case when intervention_type = 'example' then 1 else 0 end)::text as examples,
          sum(case when intervention_type = 'mini_quiz' then 1 else 0 end)::text as mini_quizzes,
          max(created_at) as last_at
        from intervention_telemetry
        where ($1 = '' or teacher_user_id = $1)
        group by student_user_id
        `,
        [teacherScopeId],
      ),
      this.pool.query<QuizAggregateRow>(
        `
        select
          user_id,
          count(*)::text as total,
          sum(case when chosen_index is not null then 1 else 0 end)::text as answered,
          sum(case when correct = true then 1 else 0 end)::text as correct_total,
          sum(case when followup_score is not null then 1 else 0 end)::text as scored,
          sum(case when followup_score is not null then followup_score else 0 end)::text as followup_sum,
          sum(case when status = 'skipped' then 1 else 0 end)::text as skipped,
          max(created_at) as last_at
        from student_quizzes
        where ($1 = '' or teacher_user_id = $1)
        group by user_id
        `,
        [teacherScopeId],
      ),
      this.pool.query<ActivityAggregateRow>(
        `
        select
          user_id,
          category,
          count(*)::text as total,
          coalesce(sum(duration_ms), 0)::text as duration_ms,
          max(occurred_at) as last_at
        from user_behavior_events
        where ($1 = '' or teacher_user_id = $1)
        group by user_id, category
        `,
        [teacherScopeId],
      ),
      this.pool.query<ExerciseAggregateRow>(
        `
        select
          student_user_id as user_id,
          count(*)::text as exercises,
          coalesce(sum(hint_count), 0)::text as hints,
          max(last_intervention_at) as last_at
        from student_exercise_progress
        group by student_user_id
        `,
      ),
      this.pool.query<PilotCohortRow>(
        `
        select student_user_id, cohort
        from pilot_assignments
        where ($1 = '' or teacher_user_id = $1)
        `,
        [teacherScopeId],
      ),
    ]);

    return {
      students,
      sessions: sessions.rows,
      interventions: interventions.rows,
      quizzes: quizzes.rows,
      activity: activity.rows,
      exercises: exercises.rows,
      pilot: pilot.rows,
    };
  }

  /**
   * Listas del detalle de un estudiante. El acceso ya se comprobo con
   * listStudentProgressRows (el estudiante esta en la lista del que mira).
   * Sin ids de sesion: con ellos se actua como el estudiante.
   */
  async getStudentProgressDetailRows(viewer: AppUser, studentUserId: string, limit = 30) {
    const bounded = Math.max(1, Math.min(200, Math.round(Number(limit) || 30)));
    const [sessions, interventions, quizzes, exercises, activity] = await Promise.all([
      this.pool.query<{
        kind: string | null;
        label: string | null;
        created_at: string | Date;
        last_seen_at: string | Date;
        expires_at: string | Date | null;
        is_active: boolean;
      }>(
        `
        select kind, label, created_at, last_seen_at, expires_at, is_active
        from app_sessions
        where user_id = $1
        order by created_at desc
        limit $2
        `,
        [studentUserId, bounded],
      ),
      this.pool.query<{
        id: string;
        event_type: string;
        intervention_type: string;
        detail_level: string;
        policy_name: string;
        exercise_key: string | null;
        blocked: boolean;
        reason: string;
        context_summary: string;
        created_at: string | Date;
      }>(
        `
        select
          id, event_type, intervention_type, detail_level, policy_name,
          exercise_key, blocked, reason, context_summary, created_at
        from intervention_telemetry
        where student_user_id = $1
        order by created_at desc
        limit $2
        `,
        [studentUserId, bounded],
      ),
      this.pool.query<StudentQuizRow>(
        `
        select ${STUDENT_QUIZ_COLUMNS}
        from student_quizzes
        where user_id = $1
        order by created_at desc
        limit $2
        `,
        [studentUserId, bounded],
      ),
      this.pool.query<{ exercise_key: string; hint_count: number; last_intervention_at: string | Date }>(
        `
        select exercise_key, hint_count, last_intervention_at
        from student_exercise_progress
        where student_user_id = $1
        order by last_intervention_at desc
        limit $2
        `,
        [studentUserId, bounded],
      ),
      this.summarizeBehaviorEventsForViewer({ viewer, targetUserId: studentUserId, limit: 40 }),
    ]);

    return {
      sessions: sessions.rows.map((row) => {
        const createdAt = toIso(row.created_at);
        const lastSeenAt = toIso(row.last_seen_at);
        return {
          kind: normalizeSessionKind(row.kind),
          label: trimText(row.label) || null,
          createdAt,
          lastSeenAt,
          expiresAt: row.expires_at ? toIso(row.expires_at) : null,
          isActive: row.is_active === true,
          durationMinutes: Math.max(0, Math.round((Date.parse(lastSeenAt) - Date.parse(createdAt)) / 60000)),
        };
      }),
      interventions: interventions.rows.map((row) => ({
        id: row.id,
        eventType: row.event_type,
        interventionType: row.intervention_type,
        detailLevel: row.detail_level,
        policyName: row.policy_name,
        exerciseKey: row.exercise_key,
        blocked: row.blocked === true,
        reason: row.reason,
        contextSummary: row.context_summary,
        createdAt: toIso(row.created_at),
      })),
      quizzes: quizzes.rows.map(mapStudentQuizRow),
      exercises: exercises.rows.map((row) => ({
        exerciseKey: row.exercise_key,
        hintCount: Number(row.hint_count) || 0,
        lastInterventionAt: toIso(row.last_intervention_at),
      })),
      activity,
    };
  }
}

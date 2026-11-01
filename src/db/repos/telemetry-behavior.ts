// AppDatabase: eventos de comportamiento (historial y resumen para el docente) y la telemetria antigua (recordTelemetry).
// Metodos movidos sin cambios desde src/db/repos/telemetry.ts; la clase va entre TelemetryDatabase y ProgressDatabase.
import { randomUUID } from "node:crypto";
import type { AppUser, TelemetryItem } from "../../types/app.js";
import { mapBehaviorEventRow, mapBehaviorSummaryRow, toIso } from "../rows.js";
import type { BehaviorEventRow, BehaviorEventSummaryRow } from "../rows.js";
import { trimText } from "../../services/shared/text-utils.js";
import { TelemetryDatabase } from "./telemetry.js";

export class BehaviorEventsDatabase extends TelemetryDatabase {
  async listBehaviorEventsForViewer(input: {
    viewer: AppUser;
    targetUserId?: string;
    category?: string;
    eventType?: string;
    source?: string;
    repoFullName?: string;
    since?: string;
    limit?: number;
  }) {
    const limit = Math.max(1, Math.min(100, Math.round(Number(input.limit) || 50)));
    const result = await this.pool.query<BehaviorEventRow>(
      `
      select
        e.id,
        e.user_id,
        e.teacher_user_id,
        e.session_id,
        e.source,
        e.category,
        e.event_type,
        e.page_context,
        e.repo_full_name,
        e.branch,
        e.file_path,
        e.language,
        e.subject_id,
        e.event_value,
        e.duration_ms,
        e.count_value,
        e.metadata,
        e.occurred_at,
        e.created_at
      from user_behavior_events e
      where (
          $1 = 'admin'
          or e.user_id = $2
          or ($1 = 'teacher' and e.teacher_user_id = $2)
        )
        and ($3 = '' or e.user_id = $3)
        and ($4 = '' or e.category = $4)
        and ($5 = '' or e.event_type = $5)
        and ($6 = '' or e.source = $6)
        and ($7 = '' or lower(e.repo_full_name) = lower($7))
        and ($8::timestamptz is null or e.occurred_at >= $8::timestamptz)
      order by e.occurred_at desc, e.created_at desc
      limit $9
      `,
      [
        input.viewer.role,
        input.viewer.id,
        trimText(input.targetUserId),
        trimText(input.category),
        trimText(input.eventType),
        trimText(input.source),
        trimText(input.repoFullName),
        trimText(input.since) || null,
        limit,
      ],
    );

    return result.rows.map(mapBehaviorEventRow);
  }

  async summarizeBehaviorEventsForViewer(input: {
    viewer: AppUser;
    targetUserId?: string;
    category?: string;
    source?: string;
    repoFullName?: string;
    since?: string;
    limit?: number;
  }) {
    const limit = Math.max(1, Math.min(200, Math.round(Number(input.limit) || 100)));
    const result = await this.pool.query<BehaviorEventSummaryRow>(
      `
      select
        e.user_id,
        e.teacher_user_id,
        e.source,
        e.category,
        e.event_type,
        count(*)::text as total_events,
        coalesce(sum(e.count_value), 0)::text as total_count,
        coalesce(sum(e.duration_ms), 0)::text as total_duration_ms,
        avg(e.duration_ms)::text as average_duration_ms,
        min(e.occurred_at) as first_occurred_at,
        max(e.occurred_at) as last_occurred_at
      from user_behavior_events e
      where (
          $1 = 'admin'
          or e.user_id = $2
          or ($1 = 'teacher' and e.teacher_user_id = $2)
        )
        and ($3 = '' or e.user_id = $3)
        and ($4 = '' or e.category = $4)
        and ($5 = '' or e.source = $5)
        and ($6 = '' or lower(e.repo_full_name) = lower($6))
        and ($7::timestamptz is null or e.occurred_at >= $7::timestamptz)
      group by
        e.user_id,
        e.teacher_user_id,
        e.source,
        e.category,
        e.event_type
      order by max(e.occurred_at) desc
      limit $8
      `,
      [
        input.viewer.role,
        input.viewer.id,
        trimText(input.targetUserId),
        trimText(input.category),
        trimText(input.source),
        trimText(input.repoFullName),
        trimText(input.since) || null,
        limit,
      ],
    );

    return result.rows.map(mapBehaviorSummaryRow);
  }

  async recordTelemetry(input: {
    sessionId: string;
    studentUserId: string | null;
    teacherUserId: string | null;
    eventType: string;
    interventionType: string;
    detailLevel: string;
    policyName: string;
    exerciseKey: string | null;
    blocked: boolean;
    reason: string;
    contextSummary: string;
    policySnapshot: object;
  }) {
    const id = randomUUID();

    await this.pool.query(
      `
      insert into intervention_telemetry (
        id,
        session_id,
        student_user_id,
        teacher_user_id,
        event_type,
        intervention_type,
        detail_level,
        policy_name,
        exercise_key,
        blocked,
        reason,
        context_summary,
        policy_snapshot
      )
      values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13::jsonb)
      `,
      [
        id,
        input.sessionId,
        input.studentUserId,
        input.teacherUserId,
        input.eventType,
        input.interventionType,
        input.detailLevel,
        input.policyName,
        input.exerciseKey,
        input.blocked,
        input.reason,
        input.contextSummary,
        JSON.stringify(input.policySnapshot),
      ],
    );

    return id;
  }

  async listTelemetryForTeacher(teacherUserId: string, limit = 10) {
    const result = await this.pool.query<{
      id: string;
      student_user_id: string | null;
      teacher_user_id: string | null;
      event_type: string;
      intervention_type: string;
      detail_level: string;
      policy_name: string;
      exercise_key: string | null;
      blocked: boolean;
      reason: string;
      context_summary: string;
      created_at: string | Date;
      student_name: string | null;
    }>(
      `
      select
        t.id,
        t.student_user_id,
        t.teacher_user_id,
        t.event_type,
        t.intervention_type,
        t.detail_level,
        t.policy_name,
        t.exercise_key,
        t.blocked,
        t.reason,
        t.context_summary,
        t.created_at,
        s.display_name as student_name
      from intervention_telemetry t
      left join users s on s.id = t.student_user_id
      where t.teacher_user_id = $1
      order by t.created_at desc
      limit $2
      `,
      [teacherUserId, limit],
    );

    // Sin session_id: el docente no debe poder actuar como sus estudiantes.
    return result.rows.map<TelemetryItem>((row) => ({
      id: row.id,
      studentUserId: row.student_user_id,
      teacherUserId: row.teacher_user_id,
      eventType: row.event_type as TelemetryItem["eventType"],
      interventionType: row.intervention_type as TelemetryItem["interventionType"],
      detailLevel: row.detail_level as TelemetryItem["detailLevel"],
      policyName: row.policy_name,
      exerciseKey: row.exercise_key,
      blocked: row.blocked,
      reason: row.reason,
      contextSummary: row.context_summary,
      createdAt: toIso(row.created_at),
      studentName: row.student_name,
    }));
  }
}

// AppDatabase, parte 10 de 12: uso de pistas, eventos de comportamiento y telemetria.
// Metodos movidos sin cambios desde src/db/database.ts. Cadena: DatabaseCore -> AuthDatabase -> UsersDatabase -> PolicyDatabase -> RagLotsDatabase -> RagSourcesDatabase -> GithubDatabase -> WorkspaceDatabase -> PilotDatabase -> TelemetryDatabase -> ProgressDatabase -> QuizDatabase -> AppDatabase
// (cada clase extiende a la anterior; db.metodo() sigue igual). private pasa a protected solo si otra clase lo usa.
import { randomUUID } from "node:crypto";
import type { AppUser, BehaviorEventInput, BehaviorEventItem, TelemetryItem } from "../../types/app.js";
import { mapBehaviorEventRow, mapBehaviorSummaryRow, toIso } from "../rows.js";
import type { BehaviorEventRow, BehaviorEventSummaryRow } from "../rows.js";
import { trimText } from "../../services/text-utils.js";
import { actorFromSession, buildTelemetryRow } from "../../services/telemetry.js";
import type { TelemetryActor, TelemetryEventInput } from "../../services/telemetry.js";
import { behaviorEventToTelemetryInput, mapTelemetryEventRow } from "../telemetry-rows.js";
import type { TelemetryEventDbRow } from "../telemetry-rows.js";
import { NO_PILOT } from "../../services/pilot.js";
import { PilotDatabase } from "./pilot.js";

export class TelemetryDatabase extends PilotDatabase {
  async getHintUsage(studentUserId: string, exerciseKey: string) {
    const result = await this.pool.query<{ hint_count: number }>(
      `
      select hint_count
      from student_exercise_progress
      where student_user_id = $1 and exercise_key = $2
      limit 1
      `,
      [studentUserId, exerciseKey],
    );

    return result.rows[0]?.hint_count || 0;
  }

  async incrementHintUsage(studentUserId: string, exerciseKey: string) {
    const existing = await this.pool.query<{ id: string; hint_count: number }>(
      `
      select id, hint_count
      from student_exercise_progress
      where student_user_id = $1 and exercise_key = $2
      limit 1
      `,
      [studentUserId, exerciseKey],
    );

    if (existing.rows[0]) {
      await this.pool.query(
        `
        update student_exercise_progress
        set hint_count = hint_count + 1, last_intervention_at = now()
        where id = $1
        `,
        [existing.rows[0].id],
      );
      return existing.rows[0].hint_count + 1;
    }

    await this.pool.query(
      `
      insert into student_exercise_progress (id, student_user_id, exercise_key, hint_count)
      values ($1, $2, $3, 1)
      `,
      [randomUUID(), studentUserId, exerciseKey],
    );
    return 1;
  }

  async recordBehaviorEvents(input: {
    sessionId: string;
    user: AppUser;
    events: BehaviorEventInput[];
    /** false cuando quien llama ya escribe en telemetry_events (ruta de eventos). */
    mirrorTelemetry?: boolean;
  }) {
    const stored: BehaviorEventItem[] = [];
    const teacherUserId = input.user.role === "student"
      ? input.user.teacherUserId
      : null;

    for (const event of input.events) {
      let durationMs: number | null = null;
      if (event.durationMs != null && Number.isFinite(Number(event.durationMs))) {
        durationMs = Math.max(0, Math.round(Number(event.durationMs)));
      }
      const count = Number.isFinite(Number(event.count))
        ? Math.max(1, Math.min(100000, Math.round(Number(event.count))))
        : 1;
      const metadata = event.metadata && typeof event.metadata === "object"
        ? event.metadata
        : {};

      const result = await this.pool.query<BehaviorEventRow>(
        `
        insert into user_behavior_events (
          id,
          user_id,
          teacher_user_id,
          session_id,
          source,
          category,
          event_type,
          page_context,
          repo_full_name,
          branch,
          file_path,
          language,
          subject_id,
          event_value,
          duration_ms,
          count_value,
          metadata,
          occurred_at
        )
        values (
          $1,
          $2,
          $3,
          $4,
          $5,
          $6,
          $7,
          $8,
          $9,
          $10,
          $11,
          $12,
          $13,
          $14,
          $15,
          $16,
          $17::jsonb,
          coalesce($18::timestamptz, now())
        )
        returning
          id,
          user_id,
          teacher_user_id,
          session_id,
          source,
          category,
          event_type,
          page_context,
          repo_full_name,
          branch,
          file_path,
          language,
          subject_id,
          event_value,
          duration_ms,
          count_value,
          metadata,
          occurred_at,
          created_at
        `,
        [
          randomUUID(),
          input.user.id,
          teacherUserId,
          input.sessionId,
          event.source,
          event.category,
          trimText(event.eventType).slice(0, 120),
          trimText(event.pageContext).slice(0, 120),
          trimText(event.repoFullName).slice(0, 240),
          trimText(event.branch).slice(0, 160),
          trimText(event.filePath).slice(0, 700),
          trimText(event.language).slice(0, 120),
          trimText(event.subjectId).slice(0, 220),
          trimText(event.value).slice(0, 1000),
          durationMs,
          count,
          JSON.stringify(metadata),
          trimText(event.occurredAt) || null,
        ],
      );

      const row = result.rows[0];
      if (row) {
        stored.push(mapBehaviorEventRow(row));
      }
    }

    // Telemetria v1.1: cada evento de comportamiento tambien entra, seudonimizado,
    // al registro unico telemetry_events (el dataset del piloto).
    if (input.mirrorTelemetry === false) {
      return stored;
    }
    const actor = actorFromSession({ user: input.user });
    await this.insertTelemetryEvents(
      input.events.map((event) => behaviorEventToTelemetryInput(event)),
      actor,
    ).catch((error) => {
      console.warn("[telemetria] no se pudo copiar a telemetry_events:", String(error));
    });

    return stored;
  }

  /**
   * Registro unico de telemetria v1.1 (sin llaves foraneas: acepta actores
   * anonimos). Devuelve las filas guardadas con sus avisos de calidad.
   */
  async insertTelemetryEvents(inputs: TelemetryEventInput[], actor: TelemetryActor) {
    const rows = inputs.map((input) => buildTelemetryRow(actor, input));
    // A13.1: el bloque, la cohorte y la condicion del piloto los pone el servidor.
    const pilot = await this.getPilotStateForActor(actor).catch(() => NO_PILOT);
    for (const row of rows) {
      row.pilotBlock = pilot.block || null;
      row.pilotCohort = pilot.cohort;
      row.pilotCondition = pilot.condition;
    }
    for (const row of rows) {
      await this.pool.query(
        `
        insert into telemetry_events (
          id, schema_version, occurred_at, received_at, source, channel, category, event_type,
          actor_anon_id, actor_kind, actor_role, teacher_anon_id, client_session_id, seq,
          decision_id, course_code, exercise_hash, language, file_ext, policy_event_type,
          intervention_type, help_stage, reason_code, blocked, latency_ms, duration_ms,
          count_value, value_text, error_hash, context_hash, metadata, quality_flags,
          pilot_block, pilot_cohort, pilot_condition
        )
        values (
          $1, $2, $3::timestamptz, $4::timestamptz, $5, $6, $7, $8,
          $9, $10, $11, $12, $13, $14,
          $15, $16, $17, $18, $19, $20,
          $21, $22, $23, $24, $25, $26,
          $27, $28, $29, $30, $31::jsonb, $32::jsonb,
          $33, $34, $35
        )
        `,
        [
          row.id,
          row.schemaVersion,
          row.occurredAt,
          row.receivedAt,
          row.source,
          row.channel,
          row.category,
          row.eventType,
          row.actorAnonId,
          row.actorKind,
          row.actorRole,
          row.teacherAnonId,
          row.clientSessionId,
          row.seq,
          row.decisionId,
          row.courseCode,
          row.exerciseHash,
          row.language,
          row.fileExt,
          row.policyEventType,
          row.interventionType,
          row.helpStage,
          row.reasonCode,
          row.blocked,
          row.latencyMs,
          row.durationMs,
          row.countValue,
          row.valueText,
          row.errorHash,
          row.contextHash,
          JSON.stringify(row.metadata),
          JSON.stringify(row.qualityFlags),
          row.pilotBlock,
          row.pilotCohort,
          row.pilotCondition,
        ],
      );
    }
    return rows;
  }

  /** Eventos de telemetria para exportar o revisar calidad, en orden temporal. */
  async listTelemetryEvents(input: { since?: string; until?: string; limit?: number } = {}) {
    const limit = Math.max(1, Math.min(200_000, Math.round(input.limit || 50_000)));
    const since = input.since ? new Date(input.since) : new Date(0);
    const until = input.until ? new Date(input.until) : new Date(Date.now() + 60_000);
    const result = await this.pool.query<TelemetryEventDbRow>(
      `
      select *
      from telemetry_events
      where occurred_at >= $1::timestamptz and occurred_at < $2::timestamptz
      order by occurred_at asc
      limit $3
      `,
      [since.toISOString(), until.toISOString(), limit],
    );
    return result.rows.map(mapTelemetryEventRow);
  }

  /**
   * Aplicaciones de codigo ya permitidas para un actor y un ejercicio
   * (limite de pistas por ejercicio en el canal de VS Code).
   */
  async countAllowedCodeApplications(actorAnonIdValue: string, exerciseHashValue: string) {
    if (!actorAnonIdValue || !exerciseHashValue) return 0;
    const result = await this.pool.query<{ total: string | number }>(
      `
      select count(*) as total
      from telemetry_events
      where event_type = 'code_application_checked'
        and actor_anon_id = $1
        and exercise_hash = $2
        and blocked = false
      `,
      [actorAnonIdValue, exerciseHashValue],
    );
    return Number(result.rows[0]?.total || 0);
  }

  /** Borra eventos anteriores a una fecha (retencion; ver scripts/purgar-telemetria.ts). */
  async deleteTelemetryEventsBefore(before: Date) {
    const result = await this.pool.query(
      `delete from telemetry_events where occurred_at < $1::timestamptz`,
      [before.toISOString()],
    );
    return result.rowCount || 0;
  }

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

// AppDatabase, parte 13 de 13: analitica de aprendizaje (29-10-2026). Historia del avance del
// taller con seudonimos, seudonimos fuera del analisis (cuentas de muestra) y el registro de la
// reidentificacion dentro de ADACEEN («¿Quien es este codigo?», src/services/learning-analytics.ts).
// Cadena: DatabaseCore -> AuthDatabase -> UsersDatabase -> PolicyDatabase -> RagLotsDatabase -> RagSourcesDatabase -> GithubDatabase -> WorkspaceDatabase -> PilotDatabase -> TelemetryDatabase -> ProgressDatabase -> QuizDatabase -> AnalyticsDatabase -> AppDatabase
import { randomUUID } from "node:crypto";
import type { AppUser } from "../../types/app.js";
import { QuizDatabase } from "./quiz.js";

/** Un estudiante con su login de GitHub (si lo vinculo) y su docente: para pasar del login al seudonimo. */
export type AnalyticsStudentIdentity = {
  userId: string;
  teacherUserId: string | null;
  githubLogin: string | null;
};

/** Foto del avance de un estudiante en un taller (sin login, sin nombre: solo el seudonimo). */
export type WorkshopSnapshot = {
  taller: string;
  actorAnonId: string;
  teacherAnonId: string;
  capturedAt: string;
  started: boolean;
  percent: number;
  compiles: boolean | null;
  done: string[];
  partial: string[];
  missing: string[];
  files: number;
  outside: number;
  lastChangeAt: string | null;
  fingerprint: string;
};

export type WorkshopSnapshotRow = WorkshopSnapshot & { id: string; receivedAt: string };

/** Candidato de la reidentificacion: solo existe dentro del backend, nunca se exporta en bloque. */
export type PseudonymCandidate = {
  userId: string;
  displayName: string;
  studentCode: string | null;
  mergedIntoUserId: string | null;
  mergedIntoDisplayName: string | null;
};

function isoOrNull(value: Date | string | null | undefined): string | null {
  if (value === null || value === undefined || value === "") return null;
  const date = value instanceof Date ? value : new Date(value);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

function parsePointList(value: unknown): string[] {
  try {
    const parsed = typeof value === "string" ? JSON.parse(value) : value;
    return Array.isArray(parsed) ? parsed.filter((item): item is string => typeof item === "string") : [];
  } catch {
    return [];
  }
}

/** Filtro de la historia del avance (el docente solo ve su grupo: teacherAnonId). */
export type WorkshopSnapshotFilter = {
  taller?: string;
  since?: string;
  until?: string;
  teacherAnonId?: string;
  limit?: number;
};

type Queryable = { query<R = any>(text: string, values?: unknown[]): Promise<{ rows: R[] }> };

/**
 * Historia para el exporte (mas antigua primero), sin las cuentas fuera del analisis. Funcion suelta
 * para que la use tambien scripts/exportar-telemetria.ts con su propio pool.
 */
export async function queryWorkshopSnapshots(pool: Queryable, filter: WorkshopSnapshotFilter = {}): Promise<WorkshopSnapshotRow[]> {
  const result = await pool.query<{
    id: string;
    taller: string;
    actor_anon_id: string;
    teacher_anon_id: string;
    captured_at: Date | string;
    received_at: Date | string;
    started: boolean;
    percent: number;
    compiles: boolean | null;
    done_points: string;
    partial_points: string;
    missing_points: string;
    files: number;
    outside: number;
    last_change_at: Date | string | null;
    fingerprint: string;
  }>(
    `
    select *
    from workshop_progress_snapshots
    where ($1 = '' or taller = $1)
      and captured_at >= $2::timestamptz
      and captured_at < $3::timestamptz
      and ($4 = '' or teacher_anon_id = $4)
      and actor_anon_id not in (select actor_anon_id from analytics_excluded_actors)
    order by captured_at asc, actor_anon_id asc
    limit $5
    `,
    [
      filter.taller || "",
      filter.since || "1970-01-01",
      filter.until || new Date(Date.now() + 60_000).toISOString(),
      filter.teacherAnonId || "",
      Math.max(1, Math.min(filter.limit ?? 200_000, 200_000)),
    ],
  );
  return result.rows.map((row) => ({
    id: row.id,
    taller: row.taller,
    actorAnonId: row.actor_anon_id,
    teacherAnonId: row.teacher_anon_id,
    capturedAt: isoOrNull(row.captured_at) || "",
    receivedAt: isoOrNull(row.received_at) || "",
    started: Boolean(row.started),
    percent: Number(row.percent) || 0,
    compiles: row.compiles === null || row.compiles === undefined ? null : Boolean(row.compiles),
    done: parsePointList(row.done_points),
    partial: parsePointList(row.partial_points),
    missing: parsePointList(row.missing_points),
    files: Number(row.files) || 0,
    outside: Number(row.outside) || 0,
    lastChangeAt: isoOrNull(row.last_change_at),
    fingerprint: row.fingerprint,
  }));
}

export class AnalyticsDatabase extends QuizDatabase {
  /** Estudiantes (no unidos a otra cuenta) con su login de GitHub y su docente. */
  async listStudentAnalyticsIdentities(): Promise<AnalyticsStudentIdentity[]> {
    const result = await this.pool.query<{ id: string; teacher_user_id: string | null; account_login: string | null }>(
      `
      select u.id, u.teacher_user_id, g.account_login
      from users u
      join roles r on r.id = u.role_id
      left join github_user_tokens g on g.user_id = u.id
      where r.code = 'student'
        and u.merged_into_user_id is null
      `,
    );
    return result.rows.map((row) => ({
      userId: row.id,
      teacherUserId: row.teacher_user_id || null,
      githubLogin: row.account_login ? row.account_login.trim().toLowerCase() || null : null,
    }));
  }

  /** Huella de la ultima foto de cada seudonimo en el taller. */
  async listWorkshopLastFingerprints(taller: string): Promise<Map<string, string>> {
    const result = await this.pool.query<{ actor_anon_id: string; fingerprint: string }>(
      `select actor_anon_id, fingerprint from workshop_progress_last where taller = $1`,
      [taller],
    );
    return new Map(result.rows.map((row) => [row.actor_anon_id, row.fingerprint]));
  }

  /** Guarda las fotos (ya filtradas: solo las que cambiaron) y deja cada una como la ultima. */
  async saveWorkshopSnapshots(snapshots: WorkshopSnapshot[]): Promise<number> {
    for (const snapshot of snapshots) {
      await this.pool.query(
        `
        insert into workshop_progress_snapshots
          (id, taller, actor_anon_id, teacher_anon_id, captured_at, received_at, started, percent, compiles,
           done_points, partial_points, missing_points, files, outside, last_change_at, fingerprint)
        values ($1, $2, $3, $4, $5, now(), $6, $7, $8, $9, $10, $11, $12, $13, $14, $15)
        `,
        [
          randomUUID(),
          snapshot.taller,
          snapshot.actorAnonId,
          snapshot.teacherAnonId,
          snapshot.capturedAt,
          snapshot.started,
          snapshot.percent,
          snapshot.compiles,
          JSON.stringify(snapshot.done),
          JSON.stringify(snapshot.partial),
          JSON.stringify(snapshot.missing),
          snapshot.files,
          snapshot.outside,
          snapshot.lastChangeAt,
          snapshot.fingerprint,
        ],
      );
      await this.pool.query(
        `
        insert into workshop_progress_last (taller, actor_anon_id, fingerprint, captured_at)
        values ($1, $2, $3, $4)
        on conflict (taller, actor_anon_id) do update
        set fingerprint = excluded.fingerprint,
            captured_at = excluded.captured_at
        `,
        [snapshot.taller, snapshot.actorAnonId, snapshot.fingerprint, snapshot.capturedAt],
      );
    }
    return snapshots.length;
  }

  /** Historia para el exporte (mas antigua primero). teacherAnonId acota al grupo de un docente. */
  async listWorkshopSnapshots(filter: WorkshopSnapshotFilter = {}): Promise<WorkshopSnapshotRow[]> {
    return queryWorkshopSnapshots(this.pool, filter);
  }

  /** Deja en analytics_excluded_actors exactamente estos seudonimos con ese motivo. */
  async replaceAnalyticsExcludedActors(anonIds: Iterable<string>, reason = "muestra") {
    const wanted = new Set([...anonIds].filter(Boolean));
    const current = await this.pool.query<{ actor_anon_id: string }>(
      `select actor_anon_id from analytics_excluded_actors where reason = $1`,
      [reason],
    );
    for (const row of current.rows) {
      if (!wanted.has(row.actor_anon_id)) {
        await this.pool.query(`delete from analytics_excluded_actors where actor_anon_id = $1`, [row.actor_anon_id]);
      }
    }
    const have = new Set(current.rows.map((row) => row.actor_anon_id));
    for (const anonId of wanted) {
      if (have.has(anonId)) continue;
      await this.pool.query(
        `
        insert into analytics_excluded_actors (actor_anon_id, reason, updated_at)
        values ($1, $2, now())
        on conflict (actor_anon_id) do update set reason = excluded.reason, updated_at = excluded.updated_at
        `,
        [anonId, reason],
      );
    }
    return wanted.size;
  }

  /**
   * Estudiantes que el visor puede reidentificar: el administrador, todos; el docente, los suyos.
   * Incluye las cuentas unidas a otra (su telemetria vieja sigue con el seudonimo de su id).
   */
  async listPseudonymCandidates(viewer: AppUser): Promise<PseudonymCandidate[]> {
    if (viewer.role !== "admin" && viewer.role !== "teacher") return [];
    const teacherScopeId = viewer.role === "teacher" ? viewer.id : "";
    const result = await this.pool.query<{
      id: string;
      display_name: string;
      code: string | null;
      merged_into_user_id: string | null;
      merged_display_name: string | null;
    }>(
      `
      select u.id, u.display_name, sc.code, u.merged_into_user_id, merged.display_name as merged_display_name
      from users u
      join roles r on r.id = u.role_id
      left join student_codes sc on sc.user_id = u.id
      left join users merged on merged.id = u.merged_into_user_id
      where r.code = 'student'
        and ($1 = '' or u.teacher_user_id = $1)
      `,
      [teacherScopeId],
    );
    return result.rows.map((row) => ({
      userId: row.id,
      displayName: row.display_name,
      studentCode: row.code || null,
      mergedIntoUserId: row.merged_into_user_id || null,
      mergedIntoDisplayName: row.merged_display_name || null,
    }));
  }

  async recordPseudonymLookup(viewerUserId: string, code: string, found: boolean) {
    await this.pool.query(
      `insert into pseudonym_lookups (id, viewer_user_id, code, found, created_at) values ($1, $2, $3, $4, now())`,
      [randomUUID(), viewerUserId, code, found],
    );
  }

  async countPseudonymLookupsSince(viewerUserId: string, sinceIso: string): Promise<number> {
    const result = await this.pool.query<{ total: string | number }>(
      `select count(*) as total from pseudonym_lookups where viewer_user_id = $1 and created_at >= $2::timestamptz`,
      [viewerUserId, sinceIso],
    );
    return Number(result.rows[0]?.total) || 0;
  }
}

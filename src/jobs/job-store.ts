import { randomUUID } from "node:crypto";
import type { AppDatabase } from "../db/database.js";
import type {
  JobInput,
  JobKind,
  JobRecord,
  JobResultRecord,
  JobStatus,
  JobWithResult,
  WorkerNodeRecord,
} from "./job-types.js";

type JobRow = {
  id: string;
  user_id: string | null;
  kind: string;
  model: string | null;
  status: string;
  input_json: unknown;
  min_vram_gb: number | null;
  assigned_worker_id: string | null;
  error: string | null;
  created_at: string | Date;
  started_at: string | Date | null;
  completed_at: string | Date | null;
  updated_at: string | Date;
};

type JobWithResultRow = JobRow & {
  result_id: string | null;
  result_job_id: string | null;
  output_json: unknown | null;
  output_text: string | null;
  result_worker_id: string | null;
  result_created_at: string | Date | null;
};

type WorkerRow = {
  worker_id: string;
  worker_role: string | null;
  hostname: string | null;
  status: string;
  vram_gb: number | null;
  observed_vram_gb: number | null;
  supported_models: unknown | null;
  ollama_status: unknown | null;
  max_parallel_jobs: number | null;
  last_seen_at: string | Date;
  created_at: string | Date;
  updated_at: string | Date;
};

function toIso(value: string | Date | null) {
  if (!value) return null;
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
}

function normalizeJson<T>(value: unknown, fallback: T): T {
  if (typeof value === "string") {
    try {
      return JSON.parse(value) as T;
    } catch {
      return fallback;
    }
  }
  return (value ?? fallback) as T;
}

function normalizeSupportedModels(value: unknown) {
  const parsed = normalizeJson<unknown[]>(value, []);
  if (!Array.isArray(parsed)) return null;
  return parsed.map((item) => String(item)).filter(Boolean);
}

function mapJobRow(row: JobRow): JobRecord {
  return {
    id: row.id,
    userId: row.user_id,
    kind: row.kind as JobKind,
    model: row.model,
    status: row.status as JobStatus,
    input: normalizeJson<JobInput>(row.input_json, {}),
    minVramGb: row.min_vram_gb,
    assignedWorkerId: row.assigned_worker_id,
    error: row.error,
    createdAt: toIso(row.created_at) || new Date().toISOString(),
    startedAt: toIso(row.started_at),
    completedAt: toIso(row.completed_at),
    updatedAt: toIso(row.updated_at) || new Date().toISOString(),
  };
}

function mapResultRow(row: JobWithResultRow): JobResultRecord | null {
  if (!row.result_id || !row.result_job_id || !row.result_created_at) return null;

  return {
    id: row.result_id,
    jobId: row.result_job_id,
    outputJson: normalizeJson<unknown | null>(row.output_json, null),
    outputText: row.output_text,
    workerId: row.result_worker_id,
    createdAt: toIso(row.result_created_at) || new Date().toISOString(),
  };
}

function mapWorkerRow(row: WorkerRow): WorkerNodeRecord {
  return {
    workerId: row.worker_id,
    workerRole: row.worker_role,
    hostname: row.hostname,
    status: row.status,
    vramGb: row.vram_gb,
    observedVramGb: row.observed_vram_gb,
    supportedModels: normalizeSupportedModels(row.supported_models),
    ollamaStatus: normalizeJson<Record<string, unknown> | null>(row.ollama_status, null),
    maxParallelJobs: row.max_parallel_jobs,
    lastSeenAt: toIso(row.last_seen_at) || new Date().toISOString(),
    createdAt: toIso(row.created_at) || new Date().toISOString(),
    updatedAt: toIso(row.updated_at) || new Date().toISOString(),
  };
}

function normalizeOutput(output: unknown) {
  if (typeof output === "string") {
    return { outputJson: null, outputText: output };
  }

  if (output && typeof output === "object" && !Array.isArray(output)) {
    const maybeText = (output as Record<string, unknown>).text;
    return {
      outputJson: output,
      outputText: typeof maybeText === "string" ? maybeText : null,
    };
  }

  if (output == null) {
    return { outputJson: null, outputText: null };
  }

  return { outputJson: output, outputText: String(output) };
}

export class JobStore {
  constructor(private readonly database: AppDatabase) {}

  async createJob(input: {
    kind: JobKind;
    input: JobInput;
    userId?: string | null;
    model?: string | null;
    minVramGb?: number | null;
  }) {
    const id = randomUUID();
    const result = await this.database.pool.query<JobRow>(
      `
      insert into jobs (
        id,
        user_id,
        kind,
        model,
        status,
        input_json,
        min_vram_gb
      )
      values ($1, $2, $3, $4, 'queued', $5::jsonb, $6)
      returning
        id,
        user_id,
        kind,
        model,
        status,
        input_json,
        min_vram_gb,
        assigned_worker_id,
        error,
        created_at,
        started_at,
        completed_at,
        updated_at
      `,
      [
        id,
        input.userId || null,
        input.kind,
        input.model || null,
        JSON.stringify(input.input),
        input.minVramGb ?? null,
      ],
    );

    return mapJobRow(result.rows[0]);
  }

  async getJob(jobId: string): Promise<JobWithResult | null> {
    const result = await this.database.pool.query<JobWithResultRow>(
      `
      select
        j.id,
        j.user_id,
        j.kind,
        j.model,
        j.status,
        j.input_json,
        j.min_vram_gb,
        j.assigned_worker_id,
        j.error,
        j.created_at,
        j.started_at,
        j.completed_at,
        j.updated_at,
        r.id as result_id,
        r.job_id as result_job_id,
        r.output_json,
        r.output_text,
        r.worker_id as result_worker_id,
        r.created_at as result_created_at
      from jobs j
      left join job_results r on r.job_id = j.id
      where j.id = $1
      limit 1
      `,
      [jobId],
    );

    const row = result.rows[0];
    if (!row) return null;
    return {
      ...mapJobRow(row),
      result: mapResultRow(row),
    };
  }

  async markJobRunning(jobId: string, workerId: string) {
    const result = await this.database.pool.query<JobRow>(
      `
      update jobs
      set
        status = 'running',
        assigned_worker_id = $2,
        started_at = coalesce(started_at, now()),
        updated_at = now()
      where id = $1
        and status in ('queued', 'running')
      returning
        id,
        user_id,
        kind,
        model,
        status,
        input_json,
        min_vram_gb,
        assigned_worker_id,
        error,
        created_at,
        started_at,
        completed_at,
        updated_at
      `,
      [jobId, workerId],
    );

    return result.rows[0] ? mapJobRow(result.rows[0]) : this.getJob(jobId);
  }

  async markJobCompleted(jobId: string, resultInput: {
    output?: unknown;
    workerId?: string | null;
    startedAt?: string | null;
    completedAt?: string | null;
  }) {
    const { outputJson, outputText } = normalizeOutput(resultInput.output);

    const updated = await this.database.pool.query<{ id: string }>(
      `
      update jobs
      set
        status = 'completed',
        assigned_worker_id = coalesce($2, assigned_worker_id),
        error = null,
        started_at = coalesce(started_at, $3::timestamptz, now()),
        completed_at = coalesce($4::timestamptz, now()),
        updated_at = now()
      where id = $1
      returning id
      `,
      [
        jobId,
        resultInput.workerId || null,
        resultInput.startedAt || null,
        resultInput.completedAt || null,
      ],
    );
    if (!updated.rows[0]) return null;

    await this.database.pool.query(
      `
      insert into job_results (
        id,
        job_id,
        output_json,
        output_text,
        worker_id
      )
      values ($1, $2, $3::jsonb, $4, $5)
      on conflict (job_id)
      do update set
        output_json = excluded.output_json,
        output_text = excluded.output_text,
        worker_id = excluded.worker_id,
        created_at = now()
      `,
      [
        randomUUID(),
        jobId,
        outputJson === null ? null : JSON.stringify(outputJson),
        outputText,
        resultInput.workerId || null,
      ],
    );

    return this.getJob(jobId);
  }

  async markJobFailed(jobId: string, error: string, workerId?: string | null) {
    await this.database.pool.query(
      `
      update jobs
      set
        status = 'failed',
        assigned_worker_id = coalesce($2, assigned_worker_id),
        error = $3,
        completed_at = coalesce(completed_at, now()),
        updated_at = now()
      where id = $1
      `,
      [jobId, workerId || null, error.slice(0, 4000)],
    );

    return this.getJob(jobId);
  }

  async upsertWorkerHeartbeat(input: {
    workerId: string;
    workerRole?: string | null;
    hostname?: string | null;
    status?: string | null;
    vramGb?: number | null;
    observedVramGb?: number | null;
    supportedModels?: string[] | null;
    ollamaStatus?: Record<string, unknown> | null;
    maxParallelJobs?: number | null;
  }) {
    const result = await this.database.pool.query<WorkerRow>(
      `
      insert into worker_nodes (
        worker_id,
        worker_role,
        hostname,
        status,
        vram_gb,
        observed_vram_gb,
        supported_models,
        ollama_status,
        max_parallel_jobs,
        last_seen_at
      )
      values ($1, $2, $3, $4, $5, $6, $7::jsonb, $8::jsonb, $9, now())
      on conflict (worker_id)
      do update set
        worker_role = excluded.worker_role,
        hostname = excluded.hostname,
        status = excluded.status,
        vram_gb = excluded.vram_gb,
        observed_vram_gb = excluded.observed_vram_gb,
        supported_models = excluded.supported_models,
        ollama_status = excluded.ollama_status,
        max_parallel_jobs = excluded.max_parallel_jobs,
        last_seen_at = now(),
        updated_at = now()
      returning
        worker_id,
        worker_role,
        hostname,
        status,
        vram_gb,
        observed_vram_gb,
        supported_models,
        ollama_status,
        max_parallel_jobs,
        last_seen_at,
        created_at,
        updated_at
      `,
      [
        input.workerId,
        input.workerRole || null,
        input.hostname || null,
        input.status || "online",
        input.vramGb ?? null,
        input.observedVramGb ?? null,
        JSON.stringify(input.supportedModels || []),
        JSON.stringify(input.ollamaStatus || {}),
        input.maxParallelJobs ?? null,
      ],
    );

    return mapWorkerRow(result.rows[0]);
  }

  async listWorkers() {
    const result = await this.database.pool.query<WorkerRow>(
      `
      select
        worker_id,
        worker_role,
        hostname,
        status,
        vram_gb,
        observed_vram_gb,
        supported_models,
        ollama_status,
        max_parallel_jobs,
        last_seen_at,
        created_at,
        updated_at
      from worker_nodes
      order by last_seen_at desc
      `,
    );

    return result.rows.map(mapWorkerRow);
  }
}

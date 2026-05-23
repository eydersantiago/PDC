export type JobKind =
  | "text"
  | "image"
  | "github_mentor"
  | "intervention"
  | "document_classification";

export type JobStatus =
  | "queued"
  | "running"
  | "completed"
  | "failed"
  | "cancelled";

export type JsonObject = Record<string, unknown>;
export type JobInput = string | JsonObject | unknown[];

export type LlmJobMessage = {
  jobId: string;
  kind: JobKind;
  userId?: string | null;
  model?: string | null;
  input: JobInput;
  minVramGb?: number | null;
  maxOutputChars?: number | null;
  createdAt: string;
};

export type LlmJobResultMessage = {
  jobId: string;
  status: JobStatus;
  output?: unknown;
  error?: string | null;
  workerId?: string | null;
  startedAt?: string | null;
  completedAt?: string | null;
};

export type JobRecord = {
  id: string;
  userId: string | null;
  kind: JobKind;
  model: string | null;
  status: JobStatus;
  input: JobInput;
  minVramGb: number | null;
  assignedWorkerId: string | null;
  error: string | null;
  createdAt: string;
  startedAt: string | null;
  completedAt: string | null;
  updatedAt: string;
};

export type JobResultRecord = {
  id: string;
  jobId: string;
  outputJson: unknown | null;
  outputText: string | null;
  workerId: string | null;
  createdAt: string;
};

export type JobWithResult = JobRecord & {
  result: JobResultRecord | null;
};

export type WorkerNodeRecord = {
  workerId: string;
  workerRole: string | null;
  hostname: string | null;
  status: string;
  vramGb: number | null;
  observedVramGb: number | null;
  supportedModels: string[] | null;
  ollamaStatus: Record<string, unknown> | null;
  maxParallelJobs: number | null;
  lastSeenAt: string;
  createdAt: string;
  updatedAt: string;
};

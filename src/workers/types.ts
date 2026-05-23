import type {
  JobInput,
  LlmJobMessage,
  LlmJobResultMessage,
} from "../jobs/job-types.js";

export type { JobInput, LlmJobMessage, LlmJobResultMessage };

export type WorkerModelRoute =
  | "primary"
  | "fast"
  | "classifier"
  | "experimental"
  | "explicit";

export type WorkerConfig = {
  workerId: string;
  workerRole: string;
  hostname: string;
  serviceBusConnectionString: string;
  jobsQueueName: string;
  resultsQueueName: string;
  ollamaBaseUrl: string;
  ollamaModel: string;
  ollamaFastModel: string;
  ollamaClassifierModel: string;
  ollamaExperimentalModel: string | null;
  ollamaContext: number;
  ollamaFastContext: number;
  ollamaClassifierContext: number;
  ollamaExperimentalContext: number;
  supportedModels: string[];
  maxParallelJobs: number;
  vramGb: number | null;
  adaceenApiUrl: string;
  workerSharedSecret: string;
  ollamaTimeoutMs: number;
  ollamaStatusTimeoutMs: number;
};

export type SelectedOllamaModel = {
  route: WorkerModelRoute;
  model: string;
  context: number;
  reason: string;
};

export type OllamaGenerateRequest = {
  model: string;
  prompt: string;
  stream: false;
  images?: string[];
  options?: Record<string, unknown>;
};

export type OllamaGenerateResponse = {
  model?: string;
  response?: string;
  done?: boolean;
  total_duration?: number;
  load_duration?: number;
  prompt_eval_count?: number;
  eval_count?: number;
  [key: string]: unknown;
};

export type OllamaRuntimeModel = {
  name: string;
  model: string;
  sizeBytes: number;
  sizeVramBytes: number;
  details?: unknown;
};

export type OllamaRuntimeStatus = {
  ok: boolean;
  checkedAt: string;
  loadedModels: string[];
  loadedVramBytes: number;
  loadedVramGb: number;
  models: OllamaRuntimeModel[];
  error?: string;
};

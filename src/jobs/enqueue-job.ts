import type { AppDatabase } from "../db/database.js";
import { createJobsSender } from "../queue/service-bus.js";
import { logInfo, logWarn, toErrorFields } from "../services/logger.js";
import { JobStore } from "./job-store.js";
import type { JobInput, JobKind, LlmJobMessage } from "./job-types.js";

export async function enqueueLlmJob(database: AppDatabase, input: {
  kind: JobKind;
  input: JobInput;
  userId?: string | null;
  model?: string | null;
  minVramGb?: number | null;
  maxOutputChars?: number | null;
}) {
  const sender = createJobsSender();
  const store = new JobStore(database);
  const job = await store.createJob({
    kind: input.kind,
    input: input.input,
    userId: input.userId,
    model: input.model,
    minVramGb: input.minVramGb,
  });

  const message: LlmJobMessage = {
    jobId: job.id,
    kind: input.kind,
    userId: input.userId || null,
    model: input.model || null,
    input: input.input,
    minVramGb: input.minVramGb ?? null,
    maxOutputChars: input.maxOutputChars ?? null,
    createdAt: job.createdAt,
  };

  try {
    await sender.sendMessages({
      body: message,
      contentType: "application/json",
      messageId: job.id,
      subject: input.kind,
      applicationProperties: {
        kind: input.kind,
        ...(input.minVramGb === undefined || input.minVramGb === null ? {} : { minVramGb: input.minVramGb }),
        ...(input.model ? { model: input.model } : {}),
      },
    });
    logInfo("servicebus_job_sent", {
      job_id: job.id,
      kind: input.kind,
      model: input.model || null,
      min_vram_gb: input.minVramGb ?? null,
    });
    return job;
  } catch (error) {
    await store.markJobFailed(job.id, `No se pudo enviar el job a Service Bus: ${String(error)}`);
    logWarn("servicebus_job_send_failed", {
      job_id: job.id,
      kind: input.kind,
      ...toErrorFields(error),
    });
    throw error;
  } finally {
    await sender.close().catch(() => {});
  }
}

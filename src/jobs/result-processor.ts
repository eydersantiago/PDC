import type { AppDatabase } from "../db/database.js";
import type {
  ProcessErrorArgs,
  ServiceBusReceivedMessage,
  ServiceBusReceiver,
} from "@azure/service-bus";
import { createResultsReceiver } from "../queue/service-bus.js";
import { logInfo, logWarn, toErrorFields } from "../services/logger.js";
import { JobStore } from "./job-store.js";
import type { LlmJobResultMessage } from "./job-types.js";

function parseMessageBody(body: unknown): LlmJobResultMessage {
  if (typeof body === "string") {
    return JSON.parse(body) as LlmJobResultMessage;
  }

  if (body instanceof Uint8Array) {
    return JSON.parse(new TextDecoder().decode(body)) as LlmJobResultMessage;
  }

  return body as LlmJobResultMessage;
}

function isResultMessage(value: LlmJobResultMessage) {
  return Boolean(value?.jobId && value?.status);
}

export async function startResultProcessor(database: AppDatabase) {
  let receiver: ServiceBusReceiver;
  try {
    receiver = createResultsReceiver();
  } catch (error) {
    console.warn("[queue] No se inicio el consumidor de resultados:", String(error));
    return { close: async () => {} };
  }

  const store = new JobStore(database);
  const subscription = receiver.subscribe(
    {
      processMessage: async (message: ServiceBusReceivedMessage) => {
        try {
          const result = parseMessageBody(message.body);
          if (!isResultMessage(result)) {
            logWarn("servicebus_result_invalid", {
              message_id: message.messageId || null,
            });
            await receiver.deadLetterMessage(message, {
              deadLetterReason: "InvalidResultMessage",
              deadLetterErrorDescription: "El mensaje no contiene jobId/status.",
            });
            return;
          }

          if (result.status === "running") {
            if (result.workerId) {
              await store.markJobRunning(result.jobId, result.workerId);
            }
          } else if (result.status === "completed") {
            await store.markJobCompleted(result.jobId, {
              output: result.output,
              workerId: result.workerId,
              startedAt: result.startedAt,
              completedAt: result.completedAt,
            });
          } else if (result.status === "failed") {
            await store.markJobFailed(
              result.jobId,
              result.error || "El worker marco el job como fallido.",
              result.workerId,
            );
          }

          logInfo("servicebus_result_processed", {
            message_id: message.messageId || null,
            job_id: result.jobId,
            status: result.status,
            worker_id: result.workerId || null,
            delivery_count: message.deliveryCount || 0,
          });

          await receiver.completeMessage(message);
        } catch (error) {
          if ((message.deliveryCount || 0) >= 5) {
            logWarn("servicebus_result_deadlettered", {
              message_id: message.messageId || null,
              delivery_count: message.deliveryCount || 0,
              ...toErrorFields(error),
            });
            await receiver.deadLetterMessage(message, {
              deadLetterReason: "ResultProcessingFailed",
              deadLetterErrorDescription: String(error).slice(0, 1024),
            });
            return;
          }

          logWarn("servicebus_result_abandoned", {
            message_id: message.messageId || null,
            delivery_count: message.deliveryCount || 0,
            ...toErrorFields(error),
          });
          await receiver.abandonMessage(message);
        }
      },
      processError: async (args: ProcessErrorArgs) => {
        console.error("[queue] Error recibiendo resultados:", args.error);
      },
    },
    {
      autoCompleteMessages: false,
      maxConcurrentCalls: 4,
    },
  );

  console.log("[queue] Consumidor de resultados iniciado.");

  return {
    close: async () => {
      await subscription.close();
      await receiver.close();
    },
  };
}

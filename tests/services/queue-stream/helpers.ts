import type { ServiceBusMessage, ServiceBusReceivedMessage } from "@azure/service-bus";
import { createDiagnosticLogger } from "../../../src/services/shared/diagnostics.js";
import { buildPartialMessage, buildResultMessage } from "../../../src/services/queue/queue-stream.js";
import type { QueueSessionClient } from "../../../src/services/queue/service-bus-agent.js";

// Ayudas de las pruebas de la respuesta en vivo por la cola (01-11-2026): entorno, reloj a mano y
// receptor de sesion falso de Service Bus.

export const silentLogger = createDiagnosticLogger("prueba-cola", {});

export function withEnv<T>(values: Record<string, string | undefined>, run: () => Promise<T>) {
  const before = Object.fromEntries(Object.keys(values).map((key) => [key, process.env[key]]));
  for (const [key, value] of Object.entries(values)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  return run().finally(() => {
    for (const [key, value] of Object.entries(before)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });
}

/** Reloj y temporizadores a mano: el tope de frecuencia se prueba sin esperar. */
export function manualClock() {
  let nowMs = 0;
  const timers: Array<{ at: number; callback: () => void; id: number }> = [];
  let nextId = 1;
  return {
    now: () => nowMs,
    setTimer: (callback: () => void, ms: number) => {
      const id = nextId++;
      timers.push({ at: nowMs + ms, callback, id });
      return id;
    },
    clearTimer: (handle: unknown) => {
      const index = timers.findIndex((timer) => timer.id === handle);
      if (index >= 0) timers.splice(index, 1);
    },
    async advance(ms: number) {
      nowMs += ms;
      for (;;) {
        timers.sort((left, right) => left.at - right.at);
        const due = timers[0];
        if (!due || due.at > nowMs) break;
        timers.shift();
        due.callback();
        await new Promise((resolve) => setImmediate(resolve));
      }
      await new Promise((resolve) => setImmediate(resolve));
    },
    pending: () => timers.length,
  };
}

export function received(message: ServiceBusMessage): ServiceBusReceivedMessage {
  return { ...message } as unknown as ServiceBusReceivedMessage;
}

/** Receptor de sesion falso: entrega los mensajes en orden, de a uno. */
export function fakeSessionClient(queue: ServiceBusMessage[], options: { neverFinal?: boolean } = {}) {
  const state = { accepted: "", closed: false, receives: 0 };
  const client: QueueSessionClient = {
    async acceptSession(_queue, sessionId) {
      state.accepted = sessionId;
      return {
        async receiveMessages(_count, receiveOptions) {
          state.receives += 1;
          const next = queue.shift();
          if (next) return [received(next)];
          if (options.neverFinal) {
            await new Promise((resolve) => setTimeout(resolve, Math.min(50, receiveOptions?.maxWaitTimeInMs ?? 50)));
          }
          return [];
        },
        async close() {
          state.closed = true;
        },
      };
    },
  };
  return { client, state };
}

export function partial(jobId: string, seq: number, text: string, sharedSecret = "secreto") {
  return buildPartialMessage({ jobId, seq, partialText: text, sharedSecret });
}

export function finalResult(jobId: string, text: string, sharedSecret = "secreto") {
  return buildResultMessage({ schemaVersion: 1, jobId, ok: true, outputText: text, workerId: "gpu-1", sharedSecret, completedAt: "2026-11-01T00:00:00.000Z" }, 240_000);
}

import assert from "node:assert/strict";
import test from "node:test";
import {
  JobValidationError,
  decideJobFailure,
  isJobKindSupported,
  isJobStale,
  isRetriableJobError,
  parseWorkerKinds,
  resolveLockRenewalMs,
  resolveReceivePlan,
} from "../../src/services/queue-worker-policy.js";

function withCode(message: string, code: string) {
  return Object.assign(new Error(message), { code });
}

test("isRetriableJobError reconoce fallos de red y de Ollama como transitorios", () => {
  assert.equal(isRetriableJobError(withCode("connect ECONNREFUSED 127.0.0.1:11434", "ECONNREFUSED")), true);
  assert.equal(isRetriableJobError(new Error("fetch failed")), true);
  assert.equal(isRetriableJobError(new Error("Vision HTTP 503: model loading")), true);
  assert.equal(isRetriableJobError(Object.assign(new Error("rate limited"), { status: 429 })), true);
  assert.equal(isRetriableJobError(new Error("CUDA error: out of memory")), true);
});

test("isRetriableJobError sigue la causa anidada de un fetch fallido", () => {
  const error = new Error("fetch failed", { cause: withCode("getaddrinfo EAI_AGAIN ollama", "EAI_AGAIN") });
  assert.equal(isRetriableJobError(error), true);
});

test("isRetriableJobError no reintenta errores de validacion ni de logica", () => {
  assert.equal(isRetriableJobError(new JobValidationError("jobId requerido.")), false);
  assert.equal(isRetriableJobError(new Error("Sin salida del agente")), false);
  assert.equal(isRetriableJobError("cadena suelta"), false);
});

test("decideJobFailure manda jobs invalidos a dead-letter y responde el error", () => {
  const decision = decideJobFailure({
    error: new JobValidationError("WORKER_SHARED_SECRET no coincide."),
    deliveryCount: 1,
    maxAttempts: 3,
  });
  assert.deepEqual(decision, { settlement: "deadLetter", sendResult: true, reason: "validation" });
});

test("decideJobFailure libera el job para otro worker mientras queden intentos", () => {
  const error = withCode("connect ECONNREFUSED", "ECONNREFUSED");
  assert.deepEqual(
    decideJobFailure({ error, deliveryCount: 1, maxAttempts: 3 }),
    { settlement: "abandon", sendResult: false, reason: "retry" },
  );
  assert.deepEqual(
    decideJobFailure({ error, deliveryCount: undefined, maxAttempts: 3 }),
    { settlement: "abandon", sendResult: false, reason: "retry" },
  );
});

test("decideJobFailure responde el error al agotar los intentos", () => {
  const error = withCode("connect ECONNREFUSED", "ECONNREFUSED");
  assert.deepEqual(
    decideJobFailure({ error, deliveryCount: 3, maxAttempts: 3 }),
    { settlement: "complete", sendResult: true, reason: "attempts_exhausted" },
  );
});

test("decideJobFailure completa y responde errores no reintentables", () => {
  assert.deepEqual(
    decideJobFailure({ error: new Error("Sin salida del agente"), deliveryCount: 1, maxAttempts: 3 }),
    { settlement: "complete", sendResult: true, reason: "not_retriable" },
  );
});

test("isJobStale descarta jobs que superaron la espera del backend", () => {
  const now = Date.parse("2026-09-10T12:02:01.000Z");
  assert.equal(isJobStale({ requestedAt: "2026-09-10T12:00:00.000Z", timeoutMs: 120000, now }), true);
  assert.equal(isJobStale({ requestedAt: "2026-09-10T12:01:00.000Z", timeoutMs: 120000, now }), false);
});

test("isJobStale usa enqueuedTimeUtc cuando el job no trae requestedAt", () => {
  const now = Date.parse("2026-09-10T12:10:00.000Z");
  assert.equal(isJobStale({ enqueuedTimeUtc: new Date("2026-09-10T12:00:00.000Z"), timeoutMs: 120000, now }), true);
  assert.equal(isJobStale({ requestedAt: "no-es-fecha", timeoutMs: 120000, now }), false);
  assert.equal(isJobStale({ timeoutMs: 120000, now }), false);
});

test("resolveLockRenewalMs cubre el timeout del backend con margen", () => {
  assert.equal(resolveLockRenewalMs({ requestTimeoutMs: 120000 }), 150000);
  assert.equal(resolveLockRenewalMs({ requestTimeoutMs: 10000 }), 60000);
  assert.equal(resolveLockRenewalMs({ requestTimeoutMs: 120000, configuredMs: 600000 }), 600000);
  assert.equal(resolveLockRenewalMs({ requestTimeoutMs: 120000, configuredMs: 1000 }), 150000);
});

test("parseWorkerKinds: una Mac sin modelo de vision atiende solo texto; sin valor valido, ambos tipos", () => {
  const onlyText = parseWorkerKinds(["text"]);
  assert.equal(isJobKindSupported("text", onlyText), true);
  assert.equal(isJobKindSupported("image", onlyText), false);
  assert.deepEqual([...parseWorkerKinds(" Text , IMAGE ")].sort(), ["image", "text"]);
  assert.deepEqual([...parseWorkerKinds("video")].sort(), ["image", "text"]);
  assert.deepEqual([...parseWorkerKinds(undefined)].sort(), ["image", "text"]);
  assert.equal(isJobKindSupported("video", parseWorkerKinds("text,image")), false);
});

test("queue worker: un worker de respaldo espera poco y descansa; uno normal espera en la cola", () => {
  assert.deepEqual(resolveReceivePlan(undefined, 3000), { backup: false, maxWaitTimeInMs: 5000, idleDelayMs: 0 });
  assert.deepEqual(resolveReceivePlan("normal", 3000), { backup: false, maxWaitTimeInMs: 5000, idleDelayMs: 0 });
  assert.deepEqual(resolveReceivePlan("backup", 3000), { backup: true, maxWaitTimeInMs: 1000, idleDelayMs: 3000 });
  assert.deepEqual(resolveReceivePlan(" Respaldo ", 100), { backup: true, maxWaitTimeInMs: 1000, idleDelayMs: 500 });
});

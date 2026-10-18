import assert from "node:assert/strict";
import test from "node:test";
import { getJsonWithRetry, readIntArg } from "../../scripts/lib/cli.js";

/**
 * Regresion: sin la opcion, readIntArg tomaba 0 y lo subia al minimo. Con
 * telemetria:purgar eso era retener 1 dia en lugar de TELEMETRY_RETENTION_DAYS.
 */
test("cli: readIntArg usa el valor por defecto cuando falta la opcion", () => {
  const original = process.argv;
  try {
    process.argv = ["node", "script.ts"];
    assert.equal(readIntArg("dias", 365, 1, 3650), 365);
    process.argv = ["node", "script.ts", "--dias="];
    assert.equal(readIntArg("dias", 365, 1, 3650), 365);
    process.argv = ["node", "script.ts", "--dias=180"];
    assert.equal(readIntArg("dias", 365, 1, 3650), 180);
    process.argv = ["node", "script.ts", "--dias=0"];
    assert.equal(readIntArg("dias", 365, 1, 3650), 1, "un valor explicito fuera de rango se acota");
    process.argv = ["node", "script.ts", "--dias=abc"];
    assert.equal(readIntArg("dias", 365, 1, 3650), 365);
  } finally {
    process.argv = original;
  }
});

/** fetch falso: cada llamada toma la siguiente respuesta (o error) de la lista. */
function scriptedFetch(steps: Array<Response | Error>) {
  const calls: Array<{ url: string; headers: unknown; hasSignal: boolean }> = [];
  const impl = (async (url: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(url), headers: init?.headers, hasSignal: !!init?.signal });
    const step = steps.shift();
    if (!step) throw new Error("sin respuesta preparada");
    if (step instanceof Error) throw step;
    return step;
  }) as typeof fetch;
  return { impl, calls };
}

function networkError(code: string) {
  return Object.assign(new TypeError("fetch failed"), { cause: { code } });
}

test("cli: getJsonWithRetry reintenta una vez cuando no hubo respuesta (monitor desde Cloud Shell)", async () => {
  const lost = scriptedFetch([networkError("ECONNRESET"), new Response(JSON.stringify({ block: 1 }), { status: 200 })]);
  const recovered = await getJsonWithRetry<{ block: number }>("https://backend.test/api/pilot", { "x-session-id": "s1" }, { fetchImpl: lost.impl, retryDelayMs: 0 });
  assert.equal(recovered.status, 200);
  assert.deepEqual(recovered.data, { block: 1 });
  assert.equal(recovered.attempts, 2);
  assert.equal(lost.calls.length, 2);
  assert.deepEqual(lost.calls[0].headers, { "x-session-id": "s1" });
  assert.ok(lost.calls.every((call) => call.hasSignal), "cada intento lleva su limite de tiempo");

  // Un 503 es una respuesta del backend (sin worker): no se reintenta.
  const noWorker = scriptedFetch([new Response(JSON.stringify({ ok: false, reason: "sin_worker" }), { status: 503 })]);
  const down = await getJsonWithRetry("https://backend.test/api/agent/health", {}, { fetchImpl: noWorker.impl, retryDelayMs: 0 });
  assert.equal(down.status, 503);
  assert.equal(down.attempts, 1);
  assert.equal(noWorker.calls.length, 1);

  // Sin respuesta en los dos intentos: estado 0 y el motivo, con el codigo de red.
  const gone = scriptedFetch([networkError("ECONNRESET"), networkError("ETIMEDOUT")]);
  const lostTwice = await getJsonWithRetry<{ error?: string }>("https://backend.test/api/health", {}, { fetchImpl: gone.impl, retryDelayMs: 0 });
  assert.equal(lostTwice.status, 0);
  assert.equal(lostTwice.attempts, 2);
  assert.equal(lostTwice.data.error, "TypeError: fetch failed (ETIMEDOUT)");
});

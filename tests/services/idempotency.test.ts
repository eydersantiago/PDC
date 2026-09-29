import assert from "node:assert/strict";
import test from "node:test";
import { createIdempotencyCache, readIdempotencyKey } from "../../src/services/idempotency.js";

// A12.12 · ADACEEN-155, riesgo 6: una repeticion con la misma Idempotency-Key no repite el trabajo.

test("idempotencia: la misma clave corre el trabajo una sola vez, en curso o terminado", async () => {
  const cache = createIdempotencyCache<number>();
  let calls = 0;
  let release: (value: number) => void = () => {};
  const slow = () => {
    calls += 1;
    return new Promise<number>((resolve) => { release = resolve; });
  };

  const first = cache.run("actor|clave-0001", slow);
  const concurrent = cache.run("actor|clave-0001", slow);
  assert.equal(first.reused, false);
  assert.equal(concurrent.reused, true);
  release(42);
  assert.deepEqual(await Promise.all([first.promise, concurrent.promise]), [42, 42]);

  const later = cache.run("actor|clave-0001", slow);
  assert.equal(later.reused, true);
  assert.equal(await later.promise, 42);
  assert.equal(calls, 1);

  const other = cache.run("otro-actor|clave-0001", async () => 7);
  assert.equal(other.reused, false, "la clave va por actor");
  assert.equal(await other.promise, 7);
});

test("idempotencia: un fallo no se recuerda y la clave vence con el TTL", async () => {
  let now = 1_000;
  const cache = createIdempotencyCache<string>({ ttlMs: 500, now: () => now });

  const failed = cache.run("k-fallo-001", async () => { throw new Error("modelo caido"); });
  await assert.rejects(failed.promise, /modelo caido/);
  await new Promise((resolve) => setImmediate(resolve));
  const retry = cache.run("k-fallo-001", async () => "ok");
  assert.equal(retry.reused, false, "tras un fallo se puede reintentar");
  assert.equal(await retry.promise, "ok");

  now += 600;
  const afterTtl = cache.run("k-fallo-001", async () => "nuevo");
  assert.equal(afterTtl.reused, false);
  assert.equal(await afterTtl.promise, "nuevo");
});

test("idempotencia: tope de claves y validacion de la cabecera", async () => {
  const cache = createIdempotencyCache<number>({ maxEntries: 2 });
  cache.run("a-1234567", async () => 1);
  cache.run("b-1234567", async () => 2);
  cache.run("c-1234567", async () => 3);
  assert.equal(cache.size(), 2);

  assert.equal(readIdempotencyKey("  4f1c2a9e-5b7d-4e8a-9c1d-2f3a4b5c6d7e "), "4f1c2a9e-5b7d-4e8a-9c1d-2f3a4b5c6d7e");
  assert.equal(readIdempotencyKey("corta"), "");
  assert.equal(readIdempotencyKey("con espacios internos"), "");
  assert.equal(readIdempotencyKey(undefined), "");
  assert.equal(readIdempotencyKey("x".repeat(129)), "");
});

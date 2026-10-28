import assert from "node:assert/strict";
import test from "node:test";
import type { RagSource } from "../../src/types/app.js";
import { buildRagChunksForSource, rankRagSources } from "../../src/services/rag-sources.js";
import { filterSourcesForLot } from "../../src/services/rag-lots.js";
import {
  CANARY_ACTIVE_WINDOW_MS,
  CANARY_QUIET_MS,
  SUSPECT_WINDOW_MS,
  describeQueueHealth,
  isQueueSuspect,
  noteCanaryEnd,
  noteCanaryStart,
  noteQueueJobFinished,
  noteQueueJobSent,
  noteQueueResult,
  noteQueueTimeout,
  resetQueueHealthForTests,
  shouldSendCanary,
} from "../../src/services/queue-health.js";
import {
  RECEIVE_WATCHDOG_GRACE_MS,
  receiveDeadlineMs,
  shouldRecycleIdleConnection,
  withDeadline,
} from "../../src/services/queue-worker-policy.js";
import { EXAM_PRESET_DEFAULT_REPO, resolveExamPreset } from "../../src/services/exam-preset.js";
import { env } from "../../src/config/env.js";
import { createDatabase } from "../../src/db/database.js";
import { readFileSync } from "node:fs";

/**
 * Examen del 28-10-2026: lo que fallo en la prueba del 27-10 a las 7 p. m. y lo que se preparo
 * para el parcial (Sistema bancario).
 */

function source(id: string, contentText: string, metadata: Record<string, unknown> = {}): RagSource {
  const base: RagSource = {
    id,
    scope: "default",
    teacherUserId: null,
    sourceKey: id,
    title: id,
    sourceType: "document",
    fileName: `${id}.txt`,
    mimeType: "text/plain",
    contentSha256: "sha",
    contentText,
    metadata: { courseCode: "FPOO", knowledge_tier: "primary", ...metadata },
    isActive: true,
    createdByUserId: null,
    createdAt: "2026-10-27T00:00:00.000Z",
    updatedAt: "2026-10-27T00:00:00.000Z",
  } as RagSource;
  base.chunks = buildRagChunksForSource({
    title: base.title,
    sourceType: base.sourceType,
    fileName: base.fileName,
    sourceKey: base.sourceKey,
    contentText: base.contentText,
    metadata: base.metadata,
  }).map((chunk) => ({
    id: `${id}:chunk:${chunk.chunkIndex}`,
    sourceId: id,
    scope: base.scope,
    teacherUserId: null,
    sourceKey: id,
    sourceTitle: base.title,
    sourceType: base.sourceType,
    fileName: base.fileName,
    mimeType: base.mimeType,
    sourceMetadata: base.metadata,
    isActive: true,
    ...chunk,
    createdAt: base.createdAt,
  }));
  return base;
}

test("examen 28-10: el RAG no se cae con palabras del prototipo de JavaScript («constructor»)", () => {
  const banco = source("banco", "La clase Cuenta tiene un constructor con id y saldo. CuentaCorriente redefine retirarDinero con el sobregiro.");
  for (const query of ["el constructor de Cuenta", "constructor tostring valueof hasownproperty __proto__", "Constructor de la clase"]) {
    const ranked = rankRagSources([banco], query, 3);
    assert.ok(Array.isArray(ranked), query);
  }
  const ranked = rankRagSources([banco], "como hago el constructor de Cuenta con saldo", 3);
  assert.equal(ranked[0]?.sourceId, "banco");
});

test("examen 28-10: el enunciado del parcial llega a todos los lotes salvo que el docente lo desactive", () => {
  const pinned = source("RAG-FPOO-EXAMEN-BANCO", "Sistema bancario", { pinned_all_lots: true });
  const base = source("base", "material base");
  const lotOnly = { lotId: "lote-2026-2", includesBase: false } as Parameters<typeof filterSourcesForLot>[1];
  assert.deepEqual(filterSourcesForLot([pinned, base], lotOnly).map((item) => item.id), ["RAG-FPOO-EXAMEN-BANCO"]);
  const disabled = filterSourcesForLot([pinned], lotOnly, [{ sourceId: "RAG-FPOO-EXAMEN-BANCO", isActive: false } as never]);
  assert.deepEqual(disabled, []);
});

test("examen 28-10: la semilla del RAG trae el enunciado del Sistema bancario", () => {
  const lines = readFileSync("data/rag/rag_sources_seed.jsonl", "utf8").split(/\r?\n/).filter(Boolean).map((line) => JSON.parse(line));
  const exam = lines.find((entry) => entry.id === "RAG-FPOO-EXAMEN-BANCO");
  assert.ok(exam, "falta la entrada del examen");
  assert.equal(exam.courseCode, "FPOO");
  assert.equal(exam.pinned_all_lots, true);
  for (const name of ["HU-1", "HU-5", "CuentaAhorros", "CuentaCorriente", "Titularidad", "Banco", "retirarDinero"]) {
    assert.match(exam.content, new RegExp(name), name);
  }
});

test("examen 28-10: la cola sorda se detecta y los pedidos fallan rapido; carga y reinicios no son sordera", () => {
  resetQueueHealthForTests();
  const t0 = 1_000_000;
  const v100 = (jobs: number, startedAt = "2026-10-28T12:00:00.000Z") => ({ "gce-v100": { startedAt, jobs } });
  // Carga: el job vence pero el worker avanzo (estaba ocupado con otros).
  const busy = noteQueueJobSent({ nowMs: t0, progress: v100(10) });
  assert.equal(noteQueueTimeout(busy, { nowMs: t0 + 120_000, progressNow: v100(14) }), false);
  noteQueueJobFinished(busy);
  assert.equal(isQueueSuspect({ nowMs: t0 + 120_001, progressNow: v100(14) }), false);

  // Reinicio del worker (su contador vuelve a 0 con otro startedAt): no es sordera.
  const restarted = noteQueueJobSent({ nowMs: t0 + 130_000, progress: v100(14) });
  assert.equal(noteQueueTimeout(restarted, { nowMs: t0 + 250_000, progressNow: v100(0, "2026-10-28T12:30:00.000Z") }), false);
  noteQueueJobFinished(restarted);
  // Aparece otro worker (una Mac): tampoco.
  const other = noteQueueJobSent({ nowMs: t0 + 260_000, progress: v100(0, "2026-10-28T12:30:00.000Z") });
  assert.equal(noteQueueTimeout(other, { nowMs: t0 + 380_000, progressNow: { ...v100(0, "2026-10-28T12:30:00.000Z"), "mac-lab-1": { startedAt: null, jobs: 0 } } }), false);
  noteQueueJobFinished(other);

  // Sordera: vence, nadie respondio y ningun worker avanzo (aunque otro haya dejado de estar vivo).
  const deaf = noteQueueJobSent({ nowMs: t0 + 400_000, progress: { ...v100(3), "mac-lab-1": { startedAt: null, jobs: 7 } } });
  assert.equal(noteQueueTimeout(deaf, { nowMs: t0 + 520_000, progressNow: v100(3) }), true);
  noteQueueJobFinished(deaf);
  assert.equal(isQueueSuspect({ nowMs: t0 + 520_001, progressNow: v100(3) }), true);
  assert.equal(describeQueueHealth(t0 + 520_001).queue_suspect, true);
  // El worker reconecta y su contador avanza: se cierra sola.
  assert.equal(isQueueSuspect({ nowMs: t0 + 530_000, progressNow: v100(4) }), false);

  // Una respuesta cierra la sospecha.
  const again = noteQueueJobSent({ nowMs: t0 + 600_000, progress: v100(4) });
  noteQueueTimeout(again, { nowMs: t0 + 720_000, progressNow: v100(4) });
  noteQueueJobFinished(again);
  assert.equal(isQueueSuspect({ nowMs: t0 + 720_001, progressNow: v100(4) }), true);
  noteQueueResult(t0 + 730_000);
  assert.equal(isQueueSuspect({ nowMs: t0 + 730_001, progressNow: v100(4) }), false);

  // Sin latidos no se sabe: nunca abre.
  const unknown = noteQueueJobSent({ nowMs: t0 + 800_000, progress: null });
  assert.equal(noteQueueTimeout(unknown, { nowMs: t0 + 920_000, progressNow: null }), false);
  noteQueueJobFinished(unknown);

  // Como mucho SUSPECT_WINDOW_MS de falla rapida sin confirmacion.
  const last = noteQueueJobSent({ nowMs: t0 + 1_000_000, progress: v100(4) });
  noteQueueTimeout(last, { nowMs: t0 + 1_120_000, progressNow: v100(4) });
  noteQueueJobFinished(last);
  assert.equal(isQueueSuspect({ nowMs: t0 + 1_120_000 + SUSPECT_WINDOW_MS, progressNow: v100(4) }), false);
  resetQueueHealthForTests();
});

test("examen 28-10: el canario solo prueba la cola en clase, sin pedidos en curso y tras un rato sin respuestas", () => {
  resetQueueHealthForTests();
  const t0 = 5_000_000;
  assert.equal(shouldSendCanary({ nowMs: t0, aliveWorkers: 1 }), false, "sin pedidos reales no hay canario (fuera de clase)");
  const real = noteQueueJobSent({ nowMs: t0, progress: { w: { startedAt: null, jobs: 0 } } });
  assert.equal(shouldSendCanary({ nowMs: t0 + CANARY_QUIET_MS + 1, aliveWorkers: 1 }), false, "hay un pedido en curso");
  noteQueueResult(t0 + 2000);
  noteQueueJobFinished(real);
  assert.equal(shouldSendCanary({ nowMs: t0 + 60_000, aliveWorkers: 1 }), false, "respondio hace poco");
  assert.equal(shouldSendCanary({ nowMs: t0 + 2000 + CANARY_QUIET_MS, aliveWorkers: 0 }), false, "sin worker vivo no hay a quien probar");
  assert.equal(shouldSendCanary({ nowMs: t0 + 2000 + CANARY_QUIET_MS, aliveWorkers: 1 }), true);
  noteCanaryStart(t0 + 2000 + CANARY_QUIET_MS);
  assert.equal(shouldSendCanary({ nowMs: t0 + 2000 + CANARY_QUIET_MS + 1, aliveWorkers: 1 }), false, "uno a la vez");
  noteCanaryEnd(true);
  assert.equal(shouldSendCanary({ nowMs: t0 + CANARY_ACTIVE_WINDOW_MS + 1, aliveWorkers: 1 }), false, "media hora sin pedidos reales: la GPU puede apagarse");
  // Un canario no cuenta como pedido real ni como pedido en curso.
  const canary = noteQueueJobSent({ nowMs: t0 + 10, progress: null, canary: true });
  assert.equal(describeQueueHealth().queue_in_flight, 0);
  noteQueueJobFinished(canary);
  resetQueueHealthForTests();
});

test("examen 28-10: el worker reconecta tras un rato sin mensajes y no se queda colgado en receiveMessages", async () => {
  assert.equal(shouldRecycleIdleConnection({ lastActivityMs: 0, nowMs: 239_999, idleReconnectMs: 240_000 }), false);
  assert.equal(shouldRecycleIdleConnection({ lastActivityMs: 0, nowMs: 240_000, idleReconnectMs: 240_000 }), true);
  assert.equal(shouldRecycleIdleConnection({ lastActivityMs: 0, nowMs: 10_000_000, idleReconnectMs: 0 }), false, "0 = nunca");
  assert.equal(receiveDeadlineMs(5000), 5000 + RECEIVE_WATCHDOG_GRACE_MS);
  assert.equal(env.queueWorkerIdleReconnectMs, 240_000, "por defecto, 4 minutos");
  // El plazo no retiene el proceso (unref): la promesa «colgada» la sostiene un timer propio.
  const hung = new Promise((resolve) => setTimeout(resolve, 500));
  await assert.rejects(withDeadline(hung, 20, "colgado"), /colgado/);
  assert.equal(await withDeadline(Promise.resolve(7), 1000, "no"), 7);
});

test("examen 28-10: el tema del Sistema bancario se fija una vez para el docente de las cuentas nuevas", async () => {
  const preset = resolveExamPreset();
  assert.ok(preset);
  assert.equal(preset.topic.repoFullName, EXAM_PRESET_DEFAULT_REPO);
  assert.equal(preset.topic.week, 9);
  const database = await createDatabase();
  try {
    // En pruebas (pg-mem) el arranque no lo aplica; en produccion (postgres) si.
    assert.equal(await database.syncExamPreset(preset), null);
    const applied = await database.syncExamPreset(preset, { force: true });
    assert.equal(applied?.repoFullName, EXAM_PRESET_DEFAULT_REPO);
    const teacherId = String((await database.pool.query<{ setting_value: string }>(
      `select setting_value from app_settings where setting_key = $1`, [preset.settingKey],
    )).rows[0]?.setting_value || "");
    assert.ok(teacherId, "quedo la bandera con el docente");
    const topic = await database.getPilotTopic(teacherId);
    assert.equal(topic?.repoFullName, EXAM_PRESET_DEFAULT_REPO);
    assert.match(String(topic?.title), /Sistema bancario/);
    // El docente lo cambia y un nuevo arranque no lo pisa.
    await database.setPilotTopic(teacherId, { courseCode: "FPOO", week: 10, title: "Otro", repoFullName: "vbucheli/IMC" }, teacherId);
    assert.equal(await database.syncExamPreset(preset, { force: true }), null);
    assert.equal((await database.getPilotTopic(teacherId))?.repoFullName, "vbucheli/IMC");
    // Examen calificable: el bloque del piloto (una cohorte sin tutor) pasa a 0 una sola vez.
    const other = await database.createManagedUser({ role: "teacher", email: "docente.bloque@correounivalle.edu.co", displayName: "Docente Bloque", password: "Docente-12345" });
    await database.pool.query(`delete from app_settings where setting_key = $1`, [preset.blockSettingKey]);
    await database.setPilotBlock(teacherId, 1, teacherId);
    await database.setPilotBlock(other.id, 2, other.id);
    await database.syncExamPreset(preset, { force: true });
    assert.equal((await database.getPilotBlock(teacherId)).block, 0, "todos con tutor en el examen");
    assert.equal((await database.getPilotBlock(other.id)).block, 2, "otro docente no se toca");
    await database.setPilotBlock(teacherId, 2, teacherId);
    await database.syncExamPreset(preset, { force: true });
    assert.equal((await database.getPilotBlock(teacherId)).block, 2, "una sola vez: despues manda el docente");
    // EXAM_PRESET=off no hace nada.
    const previous = env.examPreset;
    env.examPreset = "off";
    try {
      assert.equal(resolveExamPreset(), null);
    } finally {
      env.examPreset = previous;
    }
  } finally {
    await database.close();
  }
});

import assert from "node:assert/strict";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  createEmptyMetrics,
  formatMetric,
  hasFlag,
  ratio,
  readArg,
  readDataset,
  updateMetrics,
} from "../../scripts/evaluate-document-classifier.js";

test("hasFlag y readArg leen argumentos inyectados", () => {
  const argv = ["node", "script", "--llm", "--dataset=data/custom.jsonl"];

  assert.equal(hasFlag("--llm", argv), true);
  assert.equal(hasFlag("--dry-run", argv), false);
  assert.equal(readArg("--dataset", "fallback.jsonl", argv), "data/custom.jsonl");
  assert.equal(readArg("--missing", "fallback.jsonl", argv), "fallback.jsonl");
});

test("readDataset parsea jsonl ignorando lineas vacias", async () => {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), "document-classifier-test-"));
  const datasetPath = path.join(dir, "dataset.jsonl");

  try {
    await fsp.writeFile(
      datasetPath,
      [
        JSON.stringify({ id: "bitacora", text: "Bitacora semanal", label: "BITACORA" }),
        "",
        JSON.stringify({ id: "guia", text: "Guia de laboratorio", label: "OTRO" }),
      ].join("\n"),
      "utf8",
    );

    const rows = await readDataset(datasetPath);

    assert.equal(rows.length, 2);
    assert.equal(rows[0].id, "bitacora");
    assert.equal(rows[0].label, "BITACORA");
    assert.equal(rows[1].id, "guia");
    assert.equal(rows[1].label, "OTRO");
  } finally {
    await fsp.rm(dir, { recursive: true, force: true });
  }
});

test("updateMetrics acumula matriz de confusion", () => {
  const metrics = createEmptyMetrics();

  updateMetrics(metrics, "BITACORA", "BITACORA");
  updateMetrics(metrics, "OTRO", "OTRO");
  updateMetrics(metrics, "OTRO", "BITACORA");
  updateMetrics(metrics, "BITACORA", "OTRO");

  assert.deepEqual(metrics, {
    total: 4,
    correct: 2,
    truePositive: 1,
    trueNegative: 1,
    falsePositive: 1,
    falseNegative: 1,
  });
});

test("ratio y formatMetric manejan ceros y redondeo", () => {
  assert.equal(ratio(3, 4), 0.75);
  assert.equal(ratio(3, 0), 0);
  assert.equal(formatMetric(2 / 3), "0.667");
});

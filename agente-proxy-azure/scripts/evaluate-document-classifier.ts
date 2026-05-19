import fsp from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  classifyDocument,
  extractBitacoraAgenda,
  type DocumentClassificationLabel,
} from "../src/services/document-classifier.js";

export type DatasetRow = {
  id?: string;
  fileName?: string;
  filePath?: string;
  text: string;
  label: DocumentClassificationLabel;
  expectedAgendaMin?: number;
  expectedAgendaDates?: string[];
};

export type Metrics = {
  total: number;
  correct: number;
  truePositive: number;
  trueNegative: number;
  falsePositive: number;
  falseNegative: number;
};

export function hasFlag(name: string, argv = process.argv) {
  return argv.some((item) => item === name);
}

export function readArg(name: string, fallback: string, argv = process.argv) {
  const prefix = `${name}=`;
  const found = argv.find((item) => item.startsWith(prefix));
  return found ? found.slice(prefix.length) : fallback;
}

export async function readDataset(filePath: string) {
  const raw = await fsp.readFile(filePath, "utf8");
  return raw
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => JSON.parse(line) as DatasetRow);
}

export function createEmptyMetrics(): Metrics {
  return {
    total: 0,
    correct: 0,
    truePositive: 0,
    trueNegative: 0,
    falsePositive: 0,
    falseNegative: 0,
  };
}

export function updateMetrics(
  metrics: Metrics,
  expected: DocumentClassificationLabel,
  predicted: DocumentClassificationLabel,
) {
  metrics.total += 1;
  if (expected === predicted) metrics.correct += 1;

  if (expected === "BITACORA" && predicted === "BITACORA") metrics.truePositive += 1;
  if (expected === "OTRO" && predicted === "OTRO") metrics.trueNegative += 1;
  if (expected === "OTRO" && predicted === "BITACORA") metrics.falsePositive += 1;
  if (expected === "BITACORA" && predicted === "OTRO") metrics.falseNegative += 1;
}

export function ratio(numerator: number, denominator: number) {
  return denominator > 0 ? numerator / denominator : 0;
}

export function formatMetric(value: number) {
  return value.toFixed(3);
}

export async function main(argv = process.argv) {
  const datasetPath = path.resolve(
    readArg("--dataset", "data/document-classifier/dataset.jsonl", argv),
  );
  const useModel = hasFlag("--llm", argv);
  const rows = await readDataset(datasetPath);
  const metrics = createEmptyMetrics();
  let agendaRows = 0;
  let agendaCorrect = 0;

  for (const row of rows) {
    const result = await classifyDocument({
      fileName: row.fileName,
      filePath: row.filePath,
      text: row.text,
      useModel,
    });
    const predicted = result.classification.label;
    updateMetrics(metrics, row.label, predicted);
    const agendaDates = Array.isArray(row.expectedAgendaDates) ? row.expectedAgendaDates : [];
    const agendaMin = Math.max(0, Number(row.expectedAgendaMin) || 0);
    let agendaMark = "";
    if (agendaMin > 0 || agendaDates.length > 0) {
      agendaRows += 1;
      const agenda = extractBitacoraAgenda(row.text);
      const foundDates = new Set(
        agenda.items
          .map((item) => item.dueAt?.slice(0, 10) || "")
          .filter(Boolean),
      );
      const minOk = agenda.items.length >= agendaMin;
      const datesOk = agendaDates.every((date) => foundDates.has(date));
      if (minOk && datesOk) agendaCorrect += 1;
      agendaMark = [
        `agenda=${minOk && datesOk ? "OK" : "FAIL"}`,
        `agendaItems=${agenda.items.length}`,
        agendaDates.length ? `expectedDates=${agendaDates.join(",")}` : "",
      ].filter(Boolean).join(" | ");
    }
    const mark = predicted === row.label ? "OK" : "FAIL";
    console.log([
      mark,
      row.id || row.fileName || "(sin id)",
      `expected=${row.label}`,
      `predicted=${predicted}`,
      `confidence=${result.classification.confidence}`,
      `method=${result.classification.method}`,
      agendaMark,
    ].filter(Boolean).join(" | "));
  }

  const accuracy = ratio(metrics.correct, metrics.total);
  const precision = ratio(metrics.truePositive, metrics.truePositive + metrics.falsePositive);
  const recall = ratio(metrics.truePositive, metrics.truePositive + metrics.falseNegative);
  const f1 = ratio(2 * precision * recall, precision + recall);

  console.log("");
  console.log("=== Document classifier metrics ===");
  console.log(`mode=${useModel ? "hybrid" : "rules"}`);
  console.log(`total=${metrics.total}`);
  console.log(`accuracy=${formatMetric(accuracy)}`);
  console.log(`precision=${formatMetric(precision)}`);
  console.log(`recall=${formatMetric(recall)}`);
  console.log(`f1=${formatMetric(f1)}`);
  console.log("confusion_matrix:");
  console.log(`  TP=${metrics.truePositive} FP=${metrics.falsePositive}`);
  console.log(`  FN=${metrics.falseNegative} TN=${metrics.trueNegative}`);
  if (agendaRows > 0) {
    console.log(`agenda_extraction=${agendaCorrect}/${agendaRows}`);
  }
}

const isDirectRun = process.argv[1]
  ? path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
  : false;

if (isDirectRun) {
  main().catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
}

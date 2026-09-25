import fsp from "node:fs/promises";
import path from "node:path";
import { parseCsvRecords } from "../src/services/csv.js";
import { formatValue } from "../src/services/kpis.js";
import { parsePilotPlan } from "../src/services/pilot-report.js";
import { fail, readArg } from "./lib/cli.js";
import { readTelemetryFile, runPilotAnalysis } from "./lib/piloto.js";

/**
 * Analisis de KPIs del piloto (A14.4) y trazabilidad (A14.7).
 *
 *   npm run piloto:analisis -- --dataset=exportes/piloto-2026-10-22 \
 *        [--encuesta=exportes/encuesta.csv] [--plan=data/piloto/plan-piloto.json] [--salida=<carpeta>]
 *
 * --dataset es la carpeta de npm run piloto:dataset (lee dataset.csv y, si
 * existe, quices.csv) o un archivo CSV/JSONL de telemetria. Escribe en
 * <dataset>/analisis (o --salida): informe-kpis.md, kpis.csv,
 * trazabilidad.csv, graficas/*.svg y respuestas-abiertas.csv.
 */

async function exists(filePath: string) {
  return fsp.stat(filePath).then(() => true).catch(() => false);
}

async function main() {
  const datasetArg = readArg("dataset");
  if (!datasetArg) fail("Falta --dataset (carpeta de piloto:dataset o archivo de telemetria).");
  const datasetPath = path.resolve(process.cwd(), datasetArg);
  const isDir = (await fsp.stat(datasetPath).catch(() => null))?.isDirectory() === true;
  const datasetFile = isDir ? path.join(datasetPath, "dataset.csv") : datasetPath;
  if (!(await exists(datasetFile))) fail(`No existe ${datasetFile}`);
  const rows = await readTelemetryFile(datasetFile);

  let quizzes: Array<{ correct: boolean | null }> | null = null;
  const quizFile = isDir ? path.join(datasetPath, "quices.csv") : "";
  if (quizFile && await exists(quizFile)) {
    quizzes = parseCsvRecords(await fsp.readFile(quizFile, "utf8")).map((record) => ({
      correct: record.correct === "true" ? true : record.correct === "false" ? false : null,
    }));
  }

  const surveyPath = readArg("encuesta");
  const surveyText = surveyPath ? await fsp.readFile(surveyPath, "utf8") : null;
  const planPath = readArg("plan");
  const plan = planPath ? parsePilotPlan(await fsp.readFile(planPath, "utf8")) : null;
  const outDir = path.resolve(process.cwd(), readArg("salida", isDir ? path.join(datasetArg, "analisis") : `${datasetArg.replace(/\.[a-z]+$/i, "")}-analisis`));

  const analysis = await runPilotAnalysis({
    rows,
    surveyText,
    plan,
    quizzes,
    outDir,
    datasetDescription: `${rows.length} eventos de ${path.relative(process.cwd(), datasetFile)}`,
  });
  for (const warning of analysis.surveyWarnings) console.warn(`[analisis] Encuesta: ${warning}`);
  for (const kpi of analysis.kpis) {
    const status = kpi.meets === null ? "   " : kpi.meets ? "ok " : "NO ";
    console.log(`[analisis] ${status} ${kpi.id.padEnd(3)} ${kpi.name}: ${formatValue(kpi.value, kpi.unit)}`);
  }
  for (const file of analysis.files) console.log(`[analisis] ${path.relative(process.cwd(), file)}`);
}

main().catch((error) => {
  console.error("[analisis] Fallo:", error);
  process.exitCode = 1;
});

import fsp from "node:fs/promises";
import path from "node:path";
import { parseCsvRecords } from "../src/services/csv.js";
import { formatValue, renderManualTemplates, type ManualRecordFile } from "../src/services/kpis.js";
import { parsePilotPlan } from "../src/services/pilot-report.js";
import { fail, hasFlag, readArg, writeTextFile } from "./lib/cli.js";
import { readManualRecordFiles, readTelemetryFile, runPilotAnalysis } from "./lib/piloto.js";

/**
 * Analisis de KPIs del piloto (A14.4) y trazabilidad (A14.7).
 *
 *   npm run piloto:analisis -- --dataset=exportes/piloto-2026-10-22 \
 *        [--encuesta=exportes/encuesta.csv] [--plan=data/piloto/plan-piloto.json] \
 *        [--registros=exportes/registros-piloto] [--salida=<carpeta>]
 *   npm run piloto:analisis -- --escribir-plantillas     # regenera data/piloto/plantillas/ (T7, T8, T10, T11, P5)
 *
 * --dataset es la carpeta de npm run piloto:dataset (lee dataset.csv y, si
 * existe, quices.csv) o un archivo CSV/JSONL de telemetria. --registros es la
 * carpeta con las copias llenas de las plantillas de data/piloto/plantillas/
 * (registro-incidentes-*.csv, pruebas-humo*.csv o demo-escenarios*.md,
 * tiempos-instalacion*.csv o prueba-inicio-a-fin*.csv, cumplimiento*.csv y
 * hallazgos*.csv): de ahi salen T7, T8, T10, T11 y P5 sin transcribirlos al
 * plan. Escribe en <dataset>/analisis (o --salida): informe-kpis.md,
 * kpis.csv, trazabilidad.csv, registros-manuales.csv, graficas/*.svg y
 * respuestas-abiertas.csv.
 */

const TEMPLATES_DIR = "data/piloto/plantillas";

async function exists(filePath: string) {
  return fsp.stat(filePath).then(() => true).catch(() => false);
}

async function main() {
  if (hasFlag("escribir-plantillas")) {
    for (const template of renderManualTemplates()) {
      const written = await writeTextFile(path.join(TEMPLATES_DIR, template.file), template.text);
      console.log(`[analisis] Plantilla ${path.relative(process.cwd(), written)}`);
    }
    return;
  }
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
  const recordsArg = readArg("registros");
  let records: ManualRecordFile[] | null = null;
  if (recordsArg) {
    const recordsDir = path.resolve(process.cwd(), recordsArg);
    if (!(await fsp.stat(recordsDir).catch(() => null))?.isDirectory()) fail(`--registros debe ser una carpeta: ${recordsArg}`);
    if (recordsDir === path.resolve(process.cwd(), TEMPLATES_DIR)) {
      console.warn(`[analisis] Aviso: ${TEMPLATES_DIR} tiene las plantillas vacías del repositorio. Copia las hojas a una carpeta solo para ellas fuera del repositorio (por ejemplo exportes/registros-piloto/), llénalas y pasa esa carpeta.`);
    }
    records = await readManualRecordFiles(recordsDir);
    for (const file of records.filter((item) => item.encoding === "windows-1252")) {
      console.warn(`[analisis] ${file.name} no está en UTF-8: se leyó como Windows-1252. La próxima vez guárdala como «CSV UTF-8».`);
    }
  }

  const analysis = await runPilotAnalysis({
    rows,
    surveyText,
    plan,
    quizzes,
    outDir,
    datasetDescription: `${rows.length} eventos de ${path.relative(process.cwd(), datasetFile)}`,
    records,
  });
  for (const warning of analysis.surveyWarnings) console.warn(`[analisis] Encuesta: ${warning}`);
  if (analysis.records) {
    const count = (estado: string) => analysis.records?.rows.filter((row) => row.estado === estado).length || 0;
    console.log(`[analisis] Registros: ${count("usada")} filas usadas, ${count("descartada")} descartadas y ${count("ignorada")} ignoradas (detalle en registros-manuales.csv).`);
    for (const row of analysis.records.rows.filter((item) => item.estado === "descartada")) {
      console.warn(`[analisis] Descartada ${row.kpi || "—"} ${row.archivo}${row.fila ? ` fila ${row.fila}` : ""}: ${row.motivo}`);
    }
    // Hojas enteras que no entraron (por ejemplo, otra copia de cumplimiento*.csv): que no pasen desapercibidas.
    for (const row of analysis.records.rows.filter((item) => item.kpi && item.fila === null && item.estado === "ignorada")) {
      console.warn(`[analisis] Ignorada ${row.kpi} ${row.archivo}: ${row.motivo}`);
    }
    for (const file of analysis.records.unrecognized) console.warn(`[analisis] No es una plantilla (no se leyó): ${file}`);
  }
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

import fsp from "node:fs/promises";
import path from "node:path";
import { parseCsvRecords, toCsvText } from "../../src/services/csv.js";
import { computeKpis, formatValue, unblockingDetail, type KpiResult } from "../../src/services/kpis.js";
import { cleanPilotDataset, renderCleaningReport, type PilotDatasetResult } from "../../src/services/pilot-dataset.js";
import {
  buildPilotCharts,
  buildTraceability,
  manualValuesFromPlan,
  renderPilotReport,
  type PilotPlan,
} from "../../src/services/pilot-report.js";
import { parseSurvey, type SurveyResponse } from "../../src/services/survey.js";
import { EXPORT_COLUMNS, fromExportRecord, toExportRecord, type TelemetryEventRow } from "../../src/services/telemetry.js";
import { FIELD_DICTIONARY } from "../../src/services/telemetry-catalog.js";

/**
 * Pasos comunes del analisis del piloto (A14.3, A14.4, A14.7) para
 * piloto:dataset, piloto:analisis y el ensayo tecnico (piloto:simular).
 */

export async function writeFileEnsured(filePath: string, content: string) {
  await fsp.mkdir(path.dirname(filePath), { recursive: true });
  await fsp.writeFile(filePath, content, "utf8");
  return filePath;
}

/** Lee una exportacion de telemetria (CSV o JSONL de telemetria:exportar o dataset.csv). */
export async function readTelemetryFile(filePath: string): Promise<TelemetryEventRow[]> {
  const text = await fsp.readFile(filePath, "utf8");
  if (/\.jsonl?$/i.test(filePath)) {
    return text.split(/\r?\n/).filter((line) => line.trim()).map((line) => fromExportRecord(JSON.parse(line)));
  }
  return parseCsvRecords(text).map((record) => fromExportRecord(record));
}

const DATASET_COLUMNS = [...EXPORT_COLUMNS, "limpieza_marcas"];
const EXCLUDED_COLUMNS = [...EXPORT_COLUMNS, "regla"];

export function renderDatasetCodebook() {
  const lines = [
    "# Diccionario del dataset del piloto",
    "",
    "Columnas de `dataset.csv` (una fila por evento). Son las del diccionario de telemetría (`docs/telemetria/diccionario-eventos.md`) más la marca de limpieza.",
    "",
    "| Columna | Tipo | Descripción | Sensibilidad |",
    "|---|---|---|---|",
    ...FIELD_DICTIONARY.map((entry) => `| ${entry.field} | ${entry.type} | ${entry.description.replace(/\|/g, "\\|")} | ${entry.sensitivity} |`),
    "| limpieza_marcas | text | Marcas de la limpieza separadas por «;» (M1_fecha_corregida, M2_decision_huerfana, M3_orden_invalido). | ninguna |",
    "",
    "`excluidos.csv` tiene las mismas columnas del diccionario más `regla` (D1 a D5, ver `limpieza.md`).",
    "",
  ];
  return lines.join("\n");
}

export async function writePilotDataset(input: {
  rows: TelemetryEventRow[];
  testActors: string[];
  outDir: string;
  source: string;
  window: string;
  quizzes?: Array<Record<string, unknown>> | null;
  quizColumns?: readonly string[];
  blockLog?: Array<Record<string, unknown>> | null;
}) {
  const result = cleanPilotDataset({ rows: input.rows, testActors: input.testActors });
  const generatedAt = new Date().toISOString();
  const files: string[] = [];
  files.push(await writeFileEnsured(path.join(input.outDir, "dataset.csv"), toCsvText(DATASET_COLUMNS, result.kept.map((row) => ({
    ...toExportRecord(row),
    limpieza_marcas: row.cleaningMarks.join(";"),
  })))));
  files.push(await writeFileEnsured(path.join(input.outDir, "excluidos.csv"), toCsvText(EXCLUDED_COLUMNS, result.excluded.map((item) => ({
    ...toExportRecord(item.row),
    regla: item.rule,
  })))));
  files.push(await writeFileEnsured(path.join(input.outDir, "limpieza.md"), renderCleaningReport(result, { window: input.window, generatedAt, source: input.source })));
  files.push(await writeFileEnsured(path.join(input.outDir, "diccionario-dataset.md"), renderDatasetCodebook()));
  if (input.quizzes && input.quizColumns) {
    const actors = new Set(result.kept.map((row) => row.actorAnonId));
    const quizzes = input.quizzes.filter((quiz) => actors.has(String(quiz.actor_anon_id || "")));
    files.push(await writeFileEnsured(path.join(input.outDir, "quices.csv"), toCsvText([...input.quizColumns], quizzes)));
  }
  if (input.blockLog) {
    files.push(await writeFileEnsured(path.join(input.outDir, "bloques.csv"), toCsvText(["teacher_anon_id", "block", "changed_at"], input.blockLog)));
  }
  return { result, files };
}

export function surveyOpenAnswersCsv(responses: SurveyResponse[]) {
  return toCsvText(
    ["respuesta", "CMP1", "CMP2", "AB1", "AB2", "AB3"],
    responses.map((response, index) => ({
      respuesta: index + 1,
      CMP1: response.cmp[0] || "",
      CMP2: response.cmp[1] || "",
      AB1: response.open[0] || "",
      AB2: response.open[1] || "",
      AB3: response.open[2] || "",
    })),
  );
}

export function kpisCsv(kpis: KpiResult[]) {
  return toCsvText(
    ["id", "kpi", "dimension", "valor", "unidad", "valor_texto", "n", "umbral", "cumple", "lectura"],
    kpis.map((kpi) => ({
      id: kpi.id,
      kpi: kpi.name,
      dimension: kpi.dimension,
      valor: kpi.value ?? "",
      unidad: kpi.unit,
      valor_texto: formatValue(kpi.value, kpi.unit),
      n: kpi.n ?? "",
      umbral: kpi.thresholdText,
      cumple: kpi.meets === null ? "" : kpi.meets ? "si" : "no",
      lectura: kpi.summary,
    })),
  );
}

export async function runPilotAnalysis(input: {
  rows: TelemetryEventRow[];
  surveyText?: string | null;
  plan?: PilotPlan | null;
  quizzes?: Array<{ correct: boolean | null }> | null;
  outDir: string;
  datasetDescription: string;
  cleaning?: PilotDatasetResult["report"] | null;
  synthetic?: boolean;
}) {
  const parsedSurvey = input.surveyText ? parseSurvey(input.surveyText) : null;
  const survey = parsedSurvey?.responses || null;
  const plan = input.plan || null;
  const kpis = computeKpis({
    rows: input.rows,
    survey,
    attendance: plan?.sesiones?.map((session) => ({ fecha: session.fecha, presentes: session.presentes })) || null,
    participants: plan?.participantesConConsentimiento ?? null,
    quizzes: input.quizzes || null,
    manual: manualValuesFromPlan(plan),
    timeZone: plan?.zonaHoraria || "America/Bogota",
  });
  const detail = unblockingDetail(input.rows);
  const charts = buildPilotCharts({ rows: input.rows, kpis, comparison: detail.comparison, episodes: detail.episodes, survey });
  const files: string[] = [];
  for (const chart of charts) {
    files.push(await writeFileEnsured(path.join(input.outDir, "graficas", chart.file), chart.svg));
  }
  const report = renderPilotReport({
    plan,
    kpis,
    comparison: detail.comparison,
    charts,
    generatedAt: new Date().toISOString(),
    datasetDescription: input.datasetDescription,
    surveyDescription: parsedSurvey
      ? `${parsedSurvey.responses.length} respuestas; columnas reconocidas: ${parsedSurvey.recognized.length}${parsedSurvey.warnings.length ? `; avisos: ${parsedSurvey.warnings.join(" ")}` : ""}`
      : "Sin encuesta (los KPIs U1, U2, U5 y P4 quedan pendientes).",
    cleaning: input.cleaning || null,
    synthetic: input.synthetic,
  });
  files.push(await writeFileEnsured(path.join(input.outDir, "informe-kpis.md"), report));
  files.push(await writeFileEnsured(path.join(input.outDir, "kpis.csv"), kpisCsv(kpis)));
  const traceability = buildTraceability(kpis, charts);
  files.push(await writeFileEnsured(path.join(input.outDir, "trazabilidad.csv"), toCsvText(
    ["kpi", "nombre", "objetivo", "umbral", "valor", "cumple", "evidencia", "hallazgo", "accion"],
    traceability,
  )));
  if (survey) {
    files.push(await writeFileEnsured(path.join(input.outDir, "respuestas-abiertas.csv"), surveyOpenAnswersCsv(survey)));
  }
  return { kpis, charts, files, detail, surveyWarnings: parsedSurvey?.warnings || [] };
}

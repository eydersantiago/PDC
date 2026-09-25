import fsp from "node:fs/promises";
import path from "node:path";
import { parseCsvRecords, toCsvText } from "../../src/services/csv.js";
import { findKpi } from "../../src/services/kpi-catalog.js";
import {
  computeKpis,
  formatValue,
  MANUAL_KPI_IDS,
  MANUAL_TEMPLATES,
  manualRecordsCsv,
  readManualRecords,
  unblockingDetail,
  type KpiResult,
  type ManualRecordFile,
  type ManualRecordsResult,
} from "../../src/services/kpis.js";
import { cleanPilotDataset, renderCleaningReport, type PilotDatasetResult } from "../../src/services/pilot-dataset.js";
import {
  buildPilotCharts,
  buildTraceability,
  manualValuesFromPlan,
  renderPilotReport,
  type PilotPlan,
  type TraceabilityRow,
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

/**
 * Texto de una hoja: UTF-8 y, si no lo es (Excel guarda «CSV (delimitado por
 * comas)» en Windows-1252 y «Sí» llega como «S�»), otra vez como Windows-1252.
 */
export function decodeRecordText(buffer: Buffer): Pick<ManualRecordFile, "text" | "encoding"> {
  const text = buffer.toString("utf8");
  if (!text.includes("\uFFFD")) return { text, encoding: "utf-8" };
  return { text: new TextDecoder("windows-1252").decode(buffer), encoding: "windows-1252" };
}

/**
 * Copias llenas de las plantillas de data/piloto/plantillas/ (--registros):
 * los .csv y .md de la carpeta, sin subcarpetas. Cuales se reconocen lo
 * decide readManualRecords por el nombre.
 */
export async function readManualRecordFiles(dir: string): Promise<ManualRecordFile[]> {
  const entries = await fsp.readdir(dir, { withFileTypes: true });
  const files: ManualRecordFile[] = [];
  for (const entry of entries.filter((item) => item.isFile() && /\.(csv|md)$/i.test(item.name)).sort((a, b) => a.name.localeCompare(b.name))) {
    files.push({ name: entry.name, ...decodeRecordText(await fsp.readFile(path.join(dir, entry.name))) });
  }
  return files;
}

function oneLine(value: string) {
  return value.replace(/\s+/g, " ").trim();
}

/**
 * Trazabilidad (A14.7) con los registros: los KPIs manuales citan la
 * plantilla de la que salen, y hallazgos*.csv llena hallazgo y accion de los
 * KPIs que toca cada hallazgo.
 */
function traceabilityWithRecords(rows: TraceabilityRow[], kpis: KpiResult[], records: ManualRecordsResult | null): TraceabilityRow[] {
  const byId = new Map(kpis.map((kpi) => [kpi.id, kpi]));
  return rows.map((row) => {
    const result = byId.get(row.kpi);
    const origin = (result?.details as { origen?: string; archivos?: string[] } | undefined);
    let evidencia = row.evidencia;
    if (origin?.origen === "plantilla" && origin.archivos?.length) {
      evidencia = evidencia.replace("registro en el plan del piloto", `${origin.archivos.join("; ")}; registros-manuales.csv`);
    }
    const findings = (records?.findings || []).filter((finding) => finding.kpis.includes(row.kpi));
    const hallazgo = findings.map((finding) => oneLine(`${finding.id}: ${finding.hallazgo}`)).join(" | ");
    const accion = findings.filter((finding) => finding.accion).map((finding) => oneLine(`${finding.id}: ${finding.accion} (${finding.estado})`)).join(" | ");
    return { ...row, evidencia, hallazgo: hallazgo || row.hallazgo, accion: accion || row.accion };
  });
}

/** Sección del informe con el origen de cada KPI manual (plantilla, plan o sin dato). */
export function renderManualOriginSection(kpis: KpiResult[], records: ManualRecordsResult | null) {
  const byId = new Map(kpis.map((kpi) => [kpi.id, kpi]));
  const lines = [
    "## 9. Origen de los KPIs manuales",
    "",
    records
      ? "Los KPIs manuales salen de las copias llenas de las plantillas de `data/piloto/plantillas/` (`--registros`); si una plantilla no da valor, del plan del piloto. `registros-manuales.csv` dice qué pasó con cada fila leída (usada, descartada o ignorada, con el motivo)."
      : "No se pasaron plantillas llenas (`--registros`): los KPIs manuales salen del plan del piloto.",
    "",
    "| KPI | Valor | Origen | Archivos | Filas usadas | Filas descartadas |",
    "|---|---|---|---|---|---|",
  ];
  for (const id of MANUAL_KPI_IDS) {
    const result = byId.get(id);
    const details = (result?.details || {}) as { origen?: string; archivos?: string[]; filasUsadas?: number; filasDescartadas?: number };
    const origin = details.origen || (result?.value === null ? "sin dato" : "plan");
    const template = MANUAL_TEMPLATES.find((item) => item.kpi === id);
    lines.push(`| ${id}. ${findKpi(id).name} | ${formatValue(result?.value ?? null, result?.unit || "")} | ${origin} | ${details.archivos?.length ? details.archivos.map((file) => `\`${file}\``).join(", ") : `plantilla \`${template?.file}\``} | ${details.filasUsadas ?? "—"} | ${details.filasDescartadas ?? "—"} |`);
  }
  lines.push("");
  const discarded = (records?.rows || []).filter((row) => row.estado === "descartada");
  if (discarded.length) {
    lines.push("Filas descartadas (corrígelas en la hoja y vuelve a correr el análisis):", "");
    for (const row of discarded.slice(0, 20)) {
      lines.push(`- ${row.kpi || "—"} · \`${row.archivo}\`${row.fila ? `, fila ${row.fila}` : ""}: ${row.motivo}.`);
    }
    if (discarded.length > 20) lines.push(`- … y ${discarded.length - 20} más en \`registros-manuales.csv\`.`);
    lines.push("");
  }
  const ignoredFiles = (records?.rows || []).filter((row) => row.kpi && row.fila === null && row.estado === "ignorada");
  if (ignoredFiles.length) {
    lines.push("Hojas ignoradas enteras (revisa que no sea la que querías usar):", "");
    for (const row of ignoredFiles) lines.push(`- ${row.kpi} · \`${row.archivo}\`: ${row.motivo}.`);
    lines.push("");
  }
  if (records?.unrecognized.length) {
    lines.push(`Archivos de la carpeta que no son plantillas (no se leyeron): ${records.unrecognized.map((file) => `\`${file}\``).join(", ")}.`, "");
  }
  return lines.join("\n");
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
  /** Copias llenas de las plantillas (readManualRecordFiles); null: los manuales salen del plan. */
  records?: ManualRecordFile[] | null;
}) {
  const parsedSurvey = input.surveyText ? parseSurvey(input.surveyText) : null;
  const survey = parsedSurvey?.responses || null;
  const plan = input.plan || null;
  const records = input.records
    ? readManualRecords(input.records, {
      sessionDates: plan?.sesiones?.map((session) => session.fecha) || [],
      timeZone: plan?.zonaHoraria || "America/Bogota",
    })
    : null;
  const kpis = computeKpis({
    rows: input.rows,
    survey,
    attendance: plan?.sesiones?.map((session) => ({ fecha: session.fecha, presentes: session.presentes })) || null,
    participants: plan?.participantesConConsentimiento ?? null,
    quizzes: input.quizzes || null,
    manual: manualValuesFromPlan(plan),
    manualSources: records?.sources || null,
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
  files.push(await writeFileEnsured(path.join(input.outDir, "informe-kpis.md"), `${report.replace(/\n+$/, "")}\n\n${renderManualOriginSection(kpis, records)}`));
  files.push(await writeFileEnsured(path.join(input.outDir, "kpis.csv"), kpisCsv(kpis)));
  if (records) files.push(await writeFileEnsured(path.join(input.outDir, "registros-manuales.csv"), manualRecordsCsv(records.rows)));
  const traceability = traceabilityWithRecords(buildTraceability(kpis, charts), kpis, records);
  files.push(await writeFileEnsured(path.join(input.outDir, "trazabilidad.csv"), toCsvText(
    ["kpi", "nombre", "objetivo", "umbral", "valor", "cumple", "evidencia", "hallazgo", "accion"],
    traceability,
  )));
  if (survey) {
    files.push(await writeFileEnsured(path.join(input.outDir, "respuestas-abiertas.csv"), surveyOpenAnswersCsv(survey)));
  }
  return { kpis, charts, files, detail, records, surveyWarnings: parsedSurvey?.warnings || [] };
}

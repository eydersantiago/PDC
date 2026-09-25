import { COMPLIANCE_ITEMS } from "./compliance-checklist.js";
import { parseCsv, toCsvText } from "./csv.js";
import { EVENT_CATALOG } from "./telemetry-catalog.js";
import { KPI_CATALOG, findKpi, meetsThreshold, type KpiDefinition, type KpiDimension } from "./kpi-catalog.js";
import { mannWhitneyU, median, percentile, round, wilcoxonSignedRank, type WilcoxonResult } from "./stats.js";
import { personMean, susScore, type SurveyResponse } from "./survey.js";
import { analyzeTelemetryDataset, type TelemetryEventRow } from "./telemetry.js";
import { describeWorker } from "./worker-identity.js";

/**
 * Calculo de los KPIs del piloto (A3.3, A14.4) con las definiciones de
 * src/services/kpi-catalog.ts. Lo usan el endpoint GET /api/telemetry/kpis
 * (en vivo, solo telemetria), npm run piloto:analisis (informe final con
 * encuesta, asistencia y registros) y el ensayo tecnico simulado.
 *
 * Cada resultado trae una frase de lectura automatica: dice el valor, el n y
 * si cumple el umbral. La interpretacion pedagogica la escribe el autor.
 *
 * Los KPIs manuales (T7, T8, T10, T11 y P5) salen de las plantillas CSV de
 * data/piloto/plantillas/ llenas (readManualRecords, al final del archivo) o,
 * si no las hay, del bloque "registros" del plan del piloto.
 */

export const MANUAL_KPI_IDS = ["T7", "T8", "T10", "T11", "P5"] as const;
export type ManualKpiId = typeof MANUAL_KPI_IDS[number];
export type KpiManualValues = Partial<Record<ManualKpiId, number | null>>;

export type KpiContext = {
  rows: TelemetryEventRow[];
  survey?: SurveyResponse[] | null;
  /** Presentes por fecha (AAAA-MM-DD, hora de Colombia). */
  attendance?: Array<{ fecha: string; presentes: number }> | null;
  /** Estudiantes que firmaron el consentimiento. */
  participants?: number | null;
  quizzes?: Array<{ correct: boolean | null }> | null;
  manual?: KpiManualValues | null;
  /** KPIs manuales leidos de las plantillas (readManualRecords): ganan sobre el plan. */
  manualSources?: Partial<Record<ManualKpiId, ManualKpiSource>> | null;
  timeZone?: string;
};

export type KpiResult = {
  id: string;
  name: string;
  dimension: KpiDimension;
  unit: string;
  value: number | null;
  n: number | null;
  meets: boolean | null;
  thresholdText: string;
  /** Lectura automatica en una o dos frases. */
  summary: string;
  details?: Record<string, unknown>;
};

const NON_MODEL_SOURCES = new Set(["cache", "deterministic", "policy"]);
const FALLBACK_SOURCES = new Set(["degraded", "heuristic"]);
const COURSE_EVENTS = new Set(["compile_error", "runtime_error", "concept_question", "design_block", "code_suggestion"]);

// --- Formato en espanol -------------------------------------------------------

export function formatNumber(value: number | null | undefined, digits = 1, minimumDigits = 0) {
  if (value === null || value === undefined || !Number.isFinite(value)) return "sin dato";
  // Primero a 3 decimales, como el valor que se guarda: la lectura y la tabla muestran lo mismo.
  const stored = Math.round(value * 1000) / 1000;
  return new Intl.NumberFormat("es-CO", { maximumFractionDigits: digits, minimumFractionDigits: Math.min(digits, minimumDigits) }).format(stored);
}

export function formatValue(value: number | null | undefined, unit: string) {
  if (value === null || value === undefined || !Number.isFinite(value)) return "sin dato";
  if (unit === "%") return `${formatNumber(value, 1)} %`;
  if (unit === "/5") return `${formatNumber(value, 2, 2)} / 5`;
  if (unit === "s") return `${formatNumber(value, 1)} s`;
  if (unit === "min") return `${formatNumber(value, 1)} min`;
  return `${formatNumber(value, 1)} ${unit}`.trim();
}

function formatP(p: number | null) {
  if (p === null) return "sin dato";
  if (p < 0.001) return "< 0,001";
  return formatNumber(p, 3);
}

function verdict(kpi: KpiDefinition, value: number | null) {
  const meets = meetsThreshold(kpi, value);
  if (meets === null) return kpi.threshold ? "" : " KPI descriptivo, sin umbral.";
  return meets ? ` Cumple el umbral (${kpi.thresholdText}).` : ` No cumple el umbral (${kpi.thresholdText}).`;
}

function result(id: string, value: number | null, n: number | null, summary: string, details?: Record<string, unknown>): KpiResult {
  const kpi = findKpi(id);
  const rounded = round(value, 3);
  return {
    id,
    name: kpi.name,
    dimension: kpi.dimension,
    unit: kpi.unit,
    value: rounded,
    n,
    meets: meetsThreshold(kpi, rounded),
    thresholdText: kpi.thresholdText,
    summary: value === null ? summary : `${summary}${verdict(kpi, rounded)}`,
    ...(details ? { details } : {}),
  };
}

// --- Seleccion de filas -------------------------------------------------------

function metadataValue(row: TelemetryEventRow, key: string) {
  return (row.metadata || {})[key];
}

function isModelDecision(row: TelemetryEventRow) {
  if (row.eventType !== "tutor_decision" || row.blocked !== false) return false;
  if (row.reasonCode === "pilot_no_tutor") return false;
  if (metadataValue(row, "cached") === true) return false;
  return !NON_MODEL_SOURCES.has(String(metadataValue(row, "source") || ""));
}

/** Decisiones que llegaron al modelo y respondio (para latencia). */
export function latencyRows(rows: TelemetryEventRow[]) {
  return rows.filter((row) => isModelDecision(row)
    && row.reasonCode !== "model_error_fallback"
    && !FALLBACK_SOURCES.has(String(metadataValue(row, "source") || ""))
    && row.latencyMs !== null);
}

function dayKey(iso: string, timeZone: string) {
  return new Intl.DateTimeFormat("en-CA", { timeZone, year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date(iso));
}

// --- Episodios de bloqueo (P1, P2) --------------------------------------------

export type UnblockingEpisode = {
  actor: string;
  cohort: string;
  condition: string;
  block: number | null;
  detectedAt: string | null;
  resolvedAt: string | null;
  durationMs: number | null;
  resolved: boolean;
  resolvedWhileAway: boolean;
  /** Empezo en un bloque y termino en otro: no entra en P1. */
  crossesBlock: boolean;
  /** Se cerro sin su blocking_detected (perdido o fuera de la ventana). */
  withoutDetection: boolean;
};

/** Holgura para emparejar la deteccion con la aparicion del error (mismo reloj del cliente). */
const PAIRING_TOLERANCE_MS = 15_000;

/**
 * Empareja cada blocking_resolved con su blocking_detected: mismo
 * estudiante, sesion de VS Code, error (hash normalizado) y ejercicio, y una
 * deteccion posterior a la aparicion del error (resolvedAt - durationMs). Si
 * hay varias abiertas gana la mas reciente: una deteccion vieja sin cierre
 * (evento perdido, archivo abandonado) no se pega al episodio siguiente del
 * mismo error. La condicion es la del inicio del episodio.
 */
export function extractUnblockingEpisodes(rows: TelemetryEventRow[]): UnblockingEpisode[] {
  const relevant = rows
    .filter((row) => row.source === "vscode_extension" && (row.eventType === "blocking_detected" || row.eventType === "blocking_resolved"))
    .sort((a, b) => Date.parse(a.occurredAt) - Date.parse(b.occurredAt) || (a.seq ?? 0) - (b.seq ?? 0));
  const open = new Map<string, UnblockingEpisode[]>();
  const episodes: UnblockingEpisode[] = [];
  for (const row of relevant) {
    const key = [row.actorAnonId, row.clientSessionId, row.errorHash, row.exerciseHash].join("|");
    if (row.eventType === "blocking_detected") {
      const episode: UnblockingEpisode = {
        actor: row.actorAnonId,
        cohort: row.pilotCohort,
        condition: row.pilotCondition,
        block: row.pilotBlock,
        detectedAt: row.occurredAt,
        resolvedAt: null,
        durationMs: null,
        resolved: false,
        resolvedWhileAway: false,
        crossesBlock: false,
        withoutDetection: false,
      };
      const list = open.get(key) || [];
      list.push(episode);
      open.set(key, list);
      episodes.push(episode);
      continue;
    }
    const list = open.get(key) || [];
    const resolvedAtMs = Date.parse(row.occurredAt);
    const firstSeenMs = row.durationMs !== null ? resolvedAtMs - row.durationMs : Number.NEGATIVE_INFINITY;
    let chosen = -1;
    for (let index = list.length - 1; index >= 0; index -= 1) {
      const detectedAtMs = Date.parse(list[index].detectedAt as string);
      if (detectedAtMs <= resolvedAtMs + PAIRING_TOLERANCE_MS && detectedAtMs >= firstSeenMs - PAIRING_TOLERANCE_MS) {
        chosen = index;
        break;
      }
    }
    const episode = chosen >= 0 ? list.splice(chosen, 1)[0] : undefined;
    if (list.length === 0) open.delete(key);
    const durationMs = row.durationMs;
    const away = metadataValue(row, "resolvedWhileAway") === true;
    if (episode) {
      episode.resolved = true;
      episode.resolvedAt = row.occurredAt;
      episode.durationMs = durationMs;
      episode.resolvedWhileAway = away;
      episode.crossesBlock = (episode.block ?? null) !== (row.pilotBlock ?? null);
    } else {
      episodes.push({
        actor: row.actorAnonId,
        cohort: row.pilotCohort,
        condition: row.pilotCondition,
        block: row.pilotBlock,
        detectedAt: null,
        resolvedAt: row.occurredAt,
        durationMs,
        resolved: true,
        resolvedWhileAway: away,
        crossesBlock: false,
        withoutDetection: true,
      });
    }
  }
  return episodes;
}

export type UnblockingComparison = {
  pairedStudents: number;
  medianWithTutorS: number | null;
  medianWithoutTutorS: number | null;
  reductionPct: number | null;
  wilcoxon: WilcoxonResult;
  perStudent: Array<{ actor: string; cohort: string; withTutorS: number; withoutTutorS: number }>;
};

/** P1: medianas por estudiante en cada condicion, pareadas. */
export function compareUnblocking(episodes: UnblockingEpisode[], options: { excludeAway?: boolean; cohort?: string } = {}): UnblockingComparison {
  const byActor = new Map<string, { cohort: string; con: number[]; sin: number[] }>();
  for (const episode of episodes) {
    if (!episode.resolved || episode.crossesBlock || episode.durationMs === null) continue;
    if (options.excludeAway && episode.resolvedWhileAway) continue;
    if (episode.condition !== "con_tutor" && episode.condition !== "sin_tutor") continue;
    if (options.cohort && episode.cohort !== options.cohort) continue;
    const entry = byActor.get(episode.actor) || { cohort: episode.cohort, con: [], sin: [] };
    (episode.condition === "con_tutor" ? entry.con : entry.sin).push(episode.durationMs / 1000);
    byActor.set(episode.actor, entry);
  }
  const perStudent = [...byActor.entries()]
    .filter(([, entry]) => entry.con.length && entry.sin.length)
    .map(([actor, entry]) => ({
      actor,
      cohort: entry.cohort,
      withTutorS: median(entry.con) as number,
      withoutTutorS: median(entry.sin) as number,
    }));
  const withTutor = median(perStudent.map((item) => item.withTutorS));
  const withoutTutor = median(perStudent.map((item) => item.withoutTutorS));
  const reduction = withTutor !== null && withoutTutor !== null && withoutTutor > 0
    ? (1 - withTutor / withoutTutor) * 100
    : null;
  return {
    pairedStudents: perStudent.length,
    medianWithTutorS: withTutor,
    medianWithoutTutorS: withoutTutor,
    reductionPct: reduction,
    wilcoxon: wilcoxonSignedRank(perStudent.map((item) => [item.withTutorS, item.withoutTutorS])),
    perStudent,
  };
}

export type CrossoverAnalysis = {
  studentsA: number;
  studentsB: number;
  /** Efecto del tutor (con - sin) en segundos: negativo = menos tiempo con tutor. */
  treatmentEffectS: number | null;
  pTreatment: number | null;
  /** Efecto de periodo (bloque 1 - bloque 2) en segundos. */
  periodEffectS: number | null;
  pPeriod: number | null;
  method: string;
};

/**
 * Analisis clasico del cruzado AB/BA (Hills y Armitage): por estudiante,
 * d = mediana del bloque 1 - mediana del bloque 2. Para la cohorte A
 * d = (con - sin) + periodo y para la B d = (sin - con) + periodo, asi que el
 * efecto del tutor es (d_A - d_B) / 2 y se prueba con Mann-Whitney entre
 * cohortes; el de periodo es (d_A + d_B) / 2 (d_A contra -d_B). Complementa
 * la prueba pareada de P1 cuando hay efecto de orden.
 */
export function crossoverAnalysis(episodes: UnblockingEpisode[]): CrossoverAnalysis {
  const byStudent = new Map<string, { cohort: string; block1: number[]; block2: number[] }>();
  for (const episode of episodes) {
    if (!episode.resolved || episode.crossesBlock || episode.durationMs === null) continue;
    if (episode.block !== 1 && episode.block !== 2) continue;
    if (episode.cohort !== "A" && episode.cohort !== "B") continue;
    const entry = byStudent.get(episode.actor) || { cohort: episode.cohort, block1: [], block2: [] };
    (episode.block === 1 ? entry.block1 : entry.block2).push(episode.durationMs / 1000);
    byStudent.set(episode.actor, entry);
  }
  const differences = { A: [] as number[], B: [] as number[] };
  for (const entry of byStudent.values()) {
    if (!entry.block1.length || !entry.block2.length) continue;
    differences[entry.cohort as "A" | "B"].push((median(entry.block1) as number) - (median(entry.block2) as number));
  }
  const medianA = median(differences.A);
  const medianB = median(differences.B);
  const treatment = mannWhitneyU(differences.A, differences.B);
  const period = mannWhitneyU(differences.A, differences.B.map((value) => -value));
  return {
    studentsA: differences.A.length,
    studentsB: differences.B.length,
    treatmentEffectS: medianA !== null && medianB !== null ? (medianA - medianB) / 2 : null,
    pTreatment: treatment.p,
    periodEffectS: medianA !== null && medianB !== null ? (medianA + medianB) / 2 : null,
    pPeriod: period.p,
    method: treatment.method,
  };
}

// --- Calculo por KPI ------------------------------------------------------------

/** Servidor de inferencia que respondio la decision (metadata.worker), para comparar Google Cloud y las Mac. */
export function inferenceServerOf(row: TelemetryEventRow) {
  const id = String(metadataValue(row, "worker") || "").trim();
  return id ? describeWorker(id).label : "sin dato";
}

function latencyGroups(latencies: TelemetryEventRow[], keyOf: (row: TelemetryEventRow) => string) {
  const groups: Record<string, { n: number; p50: number | null; p95: number | null }> = {};
  for (const key of [...new Set(latencies.map(keyOf))].sort()) {
    const values = latencies.filter((row) => keyOf(row) === key).map((row) => (row.latencyMs as number) / 1000);
    groups[key] = { n: values.length, p50: round(percentile(values, 50), 2), p95: round(percentile(values, 95), 2) };
  }
  return groups;
}

function latencyKpis(rows: TelemetryEventRow[]) {
  const latencies = latencyRows(rows);
  const seconds = latencies.map((row) => (row.latencyMs as number) / 1000);
  const byChannel = latencyGroups(latencies, (row) => row.channel);
  const byServer = latencyGroups(latencies, inferenceServerOf);
  const channels = Object.entries(byChannel).map(([channel, data]) => `${channel}: ${formatNumber(data.p50, 1)} s (n = ${data.n})`).join("; ");
  const knownServers = Object.entries(byServer).filter(([server]) => server !== "sin dato");
  const servers = knownServers.length > 1
    ? `; por servidor: ${knownServers.map(([server, data]) => `${server} ${formatNumber(data.p50, 1)} s (n = ${data.n})`).join(", ")}`
    : "";
  const p50 = percentile(seconds, 50);
  const p95 = percentile(seconds, 95);
  return [
    result("T1", p50, seconds.length, seconds.length
      ? `Mediana de ${formatNumber(p50, 1)} s en ${seconds.length} respuestas del modelo${channels ? ` (${channels}${servers})` : ""}.`
      : "Sin respuestas del modelo en la ventana.", { byChannel, byServer }),
    result("T2", p95, seconds.length, seconds.length
      ? `Percentil 95 de ${formatNumber(p95, 1)} s en ${seconds.length} respuestas.`
      : "Sin respuestas del modelo en la ventana.", { byChannel, byServer }),
  ];
}

function availabilityKpi(rows: TelemetryEventRow[]) {
  const attempts = rows.filter(isModelDecision);
  const failures = attempts.filter((row) => row.reasonCode === "model_error_fallback"
    || FALLBACK_SOURCES.has(String(metadataValue(row, "source") || "")));
  const value = attempts.length ? (1 - failures.length / attempts.length) * 100 : null;
  return result("T3", value, attempts.length, attempts.length
    ? `${attempts.length - failures.length} de ${attempts.length} ayudas llegaron del modelo; ${failures.length} salieron por el respaldo (sin worker o con falla).`
    : "Sin ayudas que llamaran al modelo en la ventana.");
}

function integrityKpis(rows: TelemetryEventRow[]) {
  const report = analyzeTelemetryDataset(rows);
  const withSeq = rows.filter((row) => row.clientSessionId && row.seq !== null).length;
  const duplicates = report.integrity.I2_duplicados.count;
  const loss = report.eventLoss.expected ? (report.eventLoss.missing / report.eventLoss.expected) * 100 : null;
  const duplicateRate = withSeq ? (duplicates / withSeq) * 100 : null;
  return {
    report,
    results: [
      result("T4", loss, report.eventLoss.expected || null, report.eventLoss.expected
        ? `Faltan ${report.eventLoss.missing} de ${report.eventLoss.expected} eventos esperados en ${report.eventLoss.clientSessions} sesiones de cliente.`
        : "Sin eventos numerados en la ventana."),
      result("T5", duplicateRate, withSeq || null, withSeq
        ? `${duplicates} eventos repetidos de ${withSeq} con seq.`
        : "Sin eventos numerados en la ventana."),
    ],
  };
}

function telemetryCoverageKpi(rows: TelemetryEventRow[], attendance: KpiContext["attendance"], timeZone: string) {
  if (!attendance?.length) {
    return result("T6", null, null, "Falta la asistencia por sesión en el plan del piloto (presentes por fecha).");
  }
  const activeByDay = new Map<string, Set<string>>();
  for (const row of rows) {
    if (!row.pilotCondition || row.actorRole !== "student" || !row.actorAnonId) continue;
    const day = dayKey(row.occurredAt, timeZone);
    const set = activeByDay.get(day) || new Set<string>();
    set.add(row.actorAnonId);
    activeByDay.set(day, set);
  }
  const presentByDay = new Map<string, number>();
  for (const item of attendance) {
    presentByDay.set(item.fecha, (presentByDay.get(item.fecha) || 0) + Math.max(0, Number(item.presentes) || 0));
  }
  let present = 0;
  let covered = 0;
  const perSession: Array<{ fecha: string; presentes: number; conTelemetria: number }> = [];
  for (const [day, count] of [...presentByDay.entries()].sort()) {
    const active = activeByDay.get(day)?.size || 0;
    present += count;
    covered += Math.min(active, count);
    perSession.push({ fecha: day, presentes: count, conTelemetria: active });
  }
  const value = present ? (covered / present) * 100 : null;
  return result("T6", value, present || null, present
    ? `${covered} de ${present} asistencias tienen telemetría con condición del piloto (${perSession.length} ${perSession.length === 1 ? "sesión" : "sesiones"}).`
    : "La asistencia no tiene presentes.", { perSession });
}

function anchoringKpi(rows: TelemetryEventRow[]) {
  const candidates = rows.filter((row) => row.eventType === "tutor_decision"
    && row.blocked === false
    && row.reasonCode !== "pilot_no_tutor"
    && COURSE_EVENTS.has(row.policyEventType)
    && typeof metadataValue(row, "ragSources") === "number");
  const anchored = candidates.filter((row) => Number(metadataValue(row, "ragSources")) >= 1);
  const value = candidates.length ? (anchored.length / candidates.length) * 100 : null;
  return result("T9", value, candidates.length || null, candidates.length
    ? `${anchored.length} de ${candidates.length} ayudas de eventos del curso llevaron fuentes autorizadas.`
    : "Sin ayudas de eventos del curso con el dato de fuentes.");
}

function catalogKpi() {
  const useful = EVENT_CATALOG.filter((entry) => entry.kpis.length > 0).length;
  return result("T12", useful, EVENT_CATALOG.length, `${useful} de ${EVENT_CATALOG.length} eventos del catálogo alimentan algún KPI.`);
}

function sourceText(source: ManualKpiSource) {
  const rows = `${source.usedRows} ${source.usedRows === 1 ? "fila usada" : "filas usadas"}${source.discardedRows ? `, ${source.discardedRows} ${source.discardedRows === 1 ? "descartada" : "descartadas"}` : ""}`;
  return `Fuente: ${source.files.join(", ")} (${rows}; detalle en registros-manuales.csv).`;
}

/**
 * KPI manual: primero la plantilla llena (con su trazado), si no el plan del
 * piloto. Si los dos tienen valor y no coinciden, gana la plantilla y se avisa.
 */
function manualKpi(id: ManualKpiId, manual: KpiManualValues | null | undefined, source: ManualKpiSource | null | undefined) {
  const kpi = findKpi(id);
  const template = MANUAL_TEMPLATES.find((item) => item.kpi === id) as ManualTemplate;
  const planValue = manual?.[id];
  const hasPlan = planValue !== null && planValue !== undefined && Number.isFinite(planValue);
  if (source && source.value !== null) {
    const notes = [...source.notes];
    if (hasPlan && round(planValue, 3) !== round(source.value, 3)) {
      notes.push(`El plan del piloto dice ${formatValue(planValue, kpi.unit)}; se usa el valor de las plantillas.`);
    }
    const noteText = notes.length ? ` Avisos: ${notes.join(" ")}` : "";
    const details = {
      origen: "plantilla",
      archivos: source.files,
      filasUsadas: source.usedRows,
      filasDescartadas: source.discardedRows,
      avisos: notes,
      ...(source.details || {}),
    };
    const base = result(id, source.value, source.n, `${source.summary} ${sourceText(source)}${noteText}`, details);
    if (source.blocking) {
      // T11: los criticos son obligatorios aunque el porcentaje pase el umbral.
      const belowThreshold = base.meets === false ? ` y el total no llega al umbral (${kpi.thresholdText})` : "";
      return { ...base, meets: false, summary: `${source.summary} No cumple: ${source.blocking}${belowThreshold}. ${sourceText(source)}${noteText}` };
    }
    return base;
  }
  if (hasPlan) {
    return result(id, planValue, null, `Valor registrado en el plan del piloto: ${formatValue(planValue, kpi.unit)}.${source ? ` Las plantillas no dieron valor: ${source.summary}` : ""}`, {
      origen: "plan",
      ...(source ? { archivos: source.files, filasUsadas: source.usedRows, filasDescartadas: source.discardedRows } : {}),
    });
  }
  if (source) {
    return result(id, null, null, `${source.summary} ${sourceText(source)}`, { origen: "sin dato", archivos: source.files, filasUsadas: source.usedRows, filasDescartadas: source.discardedRows });
  }
  return result(id, null, null, `Se registra a mano en el plan del piloto o con la plantilla ${template.file} (opción --registros de npm run piloto:analisis): ${kpi.formula}`);
}

function surveyKpis(survey: SurveyResponse[] | null | undefined, participants: number | null | undefined) {
  if (!survey) {
    const pending = "Se calcula al final con la encuesta (npm run piloto:analisis -- --encuesta=...).";
    return [result("U1", null, null, pending), result("U2", null, null, pending), result("U5", null, null, pending), result("P4", null, null, pending)];
  }
  const ux = survey.map((response) => personMean(response.ux, 4)).filter((value): value is number => value !== null);
  const sus = survey.map((response) => susScore(response.sus)).filter((value): value is number => value !== null);
  const pa = survey.map((response) => personMean(response.pa, 3)).filter((value): value is number => value !== null);
  const average = (values: number[]) => values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : null;
  const valid = survey.filter((response) => personMean(response.ux, 4) !== null || susScore(response.sus) !== null || personMean(response.pa, 3) !== null).length;
  const itemMeans = (items: Array<Array<number | null>>) => items[0]
    ? items[0].map((_, index) => round(average(items.map((list) => list[index]).filter((value): value is number => value !== null)), 2))
    : [];
  return [
    result("U1", average(ux), ux.length, ux.length ? `Promedio ${formatNumber(average(ux), 2, 2)} / 5 en ${ux.length} personas.` : "Ninguna encuesta con 4 o más ítems UX.", { itemMeans: itemMeans(survey.map((response) => response.ux)) }),
    result("U2", average(sus), sus.length, sus.length ? `SUS promedio ${formatNumber(average(sus), 1)} en ${sus.length} encuestas completas (mediana ${formatNumber(median(sus), 1)}).` : "Ninguna encuesta con los 10 ítems SUS.", { scores: sus }),
    result("U5", participants ? (valid / participants) * 100 : null, participants || null, participants
      ? `${valid} encuestas válidas de ${participants} participantes con consentimiento.`
      : `${valid} encuestas válidas; falta el número de participantes con consentimiento en el plan.`),
    result("P4", average(pa), pa.length, pa.length ? `Promedio ${formatNumber(average(pa), 2, 2)} / 5 en ${pa.length} personas.` : "Ninguna encuesta con 3 o más ítems PA.", { itemMeans: itemMeans(survey.map((response) => response.pa)) }),
  ];
}

function feedbackKpis(rows: TelemetryEventRow[]) {
  const accepted = rows.filter((row) => row.eventType === "tutor_response_accepted").length;
  const rejected = rows.filter((row) => row.eventType === "tutor_response_rejected").length;
  const ignored = rows.filter((row) => row.eventType === "tutor_response_ignored").length;
  const shown = rows.filter((row) => row.eventType === "vscode_suggestion_shown").length;
  const applied = rows.filter((row) => row.eventType === "suggestion_completion_applied").length;
  return [
    result("U3", accepted + rejected ? (accepted / (accepted + rejected)) * 100 : null, accepted + rejected || null, accepted + rejected
      ? `«Me sirvió» en ${accepted} de ${accepted + rejected} valoraciones; ${ignored} ayudas sin valorar.`
      : "Sin valoraciones del overlay en la ventana.", { accepted, rejected, ignored }),
    result("U4", shown ? (applied / shown) * 100 : null, shown || null, shown
      ? `${applied} cambios aplicados de ${shown} sugerencias mostradas en VS Code.`
      : "Sin sugerencias mostradas en VS Code en la ventana."),
  ];
}

function unblockingKpis(rows: TelemetryEventRow[]) {
  const episodes = extractUnblockingEpisodes(rows);
  const comparison = compareUnblocking(episodes);
  const withoutAway = compareUnblocking(episodes, { excludeAway: true });
  const byCohort = {
    A: compareUnblocking(episodes, { cohort: "A" }),
    B: compareUnblocking(episodes, { cohort: "B" }),
  };
  const withCondition = episodes.filter((episode) => episode.condition === "con_tutor" || episode.condition === "sin_tutor");
  const resolution: Record<string, { detected: number; resolved: number; ratePct: number | null }> = {};
  for (const condition of ["con_tutor", "sin_tutor"]) {
    const detected = withCondition.filter((episode) => episode.condition === condition && !episode.withoutDetection);
    const resolved = detected.filter((episode) => episode.resolved && !episode.crossesBlock);
    resolution[condition] = { detected: detected.length, resolved: resolved.length, ratePct: detected.length ? round((resolved.length / detected.length) * 100, 1) : null };
  }
  const crossing = episodes.filter((episode) => episode.crossesBlock).length;
  const censored = withCondition.filter((episode) => !episode.resolved).length;

  let p1Summary: string;
  if (!comparison.pairedStudents) {
    p1Summary = "Sin estudiantes con episodios resueltos en las dos condiciones.";
  } else {
    const significance = comparison.wilcoxon.p === null
      ? ""
      : comparison.wilcoxon.p < 0.05
        ? ` La diferencia es estadísticamente significativa (Wilcoxon ${comparison.wilcoxon.method}, p = ${formatP(comparison.wilcoxon.p)}).`
        : ` La diferencia no es estadísticamente significativa (Wilcoxon ${comparison.wilcoxon.method}, p = ${formatP(comparison.wilcoxon.p)}).`;
    p1Summary = `Mediana con tutor ${formatNumber(comparison.medianWithTutorS, 0)} s y sin tutor ${formatNumber(comparison.medianWithoutTutorS, 0)} s en ${comparison.pairedStudents} estudiantes: reducción de ${formatNumber(comparison.reductionPct, 1)} %.${significance} Sin los episodios corregidos desde otro archivo: ${formatNumber(withoutAway.reductionPct, 1)} %.`;
  }
  const bothRates = resolution.con_tutor.ratePct !== null && resolution.sin_tutor.ratePct !== null;
  return {
    episodes,
    comparison,
    results: [
      result("P1", comparison.reductionPct, comparison.pairedStudents || null, p1Summary, {
        withoutAway: { reductionPct: round(withoutAway.reductionPct, 1), pairedStudents: withoutAway.pairedStudents },
        byCohort: {
          A: { reductionPct: round(byCohort.A.reductionPct, 1), pairedStudents: byCohort.A.pairedStudents },
          B: { reductionPct: round(byCohort.B.reductionPct, 1), pairedStudents: byCohort.B.pairedStudents },
        },
        wilcoxon: comparison.wilcoxon,
        crossover: crossoverAnalysis(episodes),
        crossingEpisodes: crossing,
        censoredEpisodes: censored,
      }),
      result("P2", resolution.con_tutor.ratePct, resolution.con_tutor.detected + resolution.sin_tutor.detected || null, bothRates
        ? `Resueltos con tutor ${formatNumber(resolution.con_tutor.ratePct, 1)} % (${resolution.con_tutor.resolved}/${resolution.con_tutor.detected}) y sin tutor ${formatNumber(resolution.sin_tutor.ratePct, 1)} % (${resolution.sin_tutor.resolved}/${resolution.sin_tutor.detected}). El valor es el de la condición con tutor.`
        : "Sin episodios de bloqueo con condición del piloto.", { resolution }),
    ],
  };
}

function participationKpi(rows: TelemetryEventRow[], participants: number | null | undefined) {
  const conditions = new Map<string, Set<string>>();
  for (const row of rows) {
    if (row.actorRole !== "student" || !row.actorAnonId) continue;
    if (row.pilotCondition !== "con_tutor" && row.pilotCondition !== "sin_tutor") continue;
    const set = conditions.get(row.actorAnonId) || new Set<string>();
    set.add(row.pilotCondition);
    conditions.set(row.actorAnonId, set);
  }
  const both = [...conditions.values()].filter((set) => set.size === 2).length;
  if (!participants) {
    return result("P3", null, conditions.size || null, `${both} estudiantes con actividad en los dos bloques; falta el número de participantes con consentimiento en el plan.`, { both, withActivity: conditions.size });
  }
  return result("P3", (both / participants) * 100, participants, `${both} de ${participants} participantes tuvieron actividad en los dos bloques.`, { both, withActivity: conditions.size });
}

function antiSolutionKpi(rows: TelemetryEventRow[], report: ReturnType<typeof analyzeTelemetryDataset>) {
  const applied = rows.filter((row) => row.eventType === "suggestion_completion_applied").length;
  const unchecked = report.integrity.I6_aplicada_sin_verificar.count;
  const truncated = rows.filter((row) => row.eventType === "tutor_decision" && metadataValue(row, "reason") === "codigo_recortado").length;
  const checks = rows.filter((row) => row.eventType === "code_application_checked");
  const blockedChecks = checks.filter((row) => row.blocked === true).length;
  return result("P6", applied ? (1 - unchecked / applied) * 100 : null, applied || null, applied
    ? `${applied - unchecked} de ${applied} cambios aplicados pasaron por la verificación; el guardarraíl recortó ${truncated} respuestas y la política negó ${blockedChecks} de ${checks.length} aplicaciones.`
    : `Sin cambios aplicados en la ventana; el guardarraíl recortó ${truncated} respuestas.`, { applied, unchecked, truncated, checks: checks.length, blockedChecks });
}

function interventionUseKpi(rows: TelemetryEventRow[]) {
  const decisions = rows.filter((row) => row.eventType === "tutor_decision" && row.reasonCode !== "pilot_no_tutor");
  const blocked = decisions.filter((row) => row.blocked === true).length;
  const byStage: Record<string, number> = {};
  const byReason: Record<string, number> = {};
  for (const row of decisions) {
    byStage[row.helpStage || "sin etapa"] = (byStage[row.helpStage || "sin etapa"] || 0) + 1;
    if (row.blocked) byReason[row.reasonCode || "sin motivo"] = (byReason[row.reasonCode || "sin motivo"] || 0) + 1;
  }
  const pilotOff = rows.filter((row) => row.eventType === "tutor_decision" && row.reasonCode === "pilot_no_tutor").length;
  const stageNames: Record<string, string> = {
    hint_1: "pista 1",
    hint_2: "pista 2",
    partial_example: "ejemplo parcial",
    explanation: "explicación",
    mini_quiz: "mini-quiz",
    controlled: "mensaje controlado",
  };
  const stages = Object.entries(byStage).sort((a, b) => b[1] - a[1]).map(([stage, count]) => `${stageNames[stage] || stage} ${count}`).join(", ");
  return result("P7", decisions.length ? (blocked / decisions.length) * 100 : null, decisions.length || null, decisions.length
    ? `${decisions.length} decisiones (${stages}); la política bloqueó ${blocked}. Aparte, ${pilotOff} pedidos en el bloque sin tutor.`
    : "Sin decisiones del tutor en la ventana.", { byStage, byReason, pilotOff });
}

function quizKpi(quizzes: KpiContext["quizzes"]) {
  if (!quizzes) return result("P8", null, null, "Se calcula con los intentos del mini-quiz (npm run piloto:dataset).");
  const answered = quizzes.filter((quiz) => quiz.correct !== null);
  const correct = answered.filter((quiz) => quiz.correct === true).length;
  return result("P8", answered.length ? (correct / answered.length) * 100 : null, answered.length || null, answered.length
    ? `${correct} de ${answered.length} respuestas correctas.`
    : "Sin respuestas del mini-quiz.");
}

/** Todos los KPIs del catalogo, en su orden. Los que no tienen datos salen con value = null. */
export function computeKpis(context: KpiContext): KpiResult[] {
  const rows = context.rows;
  const timeZone = context.timeZone || "America/Bogota";
  const integrity = integrityKpis(rows);
  const unblocking = unblockingKpis(rows);
  const all = [
    ...latencyKpis(rows),
    availabilityKpi(rows),
    ...integrity.results,
    telemetryCoverageKpi(rows, context.attendance, timeZone),
    manualKpi("T7", context.manual, context.manualSources?.T7),
    manualKpi("T8", context.manual, context.manualSources?.T8),
    anchoringKpi(rows),
    manualKpi("T10", context.manual, context.manualSources?.T10),
    manualKpi("T11", context.manual, context.manualSources?.T11),
    catalogKpi(),
    ...surveyKpis(context.survey, context.participants),
    ...feedbackKpis(rows),
    ...unblocking.results,
    participationKpi(rows, context.participants),
    manualKpi("P5", context.manual, context.manualSources?.P5),
    antiSolutionKpi(rows, integrity.report),
    interventionUseKpi(rows),
    quizKpi(context.quizzes),
  ];
  const byId = new Map(all.map((item) => [item.id, item]));
  return KPI_CATALOG.map((kpi) => {
    const found = byId.get(kpi.id);
    if (!found) throw new Error(`Falta el calculo del KPI ${kpi.id}`);
    return found;
  });
}

/** Lo que usa el informe para las graficas de P1. */
export function unblockingDetail(rows: TelemetryEventRow[]) {
  const episodes = extractUnblockingEpisodes(rows);
  return { episodes, comparison: compareUnblocking(episodes) };
}

// --- KPIs manuales desde plantillas CSV (T7, T8, T10, T11, P5) ----------------
//
// Las plantillas viven en data/piloto/plantillas/ (vacias). Despues de cada
// sesion se llena una copia fuera del repositorio y npm run piloto:analisis
// -- --registros=<carpeta> las lee: valida cada fila, calcula el KPI y deja el
// trazado fila por fila (registros-manuales.csv). Asi ya no hay que
// transcribir los valores a mano al plan del piloto.

export type ManualTemplate = {
  /** Nombre de la plantilla en data/piloto/plantillas/. */
  file: string;
  /** Prefijo con el que piloto:analisis reconoce las copias llenas (registro-incidentes-2026-10-13.csv). */
  prefix: string;
  kpi: ManualKpiId;
  columns: string[];
  required: string[];
  /** Una frase para la documentacion y el informe. */
  purpose: string;
};

export const MANUAL_TEMPLATES: ManualTemplate[] = [
  {
    file: "registro-incidentes.csv",
    prefix: "registro-incidentes",
    kpi: "T7",
    columns: ["fecha", "hora_inicio", "hora_fin", "severidad", "sintoma", "afectados", "causa", "respuesta", "responsable", "evidencia"],
    required: ["fecha", "severidad"],
    purpose: "Una copia por sesión (registro-incidentes-AAAA-MM-DD.csv), una fila por incidente con severidad S1 a S4 del plan de soporte. T7 cuenta los S1.",
  },
  {
    file: "pruebas-humo.csv",
    prefix: "pruebas-humo",
    kpi: "T8",
    columns: ["fecha", "hora", "destino", "correctas", "total", "evidencia", "observaciones"],
    required: ["fecha", "destino", "correctas", "total"],
    purpose: "Una fila por corrida de npm run demo:escenarios contra producción («Resultado: N de M comprobaciones correctas») el día de una sesión. También se leen los demo-escenarios*.md que escribe ese script con --salida.",
  },
  {
    file: "tiempos-instalacion.csv",
    prefix: "tiempos-instalacion",
    kpi: "T10",
    columns: ["persona", "rol", "fecha", "camino", "navegador", "sistema_operativo", "inicio", "overlay_con_sesion", "editor_listo", "minutos_totales", "ayuda_recibida", "observaciones"],
    required: ["persona"],
    purpose: "Una fila por persona cronometrada (camino tunel o mac). Para el camino que no traiga, se usa la hoja de la prueba de inicio a fin (P1.1 a P1.6 y P4.1 a P4.3).",
  },
  {
    file: "cumplimiento.csv",
    prefix: "cumplimiento",
    kpi: "T11",
    columns: ["id", "area", "item", "critico", "verificacion", "estado", "evidencia", "responsable", "fecha"],
    required: ["id", "estado"],
    purpose: "Una fila por ítem de la lista de cumplimiento con su estado (cumple, no cumple, no aplica o pendiente). Los automáticos se copian de npm run piloto:verificar. Si hay varias copias, cuenta la de fecha más reciente en el nombre (cumplimiento-AAAA-MM-DD.csv) entre las que tienen algún ítem marcado.",
  },
  {
    file: "hallazgos.csv",
    prefix: "hallazgos",
    kpi: "P5",
    columns: ["id", "hallazgo", "kpis", "critica", "estado", "accion", "evidencia", "responsable"],
    required: ["id", "critica", "estado"],
    purpose: "Una fila por hallazgo (A14.5) con los KPIs que toca, si es crítico y el estado de su mejora (implementada, en curso, pendiente o descartada). También llena hallazgo y acción en trazabilidad.csv.",
  },
];

/** Fuentes que se leen sin plantilla propia. */
export const MANUAL_EXTRA_SOURCES = [
  { prefix: "demo-escenarios", extension: ".md", kpi: "T8" as ManualKpiId, purpose: "Evidencia de npm run demo:escenarios -- --url=<backend> --salida=<archivo>." },
  { prefix: "prueba-inicio-a-fin", extension: ".csv", kpi: "T10" as ManualKpiId, purpose: "Hoja de la prueba de inicio a fin: respaldo de T10 para el camino (túnel o Mac) que tiempos-instalacion.csv no traiga." },
];

export type ManualRecordFile = {
  name: string;
  text: string;
  /** windows-1252: el archivo no era UTF-8 (Excel «CSV (delimitado por comas)») y se volvió a leer así. */
  encoding?: "utf-8" | "windows-1252";
};

export type ManualRowTrace = {
  kpi: ManualKpiId | "";
  archivo: string;
  /** Fila de la hoja (la cabecera es la 1; sin contar filas vacías). null: el archivo entero. */
  fila: number | null;
  /** usada: entra al KPI; descartada: fila mal llenada (hay que corregirla); ignorada: válida pero no aplica. */
  estado: "usada" | "descartada" | "ignorada";
  valor: string;
  motivo: string;
};

export type ManualKpiSource = {
  kpi: ManualKpiId;
  value: number | null;
  n: number | null;
  files: string[];
  usedRows: number;
  discardedRows: number;
  /** Lectura sin el veredicto del umbral. */
  summary: string;
  notes: string[];
  /** Motivo para no cumplir aunque el valor pase el umbral (T11: ítems críticos). */
  blocking?: string | null;
  details?: Record<string, unknown>;
};

export type ManualFinding = { id: string; hallazgo: string; kpis: string[]; critica: boolean; estado: string; accion: string };

export type ManualRecordsResult = {
  sources: Partial<Record<ManualKpiId, ManualKpiSource>>;
  rows: ManualRowTrace[];
  /** Hallazgos validos de hallazgos*.csv, para trazabilidad.csv. */
  findings: ManualFinding[];
  unrecognized: string[];
};

type SheetRow = {
  fila: number;
  values: Record<string, string>;
  /** Si la fila tiene más celdas que la cabecera, cuántas tiene (las columnas quedaron corridas); si no, null. */
  overflow: string | null;
};

function stripAccents(value: string) {
  return value.normalize("NFD").replace(/[̀-ͯ]/g, "");
}

function normalizeKey(value: string) {
  return stripAccents(String(value || "")).trim().toLowerCase().replace(/[\s-]+/g, "_");
}

function readSheet(text: string, aliases: Record<string, string> = {}) {
  const [header, ...rows] = parseCsv(text);
  if (!header) return { columns: [] as string[], rows: [] as SheetRow[] };
  const columns = header.map((cell) => {
    const key = normalizeKey(cell);
    return aliases[key] || key;
  });
  return {
    columns,
    rows: rows.map((cells, index) => ({
      fila: index + 2,
      values: Object.fromEntries(columns.map((column, position) => [column, String(cells[position] ?? "").trim()])),
      overflow: cells.length > columns.length ? `${cells.length} celdas; la cabecera tiene ${columns.length}` : null,
    })),
  };
}

/**
 * Una fila con más celdas que la cabecera tiene las columnas corridas: casi
 * siempre una coma decimal (12,5) o un texto con comas sin comillas en una
 * hoja separada por comas. Se descarta con ese motivo, no con el de la columna
 * que quedó mal.
 */
const OVERFLOW_REASON = "la fila tiene más celdas que la cabecera: ¿una coma decimal (12,5) o un texto con comas sin comillas en una hoja separada por «,»? Escribe 12.5, pon el valor entre comillas o guarda la hoja con separador «;»";

/** AAAA-MM-DD, DD/MM/AAAA (Excel en español) o una fecha ISO; null si no es una fecha real. */
export function parseRecordDate(value: string, timeZone = "America/Bogota") {
  const text = String(value || "").trim();
  if (/^\d{4}-\d{2}-\d{2}T.*(Z|[+-]\d{2}:?\d{2})$/i.test(text) && Number.isFinite(Date.parse(text))) return dayKey(text, timeZone);
  let match = text.match(/^(\d{4})-(\d{2})-(\d{2})(?:T[\d:.]+)?$/);
  let year: number;
  let month: number;
  let day: number;
  if (match) {
    [year, month, day] = [Number(match[1]), Number(match[2]), Number(match[3])];
  } else if ((match = text.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/))) {
    [day, month, year] = [Number(match[1]), Number(match[2]), Number(match[3])];
  } else {
    return null;
  }
  const date = new Date(Date.UTC(year, month - 1, day));
  if (date.getUTCFullYear() !== year || date.getUTCMonth() !== month - 1 || date.getUTCDate() !== day) return null;
  return `${year}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
}

/** Hora del día en segundos: HH:MM, HH:MM:SS, con a. m./p. m., o la hora de una fecha ISO. */
export function parseRecordClock(value: string) {
  const text = stripAccents(String(value || "")).trim().toLowerCase();
  const match = text.match(/^(\d{1,2}):(\d{2})(?::(\d{2}))?(?:\s*([ap])\.?\s*m\.?)?$/) || text.match(/t(\d{2}):(\d{2})(?::(\d{2}))?/);
  if (!match) return null;
  let hours = Number(match[1]);
  const minutes = Number(match[2]);
  const seconds = Number(match[3] || 0);
  const meridiem = match[4];
  if (meridiem) {
    if (hours < 1 || hours > 12) return null;
    hours = (hours % 12) + (meridiem === "p" ? 12 : 0);
  }
  if (hours > 23 || minutes > 59 || seconds > 59) return null;
  return hours * 3600 + minutes * 60 + seconds;
}

/** Número con coma o punto decimal, con "min" opcional ("12,5 min"). */
export function parseRecordNumber(value: string) {
  const text = String(value || "").trim().toLowerCase().replace(/\s*min(utos)?\.?$/, "").replace(",", ".");
  if (!/^\d+(\.\d+)?$/.test(text)) return null;
  return Number(text);
}

function parseCount(value: string) {
  const text = String(value || "").trim();
  return /^\d+$/.test(text) ? Number(text) : null;
}

/** true / false; null si está vacío; undefined si no se entiende. */
function parseYesNo(value: string) {
  const text = stripAccents(String(value || "")).trim().toLowerCase();
  if (!text) return null;
  if (["si", "s", "yes", "y", "x", "true", "1"].includes(text)) return true;
  if (["no", "n", "false", "0"].includes(text)) return false;
  return undefined;
}

function localClock(iso: string, timeZone: string) {
  const parts = new Intl.DateTimeFormat("en-GB", { timeZone, hour: "2-digit", minute: "2-digit", second: "2-digit", hourCycle: "h23" }).formatToParts(new Date(iso));
  const part = (type: string) => Number(parts.find((item) => item.type === type)?.value || 0);
  return part("hour") * 3600 + part("minute") * 60 + part("second");
}

function clockText(seconds: number | null) {
  if (seconds === null) return "";
  return `${String(Math.floor(seconds / 3600)).padStart(2, "0")}:${String(Math.floor((seconds % 3600) / 60)).padStart(2, "0")}`;
}

function missingColumns(columns: string[], required: string[]) {
  return required.filter((column) => !columns.includes(column));
}

function listText(items: string[], max = 6) {
  return items.length > max ? `${items.slice(0, max).join(", ")} y ${items.length - max} más` : items.join(", ");
}

type ManualContext = {
  trace: ManualRowTrace[];
  sessionDates: string[];
  timeZone: string;
};

function tracker(context: ManualContext, kpi: ManualKpiId) {
  let used = 0;
  let discarded = 0;
  const add = (archivo: string, fila: number | null, estado: ManualRowTrace["estado"], valor: string, motivo: string) => {
    if (estado === "usada") used += 1;
    if (estado === "descartada") discarded += 1;
    context.trace.push({ kpi, archivo, fila, estado, valor, motivo });
  };
  return {
    get used() { return used; },
    get discarded() { return discarded; },
    add,
    /** Descarta la fila si tiene las columnas corridas (ver OVERFLOW_REASON); true si la descartó. */
    overflowed(archivo: string, row: SheetRow) {
      if (!row.overflow) return false;
      add(archivo, row.fila, "descartada", row.overflow, OVERFLOW_REASON);
      return true;
    },
  };
}

// T7: incidentes S1 del registro del plan de soporte durante las sesiones.
function incidentsSource(files: ManualRecordFile[], context: ManualContext): ManualKpiSource {
  const track = tracker(context, "T7");
  const sessions = new Set(context.sessionDates);
  const bySeverity: Record<string, number> = { S1: 0, S2: 0, S3: 0, S4: 0 };
  const criticalDates: string[] = [];
  const counted: string[] = [];
  const covered = new Set<string>();
  for (const file of files) {
    const sheet = readSheet(file.text);
    const missing = missingColumns(sheet.columns, ["fecha", "severidad"]);
    if (missing.length) {
      track.add(file.name, null, "descartada", "", `faltan columnas: ${missing.join(", ")}`);
      continue;
    }
    const nameDate = file.name.match(/(\d{4}-\d{2}-\d{2})/)?.[1] || null;
    let valid = 0;
    for (const row of sheet.rows) {
      if (track.overflowed(file.name, row)) continue;
      const fecha = parseRecordDate(row.values.fecha, context.timeZone);
      const severity = stripAccents(row.values.severidad).trim().match(/^s?\s*([1-4])(?!\d)/i);
      if (!fecha) {
        track.add(file.name, row.fila, "descartada", row.values.fecha, "fecha no válida (AAAA-MM-DD o DD/MM/AAAA)");
        continue;
      }
      if (!severity) {
        track.add(file.name, row.fila, "descartada", row.values.severidad, "severidad no válida (S1, S2, S3 o S4 del plan de soporte)");
        continue;
      }
      if (sessions.size && !sessions.has(fecha)) {
        track.add(file.name, row.fila, "ignorada", fecha, "fecha fuera de las sesiones del plan del piloto");
        continue;
      }
      const level = `S${severity[1]}`;
      valid += 1;
      bySeverity[level] += 1;
      covered.add(fecha);
      if (level === "S1") criticalDates.push(fecha);
      track.add(file.name, row.fila, "usada", `${level} ${fecha}`, level === "S1" ? "incidente crítico: cuenta en T7" : `${level}: se reporta, no cuenta en T7`);
    }
    if (valid) {
      counted.push(file.name);
      if (nameDate) covered.add(nameDate);
    } else if (!sheet.rows.length && nameDate && (!sessions.size || sessions.has(nameDate))) {
      counted.push(file.name);
      covered.add(nameDate);
      track.add(file.name, null, "usada", `0 incidentes ${nameDate}`, "registro de la sesión sin incidentes");
    } else if (!sheet.rows.length) {
      track.add(file.name, null, "ignorada", "", nameDate
        ? "sin filas y con una fecha fuera de las sesiones del plan"
        : "sin filas y sin fecha en el nombre: no cuenta como registro de una sesión (nómbrala registro-incidentes-AAAA-MM-DD.csv)");
    }
  }
  const total = Object.values(bySeverity).reduce((sum, value) => sum + value, 0);
  const notes: string[] = [];
  const uncovered = context.sessionDates.filter((date) => !covered.has(date));
  if (counted.length && uncovered.length) notes.push(`Sin registro de incidentes de: ${listText(uncovered)}.`);
  const breakdown = `S1 ${bySeverity.S1}, S2 ${bySeverity.S2}, S3 ${bySeverity.S3}, S4 ${bySeverity.S4}`;
  return {
    kpi: "T7",
    value: counted.length ? bySeverity.S1 : null,
    n: counted.length || null,
    files: files.map((file) => file.name),
    usedRows: track.used,
    discardedRows: track.discarded,
    summary: counted.length
      ? `${bySeverity.S1} ${bySeverity.S1 === 1 ? "incidente S1" : "incidentes S1"} en ${counted.length} ${counted.length === 1 ? "registro de sesión" : "registros de sesión"} (${total} incidentes en total: ${breakdown})${criticalDates.length ? `; S1 el ${listText([...new Set(criticalDates)])}` : ""}.`
      : "Ningún registro de incidentes válido.",
    notes,
    details: { bySeverity, registros: counted },
  };
}

type SmokeRun = { fecha: string; seconds: number | null; order: number; correct: number; total: number; archivo: string; fila: number | null };

// T8: la peor sesión de npm run demo:escenarios contra producción. Con el
// plan, solo cuentan las corridas del día de una sesión (el runbook la pide
// en «Antes de la clase (T − 30 min)»): una prueba de otro día, por ejemplo la
// de la prueba de inicio a fin o una a mitad del despliegue, no es de una sesión.
function smokeSource(csvFiles: ManualRecordFile[], mdFiles: ManualRecordFile[], context: ManualContext): ManualKpiSource {
  const track = tracker(context, "T8");
  const sessions = new Set(context.sessionDates);
  const outsideSessions = (fecha: string) => sessions.size > 0 && !sessions.has(fecha);
  const OUTSIDE_REASON = "fecha fuera de las sesiones del plan del piloto (la prueba de humo cuenta el día de la sesión)";
  const runs: SmokeRun[] = [];
  let order = 0;
  for (const file of csvFiles) {
    const sheet = readSheet(file.text);
    const missing = missingColumns(sheet.columns, ["fecha", "destino", "correctas", "total"]);
    if (missing.length) {
      track.add(file.name, null, "descartada", "", `faltan columnas: ${missing.join(", ")}`);
      continue;
    }
    for (const row of sheet.rows) {
      if (track.overflowed(file.name, row)) continue;
      const fecha = parseRecordDate(row.values.fecha, context.timeZone);
      const correct = parseCount(row.values.correctas);
      const total = parseCount(row.values.total);
      const hora = row.values.hora ? parseRecordClock(row.values.hora) : null;
      if (!fecha) {
        track.add(file.name, row.fila, "descartada", row.values.fecha, "fecha no válida (AAAA-MM-DD o DD/MM/AAAA)");
      } else if (correct === null || total === null || total === 0 || correct > total) {
        track.add(file.name, row.fila, "descartada", `${row.values.correctas} de ${row.values.total}`, "correctas y total deben ser enteros, con total > 0 y correctas ≤ total");
      } else if (row.values.hora && hora === null) {
        track.add(file.name, row.fila, "descartada", row.values.hora, "hora no válida (HH:MM)");
      } else if (!/^https:\/\//i.test(row.values.destino)) {
        track.add(file.name, row.fila, "ignorada", row.values.destino, "no es contra producción (el destino no empieza por https://)");
      } else if (outsideSessions(fecha)) {
        track.add(file.name, row.fila, "ignorada", `${correct} de ${total} (${fecha})`, OUTSIDE_REASON);
      } else {
        runs.push({ fecha, seconds: hora, order: order += 1, correct, total, archivo: file.name, fila: row.fila });
      }
    }
  }
  for (const file of mdFiles) {
    const started = file.text.match(/^- Fecha: (\S+)/m)?.[1] || "";
    const backend = file.text.match(/^- Backend: (.+)$/m)?.[1]?.trim() || "";
    const outcome = file.text.match(/^- Resultado: (\d+) de (\d+) comprobaciones correctas/m);
    if (!outcome || !Number.isFinite(Date.parse(started))) {
      track.add(file.name, null, "descartada", "", "no tiene las líneas «- Fecha:» y «- Resultado: N de M comprobaciones correctas» de npm run demo:escenarios");
      continue;
    }
    if (!/^https:\/\//i.test(backend)) {
      track.add(file.name, null, "ignorada", backend, "no es contra producción (backend sin https://)");
      continue;
    }
    const correct = Number(outcome[1]);
    const total = Number(outcome[2]);
    if (!total || correct > total) {
      track.add(file.name, null, "descartada", `${correct} de ${total}`, "resultado sin comprobaciones");
      continue;
    }
    const fecha = dayKey(started, context.timeZone);
    if (outsideSessions(fecha)) {
      track.add(file.name, null, "ignorada", `${correct} de ${total} (${fecha})`, OUTSIDE_REASON);
      continue;
    }
    runs.push({ fecha, seconds: localClock(started, context.timeZone), order: order += 1, correct, total, archivo: file.name, fila: null });
  }
  // Una por sesión: si el mismo día se repitió (por ejemplo tras corregir algo), cuenta la última.
  const byDay = new Map<string, SmokeRun[]>();
  for (const run of runs) byDay.set(run.fecha, [...(byDay.get(run.fecha) || []), run]);
  const perDay: Array<{ fecha: string; correctas: number; total: number; pct: number }> = [];
  for (const [fecha, list] of [...byDay.entries()].sort()) {
    const sorted = [...list].sort((a, b) => (a.seconds ?? -1) - (b.seconds ?? -1) || a.order - b.order);
    const last = sorted[sorted.length - 1];
    for (const run of sorted) {
      const valor = `${run.correct} de ${run.total} (${fecha}${run.seconds !== null ? ` ${clockText(run.seconds)}` : ""})`;
      if (run === last) track.add(run.archivo, run.fila, "usada", valor, "prueba de humo de la sesión");
      else track.add(run.archivo, run.fila, "ignorada", valor, "reemplazada por una corrida posterior del mismo día");
    }
    perDay.push({ fecha, correctas: last.correct, total: last.total, pct: (last.correct / last.total) * 100 });
  }
  const worst = perDay.reduce<typeof perDay[number] | null>((low, day) => (!low || day.pct < low.pct ? day : low), null);
  const notes: string[] = [];
  const missingDays = context.sessionDates.filter((date) => !byDay.has(date));
  if (perDay.length && missingDays.length) notes.push(`Sesiones del plan sin prueba de humo ese mismo día: ${listText(missingDays)}.`);
  return {
    kpi: "T8",
    value: worst ? worst.pct : null,
    n: perDay.length || null,
    files: [...csvFiles, ...mdFiles].map((file) => file.name),
    usedRows: track.used,
    discardedRows: track.discarded,
    summary: worst
      ? `Peor sesión: ${formatNumber(worst.pct, 1)} % (${worst.correctas} de ${worst.total} comprobaciones, ${worst.fecha}) en ${perDay.length} ${perDay.length === 1 ? "sesión" : "sesiones"} con prueba de humo contra producción.`
      : "Ninguna prueba de humo válida contra producción.",
    notes,
    details: { perDay: perDay.map((day) => ({ ...day, pct: round(day.pct, 1) })) },
  };
}

type InstallPath = "tunel" | "mac";
type InstallTime = { camino: InstallPath; minutos: number; ayuda: boolean; archivo: string };

const PATH_LABEL: Record<InstallPath, string> = { tunel: "túnel", mac: "Mac" };

function installTimesFromSheet(files: ManualRecordFile[], context: ManualContext, track: ReturnType<typeof tracker>) {
  const times: InstallTime[] = [];
  const seen = new Set<string>();
  const notes: string[] = [];
  for (const file of files) {
    const sheet = readSheet(file.text, { editor_por_tunel: "editor_listo", minutos: "minutos_totales" });
    const missing = missingColumns(sheet.columns, ["persona"]);
    const hasMinutes = sheet.columns.includes("minutos_totales");
    const hasClocks = sheet.columns.includes("inicio") && sheet.columns.includes("editor_listo");
    if (missing.length || (!hasMinutes && !hasClocks)) {
      track.add(file.name, null, "descartada", "", `faltan columnas: ${[...missing, ...(!hasMinutes && !hasClocks ? ["minutos_totales (o inicio y editor_listo)"] : [])].join(", ")}`);
      continue;
    }
    for (const row of sheet.rows) {
      if (track.overflowed(file.name, row)) continue;
      const persona = row.values.persona;
      const rawPath = stripAccents(row.values.camino || "").trim().toLowerCase();
      const camino = !rawPath || rawPath.startsWith("tunel") ? "tunel" : rawPath.startsWith("mac") ? "mac" : null;
      const fromColumn = row.values.minutos_totales ? parseRecordNumber(row.values.minutos_totales) : null;
      const start = row.values.inicio ? parseRecordClock(row.values.inicio) : null;
      const end = row.values.editor_listo ? parseRecordClock(row.values.editor_listo) : null;
      const fromClocks = start !== null && end !== null && end > start ? (end - start) / 60 : null;
      const ayuda = parseYesNo(row.values.ayuda_recibida || "");
      if (!persona) {
        track.add(file.name, row.fila, "descartada", "", "falta persona (un código como V1 basta)");
      } else if (!camino) {
        track.add(file.name, row.fila, "descartada", row.values.camino, "camino no válido (tunel o mac)");
      } else if (row.values.minutos_totales && fromColumn === null) {
        track.add(file.name, row.fila, "descartada", row.values.minutos_totales, "minutos_totales no es un número");
      } else if (fromColumn === null && fromClocks === null) {
        track.add(file.name, row.fila, "descartada", `${row.values.inicio || ""} → ${row.values.editor_listo || ""}`, "sin minutos_totales ni horas válidas de inicio y editor_listo (HH:MM)");
      } else if (ayuda === undefined) {
        track.add(file.name, row.fila, "descartada", row.values.ayuda_recibida, "ayuda_recibida debe ser si o no");
      } else {
        const minutos = (fromColumn ?? fromClocks) as number;
        const key = `${persona.toLowerCase()}|${camino}`;
        if (minutos <= 0 || minutos > 240) {
          track.add(file.name, row.fila, "descartada", `${formatNumber(minutos, 1)} min`, "fuera de rango (más de 0 y hasta 240 minutos)");
        } else if (seen.has(key)) {
          track.add(file.name, row.fila, "ignorada", `${formatNumber(minutos, 1)} min`, "persona repetida en el mismo camino: cuenta su primera fila");
        } else {
          seen.add(key);
          times.push({ camino, minutos, ayuda: ayuda === true, archivo: file.name });
          const mismatch = fromColumn !== null && fromClocks !== null && Math.abs(fromColumn - fromClocks) > 2;
          if (mismatch) notes.push(`${file.name}, fila ${row.fila}: minutos_totales (${formatNumber(fromColumn, 1)}) no coincide con las horas (${formatNumber(fromClocks, 1)}); se usa minutos_totales.`);
          track.add(file.name, row.fila, "usada", `${formatNumber(minutos, 1)} min (${PATH_LABEL[camino]})`, fromColumn !== null ? "minutos_totales" : "calculado con inicio y editor_listo");
        }
      }
    }
  }
  return { times, notes };
}

/**
 * Respaldo de T10: la hoja de la prueba de inicio a fin, para los caminos que
 * tiempos-instalacion.csv no trae. Túnel: de P1.1 a P1.6 (P1.6 pide los
 * «Minutos totales», que ganan sobre las horas). Mac: de P4.1 a P4.3 por las
 * horas, porque en P4.1 se anotan los minutos del paso y P4.3 no dice si son
 * los totales; los minutos de P4.3 solo se usan si faltan las horas.
 */
function installTimesFromEndToEnd(files: ManualRecordFile[], track: ReturnType<typeof tracker>, paths: Set<InstallPath>) {
  const times: InstallTime[] = [];
  const notes: string[] = [];
  const stretches: Array<{ camino: InstallPath; start: string; end: string; prefer: "minutos" | "horas" }> = [
    { camino: "tunel", start: "P1.1", end: "P1.6", prefer: "minutos" },
    { camino: "mac", start: "P4.1", end: "P4.3", prefer: "horas" },
  ];
  const stepsUsed = new Set(stretches.flatMap((stretch) => [stretch.start, stretch.end]));
  for (const file of files) {
    const sheet = readSheet(file.text);
    const missing = missingColumns(sheet.columns, ["paso", "cuenta", "hora_inicio", "hora_fin", "minutos", "resultado"]);
    if (missing.length) {
      track.add(file.name, null, "descartada", "", `faltan columnas: ${missing.join(", ")}`);
      continue;
    }
    const first = new Map<string, SheetRow>();
    for (const row of sheet.rows) {
      const paso = row.values.paso.toUpperCase();
      // Solo importan las filas del cronómetro; una fila corrida en otro paso no afecta a T10.
      if (stepsUsed.has(paso) && track.overflowed(file.name, row)) continue;
      const key = `${paso}|${row.values.cuenta}`;
      if (!first.has(key)) first.set(key, row);
    }
    const accounts = [...new Set(sheet.rows.map((row) => row.values.cuenta).filter((cuenta) => /^E\d+$/i.test(cuenta)))];
    for (const cuenta of accounts) {
      for (const stretch of stretches) {
        const startRow = first.get(`${stretch.start}|${cuenta}`);
        const endRow = first.get(`${stretch.end}|${cuenta}`);
        if (!startRow || !endRow) continue;
        const label = `${cuenta} ${stretch.start}-${stretch.end}`;
        if (!paths.has(stretch.camino)) {
          track.add(file.name, endRow.fila, "ignorada", label, `tiempos-instalacion.csv ya trae tiempos del camino ${PATH_LABEL[stretch.camino]}: la hoja de la prueba solo es el respaldo`);
          continue;
        }
        const resultado = stripAccents(endRow.values.resultado).trim().toLowerCase();
        const fromColumn = endRow.values.minutos ? parseRecordNumber(endRow.values.minutos) : null;
        const start = parseRecordClock(startRow.values.hora_inicio);
        const end = parseRecordClock(endRow.values.hora_fin);
        const fromClocks = start !== null && end !== null && end > start ? (end - start) / 60 : null;
        const minutos = stretch.prefer === "minutos" ? fromColumn ?? fromClocks : fromClocks ?? fromColumn;
        const usedColumn = stretch.prefer === "minutos" ? fromColumn !== null : fromClocks === null && fromColumn !== null;
        if (resultado === "falla") {
          track.add(file.name, endRow.fila, "descartada", label, `${stretch.end} con resultado falla: no quedó listo`);
        } else if (resultado === "no aplica") {
          track.add(file.name, endRow.fila, "ignorada", label, `${stretch.end} no aplica`);
        } else if (endRow.values.minutos && fromColumn === null) {
          track.add(file.name, endRow.fila, "descartada", endRow.values.minutos, `minutos de ${stretch.end} no es un número`);
        } else if (minutos === null) {
          track.add(file.name, endRow.fila, "ignorada", label, `sin minutos en ${stretch.end} ni horas en ${stretch.start} y ${stretch.end}`);
        } else if (minutos <= 0 || minutos > 240) {
          track.add(file.name, endRow.fila, "descartada", `${formatNumber(minutos, 1)} min`, "fuera de rango (más de 0 y hasta 240 minutos)");
        } else {
          times.push({ camino: stretch.camino, minutos, ayuda: false, archivo: file.name });
          if (fromColumn !== null && fromClocks !== null && Math.abs(fromColumn - fromClocks) > 2) {
            notes.push(`${file.name}, ${label}: los minutos de ${stretch.end} (${formatNumber(fromColumn, 1)}) no coinciden con las horas (${formatNumber(fromClocks, 1)}); se usan ${usedColumn ? "los minutos" : "las horas"}.`);
          }
          track.add(file.name, endRow.fila, "usada", `${formatNumber(minutos, 1)} min (${label})`, usedColumn ? `minutos de ${stretch.end}` : `hora_inicio de ${stretch.start} a hora_fin de ${stretch.end}`);
        }
      }
    }
  }
  return { times, notes };
}

// T10: mediana de los minutos por persona hasta tener el editor por túnel con ADACEEN.
function installSource(sheetFiles: ManualRecordFile[], endToEndFiles: ManualRecordFile[], context: ManualContext): ManualKpiSource {
  const track = tracker(context, "T10");
  const fromSheet = installTimesFromSheet(sheetFiles, context, track);
  const notes = [...fromSheet.notes];
  let times = fromSheet.times;
  // El respaldo cubre cada camino que tiempos-instalacion.csv no trae (por ejemplo, solo filas de la Mac).
  const missingPaths = new Set<InstallPath>((["tunel", "mac"] as const).filter((camino) => !times.some((time) => time.camino === camino)));
  if (endToEndFiles.length && missingPaths.size) {
    const fromEndToEnd = installTimesFromEndToEnd(endToEndFiles, track, missingPaths);
    times = [...times, ...fromEndToEnd.times];
    notes.push(...fromEndToEnd.notes);
  } else {
    for (const file of endToEndFiles) track.add(file.name, null, "ignorada", "", "tiempos-instalacion.csv ya trae tiempos del túnel y de la Mac: la hoja de la prueba solo es el respaldo");
  }
  const usedFiles = [...new Set(times.map((time) => time.archivo))];
  const origin = usedFiles.length ? usedFiles : [...sheetFiles, ...endToEndFiles].map((file) => file.name);
  const tunnel = times.filter((time) => time.camino === "tunel").map((time) => time.minutos);
  const mac = times.filter((time) => time.camino === "mac").map((time) => time.minutos);
  const helped = times.filter((time) => time.ayuda).length;
  if (tunnel.length && tunnel.length < 3) notes.push(`El catálogo pide al menos 3 personas que no conozcan el proyecto; hay ${tunnel.length}.`);
  const parts: string[] = [];
  parts.push(tunnel.length
    ? `Mediana de ${formatNumber(median(tunnel), 1)} min en ${tunnel.length} ${tunnel.length === 1 ? "persona" : "personas"} por túnel (máximo ${formatNumber(Math.max(...tunnel), 1)} min)`
    : "Sin tiempos del camino por túnel");
  if (mac.length) parts.push(`Mac del laboratorio: mediana ${formatNumber(median(mac), 1)} min (n = ${mac.length})`);
  if (helped) parts.push(`${helped} con ayuda de otra persona`);
  return {
    kpi: "T10",
    value: tunnel.length ? median(tunnel) : null,
    n: tunnel.length || null,
    files: origin,
    usedRows: track.used,
    discardedRows: track.discarded,
    summary: `${parts.join("; ")}.`,
    notes,
    details: {
      tunel: { n: tunnel.length, mediana: round(median(tunnel), 1), maximo: tunnel.length ? Math.max(...tunnel) : null },
      mac: { n: mac.length, mediana: round(median(mac), 1) },
      conAyuda: helped,
    },
  };
}

const COMPLIANCE_STATES = new Map<string, "cumple" | "no cumple" | "no aplica" | "pendiente">(Object.entries({
  cumple: "cumple",
  si: "cumple",
  ok: "cumple",
  "no cumple": "no cumple",
  no: "no cumple",
  falla: "no cumple",
  "no aplica": "no aplica",
  "n/a": "no aplica",
  na: "no aplica",
  pendiente: "pendiente",
  manual: "pendiente",
  "no verificado": "pendiente",
  "": "pendiente",
} as const));

function complianceState(value: string) {
  return COMPLIANCE_STATES.get(stripAccents(String(value || "")).trim().toLowerCase().replace(/\s+/g, " "));
}

/**
 * Qué hoja de cumplimiento cuenta si hay varias: entre las que tienen algún
 * ítem marcado, la de fecha más reciente en el nombre
 * (cumplimiento-AAAA-MM-DD.csv); una hoja sin fecha, como la plantilla copiada
 * tal cual, solo gana si ninguna con ítems marcados tiene fecha. Empates: la
 * que tenga más ítems marcados y después la última por nombre. Las demás
 * quedan «ignorada» con el motivo.
 */
function pickComplianceSheet(files: ManualRecordFile[], track: ReturnType<typeof tracker>) {
  const known = new Set(COMPLIANCE_ITEMS.map((item) => item.id));
  const ranked = files.map((file) => {
    const marked = new Set<string>();
    for (const row of readSheet(file.text).rows) {
      const id = String(row.values.id || "").trim().toUpperCase();
      const state = complianceState(row.values.estado || "");
      if (!row.overflow && known.has(id) && state && state !== "pendiente") marked.add(id);
    }
    return { file, date: file.name.match(/(\d{4}-\d{2}-\d{2})/)?.[1] || "", marked: marked.size };
  });
  type Ranked = typeof ranked[number];
  const beats = (a: Ranked, b: Ranked) => {
    if ((a.marked > 0) !== (b.marked > 0)) return a.marked > 0;
    if (a.date !== b.date) return a.date > b.date;
    if (a.marked !== b.marked) return a.marked > b.marked;
    return a.file.name.localeCompare(b.file.name) > 0;
  };
  const chosen = ranked.reduce((best, entry) => (beats(entry, best) ? entry : best));
  for (const other of ranked.filter((entry) => entry !== chosen)) {
    const name = chosen.file.name;
    const reason = !other.marked && chosen.marked
      ? `sin ítems marcados; cuenta ${name}`
      : chosen.date !== other.date
        ? other.date ? `hay una hoja con fecha más reciente en el nombre: ${name}` : `sin fecha en el nombre; cuenta la hoja con fecha: ${name}`
        : chosen.marked !== other.marked
          ? `${name} tiene más ítems marcados (${chosen.marked} frente a ${other.marked})`
          : `${other.date ? "hay otra hoja del mismo día" : "hay otra hoja sin fecha"} con los mismos ítems marcados; cuenta la última por nombre: ${name}`;
    track.add(other.file.name, null, "ignorada", `${other.marked} ${other.marked === 1 ? "ítem marcado" : "ítems marcados"}`, reason);
  }
  return chosen.file;
}

// T11: ítems cumplidos / aplicables de la lista de cumplimiento, con los críticos obligatorios.
function complianceSource(files: ManualRecordFile[], context: ManualContext): ManualKpiSource {
  const track = tracker(context, "T11");
  const file = pickComplianceSheet(files, track);
  const known = new Map(COMPLIANCE_ITEMS.map((item) => [item.id, item]));
  const status = new Map<string, "cumple" | "no cumple" | "no aplica" | "pendiente">();
  const sheet = readSheet(file.text);
  const missing = missingColumns(sheet.columns, ["id", "estado"]);
  if (missing.length) {
    track.add(file.name, null, "descartada", "", `faltan columnas: ${missing.join(", ")}`);
  } else {
    for (const row of sheet.rows) {
      if (track.overflowed(file.name, row)) continue;
      const id = row.values.id.trim().toUpperCase();
      const state = complianceState(row.values.estado);
      if (!known.has(id)) {
        track.add(file.name, row.fila, "descartada", row.values.id, "ítem desconocido: no está en la lista de cumplimiento");
      } else if (status.has(id)) {
        track.add(file.name, row.fila, "descartada", id, "ítem repetido: cuenta su primera fila");
      } else if (!state) {
        track.add(file.name, row.fila, "descartada", row.values.estado, "estado no válido (cumple, no cumple, no aplica o pendiente)");
      } else {
        status.set(id, state);
        track.add(file.name, row.fila, state === "pendiente" ? "ignorada" : "usada", `${id} ${state}`, state === "pendiente" ? "sin marcar: cuenta como no cumplido" : known.get(id)?.critical ? "ítem crítico" : "ítem");
      }
    }
  }
  const marked = [...status.values()].filter((state) => state !== "pendiente").length;
  const states = COMPLIANCE_ITEMS.map((item) => ({ item, state: status.get(item.id) || "pendiente" }));
  const applicable = states.filter((entry) => entry.state !== "no aplica");
  const met = applicable.filter((entry) => entry.state === "cumple");
  const notApplicable = states.length - applicable.length;
  const pending = applicable.filter((entry) => entry.state === "pendiente").map((entry) => entry.item.id);
  const failed = applicable.filter((entry) => entry.state === "no cumple").map((entry) => entry.item.id);
  const criticalNotMet = applicable.filter((entry) => entry.item.critical && entry.state !== "cumple").map((entry) => entry.item.id);
  const value = marked && applicable.length ? (met.length / applicable.length) * 100 : null;
  return {
    kpi: "T11",
    value,
    n: marked ? applicable.length : null,
    files: [file.name],
    usedRows: track.used,
    discardedRows: track.discarded,
    summary: marked
      ? `${met.length} de ${applicable.length} ítems aplicables cumplen (${notApplicable} no ${notApplicable === 1 ? "aplica" : "aplican"})${failed.length ? `; no cumplen: ${listText(failed)}` : ""}${pending.length ? `; sin marcar: ${listText(pending)}` : ""}; críticos sin cumplir: ${criticalNotMet.length ? listText(criticalNotMet) : "ninguno"}.`
      : "La hoja de cumplimiento no tiene ningún ítem marcado.",
    notes: [],
    blocking: marked && criticalNotMet.length ? `ítems críticos sin cumplir (${listText(criticalNotMet)}), obligatorios aunque el total pase el umbral` : null,
    details: { cumplidos: met.length, aplicables: applicable.length, noAplican: notApplicable, pendientes: pending, noCumplen: failed, criticosSinCumplir: criticalNotMet },
  };
}

const FINDING_STATES = new Map<string, string>(Object.entries({
  implementada: "implementada",
  implementado: "implementada",
  hecha: "implementada",
  pendiente: "pendiente",
  "en curso": "en curso",
  en_curso: "en curso",
  descartada: "descartada",
}));

// P5: mejoras críticas implementadas / identificadas en los hallazgos (A14.5).
function findingsSource(files: ManualRecordFile[], context: ManualContext, findings: ManualFinding[]): ManualKpiSource {
  const track = tracker(context, "P5");
  const known = new Set(KPI_CATALOG.map((kpi) => kpi.id));
  const seen = new Set<string>();
  const notes: string[] = [];
  for (const file of files) {
    const sheet = readSheet(file.text);
    const missing = missingColumns(sheet.columns, ["id", "critica", "estado"]);
    if (missing.length) {
      track.add(file.name, null, "descartada", "", `faltan columnas: ${missing.join(", ")}`);
      continue;
    }
    for (const row of sheet.rows) {
      if (track.overflowed(file.name, row)) continue;
      const id = row.values.id.trim();
      const critica = parseYesNo(row.values.critica);
      const estado = FINDING_STATES.get(stripAccents(row.values.estado).trim().toLowerCase().replace(/\s+/g, " "));
      const kpis = String(row.values.kpis || "").split(/[;,\s]+/).map((value) => value.trim().toUpperCase()).filter(Boolean);
      const unknown = kpis.filter((kpi) => !known.has(kpi));
      if (!id) {
        track.add(file.name, row.fila, "descartada", "", "falta id del hallazgo (H1, H2…)");
      } else if (seen.has(id.toUpperCase())) {
        track.add(file.name, row.fila, "descartada", id, "hallazgo repetido: cuenta su primera fila");
      } else if (critica === null || critica === undefined) {
        track.add(file.name, row.fila, "descartada", row.values.critica, "critica debe ser si o no");
      } else if (!estado) {
        track.add(file.name, row.fila, "descartada", row.values.estado, "estado no válido (implementada, en curso, pendiente o descartada)");
      } else {
        seen.add(id.toUpperCase());
        if (unknown.length) notes.push(`${file.name}, fila ${row.fila}: KPIs desconocidos ${unknown.join(", ")}.`);
        findings.push({ id, hallazgo: row.values.hallazgo || "", kpis: kpis.filter((kpi) => known.has(kpi)), critica, estado, accion: row.values.accion || "" });
        track.add(file.name, row.fila, "usada", `${id} ${critica ? "crítico" : "no crítico"} ${estado}`, critica ? (estado === "implementada" ? "mejora crítica implementada" : "mejora crítica sin implementar") : "no crítico: solo trazabilidad");
      }
    }
  }
  const critical = findings.filter((finding) => finding.critica);
  const done = critical.filter((finding) => finding.estado === "implementada");
  const open = critical.filter((finding) => finding.estado !== "implementada").map((finding) => finding.id);
  return {
    kpi: "P5",
    value: critical.length ? (done.length / critical.length) * 100 : null,
    n: critical.length || null,
    files: files.map((file) => file.name),
    usedRows: track.used,
    discardedRows: track.discarded,
    summary: critical.length
      ? `${done.length} de ${critical.length} mejoras críticas implementadas (${findings.length} hallazgos en la hoja)${open.length ? `; sin implementar: ${listText(open)}` : ""}.`
      : findings.length ? `Ningún hallazgo marcado como crítico (${findings.length} en la hoja).` : "Ningún hallazgo válido.",
    notes,
    details: { criticos: critical.length, implementados: done.length, sinImplementar: open },
  };
}

function templateOf(name: string) {
  const lower = name.toLowerCase();
  const template = MANUAL_TEMPLATES.find((item) => lower.startsWith(item.prefix) && lower.endsWith(".csv"));
  if (template) return { kpi: template.kpi, kind: template.prefix };
  const extra = MANUAL_EXTRA_SOURCES.find((item) => lower.startsWith(item.prefix) && lower.endsWith(item.extension));
  return extra ? { kpi: extra.kpi, kind: extra.prefix } : null;
}

/**
 * Lee las plantillas llenas (por nombre de archivo, ver MANUAL_TEMPLATES y
 * MANUAL_EXTRA_SOURCES), valida cada fila y calcula T7, T8, T10, T11 y P5.
 * sessionDates (fechas del plan) filtra los incidentes de T7 y las pruebas de
 * humo de T8, y avisa de las sesiones sin registro. Los archivos que no
 * reconoce quedan en unrecognized.
 */
export function readManualRecords(files: ManualRecordFile[], options: { sessionDates?: string[]; timeZone?: string } = {}): ManualRecordsResult {
  const context: ManualContext = {
    trace: [],
    sessionDates: [...new Set(options.sessionDates || [])].sort(),
    timeZone: options.timeZone || "America/Bogota",
  };
  const byKind = new Map<string, ManualRecordFile[]>();
  const unrecognized: string[] = [];
  for (const file of [...files].sort((a, b) => a.name.localeCompare(b.name))) {
    const match = templateOf(file.name);
    if (!match) {
      unrecognized.push(file.name);
      context.trace.push({ kpi: "", archivo: file.name, fila: null, estado: "ignorada", valor: "", motivo: "no es una plantilla conocida" });
      continue;
    }
    byKind.set(match.kind, [...(byKind.get(match.kind) || []), file]);
  }
  const of = (kind: string) => byKind.get(kind) || [];
  const findings: ManualFinding[] = [];
  const sources: Partial<Record<ManualKpiId, ManualKpiSource>> = {};
  if (of("registro-incidentes").length) sources.T7 = incidentsSource(of("registro-incidentes"), context);
  if (of("pruebas-humo").length || of("demo-escenarios").length) sources.T8 = smokeSource(of("pruebas-humo"), of("demo-escenarios"), context);
  if (of("tiempos-instalacion").length || of("prueba-inicio-a-fin").length) sources.T10 = installSource(of("tiempos-instalacion"), of("prueba-inicio-a-fin"), context);
  if (of("cumplimiento").length) sources.T11 = complianceSource(of("cumplimiento"), context);
  if (of("hallazgos").length) sources.P5 = findingsSource(of("hallazgos"), context, findings);
  const rank = (kpi: ManualKpiId | "") => (kpi ? MANUAL_KPI_IDS.indexOf(kpi) : MANUAL_KPI_IDS.length);
  const rows = context.trace
    .map((row, index) => ({ row, index }))
    .sort((a, b) => rank(a.row.kpi) - rank(b.row.kpi) || a.row.archivo.localeCompare(b.row.archivo) || (a.row.fila ?? 0) - (b.row.fila ?? 0) || a.index - b.index)
    .map((item) => item.row);
  return { sources, rows, findings, unrecognized };
}

/** registros-manuales.csv: una fila por fila leída (o por archivo) con lo que se hizo con ella. */
export function manualRecordsCsv(rows: ManualRowTrace[]) {
  return toCsvText(["kpi", "archivo", "fila", "estado", "valor", "motivo"], rows.map((row) => ({ ...row, fila: row.fila ?? "" })));
}

/**
 * Plantillas vacías de data/piloto/plantillas/ (la de cumplimiento trae los
 * ítems de la lista). Las escribe npm run piloto:analisis -- --escribir-plantillas.
 */
export function renderManualTemplates(): Array<{ file: string; text: string }> {
  return MANUAL_TEMPLATES.map((template) => {
    if (template.kpi !== "T11") return { file: template.file, text: toCsvText(template.columns, []) };
    return {
      file: template.file,
      text: toCsvText(template.columns, COMPLIANCE_ITEMS.map((item) => ({
        id: item.id,
        area: item.area,
        item: item.item,
        critico: item.critical ? "si" : "no",
        verificacion: item.verification,
      }))),
    };
  });
}

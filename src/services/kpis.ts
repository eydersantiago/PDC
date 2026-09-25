import { EVENT_CATALOG } from "./telemetry-catalog.js";
import { KPI_CATALOG, findKpi, meetsThreshold, type KpiDefinition, type KpiDimension } from "./kpi-catalog.js";
import { mannWhitneyU, median, percentile, round, wilcoxonSignedRank, type WilcoxonResult } from "./stats.js";
import { personMean, susScore, type SurveyResponse } from "./survey.js";
import { analyzeTelemetryDataset, type TelemetryEventRow } from "./telemetry.js";

/**
 * Calculo de los KPIs del piloto (A3.3, A14.4) con las definiciones de
 * src/services/kpi-catalog.ts. Lo usan el endpoint GET /api/telemetry/kpis
 * (en vivo, solo telemetria), npm run piloto:analisis (informe final con
 * encuesta, asistencia y registros) y el ensayo tecnico simulado.
 *
 * Cada resultado trae una frase de lectura automatica: dice el valor, el n y
 * si cumple el umbral. La interpretacion pedagogica la escribe el autor.
 */

export type KpiManualValues = Partial<Record<"T7" | "T8" | "T10" | "T11" | "P5", number | null>>;

export type KpiContext = {
  rows: TelemetryEventRow[];
  survey?: SurveyResponse[] | null;
  /** Presentes por fecha (AAAA-MM-DD, hora de Colombia). */
  attendance?: Array<{ fecha: string; presentes: number }> | null;
  /** Estudiantes que firmaron el consentimiento. */
  participants?: number | null;
  quizzes?: Array<{ correct: boolean | null }> | null;
  manual?: KpiManualValues | null;
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

function latencyKpis(rows: TelemetryEventRow[]) {
  const latencies = latencyRows(rows);
  const seconds = latencies.map((row) => (row.latencyMs as number) / 1000);
  const byChannel: Record<string, { n: number; p50: number | null; p95: number | null }> = {};
  for (const channel of [...new Set(latencies.map((row) => row.channel))].sort()) {
    const values = latencies.filter((row) => row.channel === channel).map((row) => (row.latencyMs as number) / 1000);
    byChannel[channel] = { n: values.length, p50: round(percentile(values, 50), 2), p95: round(percentile(values, 95), 2) };
  }
  const channels = Object.entries(byChannel).map(([channel, data]) => `${channel}: ${formatNumber(data.p50, 1)} s (n = ${data.n})`).join("; ");
  const p50 = percentile(seconds, 50);
  const p95 = percentile(seconds, 95);
  return [
    result("T1", p50, seconds.length, seconds.length
      ? `Mediana de ${formatNumber(p50, 1)} s en ${seconds.length} respuestas del modelo${channels ? ` (${channels})` : ""}.`
      : "Sin respuestas del modelo en la ventana.", { byChannel }),
    result("T2", p95, seconds.length, seconds.length
      ? `Percentil 95 de ${formatNumber(p95, 1)} s en ${seconds.length} respuestas.`
      : "Sin respuestas del modelo en la ventana.", { byChannel }),
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

function manualKpi(id: "T7" | "T8" | "T10" | "T11" | "P5", manual: KpiManualValues | null | undefined) {
  const kpi = findKpi(id);
  const value = manual?.[id];
  if (value === null || value === undefined || !Number.isFinite(value)) {
    return result(id, null, null, `Se registra a mano (${kpi.sources.join(", ")}): ${kpi.formula}`);
  }
  return result(id, value, null, `Valor registrado: ${formatValue(value, kpi.unit)}.`);
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
    manualKpi("T7", context.manual),
    manualKpi("T8", context.manual),
    anchoringKpi(rows),
    manualKpi("T10", context.manual),
    manualKpi("T11", context.manual),
    catalogKpi(),
    ...surveyKpis(context.survey, context.participants),
    ...feedbackKpis(rows),
    ...unblocking.results,
    participationKpi(rows, context.participants),
    manualKpi("P5", context.manual),
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

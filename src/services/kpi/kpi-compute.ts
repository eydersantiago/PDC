// KPIs: calcular los KPI desde la telemetria (latencia, disponibilidad, desbloqueo, participacion, quices...).
// Movido sin cambios desde src/services/kpi/kpis.ts (solo se agrego "export" y los imports); src/services/kpi/kpis.ts lo reexporta.
import { KPI_CATALOG, findKpi } from "./kpi-catalog.js";
import { MANUAL_TEMPLATES, dayKey } from "./kpi-manual-parse.js";
import type { ManualKpiSource, ManualTemplate } from "./kpi-manual-parse.js";
import { median, percentile, round } from "../analytics/stats.js";
import { personMean, susScore } from "../pilot/survey.js";
import type { SurveyResponse } from "../pilot/survey.js";
import { EVENT_CATALOG, GUARDRAIL_TRUNCATION_REASON, LEGACY_TRUNCATION_REASON } from "../telemetry/telemetry-catalog.js";
import { analyzeTelemetryDataset } from "../telemetry/telemetry-dataset.js";
import type { TelemetryEventRow } from "../telemetry/telemetry.js";
import { describeWorker } from "../queue/worker-identity.js";
import { metadataValue, latencyRows, formatNumber, result, isModelDecision, FALLBACK_SOURCES, type KpiContext, COURSE_EVENTS, type ManualKpiId, type KpiManualValues, formatValue, type KpiResult } from "./kpi-format.js";
import { unblockingKpis } from "./kpi-unblocking.js";

/**
 * Calculo de los KPIs del piloto (A3.3, A14.4) con las definiciones de
 * src/services/kpi/kpi-catalog.ts. Lo usan el endpoint GET /api/telemetry/kpis
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

// --- Calculo por KPI ------------------------------------------------------------

/** Servidor de inferencia que respondio la decision (metadata.worker), para comparar Google Cloud y las Mac. */
export function inferenceServerOf(row: TelemetryEventRow) {
  const id = String(metadataValue(row, "worker") || "").trim();
  return id ? describeWorker(id).label : "sin dato";
}

export function latencyGroups(latencies: TelemetryEventRow[], keyOf: (row: TelemetryEventRow) => string) {
  const groups: Record<string, { n: number; p50: number | null; p95: number | null }> = {};
  for (const key of [...new Set(latencies.map(keyOf))].sort()) {
    const values = latencies.filter((row) => keyOf(row) === key).map((row) => (row.latencyMs as number) / 1000);
    groups[key] = { n: values.length, p50: round(percentile(values, 50), 2), p95: round(percentile(values, 95), 2) };
  }
  return groups;
}

export function latencyKpis(rows: TelemetryEventRow[]) {
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

export function availabilityKpi(rows: TelemetryEventRow[]) {
  const attempts = rows.filter(isModelDecision);
  const failures = attempts.filter((row) => row.reasonCode === "model_error_fallback"
    || FALLBACK_SOURCES.has(String(metadataValue(row, "source") || "")));
  const value = attempts.length ? (1 - failures.length / attempts.length) * 100 : null;
  return result("T3", value, attempts.length, attempts.length
    ? `${attempts.length - failures.length} de ${attempts.length} ayudas llegaron del modelo; ${failures.length} salieron por el respaldo (sin worker o con falla).`
    : "Sin ayudas que llamaran al modelo en la ventana.");
}

export function integrityKpis(rows: TelemetryEventRow[]) {
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

export function telemetryCoverageKpi(rows: TelemetryEventRow[], attendance: KpiContext["attendance"], timeZone: string) {
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

export function anchoringKpi(rows: TelemetryEventRow[]) {
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

export function catalogKpi() {
  const useful = EVENT_CATALOG.filter((entry) => entry.kpis.length > 0).length;
  return result("T12", useful, EVENT_CATALOG.length, `${useful} de ${EVENT_CATALOG.length} eventos del catálogo alimentan algún KPI.`);
}

export function sourceText(source: ManualKpiSource) {
  const rows = `${source.usedRows} ${source.usedRows === 1 ? "fila usada" : "filas usadas"}${source.discardedRows ? `, ${source.discardedRows} ${source.discardedRows === 1 ? "descartada" : "descartadas"}` : ""}`;
  return `Fuente: ${source.files.join(", ")} (${rows}; detalle en registros-manuales.csv).`;
}

/**
 * KPI manual: primero la plantilla llena (con su trazado), si no el plan del
 * piloto. Si los dos tienen valor y no coinciden, gana la plantilla y se avisa.
 */
export function manualKpi(id: ManualKpiId, manual: KpiManualValues | null | undefined, source: ManualKpiSource | null | undefined) {
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

export function surveyKpis(survey: SurveyResponse[] | null | undefined, participants: number | null | undefined) {
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

export function feedbackKpis(rows: TelemetryEventRow[]) {
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

export function participationKpi(rows: TelemetryEventRow[], participants: number | null | undefined) {
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

/**
 * metadata.reason de una decision cuyo codigo recorto el guardarrail por el tope de la etapa: el
 * recorte aplicable, el de guia (30-10-2026) y el de antes (codigo_recortado, en la telemetria
 * historica). Una respuesta cortada del modelo (codigo_incompleto_guia) no es un recorte de la
 * politica: se cuenta aparte (incompleteReplies).
 */
const TRUNCATION_REASONS = new Set<string>([
  GUARDRAIL_TRUNCATION_REASON.applicable,
  GUARDRAIL_TRUNCATION_REASON.guide,
  LEGACY_TRUNCATION_REASON,
]);

export function antiSolutionKpi(rows: TelemetryEventRow[], report: ReturnType<typeof analyzeTelemetryDataset>) {
  const applied = rows.filter((row) => row.eventType === "suggestion_completion_applied").length;
  const unchecked = report.integrity.I6_aplicada_sin_verificar.count;
  const truncated = rows.filter((row) => row.eventType === "tutor_decision" && TRUNCATION_REASONS.has(String(metadataValue(row, "reason") ?? ""))).length;
  const incompleteReplies = rows.filter((row) => row.eventType === "tutor_decision" && metadataValue(row, "reason") === GUARDRAIL_TRUNCATION_REASON.incomplete).length;
  const checks = rows.filter((row) => row.eventType === "code_application_checked");
  const blockedChecks = checks.filter((row) => row.blocked === true).length;
  return result("P6", applied ? (1 - unchecked / applied) * 100 : null, applied || null, applied
    ? `${applied - unchecked} de ${applied} cambios aplicados pasaron por la verificación; el guardarraíl recortó ${truncated} respuestas y la política negó ${blockedChecks} de ${checks.length} aplicaciones.`
    : `Sin cambios aplicados en la ventana; el guardarraíl recortó ${truncated} respuestas.`, { applied, unchecked, truncated, incompleteReplies, checks: checks.length, blockedChecks });
}

export function interventionUseKpi(rows: TelemetryEventRow[]) {
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

export function quizKpi(quizzes: KpiContext["quizzes"]) {
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


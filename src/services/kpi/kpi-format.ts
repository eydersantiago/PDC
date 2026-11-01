// KPIs: tipos, formato en espanol, veredicto y filas de decisiones del modelo; base de kpi-compute.ts y kpi-unblocking.ts.
import { findKpi, meetsThreshold } from "./kpi-catalog.js";
import type { KpiDefinition, KpiDimension } from "./kpi-catalog-types.js";
import type { ManualKpiSource } from "./kpi-manual-parse.js";
import { round } from "../analytics/stats.js";
import type { SurveyResponse } from "../pilot/survey.js";
import type { TelemetryEventRow } from "../telemetry/telemetry.js";

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

export const NON_MODEL_SOURCES = new Set(["cache", "deterministic", "policy"]);

export const FALLBACK_SOURCES = new Set(["degraded", "heuristic"]);

export const COURSE_EVENTS = new Set(["compile_error", "runtime_error", "concept_question", "design_block", "code_suggestion"]);

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

export function formatP(p: number | null) {
  if (p === null) return "sin dato";
  if (p < 0.001) return "< 0,001";
  return formatNumber(p, 3);
}

export function verdict(kpi: KpiDefinition, value: number | null) {
  const meets = meetsThreshold(kpi, value);
  if (meets === null) return kpi.threshold ? "" : " KPI descriptivo, sin umbral.";
  return meets ? ` Cumple el umbral (${kpi.thresholdText}).` : ` No cumple el umbral (${kpi.thresholdText}).`;
}

export function result(id: string, value: number | null, n: number | null, summary: string, details?: Record<string, unknown>): KpiResult {
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

export function metadataValue(row: TelemetryEventRow, key: string) {
  return (row.metadata || {})[key];
}

export function isModelDecision(row: TelemetryEventRow) {
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

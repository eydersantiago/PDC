// Catalogo de KPIs: KPI_CATALOG es la union, en orden, de los tecnicos, los de experiencia de uso y los pedagogicos.
import { type KpiDimension, type KpiSource, type KpiDefinition } from "./kpi-catalog-types.js";
import { TECHNICAL_KPIS } from "./kpi-catalog-technical.js";
import { UX_KPIS } from "./kpi-catalog-ux.js";
import { PEDAGOGICAL_KPIS } from "./kpi-catalog-pedagogical.js";

/**
 * Catálogo de KPIs del piloto (A3.1 técnicos, A3.2 UX y pedagógicos, A3.3
 * operacionalización, A3.5 umbrales y A3.6 reporte).
 *
 * Es la fuente de verdad: `src/services/kpi/kpis.ts` calcula los automáticos con
 * estas definiciones y `npm run kpis:catalogo` genera
 * `docs/metricas/catalogo-kpis.md`. Si cambia un umbral, se cambia aquí.
 *
 * Regla para las contradicciones del anteproyecto: manda la sección 5.4, que
 * es la tabla de KPIs (latencia ≤ 8 s y no ≤ 10 s; mejoras ≥ 65 % y no ≥ 70 %).
 * Los umbrales «propuestos» no están en el anteproyecto y los aprueba el
 * director antes del piloto (A3.5, A5.7).
 */

export const KPI_DIMENSION_LABEL: Record<KpiDimension, string> = {
  tecnico: "Técnicos",
  ux: "Experiencia de uso (UX)",
  pedagogico: "Pedagógicos",
};

export const KPI_SOURCE_LABEL: Record<KpiSource, string> = {
  telemetria: "telemetría (telemetry_events)",
  encuesta: "encuesta final (A13.2)",
  asistencia: "lista de asistencia y consentimientos",
  registro: "registro manual",
  pruebas: "pruebas de humo",
  catalogo: "catálogo de eventos",
  quices: "intentos del mini-quiz",
};

export const KPI_CATALOG: KpiDefinition[] = [
  ...TECHNICAL_KPIS,
  ...UX_KPIS,
  ...PEDAGOGICAL_KPIS,
];

const KPI_BY_ID = new Map(KPI_CATALOG.map((kpi) => [kpi.id, kpi]));

export function findKpi(id: string) {
  const kpi = KPI_BY_ID.get(id);
  if (!kpi) throw new Error(`KPI desconocido: ${id}`);
  return kpi;
}

/** Compara un valor con el umbral; null si el KPI es descriptivo o no hay valor. */
export function meetsThreshold(kpi: Pick<KpiDefinition, "threshold">, value: number | null) {
  if (!kpi.threshold || value === null || !Number.isFinite(value)) return null;
  const { op, value: target } = kpi.threshold;
  if (op === "<=") return value <= target + 1e-9;
  if (op === ">=") return value >= target - 1e-9;
  return Math.abs(value - target) < 1e-9;
}

/**
 * Qué se mira y cada cuánto (A3.6). El monitor y el informe usan estas
 * mismas listas.
 */
export const KPI_REPORT_PLAN = [
  {
    moment: "Durante cada sesión (monitor, cada 30 s)",
    how: "npm run piloto:monitor",
    kpis: ["T1", "T3", "T4", "T5"],
    extra: "Worker vivo, estudiantes activos en los últimos 5 minutos, eventos por minuto, bloque vigente y alertas.",
  },
  {
    moment: "Al cerrar cada sesión",
    how: "npm run piloto:dataset y npm run piloto:analisis sobre la fecha",
    kpis: ["T1", "T2", "T3", "T4", "T5", "T6", "T9", "P2", "P7"],
    extra: "Informe corto de la sesión para ajustar la siguiente (sin cambiar el tutor a mitad del piloto).",
  },
  {
    moment: "Al terminar el piloto",
    how: "npm run piloto:analisis con la encuesta y el plan",
    kpis: KPI_CATALOG.map((kpi) => kpi.id),
    extra: "Informe completo con gráficas, trazabilidad KPI → hallazgo → evidencia y los KPIs manuales.",
  },
];

// Catalogo de KPIs: tipos de una definicion (dimension, fuente, objetivo y umbral).

export type KpiDimension = "tecnico" | "ux" | "pedagogico";

export type KpiSource = "telemetria" | "encuesta" | "asistencia" | "registro" | "pruebas" | "catalogo" | "quices";

export type KpiObjective = "OE1" | "OE2" | "OE3";

export type KpiThreshold = {
  op: "<=" | ">=" | "=";
  value: number;
};

export type KpiDefinition = {
  id: string;
  name: string;
  dimension: KpiDimension;
  objective: KpiObjective;
  /** Uno de los KPI principales del anteproyecto (al menos uno por dimensión). */
  primary: boolean;
  question: string;
  formula: string;
  unit: string;
  window: string;
  sources: KpiSource[];
  events: string[];
  /** null: KPI descriptivo, se reporta sin umbral. */
  threshold: KpiThreshold | null;
  thresholdText: string;
  origin: string;
  /** Decisión tomada al operacionalizar (contradicciones, línea base, exclusiones). */
  decision: string;
  /** Se calcula solo con npm run piloto:analisis; si no, se registra a mano. */
  automatic: boolean;
  /** Cómo se muestra en el reporte (A3.6). */
  chart: string;
  jira: string[];
};

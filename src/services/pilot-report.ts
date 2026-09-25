import { z } from "zod";
import { KPI_CATALOG, KPI_DIMENSION_LABEL, findKpi } from "./kpi-catalog.js";
import {
  formatNumber,
  formatValue,
  latencyRows,
  type KpiManualValues,
  type KpiResult,
  type UnblockingComparison,
  type UnblockingEpisode,
} from "./kpis.js";
import { barsSvg, boxPlotSvg, CONDITION_COLORS, histogramSvg, likertSvg, pairedDotsSvg } from "./svg-charts.js";
import { susScore, type SurveyResponse } from "./survey.js";
import type { TelemetryEventRow } from "./telemetry.js";

/**
 * Informe del piloto (A14.4) y trazabilidad KPI -> hallazgo -> evidencia
 * (A14.7). Lo arma npm run piloto:analisis a partir del dataset limpio, la
 * encuesta y el plan del piloto.
 */

// --- Plan del piloto ----------------------------------------------------------

const planSchema = z.object({
  nombre: z.string().trim().min(1).max(200),
  participantesConConsentimiento: z.number().int().min(0).max(10000).nullable().default(null),
  zonaHoraria: z.string().trim().max(60).default("America/Bogota"),
  sesiones: z.array(z.object({
    fecha: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "fecha AAAA-MM-DD"),
    grupo: z.string().trim().max(60).optional(),
    presentes: z.number().int().min(0).max(10000),
    notas: z.string().max(500).optional(),
  })).default([]),
  cuentasPrueba: z.array(z.string().trim().email()).default([]),
  registros: z.object({
    T7: z.number().nullable().optional(),
    T8: z.number().nullable().optional(),
    T10: z.number().nullable().optional(),
    T11: z.number().nullable().optional(),
    P5: z.number().nullable().optional(),
  }).default({}),
}).passthrough();

export type PilotPlan = z.infer<typeof planSchema>;

/** Tabla de latencia por servidor de inferencia (Google Cloud, Mac del laboratorio): solo si hay dato. */
function latencyByServerTable(raw: unknown) {
  const byServer = (raw || {}) as Record<string, { n: number; p50: number | null; p95: number | null }>;
  const entries = Object.entries(byServer).filter(([server]) => server !== "sin dato");
  if (!entries.length) return [];
  return [
    "| Servidor de inferencia | Respuestas | Mediana (s) | p95 (s) |",
    "|---|---|---|---|",
    ...entries.map(([server, data]) => `| ${server} | ${data.n} | ${formatNumber(data.p50, 1)} | ${formatNumber(data.p95, 1)} |`),
    "",
    "Los servidores pueden ser GPUs de Google Cloud o Mac del laboratorio con Ollama: si responden distinto, la latencia del piloto depende de cuáles estaban encendidos.",
    "",
  ];
}

export function parsePilotPlan(text: string): PilotPlan {
  const raw = JSON.parse(String(text || "{}"));
  return planSchema.parse(raw);
}

export function manualValuesFromPlan(plan: PilotPlan | null): KpiManualValues {
  if (!plan) return {};
  const registros = plan.registros || {};
  return { T7: registros.T7 ?? null, T8: registros.T8 ?? null, T10: registros.T10 ?? null, T11: registros.T11 ?? null, P5: registros.P5 ?? null };
}

// --- Graficas -----------------------------------------------------------------

export type ChartFile = { file: string; title: string; svg: string; kpis: string[] };

function likertCounts(responses: SurveyResponse[], block: "ux" | "pa", prefix: string) {
  const length = responses[0]?.[block].length || (block === "ux" ? 6 : 5);
  return Array.from({ length }, (_, index) => {
    const counts = [0, 0, 0, 0, 0];
    for (const response of responses) {
      const value = response[block][index];
      if (value !== null && value >= 1 && value <= 5) counts[value - 1] += 1;
    }
    return { label: `${prefix}${index + 1}`, counts };
  });
}

export function buildPilotCharts(input: {
  rows: TelemetryEventRow[];
  kpis: KpiResult[];
  comparison: UnblockingComparison;
  episodes: UnblockingEpisode[];
  survey: SurveyResponse[] | null;
}): ChartFile[] {
  const charts: ChartFile[] = [];
  if (input.comparison.pairedStudents) {
    charts.push({
      file: "p1-pareado.svg",
      title: "Tiempo hasta desbloqueo por estudiante (mediana, s)",
      kpis: ["P1"],
      svg: pairedDotsSvg({
        title: "Tiempo hasta desbloqueo por estudiante (mediana, s)",
        unit: "segundos",
        leftLabel: "Sin tutor",
        rightLabel: "Con tutor",
        pairs: input.comparison.perStudent.map((item) => ({ left: item.withoutTutorS, right: item.withTutorS, group: item.cohort })),
      }),
    });
  }
  const resolvedEpisodes = input.episodes.filter((episode) => episode.resolved && !episode.crossesBlock && episode.durationMs !== null);
  if (resolvedEpisodes.length) {
    charts.push({
      file: "p1-caja.svg",
      title: "Duración de los episodios de bloqueo por condición (s)",
      kpis: ["P1", "P2"],
      svg: boxPlotSvg({
        title: "Duración de los episodios de bloqueo por condición (s)",
        unit: "segundos",
        groups: [
          { label: "Sin tutor", values: resolvedEpisodes.filter((episode) => episode.condition === "sin_tutor").map((episode) => (episode.durationMs as number) / 1000), color: CONDITION_COLORS.sin_tutor },
          { label: "Con tutor", values: resolvedEpisodes.filter((episode) => episode.condition === "con_tutor").map((episode) => (episode.durationMs as number) / 1000), color: CONDITION_COLORS.con_tutor },
        ],
      }),
    });
  }
  const latencies = latencyRows(input.rows);
  if (latencies.length) {
    const channels = [...new Set(latencies.map((row) => row.channel))].sort();
    charts.push({
      file: "t1-latencia.svg",
      title: "Latencia del tutor por canal (s)",
      kpis: ["T1", "T2"],
      svg: boxPlotSvg({
        title: "Latencia del tutor por canal (s)",
        unit: "segundos",
        groups: channels.map((channel) => ({
          label: channel === "vscode" ? "VS Code" : channel === "overlay" ? "Overlay" : channel,
          values: latencies.filter((row) => row.channel === channel).map((row) => (row.latencyMs as number) / 1000),
          color: channel === "vscode" ? "#2563eb" : "#0f766e",
        })),
      }),
    });
  }
  if (input.survey?.length) {
    charts.push({
      file: "u1-likert.svg",
      title: "Experiencia de uso del tutor (UX1 a UX6)",
      kpis: ["U1"],
      svg: likertSvg({ title: "Experiencia de uso del tutor (UX1 a UX6)", items: likertCounts(input.survey, "ux", "UX") }),
    });
    charts.push({
      file: "p4-likert.svg",
      title: "Percepción de apoyo al aprendizaje (PA1 a PA5)",
      kpis: ["P4"],
      svg: likertSvg({ title: "Percepción de apoyo al aprendizaje (PA1 a PA5)", items: likertCounts(input.survey, "pa", "PA") }),
    });
    const sus = input.survey.map((response) => susScore(response.sus)).filter((value): value is number => value !== null);
    if (sus.length) {
      charts.push({
        file: "u2-sus.svg",
        title: "Puntajes SUS",
        kpis: ["U2"],
        svg: histogramSvg({ title: "Puntajes SUS", unit: "puntaje SUS", values: sus, min: 0, max: 100, step: 10, reference: { value: 68, label: "referencia 68" } }),
      });
    }
  }
  const p7 = input.kpis.find((kpi) => kpi.id === "P7");
  const byStage = (p7?.details?.byStage || {}) as Record<string, number>;
  if (Object.keys(byStage).length) {
    const stageLabel: Record<string, string> = {
      hint_1: "Pista 1",
      hint_2: "Pista 2",
      partial_example: "Ejemplo parcial",
      explanation: "Explicación",
      mini_quiz: "Mini-quiz",
      controlled: "Mensaje controlado",
    };
    charts.push({
      file: "p7-etapas.svg",
      title: "Decisiones del tutor por etapa de ayuda",
      kpis: ["P7"],
      svg: barsSvg({
        title: "Decisiones del tutor por etapa de ayuda",
        unit: "",
        bars: Object.entries(byStage).sort((a, b) => b[1] - a[1]).map(([stage, count]) => ({ label: stageLabel[stage] || stage, value: count })),
      }),
    });
  }
  const t6 = input.kpis.find((kpi) => kpi.id === "T6");
  const perSession = (t6?.details?.perSession || []) as Array<{ fecha: string; presentes: number; conTelemetria: number }>;
  if (perSession.length) {
    charts.push({
      file: "t6-sesiones.svg",
      title: "Estudiantes con telemetría por sesión",
      kpis: ["T6"],
      svg: barsSvg({
        title: "Estudiantes con telemetría por sesión",
        unit: "",
        bars: perSession.flatMap((session) => [
          { label: `${session.fecha} presentes`, value: session.presentes, color: "#94a3b8" },
          { label: `${session.fecha} con telemetría`, value: Math.min(session.conTelemetria, session.presentes), color: "#2563eb" },
        ]),
      }),
    });
  }
  return charts;
}

// --- Trazabilidad (A14.7) -------------------------------------------------------

export type TraceabilityRow = {
  kpi: string;
  nombre: string;
  objetivo: string;
  umbral: string;
  valor: string;
  cumple: string;
  evidencia: string;
  hallazgo: string;
  accion: string;
};

export function buildTraceability(kpis: KpiResult[], charts: ChartFile[]): TraceabilityRow[] {
  return kpis.map((result) => {
    const kpi = findKpi(result.id);
    const files = charts.filter((chart) => chart.kpis.includes(result.id)).map((chart) => `graficas/${chart.file}`);
    const evidence = [
      "informe-kpis.md",
      "kpis.csv",
      ...files,
      ...(kpi.sources.includes("telemetria") ? ["dataset.csv"] : []),
      ...(kpi.sources.includes("encuesta") ? ["encuesta (archivo de Forms)"] : []),
      ...(kpi.automatic ? [] : ["registro en el plan del piloto"]),
    ];
    return {
      kpi: result.id,
      nombre: result.name,
      objetivo: kpi.objective,
      umbral: result.thresholdText,
      valor: formatValue(result.value, result.unit),
      cumple: result.meets === null ? "—" : result.meets ? "Sí" : "No",
      evidencia: evidence.join("; "),
      hallazgo: "",
      accion: "",
    };
  });
}

// --- Informe ------------------------------------------------------------------

function cell(value: unknown) {
  return String(value ?? "").replace(/\|/g, "\\|").replace(/\n/g, " ");
}

function meetsText(result: KpiResult) {
  if (result.meets === null) return result.value === null ? "—" : "Descriptivo";
  return result.meets ? "Sí" : "**No**";
}

function warnings(kpis: KpiResult[], comparison: UnblockingComparison, cleaning: { anonymousClientSessions?: number } | null) {
  const out: string[] = [];
  const byId = new Map(kpis.map((kpi) => [kpi.id, kpi]));
  if (comparison.pairedStudents > 0 && comparison.pairedStudents < 10) {
    out.push(`P1 se calcula con ${comparison.pairedStudents} estudiantes pareados: con menos de 10 pares la prueba de Wilcoxon tiene poca potencia; reporta el tamaño del efecto (${formatNumber(comparison.wilcoxon.rankBiserial, 2)}) junto al p.`);
  }
  const p1 = byId.get("P1");
  const crossing = Number((p1?.details as { crossingEpisodes?: number } | undefined)?.crossingEpisodes || 0);
  if (crossing) out.push(`${crossing} episodios de bloqueo cruzaron un cambio de bloque y no entraron en P1.`);
  const censored = Number((p1?.details as { censoredEpisodes?: number } | undefined)?.censoredEpisodes || 0);
  if (censored) out.push(`${censored} episodios de bloqueo no se cerraron (censurados): ver P2.`);
  const u5 = byId.get("U5");
  if (u5?.value !== null && u5?.value !== undefined && u5.value < 70) out.push(`Solo respondió la encuesta el ${formatNumber(u5.value, 1)} % de los participantes: discute el sesgo de no respuesta.`);
  if (cleaning?.anonymousClientSessions) out.push(`${cleaning.anonymousClientSessions} sesiones de cliente sin usuario en la ventana: su trabajo no tiene condición y no entra al análisis.`);
  const pending = kpis.filter((kpi) => kpi.value === null && !findKpi(kpi.id).automatic).map((kpi) => kpi.id);
  if (pending.length) out.push(`KPIs manuales sin valor todavía: ${pending.join(", ")}. Salen de copias llenas de las plantillas de \`data/piloto/plantillas/\`: guárdalas en una carpeta y pásala con \`--registros=<carpeta>\` (la sección 9 dice qué filas se usaron o descartaron). Sin plantilla válida se usa el bloque \`registros\` del plan del piloto.`);
  return out;
}

export function renderPilotReport(input: {
  plan: PilotPlan | null;
  kpis: KpiResult[];
  comparison: UnblockingComparison;
  charts: ChartFile[];
  generatedAt: string;
  datasetDescription: string;
  surveyDescription: string;
  cleaning?: { anonymousClientSessions?: number } | null;
  synthetic?: boolean;
}) {
  const byId = new Map(input.kpis.map((kpi) => [kpi.id, kpi]));
  const chartsFor = (id: string) => input.charts.filter((chart) => chart.kpis.includes(id));
  const image = (chart: ChartFile) => `![${chart.title}](graficas/${chart.file})`;
  const lines: string[] = [
    `# Informe de KPIs del piloto${input.plan ? ` — ${input.plan.nombre}` : ""}`,
    "",
  ];
  if (input.synthetic) {
    lines.push("> **Datos simulados.** Este informe sale del ensayo técnico con estudiantes sintéticos: sirve para comprobar que la cadena funciona, no dice nada del tutor.", "");
  }
  lines.push(
    "| | |",
    "|---|---|",
    `| Generado | ${input.generatedAt} con \`npm run piloto:analisis\` |`,
    `| Telemetría | ${cell(input.datasetDescription)} |`,
    `| Encuesta | ${cell(input.surveyDescription)} |`,
    `| Participantes con consentimiento | ${input.plan?.participantesConConsentimiento ?? "sin registrar"} |`,
    `| Definiciones | docs/metricas/catalogo-kpis.md |`,
    "",
    "La columna «Lectura» es automática: dice el valor, el n y si cumple el umbral aprobado. La interpretación (qué significa y por qué pasó) va en el capítulo de resultados.",
    "",
    "## 1. Tabla de KPIs",
    "",
  );
  for (const dimension of ["tecnico", "ux", "pedagogico"] as const) {
    lines.push(`### ${KPI_DIMENSION_LABEL[dimension]}`, "", "| ID | KPI | Valor | n | Umbral | Cumple | Lectura |", "|---|---|---|---|---|---|---|");
    for (const kpi of KPI_CATALOG.filter((item) => item.dimension === dimension)) {
      const result = byId.get(kpi.id);
      if (!result) continue;
      lines.push(`| ${kpi.id}${kpi.primary ? " ★" : ""} | ${cell(result.name)} | ${cell(formatValue(result.value, result.unit))} | ${result.n ?? "—"} | ${cell(result.thresholdText)} | ${meetsText(result)} | ${cell(result.summary)} |`);
    }
    lines.push("");
  }

  const p1 = byId.get("P1");
  const p2 = byId.get("P2");
  const details = (p1?.details || {}) as {
    byCohort?: Record<string, { reductionPct: number | null; pairedStudents: number }>;
    withoutAway?: { reductionPct: number | null; pairedStudents: number };
    wilcoxon?: { n: number; wPlus: number; wMinus: number; p: number | null; method: string; rankBiserial: number | null };
    crossover?: { studentsA: number; studentsB: number; treatmentEffectS: number | null; pTreatment: number | null; periodEffectS: number | null; pPeriod: number | null; method: string };
  };
  lines.push(
    "## 2. Tiempo hasta desbloqueo (P1, P2)",
    "",
    p1?.summary || "Sin datos.",
    "",
    ...chartsFor("P1").map(image),
    "",
    "| Análisis | Estudiantes pareados | Reducción |",
    "|---|---|---|",
    `| Principal (todos los episodios resueltos) | ${input.comparison.pairedStudents} | ${formatValue(input.comparison.reductionPct, "%")} |`,
    `| Sin episodios corregidos desde otro archivo | ${details.withoutAway?.pairedStudents ?? 0} | ${formatValue(details.withoutAway?.reductionPct ?? null, "%")} |`,
    `| Solo cohorte A (empezó con tutor) | ${details.byCohort?.A?.pairedStudents ?? 0} | ${formatValue(details.byCohort?.A?.reductionPct ?? null, "%")} |`,
    `| Solo cohorte B (empezó sin tutor) | ${details.byCohort?.B?.pairedStudents ?? 0} | ${formatValue(details.byCohort?.B?.reductionPct ?? null, "%")} |`,
    "",
    details.wilcoxon && details.wilcoxon.n
      ? `Prueba de Wilcoxon de rangos con signo (${details.wilcoxon.method}): W+ = ${formatNumber(details.wilcoxon.wPlus, 1)}, W− = ${formatNumber(details.wilcoxon.wMinus, 1)}, n = ${details.wilcoxon.n}, p = ${formatNumber(details.wilcoxon.p, 4)}; correlación biserial de rangos = ${formatNumber(details.wilcoxon.rankBiserial, 2)} (negativa: menos tiempo con tutor).`
      : "Sin pares suficientes para la prueba.",
    "",
    details.crossover && details.crossover.studentsA && details.crossover.studentsB
      ? `Análisis del cruzado AB/BA (Hills y Armitage, ${details.crossover.method}): efecto del tutor ${formatNumber(details.crossover.treatmentEffectS, 1)} s (con − sin; negativo = menos tiempo con tutor), p = ${formatNumber(details.crossover.pTreatment, 4)}; efecto de periodo (bloque 1 − bloque 2) ${formatNumber(details.crossover.periodEffectS, 1)} s, p = ${formatNumber(details.crossover.pPeriod, 4)}; cohorte A ${details.crossover.studentsA} y B ${details.crossover.studentsB} estudiantes.`
      : "Sin estudiantes con episodios en los dos bloques de ambas cohortes para el análisis del cruzado.",
    "",
    "Si la reducción difiere mucho entre cohortes o el efecto de periodo es grande, hay efecto de orden (aprendizaje o cansancio entre bloques): se discute en los resultados.",
    "",
    p2?.summary || "",
    "",
    "## 3. Latencia del tutor (T1, T2)",
    "",
    byId.get("T1")?.summary || "",
    "",
    ...latencyByServerTable(byId.get("T1")?.details?.byServer),
    ...chartsFor("T1").map(image),
    "",
    "## 4. Encuesta (U1, U2, P4, U5)",
    "",
    `- ${byId.get("U1")?.summary || ""}`,
    `- ${byId.get("U2")?.summary || ""}`,
    `- ${byId.get("P4")?.summary || ""}`,
    `- ${byId.get("U5")?.summary || ""}`,
    "",
    ...chartsFor("U1").map(image),
    "",
    ...chartsFor("P4").map(image),
    "",
    ...chartsFor("U2").map(image),
    "",
    "Las respuestas abiertas (AB1 a AB3) salen en `respuestas-abiertas.csv` para codificarlas a mano.",
    "",
    "## 5. Uso de las intervenciones (P7)",
    "",
    byId.get("P7")?.summary || "",
    "",
    ...chartsFor("P7").map(image),
    "",
    "## 6. Cobertura de telemetría (T6)",
    "",
    byId.get("T6")?.summary || "",
    "",
    ...chartsFor("T6").map(image),
    "",
    "## 7. Avisos del análisis",
    "",
  );
  const notes = warnings(input.kpis, input.comparison, input.cleaning || null);
  lines.push(...(notes.length ? notes.map((note) => `- ${note}`) : ["- Ninguno."]), "");
  lines.push(
    "## 8. Trazabilidad KPI → hallazgo → evidencia (A14.7)",
    "",
    "La tabla completa está en `trazabilidad.csv`: las columnas «hallazgo» y «acción» se llenan al escribir los hallazgos (A14.5) y las mejoras (P5).",
    "",
  );
  return `${lines.join("\n").replace(/\n{3,}/g, "\n\n")}`;
}

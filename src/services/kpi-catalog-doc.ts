import {
  KPI_CATALOG,
  KPI_DIMENSION_LABEL,
  KPI_REPORT_PLAN,
  KPI_SOURCE_LABEL,
  type KpiDefinition,
  type KpiDimension,
} from "./kpi-catalog.js";

/**
 * Genera docs/metricas/catalogo-kpis.md desde src/services/kpi-catalog.ts
 * (A3.1, A3.2, A3.3, A3.5, A3.6). La prueba
 * tests/scripts/kpi-catalog-doc.test.ts falla si el documento quedo
 * desactualizado: se regenera con `npm run kpis:catalogo`.
 */

function cell(value: unknown) {
  return String(value ?? "").replace(/\|/g, "\\|").replace(/\n/g, " ");
}

function detailTable(kpi: KpiDefinition) {
  const rows: Array<[string, string]> = [
    ["Pregunta", kpi.question],
    ["Fórmula", kpi.formula],
    ["Unidad", kpi.unit],
    ["Ventana", kpi.window],
    ["Fuente", kpi.sources.map((source) => KPI_SOURCE_LABEL[source]).join("; ")],
    ["Eventos", kpi.events.length ? kpi.events.map((event) => event.startsWith("(") ? event : `\`${event}\``).join(", ") : "—"],
    ["Umbral", kpi.thresholdText],
    ["Origen del umbral", kpi.origin],
    ["Decisión", kpi.decision],
    ["Cálculo", kpi.automatic ? "Automático (`npm run piloto:analisis`)" : "Manual: se registra en el plan del piloto"],
    ["Gráfica o tabla", kpi.chart],
    ["Jira", kpi.jira.join(", ")],
  ];
  return [
    "| | |",
    "|---|---|",
    ...rows.map(([label, value]) => `| ${label} | ${cell(value)} |`),
  ];
}

export function renderKpiCatalogMarkdown() {
  const dimensions: KpiDimension[] = ["tecnico", "ux", "pedagogico"];
  const proposed = KPI_CATALOG.filter((kpi) => kpi.threshold && /^Propuesto/.test(kpi.origin));
  const lines: string[] = [
    "# Catálogo de KPIs del piloto",
    "",
    "> Documento generado desde `src/services/kpi-catalog.ts` con `npm run kpis:catalogo`. No lo edites a mano: cambia el catálogo y regenéralo.",
    "",
    "| | |",
    "|---|---|",
    "| Jira | A3.1 (técnicos), A3.2 (UX y pedagógicos), A3.3 (operacionalización), A3.5 (umbrales), A3.6 (reporte) |",
    "| Cálculo | `src/services/kpis.ts` (pruebas en `tests/services/kpis.test.ts`) |",
    "| En vivo | `GET /api/telemetry/kpis` y `npm run piloto:monitor` |",
    "| Informe final | `npm run piloto:analisis` |",
    "",
    "Cada KPI dice qué pregunta responde, cómo se calcula (fórmula, unidad y ventana), de dónde salen los datos, con qué umbral se juzga y de dónde viene ese umbral. Los KPIs automáticos se calculan con la telemetría, la encuesta y la asistencia; los manuales se registran en el plan del piloto (`data/piloto/plan-piloto.ejemplo.json`).",
    "",
    "**Regla para las contradicciones del anteproyecto:** manda la sección 5.4, que es la tabla de KPIs. Por eso la latencia se juzga con ≤ 8 s (no con los ≤ 10 s de A9) y las mejoras críticas con ≥ 65 % (no con el ≥ 70 % de A13).",
    "",
    "**Línea base del tiempo hasta desbloqueo:** el mismo estudiante sin tutor, en un diseño intra-sujeto contrabalanceado AB/BA (la mitad del grupo empieza con el tutor). Ver el protocolo del piloto.",
    "",
    "## Resumen",
    "",
    "| ID | KPI | Dimensión | Umbral | Origen | Cálculo |",
    "|---|---|---|---|---|---|",
    ...KPI_CATALOG.map((kpi) => `| ${kpi.id}${kpi.primary ? " ★" : ""} | ${cell(kpi.name)} | ${KPI_DIMENSION_LABEL[kpi.dimension]} | ${cell(kpi.thresholdText)} | ${cell(kpi.origin)} | ${kpi.automatic ? "Automático" : "Manual"} |`),
    "",
    "★ KPI principal: el anteproyecto pide al menos uno técnico, uno de UX y uno pedagógico (T1, U1 y P1).",
    "",
  ];
  for (const dimension of dimensions) {
    lines.push(`## ${KPI_DIMENSION_LABEL[dimension]}`, "");
    for (const kpi of KPI_CATALOG.filter((item) => item.dimension === dimension)) {
      lines.push(`### ${kpi.id}. ${kpi.name}`, "", ...detailTable(kpi), "");
    }
  }
  lines.push(
    "## Umbrales por aprobar (A3.5)",
    "",
    "Estos umbrales no están en el anteproyecto: los propone este catálogo y los aprueba el director antes de la primera sesión del piloto. Después de aprobados no se cambian.",
    "",
    "| KPI | Umbral propuesto | Por qué |",
    "|---|---|---|",
    ...proposed.map((kpi) => `| ${kpi.id}. ${cell(kpi.name)} | ${cell(kpi.thresholdText)} | ${cell(kpi.decision)} |`),
    "",
    "También se someten a aprobación las dos decisiones sobre contradicciones del anteproyecto (T1 y P5) y la línea base de P1.",
    "",
    "## Reporte mínimo y periodicidad (A3.6)",
    "",
    "| Momento | Cómo | KPIs | Qué más |",
    "|---|---|---|---|",
    ...KPI_REPORT_PLAN.map((item) => `| ${cell(item.moment)} | ${cell(item.how)} | ${item.kpis.join(", ")} | ${cell(item.extra)} |`),
    "",
    "El informe final (`npm run piloto:analisis`) tiene, en este orden:",
    "",
    "1. **Tabla de KPIs** con valor, n, umbral y si cumple (semáforo).",
    "2. **Tiempo hasta desbloqueo (P1):** puntos pareados por estudiante (sin tutor → con tutor), caja por condición y tabla por cohorte (efecto de orden).",
    "3. **Latencia (T1, T2):** caja por canal y tabla por sesión.",
    "4. **Encuesta (U1, U2, P4):** barras por ítem e histograma SUS.",
    "5. **Uso de intervenciones (P7):** barras por etapa de ayuda.",
    "6. **Trazabilidad KPI → hallazgo → evidencia (A14.7):** una fila por KPI con el archivo de evidencia y una columna de hallazgo para completar.",
    "",
  );
  return `${lines.join("\n")}`;
}

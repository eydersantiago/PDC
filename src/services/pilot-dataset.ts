import type { TelemetryEventRow } from "./telemetry.js";

/**
 * Limpieza y validacion final del dataset del piloto (A14.3).
 *
 * Parte de telemetry_events (ya seudonimizado, sin textos) y deja solo los
 * eventos de estudiantes con condicion del piloto. Nada se borra en la base:
 * lo excluido sale en su propio archivo con la regla que lo saco.
 *
 * Reglas de exclusion (en este orden; gana la primera que aplique):
 *   D1 no_estudiante      actor docente, administrador o sistema.
 *   D2 cliente_anonimo    cliente sin sesion (x-adaceen-client-id): no hay
 *                         condicion; suele ser VS Code sin la sesion
 *                         compartida configurada.
 *   D3 cuenta_de_prueba   actor de una cuenta de prueba del equipo.
 *   D4 sin_condicion      estudiante fuera de los bloques o sin cohorte.
 *   D5 duplicado          mismo client_session_id y seq que uno anterior.
 * Marcas (el evento se queda, con aviso en limpieza_flags):
 *   M1 fecha_corregida    el cliente mando una fecha futura o muy antigua (Q5, Q6).
 *   M2 decision_huerfana  decision_id sin su tutor_decision (I5).
 *   M3 orden_invalido     valoracion antes de mostrarse la respuesta (I3).
 */

export type ExclusionRule = "D1_no_estudiante" | "D2_cliente_anonimo" | "D3_cuenta_de_prueba" | "D4_sin_condicion" | "D5_duplicado";
export type CleaningMark = "M1_fecha_corregida" | "M2_decision_huerfana" | "M3_orden_invalido";

export const EXCLUSION_RULES: Array<{ code: ExclusionRule; description: string }> = [
  { code: "D1_no_estudiante", description: "Evento de un docente, un administrador o del sistema sin estudiante." },
  { code: "D2_cliente_anonimo", description: "Cliente sin sesion: no se sabe su condicion (revisar la sesion compartida de VS Code)." },
  { code: "D3_cuenta_de_prueba", description: "Cuenta de prueba del equipo (listada en el plan del piloto)." },
  { code: "D4_sin_condicion", description: "Estudiante fuera de los bloques del piloto o sin cohorte asignada." },
  { code: "D5_duplicado", description: "Copia de un evento ya recibido (mismo client_session_id y seq)." },
];

export const CLEANING_MARKS: Array<{ code: CleaningMark; description: string }> = [
  { code: "M1_fecha_corregida", description: "El cliente mando una fecha futura (se uso la del servidor) o de mas de 7 dias atras." },
  { code: "M2_decision_huerfana", description: "El evento cita una decision del tutor que no esta en el dataset." },
  { code: "M3_orden_invalido", description: "La valoracion llego antes de que se mostrara la respuesta." },
];

export type CleanRow = TelemetryEventRow & { cleaningMarks: CleaningMark[] };

export type PilotDatasetResult = {
  kept: CleanRow[];
  excluded: Array<{ row: TelemetryEventRow; rule: ExclusionRule }>;
  report: {
    input: number;
    kept: number;
    excludedByRule: Record<ExclusionRule, number>;
    marks: Record<CleaningMark, number>;
    students: number;
    studentsByCohort: Record<string, number>;
    eventsByCondition: Record<string, number>;
    anonymousClientSessions: number;
    firstEvent: string | null;
    lastEvent: string | null;
  };
};

export function cleanPilotDataset(input: { rows: TelemetryEventRow[]; testActors?: string[] }): PilotDatasetResult {
  const testActors = new Set((input.testActors || []).filter(Boolean));
  const sorted = [...input.rows].sort((a, b) => Date.parse(a.occurredAt) - Date.parse(b.occurredAt));
  const excluded: PilotDatasetResult["excluded"] = [];
  const candidates: TelemetryEventRow[] = [];
  const seen = new Set<string>();
  const anonymousSessions = new Set<string>();

  for (const row of sorted) {
    let rule: ExclusionRule | null = null;
    if (row.actorKind === "client") {
      rule = "D2_cliente_anonimo";
      if (row.clientSessionId) anonymousSessions.add(row.clientSessionId);
    } else if (row.actorRole !== "student" || row.actorKind !== "user") {
      rule = "D1_no_estudiante";
    } else if (testActors.has(row.actorAnonId)) {
      rule = "D3_cuenta_de_prueba";
    } else if (row.pilotCondition !== "con_tutor" && row.pilotCondition !== "sin_tutor") {
      rule = "D4_sin_condicion";
    } else if (row.clientSessionId && row.seq !== null) {
      const key = `${row.clientSessionId}#${row.seq}`;
      if (seen.has(key)) rule = "D5_duplicado";
      else seen.add(key);
    }
    if (rule) excluded.push({ row, rule });
    else candidates.push(row);
  }

  const orphanIds = new Set<string>();
  const outOfOrderIds = new Set<string>();
  // Marcas completas (analyzeTelemetryDataset solo guarda ejemplos de I3 e I5).
  const decisions = new Set(candidates.filter((row) => row.eventType === "tutor_decision" && row.decisionId).map((row) => row.decisionId));
  const shownAt = new Map<string, number>();
  for (const row of candidates) {
    if (row.decisionId && row.eventType !== "tutor_decision" && !decisions.has(row.decisionId)) orphanIds.add(row.id);
    const time = Date.parse(row.occurredAt);
    if (row.eventType === "tutor_response_shown" && row.decisionId && !shownAt.has(row.decisionId)) shownAt.set(row.decisionId, time);
    if (/^tutor_response_(accepted|rejected|ignored)$/.test(row.eventType) && row.decisionId) {
      const shown = shownAt.get(row.decisionId);
      if (shown === undefined || time < shown) outOfOrderIds.add(row.id);
    }
  }

  const marks: Record<CleaningMark, number> = { M1_fecha_corregida: 0, M2_decision_huerfana: 0, M3_orden_invalido: 0 };
  const kept: CleanRow[] = candidates.map((row) => {
    const cleaningMarks: CleaningMark[] = [];
    if (row.qualityFlags.some((flag) => flag.code === "Q5_fecha_futura" || flag.code === "Q6_fecha_antigua")) cleaningMarks.push("M1_fecha_corregida");
    if (orphanIds.has(row.id)) cleaningMarks.push("M2_decision_huerfana");
    if (outOfOrderIds.has(row.id)) cleaningMarks.push("M3_orden_invalido");
    for (const mark of cleaningMarks) marks[mark] += 1;
    return { ...row, cleaningMarks };
  });

  const excludedByRule = Object.fromEntries(EXCLUSION_RULES.map((rule) => [rule.code, 0])) as Record<ExclusionRule, number>;
  for (const item of excluded) excludedByRule[item.rule] += 1;
  const cohortByActor = new Map<string, string>();
  const eventsByCondition: Record<string, number> = {};
  for (const row of kept) {
    cohortByActor.set(row.actorAnonId, row.pilotCohort);
    eventsByCondition[row.pilotCondition] = (eventsByCondition[row.pilotCondition] || 0) + 1;
  }
  const studentsByCohort: Record<string, number> = {};
  for (const cohort of cohortByActor.values()) studentsByCohort[cohort || "?"] = (studentsByCohort[cohort || "?"] || 0) + 1;

  return {
    kept,
    excluded,
    report: {
      input: input.rows.length,
      kept: kept.length,
      excludedByRule,
      marks,
      students: cohortByActor.size,
      studentsByCohort,
      eventsByCondition,
      anonymousClientSessions: anonymousSessions.size,
      firstEvent: kept[0]?.occurredAt || null,
      lastEvent: kept[kept.length - 1]?.occurredAt || null,
    },
  };
}

export function renderCleaningReport(result: PilotDatasetResult, context: { window: string; generatedAt: string; source: string }) {
  const report = result.report;
  const lines = [
    "# Limpieza del dataset del piloto (A14.3)",
    "",
    "| | |",
    "|---|---|",
    `| Generado | ${context.generatedAt} |`,
    `| Fuente | ${context.source} |`,
    `| Ventana | ${context.window} |`,
    `| Eventos de entrada | ${report.input} |`,
    `| Eventos que quedan | ${report.kept} |`,
    `| Estudiantes | ${report.students} (${Object.entries(report.studentsByCohort).map(([cohort, count]) => `cohorte ${cohort}: ${count}`).join(", ") || "sin cohortes"}) |`,
    `| Eventos por condicion | ${Object.entries(report.eventsByCondition).map(([condition, count]) => `${condition}: ${count}`).join(", ") || "—"} |`,
    `| Primer y ultimo evento | ${report.firstEvent || "—"} / ${report.lastEvent || "—"} |`,
    "",
    "## Exclusiones",
    "",
    "| Regla | Que excluye | Eventos |",
    "|---|---|---|",
    ...EXCLUSION_RULES.map((rule) => `| ${rule.code} | ${rule.description} | ${report.excludedByRule[rule.code]} |`),
    "",
    report.anonymousClientSessions
      ? `**Atencion:** ${report.anonymousClientSessions} sesiones de cliente sin sesion de usuario en la ventana. Si son estudiantes del piloto, su trabajo no tiene condicion y se pierde para el analisis: revisa que VS Code tenga la sesion compartida configurada.`
      : "Ninguna sesion de cliente anonima en la ventana.",
    "",
    "## Marcas (el evento se queda)",
    "",
    "| Marca | Que significa | Eventos |",
    "|---|---|---|",
    ...CLEANING_MARKS.map((mark) => `| ${mark.code} | ${mark.description} | ${report.marks[mark.code]} |`),
    "",
    "Lo excluido esta en `excluidos.csv` con su regla; nada se borro de la base.",
    "",
  ];
  return lines.join("\n");
}

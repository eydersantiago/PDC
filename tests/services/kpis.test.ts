import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { COMPLIANCE_ITEMS } from "../../src/services/compliance-checklist.js";
import { parseCsv, parseCsvRecords, toCsvText } from "../../src/services/csv.js";
import { KPI_CATALOG, meetsThreshold } from "../../src/services/kpi-catalog.js";
import {
  compareUnblocking,
  computeKpis,
  crossoverAnalysis,
  extractUnblockingEpisodes,
  formatValue,
  MANUAL_KPI_IDS,
  MANUAL_TEMPLATES,
  parseRecordClock,
  parseRecordDate,
  parseRecordNumber,
  readManualRecords,
  renderManualTemplates,
} from "../../src/services/kpis.js";
import { mannWhitneyU, median, percentile, wilcoxonSignedRank } from "../../src/services/stats.js";
import { parseLikert, parseSurvey, susScore } from "../../src/services/survey.js";
import type { TelemetryEventRow } from "../../src/services/telemetry.js";

/** A3.3 / A14.4: estadistica, lectura de la encuesta y calculo de los KPIs. */

let counter = 0;
function row(partial: Partial<TelemetryEventRow>): TelemetryEventRow {
  counter += 1;
  return {
    id: `evento-${counter}`,
    schemaVersion: "1.1",
    occurredAt: "2026-10-06T19:00:00.000Z",
    receivedAt: "2026-10-06T19:00:00.000Z",
    source: "backend",
    channel: "vscode",
    category: "tutor",
    eventType: "tutor_decision",
    actorAnonId: "actor-x",
    actorKind: "user",
    actorRole: "student",
    teacherAnonId: "docente-1",
    clientSessionId: "",
    seq: null,
    decisionId: "",
    courseCode: "",
    exerciseHash: "ej-1",
    language: "cpp",
    fileExt: ".cpp",
    policyEventType: "compile_error",
    interventionType: "hint",
    helpStage: "hint_1",
    reasonCode: "ok",
    blocked: false,
    latencyMs: null,
    durationMs: null,
    countValue: null,
    valueText: "",
    errorHash: "",
    contextHash: "",
    metadata: {},
    qualityFlags: [],
    pilotBlock: null,
    pilotCohort: "",
    pilotCondition: "",
    ...partial,
  };
}

test("estadistica: percentil interpolado y Wilcoxon exacto y aproximado", () => {
  assert.equal(median([4, 1, 3, 2]), 2.5);
  assert.equal(percentile(Array.from({ length: 20 }, (_, index) => index + 1), 95), 19.05);
  assert.equal(percentile([], 50), null);

  const allPositive = wilcoxonSignedRank([[7, 1], [8, 1], [9, 1], [10, 1], [11, 0], [13, 1]]);
  assert.equal(allPositive.method, "exacto");
  assert.equal(allPositive.wMinus, 0);
  assert.equal(allPositive.p, 2 / 64);
  assert.equal(allPositive.rankBiserial, 1);
  const ten = wilcoxonSignedRank(Array.from({ length: 10 }, (_, index) => [0, index + 1] as [number, number]));
  assert.equal(ten.p, 2 / 1024);
  assert.equal(ten.rankBiserial, -1, "el primer valor de cada par es menor");
  const symmetric = wilcoxonSignedRank([[1, 0], [0, 1], [2, 0], [0, 2]]);
  assert.equal(symmetric.method, "aproximacion normal", "con empates no hay exacta");
  assert.ok((symmetric.p as number) > 0.9);
  assert.equal(wilcoxonSignedRank([[1, 1]]).p, null, "sin diferencias no hay prueba");
});

test("csv: separador de Excel en espanol, comillas y saltos de linea", () => {
  const text = "﻿a;b;c\n1;\"dos; y \"\"tres\"\"\";\"linea\nnueva\"\n\n4;5;6\n";
  assert.deepEqual(parseCsv(text), [["a", "b", "c"], ["1", "dos; y \"tres\"", "linea\nnueva"], ["4", "5", "6"]]);
  assert.deepEqual(parseCsvRecords("x,y\n1,2\n"), [{ x: "1", y: "2" }]);
});

test("encuesta: reconoce los codigos de las preguntas, textos Likert y puntaje SUS", () => {
  assert.equal(parseLikert("Totalmente de acuerdo"), 5);
  assert.equal(parseLikert("ni de acuerdo ni en desacuerdo"), 3);
  assert.equal(parseLikert("4 - De acuerdo"), 4);
  assert.equal(parseLikert(""), null);
  assert.equal(susScore([3, 3, 3, 3, 3, 3, 3, 3, 3, 3]), 50);
  assert.equal(susScore([5, 1, 5, 1, 5, 1, 5, 1, 5, 1]), 100);
  assert.equal(susScore([5, 1, 5, 1, 5, 1, 5, 1, 5, null]), null);

  const header = [
    "Marca temporal",
    ...Array.from({ length: 10 }, (_, index) => `SUS${index + 1}. Pregunta SUS`),
    ...Array.from({ length: 6 }, (_, index) => `UX${index + 1}. Pregunta UX`),
    ...Array.from({ length: 5 }, (_, index) => `PA${index + 1}. Pregunta PA`),
    "CMP1. Bloque",
    "AB1. Lo mas util",
  ];
  const answer = ["2026-10-20", ..."5151515151".split(""), "Totalmente de acuerdo", "De acuerdo", "4", "4", "5", "", "4", "4", "4", "", "", "Con tutor", "Las pistas"];
  const parsed = parseSurvey(`${header.map((cell) => `"${cell}"`).join(",")}\n${answer.map((cell) => `"${cell}"`).join(",")}\n`);
  assert.deepEqual(parsed.warnings, []);
  assert.equal(parsed.responses.length, 1);
  assert.deepEqual(parsed.responses[0].ux, [5, 4, 4, 4, 5, null]);
  assert.equal(susScore(parsed.responses[0].sus), 100);
  assert.equal(parsed.responses[0].cmp[0], "Con tutor");
  assert.equal(parsed.responses[0].open[0], "Las pistas");
});

function episode(actor: string, cohort: string, condition: string, block: number, startMinute: number, seconds: number, extra: { resolveBlock?: number; away?: boolean; session?: string } = {}) {
  const start = new Date(Date.UTC(2026, 9, 6, 19, startMinute)).toISOString();
  const end = new Date(Date.UTC(2026, 9, 6, 19, startMinute) + seconds * 1000).toISOString();
  const resolveBlock = extra.resolveBlock ?? block;
  const resolveCondition = resolveBlock === block ? condition : condition === "con_tutor" ? "sin_tutor" : "con_tutor";
  const base = { source: "vscode_extension", channel: "vscode", category: "signal", actorAnonId: actor, clientSessionId: extra.session || `vs-${actor}`, errorHash: `err-${startMinute}`, exerciseHash: "ej-1", pilotCohort: cohort };
  return [
    row({ ...base, eventType: "blocking_detected", occurredAt: start, durationMs: 90_000, pilotBlock: block, pilotCondition: condition }),
    row({ ...base, eventType: "blocking_resolved", occurredAt: end, durationMs: seconds * 1000, pilotBlock: resolveBlock, pilotCondition: resolveCondition, metadata: { resolvedWhileAway: extra.away === true } }),
  ];
}

test("tiempo hasta desbloqueo: episodios emparejados, condicion del inicio y reduccion pareada", () => {
  const rows = [
    // Cohorte A: bloque 1 con tutor, bloque 2 sin tutor.
    ...episode("a1", "A", "con_tutor", 1, 0, 100),
    ...episode("a1", "A", "con_tutor", 1, 10, 140),
    ...episode("a1", "A", "sin_tutor", 2, 50, 300),
    ...episode("a2", "A", "con_tutor", 1, 1, 120),
    ...episode("a2", "A", "sin_tutor", 2, 51, 200),
    // Cohorte B: bloque 1 sin tutor, bloque 2 con tutor.
    ...episode("b1", "B", "sin_tutor", 1, 2, 400),
    ...episode("b1", "B", "con_tutor", 2, 52, 200, { away: true }),
    ...episode("b2", "B", "sin_tutor", 1, 3, 250),
    ...episode("b2", "B", "con_tutor", 2, 53, 150),
    // Cruza de bloque: no entra.
    ...episode("b2", "B", "sin_tutor", 1, 30, 900, { resolveBlock: 2 }),
    // Sin cierre: censurado.
    row({ source: "vscode_extension", eventType: "blocking_detected", actorAnonId: "a2", clientSessionId: "vs-a2", errorHash: "err-abierto", pilotBlock: 2, pilotCohort: "A", pilotCondition: "sin_tutor", occurredAt: "2026-10-06T19:55:00.000Z" }),
  ];
  const episodes = extractUnblockingEpisodes(rows);
  assert.equal(episodes.length, 11);
  assert.equal(episodes.filter((item) => item.crossesBlock).length, 1);
  assert.equal(episodes.filter((item) => !item.resolved).length, 1);

  const comparison = compareUnblocking(episodes);
  assert.equal(comparison.pairedStudents, 4);
  // Medianas por estudiante con tutor: a1 120, a2 120, b1 200, b2 150 -> 135.
  // Sin tutor: a1 300, a2 200, b1 400, b2 250 -> 275.
  assert.equal(comparison.medianWithTutorS, 135);
  assert.equal(comparison.medianWithoutTutorS, 275);
  assert.equal(Math.round((comparison.reductionPct as number) * 10) / 10, 50.9);
  assert.equal(comparison.wilcoxon.n, 4);
  assert.equal(comparison.wilcoxon.p, 2 / 16);

  const withoutAway = compareUnblocking(episodes, { excludeAway: true });
  assert.equal(withoutAway.pairedStudents, 3, "b1 solo tenia su episodio con tutor corregido desde otro archivo");

  // Cruzado AB/BA: d = bloque 1 - bloque 2. A: -180 y -80; B: 200 y 100.
  const crossover = crossoverAnalysis(episodes);
  assert.equal(crossover.studentsA, 2);
  assert.equal(crossover.studentsB, 2);
  assert.equal(crossover.treatmentEffectS, -140, "(mediana dA - mediana dB) / 2 = (-130 - 150) / 2");
  assert.equal(crossover.periodEffectS, 10);
  assert.equal(crossover.pTreatment, 2 / 6, "separacion completa con 2 y 2: p exacto = 2/6");
});

test("estadistica: Mann-Whitney exacto y con empates", () => {
  assert.equal(mannWhitneyU([1, 2, 3], [4, 5, 6]).p, 0.1);
  assert.equal(mannWhitneyU([10, 11, 12, 13], [1, 2, 3, 4]).rankBiserial, 1);
  assert.equal(mannWhitneyU([1, 1, 2], [2, 3, 3]).method, "aproximacion normal");
  assert.equal(mannWhitneyU([], [1]).p, null);
});

test("KPIs: todos los del catalogo, en orden, con lectura automatica y umbrales", () => {
  const decisions = [2, 4, 6, 8, 30].map((seconds) => row({ latencyMs: seconds * 1000, metadata: { source: "advanced", ragSources: 2 } }));
  const rows = [
    ...decisions,
    row({ latencyMs: 300, reasonCode: "model_error_fallback", metadata: { source: "degraded", ragSources: 0 } }),
    row({ latencyMs: 5, metadata: { source: "cache", cached: true } }),
    row({ blocked: true, reasonCode: "pilot_no_tutor", helpStage: "controlled", pilotCondition: "sin_tutor" }),
    row({ blocked: true, reasonCode: "out_of_domain", policyEventType: "out_of_domain", helpStage: "controlled" }),
    ...episode("a1", "A", "con_tutor", 1, 0, 100),
    ...episode("a1", "A", "sin_tutor", 2, 50, 300),
    row({ source: "vscode_extension", eventType: "vscode_suggestion_shown", clientSessionId: "vs-z", seq: 1, pilotCondition: "con_tutor" }),
    row({ source: "vscode_extension", eventType: "vscode_suggestion_shown", clientSessionId: "vs-z", seq: 3, pilotCondition: "con_tutor" }),
    row({ source: "browser_extension", eventType: "tutor_response_accepted", actorAnonId: "actor-y", pilotCondition: "con_tutor" }),
  ];
  const kpis = computeKpis({
    rows,
    attendance: [{ fecha: "2026-10-06", presentes: 4 }],
    participants: 4,
    survey: [{ sus: [4, 2, 4, 2, 4, 2, 4, 2, 4, 2], ux: [4, 4, 5, 4, null, null], pa: [5, 4, 4, null, null], cmp: ["", ""], open: ["", "", ""] }],
    manual: { T7: 0, T10: 12 },
  });
  assert.deepEqual(kpis.map((item) => item.id), KPI_CATALOG.map((item) => item.id));
  const byId = new Map(kpis.map((item) => [item.id, item]));

  assert.equal(byId.get("T1")?.value, 6, "mediana de 2,4,6,8,30 sin cache ni respaldo");
  assert.equal(byId.get("T1")?.meets, true);
  assert.equal(byId.get("T2")?.meets, false, "p95 de 25,6 s");
  assert.equal(Math.round(byId.get("T3")?.value as number), 83, "5 de 6 intentos sin falla");
  assert.equal(byId.get("T4")?.value, 33.333, "falta el seq 2 de vs-z");
  assert.equal(byId.get("T6")?.value, 75, "tres estudiantes con telemetria de 4 presentes");
  assert.equal(byId.get("T7")?.meets, true);
  assert.equal(byId.get("T8")?.value, null);
  assert.match(byId.get("T8")?.summary || "", /Se registra a mano/);
  assert.equal(byId.get("T9")?.value, 83.333, "5 de 6 ayudas del curso con fuentes");
  assert.equal(byId.get("T10")?.meets, true);
  assert.ok((byId.get("T12")?.value as number) >= 10);
  assert.equal(byId.get("U1")?.value, 4.25);
  assert.equal(byId.get("U2")?.value, 75);
  assert.equal(byId.get("U3")?.value, 100);
  assert.equal(byId.get("P1")?.value, 66.667);
  assert.match(byId.get("P1")?.summary || "", /reducción de 66,7 %/);
  assert.equal(byId.get("P3")?.value, 50, "a1 y actor-x tuvieron los dos bloques; actor-y solo uno");
  assert.equal(byId.get("U5")?.value, 25, "una encuesta de cuatro participantes");
  assert.equal(byId.get("P4")?.value, 4.333);
  assert.equal(byId.get("P7")?.details?.pilotOff, 1, "el bloque sin tutor no cuenta como bloqueo de la politica");
  assert.equal(byId.get("P8")?.value, null);
  assert.equal(formatValue(6.25, "s"), "6,3 s");
  assert.equal(meetsThreshold({ threshold: null }, 3), null);
});

test("KPIs: la latencia se separa por servidor de inferencia (Google Cloud y Mac del laboratorio)", () => {
  const rows = [
    ...[2000, 3000, 4000].map((latencyMs) => row({ latencyMs, metadata: { source: "ai", worker: "gce-v100" } })),
    ...[6000, 8000].map((latencyMs) => row({ latencyMs, metadata: { source: "ai", worker: "mac-lab01-m2" } })),
    row({ latencyMs: 5000, metadata: { source: "ai" } }),
  ];
  const kpis = computeKpis({ rows });
  const t1 = kpis.find((kpi) => kpi.id === "T1");
  const byServer = t1?.details?.byServer as Record<string, { n: number; p50: number | null }>;
  assert.equal(byServer["Google Cloud - V100"].n, 3);
  assert.equal(byServer["Google Cloud - V100"].p50, 3);
  assert.equal(byServer["Mac del laboratorio - M2"].n, 2);
  assert.equal(byServer["Mac del laboratorio - M2"].p50, 7);
  assert.equal(byServer["sin dato"].n, 1);
  assert.match(t1?.summary || "", /por servidor: Google Cloud - V100 3 s \(n = 3\), Mac del laboratorio - M2 7 s \(n = 2\)/);
});

// --- KPIs manuales desde las plantillas (T7, T8, T10, T11, P5) -----------------

function manualKpis(files: Array<{ name: string; text: string }>, sessionDates: string[] = [], manual = {}) {
  const records = readManualRecords(files, { sessionDates });
  const kpis = computeKpis({ rows: [], manual, manualSources: records.sources });
  return { records, byId: new Map(kpis.map((kpi) => [kpi.id, kpi])) };
}

function traceOf(records: ReturnType<typeof readManualRecords>, kpi: string) {
  return records.rows.filter((row) => row.kpi === kpi).map((row) => `${row.archivo}:${row.fila ?? "-"} ${row.estado} ${row.motivo}`);
}

test("plantillas: fechas, horas y minutos como los escribe una persona o Excel en español", () => {
  assert.equal(parseRecordDate("2026-10-13"), "2026-10-13");
  assert.equal(parseRecordDate("13/10/2026"), "2026-10-13");
  assert.equal(parseRecordDate("2026-10-14T02:30:00Z"), "2026-10-13", "hora de Colombia");
  assert.equal(parseRecordDate("31/02/2026"), null);
  assert.equal(parseRecordDate("mañana"), null);
  assert.equal(parseRecordClock("08:05"), 8 * 3600 + 5 * 60);
  assert.equal(parseRecordClock("2:05 p. m."), 14 * 3600 + 5 * 60);
  assert.equal(parseRecordClock("12:10 a.m."), 10 * 60);
  assert.equal(parseRecordClock("25:00"), null);
  assert.equal(parseRecordNumber("12,5"), 12.5);
  assert.equal(parseRecordNumber("14 min"), 14);
  assert.equal(parseRecordNumber("doce"), null);
});

test("plantillas: los archivos de data/piloto/plantillas estan al dia con el formato que se lee", () => {
  for (const template of renderManualTemplates()) {
    const onDisk = fs.readFileSync(path.resolve(process.cwd(), "data/piloto/plantillas", template.file), "utf8");
    assert.equal(onDisk, template.text, `${template.file}: regenera con npm run piloto:analisis -- --escribir-plantillas`);
  }
  assert.deepEqual([...new Set(MANUAL_TEMPLATES.map((template) => template.kpi))].sort(), [...MANUAL_KPI_IDS].sort(), "una plantilla por KPI manual");
  for (const kpi of KPI_CATALOG) {
    assert.equal(MANUAL_KPI_IDS.includes(kpi.id as typeof MANUAL_KPI_IDS[number]), !kpi.automatic, `${kpi.id}: los manuales del catalogo son los que tienen plantilla`);
  }
  const compliance = parseCsvRecords(fs.readFileSync(path.resolve(process.cwd(), "data/piloto/plantillas/cumplimiento.csv"), "utf8"));
  assert.deepEqual(compliance.map((row) => row.id), COMPLIANCE_ITEMS.map((item) => item.id));
});

test("T7: cuenta los S1 de los registros de las sesiones del plan y traza cada fila", () => {
  const header = "fecha;hora_inicio;hora_fin;severidad;sintoma;afectados;causa;respuesta;responsable;evidencia";
  const { records, byId } = manualKpis([
    { name: "registro-incidentes-2026-10-13.csv", text: `${header}\n13/10/2026;14:00;14:20;S1 crítica;VM apagada;25;;;;\n2026-10-13;15:00;15:05;S3;lento;3;;;;\n2026-10-13;;;grave;;;;;;\n2026-10-06;;;S1;ensayo previo;;;;;\n` },
    { name: "registro-incidentes-2026-10-20.csv", text: `${header}\n` },
    { name: "registro-incidentes.csv", text: `${header}\n` },
    { name: "notas.txt.csv", text: "a,b\n1,2\n" },
  ], ["2026-10-13", "2026-10-20", "2026-10-27"]);
  const t7 = byId.get("T7");
  assert.equal(t7?.value, 1);
  assert.equal(t7?.n, 2, "dos registros de sesion: uno con filas y otro sin incidentes");
  assert.equal(t7?.meets, false);
  assert.match(t7?.summary || "", /^1 incidente S1 en 2 registros de sesión \(2 incidentes en total: S1 1, S2 0, S3 1, S4 0\); S1 el 2026-10-13\./);
  assert.match(t7?.summary || "", /Sin registro de incidentes de: 2026-10-27\./);
  assert.equal((t7?.details as { origen?: string }).origen, "plantilla");
  assert.deepEqual(traceOf(records, "T7"), [
    "registro-incidentes-2026-10-13.csv:2 usada incidente crítico: cuenta en T7",
    "registro-incidentes-2026-10-13.csv:3 usada S3: se reporta, no cuenta en T7",
    "registro-incidentes-2026-10-13.csv:4 descartada severidad no válida (S1, S2, S3 o S4 del plan de soporte)",
    "registro-incidentes-2026-10-13.csv:5 ignorada fecha fuera de las sesiones del plan del piloto",
    "registro-incidentes-2026-10-20.csv:- usada registro de la sesión sin incidentes",
    "registro-incidentes.csv:- ignorada sin filas y sin fecha en el nombre: no cuenta como registro de una sesión (nómbrala registro-incidentes-AAAA-MM-DD.csv)",
  ]);
  assert.deepEqual(records.unrecognized, ["notas.txt.csv"]);
  const empty = manualKpis([{ name: "registro-incidentes.csv", text: `${header}\n` }]);
  assert.equal(empty.byId.get("T7")?.value, null, "la plantilla vacia no es evidencia de cero incidentes");
});

test("T8: la ultima corrida de cada dia contra produccion; el KPI es la peor sesion", () => {
  const demo = (started: string, backend: string, correct: number, total: number) => [
    "# Evidencia: escenarios S1-S5 del tutor",
    "",
    `- Fecha: ${started} a ${started}`,
    `- Backend: ${backend}`,
    "- Modelo: el del backend (AGENT_TARGET del servidor)",
    `- Resultado: ${correct} de ${total} comprobaciones correctas${correct < total ? ` (${total - correct} fallan)` : ""}`,
    "",
  ].join("\n");
  const { records, byId } = manualKpis([
    { name: "demo-escenarios-2026-10-13.md", text: demo("2026-10-13T12:40:00.000Z", "https://adaceen.example", 92, 92) },
    { name: "demo-escenarios-2026-10-13-temprano.md", text: demo("2026-10-13T12:10:00.000Z", "https://adaceen.example", 80, 92) },
    { name: "demo-escenarios-local.md", text: demo("2026-10-13T11:00:00.000Z", "en memoria (usuarios y politica demo)", 92, 92) },
    { name: "demo-escenarios-roto.md", text: "# otra cosa\n" },
    { name: "pruebas-humo.csv", text: "fecha,hora,destino,correctas,total,evidencia,observaciones\n2026-10-20,07:30,https://adaceen.example,88,92,captura,\n2026-10-20,,https://adaceen.example,93,92,,\n" },
  ]);
  const t8 = byId.get("T8");
  assert.equal(t8?.value, 95.652, "88 de 92 el 2026-10-20");
  assert.equal(t8?.n, 2);
  assert.equal(t8?.meets, true);
  assert.match(t8?.summary || "", /^Peor sesión: 95,7 % \(88 de 92 comprobaciones, 2026-10-20\) en 2 sesiones/);
  const trace = traceOf(records, "T8");
  assert.ok(trace.includes("demo-escenarios-2026-10-13-temprano.md:- ignorada reemplazada por una corrida posterior del mismo día"));
  assert.ok(trace.includes("demo-escenarios-2026-10-13.md:- usada prueba de humo de la sesión"));
  assert.ok(trace.includes("demo-escenarios-local.md:- ignorada no es contra producción (backend sin https://)"));
  assert.ok(trace.some((line) => line.startsWith("demo-escenarios-roto.md:- descartada")));
  assert.ok(trace.includes("pruebas-humo.csv:3 descartada correctas y total deben ser enteros, con total > 0 y correctas ≤ total"));
});

test("T10: mediana por persona del camino por tunel; la Mac aparte y el respaldo en la hoja de la prueba", () => {
  // Cabecera anterior de la plantilla (editor_por_tunel, sin fecha ni camino): se sigue leyendo.
  const old = "persona,rol,navegador,sistema_operativo,inicio,overlay_con_sesion,editor_por_tunel,minutos_totales,ayuda_recibida,observaciones\nP1,estudiante,Chrome,Windows,09:00,09:05,09:11,,no,\nP2,estudiante,Edge,Windows,09:00,,09:20,13,si,\nP2,estudiante,Edge,Windows,,,,12,no,repetida\n,docente,Chrome,macOS,,,,10,no,\nP4,estudiante,Chrome,Windows,,,,300,no,\n";
  const { records, byId } = manualKpis([{ name: "tiempos-instalacion-validacion.csv", text: old }]);
  const t10 = byId.get("T10");
  assert.equal(t10?.value, 12, "mediana de 11 y 13");
  assert.equal(t10?.n, 2);
  assert.match(t10?.summary || "", /Mediana de 12 min en 2 personas por túnel \(máximo 13 min\); 1 con ayuda de otra persona\./);
  assert.match(t10?.summary || "", /El catálogo pide al menos 3 personas/);
  assert.match(t10?.summary || "", /fila 3: minutos_totales \(13\) no coincide con las horas \(20\)/);
  assert.deepEqual(traceOf(records, "T10").map((line) => line.replace(/^tiempos-instalacion-validacion\.csv:/, "")), [
    "2 usada calculado con inicio y editor_listo",
    "3 usada minutos_totales",
    "4 ignorada persona repetida en el mismo camino: cuenta su primera fila",
    "5 descartada falta persona (un código como V1 basta)",
    "6 descartada fuera de rango (más de 0 y hasta 240 minutos)",
  ]);

  // Sin tiempos-instalacion.csv: la hoja de la prueba de inicio a fin (P1.1 a P1.6 y P4.1 a P4.3 por cuenta).
  const sheet = parseCsvRecords(fs.readFileSync(path.resolve(process.cwd(), "data/piloto/plantillas/prueba-inicio-a-fin.csv"), "utf8"));
  const columns = Object.keys(sheet[0]);
  const fill = (paso: string, cuenta: string, values: Record<string, string>) => {
    const row = sheet.find((item) => item.paso === paso && item.cuenta === cuenta);
    assert.ok(row, `la hoja tiene ${paso} de ${cuenta}`);
    Object.assign(row as Record<string, string>, values);
  };
  fill("P1.1", "E1", { hora_inicio: "09:00" });
  fill("P1.6", "E1", { hora_fin: "09:14", resultado: "ok" });
  fill("P1.6", "E2", { minutos: "10", resultado: "ok" });
  fill("P4.1", "E2", { hora_inicio: "10:00" });
  fill("P4.3", "E2", { hora_fin: "10:07", resultado: "falla" });
  const fallback = manualKpis([
    { name: "prueba-inicio-a-fin-2026-09-26.csv", text: toCsvText(columns, sheet) },
    { name: "tiempos-instalacion.csv", text: MANUAL_TEMPLATES.find((item) => item.kpi === "T10")?.columns.join(",") || "" },
  ]);
  assert.equal(fallback.byId.get("T10")?.value, 12, "mediana de 14 (E1, por horas) y 10 (E2, minutos de P1.6)");
  assert.deepEqual((fallback.byId.get("T10")?.details as { archivos?: string[] }).archivos, ["prueba-inicio-a-fin-2026-09-26.csv"]);
  assert.ok(traceOf(fallback.records, "T10").some((line) => /descartada P4\.3 con resultado falla/.test(line)));
});

test("T10: el respaldo cubre el camino que tiempos-instalacion.csv no trae; la Mac se mide por las horas", () => {
  const sheet = parseCsvRecords(fs.readFileSync(path.resolve(process.cwd(), "data/piloto/plantillas/prueba-inicio-a-fin.csv"), "utf8"));
  const columns = Object.keys(sheet[0]);
  const fill = (paso: string, cuenta: string, values: Record<string, string>) => Object.assign(sheet.find((item) => item.paso === paso && item.cuenta === cuenta) as Record<string, string>, values);
  fill("P1.1", "E1", { hora_inicio: "09:00" });
  fill("P1.6", "E1", { hora_fin: "09:14", resultado: "ok" });
  fill("P1.1", "E2", { hora_inicio: "09:00" });
  fill("P1.6", "E2", { hora_fin: "09:12", minutos: "10", resultado: "ok" });
  // P4.3 con los minutos del paso (3), no los totales: se usan las horas de P4.1 a P4.3.
  fill("P4.1", "E2", { hora_inicio: "10:00", minutos: "4" });
  fill("P4.3", "E2", { hora_fin: "10:09", minutos: "3", resultado: "ok" });
  const endToEnd = { name: "prueba-inicio-a-fin-2026-09-26.csv", text: toCsvText(columns, sheet) };
  // Solo la Mac en tiempos-instalacion.csv: el tunel sale de la hoja de la prueba.
  const macOnly = manualKpis([endToEnd, { name: "tiempos-instalacion.csv", text: "persona,camino,minutos_totales,ayuda_recibida\nM1,mac,9,no\n" }]);
  const t10 = macOnly.byId.get("T10");
  assert.equal(t10?.value, 12, "mediana de 14 (E1, horas) y 10 (E2, minutos de P1.6)");
  assert.deepEqual((t10?.details as { archivos?: string[] }).archivos, ["tiempos-instalacion.csv", "prueba-inicio-a-fin-2026-09-26.csv"], "primero la hoja de tiempos y despues el respaldo");
  assert.deepEqual((t10?.details as { mac?: { n: number } }).mac?.n, 1, "la Mac de la hoja de la prueba no se suma a la de tiempos-instalacion.csv");
  assert.ok(traceOf(macOnly.records, "T10").some((line) => /ignorada tiempos-instalacion\.csv ya trae tiempos del camino Mac/.test(line)));
  // Sin tiempos-instalacion.csv: la Mac por las horas (9 min), con aviso de que los minutos de P4.3 no coinciden.
  const alone = manualKpis([endToEnd]);
  assert.equal((alone.byId.get("T10")?.details as { mac?: { mediana: number } }).mac?.mediana, 9);
  assert.match(alone.byId.get("T10")?.summary || "", /E2 P4\.1-P4\.3: los minutos de P4\.3 \(3\) no coinciden con las horas \(9\); se usan las horas\./);
  assert.ok(traceOf(alone.records, "T10").some((line) => /usada hora_inicio de P4\.1 a hora_fin de P4\.3/.test(line)));
  // Con los dos caminos en tiempos-instalacion.csv, la hoja de la prueba no entra.
  const both = manualKpis([endToEnd, { name: "tiempos-instalacion.csv", text: "persona,camino,minutos_totales,ayuda_recibida\nV1,tunel,11,no\nM1,mac,9,no\n" }]);
  assert.equal(both.byId.get("T10")?.value, 11);
  assert.ok(traceOf(both.records, "T10").includes("prueba-inicio-a-fin-2026-09-26.csv:- ignorada tiempos-instalacion.csv ya trae tiempos del túnel y de la Mac: la hoja de la prueba solo es el respaldo"));
});

test("plantillas: una fila con mas celdas que la cabecera (coma decimal sin comillas) se descarta con ese motivo", () => {
  const header = "persona,rol,fecha,camino,navegador,sistema_operativo,inicio,overlay_con_sesion,editor_listo,minutos_totales,ayuda_recibida,observaciones";
  const { records, byId } = manualKpis([{ name: "tiempos-instalacion.csv", text: `${header}\nV1,estudiante,2026-10-13,tunel,Chrome,Windows,,,,12,5,no,\nV2,estudiante,2026-10-13,tunel,Chrome,Windows,,,,"12,5",no,\n` }]);
  assert.equal(byId.get("T10")?.value, 12.5, "entre comillas la coma decimal vale");
  const trace = traceOf(records, "T10");
  assert.match(trace[0], /^tiempos-instalacion\.csv:2 descartada la fila tiene más celdas que la cabecera: ¿una coma decimal \(12,5\)/);
  assert.equal(records.rows.find((row) => row.fila === 2)?.valor, "13 celdas; la cabecera tiene 12");
  // Con separador «;» la coma decimal no corre las columnas.
  const semicolon = manualKpis([{ name: "tiempos-instalacion.csv", text: `${header.replace(/,/g, ";")}\nV1;estudiante;13/10/2026;tunel;Chrome;Windows;;;;12,5;Sí;\n` }]);
  assert.equal(semicolon.byId.get("T10")?.value, 12.5);
});

test("T11: cumplidos sobre aplicables, con los criticos obligatorios aunque el total pase", () => {
  const rows = COMPLIANCE_ITEMS.map((item) => ({ id: item.id, estado: item.id === "C01" ? "no cumple" : item.id === "C13" ? "No aplica" : "Sí" }));
  const text = toCsvText(["id", "estado"], [...rows, { id: "C99", estado: "cumple" }, { id: "C02", estado: "cumple" }, { id: "C03", estado: "quizas" }]);
  const { records, byId } = manualKpis([{ name: "cumplimiento-2026-10-01.csv", text: toCsvText(["id", "estado"], rows.map((row) => ({ ...row, estado: "" }))) }, { name: "cumplimiento-2026-10-10.csv", text }]);
  const t11 = byId.get("T11");
  const applicable = COMPLIANCE_ITEMS.length - 1;
  assert.equal(t11?.value, Math.round(((applicable - 1) / applicable) * 100 * 1000) / 1000);
  assert.ok((t11?.value as number) >= 80);
  assert.equal(t11?.meets, false, "C01 es critico");
  assert.match(t11?.summary || "", /No cumple: ítems críticos sin cumplir \(C01\)/);
  assert.deepEqual(traceOf(records, "T11").filter((line) => !/ usada /.test(line)), [
    "cumplimiento-2026-10-01.csv:- ignorada sin ítems marcados; cuenta cumplimiento-2026-10-10.csv",
    `cumplimiento-2026-10-10.csv:${COMPLIANCE_ITEMS.length + 2} descartada ítem desconocido: no está en la lista de cumplimiento`,
    `cumplimiento-2026-10-10.csv:${COMPLIANCE_ITEMS.length + 3} descartada ítem repetido: cuenta su primera fila`,
    `cumplimiento-2026-10-10.csv:${COMPLIANCE_ITEMS.length + 4} descartada ítem repetido: cuenta su primera fila`,
  ]);
  const blankText = renderManualTemplates().find((item) => item.file === "cumplimiento.csv")?.text || "";
  const blank = manualKpis([{ name: "cumplimiento.csv", text: blankText }]);
  assert.equal(blank.byId.get("T11")?.value, null, "la plantilla sin marcar no da valor");
});

test("T11 con varias hojas: la de fecha mas reciente con items marcados, nunca la plantilla copiada sin marcar", () => {
  const blankText = renderManualTemplates().find((item) => item.file === "cumplimiento.csv")?.text || "";
  const sheet = (estado: (id: string) => string) => toCsvText(["id", "estado"], COMPLIANCE_ITEMS.map((item) => ({ id: item.id, estado: estado(item.id) })));
  // «cumplimiento.csv» queda despues de «cumplimiento-2026-10-20.csv» por nombre: antes ganaba la plantilla sin marcar.
  const { records, byId } = manualKpis([
    { name: "cumplimiento-2026-10-20.csv", text: sheet(() => "cumple") },
    { name: "cumplimiento.csv", text: blankText },
    { name: "cumplimiento-2026-10-13.csv", text: sheet((id) => (id === "C01" ? "no cumple" : "cumple")) },
  ]);
  assert.equal(byId.get("T11")?.value, 100);
  assert.equal(byId.get("T11")?.meets, true);
  assert.deepEqual((byId.get("T11")?.details as { archivos?: string[] }).archivos, ["cumplimiento-2026-10-20.csv"]);
  assert.deepEqual(traceOf(records, "T11").filter((line) => / ignorada /.test(line)), [
    "cumplimiento-2026-10-13.csv:- ignorada hay una hoja con fecha más reciente en el nombre: cumplimiento-2026-10-20.csv",
    "cumplimiento.csv:- ignorada sin ítems marcados; cuenta cumplimiento-2026-10-20.csv",
  ]);
  // Sin fechas en el nombre: la que tenga mas items marcados.
  const undated = manualKpis([
    { name: "cumplimiento-final.csv", text: sheet((id) => (id === "C02" ? "" : "cumple")) },
    { name: "cumplimiento-vm.csv", text: sheet((id) => (["C26", "C27"].includes(id) ? "cumple" : "")) },
  ]);
  assert.deepEqual((undated.byId.get("T11")?.details as { archivos?: string[] }).archivos, ["cumplimiento-final.csv"]);
  assert.ok(traceOf(undated.records, "T11").includes(`cumplimiento-vm.csv:- ignorada cumplimiento-final.csv tiene más ítems marcados (${COMPLIANCE_ITEMS.length - 1} frente a 2)`));
});

test("T8 con el plan: una corrida de otro dia (la prueba de inicio a fin, un despliegue) no es una sesion", () => {
  const humo = "fecha,hora,destino,correctas,total,evidencia,observaciones\n2026-09-26,10:00,https://adaceen.example,70,92,,prueba de inicio a fin\n2026-10-13,08:00,https://adaceen.example,92,92,,\n";
  const demo = "# Evidencia\n\n- Fecha: 2026-10-12T22:00:00.000Z a 2026-10-12T22:01:00.000Z\n- Backend: https://adaceen.example\n- Resultado: 60 de 92 comprobaciones correctas (32 fallan)\n";
  const { records, byId } = manualKpis([
    { name: "pruebas-humo.csv", text: humo },
    { name: "demo-escenarios-despliegue.md", text: demo },
  ], ["2026-10-13", "2026-10-20"]);
  const t8 = byId.get("T8");
  assert.equal(t8?.value, 100);
  assert.equal(t8?.n, 1);
  assert.equal(t8?.meets, true);
  assert.match(t8?.summary || "", /Sesiones del plan sin prueba de humo ese mismo día: 2026-10-20\./);
  const trace = traceOf(records, "T8");
  assert.ok(trace.includes("pruebas-humo.csv:2 ignorada fecha fuera de las sesiones del plan del piloto (la prueba de humo cuenta el día de la sesión)"));
  assert.ok(trace.includes("demo-escenarios-despliegue.md:- ignorada fecha fuera de las sesiones del plan del piloto (la prueba de humo cuenta el día de la sesión)"), "17:00 en Bogota del dia anterior");
  // Sin plan (sin fechas de sesion) cuenta cualquier dia, como antes.
  assert.equal(manualKpis([{ name: "pruebas-humo.csv", text: humo }]).byId.get("T8")?.n, 2);
});

test("P5 y el plan: la plantilla gana y avisa si el plan dice otra cosa; sin plantilla valida queda el plan", () => {
  const text = "id,hallazgo,kpis,critica,estado,accion\nH1,Latencia alta al encender,T1;T2,si,implementada,Calentar el modelo\nH2,Sin sesion en VS Code,T6,si,en curso,Aviso\nH3,Texto largo,P6 X9,no,pendiente,\nH4,Otro,P1,tal vez,pendiente,\n";
  const { records, byId } = manualKpis([{ name: "hallazgos.csv", text }], [], { P5: 100, T10: 11 });
  const p5 = byId.get("P5");
  assert.equal(p5?.value, 50);
  assert.equal(p5?.meets, false);
  assert.match(p5?.summary || "", /1 de 2 mejoras críticas implementadas \(3 hallazgos en la hoja\); sin implementar: H2\./);
  assert.match(p5?.summary || "", /El plan del piloto dice 100 %; se usa el valor de las plantillas\./);
  assert.match(p5?.summary || "", /KPIs desconocidos X9/);
  assert.deepEqual(records.findings.map((finding) => `${finding.id} ${finding.kpis.join("+")}`), ["H1 T1+T2", "H2 T6", "H3 P6"]);
  assert.ok(traceOf(records, "P5").includes("hallazgos.csv:5 descartada critica debe ser si o no"));
  const t10 = byId.get("T10");
  assert.equal(t10?.value, 11);
  assert.equal((t10?.details as { origen?: string }).origen, "plan");
  assert.match(byId.get("T8")?.summary || "", /Se registra a mano en el plan del piloto o con la plantilla pruebas-humo\.csv/);
});

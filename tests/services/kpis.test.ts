import assert from "node:assert/strict";
import test from "node:test";
import { parseCsv, parseCsvRecords } from "../../src/services/csv.js";
import { KPI_CATALOG, meetsThreshold } from "../../src/services/kpi-catalog.js";
import { compareUnblocking, computeKpis, crossoverAnalysis, extractUnblockingEpisodes, formatValue } from "../../src/services/kpis.js";
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

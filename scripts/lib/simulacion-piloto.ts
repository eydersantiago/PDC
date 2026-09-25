import path from "node:path";
import { setTextModelOverrideForTests } from "../../src/services/agent-mode.js";
import { COMPLIANCE_ITEMS } from "../../src/services/compliance-checklist.js";
import { toCsvText } from "../../src/services/csv.js";
import { formatValue, MANUAL_KPI_IDS, MANUAL_TEMPLATES, type KpiResult, type ManualRecordFile } from "../../src/services/kpis.js";
import { seededRandom } from "../../src/services/pilot.js";
import type { PilotPlan } from "../../src/services/pilot-report.js";
import { pseudonymize } from "../../src/services/telemetry.js";
import { referenceModelOutput, SCENARIO_CPP_CODE } from "../../src/services/tutor-scenarios.js";
import { login, startInProcessBackend } from "./cli.js";
import { runPilotAnalysis, writeFileEnsured, writePilotDataset } from "./piloto.js";

/**
 * Ensayo tecnico del piloto (parte automatizable de A13.6): un piloto AB/BA
 * completo con estudiantes sinteticos contra el backend real en memoria.
 *
 * Recorre lo mismo que una sesion de clase: el docente asigna cohortes y
 * cambia de bloque, los estudiantes piden ayuda en VS Code y en el overlay,
 * se atascan y se desbloquean, y al final corren la limpieza del dataset y el
 * analisis de KPIs. Los tiempos de desbloqueo son sinteticos (con y sin tutor
 * tienen medianas distintas a proposito): el ensayo prueba la cadena, no el
 * tutor.
 */

export type SimulationCheck = { name: string; ok: boolean; detail: string };

export type SimulationResult = {
  students: number;
  events: number;
  checks: SimulationCheck[];
  kpis: KpiResult[];
  files: string[];
  cleaning: Awaited<ReturnType<typeof writePilotDataset>>["result"]["report"];
  plan: PilotPlan;
};

type Json = Record<string, unknown>;

async function api<T = Json>(baseUrl: string, method: string, route: string, headers: Record<string, string>, body?: unknown) {
  const response = await fetch(`${baseUrl}${route}`, {
    method,
    headers: { "Content-Type": "application/json; charset=utf-8", ...headers },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const data = await response.json().catch(() => ({})) as T;
  return { status: response.status, data };
}

function lognormal(random: () => number, median: number, sigma: number) {
  // Box-Muller con el generador sembrado.
  const u1 = Math.max(1e-9, random());
  const u2 = random();
  const z = Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * u2);
  return median * Math.exp(sigma * z);
}

function likert(random: () => number, weights = [0.03, 0.07, 0.15, 0.45, 0.30]) {
  let pick = random();
  for (let index = 0; index < weights.length; index += 1) {
    pick -= weights[index];
    if (pick <= 0) return index + 1;
  }
  return 5;
}

function dayInBogota(date: Date) {
  return new Intl.DateTimeFormat("en-CA", { timeZone: "America/Bogota", year: "numeric", month: "2-digit", day: "2-digit" }).format(date);
}

function syntheticSurvey(random: () => number, respondents: number) {
  const header = [
    "Marca temporal",
    ...Array.from({ length: 10 }, (_, index) => `SUS${index + 1}`),
    ...Array.from({ length: 6 }, (_, index) => `UX${index + 1}`),
    ...Array.from({ length: 5 }, (_, index) => `PA${index + 1}`),
    "CMP1. ¿En qué bloque resolviste mejor tus errores?",
    "CMP2. ¿Con cuál preferirías trabajar?",
    "AB1. Lo más útil",
    "AB2. Qué mejorarías",
    "AB3. Cuándo estorbó",
  ];
  const lines = [header.map((cell) => `"${cell}"`).join(",")];
  const openAnswers = ["Las pistas sin darme el código", "Que respondiera más rápido", "Cuando el mensaje era muy largo", "Las fuentes del curso", ""];
  for (let person = 0; person < respondents; person += 1) {
    // SUS: los impares se contestan de acuerdo y los pares en desacuerdo en un sistema usable.
    const sus = Array.from({ length: 10 }, (_, index) => index % 2 === 0 ? likert(random) : 6 - likert(random));
    const ux = Array.from({ length: 6 }, () => likert(random));
    const pa = Array.from({ length: 5 }, () => likert(random));
    const row = [
      new Date().toISOString(),
      ...sus.map(String),
      ...ux.map(String),
      ...pa.map(String),
      random() < 0.7 ? "Con tutor" : random() < 0.5 ? "Igual" : "Sin tutor",
      random() < 0.8 ? "Con tutor" : "Sin tutor",
      openAnswers[Math.floor(random() * openAnswers.length)],
      openAnswers[Math.floor(random() * openAnswers.length)],
      "",
    ];
    lines.push(row.map((cell) => `"${cell}"`).join(","));
  }
  return `${lines.join("\n")}\n`;
}

function columnsOf(file: string) {
  return (MANUAL_TEMPLATES.find((template) => template.file === file) as { columns: string[] }).columns;
}

/**
 * Plantillas llenas sinteticas para los KPIs manuales (T7, T8, T10, T11, P5),
 * con las columnas de data/piloto/plantillas/. Valores fijos (el ensayo sigue
 * siendo determinista) y a proposito algunas filas que deben quedar fuera:
 * una prueba de humo contra el backend en memoria, otra reemplazada por una
 * corrida posterior del mismo dia y un tiempo de instalacion mal escrito.
 */
export function syntheticManualRecords(sessionDate: string): ManualRecordFile[] {
  return [
    {
      name: `registro-incidentes-${sessionDate}.csv`,
      text: toCsvText(columnsOf("registro-incidentes.csv"), [
        { fecha: sessionDate, hora_inicio: "14:20", hora_fin: "14:31", severidad: "S2", sintoma: "Un estudiante sintético sin sesión en VS Code", afectados: 1, causa: "ensayo", respuesta: "Abrir mi editor", responsable: "ensayo", evidencia: "sintética" },
        { fecha: sessionDate, hora_inicio: "15:05", hora_fin: "15:12", severidad: "S3", sintoma: "Latencia alta sintética", afectados: 4, causa: "ensayo", respuesta: "esperar", responsable: "ensayo", evidencia: "sintética" },
      ]),
    },
    {
      name: "pruebas-humo.csv",
      text: toCsvText(columnsOf("pruebas-humo.csv"), [
        { fecha: sessionDate, hora: "08:10", destino: "https://ensayo.invalid", correctas: 90, total: 92, evidencia: "sintética", observaciones: "falló y se repitió" },
        { fecha: sessionDate, hora: "08:40", destino: "https://ensayo.invalid", correctas: 92, total: 92, evidencia: "sintética", observaciones: "" },
        { fecha: sessionDate, hora: "07:50", destino: "en memoria", correctas: 92, total: 92, evidencia: "sintética", observaciones: "no cuenta: no es contra producción" },
      ]),
    },
    {
      name: "tiempos-instalacion.csv",
      text: toCsvText(columnsOf("tiempos-instalacion.csv"), [
        { persona: "V1", rol: "estudiante", fecha: sessionDate, camino: "tunel", navegador: "Chrome", sistema_operativo: "Windows 11", inicio: "08:00", overlay_con_sesion: "08:06", editor_listo: "08:12", minutos_totales: "12", ayuda_recibida: "no" },
        { persona: "V2", rol: "estudiante", fecha: sessionDate, camino: "tunel", navegador: "Edge", sistema_operativo: "Windows 11", inicio: "08:00", overlay_con_sesion: "08:05", editor_listo: "08:14", minutos_totales: "", ayuda_recibida: "no" },
        { persona: "V3", rol: "docente", fecha: sessionDate, camino: "tunel", navegador: "Chrome", sistema_operativo: "macOS", inicio: "08:02", overlay_con_sesion: "08:09", editor_listo: "08:17", minutos_totales: "15", ayuda_recibida: "si" },
        { persona: "V4", rol: "estudiante", fecha: sessionDate, camino: "mac", navegador: "Chrome", sistema_operativo: "macOS 15", inicio: "08:00", overlay_con_sesion: "08:04", editor_listo: "08:09", minutos_totales: "9", ayuda_recibida: "no" },
        { persona: "V5", rol: "estudiante", fecha: sessionDate, camino: "tunel", navegador: "Chrome", sistema_operativo: "Windows 11", minutos_totales: "doce", ayuda_recibida: "no", observaciones: "fila mal llenada a propósito" },
      ]),
    },
    {
      name: "cumplimiento.csv",
      text: toCsvText(columnsOf("cumplimiento.csv"), COMPLIANCE_ITEMS.map((item) => ({
        id: item.id,
        area: item.area,
        item: item.item,
        critico: item.critical ? "si" : "no",
        verificacion: item.verification,
        estado: item.id === "C13" || item.id === "C30" ? "no aplica" : item.id === "C22" ? "no cumple" : "cumple",
        evidencia: "sintética",
        responsable: "ensayo",
        fecha: sessionDate,
      }))),
    },
    {
      name: "hallazgos.csv",
      text: toCsvText(columnsOf("hallazgos.csv"), [
        { id: "H1", hallazgo: "Hallazgo sintético H1 (ensayo)", kpis: "T1; T2", critica: "si", estado: "implementada", accion: "Mejora sintética H1", evidencia: "graficas/t1-latencia.svg", responsable: "ensayo" },
        { id: "H2", hallazgo: "Hallazgo sintético H2 (ensayo)", kpis: "T6; P3", critica: "si", estado: "implementada", accion: "Mejora sintética H2", evidencia: "limpieza.md", responsable: "ensayo" },
        { id: "H3", hallazgo: "Hallazgo sintético H3 (ensayo)", kpis: "P6", critica: "si", estado: "pendiente", accion: "Mejora sintética H3", evidencia: "informe-kpis.md", responsable: "ensayo" },
        { id: "H4", hallazgo: "Hallazgo sintético H4 (ensayo)", kpis: "U2", critica: "no", estado: "pendiente", accion: "", evidencia: "encuesta", responsable: "ensayo" },
      ]),
    },
  ];
}

/** Errores de compilacion frecuentes en C++ (se repiten entre episodios, como en clase). */
const CPP_ERRORS = [
  (line: number) => `cuenta.cpp:${line}:5: error: 'saldo' was not declared in this scope`,
  (line: number) => `cuenta.cpp:${line}:48: error: expected ';' before '}' token`,
  (line: number) => `cuenta.cpp:${line}:12: error: no matching function for call to 'Cuenta::depositar()'`,
  (line: number) => `cuenta.cpp:${line}:9: error: invalid conversion from 'int' to 'const char*'`,
  (line: number) => `cuenta.cpp:${line}:3: error: 'double Cuenta::saldo' is private within this context`,
];

export async function runPilotSimulation(options: { students?: number; seed?: string; outDir: string }): Promise<SimulationResult> {
  const previousLogLevel = process.env.ADACEEN_LOG_LEVEL;
  process.env.ADACEEN_LOG_LEVEL = previousLogLevel || "warn";
  const studentCount = Math.max(4, Math.min(60, options.students ?? 12));
  const seed = options.seed || "ensayo-tecnico-adaceen";
  const random = seededRandom(seed);
  const checks: SimulationCheck[] = [];
  const check = (name: string, ok: boolean, detail: string) => checks.push({ name, ok, detail });

  // Generador aparte para la espera del modelo: los datos sinteticos no dependen de cuantas veces se le llama.
  const delayRandom = seededRandom(`${seed}:latencia`);
  setTextModelOverrideForTests(async (input) => {
    await new Promise((resolve) => setTimeout(resolve, 40 + Math.floor(delayRandom() * 220)));
    return referenceModelOutput(input);
  });
  const backend = await startInProcessBackend();
  try {
    const { baseUrl, database } = backend;
    const password = "Ensayo123!";
    const students: Array<{ email: string; sessionId: string; index: number; seq: number }> = [];
    for (let index = 1; index <= studentCount; index += 1) {
      const email = `ensayo${String(index).padStart(2, "0")}@piloto.test`;
      // Id fijo: la asignacion de cohortes ordena por id, asi que con la misma semilla el ensayo da los mismos datos.
      await database.createManagedUser({ id: `user-ensayo-${String(index).padStart(2, "0")}`, role: "student", email, displayName: `Estudiante sintético ${index}`, password, teacherUserId: "user-teacher-demo" });
      students.push({ email, sessionId: await login(baseUrl, email, password), index, seq: 0 });
    }
    const demoStudent = { email: "estudiante@adaceen.edu.co", sessionId: await login(baseUrl, "estudiante@adaceen.edu.co", "Estudiante123!"), index: 0, seq: 0 };
    const teacher = await login(baseUrl, "docente@adaceen.edu.co", "Docente123!");
    const asTeacher = { "x-session-id": teacher };

    const assigned = await api<{ counts: { A: number; B: number }; students: Array<{ displayName: string; cohort: string }> }>(baseUrl, "POST", "/api/pilot/assign", asTeacher, { seed });
    const counts = assigned.data.counts;
    check("Cohortes balanceadas", Math.abs(counts.A - counts.B) <= 1, `A = ${counts.A}, B = ${counts.B} (incluye la cuenta de prueba)`);
    const cohortByName = new Map(assigned.data.students.map((student) => [student.displayName, student.cohort]));
    const cohortOf = (index: number) => cohortByName.get(`Estudiante sintético ${index}`) || "";

    const now = Date.now();
    const windows: Record<1 | 2, { start: number; end: number }> = {
      1: { start: now - 110 * 60_000, end: now - 62 * 60_000 },
      2: { start: now - 55 * 60_000, end: now - 7 * 60_000 },
    };
    const factor = new Map(students.map((student) => [student.index, lognormal(random, 1, 0.3)]));
    let pendingCrossing: { student: typeof students[number]; errorText: string; detectedAt: number } | null = null;
    let lostSeqDone = false;
    let duplicateDone = false;
    const pilotChecks = { noTutorBlocked: 0, noTutorTotal: 0, withTutorAnswered: 0, withTutorTotal: 0 };

    const postEvents = async (student: { sessionId: string }, events: Json[]) => {
      const result = await api(baseUrl, "POST", "/api/behavior/events", { "x-session-id": student.sessionId }, { events });
      if (result.status !== 200) throw new Error(`eventos rechazados (${result.status}): ${JSON.stringify(result.data)}`);
    };
    const vscodeEvent = (student: typeof students[number], event: Json) => {
      student.seq += 1;
      return {
        source: "vscode_extension",
        schemaVersion: "1.1",
        clientSessionId: `vscode-ensayo-${student.index}`,
        seq: student.seq,
        filePath: `src/ejercicio-${student.index}.cpp`,
        language: "cpp",
        ...event,
      };
    };

    for (const block of [1, 2] as const) {
      await api(baseUrl, "PUT", "/api/pilot/block", asTeacher, { block });
      const window = windows[block];
      for (const student of students) {
        const cohort = cohortOf(student.index);
        const condition = (cohort === "A") === (block === 1) ? "con_tutor" : "sin_tutor";
        const headers = { "x-session-id": student.sessionId };
        const baseMedian = (condition === "con_tutor" ? 170 : 240) * (factor.get(student.index) || 1);
        const episodes = 2 + Math.floor(random() * 3);
        let cursor = window.start + Math.floor(random() * 5 * 60_000);
        for (let episode = 0; episode < episodes; episode += 1) {
          const errorText = CPP_ERRORS[Math.floor(random() * CPP_ERRORS.length)](10 + episode * 7);
          const detectedAt = cursor + 95_000;
          const events: Json[] = [
            vscodeEvent(student, { category: "signal", eventType: "compile_error_detected", errorText, occurredAt: new Date(cursor).toISOString(), metadata: { line: 10 + episode, errorCount: 1 } }),
            vscodeEvent(student, { category: "signal", eventType: "blocking_detected", errorText, durationMs: 95_000, count: 1, occurredAt: new Date(detectedAt).toISOString(), metadata: { reason: "persistent", errorCount: 1 } }),
          ];
          // Un evento perdido (hueco de seq) y un duplicado para ejercitar T4, T5 y D5.
          if (!lostSeqDone && block === 1 && episode === 0) {
            student.seq += 1;
            lostSeqDone = true;
          }
          const durationS = Math.max(100, lognormal(random, baseMedian, 0.45));
          // Sin cierre: a veces el estudiante no lo resuelve y el bloque termina antes.
          const unresolved = random() < 0.1 || cursor + durationS * 1000 > window.end - 60_000;
          if (block === 1 && episode === episodes - 1 && cohort === "B" && !pendingCrossing) {
            pendingCrossing = { student, errorText, detectedAt };
            await postEvents(student, events);
          } else if (unresolved) {
            await postEvents(student, events);
          } else {
            const away = random() < 0.1;
            const resolvedAt = cursor + durationS * 1000;
            events.push(vscodeEvent(student, {
              category: "signal",
              eventType: "blocking_resolved",
              errorText,
              durationMs: Math.round(durationS * 1000),
              occurredAt: new Date(resolvedAt).toISOString(),
              metadata: { blockedForMs: Math.round(durationS * 1000) - 95_000, resolvedWhileAway: away, errorCount: 0 },
            }));
            await postEvents(student, events);
            if (!duplicateDone && block === 2) {
              await postEvents(student, [events[events.length - 1]]);
              duplicateDone = true;
            }
          }
          cursor += Math.round(durationS * 1000) + Math.floor(random() * 4 * 60_000) + 60_000;
        }

        // Ayuda en VS Code: con tutor responde el modelo; sin tutor, el mensaje del piloto.
        for (let request = 0; request < (condition === "con_tutor" ? 2 : 1); request += 1) {
          const suggest = await api<{ blocked?: boolean; decision_id?: string | null; policy_applied?: { reasonCode?: string } | null }>(baseUrl, "POST", "/suggest-tab", headers, {
            tab_content: SCENARIO_CPP_CODE,
            tab_title: `ejercicio-${student.index}.cpp`,
            filePath: `src/ejercicio-${student.index}.cpp`,
            languageHint: "cpp",
            visibleError: `ejercicio-${student.index}.cpp:12:5: error: expected ';' before '}' token`,
            trigger: "blocking",
          });
          if (condition === "sin_tutor") {
            pilotChecks.noTutorTotal += 1;
            if (suggest.data.policy_applied?.reasonCode === "pilot_no_tutor") pilotChecks.noTutorBlocked += 1;
            continue;
          }
          pilotChecks.withTutorTotal += 1;
          if (suggest.data.blocked === false) pilotChecks.withTutorAnswered += 1;
          const decisionId = String(suggest.data.decision_id || "");
          const shownAt = window.start + Math.floor(random() * (window.end - window.start));
          const events: Json[] = [vscodeEvent(student, { category: "suggestion", eventType: "vscode_suggestion_shown", decisionId, latencyMs: 1200 + Math.floor(random() * 4000), occurredAt: new Date(shownAt).toISOString() })];
          if (random() < 0.5) {
            const check = await api<{ allowed?: boolean }>(baseUrl, "POST", "/api/suggestions/apply-check", headers, { decisionId, filePath: `src/ejercicio-${student.index}.cpp`, language: "cpp", applyMode: "replace", linesChanged: 2 });
            if (check.data.allowed) {
              events.push(vscodeEvent(student, { category: "suggestion", eventType: "suggestion_completion_applied", decisionId, occurredAt: new Date(shownAt + 20_000).toISOString(), metadata: { applyMode: "replace", linesChanged: 2 } }));
            }
          }
          await postEvents(student, events);
        }

        // Una consulta en el overlay y su valoracion.
        const overlay = await api<{ decision_id?: string | null; blocked?: boolean }>(baseUrl, "POST", "/intervene", headers, {
          question: "Por que no compila mi clase?",
          context: {
            pageType: "github_code",
            repoFullName: `curso-fpoo/taller-3-ensayo-${student.index}`,
            filePath: `src/ejercicio-${student.index}.cpp`,
            languageHint: "cpp",
            activityTitle: "Taller 3 - Cuenta bancaria",
            visibleError: `src/ejercicio-${student.index}.cpp:6:48: error: expected ';' before '}' token`,
            codeSnippet: SCENARIO_CPP_CODE,
          },
          max_items: 4,
        });
        if (condition === "con_tutor" && overlay.data.decision_id) {
          const at = window.start + Math.floor(random() * (window.end - window.start - 60_000));
          await postEvents(student, [
            { source: "browser_extension", category: "tutor", eventType: "tutor_response_shown", schemaVersion: "1.1", clientSessionId: `overlay-ensayo-${student.index}`, seq: block * 10 + 1, decisionId: overlay.data.decision_id, occurredAt: new Date(at).toISOString() },
            { source: "browser_extension", category: "tutor", eventType: random() < 0.75 ? "tutor_response_accepted" : "tutor_response_rejected", schemaVersion: "1.1", clientSessionId: `overlay-ensayo-${student.index}`, seq: block * 10 + 2, decisionId: overlay.data.decision_id, occurredAt: new Date(at + 30_000).toISOString() },
          ]);
        }
      }

      if (block === 2 && pendingCrossing) {
        // Episodio que empezo en el bloque 1 y se cierra en el 2: no entra en P1.
        const crossing = pendingCrossing as { student: typeof students[number]; errorText: string; detectedAt: number };
        await postEvents(crossing.student, [vscodeEvent(crossing.student, {
          category: "signal",
          eventType: "blocking_resolved",
          errorText: crossing.errorText,
          durationMs: windows[2].start - crossing.detectedAt + 60_000,
          occurredAt: new Date(windows[2].start + 60_000).toISOString(),
          metadata: { blockedForMs: windows[2].start - crossing.detectedAt, resolvedWhileAway: false },
        })]);
      }
    }

    // Ruido que la limpieza debe sacar: docente, cliente anonimo y cuenta de prueba.
    await api(baseUrl, "POST", "/api/behavior/events", asTeacher, { events: [{ source: "browser_extension", category: "navigation", eventType: "overlay_opened", schemaVersion: "1.1", clientSessionId: "overlay-docente", seq: 1 }] });
    await api(baseUrl, "POST", "/api/behavior/events", { "x-adaceen-client-id": "vscode-sin-sesion-01" }, { events: [{ source: "vscode_extension", category: "signal", eventType: "compile_error_detected", schemaVersion: "1.1", clientSessionId: "vscode-anonimo", seq: 1, errorText: "error: x" }] });
    await api(baseUrl, "PUT", "/api/pilot/block", asTeacher, { block: 1 });
    await postEvents(demoStudent, [{ source: "vscode_extension", category: "signal", eventType: "compile_error_detected", schemaVersion: "1.1", clientSessionId: "vscode-prueba", seq: 1, errorText: "error: prueba" }]);
    await api(baseUrl, "PUT", "/api/pilot/block", asTeacher, { block: 0 });

    check("Sin tutor: el motor responde el mensaje del piloto sin llamar al modelo", pilotChecks.noTutorTotal > 0 && pilotChecks.noTutorBlocked === pilotChecks.noTutorTotal, `${pilotChecks.noTutorBlocked} de ${pilotChecks.noTutorTotal} pedidos con reasonCode pilot_no_tutor`);
    check("Con tutor: el modelo responde", pilotChecks.withTutorTotal > 0 && pilotChecks.withTutorAnswered === pilotChecks.withTutorTotal, `${pilotChecks.withTutorAnswered} de ${pilotChecks.withTutorTotal} pedidos respondidos`);

    const rows = await database.listTelemetryEvents({ limit: 200_000 });
    const studentRows = rows.filter((row) => row.actorRole === "student" && row.actorKind === "user" && row.actorAnonId !== pseudonymize("user:user-student-demo"));
    const stamped = studentRows.filter((row) => row.pilotCondition === "con_tutor" || row.pilotCondition === "sin_tutor");
    check("Cada evento de los estudiantes lleva bloque, cohorte y condición", stamped.length === studentRows.length, `${stamped.length} de ${studentRows.length} eventos con condición`);

    const blockStart = new Date(windows[1].start);
    const plan: PilotPlan = {
      nombre: "Ensayo técnico con estudiantes sintéticos",
      participantesConConsentimiento: studentCount,
      zonaHoraria: "America/Bogota",
      sesiones: [{ fecha: dayInBogota(blockStart), grupo: "Simulado", presentes: studentCount }],
      cuentasPrueba: ["estudiante@adaceen.edu.co"],
      registros: {},
    };
    const datasetDir = path.join(options.outDir, "dataset");
    const dataset = await writePilotDataset({
      rows,
      testActors: [pseudonymize("user:user-student-demo")],
      outDir: datasetDir,
      source: "backend en memoria (ensayo técnico)",
      window: `${new Date(windows[1].start).toISOString()} a ${new Date().toISOString()}`,
    });
    const excludedBy = dataset.result.report.excludedByRule;
    check("La limpieza saca docente, cliente anónimo, cuenta de prueba y duplicado", excludedBy.D1_no_estudiante > 0 && excludedBy.D2_cliente_anonimo > 0 && excludedBy.D3_cuenta_de_prueba > 0 && excludedBy.D5_duplicado === 1,
      `D1 ${excludedBy.D1_no_estudiante}, D2 ${excludedBy.D2_cliente_anonimo}, D3 ${excludedBy.D3_cuenta_de_prueba}, D4 ${excludedBy.D4_sin_condicion}, D5 ${excludedBy.D5_duplicado}`);

    const respondents = studentCount - 1;
    // KPIs manuales: plantillas llenas sinteticas, escritas como las dejaria el equipo.
    const records = syntheticManualRecords(plan.sesiones[0].fecha);
    const recordFiles: string[] = [];
    for (const record of records) recordFiles.push(await writeFileEnsured(path.join(options.outDir, "registros", record.name), record.text));
    const analysis = await runPilotAnalysis({
      rows: dataset.result.kept,
      surveyText: syntheticSurvey(random, respondents),
      plan,
      outDir: path.join(options.outDir, "analisis"),
      datasetDescription: `${dataset.result.kept.length} eventos limpios de ${rows.length} (ensayo técnico, datos sintéticos)`,
      cleaning: dataset.result.report,
      synthetic: true,
      records,
    });
    const byId = new Map(analysis.kpis.map((kpi) => [kpi.id, kpi]));
    const p1 = byId.get("P1");
    check("P1 se calcula con estudiantes pareados y prueba de Wilcoxon", (p1?.n || 0) >= Math.floor(studentCount * 0.6) && p1?.value !== null, `${p1?.n || 0} estudiantes pareados; ${p1?.summary || ""}`);
    const crossing = Number((p1?.details as { crossingEpisodes?: number } | undefined)?.crossingEpisodes || 0);
    check("El episodio que cruza de bloque queda fuera de P1", crossing === 1, `${crossing} episodio(s) cruzando de bloque`);
    check("T4 detecta el evento perdido y T5 el duplicado queda fuera", (byId.get("T4")?.value || 0) > 0 && (byId.get("T5")?.value ?? -1) === 0,
      `T4 = ${formatValue(byId.get("T4")?.value ?? null, "%")}; T5 = ${formatValue(byId.get("T5")?.value ?? null, "%")} en el dataset limpio`);
    check("La encuesta se lee sin avisos y da U1, U2 y P4", analysis.surveyWarnings.length === 0 && ["U1", "U2", "P4"].every((id) => byId.get(id)?.value !== null), analysis.surveyWarnings.join(" ") || `${respondents} respuestas`);
    check("El informe, los CSV y las gráficas quedan escritos", analysis.files.some((file) => file.endsWith("informe-kpis.md")) && analysis.charts.length >= 5, `${analysis.files.length} archivos, ${analysis.charts.length} gráficas`);
    const expectedManual: Record<string, number> = { T7: 0, T8: 100, T10: 14, T11: 96.429, P5: 66.667 };
    const manualOk = MANUAL_KPI_IDS.every((id) => byId.get(id)?.value === expectedManual[id] && (byId.get(id)?.details as { origen?: string } | undefined)?.origen === "plantilla");
    check("Los KPIs manuales salen de las plantillas llenas", manualOk,
      MANUAL_KPI_IDS.map((id) => `${id} = ${formatValue(byId.get(id)?.value ?? null, byId.get(id)?.unit || "")}`).join("; "));
    const traced = analysis.records?.rows || [];
    const has = (estado: string, pattern: RegExp) => traced.some((row) => row.estado === estado && pattern.test(row.motivo));
    const traceOk = has("descartada", /minutos_totales no es un número/)
      && has("ignorada", /no es contra producción/)
      && has("ignorada", /reemplazada por una corrida posterior/)
      && analysis.files.some((file) => file.endsWith("registros-manuales.csv"));
    check("Cada fila de las plantillas queda trazada y las inválidas quedan fuera con su motivo", traceOk,
      `${traced.filter((row) => row.estado === "usada").length} usadas, ${traced.filter((row) => row.estado === "descartada").length} descartadas y ${traced.filter((row) => row.estado === "ignorada").length} ignoradas en registros-manuales.csv`);

    return {
      students: studentCount,
      events: rows.length,
      checks,
      kpis: analysis.kpis,
      files: [...dataset.files, ...recordFiles, ...analysis.files],
      cleaning: dataset.result.report,
      plan,
    };
  } finally {
    setTextModelOverrideForTests(null);
    await backend.close();
    if (previousLogLevel === undefined) delete process.env.ADACEEN_LOG_LEVEL;
    else process.env.ADACEEN_LOG_LEVEL = previousLogLevel;
  }
}

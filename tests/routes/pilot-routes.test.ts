import assert from "node:assert/strict";
import test from "node:test";
import type { Server } from "node:http";
import { createApp } from "../../src/app.js";
import { createDatabase, type AppDatabase } from "../../src/db/database.js";
import { setTextModelOverrideForTests } from "../../src/services/agent-mode.js";
import { assignPilotCohorts, PILOT_NO_TUTOR_MESSAGE } from "../../src/services/pilot.js";
import { referenceModelOutput, SCENARIO_CPP_CODE } from "../../src/services/tutor-scenarios.js";

/**
 * A13.1 (piloto AB/BA): el docente asigna cohortes y cambia de bloque; en el
 * bloque sin tutor el motor no llama al modelo ni deja aplicar codigo, y cada
 * evento del estudiante queda con su bloque, cohorte y condicion.
 */

async function startTestServer() {
  const database = await createDatabase();
  const app = createApp(database);
  const server = await new Promise<Server>((resolve) => {
    const started = app.listen(0, () => resolve(started));
  });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("No se pudo iniciar servidor de prueba.");
  return { database, server, baseUrl: `http://127.0.0.1:${address.port}` };
}

async function stopTestServer(server: Server, database: AppDatabase) {
  await new Promise<void>((resolve, reject) => {
    server.close((error) => error ? reject(error) : resolve());
  });
  await database.close();
}

async function login(baseUrl: string, email: string, password: string) {
  const response = await fetch(`${baseUrl}/api/auth/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json; charset=utf-8" },
    body: JSON.stringify({ email, password }),
  });
  const data = await response.json() as { session?: { id?: string } };
  assert.equal(response.status, 200, `login ${email}`);
  return String(data.session?.id || "");
}

async function call<T>(baseUrl: string, method: string, route: string, sessionId: string, body?: unknown) {
  const response = await fetch(`${baseUrl}${route}`, {
    method,
    headers: { "Content-Type": "application/json; charset=utf-8", ...(sessionId ? { "x-session-id": sessionId } : {}) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  return { status: response.status, data: await response.json() as T };
}

type PilotSummary = {
  ok: boolean;
  block: number;
  seed: string;
  description?: string;
  added?: number;
  assignedAutomatically?: boolean;
  message?: string;
  counts: { A: number; B: number; sinAsignar: number };
  students: Array<{ id: string; displayName: string; cohort: string }>;
  error?: string;
};

const EDITOR_BODY = {
  tab_content: SCENARIO_CPP_CODE,
  tab_title: "cuenta.cpp",
  filePath: "src/cuenta.cpp",
  languageHint: "cpp",
  visibleError: "cuenta.cpp:6:48: error: expected ';' before '}' token",
  trigger: "blocking",
};

test("piloto AB/BA: cohortes, bloques, tutor apagado por cohorte y condicion en la telemetria", async () => {
  const { server, database, baseUrl } = await startTestServer();
  const prompts: string[] = [];
  setTextModelOverrideForTests(async (input) => {
    prompts.push(input);
    return referenceModelOutput(input);
  });
  try {
    for (const name of ["Ana", "Bruno", "Carla"]) {
      await database.createManagedUser({
        role: "student",
        email: `${name.toLowerCase()}@piloto.edu.co`,
        displayName: `${name} Piloto`,
        password: "Piloto123!",
        teacherUserId: "user-teacher-demo",
      });
    }
    const teacher = await login(baseUrl, "docente@adaceen.edu.co", "Docente123!");
    const demoStudent = await login(baseUrl, "estudiante@adaceen.edu.co", "Estudiante123!");

    const initial = await call<PilotSummary>(baseUrl, "GET", "/api/pilot", teacher);
    assert.equal(initial.status, 200);
    assert.equal(initial.data.block, 0);
    assert.equal(initial.data.counts.sinAsignar, 4);

    const forbidden = await call<PilotSummary>(baseUrl, "PUT", "/api/pilot/block", demoStudent, { block: 1 });
    assert.equal(forbidden.status, 403, "un estudiante no maneja el piloto");
    // Sin cohortes, iniciar un bloque las asigna solo (ver la prueba de
    // asignacion automatica); aqui se asignan antes con una semilla fija.

    const assigned = await call<PilotSummary>(baseUrl, "POST", "/api/pilot/assign", teacher, { seed: "prueba-piloto" });
    assert.equal(assigned.status, 200);
    assert.deepEqual(assigned.data.counts, { A: 2, B: 2, sinAsignar: 0 });
    assert.equal(assigned.data.seed, "prueba-piloto");

    const block1 = await call<PilotSummary>(baseUrl, "PUT", "/api/pilot/block", teacher, { block: 1 });
    assert.equal(block1.data.block, 1);

    const cohortOf = new Map(block1.data.students.map((student) => [student.displayName, student.cohort]));
    const emails: Record<string, string> = {
      "Estudiante Demo": "estudiante@adaceen.edu.co",
      "Ana Piloto": "ana@piloto.edu.co",
      "Bruno Piloto": "bruno@piloto.edu.co",
      "Carla Piloto": "carla@piloto.edu.co",
    };
    const passwordFor = (name: string) => name === "Estudiante Demo" ? "Estudiante123!" : "Piloto123!";
    const nameA = [...cohortOf].find(([, cohort]) => cohort === "A")![0];
    const nameB = [...cohortOf].find(([, cohort]) => cohort === "B")![0];
    const studentA = await login(baseUrl, emails[nameA], passwordFor(nameA));
    const studentB = await login(baseUrl, emails[nameB], passwordFor(nameB));

    // Bloque 1: la cohorte B trabaja sin tutor.
    const me = await call<{ block: number; condition: string }>(baseUrl, "GET", "/api/pilot/me", studentB);
    assert.deepEqual({ block: me.data.block, condition: me.data.condition }, { block: 1, condition: "sin_tutor" });

    const promptsBefore = prompts.length;
    const blockedSuggest = await call<{ blocked: boolean; output_text: string; policy_applied: { reasonCode: string } | null; code_application: { allowed: boolean } | null }>(
      baseUrl, "POST", "/suggest-tab", studentB, EDITOR_BODY,
    );
    assert.equal(blockedSuggest.status, 200);
    assert.equal(blockedSuggest.data.blocked, true);
    assert.equal(blockedSuggest.data.policy_applied?.reasonCode, "pilot_no_tutor");
    assert.ok(blockedSuggest.data.output_text.includes(PILOT_NO_TUTOR_MESSAGE));
    assert.doesNotMatch(blockedSuggest.data.output_text, /Aplicar:/);
    assert.equal(blockedSuggest.data.code_application?.allowed, false);

    const blockedOverlay = await call<{ blocked: boolean; policy_applied: { reasonCode: string } | null; result: { welcome_message: string } }>(
      baseUrl, "POST", "/intervene", studentB,
      { question: "No compila mi clase", context: { visibleError: EDITOR_BODY.visibleError, filePath: "src/cuenta.cpp", selection: "saldo += monto" }, max_items: 5 },
    );
    assert.equal(blockedOverlay.data.blocked, true);
    assert.equal(blockedOverlay.data.policy_applied?.reasonCode, "pilot_no_tutor");
    assert.equal(blockedOverlay.data.result.welcome_message, PILOT_NO_TUTOR_MESSAGE);
    assert.equal(prompts.length, promptsBefore, "sin tutor no se llama al modelo");

    const applyB = await call<{ allowed: boolean; reasonCode: string }>(
      baseUrl, "POST", "/api/suggestions/apply-check", studentB,
      { filePath: "src/cuenta.cpp", applyMode: "insert", linesChanged: 1 },
    );
    assert.equal(applyB.data.allowed, false);
    assert.equal(applyB.data.reasonCode, "pilot_no_tutor");

    // La cohorte A si tiene tutor en el bloque 1.
    const withTutor = await call<{ blocked: boolean }>(baseUrl, "POST", "/suggest-tab", studentA, EDITOR_BODY);
    assert.equal(withTutor.data.blocked, false);
    assert.equal(prompts.length, promptsBefore + 1);

    // Las senales se siguen registrando y llevan la condicion (la pone el servidor).
    const signal = {
      source: "vscode_extension",
      category: "signal",
      eventType: "blocking_detected",
      schemaVersion: "1.1",
      clientSessionId: "vscode-piloto-b",
      seq: 1,
      errorText: EDITOR_BODY.visibleError,
      durationMs: 91_000,
      metadata: { reason: "persistent", errorCount: 1 },
    };
    const posted = await call<{ ok: boolean; stored: number }>(baseUrl, "POST", "/api/behavior/events", studentB, { events: [signal] });
    assert.equal(posted.status, 200);

    // Bloque 2: se invierte.
    await call<PilotSummary>(baseUrl, "PUT", "/api/pilot/block", teacher, { block: 2 });
    const meAfter = await call<{ condition: string }>(baseUrl, "GET", "/api/pilot/me", studentB);
    assert.equal(meAfter.data.condition, "con_tutor");
    const nowBlockedA = await call<{ blocked: boolean; policy_applied: { reasonCode: string } | null }>(baseUrl, "POST", "/suggest-tab", studentA, EDITOR_BODY);
    assert.equal(nowBlockedA.data.policy_applied?.reasonCode, "pilot_no_tutor");
    await call(baseUrl, "POST", "/api/behavior/events", studentB, { events: [{ ...signal, eventType: "blocking_resolved", seq: 2, durationMs: 150_000, metadata: { blockedForMs: 59_000, resolvedWhileAway: false } }] });

    const resetMidPilot = await call<PilotSummary>(baseUrl, "POST", "/api/pilot/assign", teacher, { reset: true });
    assert.equal(resetMidPilot.status, 409, "no se reasigna con el piloto en curso");
    await call<PilotSummary>(baseUrl, "PUT", "/api/pilot/block", teacher, { block: 0 });

    const rows = await database.listTelemetryEvents();
    const signals = rows.filter((row) => row.clientSessionId === "vscode-piloto-b");
    assert.equal(signals.length, 2);
    assert.deepEqual(
      signals.map((row) => [row.eventType, row.pilotBlock, row.pilotCohort, row.pilotCondition]),
      [["blocking_detected", 1, "B", "sin_tutor"], ["blocking_resolved", 2, "B", "con_tutor"]],
    );
    assert.equal(signals[1].metadata.blockedForMs, 59_000, "metadata del desbloqueo en la lista blanca");
    const decisions = rows.filter((row) => row.eventType === "tutor_decision" && row.reasonCode === "pilot_no_tutor");
    assert.ok(decisions.length >= 3, "las decisiones sin tutor quedan registradas");
    assert.ok(decisions.every((row) => row.pilotCondition === "sin_tutor"));
    const teacherRows = rows.filter((row) => row.actorRole === "teacher");
    assert.ok(teacherRows.every((row) => row.pilotCondition === ""), "el docente no tiene condicion");

    const log = await database.listPilotBlockLog();
    assert.deepEqual(log.map((item) => item.block), [1, 2, 0]);

    const csv = await fetch(`${baseUrl}/api/telemetry/export?format=csv`, { headers: { "x-session-id": teacher } }).then((response) => response.text());
    const header = csv.split("\n")[0].split(",");
    for (const column of ["pilot_block", "pilot_cohort", "pilot_condition"]) {
      assert.ok(header.includes(column), `exportacion con ${column}`);
    }

    // KPIs en vivo (A3.6, A14.2): solo docentes o administradores.
    const kpisForStudent = await call<{ ok: boolean }>(baseUrl, "GET", "/api/telemetry/kpis", studentA);
    assert.equal(kpisForStudent.status, 403);
    const kpis = await call<{ ok: boolean; kpis: Array<{ id: string; value: number | null; details?: { pilotOff?: number } }> }>(baseUrl, "GET", "/api/telemetry/kpis", teacher);
    assert.equal(kpis.status, 200);
    const p7 = kpis.data.kpis.find((item) => item.id === "P7");
    assert.ok((p7?.details?.pilotOff || 0) >= 3, "los pedidos del bloque sin tutor se cuentan aparte");
    assert.equal(kpis.data.kpis.find((item) => item.id === "U1")?.value, null, "la encuesta no esta en vivo");
  } finally {
    setTextModelOverrideForTests(null);
    await stopTestServer(server, database);
  }
});

test("piloto: iniciar un bloque sin grupos los asigna como «Asignar grupos A y B» y lo dice", async () => {
  const { server, database, baseUrl } = await startTestServer();
  try {
    for (const name of ["Ana", "Bruno", "Carla", "Dario", "Elena"]) {
      await database.createManagedUser({
        role: "student",
        email: `${name.toLowerCase()}@auto.edu.co`,
        displayName: `${name} Auto`,
        password: "Piloto123!",
        teacherUserId: "user-teacher-demo",
      });
    }
    const teacher = await login(baseUrl, "docente@adaceen.edu.co", "Docente123!");

    const started = await call<PilotSummary>(baseUrl, "PUT", "/api/pilot/block", teacher, { block: 1 });
    assert.equal(started.status, 200, JSON.stringify(started.data));
    assert.equal(started.data.block, 1);
    assert.equal(started.data.assignedAutomatically, true);
    assert.equal(started.data.added, 6);
    assert.equal(started.data.counts.sinAsignar, 0);
    assert.equal(started.data.counts.A + started.data.counts.B, 6);
    assert.equal(started.data.counts.A, 3, "balanceado");
    assert.ok(started.data.seed, "la semilla queda en el acta del piloto");
    assert.equal(
      started.data.message,
      `Grupos A y B asignados automaticamente al iniciar el bloque (6 estudiantes; semilla: ${started.data.seed}).`,
      "el aviso trae la semilla y no repite el estado (ya viene en description y counts)",
    );
    assert.equal(started.data.description, "Bloque 1: grupo A con tutor, grupo B sin tutor.");

    // Misma asignacion que haria el boton: la misma funcion, la misma semilla.
    const students = await database.listActiveStudents("user-teacher-demo");
    const expected = assignPilotCohorts({ studentUserIds: students.map((student) => student.id), existing: [], seed: started.data.seed });
    const byId = new Map(started.data.students.map((student) => [student.id, student.cohort]));
    assert.deepEqual(
      expected.assignments.map((item) => [item.studentUserId, item.cohort]).sort(),
      [...byId].sort(),
    );

    // Con grupos ya asignados no se toca a nadie ni se repite el aviso.
    const before = new Map(byId);
    const block2 = await call<PilotSummary>(baseUrl, "PUT", "/api/pilot/block", teacher, { block: 2 });
    assert.equal(block2.status, 200);
    assert.equal(block2.data.assignedAutomatically, undefined);
    assert.equal(block2.data.message, undefined);
    assert.deepEqual(new Map(block2.data.students.map((student) => [student.id, student.cohort])), before);
    const log = await database.listPilotBlockLog();
    assert.deepEqual(log.map((item) => item.block), [1, 2]);

    // Volver a 0 nunca asigna.
    const stop = await call<PilotSummary>(baseUrl, "PUT", "/api/pilot/block", teacher, { block: 0 });
    assert.equal(stop.data.assignedAutomatically, undefined);
  } finally {
    await stopTestServer(server, database);
  }
});

test("piloto: la asignacion automatica respeta la semilla guardada y no reasigna a quien ya tiene grupo", async () => {
  const { server, database, baseUrl } = await startTestServer();
  try {
    const teacher = await login(baseUrl, "docente@adaceen.edu.co", "Docente123!");
    // Un administrador opera por el docente: tambien se asigna solo. (Su login
    // hace un JOIN que pg-mem no soporta: la sesion se crea directo.)
    const admin = "sesion-admin-piloto-auto";
    await database.pool.query("insert into app_sessions (id, user_id) values ($1, 'user-admin-demo')", [admin]);

    // Sin estudiantes activos no hay a quien asignar: se explica en vez de iniciar.
    await database.pool.query("update users set is_active = false where role_id = 'role-student'");
    const empty = await call<PilotSummary>(baseUrl, "PUT", "/api/pilot/block", teacher, { block: 1 });
    assert.equal(empty.status, 409);
    assert.match(String(empty.data.error), /No hay estudiantes activos/);
    assert.deepEqual(await database.listPilotBlockLog(), [], "no se inicio el bloque");
    await database.pool.query("update users set is_active = true where role_id = 'role-student'");

    // Con un solo estudiante activo tampoco se asigna solo: un grupo quedaria
    // vacio y ese estudiante podria quedar sin tutor sin que nadie lo eligiera.
    assert.equal((await database.listActiveStudents("user-teacher-demo")).length, 1);
    const single = await call<PilotSummary>(baseUrl, "PUT", "/api/pilot/block", teacher, { block: 1 });
    assert.equal(single.status, 409);
    assert.equal(
      single.data.error,
      "Solo hay 1 estudiante activo en tu grupo: los grupos A y B se asignan solos desde 2. "
        + "Si quieres asignarlo igual, pulsa «Asignar grupos A y B» y vuelve a iniciar el bloque.",
    );
    assert.deepEqual(await database.listPilotBlockLog(), [], "no se inicio el bloque");
    assert.deepEqual(await database.listPilotAssignments("user-teacher-demo"), [], "ni se asigno a nadie");
    // Lo que dice el aviso funciona: asignarlo a mano y volver a iniciar.
    const manual = await call<PilotSummary>(baseUrl, "POST", "/api/pilot/assign", teacher, {});
    assert.equal(manual.data.added, 1);
    const singleStarted = await call<PilotSummary>(baseUrl, "PUT", "/api/pilot/block", teacher, { block: 1 });
    assert.equal(singleStarted.status, 200);
    assert.equal(singleStarted.data.assignedAutomatically, undefined);
    await call<PilotSummary>(baseUrl, "PUT", "/api/pilot/block", teacher, { block: 0 });

    // La semilla ya guardada (por ejemplo, de una asignacion con reset) se reutiliza.
    await database.savePilotAssignments("user-teacher-demo", [], { reset: true, seed: "semilla-acta" });
    for (const name of ["Fabio", "Gina", "Hugo"]) {
      await database.createManagedUser({
        role: "student",
        email: `${name.toLowerCase()}@auto.edu.co`,
        displayName: `${name} Auto`,
        password: "Piloto123!",
        teacherUserId: "user-teacher-demo",
      });
    }
    const started = await call<PilotSummary>(baseUrl, "PUT", "/api/pilot/block", admin, { block: 1, teacherUserId: "user-teacher-demo" });
    assert.equal(started.status, 200, JSON.stringify(started.data));
    assert.equal(started.data.assignedAutomatically, true);
    assert.equal(started.data.seed, "semilla-acta");
    const students = await database.listActiveStudents("user-teacher-demo");
    const expected = assignPilotCohorts({ studentUserIds: students.map((student) => student.id), existing: [], seed: "semilla-acta" });
    assert.deepEqual(
      Object.fromEntries(started.data.students.map((student) => [student.id, student.cohort])),
      Object.fromEntries(expected.assignments.map((item) => [item.studentUserId, item.cohort])),
    );

    // Un estudiante nuevo a mitad del piloto no mueve a los demas: «Asignar grupos A y B» solo lo agrega.
    await call<PilotSummary>(baseUrl, "PUT", "/api/pilot/block", teacher, { block: 0 });
    const kept = new Map(started.data.students.map((student) => [student.id, student.cohort]));
    await database.createManagedUser({
      role: "student",
      email: "ivan@auto.edu.co",
      displayName: "Ivan Auto",
      password: "Piloto123!",
      teacherUserId: "user-teacher-demo",
    });
    const again = await call<PilotSummary>(baseUrl, "PUT", "/api/pilot/block", teacher, { block: 1 });
    assert.equal(again.data.assignedAutomatically, undefined, "ya habia grupos: no se asigna otra vez");
    for (const [id, cohort] of kept) {
      assert.equal(again.data.students.find((student) => student.id === id)?.cohort, cohort);
    }
    const added = await call<PilotSummary>(baseUrl, "POST", "/api/pilot/assign", teacher, {});
    assert.equal(added.data.added, 1);
    for (const [id, cohort] of kept) {
      assert.equal(added.data.students.find((student) => student.id === id)?.cohort, cohort);
    }
  } finally {
    await stopTestServer(server, database);
  }
});

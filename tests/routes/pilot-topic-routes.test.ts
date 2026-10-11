import assert from "node:assert/strict";
import test from "node:test";
import type { Server } from "node:http";
import { createApp } from "../../src/app.js";
import { createDatabase, type AppDatabase } from "../../src/db/database.js";
import { storeClassification } from "../../src/routes/document-classifications.js";
import { normalizePilotTopicRepo, summarizeBitacoraWeeks } from "../../src/services/pilot-topic.js";

/**
 * Tema del piloto (navegador 0.7.21): el docente, o el administrador por el, elige la semana
 * de la bitacora y el repositorio del ejercicio; sus estudiantes lo reciben (sin cohortes ni
 * bloque) para verlo en Inicio y el tutor se enfoca en esa semana.
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

async function login(database: AppDatabase, email: string, password: string) {
  const session = await database.authenticateUser(email, password);
  assert.ok(session, `login ${email}`);
  return session.id;
}

async function call<T>(baseUrl: string, method: string, route: string, sessionId: string, body?: unknown) {
  const response = await fetch(`${baseUrl}${route}`, {
    method,
    headers: { "Content-Type": "application/json; charset=utf-8", ...(sessionId ? { "x-session-id": sessionId } : {}) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  return { status: response.status, data: await response.json() as T };
}

type Topic = { courseCode: string; week: number; title: string; repoFullName: string; updatedByName: string | null } | null;
type TopicReply = {
  ok: boolean;
  error?: string;
  message?: string;
  teacherUserId: string;
  topic: Topic;
  weeks?: Array<{ week: number; dateKey: string; topic: string; activities: string[] }>;
  teachers?: Array<{ id: string; displayName: string }>;
  block?: unknown;
  cohort?: unknown;
};

// Filas como las deja el importador de la bitacora 2026-2 de FPOO (semanas 6 a 8).
const AGENDA_ITEMS = [
  { title: "Herencia y polimorfismo", type: "activity", category: "Actividad", dueAt: "2026-10-07", visibleDueText: "07-10-2026", description: "Tema: Herencia y polimorfismo | Actividades en clase: Taller Avatar", confidence: 0.9, evidence: ["Semana: 6", "Hoja: Bitacora"] },
  { title: "Quiz y preguntas", type: "task", category: "Quiz", dueAt: "2026-10-14", visibleDueText: "14-10-2026", description: "Tema: Quiz de la semana | Actividades evaluación: Quiz y preguntas", confidence: 0.9, evidence: ["Semana: 7", "Hoja: Bitacora"] },
  { title: "Abstraccion", type: "activity", category: "Actividad", dueAt: "2026-10-14", visibleDueText: "14-10-2026", description: "Tema: Abstracción, encapsulamiento y test | Actividades en clase: Ejercicio IMC; Pruebas con googletest", confidence: 0.9, evidence: ["Semana: 7", "Hoja: Bitacora"] },
  { title: "Reutilizacion", type: "activity", category: "Actividad", dueAt: "2026-10-21", visibleDueText: "21-10-2026", description: "Tema: Reutilización de código, modularidad y refactoring | Actividades en clase: Ejercicio Nutrición", confidence: 0.9, evidence: ["Semana: 8", "Hoja: Bitacora"] },
  { title: "Sesion opcional", type: "note", category: "Actividad", dueAt: "2026-10-24", visibleDueText: "24-10-2026", description: "OPCIONAL", confidence: 0.5, evidence: ["Hoja: Bitacora"] },
];

async function seedBitacora(database: AppDatabase, teacherUserId: string) {
  await storeClassification(database, {
    sessionId: null,
    userId: teacherUserId,
    repoFullName: "bitacora/docente",
    requestId: "req-bitacora",
    snapshotId: "snap-bitacora",
    filePath: "Bitacora FPOO 2026-2.pdf",
    fileName: "Bitacora FPOO 2026-2.pdf",
    mimeType: "application/pdf",
    extension: ".pdf",
    classification: { label: "BITACORA", confidence: 0.97, method: "rules", evidence: [], reason: "plantilla" },
    extractedTextPreview: "",
    features: { bitacoraAgenda: { items: AGENDA_ITEMS, summary: "", warnings: [] } },
    trainingExample: {},
    modelUsed: false,
    modelError: "",
  });
}

test("tema del piloto: semanas de la bitacora y enlaces de GitHub", () => {
  const weeks = summarizeBitacoraWeeks(AGENDA_ITEMS);
  assert.deepEqual(weeks.map((week) => [week.week, week.dateKey, week.topic]), [
    [6, "2026-10-07", "Herencia y polimorfismo"],
    [7, "2026-10-14", "Abstracción, encapsulamiento y test"],
    [8, "2026-10-21", "Reutilización de código, modularidad y refactoring"],
  ], "el quiz no da el tema de la semana 7 y la fila sin semana queda fuera");
  assert.deepEqual(weeks[1].activities, ["Ejercicio IMC", "Pruebas con googletest"]);
  assert.deepEqual(summarizeBitacoraWeeks(null), []);

  for (const [input, expected] of [
    ["vbucheli/IMC", "vbucheli/IMC"],
    ["https://github.com/vbucheli/IMC", "vbucheli/IMC"],
    ["github.com/vbucheli/Nutricion.git", "vbucheli/Nutricion"],
    ["https://www.github.com/vbucheli/IMC/tree/main/IMC-tests?tab=readme", "vbucheli/IMC"],
    ["git@github.com:vbucheli/IMC.git", "vbucheli/IMC"],
    ["  vbucheli / IMC ", "vbucheli/IMC"],
    ["https://gitlab.com/vbucheli/IMC", ""],
    ["gitlab.com/vbucheli/IMC", ""],
    ["vbucheli", ""],
    ["https://github.com/vbucheli", ""],
    ["../..", ""],
    ["", ""],
  ]) {
    assert.equal(normalizePilotTopicRepo(input), expected, input);
  }
});

test("tema del piloto: el docente lo elige, el estudiante lo recibe y el administrador lo pone o quita por el docente", async () => {
  const { server, database, baseUrl } = await startTestServer();
  try {
    await seedBitacora(database, "user-teacher-demo");
    const teacher = await login(database, "docente@adaceen.edu.co", "Docente123!");
    const student = await login(database, "estudiante@adaceen.edu.co", "Estudiante123!");
    const admin = await login(database, "admin@adaceen.edu.co", "Admin123!");

    assert.equal((await call<TopicReply>(baseUrl, "GET", "/api/pilot/topic", "")).status, 401);
    const initial = await call<TopicReply>(baseUrl, "GET", "/api/pilot/topic", teacher);
    assert.equal(initial.status, 200);
    assert.equal(initial.data.topic, null);
    assert.equal(initial.data.teacherUserId, "user-teacher-demo");
    assert.deepEqual(initial.data.weeks?.map((week) => week.week), [6, 7, 8], "el docente recibe las semanas de su bitacora");
    assert.equal(initial.data.teachers, undefined, "la lista de docentes es solo del administrador");

    const badRepo = await call<TopicReply>(baseUrl, "PUT", "/api/pilot/topic", teacher, { courseCode: "FPOO", week: 7, repoFullName: "https://gitlab.com/x/y" });
    assert.equal(badRepo.status, 400);
    assert.match(String(badRepo.data.error), /usuario\/repositorio/);
    const nothing = await call<TopicReply>(baseUrl, "PUT", "/api/pilot/topic", teacher, { courseCode: "FPOO", week: 0, title: "  " });
    assert.equal(nothing.status, 400);
    const forbidden = await call<TopicReply>(baseUrl, "PUT", "/api/pilot/topic", student, { courseCode: "FPOO", week: 7 });
    assert.equal(forbidden.status, 403, "el estudiante no elige el tema");

    // Semana 7 sin titulo: toma el tema de la bitacora; el enlace queda como usuario/repositorio.
    const saved = await call<TopicReply>(baseUrl, "PUT", "/api/pilot/topic", teacher, {
      courseCode: "FPOO",
      week: 7,
      repoFullName: "https://github.com/vbucheli/IMC",
    });
    assert.equal(saved.status, 200, saved.data.error);
    assert.equal(saved.data.topic?.courseCode, "FPOO");
    assert.equal(saved.data.topic?.week, 7);
    assert.equal(saved.data.topic?.title, "Abstracción, encapsulamiento y test");
    assert.equal(saved.data.topic?.repoFullName, "vbucheli/IMC");
    assert.equal(saved.data.topic?.updatedByName, "Docente Demo");
    assert.match(String(saved.data.message), /semana 7/);

    const forStudent = await call<TopicReply>(baseUrl, "GET", "/api/pilot/topic", student);
    assert.equal(forStudent.status, 200);
    assert.equal(forStudent.data.topic?.week, 7);
    assert.equal(forStudent.data.topic?.repoFullName, "vbucheli/IMC");
    assert.equal(forStudent.data.weeks, undefined, "el estudiante no recibe la bitacora entera");
    assert.equal(forStudent.data.block, undefined, "ni el bloque ni la cohorte del piloto");
    assert.equal(forStudent.data.cohort, undefined);

    // Administrador: sin teacherUserId ve el del docente de las cuentas nuevas, con los docentes.
    const asAdmin = await call<TopicReply>(baseUrl, "GET", "/api/pilot/topic", admin);
    assert.equal(asAdmin.status, 200);
    assert.equal(asAdmin.data.teacherUserId, "user-teacher-demo");
    assert.equal(asAdmin.data.topic?.week, 7);
    assert.deepEqual(asAdmin.data.teachers?.map((entry) => entry.id), ["user-teacher-demo"]);
    assert.deepEqual(asAdmin.data.weeks?.map((week) => week.week), [6, 7, 8], "y las semanas de la bitacora de ese docente");
    const noTeacher = await call<TopicReply>(baseUrl, "PUT", "/api/pilot/topic", admin, { courseCode: "FPOO", week: 8 });
    assert.equal(noTeacher.status, 400, "el administrador indica el docente");
    const notATeacher = await call<TopicReply>(baseUrl, "PUT", "/api/pilot/topic", admin, { teacherUserId: "user-student-demo", courseCode: "FPOO", week: 8 });
    assert.equal(notATeacher.status, 400);

    const byAdmin = await call<TopicReply>(baseUrl, "PUT", "/api/pilot/topic", admin, {
      teacherUserId: "user-teacher-demo",
      courseCode: "FPOO",
      week: 8,
      title: "Nutrición: librerías, APIs y refactoring",
      repoFullName: "vbucheli/Nutricion",
    });
    assert.equal(byAdmin.status, 200, byAdmin.data.error);
    assert.equal(byAdmin.data.topic?.title, "Nutrición: librerías, APIs y refactoring");
    assert.equal(byAdmin.data.topic?.updatedByName, "Administrador Demo");

    const cleared = await call<TopicReply>(baseUrl, "PUT", "/api/pilot/topic", admin, { teacherUserId: "user-teacher-demo", clear: true });
    assert.equal(cleared.status, 200);
    assert.equal(cleared.data.topic, null);
    assert.equal((await call<TopicReply>(baseUrl, "GET", "/api/pilot/topic", student)).data.topic, null, "al quitarlo el estudiante ya no lo ve");
  } finally {
    await stopTestServer(server, database);
  }
});

import assert from "node:assert/strict";
import test from "node:test";
import type { Server } from "node:http";
import { createApp } from "../../src/app.js";
import { createDatabase, type AppDatabase } from "../../src/db/database.js";
import {
  buildTimeline,
  computeQuizGrade,
  type StudentProgressDetail,
  type StudentProgressSummary,
  type StudentProgressTotals,
} from "../../src/services/student-progress.js";

/**
 * Panel "Estudiantes" del overlay: GET /api/admin/students y
 * GET /api/admin/students/:userId. Comprueba el alcance por rol (el docente
 * solo ve a los suyos), que las cifras salen de las tablas reales y que no
 * se filtran ids de sesion.
 */

async function startTestServer() {
  const database = await createDatabase();
  const app = createApp(database);
  const server = await new Promise<Server>((resolve) => {
    const started = app.listen(0, () => resolve(started));
  });
  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("No se pudo iniciar servidor de prueba.");
  }
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
  const data = await response.json() as { session?: { id?: string; user?: { id?: string } }; error?: string };
  assert.equal(response.status, 200, data.error);
  return { id: String(data.session?.id || ""), userId: String(data.session?.user?.id || "") };
}

async function getJson<T>(baseUrl: string, path: string, sessionId?: string) {
  const response = await fetch(`${baseUrl}${path}`, {
    headers: sessionId ? { "x-session-id": sessionId } : {},
  });
  return { status: response.status, data: await response.json() as T & { ok?: boolean; error?: string } };
}

type ListPayload = { totals: StudentProgressTotals; students: StudentProgressSummary[]; viewerRole: string };

test("nota de quices: 60 % aciertos + 40 % seguimiento, o el componente que exista", () => {
  assert.deepEqual(computeQuizGrade({ answered: 0, correct: 0, scored: 0, followupSum: 0 }).score, null);
  assert.equal(computeQuizGrade({ answered: 0, correct: 0, scored: 0, followupSum: 0 }).level, "sin_datos");

  const both = computeQuizGrade({ answered: 4, correct: 3, scored: 2, followupSum: 140 });
  assert.equal(both.correctRate, 75);
  assert.equal(both.averageFollowUpScore, 70);
  assert.equal(both.score, 73);
  assert.equal(both.scale5, 3.7);
  assert.equal(both.level, "medio");

  const onlyChoices = computeQuizGrade({ answered: 5, correct: 5, scored: 0, followupSum: 0 });
  assert.equal(onlyChoices.score, 100);
  assert.equal(onlyChoices.scale5, 5);
  assert.equal(onlyChoices.level, "alto");

  const onlyFollowUp = computeQuizGrade({ answered: 0, correct: 0, scored: 1, followupSum: 40 });
  assert.equal(onlyFollowUp.score, 40);
  assert.equal(onlyFollowUp.level, "bajo");
});

test("linea de tiempo: un punto por dia y cuenta solo lo que cae en la ventana", () => {
  const now = new Date("2026-09-25T20:00:00.000Z");
  const timeline = buildTimeline({
    now,
    days: 3,
    sessions: [{ createdAt: "2026-09-25T10:00:00.000Z" }, { createdAt: "2026-09-01T10:00:00.000Z" }],
    interventions: [{ createdAt: "2026-09-24T10:00:00.000Z" }, { createdAt: "2026-09-24T11:00:00.000Z" }],
    quizzes: [{ createdAt: "2026-09-23T10:00:00.000Z" }],
  });
  assert.deepEqual(timeline.map((point) => point.day), ["2026-09-23", "2026-09-24", "2026-09-25"]);
  assert.deepEqual(timeline.map((point) => [point.sessions, point.interventions, point.quizzes]), [[0, 0, 1], [0, 2, 0], [1, 0, 0]]);
});

test("progreso de estudiantes: roles, alcance del docente y cifras reales", async () => {
  const { server, database, baseUrl } = await startTestServer();
  try {
    // --- Sin sesion y como estudiante no se puede ver.
    assert.equal((await getJson(baseUrl, "/api/admin/students")).status, 401);
    const student = await login(baseUrl, "estudiante@adaceen.edu.co", "Estudiante123!");
    assert.equal((await getJson(baseUrl, "/api/admin/students", student.id)).status, 403);

    // --- Datos del estudiante demo: una intervencion, dos quices y un evento.
    await database.recordTelemetry({
      sessionId: student.id,
      studentUserId: student.userId,
      teacherUserId: "user-teacher-demo",
      eventType: "compile_error",
      interventionType: "hint",
      detailLevel: "guided",
      policyName: "RF-05 base del piloto",
      exerciseKey: "tarea-1",
      blocked: false,
      reason: "",
      contextSummary: "Error de compilacion en Main.java",
      policySnapshot: {},
    });
    await database.recordTelemetry({
      sessionId: student.id,
      studentUserId: student.userId,
      teacherUserId: "user-teacher-demo",
      eventType: "out_of_domain",
      interventionType: "controlled_message",
      detailLevel: "brief",
      policyName: "RF-05 base del piloto",
      exerciseKey: null,
      blocked: true,
      reason: "fuera de dominio",
      contextSummary: "",
      policySnapshot: {},
    });
    await database.incrementHintUsage(student.userId, "tarea-1");
    await database.incrementHintUsage(student.userId, "tarea-1");

    const quizBase = {
      clientKey: "cliente-estudiante-demo",
      userId: student.userId,
      teacherUserId: "user-teacher-demo",
      sessionId: student.id,
      launchId: null,
      language: "java",
      filePath: "src/Main.java",
      topic: "arreglos",
      question: "Que hace la linea?",
      options: ["Inicializa", "Borra", "Imprime"],
      correctIndex: 0,
      explanation: "",
      followupQuestion: "Por que?",
      codeContext: {},
    };
    const first = await database.createStudentQuiz({ ...quizBase, trigger: "after_accept" });
    await database.saveStudentQuizAnswer(first.id, { chosenIndex: 0, correct: true, status: "followup" });
    await database.saveStudentQuizFollowUp(first.id, { answer: "Porque si", score: 80, feedback: "Bien" });
    const second = await database.createStudentQuiz({ ...quizBase, trigger: "teacher_launch" });
    await database.saveStudentQuizAnswer(second.id, { chosenIndex: 2, correct: false, status: "done" });

    const eventsResponse = await fetch(`${baseUrl}/api/behavior/events`, {
      method: "POST",
      headers: { "Content-Type": "application/json; charset=utf-8", "x-session-id": student.id },
      body: JSON.stringify({
        events: [{ source: "browser_extension", category: "tutor", eventType: "tutor_request_submitted", occurredAt: new Date().toISOString() }],
      }),
    });
    assert.equal(eventsResponse.status, 200);

    // --- Otro docente con su propio estudiante: el docente demo no debe verlo.
    // (El login del administrador hace un JOIN que pg-mem no soporta: la
    // sesion se crea directo, como en pilot-routes.test.ts.)
    const admin = { id: "sesion-admin-progreso", userId: "user-admin-demo" };
    await database.pool.query("insert into app_sessions (id, user_id) values ($1, $2)", [admin.id, admin.userId]);
    const otherTeacher = await database.createManagedUser({
      role: "teacher",
      email: "otra.docente@adaceen.edu.co",
      displayName: "Otra Docente",
      password: "Docente123!",
      teacherUserId: null,
      assignedByUserId: admin.userId,
    });
    const otherStudent = await database.createManagedUser({
      role: "student",
      email: "otro.estudiante@adaceen.edu.co",
      displayName: "Otro Estudiante",
      password: "Estudiante123!",
      teacherUserId: otherTeacher.id,
      assignedByUserId: admin.userId,
    });

    // --- El administrador ve a los dos estudiantes con sus cifras.
    const adminList = await getJson<ListPayload>(baseUrl, "/api/admin/students", admin.id);
    assert.equal(adminList.status, 200, adminList.data.error);
    assert.equal(adminList.data.viewerRole, "admin");
    assert.deepEqual(adminList.data.students.map((item) => item.email).sort(), [
      "estudiante@adaceen.edu.co",
      "otro.estudiante@adaceen.edu.co",
    ]);
    assert.equal(adminList.data.totals.students, 2);
    assert.equal(adminList.data.totals.interventions, 2);
    assert.equal(adminList.data.totals.blocked, 1);
    assert.equal(adminList.data.totals.withQuizzes, 1);

    const demo = adminList.data.students.find((item) => item.id === student.userId);
    assert.ok(demo, "el estudiante demo esta en la lista");
    assert.equal(demo.teacherDisplayName, "Docente Demo");
    assert.equal(demo.sessions.total, 1, "el login creo una sesion de navegador");
    assert.equal(demo.sessions.browser, 1);
    assert.equal(demo.sessions.activeNow, true);
    assert.equal(demo.interventions.total, 2);
    assert.equal(demo.interventions.blocked, 1);
    assert.equal(demo.interventions.hints, 1);
    assert.equal(demo.quizzes.total, 2);
    assert.equal(demo.quizzes.answered, 2);
    assert.equal(demo.quizzes.correct, 1);
    assert.equal(demo.quizzes.correctRate, 50);
    assert.equal(demo.quizzes.averageFollowUpScore, 80);
    assert.equal(demo.grade.score, 62, "60 % de 50 + 40 % de 80");
    assert.equal(demo.grade.scale5, 3.1);
    assert.equal(demo.exercises.hints, 2);
    assert.equal(demo.activity.events, 1);
    assert.equal(demo.activity.byCategory.tutor, 1);
    assert.ok(demo.lastActivityAt);

    const other = adminList.data.students.find((item) => item.id === otherStudent.id);
    assert.ok(other);
    assert.equal(other.sessions.total, 0);
    assert.equal(other.grade.level, "sin_datos");

    // --- El docente demo solo ve a su estudiante y no entra al otro (404).
    const teacher = await login(baseUrl, "docente@adaceen.edu.co", "Docente123!");
    const teacherList = await getJson<ListPayload>(baseUrl, "/api/admin/students", teacher.id);
    assert.equal(teacherList.status, 200, teacherList.data.error);
    assert.deepEqual(teacherList.data.students.map((item) => item.email), ["estudiante@adaceen.edu.co"]);
    assert.equal(teacherList.data.viewerRole, "teacher");
    assert.equal((await getJson(baseUrl, `/api/admin/students/${otherStudent.id}`, teacher.id)).status, 404);

    // --- Detalle: listas sin ids de sesion y quices con la opcion elegida.
    const detail = await getJson<StudentProgressDetail>(baseUrl, `/api/admin/students/${student.userId}?limit=10`, teacher.id);
    assert.equal(detail.status, 200, detail.data.error);
    assert.equal(detail.data.student.id, student.userId);
    assert.equal(detail.data.sessions.length, 1);
    assert.equal(detail.data.sessions[0].kind, "browser");
    assert.equal(Object.hasOwn(detail.data.sessions[0], "id"), false, "sin id de sesion");
    assert.equal(detail.data.interventions.length, 2);
    assert.equal(detail.data.interventions[0].blocked, true, "la mas reciente primero");
    assert.equal(detail.data.quizzes.length, 2);
    const answered = detail.data.quizzes.find((quiz) => quiz.id === first.id);
    assert.ok(answered);
    assert.equal(answered.chosenOption, "Inicializa");
    assert.equal(answered.correctOption, "Inicializa");
    assert.equal(answered.followupScore, 80);
    assert.equal(detail.data.exercises[0]?.hintCount, 2);
    assert.equal(detail.data.activity[0]?.category, "tutor");
    assert.equal(detail.data.timeline.length, 14);
    assert.equal(detail.data.timeline.at(-1)?.interventions, 2);
    assert.equal(detail.data.timeline.at(-1)?.quizzes, 2);
    assert.equal(detail.data.timeline.at(-1)?.sessions, 1);
    assert.equal(JSON.stringify(detail.data).includes(student.id), false, "el id de sesion no viaja en el detalle");

    // --- El administrador si entra al otro estudiante.
    assert.equal((await getJson(baseUrl, `/api/admin/students/${otherStudent.id}`, admin.id)).status, 200);
    assert.equal((await getJson(baseUrl, "/api/admin/students/no-existe", admin.id)).status, 404);
  } finally {
    await stopTestServer(server, database);
  }
});

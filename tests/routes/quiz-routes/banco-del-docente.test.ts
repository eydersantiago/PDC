import assert from "node:assert/strict";
import test from "node:test";
import { setQuizModelRunnerForTests } from "../../../src/services/quiz/quiz.js";
import { startTestServer, stopTestServer, login, fakeModel, clientHeaders } from "./helpers.js";

test("quiz 0.7.15: banco propio del docente, lanzar desde el banco, quices hechos con nombre y pagina /docente/quices", async () => {
  setQuizModelRunnerForTests(fakeModel);
  const { server, database, baseUrl } = await startTestServer();
  try {
    const teacherSession = await login(baseUrl, "docente@adaceen.edu.co", "Docente123!");
    const studentSession = await login(baseUrl, "estudiante@adaceen.edu.co", "Estudiante123!");
    const json = (sessionId: string) => ({ "Content-Type": "application/json", "x-session-id": sessionId });

    // Solo docentes.
    assert.equal((await fetch(`${baseUrl}/api/quiz/custom`, { headers: { "x-session-id": studentSession } })).status, 403);
    assert.equal((await fetch(`${baseUrl}/api/quiz/attempts`, { headers: { "x-session-id": studentSession } })).status, 403);
    assert.equal((await fetch(`${baseUrl}/api/quiz/custom`)).status, 401);

    // Escrito completo.
    const created = await fetch(`${baseUrl}/api/quiz/custom`, {
      method: "POST",
      headers: json(teacherSession),
      body: JSON.stringify({
        courseCode: "FPOO",
        topic: "Encapsulamiento",
        question: "Cual modificador oculta un atributo fuera de la clase?",
        options: ["private", "public", "static"],
        correctIndex: 0,
        explanation: "private limita el acceso a la propia clase.",
      }),
    });
    const createdData = await created.json() as { quiz: { id: string; options: string[]; correctIndex: number; courseCode: string; followupQuestion: string }; generated: boolean; error?: string };
    assert.equal(created.status, 201, createdData.error);
    assert.equal(createdData.generated, false);
    assert.equal(createdData.quiz.courseCode, "FPOO");
    assert.equal(createdData.quiz.options[createdData.quiz.correctIndex], "private", "barajar conserva la correcta");
    assert.ok(createdData.quiz.followupQuestion.length > 5, "seguimiento por defecto");

    // Generado con el tema (modelo simulado).
    const generated = await fetch(`${baseUrl}/api/quiz/custom`, {
      method: "POST",
      headers: json(teacherSession),
      body: JSON.stringify({ courseCode: "FPI", topic: "inicializacion de arreglos" }),
    });
    const generatedData = await generated.json() as { quiz: { id: string; question: string; options: string[] }; generated: boolean };
    assert.equal(generated.status, 201);
    assert.equal(generatedData.generated, true);
    assert.equal(generatedData.quiz.question, "Que hace la linea que agregaste?");
    assert.equal(generatedData.quiz.options.length, 4);

    // Validaciones: pregunta corta y correcta fuera de rango.
    const badCreate = await fetch(`${baseUrl}/api/quiz/custom`, {
      method: "POST",
      headers: json(teacherSession),
      body: JSON.stringify({ topic: "x" }),
    });
    assert.equal(badCreate.status, 400);
    const badEdit = await fetch(`${baseUrl}/api/quiz/custom/${createdData.quiz.id}`, {
      method: "PUT",
      headers: json(teacherSession),
      body: JSON.stringify({ topic: "Encapsulamiento", question: "Pregunta editada valida", options: ["a", "b", "c"], correctIndex: 3 }),
    });
    assert.equal(badEdit.status, 400);

    // Editar.
    const edited = await fetch(`${baseUrl}/api/quiz/custom/${createdData.quiz.id}`, {
      method: "PUT",
      headers: json(teacherSession),
      body: JSON.stringify({
        topic: "Encapsulamiento en C++",
        question: "Cual modificador oculta un atributo fuera de la clase?",
        options: ["private", "public", "static", "friend"],
        correctIndex: 0,
        explanation: "private limita el acceso.",
        followupQuestion: "Da un ejemplo de atributo privado.",
      }),
    });
    const editedData = await edited.json() as { quiz: { topic: string; options: string[]; correctIndex: number; followupQuestion: string }; error?: string };
    assert.equal(edited.status, 200, editedData.error);
    assert.equal(editedData.quiz.topic, "Encapsulamiento en C++");
    assert.equal(editedData.quiz.options.length, 4);
    assert.equal(editedData.quiz.options[editedData.quiz.correctIndex], "private");
    assert.equal(editedData.quiz.followupQuestion, "Da un ejemplo de atributo privado.");

    // Lanzar desde el banco: llega al estudiante y queda ligado al quiz.
    const launched = await fetch(`${baseUrl}/api/quiz/custom/${createdData.quiz.id}/launch`, {
      method: "POST",
      headers: json(teacherSession),
      body: JSON.stringify({ expiresInMinutes: 30 }),
    });
    const launchedData = await launched.json() as { launch: { id: string; customQuizId: string; options: string[]; correctIndex: number }; autoEnabled?: boolean; error?: string };
    assert.equal(launched.status, 200, launchedData.error);
    assert.equal(launchedData.launch.customQuizId, createdData.quiz.id);
    assert.equal(launchedData.launch.options[launchedData.launch.correctIndex], "private");
    assert.ok(launchedData.autoEnabled === undefined || launchedData.autoEnabled === true, "misma regla de politica que POST /api/quiz/launches");

    const pending = await fetch(`${baseUrl}/api/quiz/pending`, { headers: clientHeaders("cliente-estudiante-07", studentSession) });
    const pendingData = await pending.json() as { quiz: { id: string; launchId: string; options: string[] } | null };
    assert.ok(pendingData.quiz);
    assert.equal(pendingData.quiz.launchId, launchedData.launch.id);
    const wrongIndex = pendingData.quiz.options.indexOf("public");
    const answered = await fetch(`${baseUrl}/api/quiz/${pendingData.quiz.id}/answer`, {
      method: "POST",
      headers: clientHeaders("cliente-estudiante-07", studentSession),
      body: JSON.stringify({ choiceIndex: wrongIndex }),
    });
    assert.equal(answered.status, 200);

    // Banco con resultados y lanzamiento activo.
    const bank = await fetch(`${baseUrl}/api/quiz/custom`, { headers: { "x-session-id": teacherSession } });
    const bankData = await bank.json() as {
      quizzes: Array<{ id: string; launchCount: number; activeLaunchId: string | null; results: { answered: number; correct: number } }>;
      launches: Array<{ id: string; customQuizId: string; results: { answered: number } }>;
    };
    assert.equal(bank.status, 200);
    assert.deepEqual(bankData.quizzes.map((quiz) => quiz.id).sort(), [createdData.quiz.id, generatedData.quiz.id].sort());
    const bankQuiz = bankData.quizzes.find((quiz) => quiz.id === createdData.quiz.id);
    assert.equal(bankQuiz?.launchCount, 1);
    assert.equal(bankQuiz?.activeLaunchId, launchedData.launch.id);
    assert.deepEqual([bankQuiz?.results.answered, bankQuiz?.results.correct], [1, 0]);
    assert.equal(bankData.launches[0].customQuizId, createdData.quiz.id);

    // Quices hechos: con nombre del estudiante, sin ids de sesion ni de cliente.
    const attempts = await fetch(`${baseUrl}/api/quiz/attempts?limit=50`, { headers: { "x-session-id": teacherSession } });
    const attemptsData = await attempts.json() as {
      attempts: Array<Record<string, unknown> & { studentName: string; studentEmail: string; correct: boolean | null; customQuizId: string; launchTopic: string; trigger: string }>;
      summary: { total: number; students: number };
    };
    assert.equal(attempts.status, 200);
    assert.equal(attemptsData.attempts.length, 1);
    assert.equal(attemptsData.attempts[0].studentName, "Estudiante Demo");
    assert.equal(attemptsData.attempts[0].studentEmail, "estudiante@adaceen.edu.co");
    assert.equal(attemptsData.attempts[0].correct, false);
    assert.equal(attemptsData.attempts[0].customQuizId, createdData.quiz.id);
    assert.equal(attemptsData.attempts[0].launchTopic, "Encapsulamiento en C++");
    assert.equal(attemptsData.attempts[0].trigger, "teacher_launch");
    assert.ok(!("sessionId" in attemptsData.attempts[0]) && !("clientKey" in attemptsData.attempts[0]));
    assert.equal(attemptsData.summary.total, 1);

    // Retirar: desaparece del banco, el lanzamiento hecho se conserva; retirar dos veces es 404.
    const retired = await fetch(`${baseUrl}/api/quiz/custom/${generatedData.quiz.id}`, { method: "DELETE", headers: { "x-session-id": teacherSession } });
    assert.equal(retired.status, 200);
    assert.equal((await fetch(`${baseUrl}/api/quiz/custom/${generatedData.quiz.id}`, { method: "DELETE", headers: { "x-session-id": teacherSession } })).status, 404);
    const bankAfter = await (await fetch(`${baseUrl}/api/quiz/custom`, { headers: { "x-session-id": teacherSession } })).json() as { quizzes: Array<{ id: string }> };
    assert.deepEqual(bankAfter.quizzes.map((quiz) => quiz.id), [createdData.quiz.id]);
    assert.equal((await fetch(`${baseUrl}/api/quiz/custom/${generatedData.quiz.id}/launch`, { method: "POST", headers: json(teacherSession), body: "{}" })).status, 404);

    // Pagina del docente: HTML con CSP por nonce, sin recursos externos.
    const page = await fetch(`${baseUrl}/docente/quices`);
    const html = await page.text();
    assert.equal(page.status, 200);
    assert.match(page.headers.get("content-type") || "", /text\/html/);
    const csp = page.headers.get("content-security-policy") || "";
    assert.match(csp, /default-src 'none'/);
    assert.match(csp, /script-src 'nonce-[A-Za-z0-9+/=]+'/);
    assert.match(csp, /connect-src 'self'/);
    assert.match(html, /Quices del docente/);
    assert.match(html, /Guardar y lanzar/);
    assert.match(html, /Quices hechos por estudiantes/);
    assert.match(html, /adaceen:session/);
    assert.match(html, /Iniciar sesion con correo y contrasena/);
    assert.doesNotMatch(html, /https?:\/\/(?!drive)/, "sin scripts ni estilos externos");
    assert.ok(html.includes('<option value="FPOO">'));
  } finally {
    setQuizModelRunnerForTests(null);
    await stopTestServer(server, database);
  }
});

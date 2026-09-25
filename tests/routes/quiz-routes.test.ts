import assert from "node:assert/strict";
import test from "node:test";
import type { Server } from "node:http";
import { createApp } from "../../src/app.js";
import { createDatabase, type AppDatabase } from "../../src/db/database.js";
import {
  normalizeQuizSettings,
  parseFollowUpGrade,
  parseGeneratedQuiz,
  setQuizModelRunnerForTests,
  shuffleQuizOptions,
} from "../../src/services/quiz.js";

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
  const data = await response.json() as { session?: { id?: string } };
  assert.equal(response.status, 200);
  return String(data.session?.id || "");
}

const MODEL_QUIZ = JSON.stringify({
  question: "Que hace la linea que agregaste?",
  options: ["Inicializa la matriz", "Borra la matriz", "Imprime la matriz", "Nada"],
  correct_index: 0,
  explanation: "Crea la matriz de 9x9 antes de usarla.",
  followup_question: "Por que hay que inicializar la matriz antes de usarla?",
  topic: "inicializacion de arreglos",
});

function fakeModel(prompt: string) {
  if (prompt.includes("Califica la explicacion")) {
    return Promise.resolve('{"score": 70, "feedback": "Bien: mencionaste la inicializacion."}');
  }
  return Promise.resolve(`\`\`\`json\n${MODEL_QUIZ}\n\`\`\``);
}

function clientHeaders(clientId: string, sessionId = "") {
  return {
    "Content-Type": "application/json; charset=utf-8",
    "x-adaceen-client-id": clientId,
    ...(sessionId ? { "x-session-id": sessionId } : {}),
  };
}

const AFTER_ACCEPT_BODY = {
  filePath: "src/Algoritmos.java",
  language: "java",
  applyMode: "replace",
  originalCode: "int[][] resultado;",
  newCode: "int[][] resultado = new int[9][9];",
  suggestionText: "Inicializa la matriz resultado.",
  acceptCount: 1,
};

test("quiz: parseo tolerante y barajado conserva la respuesta correcta", () => {
  const parsed = parseGeneratedQuiz(`texto previo ${MODEL_QUIZ} texto posterior`);
  assert.ok(parsed);
  assert.equal(parsed.options.length, 4);
  assert.equal(parsed.options[parsed.correctIndex], "Inicializa la matriz");

  const shuffled = shuffleQuizOptions(parsed, () => 0);
  assert.equal(shuffled.options[shuffled.correctIndex], "Inicializa la matriz");

  assert.equal(parseGeneratedQuiz('{"question":"x","options":["a","a","b"],"correct_index":0}'), null);
  assert.equal(parseGeneratedQuiz('{"question":"x","options":["a","b","c"],"correct_index":7}'), null);
  assert.deepEqual(parseFollowUpGrade('{"score": 140, "feedback": "ok"}'), { score: 100, feedback: "ok" });

  const settings = normalizeQuizSettings({ triggers: ["teacher_launch", "otro"], everyNAccepts: 0 });
  assert.deepEqual(settings.triggers, ["teacher_launch"]);
  assert.equal(settings.everyNAccepts, 1);
  assert.equal(normalizeQuizSettings({}).followUpOnWrong, true);
});

test("quiz tras aceptar: opcion multiple, fallo, explicacion calificada", async () => {
  setQuizModelRunnerForTests(fakeModel);
  const { server, database, baseUrl } = await startTestServer();
  try {
    const noClient = await fetch(`${baseUrl}/api/quiz/after-accept`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(AFTER_ACCEPT_BODY),
    });
    assert.equal(noClient.status, 400);

    const created = await fetch(`${baseUrl}/api/quiz/after-accept`, {
      method: "POST",
      headers: clientHeaders("cliente-prueba-0001"),
      body: JSON.stringify(AFTER_ACCEPT_BODY),
    });
    const createdData = await created.json() as {
      quiz: { id: string; options: string[]; result: unknown; status: string } | null;
    };
    assert.equal(created.status, 200);
    assert.ok(createdData.quiz, "debe generar un quiz con la politica por defecto");
    assert.equal(createdData.quiz.status, "pending");
    assert.equal(createdData.quiz.result, null, "no revela la respuesta antes de contestar");
    assert.equal("correctIndex" in createdData.quiz, false);

    const quizId = createdData.quiz.id;
    const correctText = "Inicializa la matriz";
    const wrongIndex = createdData.quiz.options.findIndex((option) => option !== correctText);

    const otherClient = await fetch(`${baseUrl}/api/quiz/${quizId}/answer`, {
      method: "POST",
      headers: clientHeaders("otro-cliente-0002"),
      body: JSON.stringify({ choiceIndex: wrongIndex }),
    });
    assert.equal(otherClient.status, 404, "un cliente no puede contestar el quiz de otro");

    const answered = await fetch(`${baseUrl}/api/quiz/${quizId}/answer`, {
      method: "POST",
      headers: clientHeaders("cliente-prueba-0001"),
      body: JSON.stringify({ choiceIndex: wrongIndex }),
    });
    const answeredData = await answered.json() as {
      quiz: { status: string; followUpQuestion: string | null; result: { correct: boolean; correctIndex: number } };
    };
    assert.equal(answered.status, 200);
    assert.equal(answeredData.quiz.result.correct, false);
    assert.equal(answeredData.quiz.status, "followup");
    assert.ok(answeredData.quiz.followUpQuestion);

    const again = await fetch(`${baseUrl}/api/quiz/${quizId}/answer`, {
      method: "POST",
      headers: clientHeaders("cliente-prueba-0001"),
      body: JSON.stringify({ choiceIndex: 0 }),
    });
    assert.equal(again.status, 409, "no se puede contestar dos veces");

    const followUp = await fetch(`${baseUrl}/api/quiz/${quizId}/followup`, {
      method: "POST",
      headers: clientHeaders("cliente-prueba-0001"),
      body: JSON.stringify({ answer: "Porque si no, la matriz es null." }),
    });
    const followUpData = await followUp.json() as {
      quiz: { status: string; followUp: { score: number; feedback: string } };
    };
    assert.equal(followUp.status, 200);
    assert.equal(followUpData.quiz.status, "done");
    assert.equal(followUpData.quiz.followUp.score, 70);
  } finally {
    setQuizModelRunnerForTests(null);
    await stopTestServer(server, database);
  }
});

test("quiz: el docente parametriza cuando salen y lanza uno para la clase", async () => {
  setQuizModelRunnerForTests(fakeModel);
  const { server, database, baseUrl } = await startTestServer();
  try {
    const teacherSession = await login(baseUrl, "docente@adaceen.edu.co", "Docente123!");
    const studentSession = await login(baseUrl, "estudiante@adaceen.edu.co", "Estudiante123!");

    const saved = await fetch(`${baseUrl}/api/policies/current`, {
      method: "PUT",
      headers: { "Content-Type": "application/json", "x-session-id": teacherSession },
      body: JSON.stringify({
        quizSettings: { triggers: ["after_accept", "teacher_launch"], everyNAccepts: 2, maxPerSession: 5, followUpOnWrong: false },
      }),
    });
    const savedData = await saved.json() as { policy: { quizSettings: { everyNAccepts: number } } };
    assert.equal(saved.status, 200);
    assert.equal(savedData.policy.quizSettings.everyNAccepts, 2);

    const skipped = await fetch(`${baseUrl}/api/quiz/after-accept`, {
      method: "POST",
      headers: clientHeaders("cliente-estudiante-01", studentSession),
      body: JSON.stringify({ ...AFTER_ACCEPT_BODY, acceptCount: 1 }),
    });
    const skippedData = await skipped.json() as { quiz: unknown; reason: string };
    assert.equal(skippedData.quiz, null);
    assert.equal(skippedData.reason, "no_toca");

    const studentLaunch = await fetch(`${baseUrl}/api/quiz/launches`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-session-id": studentSession },
      body: JSON.stringify({ topic: "encapsulamiento" }),
    });
    assert.equal(studentLaunch.status, 403);

    const launched = await fetch(`${baseUrl}/api/quiz/launches`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-session-id": teacherSession },
      body: JSON.stringify({ topic: "encapsulamiento", expiresInMinutes: 30 }),
    });
    const launchedData = await launched.json() as { launch: { id: string; options: string[] }; autoEnabled?: boolean; message?: string };
    assert.equal(launched.status, 200, JSON.stringify(launchedData));
    assert.equal(launchedData.launch.options.length, 4);
    assert.equal(launchedData.autoEnabled, undefined, "la configuracion ya lo permitia: no se toca");
    assert.equal(launchedData.message, undefined);

    const pending = await fetch(`${baseUrl}/api/quiz/pending`, {
      headers: clientHeaders("cliente-estudiante-01", studentSession),
    });
    const pendingData = await pending.json() as { quiz: { id: string; trigger: string; launchId: string } | null };
    assert.equal(pending.status, 200);
    assert.ok(pendingData.quiz);
    assert.equal(pendingData.quiz.trigger, "teacher_launch");
    assert.equal(pendingData.quiz.launchId, launchedData.launch.id);

    const correctIndex = launchedData.launch.options.indexOf("Inicializa la matriz");
    const answered = await fetch(`${baseUrl}/api/quiz/${pendingData.quiz.id}/answer`, {
      method: "POST",
      headers: clientHeaders("cliente-estudiante-01", studentSession),
      body: JSON.stringify({ choiceIndex: correctIndex }),
    });
    const answeredData = await answered.json() as { quiz: { status: string; result: { correct: boolean } } };
    assert.equal(answeredData.quiz.result.correct, true);
    assert.equal(answeredData.quiz.status, "done");

    const afterAnswer = await fetch(`${baseUrl}/api/quiz/pending`, {
      headers: clientHeaders("cliente-estudiante-01", studentSession),
    });
    const afterAnswerData = await afterAnswer.json() as { quiz: unknown };
    assert.equal(afterAnswerData.quiz, null, "un quiz lanzado ya respondido no se repite");

    const launches = await fetch(`${baseUrl}/api/quiz/launches`, {
      headers: { "x-session-id": teacherSession },
    });
    const launchesData = await launches.json() as { launches: Array<{ results: { answered: number; correct: number } }> };
    assert.equal(launchesData.launches[0].results.answered, 1);
    assert.equal(launchesData.launches[0].results.correct, 1);

    const closed = await fetch(`${baseUrl}/api/quiz/launches/${launchedData.launch.id}/close`, {
      method: "POST",
      headers: { "x-session-id": teacherSession },
    });
    assert.equal(closed.status, 200);
  } finally {
    setQuizModelRunnerForTests(null);
    await stopTestServer(server, database);
  }
});

type PolicyQuiz = { allowMiniQuiz: boolean; quizSettings: { triggers: string[]; everyNAccepts: number; maxPerSession: number | null; followUpOnWrong: boolean } };

test("quiz: lanzar con el quiz del docente apagado lo activa, lo guarda y avisa; el quiz llega", async () => {
  setQuizModelRunnerForTests(fakeModel);
  const { server, database, baseUrl } = await startTestServer();
  const teacherHeaders = (sessionId: string) => ({ "Content-Type": "application/json", "x-session-id": sessionId });
  const MANUAL = {
    question: "Que modificador oculta un atributo?",
    options: ["private", "public", "static", "void"],
    correctIndex: 0,
    explanation: "private lo deja visible solo dentro de la clase.",
  };
  try {
    const teacherSession = await login(baseUrl, "docente@adaceen.edu.co", "Docente123!");
    const studentSession = await login(baseUrl, "estudiante@adaceen.edu.co", "Estudiante123!");
    const savePolicy = (body: unknown) => fetch(`${baseUrl}/api/policies/current`, {
      method: "PUT",
      headers: teacherHeaders(teacherSession),
      body: JSON.stringify(body),
    });
    const readPolicy = async () => {
      const response = await fetch(`${baseUrl}/api/policies/current`, { headers: { "x-session-id": teacherSession } });
      return (await response.json() as { policy: PolicyQuiz }).policy;
    };
    const launch = async (topic: string) => {
      const response = await fetch(`${baseUrl}/api/quiz/launches`, {
        method: "POST",
        headers: teacherHeaders(teacherSession),
        body: JSON.stringify({ topic, ...MANUAL }),
      });
      return { status: response.status, data: await response.json() as { ok: boolean; launch: { id: string }; autoEnabled?: boolean; message?: string; policy?: PolicyQuiz } };
    };
    const pending = async () => {
      const response = await fetch(`${baseUrl}/api/quiz/pending`, { headers: clientHeaders("cliente-estudiante-02", studentSession) });
      return await response.json() as { quiz: { launchId: string | null; trigger: string } | null };
    };

    // «Permitir mini quiz» apagado (y «Tras aceptar una sugerencia» marcado, como viene por defecto).
    const off = await savePolicy({ allowMiniQuiz: false, quizSettings: { triggers: ["after_accept", "teacher_launch"], everyNAccepts: 3, maxPerSession: 4, followUpOnWrong: true } });
    assert.equal(off.status, 200);
    assert.equal((await pending()).quiz, null);

    // Si crear el lanzamiento falla, la politica no cambia (se activa despues de lanzar).
    const originalCreate = database.createQuizLaunch;
    database.createQuizLaunch = async () => { throw new Error("base caida"); };
    try {
      const failed = await launch("encapsulamiento");
      assert.equal(failed.status, 400);
      assert.equal(failed.data.autoEnabled, undefined);
    } finally {
      database.createQuizLaunch = originalCreate;
    }
    const untouched = await readPolicy();
    assert.equal(untouched.allowMiniQuiz, false, "sin lanzamiento no se toca la politica");
    assert.deepEqual(untouched.quizSettings.triggers, ["after_accept", "teacher_launch"]);

    const first = await launch("encapsulamiento");
    assert.equal(first.status, 200, JSON.stringify(first.data));
    assert.equal(first.data.autoEnabled, true);
    assert.equal(
      first.data.message,
      "Quiz lanzado. Se activo «Permitir mini quiz» con «Cuando yo lo lance a la clase» en tus parametros para que llegue a tus estudiantes. «Tras aceptar una sugerencia» quedo sin marcar.",
      "dice tambien lo que se desmarco",
    );
    assert.equal(first.data.policy?.allowMiniQuiz, true, "la respuesta trae la politica nueva para refrescar el formulario");

    const saved = await readPolicy();
    assert.equal(saved.allowMiniQuiz, true, "quedo guardado");
    assert.deepEqual(saved.quizSettings.triggers, ["teacher_launch"], "solo se enciende el quiz lanzado: tras aceptar sigue sin salir");
    assert.equal(saved.quizSettings.everyNAccepts, 3, "el resto de ajustes no cambia");
    assert.equal(saved.quizSettings.maxPerSession, 4);

    const received = await pending();
    assert.equal(received.quiz?.launchId, first.data.launch.id, "el quiz llega al estudiante");
    assert.equal(received.quiz?.trigger, "teacher_launch");
    const afterAccept = await fetch(`${baseUrl}/api/quiz/after-accept`, {
      method: "POST",
      headers: clientHeaders("cliente-estudiante-02", studentSession),
      body: JSON.stringify({ ...AFTER_ACCEPT_BODY, acceptCount: 3 }),
    });
    assert.equal((await afterAccept.json() as { reason: string }).reason, "desactivado", "el quiz tras aceptar sigue apagado");

    // «Permitir mini quiz» marcado pero sin «Cuando yo lo lance a la clase»: solo se agrega ese.
    await savePolicy({ allowMiniQuiz: true, quizSettings: { triggers: ["after_accept"], everyNAccepts: 2, maxPerSession: null, followUpOnWrong: false } });
    const second = await launch("herencia");
    assert.equal(second.data.autoEnabled, true);
    assert.equal(second.data.message, "Quiz lanzado. Se activo «Cuando yo lo lance a la clase» en tus parametros para que llegue a tus estudiantes.");
    const savedAgain = await readPolicy();
    assert.deepEqual(savedAgain.quizSettings.triggers, ["after_accept", "teacher_launch"]);
    assert.equal(savedAgain.quizSettings.maxPerSession, null);

    // Ya permitido: el siguiente lanzamiento no toca nada.
    const third = await launch("polimorfismo");
    assert.equal(third.data.autoEnabled, undefined);
    assert.equal(third.data.policy, undefined);

    // Apagado sin «Tras aceptar una sugerencia»: no hay nada que desmarcar ni que decir.
    await savePolicy({ allowMiniQuiz: false, quizSettings: { triggers: [], everyNAccepts: 1, maxPerSession: null, followUpOnWrong: true } });
    const fourth = await launch("interfaces");
    assert.equal(fourth.data.message, "Quiz lanzado. Se activo «Permitir mini quiz» con «Cuando yo lo lance a la clase» en tus parametros para que llegue a tus estudiantes.");
    assert.deepEqual((await readPolicy()).quizSettings.triggers, ["teacher_launch"]);

    // Si el quiz ya quedo lanzado pero guardar la politica falla, se responde
    // ok con el lanzamiento y un aviso (no un error que invite a relanzarlo).
    await savePolicy({ allowMiniQuiz: false, quizSettings: { triggers: ["teacher_launch"], everyNAccepts: 1, maxPerSession: null, followUpOnWrong: true } });
    const originalUpdate = database.updateTeacherPolicy;
    database.updateTeacherPolicy = async () => { throw new Error("base caida"); };
    let fifth: Awaited<ReturnType<typeof launch>>;
    try {
      fifth = await launch("abstraccion");
    } finally {
      database.updateTeacherPolicy = originalUpdate;
    }
    assert.equal(fifth.status, 200, JSON.stringify(fifth.data));
    assert.equal(fifth.data.ok, true);
    assert.ok(fifth.data.launch.id, "el lanzamiento existe");
    assert.equal(fifth.data.autoEnabled, undefined);
    assert.match(String(fifth.data.message), /^Quiz lanzado, pero no se pudo revisar tus parametros: si no llega a tus estudiantes, marca «Permitir mini quiz» y «Cuando yo lo lance a la clase» y guarda\./);
  } finally {
    setQuizModelRunnerForTests(null);
    await stopTestServer(server, database);
  }
});

import assert from "node:assert/strict";
import test from "node:test";
import type { Server } from "node:http";
import { createApp } from "../../src/app.js";
import { env } from "../../src/config/env.js";
import { createDatabase, type AppDatabase } from "../../src/db/database.js";
import { analysisCodesByLogin, indexIdentitiesByLogin, studentPseudonym } from "../../src/services/learning-analytics.js";
import { ingestProgressReport } from "../../src/services/progress-report-ingest.js";
import { buildWorkshopProgressView, progressReportSchema, type ProgressReport } from "../../src/services/workshop-progress.js";

/**
 * Avance de los talleres (29-10-2026): la VM de editores (deploy/gcp/workspaces/avance-ws.py)
 * informa por login de GitHub; el backend lo cruza con los estudiantes de quien mira y lo muestra
 * en el monitor del docente y en «Estudiantes». Nunca llega codigo.
 */

type Json = Record<string, any>;

async function startServer() {
  const database = await createDatabase();
  const app = createApp(database, {});
  const server = await new Promise<Server>((resolve) => {
    const started = app.listen(0, () => resolve(started));
  });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("sin puerto");
  return { database, server, baseUrl: `http://127.0.0.1:${address.port}` };
}

async function stopServer(server: Server, database: AppDatabase) {
  await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
  await database.close();
}

async function call(baseUrl: string, method: string, route: string, options: { sessionId?: string; body?: unknown; headers?: Record<string, string> } = {}) {
  const response = await fetch(`${baseUrl}${route}`, {
    method,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      ...(options.sessionId ? { "x-session-id": options.sessionId } : {}),
      ...(options.headers || {}),
    },
    ...(options.body === undefined ? {} : { body: JSON.stringify(options.body) }),
  });
  const text = await response.text();
  let data: Json = {};
  try {
    data = text ? JSON.parse(text) : {};
  } catch {
    data = { text };
  }
  return { status: response.status, data };
}

async function sessionOf(database: AppDatabase, email: string, password: string) {
  const session = await database.authenticateUser(email, password);
  assert.ok(session, `sesion de ${email}`);
  return session.id;
}

const POINTS = [
  { id: "cliente-clase", hu: "HU-1", texto: "Clase Cliente", peso: 10 },
  { id: "retirar", hu: "HU-3", texto: "retirarDinero en Cuenta", peso: 50 },
  { id: "compila", hu: "Programa", texto: "Compila sin errores", peso: 40 },
];

function report(students: Json[]) {
  return { taller: "sistema-bancario-fpoo", titulo: "Sistema bancario", generatedAt: "2026-10-29T23:00:00.000Z", points: POINTS, students };
}

test("avance del taller: la VM informa con su token y el docente ve a los suyos, de menos avance a mas", async () => {
  const original = env.workspaceAgentToken;
  env.workspaceAgentToken = "token-del-agente-de-prueba";
  const { server, database, baseUrl } = await startServer();
  try {
    const agent = { "x-agent-token": env.workspaceAgentToken };
    const ana = await database.createManagedUser({ role: "student", email: "ana@correounivalle.edu.co", displayName: "Ana Avanza", password: "Temporal-12345", teacherUserId: "user-teacher-demo" });
    const beto = await database.createManagedUser({ role: "student", email: "beto@correounivalle.edu.co", displayName: "Beto Empieza", password: "Temporal-12345", teacherUserId: "user-teacher-demo" });
    const carla = await database.createManagedUser({ role: "student", email: "carla@correounivalle.edu.co", displayName: "Carla SinEditor", password: "Temporal-12345", teacherUserId: "user-teacher-demo" });
    const otroDocente = await database.createManagedUser({ role: "teacher", email: "otro.docente@correounivalle.edu.co", displayName: "Otro Docente", password: "Temporal-12345" });
    const dani = await database.createManagedUser({ role: "student", email: "dani@correounivalle.edu.co", displayName: "Dani OtroGrupo", password: "Temporal-12345", teacherUserId: otroDocente.id });
    await database.upsertGithubUserToken({ userId: ana.id, accountLogin: "Ana-GH", accessToken: "gho_a" });
    await database.upsertGithubUserToken({ userId: beto.id, accountLogin: "beto-gh", accessToken: "gho_b" });
    await database.upsertGithubUserToken({ userId: dani.id, accountLogin: "dani-gh", accessToken: "gho_d" });
    void carla;

    const body = report([
      { login: "ana-gh", started: true, percent: 60, compiles: true, done: ["cliente-clase", "compila"], partial: ["retirar"], missing: [], files: 6, lastChangeAt: "2026-10-29T22:50:00.000Z" },
      { login: "beto-gh", started: true, percent: 10, compiles: false, done: ["cliente-clase"], partial: [], missing: ["retirar", "compila", "no-existe"], files: 1, lastChangeAt: "2026-10-29T22:40:00.000Z" },
      { login: "dani-gh", started: true, percent: 90, compiles: true, done: ["cliente-clase", "compila"], partial: ["retirar"], missing: [], files: 7, lastChangeAt: null },
      { login: "sin-cuenta", started: true, percent: 30, compiles: null, done: [], partial: [], missing: ["retirar"], files: 2, lastChangeAt: null },
    ]);
    assert.equal((await call(baseUrl, "POST", "/api/workspaces/progress-report", { body })).status, 401);
    assert.equal((await call(baseUrl, "POST", "/api/workspaces/progress-report", { body, headers: { "x-agent-token": "otro" } })).status, 401);
    assert.equal((await call(baseUrl, "POST", "/api/workspaces/progress-report", { body: { taller: "x" }, headers: agent })).status, 400);
    assert.equal((await call(baseUrl, "POST", "/api/workspaces/progress-report", { body: { ...body, students: [{ ...body.students[0], login: "../etc" }] }, headers: agent })).status, 400);
    const sent = await call(baseUrl, "POST", "/api/workspaces/progress-report", { body, headers: agent });
    assert.equal(sent.status, 200, JSON.stringify(sent.data));
    assert.equal(sent.data.students, 4);

    const admin = await sessionOf(database, "admin@adaceen.edu.co", "Admin123!");
    const teacher = await sessionOf(database, "docente@adaceen.edu.co", "Docente123!");
    const student = await sessionOf(database, "estudiante@adaceen.edu.co", "Estudiante123!");
    assert.equal((await call(baseUrl, "GET", "/api/admin/workshop-progress")).status, 401);
    assert.equal((await call(baseUrl, "GET", "/api/admin/workshop-progress", { sessionId: student })).status, 403);

    const asTeacher = await call(baseUrl, "GET", "/api/admin/workshop-progress", { sessionId: teacher });
    assert.equal(asTeacher.status, 200, JSON.stringify(asTeacher.data));
    const view = asTeacher.data.avance;
    assert.equal(view.taller, "sistema-bancario-fpoo");
    assert.deepEqual(asTeacher.data.talleres, [{ taller: "sistema-bancario-fpoo", titulo: "Sistema bancario" }]);
    const names = view.students.map((row: Json) => row.displayName);
    assert.ok(!names.includes("Dani OtroGrupo"), "el docente no ve a otro grupo");
    // Primero quien va mas atras; luego sin carpeta / sin editor; las cuentas de muestra al final.
    assert.deepEqual(names.slice(0, 3), ["Beto Empieza", "Ana Avanza", "Carla SinEditor"]);
    const byName = Object.fromEntries(view.students.map((row: Json) => [row.displayName, row]));
    assert.equal(byName["Ana Avanza"].percent, 60);
    assert.equal(byName["Ana Avanza"].githubLogin, "ana-gh", "el login se compara sin mayusculas");
    assert.equal(byName["Carla SinEditor"].status, "sin-editor");
    assert.equal(byName["Carla SinEditor"].percent, null);
    // Lo pendiente, de mas peso a menos, con el texto del punto; los ids desconocidos se descartan.
    assert.deepEqual(byName["Beto Empieza"].pending.map((p: Json) => p.id), ["retirar", "compila"]);
    assert.equal(byName["Beto Empieza"].pending[0].texto, "retirarDinero en Cuenta");
    assert.equal(view.summary.started, 2);
    assert.equal(view.summary.averagePercent, 35);
    assert.equal(view.summary.compiling, 1);
    assert.deepEqual(view.unlinked, [], "el docente no ve logins sin cuenta");
    assert.equal(JSON.stringify(asTeacher.data).includes("gho_"), false, "nunca sale el token de GitHub");

    const asAdmin = await call(baseUrl, "GET", "/api/admin/workshop-progress", { sessionId: admin });
    assert.equal(asAdmin.status, 200);
    assert.ok(asAdmin.data.avance.students.some((row: Json) => row.displayName === "Dani OtroGrupo"));
    assert.deepEqual(asAdmin.data.avance.unlinked, [{ login: "sin-cuenta", percent: 30 }]);
    const scoped = await call(baseUrl, "GET", `/api/admin/workshop-progress?teacherUserId=${otroDocente.id}`, { sessionId: admin });
    assert.deepEqual(scoped.data.avance.students.map((row: Json) => row.displayName), ["Dani OtroGrupo"]);

    // «Estudiantes» trae la celda del taller en cada fila.
    const list = await call(baseUrl, "GET", "/api/admin/students", { sessionId: teacher });
    assert.equal(list.status, 200);
    assert.equal(list.data.workshop.taller, "sistema-bancario-fpoo");
    const anaRow = list.data.students.find((row: Json) => row.id === ana.id);
    assert.deepEqual(
      { status: anaRow.workshop.status, percent: anaRow.workshop.percent, compiles: anaRow.workshop.compiles },
      { status: "en-curso", percent: 60, compiles: true },
    );
    assert.equal(list.data.students.find((row: Json) => row.id === carla.id).workshop.status, "sin-editor");

    const health = await call(baseUrl, "GET", "/api/health");
    assert.deepEqual(health.data.workshop_progress, { taller: "sistema-bancario-fpoo", last_at: health.data.workshop_progress.last_at, students: 4, started: 4 });
    assert.equal(JSON.stringify(health.data.workshop_progress).includes("ana-gh"), false, "la salud publica no lleva logins");

    const page = await fetch(`${baseUrl}/docente/monitor`).then((response) => response.text());
    assert.ok(page.includes("Avance del taller"));
    assert.ok(page.includes("/api/admin/workshop-progress"));
  } finally {
    env.workspaceAgentToken = original;
    await stopServer(server, database);
  }
});

test("avance del taller: sin informe responde null; un informe viejo sale como desactualizado; promedio por HU", async () => {
  const { server, database, baseUrl } = await startServer();
  try {
    const teacher = await sessionOf(database, "docente@adaceen.edu.co", "Docente123!");
    const empty = await call(baseUrl, "GET", "/api/admin/workshop-progress", { sessionId: teacher });
    assert.equal(empty.status, 200);
    assert.equal(empty.data.avance, null);
    const students = (await call(baseUrl, "GET", "/api/admin/students", { sessionId: teacher })).data.students;
    assert.ok(students.every((row: Json) => row.workshop === null));
  } finally {
    await stopServer(server, database);
  }

  const old: ProgressReport = {
    ...report([
      { login: "a", started: true, percent: 100, compiles: true, done: ["cliente-clase", "retirar", "compila"], partial: [], missing: [], files: 3, lastChangeAt: null },
      { login: "b", started: true, percent: 35, compiles: false, done: ["cliente-clase"], partial: ["retirar"], missing: ["compila"], files: 1, lastChangeAt: null },
    ]),
    receivedAt: "2026-10-29T20:00:00.000Z",
  } as ProgressReport;
  const ref = (id: string, login: string | null) => ({ userId: id, displayName: id, email: `${id}@x.co`, teacherDisplayName: null, isActive: true, githubLogin: login });
  const view = buildWorkshopProgressView(old, [ref("user-a", "a"), ref("user-b", "b"), ref("user-demo-student-a1", "a")], Date.parse("2026-10-29T21:00:00.000Z"));
  assert.equal(view.stale, true, "una hora sin informe");
  assert.equal(view.summary.students, 2, "la cuenta demo no entra al resumen");
  assert.equal(view.students.at(-1)?.sampleAccount, true);
  assert.deepEqual(view.summary.byHu, [{ hu: "HU-1", percent: 100 }, { hu: "HU-3", percent: 75 }, { hu: "Programa", percent: 50 }]);
  assert.equal(view.points.find((p) => p.id === "retirar")?.partial, 1);
});

test("avance del taller (02-11-2026): la respuesta a la VM trae el codigo del analisis de cada login; sin muestra, sin vincular ni ambiguos", async () => {
  const original = env.workspaceAgentToken;
  env.workspaceAgentToken = "token-del-agente-de-prueba";
  const { server, database, baseUrl } = await startServer();
  try {
    const agent = { "x-agent-token": env.workspaceAgentToken };
    const ana = await database.createManagedUser({ role: "student", email: "ana.seud@correounivalle.edu.co", displayName: "Ana", password: "Temporal-12345", teacherUserId: "user-teacher-demo" });
    const beto = await database.createManagedUser({ role: "student", email: "beto.seud@correounivalle.edu.co", displayName: "Beto", password: "Temporal-12345", teacherUserId: "user-teacher-demo" });
    const beto2 = await database.createManagedUser({ role: "student", email: "beto.otra@correounivalle.edu.co", displayName: "Beto (otra)", password: "Temporal-12345", teacherUserId: "user-teacher-demo" });
    await database.upsertGithubUserToken({ userId: ana.id, accountLogin: "Ana-Seud", accessToken: "gho_a" });
    // El mismo login en dos cuentas distintas: no se adivina de quien es.
    await database.upsertGithubUserToken({ userId: beto.id, accountLogin: "beto-seud", accessToken: "gho_b" });
    await database.upsertGithubUserToken({ userId: beto2.id, accountLogin: "beto-seud", accessToken: "gho_c" });
    // Una cuenta de muestra con login: fuera.
    await database.upsertGithubUserToken({ userId: "user-student-demo", accountLogin: "demo-seud", accessToken: "gho_d" });
    const entry = (login: string, started = true) => ({ login, started, percent: 10, compiles: false, done: [], partial: [], missing: ["retirar"], files: 1, lastChangeAt: null });
    const info = console.info;
    const logged: string[] = [];
    console.info = (...args: unknown[]) => { logged.push(args.join(" ")); };
    let sent;
    try {
      sent = await call(baseUrl, "POST", "/api/workspaces/progress-report", {
        headers: agent,
        body: report([entry("ana-seud"), entry("beto-seud"), entry("demo-seud"), entry("sin-cuenta"), { ...entry("ana-seud"), login: "ana-sin-carpeta" }]),
      });
    } finally {
      console.info = info;
    }
    assert.equal(sent.status, 200, JSON.stringify(sent.data));
    assert.deepEqual(sent.data.analysisCodes, { "ana-seud": studentPseudonym(ana.id) });
    assert.match(sent.data.analysisCodes["ana-seud"], /^[0-9a-f]{20}$/);
    assert.equal("pseudonyms" in sent.data, false, "el nombre viejo del campo no sale");
    // El log dice cuantos, nunca cuales ni de quien.
    assert.ok(logged.includes("[avance] codigos del analisis entregados a la VM: 1"), logged.join(" | "));
    assert.equal(logged.join(" ").includes("ana-seud") || logged.join(" ").includes(studentPseudonym(ana.id)), false);

    // Si no se pueden leer las cuentas, el informe igual vale y la VM recibe null (no sabe), no {}.
    const realList = database.listStudentAnalyticsIdentities.bind(database);
    database.listStudentAnalyticsIdentities = async () => {
      throw new Error("base caida");
    };
    const warn = console.warn;
    console.warn = () => {};
    try {
      const failed = await call(baseUrl, "POST", "/api/workspaces/progress-report", { headers: agent, body: report([entry("ana-seud")]) });
      assert.equal(failed.status, 200, JSON.stringify(failed.data));
      assert.equal(failed.data.ok, true);
      assert.equal(failed.data.analysisCodes, null);
      assert.equal(failed.data.history, null);
      assert.ok(await database.getAppSetting("workshop_progress:sistema-bancario-fpoo"), "el informe quedo guardado");
    } finally {
      console.warn = warn;
      database.listStudentAnalyticsIdentities = realList;
    }
    // Sin el token del agente no hay respuesta (ni codigos).
    const anonymous = await call(baseUrl, "POST", "/api/workspaces/progress-report", { body: report([entry("ana-seud")]) });
    assert.equal(anonymous.status, 401);
    assert.equal("analysisCodes" in anonymous.data, false);
  } finally {
    env.workspaceAgentToken = original;
    await stopServer(server, database);
  }
});

test("analysisCodesByLogin: la misma regla que la historia (indexIdentitiesByLogin), solo quien tiene la carpeta, pura", () => {
  const identities = [
    { userId: "u-ana", teacherUserId: null, githubLogin: "ana" },
    { userId: "u-ana", teacherUserId: null, githubLogin: "ana" },
    { userId: "u-beto", teacherUserId: null, githubLogin: "beto" },
    { userId: "u-beto-2", teacherUserId: null, githubLogin: "beto" },
    { userId: "user-demo-student-a1", teacherUserId: null, githubLogin: "demo" },
    { userId: "u-sin-login", teacherUserId: null, githubLogin: null },
  ];
  const students = ["ANA", "beto", "demo", "nadie"].map((login) => ({ login, started: true }))
    .concat({ login: "ana-sin-carpeta", started: false });
  const conSinCarpeta = [...identities, { userId: "u-ana-2", teacherUserId: null, githubLogin: "ana-sin-carpeta" }];
  assert.deepEqual(analysisCodesByLogin({ students } as unknown as ProgressReport, conSinCarpeta), { ana: studentPseudonym("u-ana") });
  const index = indexIdentitiesByLogin(identities);
  assert.equal(index.get("beto"), null, "ambiguo");
  assert.equal(index.get("ana")?.userId, "u-ana", "una cuenta unida y la que prevalece llegan con el mismo id");
  assert.equal(index.get("nadie"), undefined, "sin vincular");
});

test("avance del taller (02-11-2026): los avisos del revisor se guardan, se filtran sin rechazar el informe y el docente los lee", async () => {
  const original = env.workspaceAgentToken;
  env.workspaceAgentToken = "token-del-agente-de-prueba";
  const { server, database, baseUrl } = await startServer();
  try {
    const agent = { "x-agent-token": env.workspaceAgentToken };
    const alan = await database.createManagedUser({ role: "student", email: "alan.aviso@correounivalle.edu.co", displayName: "Alan Aviso", password: "Temporal-12345", teacherUserId: "user-teacher-demo" });
    await database.upsertGithubUserToken({ userId: alan.id, accountLogin: "alan-gh", accessToken: "gho_alan" });
    const body = report([
      {
        login: "alan-gh", started: true, percent: 0, compiles: false, done: [], partial: [], missing: ["cliente-clase", "retirar", "compila"], files: 4, lastChangeAt: null,
        codeNotices: [
          { id: "class-mayuscula", paths: ["src/modelo/Cliente.h", "src/modelo/Cuenta.h"] },
          { id: "aviso-de-una-vm-mas-nueva", paths: ["x.h"] },
          "no es un aviso",
          { id: "struct-mayuscula", paths: ["src/modelo/Punto.h"] },
        ],
      },
      { login: "sin-avisos", started: true, percent: 40, compiles: true, done: ["cliente-clase"], partial: [], missing: [], files: 2, lastChangeAt: null },
      { login: "sin-carpeta", started: false, percent: 0, compiles: null, done: [], partial: [], missing: [], files: 0, lastChangeAt: null, codeNotices: [{ id: "class-mayuscula", paths: [] }] },
    ]);
    const sent = await call(baseUrl, "POST", "/api/workspaces/progress-report", { body, headers: agent });
    assert.equal(sent.status, 200, "un aviso desconocido no rechaza el informe");
    const saved = JSON.parse((await database.getAppSetting("workshop_progress:sistema-bancario-fpoo"))!.value!);
    const byLogin = Object.fromEntries(saved.students.map((entry: Json) => [entry.login, entry]));
    assert.deepEqual(byLogin["alan-gh"].codeNotices, [
      { id: "class-mayuscula", paths: ["src/modelo/Cliente.h", "src/modelo/Cuenta.h"] },
      { id: "struct-mayuscula", paths: ["src/modelo/Punto.h"] },
    ]);
    assert.deepEqual(byLogin["sin-avisos"].codeNotices, [], "sin avisos: lista vacia");
    assert.deepEqual(byLogin["sin-carpeta"].codeNotices, [], "sin carpeta no hay codigo que avisar");
    assert.equal(byLogin["alan-gh"].percent, 0, "el aviso no cambia el porcentaje");

    const teacher = await sessionOf(database, "docente@adaceen.edu.co", "Docente123!");
    const view = (await call(baseUrl, "GET", "/api/admin/workshop-progress", { sessionId: teacher })).data.avance;
    const row = view.students.find((item: Json) => item.displayName === "Alan Aviso");
    assert.deepEqual(row.codeNotices, [
      { id: "class-mayuscula", texto: "Escribió Class con mayúscula en Cliente.h y Cuenta.h: no compila y esas clases no cuentan en su avance (C++ solo reconoce class)." },
      { id: "struct-mayuscula", texto: "Escribió Struct con mayúscula en Punto.h: no compila y esas estructuras no cuentan en su avance (C++ solo reconoce struct)." },
    ]);
    assert.equal(row.percent, 0);

    // Un informe guardado antes de los avisos (sin codeNotices) se sigue leyendo: lista vacia.
    const old = { ...report([{ login: "a", started: true, percent: 10, compiles: true, done: [], partial: [], missing: [], files: 1, lastChangeAt: null }]), receivedAt: new Date().toISOString() } as unknown as ProgressReport;
    const oldView = buildWorkshopProgressView(old, [{ userId: "u-a", displayName: "A", email: "a@x.co", teacherDisplayName: null, isActive: true, githubLogin: "a" }]);
    assert.deepEqual(oldView.students[0].codeNotices, []);

    const page = await fetch(`${baseUrl}/docente/monitor`).then((response) => response.text());
    assert.ok(page.includes("st.codeNotices"), "el monitor muestra los avisos");
    assert.ok(page.includes("aviso.textContent"), "como texto, sin HTML");
  } finally {
    env.workspaceAgentToken = original;
    await stopServer(server, database);
  }
});

test("ingestProgressReport: lee las cuentas una vez; si falla la historia, los codigos igual salen", async () => {
  const saved: string[] = [];
  let reads = 0;
  const database = {
    getAppSetting: async () => null,
    setAppSetting: async (key: string) => { saved.push(key); return null; },
    listStudentAnalyticsIdentities: async () => { reads += 1; return [{ userId: "u-ana", teacherUserId: null, githubLogin: "ana" }]; },
    listWorkshopLastFingerprints: async () => new Map<string, string>(),
    saveWorkshopSnapshots: async () => { throw new Error("tabla caida"); },
  };
  const warnings: string[] = [];
  const log = { info: () => {}, warn: (...args: unknown[]) => { warnings.push(args.join(" ")); } };
  const input = progressReportSchema.parse(report([{ login: "ana", started: true, percent: 5, compiles: null, done: [], partial: [], missing: [], files: 1, lastChangeAt: null }]));
  const result = await ingestProgressReport(database, input, log);
  assert.equal(reads, 1, "una sola lectura de las cuentas para la historia y los codigos");
  assert.equal(result.history, null);
  assert.deepEqual(result.analysisCodes, { ana: studentPseudonym("u-ana") });
  assert.ok(saved.includes("workshop_progress:sistema-bancario-fpoo"));
  assert.match(warnings.join(" "), /no se guardo la historia/);
});

test("informe de avance: un punto del taller no puede empezar por aviso- (es de los avisos del revisor)", () => {
  const body = report([]);
  assert.equal(progressReportSchema.safeParse({ ...body, points: [...POINTS, { id: "aviso-class-mayuscula", hu: "", texto: "x", peso: 1 }] }).success, false);
  assert.equal(progressReportSchema.safeParse(body).success, true);
});

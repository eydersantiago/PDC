import assert from "node:assert/strict";
import test from "node:test";
import type { Server } from "node:http";
import express from "express";
import { env } from "../../src/config/env.js";
import { createDatabase, type AppDatabase } from "../../src/db/database.js";
import { loadLatestBitacoraAgendaItems } from "../../src/routes/bitacora-data-routes.js";
import { registerHealthRoutes } from "../../src/routes/health-routes.js";
import {
  DEMO_ROUTE_ACCOUNTS,
  DEMO_ROUTE_ACCOUNT_IDS,
  DEMO_ROUTES,
  DEMO_ROUTES_DEFAULT_ORG,
  DEMO_ROUTES_DEFAULT_UNTIL,
  demoRouteTopic,
  demoRoutesExpired,
  demoRoutesPasswordProblem,
  demoRoutesUntil,
  isDemoRouteAccountId,
} from "../../src/services/demo-route-accounts.js";

/**
 * Cuentas demo por ruta (DEMO_RUTAS_PASSWORD, src/services/demo-route-accounts.ts): un docente demo
 * por ruta del piloto (A, B, C y D) con su bitacora, su tema y una copia del RAG del docente del
 * curso, y tres estudiantes con codigo cada uno. Sin la variable, con clave corta o vencidas no
 * se siembran y las que existan se desactivan.
 */

const PASSWORD = "clave-demo-rutas-larga";
const TEACHERS = DEMO_ROUTE_ACCOUNTS.filter((account) => account.role === "teacher");
const STUDENTS = DEMO_ROUTE_ACCOUNTS.filter((account) => account.role === "student");
const BEFORE_END = new Date("2026-11-01T12:00:00-05:00");

type Saved = Pick<typeof env, "seedDemoAccounts" | "testAccountsPassword" | "demoRoutesPassword" | "demoRoutesOrg" | "demoRoutesUntil">;

function saveEnv(): Saved {
  return {
    seedDemoAccounts: env.seedDemoAccounts,
    testAccountsPassword: env.testAccountsPassword,
    demoRoutesPassword: env.demoRoutesPassword,
    demoRoutesOrg: env.demoRoutesOrg,
    demoRoutesUntil: env.demoRoutesUntil,
  };
}

async function capturingConsole<T>(work: () => Promise<T>) {
  const lines: string[] = [];
  const saved = { info: console.info, warn: console.warn };
  console.info = (...args: unknown[]) => { lines.push(args.map(String).join(" ")); };
  console.warn = (...args: unknown[]) => { lines.push(args.map(String).join(" ")); };
  try {
    const result = await work();
    return { result, lines };
  } finally {
    Object.assign(console, saved);
  }
}

async function canLogin(database: AppDatabase, email: string, password: string) {
  return Boolean(await database.authenticateUser(email, password, { kind: "cli" }));
}

async function countRows(database: AppDatabase, sql: string, values: unknown[]) {
  const result = await database.pool.query<{ count: string }>(sql, values);
  return Number(result.rows[0]?.count || 0);
}

async function ragSourcesOf(database: AppDatabase, teacherId: string) {
  return countRows(database, `select count(*)::text as count from rag_sources where scope = 'teacher' and teacher_user_id = $1`, [teacherId]);
}

async function startHealthServer(database: AppDatabase) {
  const app = express();
  registerHealthRoutes(app, database);
  const server = await new Promise<Server>((resolve) => {
    const started = app.listen(0, () => resolve(started));
  });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("No se pudo iniciar servidor de prueba.");
  return { server, baseUrl: `http://127.0.0.1:${address.port}` };
}

async function copiesOf(database: AppDatabase, teacherId: string) {
  const result = await database.pool.query<{ metadata: unknown; created_by_user_id: string | null; is_active: boolean }>(
    `select metadata, created_by_user_id, is_active from rag_sources where scope = 'teacher' and teacher_user_id = $1`,
    [teacherId],
  );
  return result.rows.map((row) => ({
    metadata: (typeof row.metadata === "string" ? JSON.parse(row.metadata) : row.metadata) as Record<string, unknown>,
    createdBy: row.created_by_user_id,
    isActive: row.is_active,
  }));
}

async function bitacorasOf(database: AppDatabase, teacherId: string) {
  return countRows(database, `select count(*)::text as count from project_document_classifications where user_id = $1 and label = 'BITACORA'`, [teacherId]);
}

test("cuentas demo por ruta: lista, clave, fecha y tema", () => {
  assert.equal(DEMO_ROUTES.length, 4);
  assert.equal(TEACHERS.length, 4);
  assert.equal(STUDENTS.length, 12);
  assert.equal(new Set(DEMO_ROUTE_ACCOUNT_IDS).size, 16, "ids unicos");
  assert.equal(new Set(DEMO_ROUTE_ACCOUNTS.map((account) => account.email)).size, 16, "correos unicos");
  const codes = STUDENTS.map((account) => account.studentCode || "");
  assert.equal(new Set(codes).size, 12, "codigos unicos");
  assert.ok(codes.every((code) => /^\d{7}$/.test(code)), "codigos de siete digitos");
  assert.ok(!codes.some((code) => ["0000001", "0000011", "0000012", "0000013"].includes(code)), "no chocan con las cuentas demo ni las de prueba");
  for (const student of STUDENTS) {
    const teacherIndex = DEMO_ROUTE_ACCOUNTS.findIndex((account) => account.id === student.teacherId);
    assert.ok(teacherIndex >= 0 && teacherIndex < DEMO_ROUTE_ACCOUNTS.indexOf(student), `${student.email}: su docente va antes`);
  }
  assert.deepEqual(
    DEMO_ROUTE_ACCOUNTS.filter((account) => account.routeKey === "a").map((account) => [account.email, account.studentCode ?? ""]),
    [
      ["demo.a.docente@adaceen.edu.co", ""],
      ["demo.a.e1@adaceen.edu.co", "0000101"],
      ["demo.a.e2@adaceen.edu.co", "0000102"],
      ["demo.a.e3@adaceen.edu.co", "0000103"],
    ],
  );
  assert.equal(isDemoRouteAccountId("user-demo-teacher-c"), true);
  assert.equal(isDemoRouteAccountId("user-teacher-demo"), false, "el docente demo de seeds.ts no es de las rutas");

  assert.equal(demoRoutesPasswordProblem(""), "");
  assert.equal(demoRoutesPasswordProblem(PASSWORD), "");
  assert.match(demoRoutesPasswordProblem("corta"), /menos de 12 caracteres/);

  assert.deepEqual(demoRoutesUntil(""), { until: DEMO_ROUTES_DEFAULT_UNTIL, warning: "" });
  assert.deepEqual(demoRoutesUntil(" 2026-11-06 "), { until: "2026-11-06", warning: "" });
  for (const bad of ["2026-02-30", "06/11/2026", "mañana"]) {
    const result = demoRoutesUntil(bad);
    assert.equal(result.until, DEMO_ROUTES_DEFAULT_UNTIL, bad);
    assert.match(result.warning, /no es una fecha aaaa-mm-dd/, bad);
  }
  assert.equal(demoRoutesExpired("2026-11-06", new Date("2026-11-06T23:59:00-05:00")), false, "el ultimo dia todavia sirve");
  assert.equal(demoRoutesExpired("2026-11-06", new Date("2026-11-07T00:00:30-05:00")), true, "al dia siguiente vencen");

  const routeC = DEMO_ROUTES.find((route) => route.key === "c")!;
  assert.deepEqual(demoRouteTopic(routeC, "").topic, {
    courseCode: "FPOO", week: 11, title: "Taller Relaciones en Bus Fever Party", repoFullName: `${DEMO_ROUTES_DEFAULT_ORG}/taller-relaciones`,
  });
  assert.equal(demoRouteTopic(routeC, "univalle-fpoo-demo").topic.repoFullName, "univalle-fpoo-demo/taller-relaciones");
  const bad = demoRouteTopic(routeC, "no es una org");
  assert.equal(bad.topic.repoFullName, `${DEMO_ROUTES_DEFAULT_ORG}/taller-relaciones`);
  assert.match(bad.warning, /DEMO_RUTAS_ORG=no es una org no es un usuario u organizacion/);
  const routeD = DEMO_ROUTES.find((route) => route.key === "d")!;
  assert.equal(demoRouteTopic(routeD, "").topic.repoFullName, `${DEMO_ROUTES_DEFAULT_ORG}/taller-relaciones`, "D usa el taller de C");
});

test("cuentas demo por ruta: sin DEMO_RUTAS_PASSWORD no se siembran", async () => {
  const saved = saveEnv();
  Object.assign(env, { seedDemoAccounts: true, testAccountsPassword: "", demoRoutesPassword: "", demoRoutesOrg: "", demoRoutesUntil: "" });
  const database = await createDatabase();
  try {
    assert.equal(await database.countActiveDemoRouteAccounts(), 0);
    const rows = await database.pool.query(`select id from users where email like 'demo.%'`);
    assert.equal(rows.rows.length, 0, "ninguna cuenta demo por ruta en la base");
  } finally {
    Object.assign(env, saved);
    await database.close();
  }
});

test("cuentas demo por ruta: con la variable quedan con bitacora, tema, politica y RAG del curso", async () => {
  const saved = saveEnv();
  Object.assign(env, { seedDemoAccounts: true, testAccountsPassword: "", demoRoutesPassword: "", demoRoutesOrg: "", demoRoutesUntil: "" });
  const database = await createDatabase();
  try {
    // El docente del curso (aqui el demo de seeds.ts, el de las cuentas nuevas) tiene politica
    // propia y dos fuentes en su RAG, una desactivada.
    await database.updateTeacherPolicy("user-teacher-demo", { customInstruction: "Instruccion del curso" });
    const active = await database.createTeacherRagSource({
      teacherUserId: "user-teacher-demo",
      createdByUserId: "user-admin-demo",
      title: "Contratos y Encapsulamiento Aplicado",
      sourceType: "document",
      fileName: "contratos.pdf",
      mimeType: "application/pdf",
      contentText: "Un contrato .h define lo que la clase promete. El .cpp lo implementa sin cambiar la firma.",
      metadata: { courseCode: "FPOO", lotId: "lote-del-curso" },
    });
    // Una fuente base que el docente del curso apago.
    const base = await database.pool.query<{ id: string }>(`select id from rag_sources where scope = 'default' order by id limit 1`);
    const baseOff = base.rows[0]?.id || "";
    assert.ok(baseOff, "hay fuentes base");
    await database.pool.query(
      `insert into rag_source_overrides (teacher_user_id, source_id, is_active, updated_at) values ('user-teacher-demo', $1, false, now())`,
      [baseOff],
    );
    const retired = await database.createTeacherRagSource({
      teacherUserId: "user-teacher-demo",
      createdByUserId: "user-admin-demo",
      title: "Guia repetida",
      sourceType: "document",
      fileName: "guia.pdf",
      mimeType: "application/pdf",
      contentText: "Contenido repetido que el docente retiro.",
      metadata: {},
    });
    await database.deactivateTeacherRagSource(retired.id, "user-teacher-demo");

    env.demoRoutesPassword = PASSWORD;
    env.demoRoutesOrg = "univalle-fpoo-demo";
    const { lines } = await capturingConsole(() => database.syncDemoRouteAccounts(BEFORE_END));
    const summary = lines.find((line) => line.startsWith("[cuentas-demo-rutas] 16 cuentas demo por ruta activas hasta el 2026-11-15"));
    assert.ok(summary, lines.join("\n"));
    assert.match(summary!, /Bitacoras cargadas en este arranque: 4/);
    assert.match(summary!, /Fuentes del RAG copiadas en este arranque: 4\b/);
    assert.ok(!lines.some((line) => line.includes(PASSWORD)), "la clave no sale en el log");
    assert.equal(await database.countActiveDemoRouteAccounts(), 16);

    for (const account of DEMO_ROUTE_ACCOUNTS) {
      assert.equal(await canLogin(database, account.email, PASSWORD), true, `${account.email} entra con la clave`);
    }
    for (const student of STUDENTS) {
      assert.equal(await database.studentLacksCode(student.id), false, `${student.email} no pide el codigo`);
    }
    for (const teacher of TEACHERS) {
      const own = STUDENTS.filter((student) => student.teacherId === teacher.id).map((student) => student.id).sort();
      assert.deepEqual((await database.listActiveStudents(teacher.id)).map((item) => item.id).sort(), own, `${teacher.email} ve solo a sus tres estudiantes`);
      const agenda = await loadLatestBitacoraAgendaItems(database, teacher.id);
      assert.ok(agenda.length >= 16, `${teacher.email} tiene la bitacora de su ruta (${agenda.length} registros)`);
      assert.equal(await ragSourcesOf(database, teacher.id), 1, `${teacher.email}: solo la fuente activa del curso`);
    }
    const realStudents = await database.listActiveStudents("user-teacher-demo");
    assert.ok(!realStudents.some((item) => isDemoRouteAccountId(item.id)), "el grupo del curso no cambia");

    const topics = await Promise.all(TEACHERS.map((teacher) => database.getPilotTopic(teacher.id)));
    assert.deepEqual(topics.map((topic) => topic && [topic.week, topic.repoFullName]), [
      [8, "univalle-fpoo-demo/drogueria-fpoo"],
      [11, "univalle-fpoo-demo/bus-fever-party"],
      [11, "univalle-fpoo-demo/taller-relaciones"],
      [11, "univalle-fpoo-demo/taller-relaciones"],
    ]);

    const copiedChunks = await countRows(
      database,
      `select count(*)::text as count from rag_source_chunks c join rag_sources s on s.id = c.source_id where s.teacher_user_id = $1`,
      ["user-demo-teacher-a"],
    );
    const originalChunks = await countRows(database, `select count(*)::text as count from rag_source_chunks where source_id = $1`, [active.id]);
    assert.ok(originalChunks > 0 && copiedChunks === originalChunks, "la copia lleva los mismos fragmentos");
    const [copyA] = await copiesOf(database, "user-demo-teacher-a");
    assert.equal(copyA.metadata.copiedFromSourceId, active.id);
    assert.equal("lotId" in copyA.metadata, false, "la copia va a la base del docente demo, sin el lote del curso");
    assert.equal(copyA.metadata.courseCode, "FPOO");
    assert.equal(copyA.createdBy, "user-demo-teacher-a");
    const override = await database.pool.query<{ is_active: boolean }>(
      `select is_active from rag_source_overrides where teacher_user_id = 'user-demo-teacher-a' and source_id = $1`,
      [baseOff],
    );
    assert.equal(override.rows[0]?.is_active, false, "la fuente base apagada por el curso queda apagada");
    const originalStill = await countRows(database, `select count(*)::text as count from rag_sources where teacher_user_id = 'user-teacher-demo' and scope = 'teacher'`, []);
    assert.equal(originalStill, 2, "las fuentes del docente del curso no cambian");

    const studentA1 = STUDENTS[0];
    const policy = await database.getTeacherPolicyForUser({ id: studentA1.id, role: "student", email: studentA1.email, displayName: "", teacherUserId: studentA1.teacherId ?? null });
    assert.equal(policy?.teacherUserId, studentA1.teacherId);
    assert.equal(policy?.customInstruction, "Instruccion del curso", "politica copiada del docente del curso");

    const defaultTeacher = await database.getDefaultTeacherChoice();
    assert.ok(!isDemoRouteAccountId(defaultTeacher.teacherUserId), "el docente de las cuentas nuevas no es uno demo");

    // Reinicio: no repite la bitacora ni el RAG, respeta lo que el docente demo cambio y el tema
    // vuelve al de la ruta.
    const teacherB = TEACHERS[1];
    await database.pool.query(`update rag_sources set is_active = false where teacher_user_id = $1`, [teacherB.id]);
    await database.setPilotTopic(teacherB.id, { courseCode: "FPOO", week: 3, title: "Otro", repoFullName: "otro/repo" }, teacherB.id);
    await database.updateTeacherPolicy(teacherB.id, { customInstruction: "Editada por el docente" });
    await database.pool.query(`update users set is_active = false, display_name = 'Otro' where id = $1`, [STUDENTS[3].id]);
    const restart = await capturingConsole(() => database.syncDemoRouteAccounts(BEFORE_END));
    const again = restart.lines.find((line) => line.startsWith("[cuentas-demo-rutas] 16 cuentas"));
    assert.match(again || "", /Bitacoras cargadas en este arranque: 0\. Fuentes del RAG copiadas en este arranque: 0\./, restart.lines.join("\n"));
    for (const teacher of TEACHERS) {
      assert.equal(await bitacorasOf(database, teacher.id), 1, `${teacher.email}: una sola bitacora`);
      assert.equal(await ragSourcesOf(database, teacher.id), 1, `${teacher.email}: el RAG no se duplica`);
    }
    assert.equal((await database.getPilotTopic(teacherB.id))?.repoFullName, "univalle-fpoo-demo/bus-fever-party", "el tema vuelve al de la ruta");
    const keptPolicy = await database.getTeacherPolicyForUser({ id: STUDENTS[3].id, role: "student", email: "", displayName: "", teacherUserId: teacherB.id });
    assert.equal(keptPolicy?.customInstruction, "Editada por el docente", "la politica no se pisa al reiniciar");
    assert.equal(await database.countActiveDemoRouteAccounts(), 16, "la cuenta desactivada vuelve");

    // Sin bitacora (el docente la borro): el arranque siguiente la vuelve a cargar.
    await database.pool.query(`delete from project_document_classifications where user_id = $1`, [teacherB.id]);
    await capturingConsole(() => database.syncDemoRouteAccounts(BEFORE_END));
    assert.equal(await bitacorasOf(database, teacherB.id), 1);

    // Copia cortada a mitad (A sin su copia) y una fuente nueva del curso: el arranque siguiente
    // completa lo que falta. C subio una fuente propia: su RAG ya es suyo y no recibe copias.
    await database.pool.query(`delete from rag_sources where teacher_user_id = 'user-demo-teacher-a'`);
    await database.createTeacherRagSource({
      teacherUserId: TEACHERS[2].id,
      createdByUserId: TEACHERS[2].id,
      title: "Fuente propia del docente demo C",
      sourceType: "document",
      fileName: "propia.txt",
      mimeType: "text/plain",
      contentText: "Material que subio el docente demo.",
      metadata: {},
    });
    await database.createTeacherRagSource({
      teacherUserId: "user-teacher-demo",
      createdByUserId: "user-admin-demo",
      title: "Fuente nueva del curso",
      sourceType: "document",
      fileName: "nueva.txt",
      mimeType: "text/plain",
      contentText: "Agregacion: la fila agrupa pasajeros que no le pertenecen.",
      metadata: {},
    });
    const completed = await capturingConsole(() => database.syncDemoRouteAccounts(BEFORE_END));
    assert.match(completed.lines.join("\n"), /Fuentes del RAG copiadas en este arranque: 4\./, "A: 2; B y D: 1; C: 0");
    assert.equal(await ragSourcesOf(database, "user-demo-teacher-a"), 2);
    assert.equal(await ragSourcesOf(database, teacherB.id), 2, "B conserva la apagada y recibe la nueva");
    assert.equal((await copiesOf(database, teacherB.id)).filter((copy) => !copy.isActive).length, 1, "la que B apago no vuelve");
    assert.equal(await ragSourcesOf(database, TEACHERS[2].id), 2, "C: su copia y su fuente propia, nada mas");
    assert.equal(await ragSourcesOf(database, TEACHERS[3].id), 2);
  } finally {
    Object.assign(env, saved);
    await database.close();
  }
});

test("cuentas demo por ruta: vencidas, con clave corta o sin la variable se desactivan", async () => {
  const saved = saveEnv();
  Object.assign(env, { seedDemoAccounts: true, testAccountsPassword: "", demoRoutesPassword: PASSWORD, demoRoutesOrg: "", demoRoutesUntil: "2026-11-06" });
  const database = await createDatabase();
  try {
    // createDatabase ya las sembro si hoy es antes del 2026-11-06; la prueba no depende del dia.
    await capturingConsole(() => database.syncDemoRouteAccounts(new Date("2026-11-06T20:00:00-05:00")));
    assert.equal(await database.countActiveDemoRouteAccounts(), 16);
    const session = await database.authenticateUser(STUDENTS[0].email, PASSWORD, { kind: "browser" });
    assert.ok(session);
    await database.pool.query(
      `insert into github_user_tokens (id, user_id, account_login, access_token) values ('tok-demo', $1, 'vbucheli', 'gho_x')`,
      [STUDENTS[0].id],
    );

    const expired = await capturingConsole(() => database.syncDemoRouteAccounts(new Date("2026-11-07T08:00:00-05:00")));
    assert.ok(expired.lines.some((line) => line.includes("Vencieron el 2026-11-06")), expired.lines.join("\n"));
    assert.ok(expired.lines.some((line) => line.startsWith("[cuentas-demo-rutas] Cuentas demo por ruta desactivadas al arrancar")));
    assert.equal(await database.countActiveDemoRouteAccounts(), 0);
    assert.equal(await canLogin(database, STUDENTS[0].email, PASSWORD), false);
    const sessions = await database.pool.query<{ is_active: boolean }>(`select is_active from app_sessions where user_id = $1`, [STUDENTS[0].id]);
    assert.ok(sessions.rows.length > 0 && sessions.rows.every((row) => !row.is_active), "sus sesiones se cierran");
    const tokens = await countRows(database, `select count(*)::text as count from github_user_tokens where user_id = $1`, [STUDENTS[0].id]);
    assert.equal(tokens, 0, "se borra el GitHub que se le conecto");

    env.demoRoutesUntil = "2026-11-20";
    await capturingConsole(() => database.syncDemoRouteAccounts(new Date("2026-11-07T08:00:00-05:00")));
    assert.equal(await database.countActiveDemoRouteAccounts(), 16, "con otra fecha vuelven");

    env.demoRoutesPassword = "corta";
    const short = await capturingConsole(() => database.syncDemoRouteAccounts(BEFORE_END));
    assert.ok(short.lines.some((line) => line.includes("menos de 12 caracteres")));
    assert.equal(await database.countActiveDemoRouteAccounts(), 0);

    env.demoRoutesPassword = PASSWORD;
    await capturingConsole(() => database.syncDemoRouteAccounts(BEFORE_END));
    env.demoRoutesPassword = "";
    await capturingConsole(() => database.syncDemoRouteAccounts(BEFORE_END));
    assert.equal(await database.countActiveDemoRouteAccounts(), 0, "sin la variable se desactivan");
  } finally {
    Object.assign(env, saved);
    await database.close();
  }
});

test("cuentas demo por ruta: /api/health dice cuantas hay activas y hasta cuando", async () => {
  const saved = saveEnv();
  Object.assign(env, { seedDemoAccounts: true, testAccountsPassword: "", demoRoutesPassword: "", demoRoutesOrg: "", demoRoutesUntil: "" });
  const database = await createDatabase();
  const { server, baseUrl } = await startHealthServer(database);
  try {
    const read = async () => {
      const response = await fetch(`${baseUrl}/api/health`);
      assert.equal(response.status, 200);
      return await response.json() as { demo_route_accounts_active: number; demo_route_accounts_until: string | null };
    };
    assert.deepEqual(await read().then((health) => [health.demo_route_accounts_active, health.demo_route_accounts_until]), [0, null]);
    Object.assign(env, { demoRoutesPassword: PASSWORD, demoRoutesUntil: "2026-11-06" });
    await capturingConsole(() => database.syncDemoRouteAccounts(BEFORE_END));
    assert.deepEqual(await read().then((health) => [health.demo_route_accounts_active, health.demo_route_accounts_until]), [16, "2026-11-06"]);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    Object.assign(env, saved);
    await database.close();
  }
});

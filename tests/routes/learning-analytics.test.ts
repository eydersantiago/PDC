import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import type { Server } from "node:http";
import { createApp } from "../../src/app.js";
import { env } from "../../src/config/env.js";
import { createDatabase, type AppDatabase } from "../../src/db/database.js";
import {
  PSEUDONYM_LOOKUPS_PER_HOUR,
  planWorkshopSnapshots,
  snapshotFingerprint,
  snapshotTime,
  spreadsheetSafeText,
  studentPseudonym,
  syncAnalyticsExclusions,
} from "../../src/services/learning-analytics.js";
import { actorAnonId, actorFromSession, pseudonymize } from "../../src/services/telemetry.js";
import type { ProgressReport } from "../../src/services/workshop-progress.js";

/**
 * Analitica de aprendizaje (29-10-2026): la historia del avance va con el seudonimo de la
 * telemetria (nunca login, nombre ni codigo estudiantil) y la reidentificacion solo pasa dentro de
 * ADACEEN, de a un codigo, registrada y con tope por hora. Las cuentas de muestra (demo, prueba) no
 * exportan ni reidentifican: aqui el docente y el administrador son cuentas reales creadas por la prueba.
 */

type Json = Record<string, any>;
type Pool = { query: (sql: string, params?: unknown[]) => Promise<{ rows: Json[] }> };

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
  return { status: response.status, data, text, headers: response.headers };
}

async function sessionOf(database: AppDatabase, email: string, password: string) {
  const session = await database.authenticateUser(email, password);
  assert.ok(session, `sesion de ${email}`);
  return session.id;
}

function poolOf(database: AppDatabase) {
  return (database as unknown as { pool: Pool }).pool;
}

const POINTS = [
  { id: "cliente-clase", hu: "HU-1", texto: "Clase Cliente", peso: 10 },
  { id: "retirar", hu: "HU-3", texto: "retirarDinero en Cuenta", peso: 50 },
  { id: "compila", hu: "Programa", texto: "Compila sin errores", peso: 40 },
];

function report(generatedAt: string, students: Json[]) {
  return { taller: "sistema-bancario-fpoo", titulo: "Sistema bancario", generatedAt, points: POINTS, students };
}

const PASSWORD = "Temporal-12345";
let tagCounter = 0;

/** Un docente y un administrador reales (no de muestra), con sesion. */
async function realStaff(database: AppDatabase) {
  const tag = `${process.pid}-${++tagCounter}`;
  const teacher = await database.createManagedUser({ role: "teacher", email: `profe.${tag}@docentes.invalid`, displayName: "Profe Real", password: PASSWORD });
  const admin = await database.createManagedUser({ role: "teacher", email: `admin.${tag}@docentes.invalid`, displayName: "Admin Real", password: PASSWORD });
  await poolOf(database).query("update users set role_id = 'role-admin' where id = $1", [admin.id]);
  return {
    tag,
    teacher,
    admin,
    teacherSession: await sessionOf(database, teacher.email, PASSWORD),
    adminSession: await sessionOf(database, admin.email, PASSWORD),
  };
}

async function student(database: AppDatabase, name: string, email: string, teacherUserId: string, login?: string) {
  const user = await database.createManagedUser({ role: "student", email, displayName: name, password: PASSWORD, teacherUserId });
  if (login) await database.upsertGithubUserToken({ userId: user.id, accountLogin: login, accessToken: `gho_${login}` });
  return user;
}

const ANA_1 = { login: "ana-gh", started: true, percent: 10, compiles: false, done: ["cliente-clase"], partial: [], missing: ["retirar", "compila"], files: 2, lastChangeAt: "2026-10-29T22:50:00.000Z" };
const DANI_1 = { login: "dani-gh", started: true, percent: 50, compiles: true, done: ["compila"], partial: ["retirar"], missing: ["cliente-clase"], files: 4, lastChangeAt: "2026-10-29T22:40:00.000Z" };
const NO_CHANGE = { saved: 0, unchanged: 0, unlinked: 0, sample: 0, stale: 0, ambiguous: 0 };

test("analitica: la historia del avance guarda solo lo que cambia, con el seudonimo de la telemetria y sin datos personales", async () => {
  const original = env.workspaceAgentToken;
  env.workspaceAgentToken = "token-del-agente-de-prueba";
  const { server, database, baseUrl } = await startServer();
  try {
    const agent = { "x-agent-token": env.workspaceAgentToken };
    const staff = await realStaff(database);
    const otroDocente = await database.createManagedUser({ role: "teacher", email: `otro.${staff.tag}@docentes.invalid`, displayName: "Otro Docente", password: PASSWORD });
    const ana = await student(database, "Ana Avanza", `ana.${staff.tag}@estudiantes.invalid`, staff.teacher.id, "Ana-GH");
    const dani = await student(database, "Dani OtroGrupo", `dani.${staff.tag}@estudiantes.invalid`, otroDocente.id, "dani-gh");
    // La cuenta demo de estudiante es de muestra: no entra a la historia.
    await database.upsertGithubUserToken({ userId: "user-student-demo", accountLogin: "demo-gh", accessToken: "gho_demo" });

    const first = await call(baseUrl, "POST", "/api/workspaces/progress-report", {
      headers: agent,
      body: report("2026-10-29T23:00:00.000Z", [ANA_1, DANI_1, { ...ANA_1, login: "demo-gh" }, { ...ANA_1, login: "sin-cuenta" }]),
    });
    assert.equal(first.status, 200, JSON.stringify(first.data));
    assert.deepEqual(first.data.history, { ...NO_CHANGE, saved: 2, unlinked: 1, sample: 1 });

    // El mismo informe 10 minutos despues no agrega fotos; Ana avanza y Dani queda con nota (reusado).
    const same = await call(baseUrl, "POST", "/api/workspaces/progress-report", { headers: agent, body: report("2026-10-29T23:10:00.000Z", [ANA_1, DANI_1]) });
    assert.deepEqual(same.data.history, { ...NO_CHANGE, unchanged: 2 });
    const ana2 = { ...ANA_1, percent: 60, compiles: true, done: ["cliente-clase", "compila"], missing: ["retirar"], lastChangeAt: "2026-10-29T23:15:00.000Z" };
    const moved = await call(baseUrl, "POST", "/api/workspaces/progress-report", {
      headers: agent,
      body: report("2026-10-29T23:20:00.000Z", [ana2, { ...DANI_1, percent: 0, note: "error" }]),
    });
    assert.deepEqual(moved.data.history, { ...NO_CHANGE, saved: 1, stale: 1 });

    const demoAdmin = await sessionOf(database, "admin@adaceen.edu.co", "Admin123!");
    const studentSession = await sessionOf(database, "estudiante@adaceen.edu.co", "Estudiante123!");
    const route = "/api/analytics/workshop-progress/export?taller=sistema-bancario-fpoo";
    assert.equal((await call(baseUrl, "GET", route)).status, 401);
    assert.equal((await call(baseUrl, "GET", route, { sessionId: studentSession })).status, 403);
    assert.equal((await call(baseUrl, "GET", route, { sessionId: demoAdmin })).status, 403, "una cuenta de muestra no exporta");
    for (const bad of ["ayer", "1", "2026-13-45"]) {
      assert.equal((await call(baseUrl, "GET", `${route}&since=${bad}`, { sessionId: staff.adminSession })).status, 400, bad);
    }
    assert.equal((await call(baseUrl, "GET", `${route}&since=2026-10-29&until=2026-10-30T23:59`, { sessionId: staff.adminSession })).status, 200);
    assert.equal((await call(baseUrl, "GET", "/api/analytics/workshop-progress/export?taller=taller_1.v2", { sessionId: staff.adminSession })).status, 200, "el mismo nombre de taller que acepta la VM");

    const all = await call(baseUrl, "GET", route, { sessionId: staff.adminSession });
    assert.equal(all.status, 200);
    assert.match(all.headers.get("content-type") || "", /text\/csv/);
    const lines = all.text.trim().split("\n");
    assert.equal(lines[0], "captured_at,fecha,hora,taller,actor_anon_id,teacher_anon_id,started,percent,compiles,done_count,partial_count,missing_count,done,partial,missing,files,outside,last_change_at");
    assert.equal(lines.length, 4, "Ana dos veces y Dani una");
    const anaCode = studentPseudonym(ana.id);
    // El mismo seudonimo que la telemetria de Ana (actorAnonId de su sesion).
    assert.equal(anaCode, actorAnonId(actorFromSession({ user: { ...ana, teacherUserId: staff.teacher.id } as any })));
    // Mismo instante para varios: el orden entre ellos depende del seudonimo, asi que se busca por codigo.
    const anaLines = lines.filter((line) => line.includes(anaCode));
    assert.equal(anaLines.length, 2);
    assert.ok(anaLines[0].includes(",2026-10-29,18:00,") && anaLines[0].includes(",10,false,"), anaLines[0]);
    assert.ok(anaLines[1].includes(",60,true,2,0,1,cliente-clase|compila,,retirar,"), anaLines[1]);
    for (const secret of ["Ana", "ana.", "ana-gh", "Ana-GH", "dani-gh", "Dani", "gho_", ana.id, dani.id]) {
      assert.equal(all.text.includes(secret), false, `el exporte no lleva ${secret}`);
    }

    // El docente solo exporta a su grupo.
    const mine = await call(baseUrl, "GET", route, { sessionId: staff.teacherSession });
    assert.equal(mine.text.includes(studentPseudonym(dani.id)), false);
    assert.equal(mine.text.trim().split("\n").length, 3);
    assert.ok(mine.text.includes(pseudonymize(`user:${staff.teacher.id}`)));

    const points = await call(baseUrl, "GET", `${route}&layout=puntos`, { sessionId: staff.adminSession });
    const pointLines = points.text.trim().split("\n");
    assert.equal(pointLines[0], "captured_at,fecha,hora,taller,actor_anon_id,teacher_anon_id,punto,estado");
    assert.equal(pointLines.length, 1 + 9, "3 fotos x 3 puntos");
    assert.ok(pointLines.some((line) => line.includes(anaCode) && line.endsWith(",retirar,falta")));
    const defs = await call(baseUrl, "GET", `${route}&layout=definiciones`, { sessionId: staff.teacherSession });
    assert.equal(defs.text.trim().split("\n")[1], "sistema-bancario-fpoo,cliente-clase,HU-1,Clase Cliente,10");

    // Las cuentas de muestra quedan fuera de las vistas (la tabla la llena el arranque).
    const excluded = await poolOf(database).query("select actor_anon_id from analytics_excluded_actors");
    assert.ok(excluded.rows.some((row) => row.actor_anon_id === pseudonymize("user:user-student-demo")));
    assert.equal(excluded.rows.some((row) => row.actor_anon_id === anaCode), false);
  } finally {
    env.workspaceAgentToken = original;
    await stopServer(server, database);
  }
});

test("analitica: «¿Quien es este codigo?» va en los dos sentidos, de a uno, dentro del alcance, registrado y con tope", async () => {
  const { server, database, baseUrl } = await startServer();
  try {
    const pool = poolOf(database);
    const staff = await realStaff(database);
    const otroDocente = await database.createManagedUser({ role: "teacher", email: `otro.${staff.tag}@docentes.invalid`, displayName: "Otro Docente", password: PASSWORD });
    const ana = await student(database, "Ana Avanza", `ana.${staff.tag}@estudiantes.invalid`, staff.teacher.id);
    const dani = await student(database, "Dani OtroGrupo", `dani.${staff.tag}@estudiantes.invalid`, otroDocente.id);
    const vieja = await student(database, "Ana (Gmail)", `ana.vieja.${staff.tag}@correo.invalid`, staff.teacher.id);
    await pool.query("insert into student_codes (code, user_id) values ($1, $2)", ["2312345", ana.id]);
    await pool.query("insert into student_codes (code, user_id) values ($1, $2)", ["2398765", dani.id]);
    // Una cuenta unida a otra: su telemetria vieja sigue con su seudonimo y se ve el codigo de la que prevalece.
    await pool.query("update users set merged_into_user_id = $2, is_active = false where id = $1", [vieja.id, ana.id]);

    const demoAdmin = await sessionOf(database, "admin@adaceen.edu.co", "Admin123!");
    const demoTeacher = await sessionOf(database, "docente@adaceen.edu.co", "Docente123!");
    const studentSession = await sessionOf(database, "estudiante@adaceen.edu.co", "Estudiante123!");
    const resolve = (sessionId: string | undefined, code: unknown) => call(baseUrl, "POST", "/api/admin/pseudonyms/resolve", { sessionId, body: { code } });
    const anaCode = studentPseudonym(ana.id);

    assert.equal((await resolve(undefined, anaCode)).status, 401);
    assert.equal((await resolve(studentSession, anaCode)).status, 403);
    assert.equal((await resolve(demoAdmin, anaCode)).status, 403, "el administrador demo (clave conocida) no reidentifica");
    assert.equal((await resolve(demoTeacher, anaCode)).status, 403, "ni el docente demo");
    assert.equal((await resolve(staff.adminSession, "no-es-un-codigo")).status, 400);

    // Codigo del analisis -> nombre y codigo estudiantil (para el SIRA).
    const found = await resolve(staff.adminSession, anaCode.toUpperCase());
    assert.equal(found.status, 200, JSON.stringify(found.data));
    assert.equal(found.headers.get("cache-control"), "no-store");
    assert.equal(found.data.direction, "codigo");
    assert.deepEqual(found.data.student, { displayName: "Ana Avanza", studentCode: "2312345", mergedIntoDisplayName: null, sample: false });
    const merged = await resolve(staff.teacherSession, studentPseudonym(vieja.id));
    assert.deepEqual(merged.data.student, { displayName: "Ana (Gmail)", studentCode: "2312345", mergedIntoDisplayName: "Ana Avanza", sample: false });

    // Codigo estudiantil -> codigo del analisis (y el de sus cuentas unidas).
    const reverse = await resolve(staff.teacherSession, "2312345");
    assert.equal(reverse.data.direction, "estudiante");
    assert.deepEqual(reverse.data.student, { displayName: "Ana Avanza", analysisCode: anaCode, mergedCodes: [studentPseudonym(vieja.id)] });

    // El docente no reidentifica a otro grupo (no confirma que exista), en ningun sentido; el administrador si.
    for (const code of [studentPseudonym(dani.id), "2398765"]) {
      const outside = await resolve(staff.teacherSession, code);
      assert.equal(outside.status, 200);
      assert.equal(outside.data.found, false);
      assert.equal(JSON.stringify(outside.data).includes("Dani"), false);
    }
    assert.equal((await resolve(staff.adminSession, studentPseudonym(dani.id))).data.student.displayName, "Dani OtroGrupo");

    // Cada consulta valida queda registrada, con el seudonimo y sin el nombre ni el codigo estudiantil.
    const log = await pool.query("select direction, code, found, outcome from pseudonym_lookups order by created_at asc");
    assert.deepEqual(log.rows.map((row) => [row.direction, row.found, row.outcome]), [
      ["codigo", true, "encontrado"], ["codigo", true, "encontrado"], ["estudiante", true, "encontrado"],
      ["codigo", false, "no-encontrado"], ["estudiante", false, "no-encontrado"], ["codigo", true, "encontrado"],
    ]);
    assert.equal(log.rows[2].code, anaCode, "el sentido inverso guarda el seudonimo encontrado");
    assert.equal(JSON.stringify(log.rows).includes("Ana") || JSON.stringify(log.rows).includes("2312345"), false);

    // El detalle de «Estudiantes» ya no trae el codigo: con la lista armaria la tabla completa.
    const detail = await call(baseUrl, "GET", `/api/admin/students/${ana.id}`, { sessionId: staff.adminSession });
    assert.equal(detail.status, 200, JSON.stringify(detail.data));
    assert.equal("analysisCode" in detail.data, false);
    assert.equal(detail.text.includes(anaCode), false);

    // Tope por hora: lo rechazado por el tope queda anotado y no cuenta.
    for (let index = 0; index < PSEUDONYM_LOOKUPS_PER_HOUR; index += 1) {
      await pool.query("insert into pseudonym_lookups (id, viewer_user_id, code, found, outcome) values ($1, $2, $3, false, 'no-encontrado')", [`relleno-${index}`, staff.teacher.id, "0".repeat(20)]);
    }
    const limited = await resolve(staff.teacherSession, anaCode);
    assert.equal(limited.status, 429);
    assert.ok(limited.headers.get("retry-after"));
    const topes = await pool.query("select count(*) as total from pseudonym_lookups where viewer_user_id = $1 and outcome = 'tope'", [staff.teacher.id]);
    assert.equal(Number(topes.rows[0].total), 1);

    // En paralelo tampoco pasa del tope (se anota antes de contar).
    const fresh = await realStaff(database);
    await pool.query("update users set teacher_user_id = $2 where id = $1", [dani.id, fresh.teacher.id]);
    const burst = await Promise.all(Array.from({ length: PSEUDONYM_LOOKUPS_PER_HOUR + 10 }, () => resolve(fresh.teacherSession, studentPseudonym(dani.id))));
    const answered = burst.filter((reply) => reply.status === 200).length;
    assert.ok(answered <= PSEUDONYM_LOOKUPS_PER_HOUR, `respondio ${answered}`);
    assert.ok(burst.filter((reply) => reply.status === 429).length >= 10);
  } finally {
    await stopServer(server, database);
  }
});

test("analitica: la huella, lo reusado, el login ambiguo, la hora de la foto y las celdas de Excel", () => {
  const entry = { started: true, percent: 40, compiles: true, done: ["b", "a"], partial: [], missing: ["c"], files: 3, outside: 0, lastChangeAt: null };
  assert.equal(snapshotFingerprint(entry), snapshotFingerprint({ ...entry, done: ["a", "b"] }));
  assert.notEqual(snapshotFingerprint(entry), snapshotFingerprint({ ...entry, percent: 41 }));
  const base = { taller: "t", titulo: "", generatedAt: "2026-10-29T23:00:00.000Z", receivedAt: "2026-10-29T23:00:01.000Z", points: [{ id: "a", hu: "", texto: "", peso: 1 }] };
  const identities = [{ userId: "u1", teacherUserId: null, githubLogin: "x" }];
  const reused = planWorkshopSnapshots({ ...base, students: [{ login: "x", ...entry, note: "pendiente" }] } as ProgressReport, identities, new Map());
  assert.equal(reused.snapshots.length, 0);
  assert.equal(reused.stale, 1);
  const fresh = planWorkshopSnapshots({ ...base, students: [{ login: "X", ...entry }] } as ProgressReport, identities, new Map());
  assert.equal(fresh.snapshots.length, 1, "el login se compara sin mayusculas");
  assert.equal(fresh.snapshots[0].teacherAnonId, "", "sin docente, sin seudonimo de docente");
  assert.equal(fresh.snapshots[0].capturedAt, "2026-10-29T23:00:00.000Z", "la hora del calculo en la VM");
  // El mismo login en dos cuentas distintas: no se adivina (antes podia alternar entre las dos).
  const twice = planWorkshopSnapshots({ ...base, students: [{ login: "x", ...entry }] } as ProgressReport, [...identities, { userId: "u2", teacherUserId: null, githubLogin: "x" }], new Map());
  assert.equal(twice.snapshots.length, 0);
  assert.equal(twice.ambiguous, 1);
  // Una cuenta unida y la que prevalece llegan con el mismo id: no es ambiguo.
  const mergedTwice = planWorkshopSnapshots({ ...base, students: [{ login: "x", ...entry }] } as ProgressReport, [...identities, { userId: "u1", teacherUserId: null, githubLogin: "x" }], new Map());
  assert.equal(mergedTwice.snapshots.length, 1);
  // Un reloj malo en la VM no esconde ni eterniza filas: vale la hora de llegada.
  assert.equal(snapshotTime("2027-01-01T00:00:00.000Z", "2026-10-29T23:00:00.000Z"), "2026-10-29T23:00:00.000Z");
  assert.equal(snapshotTime("2026-10-20T00:00:00.000Z", "2026-10-29T23:00:00.000Z"), "2026-10-29T23:00:00.000Z");
  assert.equal(snapshotTime("2026-10-29T22:58:00.000Z", "2026-10-29T23:00:00.000Z"), "2026-10-29T22:58:00.000Z");
  // Texto que Excel tomaria como formula.
  assert.equal(spreadsheetSafeText("=HYPERLINK(\"x\")"), "'=HYPERLINK(\"x\")");
  assert.equal(spreadsheetSafeText("@SUM(1)"), "'@SUM(1)");
  assert.equal(spreadsheetSafeText("Clase Cliente"), "Clase Cliente");
});

test("analitica: telemetria:exportar --con-avance deja los tres CSV del avance desde el backend (sin acceso a la base)", async () => {
  const original = env.workspaceAgentToken;
  env.workspaceAgentToken = "token-del-agente-de-prueba";
  const { server, database, baseUrl } = await startServer();
  const folder = mkdtempSync(path.join(tmpdir(), "adaceen-avance-"));
  try {
    const staff = await realStaff(database);
    const ana = await student(database, "Ana Avanza", `ana.${staff.tag}@estudiantes.invalid`, staff.teacher.id, `ana-${staff.tag}`);
    const sent = await call(baseUrl, "POST", "/api/workspaces/progress-report", { headers: { "x-agent-token": env.workspaceAgentToken }, body: report("2026-10-29T23:00:00.000Z", [{ ...ANA_1, login: `ana-${staff.tag}` }]) });
    assert.equal(sent.data.history.saved, 1);

    const output = path.join(folder, "telemetria.csv");
    const result = await new Promise<{ code: number; text: string }>((resolve) => {
      execFile(process.execPath, [
        "--import", "tsx", "scripts/exportar-telemetria.ts",
        `--url=${baseUrl}`, `--email=${staff.admin.email}`, `--password=${PASSWORD}`, "--formato=csv", `--salida=${output}`, "--con-avance",
      ], { env: { ...process.env, DATABASE_URL: "" }, timeout: 60_000 }, (error, stdout, stderr) => {
        resolve({ code: error ? Number((error as NodeJS.ErrnoException).code) || 1 : 0, text: `${stdout}${stderr}` });
      });
    });
    assert.equal(result.code, 0, result.text);
    const fotos = readFileSync(path.join(folder, "telemetria-avance.csv"), "utf8");
    assert.ok(fotos.startsWith("captured_at,fecha,hora,taller,actor_anon_id,"), fotos);
    assert.ok(fotos.includes(studentPseudonym(ana.id)));
    assert.equal(fotos.includes(`ana-${staff.tag}`) || fotos.includes("Ana"), false);
    const puntos = readFileSync(path.join(folder, "telemetria-avance-puntos.csv"), "utf8");
    assert.equal(puntos.trim().split("\n").filter((line) => line.includes(studentPseudonym(ana.id))).length, 3);
    const definiciones = readFileSync(path.join(folder, "telemetria-avance-definiciones.csv"), "utf8");
    assert.ok(definiciones.includes("sistema-bancario-fpoo,retirar,HU-3,retirarDinero en Cuenta,50"), definiciones);
  } finally {
    env.workspaceAgentToken = original;
    rmSync(folder, { recursive: true, force: true });
    await stopServer(server, database);
  }
});

test("analitica: el retiro de un participante borra su historia del avance y las consultas de su codigo", async () => {
  const { withdrawParticipant } = await import("../../scripts/lib/retiro.js");
  const original = env.workspaceAgentToken;
  env.workspaceAgentToken = "token-del-agente-de-prueba";
  const { server, database, baseUrl } = await startServer();
  try {
    const pool = poolOf(database);
    const staff = await realStaff(database);
    const anaEmail = `ana.retiro.${staff.tag}@estudiantes.invalid`;
    const ana = await student(database, "Ana Se Retira", anaEmail, staff.teacher.id, `ana-retiro-${staff.tag}`);
    const beto = await student(database, "Beto Sigue", `beto.${staff.tag}@estudiantes.invalid`, staff.teacher.id, `beto-${staff.tag}`);
    await call(baseUrl, "POST", "/api/workspaces/progress-report", {
      headers: { "x-agent-token": env.workspaceAgentToken },
      body: report("2026-10-29T23:00:00.000Z", [{ ...ANA_1, login: `ana-retiro-${staff.tag}` }, { ...ANA_1, login: `beto-${staff.tag}` }]),
    });
    const lookup = await call(baseUrl, "POST", "/api/admin/pseudonyms/resolve", { sessionId: staff.adminSession, body: { code: studentPseudonym(ana.id) } });
    assert.equal(lookup.data.found, true);

    const count = async (sql: string, code: string) => Number((await pool.query(sql, [code])).rows[0]?.total || 0);
    const anaCode = studentPseudonym(ana.id);
    const dryRun = await withdrawParticipant(pool as any, { email: anaEmail, confirm: false, salt: "sal-de-prueba" });
    assert.equal(dryRun.counts.workshop_progress_snapshots, 1);
    assert.equal(dryRun.counts.workshop_progress_last, 1);
    assert.equal(dryRun.counts.pseudonym_lookups, 1);
    await withdrawParticipant(pool as any, { email: anaEmail, confirm: true, salt: "sal-de-prueba" });
    assert.equal(await count("select count(*) as total from workshop_progress_snapshots where actor_anon_id = $1", anaCode), 0);
    assert.equal(await count("select count(*) as total from workshop_progress_last where actor_anon_id = $1", anaCode), 0);
    assert.equal(await count("select count(*) as total from pseudonym_lookups where code = $1", anaCode), 0);
    assert.equal(await count("select count(*) as total from workshop_progress_snapshots where actor_anon_id = $1", studentPseudonym(beto.id)), 1, "el resto del grupo sigue");
  } finally {
    env.workspaceAgentToken = original;
    await stopServer(server, database);
  }
});

test("analitica: las cuentas del equipo anotadas en ANALYTICS_EXCLUDE_EMAILS salen del analisis", async () => {
  const original = env.workspaceAgentToken;
  env.workspaceAgentToken = "token-del-agente-de-prueba";
  const { server, database, baseUrl } = await startServer();
  try {
    const staff = await realStaff(database);
    const e1Email = `e1.${staff.tag}@equipo.invalid`;
    const e1 = await student(database, "E1 del equipo", e1Email, staff.teacher.id, `e1-${staff.tag}`);
    const ana = await student(database, "Ana Avanza", `ana.${staff.tag}@estudiantes.invalid`, staff.teacher.id, `ana-${staff.tag}`);
    await syncAnalyticsExclusions(database, [e1Email.toUpperCase().toLowerCase()]);
    await call(baseUrl, "POST", "/api/workspaces/progress-report", {
      headers: { "x-agent-token": env.workspaceAgentToken },
      body: report("2026-10-29T23:00:00.000Z", [{ ...ANA_1, login: `e1-${staff.tag}` }, { ...ANA_1, login: `ana-${staff.tag}` }]),
    });
    const csv = (await call(baseUrl, "GET", "/api/analytics/workshop-progress/export", { sessionId: staff.adminSession })).text;
    assert.equal(csv.includes(studentPseudonym(e1.id)), false, "la cuenta del equipo no sale");
    assert.ok(csv.includes(studentPseudonym(ana.id)));
    const rows = await poolOf(database).query("select reason from analytics_excluded_actors where actor_anon_id = $1", [studentPseudonym(e1.id)]);
    assert.deepEqual(rows.rows.map((row) => row.reason), ["plan"]);
    // Sin la lista, vuelve al analisis (y las de muestra siguen fuera).
    await syncAnalyticsExclusions(database, []);
    assert.equal(Number((await poolOf(database).query("select count(*) as total from analytics_excluded_actors where reason = 'plan'")).rows[0].total), 0);
    assert.ok(Number((await poolOf(database).query("select count(*) as total from analytics_excluded_actors where reason = 'muestra'")).rows[0].total) > 0);
  } finally {
    env.workspaceAgentToken = original;
    await stopServer(server, database);
  }
});

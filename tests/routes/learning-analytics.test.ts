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
  studentPseudonym,
} from "../../src/services/learning-analytics.js";
import { actorAnonId, actorFromSession, pseudonymize } from "../../src/services/telemetry.js";
import type { ProgressReport } from "../../src/services/workshop-progress.js";

/**
 * Analitica de aprendizaje (29-10-2026): la historia del avance va con el seudonimo de la
 * telemetria (nunca login, nombre ni codigo estudiantil) y la reidentificacion solo pasa dentro de
 * ADACEEN, de a un codigo, registrada y con tope por hora.
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

const ANA_1 = { login: "ana-gh", started: true, percent: 10, compiles: false, done: ["cliente-clase"], partial: [], missing: ["retirar", "compila"], files: 2, lastChangeAt: "2026-10-29T22:50:00.000Z" };
const DANI_1 = { login: "dani-gh", started: true, percent: 50, compiles: true, done: ["compila"], partial: ["retirar"], missing: ["cliente-clase"], files: 4, lastChangeAt: "2026-10-29T22:40:00.000Z" };

test("analitica: la historia del avance guarda solo lo que cambia, con el seudonimo de la telemetria y sin datos personales", async () => {
  const original = env.workspaceAgentToken;
  env.workspaceAgentToken = "token-del-agente-de-prueba";
  const { server, database, baseUrl } = await startServer();
  try {
    const agent = { "x-agent-token": env.workspaceAgentToken };
    const otroDocente = await database.createManagedUser({ role: "teacher", email: "otro.docente@correounivalle.edu.co", displayName: "Otro Docente", password: "Temporal-12345" });
    const ana = await database.createManagedUser({ role: "student", email: "ana@correounivalle.edu.co", displayName: "Ana Avanza", password: "Temporal-12345", teacherUserId: "user-teacher-demo" });
    const dani = await database.createManagedUser({ role: "student", email: "dani@correounivalle.edu.co", displayName: "Dani OtroGrupo", password: "Temporal-12345", teacherUserId: otroDocente.id });
    await database.upsertGithubUserToken({ userId: ana.id, accountLogin: "Ana-GH", accessToken: "gho_a" });
    await database.upsertGithubUserToken({ userId: dani.id, accountLogin: "dani-gh", accessToken: "gho_d" });
    // La cuenta demo de estudiante es de muestra: no entra a la historia.
    await database.upsertGithubUserToken({ userId: "user-student-demo", accountLogin: "demo-gh", accessToken: "gho_demo" });

    const first = await call(baseUrl, "POST", "/api/workspaces/progress-report", {
      headers: agent,
      body: report("2026-10-29T23:00:00.000Z", [
        ANA_1,
        DANI_1,
        { ...ANA_1, login: "demo-gh" },
        { ...ANA_1, login: "sin-cuenta" },
      ]),
    });
    assert.equal(first.status, 200, JSON.stringify(first.data));
    assert.deepEqual(first.data.history, { saved: 2, unchanged: 0, unlinked: 1, sample: 1, stale: 0 });

    // El mismo informe 10 minutos despues no agrega fotos; Ana avanza y Dani queda con nota (reusado).
    const same = await call(baseUrl, "POST", "/api/workspaces/progress-report", { headers: agent, body: report("2026-10-29T23:10:00.000Z", [ANA_1, DANI_1]) });
    assert.deepEqual(same.data.history, { saved: 0, unchanged: 2, unlinked: 0, sample: 0, stale: 0 });
    const ana2 = { ...ANA_1, percent: 60, compiles: true, done: ["cliente-clase", "compila"], missing: ["retirar"], lastChangeAt: "2026-10-29T23:15:00.000Z" };
    const moved = await call(baseUrl, "POST", "/api/workspaces/progress-report", {
      headers: agent,
      body: report("2026-10-29T23:20:00.000Z", [ana2, { ...DANI_1, percent: 0, note: "error" }]),
    });
    assert.deepEqual(moved.data.history, { saved: 1, unchanged: 0, unlinked: 0, sample: 0, stale: 1 });

    const admin = await sessionOf(database, "admin@adaceen.edu.co", "Admin123!");
    const teacher = await sessionOf(database, "docente@adaceen.edu.co", "Docente123!");
    const student = await sessionOf(database, "estudiante@adaceen.edu.co", "Estudiante123!");
    const route = "/api/analytics/workshop-progress/export?taller=sistema-bancario-fpoo";
    assert.equal((await call(baseUrl, "GET", route)).status, 401);
    assert.equal((await call(baseUrl, "GET", route, { sessionId: student })).status, 403);
    assert.equal((await call(baseUrl, "GET", `${route}&since=ayer`, { sessionId: admin })).status, 400);

    const all = await call(baseUrl, "GET", route, { sessionId: admin });
    assert.equal(all.status, 200);
    assert.match(all.headers.get("content-type") || "", /text\/csv/);
    const lines = all.text.trim().split("\n");
    assert.equal(lines[0], "captured_at,fecha,hora,taller,actor_anon_id,teacher_anon_id,started,percent,compiles,done_count,partial_count,missing_count,done,partial,missing,files,outside,last_change_at");
    assert.equal(lines.length, 4, "Ana dos veces y Dani una");
    const anaCode = studentPseudonym(ana.id);
    // El mismo seudonimo que la telemetria de Ana (actorAnonId de su sesion).
    assert.equal(anaCode, actorAnonId(actorFromSession({ user: { ...ana, teacherUserId: "user-teacher-demo" } as any })));
    // Mismo instante para varios: el orden entre ellos depende del seudonimo, asi que se busca por codigo.
    const anaLines = lines.filter((line) => line.includes(anaCode));
    assert.equal(anaLines.length, 2);
    assert.ok(anaLines[0].includes(",2026-10-29,18:00,") && anaLines[0].includes(",10,false,"), anaLines[0]);
    assert.ok(anaLines[1].includes(",60,true,2,0,1,cliente-clase|compila,,retirar,"), anaLines[1]);
    for (const secret of ["Ana", "ana@", "ana-gh", "Ana-GH", "dani-gh", "Dani", "gho_", ana.id, dani.id]) {
      assert.equal(all.text.includes(secret), false, `el exporte no lleva ${secret}`);
    }

    // El docente solo exporta a su grupo.
    const mine = await call(baseUrl, "GET", route, { sessionId: teacher });
    assert.equal(mine.text.includes(studentPseudonym(dani.id)), false);
    assert.equal(mine.text.trim().split("\n").length, 3);
    assert.ok(mine.text.includes(pseudonymize("user:user-teacher-demo")));

    const points = await call(baseUrl, "GET", `${route}&layout=puntos`, { sessionId: admin });
    const pointLines = points.text.trim().split("\n");
    assert.equal(pointLines[0], "captured_at,fecha,hora,taller,actor_anon_id,teacher_anon_id,punto,estado");
    assert.equal(pointLines.length, 1 + 9, "3 fotos x 3 puntos");
    assert.ok(pointLines.some((line) => line.includes(anaCode) && line.endsWith(",retirar,falta")));
    const defs = await call(baseUrl, "GET", `${route}&layout=definiciones`, { sessionId: teacher });
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

test("analitica: «¿Quien es este codigo?» da nombre y codigo estudiantil de a uno, dentro del alcance, registrado y con tope", async () => {
  const { server, database, baseUrl } = await startServer();
  try {
    const pool = poolOf(database);
    const otroDocente = await database.createManagedUser({ role: "teacher", email: "otro.docente2@correounivalle.edu.co", displayName: "Otro Docente", password: "Temporal-12345" });
    const ana = await database.createManagedUser({ role: "student", email: "ana2@correounivalle.edu.co", displayName: "Ana Avanza", password: "Temporal-12345", teacherUserId: "user-teacher-demo" });
    const dani = await database.createManagedUser({ role: "student", email: "dani2@correounivalle.edu.co", displayName: "Dani OtroGrupo", password: "Temporal-12345", teacherUserId: otroDocente.id });
    const vieja = await database.createManagedUser({ role: "student", email: "ana.vieja@gmail.com", displayName: "Ana (Gmail)", password: "Temporal-12345", teacherUserId: "user-teacher-demo" });
    await pool.query("insert into student_codes (code, user_id) values ($1, $2)", ["202312345", ana.id]);
    // Una cuenta unida a otra: su telemetria vieja sigue con su seudonimo y se ve el codigo de la que prevalece.
    await pool.query("update users set merged_into_user_id = $2, is_active = false where id = $1", [vieja.id, ana.id]);

    const admin = await sessionOf(database, "admin@adaceen.edu.co", "Admin123!");
    const teacher = await sessionOf(database, "docente@adaceen.edu.co", "Docente123!");
    const student = await sessionOf(database, "estudiante@adaceen.edu.co", "Estudiante123!");
    const resolve = (sessionId: string | undefined, code: unknown) => call(baseUrl, "POST", "/api/admin/pseudonyms/resolve", { sessionId, body: { code } });

    assert.equal((await resolve(undefined, studentPseudonym(ana.id))).status, 401);
    assert.equal((await resolve(student, studentPseudonym(ana.id))).status, 403);
    assert.equal((await resolve(admin, "no-es-un-codigo")).status, 400);

    const found = await resolve(admin, studentPseudonym(ana.id).toUpperCase());
    assert.equal(found.status, 200, JSON.stringify(found.data));
    assert.equal(found.headers.get("cache-control"), "no-store");
    assert.deepEqual(found.data.student, { displayName: "Ana Avanza", studentCode: "202312345", mergedIntoDisplayName: null, sample: false });

    const merged = await resolve(teacher, studentPseudonym(vieja.id));
    assert.deepEqual(merged.data.student, { displayName: "Ana (Gmail)", studentCode: "202312345", mergedIntoDisplayName: "Ana Avanza", sample: false });

    // El docente no reidentifica a otro grupo (no confirma que el codigo exista); el administrador si.
    const outside = await resolve(teacher, studentPseudonym(dani.id));
    assert.equal(outside.status, 200);
    assert.equal(outside.data.found, false);
    assert.equal(JSON.stringify(outside.data).includes("Dani"), false);
    assert.equal((await resolve(admin, studentPseudonym(dani.id))).data.student.displayName, "Dani OtroGrupo");

    // Cada consulta valida queda registrada, sin el nombre.
    const log = await pool.query("select viewer_user_id, code, found from pseudonym_lookups order by created_at asc");
    assert.equal(log.rows.length, 4);
    assert.deepEqual(log.rows.map((row) => row.found), [true, true, false, true]);
    assert.equal(JSON.stringify(log.rows).includes("Ana"), false);

    // Tope por hora: de a uno, no en bloque.
    for (let index = 0; index < PSEUDONYM_LOOKUPS_PER_HOUR; index += 1) {
      await pool.query("insert into pseudonym_lookups (id, viewer_user_id, code, found) values ($1, $2, $3, false)", [`relleno-${index}`, "user-teacher-demo", "0".repeat(20)]);
    }
    const limited = await resolve(teacher, studentPseudonym(ana.id));
    assert.equal(limited.status, 429);
    assert.ok(limited.headers.get("retry-after"));

    // El detalle de «Estudiantes» trae el codigo del analisis de ese estudiante.
    const detail = await call(baseUrl, "GET", `/api/admin/students/${ana.id}`, { sessionId: admin });
    assert.equal(detail.status, 200, JSON.stringify(detail.data));
    assert.equal(detail.data.analysisCode, studentPseudonym(ana.id));
  } finally {
    await stopServer(server, database);
  }
});

test("analitica: la huella no depende del orden de los puntos y lo reusado no cuenta como medicion", () => {
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
  // Dos cuentas con el mismo login de GitHub: gana la que lo vinculo despues (la ultima de la lista).
  const twice = planWorkshopSnapshots({ ...base, students: [{ login: "x", ...entry }] } as ProgressReport, [...identities, { userId: "u2", teacherUserId: null, githubLogin: "x" }], new Map());
  assert.equal(twice.snapshots.length, 1);
  assert.equal(twice.snapshots[0].actorAnonId, studentPseudonym("u2"));
});

test("analitica: telemetria:exportar --con-avance deja los tres CSV del avance desde el backend (sin acceso a la base)", async () => {
  const original = env.workspaceAgentToken;
  env.workspaceAgentToken = "token-del-agente-de-prueba";
  const { server, database, baseUrl } = await startServer();
  const folder = mkdtempSync(path.join(tmpdir(), "adaceen-avance-"));
  try {
    const ana = await database.createManagedUser({ role: "student", email: "ana3@correounivalle.edu.co", displayName: "Ana Avanza", password: "Temporal-12345", teacherUserId: "user-teacher-demo" });
    await database.upsertGithubUserToken({ userId: ana.id, accountLogin: "ana3-gh", accessToken: "gho_a" });
    const sent = await call(baseUrl, "POST", "/api/workspaces/progress-report", { headers: { "x-agent-token": env.workspaceAgentToken }, body: report("2026-10-29T23:00:00.000Z", [{ ...ANA_1, login: "ana3-gh" }]) });
    assert.equal(sent.data.history.saved, 1);

    const output = path.join(folder, "telemetria.csv");
    const result = await new Promise<{ code: number; text: string }>((resolve) => {
      execFile(process.execPath, [
        "--import", "tsx", "scripts/exportar-telemetria.ts",
        `--url=${baseUrl}`, "--email=admin@adaceen.edu.co", "--password=Admin123!", "--formato=csv", `--salida=${output}`, "--con-avance",
      ], { env: { ...process.env, DATABASE_URL: "" }, timeout: 60_000 }, (error, stdout, stderr) => {
        resolve({ code: error ? Number((error as NodeJS.ErrnoException).code) || 1 : 0, text: `${stdout}${stderr}` });
      });
    });
    assert.equal(result.code, 0, result.text);
    const fotos = readFileSync(path.join(folder, "telemetria-avance.csv"), "utf8");
    assert.ok(fotos.startsWith("captured_at,fecha,hora,taller,actor_anon_id,"), fotos);
    assert.ok(fotos.includes(studentPseudonym(ana.id)));
    assert.equal(fotos.includes("ana3-gh") || fotos.includes("Ana"), false);
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
    const ana = await database.createManagedUser({ role: "student", email: "ana.retiro@correounivalle.edu.co", displayName: "Ana Se Retira", password: "Temporal-12345", teacherUserId: "user-teacher-demo" });
    const beto = await database.createManagedUser({ role: "student", email: "beto.sigue@correounivalle.edu.co", displayName: "Beto Sigue", password: "Temporal-12345", teacherUserId: "user-teacher-demo" });
    await database.upsertGithubUserToken({ userId: ana.id, accountLogin: "ana-retiro", accessToken: "gho_a" });
    await database.upsertGithubUserToken({ userId: beto.id, accountLogin: "beto-sigue", accessToken: "gho_b" });
    await call(baseUrl, "POST", "/api/workspaces/progress-report", {
      headers: { "x-agent-token": env.workspaceAgentToken },
      body: report("2026-10-29T23:00:00.000Z", [{ ...ANA_1, login: "ana-retiro" }, { ...ANA_1, login: "beto-sigue" }]),
    });
    const admin = await sessionOf(database, "admin@adaceen.edu.co", "Admin123!");
    await call(baseUrl, "POST", "/api/admin/pseudonyms/resolve", { sessionId: admin, body: { code: studentPseudonym(ana.id) } });

    const count = async (sql: string, code: string) => Number((await pool.query(sql, [code])).rows[0]?.total || 0);
    const anaCode = studentPseudonym(ana.id);
    const dryRun = await withdrawParticipant(pool as any, { email: "ana.retiro@correounivalle.edu.co", confirm: false, salt: "sal-de-prueba" });
    assert.equal(dryRun.counts.workshop_progress_snapshots, 1);
    assert.equal(dryRun.counts.workshop_progress_last, 1);
    assert.equal(dryRun.counts.pseudonym_lookups, 1);
    await withdrawParticipant(pool as any, { email: "ana.retiro@correounivalle.edu.co", confirm: true, salt: "sal-de-prueba" });
    assert.equal(await count("select count(*) as total from workshop_progress_snapshots where actor_anon_id = $1", anaCode), 0);
    assert.equal(await count("select count(*) as total from workshop_progress_last where actor_anon_id = $1", anaCode), 0);
    assert.equal(await count("select count(*) as total from pseudonym_lookups where code = $1", anaCode), 0);
    assert.equal(await count("select count(*) as total from workshop_progress_snapshots where actor_anon_id = $1", studentPseudonym(beto.id)), 1, "el resto del grupo sigue");
  } finally {
    env.workspaceAgentToken = original;
    await stopServer(server, database);
  }
});

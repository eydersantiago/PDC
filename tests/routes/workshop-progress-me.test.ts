import assert from "node:assert/strict";
import test from "node:test";
import type { Server } from "node:http";
import { createApp } from "../../src/app.js";
import { env } from "../../src/config/env.js";
import { createDatabase, type AppDatabase } from "../../src/db/database.js";

/**
 * GET /api/workshop-progress/me (30-10-2026): VS Code muestra al estudiante su propio avance en el
 * taller (el informe de la VM de editores, cruzado por su login de GitHub). Solo el de quien
 * pregunta; el taller sale del repositorio (?repoFullName=, con ?repo= como alias) sin caer en
 * otro, o sin repositorio del tema del piloto o, si no, del informe mas reciente.
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

const CLIENT = { "x-adaceen-client-id": "vscode-avance-0001" };

const POINTS = Array.from({ length: 10 }, (_, index) => ({ id: `punto-${index + 1}`, hu: `HU-${Math.floor(index / 3) + 1}`, texto: `Punto ${index + 1}`, peso: 10 }));

function progressReport(taller: string, students: Json[], extra: Json = {}) {
  return { taller, titulo: `Taller ${taller}`, generatedAt: new Date().toISOString(), points: POINTS, students, ...extra };
}

test("GET /api/workshop-progress/me: estado, avance propio por repositorio y nunca el de otro", async () => {
  const original = env.workspaceAgentToken;
  env.workspaceAgentToken = "token-del-agente-de-prueba";
  const { server, database, baseUrl } = await startServer();
  try {
    const agent = { "x-agent-token": env.workspaceAgentToken };
    const ana = await database.createManagedUser({ role: "student", email: "ana.prog@correounivalle.edu.co", displayName: "Ana", password: "Temporal-12345", teacherUserId: "user-teacher-demo" });
    const beto = await database.createManagedUser({ role: "student", email: "beto.prog@correounivalle.edu.co", displayName: "Beto", password: "Temporal-12345", teacherUserId: "user-teacher-demo" });
    const carla = await database.createManagedUser({ role: "student", email: "carla.prog@correounivalle.edu.co", displayName: "Carla", password: "Temporal-12345", teacherUserId: "user-teacher-demo" });
    await database.upsertGithubUserToken({ userId: ana.id, accountLogin: "Ana-GH", accessToken: "gho_a" });
    await database.upsertGithubUserToken({ userId: beto.id, accountLogin: "beto-gh", accessToken: "gho_b" });
    const session = async (email: string) => (await database.authenticateUser(email, "Temporal-12345"))!.id;
    const [anaSession, betoSession, carlaSession] = await Promise.all([session(ana.email), session(beto.email), session(carla.email)]);

    const route = "/api/workshop-progress/me";
    assert.equal((await call(baseUrl, "GET", route)).status, 401);
    assert.equal((await call(baseUrl, "GET", route, { headers: CLIENT })).status, 401, "un cliente anonimo no tiene avance");
    assert.equal((await call(baseUrl, "GET", "/api/workspaces/my-progress", { sessionId: anaSession })).status, 404, "la ruta de la 0.0.38 sin publicar ya no existe");
    assert.deepEqual((await call(baseUrl, "GET", route, { sessionId: anaSession })).data, { ok: true, status: "sin-taller", progress: null }, "sin informe");
    assert.deepEqual((await call(baseUrl, "GET", route, { sessionId: carlaSession })).data, { ok: true, status: "sin-editor", progress: null }, "sin GitHub vinculado");

    // Dos talleres: el bancario (antes) y otro (el mas reciente).
    const anaEntry = { login: "ana-gh", started: true, percent: 20, compiles: true, done: ["punto-1", "punto-2"], partial: ["punto-4"], missing: ["punto-3", "punto-5", "punto-6", "punto-7", "punto-8", "punto-9", "punto-10"], files: 3, lastChangeAt: "2026-10-30T14:00:00.000Z" };
    const betoEntry = { login: "beto-gh", started: true, percent: 90, compiles: false, done: POINTS.slice(0, 9).map((point) => point.id), partial: [], missing: ["punto-10"], files: 8, lastChangeAt: null };
    assert.equal((await call(baseUrl, "POST", "/api/workspaces/progress-report", { headers: agent, body: progressReport("sistema-bancario-fpoo", [anaEntry, betoEntry]) })).status, 200);
    assert.equal((await call(baseUrl, "POST", "/api/workspaces/progress-report", { headers: agent, body: progressReport("taller-dos", [{ ...anaEntry, percent: 70, done: POINTS.slice(0, 7).map((point) => point.id), partial: [], missing: ["punto-8", "punto-9", "punto-10"] }]) })).status, 200);

    // Con repoFullName (y el alias repo, y un enlace con /tree/main): el taller de ese repositorio.
    const bank = await call(baseUrl, "GET", `${route}?repoFullName=eydersantiago/sistema-bancario-fpoo`, { sessionId: anaSession });
    assert.equal(bank.status, 200);
    assert.equal(bank.data.status, "en-curso");
    const progress = bank.data.progress;
    assert.deepEqual(Object.keys(progress).sort(), ["compiles", "done", "lastChangeAt", "matchedBy", "partial", "pending", "pendingCount", "percent", "receivedAt", "stale", "taller", "titulo", "total"]);
    assert.equal(progress.taller, "sistema-bancario-fpoo");
    assert.equal(progress.titulo, "Taller sistema-bancario-fpoo");
    assert.equal(progress.percent, 20, "ponderado (lo calcula la VM)");
    assert.equal(progress.compiles, true);
    assert.deepEqual([progress.done, progress.partial, progress.total], [2, 1, 10], "cuentas simples de puntos");
    assert.equal(progress.stale, false);
    assert.equal(progress.lastChangeAt, "2026-10-30T14:00:00.000Z");
    assert.equal(progress.matchedBy, "repo");
    assert.equal(progress.pendingCount, 8);
    assert.equal(progress.pending.length, 8, "a lo sumo 8");
    assert.deepEqual(progress.pending.slice(0, 2), [
      { id: "punto-3", hu: "HU-1", texto: "Punto 3", partial: false },
      { id: "punto-4", hu: "HU-2", texto: "Punto 4", partial: true },
    ], "en el orden del taller, con lo que va a medias");
    assert.deepEqual((await call(baseUrl, "GET", `${route}?repo=eydersantiago/sistema-bancario-fpoo`, { sessionId: anaSession })).data, bank.data, "repo es un alias del parametro");
    assert.equal((await call(baseUrl, "GET", `${route}?repoFullName=https://github.com/eydersantiago/sistema-bancario-fpoo/tree/main`, { sessionId: anaSession })).data.progress.taller, "sistema-bancario-fpoo");
    assert.equal((await call(baseUrl, "GET", `${route}?repoFullName=https://github.com/Otro/Taller-Dos.git`, { sessionId: anaSession })).data.progress.taller, "taller-dos");
    // Un repositorio que no es de ningun taller: sin-taller, sin caer en otro.
    assert.deepEqual((await call(baseUrl, "GET", `${route}?repoFullName=alumno/otro-ejercicio`, { sessionId: anaSession })).data, { ok: true, status: "sin-taller", progress: null });

    // Sin repositorio: el del tema del piloto del docente; sin tema, el mas reciente.
    const latest = await call(baseUrl, "GET", route, { sessionId: anaSession });
    assert.deepEqual([latest.data.progress.taller, latest.data.progress.matchedBy], ["taller-dos", "latest"]);
    await database.setPilotTopic("user-teacher-demo", { courseCode: "FPOO", week: 9, title: "Sistema bancario", repoFullName: "eydersantiago/sistema-bancario-fpoo" }, "user-admin-demo");
    const byPilot = await call(baseUrl, "GET", route, { sessionId: anaSession });
    assert.deepEqual([byPilot.data.progress.taller, byPilot.data.progress.matchedBy], ["sistema-bancario-fpoo", "pilot"]);

    // Cada quien ve solo lo suyo: Beto su 90 %; en el taller donde no aparece, sin-carpeta.
    const asBeto = await call(baseUrl, "GET", `${route}?repoFullName=eydersantiago/sistema-bancario-fpoo`, { sessionId: betoSession });
    assert.equal(asBeto.data.progress.percent, 90);
    assert.deepEqual(asBeto.data.progress.pending, [{ id: "punto-10", hu: "HU-4", texto: "Punto 10", partial: false }]);
    assert.deepEqual((await call(baseUrl, "GET", `${route}?repoFullName=otro/taller-dos`, { sessionId: betoSession })).data, { ok: true, status: "sin-carpeta", progress: null });
    const teacher = (await database.authenticateUser("docente@adaceen.edu.co", "Docente123!"))!.id;
    assert.deepEqual((await call(baseUrl, "GET", route, { sessionId: teacher })).data, { ok: true, status: "sin-editor", progress: null }, "el docente sin GitHub tampoco ve el de sus estudiantes");
    const raw = JSON.stringify(bank.data) + JSON.stringify(asBeto.data);
    for (const secret of ["gho_", "ana-gh", "beto-gh", "Ana", "Beto"]) {
      assert.equal(raw.includes(secret), false, `no sale ${secret}`);
    }

    // Un informe sin la carpeta del estudiante (started: false) no es avance.
    await call(baseUrl, "POST", "/api/workspaces/progress-report", { headers: agent, body: progressReport("sistema-bancario-fpoo", [{ ...anaEntry, started: false, percent: 0, done: [], partial: [] }]) });
    assert.equal((await call(baseUrl, "GET", `${route}?repoFullName=eydersantiago/sistema-bancario-fpoo`, { sessionId: anaSession })).data.status, "sin-carpeta");

    // Un informe que dice su repositorio se elige por el (dueno y nombre), no por el nombre del taller.
    await call(baseUrl, "POST", "/api/workspaces/progress-report", { headers: agent, body: progressReport("taller-tres", [anaEntry], { repo: "curso/taller-tres-repo" }) });
    assert.equal((await call(baseUrl, "GET", `${route}?repoFullName=curso/taller-tres-repo`, { sessionId: anaSession })).data.progress.taller, "taller-tres");
    assert.equal((await call(baseUrl, "GET", `${route}?repoFullName=otro-dueno/taller-tres-repo`, { sessionId: anaSession })).data.status, "sin-taller");
  } finally {
    env.workspaceAgentToken = original;
    await stopServer(server, database);
  }
});

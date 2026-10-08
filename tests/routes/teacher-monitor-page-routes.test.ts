import assert from "node:assert/strict";
import test from "node:test";
import type { Server } from "node:http";
import { createApp } from "../../src/app.js";
import { env } from "../../src/config/env.js";
import { createDatabase, type AppDatabase } from "../../src/db/database.js";
import { MONITOR_PAGE_INTERVAL_S } from "../../src/routes/teacher-monitor-page-routes.js";
import type { PilotMonitorSummary } from "../../src/services/pilot-monitor.js";
import { recordWorkerHeartbeat, resetWorkerHeartbeatsForTests } from "../../src/services/worker-heartbeat.js";
import { describeWorker, recordWorker } from "../../src/services/worker-identity.js";

/**
 * Monitor del piloto en el navegador: la pagina /docente/monitor (HTML propio con CSP
 * por nonce, sin recursos externos, sesion por postMessage o inicio de sesion) y
 * GET /api/pilot/monitor, que arma en el servidor lo mismo que consulta
 * npm run piloto:monitor y devuelve {resumen, alertas, leidoEn}. Solo docente o
 * administrador; la GPU se simula con latidos falsos en memoria.
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

type MonitorResponse = {
  ok: boolean;
  resumen: PilotMonitorSummary;
  alertas: string[];
  leidoEn: string;
  desde: string;
  linea: string;
  error?: string;
};

async function readMonitor(baseUrl: string, sessionId: string, query = "") {
  const response = await fetch(`${baseUrl}/api/pilot/monitor${query}`, { headers: sessionId ? { "x-session-id": sessionId } : {} });
  return { status: response.status, data: await response.json() as MonitorResponse };
}

test("monitor del piloto: la pagina /docente/monitor es HTML propio con CSP por nonce y sesion por postMessage o inicio de sesion", async () => {
  const { server, database, baseUrl } = await startTestServer();
  try {
    const page = await fetch(`${baseUrl}/docente/monitor`);
    assert.equal(page.status, 200);
    assert.match(page.headers.get("content-type") || "", /text\/html; charset=utf-8/);
    assert.equal(page.headers.get("cache-control"), "no-store");
    const csp = page.headers.get("content-security-policy") || "";
    assert.match(csp, /default-src 'none'/);
    assert.match(csp, /connect-src 'self'/);
    assert.match(csp, /frame-ancestors 'none'/);
    const nonce = csp.match(/script-src 'nonce-([A-Za-z0-9+/=]+)'/)?.[1];
    assert.ok(nonce, "CSP con nonce");
    const html = await page.text();
    assert.match(html, /<html lang="es"/);
    assert.ok(html.includes(`<script nonce="${nonce}">`), "el script en linea lleva el nonce de la CSP");
    assert.equal((html.match(/<script/g) || []).length, 1, "un solo script, en linea");
    assert.doesNotMatch(html, /https?:\/\//, "sin scripts, estilos ni enlaces externos");
    assert.match(html, /<h1>Monitor del piloto<\/h1>/);
    assert.match(html, /adaceen:session/, "recibe la sesion de la extension por postMessage");
    assert.match(html, /adaceen:session-request/);
    assert.match(html, /event\.origin !== location\.origin/, "solo atiende mensajes del mismo origen");
    assert.match(html, /Iniciar sesion con correo y contrasena/);
    assert.match(html, /sessionKind: "cli"/, "el inicio de sesion de la pagina no cierra el del overlay");
    assert.match(html, /\/api\/pilot\/monitor\?/, "la pagina solo pinta lo que devuelve el backend");
    assert.ok(html.includes(`var INTERVAL_MS = ${MONITOR_PAGE_INTERVAL_S} * 1000;`), "lee cada 15 s");
    assert.equal(MONITOR_PAGE_INTERVAL_S, 15);
    for (const text of ["Backend", "Modelo", "Editor en la nube", "Bloque del piloto", "Estudiantes activos (5 min)", "Calidad de telemetria y latencia", "Alertas", "Sin alertas en la ultima lectura."]) {
      assert.ok(html.includes(text), `la pagina muestra «${text}»`);
    }
  } finally {
    await stopTestServer(server, database);
  }
});

test("monitor del piloto: GET /api/pilot/monitor rechaza al estudiante y devuelve resumen y alertas con una GPU simulada", async () => {
  const { server, database, baseUrl } = await startTestServer();
  const originalMode = env.targetMode;
  resetWorkerHeartbeatsForTests();
  try {
    const studentSession = await login(baseUrl, "estudiante@adaceen.edu.co", "Estudiante123!");
    const teacherSession = await login(baseUrl, "docente@adaceen.edu.co", "Docente123!");
    // El login por HTTP del administrador tropieza con un join que pg-mem no soporta: sesion directa.
    const adminSession = String((await database.authenticateUser("admin@adaceen.edu.co", "Admin123!"))?.id || "");
    assert.ok(adminSession, "sesion de administrador");

    assert.equal((await readMonitor(baseUrl, "")).status, 401, "sin sesion");
    const asStudent = await readMonitor(baseUrl, studentSession);
    assert.equal(asStudent.status, 403, "el estudiante no ve el monitor");
    assert.equal(asStudent.data.error, "Solo el docente o un administrador manejan el piloto.");

    // Modo queue sin ningun latido: como /api/agent/health en 503, el worker esta caido.
    env.targetMode = "queue";
    const since = new Date(Date.now() - 60_000).toISOString();
    const down = await readMonitor(baseUrl, teacherSession, `?desde=${encodeURIComponent(since)}`);
    assert.equal(down.status, 200);
    assert.equal(down.data.ok, true);
    assert.equal(down.data.desde, since);
    assert.ok(!Number.isNaN(Date.parse(down.data.leidoEn)), "leidoEn en ISO");
    assert.deepEqual(down.data.resumen.worker, { ok: false, estado: 503, vivos: 0 });
    assert.equal(down.data.resumen.modelo.servidoresVivos, 0);
    assert.equal(down.data.resumen.modelo.texto, "servidores 0");
    assert.equal(down.data.resumen.backend.modo, "queue");
    assert.equal(down.data.resumen.piloto.bloque, 0);
    assert.deepEqual(down.data.resumen.piloto.conteos, { A: 0, B: 0, sinAsignar: 1 }, "el estudiante demo no tiene cohorte");
    assert.deepEqual(down.data.alertas, [
      "sin worker (agent/health 503): el tutor responde degradado",
      "1 estudiantes sin cohorte",
    ]);
    assert.match(down.data.linea, /^bloque 0 \| worker CAIDO \| servidores 0 \| activos 5 min 0 \(con tutor 0, sin tutor 0\) \| p50 10 min — \| sin fallo — \| perdidos — \| eventos \d+$/);

    // GPU simulada: dos latidos en memoria (lo que mandaria POST /api/agent/heartbeat) y el ultimo job atendido.
    recordWorkerHeartbeat({ workerId: "mac-lab01-m2", model: "qwen2.5-coder:14b", kinds: "text", platform: "darwin-arm64", jobsProcessed: 3 });
    recordWorkerHeartbeat({ workerId: "gce-v100", model: "qwen2.5-coder:14b", kinds: "text,image", platform: "linux-x64", jobsProcessed: 7 });
    recordWorker(describeWorker("gce-v100", { mode: "queue" }));
    const up = await readMonitor(baseUrl, teacherSession, `?desde=${encodeURIComponent(since)}`);
    assert.equal(up.status, 200);
    assert.deepEqual(up.data.resumen.worker, { ok: true, estado: 200, vivos: 2 });
    assert.equal(up.data.resumen.modelo.servidoresVivos, 2);
    assert.match(up.data.resumen.modelo.texto, /^servidores 2 \(/);
    assert.deepEqual(up.data.resumen.modelo.porTipo.map((item) => item.etiqueta).sort(), ["Google Cloud - V100", "Mac del laboratorio - M2"]);
    assert.deepEqual(up.data.resumen.modelo.modelos, ["qwen2.5-coder:14b"]);
    assert.equal(up.data.resumen.modelo.aceptaImagenes, true);
    assert.deepEqual(up.data.resumen.modelo.servidores.map((server) => server.id).sort(), ["gce-v100", "mac-lab01-m2"]);
    assert.equal(up.data.resumen.modelo.servidores.find((server) => server.id === "gce-v100")?.jobs, 7);
    assert.equal(up.data.resumen.modelo.ultimoAtendio?.etiqueta, "Google Cloud - V100");
    assert.equal(typeof up.data.resumen.editor.proveedor, "string");
    assert.equal(typeof up.data.resumen.editor.agenteConectado, "boolean");
    assert.equal(typeof up.data.resumen.editor.autoencendido, "boolean");
    assert.deepEqual(up.data.alertas, ["1 estudiantes sin cohorte"]);
    assert.match(up.data.linea, /^bloque 0 \| worker ok \| servidores 2 \(/);

    // Administrador: como /api/pilot, pide el docente; con el, lee su grupo.
    const adminNoTeacher = await readMonitor(baseUrl, adminSession);
    assert.equal(adminNoTeacher.status, 400);
    assert.equal(adminNoTeacher.data.error, "Indica teacherUserId: el piloto va por docente.");
    const adminOk = await readMonitor(baseUrl, adminSession, "?teacherUserId=user-teacher-demo");
    assert.equal(adminOk.status, 200);
    assert.deepEqual(adminOk.data.resumen.piloto.conteos, { A: 0, B: 0, sinAsignar: 1 });
    // Un docente no mira el grupo de otro, y la fecha de inicio se valida.
    assert.equal((await readMonitor(baseUrl, teacherSession, "?teacherUserId=otro-docente")).status, 403);
    const badDate = await readMonitor(baseUrl, teacherSession, "?desde=ayer");
    assert.equal(badDate.status, 400);
    assert.equal(badDate.data.error, "Fecha invalida: ayer");
  } finally {
    env.targetMode = originalMode;
    resetWorkerHeartbeatsForTests();
    await stopTestServer(server, database);
  }
});

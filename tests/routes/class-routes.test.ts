import assert from "node:assert/strict";
import test from "node:test";
import type { Server } from "node:http";
import express from "express";
import { createDatabase, type AppDatabase } from "../../src/db/database.js";
import { registerClassRoutes, type ClassRouteDeps } from "../../src/routes/class-routes.js";
import { registerHealthRoutes } from "../../src/routes/health-routes.js";
import { createClassStarter, type ClassContext, type ClassStartConfig } from "../../src/services/class-start.js";
import { createComputeClient } from "../../src/services/gcp-compute.js";
import type { FetchLike } from "../../src/services/workspace-provider.js";

/**
 * «Iniciar clase» desde la tuerca (navegador 0.7.21): GET /api/admin/clase/estado y
 * POST /api/admin/clase/iniciar con un Compute falso (fetch inyectado, como en
 * tests/services/gcp-compute.test.ts) y un contexto (proveedor, agente, servidores) de prueba.
 */

const CONFIG: ClassStartConfig = {
  project: "adaceen-piloto",
  gpus: [
    { name: "adaceen-worker-v100", zone: "us-central1-b" },
    { name: "adaceen-worker-a100", zone: "us-central1-c" },
    { name: "adaceen-worker", zone: "us-central1-a" },
  ],
  editors: { name: "adaceen-ws", zone: "us-central1-a" },
};

const STOCKOUT = {
  error: {
    code: 403,
    message: "The zone 'projects/adaceen-piloto/zones/us-central1-b' does not have enough resources available to fulfill the request. Try a different zone, or try again later.",
    errors: [{ reason: "ZONE_RESOURCE_POOL_EXHAUSTED" }],
  },
};

type FakeVm = { status: string; startStatus: number; startBody?: unknown; startsTo?: string };

function json(status: number, body: unknown) {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

// Compute falso: estado por VM, lo que responde cada start y que llamadas hubo.
function fakeCompute(initial: Record<string, FakeVm>) {
  const vms = initial;
  const calls: string[] = [];
  const fetchImpl: FetchLike = async (url, init) => {
    const method = init?.method || "GET";
    const match = url.match(/\/projects\/([^/]+)\/zones\/([^/]+)\/instances\/([^/]+)(\/start)?$/);
    assert.ok(match, `URL de Compute inesperada: ${url}`);
    assert.equal(new Headers(init?.headers).get("authorization"), "Bearer token-falso");
    const [, project, zone, name, start] = match;
    calls.push(`${method} ${project}/${zone}/${name}${start || ""}`);
    const vm = vms[name];
    if (!vm) return json(404, { error: { code: 404, message: "not found", errors: [{ reason: "notFound" }] } });
    if (start) {
      if (vm.startStatus >= 200 && vm.startStatus < 300) vm.status = vm.startsTo || "STAGING";
      return json(vm.startStatus, vm.startBody ?? { kind: "compute#operation", status: "RUNNING" });
    }
    return json(200, { name, status: vm.status });
  };
  return { vms, calls, fetchImpl, posts: () => calls.filter((call) => call.startsWith("POST")) };
}

async function startServer(deps: ClassRouteDeps, options: { health?: boolean } = {}) {
  const database = await createDatabase();
  const app = express();
  app.use(express.json());
  if (options.health) registerHealthRoutes(app, database);
  registerClassRoutes(app, database, deps);
  const server = await new Promise<Server>((resolve) => {
    const started = app.listen(0, () => resolve(started));
  });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("No se pudo iniciar servidor de prueba.");
  const admin = await database.authenticateUser("admin@adaceen.edu.co", "Admin123!");
  const teacher = await database.authenticateUser("docente@adaceen.edu.co", "Docente123!");
  const student = await database.authenticateUser("estudiante@adaceen.edu.co", "Estudiante123!");
  assert.ok(admin && teacher && student, "las cuentas demo deben poder iniciar sesion");
  return { database, server, admin, teacher, student, baseUrl: `http://127.0.0.1:${address.port}` };
}

async function stopServer(server: Server, database: AppDatabase) {
  await new Promise<void>((resolve, reject) => {
    server.close((error) => error ? reject(error) : resolve());
  });
  await database.close();
}

type VmBody = { name: string; zone: string; kind: string; vmStatus: string | null; state: string; startRequestedAt: string | null; problem: string };
type ClassBody = {
  ok?: boolean;
  configured?: boolean;
  code?: string;
  error?: string;
  message?: string;
  provider?: string;
  editorsNeeded?: boolean;
  editors?: VmBody | null;
  gpus?: VmBody[];
  gpu?: string;
  workspaceAgentOnline?: boolean | null;
  modelWorkersAlive?: number;
  ready?: boolean;
  requestedBy?: string | null;
  requestedAt?: string | null;
  actions?: string[];
};

async function call(baseUrl: string, path: string, sessionId?: string, post = false) {
  const response = await fetch(`${baseUrl}${path}`, {
    method: post ? "POST" : "GET",
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      ...(sessionId ? { "x-session-id": sessionId } : {}),
    },
    body: post ? "{}" : undefined,
  });
  return { status: response.status, body: await response.json() as ClassBody };
}

const estado = (baseUrl: string, sessionId?: string) => call(baseUrl, "/api/admin/clase/estado", sessionId);
const iniciar = (baseUrl: string, sessionId?: string) => call(baseUrl, "/api/admin/clase/iniciar", sessionId, true);

function withQuietConsole<T>(work: (lines: string[]) => Promise<T>) {
  const originalInfo = console.info;
  const originalWarn = console.warn;
  const lines: string[] = [];
  console.info = (...args: unknown[]) => { lines.push(args.map(String).join(" ")); };
  console.warn = (...args: unknown[]) => { lines.push(args.map(String).join(" ")); };
  return work(lines).finally(() => {
    console.info = originalInfo;
    console.warn = originalWarn;
  });
}

function makeStarter(compute: ReturnType<typeof fakeCompute>, context: ClassContext, clock: { now: number }, config = CONFIG) {
  return createClassStarter(config, {
    compute: createComputeClient({ getAccessToken: async () => "token-falso", fetch: compute.fetchImpl }),
    context: async () => ({ ...context }),
    now: () => clock.now,
  });
}

test("clase: solo el administrador o el docente; sin configurar responde 409 con el motivo", async () => {
  const { server, database, admin, teacher, student, baseUrl } = await startServer({
    starter: null,
    problem: "Este backend no tiene credenciales de Google Cloud: carga GCP_SERVICE_ACCOUNT_JSON o la federacion sin clave.",
  }, { health: true });
  try {
    assert.equal((await estado(baseUrl)).status, 401);
    assert.equal((await iniciar(baseUrl)).status, 401);
    const forbidden = await iniciar(baseUrl, student.id);
    assert.equal(forbidden.status, 403);
    assert.equal(forbidden.body.error, "Solo el administrador o el docente inician la clase.");
    assert.equal((await estado(baseUrl, student.id)).status, 403);

    for (const sessionId of [admin.id, teacher.id]) {
      const refused = await estado(baseUrl, sessionId);
      assert.equal(refused.status, 409);
      assert.equal(refused.body.code, "class_start_not_configured");
      assert.equal(refused.body.configured, false);
      assert.match(refused.body.error || "", /credenciales de Google Cloud/);
      assert.equal(refused.body.message, refused.body.error);
      assert.equal((await iniciar(baseUrl, sessionId)).status, 409);
    }

    // /api/health: sin autoencendido no hay modo de credenciales.
    const health = await (await fetch(`${baseUrl}/api/health`)).json() as Record<string, unknown>;
    assert.equal(health.workspace_vm_autostart, false);
    assert.equal(health.workspace_vm_auth, null);
  } finally {
    await stopServer(server, database);
  }
});

test("clase iniciar: enciende la VM de editores y la primera GPU que acepte (la V100 sin cupo se salta); estado sigue hasta ready", async () => {
  const clock = { now: Date.parse("2026-10-08T12:00:00Z") };
  const compute = fakeCompute({
    "adaceen-worker-v100": { status: "TERMINATED", startStatus: 403, startBody: STOCKOUT },
    "adaceen-worker-a100": { status: "TERMINATED", startStatus: 200 },
    "adaceen-worker": { status: "TERMINATED", startStatus: 200 },
    "adaceen-ws": { status: "TERMINATED", startStatus: 200 },
  });
  const context: ClassContext = { provider: "tunnel", agentOnline: false, workersAlive: 0 };
  const starter = makeStarter(compute, context, clock);
  const { server, database, admin, teacher, baseUrl } = await startServer({ starter });
  try {
    await withQuietConsole(async (lines) => {
      const before = await estado(baseUrl, teacher.id);
      assert.equal(before.status, 200);
      assert.equal(before.body.ready, false);
      assert.equal(before.body.gpu, "off");
      assert.equal(before.body.editors?.state, "off");
      assert.equal(before.body.requestedBy, null);
      assert.deepEqual(compute.posts(), [], "estado no enciende nada");

      const started = await iniciar(baseUrl, admin.id);
      assert.equal(started.status, 200);
      assert.deepEqual(started.body.actions, ["instances.start adaceen-ws", "instances.start adaceen-worker-v100", "instances.start adaceen-worker-a100"]);
      assert.equal(started.body.editorsNeeded, true);
      assert.equal(started.body.editors?.state, "starting");
      assert.equal(started.body.editors?.startRequestedAt, new Date(clock.now).toISOString());
      assert.equal(started.body.gpus?.[0].state, "failed");
      assert.match(started.body.gpus?.[0].problem || "", /instances\.start HTTP 403 \(ZONE_RESOURCE_POOL_EXHAUSTED/);
      assert.equal(started.body.gpus?.[1].state, "starting");
      assert.equal(started.body.gpus?.[2].state, "off", "la L4 no se toca: la A100 acepto");
      assert.equal(started.body.gpu, "starting");
      assert.equal(started.body.ready, false);
      assert.equal(started.body.requestedBy, "Administrador Demo (admin, u-admin)".replace("u-admin", String(admin.user.id)));
      assert.match(started.body.message || "", /^Encendiendo la VM de editores \(el agente se conecta en 1-2 min\)\. Encendiendo la GPU adaceen-worker-a100/);
      assert.deepEqual(compute.posts(), [
        "POST adaceen-piloto/us-central1-a/adaceen-ws/start",
        "POST adaceen-piloto/us-central1-b/adaceen-worker-v100/start",
        "POST adaceen-piloto/us-central1-c/adaceen-worker-a100/start",
      ]);
      assert.ok(lines.some((line) => line.includes("«Iniciar clase» pedido por Administrador Demo")), "queda en el log quien lo pidio");
      assert.ok(lines.some((line) => line.includes("adaceen-worker-v100 no encendio") && line.includes("sin cupo o cuota")));
      assert.ok(lines.every((line) => !line.includes("Bearer") && !line.includes("token-falso")));

      // Dentro de los 2 min: otro «Iniciar clase» no repite ningun start.
      clock.now += 30_000;
      const again = await iniciar(baseUrl, teacher.id);
      assert.deepEqual(again.body.actions, []);
      assert.equal(again.body.gpu, "starting");
      assert.equal(compute.posts().length, 3);
      assert.match(again.body.message || "", /ya se esta encendiendo/);

      // Las VMs ya estan RUNNING y el agente y la GPU se conectaron: ready.
      compute.vms["adaceen-worker-a100"].status = "RUNNING";
      compute.vms["adaceen-ws"].status = "RUNNING";
      context.agentOnline = true;
      context.workersAlive = 1;
      // La cache de 15 s sigue diciendo lo que leyo el ultimo iniciar (STAGING tras el start)...
      const cached = await estado(baseUrl, teacher.id);
      assert.equal(cached.body.editors?.vmStatus, "STAGING");
      assert.equal(cached.body.ready, true, "ready depende del agente y los latidos, no de la cache de la VM");
      // ...y pasados 15 s se vuelve a leer.
      clock.now += 20_000;
      const ready = await estado(baseUrl, teacher.id);
      assert.equal(ready.body.ready, true);
      assert.equal(ready.body.gpu, "running");
      assert.equal(ready.body.editors?.state, "running");
      assert.equal(ready.body.editors?.vmStatus, "RUNNING");
      assert.equal(ready.body.gpus?.[1].vmStatus, "RUNNING");
      assert.equal(ready.body.workspaceAgentOnline, true);
      assert.equal(ready.body.modelWorkersAlive, 1);
      assert.equal(compute.posts().length, 3, "nunca se apaga ni se vuelve a encender nada");
    });
  } finally {
    await stopServer(server, database);
  }
});

test("clase iniciar: con una GPU ya encendida no enciende otra; con Codespaces no toca la VM de editores", async () => {
  const clock = { now: Date.parse("2026-10-08T12:00:00Z") };
  const compute = fakeCompute({
    "adaceen-worker-v100": { status: "TERMINATED", startStatus: 200 },
    "adaceen-worker-a100": { status: "RUNNING", startStatus: 200 },
    "adaceen-worker": { status: "TERMINATED", startStatus: 200 },
    "adaceen-ws": { status: "TERMINATED", startStatus: 200 },
  });
  const context: ClassContext = { provider: "codespaces", agentOnline: false, workersAlive: 0 };
  const { server, database, teacher, baseUrl } = await startServer({ starter: makeStarter(compute, context, clock) });
  try {
    await withQuietConsole(async () => {
      const started = await iniciar(baseUrl, teacher.id);
      assert.equal(started.status, 200);
      assert.deepEqual(started.body.actions, []);
      assert.equal(started.body.editorsNeeded, false);
      assert.equal(started.body.editors?.state, "off", "con Codespaces la VM de editores se deja apagada");
      assert.equal(started.body.gpu, "running");
      assert.equal(started.body.ready, false, "falta el latido del servidor del modelo");
      assert.equal(started.body.message, "La GPU adaceen-worker-a100 ya esta encendida; el servidor del modelo tarda 2-5 min en mandar latido.");
      assert.deepEqual(compute.posts(), []);

      context.workersAlive = 2;
      const ready = await estado(baseUrl, teacher.id);
      assert.equal(ready.body.ready, true, "con Codespaces basta el servidor del modelo");
      assert.equal(ready.body.modelWorkersAlive, 2);
    });
  } finally {
    await stopServer(server, database);
  }
});

test("clase estado: un start aceptado cuya GPU sigue apagada cuenta como fallo y estado prueba la siguiente (hasta 15 min)", async () => {
  const clock = { now: Date.parse("2026-10-08T12:00:00Z") };
  const compute = fakeCompute({
    // Compute acepta el start pero la VM nunca pasa de TERMINATED (sin cupo).
    "adaceen-worker-v100": { status: "TERMINATED", startStatus: 200, startsTo: "TERMINATED" },
    "adaceen-worker-a100": { status: "TERMINATED", startStatus: 200 },
    "adaceen-worker": { status: "TERMINATED", startStatus: 200 },
  });
  const context: ClassContext = { provider: "codespaces", agentOnline: null, workersAlive: 0 };
  const { server, database, admin, baseUrl } = await startServer({ starter: makeStarter(compute, context, clock, { ...CONFIG, editors: null }) });
  try {
    await withQuietConsole(async () => {
      const started = await iniciar(baseUrl, admin.id);
      assert.deepEqual(started.body.actions, ["instances.start adaceen-worker-v100"]);
      assert.equal(started.body.editors, null);
      assert.equal(started.body.gpus?.[0].state, "starting");

      // A los 30 s sigue "starting" (todavia puede estar arrancando).
      clock.now += 30_000;
      assert.equal((await estado(baseUrl, admin.id)).body.gpus?.[0].state, "starting");
      assert.equal(compute.posts().length, 1);

      // A los 90 s sigue TERMINATED: fallo; estado completa lo pedido con la A100.
      clock.now += 70_000;
      const next = await estado(baseUrl, admin.id);
      assert.equal(next.body.gpus?.[0].state, "failed");
      assert.match(next.body.gpus?.[0].problem || "", /sigue apagada/);
      assert.equal(next.body.gpus?.[1].state, "starting");
      assert.equal(next.body.gpu, "starting");
      assert.deepEqual(compute.posts(), [
        "POST adaceen-piloto/us-central1-b/adaceen-worker-v100/start",
        "POST adaceen-piloto/us-central1-c/adaceen-worker-a100/start",
      ]);

      // Con un servidor vivo ya no se enciende nada mas, aunque la A100 tampoco quedara RUNNING.
      compute.vms["adaceen-worker-a100"].status = "TERMINATED";
      context.workersAlive = 1;
      clock.now += 2 * 60_000;
      const served = await estado(baseUrl, admin.id);
      assert.equal(served.body.ready, true);
      assert.equal(compute.posts().length, 2);

      // Pasados 15 min desde el boton, estado ya no enciende nada aunque no haya servidores.
      context.workersAlive = 0;
      clock.now += 15 * 60_000;
      const later = await estado(baseUrl, admin.id);
      assert.equal(later.body.ready, false);
      assert.equal(later.body.gpu, "off", "pasado el tiempo de fallo las GPU vuelven a verse apagadas");
      assert.equal(compute.posts().length, 2, "estado no enciende por su cuenta");
    });
  } finally {
    await stopServer(server, database);
  }
});

test("clase: consultas simultaneas comparten una sola lectura por VM; Compute caido -> unknown con el motivo, nunca 500", async () => {
  const clock = { now: Date.parse("2026-10-08T12:00:00Z") };
  const compute = fakeCompute({
    "adaceen-worker-v100": { status: "TERMINATED", startStatus: 200 },
    "adaceen-worker-a100": { status: "TERMINATED", startStatus: 200 },
    "adaceen-worker": { status: "TERMINATED", startStatus: 200 },
    "adaceen-ws": { status: "TERMINATED", startStatus: 200 },
  });
  const context: ClassContext = { provider: "tunnel", agentOnline: false, workersAlive: 0 };
  const { server, database, teacher, baseUrl } = await startServer({ starter: makeStarter(compute, context, clock) });
  try {
    await withQuietConsole(async () => {
      const results = await Promise.all([estado(baseUrl, teacher.id), estado(baseUrl, teacher.id), estado(baseUrl, teacher.id)]);
      assert.ok(results.every((result) => result.status === 200));
      assert.equal(compute.calls.length, 4, "una lectura por VM para las tres consultas");
    });
  } finally {
    await stopServer(server, database);
  }

  const down = createClassStarter(CONFIG, {
    compute: createComputeClient({
      getAccessToken: async () => "t",
      fetch: async () => { throw new TypeError("fetch failed"); },
    }),
    context: async () => ({ provider: "tunnel", agentOnline: false, workersAlive: 0 }),
  });
  const offline = await startServer({ starter: down });
  try {
    await withQuietConsole(async () => {
      const status = await estado(offline.baseUrl, offline.teacher.id);
      assert.equal(status.status, 200);
      assert.equal(status.body.editors?.state, "unknown");
      assert.match(status.body.editors?.problem || "", /fetch failed/);
      const started = await iniciar(offline.baseUrl, offline.teacher.id);
      assert.equal(started.status, 200);
      assert.deepEqual(started.body.actions, [], "sin saber el estado no se pide ningun start");
      assert.match(started.body.message || "", /no encendio|no se pudo encender/);
    });
  } finally {
    await stopServer(offline.server, offline.database);
  }
});

import assert from "node:assert/strict";
import test from "node:test";
import {
  createVmAutostarter,
  parseServiceAccountJson,
  resolveVmAutostartConfig,
  type VmAutostartConfig,
} from "../../src/services/gcp-compute.js";
import type { FetchLike } from "../../src/services/workspace-provider.js";

/**
 * Encendido automatico de la VM de editores (acceso simplificado, seccion 5):
 * consulta instances.get y pide instances.start como mucho una vez cada 2 min,
 * con fetch y token falsos (sin red).
 */

const KEY = {
  type: "service_account",
  client_email: "adaceen-autoencendido@adaceen-piloto.iam.gserviceaccount.com",
  private_key: "-----BEGIN PRIVATE KEY-----\nMIIEclave\n-----END PRIVATE KEY-----\n",
};

const CONFIG: VmAutostartConfig = {
  project: "adaceen-piloto",
  zone: "us-central1-a",
  name: "adaceen-ws",
  credentialsJson: JSON.stringify(KEY),
};

const INSTANCE_URL = "https://compute.googleapis.com/compute/v1/projects/adaceen-piloto/zones/us-central1-a/instances/adaceen-ws";

function json(status: number, body: unknown) {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

function fakeCompute(initialStatus: string) {
  const state = { vmStatus: initialStatus, startStatus: 200, getStatus: 200 };
  const calls: Array<{ method: string; url: string; authorization: string }> = [];
  const fetchImpl: FetchLike = async (url, init) => {
    const method = init?.method || "GET";
    calls.push({ method, url, authorization: new Headers(init?.headers).get("authorization") || "" });
    if (method === "POST") {
      if (state.startStatus === 200) state.vmStatus = "STAGING";
      return json(state.startStatus, { kind: "compute#operation" });
    }
    return json(state.getStatus, { status: state.vmStatus });
  };
  return { state, calls, fetchImpl };
}

test("autoencendido: la clave de la cuenta de servicio se acepta en JSON o en base64", () => {
  assert.equal(parseServiceAccountJson(JSON.stringify(KEY))?.client_email, KEY.client_email);
  const base64 = Buffer.from(JSON.stringify(KEY)).toString("base64");
  assert.equal(parseServiceAccountJson(base64)?.client_email, KEY.client_email);
  // Clave pegada con \n escapados (como en App Service).
  const escaped = JSON.stringify({ ...KEY, private_key: KEY.private_key.replace(/\n/g, "\\n") });
  assert.match(parseServiceAccountJson(escaped)?.private_key || "", /\n/);
  assert.equal(parseServiceAccountJson(""), null);
  assert.equal(parseServiceAccountJson("no-es-json"), null);
  assert.equal(parseServiceAccountJson(JSON.stringify({ client_email: "x@y" })), null, "sin private_key");
});

test("autoencendido: apagado sin configuracion; incompleto o invalido avisa y queda apagado", () => {
  assert.deepEqual(resolveVmAutostartConfig({}), { config: null, problem: "" });
  assert.deepEqual(resolveVmAutostartConfig({ mode: "off" }), { config: null, problem: "" });
  assert.match(resolveVmAutostartConfig({ mode: "aws" }).problem, /no es valido/);
  const missing = resolveVmAutostartConfig({ mode: "gcp", project: "adaceen-piloto", zone: "us-central1-a" });
  assert.equal(missing.config, null);
  assert.match(missing.problem, /WORKSPACE_VM_NAME/);
  assert.match(missing.problem, /GCP_SERVICE_ACCOUNT_JSON/);
  assert.doesNotMatch(missing.problem, /PRIVATE KEY/, "el aviso no muestra la clave");
  const ok = resolveVmAutostartConfig({ mode: "GCP", project: "adaceen-piloto", zone: "us-central1-a", name: "adaceen-ws", credentialsJson: JSON.stringify(KEY) });
  assert.equal(ok.problem, "");
  assert.equal(ok.config?.name, "adaceen-ws");
});

test("autoencendido: VM apagada -> un solo start cada 2 min; arrancando o recien encendida -> starting", async () => {
  let now = 1_000_000;
  const compute = fakeCompute("TERMINATED");
  const autostart = createVmAutostarter(CONFIG, {
    fetch: compute.fetchImpl,
    now: () => now,
    getAccessToken: async () => "token-falso",
  });

  const first = await autostart.ensureStarted();
  assert.deepEqual(first, { state: "starting", vmStatus: "TERMINATED", startRequested: true });
  assert.deepEqual(compute.calls.map((call) => `${call.method} ${call.url}`), [`GET ${INSTANCE_URL}`, `POST ${INSTANCE_URL}/start`]);
  assert.ok(compute.calls.every((call) => call.authorization === "Bearer token-falso"));

  // La extension consulta cada 3 s: dentro de 10 s se reutiliza la ultima lectura.
  now += 3_000;
  await autostart.ensureStarted();
  assert.equal(compute.calls.length, 2);

  // Se volvio a apagar (o el start no prendio): dentro de los 2 min no se repite el start.
  compute.state.vmStatus = "TERMINATED";
  now += 30_000;
  const cooling = await autostart.ensureStarted();
  assert.deepEqual(cooling, { state: "starting", vmStatus: "TERMINATED", startRequested: false });
  assert.equal(compute.calls.filter((call) => call.method === "POST").length, 1);

  now += 2 * 60 * 1000;
  const again = await autostart.ensureStarted();
  assert.equal(again.state === "starting" && again.startRequested, true, "pasados 2 min se pide de nuevo");
  assert.equal(compute.calls.filter((call) => call.method === "POST").length, 2);

  // Encendida hace poco: el agente aun se esta conectando.
  compute.state.vmStatus = "RUNNING";
  now += 60_000;
  assert.deepEqual(await autostart.ensureStarted(), { state: "starting", vmStatus: "RUNNING", startRequested: false });

  // Encendida hace rato y el agente sigue sin responder: el problema no es la VM.
  now += 10 * 60 * 1000;
  assert.deepEqual(await autostart.ensureStarted(), { state: "running", vmStatus: "RUNNING" });
});

test("autoencendido: consultas simultaneas comparten una sola llamada a Compute", async () => {
  const compute = fakeCompute("TERMINATED");
  const autostart = createVmAutostarter(CONFIG, { fetch: compute.fetchImpl, getAccessToken: async () => "t" });
  const results = await Promise.all([autostart.ensureStarted(), autostart.ensureStarted(), autostart.ensureStarted()]);
  assert.ok(results.every((result) => result.state === "starting"));
  assert.equal(compute.calls.filter((call) => call.method === "POST").length, 1);
});

test("autoencendido: sin permiso, token fallido o VM suspendida -> unavailable (nunca lanza)", async () => {
  const originalWarn = console.warn;
  const warnings: string[] = [];
  console.warn = (...args: unknown[]) => { warnings.push(args.map(String).join(" ")); };
  try {
    const forbidden = fakeCompute("TERMINATED");
    forbidden.state.getStatus = 403;
    const noPermission = createVmAutostarter(CONFIG, { fetch: forbidden.fetchImpl, getAccessToken: async () => "t" });
    assert.deepEqual(await noPermission.ensureStarted(), { state: "unavailable", reason: "instances.get HTTP 403" });

    const startDenied = fakeCompute("TERMINATED");
    startDenied.state.startStatus = 403;
    const denied = createVmAutostarter(CONFIG, { fetch: startDenied.fetchImpl, getAccessToken: async () => "t" });
    assert.deepEqual(await denied.ensureStarted(), { state: "unavailable", reason: "instances.start HTTP 403" });

    const tokenFails = createVmAutostarter(CONFIG, {
      fetch: fakeCompute("TERMINATED").fetchImpl,
      getAccessToken: async () => {
        throw new Error("invalid_grant");
      },
    });
    const outcome = await tokenFails.ensureStarted();
    assert.equal(outcome.state, "unavailable");

    const suspended = createVmAutostarter(CONFIG, { fetch: fakeCompute("SUSPENDED").fetchImpl, getAccessToken: async () => "t" });
    assert.deepEqual(await suspended.ensureStarted(), { state: "unavailable", reason: "la VM esta en SUSPENDED" });

    const network = createVmAutostarter(CONFIG, {
      fetch: async () => {
        throw new TypeError("fetch failed");
      },
      getAccessToken: async () => "t",
    });
    assert.equal((await network.ensureStarted()).state, "unavailable");
    assert.ok(warnings.length >= 4);
    assert.ok(warnings.every((line) => !line.includes("PRIVATE KEY") && !line.includes("Bearer")));
  } finally {
    console.warn = originalWarn;
  }
});

test("autoencendido: si instances.start falla, la pausa no dice 'encendiendo' (el estudiante ve 'avisa al docente')", async () => {
  const originalWarn = console.warn;
  const warnings: string[] = [];
  console.warn = (...args: unknown[]) => { warnings.push(args.map(String).join(" ")); };
  try {
    let now = 5_000_000;
    const compute = fakeCompute("TERMINATED");
    compute.state.startStatus = 403;
    const autostart = createVmAutostarter(CONFIG, { fetch: compute.fetchImpl, now: () => now, getAccessToken: async () => "t" });

    assert.deepEqual(await autostart.ensureStarted(), { state: "unavailable", reason: "instances.start HTTP 403" });
    now += 11_000;
    assert.deepEqual(await autostart.ensureStarted(), { state: "unavailable", reason: "instances.start HTTP 403" }, "dentro de la pausa sigue sin encender");
    now += 60_000;
    assert.equal((await autostart.ensureStarted()).state, "unavailable");
    assert.equal(compute.calls.filter((call) => call.method === "POST").length, 1, "no se repite el start dentro de los 2 min");
    assert.equal(warnings.length, 1, "un aviso por motivo, no uno por consulta");

    // Se corrigieron los permisos: pasada la pausa se vuelve a intentar y ahora si enciende.
    compute.state.startStatus = 200;
    now += 2 * 60 * 1000;
    assert.deepEqual(await autostart.ensureStarted(), { state: "starting", vmStatus: "TERMINATED", startRequested: true });
    compute.state.vmStatus = "TERMINATED";
    now += 11_000;
    assert.deepEqual(await autostart.ensureStarted(), { state: "starting", vmStatus: "TERMINATED", startRequested: false }, "start aceptado: la pausa si dice encendiendo");
  } finally {
    console.warn = originalWarn;
  }
});

test("autoencendido: una VM que se esta apagando (clase.sh terminar) no se vuelve a encender enseguida", async () => {
  const originalWarn = console.warn;
  console.warn = () => {};
  try {
    let now = 8_000_000;
    const compute = fakeCompute("STOPPING");
    const autostart = createVmAutostarter(CONFIG, { fetch: compute.fetchImpl, now: () => now, getAccessToken: async () => "t" });

    assert.deepEqual(await autostart.ensureStarted(), { state: "unavailable", reason: "la VM se esta apagando" });
    // Ya apagada; las ventanas siguen consultando durante su espera (hasta 12 min).
    compute.state.vmStatus = "TERMINATED";
    for (const step of [30_000, 5 * 60 * 1000, 6 * 60 * 1000]) {
      now += step;
      assert.equal((await autostart.ensureStarted()).state, "unavailable");
    }
    assert.equal(compute.calls.filter((call) => call.method === "POST").length, 0, "no se pidio ningun start");

    // Pasada la espera, un estudiante que pulsa Abrir mi editor si la enciende.
    now += 4 * 60 * 1000;
    assert.deepEqual(await autostart.ensureStarted(), { state: "starting", vmStatus: "TERMINATED", startRequested: true });
    assert.equal(compute.calls.filter((call) => call.method === "POST").length, 1);
  } finally {
    console.warn = originalWarn;
  }
});

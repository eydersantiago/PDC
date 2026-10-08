import assert from "node:assert/strict";
import test from "node:test";
import { ExternalAccountClient } from "google-auth-library";
import {
  AZURE_IMDS_TOKEN_URL,
  buildFederationCredentialJson,
  createComputeClient,
  createVmAutostarter,
  describeComputeError,
  isCapacityProblem,
  parseServiceAccountJson,
  readAzureIdentityEnv,
  resolveGcpCredentials,
  resolveVmAutostartConfig,
  type GcpFederationCredentials,
  type VmAutostartConfig,
} from "../../src/services/gcp-compute.js";
import type { FetchLike } from "../../src/services/workspace-provider.js";

/**
 * Encendido automatico de la VM de editores (acceso simplificado, seccion 5):
 * consulta instances.get y pide instances.start como mucho una vez cada 2 min,
 * con fetch y token falsos (sin red). Credenciales en dos modos: clave de la
 * cuenta de servicio o federacion de identidades desde Azure (sin clave).
 */

const FEDERATION: GcpFederationCredentials = {
  mode: "federation",
  audience: "//iam.googleapis.com/projects/123456789012/locations/global/workloadIdentityPools/adaceen-azure/providers/azure",
  serviceAccountEmail: "adaceen-autoencendido@adaceen-piloto.iam.gserviceaccount.com",
  azureTokenResource: "api://adaceen-gcp",
};

test("credenciales de Google Cloud: ninguna, clave, federacion completa o incompleta, y la clave gana si hay las dos", () => {
  assert.deepEqual(resolveGcpCredentials({}), { credentials: null, problem: "", warning: "" });

  const key = resolveGcpCredentials({ credentialsJson: JSON.stringify(KEY) });
  assert.equal(key.credentials?.mode, "key");
  assert.equal(key.warning, "");

  const federation = resolveGcpCredentials({
    workloadIdentityAudience: ` ${FEDERATION.audience} `,
    serviceAccountEmail: FEDERATION.serviceAccountEmail.toUpperCase(),
    azureTokenResource: FEDERATION.azureTokenResource,
  });
  assert.deepEqual(federation, { credentials: FEDERATION, problem: "", warning: "" });

  const incomplete = resolveGcpCredentials({ workloadIdentityAudience: FEDERATION.audience });
  assert.equal(incomplete.credentials, null);
  assert.match(incomplete.problem, /GCP_SERVICE_ACCOUNT_EMAIL/);
  assert.match(incomplete.problem, /GCP_AZURE_TOKEN_RESOURCE/);
  assert.doesNotMatch(incomplete.problem, /GCP_WORKLOAD_IDENTITY_AUDIENCE/, "la audience si estaba bien");

  const badAudience = resolveGcpCredentials({
    workloadIdentityAudience: "projects/123/locations/global/workloadIdentityPools/x/providers/y",
    serviceAccountEmail: FEDERATION.serviceAccountEmail,
    azureTokenResource: FEDERATION.azureTokenResource,
  });
  assert.match(badAudience.problem, /GCP_WORKLOAD_IDENTITY_AUDIENCE/, "la audience lleva //iam.googleapis.com/projects/<numero>/...");

  // Clave y federacion a la vez: se usa la clave y se avisa (sin mostrar la clave).
  const both = resolveGcpCredentials({
    credentialsJson: JSON.stringify(KEY),
    workloadIdentityAudience: FEDERATION.audience,
    serviceAccountEmail: FEDERATION.serviceAccountEmail,
    azureTokenResource: FEDERATION.azureTokenResource,
  });
  assert.equal(both.credentials?.mode, "key");
  assert.match(both.warning, /se usa la clave/);
  assert.doesNotMatch(both.warning, /PRIVATE KEY/);
});

test("federacion: la configuracion external_account se arma sin red, con el endpoint del App Service o el IMDS", () => {
  // App Service: IDENTITY_ENDPOINT e IDENTITY_HEADER (las pone Azure en el proceso).
  const azure = readAzureIdentityEnv({ IDENTITY_ENDPOINT: "http://127.0.0.1:41273/msi/token", IDENTITY_HEADER: "cabecera-secreta" } as NodeJS.ProcessEnv);
  const appService = buildFederationCredentialJson(FEDERATION, azure);
  assert.deepEqual(appService, {
    type: "external_account",
    audience: FEDERATION.audience,
    subject_token_type: "urn:ietf:params:oauth:token-type:jwt",
    token_url: "https://sts.googleapis.com/v1/token",
    service_account_impersonation_url: "https://iamcredentials.googleapis.com/v1/projects/-/serviceAccounts/adaceen-autoencendido@adaceen-piloto.iam.gserviceaccount.com:generateAccessToken",
    credential_source: {
      url: "http://127.0.0.1:41273/msi/token?api-version=2019-08-01&resource=api%3A%2F%2Fadaceen-gcp",
      headers: { "X-IDENTITY-HEADER": "cabecera-secreta" },
      format: { type: "json", subject_token_field_name: "access_token" },
    },
  });
  assert.doesNotMatch(JSON.stringify(appService), /private_key|PRIVATE KEY/, "sin clave");

  // Fuera del App Service (VM de Azure): IMDS con la cabecera Metadata.
  const imds = buildFederationCredentialJson(FEDERATION, readAzureIdentityEnv({} as NodeJS.ProcessEnv));
  assert.equal(imds.credential_source.url, `${AZURE_IMDS_TOKEN_URL}?api-version=2018-02-01&resource=api%3A%2F%2Fadaceen-gcp`);
  assert.deepEqual(imds.credential_source.headers, { Metadata: "true" });

  // La libreria instalada acepta ese formato (credential_source.url con headers y format json).
  const client = ExternalAccountClient.fromJSON({ ...appService, scopes: ["https://www.googleapis.com/auth/compute"] });
  assert.ok(client, "ExternalAccountClient.fromJSON acepta la configuracion");
  assert.equal(client?.constructor.name, "IdentityPoolClient");

  // El autoencendido en modo federacion: sin GCP_SERVICE_ACCOUNT_JSON.
  const resolved = resolveVmAutostartConfig({
    mode: "gcp",
    project: "adaceen-piloto",
    zone: "us-central1-a",
    name: "adaceen-ws",
    workloadIdentityAudience: FEDERATION.audience,
    serviceAccountEmail: FEDERATION.serviceAccountEmail,
    azureTokenResource: FEDERATION.azureTokenResource,
  });
  assert.equal(resolved.problem, "");
  assert.deepEqual(resolved.config?.federation, FEDERATION);
  assert.equal(createVmAutostarter(resolved.config!, { getAccessToken: async () => "t" }).authMode, "federation");
  assert.equal(createVmAutostarter(CONFIG, { getAccessToken: async () => "t" }).authMode, "key");
  assert.equal(createVmAutostarter({ ...CONFIG, credentialsJson: "" }, { getAccessToken: async () => "t" }).authMode, null);

  // Federacion incompleta con el autoencendido pedido: queda apagado y dice que falta.
  const incomplete = resolveVmAutostartConfig({ mode: "gcp", project: "adaceen-piloto", zone: "us-central1-a", name: "adaceen-ws", workloadIdentityAudience: FEDERATION.audience });
  assert.equal(incomplete.config, null);
  assert.match(incomplete.problem, /GCP_SERVICE_ACCOUNT_EMAIL/);
});

test("cliente de Compute: un start rechazado por cupo o cuota se distingue de otros fallos (para probar la siguiente GPU)", async () => {
  const stockout = {
    error: {
      code: 403,
      message: "The zone 'projects/adaceen-piloto/zones/us-central1-b' does not have enough resources available to fulfill the request. Try a different zone, or try again later.",
      errors: [{ reason: "ZONE_RESOURCE_POOL_EXHAUSTED", domain: "global" }],
    },
  };
  assert.equal(describeComputeError(stockout), `ZONE_RESOURCE_POOL_EXHAUSTED: ${stockout.error.message}`);
  assert.equal(describeComputeError({}), "");
  assert.equal(isCapacityProblem("QUOTA_EXCEEDED: Quota 'GPUS_ALL_REGIONS' exceeded. Limit: 1.0 globally."), true);
  assert.equal(isCapacityProblem("forbidden: Required 'compute.instances.start' permission"), false);

  const responses: Record<string, () => Response> = {
    "GET adaceen-worker-v100": () => json(200, { status: "TERMINATED" }),
    "POST adaceen-worker-v100/start": () => json(403, stockout),
    "POST adaceen-worker-a100/start": () => json(403, { error: { code: 403, message: "Required 'compute.instances.start' permission", errors: [{ reason: "forbidden" }] } }),
    "POST adaceen-worker/start": () => json(200, { kind: "compute#operation", status: "RUNNING" }),
  };
  const compute = createComputeClient({
    getAccessToken: async () => "token-falso",
    fetch: async (url, init) => {
      const key = `${init?.method || "GET"} ${url.split("/instances/")[1]}`;
      return responses[key]?.() ?? json(404, {});
    },
  });
  const ref = (name: string) => ({ project: "adaceen-piloto", zone: "us-central1-b", name });
  assert.deepEqual(await compute.getStatus(ref("adaceen-worker-v100")), { ok: true, vmStatus: "TERMINATED" });
  assert.deepEqual(await compute.getStatus(ref("otra")), { ok: false, reason: "instances.get HTTP 404" });
  const exhausted = await compute.start(ref("adaceen-worker-v100"));
  assert.equal(exhausted.accepted, false);
  assert.equal(exhausted.accepted === false && exhausted.capacity, true);
  assert.match(exhausted.accepted === false ? exhausted.reason : "", /^instances\.start HTTP 403 \(ZONE_RESOURCE_POOL_EXHAUSTED: The zone/);
  const denied = await compute.start(ref("adaceen-worker-a100"));
  assert.deepEqual(denied, { accepted: false, reason: "instances.start HTTP 403 (forbidden: Required 'compute.instances.start' permission)", capacity: false });
  assert.deepEqual(await compute.start(ref("adaceen-worker")), { accepted: true });

  // Red caida o token fallido: motivo, nunca una excepcion.
  const down = createComputeClient({ getAccessToken: async () => { throw new Error("invalid_grant"); }, fetch: async () => json(200, {}) });
  assert.match((await down.start(ref("adaceen-worker"))).accepted ? "" : (await down.start(ref("adaceen-worker")) as { reason: string }).reason, /invalid_grant/);
});

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
  assert.deepEqual(resolveVmAutostartConfig({}), { config: null, problem: "", warning: "" });
  assert.deepEqual(resolveVmAutostartConfig({ mode: "off" }), { config: null, problem: "", warning: "" });
  assert.match(resolveVmAutostartConfig({ mode: "aws" }).problem, /no es valido/);
  const missing = resolveVmAutostartConfig({ mode: "gcp", project: "adaceen-piloto", zone: "us-central1-a" });
  assert.equal(missing.config, null);
  assert.match(missing.problem, /WORKSPACE_VM_NAME/);
  assert.match(missing.problem, /GCP_SERVICE_ACCOUNT_JSON/);
  assert.doesNotMatch(missing.problem, /PRIVATE KEY/, "el aviso no muestra la clave");
  const ok = resolveVmAutostartConfig({ mode: "GCP", project: "adaceen-piloto", zone: "us-central1-a", name: "adaceen-ws", credentialsJson: JSON.stringify(KEY) });
  assert.equal(ok.problem, "");
  assert.equal(ok.config?.name, "adaceen-ws");
  assert.equal(ok.config?.federation, undefined);
  assert.equal(ok.warning, "");
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

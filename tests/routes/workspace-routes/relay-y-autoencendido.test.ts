import assert from "node:assert/strict";
import test from "node:test";
import { createVmAutostarter } from "../../../src/services/infra/gcp-compute.js";
import { createWorkspaceRelay } from "../../../src/services/workspace/workspace-relay.js";
import type { FetchLike } from "../../../src/services/workspace/workspace-config.js";
import {
  AGENT_TOKEN,
  REPO,
  TUNNEL_CONFIG,
  jsonResponse,
  fakeAgent,
  githubLoginReader,
  startServer,
  stopServer,
  callApi,
  statusPath,
} from "./helpers.js";

test("workspaces: modo relay (VM sin IP publica): el agente recoge la peticion por HTTPS de salida", async () => {
  const relay = createWorkspaceRelay({ staleAfterMs: 5_000 });
  const started = await startServer({
    config: { ...TUNNEL_CONFIG, transport: "relay", agentUrl: "", agentTimeoutMs: 5_000 },
    readGithubLogin: githubLoginReader,
    relay,
    publicBaseUrl: "https://adaceen.prueba",
  });
  // relay.mjs es JavaScript del agente de la VM: se carga tal cual corre alla.
  const relayModule = "../../../deploy/gcp/workspaces/agente/relay.mjs";
  const { crearClienteRelay } = await import(relayModule);
  let client: { iniciar: () => Promise<void>; detener: () => Promise<void> } | null = null;
  try {
    // Sin agente conectado: error legible de inmediato, sin esperar el timeout.
    const offline = await callApi(started.baseUrl, "/api/workspaces/prepare", {
      sessionId: started.session.id,
      body: { repoFullName: REPO },
    });
    assert.equal(offline.body.status, "error");
    assert.equal(offline.body.code, "agent_unreachable");

    const wrongToken = await fetch(`${started.baseUrl}/api/workspaces/agent/next?wait=0`, { headers: { "x-agent-token": "otro-token" } });
    assert.equal(wrongToken.status, 401, "solo el agente con WORKSPACE_AGENT_TOKEN recoge trabajos");

    const localCalls: Array<{
      url: string;
      method: string;
      token: string | null;
      body: { login?: string; editorSession?: { sessionId: string; backendUrl: string; userEmail: string } } | null;
    }> = [];
    const fetchImpl: FetchLike = async (url, init) => {
      if (url.startsWith("http://agente.local")) {
        localCalls.push({
          url,
          method: init?.method || "GET",
          token: new Headers(init?.headers).get("x-agent-token"),
          body: typeof init?.body === "string" ? JSON.parse(init.body) : null,
        });
        return jsonResponse(200, {
          state: "device_code",
          deviceCode: "ABCD-1234",
          verificationUrl: "https://github.com/login/device",
          tunnelName: "ad-estudiante-gh",
        });
      }
      return fetch(url, init);
    };
    client = crearClienteRelay({
      relayUrl: `${started.baseUrl}/api/workspaces/agent`,
      token: AGENT_TOKEN,
      destino: "http://agente.local",
      esperaS: 2,
      fetchImpl,
    });
    void client!.iniciar();
    for (let attempt = 0; attempt < 100 && !relay.isAgentOnline(); attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 20));
    }

    const prepare = await callApi(started.baseUrl, "/api/workspaces/prepare", {
      sessionId: started.session.id,
      body: { repoFullName: REPO },
    });
    assert.equal(prepare.status, 200);
    assert.equal(prepare.body.status, "device_code");
    assert.equal(prepare.body.deviceCode?.userCode, "ABCD-1234");
    assert.deepEqual(localCalls.map((call) => [call.method, call.url, call.token]), [["POST", "http://agente.local/workspaces", AGENT_TOKEN]]);
    assert.equal(localCalls[0].body?.login, "estudiante-gh");
    // La sesion del editor viaja por el relay igual que por HTTP directo.
    const relayed = localCalls[0].body?.editorSession;
    assert.ok(relayed, "el agente recibe editorSession por el relay");
    assert.equal(relayed.backendUrl, "https://adaceen.prueba");
    assert.equal(relayed.userEmail, "estudiante@adaceen.edu.co");
    const relayedSession = await started.database.getSession(relayed.sessionId);
    assert.equal(relayedSession?.kind, "editor");
    assert.equal(relayedSession?.label, "tunnel");

    const agentStatus = await fetch(`${started.baseUrl}/api/workspaces/agent/status`, { headers: { "x-agent-token": AGENT_TOKEN } })
      .then((response) => response.json()) as { transport: string; relay: { online: boolean } };
    assert.equal(agentStatus.transport, "relay");
    assert.equal(agentStatus.relay.online, true);
  } finally {
    await client?.detener();
    relay.close();
    await stopServer(started.server, started.database);
  }
});

test("workspaces: backendUrl de la peticion (x-forwarded-*) y sesion del tunel nueva si le quedan menos de 7 dias", async () => {
  const agent = fakeAgent(() => jsonResponse(200, { state: "ready" }));
  const { server, database, session, baseUrl } = await startServer({
    config: TUNNEL_CONFIG,
    fetch: agent.fetchImpl,
    readGithubLogin: githubLoginReader,
    publicBaseUrl: "",
    // Vigencia corta (3 dias): nunca le quedan 7, asi que cada prepare crea otra.
    editorSessionTtlMs: 3 * 24 * 60 * 60 * 1000,
  });
  try {
    await callApi(baseUrl, "/api/workspaces/prepare", {
      sessionId: session.id,
      body: { repoFullName: REPO },
      headers: { "x-forwarded-proto": "https", "x-forwarded-host": "adaceen.ejemplo.edu.co" },
    });
    await callApi(baseUrl, "/api/workspaces/prepare", { sessionId: session.id, body: { repoFullName: REPO } });
    // Con la cookie sola (sin x-session-id) no se manda sesion del editor.
    await callApi(baseUrl, "/api/workspaces/prepare", {
      body: { repoFullName: REPO },
      headers: { Cookie: `adaceen_session_id=${session.id}`, "x-forwarded-host": "evil.example" },
    });
    assert.equal(agent.calls.length, 3);
    assert.equal((agent.calls[2].body as { editorSession?: unknown }).editorSession, undefined);
    const bodies = agent.calls.map((call) => call.body as { editorSession: { sessionId: string; backendUrl: string; expiresAt: string } });
    assert.equal(bodies[0].editorSession.backendUrl, "https://adaceen.ejemplo.edu.co");
    assert.equal(bodies[1].editorSession.backendUrl, baseUrl, "sin PUBLIC_BASE_URL ni x-forwarded: la URL de la peticion");
    assert.notEqual(bodies[0].editorSession.sessionId, bodies[1].editorSession.sessionId);
    const days = (Date.parse(bodies[1].editorSession.expiresAt) - Date.now()) / (24 * 60 * 60 * 1000);
    assert.ok(days > 2.9 && days <= 3, `vence en 3 dias (${days})`);
    // La sesion anterior sigue activa: VS Code del tunel no se queda sin sesion mientras la VM reescribe el archivo.
    assert.ok(await database.getSession(bodies[0].editorSession.sessionId));
  } finally {
    await stopServer(server, database);
  }
});

test("workspaces: sin x-forwarded-proto, un backendUrl fuera de localhost sale en https (el agente rechaza http)", async () => {
  const agent = fakeAgent(() => jsonResponse(200, { state: "ready" }));
  const { server, database, session, baseUrl } = await startServer({
    config: TUNNEL_CONFIG,
    fetch: agent.fetchImpl,
    readGithubLogin: githubLoginReader,
    publicBaseUrl: "",
  });
  try {
    // Detras del proxy de Azure sin x-forwarded-proto: la peticion llega como http.
    await callApi(baseUrl, "/api/workspaces/prepare", {
      sessionId: session.id,
      body: { repoFullName: REPO },
      headers: { "x-forwarded-host": "app-adaceen.azurewebsites.net" },
    });
    // Un puerto propio no se toca (no se sabe si ahi hay https).
    await callApi(baseUrl, "/api/workspaces/prepare", {
      sessionId: session.id,
      body: { repoFullName: REPO },
      headers: { "x-forwarded-host": "10.0.0.5:3000" },
    });
    const urls = agent.calls.map((call) => (call.body as { editorSession?: { backendUrl?: string } }).editorSession?.backendUrl);
    assert.deepEqual(urls, ["https://app-adaceen.azurewebsites.net", "http://10.0.0.5:3000"]);
  } finally {
    await stopServer(server, database);
  }
});

test("workspaces: agente desconectado -> retryable; el siguiente status reenvia el prepare cuando vuelve", async () => {
  let agentUp = false;
  const agent = fakeAgent((call) => {
    if (!agentUp) throw new TypeError("fetch failed: connect ECONNREFUSED 10.128.0.5:8787");
    return jsonResponse(200, call.method === "POST"
      ? { state: "pending", message: "Clonando el repositorio..." }
      : { state: "ready" });
  });
  const { server, database, session, baseUrl } = await startServer({
    config: TUNNEL_CONFIG,
    fetch: agent.fetchImpl,
    readGithubLogin: githubLoginReader,
    publicBaseUrl: "https://adaceen.prueba",
  });
  try {
    const down = await callApi(baseUrl, "/api/workspaces/prepare", { sessionId: session.id, body: { repoFullName: REPO } });
    assert.equal(down.body.code, "agent_unreachable");
    assert.equal(down.body.retryable, true);

    // La extension 0.7.11 sigue consultando; mientras el agente no vuelve, sigue igual.
    const stillDown = await callApi(baseUrl, statusPath, { sessionId: session.id });
    assert.equal(stillDown.body.code, "agent_unreachable");
    assert.deepEqual(agent.calls.map((call) => call.method), ["POST", "POST"], "status reintenta el POST que no llego");

    agentUp = true;
    const redispatched = await callApi(baseUrl, statusPath, { sessionId: session.id });
    assert.equal(redispatched.body.ok, true);
    assert.equal(redispatched.body.status, "pending");
    const lastPost = agent.calls.at(-1);
    assert.equal(lastPost?.method, "POST");
    assert.equal((lastPost?.body as { force?: boolean; editorSession?: unknown }).force, false);
    assert.ok((lastPost?.body as { editorSession?: unknown }).editorSession, "el reenvio lleva la sesion del editor");

    const ready = await callApi(baseUrl, statusPath, { sessionId: session.id });
    assert.equal(ready.body.status, "ready");
    assert.equal(agent.calls.at(-1)?.method, "GET", "ya entregado: status vuelve a consultar con GET");

    const failed = await database.listBehaviorEventsForViewer({ viewer: session.user, eventType: "prepare_environment_failed" });
    assert.equal(failed.length, 1, "el fallo transitorio se registra una sola vez");
    const readyEvents = await database.listBehaviorEventsForViewer({ viewer: session.user, eventType: "tunnel_workspace_ready" });
    assert.equal(readyEvents.length, 1, "y el listo posterior tambien queda registrado");

    // En el dataset seudonimizado (telemetry_events) la espera se distingue de un fallo terminal.
    const telemetry = await database.listTelemetryEvents();
    const transient = telemetry.find((row) => row.eventType === "prepare_environment_failed");
    assert.equal(transient?.metadata.retryable, true, "metadata.retryable pasa la lista blanca");
    assert.equal(transient?.metadata.reason, "agent_unreachable");
    const readyRow = telemetry.find((row) => row.eventType === "tunnel_workspace_ready");
    assert.equal(readyRow?.metadata.reason, "agent_unreachable", "el listo dice que llego tras una espera");
  } finally {
    await stopServer(server, database);
  }
});

test("workspaces: autoencendido de la VM (fetch falso de Compute) -> pending vm_starting y luego listo", async () => {
  let vmStatus = "TERMINATED";
  let agentUp = false;
  const computeCalls: string[] = [];
  const autostart = createVmAutostarter(
    { project: "adaceen-piloto", zone: "us-central1-a", name: "adaceen-ws", credentialsJson: "" },
    {
      getAccessToken: async () => "token-de-compute",
      fetch: async (url, init) => {
        computeCalls.push(`${init?.method || "GET"} ${url}`);
        if (url.endsWith("/start")) {
          vmStatus = "STAGING";
          return jsonResponse(200, { kind: "compute#operation", status: "RUNNING" });
        }
        return jsonResponse(200, { name: "adaceen-ws", status: vmStatus });
      },
      checkCacheMs: 0,
    },
  );
  const agent = fakeAgent((call) => {
    if (!agentUp) throw new TypeError("fetch failed: connect EHOSTUNREACH");
    return jsonResponse(200, call.method === "POST" ? { state: "ready" } : { state: "ready" });
  });
  const { server, database, session, baseUrl } = await startServer({
    config: TUNNEL_CONFIG,
    fetch: agent.fetchImpl,
    readGithubLogin: githubLoginReader,
    publicBaseUrl: "https://adaceen.prueba",
    autostart,
  });
  try {
    const starting = await callApi(baseUrl, "/api/workspaces/prepare", { sessionId: session.id, body: { repoFullName: REPO } });
    assert.equal(starting.status, 200);
    assert.equal(starting.body.ok, true, "encendiendo no es un error");
    assert.equal(starting.body.status, "pending");
    assert.equal(starting.body.code, "vm_starting");
    assert.equal(starting.body.retryable, true);
    assert.match(starting.body.message || "", /Encendiendo la VM de editores/);
    assert.equal(starting.body.error, undefined);
    assert.deepEqual(computeCalls, [
      "GET https://compute.googleapis.com/compute/v1/projects/adaceen-piloto/zones/us-central1-a/instances/adaceen-ws",
      "POST https://compute.googleapis.com/compute/v1/projects/adaceen-piloto/zones/us-central1-a/instances/adaceen-ws/start",
    ]);

    // Sigue arrancando: no se pide otro start.
    const stillStarting = await callApi(baseUrl, statusPath, { sessionId: session.id });
    assert.equal(stillStarting.body.code, "vm_starting");
    assert.equal(computeCalls.filter((call) => call.startsWith("POST")).length, 1);

    vmStatus = "RUNNING";
    agentUp = true;
    const ready = await callApi(baseUrl, statusPath, { sessionId: session.id });
    assert.equal(ready.body.status, "ready");
    assert.equal(agent.calls.filter((call) => call.method === "POST").length, 3, "el prepare se reenvio al volver la VM");

    const failed = await database.listBehaviorEventsForViewer({ viewer: session.user, eventType: "prepare_environment_failed" });
    assert.equal(failed.length, 0, "encender la VM no cuenta como fallo");
  } finally {
    await stopServer(server, database);
  }
});

test("workspaces: WORKSPACE_ALLOWED_LOGINS=* deja pasar a cualquier estudiante con GitHub conectado", async () => {
  const agent = fakeAgent(() => jsonResponse(200, { state: "ready" }));
  const { server, database, session, baseUrl } = await startServer({
    config: { ...TUNNEL_CONFIG, allowedLogins: ["*"] },
    fetch: agent.fetchImpl,
    readGithubLogin: githubLoginReader,
    publicBaseUrl: "https://adaceen.prueba",
  });
  try {
    const prepare = await callApi(baseUrl, "/api/workspaces/prepare", { sessionId: session.id, body: { repoFullName: REPO } });
    assert.equal(prepare.status, 200);
    assert.equal(prepare.body.status, "ready");
    assert.equal(agent.calls.length, 1);
  } finally {
    await stopServer(server, database);
  }
});

test("workspaces: consultas simultaneas mientras se reenvia el prepare comparten un solo POST", async () => {
  let agentUp = false;
  const agent = fakeAgent(async () => {
    if (!agentUp) throw new TypeError("fetch failed: connect ECONNREFUSED");
    await new Promise((resolve) => setTimeout(resolve, 400));
    return jsonResponse(200, { state: "pending", message: "Clonando el repositorio..." });
  });
  const { server, database, session, baseUrl } = await startServer({
    config: { ...TUNNEL_CONFIG, agentTimeoutMs: 2_000 },
    fetch: agent.fetchImpl,
    readGithubLogin: githubLoginReader,
    publicBaseUrl: "https://adaceen.prueba",
  });
  try {
    await callApi(baseUrl, "/api/workspaces/prepare", { sessionId: session.id, body: { repoFullName: REPO } });
    assert.equal(agent.calls.length, 1);
    agentUp = true;
    const results = await Promise.all([1, 2, 3].map(() => callApi(baseUrl, statusPath, { sessionId: session.id })));
    assert.ok(results.every((result) => result.body.status === "pending"));
    assert.deepEqual(agent.calls.map((call) => call.method), ["POST", "POST"], "un solo reenvio para las tres consultas");
  } finally {
    await stopServer(server, database);
  }
});

test("relay: una peticion que el agente nunca recogio vence como unreachable (no se perdio en silencio)", async () => {
  const relay = createWorkspaceRelay({ staleAfterMs: 60_000 });
  try {
    // El agente sondeo hace poco (cuenta como conectado) pero ya no vuelve.
    assert.deepEqual(await relay.nextJobs(0), []);
    assert.equal(relay.isAgentOnline(), true);
    const lost = await relay.request("POST", "/workspaces", { login: "estudiante-gh" }, 50);
    assert.equal(lost.kind, "unreachable");
    assert.equal(relay.status().pending, 0, "sale de la cola: el agente no la recoge tarde");
    assert.equal(relay.status().waiting, 0);

    // Recogida y sin respuesta: eso si es timeout (pudo llegar al agente).
    const pending = relay.request("GET", "/workspaces/estudiante-gh", undefined, 80);
    const jobs = await relay.nextJobs(0);
    assert.equal(jobs.length, 1);
    assert.equal((await pending).kind, "timeout");
  } finally {
    relay.close();
  }
});

test("workspaces: modo relay con el agente caido hace poco -> el prepare se reenvia cuando vuelve (no not_found)", async () => {
  const relay = createWorkspaceRelay({ staleAfterMs: 60_000 });
  const { server, database, session, baseUrl } = await startServer({
    config: { ...TUNNEL_CONFIG, transport: "relay", agentUrl: "", agentTimeoutMs: 150 },
    readGithubLogin: githubLoginReader,
    relay,
    publicBaseUrl: "https://adaceen.prueba",
  });
  // El agente responde un trabajo: POST -> pending; GET -> not_found si nunca recibio el POST.
  const received: Array<{ method: string; path: string; force?: boolean }> = [];
  async function serveOne() {
    const jobs = await relay.nextJobs(2_000);
    relay.respond(jobs.map((job) => {
      const body = job.body as { force?: boolean } | undefined;
      received.push({ method: job.method, path: job.path, force: body?.force });
      const knowsStudent = received.some((item) => item.method === "POST");
      return job.method === "POST"
        ? { id: job.id, status: 200, json: { state: "pending", message: "Clonando el repositorio..." } }
        : knowsStudent
          ? { id: job.id, status: 200, json: { state: "ready" } }
          : { id: job.id, status: 404, json: { state: "error", code: "not_found", message: "Todavia no hay un editor preparado para esta cuenta." } };
    }));
  }
  try {
    // Sondeo reciente y luego nada: el relay cree que el agente sigue conectado.
    await relay.nextJobs(0);
    const lost = await callApi(baseUrl, "/api/workspaces/prepare", { sessionId: session.id, body: { repoFullName: REPO, force: true } });
    assert.equal(lost.body.status, "error");
    assert.equal(lost.body.code, "agent_unreachable", "nunca salio de la cola");
    assert.equal(lost.body.retryable, true);

    // El agente vuelve: el siguiente status reenvia el POST (con el force original, que no llego).
    const [redispatched] = await Promise.all([callApi(baseUrl, statusPath, { sessionId: session.id }), serveOne()]);
    assert.equal(redispatched.body.ok, true);
    assert.equal(redispatched.body.status, "pending");
    assert.deepEqual(received, [{ method: "POST", path: "/workspaces", force: true }]);

    const [ready] = await Promise.all([callApi(baseUrl, statusPath, { sessionId: session.id }), serveOne()]);
    assert.equal(ready.body.status, "ready");
    assert.equal(received.at(-1)?.method, "GET");
  } finally {
    relay.close();
    await stopServer(server, database);
  }
});

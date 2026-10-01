import assert from "node:assert/strict";
import test from "node:test";
import type { Server } from "node:http";
import express from "express";
import { createDatabase, type AppDatabase } from "../../src/db/database.js";
import { registerHealthRoutes } from "../../src/routes/health-routes.js";
import { registerWorkspaceRoutes, type WorkspaceRouteDeps } from "../../src/routes/workspace-routes.js";
import { createVmAutostarter } from "../../src/services/gcp-compute.js";
import { createWorkspaceRelay } from "../../src/services/workspace-relay.js";
import { forgetWorkspaceProviderChoice, readWorkspaceProviderChoice } from "../../src/services/workspace-provider-choice.js";
import {
  buildTunnelName,
  buildTunnelWebUrl,
  mapAgentResult,
  normalizeRepoFullName,
  normalizeWorkspaceLogin,
  type FetchLike,
  type WorkspaceConfig,
} from "../../src/services/workspace-provider.js";

const AGENT_URL = "http://agente.prueba:8787";
const AGENT_TOKEN = "token-agente-de-prueba-0123456789";
const GITHUB_TOKEN = "gho_token_de_prueba";
const REPO = "Univalle-ADACEEN/Proyecto-Final";

const TUNNEL_CONFIG: WorkspaceConfig = {
  provider: "tunnel",
  transport: "direct",
  agentUrl: AGENT_URL,
  agentToken: AGENT_TOKEN,
  agentTimeoutMs: 300,
  allowedLogins: [],
  githubApiBaseUrl: "https://api.github.invalid",
};

type AgentCall = {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: unknown;
};

function jsonResponse(status: number, body: unknown) {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

// Agente falso: registra las llamadas y responde lo que diga el caso.
function fakeAgent(handler: (call: AgentCall) => Response | Promise<Response>) {
  const calls: AgentCall[] = [];
  const fetchImpl: FetchLike = async (url, init) => {
    const call: AgentCall = {
      url,
      method: init?.method || "GET",
      headers: Object.fromEntries(new Headers(init?.headers).entries()),
      body: typeof init?.body === "string" ? JSON.parse(init.body) : null,
    };
    calls.push(call);
    return handler(call);
  };
  return { calls, fetchImpl };
}

const githubLoginReader = async (accessToken: string) => {
  assert.equal(accessToken, GITHUB_TOKEN, "el login sale del token OAuth guardado del estudiante");
  return "Estudiante-GH";
};

// Por defecto GitHub ve el repositorio y es publico (0.7.20): sin token de clon y
// sin una llamada extra al fetch falso del agente. Los casos de repos privados o
// sin acceso pasan su propio lector.
const publicRepoReader = async (_token: string, repoFullName: string) => ({ state: "visible" as const, private: false, fullName: repoFullName });

async function startServer(deps: WorkspaceRouteDeps, options: { connectGithub?: boolean; health?: boolean } = {}) {
  const database = await createDatabase();
  const app = express();
  app.use(express.json());
  if (options.health) registerHealthRoutes(app, database);
  registerWorkspaceRoutes(app, database, { readGithubRepoAccess: publicRepoReader, ...deps });
  const server = await new Promise<Server>((resolve) => {
    const started = app.listen(0, () => resolve(started));
  });
  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("No se pudo iniciar servidor de prueba.");
  }
  const session = await database.authenticateUser("estudiante@adaceen.edu.co", "Estudiante123!");
  assert.ok(session, "el estudiante sembrado debe poder iniciar sesion");
  if (options.connectGithub !== false) {
    await database.upsertGithubUserToken({
      userId: session.user.id,
      accountLogin: "Estudiante-GH",
      accessToken: GITHUB_TOKEN,
      scopes: "repo read:user",
    });
  }
  return {
    database,
    server,
    session,
    baseUrl: `http://127.0.0.1:${address.port}`,
  };
}

async function stopServer(server: Server, database: AppDatabase) {
  await new Promise<void>((resolve, reject) => {
    server.close((error) => error ? reject(error) : resolve());
  });
  await database.close();
}

type WorkspaceBody = {
  ok?: boolean;
  provider?: string;
  status?: string;
  code?: string;
  message?: string;
  error?: string;
  retryable?: boolean;
  agentConfigured?: boolean;
  workspace?: { login?: string; tunnelName?: string; webUrl?: string; repoFullName?: string };
  deviceCode?: { userCode?: string; verificationUrl?: string; expiresAt?: string | null };
};

async function callApi(baseUrl: string, path: string, options: { sessionId?: string; body?: unknown; headers?: Record<string, string> } = {}) {
  const response = await fetch(`${baseUrl}${path}`, {
    method: options.body === undefined ? "GET" : "POST",
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      ...(options.sessionId ? { "x-session-id": options.sessionId } : {}),
      ...(options.headers || {}),
    },
    body: options.body === undefined ? undefined : JSON.stringify(options.body),
  });
  return { status: response.status, body: await response.json() as WorkspaceBody };
}

const statusPath = `/api/workspaces/status?repoFullName=${encodeURIComponent(REPO)}`;

test("workspaces: login, repo, nombre del tunel y URL siguen la regla de nuevo-tunel.sh", () => {
  assert.equal(normalizeWorkspaceLogin("EyderSantiago"), "eydersantiago");
  assert.equal(normalizeWorkspaceLogin("eyder@correounivalle.edu.co"), "");
  assert.equal(normalizeWorkspaceLogin("a".repeat(29)), "");
  assert.equal(normalizeWorkspaceLogin("-guion"), "");
  assert.equal(normalizeRepoFullName("owner/repo.git"), "owner/repo");
  assert.equal(normalizeRepoFullName(" Owner-1/Repo_2.x "), "Owner-1/Repo_2.x");
  assert.equal(normalizeRepoFullName("owner/.."), "");
  assert.equal(normalizeRepoFullName("owner/repo/extra"), "");
  assert.equal(normalizeRepoFullName("https://github.com/owner/repo"), "");
  assert.equal(buildTunnelName("abcdefghijklmnopqrstuvwxyz"), "ad-abcdefghijklmnopq");
  assert.equal(buildTunnelWebUrl("eyder"), "https://vscode.dev/tunnel/ad-eyder/home/ws-eyder/proyecto");

  // Defensa en profundidad: una webUrl ajena o un codigo raro no llegan al estudiante.
  const mapped = mapAgentResult(
    { kind: "response", status: 200, json: { state: "ready", tunnelName: "ad-eyder", webUrl: "https://evil.example/tunnel/ad-eyder/x" } },
    { login: "eyder", repoFullName: "eyder/p" },
  );
  assert.equal(mapped.workspace.webUrl, "https://vscode.dev/tunnel/ad-eyder/home/ws-eyder/proyecto");
  const weirdCode = mapAgentResult(
    { kind: "response", status: 200, json: { state: "device_code", deviceCode: "<script>" } },
    { login: "eyder", repoFullName: "eyder/p" },
  );
  assert.equal(weirdCode.status, "pending");
  assert.equal(weirdCode.deviceCode, undefined);
});

test("workspaces: proveedor codespaces -> provider publico y 409 en prepare/status", async () => {
  const agent = fakeAgent(() => jsonResponse(500, {}));
  const { server, database, session, baseUrl } = await startServer({
    config: { ...TUNNEL_CONFIG, provider: "codespaces" },
    fetch: agent.fetchImpl,
    readGithubLogin: githubLoginReader,
  });
  try {
    const provider = await callApi(baseUrl, "/api/workspaces/provider");
    assert.equal(provider.status, 200);
    assert.deepEqual(provider.body, { ok: true, provider: "codespaces" });

    const noSession = await callApi(baseUrl, "/api/workspaces/prepare", { body: { repoFullName: REPO } });
    assert.equal(noSession.status, 401);

    const prepare = await callApi(baseUrl, "/api/workspaces/prepare", { sessionId: session.id, body: { repoFullName: REPO } });
    assert.equal(prepare.status, 409);
    assert.equal(prepare.body.provider, "codespaces");
    assert.equal(prepare.body.code, "provider_codespaces");
    assert.match(prepare.body.message || "", /Codespaces/);
    assert.equal(prepare.body.error, prepare.body.message);

    const status = await callApi(baseUrl, statusPath, { sessionId: session.id });
    assert.equal(status.status, 409);
    assert.equal(agent.calls.length, 0, "con Codespaces no se llama al agente");
  } finally {
    await stopServer(server, database);
  }
});

test("workspaces: proveedor tunnel, sesion obligatoria y validaciones previas al agente", async () => {
  const agent = fakeAgent(() => jsonResponse(500, {}));
  const { server, database, session, baseUrl } = await startServer({
    config: TUNNEL_CONFIG,
    fetch: agent.fetchImpl,
    readGithubLogin: githubLoginReader,
  }, { connectGithub: false });
  try {
    const provider = await callApi(baseUrl, "/api/workspaces/provider");
    assert.deepEqual(provider.body, { ok: true, provider: "tunnel", agentConfigured: true });

    assert.equal((await callApi(baseUrl, statusPath)).status, 401);
    assert.equal((await callApi(baseUrl, "/api/workspaces/prepare", { body: { repoFullName: REPO } })).status, 401);

    const badRepo = await callApi(baseUrl, "/api/workspaces/prepare", { sessionId: session.id, body: { repoFullName: "no-es-un-repo" } });
    assert.equal(badRepo.status, 400);
    assert.equal(badRepo.body.status, "error");
    assert.equal((await callApi(baseUrl, "/api/workspaces/status", { sessionId: session.id })).status, 400);

    const noGithub = await callApi(baseUrl, "/api/workspaces/prepare", { sessionId: session.id, body: { repoFullName: REPO } });
    assert.equal(noGithub.status, 409);
    assert.equal(noGithub.body.code, "github_not_connected");
    assert.match(noGithub.body.error || "", /GitHub/);
    assert.equal(agent.calls.length, 0);
  } finally {
    await stopServer(server, database);
  }
});

test("workspaces: login fuera de la lista del piloto -> 403 sin llamar al agente", async () => {
  const agent = fakeAgent(() => jsonResponse(200, { state: "ready" }));
  const { server, database, session, baseUrl } = await startServer({
    config: { ...TUNNEL_CONFIG, allowedLogins: ["Otro-Estudiante", "eydersantiago"] },
    fetch: agent.fetchImpl,
    readGithubLogin: githubLoginReader,
  });
  try {
    const prepare = await callApi(baseUrl, "/api/workspaces/prepare", { sessionId: session.id, body: { repoFullName: REPO } });
    assert.equal(prepare.status, 403);
    assert.equal(prepare.body.status, "error");
    assert.equal(prepare.body.code, "login_not_allowed");
    assert.equal(prepare.body.workspace?.login, "estudiante-gh");
    assert.match(prepare.body.message || "", /estudiante-gh/);

    const status = await callApi(baseUrl, statusPath, { sessionId: session.id });
    assert.equal(status.status, 403);
    assert.equal(agent.calls.length, 0);
    const editorSessions = await database.pool.query(`select id from app_sessions where kind = 'editor'`);
    assert.equal(editorSessions.rows.length, 0, "no se crean sesiones de editor para quien no puede preparar");

    const failed = await database.listBehaviorEventsForViewer({ viewer: session.user, eventType: "prepare_environment_failed" });
    assert.equal(failed.length, 1);
    assert.match(failed[0].value || "", /login_not_allowed/);
  } finally {
    await stopServer(server, database);
  }
});

test("workspaces: device_code en prepare, luego ready en status (y eventos de comportamiento)", async () => {
  const expiresAt = new Date(Date.now() + 14 * 60 * 1000).toISOString();
  let tunnelReady = false;
  const agent = fakeAgent((call) => {
    const common = {
      login: "estudiante-gh",
      tunnelName: "ad-estudiante-gh",
      webUrl: "https://vscode.dev/tunnel/ad-estudiante-gh/home/ws-estudiante-gh/proyecto",
      repo: REPO,
    };
    if (call.method === "POST") {
      return jsonResponse(200, {
        ...common,
        state: "device_code",
        deviceCode: "WDJB-MJHT",
        verificationUrl: "https://github.com/login/device",
        expiresAt,
        message: "Autoriza el editor en GitHub con este codigo (solo la primera vez).",
      });
    }
    return jsonResponse(200, tunnelReady ? { ...common, state: "ready" } : { ...common, state: "pending", message: "Arrancando el tunel..." });
  });
  const { server, database, session, baseUrl } = await startServer({
    config: { ...TUNNEL_CONFIG, allowedLogins: ["estudiante-gh"] },
    fetch: agent.fetchImpl,
    readGithubLogin: githubLoginReader,
    publicBaseUrl: "https://adaceen.prueba",
  });
  try {
    const prepare = await callApi(baseUrl, "/api/workspaces/prepare", { sessionId: session.id, body: { repoFullName: REPO } });
    assert.equal(prepare.status, 200);
    assert.equal(prepare.body.ok, true);
    assert.equal(prepare.body.provider, "tunnel");
    assert.equal(prepare.body.status, "device_code");
    assert.deepEqual(prepare.body.deviceCode, {
      userCode: "WDJB-MJHT",
      verificationUrl: "https://github.com/login/device",
      expiresAt,
    });
    assert.deepEqual(prepare.body.workspace, {
      login: "estudiante-gh",
      tunnelName: "ad-estudiante-gh",
      webUrl: "https://vscode.dev/tunnel/ad-estudiante-gh/home/ws-estudiante-gh/proyecto",
      repoFullName: REPO,
    });

    // Llamada exacta al agente: URL, token y cuerpo {login, repo, force, editorSession}.
    assert.equal(agent.calls.length, 1);
    assert.equal(agent.calls[0].url, `${AGENT_URL}/workspaces`);
    assert.equal(agent.calls[0].method, "POST");
    assert.equal(agent.calls[0].headers["x-agent-token"], AGENT_TOKEN);
    const firstBody = agent.calls[0].body as { editorSession?: { sessionId: string; expiresAt: string } };
    const editorSession = firstBody.editorSession;
    assert.ok(editorSession, "prepare manda la sesion del editor");
    assert.deepEqual(agent.calls[0].body, {
      login: "estudiante-gh",
      repo: REPO,
      force: false,
      editorSession: {
        sessionId: editorSession.sessionId,
        backendUrl: "https://adaceen.prueba",
        expiresAt: editorSession.expiresAt,
        userName: session.user.displayName,
        userEmail: "estudiante@adaceen.edu.co",
      },
    });
    const written = await database.getSession(editorSession.sessionId);
    assert.equal(written?.kind, "editor");
    assert.equal(written?.label, "tunnel");
    assert.equal(written?.user.id, session.user.id);
    assert.equal(written?.expiresAt, editorSession.expiresAt);
    assert.ok(await database.getSession(session.id), "la sesion del navegador sigue viva");
    assert.equal(JSON.stringify(prepare.body).includes(editorSession.sessionId), false, "la sesion no vuelve al navegador");

    const pending = await callApi(baseUrl, statusPath, { sessionId: session.id });
    assert.equal(pending.status, 200);
    assert.equal(pending.body.status, "pending");
    // 0.7.20: el estado se pide para el repositorio de la pagina.
    assert.equal(agent.calls[1].url, `${AGENT_URL}/workspaces/estudiante-gh?repo=${encodeURIComponent(REPO)}`);
    assert.equal(agent.calls[1].method, "GET");

    tunnelReady = true;
    const ready = await callApi(baseUrl, statusPath, { sessionId: session.id });
    assert.equal(ready.status, 200);
    assert.equal(ready.body.ok, true);
    assert.equal(ready.body.status, "ready");
    assert.equal(ready.body.workspace?.webUrl, "https://vscode.dev/tunnel/ad-estudiante-gh/home/ws-estudiante-gh/proyecto");
    assert.equal(ready.body.deviceCode, undefined);

    const events = await database.listBehaviorEventsForViewer({ viewer: session.user, category: "codespace" });
    const types = events.map((event) => event.eventType).sort();
    assert.deepEqual(types, ["prepare_environment_started", "tunnel_workspace_device_code", "tunnel_workspace_ready"]);

    // force llega al agente tal cual, y la sesion del tunel se reutiliza (le quedan mas de 7 dias).
    await callApi(baseUrl, "/api/workspaces/prepare", { sessionId: session.id, body: { repoFullName: REPO, force: true } });
    assert.deepEqual(agent.calls.at(-1)?.body, { login: "estudiante-gh", repo: REPO, force: true, editorSession });
  } finally {
    await stopServer(server, database);
  }
});

test("workspaces: agente caido, lento o que rechaza -> status error legible, nunca 500 sin cuerpo", async () => {
  let mode: "down" | "slow" | "unauthorized" | "mismatch" | "boom" = "down";
  const fetchImpl: FetchLike = (_url, init) => {
    if (mode === "down") {
      return Promise.reject(new TypeError("fetch failed: connect ECONNREFUSED 10.128.0.5:8787"));
    }
    if (mode === "slow") {
      return new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => {
          reject(Object.assign(new Error("This operation was aborted"), { name: "AbortError" }));
        });
      });
    }
    if (mode === "unauthorized") {
      return Promise.resolve(jsonResponse(401, { state: "error", code: "unauthorized", message: "Token del agente invalido o ausente." }));
    }
    if (mode === "mismatch") {
      return Promise.resolve(jsonResponse(409, {
        state: "error",
        code: "repo_mismatch",
        message: "Tu editor ya tiene clonado otro/repo. Para cambiarlo usa la opcion de rehacer el entorno.",
      }));
    }
    return Promise.resolve(new Response("<html>502 Bad Gateway</html>", { status: 502 }));
  };
  const { server, database, session, baseUrl } = await startServer({
    config: TUNNEL_CONFIG,
    fetch: fetchImpl,
    readGithubLogin: githubLoginReader,
  });
  try {
    const down = await callApi(baseUrl, "/api/workspaces/prepare", { sessionId: session.id, body: { repoFullName: REPO } });
    assert.equal(down.status, 200);
    assert.equal(down.body.ok, false);
    assert.equal(down.body.status, "error");
    assert.equal(down.body.code, "agent_unreachable");
    assert.equal(down.body.retryable, true, "agente desconectado: transitorio");
    assert.match(down.body.message || "", /apagado.*docente.*esperando/);
    assert.equal(down.body.error, down.body.message);
    assert.equal(down.body.workspace?.login, "estudiante-gh");

    mode = "slow";
    const slow = await callApi(baseUrl, statusPath, { sessionId: session.id });
    assert.equal(slow.status, 200);
    assert.equal(slow.body.status, "error");
    assert.equal(slow.body.code, "agent_timeout");
    assert.equal(slow.body.retryable, true, "sin respuesta a tiempo: transitorio");

    mode = "unauthorized";
    const unauthorized = await callApi(baseUrl, statusPath, { sessionId: session.id });
    assert.equal(unauthorized.body.code, "agent_unauthorized");
    assert.equal(unauthorized.body.retryable, undefined, "configuracion: no se reintenta");
    assert.doesNotMatch(unauthorized.body.message || "", /token/i, "no se le habla de tokens al estudiante");

    mode = "mismatch";
    const mismatch = await callApi(baseUrl, "/api/workspaces/prepare", { sessionId: session.id, body: { repoFullName: REPO } });
    assert.equal(mismatch.status, 200);
    assert.equal(mismatch.body.code, "repo_mismatch");
    assert.equal(mismatch.body.retryable, undefined);
    assert.match(mismatch.body.message || "", /rehacer/);

    mode = "boom";
    const boom = await callApi(baseUrl, statusPath, { sessionId: session.id });
    assert.equal(boom.status, 200);
    assert.equal(boom.body.code, "agent_error");
    assert.equal(boom.body.retryable, undefined);
    assert.match(boom.body.message || "", /HTTP 502/);

    const failed = await database.listBehaviorEventsForViewer({ viewer: session.user, eventType: "prepare_environment_failed" });
    assert.ok(failed.length >= 1);
  } finally {
    await stopServer(server, database);
  }
});

test("workspaces: sin WORKSPACE_AGENT_URL -> 503 claro; token de GitHub revocado -> 409", async () => {
  const agent = fakeAgent(() => jsonResponse(200, { state: "ready" }));
  const unconfigured = await startServer({
    config: { ...TUNNEL_CONFIG, agentUrl: "", agentToken: "" },
    fetch: agent.fetchImpl,
    readGithubLogin: githubLoginReader,
  });
  try {
    const provider = await callApi(unconfigured.baseUrl, "/api/workspaces/provider");
    assert.equal(provider.body.agentConfigured, false);
    const prepare = await callApi(unconfigured.baseUrl, "/api/workspaces/prepare", {
      sessionId: unconfigured.session.id,
      body: { repoFullName: REPO },
    });
    assert.equal(prepare.status, 503);
    assert.equal(prepare.body.code, "agent_not_configured");
  } finally {
    await stopServer(unconfigured.server, unconfigured.database);
  }

  // Lector real de GitHub con fetch falso: 401 de /user = token revocado.
  const githubCalls: string[] = [];
  const revoked = await startServer({
    config: TUNNEL_CONFIG,
    fetch: async (url) => {
      githubCalls.push(url);
      return jsonResponse(401, { message: "Bad credentials" });
    },
  });
  try {
    const prepare = await callApi(revoked.baseUrl, "/api/workspaces/prepare", {
      sessionId: revoked.session.id,
      body: { repoFullName: REPO },
    });
    assert.equal(prepare.status, 409);
    assert.equal(prepare.body.code, "github_token_invalid");
    assert.deepEqual(githubCalls, ["https://api.github.invalid/user"]);
  } finally {
    await stopServer(revoked.server, revoked.database);
  }
});

test("workspaces: modo relay (VM sin IP publica): el agente recoge la peticion por HTTPS de salida", async () => {
  const relay = createWorkspaceRelay({ staleAfterMs: 5_000 });
  const started = await startServer({
    config: { ...TUNNEL_CONFIG, transport: "relay", agentUrl: "", agentTimeoutMs: 5_000 },
    readGithubLogin: githubLoginReader,
    relay,
    publicBaseUrl: "https://adaceen.prueba",
  });
  // relay.mjs es JavaScript del agente de la VM: se carga tal cual corre alla.
  const relayModule = "../../deploy/gcp/workspaces/agente/relay.mjs";
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

test("workspaces: tras una espera, not_found del agente reenvia el prepare una vez (sin force) en vez de cortar", async () => {
  let mode: "slow" | "lost" | "ok" = "slow";
  let postsSeen = 0;
  const agent = fakeAgent((call) => {
    if (mode === "slow") {
      // El POST vence por tiempo sin llegar (VM arrancando, conexion colgada).
      return new Promise<Response>(() => {});
    }
    if (call.method === "POST") {
      postsSeen += 1;
      return jsonResponse(200, { state: "pending", message: "Clonando el repositorio..." });
    }
    if (mode === "lost" || postsSeen === 0) {
      return jsonResponse(404, { state: "error", code: "not_found", message: "Todavia no hay un editor preparado para esta cuenta. Pulsa Preparar mi editor." });
    }
    return jsonResponse(200, { state: "ready" });
  });
  // fakeAgent no conoce el AbortSignal: se corta aqui para simular el timeout de fetch.
  const fetchImpl: FetchLike = (url, init) => new Promise<Response>((resolve, reject) => {
    init?.signal?.addEventListener("abort", () => reject(Object.assign(new Error("aborted"), { name: "AbortError" })));
    Promise.resolve(agent.fetchImpl(url, init)).then(resolve, reject);
  });
  const { server, database, session, baseUrl } = await startServer({
    config: { ...TUNNEL_CONFIG, agentTimeoutMs: 150 },
    fetch: fetchImpl,
    readGithubLogin: githubLoginReader,
    publicBaseUrl: "https://adaceen.prueba",
  });
  try {
    const slow = await callApi(baseUrl, "/api/workspaces/prepare", { sessionId: session.id, body: { repoFullName: REPO, force: true } });
    assert.equal(slow.body.code, "agent_timeout");
    assert.equal(slow.body.retryable, true);

    // El agente vuelve sin haber recibido el POST: GET -> not_found -> se reenvia sin force.
    mode = "ok";
    const resent = await callApi(baseUrl, statusPath, { sessionId: session.id });
    assert.equal(resent.body.ok, true);
    assert.equal(resent.body.status, "pending");
    assert.deepEqual(agent.calls.map((call) => call.method), ["POST", "GET", "POST"]);
    const lastBody = agent.calls.at(-1)?.body as { force?: boolean; editorSession?: unknown };
    assert.equal(lastBody.force, false, "no hay nada que rehacer: sin force");
    assert.ok(lastBody.editorSession, "el reenvio lleva la sesion del editor");

    const ready = await callApi(baseUrl, statusPath, { sessionId: session.id });
    assert.equal(ready.body.status, "ready");

    // Solo una vez por preparacion: si el agente sigue sin conocer al estudiante, el error sale.
    mode = "slow";
    await callApi(baseUrl, "/api/workspaces/prepare", { sessionId: session.id, body: { repoFullName: REPO } });
    mode = "lost";
    const first = await callApi(baseUrl, statusPath, { sessionId: session.id });
    assert.equal(first.body.status, "pending", "primer not_found: se reenvia");
    const second = await callApi(baseUrl, statusPath, { sessionId: session.id });
    assert.equal(second.body.status, "error");
    assert.equal(second.body.code, "not_found");
  } finally {
    await stopServer(server, database);
  }
});

test("workspaces: sin espera previa, not_found sigue siendo el error de siempre (no se reenvia)", async () => {
  const agent = fakeAgent((call) => call.method === "POST"
    ? jsonResponse(200, { state: "pending", message: "Clonando el repositorio..." })
    : jsonResponse(404, { state: "error", code: "not_found", message: "Todavia no hay un editor preparado para esta cuenta. Pulsa Preparar mi editor." }));
  const { server, database, session, baseUrl } = await startServer({
    config: TUNNEL_CONFIG,
    fetch: agent.fetchImpl,
    readGithubLogin: githubLoginReader,
    publicBaseUrl: "https://adaceen.prueba",
  });
  try {
    await callApi(baseUrl, "/api/workspaces/prepare", { sessionId: session.id, body: { repoFullName: REPO } });
    const status = await callApi(baseUrl, statusPath, { sessionId: session.id });
    assert.equal(status.body.code, "not_found");
    assert.deepEqual(agent.calls.map((call) => call.method), ["POST", "GET"]);
  } finally {
    await stopServer(server, database);
  }
});

test("workspaces: tras «Salir», status con el editor listo reescribe la sesion de VS Code en la VM (hallazgo 5a)", async () => {
  const agent = fakeAgent(() => jsonResponse(200, { state: "ready" }));
  const { server, database, session, baseUrl } = await startServer({
    config: TUNNEL_CONFIG,
    fetch: agent.fetchImpl,
    readGithubLogin: githubLoginReader,
    publicBaseUrl: "https://adaceen.prueba",
  });
  type EditorBody = { force?: boolean; editorSession?: { sessionId: string } };
  try {
    await callApi(baseUrl, "/api/workspaces/prepare", { sessionId: session.id, body: { repoFullName: REPO } });
    const firstSession = (agent.calls[0].body as EditorBody).editorSession?.sessionId;
    assert.ok(firstSession);

    // Con la sesion del tunel viva, status solo consulta (GET).
    const plain = await callApi(baseUrl, statusPath, { sessionId: session.id });
    assert.equal(plain.body.status, "ready");
    assert.deepEqual(agent.calls.map((call) => call.method), ["POST", "GET"]);

    // «Salir» en otro navegador: el backend desactiva las sesiones editor. El estudiante
    // vuelve a entrar y pulsa «Abrir mi editor» con un editor guardado reciente (solo status).
    await database.deactivateEditorSessionsForUser(session.user.id);
    assert.equal(await database.getSession(firstSession), null);
    const again = await database.authenticateUser("estudiante@adaceen.edu.co", "Estudiante123!");
    assert.ok(again);

    // Con la cookie sola no se manda sesion del editor: status no reenvia nada.
    const cookieOnly = await callApi(baseUrl, statusPath, { headers: { Cookie: `adaceen_session_id=${again.id}` } });
    assert.equal(cookieOnly.body.status, "ready");
    assert.deepEqual(agent.calls.map((call) => call.method), ["POST", "GET", "GET"]);

    const reopened = await callApi(baseUrl, statusPath, { sessionId: again.id });
    assert.equal(reopened.status, 200);
    assert.equal(reopened.body.status, "ready");
    assert.equal(reopened.body.workspace?.webUrl, buildTunnelWebUrl("estudiante-gh"));
    assert.deepEqual(agent.calls.map((call) => call.method), ["POST", "GET", "GET", "GET", "POST"], "status reenvia el prepare antes de contestar");
    const resent = agent.calls.at(-1)?.body as EditorBody;
    assert.equal(resent.force, false);
    assert.ok(resent.editorSession && resent.editorSession.sessionId !== firstSession, "una sesion nueva para la VM");
    const written = await database.getSession(resent.editorSession.sessionId);
    assert.equal(written?.kind, "editor");
    assert.equal(written?.label, "tunnel");
    assert.equal(JSON.stringify(reopened.body).includes(resent.editorSession.sessionId), false, "la sesion no vuelve al navegador");

    // Ya hay sesion: el siguiente status vuelve a ser solo GET.
    await callApi(baseUrl, statusPath, { sessionId: again.id });
    assert.equal(agent.calls.at(-1)?.method, "GET");
    assert.equal(agent.calls.length, 6);
  } finally {
    await stopServer(server, database);
  }
});

// ---- Entorno de los estudiantes elegido por el administrador (navegador 0.7.19) ----

type AdminProviderBody = {
  ok?: boolean;
  provider?: string;
  source?: string;
  serverProvider?: string;
  choice?: string | null;
  updatedAt?: string | null;
  updatedBy?: string | null;
  agentConfigured?: boolean;
  agentOnline?: boolean | null;
  transport?: string;
  vmAutostart?: boolean;
  message?: string;
  warning?: string;
  code?: string;
  error?: string;
};

async function adminProvider(baseUrl: string, sessionId?: string, provider?: unknown) {
  const response = await fetch(`${baseUrl}/api/admin/workspace-provider`, {
    method: provider === undefined ? "GET" : "PUT",
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      ...(sessionId ? { "x-session-id": sessionId } : {}),
    },
    body: provider === undefined ? undefined : JSON.stringify({ provider }),
  });
  return { status: response.status, body: await response.json() as AdminProviderBody };
}

test("0.7.19: el administrador o el docente eligen el entorno de los estudiantes y manda sobre la variable sin reiniciar", async () => {
  const agent = fakeAgent(() => jsonResponse(200, {
    state: "ready",
    tunnelName: "ad-estudiante-gh",
    webUrl: buildTunnelWebUrl("estudiante-gh"),
  }));
  const { server, database, session, baseUrl } = await startServer({
    config: { ...TUNNEL_CONFIG, provider: "codespaces" },
    fetch: agent.fetchImpl,
    readGithubLogin: githubLoginReader,
  });
  try {
    const admin = await database.authenticateUser("admin@adaceen.edu.co", "Admin123!");
    const teacher = await database.authenticateUser("docente@adaceen.edu.co", "Docente123!");
    assert.ok(admin && teacher);

    // El administrador y el docente lo ven y lo cambian; el estudiante no.
    assert.equal((await adminProvider(baseUrl)).status, 401);
    assert.equal((await adminProvider(baseUrl, session.id)).status, 403);
    const studentPut = await adminProvider(baseUrl, session.id, "tunnel");
    assert.equal(studentPut.status, 403);
    assert.equal(studentPut.body.error, "Solo el administrador o el docente eligen el entorno de los estudiantes.");
    assert.equal((await adminProvider(baseUrl, teacher.id)).status, 200);

    const before = await adminProvider(baseUrl, admin.id);
    assert.equal(before.status, 200);
    assert.equal(before.body.provider, "codespaces");
    assert.equal(before.body.source, "server");
    assert.equal(before.body.serverProvider, "codespaces");
    assert.equal(before.body.choice, null);
    assert.equal(before.body.updatedAt, null);
    assert.equal(before.body.agentConfigured, true);
    assert.equal(before.body.agentOnline, null, "en modo directo el backend no sabe si el agente escucha");
    assert.equal(before.body.transport, "direct");

    const invalid = await adminProvider(baseUrl, admin.id, "vm");
    assert.equal(invalid.status, 400);
    assert.equal((await adminProvider(baseUrl, admin.id, undefined)).body.choice, null, "un pedido invalido no cambia nada");

    // Tunel: /api/workspaces/provider y prepare lo usan enseguida, sin reiniciar el backend.
    const tunnel = await adminProvider(baseUrl, admin.id, "tunnel");
    assert.equal(tunnel.status, 200);
    assert.equal(tunnel.body.provider, "tunnel");
    assert.equal(tunnel.body.source, "extension");
    assert.equal(tunnel.body.serverProvider, "codespaces");
    assert.equal(tunnel.body.choice, "tunnel");
    assert.equal(tunnel.body.updatedBy, "Administrador Demo");
    assert.ok(tunnel.body.updatedAt && !Number.isNaN(Date.parse(tunnel.body.updatedAt)));
    assert.equal(
      tunnel.body.message,
      "Entorno de los estudiantes: editor en la nube (túnel de VS Code). Lo verán al recargar la página o en unos minutos.",
    );
    assert.equal(tunnel.body.warning, undefined);
    assert.deepEqual((await callApi(baseUrl, "/api/workspaces/provider")).body, { ok: true, provider: "tunnel", agentConfigured: true });
    const prepared = await callApi(baseUrl, "/api/workspaces/prepare", { sessionId: session.id, body: { repoFullName: REPO } });
    assert.equal(prepared.status, 200);
    assert.equal(prepared.body.status, "ready");
    assert.equal(agent.calls.length, 1);

    // Codespaces, esta vez desde la cuenta del docente: prepare y status vuelven a 409 y no se
    // llama al agente.
    const codespaces = await adminProvider(baseUrl, teacher.id, "codespaces");
    assert.equal(codespaces.status, 200);
    assert.equal(codespaces.body.provider, "codespaces");
    assert.equal(codespaces.body.source, "extension");
    assert.equal(codespaces.body.updatedBy, "Docente Demo");
    assert.equal(codespaces.body.message, "Entorno de los estudiantes: GitHub Codespaces. Lo verán al recargar la página o en unos minutos.");
    assert.equal((await callApi(baseUrl, "/api/workspaces/prepare", { sessionId: session.id, body: { repoFullName: REPO } })).status, 409);
    assert.equal((await callApi(baseUrl, statusPath, { sessionId: session.id })).status, 409);
    assert.equal(agent.calls.length, 1);

    // "server": vuelve a la variable y queda quien lo cambio y cuando.
    const back = await adminProvider(baseUrl, admin.id, "server");
    assert.equal(back.status, 200);
    assert.equal(back.body.provider, "codespaces");
    assert.equal(back.body.source, "server");
    assert.equal(back.body.choice, null);
    assert.equal(back.body.updatedBy, "Administrador Demo");
    assert.equal(back.body.message, "Entorno de los estudiantes: lo que diga el servidor (GitHub Codespaces). Lo verán al recargar la página o en unos minutos.");

    // Queda en la base: otra instancia del backend (sin la cache) lo lee.
    await adminProvider(baseUrl, admin.id, "TUNNEL");
    forgetWorkspaceProviderChoice(database);
    const stored = await readWorkspaceProviderChoice(database);
    assert.equal(stored.choice, "tunnel");
    assert.equal(stored.updatedBy, "Administrador Demo");
  } finally {
    await stopServer(server, database);
  }
});

test("0.7.19: sin token del agente el tunel no se puede elegir; con relay avisa si la VM esta apagada; /api/health lo refleja", async () => {
  const relay = createWorkspaceRelay({ staleAfterMs: 60_000 });
  const withoutToken = await startServer({
    config: { ...TUNNEL_CONFIG, provider: "codespaces", transport: "relay", agentUrl: "", agentToken: "" },
    relay,
    autostart: null,
    readGithubLogin: githubLoginReader,
  });
  try {
    const admin = await withoutToken.database.authenticateUser("admin@adaceen.edu.co", "Admin123!");
    assert.ok(admin);
    const refused = await adminProvider(withoutToken.baseUrl, admin.id, "tunnel");
    assert.equal(refused.status, 409);
    assert.equal(refused.body.code, "agent_not_configured");
    assert.match(refused.body.error || "", /bash deploy\/produccion\.sh aplicar/);
    assert.equal(refused.body.message, refused.body.error);
    const unchanged = await adminProvider(withoutToken.baseUrl, admin.id);
    assert.equal(unchanged.body.provider, "codespaces");
    assert.equal(unchanged.body.choice, null);
    assert.equal(unchanged.body.agentConfigured, false);
    // Volver al servidor o elegir Codespaces siempre se puede.
    assert.equal((await adminProvider(withoutToken.baseUrl, admin.id, "codespaces")).status, 200);
    assert.equal((await adminProvider(withoutToken.baseUrl, admin.id, "server")).status, 200);
  } finally {
    await stopServer(withoutToken.server, withoutToken.database);
    relay.close();
  }

  const relayOff = createWorkspaceRelay({ staleAfterMs: 60_000 });
  const withToken = await startServer({
    config: { ...TUNNEL_CONFIG, provider: "codespaces", transport: "relay", agentUrl: "" },
    relay: relayOff,
    autostart: null,
    readGithubLogin: githubLoginReader,
  }, { health: true });
  try {
    const admin = await withToken.database.authenticateUser("admin@adaceen.edu.co", "Admin123!");
    assert.ok(admin);
    const healthBefore = await (await fetch(`${withToken.baseUrl}/api/health`)).json() as Record<string, unknown>;
    assert.equal(healthBefore.workspace_provider, "codespaces");
    assert.equal(healthBefore.workspace_provider_source, "server");
    assert.equal(healthBefore.workspace_provider_server, "codespaces");
    assert.equal(healthBefore.workspace_agent_transport, null);

    const tunnel = await adminProvider(withToken.baseUrl, admin.id, "tunnel");
    assert.equal(tunnel.status, 200);
    assert.equal(tunnel.body.agentOnline, false);
    assert.equal(tunnel.body.vmAutostart, false);
    assert.equal(tunnel.body.warning, "La VM de editores está apagada: enciéndela antes de la clase con bash deploy/clase.sh iniciar.");

    // /empezar y deploy/clase.sh leen el entorno activo; deploy/produccion.sh, el del servidor.
    const health = await (await fetch(`${withToken.baseUrl}/api/health`)).json() as Record<string, unknown>;
    assert.equal(health.workspace_provider, "tunnel");
    assert.equal(health.workspace_provider_source, "extension");
    assert.equal(health.workspace_provider_server, "codespaces");
    assert.ok(health.workspace_agent_transport, "con el tunel activo /empezar necesita el transporte");
    assert.equal(typeof health.workspace_vm_autostart, "boolean");
  } finally {
    await stopServer(withToken.server, withToken.database);
    relayOff.close();
  }
});

// --- Un editor, varios repositorios (0.7.20) ---

type EditorsBody = WorkspaceBody & { editors?: Array<{ repoFullName: string; webUrl: string }> };

test("workspaces 0.7.20: solo repositorios publicos: privado -> repo_private y no visible -> repo_not_accessible sin despertar la VM; nunca sale un token", async () => {
  const PRIVATE_REPO = "FPOO-2026/taller-ana";
  const agent = fakeAgent(() => jsonResponse(200, {
    login: "estudiante-gh",
    state: "ready",
    tunnelName: "ad-estudiante-gh",
    webUrl: "https://vscode.dev/tunnel/ad-estudiante-gh/home/ws-estudiante-gh/Proyecto-Final",
    folder: "Proyecto-Final",
    repos: [{ repo: REPO, folder: "Proyecto-Final", webUrl: "https://vscode.dev/tunnel/ad-estudiante-gh/home/ws-estudiante-gh/Proyecto-Final" }],
  }));
  const repoChecks: string[] = [];
  let privateNow = true;
  const { server, database, session, baseUrl } = await startServer({
    config: TUNNEL_CONFIG,
    fetch: agent.fetchImpl,
    readGithubLogin: githubLoginReader,
    readGithubRepoAccess: async (token, repoFullName) => {
      assert.equal(token, GITHUB_TOKEN, "se consulta con el token del usuario (no sale del backend)");
      repoChecks.push(repoFullName);
      if (repoFullName === PRIVATE_REPO) return { state: "visible", private: privateNow, fullName: PRIVATE_REPO };
      if (repoFullName === "otro/secreto") return { state: "not_visible" };
      if (repoFullName === "caido/github") return { state: "unknown" };
      return { state: "visible", private: false, fullName: repoFullName };
    },
  });
  try {
    // Publico: listo, con editors y sin token en lo que va a la VM.
    const prepared = await callApi(baseUrl, "/api/workspaces/prepare", { sessionId: session.id, body: { repoFullName: REPO } });
    assert.equal(prepared.status, 200);
    assert.equal(prepared.body.status, "ready");
    assert.deepEqual((prepared.body as EditorsBody).editors, [
      { repoFullName: REPO, webUrl: "https://vscode.dev/tunnel/ad-estudiante-gh/home/ws-estudiante-gh/Proyecto-Final" },
    ]);
    assert.equal("cloneToken" in (agent.calls[0].body as object), false);
    // GitHub sin responder: se sigue con el clon publico (sin token).
    await callApi(baseUrl, "/api/workspaces/prepare", { sessionId: session.id, body: { repoFullName: "caido/github" } });
    assert.equal("cloneToken" in (agent.calls[1].body as object), false);
    assert.equal(agent.calls.some((call) => JSON.stringify(call.body).includes(GITHUB_TOKEN)), false, "ningun token llega a la VM");

    // Privado: 409 con un mensaje claro y la VM ni se entera.
    const callsBefore = agent.calls.length;
    const priv = await callApi(baseUrl, "/api/workspaces/prepare", { sessionId: session.id, body: { repoFullName: PRIVATE_REPO } });
    assert.equal(priv.status, 409);
    assert.equal(priv.body.code, "repo_private");
    assert.match(priv.body.message || "", /FPOO-2026\/taller-ana es privado\. El editor en la nube de ADACEEN solo abre repositorios publicos/);
    assert.equal(priv.body.error, priv.body.message);
    // No visible (no existe o es privado sin acceso): tambien 409, sin la VM.
    const hidden = await callApi(baseUrl, "/api/workspaces/prepare", { sessionId: session.id, body: { repoFullName: "otro/secreto" } });
    assert.equal(hidden.status, 409);
    assert.equal(hidden.body.code, "repo_not_accessible");
    assert.match(hidden.body.message || "", /GitHub no encuentra otro\/secreto como repositorio publico/);
    assert.equal(agent.calls.length, callsBefore);
    const failures = await database.listBehaviorEventsForViewer({ viewer: session.user, category: "error" });
    assert.ok(failures.some((event) => event.eventType === "prepare_environment_failed" && String(event.value).startsWith("repo_private")));

    // Cache: el publico se recuerda; el privado no (quien lo hace publico no espera).
    const checks = repoChecks.length;
    await callApi(baseUrl, "/api/workspaces/prepare", { sessionId: session.id, body: { repoFullName: REPO } });
    assert.equal(repoChecks.length, checks, "el publico se recuerda 5 min");
    privateNow = false;
    const nowPublic = await callApi(baseUrl, "/api/workspaces/prepare", { sessionId: session.id, body: { repoFullName: PRIVATE_REPO } });
    assert.equal(nowPublic.status, 200, "recien hecho publico: se vuelve a preguntar");
    assert.equal(repoChecks.length, checks + 1);
  } finally {
    await stopServer(server, database);
  }

  // Lector real contra un GitHub falso: 404 -> no visible; 403 (limite u organizacion con
  // apps OAuth restringidas) no dice si es publico: se sigue y el clon publico decide.
  const githubCalls: string[] = [];
  const agentCalls: string[] = [];
  const real = await startServer({
    config: TUNNEL_CONFIG,
    readGithubLogin: githubLoginReader,
    readGithubRepoAccess: undefined,
    fetch: async (url) => {
      if (url.startsWith(AGENT_URL)) {
        agentCalls.push(url);
        return jsonResponse(200, { login: "estudiante-gh", state: "ready", tunnelName: "ad-estudiante-gh", webUrl: "https://vscode.dev/tunnel/ad-estudiante-gh/home/ws-estudiante-gh/tarea" });
      }
      githubCalls.push(url);
      if (url.endsWith("/repos/curso-org/tarea")) {
        return jsonResponse(403, { message: "Although you appear to have the correct authorization credentials, the `curso-org` organization has enabled OAuth App access restrictions." });
      }
      if (url.endsWith("/repos/nadie/nada")) return jsonResponse(404, { message: "Not Found" });
      if (url.endsWith("/repos/curso-org/privado")) return jsonResponse(200, { full_name: "curso-org/privado", private: true });
      return jsonResponse(500, {});
    },
  });
  try {
    const restricted = await callApi(real.baseUrl, "/api/workspaces/prepare", { sessionId: real.session.id, body: { repoFullName: "curso-org/tarea" } });
    assert.equal(restricted.status, 200, "403 no bloquea: la VM intenta el clon publico");
    assert.equal(restricted.body.status, "ready");
    const missing = await callApi(real.baseUrl, "/api/workspaces/prepare", { sessionId: real.session.id, body: { repoFullName: "nadie/nada" } });
    assert.equal(missing.body.code, "repo_not_accessible");
    const privado = await callApi(real.baseUrl, "/api/workspaces/prepare", { sessionId: real.session.id, body: { repoFullName: "curso-org/privado" } });
    assert.equal(privado.body.code, "repo_private");
    assert.deepEqual(githubCalls, [
      "https://api.github.invalid/repos/curso-org/tarea",
      "https://api.github.invalid/repos/nadie/nada",
      "https://api.github.invalid/repos/curso-org/privado",
    ]);
    assert.equal(agentCalls.length, 1, "solo el que podia ser publico llego a la VM");
  } finally {
    await stopServer(real.server, real.database);
  }
});

test("workspaces 0.7.20: estado por repositorio, otro repo en marcha reintentable y agente anterior detras del relay", async () => {
  // busy_other_repo: la VM termina otro repositorio y en segundos sigue con este.
  let busy = true;
  const agent = fakeAgent((call) => {
    if (call.method === "POST" && busy) {
      return jsonResponse(409, { login: "estudiante-gh", state: "error", code: "busy_other_repo", message: "Tu editor esta terminando de preparar a/otro. En unos segundos sigue con este." });
    }
    if (call.method === "GET" && busy === false && !call.url.includes("listo")) {
      return jsonResponse(404, { login: "estudiante-gh", state: "error", code: "not_found", message: `${REPO} todavia no esta en tu editor.` });
    }
    return jsonResponse(200, { login: "estudiante-gh", state: "ready", tunnelName: "ad-estudiante-gh", webUrl: "https://vscode.dev/tunnel/ad-estudiante-gh/home/ws-estudiante-gh/Proyecto-Final" });
  });
  const { server, database, session, baseUrl } = await startServer({
    config: TUNNEL_CONFIG,
    fetch: agent.fetchImpl,
    readGithubLogin: githubLoginReader,
  });
  try {
    const first = await callApi(baseUrl, "/api/workspaces/prepare", { sessionId: session.id, body: { repoFullName: REPO } });
    assert.equal(first.status, 200);
    assert.equal(first.body.code, "busy_other_repo");
    assert.equal(first.body.retryable, true, "la extension sigue esperando");
    // Termina el otro: este repo aun no esta (not_found) y status reenvia el prepare una vez.
    busy = false;
    const after = await callApi(baseUrl, statusPath, { sessionId: session.id });
    assert.equal(after.body.status, "ready");
    assert.equal(after.body.workspace?.webUrl, "https://vscode.dev/tunnel/ad-estudiante-gh/home/ws-estudiante-gh/Proyecto-Final");
    assert.deepEqual(agent.calls.map((call) => `${call.method} ${call.url.replace(AGENT_URL, "")}`), [
      "POST /workspaces",
      `GET /workspaces/estudiante-gh?repo=${encodeURIComponent(REPO)}`,
      "POST /workspaces",
    ]);
  } finally {
    await stopServer(server, database);
  }

  // Agente anterior a 0.7.20 detras del relay: rechaza ?repo= (403 route_not_allowed).
  // PDC le vuelve a preguntar solo por login y no insiste durante un rato.
  const legacyCalls: string[] = [];
  const legacy = fakeAgent((call) => {
    legacyCalls.push(call.url.replace(AGENT_URL, ""));
    if (call.url.includes("?repo=")) return jsonResponse(403, { state: "error", code: "route_not_allowed", message: "Ruta no permitida por el relay." });
    return jsonResponse(200, { login: "estudiante-gh", state: "ready", tunnelName: "ad-estudiante-gh", webUrl: "https://vscode.dev/tunnel/ad-estudiante-gh/home/ws-estudiante-gh/proyecto" });
  });
  const old = await startServer({ config: TUNNEL_CONFIG, fetch: legacy.fetchImpl, readGithubLogin: githubLoginReader });
  try {
    const ready = await callApi(old.baseUrl, statusPath, { sessionId: old.session.id });
    assert.equal(ready.body.status, "ready");
    assert.equal(ready.body.workspace?.webUrl, "https://vscode.dev/tunnel/ad-estudiante-gh/home/ws-estudiante-gh/proyecto");
    await callApi(old.baseUrl, statusPath, { sessionId: old.session.id });
    // (El POST de en medio es la sesion del editor que status reescribe con el editor listo.)
    assert.deepEqual(legacyCalls.filter((url) => url !== "/workspaces"), [
      `/workspaces/estudiante-gh?repo=${encodeURIComponent(REPO)}`,
      "/workspaces/estudiante-gh",
      "/workspaces/estudiante-gh",
    ]);
  } finally {
    await stopServer(old.server, old.database);
  }

  // editors: solo owner/nombre validos y URLs del tunel del estudiante.
  const mapped = mapAgentResult({
    kind: "response",
    status: 200,
    json: {
      state: "ready",
      tunnelName: "ad-eyder",
      webUrl: "https://vscode.dev/tunnel/ad-eyder/home/ws-eyder/Taller",
      repos: [
        { repo: "a/Taller", webUrl: "https://vscode.dev/tunnel/ad-eyder/home/ws-eyder/Taller" },
        { repo: "a/taller", webUrl: "https://vscode.dev/tunnel/ad-eyder/home/ws-eyder/Taller" },
        { repo: "b/ajeno", webUrl: "https://evil.example/tunnel/ad-eyder/x" },
        { repo: "no valido", webUrl: "https://vscode.dev/tunnel/ad-eyder/home/ws-eyder/x" },
        "basura",
      ],
    },
  }, { login: "eyder", repoFullName: "a/Taller" });
  assert.deepEqual(mapped.editors, [{ repoFullName: "a/Taller", webUrl: "https://vscode.dev/tunnel/ad-eyder/home/ws-eyder/Taller" }]);
  assert.equal(buildTunnelWebUrl("eyder", "ad-eyder", "Taller-1"), "https://vscode.dev/tunnel/ad-eyder/home/ws-eyder/Taller-1");
  assert.equal(buildTunnelWebUrl("eyder", "ad-eyder", "../x"), "https://vscode.dev/tunnel/ad-eyder/home/ws-eyder/proyecto");
});

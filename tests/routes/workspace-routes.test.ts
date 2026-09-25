import assert from "node:assert/strict";
import test from "node:test";
import type { Server } from "node:http";
import express from "express";
import { createDatabase, type AppDatabase } from "../../src/db/database.js";
import { registerWorkspaceRoutes } from "../../src/routes/workspace-routes.js";
import { createWorkspaceRelay } from "../../src/services/workspace-relay.js";
import {
  buildTunnelName,
  buildTunnelWebUrl,
  mapAgentResult,
  normalizeRepoFullName,
  normalizeWorkspaceLogin,
  type FetchLike,
  type WorkspaceConfig,
  type WorkspaceProviderDeps,
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

async function startServer(deps: WorkspaceProviderDeps, options: { connectGithub?: boolean } = {}) {
  const database = await createDatabase();
  const app = express();
  app.use(express.json());
  registerWorkspaceRoutes(app, database, deps);
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
  agentConfigured?: boolean;
  workspace?: { login?: string; tunnelName?: string; webUrl?: string; repoFullName?: string };
  deviceCode?: { userCode?: string; verificationUrl?: string; expiresAt?: string | null };
};

async function callApi(baseUrl: string, path: string, options: { sessionId?: string; body?: unknown } = {}) {
  const response = await fetch(`${baseUrl}${path}`, {
    method: options.body === undefined ? "GET" : "POST",
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      ...(options.sessionId ? { "x-session-id": options.sessionId } : {}),
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

    // Llamada exacta al agente: URL, token y cuerpo {login, repo, force}.
    assert.equal(agent.calls.length, 1);
    assert.equal(agent.calls[0].url, `${AGENT_URL}/workspaces`);
    assert.equal(agent.calls[0].method, "POST");
    assert.equal(agent.calls[0].headers["x-agent-token"], AGENT_TOKEN);
    assert.deepEqual(agent.calls[0].body, { login: "estudiante-gh", repo: REPO, force: false });

    const pending = await callApi(baseUrl, statusPath, { sessionId: session.id });
    assert.equal(pending.status, 200);
    assert.equal(pending.body.status, "pending");
    assert.equal(agent.calls[1].url, `${AGENT_URL}/workspaces/estudiante-gh`);
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

    // force llega al agente tal cual.
    await callApi(baseUrl, "/api/workspaces/prepare", { sessionId: session.id, body: { repoFullName: REPO, force: true } });
    assert.deepEqual(agent.calls.at(-1)?.body, { login: "estudiante-gh", repo: REPO, force: true });
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
    assert.match(down.body.message || "", /VM de editores/);
    assert.equal(down.body.error, down.body.message);
    assert.equal(down.body.workspace?.login, "estudiante-gh");

    mode = "slow";
    const slow = await callApi(baseUrl, statusPath, { sessionId: session.id });
    assert.equal(slow.status, 200);
    assert.equal(slow.body.status, "error");
    assert.equal(slow.body.code, "agent_timeout");

    mode = "unauthorized";
    const unauthorized = await callApi(baseUrl, statusPath, { sessionId: session.id });
    assert.equal(unauthorized.body.code, "agent_unauthorized");
    assert.doesNotMatch(unauthorized.body.message || "", /token/i, "no se le habla de tokens al estudiante");

    mode = "mismatch";
    const mismatch = await callApi(baseUrl, "/api/workspaces/prepare", { sessionId: session.id, body: { repoFullName: REPO } });
    assert.equal(mismatch.status, 200);
    assert.equal(mismatch.body.code, "repo_mismatch");
    assert.match(mismatch.body.message || "", /rehacer/);

    mode = "boom";
    const boom = await callApi(baseUrl, statusPath, { sessionId: session.id });
    assert.equal(boom.status, 200);
    assert.equal(boom.body.code, "agent_error");
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

    const localCalls: Array<{ url: string; method: string; token: string | null; body: { login?: string } | null }> = [];
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

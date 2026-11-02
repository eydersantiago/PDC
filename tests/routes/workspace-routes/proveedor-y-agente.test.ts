import assert from "node:assert/strict";
import test from "node:test";
import { workspacePayloadForRole } from "../../../src/routes/workspace/workspace-prepare-routes.js";
import {
  buildWorkspaceErrorPayload,
  buildWorkspaceInfo,
  mapAgentResult,
} from "../../../src/services/workspace/workspace-agent-result.js";
import {
  buildTunnelName,
  buildTunnelWebUrl,
  normalizeRepoFullName,
  normalizeWorkspaceLogin,
  type FetchLike,
} from "../../../src/services/workspace/workspace-config.js";
import {
  AGENT_URL,
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
    assert.match(prepare.body.message || "", /Pide al docente/, "el estudiante ve a quien pedirlo");

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

test("workspaces 0.7.20: docente y administrador leen que hacer, no «avisa al docente»", () => {
  const info = buildWorkspaceInfo("profe-gh", REPO);
  const notAllowed = buildWorkspaceErrorPayload("login_not_allowed", "La cuenta de GitHub profe-gh no esta en la lista del piloto. Pide al docente que la agregue.", info);
  const vmOff = mapAgentResult({ kind: "unreachable", detail: "ECONNREFUSED" }, { login: "profe-gh", repoFullName: REPO });
  const badToken = mapAgentResult({ kind: "response", status: 401, json: {} }, { login: "profe-gh", repoFullName: REPO });

  for (const role of ["teacher", "admin"]) {
    const allowed = workspacePayloadForRole(notAllowed, role);
    assert.match(allowed.message || "", /profe-gh/);
    assert.match(allowed.message || "", /WORKSPACE_ALLOWED_LOGINS/);
    assert.doesNotMatch(allowed.message || "", /docente/);
    assert.equal(allowed.code, "login_not_allowed");

    const off = workspacePayloadForRole(vmOff, role);
    assert.match(off.message || "", /clase\.sh iniciar/);
    assert.equal(off.retryable, true, "sigue siendo reintentable: la ventana espera");
    assert.doesNotMatch(off.message || "", /docente/);

    assert.match(workspacePayloadForRole(badToken, role).message || "", /produccion\.sh aplicar/);
  }
  // El estudiante (o sin rol) ve el mensaje de siempre; un exito no se toca.
  assert.equal(workspacePayloadForRole(notAllowed, "student"), notAllowed);
  assert.equal(workspacePayloadForRole(vmOff, undefined), vmOff);
  assert.match(vmOff.message || "", /Avisa al docente/);
  const ready = mapAgentResult({ kind: "response", status: 200, json: { state: "ready", tunnelName: "ad-profe-gh" } }, { login: "profe-gh", repoFullName: REPO });
  assert.equal(workspacePayloadForRole(ready, "teacher"), ready);
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

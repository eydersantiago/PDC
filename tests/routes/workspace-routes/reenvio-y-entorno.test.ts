import assert from "node:assert/strict";
import test from "node:test";
import { createWorkspaceRelay } from "../../../src/services/workspace/workspace-relay.js";
import { forgetWorkspaceProviderChoice, readWorkspaceProviderChoice } from "../../../src/services/workspace/workspace-provider-choice.js";
import { buildTunnelWebUrl, type FetchLike } from "../../../src/services/workspace/workspace-config.js";
import {
  GITHUB_TOKEN,
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

test("workspaces: dos cuentas con el mismo GitHub (cuentas de prueba): status deja en la VM la sesion de la que abre", async () => {
  const agent = fakeAgent(() => jsonResponse(200, { state: "ready" }));
  const { server, database, session, baseUrl } = await startServer({
    config: TUNNEL_CONFIG,
    fetch: agent.fetchImpl,
    readGithubLogin: githubLoginReader,
    publicBaseUrl: "https://adaceen.prueba",
  });
  type EditorBody = { editorSession?: { sessionId: string; userEmail: string } };
  const lastWritten = () => (agent.calls.at(-1)?.body as EditorBody | null)?.editorSession;
  try {
    // La misma cuenta de GitHub conectada tambien en el docente demo.
    const other = await database.authenticateUser("docente@adaceen.edu.co", "Docente123!");
    assert.ok(other);
    await database.upsertGithubUserToken({ userId: other.user.id, accountLogin: "Estudiante-GH", accessToken: GITHUB_TOKEN, scopes: "read:user" });

    await callApi(baseUrl, "/api/workspaces/prepare", { sessionId: session.id, body: { repoFullName: REPO } });
    const firstSession = lastWritten()?.sessionId;
    assert.equal(lastWritten()?.userEmail, "estudiante@adaceen.edu.co");
    await callApi(baseUrl, statusPath, { sessionId: session.id });
    assert.deepEqual(agent.calls.map((call) => call.method), ["POST", "GET"], "la misma cuenta: solo consulta");

    // La otra cuenta abre: no tiene sesion del tunel, se escribe la suya (como antes).
    await callApi(baseUrl, statusPath, { sessionId: other.id });
    assert.deepEqual(agent.calls.map((call) => call.method).slice(2), ["GET", "POST"]);
    assert.equal(lastWritten()?.userEmail, "docente@adaceen.edu.co");

    // Vuelve el estudiante: su sesion sigue vigente, pero la VM tiene la del docente.
    await callApi(baseUrl, statusPath, { sessionId: session.id });
    assert.deepEqual(agent.calls.map((call) => call.method).slice(4), ["GET", "POST"], "reescribe la sesion");
    assert.equal(lastWritten()?.userEmail, "estudiante@adaceen.edu.co");
    assert.equal(lastWritten()?.sessionId, firstSession, "reutiliza su sesion vigente");

    await callApi(baseUrl, statusPath, { sessionId: session.id });
    assert.equal(agent.calls.length, 7);
    assert.equal(agent.calls.at(-1)?.method, "GET", "ya es suya: solo consulta");

    // passive (al entrar en la pagina del repositorio) no reescribe nada.
    await callApi(baseUrl, `${statusPath}&passive=1`, { sessionId: other.id });
    assert.equal(agent.calls.length, 8);
    assert.equal(agent.calls.at(-1)?.method, "GET");
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

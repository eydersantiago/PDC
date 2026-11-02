import assert from "node:assert/strict";
import test from "node:test";
import { createVmAutostarter } from "../../../src/services/infra/gcp-compute.js";
import { mapAgentResult } from "../../../src/services/workspace/workspace-agent-result.js";
import { buildTunnelWebUrl } from "../../../src/services/workspace/workspace-config.js";
import {
  AGENT_URL,
  AGENT_TOKEN,
  GITHUB_TOKEN,
  REPO,
  TUNNEL_CONFIG,
  jsonResponse,
  fakeAgent,
  githubLoginReader,
  startServer,
  stopServer,
  type WorkspaceBody,
  callApi,
  statusPath,
} from "./helpers.js";

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
    // busy_other_repo no cuenta como entregado: cada status reenvia el prepare (sin
    // preguntar antes) hasta que la VM, ya libre, lo acepta.
    const stillBusy = await callApi(baseUrl, statusPath, { sessionId: session.id });
    assert.equal(stillBusy.body.code, "busy_other_repo");
    assert.equal(stillBusy.body.retryable, true);
    busy = false;
    const after = await callApi(baseUrl, statusPath, { sessionId: session.id });
    assert.equal(after.body.status, "ready");
    assert.equal(after.body.workspace?.webUrl, "https://vscode.dev/tunnel/ad-estudiante-gh/home/ws-estudiante-gh/Proyecto-Final");
    assert.deepEqual(agent.calls.map((call) => `${call.method} ${call.url.replace(AGENT_URL, "")}`), [
      "POST /workspaces",
      "POST /workspaces",
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

test("workspaces 0.7.20 (verificacion): agente real: B espera a que termine A, githubUserId llega al script y el modo de compatibilidad no abre otro repo", async () => {
  // agente-workspaces.mjs es JavaScript de la VM: se carga tal cual corre alla, con
  // un script falso en lugar de nuevo-tunel.sh (los repos "lento" tardan 1,5 s).
  const agentModule = "../../../deploy/gcp/workspaces/agente/agente-workspaces.mjs";
  const { crearAgente } = await import(agentModule);
  const { mkdtempSync, writeFileSync, readFileSync, chmodSync, rmSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const path = await import("node:path");
  const dir = mkdtempSync(path.join(tmpdir(), "ws-verif-"));
  const script = path.join(dir, "nuevo-tunel-falso.sh");
  writeFileSync(script, [
    "#!/usr/bin/env bash",
    "set -euo pipefail",
    'case "$2" in *lento*) sleep 1.5 ;; esac',
    `echo "\${ADACEEN_GITHUB_ID:-sin-id}" > "${dir}/id-$1"`,
    `echo "$3 $2" >> "${dir}/clones-$1"`,
    "",
  ].join("\n"));
  chmodSync(script, 0o755);
  const ACTIVO = { activo: true, arrancando: false, fallido: false, invocacion: "" };
  const sistema = {
    async observar() { return { usuarioExiste: true, servicio: ACTIVO, sesion: true, codigoJournal: null, nombreTunelReal: null }; },
    async inventario(login: string) {
      let text = "";
      try { text = readFileSync(path.join(dir, `clones-${login}`), "utf8"); } catch { /* sin clones */ }
      const clones = text.split("\n").filter(Boolean).map((line: string) => {
        const [carpeta, url] = line.split(" ");
        const fullName = url.replace("https://github.com/", "").replace(/\.git$/, "");
        return { carpeta, repoClave: fullName.toLowerCase(), repoFullName: fullName };
      });
      return { clones, nombres: clones.map((clon: { carpeta: string }) => clon.carpeta) };
    },
    async prepararRehacer() { return null; },
    async guardarSesionEditor() { return true; },
  };
  const agente = crearAgente({
    config: { token: AGENT_TOKEN, hosts: ["127.0.0.1"], puerto: 0, script, codeBin: "/bin/false", maxConcurrentes: 2, maxCola: 5, timeoutScriptMs: 20_000, esperaPrepararMs: 200 },
    sistema,
  });
  const [agentServer] = await agente.escuchar();
  const agentUrl = `http://127.0.0.1:${agentServer.address().port}`;
  const calls: Array<{ method: string; path: string; body: Record<string, unknown> | null }> = [];
  let rejectRepoQueries = 0;
  const started = await startServer({
    config: { ...TUNNEL_CONFIG, agentUrl, agentTimeoutMs: 5_000 },
    readGithubLogin: async () => ({ login: "Estudiante-GH", id: 4242 }),
    fetch: async (url, init) => {
      const body = typeof init?.body === "string" ? JSON.parse(init.body) : null;
      calls.push({ method: init?.method || "GET", path: url.replace(agentUrl, ""), body });
      // Simula el relay de un agente anterior (rechaza ?repo=) las veces que diga el caso.
      if (url.includes("?repo=") && rejectRepoQueries > 0) {
        rejectRepoQueries -= 1;
        return jsonResponse(403, { state: "error", code: "route_not_allowed", message: "Ruta no permitida por el relay." });
      }
      return fetch(url, init);
    },
  });
  const statusOf = (repo: string) => callApi(started.baseUrl, `/api/workspaces/status?repoFullName=${encodeURIComponent(repo)}`, { sessionId: started.session.id });
  const urlOf = (folder: string) => `https://vscode.dev/tunnel/ad-estudiante-gh/home/ws-estudiante-gh/${folder}`;
  try {
    const first = await callApi(started.baseUrl, "/api/workspaces/prepare", { sessionId: started.session.id, body: { repoFullName: "prof/lento-a" } });
    assert.equal(first.body.status, "pending", "A se esta clonando");
    const second = await callApi(started.baseUrl, "/api/workspaces/prepare", { sessionId: started.session.id, body: { repoFullName: "prof/b" } });
    assert.equal(second.body.code, "busy_other_repo");
    assert.equal(second.body.retryable, true);
    // La extension sigue consultando B: nunca un error terminal, y termina listo
    // en SU carpeta (antes acababa en not_found y habia que pulsar otra vez).
    let last = second;
    for (let i = 0; i < 30 && last.body.status !== "ready"; i += 1) {
      await new Promise((resolve) => setTimeout(resolve, 150));
      last = await statusOf("prof/b");
      assert.ok(last.body.status !== "error" || last.body.retryable === true, `status de B #${i}: ${last.body.code} ${last.body.message}`);
    }
    assert.equal(last.body.status, "ready");
    assert.equal(last.body.workspace?.webUrl, urlOf("b"));
    assert.equal((await statusOf("prof/lento-a")).body.workspace?.webUrl, urlOf("lento-a"));
    // El id publico de GitHub viaja en el POST y llega al script (correo noreply ID+login).
    const posts = calls.filter((call) => call.method === "POST" && call.body?.repo);
    assert.ok(posts.length >= 2);
    assert.ok(posts.every((call) => call.body?.githubUserId === 4242 && !("cloneToken" in (call.body || {}))));
    assert.equal(readFileSync(path.join(dir, "id-estudiante-gh"), "utf8").trim(), "4242");

    // 404 de un repo que aun no esta: trae los demas en editors.
    const missing = await statusOf("prof/c");
    assert.equal(missing.body.code, "not_found");
    assert.deepEqual((missing.body as EditorsBody).editors?.map((editor) => editor.repoFullName).sort(), ["prof/b", "prof/lento-a"]);

    // Modo de compatibilidad (el relay rechazo ?repo= una vez): la consulta solo por
    // login nunca devuelve la URL de otro repositorio...
    rejectRepoQueries = 1;
    const compat = await statusOf("prof/c");
    assert.notEqual(compat.body.status, "ready", "un ready de otro repo no abre prof/c");
    assert.equal(compat.body.workspace?.webUrl?.endsWith("/c") ?? false, false);
    // ...y como el agente responde folder (es 0.7.20), la siguiente vuelve a ?repo=.
    calls.length = 0;
    const back = await statusOf("prof/lento-a");
    assert.equal(back.body.status, "ready");
    assert.equal(back.body.workspace?.webUrl, urlOf("lento-a"));
    assert.ok(calls.some((call) => call.path === `/workspaces/estudiante-gh?repo=${encodeURIComponent("prof/lento-a")}`));
    calls.length = 0;
    await statusOf("prof/b");
    assert.deepEqual(calls.filter((call) => call.method === "GET").map((call) => call.path), [`/workspaces/estudiante-gh?repo=${encodeURIComponent("prof/b")}`]);
  } finally {
    await stopServer(started.server, started.database);
    await agente.cerrar();
    rmSync(dir, { recursive: true, force: true });
  }

  // Agente anterior (sin folder): un "ready" que dice ser de otro repo es not_found.
  const legacy = mapAgentResult({
    kind: "response",
    status: 200,
    json: { state: "ready", tunnelName: "ad-eyder", webUrl: "https://vscode.dev/tunnel/ad-eyder/home/ws-eyder/proyecto", repo: "a/otro" },
  }, { login: "eyder", repoFullName: "a/Taller" });
  assert.equal(legacy.status, "error");
  assert.equal(legacy.code, "not_found");
  assert.match(legacy.message || "", /a\/Taller todavia no esta en tu editor/);
  const same = mapAgentResult({
    kind: "response",
    status: 200,
    json: { state: "ready", tunnelName: "ad-eyder", webUrl: "https://vscode.dev/tunnel/ad-eyder/home/ws-eyder/proyecto", repo: "A/taller" },
  }, { login: "eyder", repoFullName: "a/Taller" });
  assert.equal(same.status, "ready", "mismo repo con otras mayusculas: listo");
});

test("workspaces 0.7.20: status passive=1 solo mira (sin encender la VM, sin reenviar ni tocar la preparacion) y el reenvio vence a los 15 min", async () => {
  let clock = Date.parse("2026-10-01T15:00:00.000Z");
  let vmStatus = "TERMINATED";
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
  let agentUp = false;
  const agent = fakeAgent((call) => {
    if (!agentUp) throw new TypeError("fetch failed: connect EHOSTUNREACH");
    return jsonResponse(200, { login: "estudiante-gh", state: "ready", tunnelName: "ad-estudiante-gh", webUrl: "https://vscode.dev/tunnel/ad-estudiante-gh/home/ws-estudiante-gh/Proyecto-Final", folder: "Proyecto-Final", repo: call.method === "POST" ? REPO : undefined });
  });
  const { server, database, session, baseUrl } = await startServer({
    config: TUNNEL_CONFIG,
    fetch: agent.fetchImpl,
    readGithubLogin: githubLoginReader,
    publicBaseUrl: "https://adaceen.prueba",
    autostart,
    now: () => clock,
  });
  const passivePath = `${statusPath}&passive=1`;
  const posts = () => agent.calls.filter((call) => call.method === "POST").length;
  try {
    // Entrar en la pagina (docente, administrador o estudiante): la VM apagada sigue apagada.
    const look = await callApi(baseUrl, passivePath, { sessionId: session.id });
    assert.equal(look.status, 200);
    assert.equal(look.body.code, "agent_unreachable");
    assert.deepEqual(computeCalls, [], "mirar no enciende la VM");
    assert.equal(posts(), 0);

    // El clic si la enciende; la preparacion queda pendiente de reenvio.
    const starting = await callApi(baseUrl, "/api/workspaces/prepare", { sessionId: session.id, body: { repoFullName: REPO, force: true } });
    assert.equal(starting.body.code, "vm_starting");
    const events = (await database.listBehaviorEventsForViewer({ viewer: session.user })).length;
    const postsBefore = posts();
    const startsBefore = computeCalls.filter((call) => call.startsWith("POST")).length;

    // Otra pestana mira mientras tanto: ni reenvia el prepare, ni enciende, ni registra nada.
    const lookAgain = await callApi(baseUrl, passivePath, { sessionId: session.id });
    assert.equal(lookAgain.body.code, "agent_unreachable");
    assert.equal(posts(), postsBefore, "passive no reenvia el prepare pendiente");
    assert.equal(computeCalls.filter((call) => call.startsWith("POST")).length, startsBefore);
    assert.equal((await database.listBehaviorEventsForViewer({ viewer: session.user })).length, events);

    // La pestana que espera si reenvia (la preparacion sigue abierta).
    await callApi(baseUrl, statusPath, { sessionId: session.id });
    assert.equal(posts(), postsBefore + 1, "la espera de la extension reenvia");

    // 15 min despues la extension ya dejo de esperar: un status no resucita el «Rehacer»
    // ni registra un «listo» de esa preparacion con su force y horas de duracion.
    clock += 16 * 60 * 1000;
    agentUp = true;
    const late = postsBefore + 1;
    const lateReady = await callApi(baseUrl, statusPath, { sessionId: session.id });
    assert.equal(lateReady.body.status, "ready");
    assert.equal(posts(), late, "fuera de la ventana de espera no se reenvia (ni con force)");
    assert.deepEqual(await database.listBehaviorEventsForViewer({ viewer: session.user, eventType: "tunnel_workspace_ready" }), []);
  } finally {
    await stopServer(server, database);
  }

  // Editor listo y sin sesion de VS Code en la VM (tras «Salir»): mirar no manda nada a la
  // VM (la renueva el primer clic); un status de la espera si la reescribe.
  const ready = fakeAgent(() => jsonResponse(200, { login: "estudiante-gh", state: "ready", tunnelName: "ad-estudiante-gh", webUrl: "https://vscode.dev/tunnel/ad-estudiante-gh/home/ws-estudiante-gh/Proyecto-Final", folder: "Proyecto-Final" }));
  const look = await startServer({ config: TUNNEL_CONFIG, fetch: ready.fetchImpl, readGithubLogin: githubLoginReader, publicBaseUrl: "https://adaceen.prueba" });
  try {
    const seen = await callApi(look.baseUrl, `${statusPath}&passive=1`, { sessionId: look.session.id });
    assert.equal(seen.body.status, "ready");
    assert.deepEqual(ready.calls.map((call) => call.method), ["GET"], "passive: solo el GET");
    await callApi(look.baseUrl, statusPath, { sessionId: look.session.id });
    assert.deepEqual(ready.calls.map((call) => call.method), ["GET", "GET", "POST"], "sin passive: reescribe la sesion");
  } finally {
    await stopServer(look.server, look.database);
  }
});

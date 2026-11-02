import assert from "node:assert/strict";
import test from "node:test";
import { workspacePayloadForRole } from "../../../src/routes/workspace/workspace-prepare-routes.js";
import { buildWorkspaceErrorPayload, buildWorkspaceInfo } from "../../../src/services/workspace/workspace-agent-result.js";
import { REPO, TUNNEL_CONFIG, jsonResponse, fakeAgent, githubLoginReader, startServer, stopServer, callApi, statusPath } from "./helpers.js";

test("workspaces: reconectar (0.8.1) llega al agente; uno anterior que lo ignora -> reconnect_unsupported", async () => {
  const common = {
    login: "estudiante-gh",
    tunnelName: "ad-estudiante-gh",
    webUrl: "https://vscode.dev/tunnel/ad-estudiante-gh/home/ws-estudiante-gh/Proyecto-Final",
    folder: "Proyecto-Final",
    repo: REPO,
  };
  const expiresAt = new Date(Date.now() + 14 * 60 * 1000).toISOString();
  let agentVersion: "nuevo" | "anterior" | "apagado" = "nuevo";
  const agent = fakeAgent((call) => {
    if (agentVersion === "apagado") throw new TypeError("fetch failed: connect ECONNREFUSED 10.128.0.5:8787");
    const reconnect = (call.body as { reconnect?: boolean } | null)?.reconnect === true;
    if (call.method === "POST" && reconnect && agentVersion === "nuevo") {
      return jsonResponse(200, { ...common, state: "device_code", deviceCode: "NUEV-0001", verificationUrl: "https://github.com/login/device", expiresAt, reconnect: true });
    }
    // El agente anterior no conoce reconnect: responde como un prepare normal.
    return jsonResponse(200, { ...common, state: "ready" });
  });
  const { server, database, session, baseUrl } = await startServer({
    config: TUNNEL_CONFIG,
    fetch: agent.fetchImpl,
    readGithubLogin: githubLoginReader,
    publicBaseUrl: "https://adaceen.prueba",
  });
  try {
    const reconnected = await callApi(baseUrl, "/api/workspaces/prepare", { sessionId: session.id, body: { repoFullName: REPO, reconnect: true } });
    assert.equal(reconnected.status, 200);
    assert.equal(reconnected.body.status, "device_code");
    assert.equal(reconnected.body.deviceCode?.userCode, "NUEV-0001");
    const sent = agent.calls.at(-1)?.body as { reconnect?: boolean; force?: boolean };
    assert.equal(sent.reconnect, true);
    assert.equal(sent.force, false, "reconectar no aparta el clon");
    const started = await database.listBehaviorEventsForViewer({ viewer: session.user, eventType: "prepare_environment_retry_started" });
    assert.equal(started.length, 1);
    assert.equal(started[0].metadata.mode, "reconnect", "metadata.mode pasa la lista blanca");

    assert.equal((await callApi(baseUrl, "/api/workspaces/prepare", { sessionId: session.id, body: { repoFullName: REPO, reconnect: "si" } })).status, 400);

    agentVersion = "anterior";
    const old = await callApi(baseUrl, "/api/workspaces/prepare", { sessionId: session.id, body: { repoFullName: REPO, reconnect: true } });
    assert.equal(old.status, 200);
    assert.equal(old.body.ok, false);
    assert.equal(old.body.status, "error");
    assert.equal(old.body.code, "reconnect_unsupported");
    assert.match(old.body.message || "", /desactualizada.*Avisa al docente/);
    // Sin reconnect, el mismo agente anterior sigue sirviendo como siempre.
    const plain = await callApi(baseUrl, "/api/workspaces/prepare", { sessionId: session.id, body: { repoFullName: REPO } });
    assert.equal(plain.body.status, "ready");
    assert.equal("reconnect" in (agent.calls.at(-1)?.body as object), false);

    // VM apagada al pedirlo: el reenvio de status tambien reconecta.
    agentVersion = "apagado";
    const off = await callApi(baseUrl, "/api/workspaces/prepare", { sessionId: session.id, body: { repoFullName: REPO, reconnect: true } });
    assert.equal(off.body.code, "agent_unreachable");
    agentVersion = "nuevo";
    const back = await callApi(baseUrl, statusPath, { sessionId: session.id });
    assert.equal(back.body.status, "device_code");
    const resent = agent.calls.at(-1);
    assert.equal(resent?.method, "POST");
    assert.equal((resent?.body as { reconnect?: boolean }).reconnect, true);
  } finally {
    await stopServer(server, database);
  }

  // Docente o administrador: el mensaje dice como actualizar la VM.
  const forTeacher = workspacePayloadForRole(
    buildWorkspaceErrorPayload("reconnect_unsupported", "x", buildWorkspaceInfo("estudiante-gh", REPO)),
    "teacher",
  );
  assert.match(forTeacher.message || "", /google_metadata_script_runner startup/);
  assert.match(forTeacher.message || "", /Reconectar/);
});

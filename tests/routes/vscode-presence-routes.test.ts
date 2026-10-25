import assert from "node:assert/strict";
import test from "node:test";
import type { Server } from "node:http";
import { createApp } from "../../src/app.js";
import { createDatabase, type AppDatabase } from "../../src/db/database.js";
import { readDownloadVersions } from "../../src/routes/start-page-routes.js";
import { clearDownloadVersionsCache, readDownloadVersionsCached } from "../../src/services/download-versions.js";
import {
  clearVscodePresences,
  describeVscodeExtension,
  describeVscodeExtensionsByHost,
  isVscodeHost,
  recordVscodePresence,
  readVscodePresence,
  vscodeHostFromWorkerId,
} from "../../src/services/vscode-presence.js";

/**
 * Guia del tunel (25/10/2026): el aviso del paso 4 en vscode.dev comprueba que la extension
 * ADACEEN de VS Code este en el editor y sea la ultima. El backend lo sabe por las llamadas de
 * VS Code (x-adaceen-worker-id y, desde la 0.0.37, x-adaceen-vscode-version), por usuario y por
 * tipo de editor (tunel, VS Code instalado, Codespaces).
 */

type PresenceReply = { ok: boolean; status: string; version: string; host: string; latest_version: string; fresh: boolean; error?: string };

async function startTestServer() {
  clearVscodePresences();
  const database = await createDatabase();
  const app = createApp(database);
  const server = await new Promise<Server>((resolve) => {
    const started = app.listen(0, () => resolve(started));
  });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("No se pudo iniciar servidor de prueba.");
  return { database, server, baseUrl: `http://127.0.0.1:${address.port}` };
}

async function stopTestServer(server: Server, database: AppDatabase) {
  await new Promise<void>((resolve, reject) => {
    server.close((error) => error ? reject(error) : resolve());
  });
  await database.close();
}

async function login(baseUrl: string, email: string, password: string) {
  const response = await fetch(`${baseUrl}/api/auth/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json; charset=utf-8" },
    body: JSON.stringify({ email, password }),
  });
  const data = await response.json() as { session?: { id?: string }; error?: string };
  assert.equal(response.status, 200, data.error);
  return String(data.session?.id);
}

async function presence(baseUrl: string, sessionId: string, host = "") {
  const query = host ? `?host=${encodeURIComponent(host)}` : "";
  const response = await fetch(`${baseUrl}/api/vscode/presence${query}`, { headers: { "x-session-id": sessionId } });
  return { status: response.status, body: await response.json() as PresenceReply };
}

function vscodeCall(baseUrl: string, sessionId: string, remote: string, version = "") {
  return fetch(`${baseUrl}/api/health`, {
    headers: {
      "x-session-id": sessionId,
      "x-adaceen-worker-id": `adaceen-vscode-${remote}`,
      ...(version ? { "x-adaceen-vscode-version": version } : {}),
    },
  });
}

test("la guia sabe si VS Code tiene ADACEEN y si es la ultima version", async () => {
  const { server, database, baseUrl } = await startTestServer();
  try {
    const unauthorized = await fetch(`${baseUrl}/api/vscode/presence`);
    assert.equal(unauthorized.status, 401);

    const sessionId = await login(baseUrl, "estudiante@adaceen.edu.co", "Estudiante123!");
    const latest = readDownloadVersions(process.cwd()).vscode;
    assert.ok(latest, "el repositorio publica una version de VS Code");

    const before = await presence(baseUrl, sessionId, "tunnel");
    assert.equal(before.status, 200);
    assert.equal(before.body.status, "not_seen");
    assert.equal(before.body.latest_version, latest);

    // VS Code 0.0.36 (sin la cabecera de version) desde el tunel.
    await vscodeCall(baseUrl, sessionId, "tunnel");
    const old = await presence(baseUrl, sessionId, "tunnel");
    assert.deepEqual([old.body.status, old.body.host, old.body.fresh], ["unknown_version", "tunnel", true]);

    // Una version anterior a la publicada.
    await vscodeCall(baseUrl, sessionId, "tunnel", "0.0.1");
    assert.equal((await presence(baseUrl, sessionId, "tunnel")).body.status, "outdated");

    // La publicada.
    await vscodeCall(baseUrl, sessionId, "tunnel", latest);
    const current = await presence(baseUrl, sessionId, "tunnel");
    assert.deepEqual([current.body.status, current.body.version], ["up_to_date", latest]);

    // VS Code instalado (la Mac) con otra version no tapa lo que se vio en el tunel.
    await vscodeCall(baseUrl, sessionId, "local", "0.0.1");
    assert.equal((await presence(baseUrl, sessionId, "tunnel")).body.status, "up_to_date", "el tunel sigue al dia");
    const local = await presence(baseUrl, sessionId, "local");
    assert.deepEqual([local.body.status, local.body.host], ["outdated", "local"]);
    const any = await presence(baseUrl, sessionId);
    assert.equal(any.body.host, "local", "sin host: el mas reciente");
    assert.equal((await presence(baseUrl, sessionId, "codespaces")).body.status, "not_seen");

    // Un host que no existe es un error del que llama, no «no visto».
    const wrong = await presence(baseUrl, sessionId, "windows");
    assert.equal(wrong.status, 400);
    assert.equal(wrong.body.ok, false);

    // El estado de la sesion (la linea «VS Code» de Inicio) trae todos los editores.
    const stateResponse = await fetch(`${baseUrl}/api/projects/session/state`, { headers: { "x-session-id": sessionId } });
    assert.equal(stateResponse.status, 200);
    const state = (await stateResponse.json() as { state: { vscodeExtension: ReturnType<typeof describeVscodeExtensionsByHost> } }).state;
    assert.equal(state.vscodeExtension.latest_version, latest);
    assert.equal(state.vscodeExtension.latest, "local");
    assert.equal(state.vscodeExtension.hosts.tunnel?.status, "up_to_date");
    assert.equal(state.vscodeExtension.hosts.local?.status, "outdated");
    assert.equal(state.vscodeExtension.hosts.codespaces, undefined);

    // Una llamada del navegador (sin el worker de VS Code) no cuenta como VS Code.
    clearVscodePresences();
    await fetch(`${baseUrl}/api/health`, { headers: { "x-session-id": sessionId } });
    assert.equal((await presence(baseUrl, sessionId)).body.status, "not_seen");
  } finally {
    await stopTestServer(server, database);
  }
});

test("presencia de VS Code: el remoto, la frescura y el olvido", () => {
  clearVscodePresences();
  assert.equal(vscodeHostFromWorkerId("adaceen-vscode-tunnel"), "tunnel");
  assert.equal(vscodeHostFromWorkerId("adaceen-vscode-local"), "local");
  assert.equal(vscodeHostFromWorkerId("adaceen-vscode-codespaces"), "codespaces");
  assert.equal(vscodeHostFromWorkerId("adaceen-vscode-ssh-remote"), "other");
  assert.equal(vscodeHostFromWorkerId("adaceen-browser"), "");
  assert.equal(isVscodeHost("tunnel"), true);
  assert.equal(isVscodeHost("windows"), false);
  const t0 = Date.parse("2026-10-25T20:00:00Z");
  recordVscodePresence("u1", "adaceen-vscode-tunnel", "0.0.37", t0);
  recordVscodePresence("u2", "otro-worker", "0.0.37", t0);
  assert.equal(readVscodePresence("u2", undefined, t0), null, "solo VS Code");
  const seen = readVscodePresence("u1", "tunnel", t0);
  assert.deepEqual(describeVscodeExtension(seen, "0.0.37", t0 + 60_000), {
    status: "up_to_date", latest_version: "0.0.37", version: "0.0.37", host: "tunnel", seen_at: "2026-10-25T20:00:00.000Z", fresh: true,
  });
  assert.equal(describeVscodeExtension(seen, "0.0.38", t0 + 120_000).status, "outdated");
  assert.equal(describeVscodeExtension(seen, "0.0.38", t0 + 120_000).fresh, false, "sin llamadas en 2 min: VS Code cerrado");
  assert.equal(readVscodePresence("u1", "local", t0), null, "otro tipo de editor");
  recordVscodePresence("u1", "adaceen-vscode-tunnel", "no-es-version", t0);
  assert.equal(describeVscodeExtension(readVscodePresence("u1", "tunnel", t0), "0.0.37", t0).status, "unknown_version");
  // Por editor: el mas reciente sin host, cada uno con host.
  recordVscodePresence("u1", "adaceen-vscode-local", "0.0.36", t0 + 1_000);
  assert.equal(readVscodePresence("u1", undefined, t0 + 2_000)?.host, "local");
  const byHost = describeVscodeExtensionsByHost("u1", "0.0.37", t0 + 2_000);
  assert.deepEqual(Object.keys(byHost.hosts).sort(), ["local", "tunnel"]);
  assert.equal(byHost.latest, "local");
  assert.equal(byHost.hosts.local?.status, "outdated");
  assert.equal(readVscodePresence("u1", undefined, t0 + 7 * 60 * 60_000), null, "se olvida a las 6 h");
  assert.deepEqual(describeVscodeExtensionsByHost("u1", "0.0.37", t0 + 7 * 60 * 60_000), { latest_version: "0.0.37", latest: "", hosts: {} });
});

test("la version publicada se lee del disco a lo sumo una vez por minuto", () => {
  clearDownloadVersionsCache();
  const t0 = Date.parse("2026-10-25T20:00:00Z");
  const first = readDownloadVersionsCached(process.cwd(), t0);
  assert.deepEqual(first, readDownloadVersions(process.cwd()));
  assert.equal(readDownloadVersionsCached(process.cwd(), t0 + 30_000), first, "dentro del minuto: el mismo objeto");
  assert.notEqual(readDownloadVersionsCached(process.cwd(), t0 + 61_000), first, "pasado el minuto se vuelve a leer");
  clearDownloadVersionsCache();
});

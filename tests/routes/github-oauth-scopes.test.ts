import assert from "node:assert/strict";
import test from "node:test";
import type { Server } from "node:http";
import { createApp } from "../../src/app.js";
import { env } from "../../src/config/env.js";
import { createDatabase, type AppDatabase } from "../../src/db/database.js";
import { githubOAuthScopesForProvider } from "../../src/services/github-oauth.js";

/**
 * Scopes del OAuth de GitHub segun el entorno activo de los estudiantes: con el tunel el
 * token solo sirve para leer el login y el correo (GITHUB_OAUTH_SCOPES_TUNNEL), asi GitHub
 * no pide "control total de repositorios privados"; con Codespaces se piden los de siempre
 * (GITHUB_OAUTH_SCOPES). El entorno activo es el de la tuerca de la extension o, si no
 * eligieron nada, el de ADACEEN_WORKSPACE_PROVIDER.
 */

const FULL_SCOPES = "repo codespace read:user user:email";
const TUNNEL_SCOPES = "read:user user:email";

async function startTestServer() {
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
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email, password }),
  });
  const text = await response.text();
  assert.equal(response.status, 200, `login de ${email}: ${text}`);
  return String((JSON.parse(text) as { session: { id: string } }).session.id);
}

type StartBody = { ok: boolean; authorizeUrl: string; scopes: string[]; provider: string };

async function startOAuth(baseUrl: string, sessionId: string) {
  const response = await fetch(`${baseUrl}/api/github/oauth/start`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "x-session-id": sessionId },
    body: JSON.stringify({ repoFullName: "curso/tarea-1" }),
  });
  assert.equal(response.status, 200);
  const body = await response.json() as StartBody;
  return { body, scope: new URL(body.authorizeUrl).searchParams.get("scope") };
}

test("OAuth de GitHub: con el tunel se piden solo read:user y user:email; con Codespaces los completos", async () => {
  const envKeys = [
    "githubOAuthClientId", "githubOAuthClientSecret", "githubOAuthCallbackUrl", "githubOAuthScopes", "githubOAuthScopesTunnel",
    "workspaceProvider", "workspaceAgentTransport", "workspaceAgentToken",
  ] as const;
  const savedEnv = Object.fromEntries(envKeys.map((key) => [key, env[key]]));
  Object.assign(env, {
    githubOAuthClientId: "Ov23liPruebaScopes",
    githubOAuthClientSecret: "secreto-oauth-de-prueba",
    githubOAuthCallbackUrl: "https://adaceen.prueba/auth/github/callback",
    githubOAuthScopes: FULL_SCOPES,
    githubOAuthScopesTunnel: TUNNEL_SCOPES,
    workspaceProvider: "codespaces",
    // Con token del agente el administrador puede elegir el tunel en la tuerca (si no, 409).
    workspaceAgentTransport: "relay",
    workspaceAgentToken: "token-agente-de-prueba-0123456789",
  });
  const { server, database, baseUrl } = await startTestServer();
  try {
    const student = await login(baseUrl, "estudiante@adaceen.edu.co", "Estudiante123!");

    // Variable en codespaces y nada elegido en la tuerca: los scopes de siempre.
    let start = await startOAuth(baseUrl, student);
    assert.equal(start.scope, FULL_SCOPES);
    assert.deepEqual(start.body.scopes, ["repo", "codespace", "read:user", "user:email"]);
    assert.equal(start.body.provider, "codespaces");

    // Variable en tunnel: solo lo que hace falta para leer el login y el correo.
    env.workspaceProvider = "tunnel";
    start = await startOAuth(baseUrl, student);
    assert.equal(start.scope, TUNNEL_SCOPES);
    assert.deepEqual(start.body.scopes, ["read:user", "user:email"]);
    assert.equal(start.body.provider, "tunnel");
    assert.doesNotMatch(start.body.authorizeUrl, /repo|codespace/);

    // Lo elegido en la tuerca de la extension manda sobre la variable (0.7.19). La sesion del
    // administrador sale de la base: su login HTTP carga la politica con una consulta que pg-mem
    // no soporta (lookups on joins), como en workspace-routes.test.ts.
    env.workspaceProvider = "codespaces";
    const adminSession = await database.authenticateUser("admin@adaceen.edu.co", "Admin123!");
    assert.ok(adminSession, "el administrador demo inicia sesion");
    const admin = adminSession.id;
    const choose = async (provider: string) => {
      const response = await fetch(`${baseUrl}/api/admin/workspace-provider`, {
        method: "PUT",
        headers: { "Content-Type": "application/json", "x-session-id": admin },
        body: JSON.stringify({ provider }),
      });
      assert.equal(response.status, 200, await response.text());
    };
    await choose("tunnel");
    start = await startOAuth(baseUrl, student);
    assert.equal(start.scope, TUNNEL_SCOPES);
    assert.equal(start.body.provider, "tunnel");
    await choose("server");
    start = await startOAuth(baseUrl, student);
    assert.equal(start.scope, FULL_SCOPES);
    assert.equal(start.body.provider, "codespaces");

    // Un token guardado con los scopes amplios sigue valiendo, sea cual sea el entorno.
    await choose("tunnel");
    await database.upsertGithubUserToken({
      userId: "user-student-demo",
      accountLogin: "Estudiante-GH",
      accessToken: "gho_scopes_amplios",
      scopes: "repo,codespace,read:user,user:email",
    });
    const status = await fetch(`${baseUrl}/api/github/oauth/status`, { headers: { "x-session-id": student } });
    const statusBody = await status.json() as { connected: boolean; hasCodespaceScope: boolean; scopes: string[] };
    assert.equal(statusBody.connected, true);
    assert.equal(statusBody.hasCodespaceScope, true);
    assert.deepEqual(statusBody.scopes, ["repo", "codespace", "read:user", "user:email"]);

    // Las variables aceptan comas o espacios; a GitHub siempre van separados por espacio.
    env.githubOAuthScopesTunnel = "read:user, user:email";
    assert.equal(githubOAuthScopesForProvider("tunnel"), TUNNEL_SCOPES);
    assert.equal(githubOAuthScopesForProvider("codespaces"), FULL_SCOPES);
    start = await startOAuth(baseUrl, student);
    assert.equal(start.scope, TUNNEL_SCOPES);
  } finally {
    Object.assign(env, savedEnv);
    await stopTestServer(server, database);
  }
});

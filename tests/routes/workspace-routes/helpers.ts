import assert from "node:assert/strict";
import type { Server } from "node:http";
import express from "express";
import { createDatabase, type AppDatabase } from "../../../src/db/database.js";
import { registerHealthRoutes } from "../../../src/routes/platform/health-routes.js";
import { registerWorkspaceRoutes, type WorkspaceRouteDeps } from "../../../src/routes/workspace/workspace-routes.js";
import type { FetchLike, WorkspaceConfig } from "../../../src/services/workspace/workspace-config.js";

export const AGENT_URL = "http://agente.prueba:8787";
export const AGENT_TOKEN = "token-agente-de-prueba-0123456789";
export const GITHUB_TOKEN = "gho_token_de_prueba";
export const REPO = "Univalle-ADACEEN/Proyecto-Final";

export const TUNNEL_CONFIG: WorkspaceConfig = {
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

export function jsonResponse(status: number, body: unknown) {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

// Agente falso: registra las llamadas y responde lo que diga el caso.
export function fakeAgent(handler: (call: AgentCall) => Response | Promise<Response>) {
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

export const githubLoginReader = async (accessToken: string) => {
  assert.equal(accessToken, GITHUB_TOKEN, "el login sale del token OAuth guardado del estudiante");
  return "Estudiante-GH";
};

// Por defecto GitHub ve el repositorio y es publico (0.7.20): sin token de clon y
// sin una llamada extra al fetch falso del agente. Los casos de repos privados o
// sin acceso pasan su propio lector.
const publicRepoReader = async (_token: string, repoFullName: string) => ({ state: "visible" as const, private: false, fullName: repoFullName });

export async function startServer(deps: WorkspaceRouteDeps, options: { connectGithub?: boolean; health?: boolean } = {}) {
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

export async function stopServer(server: Server, database: AppDatabase) {
  await new Promise<void>((resolve, reject) => {
    server.close((error) => error ? reject(error) : resolve());
  });
  await database.close();
}

export type WorkspaceBody = {
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

export async function callApi(baseUrl: string, path: string, options: { sessionId?: string; body?: unknown; headers?: Record<string, string> } = {}) {
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

export const statusPath = `/api/workspaces/status?repoFullName=${encodeURIComponent(REPO)}`;

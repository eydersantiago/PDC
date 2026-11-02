import assert from "node:assert/strict";
import type { Server } from "node:http";
import express from "express";
import { createApp } from "../../../src/app.js";
import { createDatabase, type AppDatabase } from "../../../src/db/database.js";
import { registerAuthRoutes } from "../../../src/routes/auth/auth-routes.js";
import { registerEditorAuthRoutes, type EditorAuthDeps } from "../../../src/routes/auth/editor-auth-routes.js";
import { createSessionStateMiddleware } from "../../../src/routes/route-utils.js";

/**
 * Acceso simplificado (docs/arquitectura/acceso-simplificado.md, secciones 1 y 2):
 * sesiones por tipo, aviso de sesion invalida, codigos de emparejamiento y
 * canje con la cuenta de GitHub de VS Code.
 */

export const STUDENT = { email: "estudiante@adaceen.edu.co", password: "Estudiante123!" };
export const TEACHER = { email: "docente@adaceen.edu.co", password: "Docente123!" };

type Started = { database: AppDatabase; server: Server; baseUrl: string };

async function listen(app: express.Express, database: AppDatabase): Promise<Started> {
  const server = await new Promise<Server>((resolve) => {
    const started = app.listen(0, () => resolve(started));
  });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("No se pudo iniciar servidor de prueba.");
  return { database, server, baseUrl: `http://127.0.0.1:${address.port}` };
}

export async function startFullApp() {
  const database = await createDatabase();
  return listen(createApp(database), database);
}

// App minima con el lector de GitHub y los limitadores inyectados (sin red).
export async function startEditorApp(deps: EditorAuthDeps = {}) {
  const database = await createDatabase();
  const app = express();
  app.use(express.json());
  app.use(createSessionStateMiddleware(database));
  registerAuthRoutes(app, database);
  registerEditorAuthRoutes(app, database, deps);
  return listen(app, database);
}

export async function stop({ server, database }: Started) {
  await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  await database.close();
}

type Json = Record<string, unknown> & {
  ok?: boolean;
  error?: string;
  message?: string;
  code?: string;
  sessionId?: string;
  expiresAt?: string;
  ttlSeconds?: number;
  githubLogin?: string;
  user?: { id?: string; role?: string; email?: string; displayName?: string };
  session?: { id?: string; kind?: string; expiresAt?: string | null };
};

export async function call(baseUrl: string, method: string, route: string, options: {
  sessionId?: string;
  body?: unknown;
  headers?: Record<string, string>;
} = {}) {
  const response = await fetch(`${baseUrl}${route}`, {
    method,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      ...(options.sessionId ? { "x-session-id": options.sessionId } : {}),
      ...(options.headers || {}),
    },
    ...(options.body === undefined ? {} : { body: JSON.stringify(options.body) }),
  });
  const text = await response.text();
  let data: Json = {};
  try {
    data = text ? JSON.parse(text) as Json : {};
  } catch {
    data = {};
  }
  return { status: response.status, headers: response.headers, data };
}

export async function login(baseUrl: string, account: { email: string; password: string }, sessionKind?: string) {
  const result = await call(baseUrl, "POST", "/api/auth/login", {
    body: { ...account, ...(sessionKind ? { sessionKind } : {}) },
  });
  assert.equal(result.status, 200, `login ${account.email}`);
  return result.data;
}

export function daysFromNow(iso: string | null | undefined) {
  return (Date.parse(String(iso)) - Date.now()) / (24 * 60 * 60 * 1000);
}

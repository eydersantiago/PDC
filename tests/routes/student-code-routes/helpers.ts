import assert from "node:assert/strict";
import type { Server } from "node:http";
import { OAuth2Client } from "google-auth-library";
import { createApp } from "../../../src/app.js";
import { env } from "../../../src/config/env.js";
import { createDatabase, type AppDatabase } from "../../../src/db/database.js";
import { resetStudentCodeAttemptsForTests } from "../../../src/routes/auth/auth-routes.js";

/**
 * Codigo de estudiante como identidad (navegador 0.7.22): Google dice con que correo llega y el
 * codigo dice quien es. Un estudiante no entra sin codigo, un codigo no queda en dos cuentas y un
 * segundo correo con el mismo codigo entra a la misma cuenta (prevalece su user_id): solo, si la
 * cuenta nunca entro, o cuando el docente lo aprueba, si ya entro.
 */

export type AuthReply = {
  ok: boolean;
  step?: string;
  error?: string;
  maskedEmail?: string;
  displayName?: string;
  email?: string;
  firstLogin?: boolean;
  session?: { id: string; user: { id: string; email: string; role: string } };
};
export type ManagedUser = { id: string; email: string; role: string; isActive: boolean; studentCode?: string | null; loginEmails?: string[]; hasSignedIn?: boolean };
export type AccessRequest = { id: string; email: string; studentCode: string; target: { id: string; email: string }; source: { id: string; hasSignedIn: boolean } | null };
export type UsersReply = { ok: boolean; users: ManagedUser[]; accessRequests: AccessRequest[]; error?: string };

export async function startTestServer() {
  resetStudentCodeAttemptsForTests();
  const database = await createDatabase();
  const app = createApp(database);
  const server = await new Promise<Server>((resolve) => {
    const started = app.listen(0, () => resolve(started));
  });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("No se pudo iniciar servidor de prueba.");
  return { database, server, baseUrl: `http://127.0.0.1:${address.port}` };
}

export async function stopTestServer(server: Server, database: AppDatabase) {
  await new Promise<void>((resolve, reject) => {
    server.close((error) => error ? reject(error) : resolve());
  });
  await database.close();
}

export async function call<T>(baseUrl: string, method: string, route: string, options: { sessionId?: string; body?: unknown } = {}) {
  const response = await fetch(`${baseUrl}${route}`, {
    method,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      ...(options.sessionId ? { "x-session-id": options.sessionId } : {}),
    },
    ...(options.body === undefined ? {} : { body: JSON.stringify(options.body) }),
  });
  return { status: response.status, data: await response.json() as T };
}

/**
 * Google simulado: cada token «token-google-<correo>» es de ese correo. Devuelve la funcion que
 * entra con Google y la que deja todo como estaba.
 */
export function simulateGoogle(baseUrl: string) {
  const previous = { clientId: env.googleClientId, password: env.googleDefaultPassword, domain: env.googleAllowedHostedDomain };
  const originalTokenInfo = OAuth2Client.prototype.getTokenInfo;
  const originalFetch = globalThis.fetch;
  env.googleClientId = "cliente-google-de-prueba.apps.googleusercontent.com";
  env.googleDefaultPassword = "ClaveGoogle123!";
  env.googleAllowedHostedDomain = "";
  let currentEmail = "";
  let currentName = "";
  OAuth2Client.prototype.getTokenInfo = async function () {
    return { aud: env.googleClientId, email: currentEmail, email_verified: true } as unknown as Awaited<ReturnType<OAuth2Client["getTokenInfo"]>>;
  };
  globalThis.fetch = (async (input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
    if (String(input).startsWith("https://www.googleapis.com/oauth2/v3/userinfo")) {
      return new Response(JSON.stringify({ email: currentEmail, email_verified: true, name: currentName }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }
    return originalFetch(input, init);
  }) as typeof fetch;
  /** name: el nombre de la cuenta de Google (por defecto «Nombre de <usuario>»). */
  const google = (email: string, extra: { studentCode?: string; sessionId?: string; name?: string } = {}) => {
    currentEmail = email;
    currentName = extra.name ?? `Nombre de ${email.split("@")[0]}`;
    return call<AuthReply>(baseUrl, "POST", "/api/auth/google-login", {
      sessionId: extra.sessionId,
      body: { accessToken: `token-google-${email}-0000000000`, ...(extra.studentCode === undefined ? {} : { studentCode: extra.studentCode }) },
    });
  };
  const restore = () => {
    globalThis.fetch = originalFetch;
    OAuth2Client.prototype.getTokenInfo = originalTokenInfo;
    env.googleClientId = previous.clientId;
    env.googleDefaultPassword = previous.password;
    env.googleAllowedHostedDomain = previous.domain;
  };
  return { google, restore };
}

export async function teacherSession(baseUrl: string) {
  const reply = await call<AuthReply>(baseUrl, "POST", "/api/auth/login", { body: { email: "docente@adaceen.edu.co", password: "Docente123!" } });
  assert.equal(reply.status, 200, JSON.stringify(reply.data));
  return String(reply.data.session?.id);
}

export async function countUsersWithEmail(database: AppDatabase, email: string) {
  const result = await database.pool.query<{ id: string }>(`select id from users where lower(email) = $1`, [email]);
  return result.rows.length;
}

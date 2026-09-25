import assert from "node:assert/strict";
import test from "node:test";
import type { Server } from "node:http";
import { OAuth2Client } from "google-auth-library";
import { createApp } from "../../src/app.js";
import { env } from "../../src/config/env.js";
import { createDatabase, type AppDatabase } from "../../src/db/database.js";
import { schemaStatements } from "../../src/db/schema.js";
import { PRIVACY_POLICY_VERSION, PUBLISHED_PRIVACY_POLICY_VERSIONS } from "../../src/routes/privacy-policy-routes.js";

/**
 * Privacidad en el servidor (auditoria de redundancias, punto 11): la
 * aceptacion se guarda por usuario y login, google-login y me la devuelven en
 * privacy. Asi otro navegador o equipo no vuelve a pedir «Aceptar y continuar».
 */

type Privacy = { version: string | null; acceptedAt: string | null };
type AuthResponse = { ok: boolean; session?: { id?: string }; privacy?: Privacy; firstLogin?: boolean; error?: string };

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

async function call<T>(baseUrl: string, method: string, route: string, options: { sessionId?: string; body?: unknown } = {}) {
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

function login(baseUrl: string, email: string, password: string) {
  return call<AuthResponse>(baseUrl, "POST", "/api/auth/login", { body: { email, password } });
}

test("privacidad en el servidor: aceptar una vez vale para otro navegador; login y me la devuelven", async () => {
  const { server, database, baseUrl } = await startTestServer();
  try {
    // Primer navegador: sin aceptacion previa.
    const first = await login(baseUrl, "estudiante@adaceen.edu.co", "Estudiante123!");
    assert.equal(first.status, 200);
    assert.deepEqual(first.data.privacy, { version: null, acceptedAt: null }, "sin aceptar: version y fecha en null");
    const firstSession = String(first.data.session?.id || "");

    const meBefore = await call<AuthResponse>(baseUrl, "GET", "/api/auth/me", { sessionId: firstSession });
    assert.equal(meBefore.status, 200);
    assert.deepEqual(meBefore.data.privacy, { version: null, acceptedAt: null });

    // La ruta exige sesion y una version con formato.
    const anonymous = await call<AuthResponse>(baseUrl, "POST", "/api/auth/privacy-acceptance", { body: { version: PRIVACY_POLICY_VERSION } });
    assert.equal(anonymous.status, 401);
    const invalidSession = await call<AuthResponse>(baseUrl, "POST", "/api/auth/privacy-acceptance", {
      sessionId: "sesion-que-no-existe",
      body: { version: PRIVACY_POLICY_VERSION },
    });
    assert.equal(invalidSession.status, 401);
    for (const version of [undefined, "", "<script>", "x".repeat(41)]) {
      const invalid = await call<AuthResponse>(baseUrl, "POST", "/api/auth/privacy-acceptance", {
        sessionId: firstSession,
        body: version === undefined ? {} : { version },
      });
      assert.equal(invalid.status, 400, `version invalida: ${JSON.stringify(version)}`);
      assert.equal(invalid.data.ok, false);
    }
    // Solo las versiones publicadas: una inventada no queda como constancia.
    for (const version of ["2099-01-01", "1", "2026-05-27"]) {
      const unknown = await call<AuthResponse>(baseUrl, "POST", "/api/auth/privacy-acceptance", {
        sessionId: firstSession,
        body: { version },
      });
      assert.equal(unknown.status, 400, `version desconocida: ${version}`);
      assert.equal(unknown.data.error, `Version de la politica desconocida (la vigente es ${PRIVACY_POLICY_VERSION}).`);
    }
    assert.deepEqual(PUBLISHED_PRIVACY_POLICY_VERSIONS.at(-1), PRIVACY_POLICY_VERSION, "la vigente es la ultima publicada");
    const noRows = await database.pool.query<{ total: string }>(
      "select count(*) as total from user_privacy_acceptances where user_id = $1",
      ["user-student-demo"],
    );
    assert.equal(Number(noRows.rows[0].total), 0, "los rechazos no guardan nada");

    const accepted = await call<{ ok: boolean; privacy: Privacy }>(baseUrl, "POST", "/api/auth/privacy-acceptance", {
      sessionId: firstSession,
      body: { version: PRIVACY_POLICY_VERSION },
    });
    assert.equal(accepted.status, 200);
    assert.equal(accepted.data.ok, true);
    assert.equal(accepted.data.privacy.version, PRIVACY_POLICY_VERSION);
    assert.ok(accepted.data.privacy.acceptedAt && !Number.isNaN(Date.parse(accepted.data.privacy.acceptedAt)), "acceptedAt en ISO");
    assert.deepEqual(Object.keys(accepted.data.privacy).sort(), ["acceptedAt", "version"], "forma del contrato");

    const meAfter = await call<AuthResponse>(baseUrl, "GET", "/api/auth/me", { sessionId: firstSession });
    assert.deepEqual(meAfter.data.privacy, accepted.data.privacy, "me devuelve la aceptacion guardada");

    // Otro navegador (nuevo login del mismo usuario): ya viene aceptada.
    const other = await login(baseUrl, "estudiante@adaceen.edu.co", "Estudiante123!");
    assert.equal(other.status, 200);
    assert.equal(other.data.firstLogin, false);
    assert.deepEqual(other.data.privacy, accepted.data.privacy, "otro navegador no vuelve a pedir la aceptacion");

    // Aceptar otra vez (otro navegador, la migracion de la extension) no
    // duplica ni cambia la fecha: queda la de la primera aceptacion.
    const again = await call<{ ok: boolean; privacy: Privacy }>(baseUrl, "POST", "/api/auth/privacy-acceptance", {
      sessionId: String(other.data.session?.id),
      body: { version: PRIVACY_POLICY_VERSION },
    });
    assert.equal(again.status, 200);
    assert.deepEqual(again.data.privacy, accepted.data.privacy, "conserva la fecha de la primera vez");
    const rows = await database.pool.query<{ total: string }>(
      "select count(*) as total from user_privacy_acceptances where user_id = $1",
      ["user-student-demo"],
    );
    assert.equal(Number(rows.rows[0].total), 1, "una fila por usuario y version");

    // Es por usuario: el docente sigue sin aceptar.
    const teacher = await login(baseUrl, "docente@adaceen.edu.co", "Docente123!");
    assert.deepEqual(teacher.data.privacy, { version: null, acceptedAt: null });

    // Un error al leer la aceptacion no tumba el login: la extension mostrara el modal.
    const original = database.getPrivacyAcceptance;
    database.getPrivacyAcceptance = async () => { throw new Error("base caida"); };
    try {
      const degraded = await login(baseUrl, "estudiante@adaceen.edu.co", "Estudiante123!");
      assert.equal(degraded.status, 200);
      assert.deepEqual(degraded.data.privacy, { version: null, acceptedAt: null });
    } finally {
      database.getPrivacyAcceptance = original;
    }
  } finally {
    await stopTestServer(server, database);
  }
});

test("privacidad en el servidor: google-login tambien devuelve la aceptacion", async () => {
  const { server, database, baseUrl } = await startTestServer();
  const previous = { clientId: env.googleClientId, password: env.googleDefaultPassword, domain: env.googleAllowedHostedDomain };
  const originalTokenInfo = OAuth2Client.prototype.getTokenInfo;
  const originalFetch = globalThis.fetch;
  env.googleClientId = "cliente-google-de-prueba.apps.googleusercontent.com";
  env.googleDefaultPassword = "ClaveGoogle123!";
  env.googleAllowedHostedDomain = "";
  // Google simulado: el token es del cliente configurado y el perfil es el del estudiante demo.
  OAuth2Client.prototype.getTokenInfo = async function () {
    return { aud: env.googleClientId, email: "estudiante@adaceen.edu.co", email_verified: true } as unknown as Awaited<ReturnType<OAuth2Client["getTokenInfo"]>>;
  };
  globalThis.fetch = (async (input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
    if (String(input).startsWith("https://www.googleapis.com/oauth2/v3/userinfo")) {
      return new Response(JSON.stringify({ email: "estudiante@adaceen.edu.co", email_verified: true, name: "Estudiante Demo" }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }
    return originalFetch(input, init);
  }) as typeof fetch;
  try {
    const googleLogin = () => call<AuthResponse>(baseUrl, "POST", "/api/auth/google-login", { body: { accessToken: "token-de-google-de-prueba-123456" } });
    const before = await googleLogin();
    assert.equal(before.status, 200, JSON.stringify(before.data));
    assert.deepEqual(before.data.privacy, { version: null, acceptedAt: null });

    await call(baseUrl, "POST", "/api/auth/privacy-acceptance", { sessionId: String(before.data.session?.id), body: { version: PRIVACY_POLICY_VERSION } });
    const after = await googleLogin();
    assert.equal(after.status, 200);
    assert.equal(after.data.privacy?.version, PRIVACY_POLICY_VERSION);
    assert.ok(after.data.privacy?.acceptedAt);
  } finally {
    globalThis.fetch = originalFetch;
    OAuth2Client.prototype.getTokenInfo = originalTokenInfo;
    env.googleClientId = previous.clientId;
    env.googleDefaultPassword = previous.password;
    env.googleAllowedHostedDomain = previous.domain;
    await stopTestServer(server, database);
  }
});

test("privacidad en el servidor: tabla idempotente y lecturas sin fila", async () => {
  // pg-mem no deja repetir los create table del esquema (limite suyo, igual con
  // las demas tablas); en PostgreSQL el if not exists hace que reiniciar el
  // backend no falle ni borre las aceptaciones.
  const statement = schemaStatements.find((item) => item.includes("user_privacy_acceptances"));
  assert.ok(statement, "la tabla esta en el esquema");
  assert.match(statement, /create table if not exists user_privacy_acceptances/);
  assert.match(statement, /user_id text not null references users\(id\)/);
  assert.match(statement, /primary key \(user_id, policy_version\)/, "una fila por usuario y version");
  const usersIndex = schemaStatements.findIndex((item) => /create table if not exists users \(/.test(item));
  assert.ok(schemaStatements.indexOf(statement) > usersIndex, "se crea despues de users");

  const database = await createDatabase();
  try {
    assert.deepEqual(await database.getPrivacyAcceptance(""), { version: null, acceptedAt: null });
    assert.deepEqual(await database.getPrivacyAcceptance("usuario-sin-fila"), { version: null, acceptedAt: null });
    const first = await database.savePrivacyAcceptance("user-student-demo", PRIVACY_POLICY_VERSION);
    await new Promise((resolve) => setTimeout(resolve, 20));
    const again = await database.savePrivacyAcceptance("user-student-demo", PRIVACY_POLICY_VERSION);
    assert.deepEqual(again, first, "volver a aceptar conserva la fecha de la primera vez");

    // Una version anterior aceptada despues (extension desactualizada en otro
    // navegador) queda en el historial pero no baja la version devuelta.
    const older = await database.savePrivacyAcceptance("user-student-demo", "2025-01-10");
    assert.deepEqual(older, first, "sigue mandando la version mas nueva");
    assert.deepEqual(await database.getPrivacyAcceptance("user-student-demo"), first);
    const history = await database.pool.query<{ policy_version: string }>(
      "select policy_version from user_privacy_acceptances where user_id = $1 order by policy_version",
      ["user-student-demo"],
    );
    assert.deepEqual(history.rows.map((row) => row.policy_version), ["2025-01-10", PRIVACY_POLICY_VERSION], "historial por version");
    // Con una version mas nueva aceptada, esa es la que se devuelve.
    const newer = await database.savePrivacyAcceptance("user-student-demo", "2027-01-15");
    assert.equal(newer.version, "2027-01-15");
  } finally {
    await database.close();
  }
});

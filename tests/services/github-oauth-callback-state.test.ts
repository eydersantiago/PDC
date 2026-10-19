import assert from "node:assert/strict";
import test from "node:test";
import { githubOAuthCallbackState, parseGithubOAuthCallbackMark } from "../../src/services/github-oauth-callback-state.js";

/**
 * Si GitHub acepta la direccion de regreso de la OAuth App de ADACEEN: lo ultimo que paso con
 * la direccion actual manda (un callback que llego bien o un rechazo visto por la extension).
 */
const URL_ACTUAL = "https://app.prueba/auth/github/callback";
const ok = (at: string, url = URL_ACTUAL) => ({ url, at });

test("estado del callback de GitHub: sin marcas, rechazado, verificado y otra direccion", () => {
  assert.deepEqual(githubOAuthCallbackState(URL_ACTUAL, null, null), { state: "sin_verificar", checkedAt: null });
  assert.deepEqual(githubOAuthCallbackState(URL_ACTUAL, null, ok("2026-10-18T23:00:00.000Z")), { state: "rechazado", checkedAt: "2026-10-18T23:00:00.000Z" });
  // Corregida la OAuth App: el callback posterior gana.
  assert.deepEqual(
    githubOAuthCallbackState(URL_ACTUAL, ok("2026-10-18T23:10:00.000Z"), ok("2026-10-18T23:00:00.000Z")),
    { state: "verificado", checkedAt: "2026-10-18T23:10:00.000Z" },
  );
  // Un rechazo despues de un callback bueno (alguien cambio la OAuth App): rechazado.
  assert.equal(githubOAuthCallbackState(URL_ACTUAL, ok("2026-10-18T23:00:00.000Z"), ok("2026-10-18T23:10:00.000Z")).state, "rechazado");
  // Marcas de otra direccion (cambio PUBLIC_API_URL): no cuentan para la actual.
  assert.equal(githubOAuthCallbackState(URL_ACTUAL, ok("2026-10-18T23:10:00.000Z", "https://vieja.prueba/auth/github/callback"), null).state, "sin_verificar");
  // Sin direccion conocida (sin PUBLIC_API_URL ni GITHUB_OAUTH_CALLBACK_URL): vale la ultima marca.
  assert.equal(githubOAuthCallbackState("", ok("2026-10-18T23:10:00.000Z", "https://cualquiera.prueba/cb"), null).state, "verificado");
});

test("estado del callback de GitHub: una marca mal guardada se ignora", () => {
  assert.equal(parseGithubOAuthCallbackMark(""), null);
  assert.equal(parseGithubOAuthCallbackMark("no es json"), null);
  assert.equal(parseGithubOAuthCallbackMark(JSON.stringify({ url: URL_ACTUAL, at: "ayer" })), null);
  assert.equal(parseGithubOAuthCallbackMark(JSON.stringify({ at: "2026-10-18T23:00:00.000Z" })), null);
  assert.deepEqual(parseGithubOAuthCallbackMark(JSON.stringify({ url: URL_ACTUAL, at: "2026-10-18T23:00:00.000Z" })), { url: URL_ACTUAL, at: "2026-10-18T23:00:00.000Z" });
});

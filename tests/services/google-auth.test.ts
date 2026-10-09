import assert from "node:assert/strict";
import test from "node:test";
import { OAuth2Client } from "google-auth-library";
import { env } from "../../src/config/env.js";
import { allowedGoogleClientIds, verifyGoogleUserFromAccessToken, verifyGoogleUserFromIdToken } from "../../src/services/google-auth.js";

/**
 * Login con Google y varias audiencias (navegador en Firefox): el token puede venir del cliente
 * de la extension de Chrome (GOOGLE_CLIENT_ID) o del cliente OAuth web con el que Firefox hace
 * identity.launchWebAuthFlow (GOOGLE_CLIENT_IDS). Google se simula en getTokenInfo, verifyIdToken
 * y el fetch de userinfo.
 */

const CHROME_CLIENT_ID = "cliente-chrome.apps.googleusercontent.com";
const WEB_CLIENT_ID = "cliente-web-firefox.apps.googleusercontent.com";
type TokenInfo = Awaited<ReturnType<OAuth2Client["getTokenInfo"]>>;

async function withGoogleEnv(clientIds: string[], run: () => Promise<void>) {
  const previous = { clientId: env.googleClientId, clientIds: env.googleClientIds, domain: env.googleAllowedHostedDomain };
  const originalTokenInfo = OAuth2Client.prototype.getTokenInfo;
  const originalVerify = OAuth2Client.prototype.verifyIdToken;
  const originalFetch = globalThis.fetch;
  env.googleClientId = CHROME_CLIENT_ID;
  env.googleClientIds = clientIds;
  env.googleAllowedHostedDomain = "";
  // tokeninfo: la audiencia va en el propio token de prueba ("aud:<client_id>").
  OAuth2Client.prototype.getTokenInfo = async function (accessToken: string) {
    return { aud: accessToken.replace(/^aud:/, ""), email: "estudiante@correounivalle.edu.co", email_verified: true } as unknown as TokenInfo;
  };
  globalThis.fetch = (async (input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
    if (String(input).startsWith("https://www.googleapis.com/oauth2/v3/userinfo")) {
      return new Response(JSON.stringify({ email: "Estudiante@CorreoUnivalle.edu.co", email_verified: true, name: "Estudiante Firefox" }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }
    return originalFetch(input, init);
  }) as typeof fetch;
  try {
    await run();
  } finally {
    globalThis.fetch = originalFetch;
    OAuth2Client.prototype.getTokenInfo = originalTokenInfo;
    OAuth2Client.prototype.verifyIdToken = originalVerify;
    env.googleClientId = previous.clientId;
    env.googleClientIds = previous.clientIds;
    env.googleAllowedHostedDomain = previous.domain;
  }
}

test("google-auth: las audiencias validas son GOOGLE_CLIENT_ID mas GOOGLE_CLIENT_IDS, sin repetidos", async () => {
  await withGoogleEnv([` ${WEB_CLIENT_ID} `, CHROME_CLIENT_ID, "", WEB_CLIENT_ID], async () => {
    assert.deepEqual(allowedGoogleClientIds(), [CHROME_CLIENT_ID, WEB_CLIENT_ID]);
  });
  await withGoogleEnv([], async () => {
    assert.deepEqual(allowedGoogleClientIds(), [CHROME_CLIENT_ID]);
  });
});

test("google-auth: un access_token del cliente web de Firefox entra solo si esta en GOOGLE_CLIENT_IDS", async () => {
  await withGoogleEnv([WEB_CLIENT_ID], async () => {
    const fromFirefox = await verifyGoogleUserFromAccessToken(`aud:${WEB_CLIENT_ID}`);
    assert.deepEqual(fromFirefox, { email: "estudiante@correounivalle.edu.co", displayName: "Estudiante Firefox", hostedDomain: "" });
    const fromChrome = await verifyGoogleUserFromAccessToken(`aud:${CHROME_CLIENT_ID}`);
    assert.equal(fromChrome.email, "estudiante@correounivalle.edu.co");
    await assert.rejects(verifyGoogleUserFromAccessToken("aud:otro-cliente.apps.googleusercontent.com"), /no corresponde al cliente OAuth/);
  });
  // Sin GOOGLE_CLIENT_IDS el backend sigue como antes: solo el cliente de Chrome.
  await withGoogleEnv([], async () => {
    await assert.rejects(verifyGoogleUserFromAccessToken(`aud:${WEB_CLIENT_ID}`), /no corresponde al cliente OAuth/);
    assert.equal((await verifyGoogleUserFromAccessToken(`aud:${CHROME_CLIENT_ID}`)).email, "estudiante@correounivalle.edu.co");
  });
});

test("google-auth: un id_token se verifica contra las mismas audiencias", async () => {
  await withGoogleEnv([WEB_CLIENT_ID], async () => {
    let audience: unknown = null;
    OAuth2Client.prototype.verifyIdToken = async function (options: { idToken: string; audience?: string | string[] }) {
      audience = options.audience;
      return { getPayload: () => ({ email: "docente@correounivalle.edu.co", email_verified: true, name: "Docente" }) } as unknown as Awaited<ReturnType<OAuth2Client["verifyIdToken"]>>;
    };
    const user = await verifyGoogleUserFromIdToken("id-token-de-prueba-1234567890");
    assert.deepEqual(audience, [CHROME_CLIENT_ID, WEB_CLIENT_ID]);
    assert.equal(user.email, "docente@correounivalle.edu.co");
    assert.equal(user.displayName, "Docente");
  });
});

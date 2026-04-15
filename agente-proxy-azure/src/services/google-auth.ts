import { OAuth2Client } from "google-auth-library";
import { env } from "../config/env.js";

type VerifiedGoogleUser = {
  email: string;
  displayName: string;
  hostedDomain: string;
};

let oauthClient: OAuth2Client | null = null;

function getOauthClient() {
  if (!env.googleClientId) {
    throw new Error("GOOGLE_CLIENT_ID no configurado.");
  }
  if (!oauthClient) {
    oauthClient = new OAuth2Client(env.googleClientId);
  }
  return oauthClient;
}

function normalizeHostedDomain(value: unknown) {
  return String(value || "").trim().toLowerCase();
}

export async function verifyGoogleUserFromIdToken(idToken: string): Promise<VerifiedGoogleUser> {
  const client = getOauthClient();
  const ticket = await client.verifyIdToken({
    idToken,
    audience: env.googleClientId,
  });
  const payload = ticket.getPayload();

  const email = String(payload?.email || "").trim().toLowerCase();
  const displayName = String(payload?.name || "").trim();
  const emailVerified = payload?.email_verified === true;
  const hostedDomain = normalizeHostedDomain(payload?.hd);

  if (!email) {
    throw new Error("El token de Google no contiene email.");
  }
  if (!emailVerified) {
    throw new Error("La cuenta de Google no tiene email verificado.");
  }
  if (env.googleAllowedHostedDomain && hostedDomain !== env.googleAllowedHostedDomain) {
    throw new Error("La cuenta de Google no pertenece al dominio permitido.");
  }

  return {
    email,
    displayName: displayName || email.split("@")[0] || "Estudiante",
    hostedDomain,
  };
}

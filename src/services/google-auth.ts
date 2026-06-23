import { OAuth2Client } from "google-auth-library";
import { env } from "../config/env.js";

type VerifiedGoogleUser = {
  email: string;
  displayName: string;
  hostedDomain: string;
};

type GoogleUserInfo = {
  email?: string;
  email_verified?: boolean | string;
  name?: string;
  hd?: string;
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

function normalizeEmail(value: unknown) {
  return String(value || "").trim().toLowerCase();
}

function normalizeDisplayName(value: unknown, email: string) {
  const displayName = String(value || "").trim();
  return displayName || email.split("@")[0] || "Estudiante";
}

function isGoogleBooleanTrue(value: unknown) {
  return value === true || String(value || "").toLowerCase() === "true";
}

function assertAllowedHostedDomain(email: string, hostedDomain: string) {
  if (!env.googleAllowedHostedDomain) return;

  const emailDomain = email.split("@").pop()?.toLowerCase() || "";
  if (hostedDomain !== env.googleAllowedHostedDomain && emailDomain !== env.googleAllowedHostedDomain) {
    throw new Error("La cuenta de Google no pertenece al dominio permitido.");
  }
}

async function fetchGoogleUserInfo(accessToken: string): Promise<GoogleUserInfo> {
  const response = await fetch("https://www.googleapis.com/oauth2/v3/userinfo", {
    headers: {
      Authorization: `Bearer ${accessToken}`,
      Accept: "application/json",
    },
  });

  const payload = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error(String(payload?.error_description || payload?.error || "No se pudo leer el perfil de Google."));
  }

  return payload as GoogleUserInfo;
}

export async function verifyGoogleUserFromIdToken(idToken: string): Promise<VerifiedGoogleUser> {
  const client = getOauthClient();
  const ticket = await client.verifyIdToken({
    idToken,
    audience: env.googleClientId,
  });
  const payload = ticket.getPayload();

  const email = normalizeEmail(payload?.email);
  const emailVerified = isGoogleBooleanTrue(payload?.email_verified);
  const hostedDomain = normalizeHostedDomain(payload?.hd);

  if (!email) {
    throw new Error("El token de Google no contiene email.");
  }
  if (!emailVerified) {
    throw new Error("La cuenta de Google no tiene email verificado.");
  }
  assertAllowedHostedDomain(email, hostedDomain);

  return {
    email,
    displayName: normalizeDisplayName(payload?.name, email),
    hostedDomain,
  };
}

export async function verifyGoogleUserFromAccessToken(accessToken: string): Promise<VerifiedGoogleUser> {
  const client = getOauthClient();
  const tokenInfo = await client.getTokenInfo(accessToken);
  const audience = String(tokenInfo.aud || "").trim();

  if (audience !== env.googleClientId) {
    throw new Error("El token de Google no corresponde al cliente OAuth configurado.");
  }

  const userInfo = await fetchGoogleUserInfo(accessToken);
  const email = normalizeEmail(userInfo.email || tokenInfo.email);
  const emailVerified = isGoogleBooleanTrue(userInfo.email_verified ?? tokenInfo.email_verified);
  const hostedDomain = normalizeHostedDomain(userInfo.hd);

  if (!email) {
    throw new Error("El token de Google no contiene email.");
  }
  if (!emailVerified) {
    throw new Error("La cuenta de Google no tiene email verificado.");
  }
  assertAllowedHostedDomain(email, hostedDomain);

  return {
    email,
    displayName: normalizeDisplayName(userInfo.name, email),
    hostedDomain,
  };
}

import { randomBytes } from "node:crypto";
import { env } from "../config/env.js";
import { trimText } from "./text-utils.js";

type GithubOAuthTokenResponse = {
  access_token?: string;
  token_type?: string;
  scope?: string;
  error?: string;
  error_description?: string;
};

type GithubUserProfile = {
  login?: string;
  email?: string | null;
};

type GithubUserEmail = {
  email?: string;
  primary?: boolean;
  verified?: boolean;
};

export function getGithubOAuthConfig() {
  const missing = [];
  if (!env.githubOAuthClientId) missing.push("GITHUB_OAUTH_CLIENT_ID");
  if (!env.githubOAuthClientSecret) missing.push("GITHUB_OAUTH_CLIENT_SECRET");
  const callbackUrl = env.githubOAuthCallbackUrl
    || (env.publicApiUrl ? `${env.publicApiUrl}/auth/github/callback` : "");
  if (!callbackUrl) missing.push("GITHUB_OAUTH_CALLBACK_URL");
  const invalid = [];
  if (env.githubOAuthClientId.startsWith("Iv")) {
    invalid.push("GITHUB_OAUTH_CLIENT_ID parece ser Client ID de GitHub App; para OAuth debe ser el Client ID de la OAuth App (normalmente inicia por Ov).");
  }
  if (/-----BEGIN [A-Z ]+PRIVATE KEY-----/.test(env.githubOAuthClientSecret)) {
    invalid.push("GITHUB_OAUTH_CLIENT_SECRET contiene una private key PEM; pega aqui el Client secret de la OAuth App, no GITHUB_APP_PRIVATE_KEY.");
  }

  return {
    configured: missing.length === 0 && invalid.length === 0,
    missing,
    invalid,
    clientId: env.githubOAuthClientId,
    clientSecret: env.githubOAuthClientSecret,
    callbackUrl,
    scopes: env.githubOAuthScopes,
  };
}

export function generateGithubOAuthState() {
  return randomBytes(24).toString("base64url");
}

export function buildGithubOAuthAuthorizeUrl(state: string, callbackUrl = "") {
  const config = getGithubOAuthConfig();
  if (!config.configured) {
    const details = [...config.missing, ...config.invalid].join(", ");
    throw new Error(`GitHub OAuth no configurado. ${details}`);
  }
  const redirectUri = trimText(callbackUrl) || config.callbackUrl;

  const params = new URLSearchParams({
    client_id: config.clientId,
    redirect_uri: redirectUri,
    scope: config.scopes,
    state,
    allow_signup: "true",
  });
  return `https://github.com/login/oauth/authorize?${params.toString()}`;
}

export function normalizeScopeList(value: string) {
  return trimText(value)
    .split(/[,\s]+/)
    .map((item) => item.trim())
    .filter(Boolean);
}

export function hasGithubCodespaceScope(scopes: string) {
  return normalizeScopeList(scopes).includes("codespace");
}

async function githubUserRequest<T>(path: string, accessToken: string) {
  const response = await fetch(`${env.githubApiBaseUrl}${path}`, {
    headers: {
      Accept: "application/vnd.github+json",
      "X-GitHub-Api-Version": "2022-11-28",
      "User-Agent": "adaceen-github-oauth/1.0",
      Authorization: `Bearer ${accessToken}`,
    },
  });
  const json = await response.json().catch(() => null);
  if (!response.ok) {
    const message = json && typeof json === "object" && "message" in json
      ? String((json as { message?: unknown }).message || "")
      : "";
    throw new Error(`GitHub API ${response.status}${message ? `: ${message}` : ""}`);
  }
  return json as T;
}

export async function exchangeGithubOAuthCode(code: string, callbackUrl = "") {
  const config = getGithubOAuthConfig();
  if (!config.configured) {
    const details = [...config.missing, ...config.invalid].join(", ");
    throw new Error(`GitHub OAuth no configurado. ${details}`);
  }
  const redirectUri = trimText(callbackUrl) || config.callbackUrl;

  const response = await fetch("https://github.com/login/oauth/access_token", {
    method: "POST",
    headers: {
      Accept: "application/json",
      "Content-Type": "application/json; charset=utf-8",
      "User-Agent": "adaceen-github-oauth/1.0",
    },
    body: JSON.stringify({
      client_id: config.clientId,
      client_secret: config.clientSecret,
      code: trimText(code),
      redirect_uri: redirectUri,
    }),
  });
  const json = await response.json().catch(() => ({})) as GithubOAuthTokenResponse;
  if (!response.ok || json.error) {
    throw new Error(json.error_description || json.error || `GitHub OAuth HTTP ${response.status}`);
  }

  const accessToken = trimText(json.access_token);
  if (!accessToken) {
    throw new Error("GitHub OAuth no devolvio access_token.");
  }

  return {
    accessToken,
    tokenType: trimText(json.token_type) || "bearer",
    scopes: trimText(json.scope),
  };
}

export async function fetchGithubOAuthUser(accessToken: string) {
  const profile = await githubUserRequest<GithubUserProfile>("/user", accessToken);
  let email = trimText(profile.email || "");

  if (!email) {
    try {
      const emails = await githubUserRequest<GithubUserEmail[]>("/user/emails", accessToken);
      const primary = Array.isArray(emails)
        ? emails.find((item) => item.primary && item.verified) || emails.find((item) => item.verified)
        : null;
      email = trimText(primary?.email || "");
    } catch {
      email = "";
    }
  }

  return {
    login: trimText(profile.login),
    email,
  };
}

import type { AppDatabase } from "../db/database.js";
import { trimText } from "./text-utils.js";

/**
 * Si GitHub acepta la direccion de regreso (redirect_uri) de la OAuth App de ADACEEN.
 *
 * GitHub no deja leer ni cambiar por API las «Redirect URIs» de una OAuth App (antes un solo
 * campo, «Authorization callback URL»; desde 2026 hasta 10 direcciones):
 * solo el dueno la cambia en github.com. Cuando no coincide con la que manda ADACEEN, el
 * estudiante ve «Be careful! The redirect_uri is not associated with this application» y su
 * editor no abre. Asi que se aprende de lo que pasa:
 *
 * - verificado: el ultimo callback que llego a ADACEEN con esta direccion (alguien conecto
 *   GitHub de verdad);
 * - rechazado: la extension vio despues esa pagina de GitHub con esta direccion y lo aviso
 *   (POST /api/github/oauth/redirect-error);
 * - sin_verificar: nadie ha conectado GitHub con esta direccion todavia (p. ej. recien
 *   cambiada PUBLIC_API_URL); no es un error.
 *
 * Lo publican /api/health y el monitor del piloto, que alerta con "rechazado". Nada se
 * bloquea: un "rechazado" falso se corrige solo con el siguiente callback que llega bien.
 */

export const GITHUB_OAUTH_CALLBACK_OK_KEY = "github_oauth_callback_ok";
export const GITHUB_OAUTH_CALLBACK_REJECTED_KEY = "github_oauth_callback_rejected";

export type GithubOAuthCallbackMark = { url: string; at: string };
export type GithubOAuthCallbackState = "verificado" | "rechazado" | "sin_verificar";

export function parseGithubOAuthCallbackMark(value: unknown): GithubOAuthCallbackMark | null {
  if (typeof value !== "string" || !value) return null;
  try {
    const parsed = JSON.parse(value) as Record<string, unknown>;
    const url = trimText(typeof parsed?.url === "string" ? parsed.url : "");
    const at = trimText(typeof parsed?.at === "string" ? parsed.at : "");
    if (!url || Number.isNaN(Date.parse(at))) return null;
    return { url, at };
  } catch {
    return null;
  }
}

/** El estado para la direccion actual; sin direccion conocida vale la ultima marca de cada tipo. */
export function githubOAuthCallbackState(
  currentUrl: string,
  ok: GithubOAuthCallbackMark | null,
  rejected: GithubOAuthCallbackMark | null,
): { state: GithubOAuthCallbackState; checkedAt: string | null } {
  const forCurrent = (mark: GithubOAuthCallbackMark | null) => (mark && (!currentUrl || mark.url === currentUrl) ? mark : null);
  const okMark = forCurrent(ok);
  const rejectedMark = forCurrent(rejected);
  if (rejectedMark && (!okMark || Date.parse(rejectedMark.at) > Date.parse(okMark.at))) {
    return { state: "rechazado", checkedAt: rejectedMark.at };
  }
  if (okMark) return { state: "verificado", checkedAt: okMark.at };
  return { state: "sin_verificar", checkedAt: null };
}

async function writeMark(database: AppDatabase, key: string, url: string, userId: string | null, now: Date) {
  const value = JSON.stringify({ url: trimText(url).slice(0, 500), at: now.toISOString() });
  await database.setAppSetting(key, value, userId);
}

/** Un callback de GitHub llego bien con esta direccion. */
export function recordGithubOAuthCallbackOk(database: AppDatabase, callbackUrl: string, userId: string | null, now = new Date()) {
  return writeMark(database, GITHUB_OAUTH_CALLBACK_OK_KEY, callbackUrl, userId, now);
}

/** La extension vio a GitHub rechazar esta direccion. */
export function recordGithubOAuthCallbackRejected(database: AppDatabase, redirectUri: string, userId: string | null, now = new Date()) {
  return writeMark(database, GITHUB_OAUTH_CALLBACK_REJECTED_KEY, redirectUri, userId, now);
}

/** Campos de /api/health (y del monitor): la direccion que manda ADACEEN y si GitHub la acepta. */
export async function describeGithubOAuthCallback(database: AppDatabase, currentUrl: string, configured: boolean) {
  const [ok, rejected] = await Promise.all([
    database.getAppSetting(GITHUB_OAUTH_CALLBACK_OK_KEY).catch(() => null),
    database.getAppSetting(GITHUB_OAUTH_CALLBACK_REJECTED_KEY).catch(() => null),
  ]);
  const { state, checkedAt } = githubOAuthCallbackState(
    trimText(currentUrl),
    parseGithubOAuthCallbackMark(ok?.value),
    parseGithubOAuthCallbackMark(rejected?.value),
  );
  return {
    github_oauth_configured: configured,
    github_oauth_callback_url: trimText(currentUrl) || null,
    github_oauth_callback_state: state,
    github_oauth_callback_checked_at: checkedAt,
  };
}

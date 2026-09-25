// Emparejar VS Code sin copiar/pegar (docs/arquitectura/acceso-simplificado.md, seccion 2).
//
//   POST /api/auth/editor/pairing-code   (sesion browser)  -> { ok, code, expiresAt, ttlSeconds }
//   POST /api/auth/editor/claim          { code, editorHost?, label? }
//        -> { ok, sessionId, expiresAt, user } | 400 invalid_code | 404 code_not_found | 429 too_many_attempts
//   POST /api/auth/editor/github         { githubToken, editorHost? }
//        -> { ok, sessionId, expiresAt, user, githubLogin } | 400 missing_token | 401 github_token_invalid
//           | 404 github_login_not_linked | 429 too_many_attempts
//
// claim y github no piden sesion: crean una sesion editor (vence a los
// EDITOR_SESSION_TTL_DAYS dias). Ni el codigo ni el token de GitHub de VS Code
// se guardan ni se registran en logs. github solo vincula estudiantes: un
// docente o administrador recibe 404 github_login_not_linked con
// reason "staff_requires_code" y se vincula con el codigo del navegador.
import type express from "express";
import { env } from "../config/env.js";
import type { AppDatabase } from "../db/database.js";
import type { AppSession } from "../types/app.js";
import {
  clientIpForLimiter,
  createAttemptLimiter,
  generatePairingCode,
  hashPairingCode,
  normalizePairingCode,
  PAIRING_CODE_TTL_SECONDS,
  type AttemptLimiter,
} from "../services/editor-pairing.js";
import { trimText } from "../services/text-utils.js";
import {
  createGithubLoginReader,
  resolveWorkspaceConfig,
  WorkspaceRequestError,
  type FetchLike,
  type GithubLoginReader,
} from "../services/workspace-provider.js";
import { clearInvalidSessionMark, errorMessage, resolveSession } from "./route-utils.js";

export type EditorAuthDeps = {
  fetch?: FetchLike;
  /** Lector del login de GitHub (por defecto GET {GITHUB_API_BASE_URL}/user). */
  readGithubLogin?: GithubLoginReader;
  githubApiBaseUrl?: string;
  /** Reloj de los limitadores por defecto. */
  now?: () => number;
  claimLimiter?: AttemptLimiter;
  githubLimiter?: AttemptLimiter;
  /** Vigencia de las sesiones editor (por defecto EDITOR_SESSION_TTL_DAYS). */
  sessionTtlMs?: number;
};

const DAY_MS = 24 * 60 * 60 * 1000;
const LABEL_RE = /^[a-z0-9][a-z0-9-]{0,39}$/;
const MAX_GITHUB_TOKEN_CHARS = 1000;

export const GITHUB_LOGIN_NOT_LINKED_MESSAGE =
  "Conecta tu cuenta de GitHub en ADACEEN (overlay del navegador) y vuelve a intentar.";

// Solo lo muestra tal cual VS Code 0.0.31 o anterior (la 0.0.32 usa su propio texto con
// «Tengo un código o sesión»): por eso nombra la opcion que tienen esas versiones. El boton del
// overlay es «Copiar codigo para VS Code» desde el navegador 0.7.12.
export const STAFF_REQUIRES_CODE_MESSAGE =
  "Las cuentas de docente y administrador se vinculan con un codigo del navegador: en el overlay usa \"Abrir en VS Code de este equipo\" o \"Copiar codigo para VS Code\" y elige \"Tengo un codigo del navegador\".";

export function editorSessionTtlMs() {
  return Math.round(env.editorSessionTtlDays * DAY_MS);
}

function cleanLabel(value: unknown) {
  const label = trimText(typeof value === "string" ? value : "").toLowerCase();
  return LABEL_RE.test(label) ? label : "";
}

function userPayload(session: AppSession) {
  return {
    id: session.user.id,
    role: session.user.role,
    email: session.user.email,
    displayName: session.user.displayName,
  };
}

function tooManyAttempts(res: express.Response) {
  res.setHeader("Retry-After", "60");
  return res.status(429).json({
    ok: false,
    error: "too_many_attempts",
    message: "Demasiados intentos desde esta red. Espera un minuto y vuelve a intentar.",
  });
}

export function registerEditorAuthRoutes(app: express.Express, database: AppDatabase, deps: EditorAuthDeps = {}) {
  const now = deps.now || Date.now;
  const claimLimiter = deps.claimLimiter || createAttemptLimiter({ limit: 20, windowMs: 60_000, now });
  const githubLimiter = deps.githubLimiter || createAttemptLimiter({ limit: 20, windowMs: 60_000, now });
  const fetchImpl: FetchLike = deps.fetch || ((url, init) => fetch(url, init));
  const githubApiBaseUrl = deps.githubApiBaseUrl || resolveWorkspaceConfig().githubApiBaseUrl;
  const readGithubLogin = deps.readGithubLogin || createGithubLoginReader(fetchImpl, githubApiBaseUrl);
  const sessionTtl = () => deps.sessionTtlMs ?? editorSessionTtlMs();

  app.post("/api/auth/editor/pairing-code", async (req, res) => {
    res.setHeader("Cache-Control", "no-store");
    try {
      const session = await resolveSession(database, req);
      // Solo con x-session-id (el overlay): la cookie sola no basta, asi otra
      // pagina no puede pedir un codigo aprovechando la cookie del estudiante.
      if (!session || trimText(req.header("x-session-id")) !== session.id) {
        return res.status(401).json({ ok: false, error: "Sesion no valida." });
      }
      // Solo el navegador reparte codigos: una sesion de VS Code no crea otras.
      if ((session.kind || "browser") !== "browser") {
        return res.status(403).json({
          ok: false,
          error: "Pide el codigo desde el navegador (overlay de ADACEEN).",
          code: "browser_session_required",
        });
      }

      // Reloj real: la base compara el vencimiento con now() al canjear.
      const expiresAt = new Date(Date.now() + PAIRING_CODE_TTL_SECONDS * 1000);
      let code = "";
      for (let attempt = 0; attempt < 3 && !code; attempt += 1) {
        const candidate = generatePairingCode();
        try {
          await database.createEditorPairingCode({
            userId: session.user.id,
            codeHash: hashPairingCode(normalizePairingCode(candidate)),
            expiresAt,
          });
          code = candidate;
        } catch (error) {
          // Choque de hash (casi imposible): se intenta con otro codigo.
          if (attempt === 2) throw error;
        }
      }

      return res.json({
        ok: true,
        code,
        expiresAt: expiresAt.toISOString(),
        ttlSeconds: PAIRING_CODE_TTL_SECONDS,
      });
    } catch (error) {
      console.error("[editor-auth] pairing-code fallo:", errorMessage(error));
      return res.status(500).json({ ok: false, error: "No se pudo crear el codigo. Intenta de nuevo." });
    }
  });

  app.post("/api/auth/editor/claim", async (req, res) => {
    res.setHeader("Cache-Control", "no-store");
    const ip = clientIpForLimiter(req);
    try {
      if (claimLimiter.isBlocked(ip)) return tooManyAttempts(res);

      const code = normalizePairingCode(req.body?.code);
      if (!code) {
        claimLimiter.recordFailure(ip);
        return res.status(400).json({
          ok: false,
          error: "invalid_code",
          message: "El codigo tiene 8 letras y numeros, asi: K7P4-M2QX.",
        });
      }

      const userId = await database.claimEditorPairingCode(hashPairingCode(code));
      const session = userId
        ? await database.createEditorSession({
          userId,
          label: cleanLabel(req.body?.label) || "codigo",
          ttlMs: sessionTtl(),
        })
        : null;
      if (!session) {
        claimLimiter.recordFailure(ip);
        return res.status(404).json({
          ok: false,
          error: "code_not_found",
          message: "El codigo no existe, ya se uso o vencio. Pide uno nuevo en el navegador.",
        });
      }

      clearInvalidSessionMark(res);
      return res.json({
        ok: true,
        sessionId: session.id,
        expiresAt: session.expiresAt,
        user: userPayload(session),
      });
    } catch (error) {
      console.error("[editor-auth] claim fallo:", errorMessage(error));
      return res.status(500).json({ ok: false, error: "internal_error", message: "No se pudo vincular VS Code. Intenta de nuevo." });
    }
  });

  app.post("/api/auth/editor/github", async (req, res) => {
    res.setHeader("Cache-Control", "no-store");
    const ip = clientIpForLimiter(req);
    try {
      if (githubLimiter.isBlocked(ip)) return tooManyAttempts(res);

      const githubToken = trimText(typeof req.body?.githubToken === "string" ? req.body.githubToken : "");
      if (!githubToken) {
        return res.status(400).json({
          ok: false,
          error: "missing_token",
          message: "Falta githubToken (la sesion de GitHub de VS Code).",
        });
      }

      let githubLogin = "";
      try {
        if (githubToken.length > MAX_GITHUB_TOKEN_CHARS || /\s/.test(githubToken)) {
          throw new WorkspaceRequestError("github_token_invalid", "", 401);
        }
        githubLogin = await readGithubLogin(githubToken);
      } catch (error) {
        if (error instanceof WorkspaceRequestError && error.code === "github_token_invalid") {
          githubLimiter.recordFailure(ip);
          return res.status(401).json({
            ok: false,
            error: "github_token_invalid",
            message: "GitHub no acepto la sesion de VS Code. Vuelve a iniciar sesion en GitHub desde VS Code.",
          });
        }
        return res.status(502).json({
          ok: false,
          error: "github_unavailable",
          message: "No se pudo verificar tu cuenta de GitHub (GitHub no respondio). Intenta de nuevo en unos segundos.",
        });
      }

      // Sin recordFailure: para llegar aqui hace falta un token valido de esa
      // cuenta, asi que no sirve para adivinar; y el laboratorio comparte una
      // IP (NAT), donde 20 estudiantes sin vincular dejarian sin cupo al resto.
      const user = await database.findUserByGithubLogin(githubLogin);
      if (user && user.role !== "student") {
        // Docentes y administradores solo con el codigo del navegador: GitHub
        // acepta cualquier token de la cuenta (otra app OAuth, un PAT) y una
        // sesion de staff de 30 dias da acceso a admin, exportes y piloto.
        return res.status(404).json({
          ok: false,
          error: "github_login_not_linked",
          reason: "staff_requires_code",
          message: STAFF_REQUIRES_CODE_MESSAGE,
        });
      }
      const session = user
        ? await database.createEditorSession({ userId: user.id, label: "github", ttlMs: sessionTtl() })
        : null;
      if (!session) {
        return res.status(404).json({
          ok: false,
          error: "github_login_not_linked",
          message: GITHUB_LOGIN_NOT_LINKED_MESSAGE,
        });
      }

      clearInvalidSessionMark(res);
      return res.json({
        ok: true,
        sessionId: session.id,
        expiresAt: session.expiresAt,
        user: userPayload(session),
        githubLogin,
      });
    } catch (error) {
      console.error("[editor-auth] github fallo:", errorMessage(error));
      return res.status(500).json({ ok: false, error: "internal_error", message: "No se pudo vincular VS Code. Intenta de nuevo." });
    }
  });
}

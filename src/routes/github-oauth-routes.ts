// Rutas del OAuth de usuario de GitHub (estado, inicio y callbacks).
// Movido sin cambios desde src/routes/github-app-routes.ts (solo se agrego "export" y los imports).
import { z } from "zod";
import express from "express";
import { env } from "../config/env.js";
import type { AppDatabase } from "../db/database.js";
import { buildGithubOAuthAuthorizeUrl, exchangeGithubOAuthCode, fetchGithubOAuthUser, generateGithubOAuthState, getGithubOAuthConfig, githubOAuthScopesForProvider, hasGithubCodespaceScope, normalizeScopeList } from "../services/github-oauth.js";
import { trimText } from "../services/text-utils.js";
import { readWorkspaceProviderChoice, resolveWorkspaceProviderState } from "../services/workspace-provider-choice.js";
import { callbackPage, escapeHtml } from "./github-callback-page.js";
import { errorMessage, resolveSession } from "./route-utils.js";

export const githubOAuthStartSchema = z.object({
  repoFullName: z.string().max(240).optional(),
}).strict();

// JSON dentro de <script>: sin "<", ">", "&" ni separadores de linea crudos,
// asi un valor que vino de la URL (repoFullName del OAuth) no puede cerrar la
// etiqueta.
export function inlineScriptJson(value: unknown) {
  return JSON.stringify(value)
    .replace(/</g, "\\u003c")
    .replace(/>/g, "\\u003e")
    .replace(/&/g, "\\u0026")
    .replace(/\u2028/g, "\\u2028")
    .replace(/\u2029/g, "\\u2029");
}

export function callbackNotifyScript(payload: unknown) {
  return `
    <script>
      (function () {
        var payload = ${inlineScriptJson(payload)};
        var attempts = 0;
        function notifyOpener() {
          attempts += 1;
          try {
            if (window.opener && !window.opener.closed) {
              window.opener.postMessage(payload, "*");
            }
          } catch (error) {}
          if (attempts >= 20) {
            window.clearInterval(timer);
          }
        }
        notifyOpener();
        var timer = window.setInterval(notifyOpener, 500);
      })();
    </script>
  `;
}

/**
 * Esta ventana (la del OAuth) es la que la extension reutiliza para esperar el
 * editor, pero es de otro origen y la extension no puede escribir en ella: le
 * manda el progreso y los errores por postMessage (ADACEEN_WAIT_UPDATE). Solo
 * se acepta de la ventana que la abrio y solo como texto.
 */
export const WAIT_UPDATE_MESSAGE_TYPE = "ADACEEN_WAIT_UPDATE";

export function callbackWaitUpdateScript() {
  return `
    <script>
      (function () {
        window.addEventListener("message", function (event) {
          if (!window.opener || event.source !== window.opener) return;
          var data = event.data;
          if (!data || data.type !== "${WAIT_UPDATE_MESSAGE_TYPE}") return;
          var title = document.getElementById("adaceenWaitTitle");
          var detail = document.getElementById("adaceenWaitDetail");
          if (title && typeof data.title === "string" && data.title) title.textContent = data.title.slice(0, 200);
          if (detail && typeof data.detail === "string") detail.textContent = data.detail.slice(0, 600);
        });
      })();
    </script>
  `;
}

export function isLocalCallbackUrl(value: string) {
  try {
    const url = new URL(value);
    const host = url.hostname.toLowerCase();
    return host === "localhost" || host === "127.0.0.1" || host === "::1";
  } catch {
    return false;
  }
}

export function getPublicRequestBaseUrl(req: express.Request) {
  const forwardedHost = trimText(req.get("x-forwarded-host")).split(",")[0]?.trim();
  const host = forwardedHost || trimText(req.get("host"));
  if (!host) return "";

  const forwardedProto = trimText(req.get("x-forwarded-proto")).split(",")[0]?.trim();
  const proto = forwardedProto || req.protocol || "https";
  return `${proto}://${host}`.replace(/\/+$/g, "");
}

export function resolveGithubOAuthCallbackUrl(req: express.Request) {
  const configured = trimText(getGithubOAuthConfig().callbackUrl);
  if (configured && !isLocalCallbackUrl(configured)) return configured;

  const publicBase = trimText(env.publicApiUrl) || getPublicRequestBaseUrl(req);
  if (publicBase && !isLocalCallbackUrl(publicBase)) {
    return `${publicBase.replace(/\/+$/g, "")}/auth/github/callback`;
  }

  return configured;
}

// OAuth de usuario de GitHub: estado, inicio y callbacks.
export function registerGithubOAuthRoutes(app: express.Express, database: AppDatabase) {
  app.get("/api/github/oauth/status", async (req, res) => {
    try {
      const session = await resolveSession(database, req);
      if (!session) {
        return res.status(401).json({ ok: false, error: "Sesion no valida." });
      }

      const config = getGithubOAuthConfig();
      const token = await database.getGithubUserTokenForUser(session.user.id);
      const scopes = token?.scopes || "";

      return res.json({
        ok: true,
        configured: config.configured,
        missingConfig: config.missing,
        invalidConfig: config.invalid,
        callbackUrl: resolveGithubOAuthCallbackUrl(req),
        connected: !!token,
        accountLogin: token?.accountLogin || null,
        accountEmail: token?.accountEmail || null,
        scopes: normalizeScopeList(scopes),
        hasCodespaceScope: hasGithubCodespaceScope(scopes),
        updatedAt: token?.updatedAt || null,
      });
    } catch (error) {
      return res.status(500).json({ ok: false, error: String(error) });
    }
  });

  app.post("/api/github/oauth/start", async (req, res) => {
    try {
      const session = await resolveSession(database, req);
      if (!session) {
        return res.status(401).json({ ok: false, error: "Sesion no valida." });
      }

      const config = getGithubOAuthConfig();
      if (!config.configured) {
        const details = [...config.missing, ...config.invalid].join(", ");
        return res.status(503).json({
          ok: false,
          error: `GitHub OAuth no configurado. ${details}`,
        });
      }

      const parsed = githubOAuthStartSchema.parse(req.body || {});
      const state = generateGithubOAuthState();
      const callbackUrl = resolveGithubOAuthCallbackUrl(req);
      // Los scopes dependen del entorno activo (el de la tuerca de la extension o la variable):
      // con el tunel solo read:user y user:email; con Codespaces, repo y codespace.
      const workspace = resolveWorkspaceProviderState(env.workspaceProvider, await readWorkspaceProviderChoice(database));
      const scopes = githubOAuthScopesForProvider(workspace.provider);
      await database.createGithubOAuthState({
        state,
        sessionId: session.id,
        userId: session.user.id,
        repoFullName: trimText(parsed.repoFullName),
      });

      return res.json({
        ok: true,
        authorizeUrl: buildGithubOAuthAuthorizeUrl(state, callbackUrl, scopes),
        scopes: normalizeScopeList(scopes),
        provider: workspace.provider,
        callbackUrl,
      });
    } catch (error) {
      const status = error instanceof z.ZodError ? 400 : 500;
      return res.status(status).json({ ok: false, error: errorMessage(error) });
    }
  });

  const handleGithubOAuthCallback = async (req: express.Request, res: express.Response) => {
    try {
      const code = trimText(req.query.code);
      const state = trimText(req.query.state);
      if (!code || !state) {
        return res.status(400).type("html").send(callbackPage("<p>Faltan parametros de OAuth GitHub.</p>"));
      }

      const oauthState = await database.consumeGithubOAuthState(state);
      if (!oauthState) {
        return res.status(400).type("html").send(callbackPage("<p>Estado OAuth invalido o expirado.</p>"));
      }

      const callbackUrl = resolveGithubOAuthCallbackUrl(req);
      const token = await exchangeGithubOAuthCode(code, callbackUrl);
      const githubUser = await fetchGithubOAuthUser(token.accessToken);
      await database.upsertGithubUserToken({
        userId: oauthState.userId,
        accountLogin: githubUser.login,
        accountEmail: githubUser.email,
        accessToken: token.accessToken,
        tokenType: token.tokenType,
        scopes: token.scopes,
      });

      // Con el tunel esta ventana pasa a la espera del editor (y al codigo de GitHub). El
      // entorno activo puede haberse elegido en la tuerca de la extension (0.7.19).
      const workspace = resolveWorkspaceProviderState(env.workspaceProvider, await readWorkspaceProviderChoice(database));
      const nextStep = workspace.provider === "tunnel"
        ? "ADACEEN esta preparando tu editor. Esta ventana se usara para abrirlo automaticamente."
        : "ADACEEN esta preparando el Codespace de la PR asociada. Esta ventana se usara para abrirlo automaticamente.";
      return res.type("html").send(callbackPage(`
        <p>GitHub conectado correctamente para ADACEEN.</p>
        <p><strong>Cuenta:</strong> ${escapeHtml(githubUser.login || "GitHub")}</p>
        <p><strong>Scopes:</strong> ${escapeHtml(token.scopes || "(sin scopes reportados)")}</p>
        <h3 id="adaceenWaitTitle">${nextStep}</h3>
        <p id="adaceenWaitDetail"></p>
      `, callbackWaitUpdateScript() + callbackNotifyScript({
        type: "ADACEEN_GITHUB_OAUTH_CONNECTED",
        repoFullName: oauthState.repoFullName,
        accountLogin: githubUser.login,
        scopes: normalizeScopeList(token.scopes),
      })));
    } catch (error) {
      return res.status(500).type("html").send(callbackPage(`
        <p>No se pudo finalizar OAuth de GitHub.</p>
        <pre>${escapeHtml(errorMessage(error))}</pre>
      `));
    }
  };

  app.get("/auth/github/callback", handleGithubOAuthCallback);
  app.get("/api/github-app/oauth/callback", (_req, res) => {
    return res.type("html").send(callbackPage(`
      <p>GitHub App autorizada.</p>
      <p>ADACEEN usa la GitHub App para instalarse en repositorios y una OAuth App separada para crear Codespaces del estudiante.</p>
      <p>Puedes cerrar esta ventana y volver a la extension.</p>
    `));
  });
}

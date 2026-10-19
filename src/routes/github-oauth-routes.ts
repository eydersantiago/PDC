// Rutas del OAuth de usuario de GitHub (estado, inicio y callbacks).
// Movido sin cambios desde src/routes/github-app-routes.ts (solo se agrego "export" y los imports).
import { z } from "zod";
import express from "express";
import { env } from "../config/env.js";
import type { AppDatabase } from "../db/database.js";
import { buildGithubOAuthAuthorizeUrl, exchangeGithubOAuthCode, fetchGithubOAuthUser, generateGithubOAuthState, getGithubOAuthConfig, githubOAuthScopesForProvider, hasGithubCodespaceScope, normalizeScopeList } from "../services/github-oauth.js";
import { recordGithubOAuthCallbackOk, recordGithubOAuthCallbackRejected } from "../services/github-oauth-callback-state.js";
import { trimText } from "../services/text-utils.js";
import { readWorkspaceProviderChoice, resolveWorkspaceProviderState } from "../services/workspace-provider-choice.js";
import { callbackPage, escapeHtml } from "./github-callback-page.js";
import { FIRST_TIME_STEPS, TUNNEL_CALLBACK_FALLBACK_MS, tunnelCallbackBody } from "./github-oauth-tunnel-page.js";
import { errorMessage, resolveSession } from "./route-utils.js";

export const githubOAuthStartSchema = z.object({
  repoFullName: z.string().max(240).optional(),
  // 0.8.1: cambiar la cuenta de GitHub conectada (GitHub muestra el selector de cuentas).
  selectAccount: z.boolean().optional(),
}).strict();

export const githubOAuthRedirectErrorSchema = z.object({
  redirectUri: z.string().max(500),
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
  // Pasos de la primera vez (0.8.0): data.step marca el actual en la pagina del tunel. Si en
  // TUNNEL_CALLBACK_FALLBACK_MS no llega ningun aviso de la extension (version anterior o la
  // ventana perdio a su opener), se muestra que pulsar (#adaceenWaitFallback).
  const steps = inlineScriptJson(FIRST_TIME_STEPS.map((step) => ({ id: step.id, label: step.label })));
  return `
    <script>
      (function () {
        var steps = ${steps};
        var received = false;
        function markStep(id) {
          var index = -1;
          for (var i = 0; i < steps.length; i++) if (steps[i].id === id) index = i;
          if (index < 0) return;
          var items = document.querySelectorAll("[data-adaceen-wait-step]");
          for (var j = 0; j < items.length; j++) {
            var itemIndex = -1;
            for (var k = 0; k < steps.length; k++) if (steps[k].id === items[j].getAttribute("data-adaceen-wait-step")) itemIndex = k;
            items[j].className = itemIndex < index ? "is-done" : itemIndex === index ? "is-current" : "";
            if (itemIndex === index) items[j].setAttribute("aria-current", "step");
            else items[j].removeAttribute("aria-current");
          }
          var heading = document.getElementById("adaceenWaitStep");
          if (heading) heading.textContent = "Paso " + (index + 1) + " de " + steps.length + " · " + steps[index].label;
        }
        window.addEventListener("message", function (event) {
          if (!window.opener || event.source !== window.opener) return;
          var data = event.data;
          if (!data || data.type !== "${WAIT_UPDATE_MESSAGE_TYPE}") return;
          received = true;
          var fallback = document.getElementById("adaceenWaitFallback");
          if (fallback) fallback.hidden = true;
          var title = document.getElementById("adaceenWaitTitle");
          var detail = document.getElementById("adaceenWaitDetail");
          if (title && typeof data.title === "string" && data.title) title.textContent = data.title.slice(0, 200);
          if (detail && typeof data.detail === "string") detail.textContent = data.detail.slice(0, 600);
          if (typeof data.step === "string") markStep(data.step);
        });
        window.setTimeout(function () {
          if (received) return;
          var fallback = document.getElementById("adaceenWaitFallback");
          if (fallback) fallback.hidden = false;
        }, ${TUNNEL_CALLBACK_FALLBACK_MS});
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

export function resolveGithubOAuthCallbackUrl(req?: express.Request) {
  const configured = trimText(getGithubOAuthConfig().callbackUrl);
  if (configured && !isLocalCallbackUrl(configured)) return configured;

  // Sin peticion (/api/health desde el monitor del servidor) solo cuenta PUBLIC_API_URL.
  const publicBase = trimText(env.publicApiUrl) || (req ? getPublicRequestBaseUrl(req) : "");
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
        authorizeUrl: buildGithubOAuthAuthorizeUrl(state, callbackUrl, scopes, { selectAccount: parsed.selectAccount === true }),
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
      // GitHub volvio a esta direccion: las «Redirect URIs» de la OAuth App la aceptan.
      await recordGithubOAuthCallbackOk(database, callbackUrl, oauthState.userId).catch(() => null);
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
      // Con el tunel, la pagina de los cuatro pasos de la primera vez (0.8.0).
      const body = workspace.provider === "tunnel"
        ? tunnelCallbackBody({ login: githubUser.login || "", scopes: token.scopes || "" })
        : `
        <p>GitHub conectado correctamente para ADACEEN.</p>
        <p><strong>Cuenta:</strong> ${escapeHtml(githubUser.login || "GitHub")}</p>
        <p><strong>Scopes:</strong> ${escapeHtml(token.scopes || "(sin scopes reportados)")}</p>
        <h3 id="adaceenWaitTitle">ADACEEN esta preparando el Codespace de la PR asociada. Esta ventana se usara para abrirlo automaticamente.</h3>
        <p id="adaceenWaitDetail"></p>
      `;
      return res.type("html").send(callbackPage(body, callbackWaitUpdateScript() + callbackNotifyScript({
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

  /**
   * La extension vio en github.com «The redirect_uri is not associated with this application»
   * para la direccion de ADACEEN: la OAuth App tiene registrada otra. Solo se anota si es la
   * direccion que este servidor manda (/api/health y el monitor lo muestran); no bloquea nada.
   */
  app.post("/api/github/oauth/redirect-error", async (req, res) => {
    try {
      const session = await resolveSession(database, req);
      if (!session) {
        return res.status(401).json({ ok: false, error: "Sesion no valida." });
      }
      const parsed = githubOAuthRedirectErrorSchema.parse(req.body || {});
      const callbackUrl = resolveGithubOAuthCallbackUrl(req);
      const recorded = !!callbackUrl && trimText(parsed.redirectUri) === callbackUrl;
      if (recorded) await recordGithubOAuthCallbackRejected(database, callbackUrl, session.user.id);
      return res.json({ ok: true, recorded, callbackUrl });
    } catch (error) {
      const status = error instanceof z.ZodError ? 400 : 500;
      return res.status(status).json({ ok: false, error: errorMessage(error) });
    }
  });
  app.get("/api/github-app/oauth/callback", (_req, res) => {
    return res.type("html").send(callbackPage(`
      <p>GitHub App autorizada.</p>
      <p>ADACEEN usa la GitHub App para instalarse en repositorios y una OAuth App separada para crear Codespaces del estudiante.</p>
      <p>Puedes cerrar esta ventana y volver a la extension.</p>
    `));
  });
}

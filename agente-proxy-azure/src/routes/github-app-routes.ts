import type express from "express";
import { z } from "zod";
import { env } from "../config/env.js";
import type { AppDatabase } from "../db/database.js";
import {
  bootstrapDevcontainerPullRequest,
  buildCodespaceQuickstartUrl,
  buildCodespaceWebUrlFromName,
  buildGithubAppInstallUrl,
  fetchGithubInstallationDetails,
  fetchGithubInstallationToken,
  findCodespaceForTargetForUser,
  findGithubInstallationForRepo,
  findLatestBootstrapPullRequest,
  generateInstallStateToken,
  getCodespaceStatusForUser,
  getGithubAppConfig,
  inspectRepoBootstrapStatus,
  installationCanAccessRepo,
  prepareCodespaceForTarget,
} from "../services/github-app.js";
import {
  extractBootstrapDetailValue,
  shouldTrustPersistedBootstrapState,
} from "../services/github-bootstrap-state.js";
import {
  buildGithubOAuthAuthorizeUrl,
  exchangeGithubOAuthCode,
  fetchGithubOAuthUser,
  generateGithubOAuthState,
  getGithubOAuthConfig,
  hasGithubCodespaceScope,
  normalizeScopeList,
} from "../services/github-oauth.js";
import { trimText } from "../services/text-utils.js";
import { errorMessage, resolveSession } from "./route-utils.js";

const githubInstallUrlSchema = z.object({
  repoFullName: z.string().max(240).optional(),
}).strict();

const githubOAuthStartSchema = z.object({
  repoFullName: z.string().max(240).optional(),
}).strict();

const githubBootstrapSchema = z.object({
  repoFullName: z.string().min(3).max(240),
  baseBranch: z.string().min(1).max(160).optional(),
  installationId: z.string().min(1).max(120).optional(),
  devcontainerJson: z.string().max(200000).optional(),
  force: z.boolean().optional(),
}).strict();

const githubPrepareEnvironmentSchema = z.object({
  repoFullName: z.string().min(3).max(240).optional(),
  owner: z.string().min(1).max(120).optional(),
  repo: z.string().min(1).max(120).optional(),
  baseBranch: z.string().min(1).max(160).optional(),
  mode: z.string().max(80).optional(),
  installationId: z.string().min(1).max(120).optional(),
  devcontainerJson: z.string().max(200000).optional(),
  force: z.boolean().optional(),
}).strict();

const githubCodespaceStatusSchema = z.object({
  name: z.string().min(1).max(120).optional(),
  repoFullName: z.string().min(3).max(240).optional(),
  pullNumber: z.coerce.number().int().min(0).max(999999).optional(),
  branchName: z.string().max(160).optional(),
}).strict().refine((value) => value.name || value.repoFullName, {
  message: "Debes enviar name o repoFullName para consultar Codespaces.",
});

const githubAutoLinkSchema = z.object({
  repoFullName: z.string().min(3).max(240),
}).strict();

function escapeHtml(value: string) {
  return trimText(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll("\"", "&quot;")
    .replaceAll("'", "&#39;")
    .replaceAll("`", "&#96;");
}

function callbackPage(body: string, script = "") {
  return `
    <html>
      <body style="font-family:Segoe UI,sans-serif;padding:24px;line-height:1.4;">
        <h2>ADACEEN</h2>
        ${body}
        ${script}
      </body>
    </html>
  `;
}

function callbackNotifyScript(payload: unknown) {
  return `
    <script>
      (function () {
        var payload = ${JSON.stringify(payload)};
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

function resolveRepoFullNameFromPrepareBody(body: z.infer<typeof githubPrepareEnvironmentSchema>) {
  const direct = trimText(body.repoFullName);
  if (direct) return direct;
  const owner = trimText(body.owner);
  const repo = trimText(body.repo);
  return owner && repo ? `${owner}/${repo}` : "";
}

function buildBootstrapDetails(input: {
  pullUrl?: string | null;
  pullNumber?: number | null;
  branchName?: string | null;
  codespaceUrl?: string | null;
  codespaceName?: string | null;
  codespaceWebUrl?: string | null;
  reason?: string | null;
}) {
  return [
    input.pullUrl ? `pullUrl=${input.pullUrl}` : "",
    input.pullNumber ? `pullNumber=${input.pullNumber}` : "",
    input.branchName ? `branchName=${input.branchName}` : "",
    input.codespaceUrl ? `codespaceUrl=${input.codespaceUrl}` : "",
    input.codespaceName ? `codespaceName=${input.codespaceName}` : "",
    input.codespaceWebUrl ? `codespaceWebUrl=${input.codespaceWebUrl}` : "",
    input.reason ? `reason=${input.reason}` : "",
  ].filter(Boolean).join("|");
}

function buildFallbackCodespace(
  repoFullName: string,
  pullNumber?: number | null,
  branchName?: string | null,
): { name: string | null; state: string | null; webUrl: string | null; fallbackUrl: string } {
  return {
    name: null,
    state: "fallback",
    webUrl: null,
    fallbackUrl: buildCodespaceQuickstartUrl({ repoFullName, pullNumber, branchName }),
  };
}

export function registerGithubAppRoutes(app: express.Express, database: AppDatabase) {
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
      await database.createGithubOAuthState({
        state,
        sessionId: session.id,
        userId: session.user.id,
        repoFullName: trimText(parsed.repoFullName),
      });

      return res.json({
        ok: true,
        authorizeUrl: buildGithubOAuthAuthorizeUrl(state),
        scopes: normalizeScopeList(config.scopes),
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

      const token = await exchangeGithubOAuthCode(code);
      const githubUser = await fetchGithubOAuthUser(token.accessToken);
      await database.upsertGithubUserToken({
        userId: oauthState.userId,
        accountLogin: githubUser.login,
        accountEmail: githubUser.email,
        accessToken: token.accessToken,
        tokenType: token.tokenType,
        scopes: token.scopes,
      });

      return res.type("html").send(callbackPage(`
        <p>GitHub conectado correctamente para ADACEEN.</p>
        <p><strong>Cuenta:</strong> ${escapeHtml(githubUser.login || "GitHub")}</p>
        <p><strong>Scopes:</strong> ${escapeHtml(token.scopes || "(sin scopes reportados)")}</p>
        <p>ADACEEN esta preparando el Codespace de la PR asociada. Esta ventana se usara para abrirlo automaticamente.</p>
      `, callbackNotifyScript({
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

  app.get("/api/github-app/status", async (req, res) => {
    try {
      const session = await resolveSession(database, req);
      if (!session) {
        return res.status(401).json({ ok: false, error: "Sesion no valida." });
      }

      const repoFullName = trimText(req.query.repoFullName);
      const config = getGithubAppConfig();
      const installation = await database.getLatestGithubInstallationForUser(session.user.id);
      const persistedBootstrap = repoFullName
        ? await database.getGithubRepoBootstrapState(session.user.id, repoFullName)
        : null;
      const sharedBootstrap = repoFullName
        ? await database.getLatestGithubRepoBootstrapStateByRepo(repoFullName)
        : null;

      let hasRepoAccess: boolean | null = null;
      let installationToken = "";
      if (config.configured && installation && repoFullName) {
        try {
          const token = await fetchGithubInstallationToken(installation.installationId);
          installationToken = trimText(token.token);
          hasRepoAccess = installationToken
            ? await installationCanAccessRepo(installationToken, repoFullName)
            : null;
        } catch {
          hasRepoAccess = null;
        }
      }

      const persistedBootstrapTrusted = persistedBootstrap?.isBootstrapped === true
        && shouldTrustPersistedBootstrapState(persistedBootstrap.source, persistedBootstrap.details);
      const sharedBootstrapTrusted = sharedBootstrap?.isBootstrapped === true
        && shouldTrustPersistedBootstrapState(sharedBootstrap.source, sharedBootstrap.details);

      let bootstrapReady = persistedBootstrapTrusted || sharedBootstrapTrusted;
      let bootstrapSource = persistedBootstrapTrusted
        ? (persistedBootstrap?.source || "")
        : (sharedBootstrapTrusted
          ? (sharedBootstrap?.source || "repo_shared")
          : "");
      let bootstrapUpdatedAt = persistedBootstrapTrusted
        ? (persistedBootstrap?.updatedAt || null)
        : (sharedBootstrapTrusted ? (sharedBootstrap?.updatedAt || null) : null);
      let bootstrapDetails = persistedBootstrapTrusted
        ? (persistedBootstrap?.details || "")
        : (sharedBootstrapTrusted ? (sharedBootstrap?.details || "") : "");
      let bootstrapSignals: Record<string, unknown> | null = null;

      if (config.configured && installationToken && repoFullName && hasRepoAccess === true && !bootstrapReady) {
        try {
          const existingBootstrapPr = await findLatestBootstrapPullRequest({
            installationToken,
            repoFullName,
          });

          if (existingBootstrapPr) {
            const prState = trimText(existingBootstrapPr.state).toLowerCase();
            const prLooksBootstrapped = prState === "open" || !!trimText(existingBootstrapPr.mergedAt);
            const codespaceUrl = buildCodespaceQuickstartUrl({
              repoFullName,
              pullNumber: existingBootstrapPr.pullNumber,
              branchName: existingBootstrapPr.headRef,
            });
            const detailsParts = [
              existingBootstrapPr.pullUrl ? `pullUrl=${existingBootstrapPr.pullUrl}` : "",
              existingBootstrapPr.pullNumber > 0 ? `pullNumber=${existingBootstrapPr.pullNumber}` : "",
              existingBootstrapPr.headRef ? `branchName=${existingBootstrapPr.headRef}` : "",
              codespaceUrl ? `codespaceUrl=${codespaceUrl}` : "",
              existingBootstrapPr.state ? `prState=${existingBootstrapPr.state}` : "",
              existingBootstrapPr.mergedAt ? `mergedAt=${existingBootstrapPr.mergedAt}` : "",
            ].filter(Boolean);

            const nextState = await database.upsertGithubRepoBootstrapState({
              userId: session.user.id,
              repoFullName,
              isBootstrapped: prLooksBootstrapped,
              source: prLooksBootstrapped ? "repo_pr_detected" : "repo_pr_closed_unmerged",
              details: detailsParts.join("|"),
            });
            bootstrapReady = nextState.isBootstrapped;
            bootstrapSource = nextState.source;
            bootstrapUpdatedAt = nextState.updatedAt;
            bootstrapDetails = nextState.details;
          }
        } catch {
          // Best effort: si falla la lectura de PRs seguimos con inspeccion de archivos.
        }
      }

      if (config.configured && installationToken && repoFullName && hasRepoAccess === true && !bootstrapReady) {
        try {
          const repoScan = await inspectRepoBootstrapStatus({
            installationToken,
            repoFullName,
          });
          bootstrapSignals = repoScan.signals as Record<string, unknown>;

          const nextState = await database.upsertGithubRepoBootstrapState({
            userId: session.user.id,
            repoFullName: repoScan.repoFullName,
            isBootstrapped: repoScan.isBootstrapped,
            source: "repo_scan",
            details: `branch=${repoScan.branch}`,
          });
          bootstrapReady = nextState.isBootstrapped;
          bootstrapSource = nextState.source;
          bootstrapUpdatedAt = nextState.updatedAt;
          bootstrapDetails = nextState.details;
        } catch {
          // Best effort: no bloquea la respuesta de estado.
        }
      }

      const bootstrapPullUrl = extractBootstrapDetailValue(bootstrapDetails, "pullUrl") || null;
      const bootstrapPullNumberRaw = extractBootstrapDetailValue(bootstrapDetails, "pullNumber");
      const bootstrapPullNumber = Number.isFinite(Number(bootstrapPullNumberRaw))
        ? Math.max(0, Number(bootstrapPullNumberRaw))
        : null;
      const bootstrapBranchName = extractBootstrapDetailValue(bootstrapDetails, "branchName")
        || extractBootstrapDetailValue(bootstrapDetails, "branch")
        || null;
      const bootstrapCodespaceUrl = extractBootstrapDetailValue(bootstrapDetails, "codespaceWebUrl")
        || extractBootstrapDetailValue(bootstrapDetails, "codespaceUrl")
        || (repoFullName
          ? buildCodespaceQuickstartUrl({
            repoFullName,
            pullNumber: bootstrapPullNumber,
            branchName: bootstrapBranchName,
          })
          : null);
      const shouldRedirectToDashboard = bootstrapReady;

      return res.json({
        ok: true,
        status: {
          configured: config.configured,
          missingConfig: config.missing,
          installUrlBase: config.installUrl || null,
          setupUrl: config.setupUrl || null,
          installation: installation
            ? {
              installationId: installation.installationId,
              accountLogin: installation.accountLogin,
              accountType: installation.accountType,
              repositorySelection: installation.repositorySelection,
              updatedAt: installation.updatedAt,
            }
            : null,
          repoFullName: repoFullName || null,
          hasRepoAccess,
          bootstrapReady,
          bootstrapSource: bootstrapSource || null,
          bootstrapUpdatedAt,
          bootstrapDetails: bootstrapDetails || null,
          bootstrapPullUrl,
          bootstrapPullNumber,
          bootstrapBranchName,
          bootstrapCodespaceUrl,
          bootstrapSignals,
          shouldRedirectToDashboard,
          redirectTo: shouldRedirectToDashboard ? env.dashboardRoute : null,
        },
      });
    } catch (error) {
      return res.status(500).json({ ok: false, error: String(error) });
    }
  });

  app.post("/api/github-app/install-url", async (req, res) => {
    try {
      const session = await resolveSession(database, req);
      if (!session) {
        return res.status(401).json({ ok: false, error: "Sesion no valida." });
      }

      const config = getGithubAppConfig();
      if (!config.configured) {
        return res.status(400).json({
          ok: false,
          error: `GitHub App no configurada. Faltan: ${config.missing.join(", ")}`,
        });
      }

      const parsed = githubInstallUrlSchema.parse(req.body || {});
      const state = generateInstallStateToken();
      await database.createGithubInstallState({
        userId: session.user.id,
        sessionId: session.id,
        repoFullName: trimText(parsed.repoFullName),
        state,
      });

      const installUrl = buildGithubAppInstallUrl(state);
      return res.json({
        ok: true,
        installUrl,
        state,
      });
    } catch (error) {
      const status = error instanceof z.ZodError ? 400 : 500;
      return res.status(status).json({ ok: false, error: errorMessage(error) });
    }
  });

  app.post("/api/github-app/link-installation-auto", async (req, res) => {
    try {
      const session = await resolveSession(database, req);
      if (!session) {
        return res.status(401).json({ ok: false, error: "Sesion no valida." });
      }

      const config = getGithubAppConfig();
      if (!config.configured) {
        return res.status(400).json({
          ok: false,
          error: `GitHub App no configurada. Faltan: ${config.missing.join(", ")}`,
        });
      }

      const parsed = githubAutoLinkSchema.parse(req.body || {});
      const matched = await findGithubInstallationForRepo(parsed.repoFullName);
      if (!matched) {
        return res.status(404).json({
          ok: false,
          error: `No se encontro una instalacion con acceso a ${parsed.repoFullName}.`,
        });
      }

      const linked = await database.upsertGithubInstallation({
        installationId: matched.installationId,
        userId: session.user.id,
        accountLogin: matched.accountLogin,
        accountType: matched.accountType,
        repositorySelection: matched.repositorySelection,
      });

      return res.json({
        ok: true,
        linkedInstallation: linked,
      });
    } catch (error) {
      const status = error instanceof z.ZodError ? 400 : 500;
      return res.status(status).json({ ok: false, error: errorMessage(error) });
    }
  });

  app.get("/api/github-app/callback", async (req, res) => {
    const state = trimText(req.query.state);
    const installationId = trimText(req.query.installation_id);
    const setupAction = trimText(req.query.setup_action) || "install";

    if (!state || !installationId) {
      return res.status(400).type("html").send(callbackPage(
        "<p>Faltan parametros del callback (state o installation_id).</p>",
      ));
    }

    try {
      const consumed = await database.consumeGithubInstallState(state);
      if (!consumed) {
        return res.status(400).type("html").send(callbackPage(
          "<p>El enlace de instalacion expiro o ya fue usado.</p>",
        ));
      }

      let accountLogin = "";
      let accountType = "";
      let repositorySelection = "";
      const config = getGithubAppConfig();

      if (config.configured) {
        try {
          const details = await fetchGithubInstallationDetails(installationId);
          accountLogin = trimText(details.account?.login);
          accountType = trimText(details.account?.type);
          repositorySelection = trimText(details.repository_selection);
        } catch {}
      }

      await database.upsertGithubInstallation({
        installationId,
        userId: consumed.userId,
        accountLogin,
        accountType,
        repositorySelection,
      });

      return res.status(200).type("html").send(callbackPage(`
        <p>GitHub App conectada correctamente.</p>
        <p><strong>Accion:</strong> ${escapeHtml(setupAction)}</p>
        <p><strong>Installation ID:</strong> ${escapeHtml(installationId)}</p>
        <p>Puedes cerrar esta ventana y volver a la extension.</p>
      `));
    } catch (error) {
      const safeError = escapeHtml(trimText(error));
      return res.status(500).type("html").send(callbackPage(`
        <p>No se pudo finalizar la conexion GitHub App.</p>
        <pre>${safeError}</pre>
      `));
    }
  });

  async function handlePrepareEnvironment(req: express.Request, res: express.Response) {
    try {
      const session = await resolveSession(database, req);
      if (!session) {
        return res.status(401).json({ ok: false, error: "Sesion no valida." });
      }

      const config = getGithubAppConfig();
      if (!config.configured) {
        return res.status(400).json({
          ok: false,
          error: `GitHub App no configurada. Faltan: ${config.missing.join(", ")}`,
        });
      }

      const parsed = githubPrepareEnvironmentSchema.parse(req.body || {});
      const repoFullName = resolveRepoFullNameFromPrepareBody(parsed);
      if (!repoFullName) {
        return res.status(400).json({ ok: false, error: "repoFullName requerido." });
      }

      const forceBootstrap = parsed.force === true;
      const baseBranch = trimText(parsed.baseBranch);
      const desiredInstallationId = trimText(parsed.installationId);
      let linkedInstallation = desiredInstallationId
        ? await database.getGithubInstallationForUserById(session.user.id, desiredInstallationId)
        : await database.getLatestGithubInstallationForUser(session.user.id);

      if (!linkedInstallation) {
        const autoFound = await findGithubInstallationForRepo(repoFullName);
        if (autoFound) {
          linkedInstallation = await database.upsertGithubInstallation({
            installationId: autoFound.installationId,
            userId: session.user.id,
            accountLogin: autoFound.accountLogin,
            accountType: autoFound.accountType,
            repositorySelection: autoFound.repositorySelection,
          });
        }
      }

      if (!linkedInstallation) {
        return res.status(400).json({
          ok: false,
          error: "No hay una instalacion GitHub App asociada al usuario actual.",
        });
      }

      const installationTokenResult = await fetchGithubInstallationToken(linkedInstallation.installationId);
      const installationToken = trimText(installationTokenResult.token);
      if (!installationToken) {
        return res.status(400).json({ ok: false, error: "No se pudo obtener token de instalacion GitHub." });
      }

      let pullUrl: string | null = null;
      let pullNumber: number | null = null;
      let branchName: string | null = null;
      let bootstrapSource = "pr_created";
      let bootstrapReason: string | null = null;

      const persistedBootstrap = await database.getGithubRepoBootstrapState(session.user.id, repoFullName);
      const persistedBootstrapTrusted = persistedBootstrap?.isBootstrapped
        ? shouldTrustPersistedBootstrapState(persistedBootstrap.source, persistedBootstrap.details)
        : false;

      if (!forceBootstrap && persistedBootstrap && persistedBootstrapTrusted) {
        pullUrl = extractBootstrapDetailValue(persistedBootstrap.details, "pullUrl") || null;
        const pullNumberRaw = extractBootstrapDetailValue(persistedBootstrap.details, "pullNumber");
        pullNumber = Number.isFinite(Number(pullNumberRaw)) ? Math.max(0, Number(pullNumberRaw)) : null;
        branchName = extractBootstrapDetailValue(persistedBootstrap.details, "branchName")
          || extractBootstrapDetailValue(persistedBootstrap.details, "branch")
          || null;
        bootstrapSource = persistedBootstrap.source || "state";
        bootstrapReason = "bootstrap_previously_created";
      } else {
        let existingPull: Awaited<ReturnType<typeof findLatestBootstrapPullRequest>> = null;
        if (!forceBootstrap) {
          try {
            existingPull = await findLatestBootstrapPullRequest({
              installationToken,
              repoFullName,
            });
          } catch {
            existingPull = null;
          }
        }

        if (existingPull) {
          pullUrl = existingPull.pullUrl || null;
          pullNumber = existingPull.pullNumber > 0 ? existingPull.pullNumber : null;
          branchName = existingPull.headRef || null;
          bootstrapSource = "repo_pr_detected";
          bootstrapReason = "bootstrap_existing_active_pr";
        } else {
          try {
            const result = await bootstrapDevcontainerPullRequest({
              installationId: linkedInstallation.installationId,
              repoFullName,
              baseBranch,
              devcontainerJson: trimText(parsed.devcontainerJson),
            });
            pullUrl = result.pullUrl || null;
            pullNumber = result.pullNumber || null;
            branchName = result.branchName || null;
            bootstrapSource = "pr_created";
          } catch (error) {
            const normalizedError = trimText(String(error)).toLowerCase();
            const noChangesToApply = normalizedError.includes("no hubo cambios para aplicar");
            if (!noChangesToApply) throw error;

            const repoScan = await inspectRepoBootstrapStatus({
              installationToken,
              repoFullName,
              branch: baseBranch,
            });
            branchName = repoScan.branch;
            bootstrapSource = "repo_scan";
            bootstrapReason = repoScan.isBootstrapped ? "bootstrap_detected_in_repo" : "bootstrap_no_changes";
          }
        }
      }

      const quickstartUrl = buildCodespaceQuickstartUrl({ repoFullName, pullNumber, branchName });
      let codespace = buildFallbackCodespace(repoFullName, pullNumber, branchName);
      let status = "fallback";
      let automation = "fallback";
      let fallbackReason = "";

      const githubUserToken = await database.getGithubUserTokenForUser(session.user.id);
      const githubUserTokenHasCodespaces = githubUserToken?.accessToken
        ? hasGithubCodespaceScope(githubUserToken.scopes)
        : false;
      const codespacesToken = githubUserTokenHasCodespaces
        ? githubUserToken?.accessToken
        : env.githubCodespacesUserToken;
      if (codespacesToken) {
        if (githubUserToken?.accessToken && !githubUserTokenHasCodespaces) {
          fallbackReason = "GitHub OAuth conectado sin scope codespace; usando token fallback de desarrollo.";
        }
        try {
          const prepared = await prepareCodespaceForTarget({
            githubUserToken: codespacesToken,
            repoFullName,
            pullNumber,
            branchName,
            geo: env.githubCodespacesGeo,
            timeoutMs: env.githubCodespacesWaitTimeoutMs,
            pollMs: env.githubCodespacesPollMs,
          });
          status = prepared.status;
          automation = prepared.action;
          codespace = {
            name: prepared.codespace.name || null,
            state: prepared.codespace.state || null,
            webUrl: prepared.codespace.webUrl || buildCodespaceWebUrlFromName(prepared.codespace.name) || null,
            fallbackUrl: prepared.quickstartUrl || quickstartUrl,
          };
        } catch (error) {
          fallbackReason = errorMessage(error);
        }
      } else {
        fallbackReason = githubUserToken?.accessToken
          ? "GitHub OAuth del estudiante no tiene scope codespace."
          : "GitHub OAuth del estudiante no conectado.";
      }

      await database.upsertGithubRepoBootstrapState({
        userId: session.user.id,
        repoFullName,
        isBootstrapped: true,
        source: bootstrapSource,
        details: buildBootstrapDetails({
          pullUrl,
          pullNumber,
          branchName,
          codespaceUrl: quickstartUrl,
          codespaceName: codespace.name,
          codespaceWebUrl: codespace.webUrl,
          reason: bootstrapReason || fallbackReason || null,
        }),
      });

      return res.json({
        ok: true,
        status,
        automation,
        fallbackReason: fallbackReason || null,
        repository: repoFullName,
        pullRequest: {
          number: pullNumber,
          url: pullUrl,
          branchName,
        },
        codespace,
        fallback: {
          webUrl: quickstartUrl,
        },
      });
    } catch (error) {
      const status = error instanceof z.ZodError ? 400 : 500;
      return res.status(status).json({ ok: false, error: errorMessage(error) });
    }
  }

  app.post("/github/prepare-environment", handlePrepareEnvironment);
  app.post("/api/github-app/prepare-environment", handlePrepareEnvironment);

  app.get("/api/github/codespaces/status", async (req, res) => {
    try {
      const session = await resolveSession(database, req);
      if (!session) {
        return res.status(401).json({ ok: false, error: "Sesion no valida." });
      }

      const parsed = githubCodespaceStatusSchema.parse({
        name: trimText(req.query.name),
        repoFullName: trimText(req.query.repoFullName),
        pullNumber: trimText(req.query.pullNumber) || undefined,
        branchName: trimText(req.query.branchName),
      });
      const githubUserToken = await database.getGithubUserTokenForUser(session.user.id);
      const codespacesToken = githubUserToken?.accessToken || env.githubCodespacesUserToken;
      if (!codespacesToken) {
        return res.status(400).json({
          ok: false,
          error: "GitHub OAuth del estudiante no conectado para consultar Codespaces.",
        });
      }

      const status = parsed.name
        ? await getCodespaceStatusForUser({
          githubUserToken: codespacesToken,
          name: parsed.name,
        })
        : await findCodespaceForTargetForUser({
          githubUserToken: codespacesToken,
          repoFullName: parsed.repoFullName || "",
          pullNumber: parsed.pullNumber,
          branchName: parsed.branchName,
        });

      return res.json({
        ok: true,
        found: !!status,
        codespace: status,
      });
    } catch (error) {
      const status = error instanceof z.ZodError ? 400 : 500;
      return res.status(status).json({ ok: false, error: errorMessage(error) });
    }
  });

  app.post("/api/github-app/bootstrap-devcontainer", async (req, res) => {
    try {
      const session = await resolveSession(database, req);
      if (!session) {
        return res.status(401).json({ ok: false, error: "Sesion no valida." });
      }

      const config = getGithubAppConfig();
      if (!config.configured) {
        return res.status(400).json({
          ok: false,
          error: `GitHub App no configurada. Faltan: ${config.missing.join(", ")}`,
        });
      }

      const parsed = githubBootstrapSchema.parse(req.body || {});
      const forceBootstrap = parsed.force === true;
      const desiredInstallationId = trimText(parsed.installationId);
      let linkedInstallation = desiredInstallationId
        ? await database.getGithubInstallationForUserById(session.user.id, desiredInstallationId)
        : await database.getLatestGithubInstallationForUser(session.user.id);

      // Temporal: permitir prueba de PR aunque no exista vinculacion previa por callback.
      // Si no hay instalacion asociada al usuario, intentamos resolverla por acceso real al repo.
      if (!linkedInstallation) {
        const autoFound = await findGithubInstallationForRepo(parsed.repoFullName);
        if (autoFound) {
          linkedInstallation = await database.upsertGithubInstallation({
            installationId: autoFound.installationId,
            userId: session.user.id,
            accountLogin: autoFound.accountLogin,
            accountType: autoFound.accountType,
            repositorySelection: autoFound.repositorySelection,
          });
        }
      }

      if (!linkedInstallation) {
        return res.status(400).json({
          ok: false,
          error: "No hay una instalacion GitHub App asociada al usuario actual.",
        });
      }

      const repoFullName = trimText(parsed.repoFullName);
      const baseBranch = trimText(parsed.baseBranch);
      const persistedBootstrap = await database.getGithubRepoBootstrapState(session.user.id, repoFullName);
      const persistedBootstrapTrusted = persistedBootstrap?.isBootstrapped
        ? shouldTrustPersistedBootstrapState(persistedBootstrap.source, persistedBootstrap.details)
        : false;
      if (!forceBootstrap && persistedBootstrap?.isBootstrapped && persistedBootstrapTrusted) {
        const pullUrl = extractBootstrapDetailValue(persistedBootstrap.details, "pullUrl") || null;
        const pullNumberRaw = extractBootstrapDetailValue(persistedBootstrap.details, "pullNumber");
        const pullNumber = Number.isFinite(Number(pullNumberRaw))
          ? Math.max(0, Number(pullNumberRaw))
          : null;
        const branchName = extractBootstrapDetailValue(persistedBootstrap.details, "branchName")
          || extractBootstrapDetailValue(persistedBootstrap.details, "branch")
          || null;
        const codespaceUrl = extractBootstrapDetailValue(persistedBootstrap.details, "codespaceWebUrl")
          || extractBootstrapDetailValue(persistedBootstrap.details, "codespaceUrl")
          || buildCodespaceQuickstartUrl({ repoFullName, pullNumber, branchName });

        return res.json({
          ok: true,
          alreadyBootstrapped: true,
          redirectTo: env.dashboardRoute,
          reason: "bootstrap_previously_created",
          result: null,
          bootstrap: {
            repoFullName: persistedBootstrap.repoFullName,
            source: persistedBootstrap.source || "state",
            updatedAt: persistedBootstrap.updatedAt,
            details: persistedBootstrap.details || null,
            pullUrl,
            pullNumber,
            branchName,
            codespaceUrl,
          },
        });
      }

      let installationToken = "";
      try {
        const token = await fetchGithubInstallationToken(linkedInstallation.installationId);
        installationToken = trimText(token.token);
      } catch {}

      if (!forceBootstrap && installationToken) {
        try {
          const existingPull = await findLatestBootstrapPullRequest({
            installationToken,
            repoFullName,
          });

          if (existingPull) {
            const codespaceUrl = buildCodespaceQuickstartUrl({
              repoFullName,
              pullNumber: existingPull.pullNumber,
              branchName: existingPull.headRef,
            });
            const detailParts = [
              existingPull.pullUrl ? `pullUrl=${existingPull.pullUrl}` : "",
              existingPull.pullNumber > 0 ? `pullNumber=${existingPull.pullNumber}` : "",
              existingPull.headRef ? `branchName=${existingPull.headRef}` : "",
              codespaceUrl ? `codespaceUrl=${codespaceUrl}` : "",
              existingPull.state ? `prState=${existingPull.state}` : "",
              existingPull.mergedAt ? `mergedAt=${existingPull.mergedAt}` : "",
            ].filter(Boolean);
            const nextState = await database.upsertGithubRepoBootstrapState({
              userId: session.user.id,
              repoFullName,
              isBootstrapped: true,
              source: "repo_pr_detected",
              details: detailParts.join("|"),
            });

            return res.json({
              ok: true,
              alreadyBootstrapped: true,
              redirectTo: env.dashboardRoute,
              reason: "bootstrap_existing_active_pr",
              result: null,
              bootstrap: {
                repoFullName: nextState.repoFullName,
                source: nextState.source,
                updatedAt: nextState.updatedAt,
                details: nextState.details || null,
                pullUrl: existingPull.pullUrl || null,
                pullNumber: existingPull.pullNumber > 0 ? existingPull.pullNumber : null,
                branchName: existingPull.headRef || null,
                codespaceUrl,
              },
            });
          }
        } catch {
          // Best effort: si falla la lectura de PRs seguimos con inspeccion de archivos.
        }
      }

      if (!forceBootstrap && installationToken) {
        try {
          const repoScan = await inspectRepoBootstrapStatus({
            installationToken,
            repoFullName,
            branch: baseBranch,
          });

          if (repoScan.isBootstrapped) {
            const codespaceUrl = buildCodespaceQuickstartUrl({
              repoFullName: repoScan.repoFullName,
              branchName: repoScan.branch,
            });
            const nextState = await database.upsertGithubRepoBootstrapState({
              userId: session.user.id,
              repoFullName: repoScan.repoFullName,
              isBootstrapped: true,
              source: "repo_scan",
              details: `branch=${repoScan.branch}|codespaceUrl=${codespaceUrl}`,
            });

            return res.json({
              ok: true,
              alreadyBootstrapped: true,
              redirectTo: env.dashboardRoute,
              reason: "bootstrap_detected_in_repo",
              result: null,
              bootstrap: {
                repoFullName: nextState.repoFullName,
                source: nextState.source,
                updatedAt: nextState.updatedAt,
                details: nextState.details || null,
                pullUrl: null,
                pullNumber: null,
                branchName: repoScan.branch,
                codespaceUrl,
              },
            });
          }
        } catch {
          // Best effort: si falla la inspeccion seguimos con la creacion del PR.
        }
      }

      let result: Awaited<ReturnType<typeof bootstrapDevcontainerPullRequest>>;
      try {
        result = await bootstrapDevcontainerPullRequest({
          installationId: linkedInstallation.installationId,
          repoFullName,
          baseBranch,
          devcontainerJson: trimText(parsed.devcontainerJson),
        });
      } catch (error) {
        const normalizedError = trimText(String(error)).toLowerCase();
        const noChangesToApply = normalizedError.includes("no hubo cambios para aplicar");

        if (forceBootstrap && noChangesToApply) {
          let pullUrl: string | null = null;
          let pullNumber: number | null = null;
          let branchName: string | null = null;

          if (installationToken) {
            try {
              const existingPull = await findLatestBootstrapPullRequest({
                installationToken,
                repoFullName,
              });
              pullUrl = existingPull?.pullUrl || null;
              pullNumber = existingPull && existingPull.pullNumber > 0
                ? existingPull.pullNumber
                : null;
              branchName = existingPull?.headRef || null;
            } catch {
              // Best effort: continuamos aun sin URL/numero del PR previo.
            }
          }

          const codespaceUrl = buildCodespaceQuickstartUrl({ repoFullName, pullNumber, branchName });

          const detailParts = [
            pullUrl ? `pullUrl=${pullUrl}` : "",
            pullNumber ? `pullNumber=${pullNumber}` : "",
            branchName ? `branchName=${branchName}` : "",
            codespaceUrl ? `codespaceUrl=${codespaceUrl}` : "",
            "reason=no_changes_to_apply",
          ].filter(Boolean);

          const nextState = await database.upsertGithubRepoBootstrapState({
            userId: session.user.id,
            repoFullName,
            isBootstrapped: true,
            source: "repo_scan",
            details: detailParts.join("|"),
          });

          return res.json({
            ok: true,
            alreadyBootstrapped: true,
            redirectTo: env.dashboardRoute,
            reason: "bootstrap_no_changes",
            result: null,
            bootstrap: {
              repoFullName: nextState.repoFullName,
              source: nextState.source,
              updatedAt: nextState.updatedAt,
              details: nextState.details || null,
              pullUrl,
              pullNumber,
              branchName,
              codespaceUrl,
            },
          });
        }

        throw error;
      }

      await database.upsertGithubRepoBootstrapState({
        userId: session.user.id,
        repoFullName,
        isBootstrapped: true,
        source: "pr_created",
        details: result.pullUrl
          ? [
            `pullUrl=${result.pullUrl}`,
            result.pullNumber ? `pullNumber=${result.pullNumber}` : "",
            result.branchName ? `branchName=${result.branchName}` : "",
            result.codespaceUrl ? `codespaceUrl=${result.codespaceUrl}` : "",
          ].filter(Boolean).join("|")
          : [
            result.pullNumber ? `pullNumber=${result.pullNumber}` : "",
            result.branchName ? `branchName=${result.branchName}` : "",
            result.codespaceUrl ? `codespaceUrl=${result.codespaceUrl}` : "",
          ].filter(Boolean).join("|"),
      });

      return res.json({
        ok: true,
        result,
      });
    } catch (error) {
      const status = error instanceof z.ZodError ? 400 : 500;
      return res.status(status).json({ ok: false, error: errorMessage(error) });
    }
  });
}

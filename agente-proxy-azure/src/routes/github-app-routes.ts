import type express from "express";
import { z } from "zod";
import { env } from "../config/env.js";
import type { AppDatabase } from "../db/database.js";
import {
  bootstrapDevcontainerPullRequest,
  buildGithubAppInstallUrl,
  fetchGithubInstallationDetails,
  fetchGithubInstallationToken,
  findGithubInstallationForRepo,
  findLatestBootstrapPullRequest,
  generateInstallStateToken,
  getGithubAppConfig,
  inspectRepoBootstrapStatus,
  installationCanAccessRepo,
} from "../services/github-app.js";
import {
  extractBootstrapDetailValue,
  shouldTrustPersistedBootstrapState,
} from "../services/github-bootstrap-state.js";
import { trimText } from "../services/text-utils.js";
import { errorMessage, resolveSession } from "./route-utils.js";

const githubInstallUrlSchema = z.object({
  repoFullName: z.string().max(240).optional(),
}).strict();

const githubBootstrapSchema = z.object({
  repoFullName: z.string().min(3).max(240),
  baseBranch: z.string().min(1).max(160).optional(),
  installationId: z.string().min(1).max(120).optional(),
  devcontainerJson: z.string().max(200000).optional(),
  force: z.boolean().optional(),
}).strict();

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

function callbackPage(body: string) {
  return `
    <html>
      <body style="font-family:Segoe UI,sans-serif;padding:24px;line-height:1.4;">
        <h2>ADACEEN</h2>
        ${body}
      </body>
    </html>
  `;
}

export function registerGithubAppRoutes(app: express.Express, database: AppDatabase) {
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
            const detailsParts = [
              existingBootstrapPr.pullUrl ? `pullUrl=${existingBootstrapPr.pullUrl}` : "",
              existingBootstrapPr.pullNumber > 0 ? `pullNumber=${existingBootstrapPr.pullNumber}` : "",
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
          const repoScan = await inspectRepoBootstrapStatus({
            installationToken,
            repoFullName,
            branch: baseBranch,
          });

          if (repoScan.isBootstrapped) {
            const nextState = await database.upsertGithubRepoBootstrapState({
              userId: session.user.id,
              repoFullName: repoScan.repoFullName,
              isBootstrapped: true,
              source: "repo_scan",
              details: `branch=${repoScan.branch}`,
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
            } catch {
              // Best effort: continuamos aun sin URL/numero del PR previo.
            }
          }

          const detailParts = [
            pullUrl ? `pullUrl=${pullUrl}` : "",
            pullNumber ? `pullNumber=${pullNumber}` : "",
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
          ? `pullUrl=${result.pullUrl}`
          : (result.pullNumber ? `pullNumber=${result.pullNumber}` : ""),
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

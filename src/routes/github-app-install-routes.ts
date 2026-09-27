// Rutas de la GitHub App (estado, URL de instalacion, vinculo automatico y callback).
// Movido sin cambios desde src/routes/github-app-routes.ts (solo se agrego "export" y los imports).
import { z } from "zod";
import express from "express";
import { env } from "../config/env.js";
import type { AppDatabase } from "../db/database.js";
import { buildCodespaceQuickstartUrl, buildGithubAppInstallUrl, fetchGithubInstallationDetails, fetchGithubInstallationToken, findGithubInstallationForRepo, findLatestBootstrapPullRequest, generateInstallStateToken, getGithubAppConfig, inspectRepoBootstrapStatus, installationCanAccessRepo } from "../services/github-app.js";
import { extractBootstrapDetailValue, shouldTrustPersistedBootstrapState } from "../services/github-bootstrap-state.js";
import { trimText } from "../services/text-utils.js";
import { callbackPage, escapeHtml } from "./github-callback-page.js";
import { errorMessage, resolveSession } from "./route-utils.js";

export const githubInstallUrlSchema = z.object({
  repoFullName: z.string().max(240).optional(),
}).strict();

export const githubAutoLinkSchema = z.object({
  repoFullName: z.string().min(3).max(240),
}).strict();

// GitHub manda installation_id como numero; cualquier otra cosa en la URL se
// rechaza antes de gastar el state (asi el enlace bueno sigue sirviendo).
export const GITHUB_INSTALLATION_ID_PATTERN = /^\d{1,20}$/;

// GitHub App: estado, URL de instalacion, vinculo automatico y callback.
export function registerGithubAppInstallRoutes(app: express.Express, database: AppDatabase) {
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
    if (!GITHUB_INSTALLATION_ID_PATTERN.test(installationId)) {
      return res.status(400).type("html").send(callbackPage(
        "<p>El installation_id del callback no es valido.</p>",
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

      // La extension (desde 0.7.12) consulta /api/github-app/status tras abrir
      // la instalacion y avanza sola: no hace falta volver a pulsar nada. Esta
      // pestana se abre sin opener, asi que no hay aviso por postMessage. Una
      // extension anterior no consulta sola, pero al recargar la pestana de
      // ADACEEN vuelve a leer el estado y avanza.
      return res.status(200).type("html").send(callbackPage(`
        <h3>Ya puedes cerrar esta pestana.</h3>
        <p>GitHub App conectada correctamente. ADACEEN detecta la instalacion solo y sigue en la pestana donde lo estabas usando: no hace falta pulsar nada mas.</p>
        <p>Si esa pestana no avanza en un minuto, recargala.</p>
        <details>
          <summary>Detalles tecnicos</summary>
          <p>Accion: ${escapeHtml(setupAction)}</p>
          <p>Installation ID: ${escapeHtml(installationId)}</p>
        </details>
      `));
    } catch (error) {
      const safeError = escapeHtml(trimText(error));
      return res.status(500).type("html").send(callbackPage(`
        <p>No se pudo finalizar la conexion GitHub App.</p>
        <pre>${safeError}</pre>
      `));
    }
  });
}

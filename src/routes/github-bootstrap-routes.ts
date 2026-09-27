// Ruta del PR que agrega el devcontainer al repositorio.
// Movido sin cambios desde src/routes/github-app-routes.ts (solo se agrego "export" y los imports).
import { z } from "zod";
import express from "express";
import { env } from "../config/env.js";
import type { AppDatabase } from "../db/database.js";
import { bootstrapDevcontainerPullRequest, buildCodespaceQuickstartUrl, fetchGithubInstallationToken, findGithubInstallationForRepo, findLatestBootstrapPullRequest, getGithubAppConfig, inspectRepoBootstrapStatus } from "../services/github-app.js";
import { extractBootstrapDetailValue, shouldTrustPersistedBootstrapState } from "../services/github-bootstrap-state.js";
import { trimText } from "../services/text-utils.js";
import { errorMessage, resolveSession } from "./route-utils.js";

export const githubBootstrapSchema = z.object({
  repoFullName: z.string().min(3).max(240),
  baseBranch: z.string().min(1).max(160).optional(),
  installationId: z.string().min(1).max(120).optional(),
  devcontainerJson: z.string().max(200000).optional(),
  force: z.boolean().optional(),
}).strict();

// PR que agrega el devcontainer al repositorio.
export function registerGithubBootstrapRoutes(app: express.Express, database: AppDatabase) {
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

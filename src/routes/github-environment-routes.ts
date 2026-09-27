// Rutas para preparar el entorno (Codespace) y consultar su estado.
// Movido sin cambios desde src/routes/github-app-routes.ts (solo se agrego "export" y los imports).
import { z } from "zod";
import express from "express";
import { env } from "../config/env.js";
import type { AppDatabase } from "../db/database.js";
import { bootstrapDevcontainerPullRequest, buildCodespaceQuickstartUrl, buildCodespaceWebUrlFromName, fetchGithubInstallationToken, findCodespaceForTargetForUser, findGithubInstallationForRepo, findLatestBootstrapPullRequest, getCodespaceStatusForUser, getGithubAppConfig, inspectRepoBootstrapStatus, prepareCodespaceForTarget } from "../services/github-app.js";
import { extractBootstrapDetailValue, shouldTrustPersistedBootstrapState } from "../services/github-bootstrap-state.js";
import { hasGithubCodespaceScope } from "../services/github-oauth.js";
import { trimText } from "../services/text-utils.js";
import type { BehaviorEventInput } from "../types/app.js";
import { errorMessage, resolveSession } from "./route-utils.js";
import type { AppSession } from "./route-utils.js";

export const githubPrepareEnvironmentSchema = z.object({
  repoFullName: z.string().min(3).max(240).optional(),
  owner: z.string().min(1).max(120).optional(),
  repo: z.string().min(1).max(120).optional(),
  baseBranch: z.string().min(1).max(160).optional(),
  mode: z.string().max(80).optional(),
  installationId: z.string().min(1).max(120).optional(),
  devcontainerJson: z.string().max(200000).optional(),
  force: z.boolean().optional(),
}).strict();

export const githubCodespaceStatusSchema = z.object({
  name: z.string().min(1).max(120).optional(),
  repoFullName: z.string().min(3).max(240).optional(),
  pullNumber: z.coerce.number().int().min(0).max(999999).optional(),
  branchName: z.string().max(160).optional(),
}).strict().refine((value) => value.name || value.repoFullName, {
  message: "Debes enviar name o repoFullName para consultar Codespaces.",
});

export const PREPARE_ENVIRONMENT_CODESPACE_WAIT_TIMEOUT_MS = 15_000;

export const PREPARE_ENVIRONMENT_CODESPACE_POLL_MS = 3_000;

export function resolveRepoFullNameFromPrepareBody(body: z.infer<typeof githubPrepareEnvironmentSchema>) {
  const direct = trimText(body.repoFullName);
  if (direct) return direct;
  const owner = trimText(body.owner);
  const repo = trimText(body.repo);
  return owner && repo ? `${owner}/${repo}` : "";
}

export function buildBootstrapDetails(input: {
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

export function buildFallbackCodespace(
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

export async function recordGithubBehaviorEvent(
  database: AppDatabase,
  session: AppSession,
  event: BehaviorEventInput,
) {
  try {
    await database.recordBehaviorEvents({
      sessionId: session.id,
      user: session.user,
      events: [event],
    });
  } catch {
    // La telemetria de comportamiento nunca debe bloquear el flujo GitHub/Codespaces.
  }
}

// Preparar el entorno (Codespace) y su estado.
export function registerGithubEnvironmentRoutes(app: express.Express, database: AppDatabase) {
  async function handlePrepareEnvironment(req: express.Request, res: express.Response) {
    let behaviorSession: AppSession | null = null;
    let behaviorRepoFullName = "";
    let behaviorForce = false;
    try {
      const session = await resolveSession(database, req);
      if (!session) {
        return res.status(401).json({ ok: false, error: "Sesion no valida." });
      }
      behaviorSession = session;

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
      behaviorRepoFullName = repoFullName;

      const forceBootstrap = parsed.force === true;
      behaviorForce = forceBootstrap;
      const baseBranch = trimText(parsed.baseBranch);
      await recordGithubBehaviorEvent(database, session, {
        source: "backend",
        category: "github_pr",
        eventType: forceBootstrap ? "prepare_environment_retry_started" : "prepare_environment_started",
        repoFullName,
        branch: baseBranch,
        value: trimText(parsed.mode) || "pr-codespace",
        metadata: {
          force: forceBootstrap,
          mode: trimText(parsed.mode),
          hasDevcontainerJson: Boolean(trimText(parsed.devcontainerJson)),
        },
      });

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
            timeoutMs: Math.min(
              env.githubCodespacesWaitTimeoutMs,
              PREPARE_ENVIRONMENT_CODESPACE_WAIT_TIMEOUT_MS,
            ),
            pollMs: Math.min(env.githubCodespacesPollMs, PREPARE_ENVIRONMENT_CODESPACE_POLL_MS),
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

      await recordGithubBehaviorEvent(database, session, {
        source: "backend",
        category: "github_pr",
        eventType: bootstrapSource === "pr_created" ? "bootstrap_pr_created" : "bootstrap_pr_reused",
        repoFullName,
        branch: branchName || baseBranch,
        subjectId: pullNumber ? `pr:${pullNumber}` : "",
        value: bootstrapSource,
        metadata: {
          force: forceBootstrap,
          bootstrapSource,
          bootstrapReason,
          pullUrl,
        },
      });

      await recordGithubBehaviorEvent(database, session, {
        source: "backend",
        category: "codespace",
        eventType: status === "ready" ? "codespace_ready" : "codespace_fallback",
        repoFullName,
        branch: branchName || baseBranch,
        subjectId: codespace.name || "",
        value: status,
        metadata: {
          automation,
          fallbackReason,
          hasWebUrl: Boolean(codespace.webUrl),
          pullNumber,
        },
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
      if (behaviorSession && behaviorRepoFullName) {
        await recordGithubBehaviorEvent(database, behaviorSession, {
          source: "backend",
          category: "error",
          eventType: behaviorForce ? "prepare_environment_retry_failed" : "prepare_environment_failed",
          repoFullName: behaviorRepoFullName,
          value: errorMessage(error),
          metadata: {
            force: behaviorForce,
          },
        });
      }
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
      const githubUserTokenHasCodespaces = githubUserToken?.accessToken
        ? hasGithubCodespaceScope(githubUserToken.scopes)
        : false;
      const codespacesToken = githubUserTokenHasCodespaces
        ? githubUserToken?.accessToken
        : env.githubCodespacesUserToken;
      if (!codespacesToken) {
        return res.status(400).json({
          ok: false,
          error: githubUserToken?.accessToken
            ? "GitHub OAuth del estudiante no tiene scope codespace para consultar Codespaces."
            : "GitHub OAuth del estudiante no conectado para consultar Codespaces.",
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
}

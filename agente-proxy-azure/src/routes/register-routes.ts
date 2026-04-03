import express from "express";
import multer from "multer";
import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import { runSuggestTab } from "../../runSuggestTab.js";
import { env } from "../config/env.js";
import { AppDatabase } from "../db/database.js";
import { evaluateMentorIntervention } from "../services/decision-engine.js";
import { runImageByMode, runTextByMode } from "../services/agent-mode.js";
import { buildDeterministicGradeAnswer, buildMissingPdfTextAnswer } from "../services/tab-fallbacks.js";
import { trimText } from "../services/text-utils.js";
import {
  bootstrapDevcontainerPullRequest,
  buildGithubAppInstallUrl,
  fetchGithubInstallationDetails,
  fetchGithubInstallationToken,
  findGithubInstallationForRepo,
  generateInstallStateToken,
  getGithubAppConfig,
  installationCanAccessRepo,
} from "../services/github-app.js";
import type { GithubMentorContext, TeacherPolicy, UserRoleCode } from "../types/app.js";

const loginSchema = z.object({
  email: z.string().email(),
  password: z.string().min(6),
});

const policyPatchSchema = z.object({
  policyName: z.string().min(3).max(120).optional(),
  outcome: z.enum(["RA1", "RA2", "RA3"]).optional(),
  tone: z.enum(["warm", "direct", "socratic"]).optional(),
  frequency: z.enum(["low", "medium", "high"]).optional(),
  helpLevel: z.enum(["progressive", "hint_only", "partial_example"]).optional(),
  allowMiniQuiz: z.boolean().optional(),
  strictNoSolution: z.boolean().optional(),
  maxHintsPerExercise: z.number().int().min(1).nullable().optional(),
  fallbackMessage: z.string().min(10).max(280).optional(),
  customInstruction: z.string().max(600).optional(),
  allowedInterventions: z.array(z.enum(["explanation", "hint", "example", "mini_quiz"])).optional(),
  allowedTopics: z.array(z.string().min(2).max(50)).optional(),
  eventRules: z.record(
    z.enum([
      "compile_error",
      "runtime_error",
      "concept_question",
      "design_block",
      "workflow_guidance",
      "insufficient_context",
      "out_of_domain",
    ]),
    z.object({
      enabled: z.boolean(),
      interventionType: z.enum(["explanation", "hint", "example", "mini_quiz", "controlled_message"]),
      detailLevel: z.enum(["brief", "guided", "progressive"]),
      activationThreshold: z.number().int().min(1).max(5),
      maxUsesPerSession: z.number().int().min(1).nullable(),
    }),
  ).optional(),
}).strict();

const workspaceConsentSchema = z.object({
  canRead: z.boolean().default(true),
  canModify: z.boolean().default(true),
  canAnalyze: z.boolean().default(true),
}).strict();

const projectRackSchema = z.object({
  source: z.string().min(2).max(32).optional(),
  repoFullName: z.string().max(240).optional(),
  branch: z.string().max(160).optional(),
  generatedAt: z.string().datetime().optional(),
  totalEntries: z.number().int().min(0).max(120000),
  totalFiles: z.number().int().min(0).max(120000),
  totalFolders: z.number().int().min(0).max(120000),
  files: z.array(z.string().min(1).max(700)).max(120000),
  folders: z.array(z.string().min(1).max(700)).max(120000),
  activeFilePath: z.string().max(700).optional(),
  activeCodeSnippet: z.string().max(120000).optional(),
}).strict();

const githubInstallUrlSchema = z.object({
  repoFullName: z.string().max(240).optional(),
}).strict();

const githubBootstrapSchema = z.object({
  repoFullName: z.string().min(3).max(240),
  baseBranch: z.string().min(1).max(160).optional(),
  installationId: z.string().min(1).max(120).optional(),
  devcontainerJson: z.string().max(200000).optional(),
}).strict();

const githubAutoLinkSchema = z.object({
  repoFullName: z.string().min(3).max(240),
}).strict();

function buildTabSuggestionPrompt(params: {
  tabContent: string;
  question?: string;
  tabTitle?: string;
  tabUrl?: string;
}) {
  const question = params.question?.trim() || "Dame sugerencias basicas sobre este contenido.";
  const safeContent = params.tabContent.slice(0, Math.max(1, env.maxTabContentChars));

  return [
    "Analiza el contenido de la pestaña y responde en Markdown.",
    "Formato estricto:",
    "1) Resumen corto (max 5 lineas).",
    "2) 3 sugerencias basicas y accionables.",
    "3) 2 dudas o riesgos detectados.",
    "Si hay enlaces visibles relevantes, mencionarlos y aclarar si solo se detecta el enlace o tambien su contenido.",
    "Si falta contexto, dilo sin inventar.",
    "",
    `Titulo: ${params.tabTitle || "(sin titulo)"}`,
    `URL: ${params.tabUrl || "(sin URL)"}`,
    `Pregunta del usuario: ${question}`,
    "",
    "Contenido de la pestaña:",
    safeContent,
  ].join("\n");
}

async function resolveSession(database: AppDatabase, req: express.Request) {
  const sessionId = trimText(req.header("x-session-id") || req.body?.sessionId);
  if (!sessionId) return null;
  return database.getSession(sessionId);
}

function buildAuthPayload(session: NonNullable<Awaited<ReturnType<AppDatabase["getSession"]>>>, policy: TeacherPolicy | null) {
  return {
    session: {
      id: session.id,
      createdAt: session.createdAt,
      lastSeenAt: session.lastSeenAt,
      user: session.user,
    },
    policy,
  };
}

export function registerRoutes(app: express.Express, database: AppDatabase) {
  const uploadsDir = path.join(process.cwd(), "uploads");
  if (!fs.existsSync(uploadsDir)) {
    fs.mkdirSync(uploadsDir, { recursive: true });
  }

  const upload = multer({
    storage: multer.diskStorage({
      destination: (_req, _file, cb) => cb(null, uploadsDir),
      filename: (_req, file, cb) => {
        const extension = path.extname(file.originalname || "");
        cb(null, `${Date.now()}-${Math.random().toString(36).slice(2)}${extension}`);
      },
    }),
    limits: { fileSize: 8 * 1024 * 1024 },
    fileFilter: (_req, file, cb) => cb(null, /image\/(png|jpeg|webp|gif|bmp|tiff)/.test(file.mimetype)),
  });

  app.get("/health", (_req, res) => {
    const githubConfig = getGithubAppConfig();
    res.json({
      ok: true,
      mode: env.targetMode === "azure" ? "azure" : "local",
      azure_server: env.targetMode === "azure" ? env.azureServer || null : null,
      max_tab_content_chars: env.maxTabContentChars,
      max_mentor_code_chars: env.maxMentorCodeChars,
      database_provider: database.provider,
      github_app_configured: githubConfig.configured,
      github_app_slug: githubConfig.appSlug || null,
    });
  });

  app.post("/api/auth/login", async (req, res) => {
    try {
      const parsed = loginSchema.parse(req.body || {});
      const session = await database.authenticateUser(parsed.email, parsed.password);
      if (!session) {
        return res.status(401).json({ ok: false, error: "Credenciales invalidas." });
      }

      const policy = await database.getTeacherPolicyForUser(session.user);
      const telemetry = session.user.role === "teacher"
        ? await database.listTelemetryForTeacher(session.user.id, 6)
        : [];

      return res.json({
        ok: true,
        ...buildAuthPayload(session, policy),
        telemetry,
      });
    } catch (error) {
      const message = error instanceof z.ZodError
        ? error.issues.map((issue) => issue.message).join("; ")
        : String(error);
      return res.status(400).json({ ok: false, error: message });
    }
  });

  app.get("/api/auth/me", async (req, res) => {
    try {
      const session = await resolveSession(database, req);
      if (!session) {
        return res.status(401).json({ ok: false, error: "Sesion no valida." });
      }

      const policy = await database.getTeacherPolicyForUser(session.user);
      const telemetry = session.user.role === "teacher"
        ? await database.listTelemetryForTeacher(session.user.id, 6)
        : [];

      return res.json({
        ok: true,
        ...buildAuthPayload(session, policy),
        telemetry,
      });
    } catch (error) {
      return res.status(500).json({ ok: false, error: String(error) });
    }
  });

  app.post("/api/auth/logout", async (req, res) => {
    try {
      const session = await resolveSession(database, req);
      if (session) {
        await database.logoutSession(session.id);
      }

      return res.json({ ok: true });
    } catch (error) {
      return res.status(500).json({ ok: false, error: String(error) });
    }
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

      let hasRepoAccess: boolean | null = null;
      if (config.configured && installation && repoFullName) {
        try {
          const token = await fetchGithubInstallationToken(installation.installationId);
          hasRepoAccess = await installationCanAccessRepo(token.token, repoFullName);
        } catch {
          hasRepoAccess = null;
        }
      }

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
      if (error instanceof z.ZodError) {
        const message = error.issues.map((issue) => issue.message).join("; ");
        return res.status(400).json({ ok: false, error: message });
      }

      return res.status(500).json({ ok: false, error: String(error) });
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
      if (error instanceof z.ZodError) {
        const message = error.issues.map((issue) => issue.message).join("; ");
        return res.status(400).json({ ok: false, error: message });
      }

      return res.status(500).json({ ok: false, error: String(error) });
    }
  });

  app.get("/api/github-app/callback", async (req, res) => {
    const state = trimText(req.query.state);
    const installationId = trimText(req.query.installation_id);
    const setupAction = trimText(req.query.setup_action) || "install";

    if (!state || !installationId) {
      return res.status(400).type("html").send(`
        <html><body style="font-family:Segoe UI,sans-serif;padding:24px;">
          <h2>ADACEEN</h2>
          <p>Faltan parametros del callback (state o installation_id).</p>
        </body></html>
      `);
    }

    try {
      const consumed = await database.consumeGithubInstallState(state);
      if (!consumed) {
        return res.status(400).type("html").send(`
          <html><body style="font-family:Segoe UI,sans-serif;padding:24px;">
            <h2>ADACEEN</h2>
            <p>El enlace de instalacion expiro o ya fue usado.</p>
          </body></html>
        `);
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

      return res.status(200).type("html").send(`
        <html>
          <body style="font-family:Segoe UI,sans-serif;padding:24px;line-height:1.4;">
            <h2>ADACEEN</h2>
            <p>GitHub App conectada correctamente.</p>
            <p><strong>Accion:</strong> ${setupAction}</p>
            <p><strong>Installation ID:</strong> ${installationId}</p>
            <p>Puedes cerrar esta ventana y volver a la extension.</p>
          </body>
        </html>
      `);
    } catch (error) {
      return res.status(500).type("html").send(`
        <html><body style="font-family:Segoe UI,sans-serif;padding:24px;">
          <h2>ADACEEN</h2>
          <p>No se pudo finalizar la conexion GitHub App.</p>
          <pre>${String(error)}</pre>
        </body></html>
      `);
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

      const result = await bootstrapDevcontainerPullRequest({
        installationId: linkedInstallation.installationId,
        repoFullName: parsed.repoFullName,
        baseBranch: trimText(parsed.baseBranch),
        devcontainerJson: trimText(parsed.devcontainerJson),
      });

      return res.json({
        ok: true,
        result,
      });
    } catch (error) {
      if (error instanceof z.ZodError) {
        const message = error.issues.map((issue) => issue.message).join("; ");
        return res.status(400).json({ ok: false, error: message });
      }

      return res.status(500).json({ ok: false, error: String(error) });
    }
  });

  app.get("/api/projects/consent", async (req, res) => {
    try {
      const session = await resolveSession(database, req);
      if (!session) {
        return res.status(401).json({ ok: false, error: "Sesion no valida." });
      }

      const consent = await database.getWorkspaceConsent(session.user.id);
      return res.json({ ok: true, consent });
    } catch (error) {
      return res.status(500).json({ ok: false, error: String(error) });
    }
  });

  app.post("/api/projects/consent", async (req, res) => {
    try {
      const session = await resolveSession(database, req);
      if (!session) {
        return res.status(401).json({ ok: false, error: "Sesion no valida." });
      }

      const parsed = workspaceConsentSchema.parse(req.body || {});
      const consent = await database.upsertWorkspaceConsent(session.user.id, parsed);
      return res.json({ ok: true, consent });
    } catch (error) {
      if (error instanceof z.ZodError) {
        const message = error.issues.map((issue) => issue.message).join("; ");
        return res.status(400).json({ ok: false, error: message });
      }

      return res.status(500).json({ ok: false, error: String(error) });
    }
  });

  app.post("/api/projects/rack", async (req, res) => {
    try {
      const session = await resolveSession(database, req);
      if (!session) {
        return res.status(401).json({ ok: false, error: "Sesion no valida." });
      }

      const consent = await database.getWorkspaceConsent(session.user.id);
      if (!consent.granted) {
        return res.status(403).json({
          ok: false,
          error: "Debes otorgar permisos de lectura/modificacion/analisis antes de guardar el rack.",
        });
      }

      const parsed = projectRackSchema.parse(req.body || {});
      const files = [...new Set((parsed.files || []).map((item) => trimText(item)).filter(Boolean))];
      const folders = [...new Set((parsed.folders || []).map((item) => trimText(item)).filter(Boolean))];

      const rackId = await database.saveProjectContextRack({
        sessionId: session.id,
        userId: session.user.id,
        source: trimText(parsed.source) || "codespace",
        repoFullName: trimText(parsed.repoFullName),
        branch: trimText(parsed.branch),
        generatedAt: trimText(parsed.generatedAt),
        totalEntries: Math.max(parsed.totalEntries, files.length + folders.length),
        totalFiles: Math.max(parsed.totalFiles, files.length),
        totalFolders: Math.max(parsed.totalFolders, folders.length),
        files,
        folders,
        activeFilePath: trimText(parsed.activeFilePath),
        activeCodeSnippet: trimText(parsed.activeCodeSnippet),
      });

      return res.json({
        ok: true,
        rackId,
        stored: {
          files: files.length,
          folders: folders.length,
        },
      });
    } catch (error) {
      if (error instanceof z.ZodError) {
        const message = error.issues.map((issue) => issue.message).join("; ");
        return res.status(400).json({ ok: false, error: message });
      }

      return res.status(500).json({ ok: false, error: String(error) });
    }
  });

  app.get("/api/policies/current", async (req, res) => {
    try {
      const session = await resolveSession(database, req);
      if (!session) {
        return res.status(401).json({ ok: false, error: "Sesion no valida." });
      }

      const policy = await database.getTeacherPolicyForUser(session.user);
      const telemetry = session.user.role === "teacher"
        ? await database.listTelemetryForTeacher(session.user.id, 8)
        : [];

      return res.json({
        ok: true,
        policy,
        telemetry,
      });
    } catch (error) {
      return res.status(500).json({ ok: false, error: String(error) });
    }
  });

  app.put("/api/policies/current", async (req, res) => {
    try {
      const session = await resolveSession(database, req);
      if (!session || session.user.role !== "teacher") {
        return res.status(403).json({ ok: false, error: "Solo el profesor puede actualizar politicas." });
      }

      const parsed = policyPatchSchema.parse(req.body || {});
      const policy = await database.updateTeacherPolicy(session.user.id, parsed);
      const telemetry = await database.listTelemetryForTeacher(session.user.id, 8);

      return res.json({
        ok: true,
        policy,
        telemetry,
      });
    } catch (error) {
      const message = error instanceof z.ZodError
        ? error.issues.map((issue) => issue.message).join("; ")
        : String(error);
      return res.status(400).json({ ok: false, error: message });
    }
  });

  app.get("/api/telemetry/interventions", async (req, res) => {
    try {
      const session = await resolveSession(database, req);
      if (!session || session.user.role !== "teacher") {
        return res.status(403).json({ ok: false, error: "Solo el profesor puede consultar telemetria." });
      }

      const limit = Math.max(1, Math.min(25, Number(req.query.limit) || 10));
      const items = await database.listTelemetryForTeacher(session.user.id, limit);

      return res.json({ ok: true, items });
    } catch (error) {
      return res.status(500).json({ ok: false, error: String(error) });
    }
  });

  app.post("/run-text", async (req, res) => {
    try {
      const input = trimText(req.body?.input_as_text);
      if (!input) {
        return res.status(400).json({ ok: false, error: "input_as_text requerido" });
      }

      const output = await runTextByMode(input);
      return res.json({ ok: true, output_text: output });
    } catch (error) {
      return res.status(500).json({ ok: false, error: String(error) });
    }
  });

  app.post("/run-image", upload.single("image"), async (req, res) => {
    try {
      if (!req.file) {
        return res.status(400).json({ ok: false, error: "image requerida" });
      }

      const prompt = trimText(req.body?.prompt);
      const output = await runImageByMode(req.file, prompt);
      return res.json({ ok: true, output_text: output });
    } catch (error) {
      return res.status(500).json({ ok: false, error: String(error) });
    } finally {
      if (req.file?.path) {
        await fsp.unlink(req.file.path).catch(() => {});
      }
    }
  });

  app.post("/suggest-tab", async (req, res) => {
    try {
      const tabContent = trimText(req.body?.tab_content);
      if (!tabContent) {
        return res.status(400).json({ ok: false, error: "tab_content requerido" });
      }

      const question = trimText(req.body?.question);
      const tabTitle = trimText(req.body?.tab_title);
      const tabUrl = trimText(req.body?.tab_url);

      const missingPdfText = buildMissingPdfTextAnswer({ question, tabContent });
      if (missingPdfText) {
        return res.json({ ok: true, output_text: missingPdfText });
      }

      const deterministic = buildDeterministicGradeAnswer({ question, tabContent });
      if (deterministic) {
        return res.json({ ok: true, output_text: deterministic });
      }

      let output = "";
      if (env.targetMode !== "azure") {
        try {
          output = await runSuggestTab({
            tabContent,
            question,
            tabTitle,
            tabUrl,
            maxTabContentChars: env.maxTabContentChars,
          });
        } catch {
          output = await runTextByMode(buildTabSuggestionPrompt({ tabContent, question, tabTitle, tabUrl }));
        }
      } else {
        output = await runTextByMode(buildTabSuggestionPrompt({ tabContent, question, tabTitle, tabUrl }));
      }

      return res.json({ ok: true, output_text: output });
    } catch (error) {
      return res.status(500).json({ ok: false, error: String(error) });
    }
  });

  async function handleStructuredIntervention(req: express.Request, res: express.Response) {
    try {
      const question = trimText(req.body?.question) || "Sugiere ideas y busquedas para mejorar este codigo.";
      const rawMaxItems = Number(req.body?.max_items);
      const maxItems = Number.isFinite(rawMaxItems)
        ? Math.max(3, Math.min(8, Math.round(rawMaxItems)))
        : 6;
      const rawContext = (req.body?.context || {}) as GithubMentorContext;
      const session = await resolveSession(database, req);

      const evaluation = await evaluateMentorIntervention({
        question,
        context: rawContext,
        maxItems,
        session,
        database,
      });

      return res.json({
        ok: true,
        source: evaluation.source,
        result: evaluation.result,
        policy_applied: evaluation.policy,
        telemetry_id: evaluation.telemetryId,
      });
    } catch (error) {
      return res.status(500).json({ ok: false, error: String(error) });
    }
  }

  app.post("/intervene", handleStructuredIntervention);
  app.post("/github-mentor", handleStructuredIntervention);

  app.post("/run", upload.single("image"), async (req, res) => {
    try {
      if (req.file) {
        const prompt = trimText(req.body?.prompt);
        const output = await runImageByMode(req.file, prompt);
        return res.json({ ok: true, output_text: output });
      }

      const input = trimText(req.body?.input_as_text);
      if (!input) {
        return res.status(400).json({ ok: false, error: "input_as_text requerido" });
      }

      const output = await runTextByMode(input);
      return res.json({ ok: true, output_text: output });
    } catch (error) {
      return res.status(500).json({ ok: false, error: String(error) });
    } finally {
      if (req.file?.path) {
        await fsp.unlink(req.file.path).catch(() => {});
      }
    }
  });
}

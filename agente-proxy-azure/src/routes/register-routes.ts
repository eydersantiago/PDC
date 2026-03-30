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

const projectMetricsSchema = z.object({
  suggestionsReceived: z.number().int().min(0).max(100_000).default(0),
  suggestionsAccepted: z.number().int().min(0).max(100_000).default(0),
  errorsDetected: z.number().int().min(0).max(100_000).default(0),
  quizzesTaken: z.number().int().min(0).max(100_000).default(0),
}).strict();

const projectFileSchema = z.object({
  path: z.string().min(1).max(600),
  language: z.string().max(60).default(""),
  lineCount: z.number().int().min(0).max(120_000).default(0),
  content: z.string().max(120_000).default(""),
  capturedAt: z.string().datetime().optional(),
}).strict();

const projectSnapshotSchema = z.object({
  totalEntries: z.number().int().min(0).max(200_000).optional(),
  totalFiles: z.number().int().min(0).max(200_000).optional(),
  totalFolders: z.number().int().min(0).max(200_000).optional(),
  folders: z.array(z.string().min(1).max(600)).max(10_000).optional(),
  files: z.array(z.string().min(1).max(600)).max(10_000).optional(),
  generatedAt: z.string().datetime().optional(),
}).passthrough();

const projectSaveSchema = z.object({
  workspaceKey: z.string().min(3).max(280),
  repoFullName: z.string().min(1).max(280),
  branch: z.string().max(150).default(""),
  projectLabel: z.string().max(280).default(""),
  snapshot: projectSnapshotSchema.default({}),
  files: z.array(projectFileSchema).max(180).default([]),
  metrics: projectMetricsSchema.default({
    suggestionsReceived: 0,
    suggestionsAccepted: 0,
    errorsDetected: 0,
    quizzesTaken: 0,
  }),
  lastActivityAt: z.string().datetime().optional(),
}).strict();

const projectTitleUpdateSchema = z.object({
  workspaceKey: z.string().min(3).max(280),
  projectLabel: z.string().min(1).max(280),
}).strict();

const projectDeleteSchema = z.object({
  workspaceKey: z.string().min(3).max(280),
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
    res.json({
      ok: true,
      mode: env.targetMode === "azure" ? "azure" : "local",
      azure_server: env.targetMode === "azure" ? env.azureServer || null : null,
      max_tab_content_chars: env.maxTabContentChars,
      max_mentor_code_chars: env.maxMentorCodeChars,
      database_provider: database.provider,
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

  app.post("/api/projects/save", async (req, res) => {
    try {
      const session = await resolveSession(database, req);
      if (!session) {
        return res.status(401).json({ ok: false, error: "Sesion no valida." });
      }

      const parsed = projectSaveSchema.parse(req.body || {});
      const memory = await database.saveProjectMemory({
        ownerUserId: session.user.id,
        workspaceKey: parsed.workspaceKey,
        repoFullName: parsed.repoFullName,
        branch: parsed.branch,
        projectLabel: parsed.projectLabel,
        snapshot: parsed.snapshot,
        files: parsed.files.map((file) => ({
          path: file.path,
          language: file.language,
          lineCount: file.lineCount,
          content: file.content,
          capturedAt: file.capturedAt || new Date().toISOString(),
        })),
        metrics: parsed.metrics,
        savedBy: "manual",
        lastActivityAt: parsed.lastActivityAt,
      });

      return res.json({ ok: true, memory });
    } catch (error) {
      const message = error instanceof z.ZodError
        ? error.issues.map((issue) => issue.message).join("; ")
        : String(error);
      return res.status(400).json({ ok: false, error: message });
    }
  });

  app.get("/api/projects/current", async (req, res) => {
    try {
      const session = await resolveSession(database, req);
      if (!session) {
        return res.status(401).json({ ok: false, error: "Sesion no valida." });
      }

      const workspaceKey = trimText(req.query.workspace_key);
      if (!workspaceKey) {
        return res.status(400).json({ ok: false, error: "workspace_key requerido." });
      }

      const memory = await database.getProjectMemory(session.user.id, workspaceKey);
      return res.json({ ok: true, memory });
    } catch (error) {
      return res.status(500).json({ ok: false, error: String(error) });
    }
  });

  app.get("/api/projects/list", async (req, res) => {
    try {
      const session = await resolveSession(database, req);
      if (!session) {
        return res.status(401).json({ ok: false, error: "Sesion no valida." });
      }

      const limit = Math.max(1, Math.min(30, Number(req.query.limit) || 10));
      const items = await database.listProjectMemorySummaries(session.user.id, limit);
      return res.json({ ok: true, items });
    } catch (error) {
      return res.status(500).json({ ok: false, error: String(error) });
    }
  });

  app.put("/api/projects/title", async (req, res) => {
    try {
      const session = await resolveSession(database, req);
      if (!session) {
        return res.status(401).json({ ok: false, error: "Sesion no valida." });
      }

      const parsed = projectTitleUpdateSchema.parse(req.body || {});
      const memory = await database.updateProjectMemoryTitle(
        session.user.id,
        parsed.workspaceKey,
        parsed.projectLabel,
      );

      if (!memory) {
        return res.status(404).json({ ok: false, error: "Proyecto no encontrado." });
      }

      return res.json({ ok: true, memory });
    } catch (error) {
      const message = error instanceof z.ZodError
        ? error.issues.map((issue) => issue.message).join("; ")
        : String(error);
      return res.status(400).json({ ok: false, error: message });
    }
  });

  app.delete("/api/projects", async (req, res) => {
    try {
      const session = await resolveSession(database, req);
      if (!session) {
        return res.status(401).json({ ok: false, error: "Sesion no valida." });
      }

      const parsed = projectDeleteSchema.parse(req.body || {});
      const deleted = await database.deleteProjectMemory(session.user.id, parsed.workspaceKey);
      return res.json({ ok: true, deleted });
    } catch (error) {
      const message = error instanceof z.ZodError
        ? error.issues.map((issue) => issue.message).join("; ")
        : String(error);
      return res.status(400).json({ ok: false, error: message });
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

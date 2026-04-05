import express from "express";
import multer from "multer";
import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import { createHash, randomUUID } from "node:crypto";
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
  findLatestBootstrapPullRequest,
  generateInstallStateToken,
  getGithubAppConfig,
  inspectRepoBootstrapStatus,
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
  force: z.boolean().optional(),
}).strict();

const githubAutoLinkSchema = z.object({
  repoFullName: z.string().min(3).max(240),
}).strict();

const projectScanRequestSchema = z.object({
  repoFullName: z.string().min(3).max(240),
  source: z.string().min(1).max(60).optional(),
}).strict();

const projectScanWorkerResultSchema = z.object({
  repoFullName: z.string().min(3).max(240),
  runtime: z.record(z.string(), z.unknown()).optional(),
  mode: z.record(z.string(), z.unknown()).optional(),
  workspaceFolders: z.array(z.record(z.string(), z.unknown())).optional(),
  selectedFolders: z.array(z.record(z.string(), z.unknown())).optional(),
  scannedAt: z.string().datetime().optional(),
  totalFiles: z.number().int().min(0).max(5000),
  skippedBySize: z.number().int().min(0).max(5000).optional(),
  files: z.array(z.object({
    path: z.string().min(1).max(900),
    bytes: z.number().int().min(0).max(2_000_000),
    lines: z.number().int().min(0).max(2_000_000),
    preview: z.string().max(2000).optional(),
    content: z.string().max(500_000),
  })).max(5000),
}).strict();

const projectScanWorkerFailSchema = z.object({
  error: z.string().min(1).max(1200),
}).strict();

const DASHBOARD_ROUTE = "/dashboard";
const DEFAULT_SCAN_SOURCE = "dashboard_explore";
const DEFAULT_SCAN_WORKER_ID = "vscode-ext-worker";
const PROJECT_SCAN_REQUEST_STATUSES = {
  pending: "pending",
  claimed: "claimed",
  completed: "completed",
  failed: "failed",
} as const;
type ProjectScanRequestStatus = typeof PROJECT_SCAN_REQUEST_STATUSES[keyof typeof PROJECT_SCAN_REQUEST_STATUSES];

type ProjectScanRequestRow = {
  id: string;
  repo_full_name: string;
  status: ProjectScanRequestStatus;
  requested_by_user_id: string | null;
  requested_session_id: string | null;
  worker_instance: string;
  error_message: string;
  snapshot_id: string;
  requested_at: string | Date;
  claimed_at: string | Date | null;
  completed_at: string | Date | null;
  updated_at: string | Date;
};

type ProjectScanSnapshotRow = {
  id: string;
  request_id: string | null;
  repo_full_name: string;
  source: string;
  total_files: number;
  skipped_by_size: number;
  total_bytes: string | number;
  storage_path: string;
  created_at: string | Date;
};

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

function extractBootstrapDetailValue(details: string, key: "pullUrl" | "pullNumber") {
  const raw = trimText(details);
  if (!raw) return "";
  const segments = raw.split("|").map((item) => trimText(item)).filter(Boolean);
  const prefix = `${key}=`.toLowerCase();
  for (const item of segments) {
    if (!item.toLowerCase().startsWith(prefix)) continue;
    return trimText(item.slice(prefix.length));
  }
  return "";
}

function toIso(value: string | Date | null | undefined) {
  if (!value) return null;
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
}

function normalizeRepoFullName(value: unknown) {
  const text = trimText(value).replace(/^https?:\/\/github\.com\//i, "").replace(/\.git$/i, "");
  const match = text.match(/^([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+)$/);
  if (!match) return "";
  return `${match[1]}/${match[2]}`.toLowerCase();
}

function sanitizePathSegment(value: string) {
  const clean = trimText(value).toLowerCase();
  if (!clean) return "unknown";
  return clean.replace(/[^a-z0-9._-]+/g, "_").replace(/^_+|_+$/g, "").slice(0, 160) || "unknown";
}

function buildScanStoragePath(repoFullName: string, requestId: string) {
  const scansRoot = env.projectScansDir
    ? path.resolve(env.projectScansDir)
    : path.join(process.cwd(), "data", "project-scans");
  const repoFolder = sanitizePathSegment(repoFullName.replace("/", "__"));
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const fileName = `${stamp}-${sanitizePathSegment(requestId)}.json`;
  return {
    scansRoot,
    absolutePath: path.join(scansRoot, repoFolder, fileName),
  };
}

function ensureWorkerAuthorized(req: express.Request) {
  const expected = trimText(env.scanWorkerKey);
  if (!expected) return true;
  const provided = trimText(req.header("x-adaceen-worker-key") || req.query.workerKey || "");
  return provided === expected;
}

function mapProjectScanRequestRow(row: ProjectScanRequestRow | undefined | null) {
  if (!row) return null;
  return {
    id: row.id,
    repoFullName: row.repo_full_name,
    status: row.status,
    requestedByUserId: row.requested_by_user_id,
    requestedSessionId: row.requested_session_id,
    workerInstance: row.worker_instance,
    errorMessage: row.error_message,
    snapshotId: row.snapshot_id,
    requestedAt: toIso(row.requested_at),
    claimedAt: toIso(row.claimed_at),
    completedAt: toIso(row.completed_at),
    updatedAt: toIso(row.updated_at),
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

  app.post("/api/projects/scan/request", async (req, res) => {
    try {
      const session = await resolveSession(database, req);
      if (!session) {
        return res.status(401).json({ ok: false, error: "Sesion no valida." });
      }

      const parsed = projectScanRequestSchema.parse(req.body || {});
      const repoFullName = normalizeRepoFullName(parsed.repoFullName);
      if (!repoFullName) {
        return res.status(400).json({ ok: false, error: "repoFullName invalido. Usa owner/repo." });
      }

      const existing = await database.pool.query<ProjectScanRequestRow>(
        `
        select
          id,
          repo_full_name,
          status,
          requested_by_user_id,
          requested_session_id,
          worker_instance,
          error_message,
          snapshot_id,
          requested_at,
          claimed_at,
          completed_at,
          updated_at
        from project_scan_requests
        where repo_full_name = $1
          and requested_by_user_id = $2
          and status in ('pending', 'claimed')
        order by requested_at desc
        limit 1
        `,
        [repoFullName, session.user.id],
      );

      if (existing.rows[0]) {
        return res.json({
          ok: true,
          request: mapProjectScanRequestRow(existing.rows[0]),
          reused: true,
        });
      }

      const requestId = randomUUID();
      const inserted = await database.pool.query<ProjectScanRequestRow>(
        `
        insert into project_scan_requests (
          id,
          repo_full_name,
          status,
          requested_by_user_id,
          requested_session_id,
          worker_instance,
          error_message,
          snapshot_id
        )
        values ($1, $2, 'pending', $3, $4, '', '', '')
        returning
          id,
          repo_full_name,
          status,
          requested_by_user_id,
          requested_session_id,
          worker_instance,
          error_message,
          snapshot_id,
          requested_at,
          claimed_at,
          completed_at,
          updated_at
        `,
        [requestId, repoFullName, session.user.id, session.id],
      );

      return res.json({
        ok: true,
        source: trimText(parsed.source) || DEFAULT_SCAN_SOURCE,
        request: mapProjectScanRequestRow(inserted.rows[0]),
        reused: false,
      });
    } catch (error) {
      if (error instanceof z.ZodError) {
        const message = error.issues.map((issue) => issue.message).join("; ");
        return res.status(400).json({ ok: false, error: message });
      }
      return res.status(500).json({ ok: false, error: String(error) });
    }
  });

  app.get("/api/projects/scan/request/next", async (req, res) => {
    try {
      if (!ensureWorkerAuthorized(req)) {
        return res.status(401).json({ ok: false, error: "Worker no autorizado." });
      }

      const repoFullName = normalizeRepoFullName(req.query.repoFullName);
      if (!repoFullName) {
        return res.status(400).json({ ok: false, error: "repoFullName invalido." });
      }

      const workerInstance = trimText(req.header("x-adaceen-worker-id") || req.query.workerId) || DEFAULT_SCAN_WORKER_ID;
      const claimed = await database.pool.query<ProjectScanRequestRow>(
        `
        with candidate as (
          select id
          from project_scan_requests
          where repo_full_name = $1
            and status = 'pending'
          order by requested_at asc
          limit 1
          for update skip locked
        )
        update project_scan_requests req
        set
          status = 'claimed',
          claimed_at = now(),
          updated_at = now(),
          worker_instance = $2,
          error_message = ''
        from candidate
        where req.id = candidate.id
        returning
          req.id,
          req.repo_full_name,
          req.status,
          req.requested_by_user_id,
          req.requested_session_id,
          req.worker_instance,
          req.error_message,
          req.snapshot_id,
          req.requested_at,
          req.claimed_at,
          req.completed_at,
          req.updated_at
        `,
        [repoFullName, workerInstance],
      );

      return res.json({
        ok: true,
        request: mapProjectScanRequestRow(claimed.rows[0]),
      });
    } catch (error) {
      return res.status(500).json({ ok: false, error: String(error) });
    }
  });

  app.get("/api/projects/scan/request/:requestId", async (req, res) => {
    try {
      const session = await resolveSession(database, req);
      if (!session) {
        return res.status(401).json({ ok: false, error: "Sesion no valida." });
      }

      const requestId = trimText(req.params.requestId);
      if (!requestId) {
        return res.status(400).json({ ok: false, error: "requestId requerido." });
      }

      const found = await database.pool.query<ProjectScanRequestRow>(
        `
        select
          id,
          repo_full_name,
          status,
          requested_by_user_id,
          requested_session_id,
          worker_instance,
          error_message,
          snapshot_id,
          requested_at,
          claimed_at,
          completed_at,
          updated_at
        from project_scan_requests
        where id = $1
          and requested_by_user_id = $2
        limit 1
        `,
        [requestId, session.user.id],
      );

      if (!found.rows[0]) {
        return res.status(404).json({ ok: false, error: "Solicitud no encontrada." });
      }

      let snapshot: {
        id: string;
        repoFullName: string;
        source: string;
        totalFiles: number;
        skippedBySize: number;
        totalBytes: number;
        storagePath: string;
        createdAt: string | null;
      } | null = null;

      const snapshotId = trimText(found.rows[0].snapshot_id);
      if (snapshotId) {
        const snapshotResult = await database.pool.query<ProjectScanSnapshotRow>(
          `
          select
            id,
            request_id,
            repo_full_name,
            source,
            total_files,
            skipped_by_size,
            total_bytes,
            storage_path,
            created_at
          from project_scan_snapshots
          where id = $1
          limit 1
          `,
          [snapshotId],
        );
        const snapshotRow = snapshotResult.rows[0];
        if (snapshotRow) {
          snapshot = {
            id: snapshotRow.id,
            repoFullName: snapshotRow.repo_full_name,
            source: snapshotRow.source,
            totalFiles: snapshotRow.total_files,
            skippedBySize: snapshotRow.skipped_by_size,
            totalBytes: Number(snapshotRow.total_bytes) || 0,
            storagePath: snapshotRow.storage_path,
            createdAt: toIso(snapshotRow.created_at),
          };
        }
      }

      return res.json({
        ok: true,
        request: mapProjectScanRequestRow(found.rows[0]),
        snapshot,
      });
    } catch (error) {
      return res.status(500).json({ ok: false, error: String(error) });
    }
  });

  app.post("/api/projects/scan/request/:requestId/result", async (req, res) => {
    try {
      if (!ensureWorkerAuthorized(req)) {
        return res.status(401).json({ ok: false, error: "Worker no autorizado." });
      }

      const requestId = trimText(req.params.requestId);
      if (!requestId) {
        return res.status(400).json({ ok: false, error: "requestId requerido." });
      }

      const parsed = projectScanWorkerResultSchema.parse(req.body || {});
      const repoFullName = normalizeRepoFullName(parsed.repoFullName);
      if (!repoFullName) {
        return res.status(400).json({ ok: false, error: "repoFullName invalido." });
      }

      const requestResult = await database.pool.query<ProjectScanRequestRow>(
        `
        select
          id,
          repo_full_name,
          status,
          requested_by_user_id,
          requested_session_id,
          worker_instance,
          error_message,
          snapshot_id,
          requested_at,
          claimed_at,
          completed_at,
          updated_at
        from project_scan_requests
        where id = $1
        limit 1
        `,
        [requestId],
      );

      const requestRow = requestResult.rows[0];
      if (!requestRow) {
        return res.status(404).json({ ok: false, error: "Solicitud no encontrada." });
      }
      if (normalizeRepoFullName(requestRow.repo_full_name) !== repoFullName) {
        return res.status(400).json({ ok: false, error: "El repo del resultado no coincide con la solicitud." });
      }
      if (requestRow.status === PROJECT_SCAN_REQUEST_STATUSES.completed) {
        return res.json({
          ok: true,
          request: mapProjectScanRequestRow(requestRow),
          alreadyCompleted: true,
        });
      }

      const storage = buildScanStoragePath(repoFullName, requestId);
      await fsp.mkdir(path.dirname(storage.absolutePath), { recursive: true });
      const payloadToStore = {
        requestId,
        receivedAt: new Date().toISOString(),
        payload: parsed,
      };
      await fsp.writeFile(storage.absolutePath, JSON.stringify(payloadToStore, null, 2), "utf8");

      const snapshotId = randomUUID();
      const totalBytes = parsed.files.reduce((acc, file) => acc + Math.max(0, Number(file.bytes) || 0), 0);
      const skippedBySize = Math.max(0, Number(parsed.skippedBySize) || 0);

      await database.pool.query("begin");
      try {
        await database.pool.query(
          `
          insert into project_scan_snapshots (
            id,
            request_id,
            repo_full_name,
            source,
            runtime,
            mode,
            workspace_folders,
            selected_folders,
            total_files,
            skipped_by_size,
            total_bytes,
            storage_path
          )
          values (
            $1,
            $2,
            $3,
            'vscode_extension',
            $4::jsonb,
            $5::jsonb,
            $6::jsonb,
            $7::jsonb,
            $8,
            $9,
            $10,
            $11
          )
          `,
          [
            snapshotId,
            requestId,
            repoFullName,
            JSON.stringify(parsed.runtime || {}),
            JSON.stringify(parsed.mode || {}),
            JSON.stringify(parsed.workspaceFolders || []),
            JSON.stringify(parsed.selectedFolders || []),
            parsed.totalFiles,
            skippedBySize,
            totalBytes,
            storage.absolutePath,
          ],
        );

        for (const file of parsed.files) {
          const filePath = trimText(file.path);
          const extension = path.extname(filePath).replace(/^\./, "").toLowerCase();
          const contentHash = createHash("sha256").update(file.content).digest("hex");
          await database.pool.query(
            `
            insert into project_scan_snapshot_files (
              id,
              snapshot_id,
              path,
              bytes,
              lines,
              preview,
              extension,
              content_sha256
            )
            values ($1, $2, $3, $4, $5, $6, $7, $8)
            `,
            [
              randomUUID(),
              snapshotId,
              filePath,
              Math.max(0, Number(file.bytes) || 0),
              Math.max(0, Number(file.lines) || 0),
              trimText(file.preview),
              extension,
              contentHash,
            ],
          );
        }

        await database.pool.query(
          `
          update project_scan_requests
          set
            status = 'completed',
            completed_at = now(),
            updated_at = now(),
            snapshot_id = $2,
            error_message = ''
          where id = $1
          `,
          [requestId, snapshotId],
        );

        await database.pool.query("commit");
      } catch (error) {
        await database.pool.query("rollback");
        throw error;
      }

      return res.json({
        ok: true,
        snapshotId,
        storagePath: storage.absolutePath,
        request: {
          id: requestId,
          repoFullName,
          status: PROJECT_SCAN_REQUEST_STATUSES.completed,
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

  app.post("/api/projects/scan/request/:requestId/fail", async (req, res) => {
    try {
      if (!ensureWorkerAuthorized(req)) {
        return res.status(401).json({ ok: false, error: "Worker no autorizado." });
      }

      const requestId = trimText(req.params.requestId);
      if (!requestId) {
        return res.status(400).json({ ok: false, error: "requestId requerido." });
      }

      const parsed = projectScanWorkerFailSchema.parse(req.body || {});
      const errorMessage = trimText(parsed.error).slice(0, 1200);

      const result = await database.pool.query<ProjectScanRequestRow>(
        `
        update project_scan_requests
        set
          status = 'failed',
          updated_at = now(),
          completed_at = now(),
          error_message = $2
        where id = $1
        returning
          id,
          repo_full_name,
          status,
          requested_by_user_id,
          requested_session_id,
          worker_instance,
          error_message,
          snapshot_id,
          requested_at,
          claimed_at,
          completed_at,
          updated_at
        `,
        [requestId, errorMessage],
      );

      if (!result.rows[0]) {
        return res.status(404).json({ ok: false, error: "Solicitud no encontrada." });
      }

      return res.json({
        ok: true,
        request: mapProjectScanRequestRow(result.rows[0]),
      });
    } catch (error) {
      if (error instanceof z.ZodError) {
        const message = error.issues.map((issue) => issue.message).join("; ");
        return res.status(400).json({ ok: false, error: message });
      }
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

      let bootstrapReady = persistedBootstrap?.isBootstrapped === true
        || sharedBootstrap?.isBootstrapped === true;
      let bootstrapSource = persistedBootstrap?.source
        || (sharedBootstrap?.isBootstrapped ? "repo_shared" : "")
        || sharedBootstrap?.source
        || "";
      let bootstrapUpdatedAt = persistedBootstrap?.updatedAt || sharedBootstrap?.updatedAt || null;
      let bootstrapDetails = persistedBootstrap?.details || sharedBootstrap?.details || "";
      let bootstrapSignals: Record<string, unknown> | null = null;

      if (config.configured && installationToken && repoFullName && hasRepoAccess === true && !bootstrapReady) {
        try {
          const existingBootstrapPr = await findLatestBootstrapPullRequest({
            installationToken,
            repoFullName,
          });

          if (existingBootstrapPr) {
            const detailsParts = [
              existingBootstrapPr.pullUrl ? `pullUrl=${existingBootstrapPr.pullUrl}` : "",
              existingBootstrapPr.pullNumber > 0 ? `pullNumber=${existingBootstrapPr.pullNumber}` : "",
              existingBootstrapPr.state ? `prState=${existingBootstrapPr.state}` : "",
            ].filter(Boolean);

            const nextState = await database.upsertGithubRepoBootstrapState({
              userId: session.user.id,
              repoFullName,
              isBootstrapped: true,
              source: "repo_pr_detected",
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
          redirectTo: shouldRedirectToDashboard ? DASHBOARD_ROUTE : null,
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
      if (!forceBootstrap && persistedBootstrap?.isBootstrapped) {
        const pullUrl = extractBootstrapDetailValue(persistedBootstrap.details, "pullUrl") || null;
        const pullNumberRaw = extractBootstrapDetailValue(persistedBootstrap.details, "pullNumber");
        const pullNumber = Number.isFinite(Number(pullNumberRaw))
          ? Math.max(0, Number(pullNumberRaw))
          : null;

        return res.json({
          ok: true,
          alreadyBootstrapped: true,
          redirectTo: DASHBOARD_ROUTE,
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
              redirectTo: DASHBOARD_ROUTE,
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
            redirectTo: DASHBOARD_ROUTE,
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

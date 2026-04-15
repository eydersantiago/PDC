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
import { verifyGoogleUserFromIdToken } from "../services/google-auth.js";
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

const googleLoginSchema = z.object({
  idToken: z.string().min(20).optional(),
  credential: z.string().min(20).optional(),
}).refine((input) => Boolean(input.idToken || input.credential), {
  message: "idToken o credential es requerido.",
});

const adminManagedUserRoleSchema = z.enum(["student", "teacher"]);

const adminCreateUserSchema = z.object({
  role: adminManagedUserRoleSchema,
  email: z.string().email(),
  displayName: z.string().min(2).max(120),
  password: z.string().min(6).max(120),
  teacherUserId: z.string().max(120).nullable().optional(),
}).strict();

const adminUpdateUserSchema = z.object({
  role: adminManagedUserRoleSchema.optional(),
  email: z.string().email().optional(),
  displayName: z.string().min(2).max(120).optional(),
  password: z.string().min(6).max(120).optional(),
  teacherUserId: z.string().max(120).nullable().optional(),
  isActive: z.boolean().optional(),
}).strict();

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

const projectContextQuerySchema = z.object({
  repoFullName: z.string().min(3).max(240),
}).strict();

const projectContextHistoryQuerySchema = z.object({
  repoFullName: z.string().min(3).max(240),
  limit: z.coerce.number().int().min(1).max(50).optional(),
}).strict();

const projectContextRebuildSchema = z.object({
  repoFullName: z.string().min(3).max(240),
  requestId: z.string().max(120).optional(),
}).strict();

const projectContextInsightQuerySchema = z.object({
  repoFullName: z.string().min(3).max(240),
  useModel: z.preprocess((value) => {
    const text = trimText(value).toLowerCase();
    if (!text) return undefined;
    if (["1", "true", "yes", "on"].includes(text)) return true;
    if (["0", "false", "no", "off"].includes(text)) return false;
    return value;
  }, z.boolean().optional()),
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

type ProjectContextHistoryRow = {
  request_id: string;
  repo_full_name: string;
  status: ProjectScanRequestStatus;
  requested_at: string | Date;
  completed_at: string | Date | null;
  updated_at: string | Date;
  worker_instance: string;
  error_message: string;
  snapshot_id: string;
  snapshot_source: string | null;
  snapshot_total_files: number | null;
  snapshot_total_bytes: string | number | null;
  snapshot_storage_path: string | null;
  snapshot_created_at: string | Date | null;
};

type ProjectContextInsightSnapshotRow = {
  request_id: string;
  request_status: ProjectScanRequestStatus;
  request_completed_at: string | Date | null;
  request_updated_at: string | Date;
  snapshot_id: string;
  repo_full_name: string;
  source: string;
  total_files: number;
  skipped_by_size: number;
  total_bytes: string | number;
  storage_path: string;
  created_at: string | Date;
};

type ProjectScanStoredFile = {
  path: string;
  bytes: number;
  lines: number;
  preview?: string;
  content: string;
};

type ProjectScanStoredPayload = {
  requestId?: string;
  receivedAt?: string;
  payload?: {
    repoFullName?: string;
    totalFiles?: number;
    skippedBySize?: number;
    files?: ProjectScanStoredFile[];
  };
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

function extractBootstrapDetailValue(details: string, key: string) {
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

function shouldTrustPersistedBootstrapState(source: string, details: string) {
  const cleanSource = trimText(source).toLowerCase();
  if (!cleanSource) return false;

  if (cleanSource === "repo_pr_detected") {
    const prState = trimText(extractBootstrapDetailValue(details, "prState")).toLowerCase();
    const mergedAt = trimText(extractBootstrapDetailValue(details, "mergedAt"));
    if (prState === "open") return true;
    if (prState === "closed" && !!mergedAt) return true;
    return false;
  }

  return true;
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

function buildScanStoragePath(repoFullName: string, requestId: string, requestedByUserId?: string | null) {
  const scansRoot = env.projectScansDir
    ? path.resolve(env.projectScansDir)
    : path.join(process.cwd(), "data", "project-scans");
  const repoFolder = sanitizePathSegment(repoFullName.replace("/", "__"));
  const userFolder = sanitizePathSegment(requestedByUserId || "shared");
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const fileName = `${stamp}-${sanitizePathSegment(requestId)}.json`;
  return {
    scansRoot,
    absolutePath: path.join(scansRoot, repoFolder, userFolder, fileName),
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

function mapProjectScanSnapshotRow(row: ProjectScanSnapshotRow | undefined | null) {
  if (!row) return null;
  return {
    id: row.id,
    repoFullName: row.repo_full_name,
    source: row.source,
    totalFiles: row.total_files,
    skippedBySize: row.skipped_by_size,
    totalBytes: Number(row.total_bytes) || 0,
    storagePath: row.storage_path,
    createdAt: toIso(row.created_at),
  };
}

function mapProjectContextHistoryRow(row: ProjectContextHistoryRow) {
  const snapshotId = row.snapshot_id || "";
  const requestId = row.request_id;
  const updatedAt = toIso(row.completed_at) || toIso(row.updated_at);
  const source = row.snapshot_source || row.worker_instance || "vscode_extension";
  const version = snapshotId
    ? `${source}:${snapshotId.slice(0, 8)}`
    : `${source}:${requestId.slice(0, 8)}`;
  return {
    request: {
      id: requestId,
      repoFullName: row.repo_full_name,
      status: row.status,
      workerInstance: row.worker_instance,
      errorMessage: row.error_message,
      snapshotId,
      requestedAt: toIso(row.requested_at),
      completedAt: toIso(row.completed_at),
      updatedAt: toIso(row.updated_at),
    },
    snapshot: snapshotId
      ? {
        id: snapshotId,
        source,
        totalFiles: Number(row.snapshot_total_files) || 0,
        totalBytes: Number(row.snapshot_total_bytes) || 0,
        storagePath: row.snapshot_storage_path || "",
        createdAt: toIso(row.snapshot_created_at),
      }
      : null,
    requestId,
    snapshotId,
    status: row.status,
    updatedAt,
    source,
    version,
    summary: snapshotId
      ? `Snapshot ${snapshotId.slice(0, 8)} | ${Number(row.snapshot_total_files) || 0} archivos`
      : `Request ${requestId.slice(0, 8)}`,
    canRebuild: Boolean(snapshotId),
  };
}

type MainFileCandidate = {
  path: string;
  score: number;
  reason: string;
  lines: number;
  bytes: number;
};

function normalizeRepoPath(value: string) {
  return trimText(value)
    .replace(/\\/g, "/")
    .replace(/^\/+/, "")
    .toLowerCase();
}

function truncateText(value: string, max = 280) {
  const text = trimText(value);
  if (!text) return "";
  if (text.length <= max) return text;
  return `${text.slice(0, Math.max(0, max - 3))}...`;
}

async function readStoredProjectScanPayload(storagePath: string) {
  const absolutePath = path.resolve(trimText(storagePath));
  if (!absolutePath) return null;
  const raw = await fsp.readFile(absolutePath, "utf8");
  const parsed = JSON.parse(raw) as ProjectScanStoredPayload;
  if (!parsed || typeof parsed !== "object") return null;
  return parsed;
}

function normalizeStoredScanFiles(rawFiles: unknown): ProjectScanStoredFile[] {
  if (!Array.isArray(rawFiles)) return [];
  const output: ProjectScanStoredFile[] = [];

  for (const item of rawFiles) {
    if (!item || typeof item !== "object") continue;
    const row = item as Record<string, unknown>;
    const filePath = trimText(row.path);
    if (!filePath) continue;
    output.push({
      path: filePath,
      bytes: Math.max(0, Number(row.bytes) || 0),
      lines: Math.max(0, Number(row.lines) || 0),
      preview: trimText(row.preview),
      content: String(row.content || ""),
    });
  }

  return output;
}

function scoreMainFileCandidate(file: ProjectScanStoredFile): MainFileCandidate {
  const normalizedPath = normalizeRepoPath(file.path);
  const baseName = path.posix.basename(normalizedPath);
  const content = String(file.content || "");
  let score = 0;
  const reasons: string[] = [];

  const strongEntryNames = new Set([
    "manage.py",
    "main.py",
    "app.py",
    "server.py",
    "main.ts",
    "main.js",
    "index.ts",
    "index.js",
    "server.ts",
    "server.js",
    "program.cs",
    "main.go",
  ]);
  if (strongEntryNames.has(baseName)) {
    score += 160;
    reasons.push("nombre típico de archivo de entrada");
  }

  if (normalizedPath.includes("src/main.") || normalizedPath.includes("src/index.")) {
    score += 95;
    reasons.push("ubicación típica de arranque en src");
  }

  if (/(^|\/)finagent\/urls\.py$/.test(normalizedPath) || /(^|\/)core\/urls\.py$/.test(normalizedPath)) {
    score += 65;
    reasons.push("archivo de ruteo principal detectado");
  }

  if (/(^|\/)(test|tests|__tests__|spec|specs|migrations|node_modules|dist|build|coverage)\//.test(normalizedPath)
    || /\.(test|spec)\.[a-z0-9]+$/i.test(baseName)) {
    score -= 150;
    reasons.push("parece archivo auxiliar de test/build");
  }

  if (normalizedPath.includes(".devcontainer/")) {
    score -= 90;
    reasons.push("archivo de infraestructura, no de ejecución");
  }

  if (/if __name__\s*==\s*['"]__main__['"]/.test(content)) {
    score += 120;
    reasons.push("contiene punto de entrada __main__");
  }
  if (/\bexpress\s*\(/i.test(content) || /\bapp\.listen\s*\(/i.test(content)) {
    score += 95;
    reasons.push("arranque de servidor web detectado");
  }
  if (/\bFastAPI\s*\(/.test(content) || /\bFlask\s*\(/.test(content)) {
    score += 95;
    reasons.push("arranque de API detectado");
  }
  if (/\burlpatterns\s*=/.test(content)) {
    score += 55;
    reasons.push("define rutas principales");
  }
  if (/django\.core\.management/.test(content) || /execute_from_command_line/.test(content)) {
    score += 120;
    reasons.push("script de ejecución de Django detectado");
  }

  score += Math.min(32, Math.floor((Number(file.lines) || 0) / 12));

  if (score <= 0 && reasons.length === 0) {
    reasons.push("candidato por estructura del repositorio");
  }

  return {
    path: file.path,
    score,
    reason: reasons.slice(0, 3).join("; "),
    lines: Math.max(0, Number(file.lines) || 0),
    bytes: Math.max(0, Number(file.bytes) || 0),
  };
}

function detectMainFileByHeuristic(files: ProjectScanStoredFile[]) {
  const candidates = files
    .map(scoreMainFileCandidate)
    .sort((a, b) => b.score - a.score || b.lines - a.lines || a.path.localeCompare(b.path))
    .slice(0, 8);
  const best = candidates[0] || null;

  return {
    mainFilePath: best?.path || "",
    mainFileReason: best?.reason || "",
    candidates: candidates.slice(0, 5),
  };
}

function resolveMainFilePath(rawPath: string, files: ProjectScanStoredFile[]) {
  const wanted = normalizeRepoPath(rawPath);
  if (!wanted) return "";
  const byPath = files.find((file) => normalizeRepoPath(file.path) === wanted);
  if (byPath) return byPath.path;

  const byBaseName = files.filter((file) => path.posix.basename(normalizeRepoPath(file.path)) === path.posix.basename(wanted));
  if (byBaseName.length === 1) return byBaseName[0].path;
  return "";
}

function parseModelInsight(rawOutput: string) {
  const direct = trimText(rawOutput);
  if (!direct) return null;

  const candidates = [direct];
  const start = direct.indexOf("{");
  const end = direct.lastIndexOf("}");
  if (start >= 0 && end > start) {
    candidates.push(direct.slice(start, end + 1));
  }

  for (const candidate of candidates) {
    try {
      const parsed = JSON.parse(candidate) as Record<string, unknown>;
      if (!parsed || typeof parsed !== "object") continue;
      return {
        summary: truncateText(String(parsed.summary || ""), 900),
        mainFilePath: trimText(parsed.mainFilePath),
        mainFileReason: truncateText(String(parsed.mainFileReason || parsed.reason || ""), 320),
        autoAdvice: truncateText(String(parsed.autoAdvice || parsed.advice || ""), 420),
      };
    } catch {}
  }

  return null;
}

function buildProjectInsightPrompt(params: {
  repoFullName: string;
  version: string;
  files: ProjectScanStoredFile[];
  heuristicMainFilePath: string;
  heuristicReason: string;
  candidates: MainFileCandidate[];
}) {
  const byNormalizedPath = new Map<string, ProjectScanStoredFile>();
  for (const file of params.files) {
    byNormalizedPath.set(normalizeRepoPath(file.path), file);
  }

  const selectedPaths = [
    ...params.candidates.map((item) => item.path),
    ...params.files.slice(0, 12).map((item) => item.path),
  ]
    .map((item) => normalizeRepoPath(item))
    .filter(Boolean)
    .filter((item, index, array) => array.indexOf(item) === index)
    .slice(0, 12);

  const fileBlocks = selectedPaths.map((normalizedPath, index) => {
    const file = byNormalizedPath.get(normalizedPath);
    if (!file) return "";
    const preview = truncateText(file.preview || file.content || "", 320);
    const contentSnippet = truncateText(file.content || "", 900);
    return [
      `# Archivo ${index + 1}`,
      `path: ${file.path}`,
      `lines: ${file.lines}`,
      `bytes: ${file.bytes}`,
      `preview: ${preview || "(sin preview)"}`,
      "snippet:",
      contentSnippet || "(sin contenido)",
      "",
    ].join("\n");
  }).filter(Boolean);

  const candidateLines = params.candidates.length > 0
    ? params.candidates.map((item, index) => `${index + 1}. ${item.path} | score=${item.score} | ${item.reason}`).join("\n")
    : "1. (sin candidatos)";

  return [
    "Eres un analista técnico de repositorios para un dashboard educativo.",
    "Debes devolver SOLO un JSON válido (sin markdown) con este formato exacto:",
    "{\"summary\":\"...\",\"mainFilePath\":\"...\",\"mainFileReason\":\"...\",\"autoAdvice\":\"...\"}",
    "Reglas:",
    "- summary: máximo 3 frases cortas, explica de qué trata el proyecto.",
    "- mainFilePath: ruta exacta de archivo dentro del repositorio.",
    "- mainFileReason: por qué ese archivo es el principal.",
    "- autoAdvice: consejo concreto y corto para el estudiante en ese archivo.",
    "- Si no estás seguro de la ruta principal, usa el candidato más probable.",
    "",
    `repo: ${params.repoFullName}`,
    `version: ${params.version || "sin_version"}`,
    `heuristicMainFile: ${params.heuristicMainFilePath || "(sin detectar)"}`,
    `heuristicReason: ${params.heuristicReason || "(sin razon)"}`,
    "",
    "Top candidatos heurísticos:",
    candidateLines,
    "",
    "Archivos y fragmentos:",
    fileBlocks.join("\n"),
  ].join("\n");
}

function buildFallbackInsight(params: {
  repoFullName: string;
  version: string;
  mainFilePath: string;
  mainFileReason: string;
  totalFiles: number;
}) {
  const mainFile = params.mainFilePath || "(sin detectar)";
  const reason = params.mainFileReason || "candidato estimado por estructura y contenido";
  return {
    summary: `Repositorio ${params.repoFullName} con ${params.totalFiles} archivo(s) escaneado(s). Version activa: ${params.version || "sin_version"}.`,
    mainFilePath: mainFile,
    mainFileReason: reason,
    autoAdvice: params.mainFilePath
      ? `Empieza por ${params.mainFilePath}: valida flujo de entrada, rutas y dependencias principales antes de cambios grandes.`
      : "Primero abre el archivo de entrada del proyecto y valida qué ruta o función inicia la ejecución.",
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
      google_auth_configured: Boolean(env.googleClientId),
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

  app.post("/api/auth/google-login", async (req, res) => {
    try {
      if (!env.googleClientId) {
        return res.status(503).json({ ok: false, error: "Login con Google no configurado en servidor." });
      }
      if (!env.googleDefaultPassword) {
        return res.status(503).json({ ok: false, error: "GOOGLE_DEFAULT_PASSWORD no configurado en servidor." });
      }

      const parsed = googleLoginSchema.parse(req.body || {});
      const rawIdToken = trimText(parsed.idToken || parsed.credential);
      if (!rawIdToken) {
        return res.status(400).json({ ok: false, error: "idToken requerido." });
      }

      const googleUser = await verifyGoogleUserFromIdToken(rawIdToken);
      const session = await database.authenticateGoogleUser({
        email: googleUser.email,
        displayName: googleUser.displayName,
        defaultPassword: env.googleDefaultPassword,
      });

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

  app.get("/api/admin/users", async (req, res) => {
    try {
      const session = await resolveSession(database, req);
      if (!session || session.user.role !== "admin") {
        return res.status(403).json({ ok: false, error: "Solo el administrador puede gestionar usuarios." });
      }

      const managed = await database.listManagedUsers();
      return res.json({
        ok: true,
        users: managed.users,
        teachers: managed.teachers,
      });
    } catch (error) {
      return res.status(500).json({ ok: false, error: String(error) });
    }
  });

  app.post("/api/admin/users", async (req, res) => {
    try {
      const session = await resolveSession(database, req);
      if (!session || session.user.role !== "admin") {
        return res.status(403).json({ ok: false, error: "Solo el administrador puede crear usuarios." });
      }

      const parsed = adminCreateUserSchema.parse(req.body || {});
      const createdUser = await database.createManagedUser(parsed);
      return res.json({ ok: true, user: createdUser });
    } catch (error) {
      const message = error instanceof z.ZodError
        ? error.issues.map((issue) => issue.message).join("; ")
        : String(error);
      return res.status(400).json({ ok: false, error: message });
    }
  });

  app.put("/api/admin/users/:userId", async (req, res) => {
    try {
      const session = await resolveSession(database, req);
      if (!session || session.user.role !== "admin") {
        return res.status(403).json({ ok: false, error: "Solo el administrador puede editar usuarios." });
      }

      const userId = trimText(req.params.userId);
      if (!userId) {
        return res.status(400).json({ ok: false, error: "userId requerido." });
      }

      const parsed = adminUpdateUserSchema.parse(req.body || {});
      const updatedUser = await database.updateManagedUser(userId, parsed);
      return res.json({ ok: true, user: updatedUser });
    } catch (error) {
      const message = error instanceof z.ZodError
        ? error.issues.map((issue) => issue.message).join("; ")
        : String(error);
      return res.status(400).json({ ok: false, error: message });
    }
  });

  app.delete("/api/admin/users/:userId", async (req, res) => {
    try {
      const session = await resolveSession(database, req);
      if (!session || session.user.role !== "admin") {
        return res.status(403).json({ ok: false, error: "Solo el administrador puede eliminar usuarios." });
      }

      const userId = trimText(req.params.userId);
      if (!userId) {
        return res.status(400).json({ ok: false, error: "userId requerido." });
      }

      const deactivatedUser = await database.deactivateManagedUser(userId);
      return res.json({ ok: true, user: deactivatedUser });
    } catch (error) {
      return res.status(400).json({ ok: false, error: String(error) });
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

      let snapshot: ReturnType<typeof mapProjectScanSnapshotRow> = null;

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
        snapshot = mapProjectScanSnapshotRow(snapshotResult.rows[0]);
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

  app.get("/api/projects/context/status", async (req, res) => {
    try {
      const session = await resolveSession(database, req);
      if (!session) {
        return res.status(401).json({ ok: false, error: "Sesion no valida." });
      }

      const parsed = projectContextQuerySchema.parse(req.query || {});
      const repoFullName = normalizeRepoFullName(parsed.repoFullName);
      if (!repoFullName) {
        return res.status(400).json({ ok: false, error: "repoFullName invalido. Usa owner/repo." });
      }

      const latestRequestResult = await database.pool.query<ProjectScanRequestRow>(
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
        order by requested_at desc
        limit 1
        `,
        [repoFullName, session.user.id],
      );

      const latestRequest = latestRequestResult.rows[0] || null;
      const latestSnapshotId = trimText(latestRequest?.snapshot_id);
      let latestSnapshot: ReturnType<typeof mapProjectScanSnapshotRow> = null;

      if (latestSnapshotId) {
        const latestSnapshotResult = await database.pool.query<ProjectScanSnapshotRow>(
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
          [latestSnapshotId],
        );
        latestSnapshot = mapProjectScanSnapshotRow(latestSnapshotResult.rows[0]);
      }

      const versionsCountResult = await database.pool.query<{ total: number | string }>(
        `
        select count(*)::int as total
        from project_scan_requests
        where repo_full_name = $1
          and requested_by_user_id = $2
          and status = 'completed'
          and snapshot_id <> ''
        `,
        [repoFullName, session.user.id],
      );

      const latestRebuildResult = await database.pool.query<ProjectScanRequestRow>(
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
          and worker_instance = 'manual_rebuild'
        order by completed_at desc nulls last, requested_at desc
        limit 1
        `,
        [repoFullName, session.user.id],
      );

      const versionsCount = Number(versionsCountResult.rows[0]?.total) || 0;
      const contextReady = latestRequest?.status === PROJECT_SCAN_REQUEST_STATUSES.completed
        && !!latestSnapshot;
      const latestRequestMapped = mapProjectScanRequestRow(latestRequest);
      const latestSnapshotMapped = latestSnapshot;
      const latestVersion = latestSnapshotMapped?.id
        ? `${latestSnapshotMapped.source}:${latestSnapshotMapped.id.slice(0, 8)}`
        : (latestRequestMapped?.id ? `request:${latestRequestMapped.id.slice(0, 8)}` : "");

      return res.json({
        ok: true,
        context: {
          configured: true,
          repoFullName,
          hasContext: contextReady,
          ready: contextReady,
          versionsCount,
          totalVersions: versionsCount,
          latestRequestId: latestRequestMapped?.id || "",
          latestSnapshotId: latestSnapshotMapped?.id || "",
          latestVersion,
          currentVersion: latestVersion,
          updatedAt: latestSnapshotMapped?.createdAt || latestRequestMapped?.updatedAt || null,
          source: latestSnapshotMapped?.source || latestRequestMapped?.workerInstance || "",
          requestStatus: latestRequestMapped?.status || "",
          summary: contextReady
            ? `Contexto disponible para ${repoFullName} (${latestVersion || "version actual"}).`
            : `Aun no hay contexto completado para ${repoFullName}.`,
          latestRequest: latestRequestMapped,
          latestSnapshot: latestSnapshotMapped,
          latestRebuild: mapProjectScanRequestRow(latestRebuildResult.rows[0]),
        },
      });
    } catch (error) {
      const message = error instanceof z.ZodError
        ? error.issues.map((issue) => issue.message).join("; ")
        : String(error);
      return res.status(400).json({ ok: false, error: message });
    }
  });

  app.get("/api/projects/context/history", async (req, res) => {
    try {
      const session = await resolveSession(database, req);
      if (!session) {
        return res.status(401).json({ ok: false, error: "Sesion no valida." });
      }

      const parsed = projectContextHistoryQuerySchema.parse(req.query || {});
      const repoFullName = normalizeRepoFullName(parsed.repoFullName);
      if (!repoFullName) {
        return res.status(400).json({ ok: false, error: "repoFullName invalido. Usa owner/repo." });
      }

      const limit = Math.max(1, Math.min(50, Number(parsed.limit) || 20));
      const historyResult = await database.pool.query<ProjectContextHistoryRow>(
        `
        select
          req.id as request_id,
          req.repo_full_name,
          req.status,
          req.requested_at,
          req.completed_at,
          req.updated_at,
          req.worker_instance,
          req.error_message,
          req.snapshot_id,
          snap.source as snapshot_source,
          snap.total_files as snapshot_total_files,
          snap.total_bytes as snapshot_total_bytes,
          snap.storage_path as snapshot_storage_path,
          snap.created_at as snapshot_created_at
        from project_scan_requests req
        left join project_scan_snapshots snap on snap.id = req.snapshot_id
        where req.repo_full_name = $1
          and req.requested_by_user_id = $2
          and req.status = 'completed'
          and req.snapshot_id <> ''
        order by req.completed_at desc nulls last, req.requested_at desc
        limit $3
        `,
        [repoFullName, session.user.id, limit],
      );

      return res.json({
        ok: true,
        repoFullName,
        versions: historyResult.rows.map(mapProjectContextHistoryRow),
      });
    } catch (error) {
      const message = error instanceof z.ZodError
        ? error.issues.map((issue) => issue.message).join("; ")
        : String(error);
      return res.status(400).json({ ok: false, error: message });
    }
  });

  app.get("/api/projects/context/insight", async (req, res) => {
    try {
      const session = await resolveSession(database, req);
      if (!session) {
        return res.status(401).json({ ok: false, error: "Sesion no valida." });
      }

      const parsed = projectContextInsightQuerySchema.parse(req.query || {});
      const repoFullName = normalizeRepoFullName(parsed.repoFullName);
      if (!repoFullName) {
        return res.status(400).json({ ok: false, error: "repoFullName invalido. Usa owner/repo." });
      }

      const useModel = parsed.useModel !== false;
      const latestSnapshotResult = await database.pool.query<ProjectContextInsightSnapshotRow>(
        `
        select
          req.id as request_id,
          req.status as request_status,
          req.completed_at as request_completed_at,
          req.updated_at as request_updated_at,
          snap.id as snapshot_id,
          snap.repo_full_name,
          snap.source,
          snap.total_files,
          snap.skipped_by_size,
          snap.total_bytes,
          snap.storage_path,
          snap.created_at
        from project_scan_requests req
        join project_scan_snapshots snap on snap.id = req.snapshot_id
        where req.repo_full_name = $1
          and req.requested_by_user_id = $2
          and req.status = 'completed'
          and req.snapshot_id <> ''
        order by req.completed_at desc nulls last, req.requested_at desc
        limit 1
        `,
        [repoFullName, session.user.id],
      );

      const snapshot = latestSnapshotResult.rows[0];
      if (!snapshot) {
        return res.json({
          ok: true,
          insight: {
            configured: true,
            repoFullName,
            hasContext: false,
            modelEnabled: useModel,
            modelUsed: false,
            summary: `Aun no existe un escaneo completo para ${repoFullName}.`,
            mainFilePath: "",
            mainFileReason: "",
            autoAdvice: "Pulsa Explorar proyecto para enviar archivos al backend.",
          },
        });
      }

      let files = [] as ProjectScanStoredFile[];
      let storageReadError = "";
      try {
        const storedPayload = await readStoredProjectScanPayload(snapshot.storage_path);
        files = normalizeStoredScanFiles(storedPayload?.payload?.files);
      } catch (error) {
        storageReadError = trimText(String(error));
      }

      if (files.length === 0) {
        const fallbackFilesResult = await database.pool.query<{
          path: string;
          bytes: number;
          lines: number;
          preview: string;
        }>(
          `
          select
            path,
            bytes,
            lines,
            preview
          from project_scan_snapshot_files
          where snapshot_id = $1
          order by lines desc, bytes desc
          limit 160
          `,
          [snapshot.snapshot_id],
        );

        files = fallbackFilesResult.rows
          .map((row) => ({
            path: trimText(row.path),
            bytes: Math.max(0, Number(row.bytes) || 0),
            lines: Math.max(0, Number(row.lines) || 0),
            preview: trimText(row.preview),
            content: trimText(row.preview),
          }))
          .filter((row) => !!row.path);
      }

      const version = snapshot.snapshot_id
        ? `${snapshot.source}:${snapshot.snapshot_id.slice(0, 8)}`
        : `request:${snapshot.request_id.slice(0, 8)}`;
      const heuristic = detectMainFileByHeuristic(files);
      let insight = buildFallbackInsight({
        repoFullName,
        version,
        mainFilePath: heuristic.mainFilePath,
        mainFileReason: heuristic.mainFileReason,
        totalFiles: Number(snapshot.total_files) || files.length,
      });
      let modelUsed = false;
      let modelError = "";

      if (useModel && files.length > 0) {
        try {
          const modelPrompt = buildProjectInsightPrompt({
            repoFullName,
            version,
            files,
            heuristicMainFilePath: heuristic.mainFilePath,
            heuristicReason: heuristic.mainFileReason,
            candidates: heuristic.candidates,
          });
          const modelRawOutput = await runTextByMode(modelPrompt);
          const modelInsight = parseModelInsight(modelRawOutput);
          if (modelInsight) {
            const modelMainFilePath = resolveMainFilePath(modelInsight.mainFilePath, files)
              || heuristic.mainFilePath;
            insight = {
              summary: modelInsight.summary || insight.summary,
              mainFilePath: modelMainFilePath,
              mainFileReason: modelInsight.mainFileReason || heuristic.mainFileReason || insight.mainFileReason,
              autoAdvice: modelInsight.autoAdvice || insight.autoAdvice,
            };
            modelUsed = true;
          } else {
            modelError = "El modelo no devolvio JSON valido para insight.";
          }
        } catch (error) {
          modelError = trimText(String(error));
        }
      }

      return res.json({
        ok: true,
        insight: {
          configured: true,
          repoFullName,
          hasContext: true,
          requestId: snapshot.request_id,
          snapshotId: snapshot.snapshot_id,
          version,
          currentVersion: version,
          source: snapshot.source,
          updatedAt: toIso(snapshot.created_at) || toIso(snapshot.request_completed_at) || toIso(snapshot.request_updated_at),
          totalFiles: Number(snapshot.total_files) || files.length,
          totalBytes: Number(snapshot.total_bytes) || 0,
          modelEnabled: useModel,
          modelUsed,
          modelProvider: env.targetMode === "azure" ? "azure_proxy" : "local_ollama",
          summary: insight.summary,
          mainFilePath: insight.mainFilePath,
          mainFileReason: insight.mainFileReason,
          autoAdvice: insight.autoAdvice,
          candidates: heuristic.candidates,
          storageReadError: storageReadError || null,
          modelError: modelError || null,
        },
      });
    } catch (error) {
      const message = error instanceof z.ZodError
        ? error.issues.map((issue) => issue.message).join("; ")
        : String(error);
      return res.status(400).json({ ok: false, error: message });
    }
  });

  app.post("/api/projects/context/rebuild", async (req, res) => {
    try {
      const session = await resolveSession(database, req);
      if (!session) {
        return res.status(401).json({ ok: false, error: "Sesion no valida." });
      }

      const parsed = projectContextRebuildSchema.parse(req.body || {});
      const repoFullName = normalizeRepoFullName(parsed.repoFullName);
      if (!repoFullName) {
        return res.status(400).json({ ok: false, error: "repoFullName invalido. Usa owner/repo." });
      }

      const requestedId = trimText(parsed.requestId);
      const sourceRequestResult = await database.pool.query<ProjectScanRequestRow>(
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
          and status = 'completed'
          and snapshot_id <> ''
          and ($3 = '' or id = $3)
        order by requested_at desc
        limit 1
        `,
        [repoFullName, session.user.id, requestedId],
      );

      const sourceRequest = sourceRequestResult.rows[0];
      if (!sourceRequest) {
        return res.status(404).json({
          ok: false,
          error: requestedId
            ? "No se encontro la version solicitada para aplicar rebuild."
            : "No hay versiones guardadas para este repositorio.",
        });
      }

      const sourceSnapshotId = trimText(sourceRequest.snapshot_id);
      if (!sourceSnapshotId) {
        return res.status(400).json({ ok: false, error: "La version origen no tiene snapshot asociado." });
      }

      const sourceSnapshotResult = await database.pool.query<ProjectScanSnapshotRow>(
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
        [sourceSnapshotId],
      );

      const sourceSnapshot = sourceSnapshotResult.rows[0];
      if (!sourceSnapshot) {
        return res.status(404).json({ ok: false, error: "Snapshot origen no encontrado." });
      }

      const rebuildRequestId = randomUUID();
      const rebuildResult = await database.pool.query<ProjectScanRequestRow>(
        `
        insert into project_scan_requests (
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
        )
        values (
          $1,
          $2,
          'completed',
          $3,
          $4,
          'manual_rebuild',
          $5,
          $6,
          now(),
          now(),
          now(),
          now()
        )
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
        [
          rebuildRequestId,
          repoFullName,
          session.user.id,
          session.id,
          `rebuild_from=${sourceRequest.id}`,
          sourceSnapshotId,
        ],
      );

      return res.json({
        ok: true,
        rebuild: {
          request: mapProjectScanRequestRow(rebuildResult.rows[0]),
          sourceRequest: mapProjectScanRequestRow(sourceRequest),
          snapshot: mapProjectScanSnapshotRow(sourceSnapshot),
        },
      });
    } catch (error) {
      const message = error instanceof z.ZodError
        ? error.issues.map((issue) => issue.message).join("; ")
        : String(error);
      return res.status(400).json({ ok: false, error: message });
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

      const storage = buildScanStoragePath(repoFullName, requestId, requestRow.requested_by_user_id);
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

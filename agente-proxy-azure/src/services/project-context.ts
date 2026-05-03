import fsp from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { env } from "../config/env.js";
import type { AppDatabase } from "../db/database.js";
import { trimText } from "./text-utils.js";

export const PROJECT_SCAN_REQUEST_STATUSES = {
  pending: "pending",
  claimed: "claimed",
  completed: "completed",
  failed: "failed",
} as const;

export type ProjectScanRequestStatus =
  typeof PROJECT_SCAN_REQUEST_STATUSES[keyof typeof PROJECT_SCAN_REQUEST_STATUSES];

export type ProjectScanRequestRow = {
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

export type ProjectScanSnapshotRow = {
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

export type ProjectContextHistoryRow = {
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

export type ProjectContextInsightSnapshotRow = {
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

export type ProjectScanStoredFile = {
  path: string;
  bytes: number;
  lines: number;
  preview?: string;
  content: string;
};

export type ProjectScreenshotCaptureEntry = {
  type?: string;
  name?: string;
  path?: string;
  level?: number;
};

export type ProjectScreenshotCaptureContext = {
  capturedAt?: string;
  overlayHidden?: boolean;
  viewport?: {
    width?: number;
    height?: number;
    offsetLeft?: number;
    offsetTop?: number;
    scrollX?: number;
    scrollY?: number;
    devicePixelRatio?: number;
  };
  url?: string;
  title?: string;
  pageContext?: string;
  pageType?: string;
  repoFullName?: string;
  branch?: string;
  filePath?: string;
  languageHint?: string;
  codespaceBreadcrumbs?: string[];
  codespaceActiveTabs?: string[];
  visibleError?: string;
  selection?: string;
  visibleText?: string;
  codeSnippet?: string;
  codeLineCount?: number;
  explorerEntries?: ProjectScreenshotCaptureEntry[];
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

export type MainFileCandidate = {
  path: string;
  score: number;
  reason: string;
  lines: number;
  bytes: number;
};

export function toIso(value: string | Date | null | undefined) {
  if (!value) return null;
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
}

export function normalizeRepoFullName(value: unknown) {
  const text = trimText(value).replace(/^https?:\/\/github\.com\//i, "").replace(/\.git$/i, "");
  const match = text.match(/^([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+)$/);
  if (!match) return "";
  return `${match[1]}/${match[2]}`.toLowerCase();
}

export function sanitizePathSegment(value: string) {
  const clean = trimText(value).toLowerCase();
  if (!clean) return "unknown";
  return clean.replace(/[^a-z0-9._-]+/g, "_").replace(/^_+|_+$/g, "").slice(0, 160) || "unknown";
}

function getProjectScansRoot() {
  return env.projectScansDir
    ? path.resolve(env.projectScansDir)
    : path.join(process.cwd(), "data", "project-scans");
}

function getProjectScreenshotsRoot() {
  return env.projectScreenshotsDir
    ? path.resolve(env.projectScreenshotsDir)
    : path.join(process.cwd(), "data", "project-screenshots");
}

export function buildScanStoragePath(repoFullName: string, requestId: string, requestedByUserId?: string | null) {
  const scansRoot = getProjectScansRoot();
  const repoFolder = sanitizePathSegment(repoFullName.replace("/", "__"));
  const userFolder = sanitizePathSegment(requestedByUserId || "shared");
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const fileName = `${stamp}-${sanitizePathSegment(requestId)}.json`;
  return {
    scansRoot,
    absolutePath: path.join(scansRoot, repoFolder, userFolder, fileName),
  };
}

export function buildScreenshotStoragePath(repoFullName: string, extension: string, requestedByUserId?: string | null) {
  const screenshotsRoot = getProjectScreenshotsRoot();
  const repoFolder = sanitizePathSegment(repoFullName.replace("/", "__"));
  const userFolder = sanitizePathSegment(requestedByUserId || "shared");
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const cleanExtension = sanitizePathSegment(extension).replace(/[^a-z0-9]/g, "") || "png";
  const fileName = `${stamp}-${randomUUID()}.${cleanExtension}`;
  const absolutePath = path.join(screenshotsRoot, repoFolder, userFolder, fileName);
  const relativePath = path.relative(process.cwd(), absolutePath).replace(/\\/g, "/");
  return {
    screenshotsRoot,
    absolutePath,
    relativePath,
  };
}

export function mapProjectScanRequestRow(row: ProjectScanRequestRow | undefined | null) {
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

export function mapProjectScanSnapshotRow(row: ProjectScanSnapshotRow | undefined | null) {
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

export function mapProjectContextHistoryRow(row: ProjectContextHistoryRow) {
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

export function buildSnapshotVersion(snapshot: Pick<ProjectContextInsightSnapshotRow, "snapshot_id" | "source" | "request_id">) {
  return snapshot.snapshot_id
    ? `${snapshot.source}:${snapshot.snapshot_id.slice(0, 8)}`
    : `request:${snapshot.request_id.slice(0, 8)}`;
}

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

  const scansRoot = getProjectScansRoot();
  const relativeToRoot = path.relative(scansRoot, absolutePath);
  if (
    relativeToRoot === ""
    || relativeToRoot === "."
    || relativeToRoot.startsWith("..")
    || path.isAbsolute(relativeToRoot)
  ) {
    throw new Error("Ruta de almacenamiento inválida.");
  }

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

export async function loadProjectScanFiles(
  database: AppDatabase,
  snapshotId: string,
  storagePath: string,
  fallbackLimit: number,
) {
  let files = [] as ProjectScanStoredFile[];
  let storageReadError = "";
  try {
    const storedPayload = await readStoredProjectScanPayload(storagePath);
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
      limit $2
      `,
      [snapshotId, fallbackLimit],
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

  return { files, storageReadError };
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
    reasons.push("nombre tipico de archivo de entrada");
  }

  if (normalizedPath.includes("src/main.") || normalizedPath.includes("src/index.")) {
    score += 95;
    reasons.push("ubicacion tipica de arranque en src");
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
    reasons.push("archivo de infraestructura, no de ejecucion");
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
    reasons.push("script de ejecucion de Django detectado");
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

export function detectMainFileByHeuristic(files: ProjectScanStoredFile[]) {
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

export function resolveMainFilePath(rawPath: string, files: ProjectScanStoredFile[]) {
  const wanted = normalizeRepoPath(rawPath);
  if (!wanted) return "";
  const byPath = files.find((file) => normalizeRepoPath(file.path) === wanted);
  if (byPath) return byPath.path;

  const bySuffix = files.filter((file) => {
    const candidate = normalizeRepoPath(file.path);
    return wanted.endsWith(`/${candidate}`) || candidate.endsWith(`/${wanted}`);
  });
  if (bySuffix.length === 1) return bySuffix[0].path;

  const byBaseName = files.filter((file) => path.posix.basename(normalizeRepoPath(file.path)) === path.posix.basename(wanted));
  if (byBaseName.length === 1) return byBaseName[0].path;
  return "";
}

function extractModelJsonObject(rawOutput: string) {
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
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) continue;
      return parsed;
    } catch {}
  }

  return null;
}

export function parseModelInsight(rawOutput: string) {
  const parsed = extractModelJsonObject(rawOutput);
  if (!parsed) return null;
  return {
    summary: truncateText(String(parsed.summary || ""), 900),
    mainFilePath: trimText(parsed.mainFilePath),
    mainFileReason: truncateText(String(parsed.mainFileReason || parsed.reason || ""), 320),
    autoAdvice: truncateText(String(parsed.autoAdvice || parsed.advice || ""), 420),
  };
}

export function parseScreenshotModelInsight(rawOutput: string) {
  const parsed = extractModelJsonObject(rawOutput);
  if (!parsed) return null;

  const rawConfidence = Number(parsed.confidence ?? parsed.mainFileConfidence ?? 0);
  const normalizedConfidence = Number.isFinite(rawConfidence)
    ? Math.max(0, Math.min(100, Math.round(rawConfidence)))
    : 0;

  return {
    summary: truncateText(String(parsed.summary || ""), 900),
    mainFilePath: trimText(parsed.mainFilePath || parsed.main_file_path || parsed.filePath || ""),
    mainFileReason: truncateText(String(parsed.mainFileReason || parsed.reason || ""), 380),
    autoAdvice: truncateText(String(parsed.autoAdvice || parsed.advice || ""), 420),
    ocrText: truncateText(String(parsed.ocrText || parsed.visibleText || parsed.text || ""), 1800),
    confidence: normalizedConfidence,
  };
}

export function buildProjectInsightPrompt(params: {
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
    "Eres un analista tecnico de repositorios para un dashboard educativo.",
    "Debes devolver SOLO un JSON valido (sin markdown) con este formato exacto:",
    "{\"summary\":\"...\",\"mainFilePath\":\"...\",\"mainFileReason\":\"...\",\"autoAdvice\":\"...\"}",
    "Reglas:",
    "- summary: maximo 3 frases cortas, explica de que trata el proyecto.",
    "- mainFilePath: ruta exacta de archivo dentro del repositorio.",
    "- mainFileReason: por que ese archivo es el principal.",
    "- autoAdvice: consejo concreto y corto para el estudiante en ese archivo.",
    "- Si no estas seguro de la ruta principal, usa el candidato mas probable.",
    "",
    `repo: ${params.repoFullName}`,
    `version: ${params.version || "sin_version"}`,
    `heuristicMainFile: ${params.heuristicMainFilePath || "(sin detectar)"}`,
    `heuristicReason: ${params.heuristicReason || "(sin razon)"}`,
    "",
    "Top candidatos heuristicos:",
    candidateLines,
    "",
    "Archivos y fragmentos:",
    fileBlocks.join("\n"),
  ].join("\n");
}

export function buildProjectScreenshotInsightPrompt(params: {
  repoFullName: string;
  version: string;
  files: ProjectScanStoredFile[];
  heuristicMainFilePath: string;
  heuristicReason: string;
  candidates: MainFileCandidate[];
  captureContext?: ProjectScreenshotCaptureContext;
}) {
  const pathList = params.files
    .map((file) => trimText(file.path))
    .filter(Boolean)
    .slice(0, 260);
  const candidateLines = params.candidates.length > 0
    ? params.candidates.map((item, index) => `${index + 1}. ${item.path} | score=${item.score} | ${item.reason}`).join("\n")
    : "1. (sin candidatos)";
  const captureContextBlock = buildScreenshotCaptureContextBlock(params.captureContext);

  return [
    "Analiza una captura de pantalla de VS Code/Codespaces.",
    "Objetivo: aplicar OCR visual reforzado + detectar archivo principal + dar consejo.",
    "Responde SOLO JSON valido (sin markdown) con este formato exacto:",
    "{\"summary\":\"...\",\"mainFilePath\":\"...\",\"mainFileReason\":\"...\",\"autoAdvice\":\"...\",\"ocrText\":\"...\",\"confidence\":0}",
    "Reglas estrictas:",
    "- La captura se toma con el overlay ADACEEN oculto; si aun aparece contenido de ADACEEN, ignoralo por completo.",
    "- Lee visualmente tabs, breadcrumb, explorer, editor, terminal y mensajes de error.",
    "- Contrasta el OCR con el contexto DOM complementario para evitar confundir texto cortado o tapado.",
    "- mainFilePath debe ser una ruta exacta del repositorio cuando sea posible.",
    "- Si el OCR no confirma ruta exacta, usa primero filePath/breadcrumb/tabs del contexto DOM y luego heuristicMainFile.",
    "- summary: maximo 3 frases cortas.",
    "- mainFileReason: breve y concreta (maximo 2 frases).",
    "- autoAdvice: accion puntual para el estudiante sobre ese archivo.",
    "- ocrText: resume texto visible util en secciones: tabs/breadcrumb/explorer/editor/terminal; no inventes rutas.",
    "- confidence: entero de 0 a 100.",
    "",
    `repo: ${params.repoFullName}`,
    `version: ${params.version || "sin_version"}`,
    `heuristicMainFile: ${params.heuristicMainFilePath || "(sin detectar)"}`,
    `heuristicReason: ${params.heuristicReason || "(sin razon)"}`,
    "",
    "Top candidatos heuristicos:",
    candidateLines,
    "",
    captureContextBlock,
    "",
    "Rutas conocidas del repositorio (elige de aqui si coincide OCR):",
    pathList.map((item) => `- ${item}`).join("\n"),
  ].join("\n");
}

function buildScreenshotCaptureContextBlock(context: ProjectScreenshotCaptureContext | undefined) {
  if (!context || typeof context !== "object") {
    return "Contexto DOM complementario: (no enviado).";
  }

  const breadcrumbs = Array.isArray(context.codespaceBreadcrumbs)
    ? context.codespaceBreadcrumbs.map((item) => trimText(item)).filter(Boolean).slice(0, 12)
    : [];
  const activeTabs = Array.isArray(context.codespaceActiveTabs)
    ? context.codespaceActiveTabs.map((item) => trimText(item)).filter(Boolean).slice(0, 8)
    : [];
  const explorerEntries = Array.isArray(context.explorerEntries)
    ? context.explorerEntries
      .map((entry) => {
        const type = trimText(entry?.type);
        const pathValue = trimText(entry?.path);
        if (!pathValue) return "";
        return `${type || "item"}: ${pathValue}`;
      })
      .filter(Boolean)
      .slice(0, 120)
    : [];

  const viewport = context.viewport || {};
  const viewportText = [
    Number(viewport.width) || 0,
    Number(viewport.height) || 0,
  ].every(Boolean)
    ? `${Math.round(Number(viewport.width))}x${Math.round(Number(viewport.height))} dpr=${Number(viewport.devicePixelRatio) || 1}`
    : "";

  const lines = [
    "Contexto DOM complementario extraido antes de la captura:",
    `overlayHidden: ${context.overlayHidden === true ? "true" : "unknown"}`,
    viewportText ? `viewport: ${viewportText}` : "",
    context.capturedAt ? `capturedAt: ${truncateText(context.capturedAt, 80)}` : "",
    context.title ? `title: ${truncateText(context.title, 180)}` : "",
    context.url ? `url: ${truncateText(context.url, 260)}` : "",
    context.pageType ? `pageType: ${truncateText(context.pageType, 60)}` : "",
    context.branch ? `branch: ${truncateText(context.branch, 120)}` : "",
    context.filePath ? `filePath: ${truncateText(context.filePath, 260)}` : "",
    context.languageHint ? `languageHint: ${truncateText(context.languageHint, 80)}` : "",
    breadcrumbs.length ? `breadcrumbs: ${breadcrumbs.join(" / ")}` : "",
    activeTabs.length ? `activeTabs: ${activeTabs.join(" | ")}` : "",
    context.visibleError ? `visibleError: ${truncateText(context.visibleError, 500)}` : "",
    context.selection ? `selection: ${truncateText(context.selection, 700)}` : "",
    context.codeLineCount ? `codeLineCount: ${Math.max(0, Number(context.codeLineCount) || 0)}` : "",
    context.codeSnippet ? `editorSnippet:\n${truncateText(context.codeSnippet, 2200)}` : "",
    context.visibleText ? `visibleTextExcerpt:\n${truncateText(context.visibleText, 1200)}` : "",
    explorerEntries.length ? `visibleExplorerEntries:\n${explorerEntries.map((item) => `- ${item}`).join("\n")}` : "",
  ].filter(Boolean);

  return lines.join("\n");
}

export function parseImageDataUrl(rawValue: string) {
  const clean = trimText(rawValue);
  if (!clean) return null;

  const match = clean.match(/^data:(image\/(?:png|jpe?g|webp|gif|bmp|tiff));base64,([a-z0-9+/=\s]+)$/i);
  if (!match) return null;

  const mimeType = match[1].toLowerCase() === "image/jpg"
    ? "image/jpeg"
    : match[1].toLowerCase();
  const extensionByMime: Record<string, string> = {
    "image/png": "png",
    "image/jpeg": "jpg",
    "image/webp": "webp",
    "image/gif": "gif",
    "image/bmp": "bmp",
    "image/tiff": "tiff",
  };
  const extension = extensionByMime[mimeType];
  if (!extension) return null;

  const base64Payload = match[2].replace(/\s+/g, "");
  if (!base64Payload) return null;

  let buffer = Buffer.alloc(0);
  try {
    buffer = Buffer.from(base64Payload, "base64");
  } catch {
    return null;
  }
  if (!buffer.length) return null;

  return {
    mimeType,
    extension,
    buffer,
  };
}

export function buildFallbackInsight(params: {
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
      : "Primero abre el archivo de entrada del proyecto y valida que ruta o funcion inicia la ejecucion.",
  };
}

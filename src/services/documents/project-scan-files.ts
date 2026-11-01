// Contexto del proyecto: archivos del escaneo guardado y deteccion del archivo principal.
import fsp from "node:fs/promises";
import path from "node:path";
import type { AppDatabase } from "../../db/database.js";
import { trimText } from "../shared/text-utils.js";
import { getProjectScansRoot } from "./project-context.js";

export type ProjectScanStoredFile = {
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

export type MainFileCandidate = {
  path: string;
  score: number;
  reason: string;
  lines: number;
  bytes: number;
};

export function normalizeRepoPath(value: string) {
  return trimText(value)
    .replace(/\\/g, "/")
    .replace(/^\/+/, "")
    .toLowerCase();
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

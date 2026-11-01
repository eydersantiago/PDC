// Contexto del proyecto: estados y filas del escaneo, rutas de almacenamiento y mapeadores de filas.
import path from "node:path";
import { randomUUID } from "node:crypto";
import { env } from "../../config/env.js";
import { trimText } from "../shared/text-utils.js";

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

export function getProjectScansRoot() {
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


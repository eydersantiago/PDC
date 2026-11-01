// Base de datos: filas y mapeadores de RAG (fuentes, fragmentos y lotes) y utilidades de las fuentes sembradas.
import { createHash } from "node:crypto";
import type { RagSource, RagSourceChunk, RagSourceScope } from "../types/app.js";
import type { RagLot } from "../services/rag/rag-lots.js";
import { normalizeRagCourseCode } from "../services/rag/rag-courses.js";
import { trimText } from "../services/shared/text-utils.js";
import { toIso } from "./rows.js";

export type RagSourceRow = {
  id: string;
  scope: RagSourceScope;
  teacher_user_id: string | null;
  source_key: string;
  title: string;
  source_type: string;
  file_name: string;
  mime_type: string;
  content_sha256: string;
  content_text: string;
  metadata: Record<string, unknown>;
  is_active: boolean;
  created_by_user_id: string | null;
  created_at: string | Date;
  updated_at: string | Date;
};

export type RagSourceChunkRow = {
  id: string;
  source_id: string;
  scope: RagSourceScope;
  teacher_user_id: string | null;
  source_key: string;
  source_title: string;
  source_type: string;
  file_name: string;
  mime_type: string;
  source_metadata: Record<string, unknown>;
  is_active: boolean;
  chunk_index: number;
  content_text: string;
  search_text: string;
  token_count: number;
  char_start: number;
  char_end: number;
  page_start: number | null;
  page_end: number | null;
  citation_label: string;
  metadata: Record<string, unknown>;
  created_at: string | Date;
};

export function safeJsonObject(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

export type RagLotRow = {
  id: string;
  teacher_user_id: string;
  course_code: string;
  name: string;
  description: string;
  includes_base: boolean;
  is_active: boolean;
  created_at: string | Date;
  updated_at: string | Date;
};

export function mapRagLotRow(row: RagLotRow): RagLot {
  return {
    id: row.id,
    teacherUserId: row.teacher_user_id,
    courseCode: normalizeRagCourseCode(row.course_code),
    name: row.name,
    description: row.description || "",
    includesBase: row.includes_base !== false,
    isActive: row.is_active !== false,
    createdAt: toIso(row.created_at),
    updatedAt: toIso(row.updated_at),
  };
}

export function mapRagSourceRow(row: RagSourceRow): RagSource {
  return {
    id: row.id,
    scope: row.scope,
    teacherUserId: row.teacher_user_id,
    sourceKey: row.source_key,
    title: row.title,
    sourceType: row.source_type,
    fileName: row.file_name,
    mimeType: row.mime_type,
    contentSha256: row.content_sha256,
    contentText: row.content_text,
    metadata: safeJsonObject(row.metadata),
    isActive: row.is_active,
    createdByUserId: row.created_by_user_id,
    createdAt: toIso(row.created_at),
    updatedAt: toIso(row.updated_at),
  };
}

export function mapRagChunkRow(row: RagSourceChunkRow): RagSourceChunk {
  return {
    id: row.id,
    sourceId: row.source_id,
    scope: row.scope,
    teacherUserId: row.teacher_user_id,
    sourceKey: row.source_key,
    sourceTitle: row.source_title,
    sourceType: row.source_type,
    fileName: row.file_name,
    mimeType: row.mime_type,
    sourceMetadata: safeJsonObject(row.source_metadata),
    isActive: row.is_active,
    chunkIndex: Number(row.chunk_index) || 0,
    contentText: row.content_text,
    searchText: row.search_text,
    tokenCount: Number(row.token_count) || 0,
    charStart: Number(row.char_start) || 0,
    charEnd: Number(row.char_end) || 0,
    pageStart: row.page_start == null ? null : Number(row.page_start),
    pageEnd: row.page_end == null ? null : Number(row.page_end),
    citationLabel: row.citation_label,
    metadata: safeJsonObject(row.metadata),
    createdAt: toIso(row.created_at),
  };
}

export function seedEntryText(entry: Record<string, unknown>) {
  return [
    entry.id,
    entry.title,
    entry.description,
    entry.content,
    entry.courseCode,
    entry.courseName,
    entry.role,
    entry.category,
    entry.authors,
    entry.publisher,
    entry.year,
    entry.edition,
    entry.isbn,
    entry.access_status,
    entry.license,
    entry.topics,
    entry.keywords,
    entry.week == null ? "" : `Semana ${entry.week}`,
    entry.date,
    entry.source_pdf,
    entry.path,
    entry.original_url,
    entry.download_url,
    entry.rag_use,
  ]
    .map((value) => trimText(String(value ?? "")))
    .filter(Boolean)
    .join("\n");
}

export function contentHash(value: string) {
  return createHash("sha256").update(value).digest("hex");
}

export function estimateRagTokenCount(value: string) {
  const words = trimText(value).split(/\s+/).filter(Boolean).length;
  return Math.max(1, Math.ceil(words * 1.25));
}

export function optionalPositiveInteger(value: unknown) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) return null;
  return Math.round(parsed);
}

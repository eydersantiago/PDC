// Clasificaciones de documentos guardadas: fila, mapeo y guardar una clasificacion.
// Movido sin cambios desde src/routes/document-routes.ts (solo se agrego "export" y los imports).
import { randomUUID } from "node:crypto";
import type { AppDatabase } from "../db/database.js";
import type { DocumentClassification } from "../services/document-classifier.js";
import { toIso } from "../services/project-context.js";
import { trimText } from "../services/text-utils.js";

export type StoredClassificationRow = {
  id: string;
  repo_full_name: string;
  request_id: string;
  snapshot_id: string;
  file_path: string;
  file_name: string;
  mime_type: string;
  extension: string;
  label: string;
  confidence: number;
  method: string;
  evidence: unknown;
  reason: string;
  extracted_text_preview: string;
  features: unknown;
  model_used: boolean;
  model_error: string;
  classified_at: string | Date;
  updated_at: string | Date;
};

export function evidenceToArray(value: unknown) {
  return Array.isArray(value)
    ? value.map((item) => trimText(item)).filter(Boolean)
    : [];
}

export function mapStoredClassification(row: StoredClassificationRow) {
  const features = row.features && typeof row.features === "object"
    ? row.features as Record<string, unknown>
    : {};
  return {
    id: row.id,
    repoFullName: row.repo_full_name,
    requestId: row.request_id,
    snapshotId: row.snapshot_id,
    filePath: row.file_path,
    fileName: row.file_name,
    mimeType: row.mime_type,
    extension: row.extension,
    label: row.label,
    confidence: Number(row.confidence) || 0,
    method: row.method,
    evidence: evidenceToArray(row.evidence),
    reason: row.reason,
    extractedTextPreview: row.extracted_text_preview,
    features,
    bitacoraAgenda: features.bitacoraAgenda && typeof features.bitacoraAgenda === "object"
      ? features.bitacoraAgenda
      : { items: [], summary: "", warnings: [] },
    modelUsed: row.model_used,
    modelError: row.model_error,
    classifiedAt: toIso(row.classified_at),
    updatedAt: toIso(row.updated_at),
  };
}

export async function storeClassification(
  database: AppDatabase,
  input: {
    sessionId: string | null;
    userId: string | null;
    repoFullName: string;
    requestId: string;
    snapshotId: string;
    filePath: string;
    fileName: string;
    mimeType: string;
    extension: string;
    classification: DocumentClassification;
    extractedTextPreview: string;
    features: object;
    trainingExample: object;
    modelUsed: boolean;
    modelError: string;
  },
) {
  if (!input.repoFullName || !input.filePath) return null;

  const result = await database.pool.query<StoredClassificationRow>(
    `
    insert into project_document_classifications (
      id,
      user_id,
      session_id,
      repo_full_name,
      request_id,
      snapshot_id,
      file_path,
      file_name,
      mime_type,
      extension,
      label,
      confidence,
      method,
      evidence,
      reason,
      extracted_text_preview,
      features,
      training_example,
      model_used,
      model_error,
      classified_at,
      updated_at
    )
    values (
      $1,
      $2,
      $3,
      $4,
      $5,
      $6,
      $7,
      $8,
      $9,
      $10,
      $11,
      $12,
      $13,
      $14::jsonb,
      $15,
      $16,
      $17::jsonb,
      $18::jsonb,
      $19,
      $20,
      now(),
      now()
    )
    on conflict (repo_full_name, snapshot_id, file_path) do update
    set
      user_id = coalesce(excluded.user_id, project_document_classifications.user_id),
      session_id = coalesce(excluded.session_id, project_document_classifications.session_id),
      request_id = excluded.request_id,
      file_name = excluded.file_name,
      mime_type = excluded.mime_type,
      extension = excluded.extension,
      label = excluded.label,
      confidence = excluded.confidence,
      method = excluded.method,
      evidence = excluded.evidence,
      reason = excluded.reason,
      extracted_text_preview = excluded.extracted_text_preview,
      features = excluded.features,
      training_example = excluded.training_example,
      model_used = excluded.model_used,
      model_error = excluded.model_error,
      updated_at = now()
    returning
      id,
      repo_full_name,
      request_id,
      snapshot_id,
      file_path,
      file_name,
      mime_type,
      extension,
      label,
      confidence,
      method,
      evidence,
      reason,
      extracted_text_preview,
      features,
      model_used,
      model_error,
      classified_at,
      updated_at
    `,
    [
      randomUUID(),
      input.userId || null,
      input.sessionId || null,
      input.repoFullName,
      input.requestId,
      input.snapshotId,
      input.filePath,
      input.fileName,
      input.mimeType,
      input.extension,
      input.classification.label,
      input.classification.confidence,
      input.classification.method,
      JSON.stringify(input.classification.evidence),
      input.classification.reason,
      input.extractedTextPreview,
      JSON.stringify(input.features),
      JSON.stringify(input.trainingExample),
      input.modelUsed,
      input.modelError,
    ],
  );

  return mapStoredClassification(result.rows[0]);
}

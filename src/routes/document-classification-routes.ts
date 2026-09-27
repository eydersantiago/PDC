// Rutas de clasificacion de documentos (clasificar y listar).
// Movido sin cambios desde src/routes/document-routes.ts (solo se agrego "export" y los imports).
import { z } from "zod";
import express from "express";
import path from "node:path";
import { env } from "../config/env.js";
import type { AppDatabase } from "../db/database.js";
import { classifyDocument, extractBitacoraAgenda } from "../services/document-classifier.js";
import { normalizeRepoFullName } from "../services/project-context.js";
import { trimText } from "../services/text-utils.js";
import { mapStoredClassification, storeClassification } from "./document-classifications.js";
import type { StoredClassificationRow } from "./document-classifications.js";
import { errorMessage, resolveSession } from "./route-utils.js";

export const classifyDocumentSchema = z.object({
  repoFullName: z.string().max(240).optional(),
  requestId: z.string().max(120).optional(),
  snapshotId: z.string().max(120).optional(),
  filePath: z.string().max(900).optional(),
  fileName: z.string().max(500).optional(),
  mimeType: z.string().max(160).optional(),
  extension: z.string().max(24).optional(),
  text: z.string().max(1_000_000).optional(),
  contentBase64: z.string().max(15_000_000).optional(),
  useModel: z.boolean().optional(),
}).strict();

export const listClassificationsQuerySchema = z.object({
  repoFullName: z.string().min(3).max(240),
  limit: z.coerce.number().int().min(1).max(100).optional(),
}).strict();

export function ensureWorkerAuthorized(req: express.Request) {
  const expected = trimText(env.scanWorkerKey);
  if (!expected) return true;
  const provided = trimText(req.header("x-adaceen-worker-key") || req.query.workerKey || req.body?.workerKey || "");
  return provided === expected;
}

export function decodeBase64Payload(value: string) {
  const clean = trimText(value);
  if (!clean) return undefined;
  const withoutDataUrl = clean.replace(/^data:[^;]+;base64,/i, "");
  try {
    const buffer = Buffer.from(withoutDataUrl.replace(/\s+/g, ""), "base64");
    return buffer.length ? buffer : undefined;
  } catch {
    return undefined;
  }
}

export async function resolveScanRequestOwner(database: AppDatabase, requestId: string) {
  const cleanRequestId = trimText(requestId);
  if (!cleanRequestId) return null;

  const result = await database.pool.query<{
    repo_full_name: string;
    requested_by_user_id: string | null;
    requested_session_id: string | null;
    snapshot_id: string;
  }>(
    `
    select
      repo_full_name,
      requested_by_user_id,
      requested_session_id,
      snapshot_id
    from project_scan_requests
    where id = $1
    limit 1
    `,
    [cleanRequestId],
  );

  return result.rows[0] || null;
}

// Clasificacion de documentos.
export function registerDocumentClassificationRoutes(app: express.Express, database: AppDatabase) {
  app.post("/api/documents/classify", async (req, res) => {
    try {
      const session = await resolveSession(database, req);
      const workerAuthorized = ensureWorkerAuthorized(req);
      if (!session && !workerAuthorized) {
        return res.status(401).json({ ok: false, error: "Sesion o worker no autorizado." });
      }

      const parsed = classifyDocumentSchema.parse(req.body || {});
      const requestOwner = await resolveScanRequestOwner(database, trimText(parsed.requestId));
      const repoFullName = normalizeRepoFullName(parsed.repoFullName || requestOwner?.repo_full_name || "");
      const requestId = trimText(parsed.requestId);
      const snapshotId = trimText(parsed.snapshotId || requestOwner?.snapshot_id);
      const filePath = trimText(parsed.filePath || parsed.fileName);
      const fileName = trimText(parsed.fileName || path.basename(filePath));
      const buffer = decodeBase64Payload(parsed.contentBase64 || "");

      if (!trimText(parsed.text) && !buffer?.length) {
        return res.status(400).json({ ok: false, error: "text o contentBase64 requerido." });
      }

      const result = await classifyDocument({
        fileName,
        filePath,
        mimeType: parsed.mimeType,
        extension: parsed.extension,
        text: parsed.text,
        buffer,
        useModel: parsed.useModel,
      });
      const bitacoraAgenda = result.classification.label === "BITACORA"
        ? extractBitacoraAgenda(result.extracted.text)
        : {
          items: [],
          summary: "El documento no fue clasificado como bitacora.",
          warnings: [],
        };

      const userId = session?.user.id || requestOwner?.requested_by_user_id || null;
      const sessionId = session?.id || requestOwner?.requested_session_id || null;
      const stored = await storeClassification(database, {
        sessionId,
        userId,
        repoFullName,
        requestId,
        snapshotId,
        filePath,
        fileName,
        mimeType: result.extracted.mimeType || trimText(parsed.mimeType),
        extension: result.extracted.extension || trimText(parsed.extension),
        classification: result.classification,
        extractedTextPreview: trimText(result.extracted.text).replace(/\s+/g, " ").slice(0, 1200),
        features: {
          ...result.features,
          bitacoraAgenda,
        },
        trainingExample: result.trainingExample,
        modelUsed: result.modelUsed,
        modelError: result.modelError,
      });

      return res.json({
        ok: true,
        classification: result.classification,
        stored,
        extraction: {
          source: result.extracted.source,
          mimeType: result.extracted.mimeType,
          extension: result.extracted.extension,
          bytes: result.extracted.bytes,
          textLength: result.extracted.text.length,
          warnings: result.extracted.warnings,
        },
        bitacoraAgenda,
        modelUsed: result.modelUsed,
        modelError: result.modelError || null,
      });
    } catch (error) {
      const status = error instanceof z.ZodError ? 400 : 500;
      return res.status(status).json({ ok: false, error: errorMessage(error) });
    }
  });

  app.get("/api/documents/classifications", async (req, res) => {
    try {
      const session = await resolveSession(database, req);
      if (!session) {
        return res.status(401).json({ ok: false, error: "Sesion no valida." });
      }

      const parsed = listClassificationsQuerySchema.parse(req.query || {});
      const repoFullName = normalizeRepoFullName(parsed.repoFullName);
      if (!repoFullName) {
        return res.status(400).json({ ok: false, error: "repoFullName invalido. Usa owner/repo." });
      }

      const limit = Math.max(1, Math.min(100, Number(parsed.limit) || 30));
      const result = await database.pool.query<StoredClassificationRow>(
        `
        select
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
        from project_document_classifications
        where repo_full_name = $1
          and (user_id is null or user_id = $2)
        order by classified_at desc, updated_at desc
        limit $3
        `,
        [repoFullName, session.user.id, limit],
      );

      return res.json({
        ok: true,
        repoFullName,
        classifications: result.rows.map(mapStoredClassification),
      });
    } catch (error) {
      const status = error instanceof z.ZodError ? 400 : 500;
      return res.status(status).json({ ok: false, error: errorMessage(error) });
    }
  });
}

// Rutas para importar la bitacora (archivo); registerBitacoraImportRoutes registra, en este orden, la del archivo y la del registro manual.
// Movido sin cambios desde src/routes/documents/document-routes.ts (solo se agrego "export" y los imports).
import { z } from "zod";
import multer from "multer";
import path from "node:path";
import express from "express";
import { randomUUID } from "node:crypto";
import type { AppDatabase } from "../../db/database.js";
import { assessPdfBitacoraReadiness, parseBitacoraTemplateUpload } from "../../services/bitacora/bitacora-import.js";
import type { ParsedBitacoraImportResult } from "../../services/bitacora/bitacora-import.js";
import { classifyDocument } from "../../services/documents/document-classifier.js";
import { extractBitacoraAgenda } from "../../services/documents/bitacora-agenda.js";
import type { DocumentClassification } from "../../services/documents/document-classifier.js";
import { normalizeRepoFullName } from "../../services/documents/project-context.js";
import { trimText } from "../../services/shared/text-utils.js";
import { resolveBitacoraOwner } from "./bitacora-owner.js";
import { storeClassification } from "../documents/document-classifications.js";
import { errorMessage, resolveSession } from "../route-utils.js";
import { buildBitacoraImportRepoName } from "./bitacora-manual-items.js";
import { registerBitacoraManualImportRoute } from "./bitacora-manual-routes.js";

export const bitacoraImportSchema = z.object({
  repoFullName: z.string().max(240).optional(),
  requestId: z.string().max(120).optional(),
  snapshotId: z.string().max(120).optional(),
  fileName: z.string().max(500).optional(),
  // Administrador (0.7.22): el docente dueño de la bitácora (bitacora-owner.ts).
  teacherUserId: z.string().max(120).optional(),
}).strict();

export const bitacoraImportUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 12 * 1024 * 1024 },
});

export const BITACORA_IMPORT_PDF_MIME_TYPES = new Set([
  "application/pdf",
  "application/x-pdf",
]);

export const BITACORA_IMPORT_EXCEL_MIME_TYPES = new Set([
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  "application/vnd.ms-excel",
]);

export function detectBitacoraImportSource(fileName: string, mimeType: string) {
  const extension = path.extname(fileName || "").toLowerCase();
  const normalizedMime = trimText(mimeType).toLowerCase();
  const isPdf = extension === ".pdf" || BITACORA_IMPORT_PDF_MIME_TYPES.has(normalizedMime);
  const isExcel = extension === ".xlsx" || extension === ".xls" || BITACORA_IMPORT_EXCEL_MIME_TYPES.has(normalizedMime);

  if (isPdf) return "pdf";
  if (isExcel) return "excel";
  return "unknown";
}

export function buildBitacoraImportClassification(
  result: ParsedBitacoraImportResult,
  recognizedLabel: "BITACORA" | "OTRO",
): DocumentClassification {
  const label = recognizedLabel === "BITACORA" ? "BITACORA" : "OTRO";
  const hasAgenda = result.rowsUsed > 0 || result.recognized;
  return {
    label: hasAgenda ? "BITACORA" as const : label,
    confidence: hasAgenda ? 0.91 : 0.48,
    method: "rules" as const,
    evidence: [
      `Fuente: ${result.source}`,
      `Filas parseadas: ${result.rowsParsed}`,
      `Filas con agenda: ${result.rowsUsed}`,
      recognizedLabel === "OTRO" ? "El archivo no presenta estructura suficiente para agenda." : "Estructura reconocible para agenda académica.",
    ],
    reason: `Importación desde ${result.source}: ${result.bitacoraAgenda.summary}`,
  };
}

export function summarizeBitacoraImportRowsFromAgenda(bitacoraAgenda: ReturnType<typeof extractBitacoraAgenda>) {
  return {
    activities: bitacoraAgenda.items.filter((item) => item.type === "activity" || item.type === "commitment").length,
    exams: bitacoraAgenda.items.filter((item) => item.type === "task").length,
    withDate: bitacoraAgenda.items.filter((item) => Boolean(item.dueAt)).length,
    withoutDate: bitacoraAgenda.items.filter((item) => !item.dueAt).length,
  };
}

// Bitacora: importar el archivo y registro manual.
export function registerBitacoraImportRoutes(app: express.Express, database: AppDatabase) {
  registerBitacoraFileImportRoute(app, database);
  registerBitacoraManualImportRoute(app, database);
}

function registerBitacoraFileImportRoute(app: express.Express, database: AppDatabase) {
  app.post("/api/documents/bitacora/import", bitacoraImportUpload.single("file"), async (req, res) => {
    try {
      const session = await resolveSession(database, req);
      if (!session) {
        return res.status(401).json({ ok: false, error: "Sesion no valida." });
      }
      if (session.user.role !== "teacher" && session.user.role !== "admin") {
        return res.status(403).json({ ok: false, error: "Solo docentes pueden importar bitacora." });
      }

      const parsed = bitacoraImportSchema.parse(req.body || {});
      const resolved = await resolveBitacoraOwner(database, session, parsed.teacherUserId, {
        deniedMessage: "Solo docentes pueden importar bitacora.",
      });
      if (!resolved.ok) {
        return res.status(resolved.status).json({ ok: false, error: resolved.error });
      }
      const ownerRef = { user: { id: resolved.owner.id } };
      const uploadedFile = req.file;
      if (!uploadedFile?.buffer || uploadedFile.buffer.length === 0) {
        return res.status(400).json({ ok: false, error: "Archivo requerido para importar." });
      }

      const inputFileName = trimText(parsed.fileName || uploadedFile.originalname || "bitacora_import");
      const fileSource = detectBitacoraImportSource(inputFileName, uploadedFile.mimetype);
      if (fileSource === "unknown") {
        return res.status(400).json({ ok: false, error: "Solo se permiten archivos PDF o Excel (.xlsx/.xls)." });
      }

      const requestId = trimText(parsed.requestId) || randomUUID();
      const snapshotId = trimText(parsed.snapshotId) || randomUUID();
      const repoFullName = normalizeRepoFullName(parsed.repoFullName || buildBitacoraImportRepoName(ownerRef))
        || buildBitacoraImportRepoName(ownerRef);
      const filePath = inputFileName;

      let parsedResult: ParsedBitacoraImportResult;
      let readiness: ReturnType<typeof assessPdfBitacoraReadiness> | null = null;
      let modelUsed = false;
      let modelError = "";

      if (fileSource === "excel") {
        parsedResult = await parseBitacoraTemplateUpload(uploadedFile.buffer);
        if (!parsedResult.detectedTemplate || !parsedResult.validation.isValid) {
          return res.status(400).json({
            ok: false,
            error: parsedResult.detectedTemplate
              ? "La plantilla no cumple los requisitos mínimos para importar bitácora."
              : "El archivo subido no parece ser una plantilla de bitácora.",
            import: parsedResult,
            validation: parsedResult.validation,
          });
        }
      } else {
        const result = await classifyDocument({
          fileName: inputFileName,
          filePath: inputFileName,
          mimeType: uploadedFile.mimetype,
          extension: path.extname(inputFileName).replace(/^\./, "").toLowerCase(),
          buffer: uploadedFile.buffer,
        });
        const bitacoraAgenda = result.classification.label === "BITACORA"
          ? extractBitacoraAgenda(result.extracted.text)
          : {
            items: [],
            summary: "El documento no fue clasificado como bitacora.",
            warnings: ["No se detectaron señales suficientes para autoimportación."],
          };
        readiness = assessPdfBitacoraReadiness({
          text: result.extracted.text,
          fileSize: uploadedFile.buffer.length,
          fileName: inputFileName,
        });
        modelUsed = result.modelUsed;
        modelError = result.modelError;
        const summary = summarizeBitacoraImportRowsFromAgenda(bitacoraAgenda);
        const validation = {
          minimumWeeks: 0,
          createdWeeks: summary.withDate,
          hasActivities: summary.activities > 0,
          hasExams: summary.exams > 0,
          isValid: (result.classification.label === "BITACORA" || readiness.canAutoImport)
            && bitacoraAgenda.items.length > 0,
          errors: readiness.blockers,
          warnings: [
            ...readiness.recommendations,
            ...bitacoraAgenda.warnings,
          ],
        };
        parsedResult = {
          source: "pdf_text",
          recognized: result.classification.label === "BITACORA" || readiness.canAutoImport,
          detectedTemplate: false,
          rowsParsed: bitacoraAgenda.items.length || readiness.signals.chars,
          rowsUsed: bitacoraAgenda.items.length,
          warnings: [
            ...readiness.blockers,
            ...readiness.recommendations,
            ...bitacoraAgenda.warnings,
          ],
          validation,
          bitacoraAgenda,
          summary: {
            ...summary,
            parseWarnings: readiness.blockers.length + readiness.recommendations.length + bitacoraAgenda.warnings.length,
          },
          textPreview: trimText(result.extracted.text).slice(0, 2200),
        };
      }

      const classification: DocumentClassification = fileSource === "excel"
        ? buildBitacoraImportClassification(parsedResult, parsedResult.recognized ? "BITACORA" : "OTRO")
        : parsedResult.recognized
          ? {
            label: "BITACORA",
            confidence: 0.89,
            method: "rules",
            evidence: [`Documento PDF importado con ${parsedResult.bitacoraAgenda.items.length} registro(s).`],
            reason: parsedResult.bitacoraAgenda.summary,
          }
          : {
            label: "OTRO",
            confidence: 0.58,
            method: "rules",
            evidence: [
              "No se detectaron suficientes señales para marcarlo como bitacora.",
              ...parsedResult.warnings.slice(0, 3),
            ],
            reason: parsedResult.bitacoraAgenda.summary,
          };

      const stored = await storeClassification(database, {
        sessionId: session.id,
        userId: resolved.owner.id,
        repoFullName,
        requestId,
        snapshotId,
        filePath,
        fileName: inputFileName,
        mimeType: trimText(uploadedFile.mimetype) || (fileSource === "excel" ? "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" : "application/pdf"),
        extension: path.extname(inputFileName).replace(/^\./, "").toLowerCase(),
        classification,
        extractedTextPreview: parsedResult.textPreview,
        features: {
          source: fileSource,
          bitacoraAgenda: parsedResult.bitacoraAgenda,
          rowsParsed: parsedResult.rowsParsed,
          rowsUsed: parsedResult.rowsUsed,
          detectedTemplate: parsedResult.detectedTemplate,
          importWarnings: parsedResult.warnings,
          pdfReadiness: readiness,
        },
        trainingExample: {
          input: {
            fileName: inputFileName,
            filePath,
            textPreview: parsedResult.textPreview,
          },
          expectedLabel: null,
          predictedLabel: classification.label,
        },
        modelUsed,
        modelError,
      });

      return res.json({
        ok: true,
        source: fileSource,
        import: parsedResult,
        readiness: fileSource === "pdf" ? readiness : null,
        classification,
        stored,
      });
    } catch (error) {
      const status = error instanceof z.ZodError ? 400 : 500;
      return res.status(status).json({ ok: false, error: errorMessage(error) });
    }
  });
}


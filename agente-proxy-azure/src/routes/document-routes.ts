import path from "node:path";
import { randomUUID } from "node:crypto";
import type express from "express";
import multer from "multer";
import { z } from "zod";
import { env } from "../config/env.js";
import type { AppDatabase } from "../db/database.js";
import {
  classifyDocument,
  extractBitacoraAgenda,
  type BitacoraAgendaItem,
  type DocumentClassification,
} from "../services/document-classifier.js";
import { normalizeRepoFullName, toIso } from "../services/project-context.js";
import {
  buildBitacoraTemplate,
  getBitacoraTemplateUiMetadata,
} from "../services/bitacora-template.js";
import {
  assessPdfBitacoraReadiness,
  getBitacoraPdfGuidelines,
  type ParsedBitacoraImportResult,
  parseBitacoraTemplateUpload,
} from "../services/bitacora-import.js";
import { trimText } from "../services/text-utils.js";
import { errorMessage, resolveSession } from "./route-utils.js";

type StoredClassificationRow = {
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

const classifyDocumentSchema = z.object({
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

const listClassificationsQuerySchema = z.object({
  repoFullName: z.string().min(3).max(240),
  limit: z.coerce.number().int().min(1).max(100).optional(),
}).strict();

const bitacoraTemplateQuerySchema = z.object({
  courseName: z.string().max(240).optional(),
  courseCode: z.string().max(120).optional(),
  group: z.string().max(120).optional(),
  academicPeriod: z.string().max(120).optional(),
}).strict();

const bitacoraImportSchema = z.object({
  repoFullName: z.string().max(240).optional(),
  requestId: z.string().max(120).optional(),
  snapshotId: z.string().max(120).optional(),
  fileName: z.string().max(500).optional(),
}).strict();

const bitacoraManualItemSchema = z.object({
  week: z.coerce.number().int().min(1).max(20).optional(),
  dueAt: z.string().max(180).optional(),
  title: z.string().min(1).max(260),
  type: z.string().max(140).optional(),
  subtype: z.string().max(160).optional(),
  description: z.string().max(1600).optional(),
  notes: z.string().max(1600).optional(),
  modality: z.string().max(100).optional(),
  state: z.string().max(100).optional(),
}).strict();

const bitacoraManualImportSchema = z.object({
  repoFullName: z.string().max(240).optional(),
  requestId: z.string().max(120).optional(),
  snapshotId: z.string().max(120).optional(),
  sourceName: z.string().max(180).optional(),
  fileName: z.string().max(500).optional(),
  activities: z.array(bitacoraManualItemSchema).max(240).optional(),
  exams: z.array(bitacoraManualItemSchema).max(160).optional(),
  dryRun: z.boolean().optional(),
}).strict();

const bitacoraImportUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 12 * 1024 * 1024 },
});

function compactText(value: string, max = 300) {
  const text = trimText(value).replace(/\s+/g, " ");
  if (!text) return "";
  return text.length <= max ? text : `${text.slice(0, Math.max(0, max - 3))}...`;
}

function isIsoDateLike(value: string) {
  const normalized = trimText(value).toLowerCase();
  return /^[0-9]{4}-[0-9]{2}-[0-9]{2}/.test(normalized);
}

function buildManualDueAt(value: string) {
  const source = trimText(value).toLowerCase();
  if (!source) return { dueAt: null as string | null, visibleDueText: "" };
  if (isIsoDateLike(source)) {
    const withoutTime = source.split(/[T ]/)[0];
    const match = withoutTime.match(/(\d{4})-(\d{1,2})-(\d{1,2})/);
    if (!match) return { dueAt: null, visibleDueText: source };
    const year = Number(match[1]);
    const month = Number(match[2]);
    const day = Number(match[3]);
    if (
      Number.isInteger(year)
      && Number.isInteger(month)
      && Number.isInteger(day)
      && month >= 1 && month <= 12
      && day >= 1 && day <= 31
    ) {
      return {
        dueAt: `${String(year).padStart(4, "0")}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}T09:00:00-05:00`,
        visibleDueText: source,
      };
    }
    return { dueAt: null, visibleDueText: source };
  }

  const matchSlash = source.match(/^(\d{1,2})[\/\-](\d{1,2})(?:[\/\-](\d{2,4}))?(?:\s+(\d{1,2}):(\d{2}))?$/);
  if (matchSlash) {
    const day = Number(matchSlash[1]);
    const month = Number(matchSlash[2]);
    const year = matchSlash[3]
      ? Number(matchSlash[3].length === 2 ? `20${matchSlash[3]}` : matchSlash[3])
      : new Date().getUTCFullYear();
    const hour = Number(matchSlash[4] || "9");
    const minute = Number(matchSlash[5] || "0");
    if (
      Number.isInteger(day)
      && Number.isInteger(month)
      && Number.isInteger(year)
      && Number.isInteger(hour)
      && Number.isInteger(minute)
      && month >= 1 && month <= 12
      && day >= 1 && day <= 31
      && hour >= 0 && hour <= 23
      && minute >= 0 && minute <= 59
    ) {
      return {
        dueAt: `${String(year).padStart(4, "0")}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}T${String(hour).padStart(2, "0")}:${String(minute).padStart(2, "0")}:00-05:00`,
        visibleDueText: source,
      };
    }
  }

  const parsedDate = new Date(source);
  if (!Number.isNaN(parsedDate.getTime())) {
    return {
      dueAt: parsedDate.toISOString(),
      visibleDueText: source,
    };
  }

  return { dueAt: null, visibleDueText: source };
}

const BITACORA_IMPORT_PDF_MIME_TYPES = new Set([
  "application/pdf",
  "application/x-pdf",
]);

const BITACORA_IMPORT_EXCEL_MIME_TYPES = new Set([
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  "application/vnd.ms-excel",
]);

function ensureWorkerAuthorized(req: express.Request) {
  const expected = trimText(env.scanWorkerKey);
  if (!expected) return true;
  const provided = trimText(req.header("x-adaceen-worker-key") || req.query.workerKey || req.body?.workerKey || "");
  return provided === expected;
}

function decodeBase64Payload(value: string) {
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

function detectBitacoraImportSource(fileName: string, mimeType: string) {
  const extension = path.extname(fileName || "").toLowerCase();
  const normalizedMime = trimText(mimeType).toLowerCase();
  const isPdf = extension === ".pdf" || BITACORA_IMPORT_PDF_MIME_TYPES.has(normalizedMime);
  const isExcel = extension === ".xlsx" || extension === ".xls" || BITACORA_IMPORT_EXCEL_MIME_TYPES.has(normalizedMime);

  if (isPdf) return "pdf";
  if (isExcel) return "excel";
  return "unknown";
}

function buildBitacoraImportRepoName(session: { user: { id: string } }) {
  const safeTeacherId = trimText(session.user.id).replace(/[^a-z0-9-]/gi, "").slice(0, 24) || "teacher";
  return normalizeRepoFullName(`docentes/${safeTeacherId}`) || "docentes/manual";
}

function buildBitacoraImportClassification(
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

function buildManualBitacoraValidation(input: {
  activities: Array<z.infer<typeof bitacoraManualItemSchema>>;
  exams: Array<z.infer<typeof bitacoraManualItemSchema>>;
}) {
  const allRows = [...input.activities, ...input.exams];
  const weeks = allRows.map((row) => row.week).filter((value): value is number => value !== undefined);
  const uniqueWeeks = new Set(weeks.map((week) => String(week)));
  return {
    minimumWeeks: 0,
    createdWeeks: uniqueWeeks.size,
    hasActivities: input.activities.length > 0,
    hasExams: input.exams.length > 0,
    isValid: allRows.length > 0,
    errors: [] as string[],
    warnings: allRows.length === 0
      ? ["No se enviaron filas de actividades ni exámenes desde la interfaz."]
      : [],
  };
}

function parseManualBitacoraItems(input: {
  activities: Array<z.infer<typeof bitacoraManualItemSchema>>;
  exams: Array<z.infer<typeof bitacoraManualItemSchema>>;
}) {
  const items: BitacoraAgendaItem[] = [];
  const warnings: string[] = [];
  const sections: Array<{
    source: "Actividades" | "Exámenes";
    rows: typeof input.activities;
  }> = [
    { source: "Actividades", rows: input.activities },
    { source: "Exámenes", rows: input.exams },
  ];

  for (const section of sections) {
    section.rows.forEach((row, index) => {
      const rowIndex = index + 1;
      const title = compactText(row.title, 220);
      const notes = compactText(compactText(row.notes || ""), 260);
      const typeValue = compactText(row.type || "", 120);
      const subtypeValue = compactText(row.subtype || "", 140);
      const description = compactText(row.description || "", 500);
      const parsedDate = buildManualDueAt(row.dueAt || "");
      const visibleText = parsedDate.visibleDueText;
      const evidence = [
        `Origen: interfaz docente`,
        `Hoja: ${section.source}`,
        `Fila: ${rowIndex}`,
      ];

      if (!trimText(title) && !trimText(description)) {
        warnings.push(`Se omitió ${section.source} fila ${rowIndex}: falta título y descripción.`);
        return;
      }

      const resolvedTitle = section.source === "Exámenes" && title
        ? `Examen: ${title}`
        : title || "Sin titulo";

      const resolvedDescription = compactText([
        typeValue ? `Tipo: ${typeValue}` : "",
        subtypeValue ? `Subtipo: ${subtypeValue}` : "",
        row.modality ? `Modalidad: ${row.modality}` : "",
        row.state ? `Estado: ${row.state}` : "",
        notes,
        description,
      ].filter(Boolean).join(" | "), 520);

      if (!parsedDate.dueAt && trimText(row.dueAt)) {
        warnings.push(`Se omiti\u00f3 fecha interpretada en ${section.source} fila ${rowIndex}: "${trimText(row.dueAt)}".`);
        evidence.push(`Fecha informada: ${visibleText}`);
      }

      items.push({
        title: resolvedTitle,
        type: section.source === "Exámenes" ? "task" : "activity",
        dueAt: parsedDate.dueAt,
        visibleDueText: visibleText,
        description: resolvedDescription,
        confidence: section.source === "Exámenes" ? 0.98 : 0.95,
        evidence,
      });
    });
  }

  const withDate = items.filter((item) => Boolean(item.dueAt)).length;
  return {
    items,
    summary: items.length
      ? `Se detectaron ${items.length} registro(s) creados desde la interfaz docente.`
      : "No se detectaron filas con información valida para agendar.",
    warnings,
    withDate,
    withoutDate: items.length - withDate,
    activities: items.filter((item) => item.type === "activity").length,
    exams: items.filter((item) => item.type === "task").length,
  };
}

function summarizeBitacoraImportRowsFromAgenda(bitacoraAgenda: ReturnType<typeof extractBitacoraAgenda>) {
  return {
    activities: bitacoraAgenda.items.filter((item) => item.type === "activity" || item.type === "commitment").length,
    exams: bitacoraAgenda.items.filter((item) => item.type === "task").length,
    withDate: bitacoraAgenda.items.filter((item) => Boolean(item.dueAt)).length,
    withoutDate: bitacoraAgenda.items.filter((item) => !item.dueAt).length,
  };
}

function evidenceToArray(value: unknown) {
  return Array.isArray(value)
    ? value.map((item) => trimText(item)).filter(Boolean)
    : [];
}

function mapStoredClassification(row: StoredClassificationRow) {
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

async function resolveScanRequestOwner(database: AppDatabase, requestId: string) {
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

async function storeClassification(
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

export function registerDocumentRoutes(app: express.Express, database: AppDatabase) {
  app.get("/api/documents/bitacora-template", async (req, res) => {
    try {
      const session = await resolveSession(database, req);
      if (!session) {
        return res.status(401).json({ ok: false, error: "Sesion no valida." });
      }
      if (session.user.role !== "teacher") {
        return res.status(403).json({ ok: false, error: "Solo docentes pueden descargar esta plantilla." });
      }

      const parsed = bitacoraTemplateQuerySchema.parse(req.query || {});
      const filenameDate = new Date().toISOString().split("T")[0].replace(/-/g, "");
      const workbookBuffer = await buildBitacoraTemplate({
        teacher: {
          id: session.user.id,
          displayName: session.user.displayName,
          email: session.user.email,
        },
        courseName: parsed.courseName,
        courseCode: parsed.courseCode,
        group: parsed.group,
        academicPeriod: parsed.academicPeriod,
      });

      res.setHeader("Content-Type", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
      res.setHeader("Content-Disposition", `attachment; filename="plantilla_bitacora_${filenameDate}.xlsx"`);
      res.setHeader("X-Content-Type-Options", "nosniff");
      return res.send(Buffer.from(workbookBuffer));
    } catch (error) {
      const status = error instanceof z.ZodError ? 400 : 500;
      return res.status(status).json({ ok: false, error: errorMessage(error) });
    }
  });

  app.get("/api/documents/bitacora-teacher-workflow", async (req, res) => {
    try {
      const session = await resolveSession(database, req);
      if (!session) {
        return res.status(401).json({ ok: false, error: "Sesion no valida." });
      }
      if (session.user.role !== "teacher") {
        return res.status(403).json({ ok: false, error: "Solo docentes pueden consultar este panel de flujo." });
      }

      return res.json({
        ok: true,
        teacherRole: true,
        routes: {
          templateDownload: "/api/documents/bitacora-template",
          templateMetadata: "/api/documents/bitacora-template-form",
          excelOrPdfImport: "/api/documents/bitacora/import",
          manualDesignImport: "/api/documents/bitacora/manual",
          pdfGuidelines: "/api/documents/bitacora-pdf-guidelines",
        },
        templateMetadata: getBitacoraTemplateUiMetadata(),
        uploadField: "file",
      });
    } catch (error) {
      const status = error instanceof z.ZodError ? 400 : 500;
      return res.status(status).json({ ok: false, error: errorMessage(error) });
    }
  });

  app.get("/api/documents/bitacora-template-form", async (req, res) => {
    try {
      const session = await resolveSession(database, req);
      if (!session) {
        return res.status(401).json({ ok: false, error: "Sesion no valida." });
      }
      if (session.user.role !== "teacher") {
        return res.status(403).json({ ok: false, error: "Solo docentes pueden consultar metadatos de plantilla." });
      }

      return res.json({
        ok: true,
        template: getBitacoraTemplateUiMetadata(),
      });
    } catch (error) {
      const status = error instanceof z.ZodError ? 400 : 500;
      return res.status(status).json({ ok: false, error: errorMessage(error) });
    }
  });

  app.get("/api/documents/bitacora-pdf-guidelines", async (req, res) => {
    try {
      const session = await resolveSession(database, req);
      if (!session) {
        return res.status(401).json({ ok: false, error: "Sesion no valida." });
      }
      if (session.user.role !== "teacher") {
        return res.status(403).json({ ok: false, error: "Solo docentes pueden consultar lineamientos." });
      }
      return res.json({
        ok: true,
        guidelines: getBitacoraPdfGuidelines(),
      });
    } catch (error) {
      return res.status(500).json({ ok: false, error: errorMessage(error) });
    }
  });

  app.post("/api/documents/bitacora/import", bitacoraImportUpload.single("file"), async (req, res) => {
    try {
      const session = await resolveSession(database, req);
      if (!session) {
        return res.status(401).json({ ok: false, error: "Sesion no valida." });
      }
      if (session.user.role !== "teacher") {
        return res.status(403).json({ ok: false, error: "Solo docentes pueden importar bitacora." });
      }

      const parsed = bitacoraImportSchema.parse(req.body || {});
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
      const repoFullName = normalizeRepoFullName(parsed.repoFullName || buildBitacoraImportRepoName(session))
        || buildBitacoraImportRepoName(session);
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
        userId: session.user.id,
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

  app.post("/api/documents/bitacora/manual", async (req, res) => {
    try {
      const session = await resolveSession(database, req);
      if (!session) {
        return res.status(401).json({ ok: false, error: "Sesion no valida." });
      }
      if (session.user.role !== "teacher") {
        return res.status(403).json({ ok: false, error: "Solo docentes pueden guardar bitacora manual." });
      }

      const parsed = bitacoraManualImportSchema.parse(req.body || {});
      const parsedRows = parseManualBitacoraItems({
        activities: parsed.activities || [],
        exams: parsed.exams || [],
      });
      const validation = buildManualBitacoraValidation({
        activities: parsed.activities || [],
        exams: parsed.exams || [],
      });

      const inputFileName = trimText(parsed.fileName || parsed.sourceName || `bitacora_manual_${new Date().toISOString().slice(0, 10)}.json`);
      const requestId = trimText(parsed.requestId) || randomUUID();
      const snapshotId = trimText(parsed.snapshotId) || randomUUID();
      const repoFullName = normalizeRepoFullName(parsed.repoFullName || buildBitacoraImportRepoName(session))
        || buildBitacoraImportRepoName(session);

      if (!parsedRows.items.length || !validation.isValid) {
        return res.status(400).json({
          ok: false,
          error: "La carga manual no contiene registros importables.",
          validation,
          import: {
            source: "manual",
            recognized: false,
            detectedTemplate: false,
            rowsParsed: 0,
            rowsUsed: 0,
            warnings: validation.warnings,
            bitacoraAgenda: {
              items: [],
              summary: parsedRows.summary,
              warnings: parsedRows.warnings,
            },
            summary: {
              activities: parsedRows.activities,
              exams: parsedRows.exams,
              withDate: parsedRows.withDate,
              withoutDate: parsedRows.withoutDate,
              parseWarnings: parsedRows.warnings.length + validation.warnings.length,
            },
            textPreview: "",
          },
        });
      }

      const bitacoraAgenda = {
        items: parsedRows.items,
        summary: parsedRows.summary,
        warnings: parsedRows.warnings,
      };

      const classification = {
        label: "BITACORA" as const,
        confidence: 0.97,
        method: "rules" as const,
        evidence: [
          "Importación desde interfaz docente.",
          `Actividades cargadas: ${parsedRows.activities}`,
          `Exámenes cargados: ${parsedRows.exams}`,
          `Registros con fecha: ${parsedRows.withDate}`,
        ],
        reason: bitacoraAgenda.summary,
      };

      const stored = parsed.dryRun
        ? null
        : await storeClassification(database, {
          sessionId: session.id,
          userId: session.user.id,
          repoFullName,
          requestId,
          snapshotId,
          filePath: inputFileName,
          fileName: inputFileName,
          mimeType: "application/json",
          extension: "json",
          classification,
          extractedTextPreview: `${parsedRows.activities} actividades / ${parsedRows.exams} exámenes`,
          features: {
            source: "manual_form",
            bitacoraAgenda,
            rowsParsed: parsedRows.items.length,
            rowsUsed: parsedRows.items.length,
            parsedValidation: validation,
            parsedWarnings: parsedRows.warnings,
            totals: {
              activities: parsedRows.activities,
              exams: parsedRows.exams,
              withDate: parsedRows.withDate,
              withoutDate: parsedRows.withoutDate,
            },
          },
          trainingExample: {
            input: {
              fileName: inputFileName,
              filePath: inputFileName,
              textPreview: `${parsedRows.activities} actividades / ${parsedRows.exams} exámenes`,
            },
            expectedLabel: null,
            predictedLabel: classification.label,
          },
          modelUsed: false,
          modelError: "",
        });

      return res.json({
        ok: true,
        source: "manual",
        import: {
          source: "manual",
          recognized: true,
          detectedTemplate: false,
          rowsParsed: parsedRows.items.length,
          rowsUsed: parsedRows.items.length,
          warnings: [
            ...validation.warnings,
            ...parsedRows.warnings,
          ],
          bitacoraAgenda,
          summary: {
            activities: parsedRows.activities,
            exams: parsedRows.exams,
            withDate: parsedRows.withDate,
            withoutDate: parsedRows.withoutDate,
            parseWarnings: parsedRows.warnings.length + validation.warnings.length,
          },
          textPreview: compactText(
            `${parsed.activities?.length || 0} actividades | ${parsed.exams?.length || 0} exámenes`,
            2200,
          ),
        },
        classification,
        stored,
      });
    } catch (error) {
      const status = error instanceof z.ZodError ? 400 : 500;
      return res.status(status).json({ ok: false, error: errorMessage(error) });
    }
  });

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

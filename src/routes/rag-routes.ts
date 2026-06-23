import path from "node:path";
import type express from "express";
import multer from "multer";
import { z } from "zod";
import { env } from "../config/env.js";
import type { AppDatabase } from "../db/database.js";
import { extractRagDocumentText } from "../services/rag-document-processing.js";
import {
  DEFAULT_RAG_COURSE_CODE,
  RAG_COURSES,
  getRagCourse,
  normalizeRagCourseCode,
  normalizeRagCourseCodes,
  ragCourseMetadata,
} from "../services/rag-courses.js";
import { buildRagChunksForSource, mapRagSourceForApi } from "../services/rag-sources.js";
import { trimText } from "../services/text-utils.js";
import { errorMessage, resolveSession } from "./route-utils.js";

const ragUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: env.ragUploadMaxBytes },
});

const ragUploadSchema = z.object({
  title: z.string().max(260).optional(),
  description: z.string().max(1600).optional(),
  sourceType: z.string().max(80).optional(),
  repoFullName: z.string().max(240).optional(),
  courseCode: z.string().max(120).optional(),
  tags: z.string().max(600).optional(),
}).strict();

const booleanQuerySchema = z.preprocess((value) => {
  if (typeof value !== "string") return value;
  const normalized = value.trim().toLowerCase();
  return normalized === "true" || normalized === "1" || normalized === "yes";
}, z.boolean().optional());

const ragListQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(300).optional(),
  courseCode: z.string().max(120).optional(),
  allCourses: booleanQuerySchema,
}).strict();

function parseTags(value: string | undefined) {
  return trimText(value)
    .split(",")
    .map((tag) => trimText(tag))
    .filter(Boolean)
    .slice(0, 30);
}

function cleanFileName(value: string) {
  return trimText(path.basename(value || "fuente_rag"));
}

function getCoursesForUser(user: { role: string; assignedCourseCodes?: string[] }) {
  if (user.role !== "student") {
    return RAG_COURSES;
  }

  const assignedCodes = normalizeRagCourseCodes(user.assignedCourseCodes, {
    fallbackToDefault: true,
    knownOnly: true,
  });
  const assignedSet = new Set(assignedCodes);
  return RAG_COURSES.filter((course) => assignedSet.has(course.code));
}

function resolveCourseCodeForUser(
  user: { role: string; assignedCourseCodes?: string[] },
  requestedCourseCode: string | null | undefined,
) {
  const requested = normalizeRagCourseCode(requestedCourseCode || DEFAULT_RAG_COURSE_CODE);
  if (user.role !== "student") {
    return getRagCourse(requested)?.code || DEFAULT_RAG_COURSE_CODE;
  }

  const allowed = getCoursesForUser(user);
  if (allowed.some((course) => course.code === requested)) {
    return requested;
  }
  return allowed[0]?.code || DEFAULT_RAG_COURSE_CODE;
}

export function registerRagRoutes(app: express.Express, database: AppDatabase) {
  app.get("/api/rag/courses", async (req, res) => {
    try {
      const session = await resolveSession(database, req);
      if (!session) {
        return res.status(401).json({ ok: false, error: "Sesion no valida." });
      }

      return res.json({
        ok: true,
        defaultCourseCode: DEFAULT_RAG_COURSE_CODE,
        courses: getCoursesForUser(session.user),
        assignedCourseCodes: normalizeRagCourseCodes(session.user.assignedCourseCodes, {
          fallbackToDefault: session.user.role === "student",
          knownOnly: true,
        }),
      });
    } catch (error) {
      return res.status(500).json({ ok: false, error: errorMessage(error) });
    }
  });

  app.get("/api/rag/sources", async (req, res) => {
    try {
      const session = await resolveSession(database, req);
      if (!session) {
        return res.status(401).json({ ok: false, error: "Sesion no valida." });
      }

      const parsed = ragListQuerySchema.parse(req.query || {});
      const courseCode = resolveCourseCodeForUser(session.user, parsed.courseCode);
      const sources = await database.listRagSourcesForUser(session.user, parsed.limit || 100, {
        courseCode,
        includeAllCourses: (session.user.role === "teacher" || session.user.role === "admin") && parsed.allCourses === true,
      });
      return res.json({
        ok: true,
        courseCode,
        courses: getCoursesForUser(session.user),
        sources: sources.map(mapRagSourceForApi),
      });
    } catch (error) {
      const status = error instanceof z.ZodError ? 400 : 500;
      return res.status(status).json({ ok: false, error: errorMessage(error) });
    }
  });

  app.post("/api/rag/sources", ragUpload.single("file"), async (req, res) => {
    try {
      const session = await resolveSession(database, req);
      if (!session) {
        return res.status(401).json({ ok: false, error: "Sesion no valida." });
      }
      if (session.user.role !== "teacher") {
        return res.status(403).json({ ok: false, error: "Solo docentes pueden cargar fuentes RAG." });
      }

      const uploadedFile = req.file;
      if (!uploadedFile?.buffer?.length) {
        return res.status(400).json({ ok: false, error: "Archivo requerido para alimentar el RAG." });
      }

      const parsed = ragUploadSchema.parse(req.body || {});
      const courseCode = normalizeRagCourseCode(parsed.courseCode || DEFAULT_RAG_COURSE_CODE);
      const course = getRagCourse(courseCode);
      if (!course) {
        return res.status(400).json({ ok: false, error: `Curso RAG no soportado: ${courseCode}` });
      }
      const fileName = cleanFileName(uploadedFile.originalname || parsed.title || "fuente_rag");
      const extracted = await extractRagDocumentText({
        fileName,
        filePath: fileName,
        mimeType: uploadedFile.mimetype,
        extension: path.extname(fileName).replace(/^\./, "").toLowerCase(),
        buffer: uploadedFile.buffer,
        maxTextChars: env.ragMaxExtractedTextChars,
        useModel: false,
      });
      const contentText = trimText(extracted.text);

      if (!contentText) {
        return res.status(400).json({
          ok: false,
          error: "No se pudo extraer texto util del archivo RAG.",
          extraction: {
            source: extracted.source,
            mimeType: extracted.mimeType,
            extension: extracted.extension,
            bytes: extracted.bytes,
            warnings: extracted.warnings,
          },
        });
      }

      const title = trimText(parsed.title) || fileName;
      const metadata = {
        description: trimText(parsed.description),
        repoFullName: trimText(parsed.repoFullName),
        ...ragCourseMetadata(course.code),
        tags: parseTags(parsed.tags),
        originalName: uploadedFile.originalname || fileName,
        extractionSource: extracted.source,
        extension: extracted.extension,
        bytes: extracted.bytes,
        pageCount: extracted.totalPages || extracted.pages.length || null,
        truncated: extracted.truncated,
        warnings: extracted.warnings,
      };
      const chunks = buildRagChunksForSource({
        title,
        sourceType: trimText(parsed.sourceType) || extracted.source,
        fileName,
        sourceKey: fileName,
        contentText,
        metadata,
        pages: extracted.pages,
      });
      const source = await database.createTeacherRagSource({
        teacherUserId: session.user.id,
        createdByUserId: session.user.id,
        sourceKey: fileName,
        title,
        sourceType: trimText(parsed.sourceType) || extracted.source,
        fileName,
        mimeType: extracted.mimeType || trimText(uploadedFile.mimetype),
        contentText,
        metadata,
        chunks,
      });

      return res.json({
        ok: true,
        course,
        source: mapRagSourceForApi(source),
        extraction: {
          source: extracted.source,
          mimeType: extracted.mimeType,
          extension: extracted.extension,
          bytes: extracted.bytes,
          pages: extracted.totalPages || extracted.pages.length || 0,
          textLength: contentText.length,
          chunkCount: chunks.length,
          citations: chunks.slice(0, 5).map((chunk) => chunk.citationLabel),
          truncated: extracted.truncated,
          warnings: extracted.warnings,
        },
      });
    } catch (error) {
      const status = error instanceof z.ZodError ? 400 : 500;
      return res.status(status).json({ ok: false, error: errorMessage(error) });
    }
  });

  app.delete("/api/rag/sources/:id", async (req, res) => {
    try {
      const session = await resolveSession(database, req);
      if (!session) {
        return res.status(401).json({ ok: false, error: "Sesion no valida." });
      }
      if (session.user.role !== "teacher") {
        return res.status(403).json({ ok: false, error: "Solo docentes pueden desactivar fuentes RAG." });
      }

      const sourceId = trimText(req.params.id);
      if (!sourceId) {
        return res.status(400).json({ ok: false, error: "id requerido." });
      }

      const removed = await database.deactivateTeacherRagSource(sourceId, session.user.id);
      if (!removed) {
        return res.status(404).json({ ok: false, error: "Fuente RAG no encontrada para este docente." });
      }

      return res.json({ ok: true, removed: true, id: sourceId });
    } catch (error) {
      return res.status(500).json({ ok: false, error: errorMessage(error) });
    }
  });
}

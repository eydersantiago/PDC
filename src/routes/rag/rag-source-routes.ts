// Rutas de cursos y fuentes RAG: listar, ver, cargar y retirar.
import path from "node:path";
import type express from "express";
import multer from "multer";
import { z } from "zod";
import { env } from "../../config/env.js";
import type { AppDatabase } from "../../db/database.js";
import { extractRagDocumentText } from "../../services/rag/rag-document-processing.js";
import { DEFAULT_RAG_COURSE_CODE, getRagCourse, normalizeRagCourseCode, normalizeRagCourseCodes, ragCourseMetadata } from "../../services/rag/rag-courses.js";
import { mapRagSourceForApi } from "../../services/rag/rag-sources.js";
import { buildRagChunksForSource } from "../../services/rag/rag-chunks.js";
import { trimText } from "../../services/shared/text-utils.js";
import { resolveManagedTeacher } from "../bitacora/bitacora-owner.js";
import { errorMessage, isStaffRole, resolveSession } from "../route-utils.js";
import { sendRagViewerHtml, renderRagViewerMessage, ensureIndependentRagViewerSource, findViewerChunk, renderRagViewerPage, cleanFileName } from "./rag-viewer.js";
import { type RagManagerResolver, getCoursesForUser, resolveCourseCodeForUser } from "./rag-access.js";

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
  /** Lote del docente al que entra la fuente; vacio = base del curso (0.7.15). */
  lotId: z.string().max(80).optional(),
  /** Administrador (navegador 0.7.22): docente en cuyo RAG entra la fuente. */
  teacherUserId: z.string().max(120).optional(),
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
  /** Administrador: el docente cuyo RAG se lista (sin el, el docente de las cuentas nuevas). */
  teacherUserId: z.string().max(120).optional(),
}).strict();

const ragViewerQuerySchema = z.object({
  chunkId: z.string().max(260).optional(),
  page: z.coerce.number().int().min(1).max(20000).optional(),
  courseCode: z.string().max(120).optional(),
  sessionId: z.string().max(260).optional(),
}).strict();

function parseTags(value: string | undefined) {
  return trimText(value)
    .split(",")
    .map((tag) => trimText(tag))
    .filter(Boolean)
    .slice(0, 30);
}

export function registerRagSourceRoutes(app: express.Express, database: AppDatabase, requireRagManager: RagManagerResolver) {
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
      const manages = isStaffRole(session.user.role);
      // Administrador (navegador 0.7.22): el RAG del docente elegido, como lo ve ese docente.
      let viewer = session.user;
      let managedTeacherId = session.user.role === "teacher" ? session.user.id : "";
      let adminView: Record<string, unknown> | null = null;
      if (session.user.role === "admin") {
        const resolved = await resolveManagedTeacher(database, session, parsed.teacherUserId, {
          deniedMessage: "",
          fallbackToDefault: true,
          noTeachersError: "No hay docentes activos: crea uno en «Usuarios» antes de gestionar su RAG.",
          missingError: "Elige el docente dueño del RAG (teacherUserId).",
        });
        if (resolved.ok) {
          managedTeacherId = resolved.owner.id;
          viewer = { ...session.user, id: resolved.owner.id, role: "teacher", teacherUserId: null };
          adminView = { teacherUserId: resolved.owner.id, teachers: resolved.teachers || [] };
        } else {
          adminView = { teacherUserId: "", teachers: resolved.teachers || [], message: resolved.error };
        }
      }
      const sources = await database.listRagSourcesForUser(viewer, parsed.limit || 100, {
        courseCode,
        includeAllCourses: manages && parsed.allCourses === true,
        includeAllLots: manages,
      });
      const overrides = managedTeacherId ? await database.listRagSourceOverrides(managedTeacherId) : [];
      const disabled = new Set(overrides.filter((item) => item.isActive === false).map((item) => item.sourceId));
      return res.json({
        ok: true,
        ...(adminView || {}),
        courseCode,
        courses: getCoursesForUser(session.user),
        sources: sources.map((source) => ({
          ...mapRagSourceForApi(source),
          // Para el docente: si la desactivo para su curso (la fuente sigue existiendo).
          isEnabled: !disabled.has(source.id),
        })),
      });
    } catch (error) {
      const status = error instanceof z.ZodError ? 400 : 500;
      return res.status(status).json({ ok: false, error: errorMessage(error) });
    }
  });

  app.get("/api/rag/sources/:id/view", async (req, res) => {
    try {
      const parsed = ragViewerQuerySchema.parse(req.query || {});
      const sourceId = trimText(req.params.id);
      if (!sourceId) {
        return sendRagViewerHtml(res, 400, renderRagViewerMessage("Fuente invalida", "No se recibio el identificador de la fuente."));
      }

      const source = await database.getRagSourceForViewer(sourceId, {
        courseCode: parsed.courseCode,
      });
      if (!source) {
        return sendRagViewerHtml(
          res,
          404,
          renderRagViewerMessage("Fuente no encontrada", "La fuente RAG no existe, no esta activa o no coincide con el curso solicitado."),
        );
      }

      const courseCode = normalizeRagCourseCode(
        String(source.metadata.courseCode || source.metadata.course_code || parsed.courseCode || DEFAULT_RAG_COURSE_CODE),
      );
      const requestedPage = parsed.page || null;
      const viewerSource = await ensureIndependentRagViewerSource(database, source);
      const chunk = findViewerChunk(viewerSource.source, trimText(parsed.chunkId), requestedPage);
      return sendRagViewerHtml(res, 200, renderRagViewerPage({
        source: viewerSource.source,
        chunk,
        requestedPage,
        courseCode,
        notice: viewerSource.notice,
      }));
    } catch (error) {
      const status = error instanceof z.ZodError ? 400 : 500;
      return sendRagViewerHtml(
        res,
        status,
        renderRagViewerMessage("No se pudo abrir la fuente", errorMessage(error)),
      );
    }
  });

  app.post("/api/rag/sources", ragUpload.single("file"), async (req, res) => {
    try {
      const manager = await requireRagManager(req, res, "cargar fuentes RAG");
      if (!manager) return;
      const { session, teacherUserId: ownerTeacherId } = manager;

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
      const lotId = trimText(parsed.lotId);
      if (lotId) {
        const lot = await database.getRagLot(lotId);
        if (!lot || lot.teacherUserId !== ownerTeacherId || !lot.isActive || lot.courseCode !== course.code) {
          return res.status(400).json({ ok: false, error: "El lote no existe o no es de este curso." });
        }
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
        ...(lotId ? { lotId } : {}),
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
        teacherUserId: ownerTeacherId,
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
        teacherUserId: ownerTeacherId,
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
      const manager = await requireRagManager(req, res, "desactivar fuentes RAG");
      if (!manager) return;

      const sourceId = trimText(req.params.id);
      if (!sourceId) {
        return res.status(400).json({ ok: false, error: "id requerido." });
      }

      const removed = await database.deactivateTeacherRagSource(sourceId, manager.teacherUserId);
      if (!removed) {
        return res.status(404).json({ ok: false, error: "Fuente RAG no encontrada para este docente." });
      }

      return res.json({ ok: true, removed: true, id: sourceId });
    } catch (error) {
      return res.status(500).json({ ok: false, error: errorMessage(error) });
    }
  });
}

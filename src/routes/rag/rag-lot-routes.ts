// Rutas de lotes de RAG por curso: catalogo, crear, editar, retirar, activar y asignar a estudiantes.
import type express from "express";
import { z } from "zod";
import type { AppDatabase } from "../../db/database.js";
import { DEFAULT_RAG_COURSE_CODE, RAG_COURSES, getRagCourse, normalizeRagCourseCode } from "../../services/rag/rag-courses.js";
import { BASE_LOT_NAME, normalizeRagLotInput, summarizeLotsForCourse } from "../../services/rag/rag-lots.js";
import { trimText } from "../../services/shared/text-utils.js";
import { errorMessage } from "../route-utils.js";
import { type RagManagerResolver } from "./rag-access.js";

const ragLotBodySchema = z.object({
  courseCode: z.string().max(120).optional(),
  name: z.string().max(200).optional(),
  description: z.string().max(1000).optional(),
  includesBase: z.union([z.boolean(), z.string().max(10)]).optional(),
  teacherUserId: z.string().max(120).optional(),
}).strict();

const ragActiveLotBodySchema = z.object({
  lotId: z.string().max(80).nullable().optional(),
  teacherUserId: z.string().max(120).optional(),
}).strict();

const ragSourceActiveBodySchema = z.object({
  isActive: z.boolean(),
  teacherUserId: z.string().max(120).optional(),
}).strict();

const ragStudentLotBodySchema = z.object({
  courseCode: z.string().max(120),
  lotId: z.string().max(80).nullable().optional(),
  teacherUserId: z.string().max(120).optional(),
}).strict();

export function registerRagLotRoutes(app: express.Express, database: AppDatabase, requireRagManager: RagManagerResolver) {
  // ---- Lotes de RAG por curso (0.7.15) ----

  /** Catalogo de lotes del docente: por curso, la base, los lotes y cual esta activo. */
  async function buildRagLotCatalog(teacherUserId: string, requestedCourseCode?: string) {
    const [lots, overrides, activeLots, sources] = await Promise.all([
      database.listRagLots(teacherUserId),
      database.listRagSourceOverrides(teacherUserId),
      database.listActiveRagLots(teacherUserId),
      database.listRagSourcesForUser({ id: teacherUserId, role: "teacher" } as never, 300, {
        includeAllCourses: true,
        includeAllLots: true,
        includeReferenceOnly: true,
      }),
    ]);
    const requested = trimText(requestedCourseCode) ? normalizeRagCourseCode(requestedCourseCode) : "";
    const courses = RAG_COURSES
      .filter((course) => !requested || course.code === requested)
      .map((course) => {
        const summary = summarizeLotsForCourse({
          courseCode: course.code,
          lots,
          sources,
          overrides,
          activeLotId: activeLots[course.code] || null,
        });
        return {
          courseCode: course.code,
          courseName: course.name,
          courseShortName: course.shortName,
          activeLotId: summary.activeLotId,
          activeLotName: summary.activeLotName,
          base: summary.base,
          lots: summary.lots,
        };
      });
    return {
      baseLotName: BASE_LOT_NAME,
      courses,
      disabledSourceIds: overrides.filter((item) => item.isActive === false).map((item) => item.sourceId),
    };
  }

  app.get("/api/rag/lots", async (req, res) => {
    try {
      const manager = await requireRagManager(req, res, "administrar lotes de RAG", { fallbackToDefault: true });
      if (!manager) return;
      const courseCode = typeof req.query.courseCode === "string" ? req.query.courseCode : "";
      if (courseCode && !getRagCourse(normalizeRagCourseCode(courseCode))) {
        return res.status(400).json({ ok: false, error: `Curso RAG no soportado: ${courseCode}` });
      }
      const catalog = await buildRagLotCatalog(manager.teacherUserId, courseCode);
      return res.json({ ok: true, ...(manager.teachers ? { teacherUserId: manager.teacherUserId } : {}), ...catalog });
    } catch (error) {
      return res.status(500).json({ ok: false, error: errorMessage(error) });
    }
  });

  app.post("/api/rag/lots", async (req, res) => {
    try {
      const manager = await requireRagManager(req, res, "crear lotes de RAG");
      if (!manager) return;
      const ownerTeacherId = manager.teacherUserId;
      const parsed = ragLotBodySchema.parse(req.body || {});
      const courseCode = normalizeRagCourseCode(parsed.courseCode || DEFAULT_RAG_COURSE_CODE);
      if (!getRagCourse(courseCode)) {
        return res.status(400).json({ ok: false, error: `Curso RAG no soportado: ${courseCode}` });
      }
      const input = normalizeRagLotInput(parsed);
      const lot = await database.createRagLot({ teacherUserId: ownerTeacherId, courseCode, ...input });
      return res.status(201).json({ ok: true, lot, catalog: await buildRagLotCatalog(ownerTeacherId) });
    } catch (error) {
      const status = error instanceof z.ZodError || /nombre/i.test(errorMessage(error)) ? 400 : 500;
      return res.status(status).json({ ok: false, error: errorMessage(error) });
    }
  });

  app.put("/api/rag/lots/:id", async (req, res) => {
    try {
      const manager = await requireRagManager(req, res, "editar lotes de RAG");
      if (!manager) return;
      const ownerTeacherId = manager.teacherUserId;
      const parsed = ragLotBodySchema.parse(req.body || {});
      const current = await database.getRagLot(trimText(req.params.id));
      if (!current || current.teacherUserId !== ownerTeacherId || !current.isActive) {
        return res.status(404).json({ ok: false, error: "Lote no encontrado para este docente." });
      }
      const input = normalizeRagLotInput({
        name: parsed.name === undefined ? current.name : parsed.name,
        description: parsed.description === undefined ? current.description : parsed.description,
        includesBase: parsed.includesBase === undefined ? current.includesBase : parsed.includesBase,
      });
      const lot = await database.updateRagLot(current.id, ownerTeacherId, input);
      return res.json({ ok: true, lot, catalog: await buildRagLotCatalog(ownerTeacherId) });
    } catch (error) {
      const status = error instanceof z.ZodError || /nombre/i.test(errorMessage(error)) ? 400 : 500;
      return res.status(status).json({ ok: false, error: errorMessage(error) });
    }
  });

  app.delete("/api/rag/lots/:id", async (req, res) => {
    try {
      const manager = await requireRagManager(req, res, "retirar lotes de RAG");
      if (!manager) return;
      const retired = await database.retireRagLot(trimText(req.params.id), manager.teacherUserId);
      if (!retired) {
        return res.status(404).json({ ok: false, error: "Lote no encontrado para este docente." });
      }
      return res.json({ ok: true, removed: true, id: trimText(req.params.id), catalog: await buildRagLotCatalog(manager.teacherUserId) });
    } catch (error) {
      return res.status(500).json({ ok: false, error: errorMessage(error) });
    }
  });

  app.put("/api/rag/courses/:courseCode/active-lot", async (req, res) => {
    try {
      const manager = await requireRagManager(req, res, "activar lotes de RAG");
      if (!manager) return;
      const courseCode = normalizeRagCourseCode(req.params.courseCode);
      if (!getRagCourse(courseCode)) {
        return res.status(400).json({ ok: false, error: `Curso RAG no soportado: ${req.params.courseCode}` });
      }
      const parsed = ragActiveLotBodySchema.parse(req.body || {});
      const activeLotId = await database.setActiveRagLot(manager.teacherUserId, courseCode, parsed.lotId ?? null);
      return res.json({ ok: true, courseCode, activeLotId, catalog: await buildRagLotCatalog(manager.teacherUserId) });
    } catch (error) {
      const status = error instanceof z.ZodError || /lote no existe/i.test(errorMessage(error)) ? 400 : 500;
      return res.status(status).json({ ok: false, error: errorMessage(error) });
    }
  });

  app.put("/api/rag/sources/:id/active", async (req, res) => {
    try {
      const manager = await requireRagManager(req, res, "activar o desactivar fuentes RAG");
      if (!manager) return;
      const parsed = ragSourceActiveBodySchema.parse(req.body || {});
      const sourceId = trimText(req.params.id);
      const changed = await database.setRagSourceOverride(manager.teacherUserId, sourceId, parsed.isActive);
      if (!changed) {
        return res.status(404).json({ ok: false, error: "Fuente RAG no encontrada." });
      }
      return res.json({ ok: true, id: sourceId, isEnabled: parsed.isActive });
    } catch (error) {
      const status = error instanceof z.ZodError ? 400 : 500;
      return res.status(status).json({ ok: false, error: errorMessage(error) });
    }
  });

  app.put("/api/rag/students/:studentUserId/lot", async (req, res) => {
    try {
      const manager = await requireRagManager(req, res, "asignar lotes de RAG a estudiantes");
      if (!manager) return;
      const parsed = ragStudentLotBodySchema.parse(req.body || {});
      const courseCode = normalizeRagCourseCode(parsed.courseCode);
      if (!getRagCourse(courseCode)) {
        return res.status(400).json({ ok: false, error: `Curso RAG no soportado: ${parsed.courseCode}` });
      }
      const lotId = await database.setStudentRagLot({
        studentUserId: trimText(req.params.studentUserId),
        courseCode,
        lotId: parsed.lotId ?? null,
        teacherUserId: manager.teacherUserId,
      });
      const effective = await database.resolveRagLotForUser(
        await database.getActiveUserById(trimText(req.params.studentUserId)),
        courseCode,
      );
      return res.json({
        ok: true,
        studentUserId: trimText(req.params.studentUserId),
        courseCode,
        lotId,
        applied: { lotId: effective.lotId, lotName: effective.name, origin: effective.origin },
      });
    } catch (error) {
      const message = errorMessage(error);
      const status = error instanceof z.ZodError || /no esta asignado|lote no existe/i.test(message) ? 400 : 500;
      return res.status(status).json({ ok: false, error: message });
    }
  });
}

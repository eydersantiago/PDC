import type express from "express";
import type { AppDatabase } from "../db/database.js";
import {
  buildStudentProgressSummaries,
  buildTimeline,
  canViewStudentProgress,
  toStudentQuizItem,
  type StudentProgressDetail,
} from "../services/student-progress.js";
import { trimText } from "../services/text-utils.js";
import { boundedInteger, errorMessage, resolveSession } from "./route-utils.js";

/**
 * Panel "Estudiantes" del overlay (docente y administrador):
 *
 *   GET /api/admin/students          lista con sesiones, intervenciones, quices y nota
 *   GET /api/admin/students/:userId  detalle: sesiones, intervenciones, quices, actividad y linea de tiempo
 *
 * El docente solo ve a sus estudiantes (los de listManagedUsers); el
 * administrador, a todos. Un estudiante fuera de ese alcance responde 404,
 * no 403, para no confirmar que existe. Nunca salen ids de sesion.
 */
export function registerStudentProgressRoutes(app: express.Express, database: AppDatabase) {
  async function requireViewer(req: express.Request, res: express.Response) {
    const session = await resolveSession(database, req).catch(() => null);
    if (!session) {
      res.status(401).json({ ok: false, error: "Sesion no valida." });
      return null;
    }
    if (!canViewStudentProgress(session.user)) {
      res.status(403).json({ ok: false, error: "Solo docentes o administradores pueden ver el progreso de los estudiantes." });
      return null;
    }
    return session;
  }

  app.get("/api/admin/students", async (req, res) => {
    try {
      const session = await requireViewer(req, res);
      if (!session) return;
      const rows = await database.listStudentProgressRows(session.user);
      const { students, totals } = buildStudentProgressSummaries(rows);
      return res.json({
        ok: true,
        generatedAt: new Date().toISOString(),
        viewerRole: session.user.role,
        totals,
        students,
      });
    } catch (error) {
      return res.status(500).json({ ok: false, error: errorMessage(error) });
    }
  });

  app.get("/api/admin/students/:userId", async (req, res) => {
    try {
      const session = await requireViewer(req, res);
      if (!session) return;
      const studentUserId = trimText(req.params.userId);
      if (!studentUserId) {
        return res.status(400).json({ ok: false, error: "userId requerido." });
      }
      const rows = await database.listStudentProgressRows(session.user);
      const { students } = buildStudentProgressSummaries(rows);
      const student = students.find((item) => item.id === studentUserId);
      if (!student) {
        return res.status(404).json({ ok: false, error: "Estudiante no encontrado." });
      }
      const limit = boundedInteger(req.query.limit, 30, 1, 200);
      const detailRows = await database.getStudentProgressDetailRows(session.user, studentUserId, limit);
      const quizzes = detailRows.quizzes.map(toStudentQuizItem);
      const detail: StudentProgressDetail = {
        student,
        sessions: detailRows.sessions,
        interventions: detailRows.interventions,
        quizzes,
        activity: detailRows.activity.map((item) => ({
          category: item.category,
          eventType: item.eventType,
          source: item.source,
          totalEvents: item.totalEvents,
          totalCount: item.totalCount,
          totalDurationMs: item.totalDurationMs,
          lastOccurredAt: item.lastOccurredAt,
        })),
        exercises: detailRows.exercises,
        timeline: buildTimeline({
          sessions: detailRows.sessions,
          interventions: detailRows.interventions,
          quizzes,
        }),
      };
      return res.json({ ok: true, generatedAt: new Date().toISOString(), ...detail });
    } catch (error) {
      return res.status(500).json({ ok: false, error: errorMessage(error) });
    }
  });
}

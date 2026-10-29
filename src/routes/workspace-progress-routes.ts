// Avance de los estudiantes en los talleres (src/services/workshop-progress.ts, 29-10-2026):
//
//   POST /api/workspaces/progress-report   la VM de editores (avance-ws.py), con el token del agente
//   GET  /api/admin/workshop-progress      docente (sus estudiantes) o administrador (todos, o los de
//        ?taller=<slug>&teacherUserId=<id>  un docente con teacherUserId); sin taller, el mas reciente
//
// Nunca pasa codigo: la VM manda por login de GitHub el porcentaje, los puntos que faltan, si
// compila y la fecha del ultimo cambio.
import type express from "express";
import type { AppDatabase } from "../db/database.js";
import { trimText } from "../services/text-utils.js";
import {
  buildWorkshopProgressView,
  listWorkshops,
  progressReportSchema,
  readProgressReport,
  saveProgressReport,
} from "../services/workshop-progress.js";
import { errorMessage, resolveSession } from "./route-utils.js";

export function registerWorkspaceProgressRoutes(
  app: express.Express,
  database: AppDatabase,
  agentAuthorized: (req: express.Request) => boolean,
) {
  app.post("/api/workspaces/progress-report", async (req, res) => {
    if (!agentAuthorized(req)) return res.status(401).json({ ok: false, error: "Token del agente invalido." });
    const parsed = progressReportSchema.safeParse(req.body || {});
    if (!parsed.success) return res.status(400).json({ ok: false, error: "Informe de avance invalido." });
    try {
      const report = await saveProgressReport(database, parsed.data);
      return res.json({ ok: true, receivedAt: report.receivedAt, students: report.students.length });
    } catch (error) {
      return res.status(500).json({ ok: false, error: errorMessage(error) });
    }
  });

  app.get("/api/admin/workshop-progress", async (req, res) => {
    try {
      const session = await resolveSession(database, req).catch(() => null);
      if (!session) return res.status(401).json({ ok: false, error: "Sesion no valida." });
      if (session.user.role !== "admin" && session.user.role !== "teacher") {
        return res.status(403).json({ ok: false, error: "Solo docentes o administradores." });
      }
      const taller = typeof req.query.taller === "string" ? trimText(req.query.taller).toLowerCase() : "";
      const [report, workshops] = await Promise.all([readProgressReport(database, taller), listWorkshops(database)]);
      const talleres = workshops.map((item) => ({ taller: item.taller, titulo: item.titulo }));
      if (!report) return res.json({ ok: true, viewerRole: session.user.role, talleres, avance: null });

      // El administrador puede mirar el grupo de un docente (como el monitor del piloto): se
      // consulta con el alcance de ese docente. Un id que no es docente da la lista vacia.
      const teacherUserId = session.user.role === "admin" && typeof req.query.teacherUserId === "string"
        ? trimText(req.query.teacherUserId).slice(0, 80)
        : "";
      const students = await database.listStudentGithubLogins(
        teacherUserId ? { ...session.user, id: teacherUserId, role: "teacher" } : session.user,
      );
      const view = buildWorkshopProgressView(report, students);
      // Logins de la VM sin estudiante en la base: solo el administrador (son cuentas de GitHub).
      const known = new Set(students.map((student) => student.githubLogin).filter(Boolean));
      const unlinked = session.user.role === "admin" && !teacherUserId
        ? report.students.filter((entry) => entry.started && !known.has(entry.login)).map((entry) => ({ login: entry.login, percent: entry.percent }))
        : [];
      return res.json({ ok: true, viewerRole: session.user.role, talleres, avance: { ...view, unlinked } });
    } catch (error) {
      return res.status(500).json({ ok: false, error: errorMessage(error) });
    }
  });
}

// Informe de la copia de respaldo de la VM de editores (src/services/workspace-backup.ts):
//
//   POST /api/workspaces/backup-report   el agente de la VM, con su token (x-agent-token)
//   GET  /api/admin/workspace-backup     administrador o docente: el ultimo informe completo
import type express from "express";
import type { AppDatabase } from "../db/database.js";
import { backupReportSchema, readBackupReport, saveBackupReport } from "../services/workspace-backup.js";
import { errorMessage, resolveSession } from "./route-utils.js";

export function registerWorkspaceBackupRoutes(
  app: express.Express,
  database: AppDatabase,
  agentAuthorized: (req: express.Request) => boolean,
) {
  app.post("/api/workspaces/backup-report", async (req, res) => {
    if (!agentAuthorized(req)) return res.status(401).json({ ok: false, error: "Token del agente invalido." });
    const parsed = backupReportSchema.safeParse(req.body || {});
    if (!parsed.success) return res.status(400).json({ ok: false, error: "Informe de respaldo invalido." });
    try {
      const report = await saveBackupReport(database, parsed.data);
      return res.json({ ok: true, receivedAt: report.receivedAt });
    } catch (error) {
      return res.status(500).json({ ok: false, error: errorMessage(error) });
    }
  });

  app.get("/api/admin/workspace-backup", async (req, res) => {
    const session = await resolveSession(database, req).catch(() => null);
    if (!session) return res.status(401).json({ ok: false, error: "Sesion no valida." });
    if (session.user.role !== "admin" && session.user.role !== "teacher") {
      return res.status(403).json({ ok: false, error: "Solo docentes o administradores." });
    }
    return res.json({ ok: true, report: await readBackupReport(database) });
  });
}

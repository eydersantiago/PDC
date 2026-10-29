// Aviso «Estamos actualizando» (src/services/maintenance.ts):
//
//   GET /api/maintenance         publico: si esta encendido, el mensaje y hasta cuando
//   PUT /api/admin/maintenance   solo administrador: { active, message?, minutes? }
import type express from "express";
import { z } from "zod";
import type { AppDatabase } from "../db/database.js";
import { MAX_MAINTENANCE_MINUTES, readMaintenance, setMaintenance } from "../services/maintenance.js";
import { errorMessage, resolveSession } from "./route-utils.js";

const maintenanceSchema = z.object({
  active: z.boolean(),
  message: z.string().max(400).optional(),
  minutes: z.number().int().min(1).max(MAX_MAINTENANCE_MINUTES).optional(),
});

export function registerMaintenanceRoutes(app: express.Express, database: AppDatabase) {
  app.get("/api/maintenance", async (_req, res) => {
    const notice = await readMaintenance(database);
    res.setHeader("Cache-Control", "no-store");
    return res.json({ ok: true, active: notice.active, message: notice.active ? notice.message : null, until: notice.active ? notice.until : null });
  });

  app.put("/api/admin/maintenance", async (req, res) => {
    try {
      const session = await resolveSession(database, req).catch(() => null);
      if (!session) return res.status(401).json({ ok: false, error: "Sesion no valida." });
      if (session.user.role !== "admin") return res.status(403).json({ ok: false, error: "Solo el administrador enciende o apaga el aviso de actualizacion." });
      const parsed = maintenanceSchema.safeParse(req.body || {});
      if (!parsed.success) return res.status(400).json({ ok: false, error: `Datos invalidos: usa active (true o false), message y minutes (1 a ${MAX_MAINTENANCE_MINUTES}).` });
      const notice = await setMaintenance(database, { ...parsed.data, user: { id: session.user.id, displayName: session.user.displayName } });
      return res.json({ ok: true, ...notice });
    } catch (error) {
      return res.status(500).json({ ok: false, error: errorMessage(error) });
    }
  });
}

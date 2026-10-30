// Analitica de aprendizaje (29-10-2026, src/services/learning-analytics.ts):
//
//   GET  /api/analytics/workshop-progress/export   docente (su grupo) o administrador (todos): la historia
//        ?taller=<slug>&since=&until=               del avance en CSV con seudonimos (layout=fotos, una fila por
//        &layout=fotos|puntos|definiciones          foto; puntos, una por foto y punto; definiciones, los puntos)
//   POST /api/admin/pseudonyms/resolve { code }    «¿Quien es este codigo?»: nombre y codigo estudiantil de UN
//                                                  seudonimo, dentro del alcance del visor, registrado y con tope
//
// El exporte nunca lleva nombres, correos, logins ni codigos estudiantiles; la reidentificacion solo
// pasa aqui, de a uno (docs/piloto/consentimiento.md: la lista nombre <-> cuenta no se exporta).
import type express from "express";
import type { AppDatabase } from "../db/database.js";
import {
  PSEUDONYM_LOOKUPS_PER_HOUR,
  pointDefinitionsToCsv,
  resolvePseudonym,
  snapshotPointsToCsv,
  snapshotsToCsv,
} from "../services/learning-analytics.js";
import { pseudonymize } from "../services/telemetry.js";
import { trimText } from "../services/text-utils.js";
import { readProgressReport } from "../services/workshop-progress.js";
import { boundedInteger, errorMessage, resolveSession } from "./route-utils.js";

const SLUG = /^[a-z0-9][a-z0-9-]{0,63}$/;

export function registerLearningAnalyticsRoutes(app: express.Express, database: AppDatabase) {
  async function requireAnalyst(req: express.Request, res: express.Response) {
    const session = await resolveSession(database, req).catch(() => null);
    if (!session) {
      res.status(401).json({ ok: false, error: "Sesion no valida." });
      return null;
    }
    if (session.user.role !== "teacher" && session.user.role !== "admin") {
      res.status(403).json({ ok: false, error: "Solo docentes o administradores." });
      return null;
    }
    return session;
  }

  app.get("/api/analytics/workshop-progress/export", async (req, res) => {
    try {
      const session = await requireAnalyst(req, res);
      if (!session) return;
      const taller = typeof req.query.taller === "string" ? trimText(req.query.taller).toLowerCase() : "";
      if (taller && !SLUG.test(taller)) return res.status(400).json({ ok: false, error: "Taller invalido." });
      const since = typeof req.query.since === "string" ? req.query.since : "";
      const until = typeof req.query.until === "string" ? req.query.until : "";
      for (const value of [since, until]) {
        if (value && Number.isNaN(Date.parse(value))) return res.status(400).json({ ok: false, error: `Fecha invalida: ${value}` });
      }
      const layout = String(req.query.layout || "fotos").toLowerCase();
      let csv = "";
      if (layout === "definiciones") {
        csv = pointDefinitionsToCsv(await readProgressReport(database, taller));
      } else {
        const rows = await database.listWorkshopSnapshots({
          taller,
          since,
          until,
          // El docente solo exporta su grupo (el mismo seudonimo de docente que la telemetria).
          teacherAnonId: session.user.role === "teacher" ? pseudonymize(`user:${session.user.id}`) : "",
          limit: boundedInteger(req.query.limit, 200_000, 1, 200_000),
        });
        csv = layout === "puntos" ? snapshotPointsToCsv(rows) : snapshotsToCsv(rows);
      }
      const name = `avance-${taller || "talleres"}-${layout === "puntos" || layout === "definiciones" ? layout : "fotos"}.csv`;
      res.setHeader("Content-Type", "text/csv; charset=utf-8");
      res.setHeader("Content-Disposition", `attachment; filename="${name}"`);
      res.setHeader("Cache-Control", "no-store");
      return res.send(csv);
    } catch (error) {
      return res.status(500).json({ ok: false, error: errorMessage(error) });
    }
  });

  app.post("/api/admin/pseudonyms/resolve", async (req, res) => {
    try {
      const session = await requireAnalyst(req, res);
      if (!session) return;
      res.setHeader("Cache-Control", "no-store");
      const result = await resolvePseudonym(database, session.user, req.body?.code);
      if (result.status === "invalid") {
        return res.status(400).json({ ok: false, error: "El codigo del analisis tiene 20 caracteres (0-9 y a-f)." });
      }
      if (result.status === "limit") {
        res.setHeader("Retry-After", String(result.retryAfterMinutes * 60));
        return res.status(429).json({
          ok: false,
          error: `Llegaste al tope de ${PSEUDONYM_LOOKUPS_PER_HOUR} consultas por hora. Intenta mas tarde.`,
        });
      }
      if (result.status === "not_found") {
        return res.json({
          ok: true,
          found: false,
          message: session.user.role === "teacher"
            ? "Ese codigo no es de ninguno de tus estudiantes."
            : "Ese codigo no es de ningun estudiante (o es de un cliente sin sesion, que no se puede reidentificar).",
        });
      }
      return res.json({ ok: true, found: true, student: result.student });
    } catch (error) {
      return res.status(500).json({ ok: false, error: errorMessage(error) });
    }
  });
}

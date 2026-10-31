// Analitica de aprendizaje (29-10-2026, src/services/learning-analytics.ts):
//
//   GET  /api/analytics/workshop-progress/export   docente (su grupo) o administrador (todos): la historia
//        ?taller=<slug>&since=&until=               del avance en CSV con seudonimos (layout=fotos, una fila por
//        &layout=fotos|puntos|definiciones          foto; puntos, una por foto y punto; definiciones, los puntos)
//   POST /api/admin/pseudonyms/resolve { code }    «¿Quien es este codigo?»: de UN codigo del analisis al nombre y
//                                                  el codigo estudiantil, o de UN codigo estudiantil al nombre y el
//                                                  codigo del analisis; dentro del alcance, registrado y con tope
//
// El exporte nunca lleva nombres, correos, logins ni codigos estudiantiles; la reidentificacion solo
// pasa aqui, de a uno (docs/piloto/consentimiento.md: la lista nombre <-> cuenta no se exporta). Las
// cuentas de muestra (claves compartidas con quienes prueban) no exportan ni reidentifican.
import type express from "express";
import type { AppDatabase } from "../db/database.js";
import {
  PSEUDONYM_LOOKUPS_PER_HOUR,
  canUseAnalytics,
  pointDefinitionsToCsv,
  resolvePseudonym,
  snapshotPointsToCsv,
  snapshotsToCsv,
} from "../services/learning-analytics.js";
import { userPseudonym } from "../services/telemetry.js";
import { trimText } from "../services/text-utils.js";
import { WORKSHOP_SLUG, readProgressReport } from "../services/workshop-progress.js";
import { boundedInteger, errorMessage, resolveSession } from "./route-utils.js";

/** AAAA-MM-DD, con hora opcional (y zona): lo que PostgreSQL entiende igual que Date.parse. */
const ISO_DATE = /^\d{4}-\d{2}-\d{2}([T ]\d{2}:\d{2}(:\d{2}(\.\d{1,6})?)?(Z|[+-]\d{2}:?\d{2})?)?$/;

function isoParam(value: unknown): string | null {
  if (typeof value !== "string" || !value) return "";
  if (!ISO_DATE.test(value) || Number.isNaN(Date.parse(value))) return null;
  return new Date(value).toISOString();
}

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
    if (!canUseAnalytics(session.user)) {
      res.status(403).json({ ok: false, error: "Las cuentas de muestra no exportan ni reidentifican estudiantes." });
      return null;
    }
    return session;
  }

  app.get("/api/analytics/workshop-progress/export", async (req, res) => {
    try {
      const session = await requireAnalyst(req, res);
      if (!session) return;
      const taller = typeof req.query.taller === "string" ? trimText(req.query.taller).toLowerCase() : "";
      if (taller && !WORKSHOP_SLUG.test(taller)) return res.status(400).json({ ok: false, error: "Taller invalido." });
      const since = isoParam(req.query.since);
      const until = isoParam(req.query.until);
      if (since === null || until === null) {
        return res.status(400).json({ ok: false, error: "Fecha invalida: usa AAAA-MM-DD (con hora opcional, por ejemplo 2026-10-29T08:00)." });
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
          teacherAnonId: session.user.role === "teacher" ? userPseudonym(session.user.id) : "",
          // Por punto multiplica las filas (fotos x puntos): menos fotos por pedido.
          limit: layout === "puntos" ? boundedInteger(req.query.limit, 50_000, 1, 50_000) : boundedInteger(req.query.limit, 200_000, 1, 200_000),
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
      if (result.status === "forbidden") {
        return res.status(403).json({ ok: false, error: "Las cuentas de muestra no reidentifican estudiantes." });
      }
      if (result.status === "invalid") {
        return res.status(400).json({ ok: false, error: "Escribe un codigo del analisis (20 caracteres, 0-9 y a-f) o un codigo estudiantil (7 digitos)." });
      }
      if (result.status === "limit") {
        res.setHeader("Retry-After", String(result.retryAfterMinutes * 60));
        return res.status(429).json({
          ok: false,
          error: `Llegaste al tope de ${PSEUDONYM_LOOKUPS_PER_HOUR} consultas por hora. Intenta mas tarde.`,
        });
      }
      if (result.status === "not_found") {
        const teacher = session.user.role === "teacher";
        return res.json({
          ok: true,
          found: false,
          direction: result.direction,
          message: result.direction === "estudiante"
            ? (teacher ? "Ese codigo estudiantil no es de ninguno de tus estudiantes." : "Ningun estudiante tiene ese codigo estudiantil.")
            : (teacher
              ? "Ese codigo no es de ninguno de tus estudiantes."
              : "Ese codigo no es de ningun estudiante (o es de un cliente sin sesion, que no se puede reidentificar)."),
        });
      }
      return res.json({ ok: true, found: true, direction: result.direction, student: result.student });
    } catch (error) {
      return res.status(500).json({ ok: false, error: errorMessage(error) });
    }
  });
}

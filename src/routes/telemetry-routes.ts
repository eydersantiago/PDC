import type express from "express";
import type { AppDatabase } from "../db/database.js";
import { analyzeTelemetryDataset, toCsv, toJsonl } from "../services/telemetry.js";
import { EVENT_CATALOG, FIELD_DICTIONARY, QUALITY_RULES } from "../services/telemetry-catalog.js";
import { boundedInteger, errorMessage, resolveSession } from "./route-utils.js";

/**
 * Exportacion del dataset seudonimizado y revision de calidad (A7.2, A7.6).
 * Solo docentes y administradores. La exportacion nunca incluye ids en
 * claro, correos, rutas ni textos: salen las columnas del diccionario.
 */
export function registerTelemetryRoutes(app: express.Express, database: AppDatabase) {
  async function requireAnalyst(req: express.Request, res: express.Response) {
    const session = await resolveSession(database, req).catch(() => null);
    if (!session || (session.user.role !== "teacher" && session.user.role !== "admin")) {
      res.status(403).json({ ok: false, error: "Solo docentes o administradores pueden exportar la telemetria." });
      return null;
    }
    return session;
  }

  function range(req: express.Request) {
    const since = typeof req.query.since === "string" ? req.query.since : undefined;
    const until = typeof req.query.until === "string" ? req.query.until : undefined;
    for (const value of [since, until]) {
      if (value && Number.isNaN(Date.parse(value))) {
        throw new Error(`Fecha invalida: ${value}`);
      }
    }
    return { since, until, limit: boundedInteger(req.query.limit, 50_000, 1, 200_000) };
  }

  app.get("/api/telemetry/export", async (req, res) => {
    try {
      if (!(await requireAnalyst(req, res))) return;
      const rows = await database.listTelemetryEvents(range(req));
      const format = String(req.query.format || "jsonl").toLowerCase();
      if (format === "csv") {
        res.setHeader("Content-Type", "text/csv; charset=utf-8");
        res.setHeader("Content-Disposition", "attachment; filename=\"telemetria-adaceen.csv\"");
        return res.send(toCsv(rows));
      }
      res.setHeader("Content-Type", "application/x-ndjson; charset=utf-8");
      res.setHeader("Content-Disposition", "attachment; filename=\"telemetria-adaceen.jsonl\"");
      return res.send(toJsonl(rows));
    } catch (error) {
      return res.status(400).json({ ok: false, error: errorMessage(error) });
    }
  });

  app.get("/api/telemetry/quality", async (req, res) => {
    try {
      if (!(await requireAnalyst(req, res))) return;
      const rows = await database.listTelemetryEvents(range(req));
      return res.json({ ok: true, report: analyzeTelemetryDataset(rows), rules: QUALITY_RULES });
    } catch (error) {
      return res.status(400).json({ ok: false, error: errorMessage(error) });
    }
  });

  /** Catalogo y diccionario publicos: no tienen datos, solo definiciones. */
  app.get("/api/telemetry/catalog", (_req, res) => {
    return res.json({ ok: true, schemaVersion: "1.1", events: EVENT_CATALOG, fields: FIELD_DICTIONARY, rules: QUALITY_RULES });
  });
}

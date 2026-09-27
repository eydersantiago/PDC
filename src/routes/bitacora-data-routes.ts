// Rutas de la bitacora: estado, exportar (Excel/CSV) y borrar.
// Movido sin cambios desde src/routes/document-routes.ts (solo se agrego "export" y los imports).
import { z } from "zod";
import express from "express";
import type { AppDatabase } from "../db/database.js";
import { buildBitacoraCsv, buildBitacoraExportFileName, buildBitacoraExportRows } from "../services/bitacora-export.js";
import { BITACORA_TEMPLATE_DEFAULTS, buildBitacoraWorkbook } from "../services/bitacora-template.js";
import type { BitacoraAgendaItem } from "../services/document-classifier.js";
import { toIso } from "../services/project-context.js";
import { trimText } from "../services/text-utils.js";
import { mapStoredClassification } from "./document-classifications.js";
import type { StoredClassificationRow } from "./document-classifications.js";
import { errorMessage, resolveSession } from "./route-utils.js";

export const bitacoraExportQuerySchema = z.object({
  format: z.enum(["xlsx", "csv"]).optional(),
  courseName: z.string().max(240).optional(),
  courseCode: z.string().max(120).optional(),
  group: z.string().max(120).optional(),
  academicPeriod: z.string().max(120).optional(),
}).strict();

export function mapDeletedBitacoraRow(row: { id: string; file_name: string; file_path: string; updated_at: string | Date }) {
  return {
    id: row.id,
    fileName: row.file_name,
    filePath: row.file_path,
    updatedAt: toIso(row.updated_at),
  };
}

// Bitacora: estado, exportar y borrar.
export function registerBitacoraDataRoutes(app: express.Express, database: AppDatabase) {
  app.get("/api/documents/bitacora/status", async (req, res) => {
    try {
      const session = await resolveSession(database, req);
      if (!session) {
        return res.status(401).json({ ok: false, error: "Sesion no valida." });
      }
      const bitacoraOwnerUserId = session.user.role === "teacher"
        ? session.user.id
        : trimText(session.user.teacherUserId || "");
      if (!bitacoraOwnerUserId) {
        return res.json({
          ok: true,
          loaded: false,
          latest: null,
          summary: null,
          message: "No hay docente asignado para consultar bitacora.",
        });
      }

      const result = await database.pool.query<StoredClassificationRow>(
        `
        select
          id,
          repo_full_name,
          request_id,
          snapshot_id,
          file_path,
          file_name,
          mime_type,
          extension,
          label,
          confidence,
          method,
          evidence,
          reason,
          extracted_text_preview,
          features,
          model_used,
          model_error,
          classified_at,
          updated_at
        from project_document_classifications
        where user_id = $1
          and label = 'BITACORA'
        order by updated_at desc, classified_at desc
        limit 1
        `,
        [bitacoraOwnerUserId],
      );

      const latest = result.rows[0] ? mapStoredClassification(result.rows[0]) : null;
      const latestAgenda = latest?.bitacoraAgenda as { items?: unknown[] } | null | undefined;
      const agendaItems = Array.isArray(latestAgenda?.items)
        ? latestAgenda.items
        : [];

      return res.json({
        ok: true,
        loaded: Boolean(latest),
        latest,
        summary: latest
          ? {
            fileName: latest.fileName,
            label: latest.label,
            confidence: latest.confidence,
            rows: agendaItems.length,
            classifiedAt: latest.classifiedAt,
            updatedAt: latest.updatedAt,
          }
          : null,
      });
    } catch (error) {
      return res.status(500).json({ ok: false, error: errorMessage(error) });
    }
  });

  /**
   * Exporta la bitacora cargada (0.7.15) con el diseno de la plantilla: xlsx (se
   * puede volver a importar) o csv con «;» y BOM para Excel y Power BI.
   */
  app.get("/api/documents/bitacora/export", async (req, res) => {
    try {
      const session = await resolveSession(database, req);
      if (!session) {
        return res.status(401).json({ ok: false, error: "Sesion no valida." });
      }
      if (session.user.role !== "teacher") {
        return res.status(403).json({ ok: false, error: "Solo docentes pueden exportar su bitacora." });
      }
      const parsed = bitacoraExportQuerySchema.parse(req.query || {});
      const format = parsed.format || "xlsx";
      const result = await database.pool.query<StoredClassificationRow>(
        `
        select
          id, repo_full_name, request_id, snapshot_id, file_path, file_name, mime_type, extension,
          label, confidence, method, evidence, reason, extracted_text_preview, features,
          model_used, model_error, classified_at, updated_at
        from project_document_classifications
        where user_id = $1
          and label = 'BITACORA'
        order by updated_at desc, classified_at desc
        limit 1
        `,
        [session.user.id],
      );
      const latest = result.rows[0] ? mapStoredClassification(result.rows[0]) : null;
      const agenda = latest?.bitacoraAgenda as { items?: BitacoraAgendaItem[] } | null | undefined;
      const items = Array.isArray(agenda?.items) ? agenda.items : [];
      if (!latest || !items.length) {
        return res.status(404).json({ ok: false, error: "No hay bitacora cargada para exportar. Carga la plantilla o escribela primero." });
      }
      const rows = buildBitacoraExportRows(items);
      const courseCode = trimText(parsed.courseCode) || trimText(session.user.activeCourseCode) || BITACORA_TEMPLATE_DEFAULTS.courseCode;
      const fileName = buildBitacoraExportFileName({ courseCode, format });
      res.setHeader("Content-Disposition", `attachment; filename="${fileName}"`);
      res.setHeader("X-Content-Type-Options", "nosniff");
      res.setHeader("Cache-Control", "no-store");
      if (format === "csv") {
        res.setHeader("Content-Type", "text/csv; charset=utf-8");
        return res.send(buildBitacoraCsv(rows));
      }
      const workbookBuffer = await buildBitacoraWorkbook({
        teacher: { id: session.user.id, displayName: session.user.displayName, email: session.user.email },
        courseName: parsed.courseName,
        courseCode,
        group: parsed.group,
        academicPeriod: parsed.academicPeriod,
      }, rows);
      res.setHeader("Content-Type", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
      return res.send(Buffer.from(workbookBuffer));
    } catch (error) {
      const status = error instanceof z.ZodError ? 400 : 500;
      return res.status(status).json({ ok: false, error: errorMessage(error) });
    }
  });

  app.delete("/api/documents/bitacora/latest", async (req, res) => {
    try {
      const session = await resolveSession(database, req);
      if (!session) {
        return res.status(401).json({ ok: false, error: "Sesion no valida." });
      }
      if (session.user.role !== "teacher") {
        return res.status(403).json({ ok: false, error: "Solo docentes pueden eliminar bitacora." });
      }

      const result = await database.pool.query<{
        id: string;
        file_name: string;
        file_path: string;
        updated_at: string | Date;
      }>(
        `
        delete from project_document_classifications
        where id = (
          select id
          from (
            select id
            from project_document_classifications
            where user_id = $1
              and label = 'BITACORA'
            order by updated_at desc, classified_at desc
            limit 1
          ) latest
        )
        returning id, file_name, file_path, updated_at
        `,
        [session.user.id],
      );

      return res.json({
        ok: true,
        scope: "latest",
        deletedCount: result.rowCount || 0,
        deleted: result.rows.map(mapDeletedBitacoraRow),
      });
    } catch (error) {
      return res.status(500).json({ ok: false, error: errorMessage(error) });
    }
  });

  app.delete("/api/documents/bitacora/data", async (req, res) => {
    try {
      const session = await resolveSession(database, req);
      if (!session) {
        return res.status(401).json({ ok: false, error: "Sesion no valida." });
      }
      if (session.user.role !== "teacher") {
        return res.status(403).json({ ok: false, error: "Solo docentes pueden borrar datos de bitacora." });
      }

      const result = await database.pool.query<{
        id: string;
        file_name: string;
        file_path: string;
        updated_at: string | Date;
      }>(
        `
        delete from project_document_classifications
        where user_id = $1
          and label = 'BITACORA'
        returning id, file_name, file_path, updated_at
        `,
        [session.user.id],
      );

      return res.json({
        ok: true,
        scope: "all",
        deletedCount: result.rowCount || 0,
        deleted: result.rows.map(mapDeletedBitacoraRow),
      });
    } catch (error) {
      return res.status(500).json({ ok: false, error: errorMessage(error) });
    }
  });
}

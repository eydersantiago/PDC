// Rutas de la plantilla de la bitacora, flujo del docente, formulario y guia para PDF.
// Movido sin cambios desde src/routes/document-routes.ts (solo se agrego "export" y los imports).
import { z } from "zod";
import express from "express";
import type { AppDatabase } from "../db/database.js";
import { getBitacoraPdfGuidelines } from "../services/bitacora-import.js";
import { BITACORA_TEMPLATE_DEFAULTS, BITACORA_TEMPLATE_FILE_NAME, buildBitacoraTemplate, getBitacoraTemplateUiMetadata } from "../services/bitacora-template.js";
import { trimText } from "../services/text-utils.js";
import { errorMessage, resolveSession } from "./route-utils.js";

export const bitacoraTemplateQuerySchema = z.object({
  courseName: z.string().max(240).optional(),
  courseCode: z.string().max(120).optional(),
  group: z.string().max(120).optional(),
  academicPeriod: z.string().max(120).optional(),
}).strict();

export function slugBitacoraTemplatePart(value: string) {
  return trimText(value)
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .slice(0, 80);
}

export function buildBitacoraTemplateDownloadName(input: {
  courseCode?: string;
  academicPeriod?: string;
}) {
  const courseCode = slugBitacoraTemplatePart(input.courseCode || BITACORA_TEMPLATE_DEFAULTS.courseCode);
  const academicPeriod = slugBitacoraTemplatePart(input.academicPeriod || BITACORA_TEMPLATE_DEFAULTS.academicPeriod);
  if (courseCode === "fpoo" && academicPeriod === "2026_1") {
    return BITACORA_TEMPLATE_FILE_NAME;
  }
  return `plantilla_bitacora_${courseCode || "curso"}_${academicPeriod || "periodo"}.xlsx`;
}

// Bitacora: plantilla, flujo del docente, formulario y guia para PDF.
export function registerBitacoraTemplateRoutes(app: express.Express, database: AppDatabase) {
  app.get("/api/documents/bitacora-template", async (req, res) => {
    try {
      const session = await resolveSession(database, req);
      if (!session) {
        return res.status(401).json({ ok: false, error: "Sesion no valida." });
      }
      if (session.user.role !== "teacher") {
        return res.status(403).json({ ok: false, error: "Solo docentes pueden descargar esta plantilla." });
      }

      const parsed = bitacoraTemplateQuerySchema.parse(req.query || {});
      const fileName = buildBitacoraTemplateDownloadName(parsed);
      const workbookBuffer = await buildBitacoraTemplate({
        teacher: {
          id: session.user.id,
          displayName: session.user.displayName,
          email: session.user.email,
        },
        courseName: parsed.courseName,
        courseCode: parsed.courseCode,
        group: parsed.group,
        academicPeriod: parsed.academicPeriod,
      });

      res.setHeader("Content-Type", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
      res.setHeader("Content-Disposition", `attachment; filename="${fileName}"`);
      res.setHeader("X-Content-Type-Options", "nosniff");
      return res.send(Buffer.from(workbookBuffer));
    } catch (error) {
      const status = error instanceof z.ZodError ? 400 : 500;
      return res.status(status).json({ ok: false, error: errorMessage(error) });
    }
  });

  app.get("/api/documents/bitacora-teacher-workflow", async (req, res) => {
    try {
      const session = await resolveSession(database, req);
      if (!session) {
        return res.status(401).json({ ok: false, error: "Sesion no valida." });
      }
      if (session.user.role !== "teacher") {
        return res.status(403).json({ ok: false, error: "Solo docentes pueden consultar este panel de flujo." });
      }

      return res.json({
        ok: true,
        teacherRole: true,
        routes: {
          templateDownload: "/api/documents/bitacora-template",
          templateMetadata: "/api/documents/bitacora-template-form",
          excelOrPdfImport: "/api/documents/bitacora/import",
          manualDesignImport: "/api/documents/bitacora/manual",
          pdfGuidelines: "/api/documents/bitacora-pdf-guidelines",
        },
        templateMetadata: getBitacoraTemplateUiMetadata(),
        uploadField: "file",
      });
    } catch (error) {
      const status = error instanceof z.ZodError ? 400 : 500;
      return res.status(status).json({ ok: false, error: errorMessage(error) });
    }
  });

  app.get("/api/documents/bitacora-template-form", async (req, res) => {
    try {
      const session = await resolveSession(database, req);
      if (!session) {
        return res.status(401).json({ ok: false, error: "Sesion no valida." });
      }
      if (session.user.role !== "teacher") {
        return res.status(403).json({ ok: false, error: "Solo docentes pueden consultar metadatos de plantilla." });
      }

      return res.json({
        ok: true,
        template: getBitacoraTemplateUiMetadata(),
      });
    } catch (error) {
      const status = error instanceof z.ZodError ? 400 : 500;
      return res.status(status).json({ ok: false, error: errorMessage(error) });
    }
  });

  app.get("/api/documents/bitacora-pdf-guidelines", async (req, res) => {
    try {
      const session = await resolveSession(database, req);
      if (!session) {
        return res.status(401).json({ ok: false, error: "Sesion no valida." });
      }
      if (session.user.role !== "teacher") {
        return res.status(403).json({ ok: false, error: "Solo docentes pueden consultar lineamientos." });
      }
      return res.json({
        ok: true,
        guidelines: getBitacoraPdfGuidelines(),
      });
    } catch (error) {
      return res.status(500).json({ ok: false, error: errorMessage(error) });
    }
  });
}

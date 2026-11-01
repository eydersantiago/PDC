// Ruta POST /api/documents/bitacora/manual: guardar la bitacora escrita a mano.
import { z } from "zod";
import express from "express";
import { randomUUID } from "node:crypto";
import type { AppDatabase } from "../../db/database.js";
import { normalizeRepoFullName } from "../../services/documents/project-context.js";
import { trimText } from "../../services/shared/text-utils.js";
import { resolveBitacoraOwner } from "./bitacora-owner.js";
import { storeClassification } from "../documents/document-classifications.js";
import { errorMessage, resolveSession } from "../route-utils.js";
import { buildBitacoraImportRepoName, bitacoraManualImportSchema, parseManualBitacoraItems, buildManualBitacoraValidation, compactText } from "./bitacora-manual-items.js";

export function registerBitacoraManualImportRoute(app: express.Express, database: AppDatabase) {
  app.post("/api/documents/bitacora/manual", async (req, res) => {
    try {
      const session = await resolveSession(database, req);
      if (!session) {
        return res.status(401).json({ ok: false, error: "Sesion no valida." });
      }
      if (session.user.role !== "teacher" && session.user.role !== "admin") {
        return res.status(403).json({ ok: false, error: "Solo docentes pueden guardar bitacora manual." });
      }

      const parsed = bitacoraManualImportSchema.parse(req.body || {});
      const resolved = await resolveBitacoraOwner(database, session, parsed.teacherUserId, {
        deniedMessage: "Solo docentes pueden guardar bitacora manual.",
      });
      if (!resolved.ok) {
        return res.status(resolved.status).json({ ok: false, error: resolved.error });
      }
      const ownerRef = { user: { id: resolved.owner.id } };
      const parsedRows = parseManualBitacoraItems({
        activities: parsed.activities || [],
        exams: parsed.exams || [],
      });
      const validation = buildManualBitacoraValidation({
        activities: parsed.activities || [],
        exams: parsed.exams || [],
      });

      const inputFileName = trimText(parsed.fileName || parsed.sourceName || `bitacora_manual_${new Date().toISOString().slice(0, 10)}.json`);
      const requestId = trimText(parsed.requestId) || randomUUID();
      const snapshotId = trimText(parsed.snapshotId) || randomUUID();
      const repoFullName = normalizeRepoFullName(parsed.repoFullName || buildBitacoraImportRepoName(ownerRef))
        || buildBitacoraImportRepoName(ownerRef);

      if (!parsedRows.items.length || !validation.isValid) {
        return res.status(400).json({
          ok: false,
          error: "La carga manual no contiene registros importables.",
          validation,
          import: {
            source: "manual",
            recognized: false,
            detectedTemplate: false,
            rowsParsed: 0,
            rowsUsed: 0,
            warnings: validation.warnings,
            bitacoraAgenda: {
              items: [],
              summary: parsedRows.summary,
              warnings: parsedRows.warnings,
            },
            summary: {
              activities: parsedRows.activities,
              exams: parsedRows.exams,
              withDate: parsedRows.withDate,
              withoutDate: parsedRows.withoutDate,
              parseWarnings: parsedRows.warnings.length + validation.warnings.length,
            },
            textPreview: "",
          },
        });
      }

      const bitacoraAgenda = {
        items: parsedRows.items,
        summary: parsedRows.summary,
        warnings: parsedRows.warnings,
      };

      const classification = {
        label: "BITACORA" as const,
        confidence: 0.97,
        method: "rules" as const,
        evidence: [
          "Importación desde interfaz docente.",
          `Actividades cargadas: ${parsedRows.activities}`,
          `Exámenes cargados: ${parsedRows.exams}`,
          `Registros con fecha: ${parsedRows.withDate}`,
        ],
        reason: bitacoraAgenda.summary,
      };

      const stored = parsed.dryRun
        ? null
        : await storeClassification(database, {
          sessionId: session.id,
          userId: resolved.owner.id,
          repoFullName,
          requestId,
          snapshotId,
          filePath: inputFileName,
          fileName: inputFileName,
          mimeType: "application/json",
          extension: "json",
          classification,
          extractedTextPreview: `${parsedRows.activities} actividades / ${parsedRows.exams} exámenes`,
          features: {
            source: "manual_form",
            bitacoraAgenda,
            rowsParsed: parsedRows.items.length,
            rowsUsed: parsedRows.items.length,
            parsedValidation: validation,
            parsedWarnings: parsedRows.warnings,
            totals: {
              activities: parsedRows.activities,
              exams: parsedRows.exams,
              withDate: parsedRows.withDate,
              withoutDate: parsedRows.withoutDate,
            },
          },
          trainingExample: {
            input: {
              fileName: inputFileName,
              filePath: inputFileName,
              textPreview: `${parsedRows.activities} actividades / ${parsedRows.exams} exámenes`,
            },
            expectedLabel: null,
            predictedLabel: classification.label,
          },
          modelUsed: false,
          modelError: "",
        });

      return res.json({
        ok: true,
        source: "manual",
        import: {
          source: "manual",
          recognized: true,
          detectedTemplate: false,
          rowsParsed: parsedRows.items.length,
          rowsUsed: parsedRows.items.length,
          warnings: [
            ...validation.warnings,
            ...parsedRows.warnings,
          ],
          bitacoraAgenda,
          summary: {
            activities: parsedRows.activities,
            exams: parsedRows.exams,
            withDate: parsedRows.withDate,
            withoutDate: parsedRows.withoutDate,
            parseWarnings: parsedRows.warnings.length + validation.warnings.length,
          },
          textPreview: compactText(
            `${parsed.activities?.length || 0} actividades | ${parsed.exams?.length || 0} exámenes`,
            2200,
          ),
        },
        classification,
        stored,
      });
    } catch (error) {
      const status = error instanceof z.ZodError ? 400 : 500;
      return res.status(status).json({ ok: false, error: errorMessage(error) });
    }
  });
}

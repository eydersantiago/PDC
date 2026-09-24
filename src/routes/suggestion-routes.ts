import type express from "express";
import { z } from "zod";
import type { AppDatabase } from "../db/database.js";
import { DEFAULT_CODE_APPLICATION_SETTINGS } from "../services/policy-settings.js";
import { checkCodeApplication } from "../services/suggestion-policy.js";
import { actorAnonId, exerciseHash } from "../services/telemetry.js";
import { errorMessage, resolvePolicyForSession, resolveRequestActor } from "./route-utils.js";

/**
 * A10.8: antes de aplicar en el archivo del estudiante un cambio de codigo
 * sugerido por el tutor, VS Code pregunta aqui si la politica del docente lo
 * permite. Cada respuesta queda en telemetry_events como
 * code_application_checked y las permitidas cuentan como pista del archivo
 * cuando la politica asi lo dice (codeApplication.countsAsHint).
 */

const applyCheckSchema = z.object({
  decisionId: z.string().max(80).optional(),
  filePath: z.string().max(700).default(""),
  language: z.string().max(60).optional(),
  applyMode: z.enum(["insert", "replace", "delete"]),
  linesChanged: z.number().int().min(0).max(5000),
  charsChanged: z.number().int().min(0).max(500000).default(0),
  trigger: z.string().max(40).optional(),
}).strict();

export function registerSuggestionRoutes(app: express.Express, database: AppDatabase) {
  app.post("/api/suggestions/apply-check", async (req, res) => {
    try {
      const { session, actor } = await resolveRequestActor(database, req);
      if (!actor) {
        return res.status(401).json({ ok: false, error: "Falta la sesion o la cabecera x-adaceen-client-id." });
      }
      const parsed = applyCheckSchema.parse(req.body || {});
      const policy = await resolvePolicyForSession(database, session).catch(() => null);
      const exerciseKey = `file:${parsed.filePath.toLowerCase()}`;
      const used = await database
        .countAllowedCodeApplications(actorAnonId(actor), exerciseHash(exerciseKey))
        .catch(() => 0);

      const decision = checkCodeApplication(
        policy || { codeApplication: DEFAULT_CODE_APPLICATION_SETTINGS, maxHintsPerExercise: null },
        { linesChanged: parsed.linesChanged },
        used,
      );
      const remainingAfter = decision.allowed && decision.remaining !== null && decision.countsAsHint
        ? Math.max(0, decision.remaining - 1)
        : decision.remaining;

      await database.insertTelemetryEvents([
        {
          source: "backend",
          channel: "vscode",
          category: "code_application",
          eventType: "code_application_checked",
          decisionId: parsed.decisionId,
          exerciseKey,
          language: parsed.language,
          filePath: parsed.filePath,
          blocked: !decision.allowed,
          reasonCode: decision.reasonCode,
          value: parsed.applyMode,
          metadata: {
            applyMode: parsed.applyMode,
            linesChanged: parsed.linesChanged,
            charsChanged: parsed.charsChanged,
            trigger: parsed.trigger || "",
            allowed: decision.allowed,
            maxLines: decision.maxLines,
            ...(remainingAfter !== null ? { remaining: remainingAfter } : {}),
          },
        },
      ], actor);

      return res.json({
        ok: true,
        allowed: decision.allowed,
        reason: decision.reason,
        reasonCode: decision.reasonCode,
        maxLines: decision.maxLines,
        remaining: remainingAfter,
        requireConfirmation: decision.requireConfirmation,
        decisionId: parsed.decisionId || null,
      });
    } catch (error) {
      const status = error instanceof z.ZodError ? 400 : 500;
      return res.status(status).json({ ok: false, error: errorMessage(error) });
    }
  });
}

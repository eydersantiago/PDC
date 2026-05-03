import type express from "express";
import { z } from "zod";
import type { AppDatabase } from "../db/database.js";
import { boundedInteger, errorMessage, resolveSession } from "./route-utils.js";

const policyPatchSchema = z.object({
  policyName: z.string().min(3).max(120).optional(),
  outcome: z.enum(["RA1", "RA2", "RA3"]).optional(),
  tone: z.enum(["warm", "direct", "socratic"]).optional(),
  frequency: z.enum(["low", "medium", "high"]).optional(),
  helpLevel: z.enum(["progressive", "hint_only", "partial_example"]).optional(),
  allowMiniQuiz: z.boolean().optional(),
  strictNoSolution: z.boolean().optional(),
  maxHintsPerExercise: z.number().int().min(1).nullable().optional(),
  fallbackMessage: z.string().min(10).max(280).optional(),
  customInstruction: z.string().max(600).optional(),
  allowedInterventions: z.array(z.enum(["explanation", "hint", "example", "mini_quiz"])).optional(),
  allowedTopics: z.array(z.string().min(2).max(50)).optional(),
  eventRules: z.record(
    z.enum([
      "compile_error",
      "runtime_error",
      "concept_question",
      "design_block",
      "workflow_guidance",
      "insufficient_context",
      "out_of_domain",
    ]),
    z.object({
      enabled: z.boolean(),
      interventionType: z.enum(["explanation", "hint", "example", "mini_quiz", "controlled_message"]),
      detailLevel: z.enum(["brief", "guided", "progressive"]),
      activationThreshold: z.number().int().min(1).max(5),
      maxUsesPerSession: z.number().int().min(1).nullable(),
    }),
  ).optional(),
}).strict();

export function registerPolicyRoutes(app: express.Express, database: AppDatabase) {
  app.get("/api/policies/current", async (req, res) => {
    try {
      const session = await resolveSession(database, req);
      if (!session) {
        return res.status(401).json({ ok: false, error: "Sesion no valida." });
      }

      const policy = await database.getTeacherPolicyForUser(session.user);
      const telemetry = session.user.role === "teacher"
        ? await database.listTelemetryForTeacher(session.user.id, 8)
        : [];

      return res.json({
        ok: true,
        policy,
        telemetry,
      });
    } catch (error) {
      return res.status(500).json({ ok: false, error: String(error) });
    }
  });

  app.put("/api/policies/current", async (req, res) => {
    try {
      const session = await resolveSession(database, req);
      if (!session || session.user.role !== "teacher") {
        return res.status(403).json({ ok: false, error: "Solo el profesor puede actualizar politicas." });
      }

      const parsed = policyPatchSchema.parse(req.body || {});
      const policy = await database.updateTeacherPolicy(session.user.id, parsed);
      const telemetry = await database.listTelemetryForTeacher(session.user.id, 8);

      return res.json({
        ok: true,
        policy,
        telemetry,
      });
    } catch (error) {
      return res.status(400).json({ ok: false, error: errorMessage(error) });
    }
  });

  app.get("/api/telemetry/interventions", async (req, res) => {
    try {
      const session = await resolveSession(database, req);
      if (!session || session.user.role !== "teacher") {
        return res.status(403).json({ ok: false, error: "Solo el profesor puede consultar telemetria." });
      }

      const limit = boundedInteger(req.query.limit, 10, 1, 25);
      const items = await database.listTelemetryForTeacher(session.user.id, limit);

      return res.json({ ok: true, items });
    } catch (error) {
      return res.status(500).json({ ok: false, error: String(error) });
    }
  });
}

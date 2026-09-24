import type express from "express";
import { z } from "zod";
import type { AppDatabase } from "../db/database.js";
import type { BehaviorEventInput } from "../types/app.js";
import { trimText } from "../services/text-utils.js";
import {
  actorFromClientId,
  actorFromSession,
  hashErrorText,
  type TelemetryEventInput,
} from "../services/telemetry.js";
import { boundedInteger, errorMessage, resolveSession } from "./route-utils.js";

const behaviorSourceSchema = z.enum([
  "browser_extension",
  "vscode_extension",
  "backend",
  "system",
]);

const behaviorCategorySchema = z.enum([
  "suggestion",
  "cursor_idle",
  "codespace",
  "github_pr",
  "navigation",
  "project_context",
  "intervention",
  "error",
  "workflow",
  // v1.1
  "tutor",
  "signal",
  "code_application",
  "quiz",
]);

const behaviorEventSchema = z.object({
  source: behaviorSourceSchema.default("browser_extension"),
  category: behaviorCategorySchema,
  eventType: z.string().min(1).max(120),
  pageContext: z.string().max(120).optional(),
  repoFullName: z.string().max(240).optional(),
  branch: z.string().max(160).optional(),
  filePath: z.string().max(700).optional(),
  language: z.string().max(120).optional(),
  subjectId: z.string().max(220).optional(),
  value: z.string().max(1000).optional(),
  durationMs: z.number().int().min(0).max(86_400_000).nullable().optional(),
  count: z.number().int().min(1).max(100000).nullable().optional(),
  metadata: z.record(z.string(), z.unknown()).optional(),
  occurredAt: z.string().datetime().optional(),
  // Telemetria v1.1 (ver docs/telemetria/diccionario-eventos.md)
  schemaVersion: z.string().max(20).optional(),
  seq: z.number().int().min(0).max(1_000_000_000).nullable().optional(),
  clientSessionId: z.string().max(80).optional(),
  decisionId: z.string().max(80).optional(),
  latencyMs: z.number().int().min(0).max(600_000).nullable().optional(),
  // El texto del error solo se usa para calcular su hash; nunca se guarda.
  errorText: z.string().max(500).optional(),
  errorHash: z.string().regex(/^[0-9a-f]{8,64}$/i).optional(),
  contextHash: z.string().regex(/^[0-9a-f]{8,64}$/i).optional(),
}).strict();

const behaviorEventsPayloadSchema = z.object({
  events: z.array(behaviorEventSchema).min(1).max(50),
}).strict();

const behaviorHistoryQuerySchema = z.object({
  userId: z.string().max(120).optional(),
  category: behaviorCategorySchema.optional(),
  eventType: z.string().max(120).optional(),
  source: behaviorSourceSchema.optional(),
  repoFullName: z.string().max(240).optional(),
  since: z.string().datetime().optional(),
  limit: z.coerce.number().int().min(1).max(100).optional(),
}).strict();

const behaviorSummaryQuerySchema = behaviorHistoryQuerySchema.omit({ eventType: true }).extend({
  limit: z.coerce.number().int().min(1).max(200).optional(),
}).strict();

function normalizeBehaviorEvent(event: z.infer<typeof behaviorEventSchema>): BehaviorEventInput {
  return {
    source: event.source,
    category: event.category,
    eventType: trimText(event.eventType).slice(0, 120),
    pageContext: trimText(event.pageContext).slice(0, 120),
    repoFullName: trimText(event.repoFullName).slice(0, 240),
    branch: trimText(event.branch).slice(0, 160),
    filePath: trimText(event.filePath).slice(0, 700),
    language: trimText(event.language).slice(0, 120),
    subjectId: trimText(event.subjectId).slice(0, 220),
    value: trimText(event.value).slice(0, 1000),
    durationMs: event.durationMs ?? null,
    count: event.count ?? 1,
    metadata: event.metadata || {},
    occurredAt: trimText(event.occurredAt),
    schemaVersion: trimText(event.schemaVersion).slice(0, 20),
    seq: event.seq ?? null,
    clientSessionId: trimText(event.clientSessionId).slice(0, 80),
    decisionId: trimText(event.decisionId).slice(0, 80),
    latencyMs: event.latencyMs ?? null,
    errorHash: event.errorText ? hashErrorText(event.errorText) : trimText(event.errorHash).toLowerCase(),
    contextHash: trimText(event.contextHash).toLowerCase(),
  };
}

export function registerBehaviorRoutes(app: express.Express, database: AppDatabase) {
  app.post("/api/behavior/events", async (req, res) => {
    try {
      // v1.1: con sesion o, sin ella, con x-adaceen-client-id (lo habitual en el piloto).
      const session = await resolveSession(database, req).catch(() => null);
      const actor = session
        ? actorFromSession(session)
        : actorFromClientId(req.header("x-adaceen-client-id"));
      if (!actor) {
        return res.status(401).json({ ok: false, error: "Falta la sesion o la cabecera x-adaceen-client-id." });
      }

      const parsed = behaviorEventsPayloadSchema.parse(req.body || {});
      const events = parsed.events.map(normalizeBehaviorEvent);
      const hadErrorText = parsed.events.map((event) => Boolean(event.errorText));

      let stored: Awaited<ReturnType<AppDatabase["recordBehaviorEvents"]>> = [];
      if (session) {
        stored = await database.recordBehaviorEvents({
          sessionId: session.id,
          user: session.user,
          events,
          mirrorTelemetry: false,
        });
      }
      const rows = await database.insertTelemetryEvents(
        events.map((event) => behaviorEventToTelemetry(event)),
        actor,
      );
      const flags = rows.flatMap((row, index) => [
        ...row.qualityFlags.map((flag) => ({ index, code: flag.code, severity: flag.severity })),
        ...(hadErrorText[index] ? [{ index, code: "Q9_texto_descartado", severity: "info" as const }] : []),
      ]);

      return res.json({
        ok: true,
        stored: rows.length,
        flags,
        ...(session ? { events: stored } : {}),
      });
    } catch (error) {
      const status = error instanceof z.ZodError ? 400 : 500;
      return res.status(status).json({ ok: false, error: errorMessage(error) });
    }
  });

  app.get("/api/behavior/events", async (req, res) => {
    try {
      const session = await resolveSession(database, req);
      if (!session) {
        return res.status(401).json({ ok: false, error: "Sesion no valida." });
      }

      const parsed = behaviorHistoryQuerySchema.parse(req.query || {});
      const items = await database.listBehaviorEventsForViewer({
        viewer: session.user,
        targetUserId: trimText(parsed.userId),
        category: trimText(parsed.category),
        eventType: trimText(parsed.eventType),
        source: trimText(parsed.source),
        repoFullName: trimText(parsed.repoFullName),
        since: trimText(parsed.since),
        limit: boundedInteger(parsed.limit, 50, 1, 100),
      });

      return res.json({ ok: true, items });
    } catch (error) {
      const status = error instanceof z.ZodError ? 400 : 500;
      return res.status(status).json({ ok: false, error: errorMessage(error) });
    }
  });

  app.get("/api/behavior/summary", async (req, res) => {
    try {
      const session = await resolveSession(database, req);
      if (!session) {
        return res.status(401).json({ ok: false, error: "Sesion no valida." });
      }

      const parsed = behaviorSummaryQuerySchema.parse(req.query || {});
      const items = await database.summarizeBehaviorEventsForViewer({
        viewer: session.user,
        targetUserId: trimText(parsed.userId),
        category: trimText(parsed.category),
        source: trimText(parsed.source),
        repoFullName: trimText(parsed.repoFullName),
        since: trimText(parsed.since),
        limit: boundedInteger(parsed.limit, 100, 1, 200),
      });

      return res.json({ ok: true, items });
    } catch (error) {
      const status = error instanceof z.ZodError ? 400 : 500;
      return res.status(status).json({ ok: false, error: errorMessage(error) });
    }
  });
}

function behaviorEventToTelemetry(event: BehaviorEventInput): TelemetryEventInput {
  return {
    source: event.source,
    category: event.category,
    eventType: event.eventType,
    occurredAt: event.occurredAt || null,
    schemaVersion: event.schemaVersion,
    clientSessionId: event.clientSessionId,
    seq: event.seq ?? null,
    decisionId: event.decisionId,
    exerciseKey: event.filePath ? `file:${event.filePath}` : undefined,
    language: event.language,
    filePath: event.filePath,
    pageContext: event.pageContext,
    latencyMs: event.latencyMs ?? null,
    durationMs: event.durationMs ?? null,
    count: event.count ?? null,
    value: event.value,
    errorHash: event.errorHash,
    contextHash: event.contextHash,
    metadata: event.metadata,
  };
}

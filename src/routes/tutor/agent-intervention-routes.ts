// Rutas POST /intervene y /github-mentor: intervencion estructurada del tutor para el overlay.
import type express from "express";
import { env } from "../../config/env.js";
import type { AppDatabase } from "../../db/database.js";
import { evaluateMentorIntervention } from "../../services/tutor/decision-engine.js";
import { durationMs, errorSummary, shortHash, textStats } from "../../services/shared/diagnostics.js";
import { readMaintenance, type MaintenanceNotice } from "../../services/infra/maintenance.js";
import { withUpdateNotice, type ExtensionUpdateNotifier } from "../../services/extensions/extension-update-notice.js";
import { CLIENT_ID_HEADER, CLIENT_VERSION_HEADER } from "../client-headers.js";
import { trimText } from "../../services/shared/text-utils.js";
import { createIdempotencyCache, readIdempotencyKey } from "../../services/shared/idempotency.js";
import type { GithubMentorContext } from "../../types/app.js";
import { boundedInteger, getRequestBaseUrl, resolveRequestActor } from "../route-utils.js";
import { getRequestId, agentRoutesLog, summarizeRagSourcesForLog, attachRagViewerLinks } from "./agent-route-utils.js";

/** Respuesta de /intervene con el aviso: el overlay la muestra como saludo, estado y pista. */
function maintenanceInterventionReply(notice: MaintenanceNotice) {
  return {
    ok: true,
    source: "maintenance",
    maintenance: true,
    result: {
      ideas: [notice.message],
      searches: [],
      guide: [notice.message, "Guarda tu trabajo y vuelve a pedir ayuda en unos minutos."],
      welcome_message: notice.message,
      analysis_summary: notice.message,
    },
    policy_applied: null,
    telemetry_id: null,
    decision_id: null,
    blocked: false,
    help_stage: "controlled",
    latency_ms: 0,
    rag_sources: [],
  };
}

export function registerAgentInterventionRoutes(app: express.Express, database: AppDatabase, options: { extensionUpdate?: ExtensionUpdateNotifier }) {
  // Respuestas de /intervene y /github-mentor por Idempotency-Key (A12.12): una repeticion no
  // vuelve a llamar al modelo ni a sumar el cupo de pistas.
  const interventionReplies = createIdempotencyCache<Record<string, unknown>>({ ttlMs: 10 * 60 * 1000, maxEntries: 500 });
  // Pedidos repetidos (28-10-2026): el mismo estudiante con la misma pregunta sobre la misma pagina.
  //   - Mientras el primero corre (el overlay pide al entrar a la pagina y el estudiante pulsa
  //     Actualizar a la vez), el segundo espera y recibe la misma respuesta: antes los dos leian
  //     las mismas pistas usadas y salian dos pistas identicas a las 11:09.
  //   - Un bloqueo se repite tal cual durante 2 min, sin otra decision en la telemetria (5
  //     bloqueos en el mismo minuto en el editor sin archivo abierto).
  // Un pedido nuevo despues de recibir la pista si llega al modelo: es como sube la ayuda (A2.2).
  const REPEATED_BLOCK_MS = 2 * 60 * 1000;
  const repeatedReplies = createIdempotencyCache<Record<string, unknown>>({
    ttlMs: REPEATED_BLOCK_MS,
    maxEntries: 500,
    ttlFor: (reply) => (reply.source === "policy" ? REPEATED_BLOCK_MS : 0),
  });

  async function handleStructuredIntervention(req: express.Request, res: express.Response) {
    const requestId = getRequestId(req);
    const startedAt = Date.now();
    const route = req.path || "/intervene";
    const logger = agentRoutesLog.child({ requestId, route, mode: env.targetMode });
    try {
      const question = trimText(req.body?.question) || "Sugiere ideas y busquedas para mejorar este codigo.";
      const maxItems = boundedInteger(req.body?.max_items, 6, 3, 8);
      const rawContext = (req.body?.context || {}) as GithubMentorContext;
      logger.info("intervention.request.start", {
        question: textStats(question),
        maxItems,
        pageType: rawContext.pageType || "",
        pageContext: rawContext.pageContext || "",
        repoFullName: rawContext.repoFullName || "",
        filePath: rawContext.filePath || "",
        codeSnippet: textStats(rawContext.codeSnippet),
      });
      const maintenance = await readMaintenance(database);
      if (maintenance.active) {
        logger.info("intervention.request.maintenance", { durationMs: durationMs(startedAt) });
        return res.json(maintenanceInterventionReply(maintenance));
      }
      const { session, actor } = await resolveRequestActor(database, req);
      // Aviso de version nueva de la extension (29-10-2026): al final del saludo, una vez cada
      // 30 min por persona, solo si tiene una version anterior a la que puede instalar.
      const send = async (reply: Record<string, unknown>) => {
        let notice = "";
        if (options.extensionUpdate && reply.result) {
          notice = await options.extensionUpdate.noticeFor({
            actorKey: actor?.key || trimText(req.header(CLIENT_ID_HEADER)) || `ip:${req.ip || ""}`,
            clientVersionHeader: req.header(CLIENT_VERSION_HEADER),
            startPageUrl: `${getRequestBaseUrl(req, env.publicApiUrl || env.azureServer)}/empezar`,
          }).catch(() => "");
        }
        return res.json(withUpdateNotice(reply, notice));
      };

      const evaluate = async (): Promise<Record<string, unknown>> => {
        const evaluation = await evaluateMentorIntervention({
          question,
          context: rawContext,
          maxItems,
          session,
          database,
          actor,
        });
        logger.info("intervention.request.done", {
          durationMs: durationMs(startedAt),
          source: evaluation.source,
          telemetryId: evaluation.telemetryId,
          ragCourseCode: evaluation.ragCourseCode,
          ragSources: evaluation.ragSources.length,
          selectedSources: summarizeRagSourcesForLog(evaluation.ragSources),
        });

        return {
          ok: true,
          source: evaluation.source,
          result: evaluation.result,
          policy_applied: evaluation.policy,
          telemetry_id: evaluation.telemetryId,
          decision_id: evaluation.decisionId,
          blocked: evaluation.blocked,
          help_stage: evaluation.helpStage,
          latency_ms: evaluation.latencyMs,
          rag_course_code: evaluation.ragCourseCode,
          rag_lot: { id: evaluation.ragLot.lotId, name: evaluation.ragLot.name, origin: evaluation.ragLot.origin },
          rag_sources: attachRagViewerLinks(req, evaluation.ragSources, evaluation.ragCourseCode),
        };
      };

      // Con Idempotency-Key (overlay 0.7.18) una repeticion de la misma peticion recibe la
      // misma respuesta. La clave va por actor, para que nadie lea la de otro.
      const idempotencyKey = readIdempotencyKey(req.header("idempotency-key"));
      const replyScope = actor?.key || `ip:${req.ip || ""}`;
      const evaluateOnce = async (): Promise<{ reply: Record<string, unknown>; replayed: boolean }> => {
        if (!idempotencyKey) return { reply: await evaluate(), replayed: false };
        const { promise, reused } = interventionReplies.run(`${replyScope}|${idempotencyKey}`, evaluate);
        return { reply: await promise, replayed: reused };
      };
      // La misma pregunta sobre la misma pagina en 2 min (repeatedReplies): la misma respuesta.
      if (actor) {
        const fingerprint = shortHash(JSON.stringify({ question, maxItems, context: rawContext }), 32);
        let replayed = false;
        const { promise, reused } = repeatedReplies.run(`${actor.key}|${fingerprint}`, async () => {
          const once = await evaluateOnce();
          replayed = once.replayed;
          return once.reply;
        });
        const reply = await promise;
        if (reused) {
          logger.info("intervention.request.repeated", { durationMs: durationMs(startedAt), source: String(reply.source || "") });
          return send({ ...reply, repeated: true });
        }
        if (replayed) logger.info("intervention.request.replayed", { durationMs: durationMs(startedAt) });
        return send(replayed ? { ...reply, idempotent_replay: true } : reply);
      }
      const { reply, replayed } = await evaluateOnce();
      if (replayed) {
        logger.info("intervention.request.replayed", { durationMs: durationMs(startedAt) });
        return send({ ...reply, idempotent_replay: true });
      }
      return send(reply);
    } catch (error) {
      logger.error("intervention.request.failed", {
        durationMs: durationMs(startedAt),
        error: errorSummary(error),
      });
      return res.status(500).json({ ok: false, error: String(error) });
    }
  }

  app.post("/intervene", handleStructuredIntervention);
  app.post("/github-mentor", handleStructuredIntervention);
}

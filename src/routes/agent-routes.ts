import { NO_PILOT } from "../services/pilot.js";
import fsp from "node:fs/promises";
import crypto from "node:crypto";
import type express from "express";
import { runSuggestTab } from "../../runSuggestTab.js";
import { env } from "../config/env.js";
import type { AppDatabase } from "../db/database.js";
import { evaluateMentorIntervention, resolveMentorRagContext } from "../services/decision-engine.js";
import {
  createDiagnosticLogger,
  durationMs,
  errorSummary,
  shortHash,
  shortId,
  textStats,
  urlSummary,
  type DiagnosticLogger,
} from "../services/diagnostics.js";
import {
  hasTextModelOverride,
  isTutorStartingError,
  runImageByMode,
  runTextByMode,
  runTextByModeDetailed,
} from "../services/agent-mode.js";
import { editorBlockCause } from "../services/block-messages.js";
import { tutorStartingMessage } from "../services/gpu-autostart.js";
import { buildMaintenanceSuggestionMarkdown, readMaintenance, type MaintenanceNotice } from "../services/maintenance.js";
import { withUpdateNotice, type ExtensionUpdateNotifier } from "../services/extension-update-notice.js";
import { CLIENT_ID_HEADER, CLIENT_VERSION_HEADER } from "./client-headers.js";
import { getServiceBusQueueConfig } from "../services/service-bus-agent.js";
import { describeWorker, getLastWorker } from "../services/worker-identity.js";
import {
  countAliveWorkers,
  isHeartbeatTokenValid,
  listListeningWorkers,
  recordWorkerHeartbeat,
} from "../services/worker-heartbeat.js";
import { buildDeterministicGradeAnswer, buildMissingPdfTextAnswer } from "../services/tab-fallbacks.js";
import { buildCompactRagPromptBlock, buildEditorRagSearchQuery } from "../services/rag-sources.js";
import { extractEditorCode, stripCodeFenceGutters } from "../services/editor-context.js";
import { resolveEffectiveLot } from "../services/rag-lots.js";
import { prioritizeRagSourcesForScenario } from "../services/scenario-resources.js";
import {
  avoidRepeatInstruction,
  buildScopedTabSuggestionPrompt,
  buildTabSuggestionPrompt,
  editorCodeProblem,
  editorCodeRetryInstruction,
  hasClosedCodeBlock,
  modernizeEditorQuestion,
  normalizeRequestedAction,
  type TabSuggestionScope,
} from "../services/tab-suggestion-prompt.js";
import { trimText } from "../services/text-utils.js";
import { createIdempotencyCache, readIdempotencyKey } from "../services/idempotency.js";
import {
  buildControlledSuggestionMarkdown,
  buildStartingSuggestionMarkdown,
  buildUnavailableSuggestionMarkdown,
  buildSuggestionPolicyInstruction,
  evaluateSuggestionPolicy,
  EXPLICIT_REQUEST_WINDOW_MS,
  firstErrorText,
  isEditorFocusScope,
  isExplicitSuggestionRequest,
  moveApplyLinesOutOfCodeFences,
  type CodeApplicationDecision,
  type GuardrailOutcome,
  type SuggestionDiagnostic,
  type SuggestionPolicyDecision,
} from "../services/suggestion-policy.js";
import { actorAnonId, exerciseHash, type TelemetryActor } from "../services/telemetry.js";
import { resolveExamReferenceForRequest } from "../services/exam-reference.js";
import type { CutSummary } from "../services/code-cut.js";
import { finalizeEditorSuggestion } from "../services/suggestion-output.js";
import { GUARDRAIL_TRUNCATION_REASON } from "../services/telemetry-catalog.js";
import { serializableGeneration, type TextGenerationOptions } from "../services/text-generation.js";
import type { DecisionReasonCode, GithubMentorContext, RagContextItem, TeacherPolicy } from "../types/app.js";
import {
  boundedInteger,
  getRequestBaseUrl,
  resolvePolicyForSession,
  resolveRequestActor,
  resolveSession,
} from "./route-utils.js";

type ImageUploadMiddleware = {
  single(fieldName: string): express.RequestHandler;
};

type RagContextItemWithViewer = RagContextItem & {
  url: string;
  externalUrl: string;
  courseCode: string;
  citation: RagContextItem["citation"] & {
    externalUrl: string;
  };
};

const agentRoutesLog = createDiagnosticLogger("agent-routes");

function getRequestId(req: express.Request) {
  return trimText(req.header("x-request-id") || req.header("x-correlation-id")) || crypto.randomUUID();
}

function ragItemCourseCode(item: RagContextItem, fallback: string) {
  return trimText(item.metadata.courseCode)
    || trimText(item.metadata.course_code)
    || trimText(fallback);
}

/**
 * Enlace al visor de la fuente. A12.8: sin sessionId en la URL (el visor no
 * lo usa y una sesion en la URL queda en el historial, en capturas y en logs).
 */
function buildRagViewerUrl(
  req: express.Request,
  item: RagContextItem,
  courseCode: string,
) {
  const baseUrl = getRequestBaseUrl(req, env.publicApiUrl || env.azureServer);
  const sourceId = trimText(item.sourceId || item.id);
  if (!baseUrl || !sourceId) return "";

  const params = new URLSearchParams();
  const chunkId = trimText(item.chunkId);
  if (chunkId) params.set("chunkId", chunkId);
  if (item.pageStart) params.set("page", String(item.pageStart));
  if (courseCode) params.set("courseCode", courseCode);

  const query = params.toString();
  return `${baseUrl}/api/rag/sources/${encodeURIComponent(sourceId)}/view${query ? `?${query}` : ""}`;
}

function attachRagViewerLinks(
  req: express.Request,
  items: RagContextItem[],
  fallbackCourseCode: string,
): RagContextItemWithViewer[] {
  return items.map((item) => {
    const courseCode = ragItemCourseCode(item, fallbackCourseCode);
    const externalUrl = trimText(item.citation?.url);
    const viewerUrl = buildRagViewerUrl(req, item, courseCode);
    const url = viewerUrl || externalUrl;
    return {
      ...item,
      url,
      externalUrl,
      courseCode,
      citation: {
        ...item.citation,
        url,
        externalUrl,
      },
      metadata: {
        ...item.metadata,
        courseCode,
        externalUrl,
        viewerUrl,
      },
    };
  });
}

function summarizeRagSourcesForLog(items: unknown[]) {
  return items.slice(0, 5).map((item, index) => {
    const source = item && typeof item === "object" ? item as Record<string, unknown> : {};
    const metadata = source.metadata && typeof source.metadata === "object"
      ? source.metadata as Record<string, unknown>
      : {};
    return {
      index: index + 1,
      title: trimText(source.title),
      fileName: trimText(source.fileName),
      citationLabel: trimText(source.citationLabel),
      courseCode: trimText(source.courseCode) || trimText(metadata.courseCode),
      pageStart: Number(source.pageStart) || null,
      pageEnd: Number(source.pageEnd) || null,
      score: Number(source.score) || 0,
      isOpenable: Boolean(source.isOpenable || source.url),
      usageReason: textStats(source.usageReason),
    };
  });
}

/** Respuesta de /suggest-tab con el aviso «Estamos actualizando»: sin codigo, sin decision ni cache. */
function maintenanceSuggestTabReply(notice: MaintenanceNotice, request: { scope: string; cacheNamespace: string; courseCode: string }) {
  return {
    ok: true,
    output_text: buildMaintenanceSuggestionMarkdown(notice),
    suggestion_scope: request.scope,
    cache_namespace: request.cacheNamespace,
    cached: false,
    blocked: false,
    degraded: true,
    maintenance: true,
    decision_id: null,
    policy_applied: null,
    code_application: null,
    rag_course_code: request.courseCode,
    rag_sources: [],
  };
}

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

export function registerAgentRoutes(
  app: express.Express,
  database: AppDatabase,
  upload: ImageUploadMiddleware,
  options: { extensionUpdate?: ExtensionUpdateNotifier } = {},
) {
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

  type SuggestTabCacheNamespace = "general" | "file_summary" | "focus";
  type SuggestTabCacheEntry = { output: string; createdAt: number };
  const suggestTabCaches: Record<SuggestTabCacheNamespace, Map<string, SuggestTabCacheEntry>> = {
    general: new Map(),
    file_summary: new Map(),
    focus: new Map(),
  };
  const suggestTabCacheTtlMs = 120_000;
  const suggestTabCacheMaxEntries = 120;

  function normalizeSuggestionScope(value: unknown, question: string, tabContent: string): TabSuggestionScope {
    const clean = trimText(value).toLowerCase().replace(/-/g, "_");
    if (clean === "file_summary" || clean === "file" || clean === "summary") return "file_summary";
    if (clean === "selection" || clean === "selected_text") return "selection";
    if (clean === "cursor" || clean === "cursor_idle") return "cursor";

    const probe = `${question}\n${tabContent.slice(0, 900)}`.toLowerCase();
    if (/selecci[oó]n|selected text|texto seleccionado/.test(probe)) return "selection";
    if (/cursor|linea indicada|l[ií]nea indicada|cursor quieto/.test(probe)) return "cursor";
    return "general";
  }

  function cacheNamespaceForScope(scope: TabSuggestionScope): SuggestTabCacheNamespace {
    if (scope === "file_summary") return "file_summary";
    if (scope === "cursor" || scope === "selection") return "focus";
    return "general";
  }

  function buildSuggestTabCacheKey(params: {
    scope: TabSuggestionScope;
    tabContent: string;
    question: string;
    tabTitle: string;
    tabUrl: string;
    courseCode: string;
  }) {
    const contentHash = crypto.createHash("sha256").update(params.tabContent).digest("hex");
    const headerHash = crypto.createHash("sha256")
      .update(`${params.scope}||${params.tabUrl}||${params.tabTitle}||${params.question}||${params.courseCode}`)
      .digest("hex");
    return `${headerHash}.${contentHash}`;
  }

  async function buildSuggestTabRagPayload(
    req: express.Request,
    params: {
      question: string;
      tabContent: string;
      tabTitle: string;
      tabUrl: string;
      courseCode: string;
      scope: TabSuggestionScope;
      visibleError: string;
      logger?: DiagnosticLogger;
    },
  ) {
    const session = await resolveSession(database, req).catch((error) => {
      params.logger?.warn("suggest-tab.session.resolve.failed", {
        error: errorSummary(error),
      });
      return null;
    });
    const filePath = trimText(req.body?.filePath) || params.tabTitle;
    const context: GithubMentorContext = {
      url: params.tabUrl,
      title: params.tabTitle,
      pageContext: "github",
      pageType: "codespace",
      repoFullName: trimText(req.body?.repoFullName),
      filePath,
      languageHint: trimText(req.body?.languageHint),
      courseCode: params.courseCode,
      ragCourseCode: params.courseCode,
      selection: trimText(req.body?.selection),
      codeSnippet: params.tabContent.slice(0, 6000),
      codeLineCount: params.tabContent.split(/\r?\n/).length,
    };
    // Editor (cursor, seleccion y resumen del archivo): la consulta sale del codigo y del error,
    // no de la pregunta que arma VS Code (es una instruccion de formato) ni de los rotulos del
    // contexto. Se quedan las fuentes con al menos la mitad del puntaje de la mejor, que traen
    // dos terminos de la consulta o mas (sin contar el lenguaje), y a lo sumo dos fragmentos por
    // fuente; si ninguna llega, no se cita nada (revision de precision del 21/10/2026).
    const isEditorScope = params.scope !== "general";
    const editorCode = isEditorScope ? extractEditorCode(params.tabContent, context.selection) : null;
    const rag = await resolveMentorRagContext({
      question: params.question,
      context,
      session,
      database,
      ...(editorCode
        ? {
            queryOverride: buildEditorRagSearchQuery({
              focusCode: params.scope === "file_summary" ? "" : editorCode.focusCode,
              fileCode: editorCode.fileCode,
              visibleError: params.visibleError,
              languageHint: context.languageHint,
              filePath,
            }),
            rankOptions: { minRelativeScore: 0.5, maxPerSource: 2, minMatchedTerms: 2 },
          }
        : {}),
    }).catch((error) => {
      params.logger?.warn("suggest-tab.rag.resolve.failed", {
        error: errorSummary(error),
      });
      return {
        ragSources: [],
        ragCourseCode: params.courseCode,
        ragLot: resolveEffectiveLot({ courseCode: params.courseCode, lots: [], activeLotId: null }),
      };
    });

    return {
      rag_course_code: rag.ragCourseCode,
      rag_lot: { id: rag.ragLot.lotId, name: rag.ragLot.name, origin: rag.ragLot.origin },
      rag_sources: attachRagViewerLinks(req, rag.ragSources, rag.ragCourseCode),
    };
  }

  /** Fuentes que van en el prompt; el editor muestra como "material citado" estas mismas. */
  const SUGGEST_TAB_PROMPT_SOURCES = 3;
  /** Reintento de un pedido de codigo sin codigo: solo si la primera respuesta llego antes de esto. */
  const SUGGEST_TAB_RETRY_MAX_ELAPSED_MS = 50_000;
  /** Lo que espera VS Code por /suggest-tab (120 s) menos un margen para la respuesta. */
  const SUGGEST_TAB_CLIENT_WAIT_MS = 110_000;

  function getCachedSuggestTabOutput(namespace: SuggestTabCacheNamespace, key: string) {
    const cache = suggestTabCaches[namespace];
    const entry = cache.get(key);
    if (!entry) return null;
    if (Date.now() - entry.createdAt > suggestTabCacheTtlMs) {
      cache.delete(key);
      return null;
    }

    return entry.output;
  }

  function setCachedSuggestTabOutput(namespace: SuggestTabCacheNamespace, key: string, output: string) {
    const cache = suggestTabCaches[namespace];
    cache.set(key, {
      output,
      createdAt: Date.now(),
    });

    if (cache.size > suggestTabCacheMaxEntries) {
      const entries = [...cache.entries()]
        .sort((left, right) => left[1].createdAt - right[1].createdAt);
      for (const [entryKey] of entries.slice(0, cache.size - suggestTabCacheMaxEntries)) {
        cache.delete(entryKey);
      }
    }
  }

  app.post("/run-text", async (req, res) => {
    const requestId = getRequestId(req);
    const startedAt = Date.now();
    const logger = agentRoutesLog.child({ requestId, route: "/run-text", mode: env.targetMode });
    try {
      const input = trimText(req.body?.input_as_text);
      logger.info("run-text.request.start", {
        input: textStats(input),
        contentLength: trimText(req.header("content-length")),
      });
      if (!input) {
        logger.warn("run-text.request.invalid", {
          reason: "input_as_text requerido",
        });
        return res.status(400).json({ ok: false, error: "input_as_text requerido" });
      }

      // generation: el perfil que manda otro backend encadenado (AGENT_TARGET=azure).
      const generation = req.body?.generation && typeof req.body.generation === "object"
        ? serializableGeneration(req.body.generation as TextGenerationOptions)
        : undefined;
      const { outputText: output, worker } = await runTextByModeDetailed(input, {
        requestId,
        route: "/run-text",
      }, generation);
      logger.info("run-text.request.done", {
        durationMs: durationMs(startedAt),
        output: textStats(output),
        worker: worker.id || worker.provider,
      });
      // worker es aditivo: los clientes que solo leen output_text no se rompen.
      return res.json({ ok: true, output_text: output, worker });
    } catch (error) {
      logger.error("run-text.request.failed", {
        durationMs: durationMs(startedAt),
        error: errorSummary(error),
      });
      return res.status(500).json({ ok: false, error: String(error) });
    }
  });

  /**
   * Estado del backend de inferencia, para que un cliente pueda mostrar
   * de donde sale la GPU sin tener que lanzar un job primero.
   *
   * - mode: local | azure | queue (AGENT_TARGET)
   * - worker: quien atendio el ultimo job, si hubo alguno
   * - queue: nombres de cola cuando el modo es queue
   */
  app.get("/api/agent/backend", (_req, res) => {
    const mode = env.targetMode;
    const lastWorker = getLastWorker();
    const queueConfig = mode === "queue" ? getServiceBusQueueConfig() : null;

    // Latidos (A15.4): quien esta escuchando la cola ahora, no solo quien atendio el ultimo job.
    const listening = listListeningWorkers();
    return res.json({
      ok: true,
      mode,
      worker: lastWorker,
      listening,
      alive_workers: listening.filter((worker) => worker.alive).length,
      // Cuando todavia no ha pasado ningun job, al menos decimos que se espera.
      expected: lastWorker
        ? null
        : describeWorker(mode === "local" ? "" : undefined, { mode }),
      queue: queueConfig
        ? {
            configured: queueConfig.configured,
            missing: queueConfig.missing,
            jobsQueueName: queueConfig.jobsQueueName,
            resultsQueueName: queueConfig.resultsQueueName,
          }
        : null,
      checkedAt: new Date().toISOString(),
    });
  });

  /**
   * Latido de un worker de GPU (A15.4). Cabecera x-worker-token con
   * WORKER_HEARTBEAT_TOKEN. Sin token configurado en el servidor: 503.
   */
  app.post("/api/agent/heartbeat", (req, res) => {
    if (!env.workerHeartbeatToken) {
      return res.status(503).json({ ok: false, error: "WORKER_HEARTBEAT_TOKEN no configurado en el servidor." });
    }
    if (!isHeartbeatTokenValid(req.header("x-worker-token"))) {
      return res.status(401).json({ ok: false, error: "Token de worker invalido." });
    }
    const entry = recordWorkerHeartbeat({
      workerId: trimText(req.body?.workerId),
      model: trimText(req.body?.model),
      jobsProcessed: Number(req.body?.jobsProcessed),
      lastJobAt: trimText(req.body?.lastJobAt),
      startedAt: trimText(req.body?.startedAt),
      platform: trimText(req.body?.platform),
      concurrency: Number(req.body?.concurrency),
      kinds: trimText(req.body?.kinds),
    });
    if (!entry) {
      return res.status(400).json({ ok: false, error: "workerId requerido." });
    }
    return res.status(204).end();
  });

  /**
   * Salud del camino de inferencia: en modo queue exige al menos un worker
   * con latido reciente. Sirve para una alerta de disponibilidad (Azure
   * Monitor / prueba de disponibilidad) que avise cuando no hay GPU.
   */
  app.get("/api/agent/health", (_req, res) => {
    const aliveWorkers = countAliveWorkers();
    if (env.targetMode === "queue" && aliveWorkers === 0) {
      return res.status(503).json({ ok: false, reason: "sin_worker", mode: env.targetMode, alive_workers: 0 });
    }
    return res.json({ ok: true, mode: env.targetMode, alive_workers: aliveWorkers });
  });

  app.post("/run-image", upload.single("image"), async (req, res) => {
    const requestId = getRequestId(req);
    const startedAt = Date.now();
    const logger = agentRoutesLog.child({ requestId, route: "/run-image", mode: env.targetMode });
    try {
      logger.info("run-image.request.start", {
        hasFile: Boolean(req.file),
        mimetype: req.file?.mimetype || "",
        originalname: req.file?.originalname || "",
        size: req.file?.size || 0,
        prompt: textStats(req.body?.prompt),
      });
      if (!req.file) {
        logger.warn("run-image.request.invalid", {
          reason: "image requerida",
        });
        return res.status(400).json({ ok: false, error: "image requerida" });
      }

      const prompt = trimText(req.body?.prompt);
      const output = await runImageByMode(req.file, prompt, { requestId, route: "/run-image" });
      logger.info("run-image.request.done", {
        durationMs: durationMs(startedAt),
        output: textStats(output),
      });
      return res.json({ ok: true, output_text: output });
    } catch (error) {
      logger.error("run-image.request.failed", {
        durationMs: durationMs(startedAt),
        error: errorSummary(error),
      });
      return res.status(500).json({ ok: false, error: String(error) });
    } finally {
      if (req.file?.path) {
        await fsp.unlink(req.file.path).catch(() => {});
      }
    }
  });

  function normalizeSuggestionTrigger(value: unknown) {
    const clean = trimText(value).toLowerCase();
    return ["cursor_idle", "selection", "manual", "blocking", "file_open", "panel"].includes(clean) ? clean : "";
  }

  function parseSuggestionDiagnostics(value: unknown): SuggestionDiagnostic[] {
    if (!Array.isArray(value)) return [];
    return value.slice(0, 10).map((item) => {
      const source = item && typeof item === "object" ? item as Record<string, unknown> : {};
      const line = Number(source.line);
      return {
        message: trimText(source.message).slice(0, 300),
        severity: source.severity === "warning" ? "warning" as const : "error" as const,
        ...(Number.isFinite(line) ? { line: Math.max(0, Math.round(line)) } : {}),
      };
    }).filter((item) => item.message);
  }

  function policyPayload(decision: SuggestionPolicyDecision | null, policy: TeacherPolicy | null) {
    if (!decision || !policy) return null;
    return {
      name: policy.policyName,
      eventType: decision.eventType,
      interventionType: decision.blocked ? "controlled_message" : decision.rule?.interventionType || "hint",
      detailLevel: decision.rule?.detailLevel || "brief",
      helpStage: decision.helpStage,
      blocked: decision.blocked,
      reason: decision.reason,
      reasonCode: decision.reasonCode,
    };
  }

  /**
   * code_application de /suggest-tab (contrato en docs/arquitectura/contrato-api.md, 2.2). Desde el
   * 30-10-2026 dice si el guardarrail recorto el codigo, sin que VS Code busque el texto de la nota:
   *   truncation: "none" (sin recorte), "applicable" (un trozo cerrado o un reemplazo parcial: se
   *               puede aplicar si allowed) o "guide" (solo guia: allowed false). Solo truncation
   *               (con allowed) dice si el codigo se puede aplicar; cut es informativo.
   *   cut: solo con recorte de un bloque; { kind: "prefix", linesShown, linesTotal, bracketsClosed }
   *        o { kind: "partial", changesApplied, changesTotal }.
   *   reasonCode: code_application_too_large en un recorte de guia, salvo que ya no se pudiera
   *               aplicar (docente, cupo o piloto): entonces queda ese motivo.
   */
  function codeApplicationPayload(
    value: CodeApplicationDecision | null,
    cut: { truncation: GuardrailOutcome; summary: CutSummary | null } = { truncation: "none", summary: null },
  ) {
    if (!value) return null;
    return {
      allowed: value.allowed,
      maxLines: value.maxLines,
      remaining: value.remaining,
      requireConfirmation: value.requireConfirmation,
      countsAsHint: value.countsAsHint,
      reason: value.reason,
      reasonCode: value.reasonCode,
      truncation: cut.truncation,
      ...(cut.summary ? { cut: cut.summary } : {}),
    };
  }

  app.post("/suggest-tab", async (req, res) => {
    const requestId = getRequestId(req);
    const startedAt = Date.now();
    let logger = agentRoutesLog.child({ requestId, route: "/suggest-tab", mode: env.targetMode });
    try {
      const tabContent = trimText(req.body?.tab_content);
      logger.info("suggest-tab.request.received", {
        contentLength: trimText(req.header("content-length")),
        tabContent: textStats(tabContent),
        question: textStats(req.body?.question),
        tabTitle: textStats(req.body?.tab_title),
        tabUrl: urlSummary(req.body?.tab_url),
        repoFullName: trimText(req.body?.repoFullName),
        filePath: trimText(req.body?.filePath),
      });
      if (!tabContent) {
        logger.warn("suggest-tab.request.invalid", {
          reason: "tab_content requerido",
        });
        return res.status(400).json({ ok: false, error: "tab_content requerido" });
      }

      const rawQuestion = trimText(req.body?.question);
      const tabTitle = trimText(req.body?.tab_title);
      const tabUrl = trimText(req.body?.tab_url);
      const courseCode = trimText(req.body?.ragCourseCode || req.body?.rag_course_code || req.body?.courseCode || req.body?.course_code);
      const scope = normalizeSuggestionScope(req.body?.suggestion_scope ?? req.body?.suggestionScope, rawQuestion, tabContent);
      const cacheNamespace = cacheNamespaceForScope(scope);
      // Editor: sin las instrucciones de "comentario TODO" de las extensiones anteriores a la
      // 0.0.34 (modernizeEditorQuestion) y con la accion que pidio el estudiante, si la hay.
      const isEditorFocus = isEditorFocusScope(scope);
      const question = isEditorFocus ? modernizeEditorQuestion(rawQuestion) : rawQuestion;
      const requestedAction = isEditorFocus ? normalizeRequestedAction(req.body?.requestedAction ?? req.body?.requested_action) : "";

      // Aviso «Estamos actualizando» (28-10-2026): el tutor responde el aviso, sin decision del
      // tutor ni cache (no es una sugerencia).
      const maintenance = await readMaintenance(database);
      if (maintenance.active) {
        logger.info("suggest-tab.request.maintenance", { durationMs: durationMs(startedAt) });
        return res.json(maintenanceSuggestTabReply(maintenance, { scope, cacheNamespace, courseCode }));
      }

      // --- Politica del docente (A9.10) -------------------------------------
      const trigger = normalizeSuggestionTrigger(req.body?.trigger);
      const filePath = trimText(req.body?.filePath) || tabTitle;
      const languageHint = trimText(req.body?.languageHint);
      const visibleError = trimText(req.body?.visibleError).slice(0, 2000);
      const diagnosticsList = parseSuggestionDiagnostics(req.body?.diagnostics);
      const signals = {
        question,
        scope,
        trigger,
        visibleError,
        diagnostics: diagnosticsList,
        selection: trimText(req.body?.selection),
        tabContent,
        languageHint,
        filePath,
      };
      const exerciseKey = `file:${filePath.toLowerCase()}`;
      const { session: actorSession, actor } = await resolveRequestActor(database, req);
      const policy = await resolvePolicyForSession(database, actorSession).catch(() => null);
      const applicationsUsed = actor
        ? await database.countAllowedCodeApplications(actorAnonId(actor), exerciseHash(exerciseKey)).catch(() => 0)
        : 0;
      // 30-10-2026: «Otra sugerencia» y los pedidos de codigo sobre el cursor o la seleccion
      // tambien suben la etapa (5, 10 y el maximo del docente); los automaticos no.
      const explicitRequest = isExplicitSuggestionRequest({ scope, trigger, requestedAction });
      const explicitRequestsBefore = actor && explicitRequest
        ? await database.countRecentExplicitEditorRequests(
          actorAnonId(actor),
          exerciseHash(exerciseKey),
          new Date(Date.now() - EXPLICIT_REQUEST_WINDOW_MS),
        ).catch(() => 0)
        : 0;
      // A13.1: condicion del estudiante en el piloto AB/BA (vacia fuera del piloto).
      const pilot = await database.getPilotStateForUser(actorSession?.user).catch(() => NO_PILOT);
      const decision = policy
        ? evaluateSuggestionPolicy({ policy, signals, applicationsUsed, explicitRequestsBefore, pilotCondition: pilot.condition })
        : null;
      // Examen 28-10-2026: solucion y guia privadas del docente (exam-reference.ts), solo para el
      // repositorio del ejercicio, con sesion iniciada y con la politica activa (su guardarrail
      // limita el codigo). El resumen del archivo no propone codigo: recibe lo del panel (sin .cpp).
      const examReference = scope === "general"
        ? null
        : resolveExamReferenceForRequest(
          { repoFullName: trimText(req.body?.repoFullName), url: tabUrl, title: tabTitle, filePath },
          {
            channel: scope === "file_summary" ? "panel" : "editor",
            authenticated: Boolean(actorSession),
            policyActive: Boolean(decision && !decision.blocked),
          },
        );
      const decisionId = crypto.randomUUID();
      const errorForPrompt = firstErrorText(signals);
      const effectiveQuestion = [question, errorForPrompt ? `Error visible en el editor: ${errorForPrompt.slice(0, 500)}` : ""]
        .filter(Boolean)
        .join("\n");
      const policyInstruction = policy && decision && !decision.blocked
        ? buildSuggestionPolicyInstruction(policy, decision, { requestedAction })
        : "";
      const cacheKey = buildSuggestTabCacheKey({
        scope,
        tabContent,
        question: `${effectiveQuestion}||${policyInstruction}||${policy?.updatedAt || ""}||${requestedAction}${examReference ? `||examen:${examReference.stepId}` : ""}`,
        tabTitle,
        tabUrl,
        courseCode,
      });
      logger = logger.child({
        scope,
        cacheNamespace,
        cacheHash: shortHash(cacheKey),
        courseCode,
        policyEvent: decision?.eventType || "",
      });

      const recordDecision = async (details: {
        latencyMs: number;
        source: string;
        cached: boolean;
        /** El guardarrail recorto codigo: aplicable (reemplazo parcial o trozo cerrado) o guia. */
        truncation?: GuardrailOutcome;
        /** Sin respuesta del modelo (mensaje controlado): no cuenta como ayuda recibida. */
        degraded?: boolean;
        codeApplication: CodeApplicationDecision | null;
        actorForEvent: TelemetryActor | null;
        reasonCode?: DecisionReasonCode;
        /** Fuentes autorizadas que acompanan la respuesta (KPI de anclaje RAG). */
        ragSources?: number;
        /** Servidor de inferencia que respondio (QUEUE_WORKER_ID). */
        worker?: string;
        /** Otra sugerencia pedida sobre el mismo codigo poco despues («Otra sugerencia»). */
        repeated?: boolean;
      }) => {
        if (!details.actorForEvent) return;
        await database.insertTelemetryEvents([
          {
            source: "backend",
            channel: "vscode",
            category: "tutor",
            eventType: "tutor_decision",
            decisionId,
            courseCode,
            exerciseKey,
            language: languageHint,
            filePath,
            policyEventType: decision?.eventType || "",
            interventionType: decision ? (decision.blocked ? "controlled_message" : decision.rule?.interventionType || "hint") : "",
            helpStage: decision?.helpStage || "",
            reasonCode: details.reasonCode || decision?.reasonCode || "",
            blocked: decision?.blocked ?? false,
            latencyMs: details.latencyMs,
            errorText: errorForPrompt || undefined,
            contextText: tabContent.slice(0, 6000),
            metadata: {
              trigger,
              scope,
              cached: details.cached,
              source: details.source,
              mode: env.targetMode,
              ...(requestedAction ? { requestedAction } : {}),
              ...(details.truncation && details.truncation !== "none" ? { reason: GUARDRAIL_TRUNCATION_REASON[details.truncation] } : {}),
              // Pedido explicito que el tutor respondio: sube la etapa (countRecentExplicitEditorRequests).
              ...(explicitRequest && !details.degraded && !decision?.blocked ? { explicitRequest: true } : {}),
              ...(typeof details.ragSources === "number" ? { ragSources: details.ragSources } : {}),
              ...(details.worker ? { worker: details.worker } : {}),
              ...(decision?.blocked ? { cause: editorBlockCause(decision.reasonCode) } : {}),
              ...(details.repeated ? { repeated: true } : {}),
              ...(details.codeApplication ? { allowed: details.codeApplication.allowed, maxLines: details.codeApplication.maxLines } : {}),
              ...(details.codeApplication && details.codeApplication.remaining !== null ? { remaining: details.codeApplication.remaining } : {}),
            },
          },
        ], details.actorForEvent).catch((error) => {
          logger.warn("suggest-tab.telemetry.failed", { error: errorSummary(error) });
        });
      };

      if (decision?.blocked && policy) {
        const output = buildControlledSuggestionMarkdown(policy, decision);
        await recordDecision({
          latencyMs: durationMs(startedAt),
          source: "policy",
          cached: false,
          codeApplication: decision.codeApplication,
          actorForEvent: actor,
        });
        logger.info("suggest-tab.request.blocked", {
          durationMs: durationMs(startedAt),
          reasonCode: decision.reasonCode,
        });
        return res.json({
          ok: true,
          output_text: output,
          suggestion_scope: scope,
          cache_namespace: cacheNamespace,
          cached: false,
          blocked: true,
          decision_id: actor ? decisionId : null,
          policy_applied: policyPayload(decision, policy),
          code_application: codeApplicationPayload(decision.codeApplication),
          rag_course_code: courseCode,
          rag_sources: [],
        });
      }

      // Revisa la salida con la politica (A10.2) y arma la respuesta comun. Los pasos sobre el
      // texto (y su orden) estan en finalizeEditorSuggestion; aqui solo logs, telemetria y respuesta.
      const finish = async (
        rawOutput: string,
        meta: { cached: boolean; source: string; degraded?: boolean; worker?: string; starting?: boolean; repeated?: boolean },
        ragPayload: { rag_course_code: string; rag_sources: unknown[] },
      ) => {
        // Tambien la de la cache: una respuesta guardada antes del arreglo del 28-10 puede traer
        // la linea «Aplicar:» dentro del bloque de codigo.
        const finalized = finalizeEditorSuggestion(rawOutput, {
          decision,
          options: { requestedAction, selection: signals.selection, languageHint },
          examReference,
        });
        const { text: output, codeApplication, truncation, cutSummary, counters } = finalized;
        if (counters.extraBlocksRemoved) {
          logger.warn("suggest-tab.exam_reference.extra_blocks_removed", { removedBlocks: counters.extraBlocksRemoved });
        }
        if (counters.leakedLinesRemoved) {
          logger.warn("suggest-tab.exam_reference.leak_trimmed", { removedLines: counters.leakedLinesRemoved });
        }
        await recordDecision({
          latencyMs: durationMs(startedAt),
          source: meta.source,
          cached: meta.cached,
          truncation,
          degraded: meta.degraded,
          codeApplication,
          actorForEvent: actor,
          reasonCode: meta.degraded ? "model_error_fallback" : undefined,
          ragSources: Array.isArray(ragPayload.rag_sources) ? ragPayload.rag_sources.length : 0,
          worker: meta.worker,
          repeated: meta.repeated,
        });
        return {
          ok: true,
          output_text: output,
          suggestion_scope: scope,
          cache_namespace: cacheNamespace,
          cached: meta.cached,
          blocked: false,
          requested_action: requestedAction || null,
          ...(meta.degraded ? { degraded: true } : {}),
          ...(meta.starting ? { tutor_starting: true } : {}),
          decision_id: actor ? decisionId : null,
          policy_applied: policyPayload(decision, policy),
          code_application: codeApplicationPayload(codeApplication, { truncation, summary: cutSummary }),
          ...ragPayload,
        };
      };

      logger.info("suggest-tab.request.start", {
        tabContent: textStats(tabContent),
        question: textStats(question),
        tabTitle: textStats(tabTitle),
        tabUrl: urlSummary(tabUrl),
        repoFullName: trimText(req.body?.repoFullName),
        filePath: trimText(req.body?.filePath),
        languageHint,
        trigger,
        helpStage: decision?.helpStage || "",
        ...(examReference ? { examReferenceStep: examReference.stepId || "general", examReferenceChars: examReference.text.length } : {}),
      });
      let ragPayloadPromise: Promise<{ rag_course_code: string; rag_sources: unknown[] }> | null = null;
      const getRagPayload = () => {
        if (!ragPayloadPromise) {
          ragPayloadPromise = buildSuggestTabRagPayload(req, {
            question: effectiveQuestion,
            tabContent,
            tabTitle,
            tabUrl,
            courseCode,
            scope,
            visibleError: errorForPrompt || visibleError,
            logger,
          }).then((payload) => {
            let items = payload.rag_sources as RagContextItem[];
            if (decision && items.length) {
              // A8.6: primero el material que la matriz recomienda para el evento.
              items = prioritizeRagSourcesForScenario(
                items,
                decision.eventType,
                [question, visibleError, signals.selection].filter(Boolean).join("\n"),
              ).items;
            }
            // En el editor, las fuentes que se devuelven son las que vio el modelo.
            if (scope !== "general") items = items.slice(0, SUGGEST_TAB_PROMPT_SOURCES);
            return { ...payload, rag_sources: items };
          });
        }
        return ragPayloadPromise;
      };
      // Un pedido explicito del estudiante en VS Code («Otra sugerencia», «Proponer una
      // mejora»: trigger manual) le pregunta otra vez al modelo; la respuesta nueva si se
      // guarda para los pedidos automaticos.
      const cachedOutput = trigger === "manual" ? null : getCachedSuggestTabOutput(cacheNamespace, cacheKey);
      // Pedido repetido (28-10-2026: dos pistas identicas a las 11:09 sobre el mismo archivo): si
      // pide otra sugerencia sobre el mismo codigo antes de 2 min, el modelo ve la anterior y se le
      // pide una distinta, con algo mas de variedad.
      const previousOutput = trigger === "manual" ? getCachedSuggestTabOutput(cacheNamespace, cacheKey) : null;
      if (cachedOutput) {
        logger.info("suggest-tab.cache.hit", {
          output: textStats(cachedOutput),
        });
        const ragStartedAt = Date.now();
        const ragPayload = await getRagPayload();
        logger.info("suggest-tab.rag.done", {
          durationMs: durationMs(ragStartedAt),
          ragCourseCode: ragPayload.rag_course_code,
          ragSources: ragPayload.rag_sources.length,
          selectedSources: summarizeRagSourcesForLog(ragPayload.rag_sources),
        });
        logger.info("suggest-tab.request.done", {
          durationMs: durationMs(startedAt),
          cached: true,
          output: textStats(cachedOutput),
        });
        return res.json(await finish(cachedOutput, { cached: true, source: "cache" }, ragPayload));
      }

      logger.info("suggest-tab.cache.miss");
      const ragStartedAt = Date.now();
      const ragPayload = await getRagPayload();
      logger.info("suggest-tab.rag.done", {
        durationMs: durationMs(ragStartedAt),
        ragCourseCode: ragPayload.rag_course_code,
        ragSources: ragPayload.rag_sources.length,
        selectedSources: summarizeRagSourcesForLog(ragPayload.rag_sources),
      });
      // Bloque corto: etiqueta, titulo y parrafo que coincide (antes 6000 caracteres de metadatos).
      const ragContext = buildCompactRagPromptBlock(ragPayload.rag_sources as RagContextItem[], {
        maxItems: scope === "general" ? 4 : SUGGEST_TAB_PROMPT_SOURCES,
      });
      const missingPdfText = buildMissingPdfTextAnswer({ question, tabContent });
      if (scope === "general" && missingPdfText) {
        setCachedSuggestTabOutput(cacheNamespace, cacheKey, missingPdfText);
        logger.info("suggest-tab.response.missing-pdf-text", {
          durationMs: durationMs(startedAt),
          output: textStats(missingPdfText),
        });
        return res.json(await finish(missingPdfText, { cached: false, source: "deterministic" }, ragPayload));
      }

      const deterministic = buildDeterministicGradeAnswer({ question, tabContent });
      if (scope === "general" && deterministic) {
        setCachedSuggestTabOutput(cacheNamespace, cacheKey, deterministic);
        logger.info("suggest-tab.response.deterministic", {
          durationMs: durationMs(startedAt),
          output: textStats(deterministic),
        });
        return res.json(await finish(deterministic, { cached: false, source: "deterministic" }, ragPayload));
      }

      let output = "";
      let outputSource = "ai";
      let outputWorker = "";
      const diagnostics = { requestId, route: "/suggest-tab", scope, cacheNamespace };
      try {
        // El agente con herramientas (runSuggestTab) necesita un modelo en esta maquina: solo en
        // modo local. En modo queue el API no tiene GPU y antes fallaba siempre antes de usar la cola.
        if (scope === "general" && env.targetMode === "local" && !hasTextModelOverride()) {
          try {
            const modelStartedAt = Date.now();
            logger.info("suggest-tab.model.advanced.start", {
              runner: "runSuggestTab",
            });
            output = await runSuggestTab({
              tabContent,
              question: effectiveQuestion,
              tabTitle,
              tabUrl,
              maxTabContentChars: env.maxTabContentChars,
              diagnostics: { ...diagnostics, source: "advanced" },
              policyInstruction,
            });
            logger.info("suggest-tab.model.advanced.done", {
              durationMs: durationMs(modelStartedAt),
              output: textStats(output),
            });
          } catch (error) {
            logger.warn("suggest-tab.model.advanced.failed_fallback", {
              error: errorSummary(error),
            });
            outputSource = "ai_fallback";
            const run = await runTextByModeDetailed(
              buildTabSuggestionPrompt({ tabContent, question: effectiveQuestion, tabTitle, tabUrl, ragContext, policyInstruction }),
              { ...diagnostics, source: "advanced-fallback" },
              { profile: "default" },
              { wakeGpu: actor?.kind === "user" },
            );
            output = run.outputText;
            outputWorker = run.worker.id;
          }
        } else {
          logger.info("suggest-tab.model.scoped.start", {
            runner: "runTextByMode",
          });
          const scopedPrompt = buildScopedTabSuggestionPrompt(scope, {
            tabContent,
            question: effectiveQuestion,
            tabTitle,
            tabUrl,
            ragContext,
            policyInstruction,
            requestedAction,
            languageHint,
            reference: examReference,
          });
          logger.info("suggest-tab.prompt.built", { prompt: textStats(scopedPrompt), repeated: Boolean(previousOutput) });
          const run = await runTextByModeDetailed(
            previousOutput ? `${scopedPrompt}\n\n${avoidRepeatInstruction(previousOutput)}` : scopedPrompt,
            { ...diagnostics, source: previousOutput ? "scoped-repeat" : "scoped" },
            // Editor: temperatura baja (el codigo tiene que calzar con el del estudiante).
            previousOutput
              ? { profile: isEditorFocus ? "editor" : "default", temperature: 0.5 }
              : { profile: isEditorFocus ? "editor" : "default" },
            // Sin servidor vivo, despierta la GPU solo un estudiante identificado (sesion o cliente).
            { wakeGpu: actor?.kind === "user" },
          );
          // Sin el margen numerado si el modelo lo copio del contexto (antes del guardarrail).
          // Y sin la linea «Aplicar:» dentro del bloque: si era lo unico, cuenta como sin codigo.
          output = isEditorFocus ? moveApplyLinesOutOfCodeFences(stripCodeFenceGutters(run.outputText)) : run.outputText;
          outputWorker = run.worker.id;
          // El estudiante pidio codigo («Proponer una mejora» o «...para continuar») y volvio sin
          // un bloque de codigo real: un reintento con el motivo al final. Si el reintento falla o
          // tampoco trae codigo, queda la primera respuesta (VS Code avisa que vino sin codigo).
          // Solo si la primera tardo poco: VS Code deja de esperar a los 120 s.
          const codeProblem = requestedAction && decision?.codeApplication.allowed !== false
            ? editorCodeProblem(output)
            : "";
          if (requestedAction && codeProblem && Date.now() - startedAt < SUGGEST_TAB_RETRY_MAX_ELAPSED_MS) {
            logger.warn("suggest-tab.model.code_retry", { reason: codeProblem });
            try {
              // El reintento tiene que terminar antes de que VS Code deje de esperar (120 s): si no,
              // el estudiante se quedaria tambien sin la primera respuesta.
              const retry = await runTextByModeDetailed(
                `${scopedPrompt}\n\n${editorCodeRetryInstruction(requestedAction, languageHint)}`,
                { ...diagnostics, source: "scoped-retry" },
                { profile: "editor", temperature: 0.35 },
                { timeoutMs: Math.max(15_000, SUGGEST_TAB_CLIENT_WAIT_MS - (Date.now() - startedAt)) },
              );
              const retryOutput = moveApplyLinesOutOfCodeFences(stripCodeFenceGutters(retry.outputText));
              if (!editorCodeProblem(retryOutput)) {
                output = retryOutput;
                outputWorker = retry.worker.id;
                outputSource = "ai_retry";
              }
            } catch (error) {
              logger.warn("suggest-tab.model.code_retry_failed", { error: errorSummary(error) });
            }
          }
        }
      } catch (error) {
        // A12.10: sin modelo (GPU apagada, cola sin worker, error del
        // proveedor) el estudiante recibe un mensaje controlado, no un 500.
        // No se guarda en cache para reintentar cuando vuelva el modelo.
        logger.warn("suggest-tab.model.failed_degraded", {
          durationMs: durationMs(startedAt),
          error: errorSummary(error),
        });
        // Sin servidor vivo y con la GPU encendiendose (GPU_AUTOSTART, 28-10-2026): que vuelva en
        // 2 o 3 minutos, no un fallo.
        const starting = isTutorStartingError(error);
        return res.json(await finish(
          starting ? buildStartingSuggestionMarkdown(tutorStartingMessage()) : buildUnavailableSuggestionMarkdown(),
          { cached: false, source: "degraded", degraded: true, starting },
          ragPayload,
        ));
      }
      // Un pedido de codigo que volvio sin codigo no se guarda: el siguiente intento le
      // pregunta otra vez al modelo.
      if (!requestedAction || hasClosedCodeBlock(output)) {
        setCachedSuggestTabOutput(cacheNamespace, cacheKey, output);
      }
      logger.info("suggest-tab.request.done", {
        durationMs: durationMs(startedAt),
        cached: false,
        output: textStats(output),
      });

      return res.json(await finish(output, { cached: false, source: outputSource, worker: outputWorker, repeated: Boolean(previousOutput) }, ragPayload));
    } catch (error) {
      logger.error("suggest-tab.request.failed", {
        durationMs: durationMs(startedAt),
        error: errorSummary(error),
      });
      return res.status(500).json({ ok: false, error: String(error) });
    }
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

  app.post("/run", upload.single("image"), async (req, res) => {
    const requestId = getRequestId(req);
    const startedAt = Date.now();
    const logger = agentRoutesLog.child({ requestId, route: "/run", mode: env.targetMode });
    try {
      logger.info("run.request.start", {
        hasFile: Boolean(req.file),
        input: textStats(req.body?.input_as_text),
        prompt: textStats(req.body?.prompt),
        mimetype: req.file?.mimetype || "",
        originalname: req.file?.originalname || "",
        size: req.file?.size || 0,
      });
      if (req.file) {
        const prompt = trimText(req.body?.prompt);
        const output = await runImageByMode(req.file, prompt, { requestId, route: "/run" });
        logger.info("run.request.done", {
          durationMs: durationMs(startedAt),
          kind: "image",
          output: textStats(output),
        });
        return res.json({ ok: true, output_text: output });
      }

      const input = trimText(req.body?.input_as_text);
      if (!input) {
        logger.warn("run.request.invalid", {
          reason: "input_as_text requerido",
        });
        return res.status(400).json({ ok: false, error: "input_as_text requerido" });
      }

      const output = await runTextByMode(input, { requestId, route: "/run" });
      logger.info("run.request.done", {
        durationMs: durationMs(startedAt),
        kind: "text",
        output: textStats(output),
      });
      return res.json({ ok: true, output_text: output });
    } catch (error) {
      logger.error("run.request.failed", {
        durationMs: durationMs(startedAt),
        error: errorSummary(error),
      });
      return res.status(500).json({ ok: false, error: String(error) });
    } finally {
      if (req.file?.path) {
        await fsp.unlink(req.file.path).catch(() => {});
      }
    }
  });
}

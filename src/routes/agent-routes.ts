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
  runImageByMode,
  runTextByMode,
  runTextByModeDetailed,
} from "../services/agent-mode.js";
import { getServiceBusQueueConfig } from "../services/service-bus-agent.js";
import { describeWorker, getLastWorker } from "../services/worker-identity.js";
import {
  countAliveWorkers,
  isHeartbeatTokenValid,
  listListeningWorkers,
  recordWorkerHeartbeat,
} from "../services/worker-heartbeat.js";
import { buildDeterministicGradeAnswer, buildMissingPdfTextAnswer } from "../services/tab-fallbacks.js";
import { buildRagPromptBlock } from "../services/rag-sources.js";
import { prioritizeRagSourcesForScenario } from "../services/scenario-resources.js";
import {
  buildScopedTabSuggestionPrompt,
  buildTabSuggestionPrompt,
  type TabSuggestionScope,
} from "../services/tab-suggestion-prompt.js";
import { trimText } from "../services/text-utils.js";
import {
  applySuggestionGuardrail,
  buildControlledSuggestionMarkdown,
  buildUnavailableSuggestionMarkdown,
  buildSuggestionPolicyInstruction,
  evaluateSuggestionPolicy,
  firstErrorText,
  type CodeApplicationDecision,
  type SuggestionDiagnostic,
  type SuggestionPolicyDecision,
} from "../services/suggestion-policy.js";
import { actorAnonId, exerciseHash, type TelemetryActor } from "../services/telemetry.js";
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

export function registerAgentRoutes(
  app: express.Express,
  database: AppDatabase,
  upload: ImageUploadMiddleware,
) {
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
    const rag = await resolveMentorRagContext({
      question: params.question,
      context,
      session,
      database,
    }).catch((error) => {
      params.logger?.warn("suggest-tab.rag.resolve.failed", {
        error: errorSummary(error),
      });
      return { ragSources: [], ragCourseCode: params.courseCode };
    });

    return {
      rag_course_code: rag.ragCourseCode,
      rag_sources: attachRagViewerLinks(req, rag.ragSources, rag.ragCourseCode),
    };
  }

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

      const { outputText: output, worker } = await runTextByModeDetailed(input, {
        requestId,
        route: "/run-text",
      });
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

  function codeApplicationPayload(value: CodeApplicationDecision | null) {
    if (!value) return null;
    return {
      allowed: value.allowed,
      maxLines: value.maxLines,
      remaining: value.remaining,
      requireConfirmation: value.requireConfirmation,
      countsAsHint: value.countsAsHint,
      reason: value.reason,
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

      const question = trimText(req.body?.question);
      const tabTitle = trimText(req.body?.tab_title);
      const tabUrl = trimText(req.body?.tab_url);
      const courseCode = trimText(req.body?.ragCourseCode || req.body?.rag_course_code || req.body?.courseCode || req.body?.course_code);
      const scope = normalizeSuggestionScope(req.body?.suggestion_scope ?? req.body?.suggestionScope, question, tabContent);
      const cacheNamespace = cacheNamespaceForScope(scope);

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
      const decision = policy ? evaluateSuggestionPolicy({ policy, signals, applicationsUsed }) : null;
      const decisionId = crypto.randomUUID();
      const errorForPrompt = firstErrorText(signals);
      const effectiveQuestion = [question, errorForPrompt ? `Error visible en el editor: ${errorForPrompt.slice(0, 500)}` : ""]
        .filter(Boolean)
        .join("\n");
      const policyInstruction = policy && decision && !decision.blocked
        ? buildSuggestionPolicyInstruction(policy, decision)
        : "";
      const cacheKey = buildSuggestTabCacheKey({
        scope,
        tabContent,
        question: `${effectiveQuestion}||${policyInstruction}||${policy?.updatedAt || ""}`,
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
        truncated?: boolean;
        codeApplication: CodeApplicationDecision | null;
        actorForEvent: TelemetryActor | null;
        reasonCode?: DecisionReasonCode;
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
              ...(details.truncated ? { reason: "codigo_recortado" } : {}),
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

      // Revisa la salida con la politica (A10.2) y arma la respuesta comun.
      const finish = async (
        rawOutput: string,
        meta: { cached: boolean; source: string; degraded?: boolean },
        ragPayload: { rag_course_code: string; rag_sources: unknown[] },
      ) => {
        let output = rawOutput;
        let codeApplication = decision?.codeApplication || null;
        let truncated = false;
        if (decision) {
          const guarded = applySuggestionGuardrail(rawOutput, decision);
          output = guarded.text;
          truncated = guarded.truncated;
          if (guarded.truncated && codeApplication?.allowed) {
            codeApplication = {
              ...codeApplication,
              allowed: false,
              reason: `El codigo sugerido pasaba de ${codeApplication.maxLines} lineas y se recorto: usalo como guia.`,
              reasonCode: "code_application_too_large",
            };
          }
        }
        await recordDecision({
          latencyMs: durationMs(startedAt),
          source: meta.source,
          cached: meta.cached,
          truncated,
          codeApplication,
          actorForEvent: actor,
          reasonCode: meta.degraded ? "model_error_fallback" : undefined,
        });
        return {
          ok: true,
          output_text: output,
          suggestion_scope: scope,
          cache_namespace: cacheNamespace,
          cached: meta.cached,
          blocked: false,
          ...(meta.degraded ? { degraded: true } : {}),
          decision_id: actor ? decisionId : null,
          policy_applied: policyPayload(decision, policy),
          code_application: codeApplicationPayload(codeApplication),
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
            logger,
          }).then((payload) => {
            if (!decision || !payload.rag_sources.length) return payload;
            // A8.6: primero el material que la matriz recomienda para el evento.
            const prioritized = prioritizeRagSourcesForScenario(
              payload.rag_sources as RagContextItem[],
              decision.eventType,
              [question, visibleError, signals.selection].filter(Boolean).join("\n"),
            );
            return { ...payload, rag_sources: prioritized.items };
          });
        }
        return ragPayloadPromise;
      };
      const cachedOutput = getCachedSuggestTabOutput(cacheNamespace, cacheKey);
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
      const ragContext = buildRagPromptBlock(ragPayload.rag_sources as RagContextItem[]);
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
      const diagnostics = { requestId, route: "/suggest-tab", scope, cacheNamespace };
      try {
        if (scope === "general" && env.targetMode !== "azure" && !hasTextModelOverride()) {
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
            output = await runTextByMode(
              buildTabSuggestionPrompt({ tabContent, question: effectiveQuestion, tabTitle, tabUrl, ragContext, policyInstruction }),
              { ...diagnostics, source: "advanced-fallback" },
            );
          }
        } else {
          logger.info("suggest-tab.model.scoped.start", {
            runner: "runTextByMode",
          });
          output = await runTextByMode(
            buildScopedTabSuggestionPrompt(scope, {
              tabContent,
              question: effectiveQuestion,
              tabTitle,
              tabUrl,
              ragContext,
              policyInstruction,
            }),
            { ...diagnostics, source: "scoped" },
          );
        }
      } catch (error) {
        // A12.10: sin modelo (GPU apagada, cola sin worker, error del
        // proveedor) el estudiante recibe un mensaje controlado, no un 500.
        // No se guarda en cache para reintentar cuando vuelva el modelo.
        logger.warn("suggest-tab.model.failed_degraded", {
          durationMs: durationMs(startedAt),
          error: errorSummary(error),
        });
        return res.json(await finish(
          buildUnavailableSuggestionMarkdown(),
          { cached: false, source: "degraded", degraded: true },
          ragPayload,
        ));
      }
      setCachedSuggestTabOutput(cacheNamespace, cacheKey, output);
      logger.info("suggest-tab.request.done", {
        durationMs: durationMs(startedAt),
        cached: false,
        output: textStats(output),
      });

      return res.json(await finish(output, { cached: false, source: outputSource }, ragPayload));
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
      const { session, actor } = await resolveRequestActor(database, req);

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

      return res.json({
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
        rag_sources: attachRagViewerLinks(req, evaluation.ragSources, evaluation.ragCourseCode),
      });
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

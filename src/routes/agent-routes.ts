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
import { runImageByMode, runTextByMode } from "../services/agent-mode.js";
import { buildDeterministicGradeAnswer, buildMissingPdfTextAnswer } from "../services/tab-fallbacks.js";
import { buildRagPromptBlock } from "../services/rag-sources.js";
import {
  buildScopedTabSuggestionPrompt,
  buildTabSuggestionPrompt,
  type TabSuggestionScope,
} from "../services/tab-suggestion-prompt.js";
import { trimText } from "../services/text-utils.js";
import type { GithubMentorContext, RagContextItem } from "../types/app.js";
import { boundedInteger, getRequestBaseUrl, resolveSession } from "./route-utils.js";

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

function buildRagViewerUrl(
  req: express.Request,
  item: RagContextItem,
  sessionId: string,
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
  if (sessionId) params.set("sessionId", sessionId);

  const query = params.toString();
  return `${baseUrl}/api/rag/sources/${encodeURIComponent(sourceId)}/view${query ? `?${query}` : ""}`;
}

function attachRagViewerLinks(
  req: express.Request,
  items: RagContextItem[],
  sessionId: string,
  fallbackCourseCode: string,
): RagContextItemWithViewer[] {
  return items.map((item) => {
    const courseCode = ragItemCourseCode(item, fallbackCourseCode);
    const externalUrl = trimText(item.citation?.url);
    const viewerUrl = buildRagViewerUrl(req, item, sessionId, courseCode);
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
      rag_sources: attachRagViewerLinks(req, rag.ragSources, session?.id || "", rag.ragCourseCode),
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

      const output = await runTextByMode(input, { requestId, route: "/run-text" });
      logger.info("run-text.request.done", {
        durationMs: durationMs(startedAt),
        output: textStats(output),
      });
      return res.json({ ok: true, output_text: output });
    } catch (error) {
      logger.error("run-text.request.failed", {
        durationMs: durationMs(startedAt),
        error: errorSummary(error),
      });
      return res.status(500).json({ ok: false, error: String(error) });
    }
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
      const cacheKey = buildSuggestTabCacheKey({ scope, tabContent, question, tabTitle, tabUrl, courseCode });
      logger = logger.child({
        scope,
        cacheNamespace,
        cacheHash: shortHash(cacheKey),
        courseCode,
      });
      logger.info("suggest-tab.request.start", {
        tabContent: textStats(tabContent),
        question: textStats(question),
        tabTitle: textStats(tabTitle),
        tabUrl: urlSummary(tabUrl),
        repoFullName: trimText(req.body?.repoFullName),
        filePath: trimText(req.body?.filePath),
        languageHint: trimText(req.body?.languageHint),
      });
      let ragPayloadPromise: Promise<{ rag_course_code: string; rag_sources: unknown[] }> | null = null;
      const getRagPayload = () => {
        if (!ragPayloadPromise) {
          ragPayloadPromise = buildSuggestTabRagPayload(req, {
            question,
            tabContent,
            tabTitle,
            tabUrl,
            courseCode,
            logger,
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
        return res.json({
          ok: true,
          output_text: cachedOutput,
          suggestion_scope: scope,
          cache_namespace: cacheNamespace,
          cached: true,
          ...ragPayload,
        });
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
        return res.json({
          ok: true,
          output_text: missingPdfText,
          suggestion_scope: scope,
          cache_namespace: cacheNamespace,
          cached: false,
          ...ragPayload,
        });
      }

      const deterministic = buildDeterministicGradeAnswer({ question, tabContent });
      if (scope === "general" && deterministic) {
        setCachedSuggestTabOutput(cacheNamespace, cacheKey, deterministic);
        logger.info("suggest-tab.response.deterministic", {
          durationMs: durationMs(startedAt),
          output: textStats(deterministic),
        });
        return res.json({
          ok: true,
          output_text: deterministic,
          suggestion_scope: scope,
          cache_namespace: cacheNamespace,
          cached: false,
          ...ragPayload,
        });
      }

      let output = "";
      const diagnostics = { requestId, route: "/suggest-tab", scope, cacheNamespace };
      if (scope === "general" && env.targetMode !== "azure") {
        try {
          const modelStartedAt = Date.now();
          logger.info("suggest-tab.model.advanced.start", {
            runner: "runSuggestTab",
          });
          output = await runSuggestTab({
            tabContent,
            question,
            tabTitle,
            tabUrl,
            maxTabContentChars: env.maxTabContentChars,
            diagnostics: { ...diagnostics, source: "advanced" },
          });
          logger.info("suggest-tab.model.advanced.done", {
            durationMs: durationMs(modelStartedAt),
            output: textStats(output),
          });
        } catch (error) {
          logger.warn("suggest-tab.model.advanced.failed_fallback", {
            error: errorSummary(error),
          });
          output = await runTextByMode(
            buildTabSuggestionPrompt({ tabContent, question, tabTitle, tabUrl, ragContext }),
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
            question,
            tabTitle,
            tabUrl,
            ragContext,
          }),
          { ...diagnostics, source: "scoped" },
        );
      }
      setCachedSuggestTabOutput(cacheNamespace, cacheKey, output);
      logger.info("suggest-tab.request.done", {
        durationMs: durationMs(startedAt),
        cached: false,
        output: textStats(output),
      });

      return res.json({
        ok: true,
        output_text: output,
        suggestion_scope: scope,
        cache_namespace: cacheNamespace,
        cached: false,
        ...ragPayload,
      });
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
      const session = await resolveSession(database, req);

      const evaluation = await evaluateMentorIntervention({
        question,
        context: rawContext,
        maxItems,
        session,
        database,
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
        rag_course_code: evaluation.ragCourseCode,
        rag_sources: attachRagViewerLinks(req, evaluation.ragSources, session?.id || "", evaluation.ragCourseCode),
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

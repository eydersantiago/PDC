import fsp from "node:fs/promises";
import crypto from "node:crypto";
import type express from "express";
import { runSuggestTab } from "../../runSuggestTab.js";
import { env } from "../config/env.js";
import type { AppDatabase } from "../db/database.js";
import { evaluateMentorIntervention, resolveMentorRagContext } from "../services/decision-engine.js";
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
    },
  ) {
    const session = await resolveSession(database, req).catch(() => null);
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
    }).catch(() => ({ ragSources: [], ragCourseCode: params.courseCode }));

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
    try {
      const input = trimText(req.body?.input_as_text);
      if (!input) {
        return res.status(400).json({ ok: false, error: "input_as_text requerido" });
      }

      const output = await runTextByMode(input);
      return res.json({ ok: true, output_text: output });
    } catch (error) {
      return res.status(500).json({ ok: false, error: String(error) });
    }
  });

  app.post("/run-image", upload.single("image"), async (req, res) => {
    try {
      if (!req.file) {
        return res.status(400).json({ ok: false, error: "image requerida" });
      }

      const prompt = trimText(req.body?.prompt);
      const output = await runImageByMode(req.file, prompt);
      return res.json({ ok: true, output_text: output });
    } catch (error) {
      return res.status(500).json({ ok: false, error: String(error) });
    } finally {
      if (req.file?.path) {
        await fsp.unlink(req.file.path).catch(() => {});
      }
    }
  });

  app.post("/suggest-tab", async (req, res) => {
    try {
      const tabContent = trimText(req.body?.tab_content);
      if (!tabContent) {
        return res.status(400).json({ ok: false, error: "tab_content requerido" });
      }

      const question = trimText(req.body?.question);
      const tabTitle = trimText(req.body?.tab_title);
      const tabUrl = trimText(req.body?.tab_url);
      const courseCode = trimText(req.body?.ragCourseCode || req.body?.rag_course_code || req.body?.courseCode || req.body?.course_code);
      const scope = normalizeSuggestionScope(req.body?.suggestion_scope ?? req.body?.suggestionScope, question, tabContent);
      const cacheNamespace = cacheNamespaceForScope(scope);
      const cacheKey = buildSuggestTabCacheKey({ scope, tabContent, question, tabTitle, tabUrl, courseCode });
      let ragPayloadPromise: Promise<{ rag_course_code: string; rag_sources: unknown[] }> | null = null;
      const getRagPayload = () => {
        if (!ragPayloadPromise) {
          ragPayloadPromise = buildSuggestTabRagPayload(req, {
            question,
            tabContent,
            tabTitle,
            tabUrl,
            courseCode,
          });
        }
        return ragPayloadPromise;
      };
      const cachedOutput = getCachedSuggestTabOutput(cacheNamespace, cacheKey);
      if (cachedOutput) {
        return res.json({
          ok: true,
          output_text: cachedOutput,
          suggestion_scope: scope,
          cache_namespace: cacheNamespace,
          cached: true,
          ...(await getRagPayload()),
        });
      }

      const ragPayload = await getRagPayload();
      const ragContext = buildRagPromptBlock(ragPayload.rag_sources as RagContextItem[]);
      const missingPdfText = buildMissingPdfTextAnswer({ question, tabContent });
      if (scope === "general" && missingPdfText) {
        setCachedSuggestTabOutput(cacheNamespace, cacheKey, missingPdfText);
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
      if (scope === "general" && env.targetMode !== "azure") {
        try {
          output = await runSuggestTab({
            tabContent,
            question,
            tabTitle,
            tabUrl,
            maxTabContentChars: env.maxTabContentChars,
          });
        } catch {
          output = await runTextByMode(buildTabSuggestionPrompt({ tabContent, question, tabTitle, tabUrl, ragContext }));
        }
      } else {
        output = await runTextByMode(buildScopedTabSuggestionPrompt(scope, {
          tabContent,
          question,
          tabTitle,
          tabUrl,
          ragContext,
        }));
      }
      setCachedSuggestTabOutput(cacheNamespace, cacheKey, output);

      return res.json({
        ok: true,
        output_text: output,
        suggestion_scope: scope,
        cache_namespace: cacheNamespace,
        cached: false,
        ...ragPayload,
      });
    } catch (error) {
      return res.status(500).json({ ok: false, error: String(error) });
    }
  });

  async function handleStructuredIntervention(req: express.Request, res: express.Response) {
    try {
      const question = trimText(req.body?.question) || "Sugiere ideas y busquedas para mejorar este codigo.";
      const maxItems = boundedInteger(req.body?.max_items, 6, 3, 8);
      const rawContext = (req.body?.context || {}) as GithubMentorContext;
      const session = await resolveSession(database, req);

      const evaluation = await evaluateMentorIntervention({
        question,
        context: rawContext,
        maxItems,
        session,
        database,
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
      return res.status(500).json({ ok: false, error: String(error) });
    }
  }

  app.post("/intervene", handleStructuredIntervention);
  app.post("/github-mentor", handleStructuredIntervention);

  app.post("/run", upload.single("image"), async (req, res) => {
    try {
      if (req.file) {
        const prompt = trimText(req.body?.prompt);
        const output = await runImageByMode(req.file, prompt);
        return res.json({ ok: true, output_text: output });
      }

      const input = trimText(req.body?.input_as_text);
      if (!input) {
        return res.status(400).json({ ok: false, error: "input_as_text requerido" });
      }

      const output = await runTextByMode(input);
      return res.json({ ok: true, output_text: output });
    } catch (error) {
      return res.status(500).json({ ok: false, error: String(error) });
    } finally {
      if (req.file?.path) {
        await fsp.unlink(req.file.path).catch(() => {});
      }
    }
  });
}

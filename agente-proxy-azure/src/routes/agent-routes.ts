import fsp from "node:fs/promises";
import crypto from "node:crypto";
import type express from "express";
import { runSuggestTab } from "../../runSuggestTab.js";
import { env } from "../config/env.js";
import type { AppDatabase } from "../db/database.js";
import { evaluateMentorIntervention } from "../services/decision-engine.js";
import { runImageByMode, runTextByMode } from "../services/agent-mode.js";
import { buildDeterministicGradeAnswer, buildMissingPdfTextAnswer } from "../services/tab-fallbacks.js";
import { buildTabSuggestionPrompt } from "../services/tab-suggestion-prompt.js";
import { trimText } from "../services/text-utils.js";
import type { GithubMentorContext } from "../types/app.js";
import { boundedInteger, resolveSession } from "./route-utils.js";

type ImageUploadMiddleware = {
  single(fieldName: string): express.RequestHandler;
};

export function registerAgentRoutes(
  app: express.Express,
  database: AppDatabase,
  upload: ImageUploadMiddleware,
) {
  const suggestTabCache = new Map<string, { output: string; createdAt: number }>();
  const suggestTabCacheTtlMs = 120_000;
  const suggestTabCacheMaxEntries = 120;

  function buildSuggestTabCacheKey(params: {
    tabContent: string;
    question: string;
    tabTitle: string;
    tabUrl: string;
  }) {
    const contentHash = crypto.createHash("sha256").update(params.tabContent).digest("hex");
    const headerHash = crypto.createHash("sha256")
      .update(`${params.tabUrl}||${params.tabTitle}||${params.question}`)
      .digest("hex");
    return `${headerHash}.${contentHash}`;
  }

  function getCachedSuggestTabOutput(key: string) {
    const entry = suggestTabCache.get(key);
    if (!entry) return null;
    if (Date.now() - entry.createdAt > suggestTabCacheTtlMs) {
      suggestTabCache.delete(key);
      return null;
    }

    return entry.output;
  }

  function setCachedSuggestTabOutput(key: string, output: string) {
    suggestTabCache.set(key, {
      output,
      createdAt: Date.now(),
    });

    if (suggestTabCache.size > suggestTabCacheMaxEntries) {
      const entries = [...suggestTabCache.entries()]
        .sort((left, right) => left[1].createdAt - right[1].createdAt);
      for (const [entryKey] of entries.slice(0, suggestTabCache.size - suggestTabCacheMaxEntries)) {
        suggestTabCache.delete(entryKey);
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
      const cacheKey = buildSuggestTabCacheKey({ tabContent, question, tabTitle, tabUrl });
      const cachedOutput = getCachedSuggestTabOutput(cacheKey);
      if (cachedOutput) {
        return res.json({ ok: true, output_text: cachedOutput });
      }

      const missingPdfText = buildMissingPdfTextAnswer({ question, tabContent });
      if (missingPdfText) {
        setCachedSuggestTabOutput(cacheKey, missingPdfText);
        return res.json({ ok: true, output_text: missingPdfText });
      }

      const deterministic = buildDeterministicGradeAnswer({ question, tabContent });
      if (deterministic) {
        setCachedSuggestTabOutput(cacheKey, deterministic);
        return res.json({ ok: true, output_text: deterministic });
      }

      let output = "";
      if (env.targetMode !== "azure") {
        try {
          output = await runSuggestTab({
            tabContent,
            question,
            tabTitle,
            tabUrl,
            maxTabContentChars: env.maxTabContentChars,
          });
        } catch {
          output = await runTextByMode(buildTabSuggestionPrompt({ tabContent, question, tabTitle, tabUrl }));
        }
      } else {
        output = await runTextByMode(buildTabSuggestionPrompt({ tabContent, question, tabTitle, tabUrl }));
      }
      setCachedSuggestTabOutput(cacheKey, output);

      return res.json({ ok: true, output_text: output });
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

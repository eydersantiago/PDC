import type express from "express";
import crypto from "node:crypto";
import { z } from "zod";
import type { AppDatabase } from "../db/database.js";
import { analyzeCampusPage } from "../services/campus-normalizer.js";
import { trimText } from "../services/text-utils.js";
import { errorMessage, resolveSession } from "./route-utils.js";

const campusLinkSchema = z.object({
  text: z.string().max(300).optional(),
  href: z.string().max(1400).optional(),
  kind: z.string().max(80).optional(),
});

const campusActivitySchema = z.object({
  title: z.string().max(500).optional(),
  type: z.string().max(80).optional(),
  url: z.string().max(1400).optional(),
  description: z.string().max(20000).optional(),
  sectionTitle: z.string().max(300).optional(),
  visibleDueText: z.string().max(500).optional(),
  dueAt: z.string().max(120).optional(),
});

type CampusAnalyzePagePayload = z.infer<typeof campusAnalyzePageSchema>;

const campusAnalyzePageSchema = z.object({
  courseId: z.coerce.number().int().positive().optional().nullable(),
  source: z.enum(["browser_dom", "moodle_api"]).optional().default("browser_dom"),
  url: z.string().max(1400).optional(),
  title: z.string().max(500).optional(),
  visibleText: z.string().max(180000).optional(),
  text: z.string().max(180000).optional(),
  selection: z.string().max(10000).optional(),
  links: z.array(campusLinkSchema).max(500).optional(),
  activities: z.array(campusActivitySchema).max(500).optional(),
});

export function registerCampusRoutes(app: express.Express, database: AppDatabase) {
  const campusAnalyzeCache = new Map<string, { analysis: unknown; createdAt: number }>();
  const campusAnalyzeCacheTtlMs = 120_000;
  const campusAnalyzeCacheMaxEntries = 180;

  function buildCampusAnalyzeKey(payload: CampusAnalyzePagePayload) {
    const keyPayload = {
      courseId: payload.courseId,
      source: payload.source,
      url: payload.url,
      title: payload.title,
      visibleText: trimText(payload.visibleText || payload.text || ""),
      text: trimText(payload.text || ""),
      selection: trimText(payload.selection || ""),
      links: Array.isArray(payload.links) ? payload.links.map((link) => ({
        text: trimText(link.text || ""),
        href: trimText(link.href || ""),
        kind: trimText(link.kind || ""),
      })).slice(0, 500) : [],
      activities: Array.isArray(payload.activities) ? payload.activities.map((activity) => ({
        title: trimText(activity.title || ""),
        type: trimText(activity.type || ""),
        url: trimText(activity.url || ""),
        description: trimText(activity.description || "").slice(0, 800),
        sectionTitle: trimText(activity.sectionTitle || ""),
        visibleDueText: trimText(activity.visibleDueText || ""),
        dueAt: trimText(activity.dueAt || ""),
      })).slice(0, 500) : [],
    };
    const normalized = JSON.stringify(keyPayload);
    return crypto.createHash("sha256").update(normalized).digest("hex");
  }

  function getCachedCampusAnalyze(key: string) {
    const entry = campusAnalyzeCache.get(key);
    if (!entry) return null;
    if (Date.now() - entry.createdAt > campusAnalyzeCacheTtlMs) {
      campusAnalyzeCache.delete(key);
      return null;
    }
    return entry.analysis;
  }

  function setCachedCampusAnalyze(key: string, analysis: unknown) {
    campusAnalyzeCache.set(key, {
      analysis,
      createdAt: Date.now(),
    });
    if (campusAnalyzeCache.size > campusAnalyzeCacheMaxEntries) {
      const entries = [...campusAnalyzeCache.entries()]
        .sort((left, right) => left[1].createdAt - right[1].createdAt);
      for (const [entryKey] of entries.slice(0, campusAnalyzeCache.size - campusAnalyzeCacheMaxEntries)) {
        campusAnalyzeCache.delete(entryKey);
      }
    }
  }

  app.post("/api/campus/analyze-page", async (req, res) => {
    try {
      const payload = campusAnalyzePageSchema.parse(req.body || {});
      const session = await resolveSession(database, req);
      const cacheKey = buildCampusAnalyzeKey(payload);
      const cached = getCachedCampusAnalyze(cacheKey);
      if (cached) {
        return res.json({
          ok: true,
          authenticated: !!session,
          analysis: cached,
        });
      }
      const analysis = analyzeCampusPage(payload);
      setCachedCampusAnalyze(cacheKey, analysis);

      return res.json({
        ok: true,
        authenticated: !!session,
        analysis,
      });
    } catch (error) {
      const isBadRequest = error instanceof z.ZodError;
      return res.status(isBadRequest ? 400 : 500).json({
        ok: false,
        error: errorMessage(error),
      });
    }
  });
}

import type express from "express";
import { z } from "zod";
import type { AppDatabase } from "../db/database.js";
import { analyzeCampusPage } from "../services/campus-normalizer.js";
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
  app.post("/api/campus/analyze-page", async (req, res) => {
    try {
      const payload = campusAnalyzePageSchema.parse(req.body || {});
      const session = await resolveSession(database, req);
      const analysis = analyzeCampusPage(payload);

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

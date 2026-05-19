import type express from "express";
import { z } from "zod";
import type { AppDatabase } from "../db/database.js";
import { trimText } from "../services/text-utils.js";
import { errorMessage, resolveSession } from "./route-utils.js";

const saveActiveTabSchema = z.object({
  tabId: z.string().max(220).optional(),
  tabUrl: z.string().max(1800).optional(),
  tabTitle: z.string().max(600).optional(),
  viewContext: z.string().max(260).optional(),
  isActive: z.boolean().optional().default(true),
});

export function registerUiTabRoutes(app: express.Express, database: AppDatabase) {
  const staleTabMs = 120_000;
  const maxTextLengths = {
    tabId: 220,
    tabUrl: 1800,
    tabTitle: 600,
    viewContext: 260,
  } as const;

  type ResolvedSession = {
    user: {
      id: string;
    };
    id: string;
  };

  function buildDefaultTabState() {
    return {
      ok: true,
      activeTab: null,
      stale: false,
    };
  }

  function sanitizeText(value: string | undefined, max = 260) {
    return trimText(value).slice(0, max);
  }

  async function getActiveTabForSession(session: ResolvedSession) {
    if (!session) {
      return buildDefaultTabState();
    }

    const current = await database.getActiveTabForUser(session.user.id);
    if (!current) {
      return buildDefaultTabState();
    }

    const stale = Date.now() - new Date(current.seenAt).getTime() > staleTabMs;
    const belongsToSession = !current.sessionId || current.sessionId === session.id;
    const isActive = current.isActive && !stale && belongsToSession;

    return {
      ok: true,
      activeTab: {
        ...current,
        isActive,
      },
      stale,
    };
  }

  app.get("/api/ui/active-tab", async (req, res) => {
    try {
      const session = await resolveSession(database, req);
      if (!session) {
        return res.status(401).json({ ok: false, error: "Sesion no valida." });
      }

      return res.json(await getActiveTabForSession(session));
    } catch (error) {
      return res.status(500).json({ ok: false, error: errorMessage(error) });
    }
  });

  app.post("/api/ui/active-tab", async (req, res) => {
    try {
      const session = await resolveSession(database, req);
      if (!session) {
      return res.status(401).json({ ok: false, error: "Sesion no valida." });
      }

      const payload = saveActiveTabSchema.parse(req.body || {});
      const normalizedTabId = sanitizeText(payload.tabId, maxTextLengths.tabId);
      const normalizedTabUrl = sanitizeText(payload.tabUrl, maxTextLengths.tabUrl);
      const normalizedTabTitle = sanitizeText(payload.tabTitle, maxTextLengths.tabTitle);
      const normalizedViewContext = sanitizeText(payload.viewContext, maxTextLengths.viewContext);
      if (!payload.isActive) {
        await database.clearActiveTabForUser(session.user.id);
        const next = await database.getActiveTabForUser(session.user.id);
        return res.json({
          ok: true,
          activeTab: next ? {
            ...next,
            isActive: false,
          } : null,
          stale: false,
        });
      }

      const current = await database.getActiveTabForUser(session.user.id);
      const nextTabId = normalizedTabId || current?.tabId || "";
      if (!nextTabId) {
        return res.status(400).json({
          ok: false,
          error: "tabId requerido para activar una pestaña.",
        });
      }

      const nextActive = await database.saveActiveTabForUser({
        userId: session.user.id,
        sessionId: session.id,
        tabId: nextTabId,
        tabUrl: normalizedTabUrl || current?.tabUrl || "",
        tabTitle: normalizedTabTitle || current?.tabTitle || "",
        viewContext: normalizedViewContext || current?.viewContext || "",
      });

      return res.json({
        ok: true,
        activeTab: nextActive,
        stale: false,
      });
    } catch (error) {
      const status = error instanceof z.ZodError ? 400 : 500;
      return res.status(status).json({ ok: false, error: errorMessage(error) });
    }
  });
}

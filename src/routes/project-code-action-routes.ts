// Rutas de consentimiento, rack del editor y cola de acciones de codigo, con la normalizacion del texto de las acciones.
// Movido sin cambios desde src/routes/project-context-routes.ts (solo se agrego "export" y los imports).
import { z } from "zod";
import express from "express";
import { randomUUID } from "node:crypto";
import { env } from "../config/env.js";
import type { AppDatabase } from "../db/database.js";
import { normalizeRepoFullName, toIso } from "../services/project-context.js";
import { trimText } from "../services/text-utils.js";
import { errorMessage, resolveSession } from "./route-utils.js";

export const workspaceConsentSchema = z.object({
  canRead: z.boolean().default(true),
  canModify: z.boolean().default(true),
  canAnalyze: z.boolean().default(true),
}).strict();

export const projectRackSchema = z.object({
  source: z.string().min(2).max(32).optional(),
  repoFullName: z.string().max(240).optional(),
  branch: z.string().max(160).optional(),
  generatedAt: z.string().datetime().optional(),
  totalEntries: z.number().int().min(0).max(120000),
  totalFiles: z.number().int().min(0).max(120000),
  totalFolders: z.number().int().min(0).max(120000),
  files: z.array(z.string().min(1).max(700)).max(120000),
  folders: z.array(z.string().min(1).max(700)).max(120000),
  activeFilePath: z.string().max(700).optional(),
  activeCodeSnippet: z.string().max(120000).optional(),
  activeSuggestion: z.string().max(120000).optional(),
  replacementOptions: z.array(z.object({
    id: z.string().max(120).optional(),
    label: z.string().max(180).optional(),
    description: z.string().max(800).optional(),
    actionType: z.string().max(80).optional(),
    originalText: z.string().max(120000).optional(),
    replacementText: z.string().max(120000).optional(),
    metadata: z.record(z.string(), z.unknown()).optional(),
  }).strict()).max(8).optional(),
}).strict();

export const projectCodeActionSchema = z.object({
  repoFullName: z.string().min(3).max(240),
  branch: z.string().max(160).optional(),
  filePath: z.string().min(1).max(700),
  actionType: z.string().min(2).max(80).optional(),
  title: z.string().max(180).optional(),
  originalText: z.string().max(120000).optional(),
  replacementText: z.string().max(120000).default(""),
  metadata: z.record(z.string(), z.unknown()).optional(),
}).strict();

export const projectCodeActionNextQuerySchema = z.object({
  repoFullName: z.string().min(3).max(240),
  workerId: z.string().max(120).optional(),
}).strict();

export const projectCodeActionCompleteSchema = z.object({
  metadata: z.record(z.string(), z.unknown()).optional(),
}).strict();

export const projectCodeActionFailSchema = z.object({
  error: z.string().min(1).max(1200),
}).strict();

export type ProjectCodeActionRow = {
  id: string;
  session_id: string | null;
  user_id: string;
  repo_full_name: string;
  branch: string;
  file_path: string;
  action_type: string;
  title: string;
  original_text: string;
  replacement_text: string;
  status: string;
  source: string;
  worker_instance: string;
  error_message: string;
  metadata: Record<string, unknown>;
  requested_at: string | Date;
  claimed_at: string | Date | null;
  completed_at: string | Date | null;
  updated_at: string | Date;
};

export function normalizeCodeActionText(value: unknown, max = 120000) {
  return String(value || "")
    .replace(/\r\n/g, "\n")
    .replace(/\r/g, "\n")
    .slice(0, max);
}

export function normalizeReplacementOptions(value: unknown) {
  const items = Array.isArray(value) ? value : [];
  return items
    .map((item) => item && typeof item === "object" ? item as Record<string, unknown> : null)
    .filter((item): item is Record<string, unknown> => !!item)
    .map((item) => ({
      id: trimText(item.id).slice(0, 120),
      label: trimText(item.label).slice(0, 180),
      description: trimText(item.description).slice(0, 800),
      actionType: trimText(item.actionType || item.action_type).slice(0, 80),
      originalText: normalizeCodeActionText(item.originalText || item.original_text),
      replacementText: normalizeCodeActionText(item.replacementText || item.replacement_text),
      metadata: item.metadata && typeof item.metadata === "object" && !Array.isArray(item.metadata)
        ? item.metadata as Record<string, unknown>
        : {},
    }))
    .filter((item) => item.label || item.replacementText)
    .slice(0, 8);
}

export function isDeleteCodeActionType(value: string) {
  return /\b(delete|remove|eliminar|borrar)\b/i.test(trimText(value));
}

export function mapProjectCodeActionRow(row: ProjectCodeActionRow | undefined | null) {
  if (!row) return null;
  return {
    id: row.id,
    sessionId: row.session_id,
    userId: row.user_id,
    repoFullName: row.repo_full_name,
    branch: row.branch,
    filePath: row.file_path,
    actionType: row.action_type,
    title: row.title,
    originalText: row.original_text,
    replacementText: row.replacement_text,
    status: row.status,
    source: row.source,
    workerInstance: row.worker_instance,
    errorMessage: row.error_message,
    metadata: row.metadata && typeof row.metadata === "object" ? row.metadata : {},
    requestedAt: toIso(row.requested_at),
    claimedAt: toIso(row.claimed_at),
    completedAt: toIso(row.completed_at),
    updatedAt: toIso(row.updated_at),
  };
}

// Consentimiento, rack del editor y cola de acciones de codigo (pedir, reclamar, completar, fallar).
export function registerProjectCodeActionRoutes(app: express.Express, database: AppDatabase) {
  app.get("/api/projects/consent", async (req, res) => {
    try {
      const session = await resolveSession(database, req);
      if (!session) {
        return res.status(401).json({ ok: false, error: "Sesion no valida." });
      }

      const consent = await database.getWorkspaceConsent(session.user.id);
      return res.json({ ok: true, consent });
    } catch (error) {
      return res.status(500).json({ ok: false, error: String(error) });
    }
  });

  app.post("/api/projects/consent", async (req, res) => {
    try {
      const session = await resolveSession(database, req);
      if (!session) {
        return res.status(401).json({ ok: false, error: "Sesion no valida." });
      }

      const parsed = workspaceConsentSchema.parse(req.body || {});
      const consent = await database.upsertWorkspaceConsent(session.user.id, parsed);
      return res.json({ ok: true, consent });
    } catch (error) {
      const status = error instanceof z.ZodError ? 400 : 500;
      return res.status(status).json({ ok: false, error: errorMessage(error) });
    }
  });

  app.post("/api/projects/rack", async (req, res) => {
    try {
      const session = await resolveSession(database, req);
      if (!session) {
        return res.status(401).json({ ok: false, error: "Sesion no valida." });
      }

      const consent = await database.getWorkspaceConsent(session.user.id);
      if (!consent.granted) {
        return res.status(403).json({
          ok: false,
          error: "Debes otorgar permisos de lectura/modificacion/analisis antes de guardar el rack.",
        });
      }

      const parsed = projectRackSchema.parse(req.body || {});
      const files = [...new Set((parsed.files || []).map((item) => trimText(item)).filter(Boolean))];
      const folders = [...new Set((parsed.folders || []).map((item) => trimText(item)).filter(Boolean))];

      const rackId = await database.saveProjectContextRack({
        sessionId: session.id,
        userId: session.user.id,
        source: trimText(parsed.source) || "codespace",
        repoFullName: trimText(parsed.repoFullName),
        branch: trimText(parsed.branch),
        generatedAt: trimText(parsed.generatedAt),
        totalEntries: Math.max(parsed.totalEntries, files.length + folders.length),
        totalFiles: Math.max(parsed.totalFiles, files.length),
        totalFolders: Math.max(parsed.totalFolders, folders.length),
        files,
        folders,
        activeFilePath: trimText(parsed.activeFilePath),
        activeCodeSnippet: trimText(parsed.activeCodeSnippet),
        activeSuggestion: trimText(parsed.activeSuggestion),
        replacementOptions: normalizeReplacementOptions(parsed.replacementOptions),
      });

      return res.json({
        ok: true,
        rackId,
        stored: {
          files: files.length,
          folders: folders.length,
        },
      });
    } catch (error) {
      const status = error instanceof z.ZodError ? 400 : 500;
      return res.status(status).json({ ok: false, error: errorMessage(error) });
    }
  });

  app.post("/api/projects/code-actions", async (req, res) => {
    try {
      const session = await resolveSession(database, req);
      if (!session) {
        return res.status(401).json({ ok: false, error: "Sesion no valida." });
      }

      const consent = await database.getWorkspaceConsent(session.user.id);
      if (!consent.granted || !consent.canModify) {
        return res.status(403).json({
          ok: false,
          error: "Debes otorgar permisos de modificacion antes de solicitar reemplazos de codigo.",
        });
      }

      const parsed = projectCodeActionSchema.parse(req.body || {});
      const repoFullName = normalizeRepoFullName(parsed.repoFullName);
      if (!repoFullName) {
        return res.status(400).json({ ok: false, error: "repoFullName invalido. Usa owner/repo." });
      }
      const actionType = trimText(parsed.actionType) || "replace_selection";
      const originalText = normalizeCodeActionText(parsed.originalText);
      const replacementText = normalizeCodeActionText(parsed.replacementText);
      if (!replacementText.trim() && !isDeleteCodeActionType(actionType)) {
        return res.status(400).json({
          ok: false,
          error: "replacementText es requerido salvo para acciones de eliminacion.",
        });
      }

      const result = await database.pool.query<ProjectCodeActionRow>(
        `
        insert into project_code_actions (
          id,
          session_id,
          user_id,
          repo_full_name,
          branch,
          file_path,
          action_type,
          title,
          original_text,
          replacement_text,
          source,
          metadata
        )
        values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, 'browser_extension', $11::jsonb)
        returning
          id,
          session_id,
          user_id,
          repo_full_name,
          branch,
          file_path,
          action_type,
          title,
          original_text,
          replacement_text,
          status,
          source,
          worker_instance,
          error_message,
          metadata,
          requested_at,
          claimed_at,
          completed_at,
          updated_at
        `,
        [
          randomUUID(),
          session.id,
          session.user.id,
          repoFullName,
          trimText(parsed.branch),
          trimText(parsed.filePath),
          actionType,
          trimText(parsed.title) || "Reemplazo sugerido",
          originalText,
          replacementText,
          JSON.stringify(parsed.metadata || {}),
        ],
      );

      return res.json({
        ok: true,
        action: mapProjectCodeActionRow(result.rows[0]),
      });
    } catch (error) {
      const status = error instanceof z.ZodError ? 400 : 500;
      return res.status(status).json({ ok: false, error: errorMessage(error) });
    }
  });

  app.get("/api/projects/code-actions/next", async (req, res) => {
    try {
      const session = await resolveSession(database, req);
      if (!session) {
        return res.status(401).json({ ok: false, error: "Sesion no valida." });
      }

      const parsed = projectCodeActionNextQuerySchema.parse(req.query || {});
      const repoFullName = normalizeRepoFullName(parsed.repoFullName);
      if (!repoFullName) {
        return res.status(400).json({ ok: false, error: "repoFullName invalido. Usa owner/repo." });
      }

      const workerInstance = trimText(
        req.header("x-adaceen-worker-id") || parsed.workerId || env.defaultScanWorkerId,
      ) || "vscode-extension";

      await database.pool.query("begin");
      let actionRow: ProjectCodeActionRow | null = null;
      try {
        const candidate = await database.pool.query<{ id: string }>(
          `
          select id
          from project_code_actions
          where user_id = $1
            and repo_full_name = $2
            and status = 'pending'
          order by requested_at asc
          limit 1
          `,
          [session.user.id, repoFullName],
        );

        const candidateId = trimText(candidate.rows[0]?.id);
        if (candidateId) {
          const result = await database.pool.query<ProjectCodeActionRow>(
            `
            update project_code_actions
            set
              status = 'claimed',
              claimed_at = now(),
              updated_at = now(),
              worker_instance = $3,
              error_message = ''
            where id = $1
              and user_id = $2
              and status = 'pending'
            returning
              id,
              session_id,
              user_id,
              repo_full_name,
              branch,
              file_path,
              action_type,
              title,
              original_text,
              replacement_text,
              status,
              source,
              worker_instance,
              error_message,
              metadata,
              requested_at,
              claimed_at,
              completed_at,
              updated_at
            `,
            [candidateId, session.user.id, workerInstance],
          );
          actionRow = result.rows[0] || null;
        }

        await database.pool.query("commit");
      } catch (error) {
        await database.pool.query("rollback");
        throw error;
      }

      return res.json({
        ok: true,
        action: mapProjectCodeActionRow(actionRow),
      });
    } catch (error) {
      const status = error instanceof z.ZodError ? 400 : 500;
      return res.status(status).json({ ok: false, error: errorMessage(error) });
    }
  });

  app.post("/api/projects/code-actions/:id/complete", async (req, res) => {
    try {
      const session = await resolveSession(database, req);
      if (!session) {
        return res.status(401).json({ ok: false, error: "Sesion no valida." });
      }

      const parsed = projectCodeActionCompleteSchema.parse(req.body || {});
      const actionId = trimText(req.params.id);
      if (!actionId) {
        return res.status(400).json({ ok: false, error: "id requerido." });
      }

      const result = await database.pool.query<ProjectCodeActionRow>(
        `
        update project_code_actions
        set
          status = 'completed',
          completed_at = now(),
          updated_at = now(),
          error_message = '',
          metadata = $3::jsonb
        where id = $1
          and user_id = $2
          and status in ('pending', 'claimed')
        returning
          id,
          session_id,
          user_id,
          repo_full_name,
          branch,
          file_path,
          action_type,
          title,
          original_text,
          replacement_text,
          status,
          source,
          worker_instance,
          error_message,
          metadata,
          requested_at,
          claimed_at,
          completed_at,
          updated_at
        `,
        [actionId, session.user.id, JSON.stringify(parsed.metadata || {})],
      );

      if (!result.rows[0]) {
        return res.status(404).json({ ok: false, error: "Accion no encontrada o ya cerrada." });
      }

      return res.json({ ok: true, action: mapProjectCodeActionRow(result.rows[0]) });
    } catch (error) {
      const status = error instanceof z.ZodError ? 400 : 500;
      return res.status(status).json({ ok: false, error: errorMessage(error) });
    }
  });

  app.post("/api/projects/code-actions/:id/fail", async (req, res) => {
    try {
      const session = await resolveSession(database, req);
      if (!session) {
        return res.status(401).json({ ok: false, error: "Sesion no valida." });
      }

      const parsed = projectCodeActionFailSchema.parse(req.body || {});
      const actionId = trimText(req.params.id);
      if (!actionId) {
        return res.status(400).json({ ok: false, error: "id requerido." });
      }

      const result = await database.pool.query<ProjectCodeActionRow>(
        `
        update project_code_actions
        set
          status = 'failed',
          completed_at = now(),
          updated_at = now(),
          error_message = $3
        where id = $1
          and user_id = $2
          and status in ('pending', 'claimed')
        returning
          id,
          session_id,
          user_id,
          repo_full_name,
          branch,
          file_path,
          action_type,
          title,
          original_text,
          replacement_text,
          status,
          source,
          worker_instance,
          error_message,
          metadata,
          requested_at,
          claimed_at,
          completed_at,
          updated_at
        `,
        [actionId, session.user.id, trimText(parsed.error).slice(0, 1200)],
      );

      if (!result.rows[0]) {
        return res.status(404).json({ ok: false, error: "Accion no encontrada o ya cerrada." });
      }

      return res.json({ ok: true, action: mapProjectCodeActionRow(result.rows[0]) });
    } catch (error) {
      const status = error instanceof z.ZodError ? 400 : 500;
      return res.status(status).json({ ok: false, error: errorMessage(error) });
    }
  });
}

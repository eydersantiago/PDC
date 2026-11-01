// Rutas de consentimiento, rack del editor y cola de acciones de codigo; las filas y el reclamo de la cola estan en project-code-action-queue.ts.
// Movido desde src/routes/projects/project-context-routes.ts. La cola usa lease y complete idempotente desde A12.12
// (claimCodeActionForUser): VS Code reclama con POST /claim y un reclamo vencido vuelve a la cola una vez.
import { z } from "zod";
import express from "express";
import { randomUUID } from "node:crypto";
import { env } from "../../config/env.js";
import type { AppDatabase } from "../../db/database.js";
import { normalizeRepoFullName } from "../../services/documents/project-context.js";
import { trimText } from "../../services/shared/text-utils.js";
import { WORKER_ID_HEADER } from "../client-headers.js";
import { errorMessage, resolveSession } from "../route-utils.js";
import { normalizeReplacementOptions, normalizeCodeActionText, isDeleteCodeActionType, type ProjectCodeActionRow, CODE_ACTION_COLUMNS, mapProjectCodeActionRow, claimCodeActionForUser } from "./project-code-action-queue.js";

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

export const projectCodeActionClaimSchema = z.object({
  repoFullName: z.string().min(3).max(240),
  workerId: z.string().max(120).optional(),
}).strict();

export const projectCodeActionCompleteSchema = z.object({
  metadata: z.record(z.string(), z.unknown()).optional(),
}).strict();

export const projectCodeActionFailSchema = z.object({
  error: z.string().min(1).max(1200),
}).strict();

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
        returning ${CODE_ACTION_COLUMNS}
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

  // VS Code reclama el siguiente cambio con lease (A12.12). POST /claim es la ruta de VS Code
  // 0.0.33; GET /next queda para las versiones anteriores, con el mismo lease.
  async function sendClaimedCodeAction(
    req: express.Request,
    res: express.Response,
    parsed: { repoFullName: string; workerId?: string },
  ) {
    const session = await resolveSession(database, req);
    if (!session) {
      return res.status(401).json({ ok: false, error: "Sesion no valida." });
    }

    const repoFullName = normalizeRepoFullName(parsed.repoFullName);
    if (!repoFullName) {
      return res.status(400).json({ ok: false, error: "repoFullName invalido. Usa owner/repo." });
    }

    const workerInstance = trimText(
      req.header(WORKER_ID_HEADER) || parsed.workerId || env.defaultScanWorkerId,
    ) || "vscode-extension";

    const actionRow = await claimCodeActionForUser(database, {
      userId: session.user.id,
      repoFullName,
      workerInstance,
    });

    return res.json({
      ok: true,
      action: mapProjectCodeActionRow(actionRow),
      leaseSeconds: env.codeActionLeaseSeconds,
    });
  }

  app.post("/api/projects/code-actions/claim", async (req, res) => {
    try {
      const parsed = projectCodeActionClaimSchema.parse(req.body || {});
      return await sendClaimedCodeAction(req, res, parsed);
    } catch (error) {
      const status = error instanceof z.ZodError ? 400 : 500;
      return res.status(status).json({ ok: false, error: errorMessage(error) });
    }
  });

  app.get("/api/projects/code-actions/next", async (req, res) => {
    try {
      const parsed = projectCodeActionNextQuerySchema.parse(req.query || {});
      return await sendClaimedCodeAction(req, res, parsed);
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
          lease_until = null,
          metadata = $3::jsonb
        where id = $1
          and user_id = $2
          and status <> 'completed'
        returning ${CODE_ACTION_COLUMNS}
        `,
        [actionId, session.user.id, JSON.stringify(parsed.metadata || {})],
      );

      if (!result.rows[0]) {
        // Idempotente (A12.12): repetir complete de un cambio ya completado no es un error, asi
        // VS Code puede reintentar sin marcar como fallido un cambio que si aplico.
        const existing = await database.pool.query<ProjectCodeActionRow>(
          `select ${CODE_ACTION_COLUMNS} from project_code_actions where id = $1 and user_id = $2 limit 1`,
          [actionId, session.user.id],
        );
        if (existing.rows[0]?.status === "completed") {
          return res.json({ ok: true, action: mapProjectCodeActionRow(existing.rows[0]), alreadyCompleted: true });
        }
        return res.status(404).json({ ok: false, error: "Accion no encontrada." });
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
          lease_until = null,
          error_message = $3
        where id = $1
          and user_id = $2
          and status in ('pending', 'claimed')
        returning ${CODE_ACTION_COLUMNS}
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

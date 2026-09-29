// Rutas de consentimiento, rack del editor y cola de acciones de codigo, con la normalizacion del texto de las acciones.
// Movido desde src/routes/project-context-routes.ts. La cola usa lease y complete idempotente desde A12.12
// (claimCodeActionForUser): VS Code reclama con POST /claim y un reclamo vencido vuelve a la cola una vez.
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
  lease_until?: string | Date | null;
  attempts?: number | string | null;
};

/** Columnas que devuelven las consultas de la cola (returning / select). */
const CODE_ACTION_COLUMNS = `
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
  updated_at,
  lease_until,
  attempts
`;

/** Veces que VS Code puede reclamar un cambio sin confirmarlo antes de que venza. */
export const CODE_ACTION_MAX_CLAIMS = 2;

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
    leaseUntil: toIso(row.lease_until),
    attempts: Number(row.attempts) || 0,
  };
}

/**
 * Reclama para VS Code el cambio pendiente mas antiguo del usuario en ese repo, con lease
 * (A12.12). En una transaccion real (una sola conexion):
 * 1. Los reclamos vencidos (VS Code se cerro o el aviso quedo sin respuesta) vuelven a la cola;
 *    si ya se reclamaron CODE_ACTION_MAX_CLAIMS veces, vencen. Los reclamos de antes del lease
 *    (sin lease_until) se dan por vencidos pasado un lease.
 * 2. Los pendientes mas viejos que CODE_ACTION_PENDING_TTL_MINUTES vencen: ese cambio ya no es
 *    el que el estudiante esta mirando.
 * 3. Se reclama el mas antiguo que queda (lease_until = ahora + CODE_ACTION_LEASE_SECONDS). El
 *    update exige status = 'pending': si dos VS Code eligen el mismo, solo uno lo obtiene (sin
 *    «for update skip locked», que pg-mem no soporta en las pruebas).
 */
export async function claimCodeActionForUser(
  database: AppDatabase,
  input: { userId: string; repoFullName: string; workerInstance: string; now?: Date },
) {
  const now = input.now ?? new Date();
  const leaseMs = env.codeActionLeaseSeconds * 1000;
  const leaseUntil = new Date(now.getTime() + leaseMs);
  const legacyClaimCutoff = new Date(now.getTime() - leaseMs);
  const pendingCutoff = new Date(now.getTime() - env.codeActionPendingTtlMinutes * 60 * 1000);

  return database.withTransaction(async (client) => {
    await client.query(
      `
      update project_code_actions
      set
        status = case when attempts >= $4::int then 'expired' else 'pending' end,
        error_message = case when attempts >= $4::int then $5 else '' end,
        lease_until = null,
        worker_instance = '',
        updated_at = now()
      where user_id = $1
        and repo_full_name = $2
        and status = 'claimed'
        and (
          (lease_until is not null and lease_until < $3::timestamptz)
          or (lease_until is null and claimed_at < $6::timestamptz)
        )
      `,
      [
        input.userId,
        input.repoFullName,
        now.toISOString(),
        CODE_ACTION_MAX_CLAIMS,
        `VS Code no confirmo el cambio despues de ${CODE_ACTION_MAX_CLAIMS} reclamos.`,
        legacyClaimCutoff.toISOString(),
      ],
    );

    await client.query(
      `
      update project_code_actions
      set
        status = 'expired',
        error_message = $4,
        lease_until = null,
        updated_at = now()
      where user_id = $1
        and repo_full_name = $2
        and status = 'pending'
        and requested_at < $3::timestamptz
      `,
      [
        input.userId,
        input.repoFullName,
        pendingCutoff.toISOString(),
        `Vencio sin aplicarse (mas de ${env.codeActionPendingTtlMinutes} min en la cola).`,
      ],
    );

    const candidate = await client.query<{ id: string }>(
      `
      select id
      from project_code_actions
      where user_id = $1
        and repo_full_name = $2
        and status = 'pending'
      order by requested_at asc
      limit 1
      `,
      [input.userId, input.repoFullName],
    );
    const candidateId = trimText(candidate.rows[0]?.id);
    if (!candidateId) return null;

    const claimed = await client.query<ProjectCodeActionRow>(
      `
      update project_code_actions
      set
        status = 'claimed',
        claimed_at = now(),
        updated_at = now(),
        worker_instance = $3,
        error_message = '',
        lease_until = $4::timestamptz,
        attempts = attempts + 1
      where id = $1
        and user_id = $2
        and status = 'pending'
      returning ${CODE_ACTION_COLUMNS}
      `,
      [candidateId, input.userId, input.workerInstance, leaseUntil.toISOString()],
    );
    return claimed.rows[0] || null;
  });
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
      req.header("x-adaceen-worker-id") || parsed.workerId || env.defaultScanWorkerId,
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

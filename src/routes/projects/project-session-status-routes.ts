// Rutas del estado de la sesion y del contexto del proyecto: estado de la sesion, estado del contexto e historial.
import { z } from "zod";
import express from "express";
import type { AppDatabase } from "../../db/database.js";
import { PROJECT_SCAN_REQUEST_STATUSES, mapProjectContextHistoryRow, mapProjectScanRequestRow, mapProjectScanSnapshotRow, normalizeRepoFullName, toIso } from "../../services/documents/project-context.js";
import type { ProjectContextHistoryRow, ProjectScanRequestRow, ProjectScanSnapshotRow } from "../../services/documents/project-context.js";
import { trimText } from "../../services/shared/text-utils.js";
import { normalizeReplacementOptions } from "./project-code-action-queue.js";
import { describeVscodeExtensionsByEditorHost } from "../../services/vscode/vscode-presence.js";
import { errorMessage, resolveSession } from "../route-utils.js";
import { type ProjectContextStateDeps } from "./project-context-state-routes.js";

export const projectContextQuerySchema = z.object({
  repoFullName: z.string().min(3).max(240),
}).strict();

export const projectSessionStateQuerySchema = z.object({
  filePath: z.string().max(700).optional(),
}).strict();

export const projectContextHistoryQuerySchema = z.object({
  repoFullName: z.string().min(3).max(240),
  limit: z.coerce.number().int().min(1).max(50).optional(),
}).strict();

export type ProjectContextRackRow = {
  id: string;
  session_id: string | null;
  source: string;
  repo_full_name: string;
  branch: string;
  total_entries: number;
  total_files: number;
  total_folders: number;
  files: string[];
  folders: string[];
  active_file_path: string;
  active_code_snippet: string;
  active_suggestion: string;
  replacement_options: unknown;
  generated_at: string | Date;
  created_at: string | Date;
  updated_at: string | Date;
};

export function normalizeRackFilePath(value: unknown) {
  return trimText(value).replace(/\\/g, "/").replace(/^\/+/, "").toLowerCase();
}

export function mapProjectContextRackRow(row: ProjectContextRackRow | null | undefined) {
  if (!row) return null;
  return {
    id: row.id,
    sessionId: row.session_id,
    source: row.source,
    repoFullName: row.repo_full_name,
    branch: row.branch,
    totalEntries: Number(row.total_entries) || 0,
    totalFiles: Number(row.total_files) || 0,
    totalFolders: Number(row.total_folders) || 0,
    files: row.files || [],
    folders: row.folders || [],
    activeFilePath: row.active_file_path,
    activeCodeSnippet: row.active_code_snippet,
    activeSuggestion: row.active_suggestion,
    replacementOptions: normalizeReplacementOptions(row.replacement_options),
    generatedAt: toIso(row.generated_at),
    createdAt: toIso(row.created_at),
    updatedAt: toIso(row.updated_at),
  };
}

export function registerProjectSessionStatusRoutes(app: express.Express, database: AppDatabase, deps: ProjectContextStateDeps) {
  app.get("/api/projects/session/state", async (req, res) => {
    try {
      const session = await resolveSession(database, req);
      if (!session) {
        return res.status(401).json({ ok: false, error: "Sesion no valida." });
      }

      const parsed = projectSessionStateQuerySchema.parse(req.query || {});
      const requestedFilePath = normalizeRackFilePath(parsed.filePath);

      const latestRequestResult = await database.pool.query<ProjectScanRequestRow>(
        `
        select
          id,
          repo_full_name,
          status,
          requested_by_user_id,
          requested_session_id,
          worker_instance,
          error_message,
          snapshot_id,
          requested_at,
          claimed_at,
          completed_at,
          updated_at
        from project_scan_requests
        where requested_by_user_id = $1
        order by requested_at desc
        limit 1
        `,
        [session.user.id],
      );

      const latestRackResult = await database.pool.query<ProjectContextRackRow>(
        `
        select
          id,
          session_id,
          source,
          repo_full_name,
          branch,
          total_entries,
          total_files,
          total_folders,
          files,
          folders,
          active_file_path,
          active_code_snippet,
          active_suggestion,
          replacement_options,
          generated_at,
          created_at,
          updated_at
        from project_context_racks
        where user_id = $1
        order by
          case when source = 'vscode_extension' then 0 else 1 end,
          created_at desc
        limit 1
        `,
        [session.user.id],
      );

      const latestRack = latestRackResult.rows[0] || null;
      let latestRackForFile: ProjectContextRackRow | null = null;
      if (requestedFilePath) {
        const recentRackResult = await database.pool.query<ProjectContextRackRow>(
          `
          select
            id,
            session_id,
            source,
            repo_full_name,
            branch,
            total_entries,
            total_files,
            total_folders,
            files,
            folders,
            active_file_path,
            active_code_snippet,
            active_suggestion,
            replacement_options,
            generated_at,
            created_at,
            updated_at
          from project_context_racks
          where user_id = $1
            and source = 'vscode_extension'
          order by created_at desc
          limit 50
          `,
          [session.user.id],
        );
        latestRackForFile = recentRackResult.rows.find((row) => {
          const rackPath = normalizeRackFilePath(row.active_file_path);
          return rackPath === requestedFilePath
            || rackPath.endsWith(`/${requestedFilePath}`)
            || requestedFilePath.endsWith(`/${rackPath}`);
        }) || null;
      }

      return res.json({
        ok: true,
        state: {
          sessionId: session.id,
          userId: session.user.id,
          userRole: session.user.role,
          latestRequest: mapProjectScanRequestRow(latestRequestResult.rows[0]),
          latestRack: mapProjectContextRackRow(latestRack),
          latestRackForFile: mapProjectContextRackRow(latestRackForFile),
          // La extension de VS Code vista por tipo de editor y la publicada (25/10/2026): la linea
          // «VS Code» de Inicio dice si esta al dia. Solo se agrega; los navegadores anteriores la ignoran.
          vscodeExtension: describeVscodeExtensionsByEditorHost(session.user.id, deps.latestVscodeVersion()),
        },
      });
    } catch (error) {
      return res.status(500).json({ ok: false, error: String(error) });
    }
  });

  app.get("/api/projects/context/status", async (req, res) => {
    try {
      const session = await resolveSession(database, req);
      if (!session) {
        return res.status(401).json({ ok: false, error: "Sesion no valida." });
      }

      const parsed = projectContextQuerySchema.parse(req.query || {});
      const repoFullName = normalizeRepoFullName(parsed.repoFullName);
      if (!repoFullName) {
        return res.status(400).json({ ok: false, error: "repoFullName invalido. Usa owner/repo." });
      }

      const latestRequestResult = await database.pool.query<ProjectScanRequestRow>(
        `
        select
          id,
          repo_full_name,
          status,
          requested_by_user_id,
          requested_session_id,
          worker_instance,
          error_message,
          snapshot_id,
          requested_at,
          claimed_at,
          completed_at,
          updated_at
        from project_scan_requests
        where repo_full_name = $1
          and requested_by_user_id = $2
        order by requested_at desc
        limit 1
        `,
        [repoFullName, session.user.id],
      );

      const latestRequest = latestRequestResult.rows[0] || null;
      const latestSnapshotId = trimText(latestRequest?.snapshot_id);
      let latestSnapshot: ReturnType<typeof mapProjectScanSnapshotRow> = null;

      if (latestSnapshotId) {
        const latestSnapshotResult = await database.pool.query<ProjectScanSnapshotRow>(
          `
          select
            id,
            request_id,
            repo_full_name,
            source,
            total_files,
            skipped_by_size,
            total_bytes,
            storage_path,
            created_at
          from project_scan_snapshots
          where id = $1
          limit 1
          `,
          [latestSnapshotId],
        );
        latestSnapshot = mapProjectScanSnapshotRow(latestSnapshotResult.rows[0]);
      }

      const versionsCountResult = await database.pool.query<{ total: number | string }>(
        `
        select count(*)::int as total
        from project_scan_requests
        where repo_full_name = $1
          and requested_by_user_id = $2
          and status = 'completed'
          and snapshot_id <> ''
        `,
        [repoFullName, session.user.id],
      );

      const latestRebuildResult = await database.pool.query<ProjectScanRequestRow>(
        `
        select
          id,
          repo_full_name,
          status,
          requested_by_user_id,
          requested_session_id,
          worker_instance,
          error_message,
          snapshot_id,
          requested_at,
          claimed_at,
          completed_at,
          updated_at
        from project_scan_requests
        where repo_full_name = $1
          and requested_by_user_id = $2
          and worker_instance = 'manual_rebuild'
        order by completed_at desc nulls last, requested_at desc
        limit 1
        `,
        [repoFullName, session.user.id],
      );

      const versionsCount = Number(versionsCountResult.rows[0]?.total) || 0;
      const contextReady = latestRequest?.status === PROJECT_SCAN_REQUEST_STATUSES.completed
        && !!latestSnapshot;
      const latestRequestMapped = mapProjectScanRequestRow(latestRequest);
      const latestSnapshotMapped = latestSnapshot;
      const latestVersion = latestSnapshotMapped?.id
        ? `${latestSnapshotMapped.source}:${latestSnapshotMapped.id.slice(0, 8)}`
        : (latestRequestMapped?.id ? `request:${latestRequestMapped.id.slice(0, 8)}` : "");

      return res.json({
        ok: true,
        context: {
          configured: true,
          repoFullName,
          hasContext: contextReady,
          ready: contextReady,
          versionsCount,
          totalVersions: versionsCount,
          latestRequestId: latestRequestMapped?.id || "",
          latestSnapshotId: latestSnapshotMapped?.id || "",
          latestVersion,
          currentVersion: latestVersion,
          updatedAt: latestSnapshotMapped?.createdAt || latestRequestMapped?.updatedAt || null,
          source: latestSnapshotMapped?.source || latestRequestMapped?.workerInstance || "",
          requestStatus: latestRequestMapped?.status || "",
          summary: contextReady
            ? `Contexto disponible para ${repoFullName} (${latestVersion || "version actual"}).`
            : `Aun no hay contexto completado para ${repoFullName}.`,
          latestRequest: latestRequestMapped,
          latestSnapshot: latestSnapshotMapped,
          latestRebuild: mapProjectScanRequestRow(latestRebuildResult.rows[0]),
        },
      });
    } catch (error) {
      return res.status(400).json({ ok: false, error: errorMessage(error) });
    }
  });

  app.get("/api/projects/context/history", async (req, res) => {
    try {
      const session = await resolveSession(database, req);
      if (!session) {
        return res.status(401).json({ ok: false, error: "Sesion no valida." });
      }

      const parsed = projectContextHistoryQuerySchema.parse(req.query || {});
      const repoFullName = normalizeRepoFullName(parsed.repoFullName);
      if (!repoFullName) {
        return res.status(400).json({ ok: false, error: "repoFullName invalido. Usa owner/repo." });
      }

      const limit = Math.max(1, Math.min(50, Number(parsed.limit) || 20));
      const historyResult = await database.pool.query<ProjectContextHistoryRow>(
        `
        select
          req.id as request_id,
          req.repo_full_name,
          req.status,
          req.requested_at,
          req.completed_at,
          req.updated_at,
          req.worker_instance,
          req.error_message,
          req.snapshot_id,
          snap.source as snapshot_source,
          snap.total_files as snapshot_total_files,
          snap.total_bytes as snapshot_total_bytes,
          snap.storage_path as snapshot_storage_path,
          snap.created_at as snapshot_created_at
        from project_scan_requests req
        left join project_scan_snapshots snap on snap.id = req.snapshot_id
        where req.repo_full_name = $1
          and req.requested_by_user_id = $2
          and req.status = 'completed'
          and req.snapshot_id <> ''
        order by req.completed_at desc nulls last, req.requested_at desc
        limit $3
        `,
        [repoFullName, session.user.id, limit],
      );

      return res.json({
        ok: true,
        repoFullName,
        versions: historyResult.rows.map(mapProjectContextHistoryRow),
      });
    } catch (error) {
      return res.status(400).json({ ok: false, error: errorMessage(error) });
    }
  });
}

// Ruta POST /api/projects/context/rebuild: pide reconstruir el contexto del proyecto.
import { z } from "zod";
import express from "express";
import { randomUUID } from "node:crypto";
import type { AppDatabase } from "../../db/database.js";
import { mapProjectScanRequestRow, mapProjectScanSnapshotRow, normalizeRepoFullName } from "../../services/documents/project-context.js";
import type { ProjectScanRequestRow, ProjectScanSnapshotRow } from "../../services/documents/project-context.js";
import { trimText } from "../../services/shared/text-utils.js";
import { errorMessage, resolveSession } from "../route-utils.js";

export const projectContextRebuildSchema = z.object({
  repoFullName: z.string().min(3).max(240),
  requestId: z.string().max(120).optional(),
}).strict();

export function registerProjectContextRebuildRoutes(app: express.Express, database: AppDatabase) {
  app.post("/api/projects/context/rebuild", async (req, res) => {
    try {
      const session = await resolveSession(database, req);
      if (!session) {
        return res.status(401).json({ ok: false, error: "Sesion no valida." });
      }

      const parsed = projectContextRebuildSchema.parse(req.body || {});
      const repoFullName = normalizeRepoFullName(parsed.repoFullName);
      if (!repoFullName) {
        return res.status(400).json({ ok: false, error: "repoFullName invalido. Usa owner/repo." });
      }

      const requestedId = trimText(parsed.requestId);
      const sourceRequestResult = await database.pool.query<ProjectScanRequestRow>(
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
          and status = 'completed'
          and snapshot_id <> ''
          and ($3 = '' or id = $3)
        order by requested_at desc
        limit 1
        `,
        [repoFullName, session.user.id, requestedId],
      );

      const sourceRequest = sourceRequestResult.rows[0];
      if (!sourceRequest) {
        return res.status(404).json({
          ok: false,
          error: requestedId
            ? "No se encontro la version solicitada para aplicar rebuild."
            : "No hay versiones guardadas para este repositorio.",
        });
      }

      const sourceSnapshotId = trimText(sourceRequest.snapshot_id);
      if (!sourceSnapshotId) {
        return res.status(400).json({ ok: false, error: "La version origen no tiene snapshot asociado." });
      }

      const sourceSnapshotResult = await database.pool.query<ProjectScanSnapshotRow>(
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
        [sourceSnapshotId],
      );

      const sourceSnapshot = sourceSnapshotResult.rows[0];
      if (!sourceSnapshot) {
        return res.status(404).json({ ok: false, error: "Snapshot origen no encontrado." });
      }

      const rebuildRequestId = randomUUID();
      const rebuildResult = await database.pool.query<ProjectScanRequestRow>(
        `
        insert into project_scan_requests (
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
        )
        values (
          $1,
          $2,
          'completed',
          $3,
          $4,
          'manual_rebuild',
          $5,
          $6,
          now(),
          now(),
          now(),
          now()
        )
        returning
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
        `,
        [
          rebuildRequestId,
          repoFullName,
          session.user.id,
          session.id,
          `rebuild_from=${sourceRequest.id}`,
          sourceSnapshotId,
        ],
      );

      return res.json({
        ok: true,
        rebuild: {
          request: mapProjectScanRequestRow(rebuildResult.rows[0]),
          sourceRequest: mapProjectScanRequestRow(sourceRequest),
          snapshot: mapProjectScanSnapshotRow(sourceSnapshot),
        },
      });
    } catch (error) {
      return res.status(400).json({ ok: false, error: errorMessage(error) });
    }
  });
}

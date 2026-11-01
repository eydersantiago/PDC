// Rutas del escaneo del proyecto: pedir un escaneo, el siguiente pendiente (worker) y el estado de un pedido.
import { randomUUID } from "node:crypto";
import type express from "express";
import { z } from "zod";
import { env } from "../../config/env.js";
import type { AppDatabase } from "../../db/database.js";
import { durationMs, errorSummary, shortId } from "../../services/shared/diagnostics.js";
import { mapProjectScanRequestRow, mapProjectScanSnapshotRow, normalizeRepoFullName, type ProjectScanRequestRow, type ProjectScanSnapshotRow } from "../../services/documents/project-context.js";
import { trimText } from "../../services/shared/text-utils.js";
import { WORKER_ID_HEADER } from "../client-headers.js";
import { errorMessage, resolveSession } from "../route-utils.js";
import { getRequestId, projectScanLog, ensureWorkerAuthorized, resolveScanActor } from "./project-scan-utils.js";

const projectScanRequestSchema = z.object({
  repoFullName: z.string().min(3).max(240),
  source: z.string().min(1).max(60).optional(),
}).strict();

export function registerProjectScanRequestRoutes(app: express.Express, database: AppDatabase) {
  app.post("/api/projects/scan/request", async (req, res) => {
    const diagnosticRequestId = getRequestId(req);
    const startedAt = Date.now();
    let logger = projectScanLog.child({
      requestId: diagnosticRequestId,
      route: "/api/projects/scan/request",
    });
    try {
      logger.info("scan.request.create.start", {
        repoFullName: trimText(req.body?.repoFullName),
        source: trimText(req.body?.source),
      });
      const session = await resolveSession(database, req);
      if (!session) {
        logger.warn("scan.request.create.unauthorized");
        return res.status(401).json({ ok: false, error: "Sesion no valida." });
      }

      const parsed = projectScanRequestSchema.parse(req.body || {});
      const repoFullName = normalizeRepoFullName(parsed.repoFullName);
      if (!repoFullName) {
        logger.warn("scan.request.create.invalid_repo", {
          repoFullName: trimText(parsed.repoFullName),
        });
        return res.status(400).json({ ok: false, error: "repoFullName invalido. Usa owner/repo." });
      }
      logger = logger.child({
        repoFullName,
        userId: shortId(session.user.id, 24),
        sessionId: shortId(session.id, 24),
      });

      const activeRequestForUser = await database.pool.query<ProjectScanRequestRow>(
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
          and status in ('pending', 'claimed')
        order by requested_at desc
        limit 1
        `,
        [session.user.id],
      );

      if (activeRequestForUser.rows[0]) {
        const active = activeRequestForUser.rows[0];
        if (normalizeRepoFullName(active.repo_full_name) !== repoFullName) {
          logger.warn("scan.request.create.conflict", {
            activeRequestId: active.id,
            activeRepoFullName: active.repo_full_name,
            activeStatus: active.status,
          });
          return res.status(409).json({
            ok: false,
            error: "Ya hay un analisis en curso para este usuario.",
            activeRequest: mapProjectScanRequestRow(active),
          });
        }
      }

      const existing = await database.pool.query<ProjectScanRequestRow>(
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
          and status in ('pending', 'claimed')
        order by requested_at desc
        limit 1
        `,
        [repoFullName, session.user.id],
      );

      if (existing.rows[0]) {
        logger.info("scan.request.create.reused", {
          durationMs: durationMs(startedAt),
          scanRequestId: existing.rows[0].id,
          status: existing.rows[0].status,
        });
        return res.json({
          ok: true,
          request: mapProjectScanRequestRow(existing.rows[0]),
          reused: true,
        });
      }

      const requestId = randomUUID();
      const inserted = await database.pool.query<ProjectScanRequestRow>(
        `
        insert into project_scan_requests (
          id,
          repo_full_name,
          status,
          requested_by_user_id,
          requested_session_id,
          worker_instance,
          error_message,
          snapshot_id
        )
        values ($1, $2, 'pending', $3, $4, '', '', '')
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
        [requestId, repoFullName, session.user.id, session.id],
      );

      logger.info("scan.request.create.done", {
        durationMs: durationMs(startedAt),
        scanRequestId: inserted.rows[0].id,
        source: trimText(parsed.source) || env.defaultScanSource,
      });
      return res.json({
        ok: true,
        source: trimText(parsed.source) || env.defaultScanSource,
        request: mapProjectScanRequestRow(inserted.rows[0]),
        reused: false,
      });
    } catch (error) {
      const status = error instanceof z.ZodError ? 400 : 500;
      logger.error("scan.request.create.failed", {
        durationMs: durationMs(startedAt),
        status,
        error: errorSummary(error),
      });
      return res.status(status).json({ ok: false, error: errorMessage(error) });
    }
  });

  app.get("/api/projects/scan/request/next", async (req, res) => {
    const diagnosticRequestId = getRequestId(req);
    const startedAt = Date.now();
    let logger = projectScanLog.child({
      requestId: diagnosticRequestId,
      route: "/api/projects/scan/request/next",
    });
    try {
      logger.info("scan.request.claim.start", {
        repoFullName: trimText(req.query.repoFullName),
        workerId: trimText(req.header(WORKER_ID_HEADER) || req.query.workerId),
      });
      if (!ensureWorkerAuthorized(req)) {
        logger.warn("scan.request.claim.unauthorized");
        return res.status(401).json({ ok: false, error: "Worker no autorizado." });
      }

      const repoFullName = normalizeRepoFullName(req.query.repoFullName);
      if (!repoFullName) {
        logger.warn("scan.request.claim.invalid_repo", {
          repoFullName: trimText(req.query.repoFullName),
        });
        return res.status(400).json({ ok: false, error: "repoFullName invalido." });
      }

      const workerInstance = trimText(req.header(WORKER_ID_HEADER) || req.query.workerId) || env.defaultScanWorkerId;
      logger = logger.child({ repoFullName, workerInstance });
      const { session, dedicatedWorker } = await resolveScanActor(database, req);
      if (!session && !dedicatedWorker) {
        // VS Code 0.0.32 o anterior reclama sin sesion: no recibe nada (antes recibia la
        // solicitud de cualquier usuario con ese repo). La solicitud espera a un VS Code con
        // sesion del mismo estudiante.
        logger.warn("scan.request.claim.session_required");
        return res.json({ ok: true, request: null, needsSession: true });
      }
      const ownerUserId = session ? session.user.id : "";
      // Candidato del mismo dueño y update condicionado a status = 'pending': si dos VS Code
      // eligen la misma solicitud, solo uno la obtiene (sin CTE con «skip locked», que pg-mem no
      // soporta y que impedia probar esta ruta).
      const candidate = await database.pool.query<{ id: string }>(
        `
        select id
        from project_scan_requests
        where repo_full_name = $1
          and status = 'pending'
          and ($2 = '' or requested_by_user_id = $2)
        order by requested_at asc
        limit 1
        `,
        [repoFullName, ownerUserId],
      );
      const candidateId = trimText(candidate.rows[0]?.id);
      const claimed = candidateId
        ? await database.pool.query<ProjectScanRequestRow>(
          `
          update project_scan_requests
          set
            status = 'claimed',
            claimed_at = now(),
            updated_at = now(),
            worker_instance = $2,
            error_message = ''
          where id = $1
            and status = 'pending'
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
          [candidateId, workerInstance],
        )
        : { rows: [] as ProjectScanRequestRow[] };

      logger.info("scan.request.claim.done", {
        durationMs: durationMs(startedAt),
        scanRequestId: claimed.rows[0]?.id || "",
        claimed: Boolean(claimed.rows[0]),
      });
      return res.json({
        ok: true,
        request: mapProjectScanRequestRow(claimed.rows[0]),
      });
    } catch (error) {
      logger.error("scan.request.claim.failed", {
        durationMs: durationMs(startedAt),
        error: errorSummary(error),
      });
      return res.status(500).json({ ok: false, error: String(error) });
    }
  });

  app.get("/api/projects/scan/request/:requestId", async (req, res) => {
    try {
      const session = await resolveSession(database, req);
      if (!session) {
        return res.status(401).json({ ok: false, error: "Sesion no valida." });
      }

      const requestId = trimText(req.params.requestId);
      if (!requestId) {
        return res.status(400).json({ ok: false, error: "requestId requerido." });
      }

      const found = await database.pool.query<ProjectScanRequestRow>(
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
        where id = $1
          and requested_by_user_id = $2
        limit 1
        `,
        [requestId, session.user.id],
      );

      if (!found.rows[0]) {
        return res.status(404).json({ ok: false, error: "Solicitud no encontrada." });
      }

      let snapshot: ReturnType<typeof mapProjectScanSnapshotRow> = null;

      const snapshotId = trimText(found.rows[0].snapshot_id);
      if (snapshotId) {
        const snapshotResult = await database.pool.query<ProjectScanSnapshotRow>(
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
          [snapshotId],
        );
        snapshot = mapProjectScanSnapshotRow(snapshotResult.rows[0]);
      }

      return res.json({
        ok: true,
        request: mapProjectScanRequestRow(found.rows[0]),
        snapshot,
      });
    } catch (error) {
      return res.status(500).json({ ok: false, error: String(error) });
    }
  });
}

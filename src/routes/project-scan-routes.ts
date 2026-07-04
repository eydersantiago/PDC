import fsp from "node:fs/promises";
import path from "node:path";
import { createHash, randomUUID } from "node:crypto";
import type express from "express";
import { z } from "zod";
import { env } from "../config/env.js";
import type { AppDatabase } from "../db/database.js";
import {
  createDiagnosticLogger,
  durationMs,
  errorSummary,
  shortId,
} from "../services/diagnostics.js";
import {
  buildScanStoragePath,
  mapProjectScanRequestRow,
  mapProjectScanSnapshotRow,
  normalizeRepoFullName,
  PROJECT_SCAN_REQUEST_STATUSES,
  type ProjectScanRequestRow,
  type ProjectScanSnapshotRow,
} from "../services/project-context.js";
import { trimText } from "../services/text-utils.js";
import { errorMessage, resolveSession } from "./route-utils.js";

const projectScanRequestSchema = z.object({
  repoFullName: z.string().min(3).max(240),
  source: z.string().min(1).max(60).optional(),
}).strict();

const projectScanWorkerResultSchema = z.object({
  repoFullName: z.string().min(3).max(240),
  runtime: z.record(z.string(), z.unknown()).optional(),
  mode: z.record(z.string(), z.unknown()).optional(),
  workspaceFolders: z.array(z.record(z.string(), z.unknown())).optional(),
  selectedFolders: z.array(z.record(z.string(), z.unknown())).optional(),
  scannedAt: z.string().datetime().optional(),
  totalFiles: z.number().int().min(0).max(5000),
  skippedBySize: z.number().int().min(0).max(5000).optional(),
  files: z.array(z.object({
    path: z.string().min(1).max(900),
    bytes: z.number().int().min(0).max(2_000_000),
    lines: z.number().int().min(0).max(2_000_000),
    preview: z.string().max(2000).optional(),
    content: z.string().max(500_000),
  })).max(5000),
}).strict();

const projectScanWorkerFailSchema = z.object({
  error: z.string().min(1).max(1200),
}).strict();

const projectScanLog = createDiagnosticLogger("project-scan-routes");

function getRequestId(req: express.Request) {
  return trimText(req.header("x-request-id") || req.header("x-correlation-id")) || randomUUID();
}

function ensureWorkerAuthorized(req: express.Request) {
  const expected = trimText(env.scanWorkerKey);
  if (!expected) return true;
  const provided = trimText(req.header("x-adaceen-worker-key") || req.query.workerKey || "");
  return provided === expected;
}

export function registerProjectScanRoutes(app: express.Express, database: AppDatabase) {
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
        workerId: trimText(req.header("x-adaceen-worker-id") || req.query.workerId),
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

      const workerInstance = trimText(req.header("x-adaceen-worker-id") || req.query.workerId) || env.defaultScanWorkerId;
      logger = logger.child({ repoFullName, workerInstance });
      const claimed = await database.pool.query<ProjectScanRequestRow>(
        `
        with candidate as (
          select id
          from project_scan_requests
          where repo_full_name = $1
            and status = 'pending'
          order by requested_at asc
          limit 1
          for update skip locked
        )
        update project_scan_requests req
        set
          status = 'claimed',
          claimed_at = now(),
          updated_at = now(),
          worker_instance = $2,
          error_message = ''
        from candidate
        where req.id = candidate.id
        returning
          req.id,
          req.repo_full_name,
          req.status,
          req.requested_by_user_id,
          req.requested_session_id,
          req.worker_instance,
          req.error_message,
          req.snapshot_id,
          req.requested_at,
          req.claimed_at,
          req.completed_at,
          req.updated_at
        `,
        [repoFullName, workerInstance],
      );

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

  app.post("/api/projects/scan/request/:requestId/result", async (req, res) => {
    const diagnosticRequestId = getRequestId(req);
    const startedAt = Date.now();
    let logger = projectScanLog.child({
      requestId: diagnosticRequestId,
      route: "/api/projects/scan/request/:requestId/result",
      scanRequestId: trimText(req.params.requestId),
    });
    try {
      logger.info("scan.result.receive.start", {
        contentLength: trimText(req.header("content-length")),
      });
      if (!ensureWorkerAuthorized(req)) {
        logger.warn("scan.result.receive.unauthorized");
        return res.status(401).json({ ok: false, error: "Worker no autorizado." });
      }

      const requestId = trimText(req.params.requestId);
      if (!requestId) {
        logger.warn("scan.result.receive.invalid_request", {
          reason: "requestId requerido",
        });
        return res.status(400).json({ ok: false, error: "requestId requerido." });
      }

      const parsed = projectScanWorkerResultSchema.parse(req.body || {});
      const repoFullName = normalizeRepoFullName(parsed.repoFullName);
      if (!repoFullName) {
        logger.warn("scan.result.receive.invalid_repo", {
          repoFullName: trimText(parsed.repoFullName),
        });
        return res.status(400).json({ ok: false, error: "repoFullName invalido." });
      }
      const totalBytes = parsed.files.reduce((acc, file) => acc + Math.max(0, Number(file.bytes) || 0), 0);
      const skippedBySize = Math.max(0, Number(parsed.skippedBySize) || 0);
      logger = logger.child({ repoFullName, scanRequestId: requestId });
      logger.info("scan.result.receive.parsed", {
        totalFiles: parsed.totalFiles,
        filesReceived: parsed.files.length,
        skippedBySize,
        totalBytes,
        workspaceFolders: parsed.workspaceFolders?.length || 0,
        selectedFolders: parsed.selectedFolders?.length || 0,
      });

      const requestResult = await database.pool.query<ProjectScanRequestRow>(
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
        limit 1
        `,
        [requestId],
      );

      const requestRow = requestResult.rows[0];
      if (!requestRow) {
        logger.warn("scan.result.receive.not_found");
        return res.status(404).json({ ok: false, error: "Solicitud no encontrada." });
      }
      if (normalizeRepoFullName(requestRow.repo_full_name) !== repoFullName) {
        logger.warn("scan.result.receive.repo_mismatch", {
          expectedRepoFullName: requestRow.repo_full_name,
          actualRepoFullName: repoFullName,
        });
        return res.status(400).json({ ok: false, error: "El repo del resultado no coincide con la solicitud." });
      }
      if (requestRow.status === PROJECT_SCAN_REQUEST_STATUSES.completed) {
        logger.info("scan.result.receive.already_completed", {
          durationMs: durationMs(startedAt),
          snapshotId: requestRow.snapshot_id,
        });
        return res.json({
          ok: true,
          request: mapProjectScanRequestRow(requestRow),
          alreadyCompleted: true,
        });
      }

      const storage = buildScanStoragePath(repoFullName, requestId, requestRow.requested_by_user_id);
      await fsp.mkdir(path.dirname(storage.absolutePath), { recursive: true });
      const payloadToStore = {
        requestId,
        receivedAt: new Date().toISOString(),
        payload: parsed,
      };
      await fsp.writeFile(storage.absolutePath, JSON.stringify(payloadToStore, null, 2), "utf8");

      const snapshotId = randomUUID();

      await database.pool.query("begin");
      try {
        await database.pool.query(
          `
          insert into project_scan_snapshots (
            id,
            request_id,
            repo_full_name,
            source,
            runtime,
            mode,
            workspace_folders,
            selected_folders,
            total_files,
            skipped_by_size,
            total_bytes,
            storage_path
          )
          values (
            $1,
            $2,
            $3,
            'vscode_extension',
            $4::jsonb,
            $5::jsonb,
            $6::jsonb,
            $7::jsonb,
            $8,
            $9,
            $10,
            $11
          )
          `,
          [
            snapshotId,
            requestId,
            repoFullName,
            JSON.stringify(parsed.runtime || {}),
            JSON.stringify(parsed.mode || {}),
            JSON.stringify(parsed.workspaceFolders || []),
            JSON.stringify(parsed.selectedFolders || []),
            parsed.totalFiles,
            skippedBySize,
            totalBytes,
            storage.absolutePath,
          ],
        );

        for (const file of parsed.files) {
          const filePath = trimText(file.path);
          const extension = path.extname(filePath).replace(/^\./, "").toLowerCase();
          const contentHash = createHash("sha256").update(file.content).digest("hex");
          await database.pool.query(
            `
            insert into project_scan_snapshot_files (
              id,
              snapshot_id,
              path,
              bytes,
              lines,
              preview,
              extension,
              content_sha256
            )
            values ($1, $2, $3, $4, $5, $6, $7, $8)
            `,
            [
              randomUUID(),
              snapshotId,
              filePath,
              Math.max(0, Number(file.bytes) || 0),
              Math.max(0, Number(file.lines) || 0),
              trimText(file.preview),
              extension,
              contentHash,
            ],
          );
        }

        await database.pool.query(
          `
          update project_scan_requests
          set
            status = 'completed',
            completed_at = now(),
            updated_at = now(),
            snapshot_id = $2,
            error_message = ''
          where id = $1
          `,
          [requestId, snapshotId],
        );

        await database.pool.query("commit");
      } catch (error) {
        await database.pool.query("rollback");
        throw error;
      }

      logger.info("scan.result.receive.done", {
        durationMs: durationMs(startedAt),
        snapshotId,
        storagePath: storage.absolutePath,
        totalFiles: parsed.totalFiles,
        filesReceived: parsed.files.length,
        skippedBySize,
        totalBytes,
      });
      return res.json({
        ok: true,
        snapshotId,
        storagePath: storage.absolutePath,
        request: {
          id: requestId,
          repoFullName,
          status: PROJECT_SCAN_REQUEST_STATUSES.completed,
        },
      });
    } catch (error) {
      const status = error instanceof z.ZodError ? 400 : 500;
      logger.error("scan.result.receive.failed", {
        durationMs: durationMs(startedAt),
        status,
        error: errorSummary(error),
      });
      return res.status(status).json({ ok: false, error: errorMessage(error) });
    }
  });

  app.post("/api/projects/scan/request/:requestId/fail", async (req, res) => {
    const diagnosticRequestId = getRequestId(req);
    const startedAt = Date.now();
    const logger = projectScanLog.child({
      requestId: diagnosticRequestId,
      route: "/api/projects/scan/request/:requestId/fail",
      scanRequestId: trimText(req.params.requestId),
    });
    try {
      logger.info("scan.fail.receive.start", {
        contentLength: trimText(req.header("content-length")),
      });
      if (!ensureWorkerAuthorized(req)) {
        logger.warn("scan.fail.receive.unauthorized");
        return res.status(401).json({ ok: false, error: "Worker no autorizado." });
      }

      const requestId = trimText(req.params.requestId);
      if (!requestId) {
        logger.warn("scan.fail.receive.invalid_request", {
          reason: "requestId requerido",
        });
        return res.status(400).json({ ok: false, error: "requestId requerido." });
      }

      const parsed = projectScanWorkerFailSchema.parse(req.body || {});
      const errorMessageText = trimText(parsed.error).slice(0, 1200);
      logger.warn("scan.fail.receive.parsed", {
        errorMessageChars: errorMessageText.length,
      });

      const result = await database.pool.query<ProjectScanRequestRow>(
        `
        update project_scan_requests
        set
          status = 'failed',
          updated_at = now(),
          completed_at = now(),
          error_message = $2
        where id = $1
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
        [requestId, errorMessageText],
      );

      if (!result.rows[0]) {
        logger.warn("scan.fail.receive.not_found");
        return res.status(404).json({ ok: false, error: "Solicitud no encontrada." });
      }

      logger.info("scan.fail.receive.done", {
        durationMs: durationMs(startedAt),
        repoFullName: result.rows[0].repo_full_name,
        status: result.rows[0].status,
      });
      return res.json({
        ok: true,
        request: mapProjectScanRequestRow(result.rows[0]),
      });
    } catch (error) {
      const status = error instanceof z.ZodError ? 400 : 500;
      logger.error("scan.fail.receive.failed", {
        durationMs: durationMs(startedAt),
        status,
        error: errorSummary(error),
      });
      return res.status(status).json({ ok: false, error: errorMessage(error) });
    }
  });
}

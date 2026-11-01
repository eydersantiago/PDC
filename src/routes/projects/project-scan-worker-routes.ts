// Rutas del worker del escaneo: entregar el resultado de un pedido o marcarlo como fallido.
import fsp from "node:fs/promises";
import path from "node:path";
import { createHash, randomUUID } from "node:crypto";
import type express from "express";
import { z } from "zod";
import { env } from "../../config/env.js";
import type { AppDatabase } from "../../db/database.js";
import { durationMs, errorSummary } from "../../services/shared/diagnostics.js";
import { buildScanStoragePath, mapProjectScanRequestRow, normalizeRepoFullName, PROJECT_SCAN_REQUEST_STATUSES, type ProjectScanRequestRow } from "../../services/documents/project-context.js";
import { trimText } from "../../services/shared/text-utils.js";
import { errorMessage } from "../route-utils.js";
import { getRequestId, projectScanLog, ensureWorkerAuthorized, resolveScanActor } from "./project-scan-utils.js";

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

export function registerProjectScanWorkerResultRoutes(app: express.Express, database: AppDatabase) {
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
      const scanActor = await resolveScanActor(database, req);
      if (!scanActor.dedicatedWorker && scanActor.session?.user.id !== requestRow.requested_by_user_id) {
        logger.warn("scan.result.receive.not_owner", { hasSession: Boolean(scanActor.session) });
        return res.status(scanActor.session ? 403 : 401).json({
          ok: false,
          error: scanActor.session
            ? "Esta solicitud de escaneo es de otro usuario."
            : "Sesion no valida: el escaneo lo envia el VS Code del mismo estudiante.",
        });
      }
      const contentBytes = parsed.files.reduce((acc, file) => acc + Buffer.byteLength(file.content, "utf8"), 0);
      if (contentBytes > env.scanMaxTotalBytes) {
        logger.warn("scan.result.receive.too_large", { contentBytes, limit: env.scanMaxTotalBytes });
        return res.status(413).json({
          ok: false,
          error: `El escaneo pesa ${contentBytes} bytes y el tope es ${env.scanMaxTotalBytes}.`,
        });
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

      // Transaccion real (una sola conexion): antes era pool.query("begin"/"commit") (A12.12).
      await database.withTransaction(async (client) => {
        await client.query(
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
          await client.query(
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

        await client.query(
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
      });

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
      const scanActor = await resolveScanActor(database, req);
      if (!scanActor.session && !scanActor.dedicatedWorker) {
        logger.warn("scan.fail.receive.session_required");
        return res.status(401).json({ ok: false, error: "Sesion no valida: el fallo lo reporta el VS Code del mismo estudiante." });
      }
      const failOwnerUserId = scanActor.session ? scanActor.session.user.id : "";
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
          and ($3 = '' or requested_by_user_id = $3)
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
        [requestId, errorMessageText, failOwnerUserId],
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

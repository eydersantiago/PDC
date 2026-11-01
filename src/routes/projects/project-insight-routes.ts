// Rutas del insight del proyecto: insight del contexto e insight de una captura de pantalla.
import { z } from "zod";
import express from "express";
import fsp from "node:fs/promises";
import path from "node:path";
import { env } from "../../config/env.js";
import type { AppDatabase } from "../../db/database.js";
import { runImageByMode, runTextByMode } from "../../services/tutor/agent-mode.js";
import { buildFallbackInsight, buildProjectInsightPrompt, buildProjectScreenshotInsightPrompt, buildScreenshotStoragePath, buildSnapshotVersion, detectMainFileByHeuristic, loadProjectScanFiles, normalizeRepoFullName, parseImageDataUrl, parseModelInsight, parseScreenshotModelInsight, resolveMainFilePath, toIso } from "../../services/documents/project-context.js";
import type { ProjectContextInsightSnapshotRow } from "../../services/documents/project-context.js";
import { trimText } from "../../services/shared/text-utils.js";
import { errorMessage, resolveSession } from "../route-utils.js";

export const projectContextInsightQuerySchema = z.object({
  repoFullName: z.string().min(3).max(240),
  useModel: z.preprocess((value) => {
    const text = trimText(value).toLowerCase();
    if (!text) return undefined;
    if (["1", "true", "yes", "on"].includes(text)) return true;
    if (["0", "false", "no", "off"].includes(text)) return false;
    return value;
  }, z.boolean().optional()),
}).strict();

export const screenshotCaptureEntrySchema = z.object({
  type: z.string().max(32).optional(),
  name: z.string().max(260).optional(),
  path: z.string().max(700).optional(),
  level: z.number().min(0).max(200).optional(),
}).strict();

export const screenshotViewportSchema = z.object({
  width: z.number().min(0).max(20000).optional(),
  height: z.number().min(0).max(20000).optional(),
  offsetLeft: z.number().min(-20000).max(20000).optional(),
  offsetTop: z.number().min(-20000).max(20000).optional(),
  scrollX: z.number().min(0).max(200000).optional(),
  scrollY: z.number().min(0).max(200000).optional(),
  devicePixelRatio: z.number().min(0.1).max(10).optional(),
}).strict();

export const screenshotCaptureContextSchema = z.object({
  capturedAt: z.string().max(80).optional(),
  overlayHidden: z.boolean().optional(),
  viewport: screenshotViewportSchema.optional(),
  url: z.string().max(1200).optional(),
  title: z.string().max(500).optional(),
  pageContext: z.string().max(80).optional(),
  pageType: z.string().max(80).optional(),
  repoFullName: z.string().max(240).optional(),
  branch: z.string().max(160).optional(),
  filePath: z.string().max(700).optional(),
  languageHint: z.string().max(120).optional(),
  codespaceBreadcrumbs: z.array(z.string().max(260)).max(16).optional(),
  codespaceActiveTabs: z.array(z.string().max(260)).max(12).optional(),
  visibleError: z.string().max(1000).optional(),
  selection: z.string().max(4000).optional(),
  visibleText: z.string().max(8000).optional(),
  codeSnippet: z.string().max(15000).optional(),
  codeLineCount: z.number().min(0).max(200000).optional(),
  explorerEntries: z.array(screenshotCaptureEntrySchema).max(500).optional(),
}).strict();

export const projectContextScreenshotInsightSchema = z.object({
  repoFullName: z.string().min(3).max(240),
  imageDataUrl: z.string().min(40).max(15_000_000),
  captureContext: screenshotCaptureContextSchema.optional(),
  useModel: z.boolean().optional(),
}).strict();

export async function fetchLatestInsightSnapshot(database: AppDatabase, repoFullName: string, userId: string) {
  const latestSnapshotResult = await database.pool.query<ProjectContextInsightSnapshotRow>(
    `
    select
      req.id as request_id,
      req.status as request_status,
      req.completed_at as request_completed_at,
      req.updated_at as request_updated_at,
      snap.id as snapshot_id,
      snap.repo_full_name,
      snap.source,
      snap.total_files,
      snap.skipped_by_size,
      snap.total_bytes,
      snap.storage_path,
      snap.created_at
    from project_scan_requests req
    join project_scan_snapshots snap on snap.id = req.snapshot_id
    where req.repo_full_name = $1
      and req.requested_by_user_id = $2
      and req.status = 'completed'
      and req.snapshot_id <> ''
    order by req.completed_at desc nulls last, req.requested_at desc
    limit 1
    `,
    [repoFullName, userId],
  );

  return latestSnapshotResult.rows[0] || null;
}

export function buildNoContextInsight(repoFullName: string, useModel: boolean) {
  return {
    configured: true,
    repoFullName,
    hasContext: false,
    modelEnabled: useModel,
    modelUsed: false,
    summary: `Aun no existe un escaneo completo para ${repoFullName}.`,
    mainFilePath: "",
    mainFileReason: "",
    autoAdvice: "Pulsa Explorar proyecto para enviar archivos al backend.",
  };
}

export function registerProjectInsightRoutes(app: express.Express, database: AppDatabase) {
  app.get("/api/projects/context/insight", async (req, res) => {
    try {
      const session = await resolveSession(database, req);
      if (!session) {
        return res.status(401).json({ ok: false, error: "Sesion no valida." });
      }

      const parsed = projectContextInsightQuerySchema.parse(req.query || {});
      const repoFullName = normalizeRepoFullName(parsed.repoFullName);
      if (!repoFullName) {
        return res.status(400).json({ ok: false, error: "repoFullName invalido. Usa owner/repo." });
      }

      const useModel = parsed.useModel !== false;
      const snapshot = await fetchLatestInsightSnapshot(database, repoFullName, session.user.id);
      if (!snapshot) {
        return res.json({
          ok: true,
          insight: buildNoContextInsight(repoFullName, useModel),
        });
      }

      const { files, storageReadError } = await loadProjectScanFiles(
        database,
        snapshot.snapshot_id,
        snapshot.storage_path,
        160,
      );

      const version = buildSnapshotVersion(snapshot);
      const heuristic = detectMainFileByHeuristic(files);
      let insight = buildFallbackInsight({
        repoFullName,
        version,
        mainFilePath: heuristic.mainFilePath,
        mainFileReason: heuristic.mainFileReason,
        totalFiles: Number(snapshot.total_files) || files.length,
      });
      let modelUsed = false;
      let modelError = "";

      if (useModel && files.length > 0) {
        try {
          const modelPrompt = buildProjectInsightPrompt({
            repoFullName,
            version,
            files,
            heuristicMainFilePath: heuristic.mainFilePath,
            heuristicReason: heuristic.mainFileReason,
            candidates: heuristic.candidates,
          });
          const modelRawOutput = await runTextByMode(modelPrompt, { route: "project-insight" }, { profile: "json" });
          const modelInsight = parseModelInsight(modelRawOutput);
          if (modelInsight) {
            const modelMainFilePath = resolveMainFilePath(modelInsight.mainFilePath, files)
              || heuristic.mainFilePath;
            insight = {
              summary: modelInsight.summary || insight.summary,
              mainFilePath: modelMainFilePath,
              mainFileReason: modelInsight.mainFileReason || heuristic.mainFileReason || insight.mainFileReason,
              autoAdvice: modelInsight.autoAdvice || insight.autoAdvice,
            };
            modelUsed = true;
          } else {
            modelError = "El modelo no devolvio JSON valido para insight.";
          }
        } catch (error) {
          modelError = trimText(String(error));
        }
      }

      return res.json({
        ok: true,
        insight: {
          configured: true,
          repoFullName,
          hasContext: true,
          requestId: snapshot.request_id,
          snapshotId: snapshot.snapshot_id,
          version,
          currentVersion: version,
          source: snapshot.source,
          updatedAt: toIso(snapshot.created_at) || toIso(snapshot.request_completed_at) || toIso(snapshot.request_updated_at),
          totalFiles: Number(snapshot.total_files) || files.length,
          totalBytes: Number(snapshot.total_bytes) || 0,
          modelEnabled: useModel,
          modelUsed,
          modelProvider: env.targetMode === "azure" ? "azure_proxy" : "local_ollama",
          summary: insight.summary,
          mainFilePath: insight.mainFilePath,
          mainFileReason: insight.mainFileReason,
          autoAdvice: insight.autoAdvice,
          candidates: heuristic.candidates,
          storageReadError: storageReadError || null,
          modelError: modelError || null,
        },
      });
    } catch (error) {
      return res.status(400).json({ ok: false, error: errorMessage(error) });
    }
  });

  app.post("/api/projects/context/screenshot-insight", async (req, res) => {
    try {
      const session = await resolveSession(database, req);
      if (!session) {
        return res.status(401).json({ ok: false, error: "Sesion no valida." });
      }

      const parsed = projectContextScreenshotInsightSchema.parse(req.body || {});
      const repoFullName = normalizeRepoFullName(parsed.repoFullName);
      if (!repoFullName) {
        return res.status(400).json({ ok: false, error: "repoFullName invalido. Usa owner/repo." });
      }

      const useModel = parsed.useModel !== false;
      const screenshotSource = parsed.captureContext?.overlayHidden === true
        ? "visible_tab_capture_overlay_hidden"
        : "visible_tab_capture";
      const snapshot = await fetchLatestInsightSnapshot(database, repoFullName, session.user.id);
      if (!snapshot) {
        return res.json({
          ok: true,
          insight: {
            ...buildNoContextInsight(repoFullName, useModel),
            screenshotUsed: false,
            screenshotSource,
            screenshotOcrText: "",
            screenshotConfidence: 0,
            screenshotSavedPath: null,
            screenshotSavedAt: null,
          },
        });
      }

      const { files, storageReadError } = await loadProjectScanFiles(
        database,
        snapshot.snapshot_id,
        snapshot.storage_path,
        200,
      );

      const version = buildSnapshotVersion(snapshot);
      const heuristic = detectMainFileByHeuristic(files);
      let insight = buildFallbackInsight({
        repoFullName,
        version,
        mainFilePath: heuristic.mainFilePath,
        mainFileReason: heuristic.mainFileReason,
        totalFiles: Number(snapshot.total_files) || files.length,
      });

      let modelUsed = false;
      let modelError = "";
      let screenshotUsed = false;
      let screenshotOcrText = "";
      let screenshotConfidence = 0;
      let screenshotSavedPath = "";
      let screenshotSavedAt = "";

      if (useModel) {
        const parsedImage = parseImageDataUrl(parsed.imageDataUrl);
        if (!parsedImage) {
          return res.status(400).json({ ok: false, error: "imageDataUrl invalido. Se esperaba data:image/...;base64,..." });
        }

        const storage = buildScreenshotStoragePath(
          repoFullName,
          parsedImage.extension,
          session.user.id,
        );
        await fsp.mkdir(path.dirname(storage.absolutePath), { recursive: true });
        await fsp.writeFile(storage.absolutePath, parsedImage.buffer);
        screenshotSavedPath = storage.relativePath || storage.absolutePath;
        screenshotSavedAt = new Date().toISOString();

        try {
          const prompt = buildProjectScreenshotInsightPrompt({
            repoFullName,
            version,
            files,
            heuristicMainFilePath: heuristic.mainFilePath,
            heuristicReason: heuristic.mainFileReason,
            candidates: heuristic.candidates,
            captureContext: parsed.captureContext,
          });
          const modelRawOutput = await runImageByMode({
            path: storage.absolutePath,
            mimetype: parsedImage.mimeType,
            originalname: path.basename(storage.absolutePath),
          }, prompt);
          const modelInsight = parseScreenshotModelInsight(modelRawOutput);
          if (modelInsight) {
            const resolvedMainFilePath = resolveMainFilePath(modelInsight.mainFilePath, files)
              || resolveMainFilePath(trimText(parsed.captureContext?.filePath), files)
              || heuristic.mainFilePath;
            insight = {
              summary: modelInsight.summary || insight.summary,
              mainFilePath: resolvedMainFilePath,
              mainFileReason: modelInsight.mainFileReason || heuristic.mainFileReason || insight.mainFileReason,
              autoAdvice: modelInsight.autoAdvice || insight.autoAdvice,
            };
            screenshotOcrText = modelInsight.ocrText || "";
            screenshotConfidence = modelInsight.confidence;
            screenshotUsed = true;
            modelUsed = true;
          } else {
            modelError = "El modelo OCR no devolvio JSON valido.";
          }
        } catch (error) {
          modelError = trimText(String(error));
        }
      }

      return res.json({
        ok: true,
        insight: {
          configured: true,
          repoFullName,
          hasContext: true,
          requestId: snapshot.request_id,
          snapshotId: snapshot.snapshot_id,
          version,
          currentVersion: version,
          source: snapshot.source,
          updatedAt: toIso(snapshot.created_at) || toIso(snapshot.request_completed_at) || toIso(snapshot.request_updated_at),
          totalFiles: Number(snapshot.total_files) || files.length,
          totalBytes: Number(snapshot.total_bytes) || 0,
          modelEnabled: useModel,
          modelUsed,
          modelProvider: env.targetMode === "azure" ? "azure_proxy" : "local_ollama",
          summary: insight.summary,
          mainFilePath: insight.mainFilePath,
          mainFileReason: insight.mainFileReason,
          autoAdvice: insight.autoAdvice,
          candidates: heuristic.candidates,
          storageReadError: storageReadError || null,
          modelError: modelError || null,
          screenshotUsed,
          screenshotSource,
          screenshotOcrText: screenshotOcrText || null,
          screenshotConfidence,
          screenshotSavedPath: screenshotSavedPath || null,
          screenshotSavedAt: screenshotSavedAt || null,
        },
      });
    } catch (error) {
      return res.status(400).json({ ok: false, error: errorMessage(error) });
    }
  });
}

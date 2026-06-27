import fsp from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import type express from "express";
import { z } from "zod";
import { env } from "../config/env.js";
import type { AppDatabase } from "../db/database.js";
import { runImageByMode, runTextByMode } from "../services/agent-mode.js";
import {
  buildFallbackInsight,
  buildProjectInsightPrompt,
  buildProjectScreenshotInsightPrompt,
  buildScreenshotStoragePath,
  buildSnapshotVersion,
  detectMainFileByHeuristic,
  loadProjectScanFiles,
  mapProjectContextHistoryRow,
  mapProjectScanRequestRow,
  mapProjectScanSnapshotRow,
  normalizeRepoFullName,
  parseImageDataUrl,
  parseModelInsight,
  parseScreenshotModelInsight,
  PROJECT_SCAN_REQUEST_STATUSES,
  resolveMainFilePath,
  toIso,
  type ProjectContextHistoryRow,
  type ProjectContextInsightSnapshotRow,
  type ProjectScanRequestRow,
  type ProjectScanSnapshotRow,
} from "../services/project-context.js";
import { trimText } from "../services/text-utils.js";
import { errorMessage, resolveSession } from "./route-utils.js";

const workspaceConsentSchema = z.object({
  canRead: z.boolean().default(true),
  canModify: z.boolean().default(true),
  canAnalyze: z.boolean().default(true),
}).strict();

const projectRackSchema = z.object({
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

const projectContextQuerySchema = z.object({
  repoFullName: z.string().min(3).max(240),
}).strict();

const projectContextHistoryQuerySchema = z.object({
  repoFullName: z.string().min(3).max(240),
  limit: z.coerce.number().int().min(1).max(50).optional(),
}).strict();

const projectContextRebuildSchema = z.object({
  repoFullName: z.string().min(3).max(240),
  requestId: z.string().max(120).optional(),
}).strict();

const projectContextInsightQuerySchema = z.object({
  repoFullName: z.string().min(3).max(240),
  useModel: z.preprocess((value) => {
    const text = trimText(value).toLowerCase();
    if (!text) return undefined;
    if (["1", "true", "yes", "on"].includes(text)) return true;
    if (["0", "false", "no", "off"].includes(text)) return false;
    return value;
  }, z.boolean().optional()),
}).strict();

const screenshotCaptureEntrySchema = z.object({
  type: z.string().max(32).optional(),
  name: z.string().max(260).optional(),
  path: z.string().max(700).optional(),
  level: z.number().min(0).max(200).optional(),
}).strict();

const screenshotViewportSchema = z.object({
  width: z.number().min(0).max(20000).optional(),
  height: z.number().min(0).max(20000).optional(),
  offsetLeft: z.number().min(-20000).max(20000).optional(),
  offsetTop: z.number().min(-20000).max(20000).optional(),
  scrollX: z.number().min(0).max(200000).optional(),
  scrollY: z.number().min(0).max(200000).optional(),
  devicePixelRatio: z.number().min(0.1).max(10).optional(),
}).strict();

const screenshotCaptureContextSchema = z.object({
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

const projectContextScreenshotInsightSchema = z.object({
  repoFullName: z.string().min(3).max(240),
  imageDataUrl: z.string().min(40).max(15_000_000),
  captureContext: screenshotCaptureContextSchema.optional(),
  useModel: z.boolean().optional(),
}).strict();

const projectCodeActionSchema = z.object({
  repoFullName: z.string().min(3).max(240),
  branch: z.string().max(160).optional(),
  filePath: z.string().min(1).max(700),
  actionType: z.string().min(2).max(80).optional(),
  title: z.string().max(180).optional(),
  originalText: z.string().max(120000).optional(),
  replacementText: z.string().min(1).max(120000),
  metadata: z.record(z.string(), z.unknown()).optional(),
}).strict();

const projectCodeActionNextQuerySchema = z.object({
  repoFullName: z.string().min(3).max(240),
  workerId: z.string().max(120).optional(),
}).strict();

const projectCodeActionCompleteSchema = z.object({
  metadata: z.record(z.string(), z.unknown()).optional(),
}).strict();

const projectCodeActionFailSchema = z.object({
  error: z.string().min(1).max(1200),
}).strict();

type ProjectContextRackRow = {
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

type ProjectCodeActionRow = {
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

function normalizeReplacementOptions(value: unknown) {
  const items = Array.isArray(value) ? value : [];
  return items
    .map((item) => item && typeof item === "object" ? item as Record<string, unknown> : null)
    .filter((item): item is Record<string, unknown> => !!item)
    .map((item) => ({
      id: trimText(item.id).slice(0, 120),
      label: trimText(item.label).slice(0, 180),
      description: trimText(item.description).slice(0, 800),
      actionType: trimText(item.actionType || item.action_type).slice(0, 80),
      originalText: trimText(item.originalText || item.original_text).slice(0, 120000),
      replacementText: trimText(item.replacementText || item.replacement_text).slice(0, 120000),
      metadata: item.metadata && typeof item.metadata === "object" && !Array.isArray(item.metadata)
        ? item.metadata as Record<string, unknown>
        : {},
    }))
    .filter((item) => item.label || item.replacementText)
    .slice(0, 8);
}

function mapProjectCodeActionRow(row: ProjectCodeActionRow | undefined | null) {
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

async function fetchLatestInsightSnapshot(database: AppDatabase, repoFullName: string, userId: string) {
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

function buildNoContextInsight(repoFullName: string, useModel: boolean) {
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

export function registerProjectContextRoutes(app: express.Express, database: AppDatabase) {
  app.get("/api/projects/session/state", async (req, res) => {
    try {
      const session = await resolveSession(database, req);
      if (!session) {
        return res.status(401).json({ ok: false, error: "Sesion no valida." });
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

      return res.json({
        ok: true,
        state: {
          sessionId: session.id,
          userId: session.user.id,
          userRole: session.user.role,
          latestRequest: mapProjectScanRequestRow(latestRequestResult.rows[0]),
          latestRack: latestRack
            ? {
                id: latestRack.id,
                sessionId: latestRack.session_id,
                source: latestRack.source,
                repoFullName: latestRack.repo_full_name,
                branch: latestRack.branch,
                totalEntries: Number(latestRack.total_entries) || 0,
                totalFiles: Number(latestRack.total_files) || 0,
                totalFolders: Number(latestRack.total_folders) || 0,
                files: latestRack.files || [],
                folders: latestRack.folders || [],
                activeFilePath: latestRack.active_file_path,
                activeCodeSnippet: latestRack.active_code_snippet,
                activeSuggestion: latestRack.active_suggestion,
                replacementOptions: normalizeReplacementOptions(latestRack.replacement_options),
                generatedAt: toIso(latestRack.generated_at),
                createdAt: toIso(latestRack.created_at),
                updatedAt: toIso(latestRack.updated_at),
              }
            : null,
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
          const modelRawOutput = await runTextByMode(modelPrompt);
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
          trimText(parsed.actionType) || "replace_selection",
          trimText(parsed.title) || "Reemplazo sugerido",
          trimText(parsed.originalText),
          trimText(parsed.replacementText),
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

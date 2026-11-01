// Utilidades comunes de las rutas del agente: id del pedido, log y enlaces al visor de las fuentes RAG.
import crypto from "node:crypto";
import type express from "express";
import { env } from "../../config/env.js";
import { createDiagnosticLogger, textStats } from "../../services/shared/diagnostics.js";
import { trimText } from "../../services/shared/text-utils.js";
import type { RagContextItem } from "../../types/app.js";
import { getRequestBaseUrl } from "../route-utils.js";

export type ImageUploadMiddleware = {
  single(fieldName: string): express.RequestHandler;
};

type RagContextItemWithViewer = RagContextItem & {
  url: string;
  externalUrl: string;
  courseCode: string;
  citation: RagContextItem["citation"] & {
    externalUrl: string;
  };
};

export const agentRoutesLog = createDiagnosticLogger("agent-routes");

export function getRequestId(req: express.Request) {
  return trimText(req.header("x-request-id") || req.header("x-correlation-id")) || crypto.randomUUID();
}

function ragItemCourseCode(item: RagContextItem, fallback: string) {
  return trimText(item.metadata.courseCode)
    || trimText(item.metadata.course_code)
    || trimText(fallback);
}

/**
 * Enlace al visor de la fuente. A12.8: sin sessionId en la URL (el visor no
 * lo usa y una sesion en la URL queda en el historial, en capturas y en logs).
 */
function buildRagViewerUrl(
  req: express.Request,
  item: RagContextItem,
  courseCode: string,
) {
  const baseUrl = getRequestBaseUrl(req, env.publicApiUrl || env.azureServer);
  const sourceId = trimText(item.sourceId || item.id);
  if (!baseUrl || !sourceId) return "";

  const params = new URLSearchParams();
  const chunkId = trimText(item.chunkId);
  if (chunkId) params.set("chunkId", chunkId);
  if (item.pageStart) params.set("page", String(item.pageStart));
  if (courseCode) params.set("courseCode", courseCode);

  const query = params.toString();
  return `${baseUrl}/api/rag/sources/${encodeURIComponent(sourceId)}/view${query ? `?${query}` : ""}`;
}

export function attachRagViewerLinks(
  req: express.Request,
  items: RagContextItem[],
  fallbackCourseCode: string,
): RagContextItemWithViewer[] {
  return items.map((item) => {
    const courseCode = ragItemCourseCode(item, fallbackCourseCode);
    const externalUrl = trimText(item.citation?.url);
    const viewerUrl = buildRagViewerUrl(req, item, courseCode);
    const url = viewerUrl || externalUrl;
    return {
      ...item,
      url,
      externalUrl,
      courseCode,
      citation: {
        ...item.citation,
        url,
        externalUrl,
      },
      metadata: {
        ...item.metadata,
        courseCode,
        externalUrl,
        viewerUrl,
      },
    };
  });
}

export function summarizeRagSourcesForLog(items: unknown[]) {
  return items.slice(0, 5).map((item, index) => {
    const source = item && typeof item === "object" ? item as Record<string, unknown> : {};
    const metadata = source.metadata && typeof source.metadata === "object"
      ? source.metadata as Record<string, unknown>
      : {};
    return {
      index: index + 1,
      title: trimText(source.title),
      fileName: trimText(source.fileName),
      citationLabel: trimText(source.citationLabel),
      courseCode: trimText(source.courseCode) || trimText(metadata.courseCode),
      pageStart: Number(source.pageStart) || null,
      pageEnd: Number(source.pageEnd) || null,
      score: Number(source.score) || 0,
      isOpenable: Boolean(source.isOpenable || source.url),
      usageReason: textStats(source.usageReason),
    };
  });
}

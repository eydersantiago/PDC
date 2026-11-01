// Visor de fuentes RAG (GET /api/rag/sources/:id/view): copia local del PDF, fragmentos y pagina HTML.
import path from "node:path";
import type express from "express";
import { env } from "../../config/env.js";
import type { AppDatabase } from "../../db/database.js";
import { extractRagDocumentText } from "../../services/rag/rag-document-processing.js";
import { buildRagChunksForSource } from "../../services/rag/rag-chunks.js";
import { getRagKnowledgeTier, sourceUrl } from "../../services/rag/rag-text.js";
import { trimText } from "../../services/shared/text-utils.js";
import type { RagSource, RagSourceChunk } from "../../types/app.js";
import { errorMessage } from "../route-utils.js";

const RAG_VIEWER_REMOTE_FETCH_TIMEOUT_MS = 120000;

type RagViewerChunk = {
  id: string;
  title: string;
  pageText: string;
  citationLabel: string;
  contentText: string;
  selected: boolean;
};

export function cleanFileName(value: string) {
  return trimText(path.basename(value || "fuente_rag"));
}

function escapeHtml(value: unknown) {
  return trimText(value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function appendPageFragment(rawUrl: string, page: number | null) {
  const url = trimText(rawUrl);
  if (!url || !page || url.includes("#")) return url;
  return `${url}#page=${page}`;
}

function googleDriveFileId(rawUrl: string) {
  const url = trimText(rawUrl);
  if (!url) return "";

  try {
    const parsed = new URL(url);
    if (!/(\.|^)drive\.google\.com$/i.test(parsed.hostname)) {
      return "";
    }
    const fileMatch = parsed.pathname.match(/\/file\/d\/([^/]+)/i);
    return fileMatch?.[1] || parsed.searchParams.get("id") || "";
  } catch {
    return "";
  }
}

function toDownloadableSourceUrl(rawUrl: string) {
  const url = trimText(rawUrl);
  const driveId = googleDriveFileId(url);
  return driveId ? `https://drive.google.com/uc?export=download&id=${encodeURIComponent(driveId)}` : url;
}

function metadataString(metadata: Record<string, unknown>, key: string) {
  const value = metadata[key];
  return typeof value === "string" || typeof value === "number" || typeof value === "boolean"
    ? trimText(String(value))
    : "";
}

function isLikelyExternalPdfSource(source: RagSource, externalUrl: string) {
  const probe = [
    source.sourceType,
    source.mimeType,
    source.fileName,
    source.title,
    externalUrl,
  ].join(" ").toLowerCase();
  return probe.includes("pdf")
    || probe.includes("google_drive_file")
    || /drive\.google\.com/i.test(externalUrl);
}

function hasIndependentViewerContent(source: RagSource) {
  const metadata = source.metadata || {};
  if (
    metadataString(metadata, "extractionSource")
    || metadataString(metadata, "viewerCachedAt")
    || metadataString(metadata, "cachedFromUrl")
  ) {
    return trimText(source.contentText).length > 0;
  }

  if (source.scope === "teacher" && trimText(source.contentText).length > 0) {
    return true;
  }

  return (source.chunks || []).some((chunk) => (
    trimText(chunk.contentText).length > 700
    || chunk.pageStart != null
    || chunk.pageEnd != null
  ));
}

function shouldTryRemotePdfCache(source: RagSource, externalUrl: string) {
  return !!externalUrl
    && !hasIndependentViewerContent(source)
    && isLikelyExternalPdfSource(source, externalUrl);
}

function formatPageRange(pageStart: number | null, pageEnd: number | null) {
  if (!pageStart) return "";
  if (pageEnd && pageEnd !== pageStart) return `Paginas ${pageStart}-${pageEnd}`;
  return `Pagina ${pageStart}`;
}

function viewerChunkTitle(chunk: RagSourceChunk, fallbackIndex: number) {
  const index = Number(chunk.chunkIndex);
  const position = Number.isFinite(index) ? index + 1 : fallbackIndex + 1;
  return `Fragmento ${position}`;
}

function buildViewerChunks(source: RagSource, selectedChunk: RagSourceChunk | null): RagViewerChunk[] {
  const chunks = (source.chunks || [])
    .map((chunk, index) => ({
      id: chunk.id || `${source.id}:chunk:${index}`,
      title: viewerChunkTitle(chunk, index),
      pageText: formatPageRange(chunk.pageStart, chunk.pageEnd),
      citationLabel: trimText(chunk.citationLabel),
      contentText: trimText(chunk.contentText),
      selected: selectedChunk ? chunk.id === selectedChunk.id : index === 0,
    }))
    .filter((chunk) => chunk.contentText);

  if (chunks.length > 0) return chunks;

  const contentText = trimText(source.contentText);
  return contentText
    ? [{
      id: `${source.id}:content`,
      title: "Contenido interno",
      pageText: "",
      citationLabel: "",
      contentText,
      selected: true,
    }]
    : [];
}

async function responseBufferWithLimit(response: Response, maxBytes: number) {
  const contentLength = Number(response.headers.get("content-length") || 0);
  if (contentLength > maxBytes) {
    throw new Error(`La fuente pesa ${contentLength} bytes y supera el limite RAG de ${maxBytes} bytes.`);
  }

  const arrayBuffer = await response.arrayBuffer();
  if (arrayBuffer.byteLength > maxBytes) {
    throw new Error(`La fuente pesa ${arrayBuffer.byteLength} bytes y supera el limite RAG de ${maxBytes} bytes.`);
  }

  return Buffer.from(arrayBuffer);
}

async function downloadRemotePdfForRag(rawUrl: string) {
  const downloadUrl = toDownloadableSourceUrl(rawUrl);
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), RAG_VIEWER_REMOTE_FETCH_TIMEOUT_MS);

  try {
    const response = await fetch(downloadUrl, {
      redirect: "follow",
      signal: controller.signal,
      headers: {
        "user-agent": "ADACEEN-RAG/1.0",
        accept: "application/pdf,application/octet-stream,*/*;q=0.8",
      },
    });

    if (!response.ok) {
      throw new Error(`La fuente remota respondio HTTP ${response.status}.`);
    }

    const contentType = trimText(response.headers.get("content-type") || "");
    const buffer = await responseBufferWithLimit(response, env.ragUploadMaxBytes);
    const signature = buffer.subarray(0, 5).toString("utf8");
    if (signature !== "%PDF-") {
      const hint = /html/i.test(contentType) || /<!doctype|<html/i.test(buffer.subarray(0, 160).toString("utf8"))
        ? "La fuente devolvio HTML/login en lugar del PDF."
        : "La fuente no parece ser un PDF valido.";
      throw new Error(hint);
    }

    return {
      buffer,
      contentType: contentType || "application/pdf",
      finalUrl: response.url || downloadUrl,
    };
  } finally {
    clearTimeout(timeout);
  }
}

export async function ensureIndependentRagViewerSource(database: AppDatabase, source: RagSource) {
  const externalUrl = sourceUrl(source.metadata || {});
  if (!shouldTryRemotePdfCache(source, externalUrl)) {
    return { source, notice: "" };
  }

  try {
    const remote = await downloadRemotePdfForRag(externalUrl);
    const fileName = cleanFileName(source.fileName || `${source.title || source.id}.pdf`);
    const extracted = await extractRagDocumentText({
      fileName,
      filePath: fileName,
      mimeType: remote.contentType || "application/pdf",
      extension: "pdf",
      buffer: remote.buffer,
      maxTextChars: env.ragMaxExtractedTextChars,
      useModel: false,
    });
    const contentText = trimText(extracted.text);
    if (!contentText) {
      return {
        source,
        notice: "ADACEEN intento cachear el PDF, pero no pudo extraer texto util del archivo remoto.",
      };
    }

    const metadata = {
      viewerMode: "internal_text",
      viewerCachedAt: new Date().toISOString(),
      cachedFromUrl: externalUrl,
      cachedFinalUrl: remote.finalUrl,
      extractionSource: `remote_${extracted.source}`,
      extension: extracted.extension,
      bytes: extracted.bytes,
      pageCount: extracted.totalPages || extracted.pages.length || null,
      truncated: extracted.truncated,
      warnings: extracted.warnings,
    };
    const chunks = buildRagChunksForSource({
      title: source.title,
      sourceType: source.sourceType,
      fileName,
      sourceKey: source.sourceKey,
      contentText,
      metadata: {
        ...source.metadata,
        ...metadata,
      },
      pages: extracted.pages,
    });
    const updatedSource = await database.updateRagSourceExtractedContent(source.id, {
      fileName,
      mimeType: extracted.mimeType || remote.contentType || "application/pdf",
      sourceType: source.sourceType,
      contentText,
      metadata,
      chunks,
    });

    return {
      source: updatedSource || source,
      notice: updatedSource
        ? "ADACEEN cacheo esta fuente y ahora la muestra desde texto interno, sin depender del visor de Drive."
        : "ADACEEN extrajo el PDF remoto, pero no pudo actualizar la fuente RAG.",
    };
  } catch (error) {
    return {
      source,
      notice: `ADACEEN no pudo cachear el PDF remoto: ${errorMessage(error)}. Si la fuente es de Drive, revisa que este compartida como lectura publica o carga el PDF directamente al RAG.`,
    };
  }
}

export function findViewerChunk(source: RagSource, chunkId: string, page: number | null) {
  const chunks = source.chunks || [];
  if (!chunks.length) return null;

  if (chunkId) {
    const byId = chunks.find((chunk) => chunk.id === chunkId || String(chunk.chunkIndex) === chunkId);
    if (byId) return byId;
  }

  if (page) {
    const byPage = chunks.find((chunk) => {
      const start = chunk.pageStart || 0;
      const end = chunk.pageEnd || start;
      return start > 0 && page >= start && page <= end;
    });
    if (byPage) return byPage;
  }

  return chunks[0] || null;
}

export function renderRagViewerPage(input: {
  source: RagSource;
  chunk: RagSourceChunk | null;
  requestedPage: number | null;
  courseCode: string;
  notice?: string;
}) {
  const { source, chunk } = input;
  const mergedMetadata = { ...source.metadata, ...(chunk?.metadata || {}) };
  const pageStart = chunk?.pageStart || input.requestedPage || null;
  const pageEnd = chunk?.pageEnd || pageStart;
  const pageText = formatPageRange(pageStart, pageEnd);
  const externalUrl = sourceUrl(mergedMetadata);
  const originPath = trimText(mergedMetadata.path) || trimText(mergedMetadata.source_pdf) || trimText(source.sourceKey);
  const citationLabel = trimText(chunk?.citationLabel) || trimText(mergedMetadata.citationLabel) || "";
  const viewerChunks = buildViewerChunks(source, chunk);
  const selectedViewerChunk = viewerChunks.find((viewerChunk) => viewerChunk.selected) || viewerChunks[0] || null;
  const excerpt = selectedViewerChunk?.contentText || trimText(chunk?.contentText) || trimText(source.contentText);
  const title = source.title || source.fileName || "Fuente RAG";
  const sourceKind = source.sourceType || source.mimeType || "fuente";
  const knowledgeTier = getRagKnowledgeTier(source.metadata || {}, source.sourceType);
  const sourceLabel = knowledgeTier === "supplemental"
    ? "Contexto de bitacora consultado"
    : "Fuente RAG consultada";
  const sourceRole = knowledgeTier === "supplemental"
    ? "Contexto suplementario de actividad"
    : source.scope === "default" ? "Base del curso" : source.scope === "teacher" ? "Fuente del docente" : source.scope;
  const hasInternalContent = hasIndependentViewerContent(source);
  const viewerStatus = hasInternalContent
    ? "Visor interno ADACEEN: contenido servido desde la base local, sin incrustar Google Drive."
    : knowledgeTier === "supplemental"
      ? "Este contexto proviene de la bitacora/actividad y se usa con peso secundario frente al RAG principal del curso."
      : "Esta fuente tiene metadata RAG, pero aun no tiene el PDF/texto completo cacheado. Carga el PDF al RAG o haz publico el enlace para que ADACEEN pueda cachearlo.";
  const metaParts = [
    input.courseCode ? `Curso ${input.courseCode}` : "",
    sourceRole,
    sourceKind,
    source.fileName,
    pageText,
    citationLabel,
  ].filter(Boolean);

  return `<!doctype html>
<html lang="es">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>${escapeHtml(title)} | ADACEEN RAG</title>
  <style>
    :root { color-scheme: light; font-family: Inter, Segoe UI, Roboto, Arial, sans-serif; }
    body { margin: 0; background: #f6f8fb; color: #14213d; }
    header { padding: 24px clamp(18px, 4vw, 42px); background: #ffffff; border-bottom: 1px solid #dde5ef; }
    main { display: grid; grid-template-columns: minmax(280px, 420px) minmax(0, 1fr); gap: 18px; padding: 18px clamp(18px, 4vw, 42px) 30px; }
    h1 { margin: 0 0 8px; font-size: clamp(22px, 3vw, 34px); line-height: 1.12; }
    .meta { color: #53657d; font-size: 14px; line-height: 1.55; }
    .panel { background: #ffffff; border: 1px solid #dde5ef; border-radius: 8px; padding: 18px; }
    .label { margin: 0 0 6px; color: #3b4d63; font-size: 12px; font-weight: 700; letter-spacing: .04em; text-transform: uppercase; }
    .excerpt, .chunk-body { white-space: pre-wrap; line-height: 1.62; font-size: 15px; }
    .viewer { min-height: 72vh; overflow: auto; }
    .status { margin: 14px 0 0; padding: 12px 14px; border-radius: 8px; background: #edf7ff; color: #164e63; border: 1px solid #bae6fd; line-height: 1.5; }
    .notice { margin: 12px 0 0; padding: 12px 14px; border-radius: 8px; background: #fff7ed; color: #7c2d12; border: 1px solid #fed7aa; line-height: 1.5; }
    .chunk { padding: 16px 0; border-top: 1px solid #dde5ef; }
    .chunk:first-child { border-top: 0; padding-top: 0; }
    .chunk.is-selected { border-left: 4px solid #0f766e; padding-left: 14px; background: linear-gradient(90deg, rgba(20,184,166,.08), transparent 55%); }
    .chunk-head { display: flex; flex-wrap: wrap; gap: 8px; align-items: baseline; margin-bottom: 8px; }
    .chunk-title { margin: 0; font-size: 16px; }
    .chip { display: inline-flex; align-items: center; min-height: 22px; padding: 0 8px; border-radius: 999px; background: #e2e8f0; color: #334155; font-size: 12px; font-weight: 700; }
    a { color: #075985; font-weight: 700; }
    .empty { display: grid; place-items: center; min-height: 48vh; color: #53657d; text-align: center; }
    @media (max-width: 880px) { main { grid-template-columns: 1fr; } }
  </style>
</head>
<body>
  <header>
    <p class="label">${escapeHtml(sourceLabel)}</p>
    <h1>${escapeHtml(title)}</h1>
    <div class="meta">${escapeHtml(metaParts.join(" | ") || "Fuente del material del curso")}</div>
  </header>
  <main>
    <section class="panel">
      <p class="label">Fragmento compatible</p>
      <div class="excerpt">${escapeHtml(excerpt || "No hay fragmento extraido para esta fuente.")}</div>
      <div class="status">${escapeHtml(viewerStatus)}</div>
      ${input.notice ? `<div class="notice">${escapeHtml(input.notice)}</div>` : ""}
      ${originPath ? `<p class="meta"><strong>Origen:</strong> ${escapeHtml(originPath)}</p>` : ""}
      ${externalUrl ? `<p><a href="${escapeHtml(appendPageFragment(externalUrl, pageStart))}" target="_blank" rel="noreferrer">Abrir fuente original opcional</a></p>` : ""}
    </section>
    <section class="panel viewer">
      <p class="label">Contenido interno del RAG</p>
      ${viewerChunks.length
        ? viewerChunks.map((viewerChunk) => `
          <article class="chunk${viewerChunk.selected ? " is-selected" : ""}" id="${escapeHtml(viewerChunk.id)}">
            <div class="chunk-head">
              <h2 class="chunk-title">${escapeHtml(viewerChunk.title)}</h2>
              ${viewerChunk.pageText ? `<span class="chip">${escapeHtml(viewerChunk.pageText)}</span>` : ""}
              ${viewerChunk.citationLabel ? `<span class="chip">${escapeHtml(viewerChunk.citationLabel)}</span>` : ""}
            </div>
            <div class="chunk-body">${escapeHtml(viewerChunk.contentText)}</div>
          </article>
        `).join("")
        : `<div class="empty">No hay texto interno para mostrar todavia. ADACEEN ya no incrusta Drive aqui; carga/cachea el PDF para ver la fuente completa sin permisos externos.</div>`}
    </section>
  </main>
</body>
</html>`;
}

export function sendRagViewerHtml(res: express.Response, status: number, html: string) {
  res.status(status);
  res.setHeader("Content-Type", "text/html; charset=utf-8");
  res.setHeader("Cache-Control", "private, no-store");
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("Referrer-Policy", "no-referrer");
  res.setHeader(
    "Content-Security-Policy",
    "default-src 'none'; style-src 'unsafe-inline'; img-src data:; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
  );
  return res.send(html);
}

export function renderRagViewerMessage(title: string, message: string) {
  return `<!doctype html>
<html lang="es">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>${escapeHtml(title)} | ADACEEN RAG</title>
  <style>
    body { margin: 0; min-height: 100vh; display: grid; place-items: center; font-family: Segoe UI, Roboto, Arial, sans-serif; background: #f6f8fb; color: #14213d; }
    main { width: min(680px, calc(100vw - 36px)); background: #fff; border: 1px solid #dde5ef; border-radius: 8px; padding: 24px; }
    h1 { margin: 0 0 10px; font-size: 26px; }
    p { margin: 0; color: #53657d; line-height: 1.55; }
  </style>
</head>
<body>
  <main>
    <h1>${escapeHtml(title)}</h1>
    <p>${escapeHtml(message)}</p>
  </main>
</body>
</html>`;
}

// ADACEEN | Capa 3 - Servicios: documentos del Campus: encontrar enlaces a documentos en la pagina, seguir
// paginas intermedias, descargarlos y enviarlos al clasificador del backend.
// Movido sin cambios desde services/campus.service.js.
// Orden de carga: manifest.json (content_scripts) y background.js (CONTENT_SCRIPT_FILES) deben coincidir.
"use strict";

const CAMPUS_DOCUMENT_MAX_DOWNLOADS = 6;

const CAMPUS_DOCUMENT_MAX_BYTES = 8 * 1024 * 1024;

const CAMPUS_DOCUMENT_DOWNLOAD_TIMEOUT_MS = 120000;

const CAMPUS_DOCUMENT_CLASSIFY_TIMEOUT_MS = 120000;

const CAMPUS_DOCUMENT_EXTENSIONS = new Set([
  "pdf",
  "docx",
  "txt",
  "md",
  "markdown",
  "png",
  "jpg",
  "jpeg",
  "webp",
  "gif",
  "bmp",
  "tif",
  "tiff",
]);

const CAMPUS_DOCUMENT_MIME_BY_EXTENSION = {
  pdf: "application/pdf",
  docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  txt: "text/plain",
  md: "text/markdown",
  markdown: "text/markdown",
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  webp: "image/webp",
  gif: "image/gif",
  bmp: "image/bmp",
  tif: "image/tiff",
  tiff: "image/tiff",
};

const CAMPUS_DOCUMENT_KEYWORDS =
  /\b(bitacora|bitácora|diario\s+de\s+campo|registro\s+de\s+actividades|seguimiento\s+semanal|logbook|registro\s+de\s+avance|control\s+de\s+avance|informe\s+semanal|avance\s+semanal)\b/i;

const CAMPUS_DIRECT_DOCUMENT_URL_RE =
  /pluginfile\.php|\/draftfile\.php|\/webservice\/pluginfile\.php|\.(?:pdf|docx?|txt|md|markdown|png|jpe?g|webp|gif|bmp|tiff?)(?:$|[?#])/i;

const CAMPUS_DOCUMENT_INTERMEDIATE_MAX_HOPS = 4;

function normalizeCampusDocumentUrl(value) {
  const raw = toText(value);
  if (!raw || /^(javascript|mailto|tel):/i.test(raw)) return "";

  try {
    const url = new URL(raw, location.href);
    url.hash = "";
    return url.href;
  } catch {
    return "";
  }
}

function isCampusDirectDocumentUrl(value) {
  return CAMPUS_DIRECT_DOCUMENT_URL_RE.test(toText(value));
}

function inferCampusDocumentExtension(nameOrUrl) {
  const raw = toText(nameOrUrl);
  if (!raw) return "";

  try {
    const url = new URL(raw, location.href);
    const pathname = decodeURIComponent(url.pathname || "");
    const match = pathname.match(/\.([a-z0-9]{1,12})$/i);
    return match ? match[1].toLowerCase() : "";
  } catch {
    const clean = raw.split(/[?#]/)[0];
    const match = clean.match(/\.([a-z0-9]{1,12})$/i);
    return match ? match[1].toLowerCase() : "";
  }
}

function inferCampusDocumentFileName(item, url) {
  const title = toText(item?.title).replace(/\s+/g, " ").trim();
  try {
    const parsed = new URL(url, location.href);
    const parts = decodeURIComponent(parsed.pathname || "")
      .split("/")
      .map((part) => part.trim())
      .filter(Boolean);
    const lastPart = parts[parts.length - 1] || "";
    if (/\.[a-z0-9]{1,12}$/i.test(lastPart)) return lastPart;
  } catch {}

  const extension = inferCampusDocumentExtension(url);
  const safeTitle = title
    .replace(/[<>:"/\\|?*\u0000-\u001f]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  if (!safeTitle) return extension ? `documento-campus.${extension}` : "documento-campus";
  if (extension && !safeTitle.toLowerCase().endsWith(`.${extension}`)) return `${safeTitle}.${extension}`;
  return safeTitle;
}

function isCampusDocumentMimeType(mimeType) {
  const mime = toText(mimeType).toLowerCase().split(";")[0].trim();
  return mime === "application/pdf"
    || mime === "application/vnd.openxmlformats-officedocument.wordprocessingml.document"
    || mime === "application/msword"
    || mime.startsWith("text/")
    || mime.startsWith("image/");
}

function inferCampusDocumentMimeType(candidate, blob) {
  const blobType = toText(blob?.type).toLowerCase().split(";")[0].trim();
  if (isCampusDocumentMimeType(blobType)) return blobType;
  return CAMPUS_DOCUMENT_MIME_BY_EXTENSION[candidate.extension] || "";
}

function normalizeCampusClassifierExtension(candidate) {
  const extension = toText(candidate?.extension || inferCampusDocumentExtension(candidate?.fileName)).toLowerCase();
  return CAMPUS_DOCUMENT_EXTENSIONS.has(extension) ? extension : "";
}

function looksLikeCampusDocumentCandidate(item) {
  const url = normalizeCampusDocumentUrl(item?.url);
  const title = toText(item?.title);
  const type = toText(item?.type);
  if (!url) return false;

  const extension = inferCampusDocumentExtension(url) || inferCampusDocumentExtension(title);
  const normalizedUrl = url.toLowerCase();
  const text = `${title} ${type} ${normalizedUrl}`;
  const directDocument = CAMPUS_DOCUMENT_EXTENSIONS.has(extension)
    || isCampusDirectDocumentUrl(normalizedUrl);

  return directDocument || CAMPUS_DOCUMENT_KEYWORDS.test(text);
}

function scoreCampusDocumentCandidate(item, sourceKind, index) {
  const url = normalizeCampusDocumentUrl(item?.url);
  const title = toText(item?.title);
  if (!url || !title) return -1;

  const extension = inferCampusDocumentExtension(url) || inferCampusDocumentExtension(title);
  const normalizedUrl = url.toLowerCase();
  const text = `${title} ${toText(item?.type)} ${normalizedUrl}`;
  let score = scoreCampusDateSourceCandidate(item, sourceKind, index);
  if (score < 0) score = 0;

  if (CAMPUS_DOCUMENT_KEYWORDS.test(text)) score += 130;
  if (/\b(bitacora|bitácora|logbook)\b/i.test(text)) score += 60;
  if (CAMPUS_DOCUMENT_EXTENSIONS.has(extension)) score += 90;
  if (isCampusDirectDocumentUrl(normalizedUrl)) score += 90;
  if (/\b(recurso|resource|archivo|file|documento|material)\b/i.test(`${toText(item?.type)} ${title}`)) score += 20;
  if (sourceKind === "materials") score += 18;
  if (sourceKind === "links") score += 10;
  if (sourceKind === "tasks" || sourceKind === "activities") score -= 15;

  return score > 0 ? score - (Number(index) || 0) / 1000 : -1;
}

function collectCampusDocumentAnchors(maxItems = 300) {
  const anchors = Array.from(document.querySelectorAll("a[href]"));
  const items = [];

  for (const anchor of anchors) {
    if (!(anchor instanceof HTMLAnchorElement)) continue;

    const title = normalizeText(
      anchor.innerText
      || anchor.textContent
      || anchor.getAttribute("title")
      || anchor.getAttribute("aria-label")
      || "",
    );
    const container = anchor.closest("li, .activity, [data-region='activity-card'], .activity-item, .modtype_resource, .modtype_url");
    const sectionTitle = normalizeText(
      container?.closest(".section, li.section, [data-sectionid]")?.querySelector("h3, h4, .sectionname")?.textContent
      || "",
    );
    const item = {
      title: title || normalizeText(container?.textContent || "") || anchor.href,
      type: "archivo",
      url: anchor.href || anchor.getAttribute("href") || "",
      sectionTitle,
    };

    if (looksLikeCampusDocumentCandidate(item)) {
      items.push(item);
      if (items.length >= maxItems) break;
    }
  }

  return items;
}

function findCampusDocumentCandidates(analysis, maxItems = CAMPUS_DOCUMENT_MAX_DOWNLOADS) {
  const groups = [
    ["materials", Array.isArray(analysis?.materials) ? analysis.materials : []],
    ["links", Array.isArray(analysis?.links) ? analysis.links : []],
    ["dom", collectCampusDocumentAnchors()],
    ["agenda", Array.isArray(analysis?.agenda) ? analysis.agenda : []],
    ["activities", Array.isArray(analysis?.activities) ? analysis.activities : []],
    ["tasks", Array.isArray(analysis?.tasks) ? analysis.tasks : []],
  ];
  const candidates = [];
  const seen = new Set();
  let index = 0;

  for (const [sourceKind, items] of groups) {
    for (const item of items) {
      const url = normalizeCampusDocumentUrl(item?.url);
      if (!url || seen.has(url.toLowerCase()) || !looksLikeCampusDocumentCandidate(item)) {
        index += 1;
        continue;
      }

      const score = scoreCampusDocumentCandidate(item, sourceKind, index);
      index += 1;
      if (score <= 0) continue;

      const extension = inferCampusDocumentExtension(url) || inferCampusDocumentExtension(item?.title);
      const fileName = inferCampusDocumentFileName(item, url);
      seen.add(url.toLowerCase());
      candidates.push({
        ...item,
        sourceKind,
        url,
        score,
        extension,
        fileName,
        directDocument: CAMPUS_DOCUMENT_EXTENSIONS.has(extension)
          || isCampusDirectDocumentUrl(url),
      });
    }
  }

  candidates.sort((a, b) => b.score - a.score);
  return candidates.slice(0, Math.max(1, Number(maxItems) || CAMPUS_DOCUMENT_MAX_DOWNLOADS));
}

function blobToBase64(blob) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(reader.error || new Error("No se pudo leer el archivo descargado."));
    reader.onload = () => {
      const dataUrl = toText(reader.result);
      const commaIndex = dataUrl.indexOf(",");
      resolve(commaIndex >= 0 ? dataUrl.slice(commaIndex + 1) : dataUrl);
    };
    reader.readAsDataURL(blob);
  });
}

function buildMultipartApiHeaders() {
  return overlayState.sessionId ? { "x-session-id": overlayState.sessionId } : {};
}

async function classifyCampusDocumentCandidate(candidate, context) {
  const baseUrl = normalizeBaseUrl(overlayState.backendUrl);
  if (!baseUrl) {
    throw new Error("Base URL vacia.");
  }

  const blob = await fetchCampusDocumentBlob(candidate);
  const mimeType = inferCampusDocumentMimeType(candidate, blob);
  if (!candidate.directDocument && !isCampusDocumentMimeType(mimeType)) {
    throw new Error(`tipo de archivo no soportado (${mimeType || "desconocido"})`);
  }

  const contentBase64 = await blobToBase64(blob);
  const response = await fetchJsonWithTimeout(`${baseUrl}/api/documents/classify`, {
    method: "POST",
    headers: buildApiHeaders(),
    body: JSON.stringify({
      repoFullName: "",
      filePath: candidate.url.slice(0, 900),
      fileName: candidate.fileName.slice(0, 500),
      mimeType,
      extension: normalizeCampusClassifierExtension(candidate),
      contentBase64,
      useModel: true,
    }),
  }, CAMPUS_DOCUMENT_CLASSIFY_TIMEOUT_MS);

  if (!response?.ok || !response.classification) {
    throw new Error(toText(response?.error) || "Respuesta invalida del clasificador.");
  }

  const classification = response.classification;
  return {
    id: `campus-${Date.now()}-${Math.round(Math.random() * 1000000)}`,
    repoFullName: "",
    requestId: "",
    snapshotId: "",
    filePath: candidate.url,
    fileName: candidate.fileName,
    label: toText(classification.label).toUpperCase() === "BITACORA" ? "BITACORA" : "OTRO",
    confidence: Math.max(0, Math.min(1, Number(classification.confidence) || 0)),
    method: toText(classification.method || "hybrid"),
    evidence: Array.isArray(classification.evidence)
      ? classification.evidence.map(toText).filter(Boolean).slice(0, 8)
      : [],
    reason: toText(classification.reason),
    bitacoraAgenda: response.bitacoraAgenda || { items: [], summary: "", warnings: [] },
    modelUsed: response.modelUsed === true,
    modelError: toText(response.modelError),
    classifiedAt: new Date().toISOString(),
  };
}

async function downloadAndClassifyCampusDocuments(analysis, context) {
  const candidates = findCampusDocumentCandidates(analysis);
  if (!candidates.length) {
    overlayState.documentClassifications = {
      ...EMPTY_DOCUMENT_CLASSIFICATION_STATE,
      message: "No se detectaron documentos descargables para clasificar en esta pagina.",
    };
    return [];
  }

  overlayState.documentClassifications = {
    ...normalizeDocumentClassificationState(overlayState.documentClassifications),
    items: [],
    busy: true,
    message: `Descargando ${candidates.length} documento(s) candidato(s) de Campus...`,
    error: "",
  };
  renderOverlay();

  const items = [];
  const errors = [];

  for (const candidate of candidates) {
    overlayState.documentClassifications = {
      ...normalizeDocumentClassificationState(overlayState.documentClassifications),
      items,
      busy: true,
      message: `Clasificando ${items.length + 1}/${candidates.length}: ${candidate.fileName}`,
      error: errors.join(" | "),
    };
    renderOverlay();

    try {
      const item = await classifyCampusDocumentCandidate(candidate, context);
      items.push(item);
    } catch (error) {
      errors.push(`${candidate.fileName}: ${String(error?.message || error)}`);
    }
  }

  const bitacoraCount = items.filter((item) => item.label === "BITACORA").length;
  const bitacoraAgendaCount = items
    .flatMap((item) => Array.isArray(item.bitacoraAgenda?.items) ? item.bitacoraAgenda.items : [])
    .length;
  overlayState.documentClassifications = {
    items: normalizeDocumentClassificationsPayload(items),
    busy: false,
    message: items.length > 0
      ? `Clasificacion documental lista: ${items.length} archivo(s), ${bitacoraCount} bitacora(s), ${bitacoraAgendaCount} item(s) de agenda.`
      : "No se pudo clasificar ningun documento descargado de Campus.",
    error: errors.join(" | "),
  };

  return items;
}

// ADACEEN | Capa 3 - Servicios: deteccion, descarga y clasificacion de documentos enlazados en Campus Virtual.
// Orden de carga: manifest.json (content_scripts) y background.js (CONTENT_SCRIPT_FILES) deben coincidir.
"use strict";

// NOTA: hoy ningun archivo del paquete llama a downloadAndClassifyCampusDocuments().
// analyzeCampusPage() limita el analisis al HTML visible y no descarga archivos, asi que
// este modulo esta completo pero desconectado. Se conserva a proposito; si se decide que
// la descarga no vuelve, el archivo se puede borrar entero (y quitarlo de manifest.json
// y background.js).

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

function decodeCampusUrlText(value) {
  return toText(value)
    .replace(/&amp;/g, "&")
    .replace(/&#38;/g, "&")
    .replace(/\\u0026/g, "&")
    .replace(/\\\//g, "/")
    .trim();
}

function resolveCampusUrl(value, baseUrl) {
  const raw = decodeCampusUrlText(value);
  if (!raw || /^(javascript|mailto|tel|data):/i.test(raw)) return "";
  const downloadUrl = raw.match(/^[^:]+:[^:]+:(https?:.+)$/i);
  const target = downloadUrl?.[1] || raw;

  try {
    const url = new URL(target, baseUrl || location.href);
    url.hash = "";
    return url.href;
  } catch {
    return "";
  }
}

function extractCampusContentDispositionFileName(value) {
  const header = toText(value);
  if (!header) return "";

  const encoded = header.match(/filename\*\s*=\s*(?:UTF-8''|utf-8'')?([^;]+)/i);
  const regular = header.match(/filename\s*=\s*"?([^";]+)"?/i);
  const raw = decodeCampusUrlText(encoded?.[1] || regular?.[1] || "").replace(/^["']|["']$/g, "");
  if (!raw) return "";

  try {
    return decodeURIComponent(raw);
  } catch {
    return raw;
  }
}

function scoreCampusIntermediateDocumentUrl(url, sourceText = "") {
  const normalizedUrl = toText(url).toLowerCase();
  const source = toText(sourceText).toLowerCase();
  if (!normalizedUrl || isCampusCalendarImportExportCandidate({ title: source, url: normalizedUrl })) return -1;

  let score = 0;
  if (/pluginfile\.php|\/draftfile\.php|\/webservice\/pluginfile\.php/i.test(normalizedUrl)) score += 800;
  if (/\.pdf(?:$|[?#])/i.test(normalizedUrl)) score += 760;
  if (/\.(?:docx?|txt|md|markdown|png|jpe?g|webp|gif|bmp|tiff?)(?:$|[?#])/i.test(normalizedUrl)) score += 620;
  if (/[?&]forcedownload=1\b/i.test(normalizedUrl)) score += 40;
  if (/\/mod\/resource\/view\.php/i.test(normalizedUrl) && /[?&]redirect=1\b/i.test(normalizedUrl)) score += 220;
  if (/\/mod\/url\/view\.php/i.test(normalizedUrl) && /[?&]redirect=1\b/i.test(normalizedUrl)) score += 160;
  if (CAMPUS_DOCUMENT_KEYWORDS.test(`${source} ${normalizedUrl}`)) score += 120;
  return score > 0 ? score : -1;
}

function addCampusDocumentUrlCandidate(candidates, seen, value, baseUrl, sourceText = "") {
  const url = resolveCampusUrl(value, baseUrl);
  if (!url) return;
  const key = normalizeCampusComparableUrl(url);
  if (!key || seen.has(key)) return;

  const score = scoreCampusIntermediateDocumentUrl(url, sourceText);
  if (score <= 0) return;

  seen.add(key);
  candidates.push({ url, score });
}

function addCampusUrlsFromScript(candidates, seen, scriptText, baseUrl, sourceText = "") {
  const text = toText(scriptText);
  if (!text) return;

  const quotedUrls = [
    ...text.matchAll(/(?:location(?:\.href)?|window\.location(?:\.href)?|document\.location|assign|replace|open)\s*(?:=|\()\s*["']([^"']+)["']/gi),
    ...text.matchAll(/["']([^"']*(?:pluginfile\.php|draftfile\.php|webservice\/pluginfile\.php|\.(?:pdf|docx?|txt|md|markdown)(?:[?#][^"']*)?)[^"']*)["']/gi),
  ];
  for (const match of quotedUrls) {
    addCampusDocumentUrlCandidate(candidates, seen, match[1], baseUrl, sourceText || text);
  }
}

function buildCampusIntermediateRedirectUrl(baseUrl) {
  try {
    const url = new URL(baseUrl || location.href);
    if (!/\/mod\/(?:resource|url)\/view\.php/i.test(url.pathname)) return "";
    if (url.searchParams.get("redirect") === "1") return "";
    url.searchParams.set("redirect", "1");
    url.hash = "";
    return url.href;
  } catch {
    return "";
  }
}

function applyCampusResolvedDocumentUrl(candidate, url) {
  const resolvedUrl = toText(url);
  if (!resolvedUrl) return;

  candidate.url = resolvedUrl;
  candidate.extension = inferCampusDocumentExtension(resolvedUrl) || candidate.extension;
  candidate.fileName = inferCampusDocumentFileName(candidate, resolvedUrl);
  candidate.directDocument = isCampusDirectDocumentUrl(resolvedUrl)
    || CAMPUS_DOCUMENT_EXTENSIONS.has(candidate.extension);
}

async function isCampusHtmlBlob(blob, responseMime) {
  if (responseMime.includes("text/html")) return true;
  if (
    responseMime
    && !responseMime.includes("text/plain")
    && !responseMime.includes("application/octet-stream")
  ) {
    return false;
  }

  const head = await blob.slice(0, 700).text().catch(() => "");
  return /<!doctype\s+html|<html\b|<head\b|<body\b|<meta\b/i.test(head);
}

async function fetchCampusDocumentBlob(candidate, hop = 0, visited = new Set()) {
  if (hop > CAMPUS_DOCUMENT_INTERMEDIATE_MAX_HOPS) {
    throw new Error("Moodle encadeno demasiadas paginas intermedias antes del archivo");
  }

  const currentUrlKey = normalizeCampusComparableUrl(candidate.url);
  if (currentUrlKey && visited.has(currentUrlKey)) {
    throw new Error("Moodle devolvio una pagina intermedia repetida sin llegar al archivo");
  }
  if (currentUrlKey) visited.add(currentUrlKey);

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), CAMPUS_DOCUMENT_DOWNLOAD_TIMEOUT_MS);

  try {
    const response = await fetch(candidate.url, {
      credentials: "include",
      redirect: "follow",
      signal: controller.signal,
    });

    if (!response.ok) {
      throw new Error(`HTTP ${response.status}`);
    }

    const contentLength = Number(response.headers.get("content-length")) || 0;
    if (contentLength > CAMPUS_DOCUMENT_MAX_BYTES) {
      throw new Error(`archivo mayor a ${Math.round(CAMPUS_DOCUMENT_MAX_BYTES / (1024 * 1024))} MB`);
    }

    const headerFileName = extractCampusContentDispositionFileName(response.headers.get("content-disposition"));
    if (headerFileName) {
      candidate.fileName = headerFileName;
      candidate.extension = inferCampusDocumentExtension(headerFileName) || candidate.extension;
    }

    const blob = await response.blob();
    if (blob.size > CAMPUS_DOCUMENT_MAX_BYTES) {
      throw new Error(`archivo mayor a ${Math.round(CAMPUS_DOCUMENT_MAX_BYTES / (1024 * 1024))} MB`);
    }
    if (!blob.size) {
      throw new Error("archivo vacio");
    }
    const responseMime = toText(blob.type || response.headers.get("content-type")).toLowerCase();
    const finalUrl = response.url || candidate.url;
    if (await isCampusHtmlBlob(blob, responseMime)) {
      const html = await blob.text();
      const resolvedUrl = extractCampusDocumentUrlFromHtml(html, finalUrl)
        || buildCampusIntermediateRedirectUrl(finalUrl);
      const resolvedKey = normalizeCampusComparableUrl(resolvedUrl);
      if (resolvedUrl && resolvedKey && !visited.has(resolvedKey)) {
        applyCampusResolvedDocumentUrl(candidate, resolvedUrl);
        return await fetchCampusDocumentBlob(candidate, hop + 1, visited);
      }
      throw new Error("Moodle devolvio una pagina intermedia sin enlace directo al archivo");
    }

    applyCampusResolvedDocumentUrl(candidate, finalUrl);
    return blob;
  } catch (error) {
    if (error && typeof error === "object" && error.name === "AbortError") {
      throw new Error("descarga agoto el tiempo de espera");
    }
    throw error;
  } finally {
    clearTimeout(timeout);
  }
}

function extractCampusDocumentUrlFromHtml(html, baseUrl) {
  const text = toText(html);
  if (!text) return "";

  const candidates = [];
  const seen = new Set();

  try {
    const doc = new DOMParser().parseFromString(text, "text/html");

    for (const meta of Array.from(doc.querySelectorAll("meta[http-equiv]"))) {
      const equiv = toText(meta.getAttribute("http-equiv")).toLowerCase();
      if (equiv !== "refresh") continue;
      const content = toText(meta.getAttribute("content"));
      const match = content.match(/url\s*=\s*([^;]+)/i);
      if (match) addCampusDocumentUrlCandidate(candidates, seen, match[1], baseUrl, content);
    }

    const nodes = Array.from(doc.querySelectorAll("a[href], iframe[src], embed[src], object[data], source[src], link[href], form[action]"));
    for (const node of nodes) {
      const value = node.getAttribute("href")
        || node.getAttribute("src")
        || node.getAttribute("data")
        || node.getAttribute("action")
        || "";
      const sourceText = `${node.textContent || ""} ${node.getAttribute("title") || ""} ${node.getAttribute("aria-label") || ""}`;
      addCampusDocumentUrlCandidate(candidates, seen, value, baseUrl, sourceText);
    }

    for (const param of Array.from(doc.querySelectorAll("param[value]"))) {
      const name = toText(param.getAttribute("name")).toLowerCase();
      if (name && !/\b(src|url|file|href|movie|data)\b/.test(name)) continue;
      addCampusDocumentUrlCandidate(candidates, seen, param.getAttribute("value"), baseUrl, name);
    }

    for (const node of Array.from(doc.querySelectorAll("[onclick]"))) {
      addCampusUrlsFromScript(candidates, seen, node.getAttribute("onclick"), baseUrl, node.textContent || "");
    }

    for (const node of Array.from(doc.querySelectorAll("[data-href], [data-url], [data-src], [data-file], [data-downloadurl]"))) {
      for (const attr of ["data-href", "data-url", "data-src", "data-file", "data-downloadurl"]) {
        addCampusDocumentUrlCandidate(candidates, seen, node.getAttribute(attr), baseUrl, node.textContent || "");
      }
    }

    for (const script of Array.from(doc.querySelectorAll("script"))) {
      addCampusUrlsFromScript(candidates, seen, script.textContent || "", baseUrl, "script");
    }
  } catch {}

  for (const match of text.matchAll(/(?:href|src|data|action)=["']([^"']*(?:pluginfile\.php|draftfile\.php|webservice\/pluginfile\.php|\.(?:pdf|docx?|txt|md|markdown)(?:[?#][^"']*)?)[^"']*)["']/gi)) {
    addCampusDocumentUrlCandidate(candidates, seen, match[1], baseUrl, "html attribute");
  }

  for (const match of text.matchAll(/https?:\/\/[^\s"'<>]+(?:pluginfile\.php|draftfile\.php|webservice\/pluginfile\.php|\.(?:pdf|docx?|txt|md|markdown)(?:[?#][^\s"'<>]*)?)[^\s"'<>]*/gi)) {
    addCampusDocumentUrlCandidate(candidates, seen, match[0], baseUrl, "html url");
  }

  addCampusUrlsFromScript(candidates, seen, text, baseUrl, "html script");

  const redirectUrl = buildCampusIntermediateRedirectUrl(baseUrl);
  if (redirectUrl) addCampusDocumentUrlCandidate(candidates, seen, redirectUrl, baseUrl, "moodle redirect");

  candidates.sort((a, b) => b.score - a.score);
  return candidates[0]?.url || "";
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

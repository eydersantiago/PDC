"use strict";

const CAMPUS_DOCUMENT_MAX_DOWNLOADS = 6;
const CAMPUS_DOCUMENT_MAX_BYTES = 8 * 1024 * 1024;
const CAMPUS_DOCUMENT_DOWNLOAD_TIMEOUT_MS = 45000;
const CAMPUS_DOCUMENT_CLASSIFY_TIMEOUT_MS = 90000;
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
const CAMPUS_MONTHS = {
  ene: 0,
  enero: 0,
  feb: 1,
  febrero: 1,
  mar: 2,
  marzo: 2,
  abr: 3,
  abril: 3,
  may: 4,
  mayo: 4,
  jun: 5,
  junio: 5,
  jul: 6,
  julio: 6,
  ago: 7,
  agosto: 7,
  sep: 8,
  sept: 8,
  septiembre: 8,
  oct: 9,
  octubre: 9,
  nov: 10,
  noviembre: 10,
  dic: 11,
  diciembre: 11,
};

function listCalendarItems(items, prefix, maxItems = 8) {
  return (Array.isArray(items) ? items : [])
    .map((item) => toText(item?.title || item))
    .filter(Boolean)
    .slice(0, maxItems)
    .map((title) => `${prefix}: ${title}`);
}

function buildCampusCalendarDraftUrl(context, analysis = overlayState.campusAnalysis) {
  const courseTitle = toText(analysis?.course?.title) || toText(context?.activityTitle) || "Actividad Campus Virtual";
  const deadline = toText(context?.activityDeadline);
  const recommendations = listCalendarItems(analysis?.recommendations, "Recomendacion", 4);
  const tasks = listCalendarItems(analysis?.tasks, "Tarea detectada", 8);
  const materials = listCalendarItems(analysis?.materials, "Material", 6);
  const details = [
    "Actividad detectada por ADACEEN.",
    toText(analysis?.summary),
    deadline ? `Fecha visible: ${deadline}` : "",
    ...recommendations,
    ...tasks,
    ...materials,
    toText(context?.url) ? `Pagina: ${context.url}` : "",
  ].filter(Boolean).join("\n");

  const params = new URLSearchParams({
    action: "TEMPLATE",
    text: `ADACEEN Campus: ${courseTitle}`,
    details,
  });

  return `https://calendar.google.com/calendar/render?${params.toString()}`;
}

function buildCampusAnalyzePayload(context) {
  const source = context || buildPayload();
  return {
    courseId: Number(source.courseId) || null,
    source: "browser_dom",
    url: toText(source.url),
    title: toText(source.title),
    visibleText: toText(source.text).slice(0, 140000),
    selection: toText(source.selection).slice(0, 8000),
    links: Array.isArray(source.links)
      ? source.links
        .map((link) => ({
          text: toText(link?.text).slice(0, 300),
          href: toText(link?.href).slice(0, 1200),
        }))
        .filter((link) => link.href)
        .slice(0, 300)
      : [],
    activities: Array.isArray(source.campusActivities)
      ? source.campusActivities
        .map((activity) => ({
          title: toText(activity?.title).slice(0, 500),
          type: toText(activity?.type).slice(0, 80),
          url: toText(activity?.url).slice(0, 1200),
          description: toText(activity?.description).slice(0, 12000),
          sectionTitle: toText(activity?.sectionTitle).slice(0, 300),
          visibleDueText: toText(activity?.visibleDueText).slice(0, 500),
        }))
        .filter((activity) => activity.title || activity.url)
        .slice(0, 300)
      : [],
  };
}

function normalizeCampusAnalysisForState(raw) {
  const source = raw?.analysis || raw || {};
  const stats = source.stats || {};

  return {
    course: {
      id: Number(source.course?.id) || null,
      title: toText(source.course?.title),
      url: toText(source.course?.url),
    },
    source: toText(source.source) || "browser_dom",
    summary: toText(source.summary),
    recommendations: Array.isArray(source.recommendations)
      ? source.recommendations.map(toText).filter(Boolean).slice(0, 12)
      : [],
    agenda: Array.isArray(source.agenda)
      ? source.agenda.map((item) => ({
        title: toText(item?.title),
        type: toText(item?.type),
        url: toText(item?.url),
        dueAt: toText(item?.dueAt),
        visibleDueText: toText(item?.visibleDueText),
      })).filter((item) => item.title || item.url).slice(0, 120)
      : [],
    tasks: Array.isArray(source.tasks)
      ? source.tasks.map((item) => ({
        title: toText(item?.title),
        type: toText(item?.type),
        url: toText(item?.url),
        sectionTitle: toText(item?.sectionTitle),
        visibleDueText: toText(item?.visibleDueText),
        dueAt: toText(item?.dueAt),
      })).filter((item) => item.title || item.url).slice(0, 120)
      : [],
    materials: Array.isArray(source.materials)
      ? source.materials.map((item) => ({
        title: toText(item?.title),
        type: toText(item?.type),
        url: toText(item?.url),
        sectionTitle: toText(item?.sectionTitle),
      })).filter((item) => item.title || item.url).slice(0, 120)
      : [],
    activities: Array.isArray(source.activities)
      ? source.activities.map((item) => ({
        title: toText(item?.title),
        type: toText(item?.type),
        url: toText(item?.url),
        sectionTitle: toText(item?.sectionTitle),
        visibleDueText: toText(item?.visibleDueText),
        dueAt: toText(item?.dueAt),
      })).filter((item) => item.title || item.url).slice(0, 160)
      : [],
    links: Array.isArray(source.links)
      ? source.links.map((item) => ({
        title: toText(item?.title),
        type: toText(item?.type),
        url: toText(item?.url),
      })).filter((item) => item.title || item.url).slice(0, 160)
      : [],
    stats: {
      activityCount: Number(stats.activityCount) || 0,
      taskCount: Number(stats.taskCount) || 0,
      materialCount: Number(stats.materialCount) || 0,
      linkCount: Number(stats.linkCount) || 0,
      deadlineCount: Number(stats.deadlineCount) || 0,
    },
    analyzedAt: new Date().toISOString(),
  };
}

function coerceCalendarDate(value) {
  const date = new Date(toText(value));
  return Number.isNaN(date.getTime()) ? null : date;
}

function addCalendarMinutes(date, minutes) {
  return new Date(date.getTime() + (Number(minutes) || 0) * 60 * 1000);
}

function buildCalendarDescription(lines) {
  return lines
    .map((line) => toText(line))
    .filter(Boolean)
    .join("\n");
}

function buildCalendarDateTime(date) {
  return {
    dateTime: date.toISOString(),
    timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone || "America/Bogota",
  };
}

function looksLikeCampusDateSourceTitle(title) {
  return /\b(bitacora|bitácora|agenda|cronograma|fechas?|programacion|programación|evaluacion|evaluación|sesiones?)\b/i
    .test(toText(title));
}

function isCampusCalendarImportExportCandidate(item) {
  const text = `${toText(item?.title)} ${toText(item?.url)}`.toLowerCase();
  return /\/calendar\//i.test(text)
    || /\bir\s+al\s+calendario\b/i.test(text)
    || /\b(importar|exportar)\s+calendarios?\b/i.test(text)
    || /\bcalendar\s+(?:export|import)\b/i.test(text);
}

function scoreCampusDateSourceCandidate(item, sourceKind, index) {
  const title = toText(item?.title);
  const url = toText(item?.url);
  if (!title || !url) return -1;
  if (isCampusCalendarImportExportCandidate(item)) return -1;

  const titleText = title.toLowerCase();
  const urlText = url.toLowerCase();
  let score = 0;

  if (/\b(bitacora|bitácora)\b/i.test(titleText)) score += 120;
  if (/\b(cronograma|fechas?|programacion|programación)\b/i.test(titleText)) score += 90;
  if (/\b(agenda|sesiones?)\b/i.test(titleText)) score += 65;
  if (/\b(evaluacion|evaluación)\b/i.test(titleText)) score += 45;
  if (/\b(bitacora|bitácora|cronograma|fechas?|programacion|programación|agenda|sesiones?|evaluacion|evaluación)\b/i.test(urlText)) {
    score += 70;
  }
  if (score <= 0) return -1;
  if (/pluginfile\.php|\.pdf(?:$|[?#])/i.test(urlText)) score += 55;
  if (/\b(recurso|resource|archivo|file)\b/i.test(`${toText(item?.type)} ${titleText}`)) score += 20;
  if (sourceKind === "materials") score += 12;
  if (sourceKind === "links") score += 6;

  return score > 0 ? score - (Number(index) || 0) / 1000 : -1;
}

function findCampusDateSourceResource(analysis) {
  const groups = [
    ["materials", Array.isArray(analysis?.materials) ? analysis.materials : []],
    ["links", Array.isArray(analysis?.links) ? analysis.links : []],
    ["activities", Array.isArray(analysis?.activities) ? analysis.activities : []],
  ];
  let best = null;
  let bestScore = -1;
  let index = 0;

  for (const [sourceKind, items] of groups) {
    for (const item of items) {
      const score = scoreCampusDateSourceCandidate(item, sourceKind, index);
      index += 1;
      if (score > bestScore) {
        best = item;
        bestScore = score;
      }
    }
  }

  return bestScore > 0 ? best : null;
}

function normalizeCampusComparableUrl(value) {
  try {
    const url = new URL(toText(value), location.href);
    url.hash = "";
    return url.href.replace(/\/+$/g, "").toLowerCase();
  } catch {
    return toText(value).split("#")[0].replace(/\/+$/g, "").toLowerCase();
  }
}

function findCampusDateSourceAnchor(resource) {
  if (isCampusCalendarImportExportCandidate(resource)) return null;

  const targetUrl = normalizeCampusComparableUrl(resource?.url);
  const targetTitle = normalizeText(resource?.title || "").toLowerCase();
  const anchors = Array.from(document.querySelectorAll("a[href]"));

  const scored = anchors.map((anchor, index) => {
    const rawHref = anchor.href || anchor.getAttribute("href");
    const href = normalizeCampusComparableUrl(anchor.href || anchor.getAttribute("href"));
    const text = normalizeText(
      anchor.innerText
      || anchor.textContent
      || anchor.getAttribute("title")
      || anchor.getAttribute("aria-label")
      || "",
    ).toLowerCase();
    const containerText = normalizeText(
      anchor.closest("li, .activity, [data-region='activity-card'], .activity-item, .modtype_resource, .modtype_url")?.textContent
      || "",
    ).toLowerCase();
    const combinedText = `${text} ${containerText}`.trim();
    if (isCampusCalendarImportExportCandidate({ title: combinedText, url: rawHref })) {
      return { anchor, score: -1 };
    }

    const exactUrl = !!targetUrl && href === targetUrl;
    const titleMatches = !!(targetTitle && combinedText) && (
      combinedText === targetTitle
      || combinedText.includes(targetTitle)
      || (targetTitle.includes(text) && text.length > 6)
    );
    let score = 0;

    if (exactUrl) score += 520;
    if (looksLikeCampusDateSourceTitle(combinedText)) score += 140;
    if (/pluginfile\.php|\.pdf(?:$|[?#])/i.test(href) && (exactUrl || titleMatches || looksLikeCampusDateSourceTitle(combinedText))) {
      score += 90;
    }
    if (targetTitle && combinedText) {
      if (combinedText === targetTitle) score += 240;
      else if (combinedText.includes(targetTitle)) score += 210;
      else if (targetTitle.includes(text) && text.length > 6) score += 80;
    }

    return { anchor, score: score - index / 1000 };
  }).filter((entry) => entry.score > 0);

  scored.sort((a, b) => b.score - a.score);
  return scored[0]?.anchor || null;
}

function openCampusDateSourceWithLeftClick(resource) {
  const anchor = findCampusDateSourceAnchor(resource);
  const url = toText(resource?.url);

  if (anchor) {
    anchor.scrollIntoView({ block: "center", inline: "center" });
    anchor.focus?.({ preventScroll: true });
    for (const type of ["pointerdown", "mousedown", "pointerup", "mouseup"]) {
      const isDown = type.endsWith("down");
      const EventCtor = type.startsWith("pointer") && typeof PointerEvent === "function"
        ? PointerEvent
        : MouseEvent;
      anchor.dispatchEvent(new EventCtor(type, {
        bubbles: true,
        cancelable: true,
        view: window,
        button: 0,
        buttons: isDown ? 1 : 0,
        pointerType: "mouse",
        isPrimary: true,
        ctrlKey: false,
        metaKey: false,
        shiftKey: false,
        altKey: false,
      }));
    }
    anchor.click();
    return true;
  }

  if (url) {
    window.location.assign(url);
    return true;
  }

  return false;
}

function openCampusDateSourceFromAnalysisWithLeftClick(analysis, options = {}) {
  const stats = analysis?.stats || {};
  const shouldOpen = options?.force === true
    || (Number(stats.taskCount) > 0 && Number(stats.deadlineCount) === 0);
  if (!shouldOpen) return null;

  const dateSource = findCampusDateSourceResource(analysis);
  if (!dateSource?.url) return null;

  if (!options?.force) {
    const currentUrl = normalizeCampusComparableUrl(options?.currentUrl || location.href);
    const targetUrl = normalizeCampusComparableUrl(dateSource.url);
    if (currentUrl && targetUrl && currentUrl === targetUrl) {
      return { dateSource, opened: false, skipped: true };
    }
  }

  return {
    dateSource,
    opened: openCampusDateSourceWithLeftClick(dateSource),
    skipped: false,
  };
}

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
    || /pluginfile\.php|\/draftfile\.php|\/webservice\/pluginfile\.php/i.test(normalizedUrl);

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
  if (/pluginfile\.php|\/draftfile\.php|\/webservice\/pluginfile\.php/i.test(normalizedUrl)) score += 90;
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
          || /pluginfile\.php|\/draftfile\.php|\/webservice\/pluginfile\.php/i.test(url),
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

async function fetchCampusDocumentBlob(candidate) {
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

    const blob = await response.blob();
    if (blob.size > CAMPUS_DOCUMENT_MAX_BYTES) {
      throw new Error(`archivo mayor a ${Math.round(CAMPUS_DOCUMENT_MAX_BYTES / (1024 * 1024))} MB`);
    }
    if (!blob.size) {
      throw new Error("archivo vacio");
    }
    const responseMime = toText(blob.type || response.headers.get("content-type")).toLowerCase();
    const finalUrl = response.url || candidate.url;
    if (
      responseMime.includes("text/html")
      && !/pluginfile\.php|\/draftfile\.php|\/webservice\/pluginfile\.php|\.pdf(?:$|[?#])/i.test(finalUrl)
    ) {
      const html = await blob.text();
      const resolvedUrl = extractCampusDocumentUrlFromHtml(html, finalUrl);
      if (resolvedUrl && resolvedUrl !== candidate.url) {
        candidate.url = resolvedUrl;
        candidate.extension = inferCampusDocumentExtension(resolvedUrl) || candidate.extension;
        candidate.fileName = inferCampusDocumentFileName(candidate, resolvedUrl);
        candidate.directDocument = true;
        return await fetchCampusDocumentBlob(candidate);
      }
      throw new Error("Moodle devolvio una pagina intermedia sin enlace directo al archivo");
    }

    return blob;
  } catch (error) {
    if (error && typeof error === "object" && error.name === "AbortError") {
      throw new Error("descarga agotó el tiempo de espera");
    }
    throw error;
  } finally {
    clearTimeout(timeout);
  }
}

function extractCampusDocumentUrlFromHtml(html, baseUrl) {
  const text = toText(html);
  if (!text) return "";

  try {
    const doc = new DOMParser().parseFromString(text, "text/html");
    const anchors = Array.from(doc.querySelectorAll("a[href], iframe[src], embed[src], object[data]"));
    const urls = anchors
      .map((node) => node.getAttribute("href") || node.getAttribute("src") || node.getAttribute("data") || "")
      .map((value) => {
        try {
          const url = new URL(value, baseUrl || location.href);
          url.hash = "";
          return url.href;
        } catch {
          return "";
        }
      })
      .filter(Boolean);
    const direct = urls.find((url) => /pluginfile\.php|\/draftfile\.php|\/webservice\/pluginfile\.php|\.pdf(?:$|[?#])/i.test(url));
    if (direct) return direct;
  } catch {}

  const match = text.match(/(?:href|src|data)=["']([^"']*(?:pluginfile\.php|draftfile\.php|webservice\/pluginfile\.php|\.pdf(?:[?#][^"']*)?)[^"']*)["']/i);
  if (!match) return "";
  try {
    const url = new URL(match[1].replace(/&amp;/g, "&"), baseUrl || location.href);
    url.hash = "";
    return url.href;
  } catch {
    return "";
  }
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
  overlayState.documentClassifications = {
    items: normalizeDocumentClassificationsPayload(items),
    busy: false,
    message: items.length > 0
      ? `Clasificacion documental lista: ${items.length} archivo(s), ${bitacoraCount} bitacora(s).`
      : "No se pudo clasificar ningun documento descargado de Campus.",
    error: errors.join(" | "),
  };

  return items;
}

function buildProfessorDueEvent(item, context) {
  const dueDate = coerceCalendarDate(item?.dueAt)
    || parseCampusDueDateFromText(item?.visibleDueText)
    || parseCampusDueDateFromText(item?.title);
  if (!dueDate) return null;

  const title = toText(item?.title) || "Actividad Campus Virtual";
  const start = dueDate;
  const end = addCalendarMinutes(start, 30);
  const url = toText(item?.url) || toText(context?.url);

  return {
    summary: `ADACEEN entrega: ${title}`,
    description: buildCalendarDescription([
      "Evento creado por ADACEEN desde una fecha visible de Campus Virtual.",
      "Tipo: tarea programada por el profesor / Campus.",
      toText(item?.visibleDueText) ? `Fecha visible: ${item.visibleDueText}` : "",
      url ? `Pagina: ${url}` : "",
    ]),
    location: url,
    start: buildCalendarDateTime(start),
    end: buildCalendarDateTime(end),
    reminders: {
      useDefault: false,
      overrides: [
        { method: "popup", minutes: 24 * 60 },
        { method: "popup", minutes: 60 },
      ],
    },
    extendedProperties: {
      private: {
        adaceen: "campus",
        adaceenType: "professor_due",
      },
    },
  };
}

function buildCampusCalendarEvents(analysis, context) {
  const events = [];
  const agendaItems = [
    ...(Array.isArray(analysis?.agenda) ? analysis.agenda : []),
    ...(Array.isArray(analysis?.tasks) ? analysis.tasks : []),
    ...(Array.isArray(analysis?.activities) ? analysis.activities : []),
  ];
  const seen = new Set();
  const addEvent = (item) => {
    const event = buildProfessorDueEvent(item, context);
    if (!event) return;
    const titleKey = normalizeCampusCalendarTitle(event.summary);
    const key = `${titleKey}|${event.start?.dateTime || ""}`;
    if (seen.has(key)) return;
    seen.add(key);
    events.push(event);
  };

  for (const item of agendaItems.slice(0, 20)) {
    addEvent(item);
  }

  const inferredItems = inferCampusCalendarItemsFromOrderedLinks(analysis);
  for (const item of inferredItems.slice(0, 20)) {
    addEvent(item);
  }

  return events;
}

function inferCampusCalendarLinkType(link) {
  const text = normalizeCampusDateText(`${toText(link?.text || link?.title)} ${toText(link?.href || link?.url)}`);
  if (/\b(examen|quiz|cuestionario|parcial|prueba)\b/.test(text) || /\/mod\/quiz\//.test(text)) return "quiz";
  if (/\b(entrega|tarea|asignacion|asignación|assignment|proyecto)\b/.test(text) || /\/mod\/assign\//.test(text)) return "assign";
  return toText(link?.type) || "unknown";
}

function buildCampusCalendarFallbackAnalysis(context) {
  const links = Array.isArray(context?.links) ? context.links : [];
  return {
    links: links.map((link) => ({
      title: toText(link?.text || link?.title),
      type: inferCampusCalendarLinkType(link),
      url: toText(link?.href || link?.url),
    })).filter((link) => link.title || link.url),
    agenda: [],
    tasks: [],
    activities: [],
  };
}

function normalizeCampusCalendarTitle(value) {
  return normalizeCampusDateText(value)
    .replace(/^adaceen entrega:\s*/i, "")
    .replace(/\b(asignacion|asignación|cuestionario|carpeta|archivo|url)\b/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

function looksLikeCampusDateRange(value) {
  const text = normalizeCampusDateText(value);
  return /\b\d{1,2}\s*(?:de\s*)?(?:[a-z]{3,10})?\s*(?:-|–|a|hasta)\s*\d{1,2}\s*(?:de\s*)?[a-z]{3,10}\b/.test(text)
    || /\b\d{1,2}[/-]\d{1,2}\s*(?:-|–|a|hasta)\s*\d{1,2}[/-]\d{1,2}/.test(text);
}

function isCampusSchedulableCalendarItem(item) {
  const type = toText(item?.type);
  const title = normalizeCampusDateText(item?.title);
  if (type === "assign" || type === "quiz") return true;
  return /\b(entrega|examen|quiz|cuestionario|parcial|proyecto|asignacion|asignación|tarea)\b/i.test(title);
}

function inferCampusCalendarItemsFromOrderedLinks(analysis) {
  const links = Array.isArray(analysis?.links) ? analysis.links : [];
  const output = [];
  let currentDueText = "";
  let currentDueDate = null;

  for (const link of links) {
    const title = toText(link?.title);
    const parsedDate = parseCampusDueDateFromText(title);
    if (parsedDate && looksLikeCampusDateRange(title)) {
      currentDueText = title;
      currentDueDate = parsedDate;
      continue;
    }

    if (!currentDueDate || !isCampusSchedulableCalendarItem(link)) continue;
    output.push({
      title,
      type: toText(link?.type) || "assign",
      url: toText(link?.url),
      dueAt: currentDueDate.toISOString(),
      visibleDueText: currentDueText,
      sectionTitle: currentDueText,
    });
  }

  return output;
}

function normalizeCampusDateText(value) {
  return toText(value)
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/\s+/g, " ");
}

function campusDateFromParts(day, monthIndex, year, hour = 9, minute = 0) {
  const normalizedYear = year && year < 100 ? year + 2000 : (year || new Date().getFullYear());
  if (monthIndex < 0 || monthIndex > 11 || day < 1 || day > 31) return null;
  const iso = `${String(normalizedYear).padStart(4, "0")}-${String(monthIndex + 1).padStart(2, "0")}-${String(day).padStart(2, "0")}T${String(hour).padStart(2, "0")}:${String(minute).padStart(2, "0")}:00-05:00`;
  return coerceCalendarDate(iso);
}

function parseCampusClock(text) {
  const match = normalizeCampusDateText(text).match(/\b(\d{1,2})[:h](\d{2})\b/);
  if (!match) return { hour: 9, minute: 0 };
  const hour = Number(match[1]);
  const minute = Number(match[2]);
  if (hour < 0 || hour > 23 || minute < 0 || minute > 59) return { hour: 9, minute: 0 };
  return { hour, minute };
}

function parseCampusDueDateFromText(value) {
  const text = normalizeCampusDateText(value);
  if (!text) return null;

  const clock = parseCampusClock(text);
  const range = text.match(
    /\b(\d{1,2})\s*(?:de\s*)?([a-z]{3,10})?\s*(?:-|–|a|hasta)\s*(\d{1,2})\s*(?:de\s*)?([a-z]{3,10})(?:\s*(?:de\s*)?(\d{2,4}))?/,
  );
  if (range) {
    const monthKey = range[4];
    const monthIndex = CAMPUS_MONTHS[monthKey];
    if (Number.isInteger(monthIndex)) {
      return campusDateFromParts(Number(range[3]), monthIndex, range[5] ? Number(range[5]) : 0, clock.hour, clock.minute);
    }
  }

  const spanishMatches = [...text.matchAll(/\b(\d{1,2})\s*(?:de\s*)?(ene|enero|feb|febrero|mar|marzo|abr|abril|may|mayo|jun|junio|jul|julio|ago|agosto|sep|sept|septiembre|oct|octubre|nov|noviembre|dic|diciembre)(?:\s*(?:de\s*)?(\d{2,4}))?/g)];
  const lastSpanish = spanishMatches[spanishMatches.length - 1];
  if (lastSpanish) {
    const monthIndex = CAMPUS_MONTHS[lastSpanish[2]];
    if (Number.isInteger(monthIndex)) {
      return campusDateFromParts(Number(lastSpanish[1]), monthIndex, lastSpanish[3] ? Number(lastSpanish[3]) : 0, clock.hour, clock.minute);
    }
  }

  const numericMatches = [...text.matchAll(/\b(\d{1,2})[/-](\d{1,2})(?:[/-](\d{2,4}))?/g)];
  const lastNumeric = numericMatches[numericMatches.length - 1];
  if (lastNumeric) {
    return campusDateFromParts(
      Number(lastNumeric[1]),
      Number(lastNumeric[2]) - 1,
      lastNumeric[3] ? Number(lastNumeric[3]) : 0,
      clock.hour,
      clock.minute,
    );
  }

  return null;
}

async function insertGoogleCalendarEvent(event) {
  const response = await sendRuntimeMessageToBackground({
    type: "ADACEEN_GOOGLE_CALENDAR_INSERT",
    event,
  });

  if (!response?.ok) {
    throw new Error(toText(response?.error) || "Google Calendar no pudo crear el evento.");
  }

  return response.event || {};
}

async function ensureGoogleCalendarAccess() {
  const response = await sendRuntimeMessageToBackground({
    type: "ADACEEN_GOOGLE_CALENDAR_AUTHORIZE",
  });

  if (!response?.ok) {
    throw new Error(toText(response?.error) || "Google Calendar no autorizo la extension.");
  }
}

async function openCampusDateSourceFromCurrentAnalysis() {
  overlayState.context = buildPayload();
  const context = overlayState.context;

  if (context.pageContext !== "campus") {
    overlayState.statusMessage = "Abre Campus Virtual para buscar la bitacora del curso.";
    renderOverlay();
    return;
  }

  overlayState.analysisBusy = true;
  overlayState.statusMessage = "Buscando bitacora o agenda del curso...";
  renderOverlay();

  try {
    const currentUrlKey = toText(context.url).split("#")[0];
    const analysisUrlKey = toText(overlayState.campusAnalysis?.course?.url).split("#")[0];
    if (!overlayState.campusAnalysis || analysisUrlKey !== currentUrlKey) {
      overlayState.campusAnalysis = await requestCampusPageAnalysis(context);
    }

    const dateSource = findCampusDateSourceResource(overlayState.campusAnalysis);
    if (!dateSource?.url) {
      overlayState.statusMessage = "No encontre una bitacora, agenda o calendario visible en esta pagina.";
      return;
    }

    const opened = openCampusDateSourceWithLeftClick(dateSource);
    overlayState.statusMessage = opened
      ? `Abriendo "${dateSource.title}" desde el enlace de Campus...`
      : `No pude abrir "${dateSource.title}" desde esta pagina.`;
  } catch (error) {
    overlayState.statusMessage = `No pude abrir la bitacora: ${String(error)}`;
  } finally {
    overlayState.analysisBusy = false;
    renderOverlay();
  }
}

async function syncCampusCalendarToGoogle() {
  overlayState.context = buildPayload();
  const context = overlayState.context;

  if (context.pageContext !== "campus") {
    overlayState.statusMessage = "Abre Campus Virtual para sincronizar tareas con Google Calendar.";
    renderOverlay();
    return;
  }

  overlayState.analysisBusy = true;
  overlayState.statusMessage = "Autorizando Google Calendar...";
  renderOverlay();

  try {
    await ensureGoogleCalendarAccess();
    overlayState.statusMessage = "Detectando eventos de Campus para guardar...";
    renderOverlay();

    overlayState.campusAnalysis = await requestCampusPageAnalysis(context);

    const analysis = overlayState.campusAnalysis;
    let events = buildCampusCalendarEvents(analysis, context);
    if (events.length === 0) {
      events = buildCampusCalendarEvents(buildCampusCalendarFallbackAnalysis(context), context);
    }

    if (events.length === 0) {
      const taskCount = Number(analysis?.stats?.taskCount) || 0;
      const dateSource = findCampusDateSourceResource(analysis);
      if (dateSource?.url) {
        const opened = openCampusDateSourceWithLeftClick(dateSource);
        overlayState.statusMessage = taskCount
          ? `Se detectaron ${taskCount} actividad(es), pero sin fecha clara. ${opened ? `Abri "${dateSource.title}"` : `No pude abrir "${dateSource.title}"`} para buscar fechas antes de agendar.`
          : `No hay fechas claras. ${opened ? `Abri "${dateSource.title}"` : `No pude abrir "${dateSource.title}"`} para buscar el calendario del curso.`;
      } else {
        overlayState.statusMessage = taskCount
          ? `Se detectaron ${taskCount} actividad(es), pero ninguna tiene fecha clara. Quedan en el panel de Campus.`
          : "No hay actividades con fecha clara para sincronizar con Google Calendar.";
      }
      return;
    }

    overlayState.statusMessage = `Creando ${events.length} evento(s) en Google Calendar...`;
    renderOverlay();

    let createdCount = 0;
    let firstEventUrl = "";
    for (const event of events) {
      const created = await insertGoogleCalendarEvent(event);
      createdCount += 1;
      if (!firstEventUrl) firstEventUrl = toText(created?.htmlLink);
    }

    overlayState.analysisUnlocked = true;
    overlayState.statusMessage =
      `Google Calendar actualizado: ${createdCount} evento(s) para tareas y recomendaciones de Campus.`;
    if (firstEventUrl) {
      window.open(firstEventUrl, "_blank", "noopener,noreferrer");
    }
  } catch (error) {
    overlayState.statusMessage =
      `No se pudo crear eventos en Google Calendar: ${String(error)}. Las actividades quedan en el panel de Campus.`;
  } finally {
    overlayState.analysisBusy = false;
    renderOverlay();
  }
}

async function requestCampusPageAnalysis(context) {
  const baseUrl = normalizeBaseUrl(overlayState.backendUrl);
  if (!baseUrl) {
    throw new Error("Base URL vacia.");
  }

  const response = await fetchJsonWithTimeout(`${baseUrl}/api/campus/analyze-page`, {
    method: "POST",
    headers: buildApiHeaders(),
    body: JSON.stringify(buildCampusAnalyzePayload(context)),
  }, 25000);

  if (!response?.ok) {
    throw new Error(toText(response?.error) || "Respuesta invalida del backend Campus.");
  }

  return normalizeCampusAnalysisForState(response.analysis);
}

"use strict";

// ADACEEN | Capa 3 - Servicios: documentos del Campus, descargarlos siguiendo paginas intermedias (enlaces en
// el HTML y en scripts, redirecciones). Movido sin cambios de campus-documents.service.js.

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

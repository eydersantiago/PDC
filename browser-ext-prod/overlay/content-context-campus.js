// ADACEEN | Capa 2 - Contexto: lectura del DOM de Campus Virtual (actividad, fecha limite, curso y actividades
// de la seccion). Movido sin cambios de content-context.js.

function detectCampusActivityTitle() {
  const selectors = [
    ".page-header-headings h1",
    ".page-context-header h1",
    ".activity-header h1",
    "#page-header h1",
    "main h1",
    "h1",
    "main h2",
    "h2",
    ".breadcrumb li:last-child",
  ];

  for (const selector of selectors) {
    const node = document.querySelector(selector);
    const text = normalizeText(node?.textContent || "");
    if (text && text.length >= 4) return text.slice(0, 180);
  }

  return "";
}

function detectCampusDeadline(visibleText) {
  const text = normalizeText(visibleText);
  if (!text) return "";

  const lines = text
    .split(/(?<=[.!?])\s+|\n+/)
    .map((line) => normalizeText(line))
    .filter(Boolean);

  const deadlinePatterns = [
    /\b(fecha\s*(de\s*)?(entrega|limite|cierre)|vence|vencimiento|entregar\s*hasta|disponible\s*hasta)\b/i,
    /\b(due\s*date|deadline|available\s*until|closes)\b/i,
  ];

  for (const line of lines) {
    if (line.length < 8) continue;
    if (deadlinePatterns.some((pattern) => pattern.test(line))) {
      return line.slice(0, 180);
    }
  }

  const compactMatch = text.match(
    /\b(?:entrega|vence|vencimiento|cierre|deadline|due date)\b.{0,90}(?:\d{1,2}\s*(?:de\s*)?(?:ene|enero|feb|febrero|mar|marzo|abr|abril|may|mayo|jun|junio|jul|julio|ago|agosto|sep|septiembre|oct|octubre|nov|noviembre|dic|diciembre)|\d{1,2}[/-]\d{1,2}(?:[/-]\d{2,4})?)/i,
  );
  return compactMatch ? normalizeText(compactMatch[0]).slice(0, 180) : "";
}

function detectCampusCourseId(urlText = location.href) {
  try {
    const url = new URL(urlText, location.href);
    const id = Number(url.searchParams.get("id") || url.searchParams.get("courseid") || 0);
    return Number.isInteger(id) && id > 0 ? id : null;
  } catch {
    const match = String(urlText || "").match(/[?&](?:id|courseid)=(\d+)/i);
    const id = match ? Number(match[1]) : 0;
    return Number.isInteger(id) && id > 0 ? id : null;
  }
}

function inferCampusActivityType(title, href, className = "") {
  const url = String(href || "").toLowerCase();
  const classes = String(className || "").toLowerCase();
  const text = normalizeText(title).toLowerCase();

  if (/modtype_assign|\/mod\/assign\//.test(`${classes} ${url}`)) return "assign";
  if (/modtype_quiz|\/mod\/quiz\//.test(`${classes} ${url}`)) return "quiz";
  if (/modtype_resource|\/mod\/resource\/|pluginfile\.php|\.pdf(?:$|[?#])/.test(`${classes} ${url}`)) return "resource";
  if (/modtype_url|\/mod\/url\//.test(`${classes} ${url}`)) return "url";
  if (/modtype_page|\/mod\/page\//.test(`${classes} ${url}`)) return "page";
  if (/modtype_forum|\/mod\/forum\//.test(`${classes} ${url}`)) return "forum";
  if (/modtype_book|\/mod\/book\//.test(`${classes} ${url}`)) return "book";
  if (/modtype_folder|\/mod\/folder\//.test(`${classes} ${url}`)) return "folder";

  if (/\b(tarea|entrega|taller|assignment|subir|subida)\b/.test(text)) return "assign";
  if (/\b(quiz|cuestionario|examen|parcial|prueba)\b/.test(text)) return "quiz";
  if (/\b(foro|discusion|discusión|forum)\b/.test(text)) return "forum";
  if (/\b(pdf|archivo|recurso|lectura|diapositiva|presentacion|presentación)\b/.test(text)) return "resource";
  if (/\b(enlace|link|url|video)\b/.test(text)) return "url";
  if (/\b(pagina|página|contenido)\b/.test(text)) return "page";
  if (/\b(libro|book)\b/.test(text)) return "book";

  return "unknown";
}

function findCampusSectionNode(node) {
  return node?.closest?.("li.section, section, .course-section, .section, [data-for='section'], [data-sectionid]")
    || null;
}

function findCampusSectionTitle(node) {
  const section = findCampusSectionNode(node);
  if (!section) return "";

  const selectors = [
    ".sectionname",
    ".section-title",
    "[data-for='section_title']",
    "h2",
    "h3",
    "h4",
  ];

  for (const selector of selectors) {
    const text = normalizeText(section.querySelector(selector)?.textContent || "");
    if (text && text.length >= 3) return text.slice(0, 160);
  }

  return "";
}

function extractCampusSectionHtml(node, maxChars = 12000) {
  const section = findCampusSectionNode(node) || node;
  if (!(section instanceof HTMLElement)) return "";

  const clone = section.cloneNode(true);
  if (!(clone instanceof HTMLElement)) return "";

  clone.querySelectorAll("script, style, noscript, svg, canvas, iframe, object, embed").forEach((child) => child.remove());
  clone.querySelectorAll("[hidden], [aria-hidden='true']").forEach((child) => child.remove());

  return String(clone.outerHTML || "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, maxChars);
}

function extractCampusActivities(maxItems = 120) {
  if (!document.body) return [];

  const selectors = [
    "[data-region='activity-card']",
    ".activity-item",
    "li.activity",
    ".activity",
    ".modtype_assign",
    ".modtype_quiz",
    ".modtype_resource",
    ".modtype_url",
    ".modtype_page",
    ".modtype_forum",
    ".modtype_book",
    ".modtype_folder",
  ];
  const nodes = Array.from(document.querySelectorAll(selectors.join(",")));
  const seen = new Set();
  const activities = [];

  for (const node of nodes) {
    if (!(node instanceof HTMLElement)) continue;

    const link = node.querySelector("a[href*='/mod/']")
      || node.querySelector("a[href*='pluginfile.php']")
      || node.querySelector("a[href]");
    const href = normalizeText(link?.href || "").slice(0, 520);
    const titleNode = node.querySelector(".activityname, .instancename, .aalink, [data-activityname], h3, h4")
      || link;
    const title = normalizeText(
      titleNode?.getAttribute?.("data-activityname")
      || titleNode?.textContent
      || link?.textContent
      || "",
    ).slice(0, 220);

    if (!title && !href) continue;
    const key = `${title.toLowerCase()}|${href}`;
    if (seen.has(key)) continue;
    seen.add(key);

    const rawText = normalizeText(node.innerText || node.textContent || "");
    const descriptionNode = node.querySelector(".description, .activity-description, .contentafterlink, .no-overflow, .summary");
    const description = normalizeText(descriptionNode?.innerText || descriptionNode?.textContent || rawText).slice(0, 1800);
    const sectionTitle = findCampusSectionTitle(node);
    const sectionHtml = extractCampusSectionHtml(node);
    const type = inferCampusActivityType(title, href, node.className);
    const visibleDueText = detectCampusDeadline(rawText || description);

    activities.push({
      title: title || "(actividad sin titulo)",
      type,
      url: href,
      description,
      sectionTitle,
      sectionHtml,
      visibleDueText,
    });

    if (activities.length >= maxItems) break;
  }

  return activities;
}

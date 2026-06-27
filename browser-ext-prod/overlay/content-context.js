
function extractVisibleText(maxChars = 14000) {
  if (!document.body) return "";
  const raw = String(document.body.innerText || document.body.textContent || "");
  return raw
    .replace(/\u00a0/g, " ")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim()
    .slice(0, maxChars);
}

function extractSelectionText(maxChars = 4000) {
  try {
    const selected = window.getSelection ? String(window.getSelection()) : "";
    return selected.trim().slice(0, maxChars);
  } catch {
    return "";
  }
}

function extractVisibleLinks(maxLinks = 25, maxTextChars = 100, maxUrlChars = 320) {
  if (!document.body) return [];

  const out = [];
  const seen = new Set();
  const anchors = document.querySelectorAll("a[href]");

  for (const anchor of anchors) {
    const href = normalizeText(anchor.href).slice(0, maxUrlChars);
    if (!href || /^javascript:/i.test(href)) continue;

    const rect = anchor.getBoundingClientRect();
    if (rect.width <= 0 && rect.height <= 0) continue;

    const text = normalizeText(
      anchor.innerText || anchor.textContent || anchor.getAttribute("aria-label") || "",
    ).slice(0, maxTextChars);

    const key = `${text.toLowerCase()}|${href}`;
    if (seen.has(key)) continue;
    seen.add(key);

    out.push({ text: text || "(sin texto)", href });
    if (out.length >= maxLinks) break;
  }

  return out;
}

function getGitHubInfo() {
  try {
    const url = new URL(location.href);
    const host = url.hostname.toLowerCase();
    const parts = url.pathname.split("/").filter(Boolean);

    const isGitHubHost = host === "github.com";
    const isCodespaceHost =
      host === "github.dev" ||
      host.endsWith(".github.dev") ||
      host === "app.github.dev" ||
      host.endsWith(".app.github.dev");

    let repoOwner = "";
    let repoName = "";
    let repoFullName = "";
    let branch = "";
    let filePath = "";
    let pageType = "other";

    if (isGitHubHost
      && parts[0]?.toLowerCase() === "codespaces"
      && parts[1]?.toLowerCase() === "new"
      && parts.length >= 4) {
      repoOwner = parts[2];
      repoName = parts[3].replace(/\.git$/i, "");
      repoFullName = `${repoOwner}/${repoName}`;
      pageType = "codespace";

      const treeIndex = parts.indexOf("tree");
      if (treeIndex > 3 && parts.length > treeIndex + 1) {
        branch = parts.slice(treeIndex + 1).join("/");
      }
    } else if (isGitHubHost && parts.length >= 2) {
      repoOwner = parts[0];
      repoName = parts[1].replace(/\.git$/i, "");
      repoFullName = `${repoOwner}/${repoName}`;
      pageType = "github_general";

      const blobIndex = parts.indexOf("blob");
      if (blobIndex > 1 && parts.length > blobIndex + 2) {
        branch = parts[blobIndex + 1];
        filePath = parts.slice(blobIndex + 2).join("/");
        pageType = "github_code";
      }
    }

    if (isCodespaceHost || (isGitHubHost && url.pathname.includes("/codespaces/"))) {
      pageType = "codespace";

      if (!repoFullName) {
        const queryCandidates = [
          url.searchParams.get("repo"),
          url.searchParams.get("repository"),
          url.searchParams.get("repo_full_name"),
          url.searchParams.get("workspace"),
          url.searchParams.get("folder"),
        ]
          .map((value) => parseRepoFullName(value || ""))
          .filter(Boolean);

        if (queryCandidates[0]) {
          repoFullName = queryCandidates[0];
          const parts = repoFullName.split("/");
          repoOwner = parts[0] || "";
          repoName = parts[1] || "";
        }
      }

      filePath = detectCodespaceActiveFilePath() || filePath;
    }

    return {
      pageType,
      repoOwner,
      repoName,
      repoFullName,
      branch,
      filePath,
    };
  } catch {
    return {
      pageType: "other",
      repoOwner: "",
      repoName: "",
      repoFullName: "",
      branch: "",
      filePath: "",
    };
  }
}

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

function detectVisibleError(selectionText, visibleText) {
  const candidateText = [selectionText, visibleText]
    .map((item) => String(item || ""))
    .filter(Boolean)
    .join("\n");

  if (!candidateText) return "";

  const lines = candidateText
    .split(/\r?\n/)
    .map((line) => normalizeText(line))
    .filter(Boolean);

  const patterns = [
    /\b(error|errores|exception|traceback|syntaxerror|typeerror|nameerror)\b/i,
    /\b(segmentation fault|undefined reference|nullpointer|compil[ao]cion|compilation failed)\b/i,
    /\b(module not found|cannot find|no such file|failed|warning)\b/i,
  ];

  for (const line of lines) {
    if (line.length < 6) continue;
    if (patterns.some((pattern) => pattern.test(line))) {
      return line.slice(0, 220);
    }
  }

  return "";
}

function detectLanguageHint(filePath) {
  const lower = String(filePath || "").toLowerCase();
  if (lower.endsWith(".ts") || lower.endsWith(".tsx")) return "TypeScript";
  if (lower.endsWith(".js") || lower.endsWith(".jsx")) return "JavaScript";
  if (lower.endsWith(".py")) return "Python";
  if (lower.endsWith(".cpp") || lower.endsWith(".cc") || lower.endsWith(".cxx")) return "C++";
  if (lower.endsWith(".java")) return "Java";
  if (lower.endsWith(".go")) return "Go";
  if (lower.endsWith(".rs")) return "Rust";
  if (lower.endsWith(".cs")) return "C#";
  if (lower.endsWith(".php")) return "PHP";
  if (lower.endsWith(".rb")) return "Ruby";
  if (lower.endsWith(".kt")) return "Kotlin";
  if (lower.endsWith(".swift")) return "Swift";
  if (lower.endsWith(".sql")) return "SQL";
  if (lower.endsWith(".html")) return "HTML";
  if (lower.endsWith(".css") || lower.endsWith(".scss")) return "CSS";
  if (lower.endsWith(".md")) return "Markdown";
  return "";
}

function extractCodeFromSelectors(selectors, maxLines, maxChars) {
  for (const selector of selectors) {
    const nodes = Array.from(document.querySelectorAll(selector));
    if (nodes.length === 0) continue;

    const lines = [];
    let size = 0;

    for (const node of nodes) {
      const raw = String(node.innerText || node.textContent || "");
      if (!raw) continue;

      const split = raw.split("\n");
      for (const chunk of split) {
        const line = normalizeCodeLine(chunk);
        if (!line.trim()) continue;

        lines.push(line);
        size += line.length + 1;

        if (lines.length >= maxLines || size >= maxChars) {
          return lines.join("\n").slice(0, maxChars);
        }
      }
    }

    if (lines.length > 0) {
      return lines.join("\n").slice(0, maxChars);
    }
  }

  return "";
}

function extractVisibleCode(maxLines = 260, maxChars = 18000) {
  const selectors = [
    "table.js-file-line-container td.blob-code",
    "table.js-file-line-container td.blob-code-inner",
    ".react-code-text",
    "[data-testid='code-cell']",
    ".view-lines .view-line",
    "pre code",
  ];

  const snippet = extractCodeFromSelectors(selectors, maxLines, maxChars);
  const lineCount = snippet ? snippet.split("\n").length : 0;
  return { snippet, lineCount };
}

function looksLikeRepoFilePath(value) {
  const text = normalizeText(value).replace(/\\/g, "/");
  return /(^|\/)[^/]+\.[A-Za-z0-9]{1,12}$/.test(text);
}

function normalizeCodespaceUiLabel(value) {
  return normalizeText(value)
    .replace(/\s+-\s+Visual Studio Code.*$/i, "")
    .replace(/\s+-\s+GitHub Codespaces.*$/i, "")
    .replace(/\s+\(.*?\)$/g, "")
    .replace(/^[>*\s]+|[>*\s]+$/g, "");
}

function collectSelectorTexts(selectors, maxItems = 16) {
  const values = [];
  const seen = new Set();

  for (const selector of selectors) {
    const nodes = Array.from(document.querySelectorAll(selector));
    for (const node of nodes) {
      const text = normalizeCodespaceUiLabel(
        node.getAttribute?.("aria-label")
        || node.getAttribute?.("title")
        || node.textContent
        || "",
      );
      if (!text || seen.has(text.toLowerCase())) continue;
      seen.add(text.toLowerCase());
      values.push(text);
      if (values.length >= maxItems) return values;
    }
  }

  return values;
}

function extractCodespaceBreadcrumbParts(maxParts = 12) {
  const selectors = [
    ".monaco-workbench .breadcrumbs .monaco-breadcrumb-item .label-name",
    ".monaco-workbench .breadcrumbs .label-name",
    ".monaco-workbench .monaco-breadcrumb-item .label-name",
    "[aria-label*='Breadcrumb'] .label-name",
  ];

  return collectSelectorTexts(selectors, maxParts)
    .map((item) => item.replace(/[\\/]+/g, "/"))
    .filter(Boolean)
    .slice(0, maxParts);
}

function extractCodespaceActiveTabLabels(maxTabs = 8) {
  const selectors = [
    ".monaco-workbench .part.editor .tab.active .label-name",
    ".monaco-workbench .part.editor .tab[aria-selected='true'] .label-name",
    ".monaco-workbench .tabs-container .tab.active .label-name",
    ".monaco-workbench .tabs-container .tab[aria-selected='true'] .label-name",
  ];

  return collectSelectorTexts(selectors, maxTabs)
    .filter((item) => item && !/^untitled-\d+$/i.test(item));
}

function detectCodespaceActiveFilePath() {
  const breadcrumbParts = extractCodespaceBreadcrumbParts();
  if (breadcrumbParts.length > 0) {
    const breadcrumbPath = breadcrumbParts.join("/");
    if (looksLikeRepoFilePath(breadcrumbPath)) {
      return breadcrumbPath;
    }
  }

  const activeTabs = extractCodespaceActiveTabLabels();
  const tabFile = activeTabs.find(looksLikeRepoFilePath);
  if (tabFile) {
    return tabFile;
  }

  const titleHead = normalizeCodespaceUiLabel(String(document.title || "").split(" - ")[0] || "");
  if (looksLikeRepoFilePath(titleHead)) {
    return titleHead.replace(/\\/g, "/");
  }

  return "";
}

function toText(value) {
  return String(value || "").trim();
}

function truncateText(value, max = 280) {
  const text = toText(value);
  if (!text) return "";
  if (!Number.isFinite(max) || max <= 0) return "";
  if (text.length <= max) return text;
  return `${text.slice(0, Math.max(0, max - 3))}...`;
}

function normalizeBaseUrl(value) {
  return toText(value).replace(/\/+$/, "");
}

function unique(items) {
  return [...new Set(items.filter(Boolean).map((item) => toText(item)))];
}

function clearList(listEl) {
  listEl.textContent = "";
}

function fillList(listEl, items) {
  clearList(listEl);
  const fragment = document.createDocumentFragment();
  const itemBuilder = listEl?.id?.toLowerCase().includes("guide") && typeof buildOverlayGuideItemTemplate === "function"
    ? buildOverlayGuideItemTemplate
    : typeof buildOverlayIdeaItemTemplate === "function"
      ? buildOverlayIdeaItemTemplate
      : null;

  for (const text of items) {
    const li = itemBuilder ? itemBuilder(text) : document.createElement("li");
    if (!itemBuilder) li.textContent = text;
    fragment.appendChild(li);
  }
  listEl.appendChild(fragment);
}

function basename(path) {
  const clean = toText(path);
  if (!clean) return "";
  const parts = clean.split("/").filter(Boolean);
  return parts[parts.length - 1] || "";
}

function getExtension(path) {
  const file = basename(path);
  const dot = file.lastIndexOf(".");
  if (dot < 0) return "";
  return file.slice(dot).toLowerCase();
}

function inferLanguage(filePath, hint) {
  const cleanHint = toText(hint);
  if (cleanHint) return cleanHint;

  const ext = getExtension(filePath);
  const byExtension = ext ? detectLanguageHint(filePath) : "";
  return byExtension || "General";
}

function getLearningGoal(goalId = overlayState.selectedLearningGoal) {
  return LEARNING_GOALS.find((goal) => goal.id === goalId) || LEARNING_GOALS[0];
}

function getCurrentUserId() {
  return toText(overlayState.session?.user?.id);
}

function buildPayload() {
  const pageContext = detectPageContext();
  const campusPageType = pageContext === "campus" ? detectCampusPageType(location.href) : "";
  const campusCourseOpen = campusPageType === "campus_course";
  const visibleText = extractVisibleText(14000);
  const selection = extractSelectionText(4000);
  const github = getGitHubInfo();
  const links = pageContext === "campus"
    ? extractVisibleLinks(120, 140, 520)
    : extractVisibleLinks(25, 100, 320);
  const repoFromLinks = detectRepoFromLinks(links);
  const code = pageContext === "github"
    ? extractVisibleCode(260, 18000)
    : { snippet: "", lineCount: 0 };
  const activityTitle = pageContext === "campus" ? detectCampusActivityTitle() : "";
  const activityDeadline = campusCourseOpen ? detectCampusDeadline(visibleText) : "";
  const courseId = campusCourseOpen ? detectCampusCourseId(location.href) : null;
  const campusActivities = campusCourseOpen ? extractCampusActivities(120) : [];
  const visibleError = detectVisibleError(selection, visibleText);
  const pageType = pageContext === "campus" ? (campusPageType || "campus") : github.pageType;

  return {
    url: location.href,
    title: document.title || "",
    text: visibleText,
    selection,
    links,
    pageContext,
    pageType,
    repoOwner: github.repoOwner,
    repoName: github.repoName,
    repoFullName: github.repoFullName || repoFromLinks,
    branch: github.branch,
    filePath: github.filePath,
    languageHint: detectLanguageHint(github.filePath),
    codespaceBreadcrumbs: pageType === "codespace" ? extractCodespaceBreadcrumbParts(12) : [],
    codespaceActiveTabs: pageType === "codespace" ? extractCodespaceActiveTabLabels(8) : [],
    courseId,
    campusActivities,
    activityTitle,
    activityDeadline,
    visibleError,
    codeSnippet: code.snippet,
    codeLineCount: code.lineCount,
  };
}

// ADACEEN | Capa 2 - Contexto: lectura del codigo visible, el error visible y el archivo activo en
// GitHub y Codespaces. Movido sin cambios de content-context.js.

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

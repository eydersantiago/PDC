"use strict";

function normalizeText(value) {
  return String(value || "")
    .replace(/\u00a0/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function normalizeCodeLine(value) {
  return String(value || "")
    .replace(/\u00a0/g, " ")
    .replace(/\r/g, "")
    .replace(/[ \t]+$/g, "");
}

function detectPageContext(urlText = location.href) {
  const url = String(urlText || "").toLowerCase();
  if (url.includes("campusvirtual.univalle.edu.co")) return "campus";
  if (url.includes("github.com") || url.includes("github.dev")) return "github";
  return "unknown";
}

const OVERLAY_HOST_ID = "adaceen-overlay-host";
const STORAGE_KEY_OVERLAY_PINNED = "adaceenOverlayPinned";
const STORAGE_KEY_ENABLED = "assistantEnabled";
const STORAGE_KEY_BACKEND_URL = "mentorBackendUrl";
const STORAGE_KEY_LEARNING_GOAL = "studentLearningGoal";
const STORAGE_KEY_SESSION_ID = "adaceenSessionId";
const STORAGE_KEY_PROJECT_CONSENT_BY_USER = "adaceenProjectConsentByUser";
const STORAGE_KEY_SETUP_DONE_BY_USER = "adaceenSetupDoneByUser";
const STORAGE_KEY_AUTO_CONFIG_ENABLED = "adaceenAutoConfigEnabled";
const DEFAULT_BACKEND_URL = "http://127.0.0.1:3000";
const DEFAULT_LEARNING_GOAL = "oop_basics";
const BACKEND_TIMEOUT_MS = 12000;
const MAX_LIST_ITEMS = 4;
const MAX_PREVIEW_CHARS = 900;
const MAX_ANALYSIS_RENDER_ITEMS = 10000;
const OVERLAY_MARGIN = 16;
// Temporal para pruebas: permite avanzar y crear PR sin validar instalacion/acceso en UI.
const BYPASS_GITHUB_APP_INSTALL_VALIDATION = true;

const LEARNING_GOALS = [
  { id: "oop_basics", label: "Clases y objetos" },
  { id: "encapsulation", label: "Encapsulamiento" },
  { id: "inheritance", label: "Herencia y polimorfismo" },
  { id: "debugging", label: "Resolver errores" },
  { id: "github_flow", label: "GitHub y Codespaces" },
];

const DEFAULT_POLICY = {
  policyName: "RF-05 base del piloto",
  outcome: "RA1",
  tone: "warm",
  frequency: "medium",
  helpLevel: "progressive",
  allowMiniQuiz: true,
  strictNoSolution: true,
  maxHintsPerExercise: 3,
  fallbackMessage:
    "No puedo ayudar con ese tema o con tan poco contexto. Muestrame el ejercicio, el error o un fragmento del codigo del curso.",
  customInstruction: "",
  allowedInterventions: ["explanation", "hint", "example", "mini_quiz"],
  eventRules: {},
};

const EMPTY_GITHUB_APP_STATUS = {
  configured: false,
  missingConfig: [],
  installUrlBase: "",
  setupUrl: "",
  installation: null,
  repoFullName: "",
  hasRepoAccess: null,
  bootstrapReady: false,
  bootstrapSource: "",
  bootstrapUpdatedAt: "",
  bootstrapDetails: "",
  bootstrapSignals: null,
};

const EMPTY_PROJECT_CONTEXT_STATUS = {
  configured: false,
  repoFullName: "",
  hasContext: false,
  latestRequestId: "",
  latestSnapshotId: "",
  latestVersion: "",
  currentVersion: "",
  updatedAt: "",
  source: "",
  summary: "",
  details: "",
  totalVersions: 0,
  requestStatus: "",
};

const EMPTY_PROJECT_CONTEXT_INSIGHT = {
  configured: false,
  repoFullName: "",
  hasContext: false,
  requestId: "",
  snapshotId: "",
  version: "",
  currentVersion: "",
  source: "",
  updatedAt: "",
  totalFiles: 0,
  totalBytes: 0,
  summary: "",
  mainFilePath: "",
  mainFileReason: "",
  autoAdvice: "",
  modelEnabled: true,
  modelUsed: false,
  modelProvider: "",
  candidates: [],
  modelError: "",
  storageReadError: "",
};

const overlayState = {
  assistantEnabled: true,
  autoConfigEnabled: true,
  backendUrl: DEFAULT_BACKEND_URL,
  selectedLearningGoal: DEFAULT_LEARNING_GOAL,
  sessionId: "",
  session: null,
  policy: { ...DEFAULT_POLICY },
  telemetry: [],
  authError: "",
  authBusy: false,
  analysisWindowOpen: false,
  started: false,
  settingsOpen: false,
  loading: false,
  context: null,
  ideas: [],
  guide: [],
  analysisUnlocked: false,
  welcome: "",
  statusMessage: "",
  analysisBusy: false,
  projectAnalysis: null,
  projectConsentByUser: {},
  setupDoneByUser: {},
  setupRepoFullName: "",
  setupWizardStep: 1,
  setupPrResultByUser: {},
  githubAppStatus: { ...EMPTY_GITHUB_APP_STATUS },
  githubAppBusy: false,
  projectContextStatus: { ...EMPTY_PROJECT_CONTEXT_STATUS },
  projectContextHistory: [],
  projectContextInsight: { ...EMPTY_PROJECT_CONTEXT_INSIGHT },
  projectContextBusy: false,
  projectContextMessage: "",
  projectContextError: "",
  adminUsers: [],
  adminTeachers: [],
  adminUsersBusy: false,
  adminUsersMessage: "",
};

let overlayHost = null;
let overlayRoot = null;
let overlayEls = null;
let preferencesLoaded = false;
let overlayViewportSyncFrame = 0;
let overlayViewportListenersBound = false;

function clamp(value, min, max) {
  return Math.min(Math.max(value, min), max);
}

function getViewportMetrics() {
  const viewport = window.visualViewport;
  return {
    width: viewport?.width || window.innerWidth || document.documentElement.clientWidth || 0,
    height: viewport?.height || window.innerHeight || document.documentElement.clientHeight || 0,
    offsetLeft: viewport?.offsetLeft || 0,
    offsetTop: viewport?.offsetTop || 0,
  };
}

function getOverlayViewportBounds() {
  const { width, height, offsetLeft, offsetTop } = getViewportMetrics();
  const rect = overlayHost?.getBoundingClientRect() || { width: 0, height: 0 };
  const minLeft = offsetLeft + OVERLAY_MARGIN;
  const minTop = offsetTop + OVERLAY_MARGIN;
  const maxLeft = Math.max(minLeft, offsetLeft + width - rect.width - OVERLAY_MARGIN);
  const maxTop = Math.max(minTop, offsetTop + height - rect.height - OVERLAY_MARGIN);

  return { minLeft, minTop, maxLeft, maxTop };
}

function placeOverlay(left, top) {
  if (!overlayHost) return;
  overlayHost.style.left = `${Math.round(left)}px`;
  overlayHost.style.top = `${Math.round(top)}px`;
  overlayHost.style.right = "auto";
  overlayHost.style.bottom = "auto";
}

function syncOverlayToViewport(preferCurrentPosition = true) {
  if (!overlayHost) return;

  const rect = overlayHost.getBoundingClientRect();
  const bounds = getOverlayViewportBounds();
  const defaultLeft = bounds.maxLeft;
  const defaultTop = bounds.minTop;
  const nextLeft = clamp(preferCurrentPosition ? rect.left : defaultLeft, bounds.minLeft, bounds.maxLeft);
  const nextTop = clamp(preferCurrentPosition ? rect.top : defaultTop, bounds.minTop, bounds.maxTop);

  placeOverlay(nextLeft, nextTop);
}

function scheduleOverlayViewportSync(preferCurrentPosition = true) {
  if (overlayViewportSyncFrame) {
    window.cancelAnimationFrame(overlayViewportSyncFrame);
  }

  overlayViewportSyncFrame = window.requestAnimationFrame(() => {
    overlayViewportSyncFrame = 0;
    syncOverlayToViewport(preferCurrentPosition);
  });
}

function bindOverlayViewportListeners() {
  if (overlayViewportListenersBound) return;

  const handleViewportChange = () => {
    scheduleOverlayViewportSync(true);
  };

  window.addEventListener("resize", handleViewportChange);
  window.visualViewport?.addEventListener("resize", handleViewportChange);
  window.visualViewport?.addEventListener("scroll", handleViewportChange);
  overlayViewportListenersBound = true;
}

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

    if (isGitHubHost && parts.length >= 2) {
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

function toText(value) {
  return String(value || "").trim();
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
  for (const text of items) {
    const li = document.createElement("li");
    li.textContent = text;
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

async function loadPreferences() {
  if (preferencesLoaded) return;

  try {
    const stored = await chrome.storage.local.get([
      STORAGE_KEY_ENABLED,
      STORAGE_KEY_BACKEND_URL,
      STORAGE_KEY_LEARNING_GOAL,
      STORAGE_KEY_SESSION_ID,
      STORAGE_KEY_PROJECT_CONSENT_BY_USER,
      STORAGE_KEY_SETUP_DONE_BY_USER,
      STORAGE_KEY_AUTO_CONFIG_ENABLED,
    ]);

    overlayState.assistantEnabled = typeof stored[STORAGE_KEY_ENABLED] === "boolean"
      ? stored[STORAGE_KEY_ENABLED]
      : true;
    overlayState.backendUrl = normalizeBaseUrl(stored[STORAGE_KEY_BACKEND_URL]) || DEFAULT_BACKEND_URL;
    overlayState.selectedLearningGoal = LEARNING_GOALS.some((goal) => goal.id === stored[STORAGE_KEY_LEARNING_GOAL])
      ? stored[STORAGE_KEY_LEARNING_GOAL]
      : DEFAULT_LEARNING_GOAL;
    overlayState.sessionId = toText(stored[STORAGE_KEY_SESSION_ID]);
    overlayState.autoConfigEnabled = typeof stored[STORAGE_KEY_AUTO_CONFIG_ENABLED] === "boolean"
      ? stored[STORAGE_KEY_AUTO_CONFIG_ENABLED]
      : true;
    overlayState.projectConsentByUser =
      stored[STORAGE_KEY_PROJECT_CONSENT_BY_USER]
      && typeof stored[STORAGE_KEY_PROJECT_CONSENT_BY_USER] === "object"
        ? stored[STORAGE_KEY_PROJECT_CONSENT_BY_USER]
        : {};
    overlayState.setupDoneByUser =
      stored[STORAGE_KEY_SETUP_DONE_BY_USER]
      && typeof stored[STORAGE_KEY_SETUP_DONE_BY_USER] === "object"
        ? stored[STORAGE_KEY_SETUP_DONE_BY_USER]
        : {};
  } catch {
    overlayState.assistantEnabled = true;
    overlayState.backendUrl = DEFAULT_BACKEND_URL;
    overlayState.selectedLearningGoal = DEFAULT_LEARNING_GOAL;
    overlayState.autoConfigEnabled = true;
    overlayState.sessionId = "";
    overlayState.session = null;
    overlayState.policy = { ...DEFAULT_POLICY };
    overlayState.projectConsentByUser = {};
    overlayState.setupDoneByUser = {};
  }

  preferencesLoaded = true;
}

async function persistPreferences() {
  await chrome.storage.local.set({
    [STORAGE_KEY_ENABLED]: overlayState.assistantEnabled,
    [STORAGE_KEY_BACKEND_URL]: overlayState.backendUrl,
    [STORAGE_KEY_LEARNING_GOAL]: overlayState.selectedLearningGoal,
    [STORAGE_KEY_SESSION_ID]: overlayState.sessionId,
    [STORAGE_KEY_PROJECT_CONSENT_BY_USER]: overlayState.projectConsentByUser,
    [STORAGE_KEY_SETUP_DONE_BY_USER]: overlayState.setupDoneByUser,
    [STORAGE_KEY_AUTO_CONFIG_ENABLED]: overlayState.autoConfigEnabled,
  });
}

function buildPayload() {
  const pageContext = detectPageContext();
  const visibleText = extractVisibleText(14000);
  const selection = extractSelectionText(4000);
  const github = getGitHubInfo();
  const links = extractVisibleLinks(25, 100, 320);
  const repoFromLinks = detectRepoFromLinks(links);
  const code = pageContext === "github"
    ? extractVisibleCode(260, 18000)
    : { snippet: "", lineCount: 0 };
  const activityTitle = pageContext === "campus" ? detectCampusActivityTitle() : "";
  const visibleError = detectVisibleError(selection, visibleText);
  const pageType = pageContext === "campus" ? "campus" : github.pageType;

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
    activityTitle,
    visibleError,
    codeSnippet: code.snippet,
    codeLineCount: code.lineCount,
  };
}

function parseExplorerItemType(row, name) {
  const iconLabel = row.querySelector(".monaco-icon-label");
  const classBlob = `${row.className || ""} ${iconLabel?.className || ""}`.toLowerCase();

  if (row.hasAttribute("aria-expanded")) return "folder";
  if (classBlob.includes("folder")) return "folder";
  if (classBlob.includes("file")) return "file";
  if (!/\.[a-z0-9]{1,12}$/i.test(name)) return "folder";
  return "file";
}

function extractCodespaceExplorerEntries(maxItems = 10000) {
  const root = document.querySelector(".explorer-folders-view");
  if (!root) return [];

  const rows = Array.from(root.querySelectorAll(".monaco-list-row, [role='treeitem']"));
  const pathByLevel = [];
  const seen = new Set();
  const entries = [];

  for (const row of rows) {
    if (!(row instanceof HTMLElement)) continue;

    const rawName = toText(
      row.getAttribute("data-resource-name")
      || row.querySelector("[data-resource-name]")?.getAttribute("data-resource-name")
      || row.querySelector(".label-name")?.textContent
      || row.getAttribute("aria-label")
      || "",
    );
    const name = rawName.split(",")[0].trim();
    if (!name || name === "(sin texto)") continue;

    const levelValue = Number(
      row.getAttribute("aria-level")
      || row.dataset.level
      || row.querySelector("[aria-level]")?.getAttribute("aria-level")
      || 1,
    );
    const level = Number.isFinite(levelValue) && levelValue > 0
      ? Math.floor(levelValue)
      : 1;

    const levelIndex = Math.max(0, level - 1);
    const parentPath = levelIndex > 0 ? toText(pathByLevel[levelIndex - 1]) : "";
    const path = parentPath ? `${parentPath}/${name}` : name;
    pathByLevel[levelIndex] = path;
    pathByLevel.length = levelIndex + 1;

    const type = parseExplorerItemType(row, name);
    const key = `${type}|${path.toLowerCase()}`;
    if (seen.has(key)) continue;

    seen.add(key);
    entries.push({ type, name, path, level });
    if (entries.length >= maxItems) break;
  }

  return entries;
}

function buildCodespaceAnalysis(entries) {
  const folders = entries
    .filter((entry) => entry.type === "folder")
    .map((entry) => entry.path);
  const files = entries
    .filter((entry) => entry.type === "file")
    .map((entry) => entry.path);

  return {
    totalEntries: entries.length,
    totalFiles: files.length,
    totalFolders: folders.length,
    folders,
    files,
    generatedAt: new Date().toISOString(),
  };
}

function renderProjectAnalysisWindow() {
  if (!overlayEls?.analysisWindow) return;

  overlayEls.analysisWindow.hidden = !overlayState.analysisWindowOpen;
  if (overlayEls.analysisWindow.hidden) return;

  if (overlayState.analysisBusy) {
    overlayEls.analysisStats.textContent = "Analizando archivos y carpetas visibles en Codespaces...";
    fillList(overlayEls.analysisFileList, ["Procesando arbol del explorador..."]);
    return;
  }

  const analysis = overlayState.projectAnalysis;
  if (!analysis) {
    overlayEls.analysisStats.textContent = "Pulsa Explorar proyecto para leer archivos y carpetas del explorador.";
    fillList(overlayEls.analysisFileList, ["Aun no hay resultados."]);
    return;
  }

  const status = overlayState.projectContextStatus || EMPTY_PROJECT_CONTEXT_STATUS;
  const insight = overlayState.projectContextInsight || EMPTY_PROJECT_CONTEXT_INSIGHT;
  const versionText = toText(insight.version || status.latestVersion || status.currentVersion);
  const mainFilePath = toText(insight.mainFilePath);
  const statsExtras = [];
  if (versionText) statsExtras.push(`version ${versionText}`);
  if (mainFilePath) statsExtras.push(`archivo principal ${mainFilePath}`);

  overlayEls.analysisStats.textContent =
    `Detectados ${analysis.totalFiles} archivos y ${analysis.totalFolders} carpetas ` +
    `(${analysis.totalEntries} elementos visibles).` +
    (statsExtras.length > 0 ? ` ${statsExtras.join(" | ")}` : "");

  const lines = [
    ...(insight.summary ? [`[resumen] ${truncateText(insight.summary, 260)}`] : []),
    ...(mainFilePath ? [`[archivo principal] ${mainFilePath}`] : []),
    ...(insight.autoAdvice ? [`[consejo] ${truncateText(insight.autoAdvice, 260)}`] : []),
    ...analysis.folders.map((path) => `[carpeta] ${path}`),
    ...analysis.files.map((path) => `[archivo] ${path}`),
  ];

  const visibleLines = lines.slice(0, MAX_ANALYSIS_RENDER_ITEMS);
  if (lines.length > MAX_ANALYSIS_RENDER_ITEMS) {
    visibleLines.push(`... ${lines.length - MAX_ANALYSIS_RENDER_ITEMS} elementos adicionales.`);
  }

  fillList(
    overlayEls.analysisFileList,
    visibleLines.length > 0 ? visibleLines : ["No se detectaron archivos o carpetas visibles."],
  );
}

async function analyzeCodespaceProject() {
  overlayState.analysisWindowOpen = true;
  overlayState.analysisBusy = true;
  overlayState.statusMessage = "Explorando estructura visible del proyecto...";
  renderOverlay();

  try {
    overlayState.context = buildPayload();
    const context = overlayState.context;

    if (context.pageType !== "codespace") {
      overlayState.projectAnalysis = null;
      overlayState.statusMessage = "Este analisis basico solo funciona en la interfaz de Codespaces.";
      return;
    }

    const entries = extractCodespaceExplorerEntries();
    overlayState.projectAnalysis = buildCodespaceAnalysis(entries);

    if (entries.length === 0) {
      overlayState.statusMessage = "No se pudieron leer elementos del explorador. Expande archivos y vuelve a analizar.";
      return;
    }

    overlayState.analysisUnlocked = true;
    overlayState.statusMessage =
      `Exploracion lista: ${overlayState.projectAnalysis.totalFiles} archivos y ` +
      `${overlayState.projectAnalysis.totalFolders} carpetas detectados.`;
    overlayState.analysisBusy = false;
    renderOverlay();

    await new Promise((resolve) => setTimeout(resolve, 50));

    let hasConsent = false;
    try {
      hasConsent = await ensureProjectConsentForCurrentUser();
    } catch (error) {
      overlayState.statusMessage =
        `Exploracion lista, pero no se pudo registrar el permiso inicial: ${String(error)}`;
      return;
    }

    if (!hasConsent) {
      overlayState.statusMessage =
        "Exploracion lista. Cuando des permiso, guardaremos el contexto del proyecto en el rack del agente.";
      return;
    }

    const repoFullName = getCurrentRepoFullName() || inferRepoFromContext(context);
    let workerCoordinationNote = "";
    let scanCompletedFromWorker = false;
    if (repoFullName) {
      try {
        const requestResponse = await requestProjectScanFromBackend(repoFullName);
        const requestId = toText(requestResponse?.request?.id);
        if (requestId) {
          overlayState.statusMessage =
            "Solicitud enviada a la extensión VS Code. Esperando archivos con código...";
          renderOverlay();

          const finalStatus = await waitForProjectScanCompletion(requestId, 120000, 2500);
          const finalState = toText(finalStatus?.request?.status).toLowerCase();
          if (finalState === "completed") {
            overlayState.statusMessage =
              "Exploracion lista. La extensión VS Code envió el código al backend y se guardó en almacenamiento local + PostgreSQL.";
            scanCompletedFromWorker = true;
          }
          if (finalState === "failed") {
            workerCoordinationNote =
              "La extensión VS Code reportó error al enviar el código.";
            overlayState.statusMessage = `${workerCoordinationNote} Se intentará guardado básico de respaldo.`;
          } else if (finalState !== "completed") {
            workerCoordinationNote =
              "No llegó respuesta de la extensión VS Code a tiempo.";
            overlayState.statusMessage = `${workerCoordinationNote} Se intentará guardado básico de respaldo.`;
          }
        } else {
          workerCoordinationNote =
            "El backend no creó solicitud para worker VS Code.";
        }
      } catch (error) {
        workerCoordinationNote =
          `No se pudo coordinar escaneo con la extensión VS Code: ${String(error)}.`;
        overlayState.statusMessage = `${workerCoordinationNote} Se intentará guardado básico.`;
      }
    }

    if (scanCompletedFromWorker) {
      await refreshProjectContextPanel();
      return;
    }

    try {
      const synced = await syncProjectRackToBackend(context, overlayState.projectAnalysis);
      overlayState.statusMessage = synced
        ? workerCoordinationNote
          ? `Exploracion básica guardada en backend (rack). Nota: ${workerCoordinationNote} Revisa Output > ADACEEN en VS Code.`
          : "Exploracion lista y contexto del proyecto guardado en el rack del agente."
        : "Exploracion lista, pero no se pudo guardar el rack de archivos en backend.";
    } catch (error) {
      overlayState.statusMessage =
        `Exploracion lista, pero fallo el guardado del rack en backend: ${String(error)}`;
    }
  } catch (error) {
    if (!overlayState.projectAnalysis) {
      overlayState.analysisUnlocked = false;
    }
    overlayState.statusMessage = `No se pudo analizar el explorador: ${String(error)}`;
  } finally {
    overlayState.analysisBusy = false;
    renderOverlay();
  }
}

function pickSignal(context) {
  return toText(context.visibleError)
    || toText(context.selection)
    || toText(context.activityTitle)
    || (toText(context.codeSnippet) ? "Fragmento de codigo detectado" : "")
    || "Sin senales concretas por ahora";
}

function friendlyPageContext(pageContext, pageType) {
  if (pageType === "codespace") return "GitHub / Codespaces";
  if (pageContext === "campus") return "Campus Virtual";
  if (pageContext === "github") return "GitHub";
  return "Pagina abierta";
}

function buildWelcomeText(context, goal) {
  if (context.pageContext === "campus") {
    return `Estas en Campus Virtual. Empezaremos con ${goal.label.toLowerCase()} usando el enunciado y las senales visibles como guia.`;
  }
  if (context.pageType === "codespace") {
    return `Estas programando en Codespaces. Empezaremos con ${goal.label.toLowerCase()} dentro de un cuadro flotante que se queda contigo en la pagina.`;
  }
  if (context.pageType === "github_code") {
    return `Estas en GitHub con un archivo abierto. Empezaremos con ${goal.label.toLowerCase()} tomando ese archivo como punto de partida.`;
  }
  return "Abrire una vista flotante simple para acompanarte paso a paso. Cuando pulses Empezar, reducire la ayuda a lo esencial.";
}

function buildMainStatus(context) {
  if (!overlayState.assistantEnabled) {
    return "El tutor esta pausado. Puedes reactivarlo en configuracion.";
  }
  if (context.pageContext === "campus") {
    return "Campus detectado. La ayuda se enfoca en el enunciado y la senal visible.";
  }
  if (context.pageType === "codespace") {
    return "Codespace detectado. La ayuda se enfoca en el archivo abierto y el siguiente paso.";
  }
  if (context.pageType === "github_code") {
    return "Archivo de GitHub detectado. La ayuda se enfoca en el codigo abierto.";
  }
  if (context.pageType === "github_general") {
    return "Repositorio detectado. Abre un archivo si quieres una pista mas concreta.";
  }
  return "Abre una actividad del piloto o un archivo para recibir ayuda mas contextual.";
}

function parseRepoFullName(value) {
  const text = toText(value)
    .replace(/^https?:\/\/github\.com\//i, "")
    .replace(/\/(tree|blob)\/.*$/i, "")
    .replace(/[?#].*$/g, "")
    .replace(/\.git$/i, "")
    .replace(/^\/+|\/+$/g, "");
  if (!text) return "";

  const match = text.match(/^([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+)$/);
  if (!match) return "";
  return `${match[1]}/${match[2]}`;
}

function detectRepoFromLinks(links) {
  const candidates = Array.isArray(links) ? links : [];
  for (const item of candidates) {
    const href = parseRepoFullName(item?.href || "");
    if (href) return href;
    const text = parseRepoFullName(item?.text || "");
    if (text) return text;
  }
  return "";
}

function inferRepoFromContext(context) {
  const direct = parseRepoFullName(context?.repoFullName || "");
  if (direct) return direct;
  const fromUrl = parseRepoFullName(context?.url || "");
  if (fromUrl) return fromUrl;
  const fromTitle = parseRepoFullName(context?.title || "");
  if (fromTitle) return fromTitle;
  return detectRepoFromLinks(context?.links);
}

function getCurrentRepoFullName() {
  const fromSetup = parseRepoFullName(overlayState.setupRepoFullName);
  if (fromSetup) return fromSetup;
  return inferRepoFromContext(overlayState.context || {});
}

function setSetupRepoFullName(value) {
  overlayState.setupRepoFullName = parseRepoFullName(value);
  if (overlayEls?.setupRepoInput && overlayEls.setupRepoInput.value !== overlayState.setupRepoFullName) {
    overlayEls.setupRepoInput.value = overlayState.setupRepoFullName;
  }
}

function getSetupCompletionKey(repoOverride = "") {
  const userId = getCurrentUserId();
  const repoFullName = parseRepoFullName(repoOverride) || getCurrentRepoFullName();
  if (!userId || !repoFullName) return "";
  return `${userId}:${repoFullName.toLowerCase()}`;
}

function normalizeRepoRelativePath(value) {
  return toText(value)
    .replace(/\\/g, "/")
    .replace(/^\/+/, "")
    .toLowerCase();
}

function hasBootstrapByProjectAnalysis() {
  const analysis = overlayState.projectAnalysis;
  if (!analysis || !Array.isArray(analysis.files)) return false;

  const files = new Set(
    analysis.files
      .map((item) => normalizeRepoRelativePath(item))
      .filter(Boolean),
  );

  const hasDevcontainerJson = files.has(".devcontainer/devcontainer.json");
  const markers = [
    hasDevcontainerJson,
    files.has(".devcontainer/install-extensions.sh"),
    files.has(".vscode/extensions.json"),
  ].filter(Boolean).length;

  return hasDevcontainerJson && markers >= 2;
}

function hasBootstrapByStatusSignals() {
  const signals = overlayState.githubAppStatus?.bootstrapSignals;
  if (!signals || typeof signals !== "object") return false;

  const hasDevcontainerMarker = signals.hasDevcontainerMarker === true;
  const markerCount = [
    signals.hasDevcontainerMarker === true,
    signals.hasInstallScriptMarker === true,
    signals.hasWorkspaceExtensionsMarker === true,
  ].filter(Boolean).length;

  return hasDevcontainerMarker && markerCount >= 2;
}

function hasBootstrapDetectedInTour() {
  return hasServerCompletedSetup()
    || hasBootstrapByStatusSignals()
    || hasBootstrapByProjectAnalysis();
}

function hydrateBootstrapSignalsFromCodespaceExplorer() {
  const context = overlayState.context || buildPayload();
  if (context.pageType !== "codespace") return false;
  if (hasBootstrapByProjectAnalysis()) return true;

  try {
    const entries = extractCodespaceExplorerEntries();
    if (!Array.isArray(entries) || entries.length === 0) return false;

    const analysis = buildCodespaceAnalysis(entries);
    if (!analysis || !Array.isArray(analysis.files)) return false;

    overlayState.projectAnalysis = analysis;
    overlayState.analysisUnlocked = true;
    return hasBootstrapByProjectAnalysis();
  } catch {
    return false;
  }
}

function hasServerCompletedSetup() {
  const status = overlayState.githubAppStatus || EMPTY_GITHUB_APP_STATUS;
  const currentRepo = getCurrentRepoFullName();
  const statusRepo = parseRepoFullName(status.repoFullName);

  if (currentRepo && statusRepo && currentRepo.toLowerCase() !== statusRepo.toLowerCase()) {
    return false;
  }

  return status.bootstrapReady === true;
}

function hasCompletedSetup() {
  if (hasBootstrapDetectedInTour()) {
    return true;
  }

  const userId = getCurrentUserId();
  const key = getSetupCompletionKey();
  if (!userId || !key) return false;
  return overlayState.setupDoneByUser[key] === true || overlayState.setupDoneByUser[userId] === true;
}

async function markSetupCompleted() {
  const key = getSetupCompletionKey();
  if (!key) return;
  overlayState.setupDoneByUser[key] = true;
  await persistPreferences();
}

function clearSetupForCurrentUser() {
  const key = getSetupCompletionKey();
  if (!key) return;
  overlayState.setupDoneByUser[key] = false;
}

function isGithubOrCodespaceContext(context) {
  const pageType = toText(context?.pageType);
  return pageType === "github_code" || pageType === "github_general" || pageType === "codespace";
}

function shouldShowGithubAppSection(context) {
  return isGithubOrCodespaceContext(context);
}

function canCreateBootstrapPr() {
  return !!overlayState.githubAppStatus?.configured
    && !!overlayState.githubAppStatus?.installation
    && overlayState.githubAppStatus?.hasRepoAccess === true
    && !!getCurrentRepoFullName();
}

function getSetupFlowState(context) {
  const repoFullName = getCurrentRepoFullName();
  const status = overlayState.githubAppStatus || EMPTY_GITHUB_APP_STATUS;
  const configured = !!status.configured;
  const explored = !!overlayState.analysisUnlocked;
  const repoReady = !!repoFullName;
  const appConnected = repoReady && !!status.installation;
  const accessVerified = appConnected && status.hasRepoAccess === true;
  const bootstrapDetected = hasBootstrapDetectedInTour();
  const prCreated = accessVerified && bootstrapDetected;

  return {
    configured,
    explored,
    repoReady,
    appConnected,
    accessVerified,
    bootstrapDetected,
    prCreated,
    repoFullName,
    context,
  };
}

function resolveCurrentSetupStep(flow) {
  let step = Number(overlayState.setupWizardStep) || 1;
  step = Math.max(1, Math.min(3, step));

  if (step > 1 && !flow.repoReady) {
    step = 1;
  }
  if (!BYPASS_GITHUB_APP_INSTALL_VALIDATION) {
    if (step > 2 && !flow.accessVerified) {
      step = 2;
    }
    // Temporalmente deshabilitado para pruebas de PR:
    // if (step > 2 && !flow.accessVerified) step = 2;
  }

  overlayState.setupWizardStep = step;
  return step;
}

function buildGithubAppStatusText() {
  const repoFullName = getCurrentRepoFullName();
  const status = overlayState.githubAppStatus || EMPTY_GITHUB_APP_STATUS;

  if (!repoFullName) {
    return "Abre un repositorio de GitHub o Codespaces para conectar la GitHub App.";
  }

  if (!status.configured) {
    return status.missingConfig?.length
      ? `Backend sin configurar GitHub App. Faltan: ${status.missingConfig.join(", ")}.`
      : "Backend sin configurar GitHub App.";
  }

  if (!status.installation) {
    return `Repositorio detectado: ${repoFullName}. Aun no hay instalacion vinculada para este usuario.`;
  }

  const account = status.installation.accountLogin
    ? `Instalada en ${status.installation.accountLogin}`
    : "Instalacion detectada";
  if (status.bootstrapReady === true) {
    return `${account}. ${repoFullName} ya tiene bootstrap ADACEEN detectado.`;
  }
  if (status.hasRepoAccess === true) {
    return `${account}. La app tiene acceso a ${repoFullName}.`;
  }
  if (status.hasRepoAccess === false) {
    return `${account}. La app aun no tiene acceso confirmado a ${repoFullName}.`;
  }
  return `${account}. Verifica acceso con "Actualizar estado".`;
}

function buildSetupStatusText(context, currentStep, flow) {
  const modeLabel = context?.pageType === "codespace"
    ? "Codespaces"
    : context?.pageType === "github_code" || context?.pageType === "github_general"
      ? "GitHub"
      : "fuera de GitHub";

  if (flow.prCreated) {
    return "Tour completado. Ya puedes ir al dashboard principal.";
  }

  if (currentStep === 1) {
    if (!flow.repoReady) {
      return `Contexto detectado: ${modeLabel}. Paso 1/3: confirma el repositorio objetivo.`;
    }
    return `Paso 1/3 listo para ${flow.repoFullName}. Pulsa Siguiente.`;
  }

  if (currentStep === 2) {
    if (!flow.configured) {
      return `Repo objetivo: ${flow.repoFullName}. Falta configurar GitHub App en backend.`;
    }
    if (!flow.appConnected) {
      return `Paso 2/3: conecta la GitHub App para ${flow.repoFullName}.`;
    }
    if (!flow.accessVerified) {
      return `Paso 2/3: verifica acceso de la app al repo ${flow.repoFullName}.`;
    }
    return `Paso 2/3 completado para ${flow.repoFullName}. Pulsa Siguiente.`;
  }

  return `Paso 3/3: crea el PR de devcontainer en ${flow.repoFullName}.`;
}

function hasActiveSession() {
  return !!overlayState.session?.user;
}

function isTeacherSession() {
  return overlayState.session?.user?.role === "teacher";
}

function isAdminSession() {
  return overlayState.session?.user?.role === "admin";
}

function getRoleLabel(role) {
  if (role === "teacher") return "Profesor";
  if (role === "admin") return "Admin";
  return "Estudiante";
}

function getRoleLabelLower(role) {
  if (role === "teacher") return "profesor";
  if (role === "admin") return "admin";
  return "estudiante";
}

function buildTeacherSummary() {
  const settings = overlayState.policy || DEFAULT_POLICY;
  const toneMap = { warm: "calido", direct: "directo", socratic: "socratico" };
  const frequencyMap = { low: "baja", medium: "media", high: "alta" };
  const helpMap = { progressive: "progresiva", hint_only: "solo pistas", partial_example: "ejemplo parcial" };
  const hintLimit = settings.maxHintsPerExercise == null ? "pistas ilimitadas" : `max ${settings.maxHintsPerExercise} pistas`;

  return [
    `${settings.policyName || "Politica docente"}`,
    `tono ${toneMap[settings.tone] || "calido"}`,
    `frecuencia ${frequencyMap[settings.frequency] || "media"}`,
    `ayuda ${helpMap[settings.helpLevel] || "progresiva"}`,
    hintLimit,
    settings.outcome,
  ].join(" | ");
}

function analyzeCodeSignals(codeText) {
  const code = String(codeText || "");
  return {
    todoCount: (code.match(/\b(TODO|FIXME)\b/g) || []).length,
    functionCount: (code.match(/\b(function|def|func|fn|public\s+\w+|private\s+\w+)\b/g) || []).length,
    classCount: (code.match(/\b(class|struct|interface)\b/g) || []).length,
    hasTests: /\b(describe\(|it\(|pytest|unittest|assert\s|@Test)\b/i.test(code),
  };
}

function buildGoalIdeas(context, language, goalId) {
  const ideas = [];

  if (goalId === "encapsulation") {
    ideas.push("Revisa que datos deban quedar protegidos y cuales pueden exponerse.");
    ideas.push("Verifica si tus metodos controlan los cambios de estado.");
  } else if (goalId === "inheritance") {
    ideas.push("Confirma si la relacion entre clases realmente es de tipo es-un.");
    ideas.push("Busca comportamiento comun antes de duplicar codigo.");
  } else if (goalId === "debugging") {
    ideas.push("Aisla primero la linea o bloque donde aparece la falla.");
    ideas.push("Prueba una sola correccion por intento.");
  } else if (goalId === "github_flow") {
    ideas.push("Trabaja en una rama corta para que el cambio sea facil de revisar.");
    ideas.push("Haz commits pequenos que expliquen la intencion.");
  } else {
    ideas.push("Identifica las entidades del problema antes de crear nuevas clases.");
    ideas.push(`Piensa que atributos y metodos necesita tu modelo en ${language}.`);
  }

  if (context.pageContext === "campus") {
    ideas.push("Relaciona cada pista con el enunciado visible antes de cambiar codigo.");
  } else if (context.pageType === "codespace") {
    ideas.push("Aprovecha el editor para probar una mejora pequena de inmediato.");
  } else if (context.pageType === "github_code") {
    ideas.push("Ubica en el archivo actual el bloque exacto que quieres reforzar.");
  } else {
    ideas.push("Abre una actividad o un archivo para recibir pistas mas precisas.");
  }

  return ideas;
}

function buildIdeas(context, language, goalId) {
  const ideas = [];
  const signals = analyzeCodeSignals(context.codeSnippet || "");

  ideas.push(...buildGoalIdeas(context, language, goalId));

  if (signals.todoCount > 0) {
    ideas.push(`Convierte ${signals.todoCount} TODO(s) en un plan corto de trabajo.`);
  }
  if (signals.functionCount >= 12) {
    ideas.push("El archivo se ve cargado. Evalua separar funciones o responsabilidades.");
  }
  if (signals.classCount >= 5) {
    ideas.push("Hay varias clases visibles. Compara responsabilidades antes de crear otra.");
  }
  if (context.codeSnippet && !signals.hasTests && goalId !== "github_flow") {
    ideas.push("Agrega un caso minimo de prueba para validar el siguiente cambio.");
  }

  return unique(ideas).slice(0, MAX_LIST_ITEMS);
}

function buildGuide(goalId, context) {
  if (goalId === "debugging") {
    return [
      "Ubica la primera evidencia concreta del error.",
      "Relaciona esa senal con el bloque o enunciado correspondiente.",
      "Cambia una sola cosa y valida el resultado.",
    ];
  }

  if (goalId === "github_flow") {
    return [
      "Confirma en que rama vas a trabajar.",
      "Haz un cambio pequeno y claro.",
      "Revisa el diff antes de seguir.",
    ];
  }

  if (context.pageContext === "campus") {
    return [
      "Lee entradas, salidas y restricciones del enunciado.",
      "Traduce el problema a una idea de clases o pasos.",
      "Pasa al codigo con una meta pequena y verificable.",
    ];
  }

  return [
    "Define una meta pequena para el archivo actual.",
    "Ubica el bloque donde empezar sin tocar todo a la vez.",
    "Valida el resultado antes del siguiente cambio.",
  ];
}

function buildSummaryBlock(context, language) {
  const status = overlayState.projectContextStatus || EMPTY_PROJECT_CONTEXT_STATUS;
  const insight = overlayState.projectContextInsight || EMPTY_PROJECT_CONTEXT_INSIGHT;
  const connectedVersion = toText(insight.version || status.latestVersion || status.currentVersion);
  const versionLabel = connectedVersion ? `Version ${connectedVersion}` : "Version sin contexto";
  const basePreview = toText(context.codeSnippet)
    || toText(context.selection)
    || toText(context.visibleError)
    || toText(context.activityTitle)
    || toText(context.text).slice(0, MAX_PREVIEW_CHARS);
  const previewChunks = [];
  if (insight.autoAdvice) {
    previewChunks.push(`[Consejo automatico]\n${insight.autoAdvice}`);
  }
  if (basePreview) {
    previewChunks.push(previewChunks.length > 0 ? `[Fragmento]\n${basePreview}` : basePreview);
  }

  return {
    contextLabel: friendlyPageContext(context.pageContext, context.pageType),
    detailTitle: toText(insight.mainFilePath)
      ? `Archivo principal: ${insight.mainFilePath}`
      : (toText(context.activityTitle) || toText(context.filePath) || toText(context.title) || "Sin detalle detectado"),
    detailMeta: `${language} | ${toText(context.repoFullName) || "Sin repositorio"} | ${toText(context.branch) || "Sin rama"} | ${versionLabel}`,
    signal: toText(insight.summary) || pickSignal(context),
    preview: previewChunks.join("\n\n") || "(Sin fragmento detectado)",
  };
}

async function fetchJsonWithTimeout(url, options = {}, timeoutMs = BACKEND_TIMEOUT_MS) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const response = await fetch(url, {
      ...options,
      signal: controller.signal,
    });
    const json = await response.json().catch(() => ({}));
    if (!response.ok) {
      throw new Error(String(json.error || `HTTP ${response.status}`));
    }
    return json;
  } finally {
    clearTimeout(timeout);
  }
}

function buildApiHeaders() {
  return {
    "Content-Type": "application/json; charset=utf-8",
    ...(overlayState.sessionId ? { "x-session-id": overlayState.sessionId } : {}),
  };
}

async function fetchCurrentSession() {
  const baseUrl = normalizeBaseUrl(overlayState.backendUrl);
  if (!baseUrl || !overlayState.sessionId) return false;

  const response = await fetchJsonWithTimeout(`${baseUrl}/api/auth/me`, {
    method: "GET",
    headers: buildApiHeaders(),
  });

  if (!response?.ok || !response?.session) return false;

  overlayState.session = response.session;
  overlayState.policy = response.policy || { ...DEFAULT_POLICY };
  overlayState.telemetry = Array.isArray(response.telemetry) ? response.telemetry : [];
  overlayState.authError = "";
  await persistPreferences();
  return true;
}

async function loginToBackend(email, password) {
  const baseUrl = normalizeBaseUrl(overlayState.backendUrl);
  if (!baseUrl) {
    throw new Error("Configura primero la URL del backend.");
  }

  const response = await fetchJsonWithTimeout(`${baseUrl}/api/auth/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json; charset=utf-8" },
    body: JSON.stringify({ email, password }),
  });

  if (!response?.ok || !response?.session?.id) {
    throw new Error(String(response?.error || "No se pudo iniciar sesion."));
  }

  overlayState.sessionId = response.session.id;
  overlayState.session = response.session;
  overlayState.policy = response.policy || { ...DEFAULT_POLICY };
  overlayState.telemetry = Array.isArray(response.telemetry) ? response.telemetry : [];
  overlayState.authError = "";
  await persistPreferences();
}

async function logoutFromBackend() {
  const baseUrl = normalizeBaseUrl(overlayState.backendUrl);
  try {
    if (baseUrl && overlayState.sessionId) {
      await fetchJsonWithTimeout(`${baseUrl}/api/auth/logout`, {
        method: "POST",
        headers: buildApiHeaders(),
        body: JSON.stringify({}),
      });
    }
  } catch {}

  overlayState.sessionId = "";
  overlayState.session = null;
  overlayState.policy = { ...DEFAULT_POLICY };
  overlayState.telemetry = [];
  overlayState.authError = "";
  await persistPreferences();
}

async function reloadPolicyAndTelemetry() {
  if (!overlayState.sessionId) return;
  const baseUrl = normalizeBaseUrl(overlayState.backendUrl);
  if (!baseUrl) return;

  const response = await fetchJsonWithTimeout(`${baseUrl}/api/policies/current`, {
    method: "GET",
    headers: buildApiHeaders(),
  });

  if (response?.ok) {
    overlayState.policy = response.policy || { ...DEFAULT_POLICY };
    overlayState.telemetry = Array.isArray(response.telemetry) ? response.telemetry : [];
  }
}

async function reloadAdminUsers() {
  const baseUrl = normalizeBaseUrl(overlayState.backendUrl);
  if (!baseUrl || !overlayState.sessionId || !isAdminSession()) {
    overlayState.adminUsers = [];
    overlayState.adminTeachers = [];
    return;
  }

  const response = await fetchJsonWithTimeout(`${baseUrl}/api/admin/users`, {
    method: "GET",
    headers: buildApiHeaders(),
  });

  overlayState.adminUsers = Array.isArray(response?.users) ? response.users : [];
  overlayState.adminTeachers = Array.isArray(response?.teachers) ? response.teachers : [];
}

async function createAdminUserFromForm() {
  if (!overlayEls || !isAdminSession()) return;

  const role = toText(overlayEls.adminCreateRole.value).toLowerCase() === "teacher" ? "teacher" : "student";
  const payload = {
    role,
    displayName: overlayEls.adminCreateName.value.trim(),
    email: overlayEls.adminCreateEmail.value.trim(),
    password: overlayEls.adminCreatePassword.value,
    teacherUserId: role === "student" ? toText(overlayEls.adminCreateTeacher.value) || null : null,
  };

  const baseUrl = normalizeBaseUrl(overlayState.backendUrl);
  if (!baseUrl || !overlayState.sessionId) {
    throw new Error("Sesion no valida para crear usuarios.");
  }

  await fetchJsonWithTimeout(`${baseUrl}/api/admin/users`, {
    method: "POST",
    headers: buildApiHeaders(),
    body: JSON.stringify(payload),
  });

  overlayEls.adminCreatePassword.value = "";
}

async function updateAdminUserRow(rowUserId, data) {
  const baseUrl = normalizeBaseUrl(overlayState.backendUrl);
  if (!baseUrl || !overlayState.sessionId) {
    throw new Error("Sesion no valida para editar usuarios.");
  }

  return fetchJsonWithTimeout(`${baseUrl}/api/admin/users/${encodeURIComponent(rowUserId)}`, {
    method: "PUT",
    headers: buildApiHeaders(),
    body: JSON.stringify(data),
  });
}

async function deleteAdminUser(rowUserId) {
  const baseUrl = normalizeBaseUrl(overlayState.backendUrl);
  if (!baseUrl || !overlayState.sessionId) {
    throw new Error("Sesion no valida para eliminar usuarios.");
  }

  return fetchJsonWithTimeout(`${baseUrl}/api/admin/users/${encodeURIComponent(rowUserId)}`, {
    method: "DELETE",
    headers: buildApiHeaders(),
  });
}

async function fetchProjectConsentStatus() {
  const baseUrl = normalizeBaseUrl(overlayState.backendUrl);
  if (!baseUrl || !overlayState.sessionId) return false;

  const response = await fetchJsonWithTimeout(`${baseUrl}/api/projects/consent`, {
    method: "GET",
    headers: buildApiHeaders(),
  });

  return !!response?.consent?.granted;
}

async function grantProjectConsent() {
  const baseUrl = normalizeBaseUrl(overlayState.backendUrl);
  if (!baseUrl || !overlayState.sessionId) {
    throw new Error("Sesion no valida para registrar permisos.");
  }

  const response = await fetchJsonWithTimeout(`${baseUrl}/api/projects/consent`, {
    method: "POST",
    headers: buildApiHeaders(),
    body: JSON.stringify({
      canRead: true,
      canModify: true,
      canAnalyze: true,
    }),
  });

  return !!response?.consent?.granted;
}

async function ensureProjectConsentForCurrentUser() {
  const userId = getCurrentUserId();
  if (!userId) return false;
  if (overlayState.projectConsentByUser[userId] === true) return true;

  try {
    const grantedRemotely = await fetchProjectConsentStatus();
    if (grantedRemotely) {
      overlayState.projectConsentByUser[userId] = true;
      await persistPreferences();
      return true;
    }
  } catch {}

  const accepted = window.confirm(
    "Dar permiso para leer, modificar y hacer analisis sobre tu entorno?\n\n" +
    "Esto se solicitara solo una vez por usuario para guardar contexto del proyecto.",
  );
  if (!accepted) {
    return false;
  }

  const granted = await grantProjectConsent();
  if (!granted) {
    return false;
  }

  overlayState.projectConsentByUser[userId] = true;
  await persistPreferences();
  return true;
}

async function syncProjectRackToBackend(context, analysis) {
  const baseUrl = normalizeBaseUrl(overlayState.backendUrl);
  if (!baseUrl || !overlayState.sessionId || !analysis) return false;

  const payload = {
    source: toText(context.pageType) || "codespace",
    repoFullName: toText(context.repoFullName),
    branch: toText(context.branch),
    generatedAt: toText(analysis.generatedAt),
    totalEntries: Number(analysis.totalEntries) || 0,
    totalFiles: Number(analysis.totalFiles) || 0,
    totalFolders: Number(analysis.totalFolders) || 0,
    files: Array.isArray(analysis.files) ? analysis.files.slice(0, 10000) : [],
    folders: Array.isArray(analysis.folders) ? analysis.folders.slice(0, 10000) : [],
    activeFilePath: toText(context.filePath),
    activeCodeSnippet: toText(context.codeSnippet).slice(0, 120000),
  };

  const response = await fetchJsonWithTimeout(`${baseUrl}/api/projects/rack`, {
    method: "POST",
    headers: buildApiHeaders(),
    body: JSON.stringify(payload),
  }, 25000);

  return !!response?.ok;
}

async function requestProjectScanFromBackend(repoFullName) {
  const baseUrl = normalizeBaseUrl(overlayState.backendUrl);
  if (!baseUrl || !overlayState.sessionId) return null;
  const cleanRepo = parseRepoFullName(repoFullName);
  if (!cleanRepo) return null;

  return fetchJsonWithTimeout(`${baseUrl}/api/projects/scan/request`, {
    method: "POST",
    headers: buildApiHeaders(),
    body: JSON.stringify({
      repoFullName: cleanRepo,
      source: "dashboard_explore",
    }),
  }, 20000);
}

async function getProjectScanRequestStatus(requestId) {
  const baseUrl = normalizeBaseUrl(overlayState.backendUrl);
  if (!baseUrl || !overlayState.sessionId || !requestId) return null;
  return fetchJsonWithTimeout(`${baseUrl}/api/projects/scan/request/${encodeURIComponent(requestId)}`, {
    method: "GET",
    headers: buildApiHeaders(),
  }, 15000);
}

async function waitForProjectScanCompletion(requestId, timeoutMs = 120000, pollMs = 2500) {
  const startedAt = Date.now();
  while (Date.now() - startedAt <= timeoutMs) {
    const response = await getProjectScanRequestStatus(requestId);
    const status = toText(response?.request?.status).toLowerCase();
    if (status === "completed" || status === "failed") {
      return response;
    }
    await new Promise((resolve) => setTimeout(resolve, pollMs));
  }
  return null;
}

async function refreshGithubAppStatus() {
  const baseUrl = normalizeBaseUrl(overlayState.backendUrl);
  const repoFullName = getCurrentRepoFullName();
  if (!baseUrl || !overlayState.sessionId) {
    overlayState.githubAppStatus = { ...EMPTY_GITHUB_APP_STATUS };
    return;
  }

  const query = repoFullName ? `?repoFullName=${encodeURIComponent(repoFullName)}` : "";
  const response = await fetchJsonWithTimeout(`${baseUrl}/api/github-app/status${query}`, {
    method: "GET",
    headers: buildApiHeaders(),
  });

  overlayState.githubAppStatus = response?.status
    ? { ...EMPTY_GITHUB_APP_STATUS, ...response.status }
    : { ...EMPTY_GITHUB_APP_STATUS };

  if (overlayState.githubAppStatus.bootstrapReady === true) {
    await markSetupCompleted();
  }
}

async function refreshProjectContextStatus() {
  const baseUrl = normalizeBaseUrl(overlayState.backendUrl);
  const repoFullName = getCurrentRepoFullName();
  if (!baseUrl || !overlayState.sessionId || !repoFullName) {
    overlayState.projectContextStatus = { ...EMPTY_PROJECT_CONTEXT_STATUS };
    return;
  }

  const response = await fetchJsonWithTimeout(
    `${baseUrl}/api/projects/context/status?repoFullName=${encodeURIComponent(repoFullName)}`,
    {
      method: "GET",
      headers: buildApiHeaders(),
    },
    15000,
  );

  overlayState.projectContextStatus = {
    ...EMPTY_PROJECT_CONTEXT_STATUS,
    ...normalizeProjectContextStatusPayload(response),
    repoFullName,
  };
}

async function refreshProjectContextHistory() {
  const baseUrl = normalizeBaseUrl(overlayState.backendUrl);
  const repoFullName = getCurrentRepoFullName();
  if (!baseUrl || !overlayState.sessionId || !repoFullName) {
    overlayState.projectContextHistory = [];
    return;
  }

  const response = await fetchJsonWithTimeout(
    `${baseUrl}/api/projects/context/history?repoFullName=${encodeURIComponent(repoFullName)}`,
    {
      method: "GET",
      headers: buildApiHeaders(),
    },
    15000,
  );

  overlayState.projectContextHistory = normalizeProjectContextHistoryPayload(response);
}

async function refreshProjectContextInsight() {
  const baseUrl = normalizeBaseUrl(overlayState.backendUrl);
  const repoFullName = getCurrentRepoFullName();
  if (!baseUrl || !overlayState.sessionId || !repoFullName) {
    overlayState.projectContextInsight = { ...EMPTY_PROJECT_CONTEXT_INSIGHT };
    return;
  }

  const useModel = overlayState.autoConfigEnabled ? "1" : "0";
  const response = await fetchJsonWithTimeout(
    `${baseUrl}/api/projects/context/insight?repoFullName=${encodeURIComponent(repoFullName)}&useModel=${useModel}`,
    {
      method: "GET",
      headers: buildApiHeaders(),
    },
    45000,
  );

  overlayState.projectContextInsight = normalizeProjectContextInsightPayload(response);
}

async function refreshProjectContextPanel() {
  const repoFullName = getCurrentRepoFullName();
  if (!repoFullName) {
    overlayState.projectContextStatus = { ...EMPTY_PROJECT_CONTEXT_STATUS };
    overlayState.projectContextHistory = [];
    overlayState.projectContextInsight = { ...EMPTY_PROJECT_CONTEXT_INSIGHT };
    overlayState.projectContextError = "";
    overlayState.projectContextMessage = "";
    renderOverlay();
    return;
  }

  overlayState.projectContextBusy = true;
  overlayState.projectContextError = "";
  overlayState.projectContextMessage = "Actualizando contexto y rebuilds...";
  renderOverlay();

  try {
    const jobs = [
      refreshProjectContextStatus(),
      refreshProjectContextHistory(),
    ];
    if (overlayState.autoConfigEnabled) {
      jobs.push(refreshProjectContextInsight());
    } else {
      overlayState.projectContextInsight = {
        ...EMPTY_PROJECT_CONTEXT_INSIGHT,
        configured: true,
        repoFullName,
        modelEnabled: false,
        summary: "Configuracion automatica desactivada.",
      };
    }
    await Promise.all(jobs);
    const status = overlayState.projectContextStatus || EMPTY_PROJECT_CONTEXT_STATUS;
    const insight = overlayState.projectContextInsight || EMPTY_PROJECT_CONTEXT_INSIGHT;
    const versionText = insight.version || status.latestVersion || status.currentVersion || "sin version";
    overlayState.projectContextMessage = status.hasContext
      ? `Contexto actualizado para ${repoFullName} (${versionText}).`
      : `Contexto consultado para ${repoFullName}, pero aun no hay versiones guardadas.`;
  } catch (error) {
    overlayState.projectContextError = `No se pudo actualizar el contexto: ${String(error)}`;
  } finally {
    overlayState.projectContextBusy = false;
    renderOverlay();
  }
}

async function applyProjectContextRebuild(requestId = "") {
  const repoFullName = getCurrentRepoFullName();
  const baseUrl = normalizeBaseUrl(overlayState.backendUrl);
  if (!baseUrl || !overlayState.sessionId || !repoFullName) {
    overlayState.projectContextError = "Abre un repositorio y inicia sesion para aplicar rebuild.";
    renderOverlay();
    return;
  }

  overlayState.projectContextBusy = true;
  overlayState.projectContextError = "";
  overlayState.projectContextMessage = requestId
    ? `Aplicando rebuild para ${shortenCompactId(requestId, 12)}...`
    : "Aplicando rebuild para el contexto actual...";
  renderOverlay();

  try {
    await fetchJsonWithTimeout(
      `${baseUrl}/api/projects/context/rebuild`,
      {
        method: "POST",
        headers: buildApiHeaders(),
        body: JSON.stringify({
          repoFullName,
          ...(requestId ? { requestId } : {}),
        }),
      },
      25000,
    );

    await refreshProjectContextPanel();
    overlayState.projectContextMessage = requestId
      ? `Rebuild aplicado para ${shortenCompactId(requestId, 12)}.`
      : `Rebuild aplicado para ${repoFullName}.`;
  } catch (error) {
    overlayState.projectContextError = `No se pudo aplicar rebuild: ${String(error)}`;
  } finally {
    overlayState.projectContextBusy = false;
    renderOverlay();
  }
}

async function autoLinkGithubInstallation(repoFullName) {
  const baseUrl = normalizeBaseUrl(overlayState.backendUrl);
  if (!baseUrl || !overlayState.sessionId) return false;

  try {
    const response = await fetchJsonWithTimeout(`${baseUrl}/api/github-app/link-installation-auto`, {
      method: "POST",
      headers: buildApiHeaders(),
      body: JSON.stringify({ repoFullName }),
    }, 25000);

    return !!response?.ok;
  } catch {
    return false;
  }
}

async function startGithubAppInstallFlow() {
  const repoFullName = getCurrentRepoFullName();
  if (!repoFullName) {
    overlayState.statusMessage = "Abre un repositorio para iniciar instalacion de GitHub App.";
    renderOverlay();
    return;
  }

  const baseUrl = normalizeBaseUrl(overlayState.backendUrl);
  if (!baseUrl || !overlayState.sessionId) {
    overlayState.statusMessage = "Debes iniciar sesion para conectar GitHub App.";
    renderOverlay();
    return;
  }

  overlayState.githubAppBusy = true;
  clearSetupForCurrentUser();
  await persistPreferences();
  overlayState.statusMessage = "Generando enlace de instalacion GitHub App...";
  renderOverlay();

  try {
    const response = await fetchJsonWithTimeout(`${baseUrl}/api/github-app/install-url`, {
      method: "POST",
      headers: buildApiHeaders(),
      body: JSON.stringify({ repoFullName }),
    });

    const installUrl = toText(response?.installUrl);
    if (!installUrl) {
      throw new Error("No se recibio URL de instalacion.");
    }

    window.open(installUrl, "_blank", "noopener,noreferrer");
    overlayState.statusMessage =
      "Se abrio GitHub para instalar la app. Al terminar, vuelve aqui y pulsa 'Actualizar estado'.";
  } catch (error) {
    overlayState.statusMessage = `No se pudo iniciar instalacion GitHub App: ${String(error)}`;
  } finally {
    overlayState.githubAppBusy = false;
    renderOverlay();
  }
}

async function bootstrapDevcontainerWithGithubApp(options = {}) {
  const repoFullName = getCurrentRepoFullName();
  if (!repoFullName) {
    overlayState.statusMessage = "No se detecta repositorio activo para crear el PR.";
    renderOverlay();
    return;
  }

  const baseUrl = normalizeBaseUrl(overlayState.backendUrl);
  if (!baseUrl || !overlayState.sessionId) {
    overlayState.statusMessage = "Debes iniciar sesion para crear el PR.";
    renderOverlay();
    return;
  }

  const force = Boolean(options && options.force);
  overlayState.githubAppBusy = true;
  overlayState.statusMessage = force
    ? "Rehaciendo branch y PR de bootstrap devcontainer..."
    : "Creando branch y PR de bootstrap devcontainer...";
  renderOverlay();

  try {
    const response = await fetchJsonWithTimeout(`${baseUrl}/api/github-app/bootstrap-devcontainer`, {
      method: "POST",
      headers: buildApiHeaders(),
      body: JSON.stringify({
        repoFullName,
        force,
      }),
    }, 35000);

    if (response?.alreadyBootstrapped === true) {
      const existingPullUrl = toText(response?.bootstrap?.pullUrl);
      const existingPullNumber = Number(response?.bootstrap?.pullNumber) || 0;
      const existingReason = toText(response?.reason);
      await markSetupCompleted();
      overlayState.statusMessage = existingPullUrl
        ? `Este repo ya tenia bootstrap (${existingReason || "detectado"}): PR #${existingPullNumber || "?"} ${existingPullUrl}`
        : `Este repo ya estaba bootstrap (${existingReason || "detectado"}).`;
      await refreshGithubAppStatus();
      return;
    }

    const pullUrl = toText(response?.result?.pullUrl);
    const pullNumber = Number(response?.result?.pullNumber) || 0;
    const userId = getCurrentUserId();
    if (userId) {
      overlayState.setupPrResultByUser[userId] = {
        pullUrl,
        pullNumber,
        createdAt: new Date().toISOString(),
      };
    }
    await markSetupCompleted();
    overlayState.statusMessage = pullUrl
      ? `PR ${force ? "rehecho" : "creado"} (#${pullNumber}): ${pullUrl}`
      : `PR de bootstrap ${force ? "rehecho" : "creado"}.`;
    await refreshGithubAppStatus();
  } catch (error) {
    overlayState.statusMessage = `No se pudo ${force ? "rehacer" : "crear"} el PR de bootstrap: ${String(error)}`;
  } finally {
    overlayState.githubAppBusy = false;
    renderOverlay();
  }
}

function normalizeBackendResult(raw, fallbackGuide) {
  const result = raw?.result || {};
  const ideas = unique(Array.isArray(result.ideas) ? result.ideas : []).slice(0, MAX_LIST_ITEMS);
  const guide = unique(Array.isArray(result.guide) ? result.guide : []).slice(0, MAX_LIST_ITEMS);

  return {
    ideas,
    guide: guide.length > 0 ? guide : fallbackGuide,
    welcome: toText(result.welcome_message),
    summary: toText(result.analysis_summary),
  };
}

function buildBackendQuestion(context, language, goal) {
  const settings = overlayState.policy || DEFAULT_POLICY;
  const rule = settings.strictNoSolution
    ? "No entregues la solucion completa."
    : "Prioriza pistas y pasos sobre respuestas completas.";
  const tone = `Tono docente: ${settings.tone}.`;
  const help = `Nivel de ayuda: ${settings.helpLevel}.`;
  const outcome = `Resultado esperado: ${settings.outcome}.`;

  if (context.pageContext === "campus") {
    return `Estoy en Campus Virtual. Quiero reforzar ${goal.label.toLowerCase()}. ${rule} ${tone} ${help} ${outcome} Enfocate en el enunciado, la actividad visible y el error en pantalla.`;
  }
  if (context.pageType === "codespace") {
    return `Estoy programando en Codespaces en ${language}. Quiero reforzar ${goal.label.toLowerCase()}. ${rule} ${tone} ${help} ${outcome} Enfocate en el archivo abierto y el siguiente paso.`;
  }
  if (context.pageType === "github_code") {
    return `Estoy en GitHub con el archivo ${context.filePath || "actual"} en ${language}. Quiero reforzar ${goal.label.toLowerCase()}. ${rule} ${tone} ${help} ${outcome} Enfocate en el codigo abierto.`;
  }
  return `Quiero reforzar ${goal.label.toLowerCase()}. ${rule} ${tone} ${help} ${outcome} Da una orientacion breve y accionable.`;
}

async function requestBackendMentor(context, language) {
  const baseUrl = normalizeBaseUrl(overlayState.backendUrl);
  if (!baseUrl) {
    throw new Error("Base URL vacia.");
  }

  const goal = getLearningGoal(overlayState.selectedLearningGoal);
  const payload = {
    question: buildBackendQuestion(context, language, goal),
    max_items: MAX_LIST_ITEMS,
    context: {
      url: toText(context.url),
      title: toText(context.title),
      pageContext: toText(context.pageContext),
      pageType: toText(context.pageType),
      repoOwner: toText(context.repoOwner),
      repoName: toText(context.repoName),
      repoFullName: toText(context.repoFullName),
      branch: toText(context.branch),
      filePath: toText(context.filePath),
      languageHint: toText(context.languageHint),
      activityTitle: toText(context.activityTitle),
      learningGoal: goal.id,
      selection: toText(context.selection),
      visibleError: toText(context.visibleError),
      codeSnippet: toText(context.codeSnippet),
      codeLineCount: Number(context.codeLineCount) || 0,
    },
  };

  const endpoints = ["/intervene", "/github-mentor"];
  let lastError = null;

  for (const endpoint of endpoints) {
    try {
      const raw = await fetchJsonWithTimeout(`${baseUrl}${endpoint}`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json; charset=utf-8",
          ...(overlayState.sessionId ? { "x-session-id": overlayState.sessionId } : {}),
        },
        body: JSON.stringify(payload),
      });

      if (!raw?.ok) {
        throw new Error(String(raw?.error || "Respuesta invalida."));
      }

      return normalizeBackendResult(raw, buildGuide(goal.id, context));
    } catch (error) {
      lastError = error;
    }
  }

  throw lastError || new Error("Backend no disponible.");
}

function buildOverlayMarkup() {
  return `
    <style>
      :host {
        all: initial;
        position: fixed;
        top: 16px;
        right: 16px;
        z-index: 2147483647;
        font-family: "Trebuchet MS", "Segoe UI", sans-serif;
      }

      * {
        box-sizing: border-box;
      }

      .shell {
        width: min(380px, calc(100vw - 32px));
        color: #173046;
        transition: width 160ms ease;
      }

      .shell.shell-expanded {
        width: min(780px, calc(100vw - 32px));
      }

      .window {
        position: relative;
        display: flex;
        flex-direction: column;
        overflow: hidden;
        max-height: min(760px, calc(100dvh - 32px));
        border: 1px solid #d9cbb4;
        border-radius: 20px;
        background:
          radial-gradient(120% 120% at 0% 0%, #fff7ea 0%, transparent 52%),
          linear-gradient(180deg, #fffaf3 0%, #f5fbf9 100%);
        box-shadow: 0 18px 48px rgba(19, 48, 70, 0.18);
        backdrop-filter: blur(12px);
      }

      .header {
        display: flex;
        align-items: center;
        justify-content: space-between;
        gap: 12px;
        padding: 14px 16px 10px;
        cursor: grab;
      }

      .brand {
        display: flex;
        align-items: center;
        gap: 10px;
      }

      .brand-dot {
        width: 12px;
        height: 12px;
        border-radius: 999px;
        background: linear-gradient(180deg, #c95f30, #94511c);
        box-shadow: 0 0 0 5px rgba(201, 95, 48, 0.12);
      }

      .brand strong {
        display: block;
        font-size: 0.97rem;
        line-height: 1;
        max-width: 190px;
        white-space: nowrap;
        overflow: hidden;
        text-overflow: ellipsis;
      }

      .brand span {
        display: block;
        color: #61707f;
        font-size: 0.7rem;
        margin-top: 3px;
      }

      .header-actions {
        display: flex;
        gap: 8px;
      }

      .icon-button {
        display: inline-flex;
        align-items: center;
        justify-content: center;
        width: 34px;
        height: 34px;
        border: 1px solid #e5d5bd;
        border-radius: 999px;
        background: #fff8ef;
        color: #173046;
        cursor: pointer;
      }

      .icon-button.text-button {
        width: auto;
        min-width: 34px;
        padding: 0 10px;
        border-radius: 999px;
        font-size: 0.72rem;
        font-weight: 700;
      }

      .body {
        flex: 1 1 auto;
        min-height: 0;
        overflow: auto;
        overscroll-behavior: contain;
        padding: 0 16px 16px;
      }

      .view[hidden] {
        display: none;
      }

      .pill {
        display: inline-flex;
        align-items: center;
        padding: 5px 10px;
        border-radius: 999px;
        background: #edf8f5;
        border: 1px solid #c6e6dc;
        color: #0f766e;
        font-size: 0.68rem;
        font-weight: 700;
        text-transform: uppercase;
        letter-spacing: 0.05em;
      }

      .role-pill {
        background: #fff4e8;
        border-color: #edc7a8;
        color: #9a4a1e;
      }

      h1 {
        margin: 12px 0 8px;
        font-size: 1.15rem;
        line-height: 1.15;
      }

      h2 {
        margin: 0 0 8px;
        font-size: 0.84rem;
      }

      p {
        margin: 0;
        line-height: 1.45;
      }

      .copy {
        color: #516070;
        font-size: 0.8rem;
      }

      .primary-button,
      .ghost-button,
      .save-button {
        width: 100%;
        border: 0;
        border-radius: 14px;
        cursor: pointer;
        font-weight: 700;
        font-size: 0.84rem;
        padding: 12px 14px;
      }

      .primary-button,
      .save-button {
        color: #fff;
        background: linear-gradient(180deg, #c65c2b, #8d3813);
      }

      .ghost-button {
        color: #173046;
        background: #f6ede0;
        border: 1px solid #e3d1b5;
      }

      .button-row {
        display: grid;
        gap: 10px;
        margin-top: 16px;
      }

      .button-row.split {
        grid-template-columns: 1fr 1fr;
      }

      .auth-card {
        border: 1px solid #e8d9c3;
        border-radius: 16px;
        background: rgba(255, 251, 245, 0.92);
        padding: 12px;
        margin-top: 12px;
      }

      .segmented {
        display: grid;
        grid-template-columns: repeat(2, 1fr);
        gap: 8px;
        margin-top: 14px;
      }

      .segment-button {
        border: 1px solid #e6d5bd;
        border-radius: 14px;
        background: #fff9f0;
        color: #173046;
        cursor: pointer;
        padding: 10px;
        text-align: center;
        font-size: 0.76rem;
        font-weight: 700;
      }

      .segment-button.is-selected {
        border-color: #c65c2b;
        background: #fff1e5;
        box-shadow: 0 10px 18px rgba(198, 92, 43, 0.12);
      }

      .main-top {
        display: flex;
        align-items: center;
        justify-content: space-between;
        gap: 10px;
        margin-bottom: 12px;
      }

      .main-top .ghost-button {
        width: auto;
        padding: 9px 12px;
        font-size: 0.76rem;
      }

      .summary-card,
      .teacher-card,
      .panel-section,
      .preview-card {
        border: 1px solid #e8d9c3;
        border-radius: 16px;
        background: rgba(255, 251, 245, 0.92);
        padding: 12px;
      }

      .summary-card,
      .teacher-card,
      .panel-section {
        margin-bottom: 12px;
      }

      .summary-head {
        display: flex;
        align-items: center;
        justify-content: space-between;
        gap: 8px;
      }

      .analyze-button {
        width: auto;
        padding: 7px 10px;
        font-size: 0.72rem;
      }

      .teacher-card {
        background: linear-gradient(180deg, #eef9f6 0%, #f7fcfb 100%);
        border-color: #d1ebe3;
        margin-bottom: 8px;
      }

      .eyebrow {
        display: block;
        margin-bottom: 6px;
        color: #0f766e;
        font-size: 0.68rem;
        font-weight: 800;
        letter-spacing: 0.08em;
        text-transform: uppercase;
      }

      .summary-title {
        font-size: 0.9rem;
        line-height: 1.25;
        margin-bottom: 6px;
      }

      .summary-meta {
        color: #667482;
        font-size: 0.72rem;
        margin-bottom: 8px;
      }

      .signal {
        color: #294355;
        font-size: 0.78rem;
      }

      .teacher-summary {
        color: #315467;
        font-size: 0.75rem;
      }

      .policy-lead {
        margin-top: 8px;
        color: #315467;
        font-size: 0.75rem;
      }

      .session-badge {
        margin-top: 10px;
        padding: 8px 10px;
        border-radius: 12px;
        background: #fff7ed;
        border: 1px solid #ecd6bd;
        color: #4a5c69;
        font-size: 0.74rem;
      }

      .teacher-only[hidden],
      .settings-role-block[hidden] {
        display: none;
      }

      .compact-list,
      .telemetry-list {
        list-style: none;
        padding-left: 0 !important;
      }

      .compact-list li,
      .telemetry-list li {
        padding: 8px 10px;
        border-radius: 12px;
        border: 1px solid #ebddca;
        background: #fffdf8;
      }

      .telemetry-list li strong {
        display: block;
        margin-bottom: 3px;
      }

      .telemetry-list li span {
        display: block;
        color: #667482;
        font-size: 0.7rem;
      }

      .goal-grid {
        display: grid;
        grid-template-columns: repeat(2, minmax(0, 1fr));
        gap: 8px;
      }

      .goal-button {
        border: 1px solid #e6d5bd;
        border-radius: 14px;
        background: #fff9f0;
        color: #173046;
        cursor: pointer;
        padding: 10px;
        text-align: left;
        font-size: 0.74rem;
        line-height: 1.3;
      }

      .goal-button.is-selected {
        border-color: #c65c2b;
        background: #fff1e5;
        box-shadow: 0 10px 18px rgba(198, 92, 43, 0.12);
      }

      .panel-section ul,
      .panel-section ol {
        margin: 0;
        padding-left: 18px;
        display: grid;
        gap: 6px;
        color: #30485b;
        font-size: 0.78rem;
        line-height: 1.4;
      }

      .admin-table-wrap {
        overflow: auto;
        border: 1px solid #eadcc8;
        border-radius: 12px;
        background: #fffdf8;
      }

      .admin-table {
        width: 100%;
        min-width: 640px;
        border-collapse: collapse;
      }

      .admin-table th,
      .admin-table td {
        border-bottom: 1px solid #f0e4d2;
        padding: 8px;
        text-align: left;
        vertical-align: middle;
        font-size: 0.72rem;
      }

      .admin-table th {
        font-size: 0.7rem;
        letter-spacing: 0.03em;
        text-transform: uppercase;
        color: #5f6f7e;
        background: #fff7ee;
      }

      .admin-table td input,
      .admin-table td select {
        width: 100%;
        border: 1px solid #dccab0;
        border-radius: 10px;
        padding: 7px 8px;
        font-size: 0.72rem;
        background: #fffefb;
      }

      .admin-actions-cell {
        display: flex;
        gap: 6px;
      }

      .admin-actions-cell .ghost-button,
      .admin-actions-cell .save-button {
        width: auto;
        padding: 7px 9px;
        font-size: 0.7rem;
      }

      details summary {
        cursor: pointer;
        font-weight: 700;
        font-size: 0.78rem;
        color: #25465a;
      }

      pre {
        margin: 10px 0 0;
        max-height: 160px;
        overflow: auto;
        border-radius: 12px;
        background: #fffdf8;
        border: 1px solid #eadcc8;
        padding: 10px;
        white-space: pre-wrap;
        word-break: break-word;
        font-size: 0.72rem;
        line-height: 1.4;
      }

      .status {
        min-height: 18px;
        margin-top: 12px;
        color: #667482;
        font-size: 0.74rem;
        line-height: 1.35;
      }

      .settings-panel {
        position: absolute;
        inset: 0;
        padding: 16px;
        overflow: auto;
        background: rgba(255, 249, 239, 0.98);
        backdrop-filter: blur(10px);
        transform: translateX(101%);
        transition: transform 160ms ease;
        display: flex;
        flex-direction: column;
        gap: 12px;
      }

      .window.settings-open .settings-panel {
        transform: translateX(0);
      }

      .settings-head {
        display: flex;
        align-items: center;
        justify-content: space-between;
        gap: 10px;
      }

      .settings-note {
        color: #62707d;
        font-size: 0.76rem;
        line-height: 1.4;
      }

      .settings-grid {
        display: grid;
        gap: 10px;
        overflow: auto;
      }

      .settings-subcard {
        border: 1px solid #e3d1b8;
        border-radius: 16px;
        background: rgba(255, 249, 241, 0.9);
        padding: 12px;
        display: grid;
        gap: 10px;
      }

      .settings-subhead {
        display: flex;
        align-items: flex-start;
        justify-content: space-between;
        gap: 10px;
      }

      .settings-subhead h3 {
        margin: 0 0 4px;
        font-size: 0.86rem;
        line-height: 1.2;
      }

      .settings-subhead .ghost-button {
        width: auto;
        padding: 8px 10px;
        font-size: 0.74rem;
        white-space: nowrap;
      }

      .settings-kv-grid {
        display: grid;
        grid-template-columns: repeat(2, minmax(0, 1fr));
        gap: 8px;
      }

      .settings-kv {
        border: 1px solid #eadcc8;
        border-radius: 12px;
        background: #fffdf8;
        padding: 9px 10px;
        display: grid;
        gap: 4px;
      }

      .settings-kv span {
        color: #6a7885;
        font-size: 0.68rem;
        font-weight: 800;
        letter-spacing: 0.04em;
        text-transform: uppercase;
      }

      .settings-kv strong {
        color: #173046;
        font-size: 0.78rem;
        line-height: 1.3;
        word-break: break-word;
      }

      .settings-history-list {
        list-style: none;
        padding-left: 0 !important;
        display: grid;
        gap: 8px;
      }

      .settings-history-item {
        border: 1px solid #eadcc8;
        border-radius: 14px;
        background: #fffdf8;
        padding: 10px;
        display: grid;
        gap: 8px;
      }

      .settings-history-top {
        display: flex;
        align-items: flex-start;
        justify-content: space-between;
        gap: 10px;
      }

      .settings-history-title {
        margin: 0;
        color: #173046;
        font-size: 0.78rem;
        font-weight: 800;
        line-height: 1.3;
      }

      .settings-history-meta {
        margin-top: 3px;
        color: #667482;
        font-size: 0.7rem;
        line-height: 1.35;
      }

      .settings-history-item .ghost-button,
      .settings-history-item .save-button {
        width: auto;
        padding: 8px 10px;
        font-size: 0.72rem;
      }

      .settings-history-empty {
        margin: 0;
        color: #667482;
        font-size: 0.74rem;
        line-height: 1.35;
      }

      .field {
        display: grid;
        gap: 6px;
      }

      .field label {
        color: #526272;
        font-size: 0.73rem;
        font-weight: 700;
      }

      .field select,
      .field input[type="text"],
      .field input[type="password"],
      .field input[type="number"],
      .field textarea {
        width: 100%;
        border: 1px solid #dccab0;
        border-radius: 12px;
        background: #fffdf8;
        color: #173046;
        padding: 10px;
        font: inherit;
        font-size: 0.78rem;
        outline: none;
      }

      .field textarea {
        resize: vertical;
        min-height: 76px;
      }

      .switch-row {
        display: flex;
        align-items: center;
        justify-content: space-between;
        gap: 10px;
        padding: 10px 12px;
        border: 1px solid #e7d7c0;
        border-radius: 14px;
        background: #fffdf8;
        color: #344d5f;
        font-size: 0.76rem;
      }

      .switch-row input {
        width: 18px;
        height: 18px;
      }

      .check-grid {
        display: grid;
        gap: 8px;
      }

      .check-item {
        display: flex;
        align-items: center;
        justify-content: space-between;
        gap: 8px;
        padding: 9px 11px;
        border: 1px solid #eadbc7;
        border-radius: 12px;
        background: #fffdf8;
        font-size: 0.75rem;
      }

      .analysis-window {
        position: absolute;
        inset: 58px 14px 14px;
        border: 1px solid #d8c4a9;
        border-radius: 16px;
        background: rgba(255, 250, 242, 0.98);
        box-shadow: 0 14px 28px rgba(39, 34, 28, 0.2);
        display: flex;
        flex-direction: column;
        z-index: 8;
      }

      .analysis-window[hidden] {
        display: none;
      }

      .analysis-head {
        display: flex;
        align-items: flex-start;
        justify-content: space-between;
        gap: 12px;
        border-bottom: 1px solid #e7d6c1;
        padding: 12px 12px 10px;
      }

      .analysis-head strong {
        display: block;
        color: #173046;
        font-size: 0.83rem;
      }

      .analysis-meta {
        margin-top: 4px;
        color: #5f6d79;
        font-size: 0.72rem;
        line-height: 1.35;
      }

      .analysis-body {
        padding: 10px 12px 12px;
        overflow: auto;
      }

      .analysis-tree {
        list-style: none;
        margin: 0;
        padding-left: 0 !important;
        display: grid;
        gap: 6px;
      }

      .analysis-tree li {
        border: 1px solid #ecdcc7;
        border-radius: 10px;
        background: #fffefb;
        padding: 7px 9px;
        color: #243d4f;
        font-size: 0.72rem;
        line-height: 1.35;
        font-family: Consolas, "Courier New", monospace;
      }

      @media (max-width: 640px) {
        :host {
          right: 12px;
          left: 12px;
          bottom: 12px;
        }

        .shell {
          width: 100%;
        }

        .shell.shell-expanded {
          width: 100%;
        }

        .goal-grid {
          grid-template-columns: 1fr;
        }

        .button-row.split,
        .segmented {
          grid-template-columns: 1fr;
        }

        .analysis-window {
          inset: 54px 10px 10px;
        }
      }
    </style>

    <div class="shell" id="shell">
      <div class="window" id="window">
        <header class="header" id="dragHandle">
          <div class="brand">
            <span class="brand-dot"></span>
            <div>
              <strong id="headerUserTitle">ADACEEN</strong>
              <span id="headerUserSubtitle">overlay de aprendizaje</span>
            </div>
          </div>
          <div class="header-actions">
            <button class="icon-button" id="settingsBtn" type="button" aria-label="Configuracion">&#9881;</button>
            <button class="icon-button text-button" id="logoutHeaderBtn" type="button" aria-label="Salir">Salir</button>
            <button class="icon-button" id="closeBtn" type="button" aria-label="Salir">&times;</button>
          </div>
        </header>

        <div class="body">
          <section class="view" id="welcomeView">
            <span class="pill" id="welcomeContext">Contexto</span>
            <h1>Bienvenido</h1>
            <p class="copy" id="welcomeCopy">Abriremos una vista flotante simple para acompanarte paso a paso.</p>
            <p class="policy-lead">Despues de pulsar Empezar se mostrara el inicio de sesion.</p>
            <div class="button-row">
              <button class="primary-button" id="startBtn" type="button">Empezar</button>
            </div>
          </section>

          <section class="view" id="authView" hidden>
            <span class="pill">Acceso</span>
            <h1>Inicia sesion</h1>
            <p class="copy">Ingresa tus credenciales. El sistema detecta automaticamente si eres estudiante, profesor o admin.</p>
            <div class="auth-card">
              <div class="field">
                <label for="authEmail">Correo</label>
                <input id="authEmail" type="text" placeholder="usuario@adaceen.edu.co" />
              </div>
              <div class="field">
                <label for="authPassword">Contrasena</label>
                <input id="authPassword" type="password" placeholder="Ingresa tu contrasena" />
              </div>
              <p class="settings-note" id="authHelper">
                Demo estudiante: estudiante@adaceen.edu.co / Estudiante123!<br />
                Demo profesor: docente@adaceen.edu.co / Docente123!<br />
                Demo admin: admin@adaceen.edu.co / Admin123!
              </p>
              <p class="status" id="authError"></p>
            </div>
            <div class="button-row split">
              <button class="ghost-button" id="authBackBtn" type="button">Volver</button>
              <button class="primary-button" id="authSubmitBtn" type="button">Entrar</button>
            </div>
          </section>

          <section class="view" id="setupView" hidden>
            <span class="pill">Configuracion inicial</span>
            <h1>Tour de inicio</h1>
            <p class="copy">Antes del dashboard, conectaremos GitHub App y crearemos el PR del archivo devcontainer.json en este mismo repositorio.</p>
            <div class="summary-card" id="setupStepOneCard" style="margin-top:12px;">
              <span class="eyebrow">Paso 1 de 3</span>
              <h2 style="margin:0 0 8px;">Detectar repositorio</h2>
              <div class="field">
                <label for="setupRepoInput">Repositorio objetivo (owner/repo o URL)</label>
                <input id="setupRepoInput" type="text" placeholder="ejemplo: eydersantiago/finagent o https://github.com/eydersantiago/finagent" />
              </div>
              <div class="button-row split" style="margin-top:10px;">
                <button class="ghost-button" id="setupExploreBtn" type="button">Explorar proyecto</button>
                <button class="ghost-button" id="setupDetectRepoBtn" type="button">Detectar repo</button>
              </div>
              <div class="button-row" style="margin-top:10px;">
                <button class="primary-button" id="setupToStep2Btn" type="button">Siguiente: instalar app</button>
              </div>
            </div>

            <div class="summary-card" id="setupStepTwoCard" style="margin-top:12px;" hidden>
              <span class="eyebrow">Paso 2 de 3</span>
              <h2 style="margin:0 0 8px;">Instalar y verificar GitHub App</h2>
              <div class="button-row split" style="margin-top:10px;">
                <button class="ghost-button" id="setupInstallAppBtn" type="button">Conectar GitHub App</button>
                <button class="ghost-button" id="setupRefreshAppBtn" type="button">Verificar acceso / Actualizar estado</button>
              </div>
              <div class="button-row split" style="margin-top:10px;">
                <button class="ghost-button" id="setupBackToStep1Btn" type="button">Volver</button>
                <button class="primary-button" id="setupToStep3Btn" type="button">Siguiente: crear PR</button>
              </div>
            </div>

            <div class="summary-card" id="setupStepThreeCard" style="margin-top:12px;" hidden>
              <span class="eyebrow">Paso 3 de 3</span>
              <h2 style="margin:0 0 8px;">Crear PR en el repositorio objetivo</h2>
              <div class="button-row" style="margin-top:10px;">
                <button class="save-button" id="setupCreatePrBtn" type="button">Crear PR en este repositorio</button>
              </div>
              <div class="button-row split" style="margin-top:10px;">
                <button class="ghost-button" id="setupBackToStep2Btn" type="button">Volver</button>
                <button class="primary-button" id="setupContinueBtn" type="button">Ir al dashboard</button>
              </div>
            </div>

            <p class="status" id="setupStatusText">Paso 1/3: detecta o confirma el repositorio objetivo.</p>
            <div class="button-row">
              <button class="ghost-button" id="setupLogoutBtn" type="button">Cerrar sesion</button>
            </div>
          </section>

          <section class="view" id="mainView" hidden>
            <div class="main-top">
              <div style="display:flex; gap:8px; flex-wrap:wrap;">
                <span class="pill" id="mainContext">Contexto</span>
                <span class="pill role-pill" id="roleBadge">Rol</span>
              </div>
              <div style="display:flex; gap:8px; flex-wrap:wrap;">
                <button class="ghost-button" id="refreshBtn" type="button" style="width:auto; padding:9px 12px; font-size:0.76rem;">Actualizar</button>
              </div>
            </div>

            <div class="teacher-card">
              <span class="eyebrow" id="policySectionTitle">Politica aplicada</span>
              <p class="teacher-summary" id="teacherSummary">Docente: tono calido | frecuencia media | ayuda progresiva | RA1</p>
            </div>

            <div class="summary-card">
              <div class="summary-head">
                <span class="eyebrow">Resumen de sesion</span>
                <button class="ghost-button analyze-button" id="analyzeProjectBtn" type="button">Explorar proyecto</button>
              </div>
              <div class="summary-title" id="detailTitle">Sin detalle detectado</div>
              <div class="summary-meta" id="detailMeta">Sin contexto</div>
              <p class="signal" id="signalText">Sin senales detectadas.</p>
              <p class="policy-lead" id="policyLead">La politica activa aparecera aqui.</p>
              <p class="session-badge" id="sessionBadge">Sesion sin iniciar.</p>
            </div>

            <section class="panel-section" id="adminUsersSection" hidden>
              <div class="summary-head" style="margin-bottom:8px;">
                <span class="eyebrow" style="margin-bottom:0;">Administracion de usuarios</span>
                <button class="ghost-button analyze-button" id="adminReloadUsersBtn" type="button">Recargar</button>
              </div>
              <p class="policy-lead" id="adminUsersStatus">Carga los usuarios para empezar.</p>

              <div class="field" style="margin-top:10px;">
                <label for="adminCreateRole">Agregar usuario</label>
                <div class="button-row split" style="margin-top:0;">
                  <select id="adminCreateRole">
                    <option value="student">Estudiante</option>
                    <option value="teacher">Profesor</option>
                  </select>
                  <input id="adminCreateName" type="text" placeholder="Nombre completo" />
                </div>
                <div class="button-row split" style="margin-top:0;">
                  <input id="adminCreateEmail" type="text" placeholder="correo@adaceen.edu.co" />
                  <input id="adminCreatePassword" type="password" placeholder="Contrasena temporal" />
                </div>
                <div class="button-row split" style="margin-top:0;">
                  <select id="adminCreateTeacher">
                    <option value="">Profesor por defecto</option>
                  </select>
                  <button class="save-button" id="adminCreateBtn" type="button">Crear usuario</button>
                </div>
              </div>

              <div class="admin-table-wrap" style="margin-top:10px;">
                <table class="admin-table">
                  <thead>
                    <tr>
                      <th>Nombre</th>
                      <th>Correo</th>
                      <th>Rol</th>
                      <th>Profesor</th>
                      <th>Estado</th>
                      <th>Acciones</th>
                    </tr>
                  </thead>
                  <tbody id="adminUsersTableBody"></tbody>
                </table>
              </div>
            </section>

            <section class="panel-section" id="studentGoalSection">
              <h2>Hoy quiero reforzar</h2>
              <div class="goal-grid" id="goalGrid"></div>
            </section>

            <section class="panel-section" id="studentIdeasSection">
              <h2>Pistas de hoy</h2>
              <ul id="ideaList"></ul>
            </section>

            <section class="panel-section" id="nextStepSection">
              <h2>Siguiente paso</h2>
              <ol id="guideList"></ol>
            </section>

            <section class="panel-section teacher-only" id="teacherPolicySection" hidden>
              <h2>Politica docente</h2>
              <ul class="compact-list" id="teacherPolicyList"></ul>
            </section>

            <section class="panel-section teacher-only" id="teacherTelemetrySection" hidden>
              <div style="display:flex; align-items:center; justify-content:space-between; gap:8px; margin-bottom:8px;">
                <h2 style="margin:0;">Telemetria reciente</h2>
                <button class="ghost-button" id="reloadTelemetryBtn" type="button" style="width:auto; padding:8px 10px; font-size:0.74rem;">Recargar</button>
              </div>
              <ul class="telemetry-list" id="telemetryList"></ul>
            </section>

            <div class="preview-card" id="previewSection">
              <details>
                <summary>Ver fragmento detectado</summary>
                <pre id="previewText">(Sin fragmento detectado)</pre>
              </details>
            </div>

            <p class="status" id="statusText"></p>
          </section>
        </div>

        <aside class="settings-panel" id="settingsPanel">
          <div class="settings-head">
            <div>
              <strong>Configuracion</strong>
              <p class="settings-note">El profesor ajusta la politica RF-05 y el estudiante conserva solo opciones tecnicas y de sesion.</p>
            </div>
            <button class="icon-button" id="settingsCloseBtn" type="button" aria-label="Cerrar">&times;</button>
          </div>

          <div class="settings-grid">
            <div class="field">
              <label for="settingsSessionLabel">Sesion</label>
              <input id="settingsSessionLabel" type="text" readonly />
            </div>

            <div class="field">
              <label for="settingsSessionMeta">Detalle de sesion</label>
              <textarea id="settingsSessionMeta" readonly></textarea>
            </div>

            <div class="switch-row">
              <span>Tutor activo</span>
              <input id="teacherEnabled" type="checkbox" />
            </div>

            <div class="switch-row">
              <span>Configuracion automatica (archivo principal)</span>
              <input id="autoConfigEnabled" type="checkbox" />
            </div>

            <div class="field">
              <label for="backendUrlInput">Base URL del backend</label>
              <input id="backendUrlInput" type="text" placeholder="http://127.0.0.1:3000" />
            </div>

            <div class="settings-role-block" id="advancedGithubBlock" hidden>
              <div class="field">
                <label>Ajustes avanzados GitHub App</label>
                <p class="settings-note" id="advancedGithubNote">
                  Si necesitas forzar una nueva rama/PR de bootstrap para este repo, hazlo desde aquí.
                </p>
                <div class="button-row" style="margin-top:8px;">
                  <button class="save-button" id="githubAppBootstrapBtn" type="button">Rehacer PR devcontainer</button>
                </div>
              </div>

              <section class="settings-subcard" id="githubAppSection">
                <div class="settings-subhead">
                  <div>
                    <h3>GitHub App estable</h3>
                    <p class="settings-note" id="githubAppStatusText">Abre un repositorio para conectar la app.</p>
                  </div>
                  <div style="display:flex; gap:8px; flex-wrap:wrap; justify-content:flex-end; margin-top:0;">
                    <button class="ghost-button" id="githubAppInstallBtn" type="button">Conectar App</button>
                    <button class="ghost-button" id="githubAppRefreshBtn" type="button">Actualizar estado</button>
                  </div>
                </div>
              </section>

              <section class="settings-subcard" id="projectContextStatusSection">
                <div class="settings-subhead">
                  <div>
                    <h3>Contexto y versiones</h3>
                    <p class="settings-note" id="projectContextStatusText">Consulta el contexto guardado para este repositorio.</p>
                  </div>
                  <button class="ghost-button" id="projectContextRefreshBtn" type="button">Refrescar estado</button>
                </div>
                <div class="settings-kv-grid" id="projectContextKvGrid">
                  <div class="settings-kv">
                    <span>Estado</span>
                    <strong id="projectContextReadyValue">Sin datos</strong>
                  </div>
                  <div class="settings-kv">
                    <span>Versión</span>
                    <strong id="projectContextVersionValue">Sin datos</strong>
                  </div>
                  <div class="settings-kv">
                    <span>Request</span>
                    <strong id="projectContextRequestValue">Sin datos</strong>
                  </div>
                  <div class="settings-kv">
                    <span>Snapshot</span>
                    <strong id="projectContextSnapshotValue">Sin datos</strong>
                  </div>
                  <div class="settings-kv">
                    <span>Actualizado</span>
                    <strong id="projectContextUpdatedValue">Sin datos</strong>
                  </div>
                  <div class="settings-kv">
                    <span>Fuente</span>
                    <strong id="projectContextSourceValue">Sin datos</strong>
                  </div>
                </div>
              </section>

              <section class="settings-subcard" id="projectContextHistorySection">
                <div class="settings-subhead">
                  <div>
                    <h3>Historial de rebuilds</h3>
                    <p class="settings-note" id="projectContextHistoryText">Versiones guardadas para este repositorio.</p>
                  </div>
                  <button class="ghost-button" id="projectContextHistoryRefreshBtn" type="button">Recargar historial</button>
                </div>
                <ul class="settings-history-list" id="projectContextHistoryList"></ul>
              </section>
            </div>

            <div class="settings-role-block" id="teacherSettingsBlock" hidden>
              <div class="field">
                <label for="teacherPolicyName">Nombre de la politica</label>
                <input id="teacherPolicyName" type="text" placeholder="RF-05 base del piloto" />
              </div>

            <div class="field">
              <label for="teacherOutcome">Resultado de aprendizaje</label>
              <select id="teacherOutcome">
                <option value="RA1">RA1</option>
                <option value="RA2">RA2</option>
                <option value="RA3">RA3</option>
              </select>
            </div>

            <div class="field">
              <label for="teacherTone">Tono del tutor</label>
              <select id="teacherTone">
                <option value="warm">Calido</option>
                <option value="direct">Directo</option>
                <option value="socratic">Socratico</option>
              </select>
            </div>

            <div class="field">
              <label for="teacherFrequency">Frecuencia de intervencion</label>
              <select id="teacherFrequency">
                <option value="low">Baja</option>
                <option value="medium">Media</option>
                <option value="high">Alta</option>
              </select>
            </div>

            <div class="field">
              <label for="teacherHelpLevel">Nivel de ayuda</label>
              <select id="teacherHelpLevel">
                <option value="progressive">Progresiva</option>
                <option value="hint_only">Solo pistas</option>
                <option value="partial_example">Ejemplo parcial</option>
              </select>
            </div>

            <div class="switch-row">
              <span>Permitir mini quiz</span>
              <input id="teacherMiniQuiz" type="checkbox" />
            </div>

            <div class="switch-row">
              <span>Bloquear solucion completa</span>
              <input id="teacherNoSolution" type="checkbox" />
            </div>

            <div class="field">
              <label for="teacherMaxHints">Maximo de pistas por ejercicio</label>
              <input id="teacherMaxHints" type="number" min="1" step="1" placeholder="3" />
            </div>

            <div class="field">
              <label>Intervenciones habilitadas</label>
              <div class="check-grid">
                <label class="check-item"><span>Explicacion</span><input id="teacherAllowExplanation" type="checkbox" /></label>
                <label class="check-item"><span>Pista</span><input id="teacherAllowHint" type="checkbox" /></label>
                <label class="check-item"><span>Ejemplo parcial</span><input id="teacherAllowExample" type="checkbox" /></label>
                <label class="check-item"><span>Mini quiz</span><input id="teacherAllowMiniQuizType" type="checkbox" /></label>
              </div>
            </div>

            <div class="field">
              <label for="teacherFallbackMessage">Mensaje controlado</label>
              <textarea id="teacherFallbackMessage" placeholder="Mensaje ante falta de contexto o consulta fuera del dominio."></textarea>
            </div>

            <div class="field">
              <label for="teacherCustomInstruction">Nota docente</label>
              <textarea id="teacherCustomInstruction" placeholder="Ejemplo: prioriza preguntas orientadoras y no des codigo completo."></textarea>
            </div>
            </div>
          </div>

          <div class="button-row">
            <button class="ghost-button" id="logoutSettingsBtn" type="button">Cerrar sesion</button>
            <button class="save-button" id="saveSettingsBtn" type="button">Guardar cambios</button>
          </div>
        </aside>

        <section class="analysis-window" id="analysisWindow" hidden>
          <div class="analysis-head">
            <div>
              <strong>Analisis de archivos en Codespaces</strong>
              <p class="analysis-meta" id="analysisStats">Pulsa Explorar proyecto para leer archivos y carpetas del explorador.</p>
            </div>
            <button class="icon-button" id="analysisCloseBtn" type="button" aria-label="Cerrar analisis">&times;</button>
          </div>
          <div class="analysis-body">
            <ul class="analysis-tree" id="analysisFileList"></ul>
          </div>
        </section>
      </div>
    </div>
  `;
}

function renderGoalButtons() {
  if (!overlayEls?.goalGrid) return;

  overlayEls.goalGrid.textContent = "";
  const fragment = document.createDocumentFragment();

  for (const goal of LEARNING_GOALS) {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "goal-button";
    button.dataset.goalId = goal.id;
    button.textContent = goal.label;
    button.classList.toggle("is-selected", goal.id === overlayState.selectedLearningGoal);
    button.addEventListener("click", async () => {
      overlayState.selectedLearningGoal = goal.id;
      await persistPreferences();
      renderGoalButtons();
      if (overlayState.started) {
        await refreshMentorSession();
      } else {
        renderOverlay();
      }
    });

    fragment.appendChild(button);
  }

  overlayEls.goalGrid.appendChild(fragment);
}

function renderTeacherPolicyList() {
  if (!overlayEls?.teacherPolicyList) return;
  const policy = overlayState.policy || DEFAULT_POLICY;
  fillList(overlayEls.teacherPolicyList, [
    `Nombre: ${policy.policyName || DEFAULT_POLICY.policyName}`,
    `Resultado: ${policy.outcome || DEFAULT_POLICY.outcome}`,
    `Nivel de ayuda: ${policy.helpLevel || DEFAULT_POLICY.helpLevel}`,
    `Maximo de pistas por ejercicio: ${policy.maxHintsPerExercise == null ? "Ilimitado" : policy.maxHintsPerExercise}`,
    `Intervenciones: ${(policy.allowedInterventions || DEFAULT_POLICY.allowedInterventions).join(", ")}`,
  ]);
}

function renderTelemetryList() {
  if (!overlayEls?.telemetryList) return;

  overlayEls.telemetryList.textContent = "";
  const items = Array.isArray(overlayState.telemetry) ? overlayState.telemetry : [];

  if (items.length === 0) {
    const li = document.createElement("li");
    li.textContent = "Aun no hay intervenciones registradas.";
    overlayEls.telemetryList.appendChild(li);
    return;
  }

  const fragment = document.createDocumentFragment();
  for (const item of items) {
    const li = document.createElement("li");
    const title = document.createElement("strong");
    const meta = document.createElement("span");
    const detail = document.createElement("span");

    title.textContent = `${item.studentName || "Estudiante"} | ${item.eventType}`;
    meta.textContent = `${item.policyName} | ${item.interventionType} | ${new Date(item.createdAt).toLocaleString()}`;
    detail.textContent = item.reason || item.contextSummary || "Intervencion registrada.";

    li.appendChild(title);
    li.appendChild(meta);
    li.appendChild(detail);
    fragment.appendChild(li);
  }

  overlayEls.telemetryList.appendChild(fragment);
}

function shortenCompactId(value, max = 10) {
  const text = toText(value);
  if (!text) return "";
  if (text.length <= max) return text;
  return `${text.slice(0, max)}…`;
}

function formatProjectContextTimestamp(value) {
  const text = toText(value);
  if (!text) return "Sin datos";
  const date = new Date(text);
  if (Number.isNaN(date.getTime())) return text;
  return date.toLocaleString();
}

function normalizeProjectContextStatusPayload(payload) {
  const source = payload?.status || payload?.context || payload || {};
  return {
    configured: !!source.configured,
    repoFullName: toText(source.repoFullName || source.repo_full_name || source.repo || ""),
    hasContext: !!(source.hasContext ?? source.contextReady ?? source.ready ?? source.available),
    latestRequestId: toText(source.latestRequestId || source.requestId || source.latest_request_id || source.currentRequestId || ""),
    latestSnapshotId: toText(source.latestSnapshotId || source.snapshotId || source.latest_snapshot_id || ""),
    latestVersion: toText(source.latestVersion || source.version || source.versionLabel || source.latest_version || ""),
    currentVersion: toText(source.currentVersion || source.current_version || source.versionName || ""),
    updatedAt: toText(source.updatedAt || source.updated_at || source.lastUpdatedAt || source.last_updated_at || ""),
    source: toText(source.source || source.contextSource || source.latestSource || ""),
    summary: toText(source.summary || source.message || source.description || ""),
    details: toText(source.details || source.note || source.extra || ""),
    totalVersions: Math.max(0, Number(source.totalVersions || source.total_versions || source.historyCount || 0) || 0),
    requestStatus: toText(source.requestStatus || source.status || ""),
  };
}

function normalizeProjectContextHistoryPayload(payload) {
  const source = payload?.history || payload?.items || payload?.versions || payload?.rebuilds || payload || [];
  const items = Array.isArray(source) ? source : [];

  return items.map((item) => ({
    requestId: toText(item?.requestId || item?.request_id || item?.id || ""),
    snapshotId: toText(item?.snapshotId || item?.snapshot_id || ""),
    version: toText(item?.version || item?.versionLabel || item?.label || item?.name || ""),
    status: toText(item?.status || item?.state || ""),
    summary: toText(item?.summary || item?.message || item?.description || ""),
    updatedAt: toText(item?.updatedAt || item?.updated_at || item?.createdAt || item?.created_at || ""),
    source: toText(item?.source || item?.origin || ""),
    canRebuild: item?.canRebuild !== false,
  }));
}

function normalizeProjectContextInsightPayload(payload) {
  const source = payload?.insight || payload?.data || payload || {};
  const rawCandidates = Array.isArray(source.candidates) ? source.candidates : [];
  return {
    ...EMPTY_PROJECT_CONTEXT_INSIGHT,
    configured: source.configured !== false,
    repoFullName: toText(source.repoFullName || source.repo_full_name || source.repo || ""),
    hasContext: !!(source.hasContext ?? source.ready ?? source.available),
    requestId: toText(source.requestId || source.request_id || ""),
    snapshotId: toText(source.snapshotId || source.snapshot_id || ""),
    version: toText(source.version || source.latestVersion || ""),
    currentVersion: toText(source.currentVersion || source.current_version || ""),
    source: toText(source.source || ""),
    updatedAt: toText(source.updatedAt || source.updated_at || ""),
    totalFiles: Math.max(0, Number(source.totalFiles || source.total_files || 0) || 0),
    totalBytes: Math.max(0, Number(source.totalBytes || source.total_bytes || 0) || 0),
    summary: toText(source.summary || ""),
    mainFilePath: toText(source.mainFilePath || source.main_file_path || ""),
    mainFileReason: toText(source.mainFileReason || source.main_file_reason || source.reason || ""),
    autoAdvice: toText(source.autoAdvice || source.auto_advice || source.advice || ""),
    modelEnabled: source.modelEnabled !== false,
    modelUsed: source.modelUsed === true,
    modelProvider: toText(source.modelProvider || source.model_provider || ""),
    candidates: rawCandidates
      .map((candidate) => ({
        path: toText(candidate?.path),
        score: Number(candidate?.score) || 0,
        reason: toText(candidate?.reason),
      }))
      .filter((candidate) => !!candidate.path)
      .slice(0, 5),
    modelError: toText(source.modelError || source.model_error || ""),
    storageReadError: toText(source.storageReadError || source.storage_read_error || ""),
  };
}

function buildProjectContextStatusText() {
  const repoFullName = getCurrentRepoFullName();
  const status = overlayState.projectContextStatus || EMPTY_PROJECT_CONTEXT_STATUS;
  const insight = overlayState.projectContextInsight || EMPTY_PROJECT_CONTEXT_INSIGHT;

  if (!repoFullName) {
    return "Abre un repositorio para consultar contexto y versiones.";
  }

  if (!status.configured) {
    return "El backend aun no expone el estado de contexto para este repositorio.";
  }

  if (!status.hasContext) {
    return status.summary || "Aun no se ha guardado contexto para este repo.";
  }

  const parts = [];
  const versionText = insight.version || status.latestVersion || status.currentVersion;
  if (versionText) parts.push(`Version ${versionText}`);
  if (status.latestRequestId) parts.push(`Request ${shortenCompactId(status.latestRequestId)}`);
  if (status.latestSnapshotId) parts.push(`Snapshot ${shortenCompactId(status.latestSnapshotId)}`);
  if (status.updatedAt) parts.push(`Actualizado ${formatProjectContextTimestamp(status.updatedAt)}`);
  if (status.source) parts.push(`Fuente ${status.source}`);
  if (insight.mainFilePath) parts.push(`Principal ${insight.mainFilePath}`);
  if (insight.modelUsed) parts.push(`IA ${insight.modelProvider || "local"}`);
  if (!insight.modelEnabled) parts.push("IA desactivada");
  if (insight.autoAdvice) parts.push(truncateText(insight.autoAdvice, 120));
  if (status.summary) parts.push(status.summary);

  return parts.join(" | ") || "Contexto listo para rebuild.";
}

function buildProjectContextHistoryText() {
  const repoFullName = getCurrentRepoFullName();
  const history = Array.isArray(overlayState.projectContextHistory) ? overlayState.projectContextHistory : [];

  if (!repoFullName) {
    return "Abre un repositorio para ver el historial de rebuilds.";
  }

  if (history.length === 0) {
    return "Aun no hay rebuilds guardados para este repositorio.";
  }

  return `${history.length} version${history.length === 1 ? "" : "es"} guardada${history.length === 1 ? "" : "s"} para este repo.`;
}

function renderProjectContextSettings() {
  if (!overlayEls) return;

  const status = overlayState.projectContextStatus || EMPTY_PROJECT_CONTEXT_STATUS;
  const insight = overlayState.projectContextInsight || EMPTY_PROJECT_CONTEXT_INSIGHT;
  const history = Array.isArray(overlayState.projectContextHistory) ? overlayState.projectContextHistory : [];
  const busy = !!overlayState.projectContextBusy;
  const errorMessage = overlayState.projectContextError || "";
  const noticeMessage = overlayState.projectContextMessage || "";
  const insightExtra = [
    insight.summary ? `Resumen: ${insight.summary}` : "",
    insight.mainFilePath ? `Archivo principal: ${insight.mainFilePath}` : "",
    insight.autoAdvice ? `Consejo: ${insight.autoAdvice}` : "",
    insight.modelError ? `IA: ${insight.modelError}` : "",
  ].filter(Boolean).join(" | ");

  overlayEls.projectContextStatusText.textContent = errorMessage || noticeMessage || buildProjectContextStatusText();
  overlayEls.projectContextHistoryText.textContent = errorMessage || noticeMessage || buildProjectContextHistoryText();
  if (!errorMessage && !noticeMessage && insightExtra) {
    overlayEls.projectContextStatusText.textContent = `${overlayEls.projectContextStatusText.textContent} | ${truncateText(insightExtra, 360)}`;
  }
  overlayEls.projectContextReadyValue.textContent = status.hasContext ? "Contexto listo" : (status.configured ? "Pendiente" : "Sin datos");
  overlayEls.projectContextVersionValue.textContent = insight.version || status.latestVersion || status.currentVersion || "Sin datos";
  overlayEls.projectContextRequestValue.textContent = status.latestRequestId ? shortenCompactId(status.latestRequestId, 12) : "Sin datos";
  overlayEls.projectContextSnapshotValue.textContent = status.latestSnapshotId ? shortenCompactId(status.latestSnapshotId, 12) : "Sin datos";
  overlayEls.projectContextUpdatedValue.textContent = (insight.updatedAt || status.updatedAt)
    ? formatProjectContextTimestamp(insight.updatedAt || status.updatedAt)
    : "Sin datos";
  overlayEls.projectContextSourceValue.textContent = insight.modelEnabled
    ? `${status.source || insight.source || "Sin datos"}${insight.modelProvider ? ` | ${insight.modelProvider}` : ""}`
    : `${status.source || insight.source || "Sin datos"} | IA OFF`;

  overlayEls.projectContextRefreshBtn.disabled = busy || !getCurrentRepoFullName();
  overlayEls.projectContextHistoryRefreshBtn.disabled = busy || !getCurrentRepoFullName();

  overlayEls.projectContextHistoryList.textContent = "";
  if (history.length === 0) {
    const li = document.createElement("li");
    li.className = "settings-history-item";
    const p = document.createElement("p");
    p.className = "settings-history-empty";
    p.textContent = getCurrentRepoFullName()
      ? "No hay versiones guardadas aun. Usa Refrescar estado para verificar o genera un rebuild."
      : "Abre un repositorio para cargar historial.";
    li.appendChild(p);
    overlayEls.projectContextHistoryList.appendChild(li);
    return;
  }

  const fragment = document.createDocumentFragment();
  history.forEach((item, index) => {
    const li = document.createElement("li");
    li.className = "settings-history-item";

    const top = document.createElement("div");
    top.className = "settings-history-top";

    const left = document.createElement("div");
    const title = document.createElement("p");
    title.className = "settings-history-title";
    title.textContent = item.version || `Version ${history.length - index}`;

    const meta = document.createElement("div");
    meta.className = "settings-history-meta";
    const metaParts = [];
    if (item.status) metaParts.push(item.status);
    if (item.snapshotId) metaParts.push(`Snapshot ${shortenCompactId(item.snapshotId, 12)}`);
    if (item.requestId) metaParts.push(`Request ${shortenCompactId(item.requestId, 12)}`);
    if (item.updatedAt) metaParts.push(formatProjectContextTimestamp(item.updatedAt));
    if (item.source) metaParts.push(item.source);
    meta.textContent = metaParts.length > 0 ? metaParts.join(" | ") : "Version disponible para aplicar rebuild.";

    left.appendChild(title);
    left.appendChild(meta);

    const action = document.createElement("button");
    action.type = "button";
    action.className = "save-button";
    action.textContent = "Aplicar rebuild";
    action.disabled = busy || !item.canRebuild || !getCurrentRepoFullName();
    action.addEventListener("click", async () => {
      await applyProjectContextRebuild(item.requestId);
    });

    top.appendChild(left);
    top.appendChild(action);

    li.appendChild(top);
    if (item.summary) {
      const summary = document.createElement("p");
      summary.className = "settings-note";
      summary.textContent = item.summary;
      li.appendChild(summary);
    }

    fragment.appendChild(li);
  });

  overlayEls.projectContextHistoryList.appendChild(fragment);
}

function renderAdminUsersTable() {
  if (!overlayEls) return;
  if (!isAdminSession()) {
    overlayEls.adminUsersSection.hidden = true;
    return;
  }

  const users = Array.isArray(overlayState.adminUsers) ? overlayState.adminUsers : [];
  const teachers = Array.isArray(overlayState.adminTeachers) ? overlayState.adminTeachers : [];
  const busy = !!overlayState.adminUsersBusy;

  overlayEls.adminUsersSection.hidden = false;
  overlayEls.adminUsersStatus.textContent = overlayState.adminUsersMessage
    || `Gestiona estudiantes y profesores (${users.length} usuario${users.length === 1 ? "" : "s"}).`;
  overlayEls.adminReloadUsersBtn.disabled = busy;
  overlayEls.adminCreateBtn.disabled = busy;

  overlayEls.adminCreateTeacher.disabled = overlayEls.adminCreateRole.value !== "student";
  overlayEls.adminCreateTeacher.innerHTML = "";
  const emptyTeacherOption = document.createElement("option");
  emptyTeacherOption.value = "";
  emptyTeacherOption.textContent = teachers.length > 0
    ? "Asignar profesor (opcional)"
    : "Sin profesores activos";
  overlayEls.adminCreateTeacher.appendChild(emptyTeacherOption);
  for (const teacher of teachers) {
    const option = document.createElement("option");
    option.value = toText(teacher.id);
    option.textContent = `${toText(teacher.displayName)} (${toText(teacher.email)})`;
    overlayEls.adminCreateTeacher.appendChild(option);
  }

  overlayEls.adminUsersTableBody.textContent = "";
  if (users.length === 0) {
    const row = document.createElement("tr");
    const cell = document.createElement("td");
    cell.colSpan = 6;
    cell.textContent = "No hay usuarios administrables.";
    row.appendChild(cell);
    overlayEls.adminUsersTableBody.appendChild(row);
    return;
  }

  const fragment = document.createDocumentFragment();
  users.forEach((user) => {
    const row = document.createElement("tr");
    const role = toText(user.role).toLowerCase() === "teacher" ? "teacher" : "student";

    const nameCell = document.createElement("td");
    const nameInput = document.createElement("input");
    nameInput.type = "text";
    nameInput.value = toText(user.displayName);
    nameInput.disabled = busy;
    nameCell.appendChild(nameInput);

    const emailCell = document.createElement("td");
    const emailInput = document.createElement("input");
    emailInput.type = "text";
    emailInput.value = toText(user.email);
    emailInput.disabled = busy;
    emailCell.appendChild(emailInput);

    const roleCell = document.createElement("td");
    const roleSelect = document.createElement("select");
    roleSelect.disabled = busy;
    [
      { value: "student", label: "Estudiante" },
      { value: "teacher", label: "Profesor" },
    ].forEach((item) => {
      const option = document.createElement("option");
      option.value = item.value;
      option.textContent = item.label;
      if (item.value === role) option.selected = true;
      roleSelect.appendChild(option);
    });
    roleCell.appendChild(roleSelect);

    const teacherCell = document.createElement("td");
    const teacherSelect = document.createElement("select");
    teacherSelect.disabled = busy || roleSelect.value !== "student";
    const emptyOption = document.createElement("option");
    emptyOption.value = "";
    emptyOption.textContent = "Profesor por defecto";
    teacherSelect.appendChild(emptyOption);
    for (const teacher of teachers) {
      const option = document.createElement("option");
      option.value = toText(teacher.id);
      option.textContent = toText(teacher.displayName);
      if (toText(user.teacherUserId) === option.value) option.selected = true;
      teacherSelect.appendChild(option);
    }
    teacherCell.appendChild(teacherSelect);

    roleSelect.addEventListener("change", () => {
      teacherSelect.disabled = busy || roleSelect.value !== "student";
      if (roleSelect.value !== "student") {
        teacherSelect.value = "";
      }
    });

    const statusCell = document.createElement("td");
    statusCell.textContent = user.isActive === false ? "Inactivo" : "Activo";

    const actionsCell = document.createElement("td");
    actionsCell.className = "admin-actions-cell";
    const saveBtn = document.createElement("button");
    saveBtn.type = "button";
    saveBtn.className = "ghost-button";
    saveBtn.textContent = "Guardar";
    saveBtn.disabled = busy;

    const deleteBtn = document.createElement("button");
    deleteBtn.type = "button";
    deleteBtn.className = "save-button";
    deleteBtn.textContent = "Eliminar";
    deleteBtn.disabled = busy || user.isActive === false;

    saveBtn.addEventListener("click", async () => {
      overlayState.adminUsersBusy = true;
      overlayState.adminUsersMessage = `Guardando cambios de ${toText(user.displayName)}...`;
      renderOverlay();
      try {
        const payload = {
          role: roleSelect.value === "teacher" ? "teacher" : "student",
          displayName: nameInput.value.trim(),
          email: emailInput.value.trim(),
          teacherUserId: roleSelect.value === "student" ? (toText(teacherSelect.value) || null) : null,
        };
        const typedPassword = window.prompt(
          "Nueva contraseña (opcional). Deja vacio para conservar la actual.",
          "",
        );
        if (typedPassword !== null && typedPassword.trim().length > 0) {
          payload.password = typedPassword.trim();
        }
        await updateAdminUserRow(toText(user.id), payload);
        await reloadAdminUsers();
        overlayState.adminUsersMessage = "Usuario actualizado.";
      } catch (error) {
        overlayState.adminUsersMessage = `No se pudo actualizar: ${String(error)}`;
      } finally {
        overlayState.adminUsersBusy = false;
        renderOverlay();
      }
    });

    deleteBtn.addEventListener("click", async () => {
      const confirmed = window.confirm(`Se desactivara el usuario ${toText(user.displayName)}. Deseas continuar?`);
      if (!confirmed) return;
      overlayState.adminUsersBusy = true;
      overlayState.adminUsersMessage = `Desactivando ${toText(user.displayName)}...`;
      renderOverlay();
      try {
        await deleteAdminUser(toText(user.id));
        await reloadAdminUsers();
        overlayState.adminUsersMessage = "Usuario desactivado.";
      } catch (error) {
        overlayState.adminUsersMessage = `No se pudo eliminar: ${String(error)}`;
      } finally {
        overlayState.adminUsersBusy = false;
        renderOverlay();
      }
    });

    actionsCell.appendChild(saveBtn);
    actionsCell.appendChild(deleteBtn);

    row.appendChild(nameCell);
    row.appendChild(emailCell);
    row.appendChild(roleCell);
    row.appendChild(teacherCell);
    row.appendChild(statusCell);
    row.appendChild(actionsCell);
    fragment.appendChild(row);
  });

  overlayEls.adminUsersTableBody.appendChild(fragment);
}

function syncSettingsInputs() {
  if (!overlayEls) return;

  const policy = overlayState.policy || DEFAULT_POLICY;
  overlayEls.teacherEnabled.checked = !!overlayState.assistantEnabled;
  overlayEls.autoConfigEnabled.checked = !!overlayState.autoConfigEnabled;
  overlayEls.backendUrlInput.value = overlayState.backendUrl;
  overlayEls.settingsSessionLabel.value = overlayState.session?.user?.displayName || "Sesion sin iniciar";
  overlayEls.settingsSessionMeta.value = overlayState.session
    ? `${getRoleLabel(overlayState.session.user.role)} | ${overlayState.session.user.email}`
    : "Inicia sesion para activar roles, politicas y telemetria.";
  overlayEls.teacherSettingsBlock.hidden = !isTeacherSession();

  if (!isTeacherSession()) return;

  overlayEls.teacherPolicyName.value = policy.policyName || DEFAULT_POLICY.policyName;
  overlayEls.teacherOutcome.value = policy.outcome || DEFAULT_POLICY.outcome;
  overlayEls.teacherTone.value = policy.tone || DEFAULT_POLICY.tone;
  overlayEls.teacherFrequency.value = policy.frequency || DEFAULT_POLICY.frequency;
  overlayEls.teacherHelpLevel.value = policy.helpLevel || DEFAULT_POLICY.helpLevel;
  overlayEls.teacherMiniQuiz.checked = !!policy.allowMiniQuiz;
  overlayEls.teacherNoSolution.checked = !!policy.strictNoSolution;
  overlayEls.teacherMaxHints.value = policy.maxHintsPerExercise == null ? "" : String(policy.maxHintsPerExercise);
  overlayEls.teacherAllowExplanation.checked = (policy.allowedInterventions || []).includes("explanation");
  overlayEls.teacherAllowHint.checked = (policy.allowedInterventions || []).includes("hint");
  overlayEls.teacherAllowExample.checked = (policy.allowedInterventions || []).includes("example");
  overlayEls.teacherAllowMiniQuizType.checked = (policy.allowedInterventions || []).includes("mini_quiz");
  overlayEls.teacherFallbackMessage.value = policy.fallbackMessage || DEFAULT_POLICY.fallbackMessage;
  overlayEls.teacherCustomInstruction.value = policy.customInstruction || "";
}

function setSettingsOpen(nextValue) {
  overlayState.settingsOpen = !!nextValue;
  if (overlayEls?.window) {
    overlayEls.window.classList.toggle("settings-open", overlayState.settingsOpen);
  }
  scheduleOverlayViewportSync(true);
}

async function saveSettingsFromOverlay() {
  overlayState.assistantEnabled = !!overlayEls.teacherEnabled.checked;
  overlayState.autoConfigEnabled = !!overlayEls.autoConfigEnabled.checked;
  overlayState.backendUrl = normalizeBaseUrl(overlayEls.backendUrlInput.value) || DEFAULT_BACKEND_URL;
  await persistPreferences();

  if (isTeacherSession() && overlayState.sessionId) {
    const allowedInterventions = [
      overlayEls.teacherAllowExplanation.checked ? "explanation" : "",
      overlayEls.teacherAllowHint.checked ? "hint" : "",
      overlayEls.teacherAllowExample.checked ? "example" : "",
      overlayEls.teacherAllowMiniQuizType.checked ? "mini_quiz" : "",
    ].filter(Boolean);

    const nextPolicy = {
      policyName: overlayEls.teacherPolicyName.value.trim() || DEFAULT_POLICY.policyName,
      outcome: overlayEls.teacherOutcome.value,
      tone: overlayEls.teacherTone.value,
      frequency: overlayEls.teacherFrequency.value,
      helpLevel: overlayEls.teacherHelpLevel.value,
      allowMiniQuiz: !!overlayEls.teacherMiniQuiz.checked,
      strictNoSolution: !!overlayEls.teacherNoSolution.checked,
      maxHintsPerExercise: overlayEls.teacherMaxHints.value
        ? Math.max(1, Number(overlayEls.teacherMaxHints.value) || DEFAULT_POLICY.maxHintsPerExercise)
        : null,
      fallbackMessage: overlayEls.teacherFallbackMessage.value.trim() || DEFAULT_POLICY.fallbackMessage,
      customInstruction: overlayEls.teacherCustomInstruction.value.trim(),
      allowedInterventions: allowedInterventions.length > 0
        ? allowedInterventions
        : DEFAULT_POLICY.allowedInterventions,
    };

    try {
      const response = await fetchJsonWithTimeout(`${normalizeBaseUrl(overlayState.backendUrl)}/api/policies/current`, {
        method: "PUT",
        headers: buildApiHeaders(),
        body: JSON.stringify(nextPolicy),
      });
      overlayState.policy = response.policy || overlayState.policy;
      overlayState.telemetry = Array.isArray(response.telemetry) ? response.telemetry : overlayState.telemetry;
      overlayState.statusMessage = "Politica docente guardada.";
    } catch (error) {
      overlayState.statusMessage = `No se pudo guardar la politica: ${String(error)}`;
    }
  } else {
    overlayState.statusMessage = "Preferencias tecnicas guardadas.";
  }

  setSettingsOpen(false);
  renderOverlay();

  if (overlayState.started && hasActiveSession()) {
    await refreshMentorSession();
  }
}

function renderOverlay() {
  if (!overlayEls) return;

  const context = overlayState.context || buildPayload();
  const goal = getLearningGoal(overlayState.selectedLearningGoal);
  const language = inferLanguage(context.filePath, context.languageHint);
  const summary = buildSummaryBlock(context, language);
  const welcome = overlayState.welcome || buildWelcomeText(context, goal);
  const sectionsUnlocked = overlayState.analysisUnlocked;
  const showGithubAppSection = shouldShowGithubAppSection(context);
  const githubAppStatusText = buildGithubAppStatusText();
  const githubConfigured = !!overlayState.githubAppStatus?.configured;
  const githubInstallation = overlayState.githubAppStatus?.installation;
  const githubHasRepoAccess = overlayState.githubAppStatus?.hasRepoAccess === true;
  const statusText = overlayState.loading
    ? "Preparando contexto..."
    : overlayState.statusMessage
      || (sectionsUnlocked ? buildMainStatus(context) : "Explora el proyecto para habilitar las secciones de ayuda.");
  const showingAuthView = overlayState.started && !hasActiveSession();
  const setupRequired = isGithubOrCodespaceContext(context);
  const showingSetupView = overlayState.started
    && hasActiveSession()
    && !isAdminSession()
    && setupRequired
    && !hasCompletedSetup();
  const showingMainView = overlayState.started && hasActiveSession() && !showingSetupView;
  const showAdvancedGithubBlock = hasActiveSession() && showingMainView && showGithubAppSection;
  const currentRole = getRoleLabel(overlayState.session?.user?.role);
  const setupFlow = getSetupFlowState(context);
  const setupCurrentStep = resolveCurrentSetupStep(setupFlow);
  const setupStatusText = showingSetupView && overlayState.statusMessage
    ? overlayState.statusMessage
    : buildSetupStatusText(context, setupCurrentStep, setupFlow);
  const setupRepoFullName = getCurrentRepoFullName();
  const insight = overlayState.projectContextInsight || EMPTY_PROJECT_CONTEXT_INSIGHT;
  const status = overlayState.projectContextStatus || EMPTY_PROJECT_CONTEXT_STATUS;
  const connectedVersion = toText(insight.version || status.latestVersion || status.currentVersion);
  const insightLineParts = [];
  if (!overlayState.autoConfigEnabled) {
    insightLineParts.push("Configuracion automatica desactivada.");
  } else {
    if (insight.mainFilePath) {
      insightLineParts.push(`Archivo principal: ${insight.mainFilePath}.`);
    }
    if (insight.autoAdvice) {
      insightLineParts.push(`Consejo: ${insight.autoAdvice}`);
    }
  }
  const insightLine = insightLineParts.join(" ");

  overlayEls.welcomeView.hidden = overlayState.started;
  overlayEls.authView.hidden = !showingAuthView;
  overlayEls.setupView.hidden = !showingSetupView;
  overlayEls.mainView.hidden = !showingMainView;
  overlayEls.adminUsersSection.hidden = !showingMainView || !isAdminSession();
  overlayEls.shell.classList.toggle("shell-expanded", showingMainView);

  overlayEls.welcomeContext.textContent = summary.contextLabel;
  overlayEls.welcomeCopy.textContent = welcome;
  overlayEls.mainContext.textContent = summary.contextLabel;
  overlayEls.headerUserTitle.textContent = overlayState.session?.user?.displayName || "ADACEEN";
  overlayEls.headerUserSubtitle.textContent = overlayState.session
    ? `${currentRole} | overlay de aprendizaje`
    : "overlay de aprendizaje";
  overlayEls.roleBadge.textContent = currentRole;
  overlayEls.detailTitle.textContent = summary.detailTitle;
  overlayEls.detailMeta.textContent = summary.detailMeta;
  overlayEls.signalText.textContent = summary.signal;
  overlayEls.previewText.textContent = summary.preview;
  const policyLeadBase = isTeacherSession()
    ? "Estas viendo y administrando la politica activa del piloto."
    : (isAdminSession()
      ? "Como admin puedes gestionar estudiantes/profesores aqui. Si necesitas GitHub App o PR, hazlo manualmente desde Configuracion."
      : "La ayuda del estudiante sigue la politica configurada por el docente.");
  overlayEls.policyLead.textContent = insightLine
    ? `${policyLeadBase} ${insightLine}`
    : policyLeadBase;
  overlayEls.sessionBadge.textContent = overlayState.session
    ? `${overlayState.session.user.displayName} | ${currentRole} | ${overlayState.session.user.email}`
      + (connectedVersion ? ` | Version ${connectedVersion}` : " | Version sin contexto")
    : "Sesion sin iniciar.";
  overlayEls.policySectionTitle.textContent = isTeacherSession()
    ? "Politica aplicada"
    : (isAdminSession() ? "Panel administrador" : "Mis parametros asignados");
  overlayEls.teacherSummary.textContent = isAdminSession()
    ? "Admin: crea, edita o desactiva usuarios con rol estudiante/profesor."
    : buildTeacherSummary();
  overlayEls.statusText.textContent = statusText;
  overlayEls.authError.textContent = overlayState.authError || "";
  overlayEls.startBtn.disabled = overlayState.loading;
  overlayEls.refreshBtn.disabled = overlayState.loading || !overlayState.assistantEnabled || !showingMainView;
  overlayEls.logoutHeaderBtn.disabled = !hasActiveSession();
  overlayEls.analyzeProjectBtn.disabled = overlayState.analysisBusy || !showingMainView;
  overlayEls.githubAppStatusText.textContent = githubAppStatusText;
  overlayEls.githubAppInstallBtn.disabled = overlayState.githubAppBusy || !githubConfigured || !hasActiveSession() || !setupRepoFullName;
  overlayEls.githubAppRefreshBtn.disabled = overlayState.githubAppBusy || !hasActiveSession();
  overlayEls.advancedGithubBlock.hidden = !showAdvancedGithubBlock;
  overlayEls.advancedGithubNote.textContent = showAdvancedGithubBlock
    ? `Repositorio actual: ${setupRepoFullName || "sin detectar"}. Usa esta opción solo si necesitas rehacer el PR de bootstrap.`
    : "Disponible cuando abras un repositorio GitHub/Codespaces con sesión activa.";
  overlayEls.githubAppBootstrapBtn.disabled = !showAdvancedGithubBlock
    || overlayState.githubAppBusy
    || !githubConfigured
    || !githubInstallation
    || !githubHasRepoAccess;
  overlayEls.setupStatusText.textContent = setupStatusText;
  overlayEls.setupStepOneCard.hidden = !showingSetupView || setupCurrentStep !== 1;
  overlayEls.setupStepTwoCard.hidden = !showingSetupView || setupCurrentStep !== 2;
  overlayEls.setupStepThreeCard.hidden = !showingSetupView || setupCurrentStep !== 3;
  if (!overlayEls.setupRepoInput.matches(":focus")) {
    overlayEls.setupRepoInput.value = setupRepoFullName;
  }
  overlayEls.setupExploreBtn.disabled = overlayState.analysisBusy || !showingSetupView || setupCurrentStep !== 1;
  overlayEls.setupDetectRepoBtn.disabled = !showingSetupView || setupCurrentStep !== 1 || overlayState.githubAppBusy;
  overlayEls.setupToStep2Btn.disabled = !showingSetupView || setupCurrentStep !== 1 || overlayState.githubAppBusy;
  overlayEls.setupInstallAppBtn.disabled = !showingSetupView
    || setupCurrentStep !== 2
    || overlayState.githubAppBusy;
  overlayEls.setupRefreshAppBtn.disabled = !showingSetupView
    || setupCurrentStep !== 2
    || overlayState.githubAppBusy;
  overlayEls.setupBackToStep1Btn.disabled = !showingSetupView || setupCurrentStep !== 2 || overlayState.githubAppBusy;
  overlayEls.setupToStep3Btn.disabled = !showingSetupView || setupCurrentStep !== 2 || overlayState.githubAppBusy;
  overlayEls.setupCreatePrBtn.disabled = !showingSetupView
    || setupCurrentStep !== 3
    || overlayState.githubAppBusy;
  overlayEls.setupBackToStep2Btn.disabled = !showingSetupView || setupCurrentStep !== 3 || overlayState.githubAppBusy;
  overlayEls.setupContinueBtn.disabled = !showingSetupView || setupCurrentStep !== 3 || overlayState.githubAppBusy;
  overlayEls.setupLogoutBtn.disabled = !showingSetupView;
  overlayEls.authSubmitBtn.disabled = overlayState.authBusy;
  overlayEls.authBackBtn.disabled = overlayState.authBusy;
  renderProjectContextSettings();

  if (!overlayState.started) {
    overlayEls.startBtn.textContent = overlayState.loading ? "Preparando..." : "Empezar";
  }

  if (showingMainView) {
    const ideas = overlayState.assistantEnabled
      ? overlayState.ideas
      : ["El tutor esta pausado. Activalo desde la configuracion para seguir."];
    const guide = overlayState.assistantEnabled
      ? overlayState.guide
      : ["Abre configuracion.", "Activa el tutor.", "Pulsa Actualizar."];

    fillList(overlayEls.ideaList, ideas);
    fillList(overlayEls.guideList, guide);
    overlayEls.studentGoalSection.hidden = isTeacherSession() || isAdminSession() || !sectionsUnlocked;
    overlayEls.studentIdeasSection.hidden = isTeacherSession() || isAdminSession() || !sectionsUnlocked;
    overlayEls.nextStepSection.hidden = isAdminSession() || !sectionsUnlocked;
    overlayEls.previewSection.hidden = isAdminSession() || !sectionsUnlocked;
    overlayEls.teacherPolicySection.hidden = !isTeacherSession() || !sectionsUnlocked;
    overlayEls.teacherTelemetrySection.hidden = !isTeacherSession() || !sectionsUnlocked;
    overlayEls.adminUsersSection.hidden = !isAdminSession();

    if (isTeacherSession()) {
      renderTeacherPolicyList();
      renderTelemetryList();
    }
    if (isAdminSession()) {
      renderAdminUsersTable();
    }
  }

  renderGoalButtons();
  syncSettingsInputs();
  setSettingsOpen(overlayState.settingsOpen);
  renderProjectAnalysisWindow();
  scheduleOverlayViewportSync(true);
}

function startDrag(event) {
  if (!overlayHost || event.button !== 0) return;
  if (event.target.closest("button") || event.target.closest("input") || event.target.closest("select") || event.target.closest("textarea")) {
    return;
  }

  event.preventDefault();
  const rect = overlayHost.getBoundingClientRect();
  const startX = event.clientX;
  const startY = event.clientY;

  function onMove(moveEvent) {
    const deltaX = moveEvent.clientX - startX;
    const deltaY = moveEvent.clientY - startY;
    const bounds = getOverlayViewportBounds();
    const nextLeft = clamp(rect.left + deltaX, bounds.minLeft, bounds.maxLeft);
    const nextTop = clamp(rect.top + deltaY, bounds.minTop, bounds.maxTop);
    placeOverlay(nextLeft, nextTop);
  }

  function onUp() {
    window.removeEventListener("pointermove", onMove);
    window.removeEventListener("pointerup", onUp);
  }

  window.addEventListener("pointermove", onMove);
  window.addEventListener("pointerup", onUp);
}

async function startExperience() {
  overlayState.started = true;
  overlayState.authError = "";

  if (!overlayState.session && overlayState.sessionId) {
    try {
      const restored = await fetchCurrentSession();
      if (!restored) {
        overlayState.sessionId = "";
        overlayState.session = null;
        await persistPreferences();
      }
    } catch {
      overlayState.sessionId = "";
      overlayState.session = null;
      await persistPreferences();
    }
  }

  if (hasActiveSession()) {
    await refreshMentorSession();
  } else {
    renderOverlay();
  }
}

async function submitLoginFromOverlay() {
  overlayState.authBusy = true;
  overlayState.authError = "";
  renderOverlay();

  try {
    const email = overlayEls.authEmail.value.trim();
    const password = overlayEls.authPassword.value;
    await loginToBackend(email, password);
    await refreshMentorSession();
    const user = overlayState.session?.user;
    if (user) {
      const roleLabel = getRoleLabelLower(user.role);
      overlayState.statusMessage = user.role === "admin"
        ? `Bienvenido ${roleLabel} ${user.displayName}. Gestiona usuarios desde el dashboard; GitHub App y PR se ejecutan manualmente en Configuracion.`
        : `Bienvenido ${roleLabel} ${user.displayName}.`;
    }
  } catch (error) {
    overlayState.authError = String(error);
    renderOverlay();
  } finally {
    overlayState.authBusy = false;
    renderOverlay();
  }
}

async function logoutAndReturnToLogin() {
  await logoutFromBackend();
  overlayState.started = true;
  overlayState.ideas = [];
  overlayState.guide = [];
  overlayState.analysisUnlocked = false;
  overlayState.analysisWindowOpen = false;
  overlayState.setupRepoFullName = "";
  overlayState.setupWizardStep = 1;
  overlayState.githubAppBusy = false;
  overlayState.githubAppStatus = { ...EMPTY_GITHUB_APP_STATUS };
  overlayState.projectContextBusy = false;
  overlayState.projectContextStatus = { ...EMPTY_PROJECT_CONTEXT_STATUS };
  overlayState.projectContextHistory = [];
  overlayState.projectContextInsight = { ...EMPTY_PROJECT_CONTEXT_INSIGHT };
  overlayState.projectContextMessage = "";
  overlayState.projectContextError = "";
  overlayState.adminUsers = [];
  overlayState.adminTeachers = [];
  overlayState.adminUsersBusy = false;
  overlayState.adminUsersMessage = "";
  overlayState.statusMessage = "Sesion cerrada.";
  renderOverlay();
}

async function ensureOverlay() {
  await loadPreferences();

  if (overlayHost?.isConnected && overlayRoot) return;

  overlayHost = document.createElement("div");
  overlayHost.id = OVERLAY_HOST_ID;
  overlayRoot = overlayHost.attachShadow({ mode: "open" });
  overlayRoot.innerHTML = buildOverlayMarkup();

  overlayEls = {
    shell: overlayRoot.getElementById("shell"),
    window: overlayRoot.getElementById("window"),
    dragHandle: overlayRoot.getElementById("dragHandle"),
    headerUserTitle: overlayRoot.getElementById("headerUserTitle"),
    headerUserSubtitle: overlayRoot.getElementById("headerUserSubtitle"),
    settingsBtn: overlayRoot.getElementById("settingsBtn"),
    logoutHeaderBtn: overlayRoot.getElementById("logoutHeaderBtn"),
    closeBtn: overlayRoot.getElementById("closeBtn"),
    settingsCloseBtn: overlayRoot.getElementById("settingsCloseBtn"),
    welcomeView: overlayRoot.getElementById("welcomeView"),
    authView: overlayRoot.getElementById("authView"),
    setupView: overlayRoot.getElementById("setupView"),
    mainView: overlayRoot.getElementById("mainView"),
    welcomeContext: overlayRoot.getElementById("welcomeContext"),
    welcomeCopy: overlayRoot.getElementById("welcomeCopy"),
    startBtn: overlayRoot.getElementById("startBtn"),
    authEmail: overlayRoot.getElementById("authEmail"),
    authPassword: overlayRoot.getElementById("authPassword"),
    authSubmitBtn: overlayRoot.getElementById("authSubmitBtn"),
    authBackBtn: overlayRoot.getElementById("authBackBtn"),
    authError: overlayRoot.getElementById("authError"),
    setupStepOneCard: overlayRoot.getElementById("setupStepOneCard"),
    setupStepTwoCard: overlayRoot.getElementById("setupStepTwoCard"),
    setupStepThreeCard: overlayRoot.getElementById("setupStepThreeCard"),
    setupRepoInput: overlayRoot.getElementById("setupRepoInput"),
    setupExploreBtn: overlayRoot.getElementById("setupExploreBtn"),
    setupDetectRepoBtn: overlayRoot.getElementById("setupDetectRepoBtn"),
    setupToStep2Btn: overlayRoot.getElementById("setupToStep2Btn"),
    setupInstallAppBtn: overlayRoot.getElementById("setupInstallAppBtn"),
    setupRefreshAppBtn: overlayRoot.getElementById("setupRefreshAppBtn"),
    setupBackToStep1Btn: overlayRoot.getElementById("setupBackToStep1Btn"),
    setupToStep3Btn: overlayRoot.getElementById("setupToStep3Btn"),
    setupCreatePrBtn: overlayRoot.getElementById("setupCreatePrBtn"),
    setupStatusText: overlayRoot.getElementById("setupStatusText"),
    setupBackToStep2Btn: overlayRoot.getElementById("setupBackToStep2Btn"),
    setupContinueBtn: overlayRoot.getElementById("setupContinueBtn"),
    setupLogoutBtn: overlayRoot.getElementById("setupLogoutBtn"),
    mainContext: overlayRoot.getElementById("mainContext"),
    roleBadge: overlayRoot.getElementById("roleBadge"),
    refreshBtn: overlayRoot.getElementById("refreshBtn"),
    analyzeProjectBtn: overlayRoot.getElementById("analyzeProjectBtn"),
    detailTitle: overlayRoot.getElementById("detailTitle"),
    detailMeta: overlayRoot.getElementById("detailMeta"),
    signalText: overlayRoot.getElementById("signalText"),
    policyLead: overlayRoot.getElementById("policyLead"),
    sessionBadge: overlayRoot.getElementById("sessionBadge"),
    policySectionTitle: overlayRoot.getElementById("policySectionTitle"),
    teacherSummary: overlayRoot.getElementById("teacherSummary"),
    githubAppSection: overlayRoot.getElementById("githubAppSection"),
    githubAppStatusText: overlayRoot.getElementById("githubAppStatusText"),
    githubAppInstallBtn: overlayRoot.getElementById("githubAppInstallBtn"),
    githubAppRefreshBtn: overlayRoot.getElementById("githubAppRefreshBtn"),
    githubAppBootstrapBtn: overlayRoot.getElementById("githubAppBootstrapBtn"),
    projectContextStatusSection: overlayRoot.getElementById("projectContextStatusSection"),
    projectContextStatusText: overlayRoot.getElementById("projectContextStatusText"),
    projectContextReadyValue: overlayRoot.getElementById("projectContextReadyValue"),
    projectContextVersionValue: overlayRoot.getElementById("projectContextVersionValue"),
    projectContextRequestValue: overlayRoot.getElementById("projectContextRequestValue"),
    projectContextSnapshotValue: overlayRoot.getElementById("projectContextSnapshotValue"),
    projectContextUpdatedValue: overlayRoot.getElementById("projectContextUpdatedValue"),
    projectContextSourceValue: overlayRoot.getElementById("projectContextSourceValue"),
    projectContextRefreshBtn: overlayRoot.getElementById("projectContextRefreshBtn"),
    projectContextHistorySection: overlayRoot.getElementById("projectContextHistorySection"),
    projectContextHistoryText: overlayRoot.getElementById("projectContextHistoryText"),
    projectContextHistoryList: overlayRoot.getElementById("projectContextHistoryList"),
    projectContextHistoryRefreshBtn: overlayRoot.getElementById("projectContextHistoryRefreshBtn"),
    adminUsersSection: overlayRoot.getElementById("adminUsersSection"),
    adminUsersStatus: overlayRoot.getElementById("adminUsersStatus"),
    adminReloadUsersBtn: overlayRoot.getElementById("adminReloadUsersBtn"),
    adminCreateRole: overlayRoot.getElementById("adminCreateRole"),
    adminCreateName: overlayRoot.getElementById("adminCreateName"),
    adminCreateEmail: overlayRoot.getElementById("adminCreateEmail"),
    adminCreatePassword: overlayRoot.getElementById("adminCreatePassword"),
    adminCreateTeacher: overlayRoot.getElementById("adminCreateTeacher"),
    adminCreateBtn: overlayRoot.getElementById("adminCreateBtn"),
    adminUsersTableBody: overlayRoot.getElementById("adminUsersTableBody"),
    studentGoalSection: overlayRoot.getElementById("studentGoalSection"),
    studentIdeasSection: overlayRoot.getElementById("studentIdeasSection"),
    nextStepSection: overlayRoot.getElementById("nextStepSection"),
    goalGrid: overlayRoot.getElementById("goalGrid"),
    ideaList: overlayRoot.getElementById("ideaList"),
    guideList: overlayRoot.getElementById("guideList"),
    teacherPolicySection: overlayRoot.getElementById("teacherPolicySection"),
    teacherPolicyList: overlayRoot.getElementById("teacherPolicyList"),
    teacherTelemetrySection: overlayRoot.getElementById("teacherTelemetrySection"),
    telemetryList: overlayRoot.getElementById("telemetryList"),
    reloadTelemetryBtn: overlayRoot.getElementById("reloadTelemetryBtn"),
    previewSection: overlayRoot.getElementById("previewSection"),
    previewText: overlayRoot.getElementById("previewText"),
    statusText: overlayRoot.getElementById("statusText"),
    settingsSessionLabel: overlayRoot.getElementById("settingsSessionLabel"),
    settingsSessionMeta: overlayRoot.getElementById("settingsSessionMeta"),
    teacherEnabled: overlayRoot.getElementById("teacherEnabled"),
    autoConfigEnabled: overlayRoot.getElementById("autoConfigEnabled"),
    teacherSettingsBlock: overlayRoot.getElementById("teacherSettingsBlock"),
    teacherPolicyName: overlayRoot.getElementById("teacherPolicyName"),
    teacherOutcome: overlayRoot.getElementById("teacherOutcome"),
    teacherTone: overlayRoot.getElementById("teacherTone"),
    teacherFrequency: overlayRoot.getElementById("teacherFrequency"),
    teacherHelpLevel: overlayRoot.getElementById("teacherHelpLevel"),
    teacherMiniQuiz: overlayRoot.getElementById("teacherMiniQuiz"),
    teacherNoSolution: overlayRoot.getElementById("teacherNoSolution"),
    teacherMaxHints: overlayRoot.getElementById("teacherMaxHints"),
    teacherAllowExplanation: overlayRoot.getElementById("teacherAllowExplanation"),
    teacherAllowHint: overlayRoot.getElementById("teacherAllowHint"),
    teacherAllowExample: overlayRoot.getElementById("teacherAllowExample"),
    teacherAllowMiniQuizType: overlayRoot.getElementById("teacherAllowMiniQuizType"),
    teacherFallbackMessage: overlayRoot.getElementById("teacherFallbackMessage"),
    teacherCustomInstruction: overlayRoot.getElementById("teacherCustomInstruction"),
    backendUrlInput: overlayRoot.getElementById("backendUrlInput"),
    advancedGithubBlock: overlayRoot.getElementById("advancedGithubBlock"),
    advancedGithubNote: overlayRoot.getElementById("advancedGithubNote"),
    logoutSettingsBtn: overlayRoot.getElementById("logoutSettingsBtn"),
    saveSettingsBtn: overlayRoot.getElementById("saveSettingsBtn"),
    analysisWindow: overlayRoot.getElementById("analysisWindow"),
    analysisCloseBtn: overlayRoot.getElementById("analysisCloseBtn"),
    analysisStats: overlayRoot.getElementById("analysisStats"),
    analysisFileList: overlayRoot.getElementById("analysisFileList"),
  };

  overlayEls.closeBtn.addEventListener("click", async () => {
    await closeOverlay();
  });
  overlayEls.settingsBtn.addEventListener("click", () => {
    setSettingsOpen(!overlayState.settingsOpen);
  });
  overlayEls.settingsCloseBtn.addEventListener("click", () => {
    setSettingsOpen(false);
  });
  overlayEls.startBtn.addEventListener("click", async () => {
    await startExperience();
  });
  overlayEls.authSubmitBtn.addEventListener("click", async () => {
    await submitLoginFromOverlay();
  });
  overlayEls.authBackBtn.addEventListener("click", () => {
    overlayState.started = false;
    overlayState.authError = "";
    renderOverlay();
  });
  overlayEls.setupRepoInput.addEventListener("input", () => {
    setSetupRepoFullName(overlayEls.setupRepoInput.value);
    overlayState.setupWizardStep = 1;
    clearSetupForCurrentUser();
    persistPreferences().catch(() => {});
    renderOverlay();
  });
  overlayEls.setupExploreBtn.addEventListener("click", async () => {
    await analyzeCodespaceProject();
  });
  overlayEls.setupDetectRepoBtn.addEventListener("click", async () => {
    overlayState.context = buildPayload();
    const detected = inferRepoFromContext(overlayState.context);
    if (detected) {
      setSetupRepoFullName(detected);
      overlayState.setupWizardStep = 1;
      clearSetupForCurrentUser();
      persistPreferences().catch(() => {});
      overlayState.statusMessage = `Repositorio detectado: ${detected}`;
    } else {
      overlayState.statusMessage = "No se pudo detectar owner/repo automaticamente. Pegalo en el campo.";
    }
    try {
      await refreshGithubAppStatus();
    } catch {}
    renderOverlay();
  });
  overlayEls.setupToStep2Btn.addEventListener("click", () => {
    const flow = getSetupFlowState(overlayState.context || buildPayload());
    if (!flow.repoReady) {
      overlayState.statusMessage = "Confirma el repositorio objetivo para pasar al Paso 2/3.";
      renderOverlay();
      return;
    }
    overlayState.setupWizardStep = 2;
    overlayState.statusMessage = "";
    renderOverlay();
  });
  overlayEls.setupInstallAppBtn.addEventListener("click", async () => {
    const flow = getSetupFlowState(overlayState.context || buildPayload());
    if (!flow.repoReady) {
      overlayState.statusMessage = "Primero completa el Paso 1/3: confirmar repositorio objetivo.";
      renderOverlay();
      return;
    }
    if (!flow.configured) {
      overlayState.statusMessage = "El backend aun no tiene GitHub App configurada.";
      renderOverlay();
      return;
    }
    await startGithubAppInstallFlow();
  });
  overlayEls.setupRefreshAppBtn.addEventListener("click", async () => {
    const flow = getSetupFlowState(overlayState.context || buildPayload());
    if (!flow.repoReady) {
      overlayState.statusMessage = "Primero completa el Paso 1/3.";
      renderOverlay();
      return;
    }
    if (!flow.configured) {
      overlayState.statusMessage = "El backend aun no tiene GitHub App configurada.";
      renderOverlay();
      return;
    }
    overlayState.githubAppBusy = true;
    overlayState.statusMessage = "Verificando instalacion y acceso al repositorio...";
    renderOverlay();
    try {
      await refreshGithubAppStatus();
      const afterRefresh = getSetupFlowState(overlayState.context || buildPayload());
      if (!afterRefresh.appConnected && afterRefresh.configured && afterRefresh.repoReady) {
        const linked = await autoLinkGithubInstallation(afterRefresh.repoFullName);
        if (linked) {
          await refreshGithubAppStatus();
        }
      }

      if (!hasBootstrapDetectedInTour()) {
        hydrateBootstrapSignalsFromCodespaceExplorer();
      }

      const finalFlow = getSetupFlowState(overlayState.context || buildPayload());
      if (hasCompletedSetup() || finalFlow.prCreated) {
        await markSetupCompleted();
        overlayState.statusMessage = "Acceso verificado. Este repo ya tenia bootstrap aplicado (PR previo); entrando al dashboard.";
        await refreshMentorSession();
        return;
      } else if (finalFlow.accessVerified) {
        overlayState.statusMessage = "Acceso verificado. Ya puedes pasar al Paso 3/3.";
      } else if (finalFlow.appConnected) {
        overlayState.statusMessage = "App conectada, pero falta acceso al repo objetivo.";
      } else {
        overlayState.statusMessage = "No se detecto una instalacion vinculada para este repositorio.";
      }
    } catch (error) {
      overlayState.statusMessage = `No se pudo actualizar estado GitHub App: ${String(error)}`;
    } finally {
      overlayState.githubAppBusy = false;
      renderOverlay();
    }
  });
  overlayEls.setupBackToStep1Btn.addEventListener("click", () => {
    overlayState.setupWizardStep = 1;
    overlayState.statusMessage = "";
    renderOverlay();
  });
  overlayEls.setupToStep3Btn.addEventListener("click", () => {
    const flow = getSetupFlowState(overlayState.context || buildPayload());
    if (!BYPASS_GITHUB_APP_INSTALL_VALIDATION) {
      if (!flow.appConnected) {
        overlayState.statusMessage = "Primero conecta la GitHub App en el Paso 2/3.";
        renderOverlay();
        return;
      }
      if (!flow.accessVerified) {
        overlayState.statusMessage = "Primero verifica acceso de la app al repositorio.";
        renderOverlay();
        return;
      }
      // Temporalmente deshabilitado para pruebas de PR:
      // if (!flow.appConnected || !flow.accessVerified) return;
    }
    overlayState.setupWizardStep = 3;
    overlayState.statusMessage = "";
    renderOverlay();
  });
  overlayEls.setupCreatePrBtn.addEventListener("click", async () => {
    const flow = getSetupFlowState(overlayState.context || buildPayload());
    if (!flow.repoReady) {
      overlayState.statusMessage = "Primero completa el Paso 1/3.";
      renderOverlay();
      return;
    }
    if (!BYPASS_GITHUB_APP_INSTALL_VALIDATION) {
      if (!flow.appConnected) {
        overlayState.statusMessage = "Primero completa el Paso 2/3: conectar GitHub App.";
        renderOverlay();
        return;
      }
      if (!flow.accessVerified) {
        overlayState.statusMessage = "Primero completa el Paso 2/3: verificar acceso.";
        renderOverlay();
        return;
      }
      // Temporalmente deshabilitado para pruebas de PR:
      // if (!flow.appConnected || !flow.accessVerified) return;
    }
    await bootstrapDevcontainerWithGithubApp();
  });
  overlayEls.setupBackToStep2Btn.addEventListener("click", () => {
    overlayState.setupWizardStep = 2;
    overlayState.statusMessage = "";
    renderOverlay();
  });
  overlayEls.setupContinueBtn.addEventListener("click", async () => {
    if (!hasCompletedSetup()) {
      overlayState.statusMessage = "Completa primero el tour: conectar app y crear PR.";
      renderOverlay();
      return;
    }
    await refreshMentorSession();
  });
  overlayEls.setupLogoutBtn.addEventListener("click", async () => {
    await logoutAndReturnToLogin();
  });
  overlayEls.refreshBtn.addEventListener("click", async () => {
    await refreshMentorSession();
  });
  overlayEls.analyzeProjectBtn.addEventListener("click", async () => {
    await analyzeCodespaceProject();
  });
  overlayEls.githubAppInstallBtn.addEventListener("click", async () => {
    await startGithubAppInstallFlow();
  });
  overlayEls.githubAppRefreshBtn.addEventListener("click", async () => {
    overlayState.githubAppBusy = true;
    renderOverlay();
    try {
      await refreshGithubAppStatus();
      overlayState.statusMessage = "Estado de GitHub App actualizado.";
    } catch (error) {
      overlayState.statusMessage = `No se pudo actualizar estado GitHub App: ${String(error)}`;
    } finally {
      overlayState.githubAppBusy = false;
      renderOverlay();
    }
  });
  overlayEls.githubAppBootstrapBtn.addEventListener("click", async () => {
    await bootstrapDevcontainerWithGithubApp({ force: true });
  });
  overlayEls.projectContextRefreshBtn.addEventListener("click", async () => {
    await refreshProjectContextPanel();
  });
  overlayEls.projectContextHistoryRefreshBtn.addEventListener("click", async () => {
    await refreshProjectContextPanel();
  });
  overlayEls.adminCreateRole.addEventListener("change", () => {
    renderAdminUsersTable();
  });
  overlayEls.adminReloadUsersBtn.addEventListener("click", async () => {
    if (!isAdminSession()) return;
    overlayState.adminUsersBusy = true;
    overlayState.adminUsersMessage = "Actualizando usuarios...";
    renderOverlay();
    try {
      await reloadAdminUsers();
      overlayState.adminUsersMessage = "Usuarios actualizados.";
    } catch (error) {
      overlayState.adminUsersMessage = `No se pudieron cargar usuarios: ${String(error)}`;
    } finally {
      overlayState.adminUsersBusy = false;
      renderOverlay();
    }
  });
  overlayEls.adminCreateBtn.addEventListener("click", async () => {
    if (!isAdminSession()) return;
    overlayState.adminUsersBusy = true;
    overlayState.adminUsersMessage = "Creando usuario...";
    renderOverlay();
    try {
      await createAdminUserFromForm();
      overlayEls.adminCreateName.value = "";
      overlayEls.adminCreateEmail.value = "";
      overlayEls.adminCreatePassword.value = "";
      overlayEls.adminCreateTeacher.value = "";
      await reloadAdminUsers();
      overlayState.adminUsersMessage = "Usuario creado correctamente.";
    } catch (error) {
      overlayState.adminUsersMessage = `No se pudo crear usuario: ${String(error)}`;
    } finally {
      overlayState.adminUsersBusy = false;
      renderOverlay();
    }
  });
  overlayEls.analysisCloseBtn.addEventListener("click", () => {
    overlayState.analysisWindowOpen = false;
    renderOverlay();
  });
  overlayEls.logoutHeaderBtn.addEventListener("click", async () => {
    await logoutAndReturnToLogin();
  });
  overlayEls.reloadTelemetryBtn?.addEventListener("click", async () => {
    await reloadPolicyAndTelemetry();
    renderOverlay();
  });
  overlayEls.saveSettingsBtn.addEventListener("click", async () => {
    await saveSettingsFromOverlay();
  });
  overlayEls.logoutSettingsBtn.addEventListener("click", async () => {
    await logoutAndReturnToLogin();
    setSettingsOpen(false);
  });
  overlayEls.dragHandle.addEventListener("pointerdown", startDrag);

  document.documentElement.appendChild(overlayHost);
  bindOverlayViewportListeners();
  overlayState.context = buildPayload();
  overlayEls.authEmail.value = "estudiante@adaceen.edu.co";
  overlayEls.authPassword.value = "Estudiante123!";
  renderOverlay();
  scheduleOverlayViewportSync(false);
}

async function openOverlay() {
  overlayState.started = false;
  overlayState.settingsOpen = false;
  overlayState.loading = false;
  overlayState.analysisBusy = false;
  overlayState.analysisUnlocked = false;
  overlayState.analysisWindowOpen = false;
  overlayState.projectAnalysis = null;
  overlayState.setupRepoFullName = "";
  overlayState.setupWizardStep = 1;
  overlayState.githubAppBusy = false;
  overlayState.githubAppStatus = { ...EMPTY_GITHUB_APP_STATUS };
  overlayState.projectContextBusy = false;
  overlayState.projectContextStatus = { ...EMPTY_PROJECT_CONTEXT_STATUS };
  overlayState.projectContextHistory = [];
  overlayState.projectContextInsight = { ...EMPTY_PROJECT_CONTEXT_INSIGHT };
  overlayState.projectContextMessage = "";
  overlayState.projectContextError = "";
  overlayState.adminUsers = [];
  overlayState.adminTeachers = [];
  overlayState.adminUsersBusy = false;
  overlayState.adminUsersMessage = "";
  overlayState.context = buildPayload();
  overlayState.ideas = [];
  overlayState.guide = [];
  overlayState.welcome = "";
  overlayState.statusMessage = "";

  await ensureOverlay();
  await chrome.storage.local.set({ [STORAGE_KEY_OVERLAY_PINNED]: true });
  renderOverlay();
  scheduleOverlayViewportSync(false);
}

async function closeOverlay() {
  overlayState.started = false;
  overlayState.settingsOpen = false;
  overlayState.loading = false;
  overlayState.analysisBusy = false;
  overlayState.analysisUnlocked = false;
  overlayState.analysisWindowOpen = false;
  overlayState.projectAnalysis = null;
  overlayState.setupRepoFullName = "";
  overlayState.setupWizardStep = 1;
  overlayState.githubAppBusy = false;
  overlayState.githubAppStatus = { ...EMPTY_GITHUB_APP_STATUS };
  overlayState.projectContextBusy = false;
  overlayState.projectContextStatus = { ...EMPTY_PROJECT_CONTEXT_STATUS };
  overlayState.projectContextHistory = [];
  overlayState.projectContextInsight = { ...EMPTY_PROJECT_CONTEXT_INSIGHT };
  overlayState.projectContextMessage = "";
  overlayState.projectContextError = "";
  overlayState.adminUsers = [];
  overlayState.adminTeachers = [];
  overlayState.adminUsersBusy = false;
  overlayState.adminUsersMessage = "";
  overlayState.ideas = [];
  overlayState.guide = [];
  overlayState.welcome = "";
  overlayState.statusMessage = "";

  try {
    await chrome.storage.local.set({ [STORAGE_KEY_OVERLAY_PINNED]: false });
  } catch {}

  if (overlayHost?.isConnected) {
    overlayHost.remove();
  }

  overlayHost = null;
  overlayRoot = null;
  overlayEls = null;
}

async function refreshMentorSession() {
  if (!hasActiveSession()) {
    renderOverlay();
    return;
  }

  overlayState.loading = true;
  overlayState.context = buildPayload();
  overlayState.statusMessage = "Leyendo contexto actual...";
  renderOverlay();

  const context = overlayState.context;
  const language = inferLanguage(context.filePath, context.languageHint);
  const goal = getLearningGoal(overlayState.selectedLearningGoal);
  const detectedRepo = inferRepoFromContext(context);
  if (!overlayState.setupRepoFullName && detectedRepo) {
    setSetupRepoFullName(detectedRepo);
  }

  overlayState.welcome = buildWelcomeText(context, goal);
  overlayState.ideas = buildIdeas(context, language, goal.id);
  overlayState.guide = buildGuide(goal.id, context);
  overlayState.statusMessage = buildMainStatus(context);

  try {
    await refreshGithubAppStatus();
  } catch {
    overlayState.githubAppStatus = { ...EMPTY_GITHUB_APP_STATUS };
  }

  overlayState.projectContextMessage = "";
  overlayState.projectContextError = "";

  try {
    await refreshProjectContextStatus();
  } catch {
    overlayState.projectContextStatus = { ...EMPTY_PROJECT_CONTEXT_STATUS };
  }

  try {
    await refreshProjectContextHistory();
  } catch {
    overlayState.projectContextHistory = [];
  }

  if (overlayState.autoConfigEnabled) {
    try {
      await refreshProjectContextInsight();
    } catch {
      overlayState.projectContextInsight = { ...EMPTY_PROJECT_CONTEXT_INSIGHT };
    }
  } else {
    overlayState.projectContextInsight = {
      ...EMPTY_PROJECT_CONTEXT_INSIGHT,
      configured: true,
      repoFullName: getCurrentRepoFullName(),
      modelEnabled: false,
      summary: "Configuracion automatica desactivada.",
    };
  }

  if (overlayState.assistantEnabled && context.pageContext !== "unknown" && normalizeBaseUrl(overlayState.backendUrl)) {
    try {
      const remote = await requestBackendMentor(context, language);
      if (remote.ideas.length > 0) overlayState.ideas = remote.ideas;
      if (remote.guide.length > 0) overlayState.guide = remote.guide;
      if (remote.welcome) overlayState.welcome = remote.welcome;
      if (remote.summary) overlayState.statusMessage = remote.summary;
      if (isTeacherSession()) {
        await reloadPolicyAndTelemetry();
      } else if (isAdminSession()) {
        await reloadAdminUsers();
      }
    } catch {
      overlayState.statusMessage = `${buildMainStatus(context)} Se usa apoyo local por ahora.`;
    }
  }

  if (isAdminSession()) {
    try {
      await reloadAdminUsers();
    } catch {
      overlayState.adminUsers = [];
      overlayState.adminTeachers = [];
    }
  }

  overlayState.loading = false;
  renderOverlay();
}

async function restorePinnedOverlay() {
  try {
    await loadPreferences();
    const stored = await chrome.storage.local.get([STORAGE_KEY_OVERLAY_PINNED]);
    if (stored[STORAGE_KEY_OVERLAY_PINNED] === true) {
      await openOverlay();
    }
  } catch {}
}

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message?.type === "GET_GITHUB_CONTEXT" || message?.type === "GET_PAGE_INFO") {
    try {
      sendResponse({ ok: true, data: buildPayload() });
    } catch (error) {
      sendResponse({ ok: false, error: String(error) });
    }
    return;
  }

  if (message?.type === "ADACEEN_PING") {
    sendResponse({ ok: true });
    return;
  }

  if (message?.type === "ADACEEN_OPEN_OVERLAY") {
    openOverlay()
      .then(() => sendResponse({ ok: true }))
      .catch((error) => sendResponse({ ok: false, error: String(error) }));
    return true;
  }

  if (message?.type === "ADACEEN_CLOSE_OVERLAY") {
    closeOverlay()
      .then(() => sendResponse({ ok: true }))
      .catch((error) => sendResponse({ ok: false, error: String(error) }));
    return true;
  }
});

restorePinnedOverlay().catch(() => {});

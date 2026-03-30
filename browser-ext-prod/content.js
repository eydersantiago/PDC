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
const DEFAULT_BACKEND_URL = "http://127.0.0.1:3000";
const DEFAULT_LEARNING_GOAL = "oop_basics";
const BACKEND_TIMEOUT_MS = 12000;
const MAX_LIST_ITEMS = 4;
const MAX_PREVIEW_CHARS = 900;
const MAX_ANALYSIS_RENDER_ITEMS = 500;
const OVERLAY_MARGIN = 16;

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

const overlayState = {
  assistantEnabled: true,
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
  welcome: "",
  statusMessage: "",
  analysisBusy: false,
  projectAnalysis: null,
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

async function loadPreferences() {
  if (preferencesLoaded) return;

  try {
    const stored = await chrome.storage.local.get([
      STORAGE_KEY_ENABLED,
      STORAGE_KEY_BACKEND_URL,
      STORAGE_KEY_LEARNING_GOAL,
      STORAGE_KEY_SESSION_ID,
    ]);

    overlayState.assistantEnabled = typeof stored[STORAGE_KEY_ENABLED] === "boolean"
      ? stored[STORAGE_KEY_ENABLED]
      : true;
    overlayState.backendUrl = normalizeBaseUrl(stored[STORAGE_KEY_BACKEND_URL]) || DEFAULT_BACKEND_URL;
    overlayState.selectedLearningGoal = LEARNING_GOALS.some((goal) => goal.id === stored[STORAGE_KEY_LEARNING_GOAL])
      ? stored[STORAGE_KEY_LEARNING_GOAL]
      : DEFAULT_LEARNING_GOAL;
    overlayState.sessionId = toText(stored[STORAGE_KEY_SESSION_ID]);
  } catch {
    overlayState.assistantEnabled = true;
    overlayState.backendUrl = DEFAULT_BACKEND_URL;
    overlayState.selectedLearningGoal = DEFAULT_LEARNING_GOAL;
    overlayState.sessionId = "";
    overlayState.session = null;
    overlayState.policy = { ...DEFAULT_POLICY };
  }

  preferencesLoaded = true;
}

async function persistPreferences() {
  await chrome.storage.local.set({
    [STORAGE_KEY_ENABLED]: overlayState.assistantEnabled,
    [STORAGE_KEY_BACKEND_URL]: overlayState.backendUrl,
    [STORAGE_KEY_LEARNING_GOAL]: overlayState.selectedLearningGoal,
    [STORAGE_KEY_SESSION_ID]: overlayState.sessionId,
  });
}

function buildPayload() {
  const pageContext = detectPageContext();
  const visibleText = extractVisibleText(14000);
  const selection = extractSelectionText(4000);
  const github = getGitHubInfo();
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
    links: extractVisibleLinks(25, 100, 320),
    pageContext,
    pageType,
    repoOwner: github.repoOwner,
    repoName: github.repoName,
    repoFullName: github.repoFullName,
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

function extractCodespaceExplorerEntries(maxItems = 2500) {
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
    overlayEls.analysisStats.textContent = "Pulsa Analizar para leer archivos y carpetas del explorador.";
    fillList(overlayEls.analysisFileList, ["Aun no hay resultados."]);
    return;
  }

  overlayEls.analysisStats.textContent =
    `Detectados ${analysis.totalFiles} archivos y ${analysis.totalFolders} carpetas ` +
    `(${analysis.totalEntries} elementos visibles).`;

  const lines = [
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
  overlayState.statusMessage = "Analizando estructura visible del proyecto...";
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

    overlayState.statusMessage =
      `Analisis listo: ${overlayState.projectAnalysis.totalFiles} archivos y ` +
      `${overlayState.projectAnalysis.totalFolders} carpetas detectados.`;
  } catch (error) {
    overlayState.projectAnalysis = null;
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

function hasActiveSession() {
  return !!overlayState.session?.user;
}

function isTeacherSession() {
  return overlayState.session?.user?.role === "teacher";
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
  return {
    contextLabel: friendlyPageContext(context.pageContext, context.pageType),
    detailTitle: toText(context.activityTitle) || toText(context.filePath) || toText(context.title) || "Sin detalle detectado",
    detailMeta: `${language} | ${toText(context.repoFullName) || "Sin repositorio"} | ${toText(context.branch) || "Sin rama"}`,
    signal: pickSignal(context),
    preview: toText(context.codeSnippet)
      || toText(context.selection)
      || toText(context.visibleError)
      || toText(context.activityTitle)
      || toText(context.text).slice(0, MAX_PREVIEW_CHARS)
      || "(Sin fragmento detectado)",
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
        width: min(360px, calc(100vw - 32px));
        color: #173046;
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

    <div class="shell">
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
            <p class="copy">Ingresa tus credenciales. El sistema detecta automaticamente si eres estudiante o profesor.</p>
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
                Demo profesor: docente@adaceen.edu.co / Docente123!
              </p>
              <p class="status" id="authError"></p>
            </div>
            <div class="button-row split">
              <button class="ghost-button" id="authBackBtn" type="button">Volver</button>
              <button class="primary-button" id="authSubmitBtn" type="button">Entrar</button>
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
                <button class="ghost-button analyze-button" id="analyzeProjectBtn" type="button">Analizar</button>
              </div>
              <div class="summary-title" id="detailTitle">Sin detalle detectado</div>
              <div class="summary-meta" id="detailMeta">Sin contexto</div>
              <p class="signal" id="signalText">Sin senales detectadas.</p>
              <p class="policy-lead" id="policyLead">La politica activa aparecera aqui.</p>
              <p class="session-badge" id="sessionBadge">Sesion sin iniciar.</p>
            </div>

            <section class="panel-section" id="studentGoalSection">
              <h2>Hoy quiero reforzar</h2>
              <div class="goal-grid" id="goalGrid"></div>
            </section>

            <section class="panel-section" id="studentIdeasSection">
              <h2>Pistas de hoy</h2>
              <ul id="ideaList"></ul>
            </section>

            <section class="panel-section">
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

            <div class="preview-card">
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

            <div class="field">
              <label for="backendUrlInput">Base URL del backend</label>
              <input id="backendUrlInput" type="text" placeholder="http://127.0.0.1:3000" />
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
              <p class="analysis-meta" id="analysisStats">Pulsa Analizar para leer archivos y carpetas del explorador.</p>
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

function syncSettingsInputs() {
  if (!overlayEls) return;

  const policy = overlayState.policy || DEFAULT_POLICY;
  overlayEls.teacherEnabled.checked = !!overlayState.assistantEnabled;
  overlayEls.backendUrlInput.value = overlayState.backendUrl;
  overlayEls.settingsSessionLabel.value = overlayState.session?.user?.displayName || "Sesion sin iniciar";
  overlayEls.settingsSessionMeta.value = overlayState.session
    ? `${overlayState.session.user.role === "teacher" ? "Profesor" : "Estudiante"} | ${overlayState.session.user.email}`
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
  const statusText = overlayState.loading
    ? "Preparando contexto..."
    : overlayState.statusMessage || buildMainStatus(context);
  const showingAuthView = overlayState.started && !hasActiveSession();
  const showingMainView = overlayState.started && hasActiveSession();
  const currentRole = overlayState.session?.user?.role === "teacher" ? "Profesor" : "Estudiante";

  overlayEls.welcomeView.hidden = overlayState.started;
  overlayEls.authView.hidden = !showingAuthView;
  overlayEls.mainView.hidden = !showingMainView;

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
  overlayEls.policyLead.textContent = isTeacherSession()
    ? "Estas viendo y administrando la politica activa del piloto."
    : "La ayuda del estudiante sigue la politica configurada por el docente.";
  overlayEls.sessionBadge.textContent = overlayState.session
    ? `${overlayState.session.user.displayName} | ${currentRole} | ${overlayState.session.user.email}`
    : "Sesion sin iniciar.";
  overlayEls.policySectionTitle.textContent = isTeacherSession()
    ? "Politica aplicada"
    : "Mis parametros asignados";
  overlayEls.teacherSummary.textContent = buildTeacherSummary();
  overlayEls.statusText.textContent = statusText;
  overlayEls.authError.textContent = overlayState.authError || "";
  overlayEls.startBtn.disabled = overlayState.loading;
  overlayEls.refreshBtn.disabled = overlayState.loading || !overlayState.assistantEnabled || !showingMainView;
  overlayEls.logoutHeaderBtn.disabled = !showingMainView;
  overlayEls.analyzeProjectBtn.disabled = overlayState.analysisBusy || !showingMainView;
  overlayEls.authSubmitBtn.disabled = overlayState.authBusy;
  overlayEls.authBackBtn.disabled = overlayState.authBusy;

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
    overlayEls.studentGoalSection.hidden = isTeacherSession();
    overlayEls.studentIdeasSection.hidden = isTeacherSession();
    overlayEls.teacherPolicySection.hidden = !isTeacherSession();
    overlayEls.teacherTelemetrySection.hidden = !isTeacherSession();

    if (isTeacherSession()) {
      renderTeacherPolicyList();
      renderTelemetryList();
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
      const roleLabel = user.role === "teacher" ? "profesor" : "estudiante";
      overlayState.statusMessage = `Bienvenido ${roleLabel} ${user.displayName}.`;
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
  overlayState.analysisWindowOpen = false;
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
    mainView: overlayRoot.getElementById("mainView"),
    welcomeContext: overlayRoot.getElementById("welcomeContext"),
    welcomeCopy: overlayRoot.getElementById("welcomeCopy"),
    startBtn: overlayRoot.getElementById("startBtn"),
    authEmail: overlayRoot.getElementById("authEmail"),
    authPassword: overlayRoot.getElementById("authPassword"),
    authSubmitBtn: overlayRoot.getElementById("authSubmitBtn"),
    authBackBtn: overlayRoot.getElementById("authBackBtn"),
    authError: overlayRoot.getElementById("authError"),
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
    studentGoalSection: overlayRoot.getElementById("studentGoalSection"),
    studentIdeasSection: overlayRoot.getElementById("studentIdeasSection"),
    goalGrid: overlayRoot.getElementById("goalGrid"),
    ideaList: overlayRoot.getElementById("ideaList"),
    guideList: overlayRoot.getElementById("guideList"),
    teacherPolicySection: overlayRoot.getElementById("teacherPolicySection"),
    teacherPolicyList: overlayRoot.getElementById("teacherPolicyList"),
    teacherTelemetrySection: overlayRoot.getElementById("teacherTelemetrySection"),
    telemetryList: overlayRoot.getElementById("telemetryList"),
    reloadTelemetryBtn: overlayRoot.getElementById("reloadTelemetryBtn"),
    previewText: overlayRoot.getElementById("previewText"),
    statusText: overlayRoot.getElementById("statusText"),
    settingsSessionLabel: overlayRoot.getElementById("settingsSessionLabel"),
    settingsSessionMeta: overlayRoot.getElementById("settingsSessionMeta"),
    teacherEnabled: overlayRoot.getElementById("teacherEnabled"),
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
  overlayEls.refreshBtn.addEventListener("click", async () => {
    await refreshMentorSession();
  });
  overlayEls.analyzeProjectBtn.addEventListener("click", async () => {
    await analyzeCodespaceProject();
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
  overlayState.analysisWindowOpen = false;
  overlayState.projectAnalysis = null;
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
  overlayState.analysisWindowOpen = false;
  overlayState.projectAnalysis = null;
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

  overlayState.welcome = buildWelcomeText(context, goal);
  overlayState.ideas = buildIdeas(context, language, goal.id);
  overlayState.guide = buildGuide(goal.id, context);
  overlayState.statusMessage = buildMainStatus(context);

  if (overlayState.assistantEnabled && context.pageContext !== "unknown" && normalizeBaseUrl(overlayState.backendUrl)) {
    try {
      const remote = await requestBackendMentor(context, language);
      if (remote.ideas.length > 0) overlayState.ideas = remote.ideas;
      if (remote.guide.length > 0) overlayState.guide = remote.guide;
      if (remote.welcome) overlayState.welcome = remote.welcome;
      if (remote.summary) overlayState.statusMessage = remote.summary;
      if (isTeacherSession()) {
        await reloadPolicyAndTelemetry();
      }
    } catch {
      overlayState.statusMessage = `${buildMainStatus(context)} Se usa apoyo local por ahora.`;
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

// ADACEEN | Capa 2 - Contexto: lectura del DOM de la pagina (GitHub, Codespaces, Campus) y utilidades de texto/URL.
// Orden de carga: manifest.json (content_scripts) y background.js (CONTENT_SCRIPT_FILES) deben coincidir.

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

// Primeros segmentos de github.com que son paginas de GitHub, no un owner: el OAuth
// (login/oauth/authorize), la instalacion de la GitHub App (apps/<app>/installations/new), el
// codigo de dispositivo (login/device), ajustes, organizaciones... GitHub no deja registrar
// cuentas con esos nombres, asi que "login/oauth" o "apps/adaceen-piloto" nunca son un
// repositorio.
const GITHUB_RESERVED_OWNERS = new Set([
  "about", "account", "apps", "blog", "codespaces", "collections", "contact", "copilot",
  "customer-stories", "dashboard", "discussions", "enterprise", "enterprises", "events",
  "explore", "features", "github-copilot", "issues", "join", "login", "logout", "marketplace",
  "new", "notifications", "organizations", "orgs", "password_reset", "pricing", "pulls",
  "readme", "search", "security", "sessions", "settings", "signup", "site", "sponsors", "stars",
  "team", "teams", "topics", "trending", "users", "watching",
]);

function isGithubReservedOwner(owner) {
  return GITHUB_RESERVED_OWNERS.has(toText(owner).toLowerCase());
}

// github.com/login/..., github.com/apps/..., github.com/settings/...: paginas del propio flujo
// de GitHub (OAuth, instalacion de la App, codigo de dispositivo), sin repositorio.
function isGithubFlowPageUrl(value) {
  try {
    const url = new URL(toText(value));
    if (url.hostname.toLowerCase() !== "github.com") return false;
    const owner = url.pathname.split("/").filter(Boolean)[0] || "";
    return !!owner && isGithubReservedOwner(owner);
  } catch {
    return false;
  }
}

function getGitHubInfo() {
  try {
    const url = new URL(location.href);
    const host = url.hostname.toLowerCase();
    const parts = url.pathname.split("/").filter(Boolean);

    const isGitHubHost = host === "github.com";
    // Un tunel de VS Code (vscode.dev/tunnel/<nombre>/...) es el mismo editor
    // web que un Codespace, asi que se trata igual: pageType "codespace".
    const isTunnelHost =
      (host === "vscode.dev" || host === "insiders.vscode.dev") &&
      parts[0]?.toLowerCase() === "tunnel";
    const isCodespaceHost =
      host === "github.dev" ||
      host.endsWith(".github.dev") ||
      host === "app.github.dev" ||
      host.endsWith(".app.github.dev") ||
      isTunnelHost;

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
    } else if (isGitHubHost && parts.length >= 2 && !isGithubReservedOwner(parts[0])) {
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

function toText(value) {
  return String(value || "").trim();
}

// ---- Repositorio GitHub: parseo de owner/repo ----

function parseRepoFullName(value) {
  const raw = toText(value);
  const urlPath = raw
    .replace(/^https?:\/\/github\.com\//i, "")
    .replace(/^https?:\/\/codespaces\.new\//i, "")
    .replace(/[?#].*$/g, "")
    .replace(/^\/+|\/+$/g, "");
  const urlParts = urlPath.split("/").filter(Boolean);
  if (urlParts[0]?.toLowerCase() === "codespaces"
    && urlParts[1]?.toLowerCase() === "new"
    && urlParts[2]
    && urlParts[3]) {
    return `${urlParts[2]}/${urlParts[3].replace(/\.git$/i, "")}`;
  }
  if (urlParts[0]?.toLowerCase() === "codespaces" && urlParts[1]?.toLowerCase() === "new") {
    return "";
  }
  if (/^https?:\/\/codespaces\.new\//i.test(raw) && urlParts[0] && urlParts[1]) {
    return `${urlParts[0]}/${urlParts[1].replace(/\.git$/i, "")}`;
  }

  const text = raw
    .replace(/^https?:\/\/github\.com\//i, "")
    .replace(/\/(tree|blob)\/.*$/i, "")
    .replace(/[?#].*$/g, "")
    .replace(/\.git$/i, "")
    .replace(/^\/+|\/+$/g, "");
  if (!text) return "";

  const match = text.match(/^([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+)$/);
  if (!match || isGithubReservedOwner(match[1])) return "";
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

// Devuelve la URL absoluta solo si el esquema es http o https (A12.8). Todo enlace o
// navegacion construido con datos del backend, del modelo o de la pagina pasa por aqui:
// bloquea javascript:, data:, blob:, file:, vbscript:, etc. Con baseUrl resuelve rutas relativas.
function toSafeHttpUrl(value, baseUrl = "") {
  const text = toText(value);
  if (!text) return "";
  try {
    const url = baseUrl ? new URL(text, baseUrl) : new URL(text);
    return url.protocol === "https:" || url.protocol === "http:" ? url.href : "";
  } catch {
    return "";
  }
}

function unique(items) {
  return [...new Set(items.filter(Boolean).map((item) => toText(item)))];
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

  const payload = {
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

  // A6.2: aqui es donde el overlay detecta errores visibles; la telemetria decide si
  // emite error_detected / blocking_detected (deduplicado y solo con el overlay activo).
  if (typeof observeVisibleErrorSignal === "function") {
    try {
      observeVisibleErrorSignal(payload);
    } catch {}
  }

  return payload;
}

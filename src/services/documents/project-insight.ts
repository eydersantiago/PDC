// Contexto del proyecto: prompts del insight (codigo y captura de pantalla), respuesta del modelo e insight de respaldo.
import { trimText } from "../shared/text-utils.js";
import { type ProjectScanStoredFile, type MainFileCandidate, normalizeRepoPath } from "./project-scan-files.js";

export type ProjectScreenshotCaptureEntry = {
  type?: string;
  name?: string;
  path?: string;
  level?: number;
};

export type ProjectScreenshotCaptureContext = {
  capturedAt?: string;
  overlayHidden?: boolean;
  viewport?: {
    width?: number;
    height?: number;
    offsetLeft?: number;
    offsetTop?: number;
    scrollX?: number;
    scrollY?: number;
    devicePixelRatio?: number;
  };
  url?: string;
  title?: string;
  pageContext?: string;
  pageType?: string;
  repoFullName?: string;
  branch?: string;
  filePath?: string;
  languageHint?: string;
  codespaceBreadcrumbs?: string[];
  codespaceActiveTabs?: string[];
  visibleError?: string;
  selection?: string;
  visibleText?: string;
  codeSnippet?: string;
  codeLineCount?: number;
  explorerEntries?: ProjectScreenshotCaptureEntry[];
};

function truncateText(value: string, max = 280) {
  const text = trimText(value);
  if (!text) return "";
  if (text.length <= max) return text;
  return `${text.slice(0, Math.max(0, max - 3))}...`;
}

function extractModelJsonObject(rawOutput: string) {
  const direct = trimText(rawOutput);
  if (!direct) return null;

  const candidates = [direct];
  const start = direct.indexOf("{");
  const end = direct.lastIndexOf("}");
  if (start >= 0 && end > start) {
    candidates.push(direct.slice(start, end + 1));
  }

  for (const candidate of candidates) {
    try {
      const parsed = JSON.parse(candidate) as Record<string, unknown>;
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) continue;
      return parsed;
    } catch {}
  }

  return null;
}

export function parseModelInsight(rawOutput: string) {
  const parsed = extractModelJsonObject(rawOutput);
  if (!parsed) return null;
  return {
    summary: truncateText(String(parsed.summary || ""), 900),
    mainFilePath: trimText(parsed.mainFilePath),
    mainFileReason: truncateText(String(parsed.mainFileReason || parsed.reason || ""), 320),
    autoAdvice: truncateText(String(parsed.autoAdvice || parsed.advice || ""), 420),
  };
}

export function parseScreenshotModelInsight(rawOutput: string) {
  const parsed = extractModelJsonObject(rawOutput);
  if (!parsed) return null;

  const rawConfidence = Number(parsed.confidence ?? parsed.mainFileConfidence ?? 0);
  const normalizedConfidence = Number.isFinite(rawConfidence)
    ? Math.max(0, Math.min(100, Math.round(rawConfidence)))
    : 0;

  return {
    summary: truncateText(String(parsed.summary || ""), 900),
    mainFilePath: trimText(parsed.mainFilePath || parsed.main_file_path || parsed.filePath || ""),
    mainFileReason: truncateText(String(parsed.mainFileReason || parsed.reason || ""), 380),
    autoAdvice: truncateText(String(parsed.autoAdvice || parsed.advice || ""), 420),
    ocrText: truncateText(String(parsed.ocrText || parsed.visibleText || parsed.text || ""), 1800),
    confidence: normalizedConfidence,
  };
}

export function buildProjectInsightPrompt(params: {
  repoFullName: string;
  version: string;
  files: ProjectScanStoredFile[];
  heuristicMainFilePath: string;
  heuristicReason: string;
  candidates: MainFileCandidate[];
}) {
  const byNormalizedPath = new Map<string, ProjectScanStoredFile>();
  for (const file of params.files) {
    byNormalizedPath.set(normalizeRepoPath(file.path), file);
  }

  const selectedPaths = [
    ...params.candidates.map((item) => item.path),
    ...params.files.slice(0, 12).map((item) => item.path),
  ]
    .map((item) => normalizeRepoPath(item))
    .filter(Boolean)
    .filter((item, index, array) => array.indexOf(item) === index)
    .slice(0, 12);

  const fileBlocks = selectedPaths.map((normalizedPath, index) => {
    const file = byNormalizedPath.get(normalizedPath);
    if (!file) return "";
    const preview = truncateText(file.preview || file.content || "", 320);
    const contentSnippet = truncateText(file.content || "", 900);
    return [
      `# Archivo ${index + 1}`,
      `path: ${file.path}`,
      `lines: ${file.lines}`,
      `bytes: ${file.bytes}`,
      `preview: ${preview || "(sin preview)"}`,
      "snippet:",
      contentSnippet || "(sin contenido)",
      "",
    ].join("\n");
  }).filter(Boolean);

  const candidateLines = params.candidates.length > 0
    ? params.candidates.map((item, index) => `${index + 1}. ${item.path} | score=${item.score} | ${item.reason}`).join("\n")
    : "1. (sin candidatos)";

  return [
    "Eres un analista tecnico de repositorios para un dashboard educativo.",
    "Debes devolver SOLO un JSON valido (sin markdown) con este formato exacto:",
    "{\"summary\":\"...\",\"mainFilePath\":\"...\",\"mainFileReason\":\"...\",\"autoAdvice\":\"...\"}",
    "Reglas:",
    "- summary: maximo 3 frases cortas, explica de que trata el proyecto.",
    "- mainFilePath: ruta exacta de archivo dentro del repositorio.",
    "- mainFileReason: por que ese archivo es el principal.",
    "- autoAdvice: consejo concreto y corto para el estudiante en ese archivo.",
    "- Si no estas seguro de la ruta principal, usa el candidato mas probable.",
    "",
    `repo: ${params.repoFullName}`,
    `version: ${params.version || "sin_version"}`,
    `heuristicMainFile: ${params.heuristicMainFilePath || "(sin detectar)"}`,
    `heuristicReason: ${params.heuristicReason || "(sin razon)"}`,
    "",
    "Top candidatos heuristicos:",
    candidateLines,
    "",
    "Archivos y fragmentos:",
    fileBlocks.join("\n"),
  ].join("\n");
}

export function buildProjectScreenshotInsightPrompt(params: {
  repoFullName: string;
  version: string;
  files: ProjectScanStoredFile[];
  heuristicMainFilePath: string;
  heuristicReason: string;
  candidates: MainFileCandidate[];
  captureContext?: ProjectScreenshotCaptureContext;
}) {
  const pathList = params.files
    .map((file) => trimText(file.path))
    .filter(Boolean)
    .slice(0, 260);
  const candidateLines = params.candidates.length > 0
    ? params.candidates.map((item, index) => `${index + 1}. ${item.path} | score=${item.score} | ${item.reason}`).join("\n")
    : "1. (sin candidatos)";
  const captureContextBlock = buildScreenshotCaptureContextBlock(params.captureContext);

  return [
    "Analiza una captura de pantalla de VS Code/Codespaces.",
    "Objetivo: aplicar OCR visual reforzado + detectar archivo principal + dar consejo.",
    "Responde SOLO JSON valido (sin markdown) con este formato exacto:",
    "{\"summary\":\"...\",\"mainFilePath\":\"...\",\"mainFileReason\":\"...\",\"autoAdvice\":\"...\",\"ocrText\":\"...\",\"confidence\":0}",
    "Reglas estrictas:",
    "- La captura se toma con el overlay ADACEEN oculto; si aun aparece contenido de ADACEEN, ignoralo por completo.",
    "- Lee visualmente tabs, breadcrumb, explorer, editor, terminal y mensajes de error.",
    "- Contrasta el OCR con el contexto DOM complementario para evitar confundir texto cortado o tapado.",
    "- mainFilePath debe ser una ruta exacta del repositorio cuando sea posible.",
    "- Si el OCR no confirma ruta exacta, usa primero filePath/breadcrumb/tabs del contexto DOM y luego heuristicMainFile.",
    "- summary: maximo 3 frases cortas.",
    "- mainFileReason: breve y concreta (maximo 2 frases).",
    "- autoAdvice: accion puntual para el estudiante sobre ese archivo.",
    "- ocrText: resume texto visible util en secciones: tabs/breadcrumb/explorer/editor/terminal; no inventes rutas.",
    "- confidence: entero de 0 a 100.",
    "",
    `repo: ${params.repoFullName}`,
    `version: ${params.version || "sin_version"}`,
    `heuristicMainFile: ${params.heuristicMainFilePath || "(sin detectar)"}`,
    `heuristicReason: ${params.heuristicReason || "(sin razon)"}`,
    "",
    "Top candidatos heuristicos:",
    candidateLines,
    "",
    captureContextBlock,
    "",
    "Rutas conocidas del repositorio (elige de aqui si coincide OCR):",
    pathList.map((item) => `- ${item}`).join("\n"),
  ].join("\n");
}

function buildScreenshotCaptureContextBlock(context: ProjectScreenshotCaptureContext | undefined) {
  if (!context || typeof context !== "object") {
    return "Contexto DOM complementario: (no enviado).";
  }

  const breadcrumbs = Array.isArray(context.codespaceBreadcrumbs)
    ? context.codespaceBreadcrumbs.map((item) => trimText(item)).filter(Boolean).slice(0, 12)
    : [];
  const activeTabs = Array.isArray(context.codespaceActiveTabs)
    ? context.codespaceActiveTabs.map((item) => trimText(item)).filter(Boolean).slice(0, 8)
    : [];
  const explorerEntries = Array.isArray(context.explorerEntries)
    ? context.explorerEntries
      .map((entry) => {
        const type = trimText(entry?.type);
        const pathValue = trimText(entry?.path);
        if (!pathValue) return "";
        return `${type || "item"}: ${pathValue}`;
      })
      .filter(Boolean)
      .slice(0, 120)
    : [];

  const viewport = context.viewport || {};
  const viewportText = [
    Number(viewport.width) || 0,
    Number(viewport.height) || 0,
  ].every(Boolean)
    ? `${Math.round(Number(viewport.width))}x${Math.round(Number(viewport.height))} dpr=${Number(viewport.devicePixelRatio) || 1}`
    : "";

  const lines = [
    "Contexto DOM complementario extraido antes de la captura:",
    `overlayHidden: ${context.overlayHidden === true ? "true" : "unknown"}`,
    viewportText ? `viewport: ${viewportText}` : "",
    context.capturedAt ? `capturedAt: ${truncateText(context.capturedAt, 80)}` : "",
    context.title ? `title: ${truncateText(context.title, 180)}` : "",
    context.url ? `url: ${truncateText(context.url, 260)}` : "",
    context.pageType ? `pageType: ${truncateText(context.pageType, 60)}` : "",
    context.branch ? `branch: ${truncateText(context.branch, 120)}` : "",
    context.filePath ? `filePath: ${truncateText(context.filePath, 260)}` : "",
    context.languageHint ? `languageHint: ${truncateText(context.languageHint, 80)}` : "",
    breadcrumbs.length ? `breadcrumbs: ${breadcrumbs.join(" / ")}` : "",
    activeTabs.length ? `activeTabs: ${activeTabs.join(" | ")}` : "",
    context.visibleError ? `visibleError: ${truncateText(context.visibleError, 500)}` : "",
    context.selection ? `selection: ${truncateText(context.selection, 700)}` : "",
    context.codeLineCount ? `codeLineCount: ${Math.max(0, Number(context.codeLineCount) || 0)}` : "",
    context.codeSnippet ? `editorSnippet:\n${truncateText(context.codeSnippet, 2200)}` : "",
    context.visibleText ? `visibleTextExcerpt:\n${truncateText(context.visibleText, 1200)}` : "",
    explorerEntries.length ? `visibleExplorerEntries:\n${explorerEntries.map((item) => `- ${item}`).join("\n")}` : "",
  ].filter(Boolean);

  return lines.join("\n");
}

export function parseImageDataUrl(rawValue: string) {
  const clean = trimText(rawValue);
  if (!clean) return null;

  const match = clean.match(/^data:(image\/(?:png|jpe?g|webp|gif|bmp|tiff));base64,([a-z0-9+/=\s]+)$/i);
  if (!match) return null;

  const mimeType = match[1].toLowerCase() === "image/jpg"
    ? "image/jpeg"
    : match[1].toLowerCase();
  const extensionByMime: Record<string, string> = {
    "image/png": "png",
    "image/jpeg": "jpg",
    "image/webp": "webp",
    "image/gif": "gif",
    "image/bmp": "bmp",
    "image/tiff": "tiff",
  };
  const extension = extensionByMime[mimeType];
  if (!extension) return null;

  const base64Payload = match[2].replace(/\s+/g, "");
  if (!base64Payload) return null;

  let buffer = Buffer.alloc(0);
  try {
    buffer = Buffer.from(base64Payload, "base64");
  } catch {
    return null;
  }
  if (!buffer.length) return null;

  return {
    mimeType,
    extension,
    buffer,
  };
}

export function buildFallbackInsight(params: {
  repoFullName: string;
  version: string;
  mainFilePath: string;
  mainFileReason: string;
  totalFiles: number;
}) {
  const mainFile = params.mainFilePath || "(sin detectar)";
  const reason = params.mainFileReason || "candidato estimado por estructura y contenido";
  return {
    summary: `Repositorio ${params.repoFullName} con ${params.totalFiles} archivo(s) escaneado(s). Version activa: ${params.version || "sin_version"}.`,
    mainFilePath: mainFile,
    mainFileReason: reason,
    autoAdvice: params.mainFilePath
      ? `Empieza por ${params.mainFilePath}: valida flujo de entrada, rutas y dependencias principales antes de cambios grandes.`
      : "Primero abre el archivo de entrada del proyecto y valida que ruta o funcion inicia la ejecucion.",
  };
}

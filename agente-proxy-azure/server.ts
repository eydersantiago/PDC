import "dotenv/config";
import express from "express";
import cors from "cors";
import multer from "multer";
import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { runText } from "./runText.js";
import { runImage } from "./runImage.js";
import { runSuggestTab } from "./runSuggestTab.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname  = path.dirname(__filename);
const app = express();
app.use(express.json({ limit: "20mb" }));

const targetMode = (process.env.AGENT_TARGET || "local").trim().toLowerCase();
const azureServer = (process.env.AZURE_SERVER_URL || "").trim().replace(/\/+$/, "");
const useAzureServer = targetMode === "azure";
const maxTabContentChars = +(process.env.MAX_TAB_CONTENT_CHARS || 12000);
const maxMentorCodeChars = +(process.env.MAX_MENTOR_CODE_CHARS || 6000);

if (useAzureServer && !azureServer) {
  console.warn("[config] AGENT_TARGET=azure pero AZURE_SERVER_URL esta vacia.");
}

const allowed = (process.env.ALLOWED_ORIGINS || "")
  .split(",").map(s => s.trim()).filter(Boolean);

function isOriginAllowed(origin?: string) {
  if (!origin) return true;
  if (allowed.length === 0) return true;
  return allowed.some(a => origin.startsWith(a));
}

app.use(cors({
  origin: (origin, cb) => isOriginAllowed(origin)
    ? cb(null, true)
    : cb(new Error(`Origin no permitido: ${origin}`), false),
}));

const uploadsDir = path.join(process.cwd(), "uploads");
if (!fs.existsSync(uploadsDir)) fs.mkdirSync(uploadsDir, { recursive: true });

const upload = multer({
  storage: multer.diskStorage({
    destination: (_r, _f, cb) => cb(null, uploadsDir),
    filename: (_r, f, cb) => {
      const ext = path.extname(f.originalname || "");
      cb(null, `${Date.now()}-${Math.random().toString(36).slice(2)}${ext}`);
    },
  }),
  limits: { fileSize: 8 * 1024 * 1024 },
  fileFilter: (_r, f, cb) => cb(null, /image\/(png|jpeg|webp|gif|bmp|tiff)/.test(f.mimetype)),
});

async function parseJsonResponse(res: Response, label: string) {
  const bodyText = await res.text();
  if (!res.ok) throw new Error(`${label} HTTP ${res.status}: ${bodyText}`);

  try {
    return JSON.parse(bodyText) as { output_text?: unknown };
  } catch {
    throw new Error(`${label} devolvio una respuesta no JSON`);
  }
}

async function runTextByMode(input: string) {
  if (!useAzureServer) return runText(input);
  if (!azureServer) throw new Error("Falta AZURE_SERVER_URL para AGENT_TARGET=azure");

  const res = await fetch(`${azureServer}/run-text`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ input_as_text: input }),
  });

  const data = await parseJsonResponse(res, "Azure /run-text");
  return String(data.output_text ?? "");
}

type UploadedImage = { path: string; mimetype?: string; originalname?: string };

async function runImageByMode(file: UploadedImage, prompt: string) {
  if (!useAzureServer) return runImage(file.path, prompt);
  if (!azureServer) throw new Error("Falta AZURE_SERVER_URL para AGENT_TARGET=azure");

  const image = await fsp.readFile(file.path);
  const form = new FormData();
  form.set(
    "image",
    new Blob([image], { type: file.mimetype || "application/octet-stream" }),
    file.originalname || path.basename(file.path),
  );
  form.set("prompt", prompt);

  const res = await fetch(`${azureServer}/run-image`, {
    method: "POST",
    body: form,
  });

  const data = await parseJsonResponse(res, "Azure /run-image");
  return String(data.output_text ?? "");
}

function buildTabSuggestionPrompt(params: {
  tabContent: string;
  question?: string;
  tabTitle?: string;
  tabUrl?: string;
}) {
  const question = params.question?.trim() || "Dame sugerencias basicas sobre este contenido.";
  const safeContent = params.tabContent.slice(0, Math.max(1, maxTabContentChars));

  return [
    "Analiza el contenido de la pestaña y responde en Markdown.",
    "Formato estricto:",
    "1) Resumen corto (max 5 lineas).",
    "2) 3 sugerencias basicas y accionables.",
    "3) 2 dudas o riesgos detectados.",
    "Si hay enlaces visibles relevantes, mencionarlos y aclarar si solo se detecta el enlace o tambien su contenido.",
    "Si falta contexto, dilo sin inventar.",
    "",
    `Titulo: ${params.tabTitle || "(sin titulo)"}`,
    `URL: ${params.tabUrl || "(sin URL)"}`,
    `Pregunta del usuario: ${question}`,
    "",
    "Contenido de la pestaña:",
    safeContent,
  ].join("\n");
}

type MentorPageContext = "campus" | "github" | "unknown";
type LearningGoalId = "oop_basics" | "encapsulation" | "inheritance" | "debugging" | "github_flow";
type GithubMentorPageType = "campus" | "github_code" | "github_general" | "codespace" | "other";

type GithubMentorContext = {
  url?: string;
  title?: string;
  pageContext?: MentorPageContext;
  pageType?: GithubMentorPageType;
  repoOwner?: string;
  repoName?: string;
  repoFullName?: string;
  branch?: string;
  filePath?: string;
  languageHint?: string;
  activityTitle?: string;
  learningGoal?: LearningGoalId;
  selection?: string;
  visibleError?: string;
  codeSnippet?: string;
  codeLineCount?: number;
};

type GithubMentorResult = {
  ideas: string[];
  searches: string[];
  guide: string[];
  welcome_message: string;
  analysis_summary: string;
};

const MENTOR_GUIDE_STEPS = [
  "En GitHub haz click en New repository y define nombre, visibilidad y README.",
  "Sube el primer commit con estructura base del proyecto.",
  "Abre el repo y entra a Code > Codespaces > Create codespace on main.",
  "Crea una rama feature/idea-inicial para trabajar sin tocar main.",
  "Implementa una version minima funcional en commits pequenos y claros.",
  "Ejecuta pruebas, corrige y abre Pull Request con descripcion breve.",
  "Actualiza README con pasos de ejecucion en Codespaces.",
];

const MENTOR_IDEAS_BY_LANGUAGE: Record<string, string[]> = {
  JavaScript: [
    "Construye una extension pequena que valide estilos de codigo en GitHub.",
    "Crea un mini dashboard que lea JSON y grafique metricas de commits.",
    "Implementa un parser de TODOs para convertirlos en issues automaticamente.",
  ],
  TypeScript: [
    "Crea un CLI tipado para automatizar flujos de repo y ramas.",
    "Disena un validador de contratos JSON con tipos estrictos.",
    "Implementa un bot local que revise convenciones de commits.",
  ],
  Python: [
    "Crea un script que escanee repos y reporte deuda tecnica basica.",
    "Construye una API simple para sugerencias de refactor por archivo.",
    "Haz un analizador de complejidad ciclomatica por modulo.",
  ],
  "C++": [
    "Arma un proyecto modular con .h/.cpp y pruebas unitarias basicas.",
    "Crea una libreria pequena con clases y polimorfismo bien definido.",
    "Implementa un benchmark simple para comparar estructuras de datos.",
  ],
  Java: [
    "Construye un microservicio CRUD con pruebas de integracion.",
    "Crea un motor pequeno de reglas con interfaces y herencia.",
    "Implementa un validador de arquitectura por paquetes.",
  ],
  Go: [
    "Desarrolla un servicio HTTP con middlewares y logs estructurados.",
    "Crea una herramienta de linea de comandos para auditoria de repos.",
    "Implementa workers concurrentes para procesar tareas por lotes.",
  ],
  Rust: [
    "Crea una utilidad CLI segura para limpieza de archivos temporales.",
    "Implementa un parser de configuracion con manejo robusto de errores.",
    "Construye un microservicio asincrono con pruebas de carga basicas.",
  ],
  General: [
    "Crea una feature pequena y cerrada en una rama nueva.",
    "Define pruebas minimas antes de tocar el archivo principal.",
    "Propone una mejora de README con pasos de ejecucion reproducibles.",
  ],
};

const LANGUAGE_BY_EXTENSION: Record<string, string> = {
  ".js": "JavaScript",
  ".jsx": "JavaScript",
  ".ts": "TypeScript",
  ".tsx": "TypeScript",
  ".py": "Python",
  ".java": "Java",
  ".cpp": "C++",
  ".cc": "C++",
  ".cxx": "C++",
  ".c": "C",
  ".cs": "C#",
  ".go": "Go",
  ".rs": "Rust",
  ".php": "PHP",
  ".rb": "Ruby",
  ".kt": "Kotlin",
  ".swift": "Swift",
  ".sql": "SQL",
  ".html": "HTML",
  ".css": "CSS",
  ".scss": "SCSS",
  ".md": "Markdown",
};

function trimText(value: unknown) {
  return String(value || "").trim();
}

function uniqueStrings(items: unknown[]) {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const item of items) {
    const text = trimText(item);
    if (!text) continue;
    const key = text.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(text);
  }
  return out;
}

function basenameSafe(value: string) {
  const parts = trimText(value).split("/").filter(Boolean);
  return parts[parts.length - 1] || "";
}

function getPathExtension(value: string) {
  const base = basenameSafe(value);
  const idx = base.lastIndexOf(".");
  if (idx < 0) return "";
  return base.slice(idx).toLowerCase();
}

function inferLanguage(context: GithubMentorContext) {
  const hint = trimText(context.languageHint);
  if (hint) return hint;
  const ext = getPathExtension(trimText(context.filePath));
  return LANGUAGE_BY_EXTENSION[ext] || "General";
}

function normalizePageType(raw: unknown): GithubMentorPageType {
  const value = trimText(raw);
  if (value === "campus") return "campus";
  if (value === "github_code") return "github_code";
  if (value === "github_general") return "github_general";
  if (value === "codespace") return "codespace";
  return "other";
}

function normalizePageContext(raw: unknown): MentorPageContext {
  const value = trimText(raw);
  if (value === "campus") return "campus";
  if (value === "github") return "github";
  return "unknown";
}

function normalizeLearningGoal(raw: unknown): LearningGoalId {
  const value = trimText(raw);
  if (value === "encapsulation") return "encapsulation";
  if (value === "inheritance") return "inheritance";
  if (value === "debugging") return "debugging";
  if (value === "github_flow") return "github_flow";
  return "oop_basics";
}

function resolvePageContext(rawPageContext: unknown, rawPageType: unknown): MentorPageContext {
  const pageContext = normalizePageContext(rawPageContext);
  if (pageContext !== "unknown") return pageContext;

  const pageType = normalizePageType(rawPageType);
  if (pageType === "campus") return "campus";
  if (pageType === "github_code" || pageType === "github_general" || pageType === "codespace") {
    return "github";
  }
  return "unknown";
}

function analyzeCodeSignals(codeText: string) {
  return {
    todoCount: (codeText.match(/\b(TODO|FIXME)\b/g) || []).length,
    functionCount: (codeText.match(/\b(function|def|func|fn|public\s+\w+|private\s+\w+)\b/g) || []).length,
    classCount: (codeText.match(/\b(class|struct|interface)\b/g) || []).length,
    hasTests: /\b(describe\(|it\(|pytest|unittest|assert\s|@Test)\b/i.test(codeText),
  };
}

function goalLabel(goal: LearningGoalId) {
  if (goal === "encapsulation") return "encapsulamiento";
  if (goal === "inheritance") return "herencia y polimorfismo";
  if (goal === "debugging") return "resolucion de errores";
  if (goal === "github_flow") return "flujo de GitHub y Codespaces";
  return "clases y objetos";
}

function buildGoalIdeas(goal: LearningGoalId, language: string) {
  if (goal === "encapsulation") {
    return [
      "Revisa que datos deban quedar protegidos y cuales pueden exponerse.",
      "Valida si tus metodos cambian estado de forma controlada y coherente.",
      "Evita que otras partes del programa modifiquen atributos sensibles sin reglas claras.",
    ];
  }
  if (goal === "inheritance") {
    return [
      "Comprueba si la relacion entre clases realmente es de tipo es-un y no solo reutilizacion.",
      "Busca comportamiento comun para moverlo a una clase base o interfaz.",
      "Si sobrescribes metodos, verifica que cada subtipo respete el contrato esperado.",
    ];
  }
  if (goal === "debugging") {
    return [
      "Aisla primero la linea o bloque donde aparece la falla antes de hacer cambios grandes.",
      "Formula una hipotesis corta del error y prueba una sola correccion por intento.",
      "Compara lo que el programa hace con lo que el enunciado o la clase deberia lograr.",
    ];
  }
  if (goal === "github_flow") {
    return [
      "Trabaja en una rama corta para que cada cambio sea facil de revisar.",
      "Haz commits pequenos que expliquen la intencion del cambio, no solo el archivo tocado.",
      "Antes de entregar, revisa diff, mensajes de error y estado de tu repositorio.",
    ];
  }
  return [
    "Identifica las entidades del problema antes de crear nuevas clases.",
    "Define para cada clase una sola responsabilidad facil de explicar.",
    `Piensa que atributos y metodos necesita realmente tu modelo en ${language}.`,
  ];
}

function buildGoalSearches(goal: LearningGoalId, language: string) {
  if (goal === "encapsulation") {
    return [
      "Que atributos deberian ser privados en este ejercicio",
      "Cuando usar getters, setters o metodos de negocio",
      `Buenas practicas de encapsulamiento en ${language}`,
    ];
  }
  if (goal === "inheritance") {
    return [
      "Que comportamiento es comun y cual cambia entre clases",
      "Cuando preferir composicion frente a herencia",
      `Ejemplos de herencia y polimorfismo en ${language}`,
    ];
  }
  if (goal === "debugging") {
    return [
      "Cual es la primera evidencia concreta del error",
      "Que entrada minima reproduce el fallo",
      `Como leer mensajes de error en ${language}`,
    ];
  }
  if (goal === "github_flow") {
    return [
      "Que cambio pequeno puedo registrar hoy en una rama separada",
      "Como revisar mi diff antes de entregar",
      "Flujo basico de ramas y commits en GitHub Codespaces",
    ];
  }
  return [
    "Que entidad del problema deberia convertirse en clase primero",
    "Que datos pertenecen al objeto y cuales deberian llegar por parametro",
    `Ejemplos simples de clases y objetos en ${language}`,
  ];
}

function buildGuideForContext(goal: LearningGoalId, pageContext: MentorPageContext) {
  if (goal === "debugging") {
    return [
      "Ubica el error o comportamiento inesperado mas concreto que veas.",
      "Relaciona esa senal con el enunciado o con la parte del codigo que la produce.",
      "Formula una hipotesis y cambia una sola cosa a la vez.",
      "Ejecuta de nuevo o relee el mensaje para validar si mejoro.",
      "Si persiste, trae mas contexto en lugar de adivinar la solucion completa.",
    ];
  }

  if (goal === "github_flow") {
    return [
      "Abre el repo o Codespace donde vas a trabajar hoy.",
      "Crea o identifica una rama de trabajo corta y con nombre claro.",
      "Haz un cambio pequeno alineado con la meta de aprendizaje de hoy.",
      "Revisa el diff y escribe un commit que explique la intencion.",
      "Antes de entregar, valida que el resultado responda al enunciado.",
    ];
  }

  if (pageContext === "campus") {
    return [
      "Lee el enunciado completo y marca entradas, salidas y restricciones.",
      "Traduce el problema a una idea de clases, metodos o pasos.",
      "Pasa al archivo de codigo con una meta pequena y verificable.",
      "Vuelve al enunciado para comprobar si tu avance cumple lo pedido.",
      "Si te bloqueas, pide una pista sobre el paso exacto que no logras resolver.",
    ];
  }

  return [
    "Define una meta pequena para el archivo o ejercicio actual.",
    "Ubica la clase, metodo o bloque donde empezar sin tocar todo a la vez.",
    "Haz un cambio corto que puedas explicar con tus propias palabras.",
    "Valida el resultado con una prueba o lectura del flujo principal.",
    "Resume que aprendiste antes de pasar al siguiente cambio.",
  ];
}

function buildWelcomeForContext(pageContext: MentorPageContext, pageType: GithubMentorPageType, goal: LearningGoalId) {
  const focus = goalLabel(goal);
  if (pageContext === "campus") {
    return `Hola. Soy ADACEEN y te acompanare desde Campus Virtual. Hoy nos enfocaremos en ${focus}.`;
  }
  if (pageType === "codespace") {
    return `Hola. Veo que estas programando en Codespaces. Hoy trabajaremos ${focus}. Vamos a programar.`;
  }
  if (pageType === "github_code") {
    return `Hola. Estoy leyendo el archivo actual para apoyarte con ${focus}.`;
  }
  return `Hola. Estoy listo para darte pistas sobre ${focus}.`;
}

function buildHeuristicMentorResult(
  context: GithubMentorContext,
  question: string,
  maxItems: number,
): GithubMentorResult {
  const pageType = normalizePageType(context.pageType);
  const pageContext = resolvePageContext(context.pageContext, pageType);
  const goal = normalizeLearningGoal(context.learningGoal);
  const language = inferLanguage(context);
  const codeSnippet = trimText(context.codeSnippet).slice(0, maxMentorCodeChars);
  const repoFullName = trimText(context.repoFullName);
  const filePath = trimText(context.filePath);
  const fileName = basenameSafe(filePath);
  const visibleError = trimText(context.visibleError);
  const activityTitle = trimText(context.activityTitle);
  const signals = analyzeCodeSignals(codeSnippet);
  const ideas: string[] = [];
  const searches: string[] = [];

  ideas.push(...buildGoalIdeas(goal, language));
  searches.push(...buildGoalSearches(goal, language));

  if (pageContext === "campus") {
    ideas.push("Relaciona cada pista con el enunciado visible antes de escribir o cambiar codigo.");
    ideas.push("Subraya restricciones, entradas, salidas y palabras clave de la actividad.");
    searches.push("Que pide exactamente el enunciado y que parte todavia no cumplo");
    searches.push("Que criterio de evaluacion puedo verificar antes de codificar");
  } else if (pageType === "codespace") {
    ideas.push("Aprovecha el editor para probar una mejora pequena y validar de inmediato.");
    ideas.push("Si estas bloqueado, reduce el problema a un caso minimo ejecutable.");
    searches.push("Que parte del archivo actual deberia revisar primero");
    searches.push("Que evidencia de mi codigo respalda la siguiente correccion");
  } else if (pageType === "github_code") {
    ideas.push("Ubica en el archivo actual la seccion que corresponde al comportamiento que quieres reforzar.");
    searches.push("Que parte del archivo actual deberia revisar primero");
    searches.push("Que evidencia de mi codigo respalda la siguiente correccion");
  } else if (pageType === "github_general") {
    ideas.push("Abre un archivo del repositorio para recomendaciones mas precisas.");
  } else {
    ideas.push("Abre una actividad del Campus o un archivo del repositorio para darte pistas mas precisas.");
  }

  if (visibleError) {
    ideas.push(`Toma este mensaje como primera pista de depuracion: ${visibleError}`);
  }
  if (activityTitle && pageContext === "campus") {
    ideas.push(`Mantente alineado con la actividad visible: ${activityTitle}.`);
  }
  if (signals.todoCount > 0) {
    ideas.push(`Convierte ${signals.todoCount} TODO(s) en un plan corto de trabajo antes de seguir.`);
  }
  if (signals.functionCount >= 12) {
    ideas.push("El archivo se ve cargado: revisa si puedes separar funciones o responsabilidades.");
  }
  if (signals.classCount >= 5) {
    ideas.push("Hay varias clases visibles: compara responsabilidades antes de crear otra mas.");
  }
  if (codeSnippet && !signals.hasTests && goal !== "github_flow") {
    ideas.push("Agrega pruebas minimas del flujo principal antes de refactorizar.");
  }

  ideas.push(...(MENTOR_IDEAS_BY_LANGUAGE[language] || MENTOR_IDEAS_BY_LANGUAGE.General));

  if (repoFullName) {
    searches.push(`${repoFullName} issues good first issue`);
    searches.push(`${repoFullName} pull request review checklist`);
  }
  if (fileName) {
    searches.push(`${language} ${fileName} best practices`);
  }
  searches.push(`${language} clean code examples github`);
  searches.push(`${language} testing strategy tutorial`);
  searches.push(`${language} project ideas beginner github`);
  searches.push(`awesome ${language.toLowerCase()}`);

  if (pageType === "codespace") {
    searches.push("github codespaces devcontainer setup");
  }
  if (/deploy|azure|production|prod/i.test(question)) {
    searches.push("github actions azure deploy workflow");
  }

  const finalIdeas = uniqueStrings(ideas).slice(0, maxItems);
  const finalSearches = uniqueStrings(searches).slice(0, maxItems);
  const guide = buildGuideForContext(goal, pageContext).slice(0, Math.max(4, maxItems + 1));

  let summary = "Sugerencias base generadas con heuristicas.";
  if (pageContext === "campus") {
    summary = "Se detecto Campus Virtual y se priorizaron pistas sobre el enunciado y los bloqueos visibles.";
  } else if (pageType === "github_code") {
    summary = "Se analizo archivo de GitHub y se generaron sugerencias enfocadas.";
  } else if (pageType === "codespace") {
    summary = "Se detecto Codespace y se priorizaron acciones de desarrollo rapido.";
  } else if (pageType === "github_general") {
    summary = "Repositorio detectado sin archivo abierto; recomendaciones generales aplicadas.";
  }

  return {
    ideas: finalIdeas,
    searches: finalSearches,
    guide,
    welcome_message: buildWelcomeForContext(pageContext, pageType, goal),
    analysis_summary: summary,
  };
}

function buildMentorPrompt(params: {
  context: GithubMentorContext;
  question: string;
  maxItems: number;
  heuristic: GithubMentorResult;
}) {
  const ctx = params.context;
  const lineCount = Number.isFinite(Number(ctx.codeLineCount)) ? Number(ctx.codeLineCount) : 0;
  const safeCode = trimText(ctx.codeSnippet).slice(0, maxMentorCodeChars);
  const pageType = normalizePageType(ctx.pageType);
  const pageContext = resolvePageContext(ctx.pageContext, pageType);
  const learningGoal = normalizeLearningGoal(ctx.learningGoal);

  return [
    "Eres ADACEEN, un tutor pedagogico para aprendizaje de programacion.",
    "Devuelve SOLO JSON valido (sin markdown, sin texto adicional) con esta forma:",
    '{"ideas":["..."],"searches":["..."],"guide":["..."],"welcome_message":"...","analysis_summary":"..."}',
    `Cada arreglo debe tener entre 3 y ${params.maxItems} elementos accionables y concretos.`,
    "Reglas:",
    "- No inventes datos no presentes.",
    "- Si falta contexto, dilo en analysis_summary y sugiere como obtenerlo.",
    "- Nunca entregues la solucion completa del ejercicio.",
    "- Responde como tutor que da pistas, pasos y preguntas orientadoras.",
    "- Si pageContext es campus, enfocate en el enunciado, la actividad y el error visible.",
    "- Si pageContext es github, enfocate en el archivo abierto, la rama y el codigo.",
    "- Si es codespace, welcome_message debe incluir exactamente: Vamos a programar.",
    "",
    `Question: ${params.question}`,
    `PageContext: ${pageContext}`,
    `PageType: ${pageType}`,
    `Title: ${trimText(ctx.title) || "(sin titulo)"}`,
    `URL: ${trimText(ctx.url) || "(sin URL)"}`,
    `LearningGoal: ${learningGoal}`,
    `Repo: ${trimText(ctx.repoFullName) || "(sin repo)"}`,
    `Branch: ${trimText(ctx.branch) || "(sin rama)"}`,
    `FilePath: ${trimText(ctx.filePath) || "(sin archivo)"}`,
    `ActivityTitle: ${trimText(ctx.activityTitle) || "(sin actividad)"}`,
    `VisibleError: ${trimText(ctx.visibleError) || "(sin error visible)"}`,
    `LanguageHint: ${trimText(ctx.languageHint) || "(sin lenguaje detectado)"}`,
    `CodeLineCount: ${lineCount}`,
    "",
    "CodeSnippet:",
    safeCode || "(sin codigo detectado)",
    "",
    "BaselineSuggestions (puedes mejorar, no repetir literal):",
    JSON.stringify(params.heuristic),
  ].join("\n");
}

function parseMentorResultFromText(rawOutput: string, maxItems: number): GithubMentorResult | null {
  const cleaned = trimText(rawOutput)
    .replace(/^```json\s*/i, "")
    .replace(/^```\s*/i, "")
    .replace(/\s*```$/i, "");
  const match = cleaned.match(/\{[\s\S]*\}/);
  if (!match) return null;

  try {
    const parsed = JSON.parse(match[0]) as Partial<GithubMentorResult>;
    const ideas = uniqueStrings(Array.isArray(parsed.ideas) ? parsed.ideas : []).slice(0, maxItems);
    const searches = uniqueStrings(Array.isArray(parsed.searches) ? parsed.searches : []).slice(0, maxItems);
    const guide = uniqueStrings(Array.isArray(parsed.guide) ? parsed.guide : []).slice(0, Math.max(4, maxItems + 1));
    const welcome = trimText(parsed.welcome_message);
    const summary = trimText(parsed.analysis_summary);

    if (ideas.length < 3 || searches.length < 3 || guide.length < 4) return null;

    return {
      ideas,
      searches,
      guide,
      welcome_message: welcome || "Sugerencias generadas.",
      analysis_summary: summary || "Sugerencias generadas por analisis del contexto.",
    };
  } catch {
    return null;
  }
}

function normalizeNum(value: string) {
  return Number.parseFloat(String(value || "").replace(",", "."));
}

function extractGradeRows(text: string) {
  const lines = String(text || "").split(/\r?\n/);
  const rows: Array<{ code: string; grade: number }> = [];

  for (const raw of lines) {
    const line = raw.trim();
    if (!line) continue;

    const match = line.match(/^(\d{5,})\s+([0-5](?:[.,]\d+)?)$/);
    if (!match) continue;

    const grade = normalizeNum(match[2]);
    if (!Number.isFinite(grade)) continue;
    if (grade < 0 || grade > 5) continue;

    rows.push({ code: match[1], grade });
  }

  return rows;
}

function parseThresholdFromQuestion(question: string) {
  const q = String(question || "")
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "");

  const gte = q.match(
    /(?:igual\s*(?:o|\/)?\s*superior|superior\s*(?:o|\/)?\s*igual|mayor\s*(?:o\s*)?igual|mayor\s*igual|al\s*menos|>=)\s*(?:a\s*)?([0-9]+(?:[.,][0-9]+)?)/i
  );
  if (gte) return { op: "gte" as const, threshold: normalizeNum(gte[1]) };

  const gt = q.match(/(?:superior(?:es)?|mayor(?:es)?|por encima|mas de|>)\s*(?:a\s*)?([0-9]+(?:[.,][0-9]+)?)/i);
  if (gt) return { op: "gt" as const, threshold: normalizeNum(gt[1]) };

  return null;
}

function asksForFullPdfText(question: string) {
  const q = String(question || "")
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "");

  const asksAllText =
    /todo el contenido|contenido completo|texto completo|transcrib|extrae todo|dame todo el texto/.test(q);
  const asksDocument = /pdf|archivo|documento|notas taller 2/.test(q);
  return asksAllText && asksDocument;
}

function extractLinkedTextBlocks(tabContent: string) {
  const text = String(tabContent || "");
  const regex = /Contenido visible del enlace:\n([\s\S]*?)(?=\n\nEnlace consultado \d+:|\n\nContenido visible \(pestana actual\):|$)/g;
  const blocks: string[] = [];
  let match: RegExpExecArray | null = null;
  while ((match = regex.exec(text)) !== null) {
    const block = (match[1] || "").trim();
    if (!block || /\(sin texto visible\)/i.test(block)) continue;
    blocks.push(block);
  }
  return blocks;
}

function extractCandidateGradeLinks(tabContent: string, limit = 3) {
  const lines = String(tabContent || "").split(/\r?\n/);
  const out: string[] = [];
  const seen = new Set<string>();

  for (const raw of lines) {
    const line = raw.trim();
    if (!line) continue;

    const urlMatch = line.match(/https?:\/\/\S+/i);
    if (!urlMatch) continue;
    const url = urlMatch[0].trim();
    const lower = line.toLowerCase();

    if (!/(taller|nota|calific|grade|report|pdf)/.test(lower)) continue;
    if (seen.has(url)) continue;
    seen.add(url);
    out.push(url);
    if (out.length >= limit) break;
  }

  return out;
}

function buildMissingPdfTextAnswer(params: { question: string; tabContent: string }) {
  if (!asksForFullPdfText(params.question)) return null;

  const linkedTextBlocks = extractLinkedTextBlocks(params.tabContent);
  const mergedLinkedText = linkedTextBlocks.join("\n").trim();
  if (mergedLinkedText.length >= 350) return null;

  const links = extractCandidateGradeLinks(params.tabContent, 4);
  const lines = [
    "1) Resumen",
    "- Pediste el contenido completo del PDF, pero no se detecto texto util del documento en el contexto recibido.",
    "- Responder con texto inventado seria incorrecto.",
    "",
    "2) Sugerencias",
    "- Abre el PDF en una pestana normal y vuelve a consultar para capturar su texto.",
    "- Si quieres exactitud inmediata, pega aqui el texto del PDF y te lo devuelvo limpio/completo.",
    "- Verifica que la extension tenga permisos para `campusvirtual.univalle.edu.co` y recargala.",
    "",
    "3) Dudas o riesgos",
    "- Si Moodle muestra un visor sin texto seleccionable, la extension puede no extraer contenido.",
    "- Si el archivo tiene imagenes escaneadas, se requiere OCR para recuperar todo el texto.",
  ];

  if (links.length > 0) {
    lines.push("", "Enlaces detectados:");
    for (const link of links) lines.push(`- ${link}`);
  }

  return lines.join("\n");
}

function buildDeterministicGradeAnswer(params: { question: string; tabContent: string }) {
  const question = String(params.question || "").trim();
  const thresholdSpec = parseThresholdFromQuestion(question);
  if (!thresholdSpec) return null;

  const rows = extractGradeRows(params.tabContent);
  if (rows.length < 5) {
    const links = extractCandidateGradeLinks(params.tabContent, 3);
    const needsGrades = /(nota|calific|taller|estudiante|pdf)/i.test(question);
    if (!needsGrades) return null;

    const lines = [
      "1) Resumen",
      "- La pregunta requiere contar notas por umbral, pero en el contenido recibido no aparecen filas de calificaciones (codigo + nota).",
      "- Sin ese listado no puedo calcular una cantidad confiable.",
      "",
      "2) Sugerencias",
      "- Abre el PDF de \"Notas Taller 2\" y vuelve a consultar cuando se vea el texto de notas en pantalla.",
      "- Si prefieres, pega aqui el bloque de notas (codigo y valor) y te doy el conteo exacto.",
      "- Confirma si el criterio es \"> 3.0\" o \">= 3.0\".",
      "",
      "3) Dudas o riesgos",
      "- Contar sin ver el listado real produce respuestas incorrectas.",
      "- Si el PDF tiene varias paginas, hay riesgo de conteo parcial si solo llega una parte del contenido.",
    ];

    if (links.length > 0) {
      lines.push("", "Enlaces detectados (posibles fuentes):");
      for (const link of links) lines.push(`- ${link}`);
    }

    return lines.join("\n");
  }

  const comparator = thresholdSpec.op === "gte"
    ? (value: number) => value >= thresholdSpec.threshold
    : (value: number) => value > thresholdSpec.threshold;
  const symbol = thresholdSpec.op === "gte" ? ">=" : ">";

  const count = rows.filter((r) => comparator(r.grade)).length;
  const total = rows.length;

  return [
    "1) Resumen",
    `- Se detectaron ${total} calificaciones en el contenido analizado.`,
    `- Estudiantes con nota ${symbol} ${thresholdSpec.threshold.toFixed(1)}: ${count}.`,
    "",
    "2) Sugerencias",
    "- Validar que el texto corresponde exactamente al archivo solicitado (por ejemplo: \"Notas Taller 2\").",
    "- Si quieres, puedo listar los codigos que cumplen la condicion.",
    "- Para auditoria, conserva una copia del texto fuente junto al conteo.",
    "",
    "3) Dudas o riesgos",
    "- Si el PDF tiene mas paginas o filas no capturadas, el conteo podria quedar incompleto.",
    "- Si hay formatos de nota distintos (coma/punto), conviene normalizar antes del calculo.",
  ].join("\n");
}

// Texto/código
app.post("/run-text", async (req, res) => {
  try {
    const input = (req.body?.input_as_text || "").toString().trim();
    if (!input) return res.status(400).json({ ok:false, error:"input_as_text requerido" });
    const out = await runTextByMode(input);
    res.json({ ok:true, output_text: out });
  } catch (e:any) {
    console.error(e);
    res.status(500).json({ ok:false, error: e.message || "error" });
  }
});

// Imágenes
app.post("/run-image", upload.single("image"), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ ok:false, error:"image requerida" });
    const prompt = (req.body?.prompt || "").toString();
    const out = await runImageByMode(req.file, prompt);
    res.json({ ok:true, output_text: out });
  } catch (e:any) {
    console.error(e);
    res.status(500).json({ ok:false, error: e.message || "error" });
  }
});

// Sugerencias sobre pestaña actual (pensado para extension del navegador)
app.post("/suggest-tab", async (req, res) => {
  try {
    const tabContent = (req.body?.tab_content || "").toString().trim();
    if (!tabContent) return res.status(400).json({ ok:false, error:"tab_content requerido" });

    const question = (req.body?.question || "").toString();
    const tabTitle = (req.body?.tab_title || "").toString();
    const tabUrl = (req.body?.tab_url || "").toString();

    const missingPdfText = buildMissingPdfTextAnswer({ question, tabContent });
    if (missingPdfText) {
      return res.json({ ok: true, output_text: missingPdfText });
    }

    const deterministic = buildDeterministicGradeAnswer({ question, tabContent });
    if (deterministic) {
      return res.json({ ok: true, output_text: deterministic });
    }

    let out = "";

    if (!useAzureServer) {
      try {
        out = await runSuggestTab({
          tabContent,
          question,
          tabTitle,
          tabUrl,
          maxTabContentChars,
        });
      } catch (advancedErr: any) {
        console.warn("[suggest-tab] Advanced workflow fallo. Se usa fallback clasico.", advancedErr?.message || advancedErr);
        const prompt = buildTabSuggestionPrompt({
          tabContent,
          question,
          tabTitle,
          tabUrl,
        });
        out = await runText(prompt);
      }
    } else {
      const prompt = buildTabSuggestionPrompt({
        tabContent,
        question,
        tabTitle,
        tabUrl,
      });
      out = await runTextByMode(prompt);
    }

    return res.json({ ok: true, output_text: out });
  } catch (e:any) {
    console.error(e);
    return res.status(500).json({ ok:false, error: e.message || "error" });
  }
});

async function handleStructuredIntervention(req: express.Request, res: express.Response) {
  try {
    const question = trimText(req.body?.question) || "Sugiere ideas y busquedas para mejorar este codigo.";
    const rawMaxItems = Number(req.body?.max_items);
    const maxItems = Number.isFinite(rawMaxItems)
      ? Math.max(3, Math.min(8, Math.round(rawMaxItems)))
      : 6;

    const rawContext = (req.body?.context || {}) as GithubMentorContext;
    const resolvedPageType = normalizePageType(rawContext.pageType);
    const context: GithubMentorContext = {
      url: trimText(rawContext.url),
      title: trimText(rawContext.title),
      pageContext: resolvePageContext(rawContext.pageContext, resolvedPageType),
      pageType: resolvedPageType,
      repoOwner: trimText(rawContext.repoOwner),
      repoName: trimText(rawContext.repoName),
      repoFullName: trimText(rawContext.repoFullName),
      branch: trimText(rawContext.branch),
      filePath: trimText(rawContext.filePath),
      languageHint: trimText(rawContext.languageHint),
      activityTitle: trimText(rawContext.activityTitle),
      learningGoal: normalizeLearningGoal(rawContext.learningGoal),
      selection: trimText(rawContext.selection),
      visibleError: trimText(rawContext.visibleError),
      codeSnippet: trimText(rawContext.codeSnippet).slice(0, maxMentorCodeChars),
      codeLineCount: Number.isFinite(Number(rawContext.codeLineCount))
        ? Number(rawContext.codeLineCount)
        : 0,
    };

    const heuristic = buildHeuristicMentorResult(context, question, maxItems);
    const prompt = buildMentorPrompt({
      context,
      question,
      maxItems,
      heuristic,
    });

    let result = heuristic;
    let source: "ai" | "heuristic" = "heuristic";

    try {
      const aiRaw = await runTextByMode(prompt);
      const parsed = parseMentorResultFromText(aiRaw, maxItems);
      if (parsed) {
        result = parsed;
        source = "ai";
      }
    } catch (aiErr: any) {
      console.warn("[github-mentor] ai fallback to heuristic", aiErr?.message || aiErr);
    }

    return res.json({
      ok: true,
      source,
      result,
    });
  } catch (e: any) {
    console.error(e);
    return res.status(500).json({ ok: false, error: e.message || "error" });
  }
}

// Sugerencias estructuradas del tutor (extension)
app.post("/intervene", handleStructuredIntervention);
app.post("/github-mentor", handleStructuredIntervention);

// Compat: endpoint mixto (igual al que ya tienes)
app.post("/run", upload.single("image"), async (req, res) => {
  try {
    if (req.file) {
      const prompt = (req.body?.prompt || "").toString();
      const out = await runImageByMode(req.file, prompt);
      return res.json({ ok: true, output_text: out });
    }

    const input = (req.body?.input_as_text || "").toString().trim();
    if (!input) return res.status(400).json({ ok:false, error:"input_as_text requerido" });
    const out = await runTextByMode(input);
    return res.json({ ok: true, output_text: out });
  } catch (e:any) {
    console.error(e);
    return res.status(500).json({ ok:false, error: e.message || "error" });
  }
});

app.get("/health", (_req, res) => {
  res.json({
    ok: true,
    mode: useAzureServer ? "azure" : "local",
    azure_server: useAzureServer ? azureServer || null : null,
    max_tab_content_chars: maxTabContentChars,
    max_mentor_code_chars: maxMentorCodeChars,
  });
});

const PORT = +(process.env.PORT || 3000);
app.listen(PORT, () => {
  const mode = useAzureServer ? "azure" : "local";
  console.log(`Agente (${mode}): http://127.0.0.1:${PORT}`);
});

import { env } from "../config/env.js";
import type {
  GithubMentorContext,
  GithubMentorPageType,
  GithubMentorResult,
  LearningGoalId,
  MentorPageContext,
} from "../types/app.js";
import {
  basenameSafe,
  inferLanguage,
  normalizeLearningGoal,
  normalizePageType,
  resolvePageContext,
  trimText,
  uniqueStrings,
} from "./text-utils.js";

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

export function analyzeCodeSignals(codeText: string) {
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

function buildWelcomeForContext(
  pageContext: MentorPageContext,
  pageType: GithubMentorPageType,
  goal: LearningGoalId,
) {
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

export function buildHeuristicMentorResult(
  context: GithubMentorContext,
  question: string,
  maxItems: number,
): GithubMentorResult {
  const pageType = normalizePageType(context.pageType);
  const pageContext = resolvePageContext(context.pageContext, pageType);
  const goal = normalizeLearningGoal(context.learningGoal);
  const language = inferLanguage(context);
  const codeSnippet = trimText(context.codeSnippet).slice(0, env.maxMentorCodeChars);
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

export function buildMentorPrompt(params: {
  context: GithubMentorContext;
  question: string;
  maxItems: number;
  heuristic: GithubMentorResult;
  policyInstruction?: string;
}) {
  const context = params.context;
  const lineCount = Number.isFinite(Number(context.codeLineCount)) ? Number(context.codeLineCount) : 0;
  const safeCode = trimText(context.codeSnippet).slice(0, env.maxMentorCodeChars);
  const pageType = normalizePageType(context.pageType);
  const pageContext = resolvePageContext(context.pageContext, pageType);
  const learningGoal = normalizeLearningGoal(context.learningGoal);

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
    params.policyInstruction ? `- Politica activa: ${params.policyInstruction}` : "",
    "",
    `Question: ${params.question}`,
    `PageContext: ${pageContext}`,
    `PageType: ${pageType}`,
    `Title: ${trimText(context.title) || "(sin titulo)"}`,
    `URL: ${trimText(context.url) || "(sin URL)"}`,
    `LearningGoal: ${learningGoal}`,
    `Repo: ${trimText(context.repoFullName) || "(sin repo)"}`,
    `Branch: ${trimText(context.branch) || "(sin rama)"}`,
    `FilePath: ${trimText(context.filePath) || "(sin archivo)"}`,
    `ActivityTitle: ${trimText(context.activityTitle) || "(sin actividad)"}`,
    `VisibleError: ${trimText(context.visibleError) || "(sin error visible)"}`,
    `LanguageHint: ${trimText(context.languageHint) || "(sin lenguaje detectado)"}`,
    `CodeLineCount: ${lineCount}`,
    "",
    "CodeSnippet:",
    safeCode || "(sin codigo detectado)",
    "",
    "BaselineSuggestions (puedes mejorar, no repetir literal):",
    JSON.stringify(params.heuristic),
  ]
    .filter(Boolean)
    .join("\n");
}

export function parseMentorResultFromText(rawOutput: string, maxItems: number): GithubMentorResult | null {
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

    if (ideas.length < 3 || searches.length < 3 || guide.length < 4) {
      return null;
    }

    return {
      ideas,
      searches,
      guide,
      welcome_message: trimText(parsed.welcome_message) || "Sugerencias generadas.",
      analysis_summary: trimText(parsed.analysis_summary) || "Sugerencias generadas por analisis del contexto.",
    };
  } catch {
    return null;
  }
}

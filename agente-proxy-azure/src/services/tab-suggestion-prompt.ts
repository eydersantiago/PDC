import { env } from "../config/env.js";

export type TabSuggestionPromptInput = {
  tabContent: string;
  question?: string;
  tabTitle?: string;
  tabUrl?: string;
};

export type TabSuggestionScope = "general" | "file_summary" | "cursor" | "selection";

export function buildTabSuggestionPrompt(params: TabSuggestionPromptInput) {
  const question = params.question?.trim() || "Dame sugerencias basicas sobre este contenido.";
  const safeContent = params.tabContent.slice(0, Math.max(1, env.maxTabContentChars));

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

export function buildFileSummarySuggestionPrompt(params: TabSuggestionPromptInput) {
  const question = params.question?.trim() || "Resume el papel del archivo activo dentro del proyecto.";
  const safeContent = params.tabContent.slice(0, Math.max(1, env.maxTabContentChars));

  return [
    "Analiza el archivo activo y responde en Markdown.",
    "Tu foco es el resumen estable del archivo, no el cursor ni una seleccion puntual.",
    "Formato estricto:",
    "1) Resumen corto (max 3 bullets, explica rol del archivo y piezas principales).",
    "2) 3 sugerencias basicas y accionables para seguir trabajando en ese archivo.",
    "3) 2 dudas o riesgos detectados.",
    "Si el contexto solo contiene un recorte, aclara que el resumen se basa en ese recorte.",
    "No inventes rutas, clases, funciones ni dependencias.",
    "",
    `Archivo/Titulo: ${params.tabTitle || "(sin titulo)"}`,
    `Origen: ${params.tabUrl || "(sin URL)"}`,
    `Pregunta del usuario: ${question}`,
    "",
    "Contexto del archivo activo:",
    safeContent,
  ].join("\n");
}

export function buildCursorSelectionSuggestionPrompt(params: TabSuggestionPromptInput) {
  const question = params.question?.trim() || "Da una pista breve sobre la seleccion o el cursor actual.";
  const safeContent = params.tabContent.slice(0, Math.max(1, env.maxTabContentChars));

  return [
    "Analiza el contexto de editor y responde en Markdown.",
    "Tu foco es la seleccion del usuario si existe; si no existe, usa la linea del cursor.",
    "Usa el resto del archivo solo como apoyo para no sacar la linea de contexto.",
    "Formato estricto:",
    "1) Resumen corto (1 o 2 bullets sobre lo que parece estar intentando hacer).",
    "2) 2 o 3 sugerencias breves para continuar desde esa linea o seleccion.",
    "3) 1 o 2 dudas o riesgos detectados.",
    "Si propones codigo, incluye como maximo un bloque corto. Si no hay seguridad, usa un comentario TODO del lenguaje.",
    "No des la solucion completa ni inventes datos.",
    "",
    `Archivo/Titulo: ${params.tabTitle || "(sin titulo)"}`,
    `Origen: ${params.tabUrl || "(sin URL)"}`,
    `Pregunta del usuario: ${question}`,
    "",
    "Contexto de seleccion/cursor:",
    safeContent,
  ].join("\n");
}

export function buildScopedTabSuggestionPrompt(
  scope: TabSuggestionScope,
  params: TabSuggestionPromptInput,
) {
  if (scope === "file_summary") {
    return buildFileSummarySuggestionPrompt(params);
  }
  if (scope === "cursor" || scope === "selection") {
    return buildCursorSelectionSuggestionPrompt(params);
  }
  return buildTabSuggestionPrompt(params);
}

import { env } from "../config/env.js";

export type TabSuggestionPromptInput = {
  tabContent: string;
  question?: string;
  tabTitle?: string;
  tabUrl?: string;
  ragContext?: string;
};

export type TabSuggestionScope = "general" | "file_summary" | "cursor" | "selection";

export function buildTabSuggestionPrompt(params: TabSuggestionPromptInput) {
  const question = params.question?.trim() || "Dame sugerencias basicas sobre este contenido.";
  const safeContent = params.tabContent.slice(0, Math.max(1, env.maxTabContentChars));

  return [
    "Analiza el contenido de la pestaña y responde en Markdown.",
    "Formato estricto:",
    "1) Resumen: maximo 5 lineas.",
    "2) Sugerencias del archivo: 3 recomendaciones globales y accionables.",
    "3) Sugerencias del codigo: 2 recomendaciones sobre la seleccion o linea activa si aplica.",
    "4) Accion: insert, replace o delete. Usa delete solo si conviene eliminar codigo.",
    "5) Riesgos: 2 dudas o riesgos detectados.",
    "Si una fuente RAG es compatible con el foco tecnico, conserva su cita exacta junto a la recomendacion.",
    "Si hay enlaces visibles relevantes, mencionarlos y aclarar si solo se detecta el enlace o tambien su contenido.",
    "Si falta contexto, dilo sin inventar.",
    "",
    `Titulo: ${params.tabTitle || "(sin titulo)"}`,
    `URL: ${params.tabUrl || "(sin URL)"}`,
    `Pregunta del usuario: ${question}`,
    params.ragContext ? `\n${params.ragContext}` : "",
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
    "1) Resumen: maximo 3 bullets, explica rol del archivo y piezas principales.",
    "2) Sugerencias del archivo: 3 recomendaciones globales y accionables.",
    "3) Sugerencias del codigo: si no hay foco puntual, escribe 'Sin foco de codigo puntual'.",
    "4) Accion: insert, replace o delete. Usa insert si solo propones un siguiente paso editable.",
    "5) Riesgos: 2 dudas o riesgos detectados.",
    "Si una fuente RAG es compatible con el archivo, conserva su cita exacta junto a la recomendacion.",
    "Si el contexto solo contiene un recorte, aclara que el resumen se basa en ese recorte.",
    "No inventes rutas, clases, funciones ni dependencias.",
    "",
    `Archivo/Titulo: ${params.tabTitle || "(sin titulo)"}`,
    `Origen: ${params.tabUrl || "(sin URL)"}`,
    `Pregunta del usuario: ${question}`,
    params.ragContext ? `\n${params.ragContext}` : "",
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
    "1) Resumen: 1 o 2 bullets sobre lo que parece estar intentando hacer.",
    "2) Sugerencias del codigo: 2 o 3 recomendaciones breves para continuar desde esa linea o seleccion.",
    "3) Sugerencias del archivo: 1 o 2 recomendaciones globales solo si ayudan al contexto.",
    "4) Accion: insert, replace o delete. Usa delete solo si conviene eliminar codigo.",
    "5) Riesgos: 1 o 2 dudas o riesgos detectados.",
    "Si una fuente RAG es compatible con la linea o seleccion, conserva su cita exacta junto a la recomendacion.",
    "Si propones codigo, incluye como maximo un bloque corto. Si no hay seguridad, usa un comentario TODO del lenguaje.",
    "No des la solucion completa ni inventes datos.",
    "",
    `Archivo/Titulo: ${params.tabTitle || "(sin titulo)"}`,
    `Origen: ${params.tabUrl || "(sin URL)"}`,
    `Pregunta del usuario: ${question}`,
    params.ragContext ? `\n${params.ragContext}` : "",
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

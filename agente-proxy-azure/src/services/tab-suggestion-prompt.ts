import { env } from "../config/env.js";

export type TabSuggestionPromptInput = {
  tabContent: string;
  question?: string;
  tabTitle?: string;
  tabUrl?: string;
};

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

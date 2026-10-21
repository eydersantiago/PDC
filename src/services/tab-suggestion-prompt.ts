import { env } from "../config/env.js";

/** Accion que el estudiante pidio sobre la seleccion (VS Code 0.0.34): codigo bajo demanda. */
export type RequestedEditorAction = "insert" | "replace";

export type TabSuggestionPromptInput = {
  tabContent: string;
  question?: string;
  tabTitle?: string;
  tabUrl?: string;
  ragContext?: string;
  /** Reglas de la politica del docente para esta sugerencia (ver suggestion-policy.ts). */
  policyInstruction?: string;
  /** El estudiante pidio una accion concreta (Modificar seleccion o Insertar debajo). */
  requestedAction?: RequestedEditorAction | "";
  /** Lenguaje del archivo (cpp, java, python...) para la valla del bloque de codigo. */
  languageHint?: string;
};

export type TabSuggestionScope = "general" | "file_summary" | "cursor" | "selection";

/**
 * El modelo (qwen2.5-coder) a veces mete caracteres chinos en medio de una
 * frase en espanol: se le pide expresamente que no. text-utils.ts los quita
 * igual de la salida (stripForeignScript).
 */
export const SPANISH_ONLY_RULE = "Responde solo en espanol. No uses caracteres chinos, japoneses ni coreanos.";

export function normalizeRequestedAction(value: unknown): RequestedEditorAction | "" {
  const clean = String(value ?? "").trim().toLowerCase();
  if (clean === "replace" || clean === "modificar" || clean === "mejorar" || clean === "improve") return "replace";
  if (clean === "insert" || clean === "insertar") return "insert";
  return "";
}

/**
 * Preguntas de las extensiones de VS Code anteriores a la 0.0.34: pedian "un
 * unico bloque de codigo corto para continuar" y, "si no es seguro", un
 * comentario TODO. El resultado era que la sugerencia solo agregaba un TODO y
 * "Modificar seleccion" cambiaba el bloque por un fragmento. Se quitan esas dos
 * instrucciones: las reglas del bloque de codigo las pone el prompt.
 */
export function modernizeEditorQuestion(question: string) {
  return String(question || "")
    .replace(/\s*Si no es seguro,? usa un comentario TODO del lenguaje\.?/gi, "")
    .replace(/un unico bloque de codigo corto (?:para continuar|que ayude a corregirlo)/gi, "un unico bloque de codigo segun la accion")
    .replace(/\s{2,}/g, " ")
    .trim();
}

function fenceLanguage(languageHint: string | undefined) {
  const clean = String(languageHint || "").trim().toLowerCase().replace(/[^a-z0-9+#-]/g, "");
  if (!clean || clean === "general" || clean === "plaintext") return "";
  return clean.slice(0, 20);
}

/**
 * Reglas del bloque de codigo del editor: el codigo corresponde a la accion
 * (asi "Modificar seleccion" recibe el bloque completo mejorado e "Insertar
 * debajo" solo lo nuevo) y siempre es codigo real.
 */
export function editorCodeRules(languageHint?: string) {
  const fence = `\`\`\`${fenceLanguage(languageHint)}`;
  return [
    `5) Codigo: un unico bloque ${fence} que corresponda a la accion elegida:`,
    "   - replace: el bloque seleccionado completo ya corregido o mejorado, linea por linea, listo para reemplazar la seleccion. Misma funcion y misma sangria; copia igual las lineas que no cambian; no omitas lineas ni uses '...'.",
    "   - insert: solo las lineas nuevas que van justo debajo de la seleccion o de la linea del cursor. No repitas el codigo que ya existe.",
    "   - delete: sin bloque de codigo; di que hay que quitar y por que.",
    "El codigo debe ser real y compilar en el lenguaje del archivo: nunca un comentario TODO solo, ni un marcador de posicion, ni pseudocodigo.",
  ];
}

/** Pedido explicito del estudiante (requestedAction): manda sobre la accion que el modelo elegiria. */
export function requestedActionInstruction(action: RequestedEditorAction | "" | undefined) {
  if (action === "replace") {
    return [
      "Pedido del estudiante: MEJORAR el bloque seleccionado (boton \"Modificar seleccion\").",
      "Escribe exactamente la linea `Aplicar: replace` y un bloque de codigo con el bloque seleccionado COMPLETO ya mejorado o corregido, listo para reemplazar la seleccion.",
      "Cambia solo lo necesario y explica en 1 o 2 bullets que cambiaste y por que.",
    ].join(" ");
  }
  if (action === "insert") {
    return [
      "Pedido del estudiante: CODIGO NUEVO para continuar (boton \"Insertar debajo\").",
      "Escribe exactamente la linea `Aplicar: insert` y un bloque de codigo solo con las lineas nuevas que van justo debajo de la seleccion o del cursor.",
      "Explica en 1 bullet que hacen esas lineas.",
    ].join(" ");
  }
  return "";
}

export function buildTabSuggestionPrompt(params: TabSuggestionPromptInput) {
  const question = params.question?.trim() || "Dame sugerencias basicas sobre este contenido.";
  const safeContent = params.tabContent.slice(0, Math.max(1, env.maxTabContentChars));

  return [
    "Analiza el contenido de la pestaña y responde en Markdown.",
    "Formato estricto:",
    "1) Resumen: maximo 5 lineas.",
    "2) Sugerencias del archivo: 3 recomendaciones globales y accionables.",
    "3) Sugerencias del codigo: 2 recomendaciones sobre la seleccion o linea activa si aplica.",
    "4) Accion: escribe exactamente una linea `Aplicar: insert`, `Aplicar: replace` o `Aplicar: delete`. Usa delete solo si conviene eliminar codigo.",
    "5) Riesgos: 2 dudas o riesgos detectados.",
    "Si una fuente RAG es compatible con el foco tecnico, conserva su cita exacta junto a la recomendacion.",
    "Si hay enlaces visibles relevantes, mencionarlos y aclarar si solo se detecta el enlace o tambien su contenido.",
    "Si falta contexto, dilo sin inventar.",
    SPANISH_ONLY_RULE,
    "",
    `Titulo: ${params.tabTitle || "(sin titulo)"}`,
    `URL: ${params.tabUrl || "(sin URL)"}`,
    `Pregunta del usuario: ${question}`,
    params.ragContext ? `\n${params.ragContext}` : "",
    params.policyInstruction ? `\nPolitica del docente: ${params.policyInstruction}` : "",
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
    "4) Accion: escribe exactamente una linea `Aplicar: insert`, `Aplicar: replace` o `Aplicar: delete`. Usa insert si solo propones un siguiente paso editable.",
    "5) Riesgos: 2 dudas o riesgos detectados.",
    "Si una fuente RAG es compatible con el archivo, conserva su cita exacta junto a la recomendacion.",
    "Si el contexto solo contiene un recorte, aclara que el resumen se basa en ese recorte.",
    "No inventes rutas, clases, funciones ni dependencias.",
    SPANISH_ONLY_RULE,
    "",
    `Archivo/Titulo: ${params.tabTitle || "(sin titulo)"}`,
    `Origen: ${params.tabUrl || "(sin URL)"}`,
    `Pregunta del usuario: ${question}`,
    params.ragContext ? `\n${params.ragContext}` : "",
    params.policyInstruction ? `\nPolitica del docente: ${params.policyInstruction}` : "",
    "",
    "Contexto del archivo activo:",
    safeContent,
  ].join("\n");
}

export function buildCursorSelectionSuggestionPrompt(params: TabSuggestionPromptInput) {
  const question = modernizeEditorQuestion(params.question?.trim() || "")
    || "Da una pista breve sobre la seleccion o el cursor actual.";
  const safeContent = params.tabContent.slice(0, Math.max(1, env.maxTabContentChars));
  const requested = requestedActionInstruction(params.requestedAction);

  return [
    "Analiza el contexto de editor y responde en Markdown.",
    "Tu foco es la seleccion del usuario si existe; si no existe, usa la linea del cursor.",
    "Usa el resto del archivo solo como apoyo para no sacar la linea de contexto.",
    "Formato estricto:",
    "1) Resumen: 1 o 2 bullets sobre lo que parece estar intentando hacer.",
    "2) Sugerencias del codigo: 2 o 3 recomendaciones breves para continuar desde esa linea o seleccion.",
    "3) Sugerencias del archivo: 1 o 2 recomendaciones globales solo si ayudan al contexto.",
    "4) Accion: escribe exactamente una linea `Aplicar: insert`, `Aplicar: replace` o `Aplicar: delete`. Usa replace para corregir o mejorar el bloque seleccionado, insert para agregar codigo nuevo debajo y delete solo si conviene eliminar codigo.",
    ...editorCodeRules(params.languageHint),
    "6) Riesgos: 1 o 2 dudas o riesgos detectados.",
    "Si una fuente RAG es compatible con la linea o seleccion, conserva su cita exacta junto a la recomendacion.",
    "No des la solucion completa del ejercicio ni inventes datos.",
    SPANISH_ONLY_RULE,
    "",
    `Archivo/Titulo: ${params.tabTitle || "(sin titulo)"}`,
    `Origen: ${params.tabUrl || "(sin URL)"}`,
    `Pregunta del usuario: ${question}`,
    requested ? `\n${requested}` : "",
    params.ragContext ? `\n${params.ragContext}` : "",
    params.policyInstruction ? `\nPolitica del docente: ${params.policyInstruction}` : "",
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

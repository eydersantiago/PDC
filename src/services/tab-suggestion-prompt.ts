import { env } from "../config/env.js";
import { fitEditorContent, stripCodeFenceGutters } from "./editor-context.js";
import { promptBudgetChars } from "./text-generation.js";

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

/** La instruccion de la politica ya empieza con "Politica del docente ...": no se repite el rotulo. */
function policyLine(instruction: string | undefined) {
  const clean = String(instruction || "").trim();
  if (!clean) return "";
  return /^Politica del docente\b/i.test(clean) ? clean : `Politica del docente: ${clean}`;
}

type PromptAssembly = {
  /** Que hace el modelo, en una linea (va primero). */
  task: string;
  /** Rotulos del contexto (archivo, origen) que van antes del contenido. */
  contextHeader: string[];
  content: string;
  /** focus/file_summary: contexto del editor (se recorta por partes); plain: texto de una pagina. */
  contentKind: "focus" | "file_summary" | "plain";
  contentTitle: string;
  ragContext?: string;
  /** Pregunta, politica y formato: van al final, junto a donde el modelo empieza a escribir. */
  instructions: string[];
};

/**
 * Arma el prompt "contexto primero, instrucciones al final" (revision de precision del
 * 21/10/2026). Con el formato al final el modelo lo tiene a la vista al empezar a escribir, y si
 * algo no cabe se recorta el contexto, nunca las reglas. El total se ajusta a la ventana del
 * modelo (promptBudgetChars): primero sale lo de menos valor del editor (mapa del proyecto, texto
 * visible repetido), despues el material del curso y al final se recorta el codigo alrededor del
 * foco.
 */
function assemblePrompt(input: PromptAssembly) {
  const budget = promptBudgetChars();
  const head = [input.task, "", ...input.contextHeader].join("\n");
  const tail = input.instructions.filter((line) => line !== null && line !== undefined).join("\n").replace(/\n{3,}/g, "\n\n");
  let rag = input.ragContext ? `## Material del curso\n${input.ragContext}` : "";
  // MAX_TAB_CONTENT_CHARS tambien se respeta por partes en el editor: un corte a ciegas antes
  // de ajustar perdia la ventana numerada y la estructura del archivo (revision independiente).
  const maxContent = Math.max(1, env.maxTabContentChars);
  const fixed = head.length + tail.length + input.contentTitle.length + 12;
  let available = budget - fixed - rag.length;
  // El codigo del estudiante vale mas que el material: si no caben los dos, sale el material.
  if (rag && available < Math.min(input.content.length, maxContent, 3000)) {
    rag = "";
    available = budget - fixed;
  }
  const limit = Math.min(maxContent, Math.max(400, available));
  const fitted = input.contentKind === "plain"
    ? input.content.slice(0, limit)
    : fitEditorContent(input.content, limit, input.contentKind).text;
  return [head, `${input.contentTitle}\n${fitted}`, rag, tail].filter((part) => part.trim()).join("\n\n");
}

export function buildTabSuggestionPrompt(params: TabSuggestionPromptInput) {
  const question = params.question?.trim() || "Dame sugerencias basicas sobre este contenido.";
  return assemblePrompt({
    task: "Eres el tutor de programacion del curso. Vas a analizar la pestaña que el estudiante tiene abierta: primero viene su contenido y al final lo que tienes que responder.",
    contextHeader: [
      `Titulo: ${params.tabTitle || "(sin titulo)"}`,
      `URL: ${params.tabUrl || "(sin URL)"}`,
    ],
    contentTitle: "Contenido de la pestaña:",
    content: params.tabContent,
    contentKind: "plain",
    ragContext: params.ragContext,
    instructions: [
      "## Lo que tienes que responder",
      `Pregunta del usuario: ${question}`,
      policyLine(params.policyInstruction),
      "",
      "Responde en Markdown con este formato estricto:",
      "1) Resumen: maximo 5 lineas.",
      "2) Sugerencias del archivo: 3 recomendaciones globales y accionables.",
      "3) Sugerencias del codigo: 2 recomendaciones sobre la seleccion o linea activa si aplica.",
      "4) Accion: escribe exactamente una linea `Aplicar: insert`, `Aplicar: replace` o `Aplicar: delete`. Usa delete solo si conviene eliminar codigo.",
      "5) Riesgos: 2 dudas o riesgos detectados.",
      "Si usas el material del curso, conserva su etiqueta exacta junto a la recomendacion.",
      "Si hay enlaces visibles relevantes, mencionarlos y aclarar si solo se detecta el enlace o tambien su contenido.",
      "Si falta contexto, dilo sin inventar.",
      SPANISH_ONLY_RULE,
    ],
  });
}

export function buildFileSummarySuggestionPrompt(params: TabSuggestionPromptInput) {
  const question = params.question?.trim() || "Resume el papel del archivo activo dentro del proyecto.";
  return assemblePrompt({
    task: "Eres el tutor de programacion del curso. Vas a resumir el archivo que el estudiante tiene abierto en el editor: primero viene el contexto y al final lo que tienes que responder.",
    contextHeader: [
      `Archivo/Titulo: ${params.tabTitle || "(sin titulo)"}`,
      `Origen: ${params.tabUrl || "(sin URL)"}`,
    ],
    contentTitle: "Contexto del archivo activo:",
    content: params.tabContent,
    contentKind: "file_summary",
    ragContext: params.ragContext,
    instructions: [
      "## Lo que tienes que responder",
      `Pregunta del usuario: ${question}`,
      policyLine(params.policyInstruction),
      "",
      "Tu foco es el resumen estable del archivo, no el cursor ni una seleccion puntual.",
      "Responde en Markdown con este formato estricto:",
      "1) Resumen: maximo 3 bullets, explica rol del archivo y piezas principales.",
      "2) Sugerencias del archivo: 3 recomendaciones globales y accionables. Si nombras una linea, usa su numero real.",
      "3) Sugerencias del codigo: si no hay foco puntual, escribe 'Sin foco de codigo puntual'.",
      "4) Accion: escribe exactamente una linea `Aplicar: insert`, `Aplicar: replace` o `Aplicar: delete`. Usa insert si solo propones un siguiente paso editable.",
      "5) Riesgos: 2 dudas o riesgos detectados.",
      "Si usas el material del curso, conserva su etiqueta exacta junto a la recomendacion.",
      "Si el contexto solo contiene un recorte, aclara que el resumen se basa en ese recorte.",
      "No inventes rutas, clases, funciones ni dependencias.",
      SPANISH_ONLY_RULE,
    ],
  });
}

export function buildCursorSelectionSuggestionPrompt(params: TabSuggestionPromptInput) {
  const question = modernizeEditorQuestion(params.question?.trim() || "")
    || "Da una pista breve sobre la seleccion o el cursor actual.";
  const requested = requestedActionInstruction(params.requestedAction);
  return assemblePrompt({
    task: "Eres el tutor de programacion del curso. Vas a ayudar al estudiante con el codigo que tiene en el editor: primero viene el contexto y al final lo que tienes que responder.",
    contextHeader: [
      `Archivo/Titulo: ${params.tabTitle || "(sin titulo)"}`,
      `Origen: ${params.tabUrl || "(sin URL)"}`,
    ],
    contentTitle: "Contexto de seleccion/cursor:",
    content: params.tabContent,
    contentKind: "focus",
    ragContext: params.ragContext,
    instructions: [
      "## Lo que tienes que responder",
      `Pregunta del usuario: ${question}`,
      requested,
      policyLine(params.policyInstruction),
      "",
      "Tu foco es la seleccion del usuario si existe; si no existe, usa la linea del cursor (en el codigo numerado, las lineas del foco llevan \">\" antes de la barra).",
      "Usa el resto del archivo solo como apoyo para no sacar la linea de contexto.",
      "Responde en Markdown con este formato estricto:",
      "1) Resumen: 1 o 2 bullets sobre lo que parece estar intentando hacer.",
      "2) Sugerencias del codigo: 2 o 3 recomendaciones breves para continuar desde esa linea o seleccion. Si nombras una linea, usa su numero real.",
      "3) Sugerencias del archivo: 1 o 2 recomendaciones globales solo si ayudan al contexto.",
      "4) Accion: escribe exactamente una linea `Aplicar: insert`, `Aplicar: replace` o `Aplicar: delete`. Usa replace para corregir o mejorar el bloque seleccionado, insert para agregar codigo nuevo debajo y delete solo si conviene eliminar codigo.",
      ...editorCodeRules(params.languageHint),
      "El numero de linea y la barra del margen no son parte del codigo: no los copies en el bloque.",
      "6) Riesgos: 1 o 2 dudas o riesgos detectados.",
      "Si usas el material del curso, conserva su etiqueta exacta junto a la recomendacion.",
      "No des la solucion completa del ejercicio ni inventes datos.",
      SPANISH_ONLY_RULE,
    ],
  });
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

/** Primer bloque de codigo de una respuesta ("" si no trae). */
function firstCodeFence(output: string) {
  const match = String(output || "").match(/```[^\n]*\n([\s\S]*?)```/);
  return match?.[1] || "";
}

/** Lineas que no son codigo: comentarios, TODO, "pass", "..." (igual que VS Code, isPlaceholderCode). */
function isPlaceholderLine(line: string) {
  if (/^#\s*(include|define|undef|if|ifdef|ifndef|elif|else|endif|pragma|import|error|line)\b/i.test(line)) return false;
  return /^(\/\/|#|\/\*|\*\/|\*(?!\*?\w+\s*=)|<!--|-->|--\s|;;|rem\s)/i.test(line)
    || /^(pass|\.\.\.|…|todo\b.*|fixme\b.*)$/i.test(line);
}

/**
 * Por que una respuesta a un pedido de codigo (requestedAction) no sirve: sin bloque de codigo o
 * con un bloque que es solo comentarios o marcadores. "" si trae codigo de verdad.
 */
export function editorCodeProblem(output: string): "" | "sin_bloque" | "solo_marcador" {
  if (!/```[^\n]*\n[\s\S]*?```/.test(String(output || ""))) return "sin_bloque";
  const lines = firstCodeFence(stripCodeFenceGutters(output)).split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  if (!lines.length || lines.every(isPlaceholderLine)) return "solo_marcador";
  return "";
}

/**
 * Recordatorio para el unico reintento de un pedido de codigo que volvio sin codigo (validar la
 * forma de la respuesta y reintentar una vez, como Aider y CodeHelp). Va al final del prompt.
 */
export function editorCodeRetryInstruction(action: RequestedEditorAction, languageHint?: string) {
  const fence = `\`\`\`${fenceLanguage(languageHint)}`;
  const what = action === "replace"
    ? "con el bloque seleccionado COMPLETO ya mejorado, linea por linea, listo para reemplazarlo"
    : "solo con las lineas nuevas que van justo debajo de la seleccion o del cursor";
  return [
    "## Correccion",
    `Tu respuesta anterior no traia un bloque de codigo real. Responde otra vez con el mismo formato: la linea \`Aplicar: ${action}\` y un unico bloque ${fence} ${what}.`,
    "El codigo debe compilar: sin comentarios TODO, sin marcadores de posicion y sin '...'.",
  ].join("\n");
}

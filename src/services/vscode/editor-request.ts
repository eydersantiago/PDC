// Lo que pide VS Code en /suggest-tab (30-10-2026): una sola definicion de los alcances, los
// disparadores y las acciones que puede pedir el estudiante. La ruta, el prompt, la politica, la
// cache y la telemetria (el pedido explicito que sube la etapa) leen estas listas; antes cada uno
// tenia su copia escrita a mano.

/** Alcance del pedido: el chat general, el resumen del archivo o el foco del editor. */
export const SUGGESTION_SCOPES = ["general", "file_summary", "cursor", "selection"] as const;
export type SuggestionScope = (typeof SUGGESTION_SCOPES)[number];

/** El foco del editor (cursor o seleccion): ahi se piden y se aplican cambios de codigo. */
export const EDITOR_FOCUS_SCOPES = ["cursor", "selection"] as const satisfies readonly SuggestionScope[];
export type EditorFocusScope = (typeof EDITOR_FOCUS_SCOPES)[number];

/** Por que VS Code pidio la sugerencia (contrato v1.1, A9.10). */
export const SUGGESTION_TRIGGERS = ["cursor_idle", "selection", "manual", "blocking", "file_open", "panel"] as const;
export type SuggestionTrigger = (typeof SUGGESTION_TRIGGERS)[number];

/** Pedidos del estudiante (no automaticos): «Otra sugerencia». */
export const EXPLICIT_TRIGGERS = ["manual"] as const satisfies readonly SuggestionTrigger[];
export type ExplicitTrigger = (typeof EXPLICIT_TRIGGERS)[number];

/** Codigo que pidio el estudiante (VS Code 0.0.34): mejorar la seleccion o continuar debajo. */
export const REQUESTED_ACTIONS = ["insert", "replace"] as const;
export type RequestedEditorAction = (typeof REQUESTED_ACTIONS)[number];

/** Toda accion pedida es un pedido explicito. */
export const EXPLICIT_ACTIONS = REQUESTED_ACTIONS;
export type ExplicitAction = RequestedEditorAction;

function oneOf<T extends string>(values: readonly T[], value: unknown): value is T {
  return (values as readonly unknown[]).includes(value);
}

export function isEditorFocusScope(scope: unknown): scope is EditorFocusScope {
  return oneOf(EDITOR_FOCUS_SCOPES, scope);
}

export function isExplicitTrigger(trigger: unknown): trigger is ExplicitTrigger {
  return oneOf(EXPLICIT_TRIGGERS, trigger);
}

/**
 * Pedido explicito de ayuda sobre el foco del editor: «Otra sugerencia» o un pedido de codigo
 * («Proponer una mejora», «Proponer codigo para continuar»). Los automaticos (cursor quieto,
 * seleccion, archivo abierto, bloqueo, panel) y el resumen del archivo no suben la etapa.
 */
export function isExplicitSuggestionRequest(input: { scope?: string; trigger?: string; requestedAction?: string }) {
  return isEditorFocusScope(input.scope)
    && (isExplicitTrigger(input.trigger) || oneOf(EXPLICIT_ACTIONS, input.requestedAction));
}

/** El disparador que manda VS Code, o "" si no es uno conocido. */
export function normalizeSuggestionTrigger(value: unknown): SuggestionTrigger | "" {
  const clean = String(value ?? "").trim().toLowerCase();
  return oneOf(SUGGESTION_TRIGGERS, clean) ? clean : "";
}

/** La accion pedida (acepta los nombres en espanol de las extensiones viejas), o "". */
export function normalizeRequestedAction(value: unknown): RequestedEditorAction | "" {
  const clean = String(value ?? "").trim().toLowerCase();
  if (clean === "replace" || clean === "modificar" || clean === "mejorar" || clean === "improve") return "replace";
  if (clean === "insert" || clean === "insertar") return "insert";
  return "";
}

/**
 * El alcance que manda VS Code (con los nombres viejos: file, summary, selected_text,
 * cursor_idle) o, si no manda uno, el que se lee en la pregunta y el comienzo del contenido.
 */
export function normalizeSuggestionScope(value: unknown, question: string, tabContent: string): SuggestionScope {
  const clean = String(value ?? "").trim().toLowerCase().replace(/-/g, "_");
  if (clean === "file_summary" || clean === "file" || clean === "summary") return "file_summary";
  if (clean === "selection" || clean === "selected_text") return "selection";
  if (clean === "cursor" || clean === "cursor_idle") return "cursor";

  const probe = `${question}\n${tabContent.slice(0, 900)}`.toLowerCase();
  if (/selecci[oó]n|selected text|texto seleccionado/.test(probe)) return "selection";
  if (/cursor|linea indicada|l[ií]nea indicada|cursor quieto/.test(probe)) return "cursor";
  return "general";
}

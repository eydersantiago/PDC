// Guardarrail del codigo de una sugerencia: linea «Aplicar:» fuera del bloque y tope de lineas de la etapa (30-10-2026).
import { limitCodeBlocks } from "../tutor/intervention-templates.js";
import { countChangedLines, detectCodeFamily, formatPartialReplacementNote, formatPrefixCutNote, isSignificantCodeLine, nonBlankTrimmedLines, renderCutFence, summarizePartialReplacement, summarizePrefixCut, type CutSummary } from "../vscode/code-cut.js";
import { buildPartialReplacement } from "../vscode/code-cut-partial.js";
import { cutCodePrefix } from "../vscode/code-cut-prefix.js";
import { mapFences, normalizeFenceLines, parseFences, renderFence, replaceFence, textOutsideFences, type MarkdownFence } from "../vscode/markdown-fences.js";
import { type SuggestionRequestOptions, type SuggestionPolicyDecision } from "./suggestion-policy.js";

const APPLY_LINE_SOURCE = "^[ \\t>*-]*(?:\\d+\\)\\s*)?(?:acci[o\u00f3]n\\s*:?\\s*)?`?aplicar\\s*:\\s*`?(insert|replace|delete)`?[ \\t]*$";

const APPLY_LINE_ALL = new RegExp(APPLY_LINE_SOURCE, "gim");

const APPLY_LINE_ANY = new RegExp(APPLY_LINE_SOURCE, "im");

const APPLY_LINE_ONE = new RegExp(APPLY_LINE_SOURCE, "i");

/**
 * El modelo a veces escribe la linea "Aplicar: ..." DENTRO del bloque de codigo (examen 28-10:
 * VS Code propuso reemplazar el codigo del estudiante por el texto «Aplicar: replace»). Se saca
 * del bloque y, si la respuesta no la trae afuera, queda justo antes de ese bloque. Un bloque que
 * solo traia esa linea queda vacio: editorCodeProblem lo ve sin codigo (reintento) y no se cachea.
 * Un bloque sin cerrar sigue sin cerrar: el guardarrail decide despues que hacer con el.
 */
export function moveApplyLinesOutOfCodeFences(markdown: string) {
  const text = String(markdown || "");
  if (!APPLY_LINE_ANY.test(text)) return text;
  let hasOutside = APPLY_LINE_ANY.test(textOutsideFences(text));
  // mapFences llama en el orden del texto: el primer bloque con la linea la recibe afuera.
  return mapFences(text, (fence) => {
    let action = "";
    const kept = fence.code.split("\n").filter((line) => {
      const match = line.match(APPLY_LINE_ONE);
      if (!match) return true;
      action = action || match[1].toLowerCase();
      return false;
    });
    if (!action) return null;
    const rendered = renderFence({ info: fence.info, code: kept.join("\n"), closed: fence.closed });
    if (hasOutside) return rendered;
    hasOutside = true;
    return `Aplicar: ${action}\n\n${rendered}`;
  });
}

/** Accion de la linea "Aplicar:" de una respuesta (vacio si no trae). */
export function parseApplyAction(markdown: string): "insert" | "replace" | "delete" | "" {
  const match = String(markdown || "").match(APPLY_LINE_ANY);
  const action = (match?.[1] || "").toLowerCase();
  return action === "insert" || action === "replace" || action === "delete" ? action : "";
}

/**
 * Parte de las lineas de la seleccion (sin sangria ni lineas en blanco) que
 * aparece en el codigo: una version del bloque copia las que no cambian; un
 * fragmento para insertar casi no repite ninguna. Igual que
 * retainedSelectionFraction de VS Code (suggestion-code.ts). Las lineas que son
 * solo una llave o una palabra suelta no cuentan (isSignificantCodeLine).
 */
function keptSelectionLines(selection: string, code: string) {
  const original = nonBlankTrimmedLines(selection).filter(isSignificantCodeLine);
  const pool = new Map<string, number>();
  for (const line of nonBlankTrimmedLines(code)) {
    pool.set(line, (pool.get(line) || 0) + 1);
  }
  let kept = 0;
  for (const line of original) {
    const available = pool.get(line) || 0;
    if (available > 0) {
      pool.set(line, available - 1);
      kept += 1;
    }
  }
  return { kept, total: original.length };
}

export function retainedSelectionFraction(selection: string, code: string) {
  const { kept, total } = keptSelectionLines(selection, code);
  return total ? kept / total : 0;
}

/**
 * Accion que va a usar VS Code 0.0.34 para el codigo de la respuesta: la linea
 * "Aplicar:", el pedido del estudiante o, si se contradicen (tambien un
 * "delete" con codigo cuando se pidio algo), el contenido: la mitad o mas de las
 * lineas significativas del bloque, replace; si no, insert. Un "insert" que ya
 * trae 2 o mas de esas lineas tambien es replace: insertarlo lo duplicaria.
 */
export function effectiveApplyAction(markdown: string, code: string, options: SuggestionRequestOptions = {}) {
  const explicit = parseApplyAction(markdown);
  const requested = options.requestedAction || "";
  const action = explicit || requested;
  if (!code.trim() || action === "") return action;
  const { kept, total } = keptSelectionLines(String(options.selection || ""), code);
  const keepsBlock = total > 0 && kept / total >= 0.5;
  if (explicit && requested && explicit !== requested) return keepsBlock ? "replace" : "insert";
  if (action === "insert" && keepsBlock && kept >= 2) return "replace";
  return action;
}

/**
 * Como queda el codigo de la respuesta despues del guardarrail (30-10-2026); es tambien
 * code_application.truncation de /suggest-tab:
 *   - none: no hizo falta recortar;
 *   - applicable: se recorto y todavia se puede aplicar (un trozo cerrado para insertar o un
 *     reemplazo parcial que solo quita las lineas del estudiante que reemplaza un cambio aplicado
 *     entero, 31-10-2026);
 *   - guide: se recorto (o el bloque venia sin cerrar) y solo sirve de guia: no se ofrece aplicar.
 */
export type CodeTruncation = "none" | "applicable" | "guide";

/**
 * Por que un recorte quedo como guia: el tope de la etapa (cap; tambien con varios bloques o sin
 * permiso de aplicar) o un bloque que no termina porque la respuesta del modelo se corto
 * (incomplete_reply), que no es un limite del docente.
 */
export type GuideCause = "cap" | "incomplete_reply";

export type GuardrailResult = {
  text: string;
  outcome: CodeTruncation;
  /** Solo con outcome "guide". */
  guideCause: GuideCause | null;
  /** Cuanto se mostro del bloque recortado (code_application.cut); null si no se recorto un bloque. */
  cutSummary: CutSummary | null;
  /** Se quito una linea «Aplicar:» de la respuesta. */
  applyRemoved: boolean;
};

/** Pone (o cambia) la linea «Aplicar:» de la respuesta: justo antes del bloque si no la traia. */
function withApplyAction(markdown: string, action: "insert" | "replace", fence: MarkdownFence) {
  if (APPLY_LINE_ANY.test(markdown)) return markdown.replace(APPLY_LINE_ALL, `Aplicar: ${action}`);
  return replaceFence(markdown, { start: fence.start, end: fence.start }, `Aplicar: ${action}\n\n`);
}

type EditorCodeLimit = { text: string; outcome: CodeTruncation; incompleteReply: boolean; cutSummary: CutSummary | null };

/**
 * Recorte de una respuesta con un solo bloque de codigo cerrado (el que VS Code aplica), segun
 * la accion:
 *   - replace sobre la seleccion: si cambia hasta maxLines lineas, entero (el bloque mejorado
 *     repite las que no cambian); si cambia mas, un reemplazo parcial que se puede aplicar o,
 *     si no se puede armar, guia (31-10-2026: antes quedaba como "none" si el bloque era corto, y
 *     un bloque de 3 lineas que reemplazaba 12 borraba 9 lineas del estudiante con un clic);
 *   - insert: las primeras lineas hasta un punto donde todo queda cerrado; se puede insertar;
 *   - cualquier otra (sin accion o replace sin seleccion): las primeras lineas, como guia.
 */
function limitSingleEditorBlock(
  markdown: string,
  fence: MarkdownFence,
  maxLines: number,
  options: SuggestionRequestOptions,
): EditorCodeLimit {
  const action = effectiveApplyAction(markdown, fence.code, options);
  const selection = String(options.selection || "");
  const family = detectCodeFamily({ fenceInfo: fence.info, languageHint: options.languageHint, code: fence.code });
  const untouched: EditorCodeLimit = { text: markdown, outcome: "none", incompleteReply: false, cutSummary: null };
  let guideOnly = false;
  if (action === "replace" && selection.trim()) {
    if (countChangedLines(selection, fence.code) <= maxLines) return untouched;
    const partial = buildPartialReplacement({ original: selection, proposed: fence.code, maxChangedLines: maxLines, family });
    if (partial) {
      const rendered = renderCutFence({ info: fence.info, code: partial.code, note: formatPartialReplacementNote(partial) });
      const withFence = replaceFence(markdown, fence, rendered);
      return {
        text: withApplyAction(withFence, "replace", { ...fence, end: fence.start + rendered.length }),
        outcome: "applicable",
        incompleteReply: false,
        cutSummary: summarizePartialReplacement(partial),
      };
    }
    // Cambia mas lineas de las permitidas y no hay parcial: solo guia, aunque el bloque sea corto.
    guideOnly = true;
  }
  if (fence.code.split("\n").length <= maxLines) return guideOnly ? { ...untouched, outcome: "guide" } : untouched;
  const prefix = cutCodePrefix(fence.code, maxLines, family);
  const rendered = renderCutFence({ info: fence.info, code: prefix.code, note: formatPrefixCutNote(prefix) });
  return {
    text: replaceFence(markdown, fence, rendered),
    outcome: !guideOnly && action === "insert" && prefix.endsCleanly ? "applicable" : "guide",
    incompleteReply: false,
    cutSummary: summarizePrefixCut(prefix),
  };
}

/**
 * Recorta el codigo de la respuesta al tope de la etapa. Con varios bloques (VS Code solo aplica
 * el primero), con un bloque sin cerrar (respuesta cortada) o sin tope (0), cada bloque se
 * recorta como guia.
 */
function limitEditorCode(markdown: string, maxLines: number, options: SuggestionRequestOptions): EditorCodeLimit {
  const fences = parseFences(markdown);
  if (!fences.length) return { text: markdown, outcome: "none", incompleteReply: false, cutSummary: null };
  if (maxLines > 0 && fences.length === 1 && fences[0].closed) {
    return limitSingleEditorBlock(markdown, fences[0], maxLines, options);
  }
  const limited = limitCodeBlocks(markdown, maxLines, options.languageHint || "");
  return {
    text: limited.text,
    outcome: limited.truncated ? "guide" : "none",
    incompleteReply: limited.incompleteReply,
    cutSummary: limited.firstTruncatedBlock,
  };
}

/**
 * Salida de /suggest-tab ya revisada por la politica (A10.2): recorta el codigo al tope de la
 * etapa sin dejar lineas «...» dentro del bloque (la nota va fuera) y quita la linea «Aplicar:»
 * cuando lo que queda no se puede aplicar (un recorte de guia) o la politica no deja aplicar.
 * Un recorte que se puede aplicar conserva la linea: el estudiante puede seguir aplicando y la
 * etapa avanza (30-10-2026). Si la politica no deja aplicar, un recorte es siempre guia.
 */
export function applySuggestionGuardrail(
  markdown: string,
  decision: SuggestionPolicyDecision,
  options: SuggestionRequestOptions = {},
): GuardrailResult {
  const limited = limitEditorCode(normalizeFenceLines(String(markdown || "")), decision.codeApplication.maxLines, options);
  const outcome: CodeTruncation = limited.outcome === "applicable" && !decision.codeApplication.allowed ? "guide" : limited.outcome;
  const guideCause: GuideCause | null = outcome !== "guide" ? null : limited.incompleteReply ? "incomplete_reply" : "cap";
  const removeApply = !decision.codeApplication.allowed || outcome === "guide";
  const hadApplyLine = APPLY_LINE_ANY.test(limited.text);
  const text = removeApply ? limited.text.replace(APPLY_LINE_ALL, "").replace(/\n{3,}/g, "\n\n").trim() : limited.text;
  return {
    text,
    outcome,
    guideCause,
    cutSummary: outcome === "none" ? null : limited.cutSummary,
    applyRemoved: removeApply && hadApplyLine,
  };
}

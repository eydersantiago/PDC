// Recorte del codigo que propone el tutor cuando pasa del tope de la etapa (30-10-2026).
//
// Antes el guardarrail cortaba el bloque en N lineas y le agregaba la linea
// «// ... recortado por la politica del docente: completa el resto tu». VS Code 0.0.35 lee
// «// ...» y «resto del codigo» como lineas que el modelo resumio (isElisionLine), no las puede
// completar con la seleccion y escondia el codigo entero. Y como el codigo recortado ya no se
// podia aplicar, la etapa nunca avanzaba (se queda en 5 lineas para siempre). Ahora:
//   - el corte nunca escribe una linea con «...», «…» ni «resto» dentro del bloque: la nota va
//     fuera, en cursiva (formatPrefixCutNote, formatPartialReplacementNote);
//   - el corte cae donde las llaves, parentesis y corchetes quedan cerrados (sin contar los que
//     van en cadenas o comentarios) y, en Python, donde la sangria vuelve al nivel de la primera
//     linea (cutCodePrefix). Un trozo asi se puede insertar;
//   - un reemplazo de la seleccion que cambia mas lineas de las permitidas se vuelve un reemplazo
//     parcial (buildPartialReplacement): se aplican los cambios en orden mientras alcance el cupo
//     y las demas lineas del estudiante quedan como estan.
// Revision independiente del 31-10-2026:
//   - un tramo que quita lineas del estudiante se aplica entero o no se aplica (antes se aplicaba
//     la linea nueva y se dejaba la vieja: `double saldo;` junto a `int saldo;`), y dos lineas que
//     declaran o asignan el mismo nombre son la misma linea cambiada;
//   - un corte no separa un try, do o if de su catch, while o else (leavesBlockChainOpen).
// Modulo puro (sin base, sin modelo ni Express) para probar cada caso con node:test.

import { renderFence } from "./markdown-fences.js";

/** Como se ve donde termina un bloque: por llaves (C, C++, Java...) o por sangria (Python). */
export type CodeFamily = "brace" | "indent";

/** Cuantos ( [ { quedan abiertos (abiertos menos cerrados) en un punto del codigo. */
export type Depth = { paren: number; bracket: number; brace: number };

export type BracketShape = Depth & {
  /** El valor mas bajo que alcanzo cada contador (negativo: se cerro algo que no se abrio). */
  min: Depth;
};

/** Las primeras lineas de un bloque (cutCodePrefix); los nombres son los de code_application.cut. */
export type PrefixCut = {
  code: string;
  /** Lineas que quedaron en el bloque. */
  linesShown: number;
  /** Lineas del bloque original del modelo (sin las de «...»). */
  linesTotal: number;
  /** El corte dejo todo cerrado y sin un bloque a medias: se puede insertar tal cual. */
  endsCleanly: boolean;
};

/** Reemplazo parcial de la seleccion (buildPartialReplacement); nombres de code_application.cut. */
export type PartialReplacement = {
  code: string;
  /** Lineas nuevas o distintas respecto a la seleccion que trae el reemplazo (countChangedLines). */
  changesShown: number;
  /** Lineas nuevas o distintas que traia la propuesta completa del modelo. */
  changesTotal: number;
};

/**
 * El recorte tal como va en code_application.cut de /suggest-tab (VS Code ya no busca el texto de
 * la nota); null cuando no se recorto ningun bloque.
 *   - prefix: se muestran las primeras linesShown de linesTotal lineas del bloque; endsCleanly
 *     dice si el corte dejo todo cerrado (se podria insertar tal cual);
 *   - partial: reemplazo parcial de la seleccion con changesShown de las changesTotal lineas nuevas
 *     o distintas que traia la propuesta (misma cuenta que countChangedLines).
 */
export type CutSummary =
  | { kind: "prefix"; linesShown: number; linesTotal: number; endsCleanly: boolean }
  | { kind: "partial"; changesShown: number; changesTotal: number };

export function summarizePrefixCut(cut: PrefixCut): CutSummary {
  return { kind: "prefix", linesShown: cut.linesShown, linesTotal: cut.linesTotal, endsCleanly: cut.endsCleanly };
}

export function summarizePartialReplacement(partial: PartialReplacement): CutSummary {
  return { kind: "partial", changesShown: partial.changesShown, changesTotal: partial.changesTotal };
}

const BRACE_LANGUAGE = /^(?:c|cpp|c\+\+|cc|cxx|h|hh|hpp|hxx|java|javascript|typescript|js|ts|jsx|tsx|javascriptreact|typescriptreact|csharp|cs|c#|go|rust|rs|kotlin|kt|swift|php|scala|dart)$/i;
const INDENT_LANGUAGE = /^(?:python|py|python3)$/i;
const PYTHON_HEADER = /^\s*(?:def|class|if|elif|else|for|while|try|except|finally|with)\b.*:\s*(?:#.*)?$/;

/**
 * Familia del codigo: la del bloque (```cpp, ```python), si no la del archivo y, sin ninguna,
 * la que sugiere el codigo (sin llaves ni punto y coma y con encabezados de Python: sangria).
 */
export function detectCodeFamily(input: { fenceInfo?: string; languageHint?: string; code?: string }): CodeFamily {
  for (const value of [String(input.fenceInfo || "").trim().split(/\s+/)[0] || "", String(input.languageHint || "").trim()]) {
    if (INDENT_LANGUAGE.test(value)) return "indent";
    if (BRACE_LANGUAGE.test(value)) return "brace";
  }
  const text = String(input.code || "");
  if (!/[{};]/.test(text) && text.split("\n").some((line) => PYTHON_HEADER.test(line))) return "indent";
  return "brace";
}

// --- Lineas que resumen codigo ---------------------------------------------------------------

const ELLIPSIS_ALONE = /^(?:\.{3,}|…)\s*(?:(?:\/\/|#|\/\*|<!--|--).*)?$/;
const COMMENTED_ELLIPSIS = /^(?:\/\/+|#+|\/\*+|<!--|--)\s*(?:\.{3,}|…)/;
const ELISION_PHRASE = /\b(?:resto|demas|demás)\b.*\b(?:codigo|código|metodo|método|clase|archivo|funcion|función|igual|bloque)\b|\b(?:sin cambios|igual que antes|se mantiene|codigo existente|código existente|existing code|rest of (?:the )?code|unchanged)\b/i;
const COMMENT_START = /^(?:\/\/+|#(?!\s*(?:include|define|undef|if|ifdef|ifndef|elif|else|endif|pragma)\b)|\/\*+|<!--|--\s)/;

/**
 * Linea con que el modelo resume codigo que no cambia ("// ...", "# ... resto igual", "...").
 * La misma regla que isElisionLine de VS Code 0.0.35 (suggestion-code.ts).
 */
export function isElisionMarkerLine(line: string) {
  const text = String(line || "").trim();
  if (!text) return false;
  if (ELLIPSIS_ALONE.test(text) || COMMENTED_ELLIPSIS.test(text)) return true;
  return COMMENT_START.test(text) && ELISION_PHRASE.test(text);
}

// --- Lineas que cambian ----------------------------------------------------------------------

/** Lineas con texto, sin la sangria (para comparar versiones de un bloque). */
export function nonBlankTrimmedLines(text: string) {
  return String(text || "")
    .replace(/\r\n?/g, "\n")
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);
}

/**
 * Lineas que cambian al reemplazar `original` por `next`: max(anadidas, quitadas), comparando
 * lineas sin sangria y sin contar las que se repiten igual. Es lo mismo que mide apply-check en
 * VS Code (measureCodeChange de code-application-guard.ts), asi la sugerencia y la aplicacion
 * usan la misma cuenta. Con «...» las lineas que faltan son las que no cambian: VS Code las
 * completa con el bloque original o no ofrece aplicar.
 */
export function countChangedLines(original: string, next: string) {
  const pool = new Map<string, number>();
  for (const line of nonBlankTrimmedLines(original)) {
    pool.set(line, (pool.get(line) || 0) + 1);
  }
  let added = 0;
  let elided = false;
  for (const line of nonBlankTrimmedLines(next)) {
    if (isElisionMarkerLine(line)) {
      elided = true;
      continue;
    }
    const available = pool.get(line) || 0;
    if (available > 0) {
      pool.set(line, available - 1);
    } else {
      added += 1;
    }
  }
  if (elided) return added;
  let removed = 0;
  for (const count of pool.values()) {
    removed += count;
  }
  return Math.max(added, removed);
}

const BARE_KEYWORD = /^(else|end|try|do|begin|then|fi|done|pass|break|continue|default|finally)$/i;

/** Una linea con letras o numeros que no es solo una llave o una palabra suelta (`}`, `} else {`). */
export function isSignificantCodeLine(line: string) {
  const words = String(line || "").match(/[\p{L}\p{N}_]+/gu) || [];
  return words.some((word) => !BARE_KEYWORD.test(word));
}

// --- Donde se puede cortar -------------------------------------------------------------------

export function splitLines(code: string) {
  return String(code || "").replace(/\r\n?/g, "\n").split("\n");
}

// --- Notas fuera del bloque ------------------------------------------------------------------

/** Nota de un bloque recortado: va despues de la valla, nunca dentro del codigo. */
export function formatPrefixCutNote(cut: Pick<PrefixCut, "linesShown" | "linesTotal">) {
  return `_El tutor muestra ${cut.linesShown} de ${cut.linesTotal} lineas: el resto lo escribes tu._`;
}

/** Nota de un reemplazo parcial: va despues de la valla, nunca dentro del codigo. */
export function formatPartialReplacementNote(partial: Pick<PartialReplacement, "changesShown" | "changesTotal">) {
  return `_El tutor propone ${partial.changesShown} de ${partial.changesTotal} lineas nuevas o distintas para tu bloque; tus demas lineas quedan como estan y el resto lo escribes tu._`;
}

/** Bloque de codigo recortado con su nota fuera de la valla. */
export function renderCutFence(input: { info: string; code: string; note: string }) {
  return `${renderFence({ info: input.info, code: input.code })}\n\n${input.note}`;
}

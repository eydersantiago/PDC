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
type Depth = { paren: number; bracket: number; brace: number };

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

// --- Llaves, parentesis y corchetes ----------------------------------------------------------

/**
 * Las lineas con las cadenas, los caracteres y los comentarios cambiados por espacios (// y /* *\/
 * en C, C++, Java...; # y cadenas triples en Python): lo que queda es el codigo que cuenta para
 * las llaves y para leer el encabezado de un bloque (31-10-2026: un solo lector para los dos).
 */
function maskStringsAndComments(lines: string[], family: CodeFamily): string[] {
  const result: string[] = [];
  let mode: "code" | "block_comment" | "string" = "code";
  let quote = "";
  for (const line of lines) {
    let masked = "";
    let index = 0;
    const blank = (count: number) => {
      const width = Math.min(count, line.length - index);
      masked += " ".repeat(width);
      index += width;
    };
    while (index < line.length) {
      if (mode === "block_comment") {
        if (line.startsWith("*/", index)) {
          mode = "code";
          blank(2);
        } else {
          blank(1);
        }
        continue;
      }
      if (mode === "string") {
        if (line[index] === "\\") {
          blank(2);
        } else if (line.startsWith(quote, index)) {
          mode = "code";
          blank(quote.length);
        } else {
          blank(1);
        }
        continue;
      }
      const char = line[index];
      if (family === "brace" && line.startsWith("//", index)) {
        blank(line.length - index);
        break;
      }
      if (family === "brace" && line.startsWith("/*", index)) {
        mode = "block_comment";
        blank(2);
        continue;
      }
      if (family === "indent" && char === "#") {
        blank(line.length - index);
        break;
      }
      if (family === "indent" && (line.startsWith("\"\"\"", index) || line.startsWith("'''", index))) {
        mode = "string";
        quote = line.slice(index, index + 3);
        blank(3);
        continue;
      }
      if (char === "\"" || char === "'" || (char === "`" && family === "brace")) {
        mode = "string";
        quote = char;
        blank(1);
        continue;
      }
      masked += char;
      index += 1;
    }
    // Una cadena de una sola comilla no cruza lineas (la plantilla ` de JavaScript y las triples si).
    if (mode === "string" && quote.length === 1 && quote !== "`") mode = "code";
    result.push(masked);
  }
  return result;
}

/**
 * Cuenta ( [ { abiertos menos cerrados despues de cada linea, sin los que van en cadenas,
 * caracteres ni comentarios (maskStringsAndComments).
 */
function scanDepths(lines: string[], family: CodeFamily): BracketShape[] {
  const depth: Depth = { paren: 0, bracket: 0, brace: 0 };
  const min: Depth = { paren: 0, bracket: 0, brace: 0 };
  const result: BracketShape[] = [];
  const bump = (key: keyof Depth, delta: number) => {
    depth[key] += delta;
    if (depth[key] < min[key]) min[key] = depth[key];
  };
  for (const line of maskStringsAndComments(lines, family)) {
    for (const char of line) {
      if (char === "(") bump("paren", 1);
      else if (char === ")") bump("paren", -1);
      else if (char === "[") bump("bracket", 1);
      else if (char === "]") bump("bracket", -1);
      else if (char === "{") bump("brace", 1);
      else if (char === "}") bump("brace", -1);
    }
    result.push({ ...depth, min: { ...min } });
  }
  return result;
}

/** Cuenta de ( [ { de un bloque completo (lo que queda abierto y lo mas bajo que llego). */
export function measureBracketShape(code: string, family: CodeFamily): BracketShape {
  const scans = scanDepths(splitLines(code), family);
  return scans[scans.length - 1] || { paren: 0, bracket: 0, brace: 0, min: { paren: 0, bracket: 0, brace: 0 } };
}

function isClosed(shape: BracketShape) {
  return shape.paren === 0 && shape.bracket === 0 && shape.brace === 0
    && shape.min.paren >= 0 && shape.min.bracket >= 0 && shape.min.brace >= 0;
}

/**
 * La version cambiada deja las llaves como la seleccion: lo mismo abierto al final y sin cerrar
 * nada que la seleccion no cerraba. Una seleccion completa (todo cerrado) pide una version
 * completa; una seleccion a medias admite una version igual de a medias.
 */
function sameShape(original: BracketShape, next: BracketShape) {
  return original.paren === next.paren && original.bracket === next.bracket && original.brace === next.brace
    && next.min.paren >= original.min.paren && next.min.bracket >= original.min.bracket && next.min.brace >= original.min.brace;
}

// --- Donde se puede cortar -------------------------------------------------------------------

function splitLines(code: string) {
  return String(code || "").replace(/\r\n?/g, "\n").split("\n");
}

function indentColumns(line: string) {
  let width = 0;
  for (const char of line.match(/^[ \t]*/)?.[0] || "") {
    width = char === "\t" ? width + 4 - (width % 4) : width + 1;
  }
  return width;
}

function isCommentLine(line: string, family: CodeFamily) {
  const text = line.trim();
  return family === "indent"
    ? text.startsWith("#")
    : /^(?:\/\/|\/\*|\*)/.test(text);
}

function isCodeLine(line: string, family: CodeFamily) {
  return Boolean(line.trim()) && !isCommentLine(line, family);
}

const CONTROL_HEADER = /^(?:\}\s*)?(?:if|else|for|while|do|switch|foreach|try|catch)\b/;
// Operador, coma, dos puntos (public:, lista de inicializacion) o parentesis de cierre sin ";"
// (la firma de una funcion o un if cuya llave va en la linea siguiente).
const CONTINUATION_END = /(?:[,=+\-*/%?&|^~!<>(\[.:)]|&&|\|\||<<|>>)$/;

/**
 * La linea deja algo a medias si lo que sigue tiene que ser parte de ella: un if/for/while sin
 * cuerpo, una firma sin su llave, un operador o una coma al final, o (en Python) dos puntos o
 * una barra al final.
 */
export function leavesConstructOpen(line: string, family: CodeFamily) {
  let text = line.trim();
  if (family === "brace") {
    if (text.startsWith("@")) return true; // una anotacion va con lo que sigue
    if (text.startsWith("#")) return false; // directiva del preprocesador
    text = text.replace(/\s+\/\/.*$/, "").trim();
    if (/(?:\+\+|--)$/.test(text)) return false;
    if (CONTROL_HEADER.test(text) && !/[;{}]$/.test(text)) return true;
    return CONTINUATION_END.test(text);
  }
  text = text.replace(/\s+#.*$/, "").trim();
  return /[:\\]$/.test(text) || /(?:[,=+\-*/%(\[]|\band|\bor)$/.test(text);
}

/** Ultima linea de codigo (no comentario ni vacia) de lines[start..end], o "". */
function lastCodeLine(lines: string[], start: number, end: number, family: CodeFamily) {
  for (let index = end; index >= start; index -= 1) {
    if (isCodeLine(lines[index], family)) return lines[index];
  }
  return "";
}

/** Primera linea de codigo (no comentario ni vacia) desde lines[from], con su sangria; o "". */
function nextCodeLine(lines: string[], from: number, family: CodeFamily) {
  for (let index = from; index < lines.length; index += 1) {
    if (isCodeLine(lines[index], family)) return lines[index];
  }
  return "";
}

// Lo que sigue a un bloque cerrado y es parte de el (31-10-2026): el catch o finally de un try, el
// else de un if y el «while (...);» de un do. Un corte antes de esa linea deja el try o el do sin
// terminar (no compila) o el if sin su else.
const BLOCK_CONTINUATION = /^(?:catch|finally|else)\b/;
const DO_WHILE_TAIL = /^while\s*\(.*\)\s*;\s*(?:\/\/.*)?$/;
const PYTHON_CONTINUATION = /^(?:except|finally|else|elif)\b/;

/**
 * Encabezado del ultimo bloque de llaves de un trozo («try», «do», «if (x)», «catch (...)»), solo
 * si el trozo termina justo en su llave de cierre; null si termina en otra cosa (un «;», un
 * «} while (x);») o si esa llave cierra un bloque que se abrio antes del trozo.
 */
function lastClosedBlockHeader(run: string[]) {
  const code = maskStringsAndComments(run, "brace").join("\n").trimEnd();
  if (!code.endsWith("}")) return null;
  let depth = 0;
  let open = -1;
  for (let index = code.length - 1; index >= 0; index -= 1) {
    if (code[index] === "}") depth += 1;
    else if (code[index] === "{" && --depth === 0) {
      open = index;
      break;
    }
  }
  if (open < 0) return null;
  // El encabezado va desde el «;» o la llave anterior (fuera de parentesis: el for lleva «;»).
  let paren = 0;
  let start = 0;
  for (let index = open - 1; index >= 0; index -= 1) {
    const char = code[index];
    if (char === ")") paren += 1;
    else if (char === "(") paren -= 1;
    else if (paren <= 0 && (char === ";" || char === "{" || char === "}")) {
      start = index + 1;
      break;
    }
  }
  return code.slice(start, open).trim().replace(/\s+/g, " ");
}

/**
 * Lo que rodea el corte: `following`, la primera linea de codigo que queda despues del trozo en el
 * resultado ("" si no queda nada: un trozo para insertar); `dropped`, la primera linea de codigo de
 * la propuesta del modelo que el corte deja fuera ("" si quedo en el resultado).
 */
type CutSurroundings = { following: string; dropped: string };

/**
 * El trozo deja a medias una cadena de bloques (31-10-2026, revision independiente): termina en un
 * try o un do sin su catch o su while, o el corte deja fuera el catch, finally, else o while que
 * seguia (en Python, el except, finally, else o elif al nivel de la primera linea o mas afuera).
 */
function leavesBlockChainOpen(run: string[], family: CodeFamily, around: CutSurroundings) {
  const dropped = around.dropped.trim();
  if (family === "indent") {
    const first = run.find((line) => line.trim());
    return Boolean(first && PYTHON_CONTINUATION.test(dropped) && indentColumns(around.dropped) <= indentColumns(first));
  }
  const header = lastClosedBlockHeader(run);
  const following = around.following.trim();
  if (header === "try" && !/^(?:catch|finally)\b/.test(following)) return true;
  if (header === "do" && !DO_WHILE_TAIL.test(following)) return true;
  return BLOCK_CONTINUATION.test(dropped) || DO_WHILE_TAIL.test(dropped);
}

/**
 * ¿Se puede cortar despues de lines[end] un trozo que empieza en lines[start]? Sin una
 * construccion a medias al final, sin un try, do o if separado de su catch, while o else
 * (leavesBlockChainOpen) y, en Python, con la siguiente linea de vuelta al nivel de la primera
 * (o mas afuera): asi no se corta un bloque por la mitad. Sin `around`, el trozo se inserta solo
 * (no le sigue nada) y lo que deja fuera es la linea siguiente de `lines`.
 */
function endsCleanly(lines: string[], start: number, end: number, family: CodeFamily, around?: CutSurroundings) {
  const last = lastCodeLine(lines, start, end, family);
  if (!last || leavesConstructOpen(last, family)) return false;
  const surroundings = around || { following: "", dropped: nextCodeLine(lines, end + 1, family) };
  if (leavesBlockChainOpen(lines.slice(start, end + 1), family, surroundings)) return false;
  if (family !== "indent") return true;
  const first = lines.slice(start, end + 1).find((line) => line.trim());
  const next = lines.slice(end + 1).find((line) => line.trim());
  return !first || !next || indentColumns(next) <= indentColumns(first);
}

/**
 * Las primeras lineas del bloque, hasta maxLines, cortadas donde todo queda cerrado (clean). Si
 * no hay un corte asi dentro del tope, las primeras maxLines lineas: sirven de guia pero no se
 * pueden insertar tal cual. Nunca deja una linea de «...»: las que traia el modelo se quitan.
 */
export function cutCodePrefix(code: string, maxLines: number, family: CodeFamily): PrefixCut {
  const lines = splitLines(code).filter((line) => !isElisionMarkerLine(line));
  while (lines.length && !lines[lines.length - 1].trim()) lines.pop();
  const total = lines.length;
  const limit = Math.max(0, Math.min(Math.floor(maxLines), total));
  const depths = scanDepths(lines, family);
  let end = -1;
  for (let candidate = limit - 1; candidate >= 0; candidate -= 1) {
    if (!lines[candidate].trim()) continue;
    if (isClosed(depths[candidate]) && endsCleanly(lines, 0, candidate, family)) {
      end = candidate;
      break;
    }
  }
  const kept = (end >= 0 ? lines.slice(0, end + 1) : lines.slice(0, limit));
  while (kept.length && !kept[kept.length - 1].trim()) kept.pop();
  return { code: kept.join("\n"), linesShown: kept.length, linesTotal: total, endsCleanly: end >= 0 };
}

// --- Reemplazo parcial -----------------------------------------------------------------------

type DiffOp =
  | { kind: "equal"; a: number; b: number }
  | { kind: "modify"; a: number; b: number }
  | { kind: "insert"; b: number }
  | { kind: "delete"; a: number };

/** Clave de una linea para comparar: sin espacios (int main(){ y int main() { son la misma). */
function lineKey(line: string) {
  return line.replace(/\s+/g, "");
}

/** Mas de esto (lineas de la seleccion x lineas propuestas) no se compara: queda como guia. */
const MAX_DIFF_CELLS = 60_000;

/** Diferencia por lineas (subsecuencia comun mas larga), en orden: igual, quitar, agregar. */
function diffLines(a: string[], b: string[]): DiffOp[] {
  const keysA = a.map(lineKey);
  const keysB = b.map(lineKey);
  const rows = a.length + 1;
  const cols = b.length + 1;
  const table = new Uint16Array(rows * cols);
  for (let i = a.length - 1; i >= 0; i -= 1) {
    for (let j = b.length - 1; j >= 0; j -= 1) {
      table[i * cols + j] = keysA[i] === keysB[j]
        ? table[(i + 1) * cols + j + 1] + 1
        : Math.max(table[(i + 1) * cols + j], table[i * cols + j + 1]);
    }
  }
  const ops: DiffOp[] = [];
  let i = 0;
  let j = 0;
  while (i < a.length || j < b.length) {
    if (i < a.length && j < b.length && keysA[i] === keysB[j]) {
      ops.push({ kind: "equal", a: i, b: j });
      i += 1;
      j += 1;
    } else if (j >= b.length || (i < a.length && table[(i + 1) * cols + j] >= table[i * cols + j + 1])) {
      ops.push({ kind: "delete", a: i });
      i += 1;
    } else {
      ops.push({ kind: "insert", b: j });
      j += 1;
    }
  }
  return ops;
}

/** Palabras, numeros y cadenas de una linea (los simbolos no cuentan: `<<` o `;` estan en todas). */
function codeTokens(line: string) {
  return line.match(/[\p{L}_][\p{L}\p{N}_]*|\d+(?:\.\d+)?|"[^"]*"|'[^']*'/gu) || [];
}

/** Parecido entre dos lineas (coeficiente de Dice sobre sus palabras, numeros y cadenas). */
function lineSimilarity(left: string, right: string) {
  const a = codeTokens(left);
  const b = codeTokens(right);
  if (!a.length || !b.length) return 0;
  const pool = new Map<string, number>();
  for (const token of a) pool.set(token, (pool.get(token) || 0) + 1);
  let common = 0;
  for (const token of b) {
    const available = pool.get(token) || 0;
    if (available > 0) {
      pool.set(token, available - 1);
      common += 1;
    }
  }
  return (2 * common) / (a.length + b.length);
}

/**
 * Desde este parecido una linea quitada y una agregada son la misma linea cambiada. Alto a
 * proposito: `cout << "Hola";` y `cout << "Saldo: " << s;` no son la misma, y la del estudiante
 * se queda en vez de cambiarse por otra.
 */
const MODIFY_SIMILARITY = 0.6;

// --- Nombre que declara o asigna una linea (31-10-2026) --------------------------------------
// Revision independiente: `int saldo;` -> `double saldo;` se parece 0,5 (solo comparten «saldo»),
// no llegaba a MODIFY_SIMILARITY y quedaba como «quitar» + «agregar»; el reemplazo parcial
// aplicaba la agregada y dejaba la quitada, y el estudiante recibia `double saldo;` y `int saldo;`
// (una redeclaracion) como codigo aplicable. Dos lineas que declaran o asignan el mismo nombre son
// la misma linea cambiada, se parezcan o no.

/** Palabras que pueden ir antes de un nombre sin ser un tipo (return x; delete p; case X:). */
const NOT_A_TYPE = /^(?:return|delete|throw|goto|case|else|new|using|typedef|namespace|template|operator|if|for|while|switch|do|sizeof|friend|co_return|co_yield|co_await|break|continue|default|print|yield|await|import|from|raise|assert|del|pass|lambda|not|and|or|in|is)$/;

/** «tipo nombre» al comienzo de la linea, seguido de =, ;, coma, (, { o : (int x = 0; void f(int m) {). */
const DECLARATION = /^(?:(?:const|static|constexpr|mutable|volatile|unsigned|signed|long|short|final|inline|virtual|explicit|extern|register|let|var|auto)\s+)*([A-Za-z_]\w*(?:::[A-Za-z_]\w*)*(?:\s*<[^;(){}=]*>)?)(?:\s*[*&]+\s*|\s+)((?:[A-Za-z_]\w*::)*~?[A-Za-z_]\w*)\s*(?:\[[^\]]*\]\s*)*(?:=(?!=)|;|,|\(|\{|:(?!:))/;

/** «nombre = ...», «nombre += ...», «this->nombre = ...», «v[i] = ...» al comienzo de la linea. */
const ASSIGNMENT = /^((?:(?:this|self)\s*(?:->|\.)\s*)?[A-Za-z_]\w*(?:\s*(?:\.|->)\s*[A-Za-z_]\w*)*)\s*(?:\[[^\]]*\]\s*)?(?:[-+*/%&|^]|<<|>>)?=(?!=)/;

/** Nombre que declara la linea (`int saldo;`, `void depositar(int m) {`, `def f(x):`), o "". */
function declaredName(line: string) {
  const match = String(line || "").trim().match(DECLARATION);
  if (!match || NOT_A_TYPE.test(match[1])) return "";
  return match[2];
}

/** Nombre que declara o asigna la linea, sin this-> ni self. (`saldo += m;` -> saldo), o "". */
function declaredOrAssignedName(line: string) {
  const declared = declaredName(line);
  if (declared) return declared;
  const match = String(line || "").trim().match(ASSIGNMENT);
  if (!match || NOT_A_TYPE.test(match[1])) return "";
  return match[1].replace(/\s+/g, "").replace(/^(?:this->|this\.|self\.)/, "");
}

/** Cuantas veces declara cada nombre un bloque (lineas que empiezan con «tipo nombre»). */
function declarationCounts(lines: string[]) {
  const counts = new Map<string, number>();
  for (const line of lines) {
    const name = declaredName(line);
    if (name) counts.set(name, (counts.get(name) || 0) + 1);
  }
  return counts;
}

/**
 * Dentro de cada tramo distinto, una linea quitada y una agregada son la misma linea cambiada
 * (modify) si declaran o asignan el mismo nombre o, si no, si se parecen. Las agregadas van antes
 * de las quitadas que no se emparejan; un tramo con quitadas sueltas se aplica entero o no se
 * aplica (buildPartialReplacement).
 */
function refineDiff(ops: DiffOp[], a: string[], b: string[]): DiffOp[] {
  const refined: DiffOp[] = [];
  let index = 0;
  while (index < ops.length) {
    if (ops[index].kind === "equal") {
      refined.push(ops[index]);
      index += 1;
      continue;
    }
    const deleted: number[] = [];
    const inserted: number[] = [];
    while (index < ops.length && ops[index].kind !== "equal") {
      const op = ops[index];
      if (op.kind === "delete") deleted.push(op.a);
      if (op.kind === "insert") inserted.push(op.b);
      index += 1;
    }
    const pairs: Array<{ d: number; i: number }> = [];
    let from = 0;
    for (let d = 0; d < deleted.length; d += 1) {
      const left = a[deleted[d]];
      const name = declaredOrAssignedName(left);
      let match = -1;
      for (let k = from; name && k < inserted.length && match < 0; k += 1) {
        if (declaredOrAssignedName(b[inserted[k]]) === name) match = k;
      }
      for (let k = from; isSignificantCodeLine(left) && k < inserted.length && match < 0; k += 1) {
        if (lineSimilarity(left, b[inserted[k]]) >= MODIFY_SIMILARITY) match = k;
      }
      if (match >= 0) {
        pairs.push({ d, i: match });
        from = match + 1;
      }
    }
    let nextD = 0;
    let nextI = 0;
    const flush = (untilD: number, untilI: number) => {
      for (; nextI < untilI; nextI += 1) refined.push({ kind: "insert", b: inserted[nextI] });
      for (; nextD < untilD; nextD += 1) refined.push({ kind: "delete", a: deleted[nextD] });
    };
    for (const pair of pairs) {
      flush(pair.d, pair.i);
      refined.push({ kind: "modify", a: deleted[pair.d], b: inserted[pair.i] });
      nextD = pair.d + 1;
      nextI = pair.i + 1;
    }
    flush(deleted.length, inserted.length);
  }
  return refined;
}

/** Columnas por nivel de sangria de un conjunto de lineas (MCD de sus sangrias relativas). */
function indentUnit(lines: string[]) {
  const widths = lines.filter((line) => line.trim()).map(indentColumns);
  if (!widths.length) return 0;
  const base = Math.min(...widths);
  const gcd = (x: number, y: number): number => (y === 0 ? x : gcd(y, x % y));
  return widths.map((width) => width - base).filter((width) => width > 0).reduce((acc, width) => gcd(acc, width), 0);
}

function leadingIndent(line: string) {
  return line.match(/^[ \t]*/)?.[0] || "";
}

/**
 * El bloque parcial queda con la sangria del modelo (es la que tiene todas las lineas bien
 * puestas; VS Code re-indenta el bloque entero al aplicarlo): las lineas del estudiante que el
 * modelo conserva o cambia toman la sangria de su linea en el modelo, y las que el modelo
 * quitaba (se dejan) se ubican respecto a la linea conservada mas cercana. La primera linea de la
 * seleccion no sirve de referencia si hay otra: si se selecciono desde el texto llega sin sangria.
 */
function modelFrame(a: string[], b: string[], ops: DiffOp[]) {
  const anchors = ops
    .map((op, index) => ({ op, index }))
    .filter((item): item is { op: Extract<DiffOp, { a: number; b: number }>; index: number } => item.op.kind === "equal" || item.op.kind === "modify");
  const preferred = anchors.filter((item) => item.op.a > 0);
  const pool = preferred.length ? preferred : anchors;
  const originalUnit = indentUnit(a.slice(1));
  const modelUnit = indentUnit(b);
  const scale = originalUnit > 0 && modelUnit > 0 ? modelUnit / originalUnit : 1;
  const useTabs = b.some((line) => /^\t/.test(line)) && !b.some((line) => /^ /.test(line));
  const render = (columns: number, text: string) => {
    const width = Math.max(0, Math.round(columns));
    const indent = useTabs ? "\t".repeat(Math.floor(width / 4)) + " ".repeat(width % 4) : " ".repeat(width);
    return `${indent}${text}`;
  };
  return {
    /** Linea del estudiante con la sangria de su linea en el modelo. */
    kept(originalLine: string, modelLine: string) {
      return originalLine.trim() ? `${leadingIndent(modelLine)}${originalLine.trim()}` : "";
    },
    /** Linea del estudiante que el modelo quitaba, junto a la conservada mas cercana. */
    left(opIndex: number) {
      const op = ops[opIndex] as { a: number };
      const line = a[op.a];
      if (!line.trim()) return "";
      const before = [...pool].reverse().find((item) => item.index < opIndex);
      const anchor = before || pool.find((item) => item.index > opIndex);
      if (!anchor) return line;
      const columns = indentColumns(b[anchor.op.b]) + (indentColumns(line) - indentColumns(a[anchor.op.a])) * scale;
      return render(columns, line.trim());
    },
  };
}

/**
 * Cambios que se aplican juntos en un reemplazo parcial (31-10-2026), con lo que suman a la cuenta
 * de countChangedLines: lineas que agregan (insert y modify) y lineas del estudiante que quitan
 * (modify y delete).
 */
type ChangeGroup = { ops: number[]; added: number; removed: number };

/**
 * Los cambios de la propuesta en orden. En un tramo sin quitadas sueltas cada linea agregada o
 * cambiada va sola (se puede cortar entre ellas). Un tramo con una quitada suelta va entero: su
 * linea nueva puede reemplazar a la quitada (`int saldo;` -> `double saldo;` con otro nombre de
 * tipo), y aplicar la agregada sin quitar la otra deja las dos.
 */
function changeGroups(ops: DiffOp[], a: string[], b: string[]): ChangeGroup[] {
  const groups: ChangeGroup[] = [];
  const weight = (line: string) => (line.trim() ? 1 : 0);
  let index = 0;
  while (index < ops.length) {
    if (ops[index].kind === "equal") {
      index += 1;
      continue;
    }
    const hunk: number[] = [];
    while (index < ops.length && ops[index].kind !== "equal") hunk.push(index++);
    const atomic = hunk.some((at) => {
      const op = ops[at];
      return op.kind === "delete" && Boolean(a[op.a].trim());
    });
    const single = (at: number): ChangeGroup => {
      const op = ops[at];
      return {
        ops: [at],
        added: op.kind === "insert" || op.kind === "modify" ? weight(b[op.b]) : 0,
        removed: op.kind === "delete" || op.kind === "modify" ? weight(a[op.a]) : 0,
      };
    };
    if (!atomic) {
      for (const at of hunk) {
        if (ops[at].kind === "insert" || ops[at].kind === "modify") groups.push(single(at));
      }
      continue;
    }
    const whole = hunk.map(single);
    groups.push({
      ops: hunk,
      added: whole.reduce((sum, item) => sum + item.added, 0),
      removed: whole.reduce((sum, item) => sum + item.removed, 0),
    });
  }
  return groups;
}

/**
 * Reemplazo parcial de la seleccion cuando la propuesta del modelo cambia mas de maxLines lineas:
 * se recorren los cambios en orden (changeGroups) y se aplican mientras alcance el cupo, con la
 * misma cuenta que countChangedLines. Las lineas de la seleccion que quedaron despues del corte, o
 * en un tramo que no se aplico, se dejan como estan. Un tramo que quita lineas del estudiante se
 * aplica entero (agrega y quita) o no se aplica: el parcial nunca deja una linea nueva junto a la
 * que reemplazaba (31-10-2026). Solo vale si:
 *   - la propuesta es una version del bloque (conserva o cambia la mitad o mas de sus lineas
 *     significativas; una reescritura completa no se puede aplicar por partes);
 *   - el resultado deja las llaves como la seleccion, no termina en una construccion a medias ni
 *     separa un try, do o if de su catch, while o else (endsCleanly);
 *   - el resultado no declara un nombre mas veces que la seleccion o la propuesta;
 *   - la propuesta no resume lineas con «...» (no se sabria cuales son).
 * null si no hay un reemplazo parcial asi: el codigo queda como guia.
 */
export function buildPartialReplacement(input: {
  /** La seleccion del estudiante. */
  original: string;
  /** El bloque que propone el modelo para reemplazarla. */
  proposed: string;
  /** Cuantas lineas nuevas o distintas puede traer el reemplazo (el tope de la etapa). */
  maxChangedLines: number;
  family: CodeFamily;
}): PartialReplacement | null {
  const { original, proposed, family } = input;
  const budget = Math.floor(input.maxChangedLines);
  if (budget <= 0 || !String(original || "").trim()) return null;
  const a = splitLines(original);
  const b = splitLines(proposed);
  while (b.length && !b[b.length - 1].trim()) b.pop();
  if (!b.length || b.some(isElisionMarkerLine)) return null;
  if (a.length * b.length > MAX_DIFF_CELLS) return null;

  const ops = refineDiff(diffLines(a, b), a, b);
  const significant = a.filter((line) => isSignificantCodeLine(line.trim()));
  const matched = ops.filter((op) => (op.kind === "equal" || op.kind === "modify") && isSignificantCodeLine(a[op.a].trim())).length;
  if (!significant.length || matched / significant.length < 0.5) return null;

  // Grupos de cambios que se pueden aplicar, en orden, hasta donde alcanza el cupo: lo que agregan
  // y lo que quitan se cuentan aparte, como en countChangedLines (max de las dos).
  const groups: ChangeGroup[] = [];
  let added = 0;
  let removed = 0;
  for (const group of changeGroups(ops, a, b)) {
    if (Math.max(added + group.added, removed + group.removed) > budget) break;
    added += group.added;
    removed += group.removed;
    groups.push(group);
  }

  const total = countChangedLines(original, proposed);
  const originalShape = measureBracketShape(original, family);
  const declaredBefore = declarationCounts(a);
  const declaredInProposal = declarationCounts(b);
  const frame = modelFrame(a, b, ops);
  for (let count = groups.length; count >= 1; count -= 1) {
    const applied = new Set(groups.slice(0, count).flatMap((group) => group.ops));
    const addedOps = [...applied].sort((x, y) => x - y).filter((index) => {
      const op = ops[index];
      return (op.kind === "insert" || op.kind === "modify") && Boolean(b[op.b].trim());
    });
    if (!addedOps.length) continue;
    const lastIndex = addedOps[addedOps.length - 1];
    const lastOp = ops[lastIndex] as { b: number };
    const out: string[] = [];
    let lastOut = -1;
    ops.forEach((op, index) => {
      if (op.kind === "equal") out.push(frame.kept(a[op.a], b[op.b]));
      else if (op.kind === "delete") {
        if (!applied.has(index)) out.push(frame.left(index));
      } else if (op.kind === "modify") out.push(applied.has(index) ? b[op.b] : frame.kept(a[op.a], b[op.b]));
      else if (applied.has(index)) out.push(b[op.b]);
      if (index === lastIndex) lastOut = out.length - 1;
    });
    const following = out.slice(lastOut + 1).find((line) => isCodeLine(line, family)) || "";
    while (out.length && !out[out.length - 1].trim()) out.pop();
    const candidate = out.join("\n");
    const changed = countChangedLines(original, candidate);
    if (changed < 1 || changed > budget) continue;
    if (!sameShape(originalShape, measureBracketShape(candidate, family))) continue;
    if (redeclares(declarationCounts(out), declaredBefore, declaredInProposal)) continue;
    // El ultimo cambio aplicado no puede dejar un bloque a medias (en Python, con la sangria del
    // tramo de lineas nuevas al que pertenece) ni dejar fuera el catch, while o else que seguia.
    let runStart = lastOp.b;
    for (let back = addedOps.length - 2; back >= 0; back -= 1) {
      const op = ops[addedOps[back]] as { b: number };
      if (op.b !== runStart - 1) break;
      runStart = op.b;
    }
    if (!endsCleanly(b, runStart, lastOp.b, family, { following, dropped: droppedAfter(ops, applied, b, lastOp.b, family) })) continue;
    return { code: candidate, changesShown: changed, changesTotal: total };
  }
  return null;
}

/**
 * La siguiente linea de codigo de la propuesta despues de b[after], si el reemplazo parcial la deja
 * fuera (una agregada o cambiada que no se aplico); "" si quedo en el resultado o no hay otra.
 */
function droppedAfter(ops: DiffOp[], applied: Set<number>, b: string[], after: number, family: CodeFamily) {
  let next = -1;
  for (let index = after + 1; index < b.length; index += 1) {
    if (isCodeLine(b[index], family)) {
      next = index;
      break;
    }
  }
  if (next < 0) return "";
  const at = ops.findIndex((op) => op.kind !== "delete" && op.b === next);
  if (at < 0 || ops[at].kind === "equal" || applied.has(at)) return "";
  return b[next];
}

/** El resultado declara algun nombre mas veces que la seleccion y que la propuesta. */
function redeclares(result: Map<string, number>, before: Map<string, number>, proposal: Map<string, number>) {
  for (const [name, count] of result) {
    if (count > Math.max(before.get(name) || 0, proposal.get(name) || 0)) return true;
  }
  return false;
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

// Recorte del codigo: donde se puede cortar un bloque (cutCodePrefix) sin dejar una construccion abierta.
import { maskStringsAndComments, scanDepths, isClosed } from "./code-cut-brackets.js";
import { type CodeFamily, type PrefixCut, splitLines, isElisionMarkerLine } from "./code-cut.js";

export function indentColumns(line: string) {
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

export function isCodeLine(line: string, family: CodeFamily) {
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
export function endsCleanly(lines: string[], start: number, end: number, family: CodeFamily, around?: CutSurroundings) {
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

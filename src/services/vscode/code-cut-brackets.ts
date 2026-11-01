// Recorte del codigo: llaves, parentesis y corchetes sin contar cadenas ni comentarios (forma de un bloque).
import { type CodeFamily, type BracketShape, type Depth, splitLines } from "./code-cut.js";

// --- Llaves, parentesis y corchetes ----------------------------------------------------------

/**
 * Las lineas con las cadenas, los caracteres y los comentarios cambiados por espacios (// y /* *\/
 * en C, C++, Java...; # y cadenas triples en Python): lo que queda es el codigo que cuenta para
 * las llaves y para leer el encabezado de un bloque (31-10-2026: un solo lector para los dos).
 */
export function maskStringsAndComments(lines: string[], family: CodeFamily): string[] {
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
export function scanDepths(lines: string[], family: CodeFamily): BracketShape[] {
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

export function isClosed(shape: BracketShape) {
  return shape.paren === 0 && shape.bracket === 0 && shape.brace === 0
    && shape.min.paren >= 0 && shape.min.bracket >= 0 && shape.min.brace >= 0;
}

/**
 * La version cambiada deja las llaves como la seleccion: lo mismo abierto al final y sin cerrar
 * nada que la seleccion no cerraba. Una seleccion completa (todo cerrado) pide una version
 * completa; una seleccion a medias admite una version igual de a medias.
 */
export function sameShape(original: BracketShape, next: BracketShape) {
  return original.paren === next.paren && original.bracket === next.bracket && original.brace === next.brace
    && next.min.paren >= original.min.paren && next.min.bracket >= original.min.bracket && next.min.brace >= original.min.brace;
}

// Referencia privada del examen en la respuesta en vivo de /suggest-tab (01-11-2026). Separado de
// exam-reference.ts (que pasaba de 500 lineas): usa sus mismas claves de linea de codigo.
import { CODE_PIECE, codeLineKey, referenceCodeLines, stripLineMarkers } from "./exam-reference.js";

/**
 * Para la respuesta en vivo (01-11-2026): dice si una linea de prosa PARECE copiada de la
 * referencia, mas estricto que guardExamReferenceLeak (sin cupo, y tambien si la copia va dentro de
 * comillas invertidas o en medio de la frase). Ante la duda la linea no se muestra en vivo; al
 * final se ve lo que deje la respuesta completa (guardExamReferenceLeak, cupo de 3).
 */
export function createReferenceLineCheck(referenceText: string) {
  const watched = referenceText ? referenceCodeLines(referenceText) : new Set<string>();
  if (!watched.size) return (_line: string) => false;
  // Cada linea vigilada tambien sin las llaves y el punto y coma de los extremos: la copia puede
  // venir sin el «;» final o sin la «{» de apertura. Solo las de 3 piezas o mas (no «return x»).
  const cores = [...new Set([...watched].map((key) => key.replace(/^(?:[;{}] )+|(?: [;{}])+$/g, "")))]
    .filter((core) => core.split(" ").length >= 3);
  const spacedKeys = [...watched].map((key) => ` ${key} `);
  // En modo local la prosa en vivo se revisa con cada token: cada linea se mira una sola vez.
  const seen = new Map<string, boolean>();
  return (raw: string) => {
    const line = String(raw || "");
    const known = seen.get(line);
    if (known !== undefined) return known;
    const result = looksCopied(line);
    if (seen.size < 2000) seen.set(line, result);
    return result;
  };

  function looksCopied(line: string) {
    const key = codeLineKey(line);
    if (key && watched.has(key)) return true;
    for (const span of line.matchAll(/`([^`\n]+)`/g)) {
      const spanKey = codeLineKey(span[1]);
      if (spanKey && watched.has(spanKey)) return true;
    }
    // Una linea de la referencia escrita en medio de la frase: sus piezas seguidas dentro de las de
    // la linea.
    const linePieces = stripLineMarkers(line).match(CODE_PIECE) || [];
    const joined = ` ${linePieces.join(" ")} `;
    if (cores.some((core) => joined.includes(` ${core} `))) return true;
    // Un trozo de una linea de la referencia (4 piezas seguidas con algun simbolo, p. ej.
    // «if (monto > saldo)» sin el resto): ante la duda, en vivo no se muestra.
    for (let start = 0; start + REFERENCE_WINDOW <= linePieces.length; start += 1) {
      const window = linePieces.slice(start, start + REFERENCE_WINDOW);
      if (!window.some((piece) => !/^\w+$/.test(piece))) continue;
      const probe = ` ${window.join(" ")} `;
      if (spacedKeys.some((key) => key.includes(probe))) return true;
    }
    return false;
  }
}

/** Piezas seguidas de una linea de la referencia que bastan para no mostrar una linea en vivo. */
const REFERENCE_WINDOW = 4;

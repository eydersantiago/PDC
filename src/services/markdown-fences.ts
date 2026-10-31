// Bloques de codigo (```) de una respuesta del modelo (30-10-2026): un solo lector para el
// guardarrail, el recorte del overlay, la referencia del examen, el reintento de un pedido de
// codigo y la cache. Antes cada uno tenia su expresion regular y un bloque sin cerrar (respuesta
// cortada) no contaba como bloque: pasaba entero sin el tope de la etapa.
//
// Reglas:
//   - una valla abre solo al comienzo de una linea (despues de espacios o tabuladores) y cierra
//     con una linea que es solo ``` (con espacios alrededor);
//   - un bloque abierto al final del texto cuenta como bloque (closed: false), para que se
//     recorte o se descarte como los demas;
//   - normalizeFenceLines pasa a su propia linea una valla escrita a mitad de linea
//     ("Mira: ```cpp" o "x = 1;```"): VS Code 0.0.37 abre y cierra bloques en cualquier punto
//     del texto, y sin esto un bloque asi saldria sin tope.

export type MarkdownFence = {
  /** Posicion donde empieza la linea de apertura. */
  start: number;
  /** Posicion despues de la linea de cierre (sin su salto de linea), o el largo del texto. */
  end: number;
  /** Lo que sigue a ``` en la apertura (lenguaje), sin espacios alrededor. */
  info: string;
  /** El codigo, sin las vallas ni el salto de linea final. */
  code: string;
  /** false: el texto termino sin la valla de cierre (respuesta cortada). */
  closed: boolean;
};

const OPENING = /^[ \t]*```+[ \t]*([^\n`]*?)[ \t]*$/;
const CLOSING = /^[ \t]*```+[ \t]*$/;

/** Bloques de codigo en orden. Acepta saltos de linea \r\n. */
export function parseFences(markdown: string): MarkdownFence[] {
  const text = String(markdown || "");
  const fences: MarkdownFence[] = [];
  let open: { start: number; info: string; bodyStart: number } | null = null;
  let position = 0;
  while (position <= text.length) {
    const newline = text.indexOf("\n", position);
    const lineEnd = newline < 0 ? text.length : newline;
    const line = text.slice(position, lineEnd).replace(/\r$/, "");
    if (!open) {
      const match = line.match(OPENING);
      if (match) open = { start: position, info: match[1].trim(), bodyStart: Math.min(text.length, lineEnd + 1) };
    } else if (CLOSING.test(line)) {
      const body = text.slice(open.bodyStart, Math.max(open.bodyStart, position));
      fences.push({ start: open.start, end: lineEnd, info: open.info, code: trimFinalNewline(body), closed: true });
      open = null;
    }
    if (newline < 0) break;
    position = newline + 1;
  }
  if (open) {
    fences.push({ start: open.start, end: text.length, info: open.info, code: trimFinalNewline(text.slice(open.bodyStart)), closed: false });
  }
  return fences;
}

function trimFinalNewline(body: string) {
  return body.replace(/\r?\n$/, "").replace(/\r/g, "");
}

/** El primer bloque, o null. */
export function firstFence(markdown: string): MarkdownFence | null {
  return parseFences(markdown)[0] || null;
}

/** Cambia un bloque (con sus vallas) por otro texto. */
export function replaceFence(markdown: string, fence: Pick<MarkdownFence, "start" | "end">, replacement: string) {
  const text = String(markdown || "");
  return `${text.slice(0, fence.start)}${replacement}${text.slice(fence.end)}`;
}

/**
 * Cambia cada bloque por lo que devuelva `render` (null lo deja igual). Los cambios se aplican
 * de atras hacia adelante, asi las posiciones de los demas no se mueven.
 */
export function mapFences(markdown: string, render: (fence: MarkdownFence, index: number) => string | null) {
  const fences = parseFences(markdown);
  let text = String(markdown || "");
  for (let index = fences.length - 1; index >= 0; index -= 1) {
    const replacement = render(fences[index], index);
    if (replacement !== null) text = replaceFence(text, fences[index], replacement);
  }
  return text;
}

/** El texto sin los bloques de codigo (lo que lee el estudiante como prosa). */
export function textOutsideFences(markdown: string) {
  return mapFences(markdown, () => "");
}

/** Un bloque cerrado con su lenguaje: «```info\ncodigo\n```» («```info\n```» si no hay codigo). */
export function renderFence(info: string, code: string) {
  return code ? `\`\`\`${info}\n${code}\n\`\`\`` : `\`\`\`${info}\n\`\`\``;
}

/**
 * Pasa a su propia linea cada ``` escrito a mitad de linea: «Mira: ```cpp» queda «Mira:» y
 * «```cpp»; «x = 1;```» queda «x = 1;» y «```». Las lineas que ya empiezan con ``` y no traen
 * otra valla no cambian.
 */
export function normalizeFenceLines(markdown: string) {
  const text = String(markdown || "");
  if (!text.includes("```")) return text;
  return text.split("\n").map((line) => {
    const body = line.replace(/\r$/, "");
    const lead = body.match(/^[ \t]*/)?.[0] || "";
    const rest = body.slice(lead.length);
    // Antes de cada ``` que no siga a otra comilla invertida (````md no se parte).
    const parts = rest.split(/(?<!`)(?=```)/);
    const pieces: string[] = [];
    for (const part of parts) {
      if (!part) continue;
      if (part.startsWith("```")) {
        // Una valla con algo pegado detras que no es un lenguaje («```}» o «```int x;») se separa.
        const fence = part.match(/^```+[ \t]*[A-Za-z0-9_+#.-]*[ \t]*/)?.[0] || "```";
        const after = part.slice(fence.length);
        pieces.push(fence.trimEnd());
        if (after.trim()) pieces.push(after.trim());
      } else if (part.trim()) {
        pieces.push(part.trimEnd());
      }
    }
    if (pieces.length <= 1) return line;
    return pieces.map((piece, index) => (index === 0 ? `${lead}${piece}` : piece)).join("\n");
  }).join("\n");
}

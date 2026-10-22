// ADACEEN: el contexto del editor que manda VS Code en tab_content (que partes trae, de donde
// sale el codigo para el RAG y como se ajusta a la ventana del modelo).
//
// Revision de precision del 21/10/2026. Antes el backend cortaba tab_content a ciegas
// (MAX_TAB_CONTENT_CHARS) y, si el prompt no cabia en la ventana del modelo, Ollama cortaba el
// comienzo en silencio. Ahora se quitan primero las partes de menos valor (mapa del proyecto,
// texto visible repetido) y el codigo se recorta alrededor del foco.

export type EditorSectionKind =
  | "meta"
  | "selection"
  | "current_line"
  | "errors"
  | "visible"
  | "code"
  | "outline"
  | "related"
  | "map";

export type EditorSection = { kind: EditorSectionKind; lines: string[] };

/** Encabezados de las partes de tab_content (VS Code 0.0.34 y 0.0.35). */
const SECTION_HEADERS: Array<{ re: RegExp; kind: EditorSectionKind }> = [
  { re: /^Bloque seleccionado\b/, kind: "selection" },
  { re: /^Linea actual:/, kind: "current_line" },
  { re: /^Errores y avisos del editor\b/, kind: "errors" },
  { re: /^Texto visible del editor:/, kind: "visible" },
  { re: /^Codigo (?:del archivo activo|alrededor del foco|del archivo)\b/, kind: "code" },
  { re: /^Estructura del resto del archivo\b/, kind: "outline" },
  { re: /^Declaraciones de archivos relacionados\b/, kind: "related" },
  { re: /^(?:Mapa local del proyecto|Otros archivos del proyecto)\b/, kind: "map" },
  { re: /^(?:Repositorio|Workspace|Archivo activo|Lenguaje|Cursor|Disparador|Lineas del archivo):/, kind: "meta" },
];

/** Margen de VS Code 0.0.35 en el codigo numerado: "  16>| codigo" (foco) o "  15 | codigo". */
const LINE_GUTTER = /^\s*\d+[ >]\| ?/;
const FOCUS_GUTTER = /^\s*\d+>\|/;

export function stripLineGutter(line: string) {
  return line.replace(LINE_GUTTER, "");
}

export function parseEditorContent(tabContent: string): EditorSection[] {
  const sections: EditorSection[] = [];
  let current: EditorSection = { kind: "meta", lines: [] };
  for (const line of String(tabContent || "").split(/\r?\n/)) {
    const header = SECTION_HEADERS.find((item) => item.re.test(line));
    // Los rotulos de una linea seguidos (Repositorio, Archivo activo, Lenguaje...) van juntos.
    if (header && !(header.kind === "meta" && current.kind === "meta")) {
      if (current.lines.length) sections.push(current);
      current = { kind: header.kind, lines: [line] };
      continue;
    }
    current.lines.push(line);
  }
  if (current.lines.length) sections.push(current);
  return sections;
}

function renderSections(sections: EditorSection[]) {
  return sections
    .map((section) => section.lines.join("\n").replace(/\n+$/g, ""))
    .filter((text) => text.trim())
    .join("\n\n");
}

/** Lineas de codigo de una parte (sin el encabezado, sin los rotulos y sin el margen numerado). */
function sectionCode(section: EditorSection) {
  return section.lines
    .slice(1)
    .filter((line) => !/^(?:Lineas analizadas de la seleccion|Aviso: la seleccion|El foco principal es)\b/.test(line))
    .map(stripLineGutter)
    .join("\n")
    .trim();
}

/**
 * Codigo para la consulta del RAG: el foco (seleccion, lineas marcadas con ">" o linea actual)
 * y el del archivo (la ventana de codigo o, si no viene, el texto visible).
 */
export function extractEditorCode(tabContent: string, selection = "") {
  const sections = parseEditorContent(tabContent);
  const codeSections = sections.filter((section) => section.kind === "code");
  const fileCode = (codeSections.length ? codeSections : sections.filter((section) => section.kind === "visible"))
    .map(sectionCode)
    .join("\n");
  let focusCode = String(selection || "").trim();
  if (!focusCode) {
    const selectionSection = sections.find((section) => section.kind === "selection");
    if (selectionSection) focusCode = sectionCode(selectionSection);
  }
  if (!focusCode) {
    focusCode = codeSections
      .flatMap((section) => section.lines.filter((line) => FOCUS_GUTTER.test(line)).map(stripLineGutter))
      .join("\n")
      .trim();
  }
  if (!focusCode) {
    const currentLine = sections.find((section) => section.kind === "current_line");
    if (currentLine) focusCode = sectionCode(currentLine);
  }
  return { focusCode, fileCode };
}

/**
 * Recorta las lineas de codigo de una parte a maxChars: alrededor de las lineas de foco si las
 * hay (VS Code 0.0.35 las marca con ">"), si no desde el comienzo. Marca lo omitido.
 */
function shrinkCodeSection(section: EditorSection, maxChars: number): EditorSection {
  const [header, ...body] = section.lines;
  const budget = Math.max(200, maxChars - header.length - 60);
  const focusIndexes = body.map((line, index) => (FOCUS_GUTTER.test(line) ? index : -1)).filter((index) => index >= 0);
  let start: number;
  let end: number;
  if (focusIndexes.length) {
    start = focusIndexes[0];
    end = focusIndexes[focusIndexes.length - 1];
  } else {
    start = 0;
    end = 0;
  }
  let size = body.slice(start, end + 1).reduce((total, line) => total + line.length + 1, 0);
  // Si el foco solo ya no cabe, se queda su comienzo.
  if (size > budget) {
    let cut = start;
    size = 0;
    while (cut <= end && size + body[cut].length + 1 <= budget) {
      size += body[cut].length + 1;
      cut += 1;
    }
    end = Math.max(start, cut - 1);
  } else {
    let grewBefore = true;
    let grewAfter = true;
    while (grewBefore || grewAfter) {
      grewBefore = false;
      grewAfter = false;
      if (end + 1 < body.length && size + body[end + 1].length + 1 <= budget) {
        end += 1;
        size += body[end].length + 1;
        grewAfter = true;
      }
      if (focusIndexes.length && start > 0 && size + body[start - 1].length + 1 <= budget) {
        start -= 1;
        size += body[start].length + 1;
        grewBefore = true;
      }
    }
  }
  const lines = [header];
  if (start > 0) lines.push(`... (${start} linea(s) omitidas arriba)`);
  lines.push(...body.slice(start, end + 1));
  const below = body.slice(end + 1).filter((line) => line.trim()).length;
  if (below > 0) lines.push(`... (${body.length - end - 1} linea(s) omitidas abajo)`);
  return { kind: section.kind, lines };
}

export type FittedEditorContent = { text: string; omitted: EditorSectionKind[]; trimmedCode: boolean };

/**
 * Ajusta tab_content a maxChars sin cortar a ciegas. Orden: el mapa del proyecto, el texto
 * visible (repite el codigo), las declaraciones de archivos relacionados y la estructura del
 * resto del archivo; despues se recorta el codigo alrededor del foco. En el resumen del archivo
 * el mapa vale mas que el texto visible.
 */
export function fitEditorContent(
  tabContent: string,
  maxChars: number,
  scope: "focus" | "file_summary" = "focus",
): FittedEditorContent {
  const limit = Math.max(400, Math.floor(maxChars));
  if (tabContent.length <= limit) return { text: tabContent, omitted: [], trimmedCode: false };
  let sections = parseEditorContent(tabContent);
  const omitted: EditorSectionKind[] = [];
  const dropOrder: EditorSectionKind[] = scope === "file_summary"
    ? ["visible", "related", "map", "outline"]
    : ["map", "visible", "related", "outline"];
  for (const kind of dropOrder) {
    if (renderSections(sections).length <= limit) break;
    if (sections.some((section) => section.kind === kind)) {
      sections = sections.filter((section) => section.kind !== kind);
      omitted.push(kind);
    }
  }
  let trimmedCode = false;
  let rendered = renderSections(sections);
  if (rendered.length > limit) {
    const codeIndex = sections.findIndex((section) => section.kind === "code");
    if (codeIndex >= 0) {
      const codeText = sections[codeIndex].lines.join("\n");
      const target = codeText.length - (rendered.length - limit);
      sections = sections.map((section, index) => (index === codeIndex ? shrinkCodeSection(section, target) : section));
      trimmedCode = true;
      rendered = renderSections(sections);
    }
  }
  if (rendered.length > limit) rendered = rendered.slice(0, limit);
  return { text: rendered, omitted, trimmedCode };
}

const CODE_FENCE = /```([^\n]*)\n([\s\S]*?)```/g;
const COPIED_GUTTER = /^[ \t]*\d+[ \t]*>?[ \t]*[|│] ?/;

/**
 * Quita de los bloques de codigo de la respuesta el margen numerado que el modelo copio del
 * contexto ("  16>| codigo"), solo si TODAS sus lineas con texto lo traen (revision
 * independiente del 21/10/2026: con el margen, el guardarrail contaba todas las lineas como
 * cambiadas y un «// TODO» pasaba por codigo).
 */
export function stripCodeFenceGutters(markdown: string) {
  return String(markdown || "").replace(CODE_FENCE, (whole, info: string, body: string) => {
    const lines = body.replace(/\r\n?/g, "\n").split("\n");
    const withText = lines.filter((line) => line.trim());
    if (!withText.length || !withText.every((line) => COPIED_GUTTER.test(line))) return whole;
    return `\`\`\`${info}\n${lines.map((line) => (line.trim() ? line.replace(COPIED_GUTTER, "") : "")).join("\n")}\`\`\``;
  });
}

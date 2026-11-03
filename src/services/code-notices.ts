// Avisos del revisor automatico sobre el codigo del estudiante (02-11-2026, el caso de Alan).
//
// La VM de editores (deploy/gcp/workspaces/avance-ws.py --evaluar) puntua el taller con las
// reglas de C++: «Class Cliente {» con mayuscula no es una clase, asi que esa clase no cuenta y
// su avance puede salir en 0 % aunque lo demas este bien. La nota no cambia (no es C++ valido),
// pero el estudiante tiene que saberlo. La VM manda solo el id del aviso y los archivos donde lo
// vio; este catalogo es la unica fuente de los textos: lo que lee el estudiante en VS Code («Te
// falta:»), lo que ve el docente en el monitor y la instruccion que recibe el tutor cuando
// encuentra lo mismo en el codigo que el estudiante tiene abierto.
//
// Un aviso nuevo es una entrada mas de CODE_NOTICES (y su deteccion en avance-ws.py, AVISOS): ni el
// esquema del informe, ni las vistas, ni el prompt cambian.

/** Una linea del codigo que tiene abierto el estudiante, con su numero real si se sabe. */
export type CodeLine = { line: number | null; text: string };

/** Lo que el tutor sabe del archivo abierto. */
export type CodeContext = { languageHint?: string; fileName?: string; lines: readonly CodeLine[] };

export type CodeNoticeDefinition = {
  readonly id: string;
  /** Para el estudiante (VS Code lo muestra tal cual en «Te falta:»): a lo sumo CODE_NOTICE_TEXT_MAX. */
  studentText(files: readonly string[]): string;
  /** Para el docente (monitor): lo mismo, contado en tercera persona. */
  teacherText(files: readonly string[]): string;
  /** Para el tutor: una instruccion si el codigo abierto tiene el problema, o "" si no lo tiene. */
  tutorInstruction(context: CodeContext): string;
};

/** Los mismos topes que el lector de VS Code 0.0.38 (texto 160, id 40) y que avance-ws.py. */
export const CODE_NOTICE_TEXT_MAX = 160;
export const CODE_NOTICES_MAX = 5;
export const CODE_NOTICE_FILES_MAX = 6;
export const CODE_NOTICE_FILE_CHARS = 120;
/** Lineas que el tutor nombra a lo sumo en su instruccion. */
const TUTOR_LINES_MAX = 3;

/** "A", "A y B", "A, B y C". */
function joinSpanish(items: readonly string[]) {
  if (items.length <= 1) return items.join("");
  return `${items.slice(0, -1).join(", ")} y ${items[items.length - 1]}`;
}

function baseName(file: string) {
  return file.split(/[\\/]/).filter(Boolean).pop() || file;
}

/**
 * El texto con la lista de archivos mas larga que cabe en `max` («A, B y 2 más»); si ni uno cabe
 * (o no hay archivos), con `fallback` en lugar de la lista. Archivos por su nombre, sin repetir.
 */
export function fitFileList(files: readonly string[], render: (list: string) => string, fallback: string, max = CODE_NOTICE_TEXT_MAX) {
  const names = [...new Set(files.map(baseName).filter(Boolean))];
  for (let shown = names.length; shown >= 1; shown -= 1) {
    const rest = names.length - shown;
    const text = render(rest > 0 ? `${names.slice(0, shown).join(", ")} y ${rest} más` : joinSpanish(names));
    if (text.length <= max) return text;
  }
  return render(fallback).slice(0, max);
}

// --- Codigo C y C++ ---------------------------------------------------------------------------

const C_FAMILY_LANGUAGES = new Set(["c", "cpp", "c++", "cc", "cxx", "h", "hh", "hpp", "hxx"]);
const C_FAMILY_FILE = /\.(?:c|cc|cpp|cxx|c\+\+|h|hh|hpp|hxx)$/i;

/** El archivo es C o C++: por el lenguaje que dice VS Code o, sin el, por la extension. */
export function isCFamilySource(context: Pick<CodeContext, "languageHint" | "fileName">) {
  const language = String(context.languageHint || "").trim().toLowerCase();
  if (language) return C_FAMILY_LANGUAGES.has(language);
  return C_FAMILY_FILE.test(String(context.fileName || "").trim());
}

/** Las lineas sin comentarios (// y /* *\/, tambien de varias lineas) ni textos entre comillas. */
export function stripCComments(lines: readonly CodeLine[]): CodeLine[] {
  let inBlock = false;
  return lines.map(({ line, text }) => {
    let out = "";
    let index = 0;
    while (index < text.length) {
      if (inBlock) {
        const end = text.indexOf("*/", index);
        if (end < 0) break;
        inBlock = false;
        index = end + 2;
        continue;
      }
      const char = text[index];
      const next = text[index + 1];
      if (char === "/" && next === "/") break;
      if (char === "/" && next === "*") {
        inBlock = true;
        index += 2;
        continue;
      }
      if (char === "\"" || char === "'") {
        let close = index + 1;
        while (close < text.length && text[close] !== char) close += text[close] === "\\" ? 2 : 1;
        out += char + char;
        index = close + 1;
        continue;
      }
      out += char;
      index += 1;
    }
    return { line, text: out };
  });
}

function lineList(lines: readonly number[]) {
  if (!lines.length) return "en su codigo";
  return lines.length === 1 ? `en la linea ${lines[0]}` : `en las lineas ${joinSpanish(lines.map(String))}`;
}

// --- Class con mayuscula ----------------------------------------------------------------------

// Al comienzo de la linea: «Class Cliente {», «CLASS Cuenta : public Base» o con la llave en la
// linea siguiente. La misma regla que avance-ws.py (AVISO_CLASE_RE): class y struct en minuscula
// son C++ valido y no avisan.
const MISSPELLED_CLASS_KEY = /^\s*(?!class\b|struct\b)([Cc][Ll][Aa][Ss][Ss]|[Ss][Tt][Rr][Uu][Cc][Tt])\s+([A-Za-z_]\w{0,59})\s*(?:final\b\s*)?(?::(?!:)|\{|$)/;

const misspelledClassKey: CodeNoticeDefinition = {
  id: "class-mayuscula",
  studentText: (files) => fitFileList(
    files,
    (list) => `Escribe class en minúscula en ${list}: C++ no reconoce Class con mayúscula, así que no compila y esas clases no cuentan en tu avance.`,
    "tus archivos",
  ),
  teacherText: (files) => fitFileList(
    files,
    (list) => `Escribió Class con mayúscula en ${list}: no compila y esas clases no cuentan en su avance (C++ solo reconoce class).`,
    "sus archivos",
  ),
  tutorInstruction(context) {
    if (!isCFamilySource(context)) return "";
    const numbers = new Set<number>();
    let first: { keyword: string; name: string } | null = null;
    for (const { line, text } of stripCComments(context.lines)) {
      const match = MISSPELLED_CLASS_KEY.exec(text);
      if (!match) continue;
      first ??= { keyword: match[1], name: match[2] };
      if (line !== null) numbers.add(line);
    }
    if (!first) return "";
    const lines = [...numbers].sort((a, b) => a - b).slice(0, TUTOR_LINES_MAX);
    return `Aviso del revisor automatico: ${lineList(lines)} escribio "${first.keyword} ${first.name}" con mayuscula; `
      + `en C++ la palabra clave es ${first.keyword.toLowerCase()} en minuscula, por eso no compila ni cuenta su avance. `
      + "Diselo primero, en una frase, antes de las demas sugerencias.";
  },
};

/** El catalogo, en orden de prioridad: al tutor se le dice solo el primero que aplica. */
export const CODE_NOTICES: readonly CodeNoticeDefinition[] = [misspelledClassKey];

const BY_ID = new Map(CODE_NOTICES.map((notice) => [notice.id, notice]));

/** Los ids del catalogo (para el esquema del informe). */
export const CODE_NOTICE_IDS = CODE_NOTICES.map((notice) => notice.id) as [string, ...string[]];

/** Un aviso como lo manda la VM: el id del catalogo y los archivos (rutas relativas) donde lo vio. */
export type CodeNotice = { id: string; files: string[] };

export function isCodeNoticeId(id: unknown): id is string {
  return typeof id === "string" && BY_ID.has(id);
}

function cleanFiles(raw: unknown) {
  if (!Array.isArray(raw)) return [];
  return [...new Set(raw
    .filter((file): file is string => typeof file === "string")
    .map((file) => file.trim())
    .filter((file) => file && file.length <= CODE_NOTICE_FILE_CHARS && !/[\u0000-\u001f\u007f]/.test(file)))]
    .slice(0, CODE_NOTICE_FILES_MAX);
}

/**
 * Los avisos que se aceptan de un informe: solo ids del catalogo, sin repetir, a lo sumo
 * CODE_NOTICES_MAX, cada uno con a lo sumo CODE_NOTICE_FILES_MAX archivos validos. Lo demas se
 * descarta sin rechazar el informe: una VM con otra version no debe hacer perder el avance.
 */
export function sanitizeCodeNotices(raw: unknown): CodeNotice[] {
  if (!Array.isArray(raw)) return [];
  const seen = new Set<string>();
  const notices: CodeNotice[] = [];
  for (const item of raw) {
    if (!item || typeof item !== "object" || Array.isArray(item)) continue;
    const { id, files } = item as { id?: unknown; files?: unknown };
    if (!isCodeNoticeId(id) || seen.has(id)) continue;
    seen.add(id);
    notices.push({ id, files: cleanFiles(files) });
    if (notices.length >= CODE_NOTICES_MAX) break;
  }
  return notices;
}

/** Texto del aviso para el estudiante, o "" si el id ya no esta en el catalogo. */
export function studentNoticeText(notice: CodeNotice) {
  return BY_ID.get(notice.id)?.studentText(notice.files).slice(0, CODE_NOTICE_TEXT_MAX) || "";
}

/** Texto del aviso para el docente, o "" si el id ya no esta en el catalogo. */
export function teacherNoticeText(notice: CodeNotice) {
  return BY_ID.get(notice.id)?.teacherText(notice.files).slice(0, CODE_NOTICE_TEXT_MAX) || "";
}

/** La instruccion para el tutor del primer aviso del catalogo que aparece en el codigo, o "". */
export function tutorNoticeInstruction(context: CodeContext) {
  for (const notice of CODE_NOTICES) {
    const instruction = notice.tutorInstruction(context);
    if (instruction) return instruction;
  }
  return "";
}

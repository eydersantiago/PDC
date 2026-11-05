// Avisos del revisor automatico sobre el codigo del estudiante (02-11-2026, el caso de Alan).
//
// La VM de editores (deploy/gcp/workspaces/avance-ws.py --evaluar) puntua el taller con las
// reglas de C++: «Class Cliente {» con mayuscula no es una clase, asi que esa clase no cuenta y
// su avance puede salir en 0 % aunque lo demas este bien. La nota no cambia (no es C++ valido),
// pero el estudiante tiene que saberlo. La VM manda solo el id del aviso y las rutas donde lo vio;
// este catalogo es la unica fuente de los textos: lo que lee el estudiante en VS Code, lo que ve
// el docente en el monitor y la instruccion que recibe el tutor cuando encuentra lo mismo en el
// codigo que el estudiante tiene abierto.
//
// Un aviso nuevo es una entrada mas de CODE_NOTICES y una de DETECTORES en avance-ws.py: ni el
// esquema del informe, ni las vistas, ni el prompt cambian. Los ids y los topes de los dos lados
// los compara tests/services/code-notices.test.ts, y los casos de tests/fixtures/avisos-codigo.json
// los corren los dos detectores.
import type { CodeLine } from "./vscode/editor-context.js";

/** Lo que el tutor sabe del archivo abierto. */
export type CodeContext = { languageHint?: string; fileName?: string; lines: readonly CodeLine[] };

type CodeNoticeDefinition<Id extends string = string> = {
  readonly id: Id;
  /** Para el estudiante (VS Code lo muestra tal cual): a lo sumo CODE_NOTICE_TEXT_MAX. */
  studentText(paths: readonly string[]): string;
  /** Para el docente (monitor): lo mismo, contado en tercera persona. */
  teacherText(paths: readonly string[]): string;
  /** Para el tutor: una instruccion si el codigo abierto tiene el problema, o "" si no lo tiene. */
  tutorInstruction(context: CodeContext): string;
};

/** Los mismos topes que el lector de VS Code 0.0.38 (texto 160, id 40) y que avance-ws.py. */
export const CODE_NOTICE_TEXT_MAX = 160;
export const CODE_NOTICES_MAX = 5;
export const CODE_NOTICE_PATHS_MAX = 6;
export const CODE_NOTICE_FILE_PATH_MAX = 120;
/** Lineas que el tutor nombra a lo sumo en su instruccion. */
const TUTOR_LINES_MAX = 3;

/** "A", "A y B", "A, B y C". */
function joinSpanish(items: readonly string[]) {
  if (items.length <= 1) return items.join("");
  return `${items.slice(0, -1).join(", ")} y ${items[items.length - 1]}`;
}

function baseName(path: string) {
  return path.split(/[\\/]/).filter(Boolean).pop() || path;
}

/**
 * El texto con la lista de archivos mas larga que cabe en `max` («A, B y 2 más»); si ni uno cabe
 * (o no hay archivos), con `fallbackList` en lugar de la lista. Archivos por su nombre, sin repetir.
 */
export function fitFileList(paths: readonly string[], render: (list: string) => string, fallbackList: string, max = CODE_NOTICE_TEXT_MAX) {
  const names = [...new Set(paths.map(baseName).filter(Boolean))];
  for (let shown = names.length; shown >= 1; shown -= 1) {
    const rest = names.length - shown;
    const text = render(rest > 0 ? `${names.slice(0, shown).join(", ")} y ${rest} más` : joinSpanish(names));
    if (text.length <= max) return text;
  }
  return render(fallbackList).slice(0, max);
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

/**
 * Las lineas como las deja limpiar() de avance-ws.py: sin comentarios (// y /* *\/, tambien de
 * varias lineas), con los textos entre comillas vacios ("") y sin las directivas del preprocesador:
 * un # que es lo primero de la linea despues de espacios o de un comentario de bloque, con sus
 * continuaciones en \.
 */
export function stripCComments(lines: readonly CodeLine[]): CodeLine[] {
  let inBlock = false;
  let inDirective = false;
  return lines.map(({ line, text }) => {
    if (inDirective) {
      inDirective = text.endsWith("\\");
      return { line, text: "" };
    }
    let out = "";
    let index = 0;
    // Hasta ver algo que no sea espacio ni comentario, un # empieza una directiva.
    let lineStart = true;
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
      if (lineStart && char === "#") {
        inDirective = text.endsWith("\\");
        break;
      }
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
        lineStart = false;
        continue;
      }
      if (!/\s/.test(char)) lineStart = false;
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

// --- Palabra clave con mayuscula (Class, Struct) ----------------------------------------------

/**
 * La palabra clave escrita con alguna mayuscula delante del nombre de un tipo, en una linea:
 * «Class Cliente {», «CLASS Cuenta : public Base», «template<class T> Class Caja {» o la linea que
 * termina en el nombre (la llave en la siguiente). En minuscula es C++ valido y no avisa;
 * «Class::x», «int Class = 3;» y «Class X;» tampoco. Es la misma expresion, linea por linea, que
 * palabra_con_mayuscula() de avance-ws.py: los casos de tests/fixtures/avisos-codigo.json lo cuidan.
 */
function misspelledKeywordPattern(keyword: string) {
  const anyCase = [...keyword].map((char) => `[${char.toUpperCase()}${char}]`).join("");
  return new RegExp(`(?:^|[^A-Za-z0-9_])(?!${keyword}(?![A-Za-z0-9_]))(${anyCase})[ \\t]+([A-Za-z_][A-Za-z0-9_]{0,59})[ \\t]*(?:final(?![A-Za-z0-9_])[ \\t]*)?(?::(?!:)|\\{|$)`);
}

function misspelledKeywordNotice<Id extends string>(id: Id, keyword: "class" | "struct", plural: string): CodeNoticeDefinition<Id> {
  const pattern = misspelledKeywordPattern(keyword);
  const capital = keyword[0].toUpperCase() + keyword.slice(1);
  return {
    id,
    studentText: (paths) => fitFileList(
      paths,
      (list) => `Escribe ${keyword} en minúscula en ${list}: C++ no reconoce ${capital}, así que no compila y esas ${plural} no cuentan en tu avance.`,
      "tus archivos",
    ),
    teacherText: (paths) => fitFileList(
      paths,
      (list) => `Escribió ${capital} con mayúscula en ${list}: no compila y esas ${plural} no cuentan en su avance (C++ solo reconoce ${keyword}).`,
      "sus archivos",
    ),
    tutorInstruction(context) {
      if (!isCFamilySource(context)) return "";
      const numbers = new Set<number>();
      let first: { written: string; name: string } | null = null;
      for (const { line, text } of stripCComments(context.lines)) {
        const match = pattern.exec(text);
        if (!match) continue;
        first ??= { written: match[1], name: match[2] };
        if (line !== null) numbers.add(line);
      }
      if (!first) return "";
      const lines = [...numbers].sort((a, b) => a - b).slice(0, TUTOR_LINES_MAX);
      return `Aviso del revisor automatico: ${lineList(lines)} escribio "${first.written} ${first.name}" con mayuscula; `
        + `en C++ la palabra clave es ${keyword} en minuscula, por eso no compila ni cuenta su avance. `
        + "Diselo primero, en una frase, antes de las demas sugerencias.";
    },
  };
}

/** El catalogo, en orden de prioridad: al tutor se le dice solo el primero que aplica. */
export const CODE_NOTICES = [
  misspelledKeywordNotice("class-mayuscula", "class", "clases"),
  misspelledKeywordNotice("struct-mayuscula", "struct", "estructuras"),
] as const satisfies readonly CodeNoticeDefinition[];

/** Los ids del catalogo: una union ("class-mayuscula" | "struct-mayuscula"), no cualquier texto. */
export type CodeNoticeId = (typeof CODE_NOTICES)[number]["id"];

const BY_ID: ReadonlyMap<string, CodeNoticeDefinition<CodeNoticeId>> = new Map(CODE_NOTICES.map((notice) => [notice.id, notice]));

/** Los ids del catalogo, en su orden (los compara una prueba con DETECTORES de avance-ws.py). */
export const CODE_NOTICE_IDS: readonly CodeNoticeId[] = CODE_NOTICES.map((notice) => notice.id);

/** Un aviso como lo manda la VM: el id del catalogo y las rutas relativas donde lo vio. */
export type CodeNotice = { id: CodeNoticeId; paths: string[] };
/** Un aviso ya con su texto, para el docente o para el estudiante. */
export type CodeNoticeView = { id: CodeNoticeId; texto: string };

export function isCodeNoticeId(id: unknown): id is CodeNoticeId {
  return typeof id === "string" && BY_ID.has(id);
}

function cleanPaths(raw: unknown) {
  if (!Array.isArray(raw)) return [];
  return [...new Set(raw
    .filter((path): path is string => typeof path === "string")
    .map((path) => path.trim())
    .filter((path) => path && path.length <= CODE_NOTICE_FILE_PATH_MAX && !/[\u0000-\u001f\u007f]/.test(path)))]
    .slice(0, CODE_NOTICE_PATHS_MAX);
}

/**
 * Los avisos que se aceptan de un informe: solo ids del catalogo, sin repetir, a lo sumo
 * CODE_NOTICES_MAX, cada uno con a lo sumo CODE_NOTICE_PATHS_MAX rutas validas. Lo demas se
 * descarta sin rechazar el informe: una VM con otra version no debe hacer perder el avance.
 */
export function sanitizeCodeNotices(raw: unknown): CodeNotice[] {
  if (!Array.isArray(raw)) return [];
  const seen = new Set<string>();
  const notices: CodeNotice[] = [];
  for (const item of raw) {
    if (!item || typeof item !== "object" || Array.isArray(item)) continue;
    const { id, paths } = item as { id?: unknown; paths?: unknown };
    if (!isCodeNoticeId(id) || seen.has(id)) continue;
    seen.add(id);
    notices.push({ id, paths: cleanPaths(paths) });
    if (notices.length >= CODE_NOTICES_MAX) break;
  }
  return notices;
}

/** Texto del aviso para el estudiante, o "" si el id ya no esta en el catalogo. */
export function studentNoticeText(notice: CodeNotice) {
  return BY_ID.get(notice.id)?.studentText(notice.paths).slice(0, CODE_NOTICE_TEXT_MAX) || "";
}

/** Texto del aviso para el docente, o "" si el id ya no esta en el catalogo. */
export function teacherNoticeText(notice: CodeNotice) {
  return BY_ID.get(notice.id)?.teacherText(notice.paths).slice(0, CODE_NOTICE_TEXT_MAX) || "";
}

/** Los ids de los avisos que el tutor ve en el codigo, en el orden del catalogo (para las pruebas). */
export function tutorNoticeIds(context: CodeContext): CodeNoticeId[] {
  return CODE_NOTICES.filter((notice) => notice.tutorInstruction(context)).map((notice) => notice.id);
}

/** La instruccion para el tutor del primer aviso del catalogo que aparece en el codigo, o "". */
export function tutorNoticeInstruction(context: CodeContext) {
  for (const notice of CODE_NOTICES) {
    const instruction = notice.tutorInstruction(context);
    if (instruction) return instruction;
  }
  return "";
}

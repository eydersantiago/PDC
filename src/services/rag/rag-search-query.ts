// Consultas de busqueda RAG: terminos del codigo, del error y familias de lenguaje.
import type { GithubMentorContext, RagSource } from "../../types/app.js";
import { trimText, uniqueStrings } from "../shared/text-utils.js";
import { metadataString, normalizeForSearch } from "./rag-text.js";

export function buildRagSearchQuery(question: string, context: GithubMentorContext) {
  // Sin el codigo del curso ni la rama: las fuentes ya vienen filtradas por curso y esos
  // terminos solo inflaban las fuentes con "FPOO" en el titulo (revision del 21/10/2026).
  return [
    question,
    context.activityTitle,
    context.learningGoal,
    context.repoFullName,
    context.filePath,
    context.languageHint,
    ...languageQueryNames(context.languageHint),
    context.visibleError,
    context.selection,
    context.codeSnippet?.slice(0, 1200),
    codeConceptTerms(`${context.selection || ""}\n${context.codeSnippet?.slice(0, 4000) || ""}`, context.languageHint).join(" "),
  ].map((item) => trimText(item)).filter(Boolean).join("\n");
}

/**
 * Conceptos del curso que se ven en el codigo (revision de precision, 21/10/2026). El material
 * del curso habla de "herencia" o "polimorfismo", no de "class B : public A" ni de "virtual":
 * estos terminos llevan la consulta del RAG al tema que el estudiante esta trabajando.
 */
const CODE_CONCEPTS: Array<{ pattern: RegExp; terms: string[]; families?: string[] }> = [
  { pattern: /\bclass[ \t]+\w+[ \t]*(?:final[ \t]*)?:[ \t]*(?:public|protected|private)?[ \t]*[A-Za-z_]\w*/, terms: ["herencia", "clase base", "subclase"], families: ["cpp"] },
  { pattern: /\bclass[ \t]+\w+(?:<[^>\n]*>)?[ \t]+extends[ \t]+\w+/, terms: ["herencia", "subclase"] },
  { pattern: /^[ \t]*class[ \t]+\w+[ \t]*\([ \t]*[A-Za-z_]\w*/m, terms: ["herencia", "subclase"], families: ["python"] },
  { pattern: /^[ \t]*class[ \t]+\w+[ \t]*<[ \t]*[A-Z]\w*/m, terms: ["herencia", "subclase"], families: ["ruby"] },
  { pattern: /\b(?:virtual|override|abstract|implements)\b|\)[ \t]*(?:const[ \t]*)?=[ \t]*0[ \t]*;|@(?:Override|abstractmethod)\b/, terms: ["polimorfismo", "metodo virtual", "sobrescritura"] },
  { pattern: /\binterface[ \t]+\w+/, terms: ["interfaz", "polimorfismo"], families: ["java", "csharp", "javascript"] },
  { pattern: /^[ \t]*(?:private|protected)[ \t]*:|\bprivate[ \t]+\w+|\bself\.__\w+|\battr_(?:reader|accessor|writer)\b/m, terms: ["encapsulamiento", "atributo privado"] },
  { pattern: /\b(?:get|set)[A-Z]\w*[ \t]*\(|\bdef[ \t]+(?:get|set)_\w+|@property\b/, terms: ["encapsulamiento", "getter", "setter"] },
  { pattern: /\b([A-Z]\w*)[ \t]*::[ \t]*\1[ \t]*\(|^[ \t]*(?:(?:public|private|protected)[ \t]+)?(?:explicit[ \t]+)?([A-Z]\w*)[ \t]*\([^;{\n]*\)[ \t]*(?::[^{\n]*)?\{|\bdef[ \t]+__init__\b|\bdef[ \t]+initialize\b|\bconstructor[ \t]*\(/m, terms: ["constructor", "inicializacion"] },
  { pattern: /~[ \t]*[A-Z]\w*[ \t]*\(/, terms: ["destructor", "memoria"], families: ["cpp"] },
  { pattern: /\bnew[ \t]+[A-Z]\w*|\bdelete[ \t]*(?:\[[ \t]*\])?[ \t]*\w+|\bmalloc[ \t]*\(|\w+[ \t]*->[ \t]*\w+|\bnullptr\b/, terms: ["puntero", "memoria dinamica"], families: ["cpp"] },
  { pattern: /\b(?:const[ \t]+)?[A-Za-z_][\w:<>]*[ \t]*&[ \t]*[A-Za-z_]\w*[ \t]*[,)=;]/, terms: ["referencia", "paso por referencia"], families: ["cpp"] },
  { pattern: /\b(?:std::)?vector[ \t]*<|\bArrayList[ \t]*<|\bpush_back[ \t]*\(|\.append[ \t]*\(/, terms: ["vector", "coleccion", "arreglo"] },
  { pattern: /\b(?:std::)?(?:map|unordered_map|set)[ \t]*<|\bHashMap[ \t]*<|\bdict[ \t]*\(/, terms: ["coleccion", "diccionario"] },
  { pattern: /\btry[ \t]*[{:]|\bcatch[ \t]*\(|\bthrow\b|\bexcept\b|\braise\b|\brescue\b/, terms: ["excepcion", "manejo de errores"] },
  { pattern: /^[ \t]*#include[ \t]*"|^[ \t]*from[ \t]+\.\S*[ \t]+import\b|^[ \t]*require_relative[ \t]/m, terms: ["modulo", "separacion en archivos"] },
  { pattern: /\btemplate[ \t]*<|\b[A-Z]\w*<[ \t]*T[ \t]*>/, terms: ["plantilla", "programacion generica"] },
  { pattern: /\boperator[ \t]*(?:<<|>>|[-+*\/=<>!\[\]()]+)/, terms: ["sobrecarga de operadores"], families: ["cpp"] },
  { pattern: /\bstatic[ \t]+\w+/, terms: ["miembro estatico"] },
  { pattern: /\b(?:assert|EXPECT_\w+|ASSERT_\w+|unittest|pytest)\b/, terms: ["prueba", "validacion"] },
];

export function codeConceptTerms(code: string, languageHint?: string) {
  const text = String(code || "").slice(0, 12000);
  if (!text.trim()) return [];
  const family = languageFamilyForHint(languageHint);
  const terms: string[] = [];
  for (const concept of CODE_CONCEPTS) {
    if (concept.families && family && !concept.families.includes(family)) continue;
    if (concept.pattern.test(text)) terms.push(...concept.terms);
  }
  return uniqueStrings(terms);
}

/** Palabras reservadas y nombres de biblioteca que no dicen de que tema es el codigo. */
const CODE_NOISE_WORDS = new Set([
  "auto", "bool", "boolean", "break", "case", "catch", "char", "class", "const", "continue", "cout", "cin", "def",
  "default", "delete", "do", "double", "elif", "else", "end", "endl", "enum", "false", "final", "float", "for",
  "from", "function", "if", "import", "in", "include", "int", "is", "let", "long", "main", "namespace", "new",
  "nil", "none", "not", "null", "nullptr", "or", "and", "print", "printf", "println", "private", "protected",
  "public", "puts", "return", "self", "short", "signed", "size", "static", "std", "string", "struct", "switch",
  "system", "this", "throw", "true", "try", "unsigned", "using", "var", "virtual", "void", "while", "iostream",
  "vector", "override", "out", "args", "string", "len", "range", "str", "list", "dict", "max", "min",
]);

/** Identificadores del codigo partidos en palabras (calcularIMC -> calcular imc), sin ruido. */
export function codeIdentifierTerms(code: string, limit = 24) {
  const words: string[] = [];
  for (const match of String(code || "").slice(0, 8000).matchAll(/[A-Za-z_][A-Za-z0-9_]{2,}/g)) {
    const parts = match[0]
      .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
      .replace(/([A-Z]+)([A-Z][a-z])/g, "$1 $2")
      .replace(/_/g, " ")
      .toLowerCase()
      .split(/\s+/)
      .filter((part) => part.length >= 3 && !CODE_NOISE_WORDS.has(part));
    words.push(...parts);
  }
  return uniqueStrings(words).slice(0, limit);
}

/**
 * Consulta del RAG para una sugerencia del editor: el error visible, el lenguaje, los conceptos
 * que se ven en el codigo y los nombres del codigo enfocado. Sin la pregunta que arma VS Code
 * (es una instruccion de formato: "analiza la seleccion completa...") ni los rotulos del
 * contexto ("Repositorio", "Workspace", "Cursor"), que antes llenaban la consulta de palabras
 * que coinciden con cualquier fuente.
 */
/** Palabras de relleno de los mensajes del compilador (en ingles casi siempre). */
const ERROR_NOISE_WORDS = new Set([
  "error", "errors", "warning", "note", "expected", "before", "after", "was", "were", "not", "in", "of",
  "to", "is", "are", "an", "at", "on", "with", "line", "file", "token", "unexpected", "no", "did", "you",
  "mean", "here", "there", "has", "have", "be", "been", "it", "its", "or", "as", "by", "into", "cannot",
  "can", "could", "would", "will",
]);

/** El error visible sin la ruta, la linea y las palabras de relleno ("archivo.cpp:6:48: error: expected"). */
export function errorQueryTerms(visibleError: string) {
  return trimText(visibleError)
    .slice(0, 500)
    .replace(/(?:[A-Za-z]:)?[\w./\\-]+\.\w+:\d+(?::\d+)?:?/g, " ")
    .split(/[^A-Za-z0-9_+#\u00C0-\u017F]+/)
    .filter((word) => word.length >= 2 && !ERROR_NOISE_WORDS.has(word.toLowerCase()))
    .join(" ");
}

export function buildEditorRagSearchQuery(input: {
  focusCode: string;
  fileCode?: string;
  visibleError?: string;
  languageHint?: string;
  filePath?: string;
}) {
  const focus = trimText(input.focusCode).slice(0, 4000);
  const file = trimText(input.fileCode).slice(0, 12000);
  const fileName = trimText(input.filePath).split("/").pop()?.replace(/\.[A-Za-z0-9]+$/, "") || "";
  return [
    errorQueryTerms(input.visibleError || ""),
    ...languageQueryNames(input.languageHint),
    codeConceptTerms(focus || file, input.languageHint).join(" "),
    focus ? codeConceptTerms(file, input.languageHint).slice(0, 8).join(" ") : "",
    codeIdentifierTerms(focus || file, 16).join(" "),
    fileName.replace(/([a-z0-9])([A-Z])/g, "$1 $2").replace(/[_-]+/g, " "),
  ].map((item) => trimText(item)).filter(Boolean).join("\n");
}

/**
 * Familias de lenguaje que se reconocen en languageHint y en el titulo, la categoria, las
 * etiquetas o la descripcion de una fuente (texto ya normalizado con normalizeForSearch).
 */
const LANGUAGE_FAMILIES: Array<{ family: string; hints: string[]; marker: RegExp }> = [
  { family: "cpp", hints: ["cpp", "c++", "cc", "cxx", "hpp", "hh", "h", "c"], marker: /(?:^|[ +])(?:c\+\+|cpp|stl)(?= |$)/ },
  { family: "python", hints: ["python", "py"], marker: /(?:^|[ +])python(?= |$)/ },
  { family: "java", hints: ["java"], marker: /(?:^|[ +])java(?= |$)/ },
  { family: "javascript", hints: ["javascript", "js", "jsx", "typescript", "ts", "tsx", "javascriptreact", "typescriptreact"], marker: /(?:^|[ +])(?:javascript|typescript|node js|nodejs)(?= |$)/ },
  { family: "ruby", hints: ["ruby", "rb"], marker: /(?:^|[ +])ruby(?= |$)/ },
  { family: "csharp", hints: ["csharp", "cs", "c#"], marker: /(?:^|[ +])(?:c#|csharp)(?= |$)/ },
  { family: "processing", hints: ["processing", "pde"], marker: /(?:^|[ +])processing(?= |$)/ },
];

export function languageFamilyForHint(languageHint: string | undefined) {
  const clean = trimText(languageHint || "").toLowerCase().replace(/^\./, "");
  if (!clean) return "";
  return LANGUAGE_FAMILIES.find((item) => item.hints.includes(clean))?.family || "";
}

/** Nombres con los que el material del curso se refiere al lenguaje (para la consulta del RAG). */
export function languageQueryNames(languageHint: string | undefined) {
  const family = languageFamilyForHint(languageHint);
  if (family === "cpp") return ["c++", "cpp"];
  if (family === "csharp") return ["c#"];
  return family ? [family] : [];
}

export function sourceLanguageFamilies(source: RagSource) {
  const probe = normalizeForSearch([
    source.title,
    metadataString(source.metadata, "category"),
    metadataString(source.metadata, "tags"),
    metadataString(source.metadata, "description"),
    metadataString(source.metadata, "language"),
  ].join(" "));
  return LANGUAGE_FAMILIES.filter((item) => item.marker.test(probe)).map((item) => item.family);
}

export function languageAffinity(sourceFamilies: string[], fileFamily: string) {
  if (!fileFamily || !sourceFamilies.length) return 1;
  return sourceFamilies.includes(fileFamily) ? 1.15 : 0.3;
}

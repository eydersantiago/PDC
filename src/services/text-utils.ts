import type {
  GithubMentorContext,
  GithubMentorPageType,
  LearningGoalId,
  MentorPageContext,
  PolicyEventType,
} from "../types/app.js";

export const LANGUAGE_BY_EXTENSION: Record<string, string> = {
  ".js": "JavaScript",
  ".jsx": "JavaScript",
  ".ts": "TypeScript",
  ".tsx": "TypeScript",
  ".py": "Python",
  ".java": "Java",
  ".cpp": "C++",
  ".cc": "C++",
  ".cxx": "C++",
  ".c": "C",
  ".cs": "C#",
  ".go": "Go",
  ".rs": "Rust",
  ".php": "PHP",
  ".rb": "Ruby",
  ".kt": "Kotlin",
  ".swift": "Swift",
  ".sql": "SQL",
  ".html": "HTML",
  ".css": "CSS",
  ".scss": "SCSS",
  ".md": "Markdown",
};

export function trimText(value: unknown) {
  return String(value || "").trim();
}

// Ideogramas chinos, kana japonesa y hangul (y sus extensiones). qwen2.5-coder
// a veces los mete en medio de una respuesta en espanol, sobre todo cerca de
// palabras con tilde (reunion del 20/10/2026).
const FOREIGN_SCRIPT_CHARS = "\\u1100-\\u11FF\\u3040-\\u30FF\\u3400-\\u4DBF\\u4E00-\\u9FFF\\uAC00-\\uD7AF\\uF900-\\uFAFF\\u{20000}-\\u{2FFFF}";
const FOREIGN_SCRIPT_TEST = new RegExp(`[${FOREIGN_SCRIPT_CHARS}\\u3000-\\u303F\\uFF00-\\uFFEF]`, "u");
const FOREIGN_SCRIPT_RUN = new RegExp(`([ \\t]*)[${FOREIGN_SCRIPT_CHARS}]+([ \\t]*)`, "gu");
const CJK_PUNCTUATION: Record<string, string> = {
  "　": " ",
  "、": ", ",
  "。": ". ",
  "「": "\"",
  "」": "\"",
  "【": "[",
  "】": "]",
};

/**
 * Quita de una salida del modelo los caracteres chinos, japoneses y coreanos,
 * y cambia los signos de ancho completo (，：；！？（）) por los normales. No
 * toca tildes, ñ ni signos de apertura del espanol, ni la sangria del codigo.
 * Un texto sin esos caracteres sale igual.
 */
export function stripForeignScript(value: string) {
  const text = String(value ?? "");
  if (!FOREIGN_SCRIPT_TEST.test(text)) return text;
  const punctuation = text.replace(/[　-〿＀-￯]/g, (char) => {
    if (char in CJK_PUNCTUATION) return CJK_PUNCTUATION[char];
    const code = char.charCodeAt(0);
    // ！ a ～ (FF01-FF5E) son los ASCII de ancho completo.
    if (code >= 0xff01 && code <= 0xff5e) return String.fromCharCode(code - 0xfee0);
    return "";
  });
  return punctuation.replace(FOREIGN_SCRIPT_RUN, (match: string, before: string, _after: string, offset: number, whole: string) => {
    const previous = offset > 0 ? whole[offset - 1] : "\n";
    const next = whole[offset + match.length] ?? "\n";
    // Al comienzo de la linea se conserva la sangria; al final, nada.
    if (previous === "\n") return before;
    if (next === "\n" || next === "\r") return "";
    return " ";
  });
}

export function uniqueStrings(items: unknown[]) {
  const output: string[] = [];
  const seen = new Set<string>();

  for (const item of items) {
    const text = trimText(item);
    if (!text) continue;

    const key = text.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    output.push(text);
  }

  return output;
}

export function basenameSafe(value: string) {
  const parts = trimText(value).split("/").filter(Boolean);
  return parts[parts.length - 1] || "";
}

export function getPathExtension(value: string) {
  const base = basenameSafe(value);
  const index = base.lastIndexOf(".");
  if (index < 0) return "";
  return base.slice(index).toLowerCase();
}

export function inferLanguage(context: GithubMentorContext) {
  const hint = trimText(context.languageHint);
  if (hint) return hint;

  const extension = getPathExtension(trimText(context.filePath));
  return LANGUAGE_BY_EXTENSION[extension] || "General";
}

export function normalizePageType(raw: unknown): GithubMentorPageType {
  const value = trimText(raw);
  if (value === "campus") return "campus";
  if (value === "github_code") return "github_code";
  if (value === "github_general") return "github_general";
  if (value === "codespace") return "codespace";
  return "other";
}

export function normalizePageContext(raw: unknown): MentorPageContext {
  const value = trimText(raw);
  if (value === "campus") return "campus";
  if (value === "github") return "github";
  return "unknown";
}

export function normalizeLearningGoal(raw: unknown): LearningGoalId {
  const value = trimText(raw);
  if (value === "encapsulation") return "encapsulation";
  if (value === "inheritance") return "inheritance";
  if (value === "debugging") return "debugging";
  if (value === "github_flow") return "github_flow";
  return "oop_basics";
}

export function resolvePageContext(
  rawPageContext: unknown,
  rawPageType: unknown,
): MentorPageContext {
  const pageContext = normalizePageContext(rawPageContext);
  if (pageContext !== "unknown") return pageContext;

  const pageType = normalizePageType(rawPageType);
  if (pageType === "campus") return "campus";
  if (pageType === "github_code" || pageType === "github_general" || pageType === "codespace") {
    return "github";
  }

  return "unknown";
}

export function normalizeEventType(raw: unknown): PolicyEventType | null {
  const value = trimText(raw);
  if (value === "compile_error") return "compile_error";
  if (value === "runtime_error") return "runtime_error";
  if (value === "concept_question") return "concept_question";
  if (value === "design_block") return "design_block";
  if (value === "workflow_guidance") return "workflow_guidance";
  if (value === "insufficient_context") return "insufficient_context";
  if (value === "out_of_domain") return "out_of_domain";
  return null;
}

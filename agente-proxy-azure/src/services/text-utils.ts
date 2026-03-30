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

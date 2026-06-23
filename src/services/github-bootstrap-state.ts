import { trimText } from "./text-utils.js";

export function extractBootstrapDetailValue(details: string, key: string) {
  const raw = trimText(details);
  if (!raw) return "";
  const segments = raw.split("|").map((item) => trimText(item)).filter(Boolean);
  const prefix = `${key}=`.toLowerCase();
  for (const item of segments) {
    if (!item.toLowerCase().startsWith(prefix)) continue;
    return trimText(item.slice(prefix.length));
  }
  return "";
}

export function shouldTrustPersistedBootstrapState(source: string, details: string) {
  const cleanSource = trimText(source).toLowerCase();
  if (!cleanSource) return false;

  if (cleanSource === "repo_pr_detected"
    || cleanSource === "pr_created"
    || cleanSource === "repo_pr_closed_unmerged") {
    // Las PRs pueden cerrarse o borrar su rama fuera de ADACEEN.
    // Revalidamos contra GitHub antes de volver a tratarlas como bootstrap activo.
    return false;
  }

  return true;
}

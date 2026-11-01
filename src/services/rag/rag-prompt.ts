// Bloques RAG para el prompt y citas de las fuentes en la respuesta del tutor.
import { env } from "../../config/env.js";
import type { GithubMentorResult, RagContextItem } from "../../types/app.js";
import { trimText, uniqueStrings } from "../shared/text-utils.js";
import { truncate, sourceUrl } from "./rag-text.js";
import { formatRagPageRange } from "./rag-chunks.js";

/**
 * Bloque corto del material para los prompts del editor y de la pestaña: etiqueta de cita,
 * titulo y el parrafo que coincide. Sin URL, puntajes ni alcance (antes el bloque llegaba a
 * 6000 caracteres en una sola linea y casi todo era metadato). Se le dice al modelo que lo
 * ignore si no aplica: el material que no tiene que ver distrae a un modelo pequeno.
 */
export function buildCompactRagPromptBlock(
  items: RagContextItem[],
  options: { maxItems?: number; excerptChars?: number } = {},
) {
  const maxItems = Math.max(1, Math.floor(Number(options.maxItems) || 3));
  const excerptChars = Math.max(120, Math.floor(Number(options.excerptChars) || 380));
  const picked = items.slice(0, maxItems);
  if (!picked.length) return "";
  const lines = picked.map((item) => {
    const supplemental = item.metadata.knowledgeTier === "supplemental";
    const page = item.pageStart
      ? ` (p. ${item.pageEnd && item.pageEnd !== item.pageStart ? `${item.pageStart}-${item.pageEnd}` : item.pageStart})`
      : "";
    const excerpt = truncate(item.excerpt || "", excerptChars);
    return [
      `- ${item.citationLabel} ${item.title}${page}${supplemental ? " [actividad o semana del curso]" : ""}`,
      excerpt ? `  ${excerpt}` : "",
    ].filter(Boolean).join("\n");
  });
  return [
    "Material del curso recuperado para este codigo. Usalo solo si aplica; si lo usas, escribe su etiqueta exacta (por ejemplo " + picked[0].citationLabel + "). Si no aplica, no lo menciones.",
    ...lines,
  ].join("\n");
}

export function buildRagPromptBlock(items: RagContextItem[]) {
  if (!items.length) return "";

  const block = items.map((item, index) => {
    const url = item.citation.url || sourceUrl(item.metadata);
    return [
      `${index + 1}. ${item.title}`,
      `Cita obligatoria: ${item.citationLabel}`,
      `Alcance: ${item.scope}`,
      `Rol de conocimiento: ${item.metadata.knowledgeTier === "supplemental" ? "contexto suplementario de bitacora/actividad" : "RAG principal del curso"}`,
      `Tipo: ${item.sourceType}`,
      item.fileName ? `Archivo: ${item.fileName}` : "",
      item.pageStart ? `Pagina: ${item.pageEnd && item.pageEnd !== item.pageStart ? `${item.pageStart}-${item.pageEnd}` : item.pageStart}` : "",
      url ? `URL: ${url}` : "",
      item.usageReason ? `Parte usada para la sugerencia: ${item.usageReason}` : "",
      `Ranking: FTS ${item.ftsScore}; semantico ${item.semanticScore}; total ${item.score}`,
      `Extracto: ${item.excerpt || "(sin extracto)"}`,
    ].filter(Boolean).join("\n");
  }).join("\n\n");

  return truncate([
    "Fuentes recuperadas y ordenadas por compatibilidad con el archivo, la linea o la pregunta. Prioriza siempre el RAG principal del curso para conceptos, diseno y codigo; usa bitacora/actividades solo como contexto suplementario de semana, ejercicio o entrega. Toda recomendacion basada en estas fuentes debe incluir la cita obligatoria exacta y la parte usada. El modelo puede complementar la explicacion, pero debe separar la evidencia RAG del razonamiento propio.",
    block,
  ].join("\n\n"), env.ragPromptMaxChars);
}

function hasCitation(value: string, labels: string[]) {
  const text = trimText(value);
  return labels.some((label) => text.includes(label)) || /\[[^\]]+#c\d+(?:\s+p\.\d+(?:-\d+)?)?\]/.test(text);
}

function appendCitation(value: string, label: string, labels: string[]) {
  const text = trimText(value);
  if (!text || hasCitation(text, labels)) return text;
  // Si el item termina en un bloque de codigo, la cita va en otra linea para
  // no romper el cierre del bloque (```) al mostrarlo como Markdown.
  return /```\s*$/.test(text) ? `${text}\n${label}` : `${text} ${label}`;
}

function buildRagEvidenceSummary(items: RagContextItem[]) {
  return items.slice(0, 2)
    .map((item) => {
      const pageRange = formatRagPageRange(item.pageStart, item.pageEnd);
      const location = [item.citationLabel, pageRange].filter(Boolean).join(" ");
      const reason = trimText(item.usageReason)
        .replace(/^Parte usada:\s*/i, "")
        .replace(/\s+/g, " ");
      return `${item.title}: ${location}${reason ? ` (${truncate(reason, 180)})` : ""}`;
    })
    .filter(Boolean)
    .join(" | ");
}

export function ensureMentorResultRagCitations(
  result: GithubMentorResult,
  items: RagContextItem[],
): GithubMentorResult {
  if (!items.length) return result;

  const labels = uniqueStrings(items.map((item) => item.citationLabel).filter(Boolean));
  if (!labels.length) return result;
  const pickLabel = (index: number) => labels[index % Math.min(labels.length, 3)] || labels[0];
  const evidenceSummary = buildRagEvidenceSummary(items);
  const analysisSummary = evidenceSummary && !/RAG usado|parte usada|fragmento usado/i.test(result.analysis_summary)
    ? `${trimText(result.analysis_summary)} RAG usado: ${evidenceSummary}.`
    : result.analysis_summary;

  return {
    ...result,
    ideas: result.ideas.map((item, index) => appendCitation(item, pickLabel(index), labels)),
    searches: result.searches.map((item, index) => (
      /revisar|fuente|material|lectura/i.test(item)
        ? appendCitation(item, pickLabel(index), labels)
        : item
    )),
    guide: result.guide.map((item, index) => appendCitation(item, pickLabel(index), labels)),
    analysis_summary: appendCitation(analysisSummary, labels[0], labels),
  };
}

export function enrichMentorResultWithRag(
  result: GithubMentorResult,
  items: RagContextItem[],
  maxItems: number,
): GithubMentorResult {
  if (!items.length) return result;

  const top = items[0];
  const labels = items.slice(0, 3).map((item) => `${item.title} ${item.citationLabel}`).join(" | ");
  const enriched = {
    ...result,
    ideas: uniqueStrings([
      `Alinea tu avance con el material base: ${top.title}. ${top.citationLabel}`,
      ...result.ideas,
    ]).slice(0, maxItems),
    searches: uniqueStrings([
      ...result.searches,
      ...items.slice(0, 2).map((item) => `Revisar ${item.title} ${item.citationLabel}`),
    ]).slice(0, maxItems),
    guide: uniqueStrings([
      ...result.guide,
      `Contrasta el siguiente paso con la fuente RAG mas cercana: ${top.title}. ${top.citationLabel}`,
    ]).slice(0, Math.max(4, maxItems + 1)),
    analysis_summary: `${result.analysis_summary} RAG consultado: ${labels}.`,
  };

  return ensureMentorResultRagCitations(enriched, items);
}

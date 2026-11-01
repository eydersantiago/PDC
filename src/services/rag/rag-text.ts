// Texto para la busqueda RAG: normalizacion, tokens, vectores, metadatos y nivel de conocimiento de una fuente.
import type { RagSource } from "../../types/app.js";
import { trimText, uniqueStrings } from "../shared/text-utils.js";

const STOPWORDS = new Set([
  "a",
  "al",
  "ante",
  "bajo",
  "cada",
  "como",
  "con",
  "contra",
  "cual",
  "cuando",
  "de",
  "del",
  "desde",
  "donde",
  "el",
  "en",
  "entre",
  "esa",
  "ese",
  "esta",
  "este",
  "esto",
  "la",
  "las",
  "lo",
  "los",
  "mas",
  "muy",
  "o",
  "para",
  "por",
  "que",
  "se",
  "sin",
  "sobre",
  "su",
  "sus",
  "un",
  "una",
  "uno",
  "and",
  "for",
  "from",
  "that",
  "the",
  "this",
  "your",
]);

const SEMANTIC_EXPANSIONS: Record<string, string[]> = {
  abstraccion: ["abstraer", "modelo", "entidad", "responsabilidad", "clase", "diseno"],
  encapsulamiento: ["private", "privado", "atributo", "getter", "setter", "metodo", "invariante"],
  encapsul: ["private", "privado", "atributo", "getter", "setter", "metodo", "invariante"],
  herencia: ["extends", "subclase", "superclase", "clase base", "es un", "reutilizacion"],
  polimorfismo: ["virtual", "override", "sobrescritura", "interfaz", "contrato", "subtipo"],
  modularidad: ["modulo", "libreria", "header", "separacion", "responsabilidad"],
  refactor: ["mejora", "limpieza", "duplicacion", "estructura", "mantenibilidad"],
  compilacion: ["compilar", "g++", "linker", "undefined reference", "build"],
  puntero: ["referencia", "memoria", "new", "delete", "direccion"],
  clase: ["objeto", "atributo", "metodo", "responsabilidad", "constructor"],
  objeto: ["instancia", "clase", "estado", "mensaje", "metodo"],
  prueba: ["test", "assert", "validacion", "caso", "verificar"],
  github: ["commit", "rama", "pull request", "codespace", "repositorio"],
};

export function normalizeForSearch(value: string) {
  return trimText(value)
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^\p{L}\p{N}+#]+/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function stemToken(token: string) {
  return token
    .replace(/(amientos|imiento|aciones|acion|adoras|adores|adora|ador|idades|idad|mente)$/u, "")
    .replace(/(ando|iendo|ados|adas|ado|ada|icos|icas|ico|ica|es|s)$/u, "")
    .trim();
}

function rawTokens(value: string) {
  return normalizeForSearch(value)
    .split(" ")
    .map((token) => stemToken(token.trim()))
    .filter((token) => token.length >= 2 && !STOPWORDS.has(token));
}

export function tokenize(value: string) {
  return uniqueStrings(rawTokens(value)).slice(0, 100);
}

export function expandTokens(tokens: string[]) {
  const expanded = new Set(tokens);
  for (const token of tokens) {
    // Object.hasOwn: «constructor», «tostring» o «valueof» no son expansiones (antes daban la función del prototipo).
    const additions = Object.hasOwn(SEMANTIC_EXPANSIONS, token) ? SEMANTIC_EXPANSIONS[token] : [];
    for (const addition of additions) {
      for (const nested of rawTokens(addition)) {
        expanded.add(nested);
      }
    }
  }
  return [...expanded].slice(0, 160);
}

export function vectorize(value: string) {
  const vector = new Map<string, number>();
  for (const token of rawTokens(value)) {
    vector.set(token, (vector.get(token) || 0) + 1);
  }
  return vector;
}

export function vectorizeTokens(tokens: string[]) {
  const vector = new Map<string, number>();
  for (const token of tokens) {
    vector.set(token, (vector.get(token) || 0) + 1);
  }
  return vector;
}

export function cosineSimilarity(left: Map<string, number>, right: Map<string, number>) {
  let dot = 0;
  let leftNorm = 0;
  let rightNorm = 0;

  for (const value of left.values()) {
    leftNorm += value * value;
  }
  for (const value of right.values()) {
    rightNorm += value * value;
  }
  for (const [token, value] of left.entries()) {
    dot += value * (right.get(token) || 0);
  }

  if (!leftNorm || !rightNorm) return 0;
  return dot / (Math.sqrt(leftNorm) * Math.sqrt(rightNorm));
}

export function metadataString(metadata: Record<string, unknown>, key: string) {
  const value = metadata[key];
  if (value == null) return "";
  if (Array.isArray(value)) {
    return value
      .map((item) => trimText(String(item ?? "")))
      .filter(Boolean)
      .join(", ");
  }
  if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
    return trimText(String(value));
  }
  return "";
}

export function metadataToText(metadata: Record<string, unknown>) {
  const preferred = [
    "knowledge_tier",
    "knowledgeTier",
    "context_domain",
    "contextDomain",
    "description",
    "role",
    "category",
    "date",
    "week",
    "source_pdf",
    "path",
    "repoFullName",
    "courseCode",
    "original_url",
    "download_url",
    "rag_use",
    "tags",
  ]
    .map((key) => metadataString(metadata, key))
    .filter(Boolean)
    .join("\n");

  if (preferred) return preferred;

  try {
    return JSON.stringify(metadata);
  } catch {
    return "";
  }
}

export type RagKnowledgeTier = "primary" | "supplemental" | "reference";

function normalizedMetadataProbe(metadata: Record<string, unknown>, sourceType = "") {
  return [
    metadataString(metadata, "knowledge_tier"),
    metadataString(metadata, "knowledgeTier"),
    metadataString(metadata, "context_domain"),
    metadataString(metadata, "contextDomain"),
    metadataString(metadata, "rag_use"),
    metadataString(metadata, "role"),
    metadataString(metadata, "category"),
    metadataString(metadata, "source_pdf"),
    metadataString(metadata, "path"),
    metadataString(metadata, "title"),
    metadataString(metadata, "access_status"),
    sourceType,
  ].join(" ")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase();
}

export function getRagKnowledgeTier(metadata: Record<string, unknown>, sourceType = ""): RagKnowledgeTier {
  const explicit = metadataString(metadata, "knowledge_tier") || metadataString(metadata, "knowledgeTier");
  const normalizedExplicit = explicit
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase();
  if (/^(primary|principal|rag|course_rag|bibliografia|bibliography)$/.test(normalizedExplicit)) return "primary";
  if (/^(supplemental|suplementario|bitacora|actividad|agenda|course_context)$/.test(normalizedExplicit)) return "supplemental";
  if (/^(reference|referencia|omitido|omitted|reference_only)$/.test(normalizedExplicit)) return "reference";

  const probe = normalizedMetadataProbe(metadata, sourceType);
  if (/referencia editorial|libro comercial|descarga libre no verificada|reference_only|omitido|omitted/.test(probe)) {
    return "reference";
  }
  if (/\bbitacora\b|cronograma_bitacora|agenda|actividad_clase|actividad_evaluacion|semana\s+\d+/.test(probe)) {
    return "supplemental";
  }
  return "primary";
}

export function isPrimaryRagSource(source: Pick<RagSource, "metadata" | "sourceType">) {
  return getRagKnowledgeTier(source.metadata || {}, source.sourceType) === "primary";
}

export function isRetrievableRagSource(source: Pick<RagSource, "metadata" | "sourceType">, includeSupplemental = false) {
  const tier = getRagKnowledgeTier(source.metadata || {}, source.sourceType);
  if (tier === "reference") return false;
  return tier === "primary" || includeSupplemental;
}

export function sourceUrl(metadata: Record<string, unknown>) {
  return metadataString(metadata, "download_url")
    || metadataString(metadata, "downloadUrl")
    || metadataString(metadata, "original_url")
    || metadataString(metadata, "originalUrl")
    || metadataString(metadata, "url")
    || metadataString(metadata, "courseMaterialUrl");
}

export function truncate(value: string, max: number) {
  const text = trimText(value).replace(/\s+/g, " ");
  if (!text || text.length <= max) return text;
  return `${text.slice(0, Math.max(0, max - 3))}...`;
}

export function countTokens(value: string) {
  return rawTokens(value).length;
}

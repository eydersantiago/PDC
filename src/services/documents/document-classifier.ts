// Clasificador de documentos (BITACORA u OTRO): reglas por nombre y contenido, y con modelo si se pide.
import path from "node:path";
import { runTextByMode } from "../tutor/agent-mode.js";
import { trimText, uniqueStrings } from "../shared/text-utils.js";
import { compactText, normalizeDocumentText, roundConfidence, clamp01 } from "./document-text-utils.js";
import { splitBitacoraScheduleRows } from "./bitacora-agenda.js";
import { type ExtractedDocumentText, type DocumentClassifierInput, extractDocumentText } from "./document-text-extraction.js";

export type DocumentClassificationLabel = "BITACORA" | "OTRO";
export type DocumentClassificationMethod = "rules" | "hybrid";

export type DocumentClassification = {
  label: DocumentClassificationLabel;
  confidence: number;
  method: DocumentClassificationMethod;
  evidence: string[];
  reason: string;
};

export type DocumentClassificationFeatures = {
  normalizedName: string;
  normalizedTextPreview: string;
  matchedTerms: string[];
  filenameScore: number;
  contentScore: number;
  structureScore: number;
  negativeScore: number;
  textLength: number;
  extractionSource: ExtractedDocumentText["source"];
};

export type DocumentClassificationResult = {
  classification: DocumentClassification;
  extracted: ExtractedDocumentText;
  features: DocumentClassificationFeatures;
  trainingExample: {
    input: {
      fileName: string;
      filePath: string;
      textPreview: string;
    };
    expectedLabel: DocumentClassificationLabel | null;
    predictedLabel: DocumentClassificationLabel;
  };
  modelUsed: boolean;
  modelError: string;
  modelRawOutput: string;
};

type RuleEvaluation = {
  classification: DocumentClassification;
  features: DocumentClassificationFeatures;
};

const BITACORA_TERMS = [
  { pattern: /\bbitacora\b/g, label: "bitacora", weight: 0.32 },
  { pattern: /\blogbook\b/g, label: "logbook", weight: 0.32 },
  { pattern: /\bdiario\s+de\s+campo\b/g, label: "diario de campo", weight: 0.3 },
  { pattern: /\bregistro\s+de\s+actividades\b/g, label: "registro de actividades", weight: 0.3 },
  { pattern: /\bseguimiento\s+semanal\b/g, label: "seguimiento semanal", weight: 0.28 },
  { pattern: /\bregistro\s+de\s+avance(s)?\b/g, label: "registro de avance", weight: 0.28 },
  { pattern: /\binforme\s+semanal\b/g, label: "informe semanal", weight: 0.2 },
  { pattern: /\bcontrol\s+de\s+avance(s)?\b/g, label: "control de avance", weight: 0.2 },
];

const STRUCTURE_TERMS = [
  { pattern: /\bactividades\s+(realizadas|desarrolladas|ejecutadas)\b/g, label: "actividades realizadas", weight: 0.12 },
  { pattern: /\bsemana\s+fecha\s+tema\b/g, label: "tabla semanal con fechas", weight: 0.16 },
  { pattern: /\bactividades\s+(en\s+clase|evaluacion)\b/g, label: "tabla de actividades", weight: 0.12 },
  { pattern: /\bobjetivo(s)?\b/g, label: "objetivos", weight: 0.04 },
  { pattern: /\bavance(s)?\b/g, label: "avances", weight: 0.07 },
  { pattern: /\bdificultad(es)?\b/g, label: "dificultades", weight: 0.07 },
  { pattern: /\bcompromiso(s)?\b/g, label: "compromisos", weight: 0.06 },
  { pattern: /\bevidencia(s)?\b/g, label: "evidencias", weight: 0.05 },
  { pattern: /\bobservacion(es)?\b/g, label: "observaciones", weight: 0.05 },
  { pattern: /\bpendiente(s)?\b/g, label: "pendientes", weight: 0.05 },
  { pattern: /\bsemana\s+\d{1,2}\b/g, label: "semanas numeradas", weight: 0.08 },
  { pattern: /\bfecha\s*[:\-]\s*\d{1,2}\b/g, label: "fechas de registro", weight: 0.08 },
];

const NEGATIVE_TERMS = [
  /\brubrica\b/g,
  /\bsyllabus\b/g,
  /\bsilabo\b/g,
  /\bguia\s+de\s+(laboratorio|aprendizaje|trabajo)\b/g,
  /\benunciado\b/g,
  /\bparcial\b/g,
  /\bexamen\b/g,
  /\bdiapositiva(s)?\b/g,
  /\bpresentacion\b/g,
];

function scorePatterns(
  target: string,
  patterns: Array<{ pattern: RegExp; label: string; weight: number }>,
) {
  let score = 0;
  const labels: string[] = [];

  for (const item of patterns) {
    const matches = target.match(item.pattern);
    if (!matches?.length) continue;
    score += Math.min(item.weight * matches.length, item.weight * 2);
    labels.push(item.label);
  }

  return { score, labels };
}

function scoreNegativeTerms(target: string) {
  let score = 0;
  for (const pattern of NEGATIVE_TERMS) {
    const matches = target.match(pattern);
    if (matches?.length) score += Math.min(0.08 * matches.length, 0.16);
  }
  return score;
}

export function classifyDocumentByRules(params: {
  fileName?: string;
  filePath?: string;
  text?: string;
  extracted?: ExtractedDocumentText;
}): RuleEvaluation {
  const displayName = trimText(params.filePath || params.fileName);
  const normalizedName = normalizeDocumentText(displayName);
  const normalizedText = normalizeDocumentText(params.text || "");
  const textPreview = compactText(normalizedText, 900);

  const filenameSignals = scorePatterns(normalizedName, BITACORA_TERMS);
  const contentSignals = scorePatterns(normalizedText, BITACORA_TERMS);
  const structureSignals = scorePatterns(normalizedText, STRUCTURE_TERMS);
  const scheduleRows = splitBitacoraScheduleRows(params.text || "");
  const scheduleLabels = scheduleRows.length >= 4 ? ["filas semanales con fechas"] : [];
  const scheduleScore = scheduleRows.length >= 4 ? 0.18 : scheduleRows.length >= 2 ? 0.08 : 0;
  const hasBitacoraSignal = filenameSignals.labels.length > 0 || contentSignals.labels.length > 0;
  const rawNegativeScore = scoreNegativeTerms(`${normalizedName}\n${normalizedText}`);
  const negativeScore = scheduleRows.length >= 4 && hasBitacoraSignal
    ? Math.min(rawNegativeScore, 0.08)
    : rawNegativeScore;

  const filenameScore = Math.min(0.46, filenameSignals.score * 1.25);
  const contentScore = Math.min(0.5, contentSignals.score);
  const structureScore = Math.min(0.34, structureSignals.score + scheduleScore);
  const rawScore = clamp01(filenameScore + contentScore + structureScore - negativeScore);

  const matchedTerms = uniqueStrings([
    ...filenameSignals.labels,
    ...contentSignals.labels,
    ...structureSignals.labels,
    ...scheduleLabels,
  ]);

  const evidence: string[] = [];
  for (const label of uniqueStrings(filenameSignals.labels)) {
    evidence.push(`El nombre del archivo contiene "${label}".`);
  }
  for (const label of uniqueStrings(contentSignals.labels)) {
    evidence.push(`El texto extraido contiene "${label}".`);
  }
  for (const label of uniqueStrings(structureSignals.labels).slice(0, 4)) {
    evidence.push(`El texto tiene una senal de seguimiento: "${label}".`);
  }
  if (scheduleRows.length >= 4) {
    evidence.push(`El texto tiene ${scheduleRows.length} fila(s) semanales con fecha.`);
  }
  if (negativeScore > 0 && rawScore < 0.5) {
    evidence.push("Tambien aparecen senales de otro tipo de documento academico.");
  }

  const label: DocumentClassificationLabel = rawScore >= 0.55 ? "BITACORA" : "OTRO";
  const confidence = label === "BITACORA"
    ? Math.max(0.56, Math.min(0.94, rawScore))
    : Math.max(0.52, Math.min(0.92, 1 - rawScore));

  const reason = label === "BITACORA"
    ? "El documento contiene senales de seguimiento periodico de actividades o avances."
    : "No hay senales suficientes para clasificarlo como bitacora o registro de seguimiento.";

  return {
    classification: {
      label,
      confidence: roundConfidence(confidence),
      method: "rules",
      evidence: evidence.slice(0, 8),
      reason,
    },
    features: {
      normalizedName,
      normalizedTextPreview: textPreview,
      matchedTerms,
      filenameScore: roundConfidence(filenameScore),
      contentScore: roundConfidence(contentScore),
      structureScore: roundConfidence(structureScore),
      negativeScore: roundConfidence(negativeScore),
      textLength: normalizedText.length,
      extractionSource: params.extracted?.source || "provided_text",
    },
  };
}

function extractJsonObject(rawOutput: string) {
  const raw = trimText(rawOutput);
  if (!raw) return null;

  const candidates = [raw];
  const start = raw.indexOf("{");
  const end = raw.lastIndexOf("}");
  if (start >= 0 && end > start) {
    candidates.push(raw.slice(start, end + 1));
  }

  for (const candidate of candidates) {
    try {
      const parsed = JSON.parse(candidate) as Record<string, unknown>;
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) return parsed;
    } catch {}
  }

  return null;
}

function normalizeModelLabel(value: unknown): DocumentClassificationLabel | null {
  const label = normalizeDocumentText(trimText(value))
    .replace(/[_-]+/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .toUpperCase();
  if (label === "BITACORA") return "BITACORA";
  if (label === "OTRO" || label === "NO BITACORA") return "OTRO";
  return null;
}

function parseModelClassification(rawOutput: string): DocumentClassification | null {
  const parsed = extractJsonObject(rawOutput);
  if (!parsed) return null;

  const label = normalizeModelLabel(parsed.label);
  if (!label) return null;

  const confidence = clamp01(Number(parsed.confidence));
  const rawEvidence = Array.isArray(parsed.evidence) ? parsed.evidence : [];
  const evidence = rawEvidence
    .map((item) => compactText(String(item || ""), 180))
    .filter(Boolean)
    .slice(0, 6);

  return {
    label,
    confidence: roundConfidence(confidence || 0.65),
    method: "hybrid",
    evidence,
    reason: compactText(String(parsed.reason || ""), 360)
      || (label === "BITACORA"
        ? "El modelo local confirmo senales de bitacora."
        : "El modelo local no encontro senales suficientes de bitacora."),
  };
}

function buildClassificationPrompt(params: {
  fileName: string;
  filePath: string;
  extracted: ExtractedDocumentText;
  rules: DocumentClassification;
}) {
  const text = compactText(params.extracted.text, 9000);
  return [
    "Eres un clasificador documental academico para ADACEEN/PDC.",
    "Decide si el documento es una bitacora academica o similar.",
    "Incluye como BITACORA: bitacora, diario de campo, registro de actividades, seguimiento semanal, logbook, registro de avance o control periodico de avances.",
    "No incluyas como BITACORA: rubricas, guias, parciales, diapositivas, silabos, enunciados o material de lectura sin seguimiento periodico.",
    "El campo label debe ser exactamente \"BITACORA\" o exactamente \"OTRO\".",
    "No uses \"BITACORA|OTRO\", listas, markdown ni texto adicional fuera del JSON.",
    "Responde SOLO JSON valido con este formato exacto:",
    "{\"label\":\"BITACORA\",\"confidence\":0.0,\"evidence\":[\"...\"],\"reason\":\"...\"}",
    "",
    `fileName: ${params.fileName || "(sin nombre)"}`,
    `filePath: ${params.filePath || "(sin ruta)"}`,
    `extractionSource: ${params.extracted.source}`,
    `rulesLabel: ${params.rules.label}`,
    `rulesConfidence: ${params.rules.confidence}`,
    `rulesEvidence: ${params.rules.evidence.join(" | ") || "(sin evidencia)"}`,
    "",
    "Texto extraido:",
    text || "(sin texto extraido)",
  ].join("\n");
}

function mergeRuleAndModel(rule: DocumentClassification, model: DocumentClassification) {
  const sameLabel = rule.label === model.label;
  const evidence = uniqueStrings([
    ...rule.evidence,
    ...model.evidence.map((item) => `LLM local: ${item}`),
  ]).slice(0, 8);

  if (sameLabel) {
    return {
      label: rule.label,
      confidence: roundConfidence(Math.max(rule.confidence, (rule.confidence + model.confidence) / 2)),
      method: "hybrid" as const,
      evidence,
      reason: model.reason || rule.reason,
    };
  }

  if (rule.label === "BITACORA" && rule.confidence >= 0.78) {
    return {
      label: "BITACORA" as const,
      confidence: roundConfidence(Math.max(0.62, rule.confidence * 0.9)),
      method: "hybrid" as const,
      evidence: uniqueStrings([...evidence, "Las reglas locales tienen evidencia fuerte aunque el modelo discrepo."]).slice(0, 8),
      reason: rule.reason,
    };
  }

  if (model.label === "BITACORA" && model.confidence >= 0.68) {
    return {
      label: "BITACORA" as const,
      confidence: roundConfidence(Math.max(model.confidence * 0.95, rule.confidence)),
      method: "hybrid" as const,
      evidence,
      reason: model.reason,
    };
  }

  return {
    label: "OTRO" as const,
    confidence: roundConfidence(Math.max(0.55, model.label === "OTRO" ? model.confidence : rule.confidence)),
    method: "hybrid" as const,
    evidence,
    reason: model.label === "OTRO" ? model.reason : rule.reason,
  };
}

export async function classifyDocument(input: DocumentClassifierInput): Promise<DocumentClassificationResult> {
  const fileName = trimText(input.fileName || path.basename(trimText(input.filePath)));
  const filePath = trimText(input.filePath);
  const extracted = await extractDocumentText(input);
  const ruleEvaluation = classifyDocumentByRules({
    fileName,
    filePath,
    text: extracted.text,
    extracted,
  });

  let classification = ruleEvaluation.classification;
  let modelUsed = false;
  let modelError = "";
  let modelRawOutput = "";

  const shouldUseModel = input.useModel !== false
    && extracted.text.length > 0
    && (classification.label === "BITACORA" || classification.confidence < 0.82);

  if (shouldUseModel) {
    try {
      const prompt = buildClassificationPrompt({
        fileName,
        filePath,
        extracted,
        rules: classification,
      });
      modelRawOutput = await runTextByMode(prompt, { route: "document-classifier" }, { profile: "json_strict" });
      const modelClassification = parseModelClassification(modelRawOutput);
      if (modelClassification) {
        classification = mergeRuleAndModel(classification, modelClassification);
        modelUsed = true;
      } else {
        modelError = "El modelo local no devolvio JSON valido.";
      }
    } catch (error) {
      modelError = trimText(String(error));
    }
  }

  return {
    classification,
    extracted,
    features: {
      ...ruleEvaluation.features,
      extractionSource: extracted.source,
    },
    trainingExample: {
      input: {
        fileName,
        filePath,
        textPreview: compactText(extracted.text, 1600),
      },
      expectedLabel: null,
      predictedLabel: classification.label,
    },
    modelUsed,
    modelError,
    modelRawOutput,
  };
}

import {
  Agent,
  Runner,
  setTracingDisabled,
  tool,
  withTrace,
} from "@openai/agents";
import { OpenAIChatCompletionsModel } from "@openai/agents-openai";
import OpenAI from "openai";
import { z } from "zod";
import {
  createDiagnosticLogger,
  durationMs,
  errorSummary,
  shortId,
  textStats,
  urlSummary,
} from "./src/services/diagnostics.js";
import type { AgentRunDiagnostics } from "./src/services/service-bus-agent.js";

type SuggestTabParams = {
  tabContent: string;
  question?: string;
  tabTitle?: string;
  tabUrl?: string;
  maxTabContentChars?: number;
  diagnostics?: AgentRunDiagnostics;
};

type LinkItem = {
  text: string;
  href: string;
};

function buildOpenAiCompatibleBaseUrl() {
  const explicit = process.env.OPENAI_BASE?.trim();
  if (explicit) return explicit;

  const ollamaBase = process.env.OLLAMA_BASE_URL?.trim();
  if (ollamaBase) {
    const clean = ollamaBase.replace(/\/+$/g, "");
    return clean.endsWith("/v1") ? clean : `${clean}/v1`;
  }

  return "http://127.0.0.1:11434/v1";
}

const baseURL = buildOpenAiCompatibleBaseUrl();
const apiKey = process.env.OPENAI_API_KEY || "dummy";
const modelId = process.env.MODEL_TEXT || process.env.OLLAMA_MODEL || "qwen2.5-coder:7b";
const tracingDisabled = apiKey === "dummy"
  || baseURL.includes("127.0.0.1")
  || baseURL.includes("localhost");
if (tracingDisabled) setTracingDisabled(true);

function runMaybeTraced<T>(name: string, work: () => Promise<T>) {
  return tracingDisabled ? work() : withTrace(name, work);
}

const client = new OpenAI({ apiKey, baseURL });
const chatModel = new OpenAIChatCompletionsModel(client, modelId);
const suggestLog = createDiagnosticLogger("run-suggest-tab", {
  modelId,
  baseURL,
  tracingDisabled,
});

const responseSchema = z.object({
  resumen: z.array(z.string().min(1)).min(1).max(5),
  sugerencias: z.array(z.string().min(1)).min(3).max(5),
  accion: z.enum(["insert", "replace", "delete"]),
  riesgos: z.array(z.string().min(1)).min(2).max(4),
  enlaces_relevantes: z.array(z.string().min(1)).max(5).optional(),
});

function normalizeText(value: string) {
  return value.replace(/\u00a0/g, " ").replace(/\s+/g, " ").trim();
}

function parseVisibleLinks(tabContent: string, maxLinks = 50): LinkItem[] {
  const blockMatch = tabContent.match(/Enlaces visibles\s*\(\d+\):\s*([\s\S]*)$/i);
  if (!blockMatch) return [];

  const lines = blockMatch[1]
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);

  const links: LinkItem[] = [];
  const seen = new Set<string>();

  for (const line of lines) {
    const cleaned = line.replace(/^\d+\.\s*/, "").trim();
    const arrowIdx = cleaned.lastIndexOf(" -> ");
    if (arrowIdx < 0) continue;

    const text = normalizeText(cleaned.slice(0, arrowIdx));
    const href = cleaned.slice(arrowIdx + 4).trim();
    if (!href) continue;

    const key = `${text.toLowerCase()}|${href}`;
    if (seen.has(key)) continue;
    seen.add(key);

    links.push({ text: text || "(sin texto)", href });
    if (links.length >= maxLinks) break;
  }

  return links;
}

function tokenize(value: string) {
  return normalizeText(value)
    .toLowerCase()
    .split(/[^a-z0-9áéíóúüñ]+/i)
    .map((token) => token.trim())
    .filter((token) => token.length >= 3);
}

function scoreLink(link: LinkItem, questionTokens: string[]) {
  const text = normalizeText(link.text).toLowerCase();
  const href = link.href.toLowerCase();

  let score = 0;
  const reasons: string[] = [];
  for (const token of questionTokens) {
    if (text.includes(token)) {
      score += 5;
      reasons.push(`coincide en texto: "${token}"`);
    } else if (href.includes(token)) {
      score += 3;
      reasons.push(`coincide en URL: "${token}"`);
    }
  }

  if (/nota|calific|taller|parcial|proyecto/.test(text)) {
    score += 2;
    reasons.push("parece recurso de notas/calificaciones");
  }

  return { score, reasons };
}

const extractLinksTool = tool({
  name: "extract_visible_links",
  description: "Extrae enlaces visibles desde el bloque de contenido de la pestaña.",
  parameters: z.object({
    tabContent: z.string().min(1),
    maxLinks: z.number().int().min(1).max(100).optional(),
  }),
  execute: async ({ tabContent, maxLinks }) => {
    const links = parseVisibleLinks(tabContent, maxLinks ?? 30);
    return { count: links.length, links };
  },
});

const rankLinksTool = tool({
  name: "rank_links_for_question",
  description: "Prioriza enlaces según su relevancia respecto a la pregunta del usuario.",
  parameters: z.object({
    question: z.string().min(1),
    tabContent: z.string().min(1),
    maxResults: z.number().int().min(1).max(20).optional(),
  }),
  execute: async ({ question, tabContent, maxResults }) => {
    const links = parseVisibleLinks(tabContent, 100);
    const qTokens = tokenize(question);

    const ranked = links
      .map((link) => {
        const rank = scoreLink(link, qTokens);
        return {
          ...link,
          score: rank.score,
          reason: rank.reasons.slice(0, 2).join("; ") || "sin coincidencias directas",
        };
      })
      .filter((item) => item.score > 0)
      .sort((a, b) => b.score - a.score)
      .slice(0, maxResults ?? 8);

    return {
      totalLinks: links.length,
      questionTokens: qTokens.slice(0, 15),
      relevantLinks: ranked,
    };
  },
});

const detectCoverageTool = tool({
  name: "detect_question_coverage",
  description:
    "Evalua si el contenido visible alcanza para responder la pregunta o si falta abrir un enlace.",
  parameters: z.object({
    question: z.string().min(1),
    tabContent: z.string().min(1),
  }),
  execute: async ({ question, tabContent }) => {
    const normalizedQuestion = normalizeText(question).toLowerCase();
    const asksCount = /cu[aá]nt|cantidad|total|promedio|porcentaje/.test(normalizedQuestion);
    const asksGrades = /nota|calific|taller|parcial|proyecto|estudiante/.test(normalizedQuestion);
    const links = parseVisibleLinks(tabContent, 60);
    const hasNumbers = /\b\d+([.,]\d+)?\b/.test(tabContent);

    const likelyNeedsOpenLink = asksGrades && asksCount && !hasNumbers;
    const recommendation = likelyNeedsOpenLink
      ? "La pregunta requiere datos que no aparecen en texto visible. Hay que abrir un enlace de notas."
      : "Con el contenido visible podria ser posible responder, dependiendo de la precision requerida.";

    return {
      asksCount,
      asksGrades,
      hasNumbers,
      visibleLinks: links.length,
      likelyNeedsOpenLink,
      recommendation,
    };
  },
});

const shortInputGuardrail = {
  name: "min_context_length",
  execute: async ({ input }: { input: string | unknown[] }) => {
    const asText = typeof input === "string" ? input : JSON.stringify(input);
    const tooShort = asText.trim().length < 120;
    return {
      tripwireTriggered: tooShort,
      outputInfo: tooShort
        ? "Contenido insuficiente para sugerir acciones concretas."
        : "Input con contexto suficiente.",
    };
  },
};

const markdownFormatGuardrail = {
  name: "markdown_1_2_3_sections",
  execute: async ({ agentOutput }: { agentOutput: unknown }) => {
    const parsed = responseSchema.safeParse(agentOutput);
    if (parsed.success) {
      return {
        tripwireTriggered: false,
        outputInfo: "Formato estructurado correcto.",
      };
    }

    const text = String(agentOutput || "");
    const hasAllSections =
      /(^|\n)\s*1\)/.test(text) && /(^|\n)\s*2\)/.test(text) && /(^|\n)\s*3\)/.test(text);
    const hasAction =
      /\bAplicar\s*:\s*(insert|replace|delete|insertar|modificar|eliminar)\b/i.test(text)
      || /\bAcci[oó]n\s*:\s*(insert|replace|delete|insertar|modificar|eliminar)\b/i.test(text);

    return {
      tripwireTriggered: !hasAllSections || !hasAction,
      outputInfo: hasAllSections && hasAction
        ? "Formato correcto."
        : "Formato incorrecto: faltan secciones o linea Aplicar: insert/replace/delete.",
    };
  },
};

const linkSpecialistAgent = new Agent({
  name: "Especialista de Enlaces",
  handoffDescription: "Especialista en identificar enlaces relevantes en una pagina.",
  instructions: [
    "Tu foco es priorizar enlaces visibles respecto a la pregunta del usuario.",
    "Usa herramientas para extraer y ranquear enlaces.",
    "Responde en texto corto con los enlaces mas utiles y por que.",
    "Si no hay enlaces suficientes, dilo explicitamente.",
  ].join("\n"),
  model: chatModel,
  tools: [extractLinksTool, rankLinksTool],
  modelSettings: { store: false, temperature: 0 },
});

const linkSpecialistAsTool = linkSpecialistAgent.asTool({
  toolName: "analyze_visible_links",
  toolDescription:
    "Analiza enlaces visibles y sugiere cuales abrir primero para resolver la pregunta del usuario.",
});

const responseAgent = Agent.create({
  name: "Asistente de Pestana",
  instructions: [
    "Analiza el contenido de la pestaña actual y responde en JSON estricto.",
    "Campos requeridos:",
    '- "resumen": 1 a 5 bullets cortos.',
    '- "sugerencias": 3 a 5 acciones concretas.',
    '- "accion": exactamente "insert", "replace" o "delete". Usa "delete" solo si la mejor ayuda es eliminar codigo; usa "replace" solo si hay codigo concreto y seguro para modificar el bloque enfocado; usa "insert" para agregar comentario, pista o codigo nuevo.',
    '- "riesgos": 2 a 4 dudas/riesgos.',
    '- "enlaces_relevantes": opcional, hasta 5 items.',
    "Siempre que sea util, usa herramientas para revisar cobertura y enlaces visibles.",
    "Si no puedes confirmar datos, dilo de forma explicita y no inventes.",
  ].join("\n"),
  handoffs: [linkSpecialistAgent],
  model: chatModel,
  tools: [extractLinksTool, rankLinksTool, detectCoverageTool, linkSpecialistAsTool],
  inputGuardrails: [shortInputGuardrail],
  outputGuardrails: [markdownFormatGuardrail],
  outputType: responseSchema,
  modelSettings: { store: false, temperature: 0.2 },
});

const triageAgent = Agent.create({
  name: "Coordinador de Analisis",
  instructions: [
    "Eres un coordinador de analisis de pestañas.",
    "Si la pregunta depende de un recurso enlazado (ej: notas/taller), puedes delegar al especialista.",
    "Luego entrega respuesta final en formato Markdown con resumen, sugerencias, accion y riesgos.",
  ].join("\n"),
  handoffs: [responseAgent, linkSpecialistAgent],
  model: chatModel,
  modelSettings: { store: false, temperature: 0.1 },
});

const suggestRunner = new Runner({
  workflowName: "suggest-tab-advanced",
  traceMetadata: { component: "suggest-tab" },
});

function buildSuggestInput(params: {
  question: string;
  tabTitle: string;
  tabUrl: string;
  tabContent: string;
}) {
  return [
    `Titulo: ${params.tabTitle || "(sin titulo)"}`,
    `URL: ${params.tabUrl || "(sin URL)"}`,
    `Pregunta del usuario: ${params.question}`,
    "",
    "Contenido de la pestaña:",
    params.tabContent,
  ].join("\n");
}

function toMarkdownOutput(value: unknown) {
  const parsed = responseSchema.safeParse(value);
  if (!parsed.success) return String(value ?? "").trim();

  const data = parsed.data;
  const lines: string[] = [];
  lines.push("1) Resumen");
  for (const item of data.resumen) lines.push(`- ${item}`);
  lines.push("");
  lines.push("2) Sugerencias");
  for (const item of data.sugerencias) lines.push(`- ${item}`);
  lines.push("");
  lines.push("3) Accion");
  lines.push(`- Aplicar: ${data.accion}`);
  lines.push("");
  lines.push("4) Dudas o riesgos");
  for (const item of data.riesgos) lines.push(`- ${item}`);
  if (Array.isArray(data.enlaces_relevantes) && data.enlaces_relevantes.length > 0) {
    lines.push("");
    lines.push("Enlaces relevantes detectados:");
    for (const item of data.enlaces_relevantes) lines.push(`- ${item}`);
  }
  return lines.join("\n").trim();
}

export async function runSuggestTab(params: SuggestTabParams) {
  return runMaybeTraced("suggest-tab-run", async () => {
    const startedAt = Date.now();
    const question = params.question?.trim() || "Dame sugerencias basicas sobre este contenido.";
    const tabTitle = params.tabTitle?.trim() || "(sin titulo)";
    const tabUrl = params.tabUrl?.trim() || "(sin URL)";
    const maxChars = Math.max(1, params.maxTabContentChars ?? 12000);
    const safeContent = String(params.tabContent || "").slice(0, maxChars).trim();
    const logger = suggestLog.child({
      requestId: shortId(params.diagnostics?.requestId, 64),
      route: params.diagnostics?.route || "",
      scope: params.diagnostics?.scope || "",
    });
    logger.info("suggest.model.start", {
      question: textStats(question),
      tabTitle: textStats(tabTitle),
      tabUrl: urlSummary(tabUrl),
      content: textStats(safeContent),
      maxChars,
      visibleLinks: parseVisibleLinks(safeContent).length,
    });

    try {
      if (!safeContent) throw new Error("tabContent vacio");

      const input = buildSuggestInput({
        question,
        tabTitle,
        tabUrl,
        tabContent: safeContent,
      });

      const result = await suggestRunner.run(triageAgent, input, {
        maxTurns: 12,
        context: { question, tabTitle, tabUrl },
      });

      const out = toMarkdownOutput(result.finalOutput);
      if (!out) throw new Error("Salida vacia en runSuggestTab");
      logger.info("suggest.model.done", {
        durationMs: durationMs(startedAt),
        output: textStats(out),
      });
      return out;
    } catch (error) {
      logger.error("suggest.model.failed", {
        durationMs: durationMs(startedAt),
        error: errorSummary(error),
      });
      throw error;
    }
  });
}

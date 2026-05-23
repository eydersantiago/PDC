import { Agent, AgentInputItem, Runner, withTrace } from "@openai/agents";
import { OpenAIChatCompletionsModel } from "@openai/agents-openai";
import OpenAI from "openai";

const baseURL = process.env.OPENAI_BASE || "http://127.0.0.1:11434/v1";
const apiKey  = process.env.OPENAI_API_KEY || "dummy";
const modelId = process.env.MODEL_TEXT || "qwen2.5:7b-instruct";

const client = new OpenAI({ apiKey, baseURL });
const chatModel = new OpenAIChatCompletionsModel(client, modelId);

const textAgent = new Agent({
  name: "Copiloto de Aprendizaje (Texto/Código)",
  instructions: [
    "Eres un asistente para estudiantes de Ingeniería de Sistemas.",
    "Si el input parece CÓDIGO, explica: Qué hace, Complejidad temporal, Riesgos, Mejores prácticas y un ejemplo mínimo.",
    "Responde SIEMPRE en Markdown con el formato:",
    "1) Resumen (≤5 líneas)",
    "2) 3–5 recomendaciones",
    "3) Riesgos/dudas",
    "No inventes datos."
  ].join("\n"),
  model: chatModel,
  modelSettings: { store: false },
});

export async function runText(input: string) {
  return withTrace("text-run", async () => {
    const looksCode = /```|class\s+\w+|def\s+\w+|\bfunction\b|\bfor\s*\(|\bimport\b/g.test(input);
    const nudge = looksCode
      ? "ANÁLISIS DE CÓDIGO solicitado. Sé preciso y técnico."
      : "ANÁLISIS DE TEXTO solicitado. Sé claro y conciso.";
    const history: AgentInputItem[] = [
      { role: "user", content: [{ type: "input_text", text: `${nudge}\n\n${input}` }] }
    ];
    const res = await new Runner().run(textAgent, history);
    if (!res.finalOutput) throw new Error("Sin salida del agente");
    return res.finalOutput;
  });
}

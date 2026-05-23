import { Agent, AgentInputItem, Runner, withTrace } from "@openai/agents";
import { OpenAIChatCompletionsModel } from "@openai/agents-openai";
import OpenAI from "openai";

const baseURL = process.env.OPENAI_BASE || "http://127.0.0.1:11434/v1";
const apiKey  = process.env.OPENAI_API_KEY || "dummy";
const modelId = process.env.MODEL_TEXT || "qwen2.5:7b-instruct";

const client = new OpenAI({ apiKey, baseURL });
const chatModel = new OpenAIChatCompletionsModel(client, modelId);

const myAgent = new Agent({
  name: "Copiloto de Aprendizaje (Local)",
  instructions: [
    "Eres un asistente para estudiantes de Ingeniería de Sistemas.",
    "Responde en Markdown con el formato:",
    "1) Resumen (≤5 líneas)",
    "2) 3–5 recomendaciones",
    "3) Riesgos/dudas",
    "No inventes datos; si no sabes, dilo."
  ].join("\n"),
  model: chatModel,
  modelSettings: { store: false },
});

export async function runTextAgent(input_as_text: string) {
  return await withTrace("agent-workflow", async () => {
    const looksCode = /```|;\s*$|class\s+\w+|def\s+\w+|\bfunction\b|\bfor\s*\(|\bimport\b/g.test(input_as_text);
    const systemNudge = looksCode
      ? "Si es código, explica: Qué hace, Complejidad, Riesgos, Mejores prácticas, Ejemplo mínimo."
      : "";
    const finalPrompt = systemNudge ? `${systemNudge}\n\n${input_as_text}` : input_as_text;

    const history: AgentInputItem[] = [
      { role: "user", content: [{ type: "input_text", text: finalPrompt }] }
    ];
    const runner = new Runner({ traceMetadata: { src: "agent-node-local" } });
    const res = await runner.run(myAgent, history);
    if (!res.finalOutput) throw new Error("Agent result is undefined");
    return res.finalOutput;
  });
}

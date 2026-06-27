process.env.AGENT_TARGET = "local";
process.env.OLLAMA_BASE_URL ||= "http://127.0.0.1:11434";
process.env.OPENAI_BASE ||= `${process.env.OLLAMA_BASE_URL.replace(/\/+$/g, "")}/v1`;
process.env.OPENAI_API_KEY ||= "dummy";
process.env.OLLAMA_MODEL ||= "qwen2.5-coder:7b";
process.env.MODEL_TEXT ||= process.env.OLLAMA_MODEL;

await import("../server.js");

import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const LOCAL_OLLAMA_HOSTS = new Set(["127.0.0.1", "localhost", "::1"]);

function stripQuotes(value) {
  const trimmed = value.trim();
  if (
    (trimmed.startsWith('"') && trimmed.endsWith('"')) ||
    (trimmed.startsWith("'") && trimmed.endsWith("'"))
  ) {
    return trimmed.slice(1, -1);
  }
  return trimmed;
}

function loadEnvFile(filePath) {
  if (!existsSync(filePath)) return;

  for (const line of readFileSync(filePath, "utf8").split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;

    const separator = trimmed.indexOf("=");
    if (separator <= 0) continue;

    const key = trimmed.slice(0, separator).trim();
    const value = stripQuotes(trimmed.slice(separator + 1));
    if (key && process.env[key] === undefined) {
      process.env[key] = value;
    }
  }
}

function normalizeLocalOllamaUrl(value) {
  const baseUrl = value.trim().replace(/\/+$/, "");
  const parsed = new URL(baseUrl);
  const hostname = parsed.hostname.replace(/^\[|\]$/g, "");

  if (!LOCAL_OLLAMA_HOSTS.has(hostname)) {
    throw new Error(
      "OLLAMA_BASE_URL debe apuntar a localhost/127.0.0.1. No expongas Ollama publicamente.",
    );
  }

  return baseUrl;
}

async function fetchJson(url, options = {}, timeoutMs = 120_000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const response = await fetch(url, {
      ...options,
      signal: controller.signal,
    });
    const text = await response.text();

    if (!response.ok) {
      throw new Error(`HTTP ${response.status}: ${text.slice(0, 1000)}`);
    }

    return text ? JSON.parse(text) : {};
  } catch (error) {
    if (controller.signal.aborted) {
      throw new Error(`Timeout despues de ${timeoutMs} ms llamando a ${url}.`);
    }
    throw error;
  } finally {
    clearTimeout(timer);
  }
}

const rootDir = path.resolve(fileURLToPath(new URL("..", import.meta.url)));
loadEnvFile(path.join(rootDir, ".env.worker"));

const args = new Map(
  process.argv
    .slice(2)
    .filter((arg) => arg.startsWith("--"))
    .map((arg) => {
      const [key, value = ""] = arg.slice(2).split("=");
      return [key, value];
    }),
);

function pickModel(route) {
  if (args.get("model")) return args.get("model").trim();
  if (process.env.OLLAMA_TEST_MODEL) return process.env.OLLAMA_TEST_MODEL.trim();

  if (route === "fast") {
    return (process.env.OLLAMA_FAST_MODEL || process.env.OLLAMA_MODEL || "qwen3-coder:30b").trim();
  }

  if (route === "classifier") {
    return (process.env.OLLAMA_CLASSIFIER_MODEL || process.env.OLLAMA_FAST_MODEL || process.env.OLLAMA_MODEL || "qwen3-coder:30b").trim();
  }

  if (route === "experimental") {
    return (process.env.OLLAMA_EXPERIMENTAL_MODEL || "").trim();
  }

  return (process.env.OLLAMA_MODEL || "qwen3-coder:30b").trim();
}

const baseUrl = normalizeLocalOllamaUrl(
  process.env.OLLAMA_BASE_URL || process.env.OLLAMA_URL || "http://127.0.0.1:11434",
);
const route = (args.get("route") || process.env.OLLAMA_TEST_ROUTE || "primary").trim();
const model = pickModel(route);
const timeoutMs = Number(process.env.OLLAMA_TEST_TIMEOUT_MS || process.env.OLLAMA_TIMEOUT_MS || 120_000);

console.log(`[test:ollama] Endpoint local: ${baseUrl}`);
console.log(`[test:ollama] Ruta: ${route}`);
console.log(`[test:ollama] Modelo: ${model}`);

if (!model) {
  throw new Error(`No hay modelo configurado para la ruta ${route}.`);
}

const tags = await fetchJson(`${baseUrl}/api/tags`, {}, timeoutMs);
const models = Array.isArray(tags.models) ? tags.models.map((item) => item.name).filter(Boolean) : [];

if (!models.includes(model)) {
  throw new Error(
    `El modelo ${model} no esta instalado localmente. Modelos disponibles: ${models.join(", ") || "(ninguno)"}. Ejecuta: ollama pull ${model}`,
  );
}

const result = await fetchJson(
  `${baseUrl}/api/generate`,
  {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      model,
      prompt: "Responde exactamente: ADACEEN Ollama local OK",
      stream: false,
      options: {
        temperature: 0,
        num_predict: 24,
      },
    }),
  },
  timeoutMs,
);

const responseText = typeof result.response === "string" ? result.response.trim() : "";
if (!responseText) {
  throw new Error(`Ollama respondio sin texto: ${JSON.stringify(result).slice(0, 1000)}`);
}

console.log(`[test:ollama] Respuesta: ${responseText}`);
console.log("[test:ollama] Inferencia local confirmada.");

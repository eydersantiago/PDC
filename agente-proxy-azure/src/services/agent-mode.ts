import fsp from "node:fs/promises";
import path from "node:path";
import { runImage } from "../../runImage.js";
import { runText } from "../../runText.js";
import { env, isAzureMode } from "../config/env.js";

type UploadedImage = {
  path: string;
  mimetype?: string;
  originalname?: string;
};

async function parseJsonResponse(response: Response, label: string) {
  const bodyText = await response.text();
  if (!response.ok) {
    throw new Error(`${label} HTTP ${response.status}: ${bodyText}`);
  }

  try {
    return JSON.parse(bodyText) as { output_text?: unknown };
  } catch {
    throw new Error(`${label} devolvio una respuesta no JSON`);
  }
}

export async function runTextByMode(input: string) {
  if (!isAzureMode()) {
    return runText(input);
  }

  if (!env.azureServer) {
    throw new Error("Falta AZURE_SERVER_URL para AGENT_TARGET=azure");
  }

  const response = await fetch(`${env.azureServer}/run-text`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ input_as_text: input }),
  });

  const data = await parseJsonResponse(response, "Azure /run-text");
  return String(data.output_text ?? "");
}

export async function runImageByMode(file: UploadedImage, prompt: string) {
  if (!isAzureMode()) {
    return runImage(file.path, prompt);
  }

  if (!env.azureServer) {
    throw new Error("Falta AZURE_SERVER_URL para AGENT_TARGET=azure");
  }

  const image = await fsp.readFile(file.path);
  const form = new FormData();
  form.set(
    "image",
    new Blob([image], { type: file.mimetype || "application/octet-stream" }),
    file.originalname || path.basename(file.path),
  );
  form.set("prompt", prompt);

  const response = await fetch(`${env.azureServer}/run-image`, {
    method: "POST",
    body: form,
  });

  const data = await parseJsonResponse(response, "Azure /run-image");
  return String(data.output_text ?? "");
}

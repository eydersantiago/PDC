// Texto de los documentos: normalizar, recortar, confianza y extension del archivo.
import path from "node:path";
import { trimText } from "../shared/text-utils.js";

export function clamp01(value: number) {
  if (!Number.isFinite(value)) return 0;
  return Math.max(0, Math.min(1, value));
}

export function roundConfidence(value: number) {
  return Math.round(clamp01(value) * 100) / 100;
}

export function normalizeDocumentText(value: string) {
  return trimText(value)
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/\u00a0/g, " ")
    .replace(/[^\S\r\n]+/g, " ")
    .replace(/\n{3,}/g, "\n\n")
    .toLowerCase();
}

export function compactText(value: string, max = 600) {
  const text = trimText(value).replace(/\s+/g, " ");
  if (!text) return "";
  return text.length <= max ? text : `${text.slice(0, Math.max(0, max - 3))}...`;
}

export function normalizeExtension(value: unknown) {
  return trimText(value).replace(/^\./, "").toLowerCase();
}

export function inferExtensionFromName(value: string) {
  return normalizeExtension(path.extname(trimText(value)));
}

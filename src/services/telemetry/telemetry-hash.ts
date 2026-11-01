// Telemetria: seudonimos (HMAC con TELEMETRY_SALT) y hashes de textos, sin datos en claro.
import { createHash, createHmac } from "node:crypto";
import { env } from "../../config/env.js";

const DEV_SALT = "adaceen-sal-de-desarrollo-no-usar-en-produccion";

let warnedAboutSalt = false;

function telemetrySalt() {
  if (env.telemetrySalt) return env.telemetrySalt;
  if (!warnedAboutSalt) {
    warnedAboutSalt = true;
    console.warn("[telemetria] TELEMETRY_SALT no esta configurada: se usa una sal de desarrollo. Configurala en produccion.");
  }
  return DEV_SALT;
}

/** HMAC-SHA256 recortado a 20 hex (80 bits): estable y no reversible sin la sal. */
export function pseudonymize(value: string) {
  const clean = String(value || "").trim();
  if (!clean) return "";
  return createHmac("sha256", telemetrySalt()).update(clean).digest("hex").slice(0, 20);
}

/**
 * Normaliza un mensaje de error para que el mismo error de dos estudiantes
 * (u otra linea, u otra ruta) produzca el mismo hash.
 */
export function normalizeErrorText(text: unknown) {
  return String(text || "")
    .toLowerCase()
    .replace(/\r?\n/g, " ")
    .replace(/[a-z]:\\[^\s:'"]*/g, "<ruta>")
    .replace(/(?:\.{0,2}\/)?(?:[\w.-]+\/)+[\w.-]+/g, "<ruta>")
    .replace(/"[^"]*"|'[^']*'|`[^`]*`|‘[^’]*’/g, "'_'")
    .replace(/0x[0-9a-f]+/g, "#")
    .replace(/\d+/g, "#")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 500);
}

/** SHA-256 recortado a 16 hex; vacio si no hay texto. */
export function hashText(text: unknown) {
  const clean = String(text || "").trim();
  if (!clean) return "";
  return createHash("sha256").update(clean).digest("hex").slice(0, 16);
}

export function hashErrorText(text: unknown) {
  return hashText(normalizeErrorText(text));
}

export function exerciseHash(exerciseKey: unknown) {
  const clean = String(exerciseKey || "").trim().toLowerCase();
  return clean ? pseudonymize(`exercise:${clean}`) : "";
}

export function fileExtension(filePath: unknown) {
  const base = String(filePath || "").split(/[\\/]/).pop() || "";
  const match = base.match(/(\.[A-Za-z0-9+#_-]{1,10})$/);
  return match ? match[1].toLowerCase() : "";
}

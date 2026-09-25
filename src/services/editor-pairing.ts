// Emparejar VS Code sin copiar/pegar la sesion (docs/arquitectura/acceso-simplificado.md, seccion 2).
//
// El overlay pide un codigo de un solo uso (XXXX-XXXX, 10 min) y VS Code lo
// canjea por una sesion editor. Solo se guarda el SHA-256 del codigo
// normalizado; el codigo nunca va a la base ni a los logs.
import { createHash, randomInt } from "node:crypto";
import type express from "express";
import { trimText } from "./text-utils.js";

// Sin I, L, O, 0 ni 1: no se confunden al dictarlos o copiarlos a mano.
export const PAIRING_CODE_ALPHABET = "ABCDEFGHJKMNPQRSTUVWXYZ23456789";
export const PAIRING_CODE_LENGTH = 8;
export const PAIRING_CODE_TTL_SECONDS = 600;

const NORMALIZED_CODE_RE = new RegExp(`^[${PAIRING_CODE_ALPHABET}]{${PAIRING_CODE_LENGTH}}$`);

/** Codigo nuevo en dos grupos de cuatro: "K7P4-M2QX". */
export function generatePairingCode() {
  let raw = "";
  for (let index = 0; index < PAIRING_CODE_LENGTH; index += 1) {
    raw += PAIRING_CODE_ALPHABET[randomInt(PAIRING_CODE_ALPHABET.length)];
  }
  return `${raw.slice(0, 4)}-${raw.slice(4)}`;
}

/** Mayusculas, sin guion ni espacios; "" si no tiene el formato de un codigo. */
export function normalizePairingCode(value: unknown) {
  const normalized = trimText(typeof value === "string" ? value : "").toUpperCase().replace(/[\s-]+/g, "");
  return NORMALIZED_CODE_RE.test(normalized) ? normalized : "";
}

export function hashPairingCode(normalizedCode: string) {
  return createHash("sha256").update(normalizedCode).digest("hex");
}

export type RateLimiterOptions = {
  limit?: number;
  windowMs?: number;
  now?: () => number;
  maxKeys?: number;
};

/**
 * Limitador en memoria por clave (IP) con ventana deslizante. Cuenta los
 * intentos fallidos: un laboratorio entero sale por la misma IP y los canjes
 * buenos no deben gastar el cupo de los demas. Vive en memoria, como el
 * registro de latidos: supone una sola instancia del App Service.
 */
export function createAttemptLimiter(options: RateLimiterOptions = {}) {
  const limit = options.limit ?? 20;
  const windowMs = options.windowMs ?? 60_000;
  const now = options.now || Date.now;
  const maxKeys = options.maxKeys ?? 5000;
  const attempts = new Map<string, number[]>();

  function recent(key: string) {
    const since = now() - windowMs;
    const list = (attempts.get(key) || []).filter((at) => at > since);
    if (list.length) attempts.set(key, list);
    else attempts.delete(key);
    return list;
  }

  function prune() {
    if (attempts.size < maxKeys) return;
    for (const key of [...attempts.keys()]) recent(key);
    if (attempts.size >= maxKeys) attempts.clear();
  }

  return {
    /** true si la clave ya gasto su cupo en la ventana. */
    isBlocked(key: string) {
      return recent(key).length >= limit;
    },
    recordFailure(key: string) {
      prune();
      const list = recent(key);
      list.push(now());
      attempts.set(key, list);
    },
    reset() {
      attempts.clear();
    },
  };
}

export type AttemptLimiter = ReturnType<typeof createAttemptLimiter>;

/**
 * IP del cliente para el limitador. En App Service el front end agrega la IP
 * real al final de X-Forwarded-For (con puerto); se toma la ultima entrada,
 * que el cliente no puede falsificar.
 */
export function clientIpForLimiter(req: express.Request) {
  const forwarded = String(req.header("x-forwarded-for") || "")
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
  const last = forwarded.at(-1) || "";
  const withoutPort = last.startsWith("[")
    ? last.slice(1, last.indexOf("]") > 0 ? last.indexOf("]") : undefined)
    : /^\d{1,3}(\.\d{1,3}){3}:\d+$/.test(last) ? last.replace(/:\d+$/, "") : last;
  return withoutPort || req.socket?.remoteAddress || "desconocida";
}

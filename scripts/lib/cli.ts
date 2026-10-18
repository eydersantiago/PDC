import fsp from "node:fs/promises";
import path from "node:path";
import type { Server } from "node:http";
import { Pool } from "pg";
import { env } from "../../src/config/env.js";

/**
 * Utilidades comunes de los scripts de operacion y evidencias del piloto
 * (demo de escenarios, latencia, estabilidad y telemetria).
 */

export function readArg(name: string, fallback = "", argv = process.argv) {
  const prefix = `--${name}=`;
  const found = argv.find((item) => item.startsWith(prefix));
  return found ? found.slice(prefix.length) : fallback;
}

export function hasFlag(name: string, argv = process.argv) {
  return argv.includes(`--${name}`);
}

export function readIntArg(name: string, fallback: number, min: number, max: number) {
  const raw = readArg(name, "");
  if (!raw.trim()) return fallback;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(max, Math.max(min, Math.round(parsed)));
}

/** Una respuesta JSON con su codigo HTTP (0 = sin respuesta) y cuantos intentos costo. */
export type JsonReading<T> = { status: number; data: T; ms: number; attempts: number };

/**
 * GET de JSON que reintenta una vez cuando no hubo respuesta: red cortada, conexion
 * reiniciada o mas de timeoutMs sin contestar. Un codigo HTTP (503, 401, 500...) si es
 * una respuesta del backend y no se reintenta. Lo usa el monitor del piloto: desde
 * Cloud Shell, una peticion suelta que se pierde ya no se vuelve una alerta.
 * Sin respuesta en ningun intento: status 0 y data.error con el motivo.
 */
export async function getJsonWithRetry<T>(
  url: string,
  headers: Record<string, string>,
  options: { attempts?: number; timeoutMs?: number; retryDelayMs?: number; fetchImpl?: typeof fetch } = {},
): Promise<JsonReading<T>> {
  const fetchImpl = options.fetchImpl ?? fetch;
  const attempts = Math.max(1, Math.round(options.attempts ?? 2));
  const timeoutMs = options.timeoutMs ?? 20_000;
  const retryDelayMs = options.retryDelayMs ?? 1_500;
  const startedAt = Date.now();
  let reason = "";
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      const response = await fetchImpl(url, { headers, signal: AbortSignal.timeout(timeoutMs) });
      const data = await response.json().catch(() => ({})) as T;
      return { status: response.status, data, ms: Date.now() - startedAt, attempts: attempt };
    } catch (error) {
      const code = (error as { cause?: { code?: unknown } })?.cause?.code;
      reason = typeof code === "string" && code ? `${String(error)} (${code})` : String(error);
      if (attempt < attempts && retryDelayMs > 0) await new Promise((resolve) => setTimeout(resolve, retryDelayMs));
    }
  }
  return { status: 0, data: { error: reason } as T, ms: Date.now() - startedAt, attempts };
}

/** Percentil por el metodo del rango mas cercano (p en 0..100). */
export function percentile(values: number[], p: number) {
  const sorted = values.filter((value) => Number.isFinite(value)).sort((a, b) => a - b);
  if (!sorted.length) return null;
  const rank = Math.ceil((p / 100) * sorted.length);
  return sorted[Math.min(sorted.length - 1, Math.max(0, rank - 1))];
}

export function describeLatencies(values: number[]) {
  const clean = values.filter((value) => Number.isFinite(value));
  return {
    n: clean.length,
    p50: percentile(clean, 50),
    p95: percentile(clean, 95),
    max: clean.length ? Math.max(...clean) : null,
    mean: clean.length ? Math.round(clean.reduce((sum, value) => sum + value, 0) / clean.length) : null,
  };
}

export async function writeTextFile(filePath: string, content: string) {
  const absolute = path.resolve(process.cwd(), filePath);
  await fsp.mkdir(path.dirname(absolute), { recursive: true });
  await fsp.writeFile(absolute, content, "utf8");
  return absolute;
}

export function nowStamp(date = new Date()) {
  return date.toISOString().slice(0, 16).replace(/[:T]/g, "-");
}

/**
 * Levanta el backend en este proceso con una base PostgreSQL en memoria
 * (usuarios y politica demo). Nunca toca la base configurada en .env.
 */
export async function startInProcessBackend() {
  env.databaseUrl = "";
  const { createDatabase } = await import("../../src/db/database.js");
  const { createApp } = await import("../../src/app.js");
  const database = await createDatabase();
  const app = createApp(database);
  const server = await new Promise<Server>((resolve) => {
    const started = app.listen(0, () => resolve(started));
  });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("No se pudo iniciar el backend en memoria.");
  return {
    baseUrl: `http://127.0.0.1:${address.port}`,
    database,
    close: async () => {
      await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
      await database.close();
    },
  };
}

/**
 * Inicia una sesion de consola (sessionKind "cli"): solo reemplaza las
 * sesiones cli anteriores, asi el script no cierra la sesion del navegador
 * ni la de VS Code de esa cuenta.
 */
export async function login(baseUrl: string, email: string, password: string) {
  const response = await fetch(`${baseUrl.replace(/\/+$/, "")}/api/auth/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json; charset=utf-8" },
    body: JSON.stringify({ email, password, sessionKind: "cli" }),
  });
  const data = await response.json().catch(() => ({})) as { session?: { id?: string }; error?: string };
  if (!response.ok || !data.session?.id) {
    throw new Error(`No se pudo iniciar sesion como ${email}: ${data.error || response.status}`);
  }
  return String(data.session.id);
}

/**
 * Conexion de solo lectura/borrado a la base del piloto (DATABASE_URL).
 * No ejecuta migraciones ni semillas: para eso esta el backend.
 */
export function openDatabasePool() {
  if (!env.databaseUrl) {
    throw new Error("Falta DATABASE_URL (en .env o en el entorno). Este script trabaja sobre la base del piloto.");
  }
  return new Pool({
    connectionString: env.databaseUrl,
    ssl: env.databaseSslMode === "require" ? { rejectUnauthorized: false } : undefined,
  });
}

export function fail(message: string): never {
  console.error(`\n[error] ${message}`);
  process.exit(1);
}

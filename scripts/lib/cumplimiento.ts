import { execFileSync } from "node:child_process";
import fsp from "node:fs/promises";
import path from "node:path";
import type { ComplianceCheckResult } from "../../src/services/compliance-checklist.js";
import { EXPORT_COLUMNS } from "../../src/services/telemetry.js";
import { FIELD_DICTIONARY } from "../../src/services/telemetry-catalog.js";

/** Comprobaciones automaticas de la lista de cumplimiento (A13.4); ver scripts/piloto-verificar.ts. */

const DEMO_ACCOUNTS = [
  ["admin@adaceen.edu.co", "Admin123!"],
  ["docente@adaceen.edu.co", "Docente123!"],
  ["estudiante@adaceen.edu.co", "Estudiante123!"],
];
const FREE_TEXT_FIELD = /(^|_)(text|texto|message|mensaje|code|codigo|snippet|path|ruta|email|correo|name|nombre)$/;

async function readText(relative: string) {
  return fsp.readFile(path.resolve(process.cwd(), relative), "utf8").catch(() => "");
}

export async function staticChecks(): Promise<Record<string, ComplianceCheckResult>> {
  const results: Record<string, ComplianceCheckResult> = {};
  const telemetrySource = await readText("src/services/telemetry.ts");
  const whitelist = telemetrySource.match(/const METADATA_WHITELIST = new Set\(\[([\s\S]*?)\]\);/)?.[1] || "";
  const keys = [...whitelist.matchAll(/"([^"]+)"/g)].map((match) => match[1]);
  const textKeys = keys.filter((key) => FREE_TEXT_FIELD.test(key.replace(/([a-z])([A-Z])/g, "$1_$2").toLowerCase()));
  // Codigos cortos (curso, motivo) y value_text recortado a 120 caracteres: no son texto libre.
  const SAFE_COLUMNS = ["value_text", "course_code", "reason_code"];
  const textColumns = FIELD_DICTIONARY.filter((entry) => FREE_TEXT_FIELD.test(entry.field) && !SAFE_COLUMNS.includes(entry.field));
  const valueText = FIELD_DICTIONARY.find((entry) => entry.field === "value_text");
  results.C03 = {
    id: "C03",
    status: keys.length && !textKeys.length && !textColumns.length && /120/.test(valueText?.description || "") ? "cumple" : "no cumple",
    detail: `Lista blanca de metadata con ${keys.length} claves${textKeys.length ? `; claves de texto: ${textKeys.join(", ")}` : ", ninguna de texto libre"}; columnas de texto: ${textColumns.map((entry) => entry.field).join(", ") || "ninguna"} (value_text recortado a 120 caracteres, sin texto libre de los clientes).`,
  };
  const identifiers = EXPORT_COLUMNS.filter((column) => /^(user_id|student_user_id|email|correo|display_name|nombre)$/.test(column));
  results.C04 = {
    id: "C04",
    status: identifiers.length ? "no cumple" : "cumple",
    detail: identifiers.length ? `Columnas con identificadores: ${identifiers.join(", ")}` : `${EXPORT_COLUMNS.length} columnas exportadas, ninguna es un identificador directo (el actor va como actor_anon_id).`,
  };
  const purge = await fsp.stat(path.resolve(process.cwd(), "scripts/purgar-telemetria.ts")).then(() => true).catch(() => false);
  const envExample = await readText(".env.example");
  results.C06 = {
    id: "C06",
    status: purge && /TELEMETRY_RETENTION_DAYS=\d+/.test(envExample) ? "cumple" : "no cumple",
    detail: `scripts/purgar-telemetria.ts ${purge ? "existe" : "no existe"}; .env.example ${/TELEMETRY_RETENTION_DAYS=\d+/.test(envExample) ? "documenta" : "no documenta"} TELEMETRY_RETENTION_DAYS.`,
  };
  const manifest = JSON.parse(await readText("browser-ext-prod/manifest.json") || "{}") as { permissions?: string[]; host_permissions?: string[] };
  const permissions = manifest.permissions || [];
  const hosts = manifest.host_permissions || [];
  const broad = hosts.filter((host) => host === "<all_urls>" || /localhost|127\.0\.0\.1|^\*:\/\/\*\//.test(host) || /\*\.azurewebsites\.net/.test(host));
  results.C09 = {
    id: "C09",
    status: !permissions.includes("tabs") && !broad.length ? "cumple" : "no cumple",
    detail: `permissions: ${permissions.join(", ") || "—"}; hosts amplios o locales: ${broad.join(", ") || "ninguno"}.`,
  };
  let trackedEnv: string[] = [];
  try {
    trackedEnv = execFileSync("git", ["ls-files", ".env", ".env.local", ".env.production"], { encoding: "utf8" }).split("\n").filter(Boolean);
  } catch {
    trackedEnv = [];
  }
  const gitignore = await readText(".gitignore");
  const ignoresEnv = /^\.env$/m.test(gitignore);
  const ignoresExports = /^exportes\/$/m.test(gitignore);
  results.C17 = {
    id: "C17",
    status: !trackedEnv.length && ignoresEnv && ignoresExports ? "cumple" : "no cumple",
    detail: `Archivos .env versionados: ${trackedEnv.join(", ") || "ninguno"}; .gitignore ${ignoresEnv ? "ignora" : "NO ignora"} .env y ${ignoresExports ? "ignora" : "NO ignora"} exportes/.`,
  };
  return results;
}

export async function backendChecks(baseUrl: string): Promise<Record<string, ComplianceCheckResult>> {
  const results: Record<string, ComplianceCheckResult> = {};
  const health = await fetch(`${baseUrl}/api/health`).then((response) => response.json()).catch(() => null) as Record<string, unknown> | null;
  if (!health) {
    for (const id of ["C02", "C06", "C10", "C19", "C21"]) results[id] = { id, status: "no verificado", detail: `No se pudo leer ${baseUrl}/api/health.` };
    return results;
  }
  results.C02 = { id: "C02", status: health.telemetry_salt_configured === true ? "cumple" : "no cumple", detail: `telemetry_salt_configured = ${String(health.telemetry_salt_configured)}` };
  results.C19 = { id: "C19", status: health.worker_heartbeat_configured === true ? "cumple" : "no cumple", detail: `worker_heartbeat_configured = ${String(health.worker_heartbeat_configured)}` };
  results.C21 = { id: "C21", status: health.database_provider === "postgres" ? "cumple" : "no cumple", detail: `database_provider = ${String(health.database_provider)}` };
  const policy = await fetch(`${baseUrl}/api/privacy-policy`).then((response) => response.ok).catch(() => false);
  results.C10 = {
    id: "C10",
    status: policy && typeof health.privacy_policy_version === "string" ? "cumple" : "no cumple",
    detail: `/api/privacy-policy ${policy ? "responde" : "no responde"}; version ${String(health.privacy_policy_version || "sin dato")}.`,
  };
  results.C18 = { id: "C18", status: baseUrl.startsWith("https://") ? "cumple" : "no cumple", detail: `URL del backend: ${baseUrl}` };
  const demoLogins: string[] = [];
  for (const [email, password] of DEMO_ACCOUNTS) {
    const response = await fetch(`${baseUrl}/api/auth/login`, {
      method: "POST",
      headers: { "Content-Type": "application/json; charset=utf-8" },
      // Sesion de consola: la comprobacion no cierra la sesion del navegador de esa cuenta.
      body: JSON.stringify({ email, password, sessionKind: "cli" }),
    }).catch(() => null);
    if (response?.ok) demoLogins.push(email);
  }
  results.C20 = {
    id: "C20",
    status: demoLogins.length ? "no cumple" : "cumple",
    detail: demoLogins.length ? `Entran con la clave del repositorio: ${demoLogins.join(", ")}` : "Ninguna cuenta demo entra con la clave del repositorio.",
  };
  return results;
}

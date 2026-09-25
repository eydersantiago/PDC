import { execFileSync } from "node:child_process";
import fsp from "node:fs/promises";
import path from "node:path";
import type { ComplianceCheckResult } from "../../src/services/compliance-checklist.js";
import { EXPORT_COLUMNS } from "../../src/services/telemetry.js";
import { FIELD_DICTIONARY } from "../../src/services/telemetry-catalog.js";
import { readArg } from "./cli.js";

/** Comprobaciones automaticas de la lista de cumplimiento (A13.4); ver scripts/piloto-verificar.ts. */

export const DEMO_ACCOUNTS: ReadonlyArray<readonly [string, string]> = [
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
  const pairing = await pairingCodeStorage();
  results.C25 = {
    id: "C25",
    status: pairing.ok ? "cumple" : "no cumple",
    detail: `${pairing.detail} El solo uso se comprueba contra el backend con --url, --email y --password.`,
  };
  return results;
}

/**
 * C25 en el codigo: editor_pairing_codes solo tiene el hash y la ruta guarda
 * hashPairingCode(normalizePairingCode(codigo)).
 */
async function pairingCodeStorage() {
  const schema = await readText("src/db/schema.ts");
  const routes = await readText("src/routes/editor-auth-routes.ts");
  const pairing = await readText("src/services/editor-pairing.ts");
  const table = schema.match(/create table if not exists editor_pairing_codes \(([\s\S]*?)\);/)?.[1] || "";
  const columns = table.split(",").map((line) => line.trim().split(/\s+/)[0]).filter(Boolean);
  const plain = columns.filter((column) => column !== "code_hash" && /code/.test(column));
  const hashed = /codeHash:\s*hashPairingCode\(normalizePairingCode\(/.test(routes)
    && /createHash\("sha256"\)/.test(pairing);
  const ok = columns.includes("code_hash") && !plain.length && hashed;
  return {
    ok,
    detail: table
      ? `editor_pairing_codes tiene ${columns.join(", ")}${plain.length ? `; columnas con el código: ${plain.join(", ")}` : ", sin columna con el código"}; la ruta ${hashed ? "guarda el SHA-256 del código normalizado" : "NO guarda solo el hash"}.`
      : "No se encontró la tabla editor_pairing_codes en src/db/schema.ts.",
  };
}

export type BackendCheckOptions = {
  /**
   * Cuenta para C24 y C25 (crea y revoca una sesion de VS Code). Por defecto
   * --email y --password de la linea de comandos; null para no usarla.
   */
  credentials?: { email: string; password: string } | null;
};

type HttpResult = { status: number; data: Record<string, unknown>; sessionHeader: string };

async function call(baseUrl: string, method: string, route: string, sessionId: string, body?: unknown): Promise<HttpResult> {
  const response = await fetch(`${baseUrl}${route}`, {
    method,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      ...(sessionId ? { "x-session-id": sessionId } : {}),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const data = await response.json().catch(() => ({})) as Record<string, unknown>;
  return { status: response.status, data, sessionHeader: response.headers.get("x-adaceen-session") || "" };
}

/** Dias maximos de una sesion editor: lo que promete el consentimiento (docs/piloto/consentimiento.md). */
const EDITOR_SESSION_MAX_DAYS = 30;

/**
 * C24 y C25 contra el backend: sesion de navegador -> codigo -> canje (sesion
 * editor) -> segundo canje (debe fallar) -> /api/auth/me de la sesion editor
 * (vence en 30 dias o menos) -> logout del navegador -> la sesion editor ya no
 * vale (401 y x-adaceen-session: invalid). Ni la sesion ni el codigo se
 * muestran.
 */
export async function editorSessionChecks(baseUrl: string, credentials: { email: string; password: string }): Promise<Record<string, ComplianceCheckResult>> {
  // Sin poder probar el canje, C25 se queda con la revision del codigo (staticChecks).
  const pending = (detail: string): Record<string, ComplianceCheckResult> => ({
    C24: { id: "C24", status: "no verificado", detail },
  });
  const failing = (detail: string): Record<string, ComplianceCheckResult> => ({
    C24: { id: "C24", status: "no cumple", detail },
    C25: { id: "C25", status: "no cumple", detail },
  });
  try {
    const login = await call(baseUrl, "POST", "/api/auth/login", "", { email: credentials.email, password: credentials.password });
    const browserSession = String((login.data.session as { id?: string } | undefined)?.id || "");
    if (login.status !== 200 || !browserSession) return pending(`No se pudo iniciar sesión con la cuenta indicada (HTTP ${login.status}).`);

    const code = await call(baseUrl, "POST", "/api/auth/editor/pairing-code", browserSession, {});
    if (code.status === 404) {
      await call(baseUrl, "POST", "/api/auth/logout", browserSession, {});
      return failing("El backend no tiene POST /api/auth/editor/pairing-code (versión anterior al acceso simplificado).");
    }
    const pairingCode = String(code.data.code || "");
    if (code.status !== 200 || !pairingCode) {
      await call(baseUrl, "POST", "/api/auth/logout", browserSession, {});
      return pending(`POST /api/auth/editor/pairing-code respondió HTTP ${code.status}${code.data.code && code.status !== 200 ? ` (${String(code.data.code)})` : ""}.`);
    }

    const claim = await call(baseUrl, "POST", "/api/auth/editor/claim", "", { code: pairingCode, label: "verificacion" });
    const editorSession = String(claim.data.sessionId || "");
    const again = await call(baseUrl, "POST", "/api/auth/editor/claim", "", { code: pairingCode, label: "verificacion" });
    const oneUse = again.status === 404 && again.data.error === "code_not_found";

    const me = editorSession ? await call(baseUrl, "GET", "/api/auth/me", editorSession) : null;
    const session = (me?.data.session || {}) as { kind?: string; expiresAt?: string | null };
    const expiresMs = session.expiresAt ? Date.parse(session.expiresAt) : Number.NaN;
    const days = Number.isFinite(expiresMs) ? (expiresMs - Date.now()) / 86_400_000 : null;
    const expiresOk = me?.status === 200 && session.kind === "editor" && days !== null && days > 0 && days <= EDITOR_SESSION_MAX_DAYS + 0.01;

    await call(baseUrl, "POST", "/api/auth/logout", browserSession, {});
    const after = editorSession ? await call(baseUrl, "GET", "/api/auth/me", editorSession) : null;
    const revoked = after?.status === 401 && after.sessionHeader === "invalid";

    const storage = await pairingCodeStorage();
    const daysText = days === null ? "sin vencimiento" : `vence en ${days.toFixed(1).replace(".", ",")} días`;
    return {
      C24: {
        id: "C24",
        status: claim.status === 200 && expiresOk && revoked ? "cumple" : "no cumple",
        detail: claim.status !== 200
          ? `El canje del código respondió HTTP ${claim.status}.`
          : `Sesión de VS Code de tipo ${session.kind || "sin dato"}: ${daysText} (máximo ${EDITOR_SESSION_MAX_DAYS}). Tras «Salir» en el navegador, GET /api/auth/me con esa sesión responde HTTP ${after?.status ?? "sin dato"}${after?.sessionHeader ? ` con x-adaceen-session: ${after.sessionHeader}` : " sin x-adaceen-session"}.`,
      },
      C25: {
        id: "C25",
        status: claim.status === 200 && oneUse && storage.ok ? "cumple" : "no cumple",
        detail: `Primer canje: HTTP ${claim.status}; segundo canje del mismo código: HTTP ${again.status}${again.data.error ? ` (${String(again.data.error)})` : ""}. En el código: ${storage.detail}`,
      },
    };
  } catch (error) {
    return pending(`No se pudo comprobar: ${error instanceof Error ? error.message : String(error)}.`);
  }
}

export async function backendChecks(baseUrl: string, options: BackendCheckOptions = {}): Promise<Record<string, ComplianceCheckResult>> {
  const results: Record<string, ComplianceCheckResult> = {};
  const argEmail = readArg("email");
  const argPassword = readArg("password");
  const credentials = options.credentials !== undefined
    ? options.credentials
    : argEmail && argPassword ? { email: argEmail, password: argPassword } : null;
  const health = await fetch(`${baseUrl}/api/health`).then((response) => response.json()).catch(() => null) as Record<string, unknown> | null;
  const httpsCheck: ComplianceCheckResult = { id: "C18", status: baseUrl.startsWith("https://") ? "cumple" : "no cumple", detail: `URL del backend: ${baseUrl}` };
  if (!health) {
    // Sin backend no se intenta nada más: C20 daría «cumple» porque ningún inicio de sesión responde.
    const unreachable = `No se pudo leer ${baseUrl}/api/health: el backend no respondió, no se intentó.`;
    for (const id of ["C02", "C06", "C10", "C19", "C20", "C21", "C24"]) results[id] = { id, status: "no verificado", detail: unreachable };
    results.C18 = httpsCheck;
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
  results.C18 = httpsCheck;
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
  if (credentials) {
    Object.assign(results, await editorSessionChecks(baseUrl, credentials));
  } else {
    results.C24 = { id: "C24", status: "no verificado", detail: "Necesita --email y --password de una cuenta de prueba (crea una sesión de VS Code y la revoca)." };
  }
  return results;
}

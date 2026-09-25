import fsp from "node:fs/promises";
import path from "node:path";
import {
  COMPLIANCE_ITEMS,
  complianceScore,
  type ComplianceCheckResult,
} from "../../src/services/compliance-checklist.js";
import { login, nowStamp } from "./cli.js";
import { backendChecks, staticChecks } from "./cumplimiento.js";

/**
 * Evidencias de despliegue en un comando (A15.6 · ADACEEN-127, A15.4 ·
 * ADACEEN-125). Junta lo que docs/operacion/evidencias-despliegue.md pedia
 * sacar a mano con curl: /api/health, /api/agent/backend, /api/agent/health,
 * /empezar y /descargas/*, la version publicada y, con credenciales de
 * docente, el estado del piloto y la verificacion de cumplimiento.
 *
 * No cambia configuracion: hace GET y HEAD, y ademas dos inicios de sesion.
 * Con credenciales, el del docente, de consola (sessionKind "cli"): reemplaza
 * las otras sesiones de consola de esa cuenta (piloto:monitor vuelve a entrar
 * solo), pero no la del navegador ni la de VS Code. Contra un backend anterior
 * a la tanda «acceso simplificado» no se hace: ese backend ignora sessionKind y
 * su login cierra todas las sesiones de la cuenta. La verificacion de
 * cumplimiento (C20) prueba ademas el login de las cuentas demo.
 * Todo lo que se escribe pasa por redactSecrets: nada que parezca un token,
 * una clave o un id de sesion llega al Markdown ni al JSON.
 */

export const REDACTED = "[redactado]";

// ---------------------------------------------------------------- argumentos

/**
 * readArg de cli.ts solo entiende --nombre=valor. Esto convierte
 * "--backend https://..." en "--backend=https://..." para las opciones con
 * valor, asi las dos formas funcionan con readArg y readIntArg.
 */
export function normalizeArgs(argv: string[], valueOptions: string[]) {
  const result: string[] = [];
  for (let index = 0; index < argv.length; index += 1) {
    const item = argv[index];
    const name = item.startsWith("--") && !item.includes("=") ? item.slice(2) : "";
    const next = argv[index + 1];
    if (name && valueOptions.includes(name) && next !== undefined && !next.startsWith("--")) {
      result.push(`--${name}=${next}`);
      index += 1;
      continue;
    }
    result.push(item);
  }
  return result;
}

/** URL del backend sin barra final; vacio si no es http(s). */
export function cleanBackendUrl(raw: string) {
  const text = raw.trim().replace(/\/+$/, "");
  if (!text) return "";
  try {
    const parsed = new URL(text);
    if (parsed.protocol !== "https:" && parsed.protocol !== "http:") return "";
    if (parsed.username || parsed.password || parsed.search || parsed.hash) return "";
    return text;
  } catch {
    return "";
  }
}

// ---------------------------------------------------------------- redaccion

/** Claves cuyo valor de texto nunca se escribe. */
const SENSITIVE_KEY = /(token|secret|password|passwd|contrasena|clave|api[-_]?key|access[-_]?key|private[-_]?key|authorization|cookie|session[-_]?id|signature|connection[-_]?string|credential|(^|[-_])(sig|sas|sid)($|[-_]))/i;

const TEXT_PATTERNS: Array<[RegExp, string]> = [
  // JWT (tres partes base64url, la primera empieza por eyJ).
  [/eyJ[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]{5,}/g, REDACTED],
  // Tokens de GitHub.
  [/\b(?:gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,})\b/g, REDACTED],
  // Cabeceras de autorizacion.
  [/\b(Bearer|Basic)\s+[A-Za-z0-9._~+/=-]{8,}/gi, `$1 ${REDACTED}`],
  // clave=valor en URLs y cadenas de conexion (SAS de Azure, codigos de emparejamiento...).
  [/\b(SharedAccessKey|SharedAccessSignature|AccountKey|sig|token|access_token|code|password|secret|key|sessionId|session_id|session)=([^&;\s"'<>|]+)/gi, `$1=${REDACTED}`],
  // UUID (los id de sesion lo son).
  [/\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi, REDACTED],
  // Hex largo (openssl rand -hex).
  [/\b[0-9a-f]{32,}\b/gi, REDACTED],
  // base64 largo con mayusculas, minusculas y digitos (openssl rand -base64, claves de Azure).
  [/(?<![A-Za-z0-9+/_=-])(?=[A-Za-z0-9+/_-]*[0-9])(?=[A-Za-z0-9+/_-]*[a-z])(?=[A-Za-z0-9+/_-]*[A-Z])[A-Za-z0-9+/_-]{32,}={0,2}(?![A-Za-z0-9+/_=-])/g, REDACTED],
];

/** Tapa en un texto todo lo que parezca un token. */
export function redactText(text: string) {
  let result = text;
  for (const [pattern, replacement] of TEXT_PATTERNS) result = result.replace(pattern, replacement);
  return result;
}

/** Copia profunda sin secretos: claves sensibles con texto y textos con forma de token. */
export function redactSecrets<T>(value: T): T {
  return redactValue(value, "") as T;
}

function redactValue(value: unknown, key: string): unknown {
  if (typeof value === "string") {
    if (key && SENSITIVE_KEY.test(key) && value) return REDACTED;
    return redactText(value);
  }
  if (Array.isArray(value)) return value.map((item) => redactValue(item, key));
  if (value && typeof value === "object") {
    const copy: Record<string, unknown> = {};
    for (const [entryKey, entryValue] of Object.entries(value as Record<string, unknown>)) {
      copy[entryKey] = redactValue(entryValue, entryKey);
    }
    return copy;
  }
  return value;
}

// ---------------------------------------------------------------- HTTP

export type HttpProbe = {
  method: "GET" | "HEAD";
  path: string;
  status: number;
  ms: number;
  bytes: number | null;
  contentType: string;
  error: string | null;
};

export function describeFetchError(error: unknown, timeoutMs: number) {
  const err = error as { name?: string; message?: string; cause?: { code?: string } };
  if (err?.name === "TimeoutError" || err?.name === "AbortError") return `sin respuesta en ${Math.round(timeoutMs / 1000)} s`;
  const code = err?.cause?.code;
  return code ? `sin conexión (${code})` : `sin conexión (${err?.message || String(error)})`;
}

async function request(baseUrl: string, pathName: string, options: {
  method?: "GET" | "HEAD";
  timeoutMs: number;
  headers?: Record<string, string>;
}) {
  const method = options.method || "GET";
  const startedAt = Date.now();
  try {
    const response = await fetch(`${baseUrl}${pathName}`, {
      method,
      headers: options.headers,
      redirect: "manual",
      signal: AbortSignal.timeout(options.timeoutMs),
    });
    let text = "";
    let bytes: number | null = null;
    if (method === "GET") {
      const buffer = Buffer.from(await response.arrayBuffer());
      bytes = buffer.length;
      text = buffer.toString("utf8");
    } else {
      await response.arrayBuffer().catch(() => undefined);
      const length = Number(response.headers.get("content-length"));
      bytes = Number.isFinite(length) && response.headers.has("content-length") ? length : null;
    }
    const probe: HttpProbe = {
      method,
      path: pathName,
      status: response.status,
      ms: Date.now() - startedAt,
      bytes,
      contentType: (response.headers.get("content-type") || "").split(";")[0].trim(),
      error: null,
    };
    return { probe, text };
  } catch (error) {
    const probe: HttpProbe = {
      method,
      path: pathName,
      status: 0,
      ms: Date.now() - startedAt,
      bytes: null,
      contentType: "",
      error: describeFetchError(error, options.timeoutMs),
    };
    return { probe, text: "" };
  }
}

function parseJsonObject(text: string): Record<string, unknown> | null {
  try {
    const parsed = JSON.parse(text);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed as Record<string, unknown> : null;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------- versiones

const VERSION_RE = /^\d+(\.\d+){0,3}$/;

/** Versiones que publica /empezar (src/routes/start-page-routes.ts). */
export function parseStartPageVersions(html: string) {
  const navegador = html.match(/data-browser-ext-latest="([^"]*)"/)?.[1] || "";
  const vscode = html.match(/VSIX, version (\d+(?:\.\d+){0,3})/)?.[1] || "";
  return {
    navegador: VERSION_RE.test(navegador) ? navegador : "",
    vscode: VERSION_RE.test(vscode) ? vscode : "",
  };
}

async function readRepoVersion(repoRoot: string, relative: string) {
  try {
    const parsed = JSON.parse(await fsp.readFile(path.resolve(repoRoot, relative), "utf8")) as { version?: unknown };
    return typeof parsed.version === "string" && VERSION_RE.test(parsed.version) ? parsed.version : "";
  } catch {
    return "";
  }
}

// ---------------------------------------------------------------- informe

export type CheckStatus = "ok" | "aviso" | "falla";
export type EvidenceCheck = { id: string; nombre: string; estado: CheckStatus; detalle: string };

export type WorkerSummary = {
  id: string;
  label: string;
  alive: boolean | null;
  lastSeenAt: string;
  model: string;
  platform: string;
  kinds: string;
  jobsProcessed: number | null;
};

export type PilotEvidence =
  | { omitido: string }
  | {
    status: number;
    block: number | null;
    description: string;
    counts: { A: number; B: number; sinAsignar: number } | null;
    updatedAt: string | null;
    error: string | null;
  };

export type ComplianceEvidence =
  | { omitido: string }
  | {
    automaticosCumplen: number;
    automaticos: number;
    criticosEnFalla: string[];
    total: { met: number; applicable: number };
    filas: Array<{ id: string; item: string; critico: boolean; estado: string; detalle: string }>;
  };

export type EvidenceReport = {
  generadoEn: string;
  terminadoEn: string;
  backend: string;
  comando: string;
  consultas: HttpProbe[];
  health: Record<string, unknown> | null;
  agenteHealth: { status: number; data: Record<string, unknown> | null };
  agenteBackend: Record<string, unknown> | null;
  workers: WorkerSummary[];
  versiones: {
    navegador: string;
    vscode: string;
    esperadas: { navegador: string; vscode: string };
    tandaAccesoSimplificado: boolean | null;
  };
  descargas: HttpProbe[];
  piloto: PilotEvidence;
  cumplimiento: ComplianceEvidence;
  comprobaciones: EvidenceCheck[];
};

export type EvidenceOptions = {
  backendUrl: string;
  timeoutMs?: number;
  /** Credenciales de docente (ADACEEN_DOCENTE_EMAIL / ADACEEN_DOCENTE_PASSWORD). */
  credentials?: { email: string; password: string } | null;
  /** Verificacion de cumplimiento sin credenciales (con credenciales siempre corre). */
  compliance?: boolean;
  /** Raiz del repositorio para las versiones esperadas (por defecto process.cwd()). */
  repoRoot?: string;
  comando?: string;
};

export const DOWNLOAD_PATHS = [
  "/descargas/adaceen-navegador.zip",
  "/descargas/adaceen.vsix",
  "/descargas/Preparar-Mac-ADACEEN.zip",
  "/descargas/Preparar-Mac-ADACEEN.command",
] as const;

/** Campos que agrego la tanda «acceso simplificado» a /api/health (src/routes/health-routes.ts). */
export const TANDA_HEALTH_FIELDS = ["workspace_agent_transport", "model_workers_alive"] as const;

function formatBytes(bytes: number | null) {
  if (bytes === null) return "—";
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1).replace(".", ",")} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1).replace(".", ",")} MB`;
}

function probeText(probe: HttpProbe) {
  return probe.status ? `HTTP ${probe.status}` : probe.error || "sin respuesta";
}

async function probeDownload(baseUrl: string, pathName: string, timeoutMs: number) {
  const head = await request(baseUrl, pathName, { method: "HEAD", timeoutMs });
  if (head.probe.status !== 405 && head.probe.status !== 501) return head.probe;
  // Sin HEAD: se descarga y se cuenta.
  return (await request(baseUrl, pathName, { method: "GET", timeoutMs })).probe;
}

function toWorkerSummaries(agentBackend: Record<string, unknown> | null): WorkerSummary[] {
  const listening = Array.isArray(agentBackend?.listening) ? agentBackend.listening as Array<Record<string, unknown>> : [];
  return listening.map((worker) => ({
    id: String(worker.id ?? ""),
    label: String(worker.label ?? ""),
    alive: typeof worker.alive === "boolean" ? worker.alive : null,
    lastSeenAt: String(worker.lastSeenAt ?? ""),
    model: String(worker.model ?? ""),
    platform: String(worker.platform ?? ""),
    kinds: String(worker.kinds ?? ""),
    jobsProcessed: typeof worker.jobsProcessed === "number" && Number.isFinite(worker.jobsProcessed) ? worker.jobsProcessed : null,
  }));
}

async function collectPilot(baseUrl: string, credentials: { email: string; password: string }, timeoutMs: number): Promise<{ pilot: PilotEvidence; probe: HttpProbe | null; loginError: string | null }> {
  let sessionId = "";
  try {
    sessionId = await login(baseUrl, credentials.email, credentials.password);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const clean = message.split(credentials.email).join("<docente>");
    return { pilot: { omitido: `No se pudo iniciar sesión con ADACEEN_DOCENTE_EMAIL: ${clean}` }, probe: null, loginError: clean };
  }
  const { probe, text } = await request(baseUrl, "/api/pilot", { timeoutMs, headers: { "x-session-id": sessionId } });
  const data = parseJsonObject(text);
  const counts = data?.counts && typeof data.counts === "object" ? data.counts as Record<string, unknown> : null;
  // Solo el resumen: la lista de estudiantes (nombres) no sale del backend.
  return {
    pilot: {
      status: probe.status,
      block: typeof data?.block === "number" ? data.block : null,
      description: typeof data?.description === "string" ? data.description : "",
      counts: counts
        ? { A: Number(counts.A) || 0, B: Number(counts.B) || 0, sinAsignar: Number(counts.sinAsignar) || 0 }
        : null,
      updatedAt: typeof data?.updatedAt === "string" ? data.updatedAt : null,
      error: probe.status === 200 ? null : String(data?.error || probe.error || `HTTP ${probe.status}`),
    },
    probe,
    loginError: null,
  };
}

async function collectCompliance(baseUrl: string): Promise<ComplianceEvidence> {
  const results: Record<string, ComplianceCheckResult> = {
    ...(await staticChecks()),
    // Sin credenciales a proposito: la comprobacion de la sesion de VS Code
    // (C24) hace «Salir» con esa cuenta, y aqui seria la del docente. Esa se
    // corre con npm run piloto:verificar y una cuenta de prueba; C25 queda con
    // la revision del codigo de staticChecks.
    ...(await backendChecks(baseUrl, { credentials: null })),
  };
  const rows = COMPLIANCE_ITEMS.map((item) => results[item.id] || {
    id: item.id,
    status: item.verification === "manual" ? "manual" as const : "no verificado" as const,
    detail: item.verification === "manual" ? item.how : "Sin comprobación automática en este comando.",
  });
  const automatic = COMPLIANCE_ITEMS.filter((item) => item.verification === "automatica");
  return {
    automaticosCumplen: automatic.filter((item) => results[item.id]?.status === "cumple").length,
    automaticos: automatic.length,
    criticosEnFalla: COMPLIANCE_ITEMS
      .filter((item) => item.critical && item.verification === "automatica" && results[item.id]?.status === "no cumple")
      .map((item) => item.id),
    total: complianceScore(rows),
    filas: COMPLIANCE_ITEMS.map((item) => {
      const row = rows.find((entry) => entry.id === item.id)!;
      return { id: item.id, item: item.item, critico: item.critical, estado: row.status, detalle: row.detail };
    }),
  };
}

function boolCheck(
  id: string,
  nombre: string,
  value: unknown,
  onFalse: { estado: CheckStatus; detalle: string },
  okDetail: string,
  field: string,
): EvidenceCheck {
  if (value === true) return { id, nombre, estado: "ok", detalle: okDetail };
  if (value === false) return { id, nombre, ...onFalse };
  return { id, nombre, estado: "aviso", detalle: `/api/health no informa ${field} (backend anterior o sin respuesta).` };
}

function buildChecks(report: Omit<EvidenceReport, "comprobaciones">, probes: {
  health: HttpProbe;
  empezar: HttpProbe;
  loginError: string | null;
  loginOmitido: string | null;
}): EvidenceCheck[] {
  const checks: EvidenceCheck[] = [];
  const health = report.health;
  const healthOk = probes.health.status === 200 && health?.ok === true;
  checks.push({
    id: "backend_responde",
    nombre: "/api/health responde",
    estado: healthOk ? "ok" : "falla",
    detalle: healthOk ? `HTTP 200 en ${probes.health.ms} ms` : `${probeText(probes.health)}${health ? `, ok = ${String(health.ok)}` : ""}`,
  });
  if (health) {
    const missing = TANDA_HEALTH_FIELDS.filter((field) => !(field in health));
    checks.push({
      id: "tanda_acceso_simplificado",
      nombre: "Backend con la tanda «acceso simplificado»",
      estado: missing.length ? "falla" : "ok",
      detalle: missing.length
        ? `Faltan ${missing.join(" y ")} en /api/health: el backend desplegado es anterior a esta tanda.`
        : `/api/health trae ${TANDA_HEALTH_FIELDS.join(" y ")}.`,
    });
    const provider = health.database_provider;
    checks.push({
      id: "base_postgres",
      nombre: "Base PostgreSQL",
      estado: provider === "postgres" ? "ok" : provider === undefined ? "aviso" : "falla",
      detalle: `database_provider = ${String(provider ?? "sin dato")}`,
    });
    checks.push(boolCheck("sal_telemetria", "TELEMETRY_SALT configurada", health.telemetry_salt_configured,
      { estado: "falla", detalle: "telemetry_salt_configured = false: falta TELEMETRY_SALT en el App Service." },
      "telemetry_salt_configured = true", "telemetry_salt_configured"));
    if (health.mode === "queue") {
      checks.push({
        id: "cola",
        nombre: "Cola de Service Bus configurada",
        estado: health.queue_configured === true ? "ok" : "falla",
        detalle: health.queue_configured === true
          ? `modo queue; colas ${String(health.jobs_queue_name ?? "?")} y ${String(health.results_queue_name ?? "?")}`
          : `modo queue sin cola configurada; faltan: ${Array.isArray(health.queue_missing_config) ? health.queue_missing_config.join(", ") : "sin dato"}`,
      });
    } else {
      checks.push({ id: "cola", nombre: "Cola de Service Bus configurada", estado: "aviso", detalle: `modo ${String(health.mode ?? "sin dato")}: no usa la cola.` });
    }
    checks.push(boolCheck("latidos", "Latido de los workers configurado", health.worker_heartbeat_configured,
      { estado: "aviso", detalle: "worker_heartbeat_configured = false: sin WORKER_HEARTBEAT_TOKEN no se ve si hay un servidor del modelo vivo." },
      "worker_heartbeat_configured = true", "worker_heartbeat_configured"));
    if (health.workspace_provider === "tunnel") {
      checks.push(boolCheck("agente_editores", "VM de editores conectada al relay", health.workspace_agent_online,
        { estado: "aviso", detalle: "workspace_agent_online = false: normal con la VM de editores apagada; antes de clase, bash deploy/clase.sh iniciar." },
        `workspace_agent_online = true (transporte ${String(health.workspace_agent_transport ?? "sin dato")})`, "workspace_agent_online"));
    } else {
      checks.push({
        id: "agente_editores",
        nombre: "VM de editores conectada al relay",
        estado: health.workspace_provider === undefined ? "aviso" : "ok",
        detalle: `workspace_provider = ${String(health.workspace_provider ?? "sin dato")}`,
      });
    }
  }
  const alive = typeof report.agenteBackend?.alive_workers === "number"
    ? report.agenteBackend.alive_workers as number
    : typeof health?.model_workers_alive === "number" ? health.model_workers_alive as number : null;
  checks.push({
    id: "servidores_vivos",
    nombre: "Servidores del modelo vivos",
    estado: alive !== null && alive >= 1 ? "ok" : "aviso",
    detalle: alive === null
      ? "Ni /api/agent/backend ni /api/health informan los servidores vivos."
      : alive >= 1
        ? `${alive} vivo(s): ${report.workers.filter((worker) => worker.alive).map((worker) => worker.id || worker.label).join(", ") || "sin id"}`
        : "Ninguno: normal fuera de clase (la GPU se apaga por diseño); en clase, bash deploy/clase.sh iniciar.",
  });
  checks.push({
    id: "empezar",
    nombre: "/empezar publicada",
    estado: probes.empezar.status === 200 ? "ok" : "falla",
    detalle: `${probeText(probes.empezar)}, ${formatBytes(probes.empezar.bytes)}`,
  });
  for (const [id, nombre, target] of [
    ["descarga_navegador", "Descarga de la extensión de navegador", "/descargas/adaceen-navegador.zip"],
    ["descarga_vsix", "Descarga de la extensión de VS Code", "/descargas/adaceen.vsix"],
  ] as const) {
    const probe = report.descargas.find((item) => item.path === target)!;
    checks.push({ id, nombre, estado: probe.status === 200 ? "ok" : "falla", detalle: `${target}: ${probeText(probe)}, ${formatBytes(probe.bytes)}` });
  }
  const macProbes = report.descargas.filter((item) => item.path.includes("Preparar-Mac-ADACEEN"));
  checks.push({
    id: "descarga_mac",
    nombre: "Instalador de Mac para estudiantes",
    estado: macProbes.some((probe) => probe.status === 200) ? "ok" : "aviso",
    detalle: macProbes.map((probe) => `${path.posix.basename(probe.path)}: ${probeText(probe)}`).join("; "),
  });
  for (const [id, nombre, key] of [
    ["version_navegador", "Versión publicada de la extensión de navegador", "navegador"],
    ["version_vscode", "Versión publicada de la extensión de VS Code", "vscode"],
  ] as const) {
    const published = report.versiones[key];
    const expected = report.versiones.esperadas[key];
    checks.push({
      id,
      nombre,
      estado: published && (!expected || published === expected) ? "ok" : "aviso",
      detalle: !published
        ? `/empezar no la informa${expected ? ` (en el repositorio: ${expected})` : ""}.`
        : expected && published !== expected
          ? `Publicada ${published}; en el repositorio ${expected}.`
          : `${published}${expected ? " (igual que el repositorio)" : ""}`,
    });
  }
  checks.push({
    id: "https",
    nombre: "Backend por HTTPS",
    estado: report.backend.startsWith("https://") ? "ok" : "aviso",
    detalle: report.backend,
  });
  if (!("omitido" in report.piloto)) {
    const pilot = report.piloto;
    checks.push({
      id: "piloto",
      nombre: "Estado del piloto (docente)",
      estado: pilot.status === 200 && !(pilot.counts?.sinAsignar) ? "ok" : "aviso",
      detalle: pilot.status === 200
        ? `bloque ${pilot.block ?? "?"}; A ${pilot.counts?.A ?? 0}, B ${pilot.counts?.B ?? 0}, sin asignar ${pilot.counts?.sinAsignar ?? 0}`
        : `/api/pilot: HTTP ${pilot.status}: ${pilot.error ?? ""}`,
    });
  } else if (probes.loginError) {
    checks.push({ id: "piloto", nombre: "Estado del piloto (docente)", estado: "falla", detalle: report.piloto.omitido });
  } else if (probes.loginOmitido) {
    checks.push({ id: "piloto", nombre: "Estado del piloto (docente)", estado: "aviso", detalle: probes.loginOmitido });
  }
  if (!("omitido" in report.cumplimiento)) {
    const compliance = report.cumplimiento;
    checks.push({
      id: "cumplimiento",
      nombre: "Verificación de cumplimiento (A13.4)",
      estado: compliance.criticosEnFalla.length ? "falla" : "ok",
      detalle: `${compliance.automaticosCumplen} de ${compliance.automaticos} automáticos cumplen; críticos en falla: ${compliance.criticosEnFalla.join(", ") || "ninguno"}`,
    });
  }
  return checks;
}

export async function collectDeploymentEvidence(options: EvidenceOptions): Promise<EvidenceReport> {
  const backend = options.backendUrl.replace(/\/+$/, "");
  const timeoutMs = options.timeoutMs ?? 30_000;
  const repoRoot = options.repoRoot || process.cwd();
  const generadoEn = new Date().toISOString();

  // /api/health primero y solo: en Azure la primera consulta despierta la app.
  const health = await request(backend, "/api/health", { timeoutMs });
  const [agentBackend, agentHealth, empezar] = await Promise.all([
    request(backend, "/api/agent/backend", { timeoutMs }),
    request(backend, "/api/agent/health", { timeoutMs }),
    request(backend, "/empezar", { timeoutMs }),
  ]);
  const descargas: HttpProbe[] = [];
  for (const target of DOWNLOAD_PATHS) descargas.push(await probeDownload(backend, target, timeoutMs));

  const healthData = parseJsonObject(health.text);
  const agentBackendData = parseJsonObject(agentBackend.text);
  const published = empezar.probe.status === 200 ? parseStartPageVersions(empezar.text) : { navegador: "", vscode: "" };
  const consultas = [health.probe, agentBackend.probe, agentHealth.probe, empezar.probe, ...descargas];

  let piloto: PilotEvidence = { omitido: "Sin credenciales de docente (ADACEEN_DOCENTE_EMAIL y ADACEEN_DOCENTE_PASSWORD)." };
  let loginError: string | null = null;
  let loginOmitido: string | null = null;
  const tanda = healthData ? TANDA_HEALTH_FIELDS.every((field) => field in healthData) : null;
  if (options.credentials?.email && options.credentials.password) {
    if (tanda !== true) {
      // sessionKind "cli" llego con la misma tanda que estos campos (5d94351):
      // un backend sin ellos ignora sessionKind y su login desactiva TODAS las
      // sesiones del docente, tambien la del navegador y la de VS Code.
      loginOmitido = tanda === null
        ? "No se inició sesión como docente: sin /api/health no se sabe si el backend acepta sesiones de consola, y en uno anterior a la tanda «acceso simplificado» el inicio de sesión cierra todas las sesiones del docente."
        : "No se inició sesión como docente: el backend es anterior a la tanda «acceso simplificado» y ahí el inicio de sesión cierra todas las sesiones del docente (navegador y VS Code).";
      piloto = { omitido: loginOmitido };
    } else {
      const pilot = await collectPilot(backend, options.credentials, timeoutMs);
      piloto = pilot.pilot;
      loginError = pilot.loginError;
      if (pilot.probe) consultas.push(pilot.probe);
    }
  }
  const runCompliance = Boolean(options.credentials?.email && options.credentials.password) || options.compliance === true;
  const cumplimiento: ComplianceEvidence = runCompliance
    ? await collectCompliance(backend)
    : { omitido: "Sin credenciales de docente ni --cumplimiento." };

  const partial: Omit<EvidenceReport, "comprobaciones"> = {
    generadoEn,
    terminadoEn: new Date().toISOString(),
    backend,
    comando: options.comando || "",
    consultas,
    health: healthData,
    agenteHealth: { status: agentHealth.probe.status, data: parseJsonObject(agentHealth.text) },
    agenteBackend: agentBackendData,
    workers: toWorkerSummaries(agentBackendData),
    versiones: {
      navegador: published.navegador,
      vscode: published.vscode,
      esperadas: {
        navegador: await readRepoVersion(repoRoot, "browser-ext-prod/manifest.json"),
        vscode: await readRepoVersion(repoRoot, "vscode-ext-prod/package.json"),
      },
      tandaAccesoSimplificado: tanda,
    },
    descargas,
    piloto,
    cumplimiento,
  };
  const report: EvidenceReport = {
    ...partial,
    comprobaciones: buildChecks(partial, { health: health.probe, empezar: empezar.probe, loginError, loginOmitido }),
  };
  return redactSecrets(report);
}

// ---------------------------------------------------------------- Markdown

function cell(value: unknown) {
  const text = value === null || value === undefined || value === ""
    ? "—"
    : typeof value === "object" ? JSON.stringify(value) : String(value);
  return text.replace(/\|/g, "\\|").replace(/\r?\n/g, " ");
}

const STATUS_LABEL: Record<CheckStatus, string> = { ok: "Bien", aviso: "Aviso", falla: "FALLA" };

export function summarizeChecks(checks: EvidenceCheck[]) {
  return {
    ok: checks.filter((check) => check.estado === "ok").length,
    aviso: checks.filter((check) => check.estado === "aviso").length,
    falla: checks.filter((check) => check.estado === "falla").length,
  };
}

export function renderEvidenceMarkdown(report: EvidenceReport) {
  const totals = summarizeChecks(report.comprobaciones);
  const lines: string[] = [
    `# Evidencias de despliegue — ${report.generadoEn.slice(0, 16).replace("T", " ")} UTC`,
    "",
    "| | |",
    "|---|---|",
    `| Jira | A15.6 · ADACEEN-127 (evidencias), A15.4 · ADACEEN-125 (salud y latidos) |`,
    `| Backend | ${cell(report.backend)} |`,
    `| Ventana | ${report.generadoEn} → ${report.terminadoEn} |`,
    `| Comando | \`${report.comando || "npm run evidencias:despliegue"}\` |`,
    `| Resultado | ${totals.ok} bien, ${totals.aviso} avisos, ${totals.falla} fallas |`,
    "",
    "Generado por `scripts/evidencias-despliegue.ts`. No cambia configuración: consultas de lectura y,",
    "con credenciales o `--cumplimiento`, inicios de sesión de consola. Lo que parece un token, una",
    `clave o un id de sesión aparece como \`${REDACTED}\`.`,
    "",
    "## 1. Comprobaciones",
    "",
    "| Estado | Comprobación | Detalle |",
    "|---|---|---|",
    ...report.comprobaciones.map((check) => `| ${STATUS_LABEL[check.estado]} | ${cell(check.nombre)} | ${cell(check.detalle)} |`),
    "",
    "## 2. Versión desplegada",
    "",
    "| Pieza | Publicada en /empezar | En el repositorio local |",
    "|---|---|---|",
    `| Extensión de navegador | ${cell(report.versiones.navegador)} | ${cell(report.versiones.esperadas.navegador)} |`,
    `| Extensión de VS Code | ${cell(report.versiones.vscode)} | ${cell(report.versiones.esperadas.vscode)} |`,
    `| Backend con la tanda «acceso simplificado» | ${report.versiones.tandaAccesoSimplificado === null ? "sin dato" : report.versiones.tandaAccesoSimplificado ? "sí" : "no"} | — |`,
    "",
    "El backend no publica el commit desplegado: anótalo desde GitHub → Actions (ejecución",
    "del flujo de despliegue) en el registro de despliegues.",
    "",
    "## 3. Consultas HTTP",
    "",
    "| Método | Ruta | Código | Tamaño | Tipo | Tiempo |",
    "|---|---|---|---|---|---|",
    ...report.consultas.map((probe) => `| ${probe.method} | ${cell(probe.path)} | ${probe.status || cell(probe.error)} | ${formatBytes(probe.bytes)} | ${cell(probe.contentType)} | ${probe.ms} ms |`),
    "",
    "## 4. /api/health",
    "",
  ];
  if (report.health) {
    lines.push("| Campo | Valor |", "|---|---|");
    for (const [key, value] of Object.entries(report.health)) lines.push(`| \`${key}\` | ${cell(value)} |`);
  } else {
    lines.push("Sin respuesta JSON.");
  }
  lines.push(
    "",
    "## 5. Servidores del modelo (/api/agent/backend y /api/agent/health)",
    "",
    `\`/api/agent/health\`: ${report.agenteHealth.status ? `HTTP ${report.agenteHealth.status}` : "sin respuesta"}${report.agenteHealth.data ? ` ${cell(report.agenteHealth.data)}` : ""}.`,
    "",
  );
  if (report.workers.length) {
    lines.push("| Id | Etiqueta | Vivo | Último latido | Modelo | Plataforma | Tipos | Trabajos |", "|---|---|---|---|---|---|---|---|");
    for (const worker of report.workers) {
      lines.push(`| ${cell(worker.id)} | ${cell(worker.label)} | ${worker.alive === null ? "—" : worker.alive ? "sí" : "no"} | ${cell(worker.lastSeenAt)} | ${cell(worker.model)} | ${cell(worker.platform)} | ${cell(worker.kinds)} | ${cell(worker.jobsProcessed)} |`);
    }
  } else {
    lines.push("Ningún servidor con latido registrado (tras un reinicio del App Service reaparecen con su siguiente latido).");
  }
  lines.push("", "## 6. Piloto (con credenciales de docente)", "");
  if ("omitido" in report.piloto) {
    lines.push(`Omitido: ${report.piloto.omitido}`);
  } else {
    const pilot = report.piloto;
    lines.push(
      "| Campo | Valor |",
      "|---|---|",
      `| \`/api/pilot\` | HTTP ${pilot.status} |`,
      `| Bloque | ${cell(pilot.block)} |`,
      `| Descripción | ${cell(pilot.description)} |`,
      `| Cohorte A / B / sin asignar | ${pilot.counts ? `${pilot.counts.A} / ${pilot.counts.B} / ${pilot.counts.sinAsignar}` : "—"} |`,
      `| Último cambio de bloque | ${cell(pilot.updatedAt)} |`,
      ...(pilot.error ? [`| Error | ${cell(pilot.error)} |`] : []),
      "",
      "Solo el resumen: la lista de estudiantes no se copia a la evidencia.",
    );
  }
  lines.push("", "## 7. Verificación de cumplimiento (A13.4)", "");
  if ("omitido" in report.cumplimiento) {
    lines.push(`Omitida: ${report.cumplimiento.omitido}`);
  } else {
    const compliance = report.cumplimiento;
    lines.push(
      `Automáticos: ${compliance.automaticosCumplen} de ${compliance.automaticos} cumplen. Críticos automáticos en falla: ${compliance.criticosEnFalla.join(", ") || "ninguno"}. Con los manuales pendientes, el total va en ${compliance.total.met} de ${compliance.total.applicable}.`,
      "",
      "| ID | Ítem | Crítico | Estado | Detalle |",
      "|---|---|---|---|---|",
      ...compliance.filas.map((row) => `| ${row.id} | ${cell(row.item)} | ${row.critico ? "Sí" : "No"} | ${row.estado} | ${cell(row.detalle)} |`),
    );
  }
  lines.push("");
  return redactText(lines.join("\n"));
}

/** Escribe evidencias.md y evidencias.json en <base>/<fecha UTC>[-n]/. */
export async function writeEvidence(report: EvidenceReport, baseDir: string) {
  const root = path.resolve(process.cwd(), baseDir);
  const stamp = nowStamp(new Date(report.generadoEn));
  let dir = path.join(root, stamp);
  for (let suffix = 2; await fsp.stat(dir).then(() => true).catch(() => false); suffix += 1) {
    dir = path.join(root, `${stamp}-${suffix}`);
  }
  await fsp.mkdir(dir, { recursive: true });
  const markdownPath = path.join(dir, "evidencias.md");
  const jsonPath = path.join(dir, "evidencias.json");
  await fsp.writeFile(markdownPath, renderEvidenceMarkdown(report), "utf8");
  await fsp.writeFile(jsonPath, `${JSON.stringify(redactSecrets(report), null, 2)}\n`, "utf8");
  return { dir, markdownPath, jsonPath };
}

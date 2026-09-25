import "dotenv/config";
import path from "node:path";
import { fail, hasFlag, readArg, readIntArg } from "./lib/cli.js";
import {
  cleanBackendUrl,
  collectDeploymentEvidence,
  normalizeArgs,
  summarizeChecks,
  writeEvidence,
} from "./lib/evidencias.js";

/**
 * Evidencias de despliegue en una carpeta fechada (A15.6 · ADACEEN-127,
 * A15.4 · ADACEEN-125): /api/health, /api/agent/backend, /api/agent/health,
 * /empezar y /descargas/* (codigo HTTP y tamanos), version publicada y, con
 * credenciales de docente, el estado del piloto y la verificacion de
 * cumplimiento. Sin secretos: lo que parece un token sale como [redactado].
 *
 *   npm run evidencias:despliegue -- --backend <url> [--salida <carpeta>] [--timeout <s>] [--cumplimiento]
 *
 * Credenciales opcionales de docente (en el entorno o en .env, nunca en la
 * linea de comandos): ADACEEN_DOCENTE_EMAIL y ADACEEN_DOCENTE_PASSWORD.
 * Con ellas tambien corre la verificacion de cumplimiento; sin ellas, solo
 * con --cumplimiento. Contra un backend anterior a la tanda «acceso
 * simplificado» no inicia sesion (ahi el login cierra todas las sesiones del
 * docente) y el estado del piloto queda como aviso.
 *
 * Escribe <salida>/<fecha UTC>/evidencias.md y evidencias.json (por defecto
 * exportes/evidencias-despliegue, que no se versiona). Sale con codigo 1 si
 * alguna comprobacion falla.
 */

const USO = "Uso: npm run evidencias:despliegue -- --backend <url> [--salida <carpeta>] [--timeout <s>] [--cumplimiento]";

async function main() {
  if (hasFlag("ayuda") || hasFlag("help") || process.argv.includes("-h")) {
    console.log(USO);
    console.log("Credenciales opcionales de docente: ADACEEN_DOCENTE_EMAIL y ADACEEN_DOCENTE_PASSWORD (entorno o .env).");
    return;
  }
  if (process.argv.some((item) => item === "--password" || item.startsWith("--password="))) {
    fail("La clave no va en la linea de comandos (queda en el historial): usa ADACEEN_DOCENTE_PASSWORD en el entorno o en .env.");
  }
  process.argv = normalizeArgs(process.argv, ["backend", "url", "salida", "timeout"]);
  const raw = readArg("backend") || readArg("url");
  const backend = cleanBackendUrl(raw);
  if (!backend) fail(raw ? `URL del backend invalida: ${raw}\n${USO}` : USO);

  const email = (process.env.ADACEEN_DOCENTE_EMAIL || "").trim();
  const password = process.env.ADACEEN_DOCENTE_PASSWORD || "";
  if (email && !password) console.warn("[evidencias] Hay ADACEEN_DOCENTE_EMAIL sin ADACEEN_DOCENTE_PASSWORD: sigo sin credenciales.");
  const credentials = email && password ? { email, password } : null;
  const timeoutS = readIntArg("timeout", 30, 1, 300);
  const salida = readArg("salida", "exportes/evidencias-despliegue");

  console.log(`[evidencias] ${backend}${credentials ? " con credenciales de docente" : " sin credenciales de docente"}`);
  const report = await collectDeploymentEvidence({
    backendUrl: backend,
    timeoutMs: timeoutS * 1000,
    credentials,
    compliance: hasFlag("cumplimiento"),
    comando: `npm run evidencias:despliegue -- ${process.argv.slice(2).join(" ")}`,
  });
  const written = await writeEvidence(report, salida);

  for (const check of report.comprobaciones) {
    const label = check.estado === "ok" ? "bien " : check.estado === "aviso" ? "AVISO" : "FALLA";
    console.log(`[evidencias] ${label} ${check.nombre}: ${check.detalle}`);
  }
  const totals = summarizeChecks(report.comprobaciones);
  console.log(`[evidencias] ${totals.ok} bien, ${totals.aviso} avisos, ${totals.falla} fallas.`);
  console.log(`[evidencias] Evidencia: ${path.relative(process.cwd(), written.markdownPath)} y ${path.basename(written.jsonPath)}`);
  if (totals.falla) process.exitCode = 1;
}

main().catch((error) => {
  console.error("[evidencias] Fallo:", error instanceof Error ? error.message : error);
  process.exitCode = 1;
});

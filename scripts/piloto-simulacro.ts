import "dotenv/config";
import { fail, hasFlag, readArg, readIntArg } from "./lib/cli.js";
import { cleanBackendUrl, normalizeArgs } from "./lib/evidencias.js";
import { ESCENARIOS, runSimulacro, type Escenario } from "./lib/simulacro.js";

/**
 * Guia con cronometro del simulacro de contingencia (A15.5 · ADACEEN-126,
 * A13.6 · ADACEEN-114; docs/operacion/contingencia.md, seccion 9).
 *
 *   npm run piloto:simulacro -- --backend <url> [--escenario gpu|editor|azure]
 *        [--intervalo 5] [--limite 900] [--timeout 10] [--salida exportes] [--sin-pausas]
 *
 *   gpu     casos 1, 2 y 4: apagar la GPU (o su worker) y volver a encenderla
 *   editor  caso 8: desconectar el agente de la VM de editores y reconectarlo
 *   azure   casos 5 y 10: reinicio del App Service o corte de la red de la sala
 *
 * Muestra cada paso, sondea /api/health (y /api/agent/health con gpu) y mide
 * deteccion, degradado y recuperacion. No apaga nada ni necesita gcloud: el
 * operador corre los comandos que se muestran (a mano o con deploy/clase.sh)
 * y pulsa Enter. Escribe exportes/simulacro-<escenario>-<fecha>.jsonl y .md.
 * Ctrl+C o «f» + Enter terminan y guardan el registro. Sale con codigo 1 si
 * el simulacro no paso.
 */

const USO = "Uso: npm run piloto:simulacro -- --backend <url> [--escenario gpu|editor|azure] [--intervalo <s>] [--limite <s>] [--timeout <s>] [--salida <carpeta>] [--sin-pausas]";

async function main() {
  if (hasFlag("ayuda") || hasFlag("help") || process.argv.includes("-h")) {
    console.log(USO);
    return;
  }
  process.argv = normalizeArgs(process.argv, ["backend", "url", "escenario", "intervalo", "limite", "timeout", "salida"]);
  const raw = readArg("backend") || readArg("url");
  const backend = cleanBackendUrl(raw);
  if (!backend) fail(raw ? `URL del backend invalida: ${raw}\n${USO}` : USO);
  const escenario = readArg("escenario", "gpu").trim().toLowerCase();
  if (!(ESCENARIOS as readonly string[]).includes(escenario)) fail(`Escenario desconocido: ${escenario} (usa ${ESCENARIOS.join(", ")})`);

  const controller = new AbortController();
  process.once("SIGINT", () => {
    console.log("\n[simulacro] Interrumpido: guardo el registro...");
    controller.abort();
  });
  const resultado = await runSimulacro({
    backendUrl: backend,
    escenario: escenario as Escenario,
    intervaloMs: readIntArg("intervalo", 5, 1, 300) * 1000,
    limiteMs: readIntArg("limite", 900, 10, 7200) * 1000,
    timeoutMs: readIntArg("timeout", 10, 1, 120) * 1000,
    salida: readArg("salida", "exportes"),
    pausas: !hasFlag("sin-pausas"),
    input: process.stdin,
    signal: controller.signal,
    comando: `npm run piloto:simulacro -- ${process.argv.slice(2).join(" ")}`,
  });
  if (resultado.veredicto === "no_paso") process.exitCode = 1;
}

main().catch((error) => {
  console.error("[simulacro] Fallo:", error instanceof Error ? error.message : error);
  process.exitCode = 1;
});

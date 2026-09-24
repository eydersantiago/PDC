import fsp from "node:fs/promises";
import path from "node:path";
import { renderTelemetryDictionaryMarkdown } from "../src/services/telemetry-dictionary-doc.js";

/**
 * Regenera docs/telemetria/diccionario-eventos.md desde el catalogo (A4.1, A4.3).
 *   npm run telemetria:diccionario              # escribe el documento
 *   npm run telemetria:diccionario -- --verificar  # sale con 1 si esta desactualizado
 */

const TARGET = path.resolve(process.cwd(), "docs/telemetria/diccionario-eventos.md");

async function main() {
  const expected = renderTelemetryDictionaryMarkdown();
  if (process.argv.includes("--verificar")) {
    const current = await fsp.readFile(TARGET, "utf8").catch(() => "");
    if (current !== expected) {
      console.error("[diccionario] docs/telemetria/diccionario-eventos.md esta desactualizado. Corre: npm run telemetria:diccionario");
      process.exitCode = 1;
      return;
    }
    console.log("[diccionario] Al dia.");
    return;
  }
  await fsp.mkdir(path.dirname(TARGET), { recursive: true });
  await fsp.writeFile(TARGET, expected, "utf8");
  console.log(`[diccionario] Escrito ${path.relative(process.cwd(), TARGET)}`);
}

main().catch((error) => {
  console.error("[diccionario] Fallo:", error);
  process.exitCode = 1;
});

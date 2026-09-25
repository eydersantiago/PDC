import fsp from "node:fs/promises";
import path from "node:path";
import { renderKpiCatalogMarkdown } from "../src/services/kpi-catalog-doc.js";

/**
 * Regenera docs/metricas/catalogo-kpis.md desde el catalogo (A3.1 a A3.6).
 *   npm run kpis:catalogo                # escribe el documento
 *   npm run kpis:catalogo -- --verificar # sale con 1 si esta desactualizado
 */

const TARGET = path.resolve(process.cwd(), "docs/metricas/catalogo-kpis.md");

async function main() {
  const expected = renderKpiCatalogMarkdown();
  if (process.argv.includes("--verificar")) {
    const current = await fsp.readFile(TARGET, "utf8").catch(() => "");
    if (current !== expected) {
      console.error("[kpis] docs/metricas/catalogo-kpis.md esta desactualizado. Corre: npm run kpis:catalogo");
      process.exitCode = 1;
      return;
    }
    console.log("[kpis] Al dia.");
    return;
  }
  await fsp.mkdir(path.dirname(TARGET), { recursive: true });
  await fsp.writeFile(TARGET, expected, "utf8");
  console.log(`[kpis] Escrito ${path.relative(process.cwd(), TARGET)}`);
}

main().catch((error) => {
  console.error("[kpis] Fallo:", error);
  process.exitCode = 1;
});

import "dotenv/config";
import path from "node:path";
import {
  COMPLIANCE_AREA_LABEL,
  COMPLIANCE_ITEMS,
  complianceScore,
  renderComplianceChecklistMarkdown,
  type ComplianceCheckResult,
} from "../src/services/compliance-checklist.js";
import { hasFlag, readArg, writeTextFile } from "./lib/cli.js";
import { backendChecks, staticChecks } from "./lib/cumplimiento.js";

/**
 * Verificacion de la lista de cumplimiento (A13.4). Revisa los items
 * automaticos; los manuales salen como pendientes con su evidencia.
 *
 *   npm run piloto:verificar                                   # solo el repositorio
 *   npm run piloto:verificar -- --url=<backend> [--email=<docente> --password=<clave>]
 *        [--salida=docs/evidencias/verificacion-cumplimiento-<fecha>.md]
 *   npm run piloto:checklist                                   # regenera docs/piloto/checklist-cumplimiento.md
 *
 * Sale con codigo 1 si un item critico automatico falla.
 */

async function main() {
  if (hasFlag("solo-documento")) {
    const written = await writeTextFile("docs/piloto/checklist-cumplimiento.md", renderComplianceChecklistMarkdown());
    console.log(`[cumplimiento] Escrito ${path.relative(process.cwd(), written)}`);
    return;
  }
  const baseUrl = readArg("url").replace(/\/+$/, "");
  const results: Record<string, ComplianceCheckResult> = {
    ...(await staticChecks()),
    ...(baseUrl ? await backendChecks(baseUrl) : {}),
  };
  const rows = COMPLIANCE_ITEMS.map((item) => results[item.id] || {
    id: item.id,
    status: item.verification === "manual" ? "manual" as const : "no verificado" as const,
    detail: item.verification === "manual" ? item.how : "Necesita --url del backend.",
  });
  const automatic = COMPLIANCE_ITEMS.filter((item) => item.verification === "automatica");
  const automaticMet = automatic.filter((item) => results[item.id]?.status === "cumple").length;
  const score = complianceScore(rows);
  const criticalAutoFailed = COMPLIANCE_ITEMS.filter((item) => item.critical && item.verification === "automatica" && results[item.id]?.status === "no cumple");

  for (const row of rows) {
    const item = COMPLIANCE_ITEMS.find((entry) => entry.id === row.id)!;
    console.log(`[cumplimiento] ${row.id} ${row.status.padEnd(13)} ${item.critical ? "(critico) " : ""}${item.item}`);
  }
  console.log(`[cumplimiento] Automaticos: ${automaticMet} de ${automatic.length} cumplen. Con los manuales pendientes, el total va en ${score.met} de ${score.applicable}.`);

  const lines = [
    `# Verificación de cumplimiento (A13.4) — ${new Date().toISOString().slice(0, 10)}`,
    "",
    "| | |",
    "|---|---|",
    `| Comando | \`npm run piloto:verificar${baseUrl ? ` -- --url=${baseUrl}` : ""}\` |`,
    `| Ítems automáticos | ${automaticMet} de ${automatic.length} cumplen |`,
    `| Críticos automáticos en falla | ${criticalAutoFailed.map((item) => item.id).join(", ") || "ninguno"} |`,
    `| Ítems manuales | ${COMPLIANCE_ITEMS.filter((item) => item.verification === "manual").length} por marcar con su evidencia |`,
    "",
    "El KPI T11 (≥ 80 %) se calcula cuando los manuales estén marcados: ítems cumplidos / ítems aplicables, con todos los críticos cumplidos.",
    "",
  ];
  for (const area of ["privacidad", "etica", "seguridad"] as const) {
    lines.push(`## ${COMPLIANCE_AREA_LABEL[area]}`, "", "| ID | Ítem | Crítico | Estado | Detalle |", "|---|---|---|---|---|");
    for (const item of COMPLIANCE_ITEMS.filter((entry) => entry.area === area)) {
      const row = rows.find((entry) => entry.id === item.id)!;
      lines.push(`| ${item.id} | ${item.item} | ${item.critical ? "Sí" : "No"} | ${row.status} | ${row.detail.replace(/\|/g, "\\|")} |`);
    }
    lines.push("");
  }
  const output = readArg("salida");
  if (output) {
    const written = await writeTextFile(output, lines.join("\n"));
    console.log(`[cumplimiento] Evidencia: ${path.relative(process.cwd(), written)}`);
  }
  if (criticalAutoFailed.length) process.exitCode = 1;
}

main().catch((error) => {
  console.error("[cumplimiento] Fallo:", error);
  process.exitCode = 1;
});

import assert from "node:assert/strict";
import fsp from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { KPI_CATALOG } from "../../src/services/kpi-catalog.js";
import { renderKpiCatalogMarkdown } from "../../src/services/kpi-catalog-doc.js";

test("catalogo de KPIs: el documento esta al dia y cada KPI esta operacionalizado", async () => {
  const doc = await fsp.readFile(path.resolve(process.cwd(), "docs/metricas/catalogo-kpis.md"), "utf8");
  assert.equal(doc, renderKpiCatalogMarkdown(), "Regenera con: npm run kpis:catalogo");
  const ids = new Set<string>();
  for (const kpi of KPI_CATALOG) {
    assert.ok(!ids.has(kpi.id), `id repetido ${kpi.id}`);
    ids.add(kpi.id);
    assert.ok(kpi.formula && kpi.unit && kpi.window && kpi.sources.length, `${kpi.id} sin operacionalizar`);
    assert.ok(kpi.origin, `${kpi.id} sin origen del umbral`);
    assert.ok(doc.includes(`### ${kpi.id}. ${kpi.name}`), kpi.id);
  }
  for (const dimension of ["tecnico", "ux", "pedagogico"]) {
    assert.ok(KPI_CATALOG.some((kpi) => kpi.dimension === dimension && kpi.primary), `falta KPI principal ${dimension}`);
  }
});

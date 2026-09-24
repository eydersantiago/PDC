import assert from "node:assert/strict";
import fsp from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { renderTelemetryDictionaryMarkdown } from "../../src/services/telemetry-dictionary-doc.js";
import { EVENT_CATALOG } from "../../src/services/telemetry-catalog.js";

test("diccionario de telemetria: el documento esta al dia con el catalogo", async () => {
  const doc = await fsp.readFile(path.resolve(process.cwd(), "docs/telemetria/diccionario-eventos.md"), "utf8");
  assert.equal(doc, renderTelemetryDictionaryMarkdown(), "Regenera con: npm run telemetria:diccionario");
  for (const entry of EVENT_CATALOG) {
    assert.ok(doc.includes(`\`${entry.eventType}\``), entry.eventType);
  }
});

import assert from "node:assert/strict";
import test from "node:test";
import { readIntArg } from "../../scripts/lib/cli.js";

/**
 * Regresion: sin la opcion, readIntArg tomaba 0 y lo subia al minimo. Con
 * telemetria:purgar eso era retener 1 dia en lugar de TELEMETRY_RETENTION_DAYS.
 */
test("cli: readIntArg usa el valor por defecto cuando falta la opcion", () => {
  const original = process.argv;
  try {
    process.argv = ["node", "script.ts"];
    assert.equal(readIntArg("dias", 365, 1, 3650), 365);
    process.argv = ["node", "script.ts", "--dias="];
    assert.equal(readIntArg("dias", 365, 1, 3650), 365);
    process.argv = ["node", "script.ts", "--dias=180"];
    assert.equal(readIntArg("dias", 365, 1, 3650), 180);
    process.argv = ["node", "script.ts", "--dias=0"];
    assert.equal(readIntArg("dias", 365, 1, 3650), 1, "un valor explicito fuera de rango se acota");
    process.argv = ["node", "script.ts", "--dias=abc"];
    assert.equal(readIntArg("dias", 365, 1, 3650), 365);
  } finally {
    process.argv = original;
  }
});

import assert from "node:assert/strict";
import test from "node:test";
import type { Server } from "node:http";
import { createApp } from "../../src/app.js";
import { createDatabase, type AppDatabase } from "../../src/db/database.js";
import { setTextModelOverrideForTests } from "../../src/services/agent-mode.js";

/**
 * /suggest-tab con el codigo bajo demanda de VS Code 0.0.34 (reunion del
 * 20/10/2026): "Modificar seleccion" pide la version mejorada del bloque
 * (requestedAction: replace) y el guardarrail cuenta las lineas que cambian.
 * Tambien: la pregunta de un VS Code anterior ya no pide un TODO y la salida
 * llega sin caracteres chinos.
 */

async function startTestServer() {
  const database = await createDatabase();
  const app = createApp(database);
  const server = await new Promise<Server>((resolve) => {
    const started = app.listen(0, () => resolve(started));
  });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("No se pudo iniciar servidor de prueba.");
  return { database, server, baseUrl: `http://127.0.0.1:${address.port}` };
}

async function stopTestServer(server: Server, database: AppDatabase) {
  await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  await database.close();
}

const CLIENT = { "x-adaceen-client-id": "vscode-codigo-0001" };

const SELECTION = [
  "double calcularArea(double base, double altura) {",
  "  if (base < 0) {",
  "    return 0;",
  "  }",
  "  double area = base * altura;",
  "  cout << area;",
  "  return area;",
  "}",
].join("\n");

const IMPROVED = SELECTION
  .replace("double area = base * altura;", "double area = base * altura / 2.0;")
  .replace("  cout << area;\n", "");

function body(extra: Record<string, unknown> = {}) {
  return {
    tab_content: `#include <iostream>\nusing namespace std;\n\n${SELECTION}\n\nint main() { return 0; }`,
    question: "El estudiante selecciono un bloque del editor. Al final, si es seguro, incluye un unico bloque de codigo corto para continuar. Si no es seguro, usa un comentario TODO del lenguaje.",
    tab_title: "src/area.cpp",
    tab_url: "vscode://alumno/taller/src/area.cpp",
    suggestion_scope: "cursor",
    filePath: "src/area.cpp",
    languageHint: "cpp",
    selection: SELECTION,
    selectionStartLine: 4,
    selectionEndLine: 11,
    trigger: "selection",
    ...extra,
  };
}

async function suggest(baseUrl: string, payload: unknown) {
  const response = await fetch(`${baseUrl}/suggest-tab`, {
    method: "POST",
    headers: { "Content-Type": "application/json; charset=utf-8", ...CLIENT },
    body: JSON.stringify(payload),
  });
  return { status: response.status, data: await response.json() as {
    ok: boolean;
    output_text: string;
    requested_action: string | null;
    code_application: { allowed: boolean; maxLines: number } | null;
    policy_applied: { helpStage: string } | null;
  } };
}

test("/suggest-tab: Modificar seleccion trae el bloque completo mejorado y se puede aplicar", async () => {
  const prompts: string[] = [];
  setTextModelOverrideForTests(async (input) => {
    prompts.push(input);
    if (/Pedido del estudiante: MEJORAR/.test(input)) {
      return ["1) Resumen:", "- El area de un triangulo es base por altura sobre dos.", "", "4) Accion:", "Aplicar: replace", "```cpp", IMPROVED, "```", "", "6) Riesgos:", "- Revisa las unidades."].join("\n");
    }
    return ["1) Resumen:", "- Calcula el área 计算 de la figura。", "", "2) Sugerencias del codigo:", "- Divide entre dos para el triángulo。", "", "4) Accion:", "Aplicar: insert", "```cpp", "  cout << \"Area: \" << area << endl;", "```"].join("\n");
  });
  const { server, database, baseUrl } = await startTestServer();
  try {
    const first = await suggest(baseUrl, body());
    assert.equal(first.status, 200);
    assert.equal(first.data.requested_action, null);
    assert.equal(first.data.policy_applied?.helpStage, "hint_1");
    assert.doesNotMatch(prompts[0], /comentario TODO del lenguaje/, "la pregunta vieja ya no pide un TODO");
    assert.match(prompts[0], /nunca un comentario TODO solo/);
    assert.doesNotMatch(first.data.output_text, /[一-鿿]/, "sin caracteres chinos");
    assert.match(first.data.output_text, /Calcula el área de la figura\./);

    const improved = await suggest(baseUrl, body({ requestedAction: "replace", trigger: "manual" }));
    assert.equal(improved.status, 200);
    assert.equal(improved.data.requested_action, "replace");
    assert.match(prompts[1], /Pedido del estudiante: MEJORAR el bloque seleccionado/);
    assert.match(prompts[1], /cambia como maximo 5 lineas/);
    // 7 lineas en el bloque, 2 cambiadas: el tope de la pista 1 (5) no lo recorta.
    assert.equal(improved.data.code_application?.maxLines, 5);
    assert.equal(improved.data.code_application?.allowed, true);
    assert.match(improved.data.output_text, /Aplicar: replace/);
    assert.match(improved.data.output_text, /base \* altura \/ 2\.0;/);
    assert.match(improved.data.output_text, /return area;\n\}/);
    assert.doesNotMatch(improved.data.output_text, /recortado por la politica/);

    // El pedido entra en la cache: la misma seleccion sin pedido no devuelve el reemplazo.
    const again = await suggest(baseUrl, body());
    assert.doesNotMatch(again.data.output_text, /Aplicar: replace/);

    const rows = await database.listTelemetryEvents();
    const decisions = rows.filter((row) => row.eventType === "tutor_decision" && row.channel === "vscode");
    assert.ok(decisions.some((row) => (row.metadata as Record<string, unknown>).requestedAction === "replace"));
  } finally {
    setTextModelOverrideForTests(null);
    await stopTestServer(server, database);
  }
});

test("/suggest-tab: «Otra sugerencia» y un pedido de codigo sin codigo vuelven a preguntar al modelo", async () => {
  let calls = 0;
  let withCode = false;
  setTextModelOverrideForTests(async () => {
    calls += 1;
    return withCode
      ? ["1) Resumen:", "- Version mejorada.", "", "Aplicar: replace", "```cpp", IMPROVED, "```"].join("\n")
      : ["1) Resumen:", "- Revisa el calculo del area.", "", "2) Sugerencias del codigo:", "- Divide entre dos."].join("\n");
  });
  const { server, database, baseUrl } = await startTestServer();
  try {
    // Pedidos automaticos: el segundo sale de la cache.
    await suggest(baseUrl, body());
    await suggest(baseUrl, body());
    assert.equal(calls, 1);
    // «Otra sugerencia» (trigger manual) pregunta otra vez.
    await suggest(baseUrl, body({ trigger: "manual" }));
    assert.equal(calls, 2);

    // «Proponer una mejora» que volvio sin codigo: no queda guardado.
    const first = await suggest(baseUrl, body({ requestedAction: "replace", trigger: "selection" }));
    assert.doesNotMatch(first.data.output_text, /```/);
    assert.equal(calls, 3);
    withCode = true;
    const retry = await suggest(baseUrl, body({ requestedAction: "replace", trigger: "selection" }));
    assert.equal(calls, 4, "el reintento llega al modelo");
    assert.match(retry.data.output_text, /Aplicar: replace/);
    // Con codigo si se guarda.
    await suggest(baseUrl, body({ requestedAction: "replace", trigger: "selection" }));
    assert.equal(calls, 4);
  } finally {
    setTextModelOverrideForTests(null);
    await stopTestServer(server, database);
  }
});

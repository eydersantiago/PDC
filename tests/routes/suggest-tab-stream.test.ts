import assert from "node:assert/strict";
import { gzipSync } from "node:zlib";
import type { Server } from "node:http";
import test from "node:test";
import { createApp } from "../../src/app.js";
import { env } from "../../src/config/env.js";
import { createDatabase, type AppDatabase } from "../../src/db/database.js";
import { setTextModelOverrideForTests, type TextModelOverride } from "../../src/services/tutor/agent-mode.js";

/**
 * /suggest-tab en vivo (01-11-2026, VS Code 0.0.39): con «Accept: application/x-ndjson» la prosa
 * sale por partes y al final el mismo objeto JSON de siempre. Decision de Eyder: texto en vivo,
 * codigo al final (ya recortado); nunca codigo ni lineas de la referencia del examen en vivo.
 * Codigo ficticio: nada de la solucion del taller (el repositorio es publico).
 */

type Json = Record<string, any>;
type StreamLine = { type: string; text?: string; status?: number; body?: Json; at: number };

async function startServer() {
  const database = await createDatabase();
  const app = createApp(database, {});
  const server = await new Promise<Server>((resolve) => {
    const started = app.listen(0, () => resolve(started));
  });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("sin puerto");
  return { database, server, baseUrl: `http://127.0.0.1:${address.port}` };
}

async function stopServer(server: Server, database: AppDatabase) {
  server.closeAllConnections?.();
  await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
  await database.close();
}

const SELECTION = ["int main(){", "    cout << \"Hola\";", "    return 0;", "}"].join("\n");
const PROPOSED = ["int main() {", "    cout << \"Hola\";", "    cout << \"Adios\";", "    return 0;", "}"].join("\n");

function answer(code: string | null) {
  return [
    "1) Resumen:",
    "- El main saluda y termina.",
    "",
    "2) Sugerencias del codigo:",
    "- Agrega una despedida antes del return.",
    "- Usa endl para que la salida quede en su linea.",
    "",
    "4) Accion:",
    "Aplicar: replace",
    ...(code ? ["```cpp", code, "```"] : []),
    "",
    "6) Riesgos:",
    "- Compila despues de cada cambio.",
  ].join("\n");
}

function body(extra: Record<string, unknown> = {}) {
  return {
    tab_content: `#include <iostream>\nusing namespace std;\n\n${SELECTION}\n`,
    question: "Mejora el bloque seleccionado.",
    tab_title: "src/main.cpp",
    tab_url: "vscode://alumno/taller/src/main.cpp",
    suggestion_scope: "cursor",
    filePath: "src/main.cpp",
    languageHint: "cpp",
    selection: SELECTION,
    trigger: "manual",
    requestedAction: "replace",
    ...extra,
  };
}

const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** Sustituto del modelo que escribe la respuesta por partes (como el worker) con pausas. */
function streamingModel(texts: string[], pauseMs = 120): { override: TextModelOverride; calls: () => number } {
  let calls = 0;
  const override: TextModelOverride = async (_input, _diagnostics, _generation, onPartial) => {
    const text = texts[Math.min(calls, texts.length - 1)];
    calls += 1;
    if (onPartial) {
      const lines = text.split("\n");
      let written = "";
      for (const line of lines) {
        written += `${line}\n`;
        onPartial(written);
        await delay(pauseMs / 4);
      }
      await delay(pauseMs);
    }
    return text;
  };
  return { override, calls: () => calls };
}

async function post(baseUrl: string, payload: unknown, headers: Record<string, string>, signal?: AbortSignal) {
  return fetch(`${baseUrl}/suggest-tab`, {
    method: "POST",
    headers: { "Content-Type": "application/json; charset=utf-8", ...headers },
    body: JSON.stringify(payload),
    signal,
  });
}

async function readStream(response: Response) {
  const lines: StreamLine[] = [];
  const reader = response.body!.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    let newline = buffer.indexOf("\n");
    while (newline >= 0) {
      const line = buffer.slice(0, newline).trim();
      buffer = buffer.slice(newline + 1);
      if (line) lines.push({ ...JSON.parse(line), at: Date.now() });
      newline = buffer.indexOf("\n");
    }
  }
  assert.equal(buffer.trim(), "", "la ultima linea termina en salto de linea");
  return lines;
}

/** decision_id es un uuid por pedido: lo demas tiene que ser igual. */
function comparable(reply: Json) {
  return { ...reply, decision_id: reply.decision_id ? "<uuid>" : reply.decision_id };
}

test("/suggest-tab NDJSON: prosa en vivo sin codigo ni «Aplicar:», y el final es el mismo JSON que sin la cabecera", async () => {
  const model = streamingModel([answer(PROPOSED)], 350);
  setTextModelOverrideForTests(model.override);
  const { server, database, baseUrl } = await startServer();
  try {
    const startedAt = Date.now();
    const response = await post(baseUrl, body(), { "x-adaceen-client-id": "vscode-stream-a", Accept: "application/x-ndjson, application/json;q=0.9" });
    assert.equal(response.status, 200);
    assert.match(String(response.headers.get("content-type")), /^application\/x-ndjson; charset=utf-8/);
    assert.equal(response.headers.get("cache-control"), "no-cache, no-transform");
    assert.equal(response.headers.get("x-accel-buffering"), "no");
    const lines = await readStream(response);
    const partials = lines.filter((line) => line.type === "partial");
    const final = lines.at(-1)!;
    assert.equal(final.type, "final", "la ultima linea es el final");
    assert.equal(lines.filter((line) => line.type === "final").length, 1);
    assert.equal(final.status, 200);
    assert.ok(partials.length >= 2, `parciales: ${partials.length}`);
    assert.ok(partials[0].at < final.at, "el primer parcial llega antes que el final");
    assert.ok(partials[0].at - startedAt < 2_000);
    for (const partial of partials) {
      assert.doesNotMatch(partial.text!, /```|cout <<|return 0;|Adios/, "nunca codigo en vivo");
      assert.doesNotMatch(partial.text!, /Aplicar/i);
    }
    for (let index = 1; index < partials.length; index += 1) {
      assert.ok(partials[index].text!.startsWith(partials[index - 1].text!), "la prosa solo crece");
    }
    assert.match(partials.at(-1)!.text!, /Agrega una despedida/);
    assert.match(final.body!.output_text, /```cpp/, "el codigo llega en el final");

    // El mismo pedido sin la cabecera (otro cliente: misma etapa) da el mismo objeto.
    const plain = await post(baseUrl, body(), { "x-adaceen-client-id": "vscode-stream-b" });
    assert.equal(plain.status, 200);
    assert.match(String(plain.headers.get("content-type")), /^application\/json/);
    const plainBody = await plain.json() as Json;
    assert.deepEqual(comparable(final.body!), comparable(plainBody));
    assert.deepEqual(Object.keys(final.body!), Object.keys(plainBody), "mismas claves, mismo orden");

    // Telemetria: streamed y firstPartialMs solo en el pedido en vivo.
    await delay(50);
    const decisions = (await database.listTelemetryEvents()).filter((row) => row.eventType === "tutor_decision");
    const streamed = decisions.filter((row) => (row.metadata as Json).streamed === true);
    assert.equal(streamed.length, 1);
    const firstPartialMs = (streamed[0].metadata as Json).firstPartialMs;
    assert.ok(Number.isInteger(firstPartialMs) && firstPartialMs >= 0 && firstPartialMs <= (streamed[0].latencyMs ?? Infinity), `firstPartialMs ${firstPartialMs}`);
    assert.ok(decisions.some((row) => !("streamed" in (row.metadata as Json))), "sin la cabecera no se marca");
  } finally {
    setTextModelOverrideForTests(null);
    await stopServer(server, database);
  }
});

test("/suggest-tab NDJSON: el reintento de un pedido de codigo manda «restart» y el final trae el codigo del reintento", async () => {
  const model = streamingModel([answer(null), answer(PROPOSED)], 340);
  setTextModelOverrideForTests(model.override);
  const { server, database, baseUrl } = await startServer();
  try {
    const response = await post(baseUrl, body(), { "x-adaceen-client-id": "vscode-stream-retry", Accept: "application/x-ndjson" });
    const lines = await readStream(response);
    assert.equal(model.calls(), 2, "hubo reintento");
    const types = lines.map((line) => line.type);
    const restart = types.indexOf("restart");
    assert.ok(restart > 0, `restart despues de algun parcial: ${types.join(",")}`);
    assert.equal(types.filter((type) => type === "restart").length, 1);
    assert.ok(types.slice(0, restart).every((type) => type === "partial"));
    assert.ok(types.slice(restart + 1, -1).every((type) => type === "partial"));
    assert.equal(types.at(-1), "final");
    const final = lines.at(-1)!.body!;
    assert.match(final.output_text, /```cpp/);
    for (const line of lines.filter((item) => item.type === "partial")) {
      assert.doesNotMatch(line.text!, /```|Aplicar|cout <</);
    }
  } finally {
    setTextModelOverrideForTests(null);
    await stopServer(server, database);
  }
});

test("/suggest-tab NDJSON: caminos rapidos (cache, sin modelo, error de pedido) mandan solo el final", async () => {
  const { server, database, baseUrl } = await startServer();
  try {
    // Sin tab_content: el 400 de siempre, ahora dentro del final.
    const invalid = await post(baseUrl, { question: "x" }, { Accept: "application/x-ndjson" });
    assert.equal(invalid.status, 400);
    const invalidLines = await readStream(invalid);
    assert.deepEqual(invalidLines.map((line) => line.type), ["final"]);
    assert.equal(invalidLines[0].status, 400);
    assert.deepEqual(invalidLines[0].body, { ok: false, error: "tab_content requerido" });

    // Sin modelo (degradado): solo el final, con degraded.
    setTextModelOverrideForTests(async () => {
      throw new Error("sin GPU");
    });
    const degraded = await post(baseUrl, body({ requestedAction: undefined, trigger: "selection" }), { "x-adaceen-client-id": "vscode-stream-deg", Accept: "application/x-ndjson" });
    const degradedLines = await readStream(degraded);
    assert.deepEqual(degradedLines.map((line) => line.type), ["final"]);
    assert.equal(degradedLines[0].body!.degraded, true);

    // Cache: un pedido automatico igual a uno anterior sale de la cache sin parciales.
    const model = streamingModel([answer(PROPOSED)], 40);
    setTextModelOverrideForTests(model.override);
    const automatic = body({ requestedAction: undefined, trigger: "selection" });
    await readStream(await post(baseUrl, automatic, { "x-adaceen-client-id": "vscode-stream-cache", Accept: "application/x-ndjson" }));
    const cached = await readStream(await post(baseUrl, automatic, { "x-adaceen-client-id": "vscode-stream-cache", Accept: "application/x-ndjson" }));
    assert.deepEqual(cached.map((line) => line.type), ["final"]);
    assert.equal(cached[0].body!.cached, true);
    assert.equal(model.calls(), 1);
  } finally {
    setTextModelOverrideForTests(null);
    await stopServer(server, database);
  }
});

test("/suggest-tab NDJSON con la referencia del examen: ninguna linea de la solucion en vivo", async () => {
  const previous = { b64: env.examReferenceB64, mode: env.examReferenceSwitch };
  const referenceCode = [
    "#include \"Caja.h\"",
    "bool Caja::sacar(double monto) {",
    "    if (monto > total) return false;",
    "    total = total - monto;",
    "    return true;",
    "}",
  ].join("\n");
  const reference = {
    version: 1,
    examen: "prueba",
    repo: "eydersantiago/sistema-bancario-fpoo",
    plan: "Plan de prueba",
    errores: "Errores de prueba",
    pasos: [{ id: "caja", titulo: "Paso caja", archivos: ["src/Caja.cpp"], apoyo: [], guia: "Implementa sacar con la validacion." }],
    archivos: { "src/Caja.cpp": referenceCode },
  };
  env.examReferenceB64 = gzipSync(Buffer.from(JSON.stringify(reference), "utf8")).toString("base64");
  env.examReferenceSwitch = "";
  const leaky = [
    "1) Resumen:",
    "- Falta validar el monto antes de restar.",
    "- if (monto > total) return false;",
    "- Usa `total = total - monto;` despues de validar.",
    "- La linea clave es if (monto > total) return false; al comienzo.",
    "",
    "2) Sugerencias del codigo:",
    "- Piensa que pasa si el monto supera el total.",
    "",
    "Aplicar: insert",
    "```cpp",
    "    if (monto > total) return false;",
    "```",
  ].join("\n");
  setTextModelOverrideForTests(streamingModel([leaky], 340).override);
  const { server, database, baseUrl } = await startServer();
  try {
    const login = await fetch(`${baseUrl}/api/auth/login`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email: "estudiante@adaceen.edu.co", password: "Estudiante123!" }),
    });
    const sessionId = String(((await login.json()) as Json).session?.id || "");
    assert.ok(sessionId);
    const examBody = body({
      requestedAction: "insert",
      selection: "",
      tab_title: "src/Caja.cpp",
      filePath: "src/Caja.cpp",
      repoFullName: "eydersantiago/sistema-bancario-fpoo",
      tab_url: "vscode://eydersantiago/sistema-bancario-fpoo/src/Caja.cpp",
    });
    const lines = await readStream(await post(baseUrl, examBody, { "x-session-id": sessionId, "x-adaceen-client-id": "vscode-stream-exam", Accept: "application/x-ndjson" }));
    const partials = lines.filter((line) => line.type === "partial");
    assert.ok(partials.length >= 1);
    for (const partial of partials) {
      for (const codeLine of referenceCode.split("\n")) {
        assert.ok(!partial.text!.includes(codeLine.trim()), `en vivo: ${codeLine.trim()}`);
      }
      assert.doesNotMatch(partial.text!, /monto > total|total - monto/);
    }
    assert.match(partials.at(-1)!.text!, /Falta validar el monto/);
    assert.equal(lines.at(-1)!.type, "final");
  } finally {
    setTextModelOverrideForTests(null);
    env.examReferenceB64 = previous.b64;
    env.examReferenceSwitch = previous.mode;
    await stopServer(server, database);
  }
});

test("/suggest-tab NDJSON: si VS Code corta la conexion, el pedido termina sin escribir y sin colgar el servidor", async () => {
  let finished = false;
  const override: TextModelOverride = async (_input, _diagnostics, _generation, onPartial) => {
    onPartial?.("1) Resumen:\n- Primera linea.\n");
    await delay(300);
    onPartial?.("1) Resumen:\n- Primera linea.\n- Segunda linea.\n");
    await delay(100);
    finished = true;
    return answer(PROPOSED);
  };
  setTextModelOverrideForTests(override);
  const { server, database, baseUrl } = await startServer();
  try {
    const controller = new AbortController();
    const response = await post(baseUrl, body(), { "x-adaceen-client-id": "vscode-stream-close", Accept: "application/x-ndjson" }, controller.signal);
    const reader = response.body!.getReader();
    const first = await reader.read();
    assert.match(new TextDecoder().decode(first.value), /"type":"partial"/);
    controller.abort();
    await reader.cancel().catch(() => {});
    await delay(700);
    assert.equal(finished, true, "el modelo termino");
    const decisions = (await database.listTelemetryEvents()).filter((row) => row.eventType === "tutor_decision");
    assert.equal(decisions.length, 1, "la decision se registra igual");
    // El servidor sigue atendiendo.
    const again = await post(baseUrl, body(), { "x-adaceen-client-id": "vscode-stream-close-2" });
    assert.equal(again.status, 200);
  } finally {
    setTextModelOverrideForTests(null);
    await stopServer(server, database);
  }
});

test("/suggest-tab NDJSON: con VS Code ya desconectado, un pedido de codigo sin codigo no se reintenta", async () => {
  let calls = 0;
  const override: TextModelOverride = async (_input, _diagnostics, _generation, onPartial) => {
    calls += 1;
    onPartial?.("1) Resumen:\n- Primera linea.\n");
    await delay(300);
    return answer(null);
  };
  setTextModelOverrideForTests(override);
  const { server, database, baseUrl } = await startServer();
  try {
    const controller = new AbortController();
    const response = await post(baseUrl, body(), { "x-adaceen-client-id": "vscode-stream-close-retry", Accept: "application/x-ndjson" }, controller.signal);
    const reader = response.body!.getReader();
    await reader.read();
    controller.abort();
    await reader.cancel().catch(() => {});
    await delay(600);
    assert.equal(calls, 1, "sin reintento: nadie lo iba a leer");
  } finally {
    setTextModelOverrideForTests(null);
    await stopServer(server, database);
  }
});

test("/suggest-tab NDJSON: un job reintentado en otro worker manda «restart» y la prosa del intento fallido no sigue en pantalla", async () => {
  const override: TextModelOverride = async (_input, _diagnostics, _generation, onPartial) => {
    onPartial?.("1) Resumen:\n- Del intento que fallo.\n");
    await delay(350);
    onPartial?.("1) Resumen:\n", { restarted: true });
    await delay(350);
    onPartial?.("1) Resumen:\n- Del intento nuevo.\n");
    await delay(350);
    return answer(PROPOSED);
  };
  setTextModelOverrideForTests(override);
  const { server, database, baseUrl } = await startServer();
  try {
    const lines = await readStream(await post(baseUrl, body(), { "x-adaceen-client-id": "vscode-stream-attempt", Accept: "application/x-ndjson" }));
    const types = lines.map((line) => line.type);
    const restart = types.indexOf("restart");
    assert.ok(restart > 0, types.join(","));
    assert.ok(lines.slice(0, restart).some((line) => /intento que fallo/.test(line.text || "")));
    for (const line of lines.slice(restart + 1).filter((item) => item.type === "partial")) {
      assert.doesNotMatch(line.text!, /intento que fallo/);
    }
    assert.match(lines.filter((line) => line.type === "partial").at(-1)!.text!, /intento nuevo/);
    assert.equal(types.at(-1), "final");

    // Sin nada mostrado antes, el reinicio no escribe «restart».
    setTextModelOverrideForTests(async (_input, _diagnostics, _generation, onPartial) => {
      onPartial?.("1) Resumen:\n- Hola.\n", { restarted: true });
      await delay(50);
      return answer(PROPOSED);
    });
    const quiet = await readStream(await post(baseUrl, body(), { "x-adaceen-client-id": "vscode-stream-attempt-2", Accept: "application/x-ndjson" }));
    assert.equal(quiet.some((line) => line.type === "restart"), false);
  } finally {
    setTextModelOverrideForTests(null);
    await stopServer(server, database);
  }
});

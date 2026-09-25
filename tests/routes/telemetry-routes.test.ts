import assert from "node:assert/strict";
import test from "node:test";
import type { Server } from "node:http";
import { createApp } from "../../src/app.js";
import { createDatabase, type AppDatabase } from "../../src/db/database.js";
import { EXPORT_COLUMNS } from "../../src/services/telemetry.js";

/**
 * A4.5 / A7.1 / A7.2 / A7.6: eventos del piloto sin sesion (cliente
 * anonimo), exportacion seudonimizada solo para docentes, revision de
 * calidad del conjunto y retencion.
 */

async function startTestServer() {
  const database = await createDatabase();
  const app = createApp(database);
  const server = await new Promise<Server>((resolve) => {
    const started = app.listen(0, () => resolve(started));
  });
  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("No se pudo iniciar servidor de prueba.");
  }
  return { database, server, baseUrl: `http://127.0.0.1:${address.port}` };
}

async function stopTestServer(server: Server, database: AppDatabase) {
  await new Promise<void>((resolve, reject) => {
    server.close((error) => error ? reject(error) : resolve());
  });
  await database.close();
}

async function login(baseUrl: string, email: string, password: string) {
  const response = await fetch(`${baseUrl}/api/auth/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json; charset=utf-8" },
    body: JSON.stringify({ email, password }),
  });
  const data = await response.json() as { session?: { id?: string } };
  assert.equal(response.status, 200);
  return String(data.session?.id || "");
}

const CLIENT_ID = "overlay-piloto-7f3a9c";
const RAW_ERROR = "/home/ana/taller/main.cpp:12:5: error: 'total' was not declared in this scope";

function overlayEvent(seq: number, extra: Record<string, unknown> = {}) {
  return {
    source: "browser_extension",
    category: "tutor",
    eventType: "overlay_opened",
    schemaVersion: "1.1",
    clientSessionId: "sesion-overlay-1",
    seq,
    pageContext: "github",
    ...extra,
  };
}

async function postEvents(baseUrl: string, events: unknown[], headers: Record<string, string>) {
  const response = await fetch(`${baseUrl}/api/behavior/events`, {
    method: "POST",
    headers: { "Content-Type": "application/json; charset=utf-8", ...headers },
    body: JSON.stringify({ events }),
  });
  return { status: response.status, data: await response.json() as { ok: boolean; stored?: number; flags?: Array<{ index: number; code: string }> } };
}

test("telemetria: el piloto registra eventos sin sesion y nunca guarda el texto del error", async () => {
  const { server, database, baseUrl } = await startTestServer();
  try {
    const noIdentity = await postEvents(baseUrl, [overlayEvent(1)], {});
    assert.equal(noIdentity.status, 401, "Q2: sin actor se rechaza");
    const badClient = await postEvents(baseUrl, [overlayEvent(1)], { "x-adaceen-client-id": "corto" });
    assert.equal(badClient.status, 401);
    const badSchema = await postEvents(baseUrl, [{ ...overlayEvent(1), campoLibre: "x" }], { "x-adaceen-client-id": CLIENT_ID });
    assert.equal(badSchema.status, 400, "Q1: esquema estricto");

    const stored = await postEvents(baseUrl, [
      overlayEvent(1),
      overlayEvent(2, { eventType: "error_detected", category: "signal", errorText: RAW_ERROR, filePath: "src/main.cpp" }),
      overlayEvent(4, { eventType: "tutor_response_shown" }),
      overlayEvent(5, { eventType: "evento_nuevo_sin_catalogo" }),
    ], { "x-adaceen-client-id": CLIENT_ID });
    assert.equal(stored.status, 200);
    assert.equal(stored.data.stored, 4);
    const codes = (stored.data.flags || []).map((flag) => `${flag.index}:${flag.code}`);
    assert.ok(codes.includes("1:Q9_texto_descartado"));
    assert.ok(codes.includes("2:Q8_sin_decision"));
    assert.ok(codes.includes("3:Q3_evento_desconocido"));

    const rows = await database.listTelemetryEvents();
    assert.equal(rows.length, 4);
    assert.ok(rows.every((row) => row.actorKind === "client" && row.channel === "overlay"));
    const serialized = JSON.stringify(rows);
    assert.ok(!serialized.includes(CLIENT_ID));
    assert.ok(!serialized.includes("was not declared"));
    assert.ok(!serialized.includes("src/main.cpp"));
    const errorRow = rows.find((row) => row.eventType === "error_detected");
    assert.match(String(errorRow?.errorHash), /^[0-9a-f]{16}$/);
    assert.equal(errorRow?.fileExt, ".cpp");

    // Con sesion tambien se guarda en el historial del docente y en la tabla seudonimizada.
    const sessionId = await login(baseUrl, "estudiante@adaceen.edu.co", "Estudiante123!");
    const withSession = await postEvents(baseUrl, [
      { source: "vscode_extension", category: "suggestion", eventType: "vscode_suggestion_shown", schemaVersion: "1.1", decisionId: "d-1" },
    ], { "x-session-id": sessionId });
    assert.equal(withSession.status, 200);
    const all = await database.listTelemetryEvents();
    assert.equal(all.length, 5);
    assert.equal(all.filter((row) => row.actorKind === "user").length, 1);
  } finally {
    await stopTestServer(server, database);
  }
});

test("telemetria: exportacion y calidad solo para docentes, catalogo publico y retencion", async () => {
  const { server, database, baseUrl } = await startTestServer();
  try {
    await postEvents(baseUrl, [overlayEvent(1), overlayEvent(2), overlayEvent(4), overlayEvent(4)], { "x-adaceen-client-id": CLIENT_ID });

    const teacher = await login(baseUrl, "docente@adaceen.edu.co", "Docente123!");
    const student = await login(baseUrl, "estudiante@adaceen.edu.co", "Estudiante123!");

    const forbidden = await fetch(`${baseUrl}/api/telemetry/export`, { headers: { "x-session-id": student } });
    assert.equal(forbidden.status, 403);
    const anonymous = await fetch(`${baseUrl}/api/telemetry/quality`);
    assert.equal(anonymous.status, 403);

    const jsonl = await fetch(`${baseUrl}/api/telemetry/export?format=jsonl`, { headers: { "x-session-id": teacher } });
    assert.equal(jsonl.status, 200);
    const records = (await jsonl.text()).trim().split("\n").map((line) => JSON.parse(line) as Record<string, unknown>);
    assert.equal(records.length, 4);
    assert.deepEqual(Object.keys(records[0]), EXPORT_COLUMNS);
    assert.ok(!JSON.stringify(records).includes(CLIENT_ID));

    const csv = await fetch(`${baseUrl}/api/telemetry/export?format=csv`, { headers: { "x-session-id": teacher } });
    assert.match(String(csv.headers.get("content-type")), /text\/csv/);
    assert.equal((await csv.text()).split("\n")[0], EXPORT_COLUMNS.join(","));

    const badDate = await fetch(`${baseUrl}/api/telemetry/export?since=ayer`, { headers: { "x-session-id": teacher } });
    assert.equal(badDate.status, 400);

    const quality = await fetch(`${baseUrl}/api/telemetry/quality`, { headers: { "x-session-id": teacher } });
    const report = await quality.json() as {
      report: { eventLoss: { expected: number; received: number; missing: number }; integrity: Record<string, { count: number }> };
      rules: unknown[];
    };
    assert.deepEqual(report.report.eventLoss, { clientSessions: 1, expected: 4, received: 3, missing: 1, rate: 0.25 });
    assert.equal(report.report.integrity.I2_duplicados.count, 1);
    assert.equal(report.rules.length, 15);

    const catalog = await (await fetch(`${baseUrl}/api/telemetry/catalog`)).json() as { events: Array<{ eventType: string }>; fields: unknown[] };
    assert.ok(catalog.events.some((entry) => entry.eventType === "tutor_decision"));
    assert.equal(catalog.fields.length, EXPORT_COLUMNS.length);

    // Retencion (scripts/purgar-telemetria.ts): borra lo anterior a la fecha de corte.
    const removed = await database.deleteTelemetryEventsBefore(new Date(Date.now() + 60_000));
    assert.equal(removed, 4);
    assert.equal((await database.listTelemetryEvents()).length, 0);
  } finally {
    await stopTestServer(server, database);
  }
});

test("telemetria: la alerta de sesiones sin usuario cuenta VS Code, no el overlay abierto antes de iniciar sesion", async () => {
  const { server, database, baseUrl } = await startTestServer();
  try {
    // P1.2: el overlay se abre (overlay_opened) antes de iniciar sesion; P2.1 deja otro con la sesion vencida.
    await postEvents(baseUrl, [overlayEvent(1)], { "x-adaceen-client-id": CLIENT_ID });
    await postEvents(baseUrl, [overlayEvent(1, { clientSessionId: "sesion-overlay-2" })], {
      "x-adaceen-client-id": "overlay-piloto-segundo",
      "x-session-id": "sesion-vencida-del-navegador",
    });
    const teacher = await login(baseUrl, "docente@adaceen.edu.co", "Docente123!");
    const kpis = async () => {
      const response = await fetch(`${baseUrl}/api/telemetry/kpis`, { headers: { "x-session-id": teacher } });
      assert.equal(response.status, 200);
      return (await response.json() as { activity: { events: number; anonymousClientSessions: number } }).activity;
    };
    const before = await kpis();
    assert.equal(before.events, 2);
    assert.equal(before.anonymousClientSessions, 0, "los overlays sin sesion no disparan la alerta de VS Code");

    // VS Code sin sesion (la sesion compartida no llego): esa si es la alerta.
    await postEvents(baseUrl, [
      { source: "vscode_extension", category: "signal", eventType: "compile_error_detected", schemaVersion: "1.1", clientSessionId: "vs-anonimo", seq: 1 },
    ], { "x-adaceen-client-id": "vscode-piloto-3b8e1d" });
    const after = await kpis();
    assert.equal(after.events, 3);
    assert.equal(after.anonymousClientSessions, 1);
  } finally {
    await stopTestServer(server, database);
  }
});

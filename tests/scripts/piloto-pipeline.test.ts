import assert from "node:assert/strict";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { renderComplianceChecklistMarkdown } from "../../src/services/compliance-checklist.js";
import { parseCsvRecords } from "../../src/services/csv.js";
import { startInProcessBackend } from "../../scripts/lib/cli.js";
import { PRIVACY_POLICY_VERSION } from "../../src/routes/privacy-policy-routes.js";
import { backendChecks, staticChecks } from "../../scripts/lib/cumplimiento.js";
import { decodeRecordText, readManualRecordFiles, renderManualOriginSection } from "../../scripts/lib/piloto.js";
import { runPilotSimulation } from "../../scripts/lib/simulacion-piloto.js";
import { computeKpis, readManualRecords } from "../../src/services/kpis.js";

/**
 * A13.6 (parte automatizable) y A14.2-A14.4: el ensayo tecnico recorre la
 * cadena completa del piloto y todas sus comprobaciones deben pasar.
 * A13.4: la verificacion automatica detecta lo que falta en un backend sin
 * configurar para el piloto. A14.4 y A14.7: los KPIs manuales salen de las
 * plantillas llenas, con cada fila trazada.
 */

test("ensayo tecnico del piloto: de la sesion simulada al informe de KPIs", async () => {
  const outDir = await fsp.mkdtemp(path.join(os.tmpdir(), "adaceen-ensayo-"));
  try {
    const result = await runPilotSimulation({ students: 6, seed: "prueba-automatica", outDir });
    for (const check of result.checks) assert.ok(check.ok, `${check.name}: ${check.detail}`);
    assert.equal(result.checks.length, 12);
    const report = await fsp.readFile(path.join(outDir, "analisis", "informe-kpis.md"), "utf8");
    assert.match(report, /Datos simulados/);
    assert.match(report, /## 8\. Trazabilidad KPI → hallazgo → evidencia/);
    assert.match(report, /## 9\. Origen de los KPIs manuales/);
    assert.match(report, /\| T10\. Tiempo de instalación \| 14 min \| plantilla \| `tiempos-instalacion\.csv` \| 4 \| 1 \|/);
    const traceability = await fsp.readFile(path.join(outDir, "analisis", "trazabilidad.csv"), "utf8");
    assert.equal(traceability.trim().split("\n").length, 1 + result.kpis.length);
    const traceRows = parseCsvRecords(traceability);
    const t10 = traceRows.find((row) => row.kpi === "T10");
    assert.match(t10?.evidencia || "", /tiempos-instalacion\.csv; registros-manuales\.csv/, "el KPI manual cita la plantilla de la que sale");
    const t1 = traceRows.find((row) => row.kpi === "T1");
    assert.match(t1?.hallazgo || "", /^H1: Hallazgo sintético H1/, "hallazgos.csv llena la columna hallazgo de sus KPIs");
    assert.match(t1?.accion || "", /H1: Mejora sintética H1 \(implementada\)/);
    const records = parseCsvRecords(await fsp.readFile(path.join(outDir, "analisis", "registros-manuales.csv"), "utf8"));
    assert.deepEqual(Object.keys(records[0]), ["kpi", "archivo", "fila", "estado", "valor", "motivo"]);
    const discarded = records.filter((row) => row.estado === "descartada");
    assert.deepEqual(discarded.map((row) => `${row.kpi} ${row.archivo} ${row.fila}`), ["T10 tiempos-instalacion.csv 6"]);
    assert.ok(await fsp.stat(path.join(outDir, "registros", "cumplimiento.csv")), "las plantillas sintéticas quedan escritas");
    const dataset = await fsp.readFile(path.join(outDir, "dataset", "dataset.csv"), "utf8");
    assert.ok(!dataset.includes("@piloto.test"), "el dataset no lleva correos");
    assert.ok(!dataset.includes("was not declared"), "el dataset no lleva el texto de los errores");
  } finally {
    await fsp.rm(outDir, { recursive: true, force: true });
  }
});

test("cumplimiento: el documento esta al dia y la verificacion detecta un backend sin preparar", async () => {
  const doc = await fsp.readFile(path.resolve(process.cwd(), "docs/piloto/checklist-cumplimiento.md"), "utf8");
  assert.equal(doc, renderComplianceChecklistMarkdown(), "Regenera con: npm run piloto:checklist");

  const repo = await staticChecks();
  for (const id of ["C03", "C04", "C06", "C09", "C17", "C25"]) assert.equal(repo[id]?.status, "cumple", `${id}: ${repo[id]?.detail}`);

  const backend = await startInProcessBackend();
  try {
    const results = await backendChecks(backend.baseUrl);
    assert.equal(results.C20.status, "no cumple", "las cuentas demo entran en el backend de prueba");
    assert.equal(results.C21.status, "no cumple", "base en memoria");
    assert.equal(results.C18.status, "no cumple", "sin HTTPS");
    assert.equal(results.C10.status, "cumple");
    assert.equal(results.C24.status, "no verificado", "sin --email ni --password no crea sesiones");
    assert.equal(results.C25, undefined, "C25 queda con la revision del codigo");
  } finally {
    await backend.close();
  }
});

test("registros: una hoja de Excel en Windows-1252 se lee bien y la seccion 9 lista las hojas ignoradas", async () => {
  // «Sí» en Windows-1252 (Excel «CSV (delimitado por comas)»): en UTF-8 llegaria como «S\uFFFD».
  const ansi = Buffer.from("id;hallazgo;kpis;critica;estado;accion\nH1;Latencia;T1;S\xed;implementada;Calentar\n", "latin1");
  assert.deepEqual(decodeRecordText(ansi), { text: "id;hallazgo;kpis;critica;estado;accion\nH1;Latencia;T1;Sí;implementada;Calentar\n", encoding: "windows-1252" });
  assert.equal(decodeRecordText(Buffer.from("fecha;severidad\n", "utf8")).encoding, "utf-8");
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), "adaceen-registros-"));
  try {
    await fsp.writeFile(path.join(dir, "hallazgos.csv"), ansi);
    await fsp.writeFile(path.join(dir, "cumplimiento.csv"), "id,estado\nC01,\n");
    await fsp.writeFile(path.join(dir, "cumplimiento-2026-10-20.csv"), "id,estado\nC01,cumple\n");
    const files = await readManualRecordFiles(dir);
    assert.equal(files.find((file) => file.name === "hallazgos.csv")?.encoding, "windows-1252");
    const records = readManualRecords(files);
    const kpis = computeKpis({ rows: [], manualSources: records.sources });
    assert.equal(kpis.find((kpi) => kpi.id === "P5")?.value, 100, "«Sí» cuenta como critica");
    const section = renderManualOriginSection(kpis, records);
    assert.match(section, /Hojas ignoradas enteras \(revisa que no sea la que querías usar\):\n\n- T11 · `cumplimiento\.csv`: sin ítems marcados; cuenta cumplimiento-2026-10-20\.csv\./);
  } finally {
    await fsp.rm(dir, { recursive: true, force: true });
  }
});

test("retiro de un participante: cuenta, borra sus datos y anonimiza la cuenta", async () => {
  const { withdrawParticipant } = await import("../../scripts/lib/retiro.js");
  const { pseudonymize } = await import("../../src/services/telemetry.js");
  const backend = await startInProcessBackend();
  try {
    const login = await fetch(`${backend.baseUrl}/api/auth/login`, {
      method: "POST",
      headers: { "Content-Type": "application/json; charset=utf-8" },
      body: JSON.stringify({ email: "estudiante@adaceen.edu.co", password: "Estudiante123!" }),
    }).then((response) => response.json()) as { session: { id: string } };
    const events = await fetch(`${backend.baseUrl}/api/behavior/events`, {
      method: "POST",
      headers: { "Content-Type": "application/json; charset=utf-8", "x-session-id": login.session.id },
      body: JSON.stringify({ events: [{ source: "vscode_extension", category: "signal", eventType: "compile_error_detected", schemaVersion: "1.1", clientSessionId: "vs-retiro", seq: 1, errorText: "error: x" }] }),
    });
    assert.equal(events.status, 200);
    // VS Code emparejado con un codigo (sesion editor) y otro codigo sin canjear.
    const pairingCode = async () => (await fetch(`${backend.baseUrl}/api/auth/editor/pairing-code`, {
      method: "POST",
      headers: { "Content-Type": "application/json; charset=utf-8", "x-session-id": login.session.id },
      body: "{}",
    }).then((response) => response.json()) as { code: string }).code;
    const claim = await fetch(`${backend.baseUrl}/api/auth/editor/claim`, {
      method: "POST",
      headers: { "Content-Type": "application/json; charset=utf-8" },
      body: JSON.stringify({ code: await pairingCode(), editorHost: "local" }),
    }).then((response) => response.json()) as { sessionId: string };
    assert.ok(claim.sessionId, "el canje del codigo crea la sesion de VS Code");
    await pairingCode();
    // Aceptacion de la politica de privacidad guardada en el backend (contrato (a) de 0.7.12).
    const privacy = await fetch(`${backend.baseUrl}/api/auth/privacy-acceptance`, {
      method: "POST",
      headers: { "Content-Type": "application/json; charset=utf-8", "x-session-id": login.session.id },
      body: JSON.stringify({ version: PRIVACY_POLICY_VERSION }),
    });
    assert.equal(privacy.status, 200);
    const editorMe = () => fetch(`${backend.baseUrl}/api/auth/me`, { headers: { "x-session-id": claim.sessionId } });
    assert.equal((await editorMe()).status, 200);
    const pool = backend.database.pool as unknown as Parameters<typeof withdrawParticipant>[0];
    const pairingRows = async () => Number((await pool.query<{ total: string | number }>(
      "select count(*) as total from editor_pairing_codes where user_id = $1", ["user-student-demo"],
    )).rows[0]?.total || 0);

    const dryRun = await withdrawParticipant(pool, { email: "Estudiante@adaceen.edu.co", confirm: false, salt: "sal-de-prueba" });
    assert.equal(dryRun.found, true);
    assert.equal(dryRun.actorAnonId, pseudonymize("user:user-student-demo"));
    assert.equal(dryRun.counts.telemetry_events, 1);
    assert.ok(dryRun.counts.user_behavior_events >= 1);
    assert.equal(dryRun.counts.editor_pairing_codes, 2, "el codigo canjeado y el que quedo sin usar");
    assert.equal(dryRun.counts.user_privacy_acceptances, 1, "la politica aceptada");
    assert.equal(dryRun.counts.app_sessions_editor_activas, 1);
    assert.equal(dryRun.counts.app_sessions_activas, 2, "la del navegador y la de VS Code");
    assert.equal((await backend.database.listTelemetryEvents()).length, 1, "la simulacion no borra");
    assert.equal(await pairingRows(), 2, "la simulacion no borra los codigos");
    assert.equal((await editorMe()).status, 200, "la simulacion no cierra la sesion de VS Code");

    await assert.rejects(() => withdrawParticipant(pool, { email: "estudiante@adaceen.edu.co", confirm: true, salt: "" }), /TELEMETRY_SALT/);
    const done = await withdrawParticipant(pool, { email: "estudiante@adaceen.edu.co", confirm: true, salt: "sal-de-prueba" });
    assert.equal(done.confirmed, true);
    assert.equal((await backend.database.listTelemetryEvents()).length, 0);
    assert.equal(await pairingRows(), 0, "se borran los codigos de emparejamiento");
    const privacyRows = await pool.query<{ total: string | number }>(
      "select count(*) as total from user_privacy_acceptances where user_id = $1", ["user-student-demo"],
    );
    assert.equal(Number(privacyRows.rows[0]?.total || 0), 0, "se borra la politica aceptada");
    const editorAfter = await editorMe();
    assert.equal(editorAfter.status, 401, "la sesion de VS Code queda cerrada");
    assert.equal(editorAfter.headers.get("x-adaceen-session"), "invalid");
    const again = await withdrawParticipant(pool, { email: "estudiante@adaceen.edu.co", confirm: false, salt: "sal-de-prueba" });
    assert.equal(again.found, false, "la cuenta queda anonimizada: el correo ya no existe");
    const relogin = await fetch(`${backend.baseUrl}/api/auth/login`, {
      method: "POST",
      headers: { "Content-Type": "application/json; charset=utf-8" },
      body: JSON.stringify({ email: "estudiante@adaceen.edu.co", password: "Estudiante123!" }),
    });
    assert.notEqual(relogin.status, 200, "la cuenta retirada no entra");
  } finally {
    await backend.close();
  }
});

test("cuentas demo (C20): se desactivan estudiante y docente, el administrador cambia de clave y seed() no lo revierte", async () => {
  const { closeDemoAccounts } = await import("../../scripts/lib/cuentas-demo.js");
  const { createDatabase } = await import("../../src/db/database.js");
  const database = await createDatabase();
  try {
    const pool = database.pool as unknown as Parameters<typeof closeDemoAccounts>[0];
    const adminBefore = await database.authenticateUser("admin@adaceen.edu.co", "Admin123!");
    const studentBefore = await database.authenticateUser("estudiante@adaceen.edu.co", "Estudiante123!");
    assert.ok(adminBefore && studentBefore, "la base recien sembrada trae las cuentas demo");

    const dryRun = await closeDemoAccounts(pool, { confirm: false });
    assert.deepEqual(dryRun.accounts.map((account) => `${account.email}:${account.action}`), [
      "admin@adaceen.edu.co:cambiar_clave",
      "docente@adaceen.edu.co:desactivar",
      "estudiante@adaceen.edu.co:desactivar",
    ]);
    assert.equal(dryRun.newAdminPassword, "");
    assert.ok(await database.getSession(studentBefore.id), "la simulacion no cambia nada");

    const done = await closeDemoAccounts(pool, { confirm: true });
    assert.match(done.newAdminPassword, /^[A-Za-z0-9_-]{16}$/);
    const publicLogins = async () => {
      const entered: string[] = [];
      for (const [email, password] of [["admin@adaceen.edu.co", "Admin123!"], ["docente@adaceen.edu.co", "Docente123!"], ["estudiante@adaceen.edu.co", "Estudiante123!"]]) {
        if (await database.authenticateUser(email, password)) entered.push(email);
      }
      return entered;
    };
    assert.deepEqual(await publicLogins(), [], "ninguna entra con la clave del repositorio");
    assert.equal(await database.getSession(adminBefore.id), null, "se cierran las sesiones del administrador demo");
    assert.equal(await database.getSession(studentBefore.id), null);
    assert.ok(await database.authenticateUser("admin@adaceen.edu.co", done.newAdminPassword), "el administrador sigue entrando con la clave nueva");

    // Cada arranque del backend vuelve a correr seed() ("on conflict do nothing"): no revierte nada.
    await (database as unknown as { seed(): Promise<void> }).seed();
    assert.deepEqual(await publicLogins(), []);
    const again = await closeDemoAccounts(pool, { confirm: false });
    assert.ok(again.accounts.every((account) => account.action === "ninguna"));
  } finally {
    await database.close();
  }
});

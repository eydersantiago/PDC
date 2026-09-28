import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import type { Server } from "node:http";
import { createApp } from "../../src/app.js";
import { createDatabase, type AppDatabase } from "../../src/db/database.js";
import { buildBitacoraTemplate } from "../../src/services/bitacora-template.js";

const EXCEL_MIME = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";

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

  return {
    database,
    server,
    baseUrl: `http://127.0.0.1:${address.port}`,
  };
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
  const data = await response.json() as { session?: { id?: string }; error?: string };
  assert.equal(response.status, 200, data.error);
  assert.ok(data.session?.id);
  return data.session;
}

async function buildBitacoraUploadForm(fileName: string, snapshotId: string) {
  const buffer = Buffer.from(await buildBitacoraTemplate({
    teacher: {
      id: "user-teacher-demo",
      displayName: "Docente Demo",
      email: "docente@adaceen.edu.co",
    },
  }));
  const form = new FormData();
  form.set("fileName", fileName);
  form.set("snapshotId", snapshotId);
  form.set("file", new Blob([new Uint8Array(buffer)], { type: EXCEL_MIME }), fileName);
  return form;
}

async function uploadBitacora(baseUrl: string, sessionId: string, fileName: string, snapshotId: string) {
  const response = await fetch(`${baseUrl}/api/documents/bitacora/import`, {
    method: "POST",
    headers: { "x-session-id": sessionId },
    body: await buildBitacoraUploadForm(fileName, snapshotId),
  });
  const data = await response.json() as { stored?: { id?: string; fileName?: string }; error?: string };
  assert.equal(response.status, 200, data.error);
  assert.ok(data.stored?.id);
  return data.stored;
}

async function getBitacoraStatus(baseUrl: string, sessionId: string) {
  const response = await fetch(`${baseUrl}/api/documents/bitacora/status`, {
    headers: { "x-session-id": sessionId },
  });
  const data = await response.json() as { loaded?: boolean; latest?: { fileName?: string } | null; summary?: { rows?: number } | null; error?: string };
  assert.equal(response.status, 200, data.error);
  return data;
}

test("docente puede eliminar bitacora actual y borrar todos sus datos de bitacora", async () => {
  const { server, database, baseUrl } = await startTestServer();
  try {
    const teacherSession = await login(baseUrl, "docente@adaceen.edu.co", "Docente123!");
    const studentSession = await login(baseUrl, "estudiante@adaceen.edu.co", "Estudiante123!");
    const teacherSessionId = String(teacherSession.id);
    const studentSessionId = String(studentSession.id);

    await uploadBitacora(baseUrl, teacherSessionId, "bitacora-a.xlsx", "bitacora-a");
    const loadedStatus = await getBitacoraStatus(baseUrl, teacherSessionId);
    assert.equal(loadedStatus.loaded, true);
    assert.equal(loadedStatus.latest?.fileName, "bitacora-a.xlsx");
    assert.ok((loadedStatus.summary?.rows || 0) >= 15);

    const studentVisibleStatus = await getBitacoraStatus(baseUrl, studentSessionId);
    assert.equal(studentVisibleStatus.loaded, true);
    assert.equal(studentVisibleStatus.latest?.fileName, "bitacora-a.xlsx");
    assert.ok((studentVisibleStatus.summary?.rows || 0) >= 15);

    const forbiddenDelete = await fetch(`${baseUrl}/api/documents/bitacora/latest`, {
      method: "DELETE",
      headers: { "x-session-id": studentSessionId },
    });
    assert.equal(forbiddenDelete.status, 403);

    const deleteLatest = await fetch(`${baseUrl}/api/documents/bitacora/latest`, {
      method: "DELETE",
      headers: { "x-session-id": teacherSessionId },
    });
    const latestResult = await deleteLatest.json() as { deletedCount?: number; deleted?: Array<{ fileName?: string }>; error?: string };
    assert.equal(deleteLatest.status, 200, latestResult.error);
    assert.equal(latestResult.deletedCount, 1);
    assert.equal(latestResult.deleted?.[0]?.fileName, "bitacora-a.xlsx");

    const emptyStatus = await getBitacoraStatus(baseUrl, teacherSessionId);
    assert.equal(emptyStatus.loaded, false);
    assert.equal(emptyStatus.latest, null);

    await uploadBitacora(baseUrl, teacherSessionId, "bitacora-b.xlsx", "bitacora-b");
    await uploadBitacora(baseUrl, teacherSessionId, "bitacora-c.xlsx", "bitacora-c");

    const deleteAll = await fetch(`${baseUrl}/api/documents/bitacora/data`, {
      method: "DELETE",
      headers: { "x-session-id": teacherSessionId },
    });
    const allResult = await deleteAll.json() as { deletedCount?: number; error?: string };
    assert.equal(deleteAll.status, 200, allResult.error);
    assert.equal(allResult.deletedCount, 2);

    const afterAllStatus = await getBitacoraStatus(baseUrl, teacherSessionId);
    assert.equal(afterAllStatus.loaded, false);
  } finally {
    await stopTestServer(server, database);
  }
});

test("0.7.15: exportar la bitacora cargada con el diseno de la plantilla (xlsx reimportable y csv)", async () => {
  const { server, database, baseUrl } = await startTestServer();
  try {
    const teacherSession = await login(baseUrl, "docente@adaceen.edu.co", "Docente123!");
    const studentSession = await login(baseUrl, "estudiante@adaceen.edu.co", "Estudiante123!");
    const teacherSessionId = String(teacherSession.id);

    // Sin bitacora: 404 con mensaje; estudiante: 403; formato raro: 400.
    const empty = await fetch(`${baseUrl}/api/documents/bitacora/export`, { headers: { "x-session-id": teacherSessionId } });
    assert.equal(empty.status, 404);
    assert.equal((await fetch(`${baseUrl}/api/documents/bitacora/export`, { headers: { "x-session-id": String(studentSession.id) } })).status, 403);
    assert.equal((await fetch(`${baseUrl}/api/documents/bitacora/export?format=pdf`, { headers: { "x-session-id": teacherSessionId } })).status, 400);

    await uploadBitacora(baseUrl, teacherSessionId, "bitacora-export.xlsx", "bitacora-export");
    const status = await getBitacoraStatus(baseUrl, teacherSessionId);
    const importedRows = status.summary?.rows || 0;
    assert.ok(importedRows >= 15);

    // CSV: cabecera de la plantilla, BOM y «;».
    const csvResponse = await fetch(`${baseUrl}/api/documents/bitacora/export?format=csv&courseCode=FPOO`, { headers: { "x-session-id": teacherSessionId } });
    const csvBytes = Buffer.from(await csvResponse.arrayBuffer());
    assert.equal(csvResponse.status, 200);
    assert.match(csvResponse.headers.get("content-type") || "", /text\/csv/);
    assert.match(csvResponse.headers.get("content-disposition") || "", /bitacora_fpoo_\d{4}-\d{2}-\d{2}\.csv/);
    assert.deepEqual([...csvBytes.subarray(0, 3)], [0xef, 0xbb, 0xbf], "BOM para que Excel lea UTF-8");
    const csv = csvBytes.subarray(3).toString("utf8");
    assert.ok(csv.startsWith("Semana;Fecha;Tema;Clasificación;Actividades en clase;Actividades evaluación\r\n"));
    const csvLines = csv.trim().split(/\r?\n/);
    assert.ok(csvLines.length >= 15, `filas csv: ${csvLines.length}`);
    assert.match(csv, /Programación orientada a objetos|POO|clase/i);

    // XLSX: hoja Bitacora con las mismas columnas y filas, y se vuelve a importar igual.
    const xlsxResponse = await fetch(`${baseUrl}/api/documents/bitacora/export`, { headers: { "x-session-id": teacherSessionId } });
    assert.equal(xlsxResponse.status, 200);
    assert.equal(xlsxResponse.headers.get("content-type"), EXCEL_MIME);
    assert.match(xlsxResponse.headers.get("content-disposition") || "", /bitacora_fpoo_\d{4}-\d{2}-\d{2}\.xlsx/);
    const xlsxBuffer = Buffer.from(await xlsxResponse.arrayBuffer());
    const ExcelJS = (await import("exceljs")).default;
    const workbook = new ExcelJS.Workbook();
    await workbook.xlsx.load(xlsxBuffer as unknown as ArrayBuffer);
    const sheet = workbook.getWorksheet("Bitacora");
    assert.ok(sheet, "hoja Bitacora");
    const header = [1, 2, 3, 4, 5, 6].map((col) => String(sheet.getRow(1).getCell(col).value || ""));
    assert.deepEqual(header, ["Semana", "Fecha", "Tema", "Clasificación", "Actividades en clase", "Actividades evaluación"]);
    let filled = 0;
    sheet.eachRow((row, rowNumber) => {
      if (rowNumber > 1 && String(row.getCell(3).value || row.getCell(5).value || "").trim()) filled += 1;
    });
    assert.equal(filled, csvLines.length - 1, "xlsx y csv con las mismas filas");
    assert.ok(workbook.getWorksheet("Instrucciones") && workbook.getWorksheet("Catalogos"), "mismas hojas que la plantilla");

    const reimportForm = new FormData();
    reimportForm.set("fileName", "bitacora-reimportada.xlsx");
    reimportForm.set("snapshotId", "bitacora-reimportada");
    reimportForm.set("file", new Blob([new Uint8Array(xlsxBuffer)], { type: EXCEL_MIME }), "bitacora-reimportada.xlsx");
    const reimport = await fetch(`${baseUrl}/api/documents/bitacora/import`, {
      method: "POST",
      headers: { "x-session-id": teacherSessionId },
      body: reimportForm,
    });
    const reimported = await reimport.json() as { error?: string };
    assert.equal(reimport.status, 200, reimported.error);
    const statusAfter = await getBitacoraStatus(baseUrl, teacherSessionId);
    assert.equal(statusAfter.latest?.fileName, "bitacora-reimportada.xlsx");
    assert.equal(statusAfter.summary?.rows, importedRows, "reimportar lo exportado da las mismas filas");
  } finally {
    await stopTestServer(server, database);
  }
});

// 0.7.17: la bitacora FPOO 2025 en PDF se lee completa y el docente la corre al semestre 2026-2
// con «Inicio del semestre»; sus estudiantes la ven con las fechas nuevas.
test("0.7.17: PDF de FPOO completo e «Inicio del semestre» el 25 de agosto de 2026", async () => {
  const { server, database, baseUrl } = await startTestServer();
  try {
    const teacherSessionId = String((await login(baseUrl, "docente@adaceen.edu.co", "Docente123!")).id);
    const studentSessionId = String((await login(baseUrl, "estudiante@adaceen.edu.co", "Estudiante123!")).id);

    // Sin bitacora todavia: nada que correr.
    const noBitacora = await fetch(`${baseUrl}/api/documents/bitacora/start-date`, {
      method: "PUT",
      headers: { "x-session-id": teacherSessionId, "Content-Type": "application/json" },
      body: JSON.stringify({ startDate: "2026-08-25" }),
    });
    assert.equal(noBitacora.status, 404);

    const pdf = fs.readFileSync(path.resolve(process.cwd(), "tests/fixtures/bitacora-fpoo-2025.pdf"));
    const form = new FormData();
    form.set("fileName", "Bitacora FPOO - Hoja 1.pdf");
    form.set("snapshotId", "bitacora-fpoo-pdf");
    form.set("file", new Blob([new Uint8Array(pdf)], { type: "application/pdf" }), "Bitacora FPOO - Hoja 1.pdf");
    const imported = await fetch(`${baseUrl}/api/documents/bitacora/import`, {
      method: "POST",
      headers: { "x-session-id": teacherSessionId },
      body: form,
    });
    const importData = await imported.json() as { ok?: boolean; error?: string; classification?: { label?: string }; import?: { rowsUsed?: number } };
    assert.equal(imported.status, 200, importData.error);
    assert.equal(importData.classification?.label, "BITACORA");
    assert.equal(importData.import?.rowsUsed, 23, "17 filas (16 semanas y la opcional) y 6 evaluaciones");

    const put = (sessionId: string, body: unknown) => fetch(`${baseUrl}/api/documents/bitacora/start-date`, {
      method: "PUT",
      headers: { "x-session-id": sessionId, "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    assert.equal((await put(studentSessionId, { startDate: "2026-08-25" })).status, 403, "solo el docente");
    assert.equal((await put(teacherSessionId, { startDate: "25/08/2026" })).status, 400);
    assert.equal((await put(teacherSessionId, { startDate: "2026-02-30" })).status, 400, "la fecha tiene que existir");

    const applied = await put(teacherSessionId, { startDate: "2026-08-25" });
    const appliedData = await applied.json() as { error?: string; previousStartDate?: string; shiftDays?: number; firstDate?: string; lastDate?: string; weeks?: number };
    assert.equal(applied.status, 200, appliedData.error);
    assert.deepEqual(
      [appliedData.previousStartDate, appliedData.shiftDays, appliedData.firstDate, appliedData.lastDate, appliedData.weeks],
      ["2025-08-20", 370, "2026-08-25", "2026-12-15", 16],
    );

    // El estudiante ve la bitacora de su docente con las fechas nuevas.
    const status = await fetch(`${baseUrl}/api/documents/bitacora/status`, { headers: { "x-session-id": studentSessionId } });
    const statusData = await status.json() as { latest?: { bitacoraAgenda?: { items?: Array<{ title: string; dueAt: string | null; evidence: string[] }> }; features?: { bitacoraStartDate?: { startDate?: string } } } };
    const items = statusData.latest?.bitacoraAgenda?.items || [];
    const byTitle = (title: string) => items.find((item) => item.title === title)?.dueAt?.slice(0, 10);
    assert.equal(byTitle("Programa del curso y bitacora"), "2026-08-25");
    assert.equal(byTitle("Uso de clases de bibliotecas, APIs, y reutilización de código"), "2026-09-22", "semana 5");
    assert.equal(byTitle("Examen (Primer parcial)"), "2026-10-06");
    assert.equal(byTitle("Entrega proyecto final"), "2026-12-08");
    assert.equal(byTitle("OPCIONAL"), "2026-12-15");
    assert.equal(statusData.latest?.features?.bitacoraStartDate?.startDate, "2026-08-25");

    // El Excel exportado lleva las 16 semanas con las fechas corridas.
    const csv = await fetch(`${baseUrl}/api/documents/bitacora/export?format=csv`, { headers: { "x-session-id": teacherSessionId } });
    const csvText = await csv.text();
    assert.equal(csv.status, 200);
    assert.match(csvText, /\r\n1;25-8-2026;Programa del curso y bitacora;/);
    assert.match(csvText, /\r\n7;6-10-2026;Examen \(Primer parcial\);Parcial;[^\r\n]*;Examen \(Primer parcial\)\r\n/);
    assert.match(csvText, /\r\n16;8-12-2026;Entrega proyecto final: [^;]*;[^;]*;[^;]*;Entrega proyecto final\r\n/);
  } finally {
    await stopTestServer(server, database);
  }
});

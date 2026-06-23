import assert from "node:assert/strict";
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

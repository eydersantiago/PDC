import assert from "node:assert/strict";
import test from "node:test";
import type { Server } from "node:http";
import { createApp } from "../../src/app.js";
import { createDatabase, type AppDatabase } from "../../src/db/database.js";

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
  const data = await response.json() as { session?: { id?: string; user?: { id?: string } }; error?: string };
  assert.equal(response.status, 200, data.error);
  assert.ok(data.session?.id);
  return data.session;
}

test("behavior routes guardan historial por usuario y agregan resumen para profesor", async () => {
  const { server, database, baseUrl } = await startTestServer();
  try {
    const unauthorized = await fetch(`${baseUrl}/api/behavior/events`);
    assert.equal(unauthorized.status, 401);

    const studentSession = await login(baseUrl, "estudiante@adaceen.edu.co", "Estudiante123!");
    const studentSessionId = String(studentSession.id);

    const storedResponse = await fetch(`${baseUrl}/api/behavior/events`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json; charset=utf-8",
        "x-session-id": studentSessionId,
      },
      body: JSON.stringify({
        events: [
          {
            source: "vscode_extension",
            category: "cursor_idle",
            eventType: "cursor_idle_5s_detected",
            repoFullName: "octo/demo",
            filePath: "src/main.py",
            language: "python",
            durationMs: 5000,
            metadata: { line: 12, column: 4 },
          },
          {
            source: "vscode_extension",
            category: "suggestion",
            eventType: "suggestion_completion_applied",
            repoFullName: "octo/demo",
            filePath: "src/main.py",
            language: "python",
            value: "replace",
            count: 1,
          },
        ],
      }),
    });
    const stored = await storedResponse.json() as { stored?: number; events?: Array<{ userId: string; teacherUserId: string | null }> };
    assert.equal(storedResponse.status, 200);
    assert.equal(stored.stored, 2);
    assert.equal(stored.events?.[0]?.userId, studentSession.user?.id);
    assert.equal(stored.events?.[0]?.teacherUserId, "user-teacher-demo");

    const historyResponse = await fetch(`${baseUrl}/api/behavior/events?category=suggestion`, {
      headers: { "x-session-id": studentSessionId },
    });
    const history = await historyResponse.json() as { items?: Array<{ eventType: string; category: string }> };
    assert.equal(historyResponse.status, 200);
    assert.equal(history.items?.length, 1);
    assert.equal(history.items?.[0]?.eventType, "suggestion_completion_applied");

    const teacherSession = await login(baseUrl, "docente@adaceen.edu.co", "Docente123!");
    const summaryResponse = await fetch(`${baseUrl}/api/behavior/summary?repoFullName=octo/demo`, {
      headers: { "x-session-id": String(teacherSession.id) },
    });
    const summary = await summaryResponse.json() as { items?: Array<{ eventType: string; totalEvents: number; userId: string }> };
    assert.equal(summaryResponse.status, 200);
    assert.equal(summary.items?.length, 2);
    assert.deepEqual(
      summary.items?.map((item) => item.eventType).sort(),
      ["cursor_idle_5s_detected", "suggestion_completion_applied"],
    );
    assert.ok(summary.items?.every((item) => item.totalEvents === 1 && item.userId === studentSession.user?.id));
  } finally {
    await stopTestServer(server, database);
  }
});

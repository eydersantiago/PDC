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

async function login(baseUrl: string) {
  const response = await fetch(`${baseUrl}/api/auth/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json; charset=utf-8" },
    body: JSON.stringify({ email: "estudiante@adaceen.edu.co", password: "Estudiante123!" }),
  });
  const data = await response.json() as { session?: { id?: string }; error?: string };
  assert.equal(response.status, 200, data.error);
  assert.ok(data.session?.id);
  return String(data.session.id);
}

test("project context sync expone rack VS Code y cola reemplazos", async () => {
  const { server, database, baseUrl } = await startTestServer();
  try {
    const sessionId = await login(baseUrl);
    const headers = {
      "Content-Type": "application/json; charset=utf-8",
      "x-session-id": sessionId,
    };

    const consentResponse = await fetch(`${baseUrl}/api/projects/consent`, {
      method: "POST",
      headers,
      body: JSON.stringify({ canRead: true, canModify: true, canAnalyze: true }),
    });
    assert.equal(consentResponse.status, 200);

    const rackResponse = await fetch(`${baseUrl}/api/projects/rack`, {
      method: "POST",
      headers,
      body: JSON.stringify({
        source: "vscode_extension",
        repoFullName: "eyder/demo",
        branch: "main",
        generatedAt: new Date().toISOString(),
        totalEntries: 1,
        totalFiles: 1,
        totalFolders: 0,
        files: ["src/main.py"],
        folders: [],
        activeFilePath: "src/main.py",
        activeCodeSnippet: "print('hola')",
        activeSuggestion: "Agrega contexto antes de cambiar el bloque.",
        replacementOptions: [{
          id: "add-context",
          label: "Agregar contexto",
          description: "Inserta una nota antes del bloque.",
          actionType: "replace_selection",
          originalText: "print('hola')",
          replacementText: "# contexto\nprint('hola')",
        }],
      }),
    });
    assert.equal(rackResponse.status, 200);

    const stateResponse = await fetch(`${baseUrl}/api/projects/session/state`, { headers });
    const state = await stateResponse.json() as {
      state?: {
        latestRack?: {
          source?: string;
          activeSuggestion?: string;
          replacementOptions?: Array<{ label?: string; pageStart?: number }>;
        };
      };
    };
    assert.equal(stateResponse.status, 200);
    assert.equal(state.state?.latestRack?.source, "vscode_extension");
    assert.equal(state.state?.latestRack?.activeSuggestion, "Agrega contexto antes de cambiar el bloque.");
    assert.equal(state.state?.latestRack?.replacementOptions?.[0]?.label, "Agregar contexto");

    const actionResponse = await fetch(`${baseUrl}/api/projects/code-actions`, {
      method: "POST",
      headers,
      body: JSON.stringify({
        repoFullName: "eyder/demo",
        branch: "main",
        filePath: "src/main.py",
        actionType: "replace_selection",
        title: "Agregar contexto",
        originalText: "print('hola')",
        replacementText: "# contexto\nprint('hola')",
      }),
    });
    const queued = await actionResponse.json() as { action?: { id?: string; status?: string }; error?: string };
    assert.equal(actionResponse.status, 200, queued.error);
    assert.equal(queued.action?.status, "pending");
    assert.ok(queued.action?.id);

    const nextResponse = await fetch(`${baseUrl}/api/projects/code-actions/next?repoFullName=eyder/demo`, {
      headers: {
        "x-session-id": sessionId,
        "x-adaceen-worker-id": "test-vscode",
      },
    });
    const next = await nextResponse.json() as { action?: { id?: string; status?: string; workerInstance?: string } };
    assert.equal(nextResponse.status, 200);
    assert.equal(next.action?.id, queued.action.id);
    assert.equal(next.action?.status, "claimed");
    assert.equal(next.action?.workerInstance, "test-vscode");

    const completeResponse = await fetch(`${baseUrl}/api/projects/code-actions/${encodeURIComponent(String(queued.action.id))}/complete`, {
      method: "POST",
      headers,
      body: JSON.stringify({ metadata: { applied: true } }),
    });
    const completed = await completeResponse.json() as { action?: { status?: string }; error?: string };
    assert.equal(completeResponse.status, 200, completed.error);
    assert.equal(completed.action?.status, "completed");
  } finally {
    await stopTestServer(server, database);
  }
});

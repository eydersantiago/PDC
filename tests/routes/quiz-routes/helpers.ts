import assert from "node:assert/strict";
import type { Server } from "node:http";
import { createApp } from "../../../src/app.js";
import { createDatabase, type AppDatabase } from "../../../src/db/database.js";

export async function startTestServer() {
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

export async function stopTestServer(server: Server, database: AppDatabase) {
  await new Promise<void>((resolve, reject) => {
    server.close((error) => error ? reject(error) : resolve());
  });
  await database.close();
}

export async function login(baseUrl: string, email: string, password: string) {
  const response = await fetch(`${baseUrl}/api/auth/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json; charset=utf-8" },
    body: JSON.stringify({ email, password }),
  });
  const data = await response.json() as { session?: { id?: string } };
  assert.equal(response.status, 200);
  return String(data.session?.id || "");
}

export const MODEL_QUIZ = JSON.stringify({
  question: "Que hace la linea que agregaste?",
  options: ["Inicializa la matriz", "Borra la matriz", "Imprime la matriz", "Nada"],
  correct_index: 0,
  explanation: "Crea la matriz de 9x9 antes de usarla.",
  followup_question: "Por que hay que inicializar la matriz antes de usarla?",
  topic: "inicializacion de arreglos",
});

export function fakeModel(prompt: string) {
  if (prompt.includes("Califica la explicacion")) {
    return Promise.resolve('{"score": 70, "feedback": "Bien: mencionaste la inicializacion."}');
  }
  return Promise.resolve(`\`\`\`json\n${MODEL_QUIZ}\n\`\`\``);
}

export function clientHeaders(clientId: string, sessionId = "") {
  return {
    "Content-Type": "application/json; charset=utf-8",
    "x-adaceen-client-id": clientId,
    ...(sessionId ? { "x-session-id": sessionId } : {}),
  };
}

export const AFTER_ACCEPT_BODY = {
  filePath: "src/Algoritmos.java",
  language: "java",
  applyMode: "replace",
  originalCode: "int[][] resultado;",
  newCode: "int[][] resultado = new int[9][9];",
  suggestionText: "Inicializa la matriz resultado.",
  acceptCount: 1,
};

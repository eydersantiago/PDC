import assert from "node:assert/strict";
import fsp from "node:fs/promises";
import http from "node:http";
import type { AddressInfo } from "node:net";
import path from "node:path";
import test from "node:test";
import { startInProcessBackend } from "../../scripts/lib/cli.js";
import { backendChecks, editorSessionChecks, staticChecks } from "../../scripts/lib/cumplimiento.js";
import { env } from "../../src/config/env.js";
import { COMPLIANCE_ITEMS, complianceScore } from "../../src/services/compliance-checklist.js";

/**
 * A13.4 · ADACEEN-112: items del acceso simplificado y de las Mac del
 * laboratorio en la lista de cumplimiento, y su verificacion automatica
 * contra el backend (C24 y C25).
 */

const STUDENT = { email: "estudiante@adaceen.edu.co", password: "Estudiante123!" };

test("cumplimiento: items del acceso simplificado y de las Mac, con su tipo de verificacion", () => {
  const ids = COMPLIANCE_ITEMS.map((item) => item.id);
  assert.equal(new Set(ids).size, ids.length, "ids unicos");
  const expected: Record<string, "automatica" | "manual"> = {
    C24: "automatica",
    C25: "automatica",
    C26: "manual",
    C27: "manual",
    C28: "manual",
    C29: "manual",
    C30: "manual",
  };
  for (const [id, verification] of Object.entries(expected)) {
    const item = COMPLIANCE_ITEMS.find((entry) => entry.id === id);
    assert.ok(item, id);
    assert.equal(item?.verification, verification, id);
    assert.ok(item?.how && item.basis, `${id} con evidencia y base`);
  }
  assert.equal(COMPLIANCE_ITEMS.find((item) => item.id === "C27")?.critical, true, "un secreto en el entorno del estudiante detiene el piloto");
  const score = complianceScore(COMPLIANCE_ITEMS.map((item) => ({ id: item.id, status: item.id === "C28" ? "no aplica" : "cumple" })));
  assert.equal(score.applicable, COMPLIANCE_ITEMS.length - 1);
});

test("cumplimiento: C25 en el codigo y C24/C25 contra el backend en memoria con una cuenta", async () => {
  const repo = await staticChecks();
  assert.equal(repo.C25.status, "cumple", repo.C25.detail);
  assert.match(repo.C25.detail, /editor_pairing_codes tiene code_hash, user_id, created_at, expires_at, used_at, sin columna con el código/);

  const backend = await startInProcessBackend();
  try {
    const results = await backendChecks(backend.baseUrl, { credentials: STUDENT });
    assert.equal(results.C24.status, "cumple", results.C24.detail);
    assert.match(results.C24.detail, /Sesión de VS Code de tipo editor: vence en 30,0 días \(máximo 30\)\. Tras «Salir» en el navegador, GET \/api\/auth\/me con esa sesión responde HTTP 401 con x-adaceen-session: invalid\./);
    assert.equal(results.C25.status, "cumple", results.C25.detail);
    assert.match(results.C25.detail, /^Primer canje: HTTP 200; segundo canje del mismo código: HTTP 404 \(code_not_found\)\./);
    assert.ok(!/[A-Z0-9]{4}-[A-Z0-9]{4}/.test(`${results.C24.detail} ${results.C25.detail}`), "el codigo no sale en la evidencia");

    const wrong = await editorSessionChecks(backend.baseUrl, { email: STUDENT.email, password: "otra-clave" });
    assert.equal(wrong.C24.status, "no verificado");
    assert.equal(wrong.C25, undefined, "sin sesion, C25 queda con la revision del codigo");
  } finally {
    await backend.close();
  }
});

test("cumplimiento: C24 falla si las sesiones de VS Code duran mas de lo que dice el consentimiento", async () => {
  const previous = env.editorSessionTtlDays;
  env.editorSessionTtlDays = 60;
  const backend = await startInProcessBackend();
  try {
    const results = await editorSessionChecks(backend.baseUrl, STUDENT);
    assert.equal(results.C24.status, "no cumple");
    assert.match(results.C24.detail, /vence en 60,0 días \(máximo 30\)/);
    assert.equal(results.C25.status, "cumple");
  } finally {
    env.editorSessionTtlDays = previous;
    await backend.close();
  }
});

test("cumplimiento: un backend anterior al acceso simplificado no cumple C24 ni C25", async () => {
  const calls: string[] = [];
  const server = http.createServer((req, res) => {
    calls.push(`${req.method} ${req.url}`);
    res.setHeader("content-type", "application/json");
    if (req.url === "/api/auth/login") return res.end(JSON.stringify({ ok: true, session: { id: "sesion-vieja" } }));
    if (req.url === "/api/auth/logout") return res.end(JSON.stringify({ ok: true }));
    res.statusCode = 404;
    return res.end(JSON.stringify({ ok: false }));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
  try {
    const baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    const results = await editorSessionChecks(baseUrl, STUDENT);
    assert.equal(results.C24.status, "no cumple");
    assert.equal(results.C25.status, "no cumple");
    assert.match(results.C24.detail, /versión anterior al acceso simplificado/);
    assert.deepEqual(calls, ["POST /api/auth/login", "POST /api/auth/editor/pairing-code", "POST /api/auth/logout"], "cierra la sesion que abrio");
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

test("cumplimiento: si /api/health no responde, C24 y C20 quedan no verificados sin intentar nada y C18 mira la URL", async () => {
  const calls: string[] = [];
  const server = http.createServer((req, res) => {
    calls.push(`${req.method} ${req.url}`);
    res.statusCode = 502;
    res.setHeader("content-type", "text/html");
    res.end("<html>Bad Gateway</html>");
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
  try {
    const baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    const results = await backendChecks(baseUrl, { credentials: STUDENT });
    for (const id of ["C02", "C10", "C19", "C20", "C21", "C24"]) {
      assert.equal(results[id]?.status, "no verificado", id);
      assert.equal(results[id]?.detail, `No se pudo leer ${baseUrl}/api/health: el backend no respondió, no se intentó.`, id);
    }
    assert.equal(results.C18.status, "no cumple", "la URL no es https");
    assert.equal(results.C25, undefined, "C25 se queda con la revision del codigo");
    assert.deepEqual(calls, ["GET /api/health"], "no intenta iniciar sesion");
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

test("cumplimiento: la evidencia de ejemplo tiene todos los items de la lista", async () => {
  const doc = await fsp.readFile(path.resolve(process.cwd(), "docs/evidencias/verificacion-cumplimiento-ejemplo.md"), "utf8");
  for (const item of COMPLIANCE_ITEMS) {
    assert.ok(doc.includes(`| ${item.id} | ${item.item} |`), `${item.id}: vuelve a generar la evidencia de ejemplo (ver su encabezado)`);
  }
  assert.ok(!/Estudiante123!|Docente123!|Admin123!/.test(doc), "la evidencia no lleva claves");
});

import assert from "node:assert/strict";
import fsp from "node:fs/promises";
import http from "node:http";
import type { AddressInfo } from "node:net";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { startInProcessBackend } from "../../scripts/lib/cli.js";
import {
  cleanBackendUrl,
  collectDeploymentEvidence,
  normalizeArgs,
  redactSecrets,
  redactText,
  renderEvidenceMarkdown,
  summarizeChecks,
  writeEvidence,
  type EvidenceReport,
} from "../../scripts/lib/evidencias.js";

/**
 * A15.6 · ADACEEN-127 y A15.4 · ADACEEN-125: npm run evidencias:despliegue
 * junta en una carpeta fechada lo que antes se sacaba con curl, sin secretos
 * y sin red (backend en memoria y un servidor HTTP falso).
 */

const UUID = /\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/i;

function check(report: EvidenceReport, id: string) {
  const found = report.comprobaciones.find((item) => item.id === id);
  assert.ok(found, `falta la comprobacion ${id}`);
  return found;
}

test("evidencias: argumentos con espacio o con =, y URL del backend", () => {
  assert.deepEqual(
    normalizeArgs(["node", "x.ts", "--backend", "https://a.b", "--salida=c", "--cumplimiento", "--timeout", "5"], ["backend", "salida", "timeout"]),
    ["node", "x.ts", "--backend=https://a.b", "--salida=c", "--cumplimiento", "--timeout=5"],
  );
  assert.deepEqual(normalizeArgs(["node", "x.ts", "--backend", "--cumplimiento"], ["backend"]), ["node", "x.ts", "--backend", "--cumplimiento"]);
  assert.equal(cleanBackendUrl("https://app.example.net/"), "https://app.example.net");
  assert.equal(cleanBackendUrl("ftp://app.example.net"), "");
  assert.equal(cleanBackendUrl("https://user:clave@app.example.net"), "", "sin credenciales en la URL");
  assert.equal(cleanBackendUrl("https://app.example.net/?token=x"), "");
});

test("evidencias: redacta lo que parece un token y deja lo demas", () => {
  const texto = [
    "https://app-adaceen-api-eyder05232002.azurewebsites.net/api/health",
    "Endpoint=sb://x.servicebus.windows.net/;SharedAccessKeyName=root;SharedAccessKey=AbCdEf0123456789AbCdEf0123456789AbCdEf01234=",
    "ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789ab",
    "Bearer abcdefghijkl",
    "3f2b8c1e-9d4a-4f6b-8e2a-1c5d7e9f0a3b",
    "vscode://adaceen.adaceen/abrir?code=ABCD-EFGH&repo=owner/repo",
    "SERVICE_BUS_CONNECTION_STRING qwen2.5-coder:14b gce-v100 /descargas/Preparar-Mac-ADACEEN.command",
  ].join("\n");
  const limpio = redactText(texto);
  assert.match(limpio, /app-adaceen-api-eyder05232002\.azurewebsites\.net\/api\/health/);
  assert.match(limpio, /SharedAccessKey=\[redactado\]/);
  assert.doesNotMatch(limpio, /ghp_|abcdefghijkl|3f2b8c1e|ABCD-EFGH/);
  assert.match(limpio, /SERVICE_BUS_CONNECTION_STRING qwen2\.5-coder:14b gce-v100 \/descargas\/Preparar-Mac-ADACEEN\.command/);
  assert.deepEqual(
    redactSecrets({ worker_heartbeat_configured: true, workerToken: "x", nested: { sessionId: "y", jobs: 3 } }),
    { worker_heartbeat_configured: true, workerToken: "[redactado]", nested: { sessionId: "[redactado]", jobs: 3 } },
  );
});

test("evidencias: backend en memoria con credenciales de docente", async () => {
  const backend = await startInProcessBackend();
  const outDir = await fsp.mkdtemp(path.join(os.tmpdir(), "adaceen-evidencias-"));
  try {
    const report = await collectDeploymentEvidence({
      backendUrl: backend.baseUrl,
      timeoutMs: 10_000,
      credentials: { email: "docente@adaceen.edu.co", password: "Docente123!" },
      comando: `npm run evidencias:despliegue -- --backend=${backend.baseUrl}`,
    });
    assert.equal(check(report, "backend_responde").estado, "ok");
    assert.equal(check(report, "tanda_acceso_simplificado").estado, "ok");
    assert.equal(report.versiones.tandaAccesoSimplificado, true);
    assert.equal(check(report, "empezar").estado, "ok");
    assert.equal(check(report, "base_postgres").estado, "falla", "base en memoria");
    assert.equal(check(report, "https").estado, "aviso");
    const manifest = JSON.parse(await fsp.readFile("browser-ext-prod/manifest.json", "utf8")) as { version: string };
    assert.equal(report.versiones.navegador, manifest.version, "la version sale de /empezar");
    assert.equal(report.versiones.esperadas.navegador, manifest.version);
    assert.equal(report.consultas.find((probe) => probe.path === "/api/agent/backend")?.status, 200);
    assert.equal(report.descargas.length, 4);
    for (const probe of report.descargas) assert.equal(probe.method, "HEAD");

    assert.ok(!("omitido" in report.piloto), "con credenciales se lee el piloto");
    if (!("omitido" in report.piloto)) {
      assert.equal(report.piloto.status, 200);
      assert.equal(report.piloto.block, 0);
      assert.ok(report.piloto.counts);
    }
    assert.ok(!("omitido" in report.cumplimiento), "con credenciales corre la verificacion de cumplimiento");
    if (!("omitido" in report.cumplimiento)) {
      assert.equal(report.cumplimiento.filas.find((row) => row.id === "C20")?.estado, "no cumple", "las cuentas demo entran");
      assert.equal(report.cumplimiento.filas.find((row) => row.id === "C21")?.estado, "no cumple", "base en memoria");
      // La prueba de la sesion de VS Code hace «Salir»: nunca con la cuenta del docente.
      const c24 = report.cumplimiento.filas.find((row) => row.id === "C24");
      if (c24) assert.equal(c24.estado, "no verificado");
    }

    const written = await writeEvidence(report, outDir);
    assert.match(path.basename(written.dir), /^\d{4}-\d{2}-\d{2}-\d{2}-\d{2}$/, "carpeta fechada");
    const markdown = await fsp.readFile(written.markdownPath, "utf8");
    const json = await fsp.readFile(written.jsonPath, "utf8");
    assert.match(markdown, /^# Evidencias de despliegue — /);
    assert.match(markdown, /## 6\. Piloto \(con credenciales de docente\)/);
    assert.equal(JSON.parse(json).backend, backend.baseUrl);
    for (const content of [markdown, json]) {
      assert.doesNotMatch(content, UUID, "sin id de sesion");
      assert.ok(!content.includes("Docente123!"), "sin la clave");
      assert.ok(!content.includes("Estudiante Demo"), "sin la lista de estudiantes");
    }
    const again = await writeEvidence(report, outDir);
    assert.equal(path.basename(again.dir), `${path.basename(written.dir)}-2`, "no pisa una evidencia anterior");
  } finally {
    await backend.close();
    await fsp.rm(outDir, { recursive: true, force: true });
  }
});

type FakeState = { tanda: boolean };

async function startFakeBackend(state: FakeState) {
  const sessionId = "0b7d6c1e-2f3a-4b5c-8d9e-0f1a2b3c4d5e";
  const requests: string[] = [];
  const logins: string[] = [];
  const server = http.createServer((req, res) => {
    const url = new URL(req.url || "/", "http://localhost");
    requests.push(`${req.method} ${url.pathname}`);
    const json = (status: number, body: unknown) => {
      res.writeHead(status, { "content-type": "application/json; charset=utf-8" });
      res.end(JSON.stringify(body));
    };
    if (url.pathname === "/api/health" && req.method === "GET") {
      return json(200, {
        ok: true,
        mode: "queue",
        queue_configured: true,
        queue_missing_config: [],
        jobs_queue_name: "adaceen-jobs",
        results_queue_name: "adaceen-results",
        database_provider: "postgres",
        telemetry_salt_configured: true,
        worker_heartbeat_configured: true,
        workspace_provider: "tunnel",
        workspace_agent_online: false,
        ...(state.tanda ? { workspace_agent_transport: "relay", model_workers_alive: 1, model_workers_known_down: false } : {}),
        // Un campo que nunca deberia existir, para probar la redaccion.
        debug_note: "Bearer abcdefghijklmnop",
      });
    }
    if (url.pathname === "/api/agent/backend") {
      return json(200, {
        ok: true,
        mode: "queue",
        listening: [{
          id: "gce-v100",
          label: "Google Cloud - V100",
          alive: true,
          lastSeenAt: "2026-09-25T14:00:00.000Z",
          model: "qwen2.5-coder:14b",
          platform: "linux",
          kinds: "text,image",
          jobsProcessed: 7,
          workerToken: "ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789ab",
        }],
        alive_workers: 1,
      });
    }
    if (url.pathname === "/api/agent/health") return json(200, { ok: true, mode: "queue", alive_workers: 1 });
    if (url.pathname === "/empezar") {
      res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      return res.end('<!doctype html><html lang="es" data-browser-ext-latest="0.7.11"><body><a>Descargar extension de VS Code<span>VSIX, version 0.0.31</span></a></body></html>');
    }
    if (url.pathname === "/descargas/adaceen-navegador.zip") {
      res.writeHead(200, { "content-type": "application/zip", "content-length": "2048" });
      return res.end(req.method === "HEAD" ? undefined : Buffer.alloc(2048));
    }
    if (url.pathname === "/descargas/adaceen.vsix") {
      if (req.method === "HEAD") { res.writeHead(405); return res.end(); }
      res.writeHead(200, { "content-type": "application/octet-stream" });
      return res.end(Buffer.alloc(5000));
    }
    if (url.pathname === "/descargas/Preparar-Mac-ADACEEN.command") {
      res.writeHead(200, { "content-type": "application/octet-stream", "content-length": "900" });
      return res.end(req.method === "HEAD" ? undefined : Buffer.alloc(900));
    }
    if (url.pathname === "/api/auth/login" && req.method === "POST") {
      let body = "";
      req.on("data", (chunk) => { body += chunk; });
      req.on("end", () => {
        const input = JSON.parse(body || "{}") as { email?: string; password?: string; sessionKind?: string };
        logins.push(String(input.email));
        if (input.email === "profe@piloto.test" && input.password === "clave-de-prueba" && input.sessionKind === "cli") {
          return json(200, { ok: true, session: { id: sessionId } });
        }
        return json(401, { ok: false, error: "Credenciales invalidas." });
      });
      return;
    }
    if (url.pathname === "/api/pilot") {
      if (req.headers["x-session-id"] !== sessionId) return json(401, { ok: false, error: "Sesion requerida." });
      return json(200, {
        ok: true,
        teacherUserId: "7c9e6679-7425-40de-944b-e07fc1f90ae7",
        block: 1,
        description: "Bloque 1: la cohorte A con tutor y la B sin tutor.",
        seed: "7c9e6679-7425-40de-944b-e07fc1f90ae7:2026-09-25",
        updatedAt: "2026-09-25T13:00:00.000Z",
        counts: { A: 2, B: 2, sinAsignar: 0 },
        students: [{ id: "s1", displayName: "Ana Privada", cohort: "A" }],
      });
    }
    if (url.pathname === "/api/privacy-policy") return json(200, { ok: true });
    res.writeHead(404, { "content-type": "text/html" });
    res.end("<p>no existe</p>");
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  return {
    baseUrl: `http://127.0.0.1:${port}`,
    sessionId,
    requests,
    logins,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

test("evidencias: servidor falso con descargas, piloto y secretos plantados", async () => {
  const state: FakeState = { tanda: true };
  const fake = await startFakeBackend(state);
  const repoRoot = await fsp.mkdtemp(path.join(os.tmpdir(), "adaceen-evidencias-repo-"));
  try {
    await fsp.mkdir(path.join(repoRoot, "browser-ext-prod"), { recursive: true });
    await fsp.writeFile(path.join(repoRoot, "browser-ext-prod/manifest.json"), JSON.stringify({ version: "0.7.10" }));
    const report = await collectDeploymentEvidence({
      backendUrl: `${fake.baseUrl}/`,
      timeoutMs: 5_000,
      credentials: { email: "profe@piloto.test", password: "clave-de-prueba" },
      repoRoot,
    });
    const byPath = new Map(report.descargas.map((probe) => [probe.path, probe]));
    assert.deepEqual(
      [byPath.get("/descargas/adaceen-navegador.zip")?.status, byPath.get("/descargas/adaceen-navegador.zip")?.bytes, byPath.get("/descargas/adaceen-navegador.zip")?.method],
      [200, 2048, "HEAD"],
    );
    assert.deepEqual(
      [byPath.get("/descargas/adaceen.vsix")?.status, byPath.get("/descargas/adaceen.vsix")?.bytes, byPath.get("/descargas/adaceen.vsix")?.method],
      [200, 5000, "GET"],
      "sin HEAD se descarga y se cuenta",
    );
    assert.equal(byPath.get("/descargas/Preparar-Mac-ADACEEN.zip")?.status, 404);
    assert.equal(check(report, "descarga_mac").estado, "ok", "basta el .command");
    assert.equal(check(report, "descarga_navegador").estado, "ok");
    assert.equal(check(report, "descarga_vsix").estado, "ok");
    assert.deepEqual([report.versiones.navegador, report.versiones.vscode], ["0.7.11", "0.0.31"]);
    assert.equal(check(report, "version_navegador").estado, "aviso");
    assert.match(check(report, "version_navegador").detalle, /Publicada 0\.7\.11; en el repositorio 0\.7\.10/);
    assert.equal(check(report, "version_vscode").estado, "ok", "sin version en el repositorio no hay con que comparar");
    assert.equal(check(report, "agente_editores").estado, "aviso");
    assert.equal(check(report, "servidores_vivos").estado, "ok");
    assert.equal(check(report, "base_postgres").estado, "ok");
    assert.equal(check(report, "cola").estado, "ok");
    assert.deepEqual(report.workers.map((worker) => [worker.id, worker.alive, worker.jobsProcessed]), [["gce-v100", true, 7]]);
    assert.ok(!("omitido" in report.piloto));
    if (!("omitido" in report.piloto)) assert.deepEqual(report.piloto.counts, { A: 2, B: 2, sinAsignar: 0 });
    assert.equal(check(report, "piloto").estado, "ok");
    assert.ok(!("omitido" in report.cumplimiento));
    if (!("omitido" in report.cumplimiento)) {
      assert.equal(report.cumplimiento.filas.find((row) => row.id === "C18")?.estado, "no cumple", "sin HTTPS");
      assert.equal(report.cumplimiento.filas.find((row) => row.id === "C20")?.estado, "cumple", "las cuentas demo no entran");
    }

    const markdown = renderEvidenceMarkdown(report);
    const json = JSON.stringify(report);
    for (const content of [markdown, json]) {
      assert.ok(!content.includes(fake.sessionId), "sin el id de sesion");
      assert.ok(!content.includes("clave-de-prueba"), "sin la clave");
      assert.ok(!content.includes("ghp_"), "sin el token del worker");
      assert.ok(!content.includes("abcdefghijklmnop"), "sin el Bearer");
      assert.ok(!content.includes("Ana Privada"), "sin nombres de estudiantes");
      assert.ok(!content.includes("7c9e6679"), "sin el id del docente");
    }
    assert.match(markdown, /\| HEAD \| \/descargas\/adaceen-navegador\.zip \| 200 \| 2,0 KB \|/);
    assert.match(markdown, /\| gce-v100 \| Google Cloud - V100 \| sí \|/);

    // Solo lectura: GET y HEAD, salvo el login de consola del docente.
    const writes = fake.requests.filter((line) => !line.startsWith("GET ") && !line.startsWith("HEAD "));
    assert.ok(writes.every((line) => line === "POST /api/auth/login"), writes.join(", "));

    // Backend anterior a la tanda y sin credenciales.
    state.tanda = false;
    const old = await collectDeploymentEvidence({ backendUrl: fake.baseUrl, timeoutMs: 5_000, repoRoot });
    assert.equal(check(old, "tanda_acceso_simplificado").estado, "falla");
    assert.equal(old.versiones.tandaAccesoSimplificado, false);
    assert.ok("omitido" in old.piloto);
    assert.ok("omitido" in old.cumplimiento);
    assert.ok(summarizeChecks(old.comprobaciones).falla >= 1);

    // Backend anterior a la tanda con credenciales: su login ignora sessionKind
    // y cerraria todas las sesiones del docente, asi que no se inicia sesion.
    fake.logins.length = 0;
    const oldWithCredentials = await collectDeploymentEvidence({
      backendUrl: fake.baseUrl,
      timeoutMs: 5_000,
      credentials: { email: "profe@piloto.test", password: "clave-de-prueba" },
      repoRoot,
    });
    assert.ok(!fake.logins.includes("profe@piloto.test"), `sin login del docente: ${fake.logins.join(", ")}`);
    assert.ok("omitido" in oldWithCredentials.piloto);
    assert.equal(check(oldWithCredentials, "piloto").estado, "aviso");
    assert.match(check(oldWithCredentials, "piloto").detalle, /anterior a la tanda «acceso simplificado»/);
    assert.ok(!("omitido" in oldWithCredentials.cumplimiento), "la verificacion de cumplimiento no usa la cuenta del docente");

    // Credenciales equivocadas: falla visible, sin el correo en la evidencia.
    state.tanda = true;
    const wrong = await collectDeploymentEvidence({
      backendUrl: fake.baseUrl,
      timeoutMs: 5_000,
      credentials: { email: "otro@piloto.test", password: "mala" },
      repoRoot,
    });
    assert.equal(check(wrong, "piloto").estado, "falla");
    assert.ok(!JSON.stringify(wrong).includes("otro@piloto.test"));
  } finally {
    await fake.close();
    await fsp.rm(repoRoot, { recursive: true, force: true });
  }

  // Backend apagado: todo falla con "sin conexion", sin excepciones.
  const down = await collectDeploymentEvidence({ backendUrl: fake.baseUrl, timeoutMs: 2_000 });
  assert.equal(check(down, "backend_responde").estado, "falla");
  assert.match(check(down, "backend_responde").detalle, /sin conexión/);
  assert.equal(check(down, "empezar").estado, "falla");
});

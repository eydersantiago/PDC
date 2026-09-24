// Pruebas HTTP del agente con un nuevo-tunel.sh falso y un "sistema" falso
// (sin systemd, sin useradd, sin red). Ejercitan autenticacion, validacion,
// lanzamiento del script sin shell, lectura del codigo, cola y timeout.
//   node --test deploy/gcp/workspaces/agente/*.test.mjs
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { crearAgente } from "./agente-workspaces.mjs";
import { estadoServicio } from "./parse.mjs";

const TOKEN = "token-de-prueba-del-agente-0123456789";
const NADA = { usuarioExiste: false, servicio: estadoServicio({}), sesion: false, codigoJournal: null, nombreTunelReal: null };
const ACTIVO = { activo: true, arrancando: false, fallido: false, invocacion: "" };

function crearScriptFalso(dir) {
  const ruta = path.join(dir, "nuevo-tunel-falso.sh");
  writeFileSync(ruta, `#!/usr/bin/env bash
set -euo pipefail
LOGIN="$1"
REPO="$2"
printf '%s\\n' "$@" > "${dir}/args-$LOGIN"
echo x >> "${dir}/corridas-$LOGIN"
echo "--- preparando $LOGIN con $REPO"
case "$LOGIN" in
  falla*) echo "fatal: could not read Username for 'https://github.com': No such device or address" >&2; exit 128 ;;
  lento*) sleep 30 ;;
esac
echo "To grant access to the server, please log into https://github.com/login/device and use code WXYZ-1234"
sleep 0.2
echo "=== tunel listo para $LOGIN ==="
`);
  return ruta;
}

function crearSistemaFalso() {
  const estados = new Map();
  const origenes = new Map();
  const rehechos = [];
  return {
    estados,
    origenes,
    rehechos,
    async observar(login) {
      return estados.get(login) || NADA;
    },
    async origenProyecto(login) {
      return origenes.get(login) || null;
    },
    async prepararRehacer(login) {
      rehechos.push(login);
      return `/home/ws-${login}/proyecto.bak-prueba`;
    },
  };
}

async function iniciar(ajustes = {}) {
  const dir = mkdtempSync(path.join(tmpdir(), "agente-ws-"));
  const sistema = crearSistemaFalso();
  const config = {
    token: TOKEN,
    hosts: ["127.0.0.1"],
    puerto: 0,
    script: crearScriptFalso(dir),
    codeBin: "/bin/false",
    maxConcurrentes: 2,
    maxCola: 1,
    timeoutScriptMs: 10000,
    esperaPrepararMs: 1500,
    ...ajustes,
  };
  const agente = crearAgente({ config, sistema });
  const [servidor] = await agente.escuchar();
  const base = `http://127.0.0.1:${servidor.address().port}`;

  async function llamar(metodo, ruta, cuerpo, token = TOKEN) {
    const respuesta = await fetch(`${base}${ruta}`, {
      method: metodo,
      headers: {
        ...(token ? { "x-agent-token": token } : {}),
        ...(cuerpo !== undefined ? { "Content-Type": "application/json" } : {}),
      },
      body: cuerpo === undefined ? undefined : typeof cuerpo === "string" ? cuerpo : JSON.stringify(cuerpo),
    });
    return { status: respuesta.status, json: await respuesta.json() };
  }

  function leer(nombre) {
    try {
      return readFileSync(path.join(dir, nombre), "utf8");
    } catch {
      return "";
    }
  }

  async function cerrar() {
    await agente.cerrar();
    rmSync(dir, { recursive: true, force: true });
  }

  return { sistema, llamar, leer, cerrar };
}

test("agente HTTP: /health publico; lo demas exige token y valida entradas", async () => {
  const agente = await iniciar();
  try {
    const salud = await agente.llamar("GET", "/health", undefined, "");
    assert.equal(salud.status, 200);
    assert.equal(salud.json.ok, true);
    assert.equal("logins" in salud.json, false);

    assert.equal((await agente.llamar("POST", "/workspaces", { login: "eyder", repo: "a/b" }, "")).status, 401);
    assert.equal((await agente.llamar("POST", "/workspaces", { login: "eyder", repo: "a/b" }, `${TOKEN}x`)).status, 401);
    assert.equal((await agente.llamar("GET", "/workspaces/eyder", undefined, "otro-token")).status, 401);
    assert.equal((await agente.llamar("GET", "/no-existe", undefined, "")).status, 401, "sin token no se revelan rutas");

    const correo = await agente.llamar("POST", "/workspaces", { login: "eyder@correounivalle.edu.co", repo: "a/b" });
    assert.equal(correo.status, 400);
    assert.equal(correo.json.code, "invalid_input");

    const inyeccion = await agente.llamar("POST", "/workspaces", { login: "eyder", repo: "a/b;touch /tmp/x" });
    assert.equal(inyeccion.status, 400);

    assert.equal((await agente.llamar("POST", "/workspaces", "{no es json")).json.code, "invalid_json");
    assert.equal((await agente.llamar("POST", "/workspaces", { login: "eyder", repo: "a/b", relleno: "x".repeat(20000) })).status, 413);
    assert.equal((await agente.llamar("GET", "/workspaces/eyder%40correo")).status, 400);
    assert.equal((await agente.llamar("GET", "/workspaces/%E0%A4%A")).status, 400);
    assert.equal((await agente.llamar("GET", "/no-existe")).status, 404);

    const nadie = await agente.llamar("GET", "/workspaces/nadie");
    assert.equal(nadie.status, 404);
    assert.equal(nadie.json.state, "error");
    assert.equal(nadie.json.code, "not_found");
  } finally {
    await agente.cerrar();
  }
});

test("agente HTTP: corre nuevo-tunel.sh sin shell, devuelve el codigo y luego ready (idempotente)", async () => {
  const agente = await iniciar();
  try {
    const preparado = await agente.llamar("POST", "/workspaces", {
      login: "Eyder",
      repo: "https://github.com/Eyder/Proyecto.git",
    });
    assert.equal(preparado.status, 200);
    assert.equal(preparado.json.state, "device_code");
    assert.equal(preparado.json.deviceCode, "WXYZ-1234");
    assert.equal(preparado.json.verificationUrl, "https://github.com/login/device");
    assert.equal(preparado.json.tunnelName, "ad-eyder");
    assert.equal(preparado.json.webUrl, "https://vscode.dev/tunnel/ad-eyder/home/ws-eyder/proyecto");
    assert.equal(preparado.json.repo, "Eyder/Proyecto");
    assert.ok(Date.parse(preparado.json.expiresAt) > Date.now());
    // Argumentos exactos: login normalizado y URL https, como lista (sin shell).
    assert.equal(agente.leer("args-eyder"), "eyder\nhttps://github.com/Eyder/Proyecto.git\n");

    // El script termino; el servicio espera la autorizacion (camino del journal).
    agente.sistema.estados.set("eyder", {
      usuarioExiste: true,
      servicio: ACTIVO,
      sesion: false,
      codigoJournal: { codigo: "JOUR-0002", url: "https://github.com/login/device", vistoEn: Date.now() },
      nombreTunelReal: null,
    });
    await new Promise((resolve) => setTimeout(resolve, 400));
    const esperando = await agente.llamar("GET", "/workspaces/eyder");
    assert.equal(esperando.status, 200);
    assert.equal(esperando.json.state, "device_code");
    assert.equal(esperando.json.deviceCode, "JOUR-0002");

    // El estudiante autorizo: servicio activo y sesion iniciada.
    agente.sistema.estados.set("eyder", { usuarioExiste: true, servicio: ACTIVO, sesion: true, codigoJournal: null, nombreTunelReal: "ad-eyder" });
    const listo = await agente.llamar("GET", "/workspaces/eyder");
    assert.equal(listo.json.state, "ready");
    assert.equal(listo.json.webUrl, "https://vscode.dev/tunnel/ad-eyder/home/ws-eyder/proyecto");
    assert.equal("deviceCode" in listo.json, false);

    // Idempotente: con el tunel arriba no se vuelve a correr el script.
    agente.sistema.origenes.set("eyder", "eyder/proyecto");
    const otraVez = await agente.llamar("POST", "/workspaces", { login: "eyder", repo: "eyder/proyecto" });
    assert.equal(otraVez.json.state, "ready");
    assert.equal(agente.leer("corridas-eyder"), "x\n");
  } finally {
    await agente.cerrar();
  }
});

test("agente HTTP: dos POST simultaneos del mismo login lanzan un solo script", async () => {
  const agente = await iniciar();
  try {
    const [uno, dos] = await Promise.all([
      agente.llamar("POST", "/workspaces", { login: "doble", repo: "doble/repo" }),
      agente.llamar("POST", "/workspaces", { login: "doble", repo: "doble/repo" }),
    ]);
    assert.equal(uno.json.state, "device_code");
    assert.equal(dos.json.state, "device_code");
    assert.equal(dos.json.deviceCode, uno.json.deviceCode);
    await new Promise((resolve) => setTimeout(resolve, 400));
    assert.equal(agente.leer("corridas-doble"), "x\n");
  } finally {
    await agente.cerrar();
  }
});

test("agente HTTP: repo distinto -> 409; force aparta el clon; fallo de clon -> error legible", async () => {
  const agente = await iniciar();
  try {
    agente.sistema.estados.set("ana", { usuarioExiste: true, servicio: ACTIVO, sesion: false, codigoJournal: null, nombreTunelReal: null });
    agente.sistema.origenes.set("ana", "ana/viejo");

    const distinto = await agente.llamar("POST", "/workspaces", { login: "ana", repo: "ana/nuevo" });
    assert.equal(distinto.status, 409);
    assert.equal(distinto.json.code, "repo_mismatch");
    assert.equal(agente.leer("corridas-ana"), "", "no debe correr el script");

    const forzado = await agente.llamar("POST", "/workspaces", { login: "ana", repo: "ana/nuevo", force: true });
    assert.equal(forzado.status, 200);
    assert.equal(forzado.json.state, "device_code");
    assert.deepEqual(agente.sistema.rehechos, ["ana"]);
    assert.equal(agente.leer("args-ana"), "ana\nhttps://github.com/ana/nuevo.git\n");

    const fallo = await agente.llamar("POST", "/workspaces", { login: "falla-privado", repo: "otro/privado" });
    assert.equal(fallo.status, 200);
    assert.equal(fallo.json.state, "error");
    assert.equal(fallo.json.code, "clone_failed");
    assert.match(fallo.json.message, /privado/);
    const falloGet = await agente.llamar("GET", "/workspaces/falla-privado");
    assert.equal(falloGet.json.code, "clone_failed");
  } finally {
    await agente.cerrar();
  }
});

test("agente HTTP: limite de concurrencia, cola llena, force sobre un trabajo en marcha y timeout", async () => {
  const agente = await iniciar({ maxConcurrentes: 1, maxCola: 1, esperaPrepararMs: 300, timeoutScriptMs: 1500 });
  try {
    const primero = await agente.llamar("POST", "/workspaces", { login: "lento-a", repo: "a/a" });
    assert.equal(primero.json.state, "pending");

    const segundo = await agente.llamar("POST", "/workspaces", { login: "lento-b", repo: "b/b" });
    assert.equal(segundo.json.state, "pending");
    assert.match(segundo.json.message, /En cola/);

    const tercero = await agente.llamar("POST", "/workspaces", { login: "lento-c", repo: "c/c" });
    assert.equal(tercero.status, 429);
    assert.equal(tercero.json.code, "busy");

    // Mismo login y repo mientras corre: no se lanza otro script.
    const repetido = await agente.llamar("POST", "/workspaces", { login: "lento-a", repo: "a/a" });
    assert.equal(repetido.json.state, "pending");
    const otroRepo = await agente.llamar("POST", "/workspaces", { login: "lento-a", repo: "a/otro" });
    assert.equal(otroRepo.status, 409);
    assert.equal(otroRepo.json.code, "busy_other_repo");

    // force sobre el que esta en cola: lo reemplaza.
    const forzado = await agente.llamar("POST", "/workspaces", { login: "lento-b", repo: "b/b", force: true });
    assert.equal(forzado.json.state, "pending");
    assert.deepEqual(agente.sistema.rehechos, []);

    await new Promise((resolve) => setTimeout(resolve, 1900));
    const vencido = await agente.llamar("GET", "/workspaces/lento-a");
    assert.equal(vencido.json.state, "error");
    assert.equal(vencido.json.code, "timeout");
    assert.equal(agente.leer("corridas-lento-a"), "x\n");
  } finally {
    await agente.cerrar();
  }
});

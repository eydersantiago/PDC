// Pruebas HTTP del agente con un nuevo-tunel.sh falso y un "sistema" falso
// (sin systemd, sin useradd, sin red). Ejercitan autenticacion, validacion,
// lanzamiento del script sin shell, lectura del codigo, cola y timeout, y la
// sesion del editor (contrato 2.3) con un directorio temporal en lugar de /home.
//   node --test deploy/gcp/workspaces/agente/*.test.mjs
import assert from "node:assert/strict";
import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  readlinkSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { crearAgente, crearSistemaReal, escribirSesionEditor } from "./agente-workspaces.mjs";
import { contenidoSesionEditor, estadoServicio, validarSesionEditor } from "./parse.mjs";
import { crearClienteRelay } from "./relay.mjs";

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
# "useradd": desde aqui el sistema falso da por existente a ws-$LOGIN.
touch "${dir}/usuario-$LOGIN"
env | grep -c '^AGENT_TOKEN=' > "${dir}/token-$LOGIN" || true
if [ -n "\${ADACEEN_EDITOR_SESSION_FILE:-}" ]; then
  cat "$ADACEEN_EDITOR_SESSION_FILE" > "${dir}/sesion-$LOGIN"
  ls -l "$ADACEEN_EDITOR_SESSION_FILE" | cut -c1-10 > "${dir}/modo-sesion-$LOGIN"
  dirname "$ADACEEN_EDITOR_SESSION_FILE" > "${dir}/dir-sesion-$LOGIN"
fi
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

function crearSistemaFalso(dir) {
  const estados = new Map();
  const origenes = new Map();
  const rehechos = [];
  const usuarios = new Set();
  const escritas = [];
  return {
    estados,
    origenes,
    rehechos,
    usuarios,
    escritas,
    async guardarSesionEditor(login, contenido) {
      if (!usuarios.has(login) && !existsSync(path.join(dir, `usuario-${login}`))) return false;
      if (login.startsWith("enlace")) throw Object.assign(new Error("ENOTDIR: not a directory"), { code: "ENOTDIR" });
      escritas.push({ login, contenido });
      return true;
    },
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
  const sistema = crearSistemaFalso(dir);
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

  return { sistema, llamar, leer, cerrar, base };
}

// Captura lo que el agente escribe en el log (para comprobar que nunca sale el sessionId).
function capturarLog() {
  const lineas = [];
  const originales = { log: console.log, error: console.error };
  console.log = (...args) => lineas.push(args.join(" "));
  console.error = (...args) => lineas.push(args.join(" "));
  return {
    lineas,
    restaurar() {
      console.log = originales.log;
      console.error = originales.error;
    },
  };
}

async function esperarHasta(condicion, ms = 3000) {
  const limite = Date.now() + ms;
  while (!condicion()) {
    if (Date.now() > limite) throw new Error("tiempo agotado esperando la condicion");
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

const SESION = {
  sessionId: "0f8e3c2a-9b1d-4e5f-8a7b-6c5d4e3f2a1b",
  backendUrl: "https://app-adaceen.example.net",
  expiresAt: "2099-01-01T00:00:00.000Z",
  userName: "Eyder Santiago",
  userEmail: "eyder@correounivalle.edu.co",
};

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

// --- Sesion del editor (contrato 2.3) ---

// Como root se comprueba el chown de verdad; si no, el dueno es uno mismo.
const ES_ROOT = typeof process.getuid === "function" && process.getuid() === 0;
const DUENO = ES_ROOT ? { uid: 4321, gid: 4322 } : { uid: process.getuid?.() ?? 0, gid: process.getgid?.() ?? 0 };

function contenidoDePrueba() {
  return contenidoSesionEditor(validarSesionEditor(SESION).sesion, Date.parse("2026-09-25T12:00:00Z"));
}

function modo(ruta) {
  return lstatSync(ruta).mode & 0o777;
}

test("sesion del editor: carpeta 0700, archivo 0600, dueno del estudiante, sin temporales", async () => {
  const base = mkdtempSync(path.join(tmpdir(), "ws-home-"));
  try {
    const home = path.join(base, "ws-eyder");
    mkdirSync(home);
    await escribirSesionEditor({ home, ...DUENO, contenido: contenidoDePrueba() });
    const carpeta = path.join(home, ".adaceen");
    const archivo = path.join(carpeta, "editor-session.json");
    assert.equal(modo(carpeta), 0o700);
    assert.equal(modo(archivo), 0o600);
    assert.equal(lstatSync(archivo).uid, DUENO.uid);
    assert.equal(lstatSync(archivo).gid, DUENO.gid);
    assert.equal(lstatSync(carpeta).uid, DUENO.uid);
    const documento = JSON.parse(readFileSync(archivo, "utf8"));
    assert.equal(documento.version, 1);
    assert.equal(documento.sessionId, SESION.sessionId);
    assert.equal(documento.writtenAt, "2026-09-25T12:00:00.000Z");
    assert.deepEqual(readdirSync(carpeta), ["editor-session.json"]);

    // Segunda escritura: reemplaza (rename) y corrige permisos que el estudiante haya abierto.
    writeFileSync(archivo, "viejo", { mode: 0o644 });
    await escribirSesionEditor({ home, ...DUENO, contenido: "{\"nuevo\":true}\n" });
    assert.equal(readFileSync(archivo, "utf8"), "{\"nuevo\":true}\n");
    assert.equal(modo(archivo), 0o600);
    assert.deepEqual(readdirSync(carpeta), ["editor-session.json"]);
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

test("sesion del editor: no sigue enlaces que el estudiante plante en su home", async () => {
  const base = mkdtempSync(path.join(tmpdir(), "ws-home-"));
  try {
    const victima = path.join(base, "victima");
    mkdirSync(victima);
    writeFileSync(path.join(victima, "secreto"), "no tocar");

    // .adaceen -> otra carpeta: se rechaza y no se escribe nada alla.
    const homeA = path.join(base, "ws-a");
    mkdirSync(homeA);
    symlinkSync(victima, path.join(homeA, ".adaceen"));
    await assert.rejects(escribirSesionEditor({ home: homeA, ...DUENO, contenido: "x" }), /ENOTDIR|ELOOP/);
    assert.deepEqual(readdirSync(victima), ["secreto"]);

    // editor-session.json -> archivo ajeno: se reemplaza el enlace, el destino queda intacto.
    const homeB = path.join(base, "ws-b");
    mkdirSync(path.join(homeB, ".adaceen"), { recursive: true });
    symlinkSync(path.join(victima, "secreto"), path.join(homeB, ".adaceen", "editor-session.json"));
    await escribirSesionEditor({ home: homeB, ...DUENO, contenido: "{}\n" });
    assert.equal(readFileSync(path.join(victima, "secreto"), "utf8"), "no tocar");
    const escrito = path.join(homeB, ".adaceen", "editor-session.json");
    assert.equal(lstatSync(escrito).isSymbolicLink(), false);
    assert.equal(readFileSync(escrito, "utf8"), "{}\n");

    // El home mismo es un enlace: se rechaza.
    const homeC = path.join(base, "ws-c");
    symlinkSync(victima, homeC);
    await assert.rejects(escribirSesionEditor({ home: homeC, ...DUENO, contenido: "x" }), /ENOTDIR|ELOOP/);
    assert.deepEqual(readdirSync(victima), ["secreto"]);
    assert.equal(readlinkSync(homeC), victima);

    // .adaceen es un archivo: se rechaza sin tocarlo.
    const homeD = path.join(base, "ws-d");
    mkdirSync(homeD);
    writeFileSync(path.join(homeD, ".adaceen"), "archivo");
    await assert.rejects(escribirSesionEditor({ home: homeD, ...DUENO, contenido: "x" }), /ENOTDIR/);
    assert.equal(readFileSync(path.join(homeD, ".adaceen"), "utf8"), "archivo");
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

test("sistema real: la sesion va al home del usuario Linux; si aun no existe no crea nada", async () => {
  const base = mkdtempSync(path.join(tmpdir(), "ws-homes-"));
  try {
    mkdirSync(path.join(base, "ws-eyder"));
    const pedidos = [];
    const sistema = crearSistemaReal(
      { homeBase: base, codeBin: "/bin/false" },
      {
        buscarUsuario: async (usuario) => {
          pedidos.push(usuario);
          return usuario === "ws-eyder" ? { usuario, ...DUENO, home: `/home/${usuario}` } : null;
        },
      },
    );
    assert.equal(await sistema.guardarSesionEditor("nadie", contenidoDePrueba()), false);
    assert.equal(existsSync(path.join(base, "ws-nadie")), false);

    assert.equal(await sistema.guardarSesionEditor("eyder", contenidoDePrueba()), true);
    const archivo = path.join(base, "ws-eyder", ".adaceen", "editor-session.json");
    assert.equal(JSON.parse(readFileSync(archivo, "utf8")).sessionId, SESION.sessionId);
    assert.deepEqual(pedidos, ["ws-nadie", "ws-eyder"]);
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

test("agente HTTP: editorSession se escribe siempre (ready, device_code, conflicto) y no sale en respuestas ni en el log", async () => {
  const agente = await iniciar();
  const log = capturarLog();
  try {
    agente.sistema.usuarios.add("eyder");
    agente.sistema.origenes.set("eyder", "eyder/proyecto");
    agente.sistema.estados.set("eyder", { usuarioExiste: true, servicio: ACTIVO, sesion: true, codigoJournal: null, nombreTunelReal: null });

    const listo = await agente.llamar("POST", "/workspaces", { login: "eyder", repo: "eyder/proyecto", editorSession: SESION });
    assert.equal(listo.status, 200);
    assert.equal(listo.json.state, "ready");
    assert.equal(agente.leer("corridas-eyder"), "", "con el tunel arriba no se corre el script");
    assert.equal(agente.sistema.escritas.length, 1);
    const documento = JSON.parse(agente.sistema.escritas[0].contenido);
    assert.equal(documento.version, 1);
    assert.equal(documento.sessionId, SESION.sessionId);
    assert.equal(documento.backendUrl, SESION.backendUrl);
    assert.equal(documento.userEmail, SESION.userEmail);
    assert.ok(Date.parse(documento.writtenAt) <= Date.now());

    // Esperando el codigo de dispositivo: tambien se escribe.
    agente.sistema.estados.set("eyder", {
      usuarioExiste: true,
      servicio: ACTIVO,
      sesion: false,
      codigoJournal: { codigo: "JOUR-0003", url: "https://github.com/login/device", vistoEn: Date.now() },
      nombreTunelReal: null,
    });
    const codigo = await agente.llamar("POST", "/workspaces", { login: "eyder", repo: "eyder/proyecto", editorSession: SESION });
    assert.equal(codigo.json.state, "device_code");
    assert.equal(agente.sistema.escritas.length, 2);

    // Otro repo (409): la sesion es de la persona, no del repo; se escribe igual.
    const otro = await agente.llamar("POST", "/workspaces", { login: "eyder", repo: "eyder/otro", editorSession: SESION });
    assert.equal(otro.status, 409);
    assert.equal(agente.sistema.escritas.length, 3);

    for (const respuesta of [listo, codigo, otro]) {
      assert.equal(JSON.stringify(respuesta.json).includes(SESION.sessionId), false, "el agente nunca devuelve el sessionId");
    }
    assert.ok(log.lineas.some((linea) => linea.includes("sesion del editor escrita")));
    assert.equal(log.lineas.some((linea) => linea.includes(SESION.sessionId)), false, "el sessionId nunca va al log");
  } finally {
    log.restaurar();
    await agente.cerrar();
  }
});

test("agente HTTP: usuario nuevo -> nuevo-tunel.sh recibe la sesion (archivo de root 0600, sin AGENT_TOKEN) y el agente la escribe al terminar", async () => {
  const agente = await iniciar();
  const log = capturarLog();
  const tokenPrevio = process.env.AGENT_TOKEN;
  process.env.AGENT_TOKEN = "no-debe-llegar-a-los-hijos-0123456789";
  try {
    const respuesta = await agente.llamar("POST", "/workspaces", { login: "nueva", repo: "nueva/repo", editorSession: SESION });
    assert.equal(respuesta.status, 200);
    assert.equal(respuesta.json.state, "device_code");
    assert.equal(JSON.stringify(respuesta.json).includes(SESION.sessionId), false);

    // El script vio la sesion en un archivo temporal 0600...
    assert.equal(JSON.parse(agente.leer("sesion-nueva")).sessionId, SESION.sessionId);
    assert.equal(agente.leer("modo-sesion-nueva").trim(), "-rw-------");
    // ...sin el token del agente en su entorno.
    assert.equal(agente.leer("token-nueva").trim(), "0");

    // Al terminar: el usuario ya existe, el agente escribe la sesion y borra el temporal.
    await esperarHasta(() => agente.sistema.escritas.some((escrita) => escrita.login === "nueva"));
    const temporal = agente.leer("dir-sesion-nueva").trim();
    assert.ok(temporal.includes("adaceen-sesion-"));
    await esperarHasta(() => !existsSync(temporal));
    assert.equal(log.lineas.some((linea) => linea.includes(SESION.sessionId)), false);

    // Otra preparacion con el usuario ya creado: se escribe directo, sin archivo para el script.
    agente.sistema.estados.set("nueva", { usuarioExiste: true, servicio: ACTIVO, sesion: true, codigoJournal: null, nombreTunelReal: null });
    const antes = agente.sistema.escritas.length;
    const otraVez = await agente.llamar("POST", "/workspaces", { login: "nueva", repo: "nueva/repo", editorSession: SESION });
    assert.equal(otraVez.json.state, "ready");
    assert.equal(agente.sistema.escritas.length, antes + 1);
  } finally {
    if (tokenPrevio === undefined) delete process.env.AGENT_TOKEN;
    else process.env.AGENT_TOKEN = tokenPrevio;
    log.restaurar();
    await agente.cerrar();
  }
});

test("agente HTTP: editorSession invalida o que no se puede escribir no impide preparar ni se registra", async () => {
  const agente = await iniciar();
  const log = capturarLog();
  try {
    const robada = "id-de-otra-persona-que-no-es-uuid";
    const mala = await agente.llamar("POST", "/workspaces", {
      login: "mala",
      repo: "mala/repo",
      editorSession: { ...SESION, sessionId: robada },
    });
    assert.equal(mala.status, 200);
    assert.equal(mala.json.state, "device_code");
    await new Promise((resolve) => setTimeout(resolve, 400));
    assert.equal(agente.sistema.escritas.length, 0);
    assert.equal(agente.leer("sesion-mala"), "", "el script no recibe una sesion invalida");
    assert.ok(log.lineas.some((linea) => linea.includes("editorSession invalida")));
    assert.equal(log.lineas.some((linea) => linea.includes(robada)), false);

    // Carpeta con un enlace plantado (el sistema lanza): se avisa y se sigue.
    agente.sistema.usuarios.add("enlace");
    agente.sistema.estados.set("enlace", { usuarioExiste: true, servicio: ACTIVO, sesion: true, codigoJournal: null, nombreTunelReal: null });
    const enlace = await agente.llamar("POST", "/workspaces", { login: "enlace", repo: "enlace/repo", editorSession: SESION });
    assert.equal(enlace.json.state, "ready");
    assert.ok(log.lineas.some((linea) => linea.includes("no se pudo escribir la sesion del editor") && linea.includes("ENOTDIR")));
    assert.equal(log.lineas.some((linea) => linea.includes(SESION.sessionId)), false);
  } finally {
    log.restaurar();
    await agente.cerrar();
  }
});

test("relay: editorSession llega intacta al agente local y se escribe", async () => {
  const agente = await iniciar();
  const log = capturarLog();
  try {
    agente.sistema.usuarios.add("relevo");
    agente.sistema.origenes.set("relevo", "relevo/repo");
    agente.sistema.estados.set("relevo", { usuarioExiste: true, servicio: ACTIVO, sesion: true, codigoJournal: null, nombreTunelReal: null });
    const relay = crearClienteRelay({
      relayUrl: "https://pdc.example/api/workspaces/agent",
      token: TOKEN,
      destino: agente.base,
      fetchImpl: fetch,
    });
    const resultado = await relay.atender({
      id: "trabajo-1",
      method: "POST",
      path: "/workspaces",
      body: { login: "relevo", repo: "relevo/repo", force: false, editorSession: SESION },
    });
    assert.equal(resultado.status, 200);
    assert.equal(resultado.json.state, "ready");
    assert.equal(JSON.stringify(resultado).includes(SESION.sessionId), false);
    assert.equal(agente.sistema.escritas.length, 1);
    assert.equal(JSON.parse(agente.sistema.escritas[0].contenido).sessionId, SESION.sessionId);
  } finally {
    log.restaurar();
    await agente.cerrar();
  }
});

test("agente: al cerrarse borra los archivos de sesion que pasaba a nuevo-tunel.sh", async () => {
  const agente = await iniciar({ esperaPrepararMs: 300 });
  let temporal = "";
  try {
    const respuesta = await agente.llamar("POST", "/workspaces", { login: "lento-sesion", repo: "l/s", editorSession: SESION });
    assert.equal(respuesta.json.state, "pending");
    await esperarHasta(() => agente.leer("dir-sesion-lento-sesion").trim() !== "");
    temporal = agente.leer("dir-sesion-lento-sesion").trim();
    assert.equal(existsSync(temporal), true);
  } finally {
    await agente.cerrar();
  }
  assert.equal(existsSync(temporal), false);
});

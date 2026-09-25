#!/usr/bin/env node
// Agente HTTP de la VM de editores (adaceen-ws): fase 2 del plan de tuneles
// (docs/workspaces-tunnel.md). PDC le pide "prepara el editor de <login> con
// <repo>"; el agente corre nuevo-tunel.sh, lee de su salida (o del journal del
// servicio adaceen-tunnel@) el codigo de dispositivo de GitHub y responde el
// estado del tunel.
//
//   POST /workspaces          {login, repo, force?} -> {state, deviceCode?, verificationUrl?, tunnelName, webUrl, ...}
//   GET  /workspaces/:login   -> {state: "ready"|"device_code"|"pending"|"error", tunnelName, webUrl, deviceCode?, message?}
//   GET  /health              -> {ok, running, queued} (sin token, no revela logins)
//
// Con AGENT_RELAY_URL (A15.3) el agente ademas recoge esas mismas peticiones
// desde PDC por HTTPS de salida (relay.mjs): la VM no necesita IP publica.
//
// Autenticacion: cabecera x-agent-token, comparada en tiempo constante con
// AGENT_TOKEN. En la VM, AGENT_TOKEN sale de la metadata workspace-agent-token
// (startup-ws.sh lo copia a /etc/adaceen-workspaces-agent.env, solo root).
//
// Variables: AGENT_TOKEN (obligatoria), AGENT_HOST (defecto 127.0.0.1; lista
// separada por comas, nunca 0.0.0.0), AGENT_PORT (8787), AGENT_SCRIPT
// (/opt/adaceen/nuevo-tunel.sh), AGENT_CODE_BIN (/usr/local/bin/code),
// AGENT_MAX_CONCURRENT (3), AGENT_MAX_QUEUE (40), AGENT_SCRIPT_TIMEOUT_MS
// (16 min), AGENT_PREPARE_WAIT_MS (10 s).
//
// Node puro, sin dependencias. Corre con el Node 18 de Debian 12 o posterior.
// Tiene que correr como root: nuevo-tunel.sh crea usuarios y unidades systemd.

import { execFile, spawn } from "node:child_process";
import { promises as fs, realpathSync } from "node:fs";
import http from "node:http";
import { fileURLToPath } from "node:url";
import {
  compararTokens,
  cuerpoRespuesta,
  decidirPreparacion,
  estadoServicio,
  extraerCodigoDispositivo,
  extraerNombreTunel,
  leerConfiguracion,
  leerOrigenGit,
  leerPropiedadesSystemd,
  mensajeDeFallo,
  normalizarLogin,
  repoDesdeUrl,
  resolverEstado,
  sesionIniciada,
  validarPeticionPreparar,
} from "./parse.mjs";
import { crearClienteRelay } from "./relay.mjs";

const MAX_SALIDA = 64 * 1024;
const MAX_CUERPO = 16 * 1024;
const MAX_TRABAJOS_GUARDADOS = 300;
const RETENCION_TRABAJO_MS = 60 * 60 * 1000;
const PAUSA_SONDEO_MS = 1500;
const GRACIA_MATAR_MS = 5000;
const EXIT_CONFIG = 78; // EX_CONFIG: la unidad systemd no reintenta en bucle

class ErrorHttp extends Error {
  constructor(status, codigo, mensaje) {
    super(mensaje);
    this.status = status;
    this.codigo = codigo;
  }
}

function registrar(nivel, mensaje, datos = {}) {
  const extra = Object.entries(datos)
    .map(([clave, valor]) => `${clave}=${JSON.stringify(valor)}`)
    .join(" ");
  const linea = `[agente] ${nivel} ${mensaje}${extra ? ` ${extra}` : ""}`;
  if (nivel === "error") console.error(linea);
  else console.log(linea);
}

// Ejecuta un comando SIN shell (lista de argumentos) y nunca rechaza.
function ejecutar(comando, argumentos, timeoutMs = 15000) {
  return new Promise((resolve) => {
    execFile(
      comando,
      argumentos,
      { timeout: timeoutMs, maxBuffer: 1024 * 1024, env: { ...process.env, LC_ALL: "C.UTF-8" } },
      (error, stdout, stderr) => {
        const codigo = !error ? 0 : typeof error.code === "number" ? error.code : -1;
        resolve({ codigo, stdout: String(stdout || ""), stderr: String(stderr || "") });
      },
    );
  });
}

async function esDirectorio(ruta) {
  try {
    return (await fs.stat(ruta)).isDirectory();
  } catch {
    return false;
  }
}

function marcaTiempo() {
  return new Date().toISOString().replace(/[-:.]/g, "");
}

function dormir(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// Lo que el agente mira de la VM. Se inyecta otro en las pruebas.
export function crearSistemaReal(config) {
  // login -> {codigo, url, vistoEn}: para calcular cuando vence un codigo que
  // solo aparece en el journal.
  const codigosVistos = new Map();

  function recordarCodigo(login, encontrado) {
    const previo = codigosVistos.get(login);
    if (previo && previo.codigo === encontrado.codigo) return previo;
    const nuevo = { ...encontrado, vistoEn: Date.now() };
    codigosVistos.set(login, nuevo);
    if (codigosVistos.size > 1000) codigosVistos.delete(codigosVistos.keys().next().value);
    return nuevo;
  }

  async function observar(login) {
    const usuario = `ws-${login}`;
    const home = `/home/${usuario}`;
    const usuarioExiste = await esDirectorio(home);
    const base = { usuarioExiste, servicio: estadoServicio({}), sesion: false, codigoJournal: null, nombreTunelReal: null };
    if (!usuarioExiste) return base;

    const unidad = `adaceen-tunnel@${usuario}.service`;
    const show = await ejecutar("systemctl", [
      "show",
      unidad,
      "--no-pager",
      "--property=LoadState,ActiveState,SubState,InvocationID",
    ]);
    const servicio = estadoServicio(leerPropiedadesSystemd(show.stdout));
    if (!servicio.activo && !servicio.arrancando) return { ...base, servicio };

    // Igual que nuevo-tunel.sh: el CLI como el usuario del estudiante, con su HOME.
    const usuarioShow = await ejecutar("runuser", [
      "-u", usuario, "--", "env", `HOME=${home}`, config.codeBin, "tunnel", "user", "show",
    ]);
    const sesion = sesionIniciada(usuarioShow.stdout, usuarioShow.codigo);

    let codigoJournal = null;
    let nombreTunelReal = null;
    if (servicio.invocacion) {
      // Solo las lineas del arranque actual del servicio (no codigos viejos).
      const journal = await ejecutar("journalctl", [
        `_SYSTEMD_INVOCATION_ID=${servicio.invocacion}`, "-o", "cat", "-a", "--no-pager", "-n", "400",
      ]);
      const encontrado = extraerCodigoDispositivo(journal.stdout);
      if (encontrado) codigoJournal = recordarCodigo(login, encontrado);
      nombreTunelReal = extraerNombreTunel(journal.stdout);
    }
    return { usuarioExiste, servicio, sesion, codigoJournal, nombreTunelReal };
  }

  // "owner/nombre" del clon actual, leyendo .git/config como texto (sin
  // ejecutar git como root sobre un repo del estudiante).
  async function origenProyecto(login) {
    const base = `/home/ws-${login}`;
    try {
      const real = await fs.realpath(`${base}/proyecto/.git/config`);
      if (!real.startsWith(`${base}/`)) return null;
      const info = await fs.stat(real);
      if (!info.isFile() || info.size > 64 * 1024) return null;
      return repoDesdeUrl(leerOrigenGit(await fs.readFile(real, "utf8")));
    } catch {
      return null;
    }
  }

  // force: para el tunel y aparta el clon (no se borra nada del estudiante);
  // nuevo-tunel.sh vuelve a clonar y a levantar el servicio.
  async function prepararRehacer(login) {
    const usuario = `ws-${login}`;
    await ejecutar("systemctl", ["stop", `adaceen-tunnel@${usuario}.service`], 60000);
    const proyecto = `/home/${usuario}/proyecto`;
    try {
      await fs.lstat(proyecto);
    } catch {
      return null;
    }
    const destino = `${proyecto}.bak-${marcaTiempo()}`;
    await fs.rename(proyecto, destino);
    return destino;
  }

  return { observar, origenProyecto, prepararRehacer };
}

function responder(res, status, cuerpo) {
  if (res.headersSent) return;
  const texto = JSON.stringify(cuerpo);
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
    "Content-Length": Buffer.byteLength(texto),
  });
  res.end(texto);
}

function leerCuerpo(req) {
  return new Promise((resolve, reject) => {
    let total = 0;
    let demasiado = false;
    const trozos = [];
    req.on("data", (trozo) => {
      total += trozo.length;
      if (total > MAX_CUERPO) {
        demasiado = true;
        return;
      }
      trozos.push(trozo);
    });
    req.on("end", () => {
      if (demasiado) reject(new ErrorHttp(413, "too_large", "Cuerpo demasiado grande."));
      else resolve(Buffer.concat(trozos).toString("utf8"));
    });
    req.on("error", reject);
  });
}

export function crearAgente({ config, sistema = crearSistemaReal(config), lanzarProceso = spawn } = {}) {
  const trabajos = new Map(); // login -> trabajo (el ultimo de cada login)
  const exclusivas = new Map(); // login -> promesa de la ultima decision en curso
  const cola = [];
  const servidores = [];
  let enCurso = 0;

  function vista(trabajo) {
    if (!trabajo) return null;
    return {
      fase: trabajo.fase,
      posicion: trabajo.fase === "en_cola" ? cola.indexOf(trabajo) + 1 : 0,
      codigo: trabajo.codigo,
      exito: trabajo.exito,
      fallo: trabajo.fallo,
      repoClave: trabajo.repo.clave,
      repoFullName: trabajo.repo.fullName,
    };
  }

  function notificar(trabajo) {
    const esperas = [...trabajo.esperas];
    trabajo.esperas.clear();
    for (const despertar of esperas) despertar();
  }

  // Duerme hasta `ms` o hasta que el trabajo cambie (codigo nuevo o fin).
  function esperarCambio(trabajo, ms) {
    return new Promise((resolve) => {
      const despertar = () => {
        clearTimeout(temporizador);
        trabajo?.esperas.delete(despertar);
        resolve();
      };
      const temporizador = setTimeout(despertar, Math.max(0, ms));
      trabajo?.esperas.add(despertar);
    });
  }

  function crearTrabajo(login, repo, respaldar) {
    return {
      login,
      repo,
      respaldar,
      fase: "en_cola",
      salida: "",
      codigo: null,
      exito: null,
      fallo: null,
      motivo: "",
      cancelado: false,
      contado: false,
      hijo: null,
      temporizador: null,
      terminado: 0,
      esperas: new Set(),
      alTerminar: [],
    };
  }

  function terminar(trabajo, resultado) {
    if (trabajo.fase === "terminado") return;
    trabajo.fase = "terminado";
    trabajo.terminado = Date.now();
    trabajo.exito = resultado.exito;
    trabajo.fallo = resultado.exito ? null : resultado.fallo;
    clearTimeout(trabajo.temporizador);
    if (trabajo.contado) {
      trabajo.contado = false;
      enCurso -= 1;
    }
    registrar(trabajo.exito ? "info" : "aviso", "preparacion terminada", {
      login: trabajo.login,
      repo: trabajo.repo.fullName,
      exito: trabajo.exito,
      ...(trabajo.fallo ? { code: trabajo.fallo.code, detail: trabajo.fallo.detail } : {}),
    });
    notificar(trabajo);
    for (const avisar of trabajo.alTerminar.splice(0)) avisar();
    siguiente();
  }

  function matar(trabajo) {
    const hijo = trabajo.hijo;
    if (!hijo || hijo.exitCode !== null || hijo.signalCode !== null) return;
    const enviar = (senal) => {
      try {
        process.kill(-hijo.pid, senal); // todo el grupo: bash, sudo, git, code
      } catch {
        try {
          hijo.kill(senal);
        } catch {
          // ya termino
        }
      }
    };
    enviar("SIGTERM");
    setTimeout(() => {
      if (hijo.exitCode === null && hijo.signalCode === null) enviar("SIGKILL");
    }, GRACIA_MATAR_MS).unref();
  }

  async function ejecutarTrabajo(trabajo) {
    if (trabajo.respaldar) {
      try {
        const respaldo = await sistema.prepararRehacer(trabajo.login);
        if (respaldo) registrar("info", "clon anterior apartado", { login: trabajo.login, respaldo });
      } catch (error) {
        terminar(trabajo, {
          exito: false,
          fallo: {
            code: "backup_failed",
            message: "No se pudo apartar el clon anterior para rehacer el entorno. Avisa al docente.",
            detail: String(error?.message || error).slice(0, 400),
          },
        });
        return;
      }
    }
    if (trabajo.cancelado) {
      terminar(trabajo, { exito: false, fallo: { code: "replaced", message: "Reemplazado por una preparacion nueva." } });
      return;
    }

    // Sin shell: login y URL ya validados viajan como argumentos sueltos.
    const hijo = lanzarProceso("/bin/bash", [config.script, trabajo.login, trabajo.repo.url], {
      stdio: ["ignore", "pipe", "pipe"],
      detached: true,
      env: { ...process.env, GIT_TERMINAL_PROMPT: "0", LC_ALL: "C.UTF-8" },
    });
    trabajo.hijo = hijo;

    const agregar = (trozo) => {
      trabajo.salida = (trabajo.salida + trozo).slice(-MAX_SALIDA);
      const encontrado = extraerCodigoDispositivo(trabajo.salida);
      if (encontrado && encontrado.codigo !== trabajo.codigo?.codigo) {
        trabajo.codigo = { ...encontrado, vistoEn: Date.now() };
        registrar("info", "codigo de dispositivo emitido", { login: trabajo.login });
        notificar(trabajo);
      }
    };
    hijo.stdout.setEncoding("utf8");
    hijo.stderr.setEncoding("utf8");
    hijo.stdout.on("data", agregar);
    hijo.stderr.on("data", agregar);

    trabajo.temporizador = setTimeout(() => {
      trabajo.motivo = "timeout";
      matar(trabajo);
    }, config.timeoutScriptMs);

    hijo.on("error", (error) => {
      trabajo.salida += `\n${error.message}`;
      terminar(trabajo, { exito: false, fallo: mensajeDeFallo(trabajo.salida, { motivo: "spawn" }) });
    });
    hijo.on("close", (codigoSalida, senal) => {
      const exito = codigoSalida === 0 && !trabajo.motivo;
      terminar(
        trabajo,
        exito
          ? { exito: true }
          : { exito: false, fallo: mensajeDeFallo(trabajo.salida, { codigoSalida, senal, motivo: trabajo.motivo }) },
      );
    });
  }

  function arrancar(trabajo) {
    trabajo.fase = "corriendo";
    trabajo.contado = true;
    enCurso += 1;
    registrar("info", "preparando", { login: trabajo.login, repo: trabajo.repo.fullName, force: trabajo.respaldar });
    ejecutarTrabajo(trabajo).catch((error) => {
      trabajo.salida += `\n${error?.message || error}`;
      terminar(trabajo, { exito: false, fallo: mensajeDeFallo(trabajo.salida, { motivo: "spawn" }) });
    });
  }

  function siguiente() {
    while (enCurso < config.maxConcurrentes && cola.length) {
      arrancar(cola.shift());
    }
  }

  function encolar(trabajo) {
    if (enCurso >= config.maxConcurrentes && cola.length >= config.maxCola) return false;
    trabajos.set(trabajo.login, trabajo);
    if (enCurso < config.maxConcurrentes) arrancar(trabajo);
    else cola.push(trabajo);
    return true;
  }

  async function reemplazar(anterior) {
    anterior.cancelado = true;
    anterior.motivo = "reemplazado";
    const enCola = cola.indexOf(anterior);
    if (enCola >= 0) {
      cola.splice(enCola, 1);
      terminar(anterior, { exito: false, fallo: { code: "replaced", message: "Reemplazado por una preparacion nueva." } });
      return;
    }
    if (anterior.fase === "corriendo") {
      const fin = new Promise((resolve) => anterior.alTerminar.push(resolve));
      matar(anterior);
      await Promise.race([fin, dormir(GRACIA_MATAR_MS + 3000)]);
    }
  }

  function podar() {
    if (trabajos.size <= MAX_TRABAJOS_GUARDADOS) return;
    const limite = Date.now() - RETENCION_TRABAJO_MS;
    for (const [login, trabajo] of trabajos) {
      if (trabajo.fase === "terminado" && trabajo.terminado < limite) trabajos.delete(login);
    }
  }

  function olvidarSiTerminado(login) {
    if (trabajos.get(login)?.fase === "terminado") trabajos.delete(login);
  }

  async function estadoActual(login) {
    const trabajo = trabajos.get(login) || null;
    const observado = await sistema.observar(login);
    const estado = resolverEstado({ trabajo: vista(trabajo), sistema: observado, ahora: Date.now() });
    return { estado, observado, trabajo };
  }

  async function esperarEstado(login, ms) {
    const limite = Date.now() + ms;
    for (;;) {
      const actual = await estadoActual(login);
      const restante = limite - Date.now();
      if (actual.estado.state !== "pending" || restante <= 0) return actual;
      await esperarCambio(actual.trabajo, Math.min(PAUSA_SONDEO_MS, restante));
    }
  }

  async function manejarPreparar(req, res) {
    let cuerpo;
    try {
      const texto = await leerCuerpo(req);
      cuerpo = texto.trim() ? JSON.parse(texto) : {};
    } catch (error) {
      if (error instanceof ErrorHttp) throw error;
      throw new ErrorHttp(400, "invalid_json", "El cuerpo no es JSON valido.");
    }
    const peticion = validarPeticionPreparar(cuerpo);
    if (!peticion.ok) {
      return responder(res, 400, { state: "error", code: "invalid_input", message: peticion.message });
    }
    const { login, repo, forzar } = peticion;
    const llegada = Date.now();

    // La decision (y el encolado) va de a una por login: dos clics o dos
    // pestanas no lanzan nuevo-tunel.sh dos veces para el mismo usuario. La
    // espera del codigo queda fuera, para no sumar esperas entre peticiones.
    const inmediata = await enExclusiva(login, () => decidirYEncolar(login, repo, forzar));
    if (inmediata) return responder(res, inmediata.status, inmediata.cuerpo);

    // La peticion entera dura como mucho AGENT_PREPARE_WAIT_MS (mas una
    // observacion), aunque un force haya tenido que esperar al trabajo viejo.
    const restante = Math.max(0, config.esperaPrepararMs - (Date.now() - llegada));
    const { estado, observado, trabajo } = await esperarEstado(login, restante);
    return responder(res, 200, cuerpoRespuesta(login, estado, observado, trabajo?.repo || repo));
  }

  // Devuelve {status, cuerpo} si hay que responder ya, o null si quedo un
  // trabajo en marcha (nuevo o existente) cuyo estado hay que esperar.
  async function decidirYEncolar(login, repo, forzar) {
    podar();
    const existente = trabajos.get(login) || null;
    const enMarcha = existente && (existente.fase === "en_cola" || existente.fase === "corriendo");
    const mirarSistema = !enMarcha && !forzar;
    const observado = mirarSistema ? await sistema.observar(login) : null;
    const origen = mirarSistema ? await sistema.origenProyecto(login) : null;
    const decision = decidirPreparacion({
      trabajo: vista(existente),
      sistema: observado,
      repo,
      origen,
      forzar,
      ahora: Date.now(),
    });

    if (decision.accion === "conflicto" || decision.accion === "responder") {
      // Un fallo viejo ya no describe el tunel: que GET mire el sistema.
      olvidarSiTerminado(login);
      registrar("info", "preparar sin lanzar", { login, repo: repo.fullName, state: decision.respuesta.state });
      return {
        status: decision.accion === "conflicto" ? 409 : 200,
        cuerpo: cuerpoRespuesta(login, decision.respuesta, observado, repo),
      };
    }

    if (decision.accion === "relanzar") await reemplazar(existente);
    if (decision.accion === "relanzar" || decision.accion === "lanzar") {
      const nuevo = crearTrabajo(login, repo, decision.respaldar === true);
      if (!encolar(nuevo)) {
        return {
          status: 429,
          cuerpo: cuerpoRespuesta(login, {
            state: "error",
            code: "busy",
            message: "La VM de editores esta ocupada preparando otros entornos. Intenta de nuevo en un minuto.",
          }, null, repo),
        };
      }
    }
    return null;
  }

  // Cerrojo por clave con promesas encadenadas (sin dependencias).
  async function enExclusiva(clave, tarea) {
    const anterior = exclusivas.get(clave) || Promise.resolve();
    const actual = anterior.then(tarea, tarea);
    const cola = actual.catch(() => {});
    exclusivas.set(clave, cola);
    try {
      return await actual;
    } finally {
      if (exclusivas.get(clave) === cola) exclusivas.delete(clave);
    }
  }

  async function manejarEstado(loginCrudo, res) {
    const login = normalizarLogin(loginCrudo);
    if (!login) {
      return responder(res, 400, { state: "error", code: "invalid_input", message: "login invalido." });
    }
    const { estado, observado, trabajo } = await estadoActual(login);
    const status = estado.code === "not_found" ? 404 : 200;
    return responder(res, status, cuerpoRespuesta(login, estado, observado, trabajo?.repo || null));
  }

  async function manejar(req, res) {
    try {
      const url = new URL(req.url || "/", "http://agente.local");
      const ruta = url.pathname.replace(/\/+$/, "") || "/";

      if (req.method === "GET" && ruta === "/health") {
        return responder(res, 200, { ok: true, running: enCurso, queued: cola.length, maxConcurrent: config.maxConcurrentes });
      }

      const recibido = req.headers["x-agent-token"];
      if (!compararTokens(Array.isArray(recibido) ? recibido[0] : recibido, config.token)) {
        return responder(res, 401, { state: "error", code: "unauthorized", message: "Token del agente invalido o ausente." });
      }

      if (req.method === "POST" && ruta === "/workspaces") return await manejarPreparar(req, res);

      const porLogin = ruta.match(/^\/workspaces\/([^/]+)$/);
      if (req.method === "GET" && porLogin) {
        let login;
        try {
          login = decodeURIComponent(porLogin[1]);
        } catch {
          throw new ErrorHttp(400, "invalid_input", "login invalido.");
        }
        return await manejarEstado(login, res);
      }

      return responder(res, 404, { state: "error", code: "no_route", message: "Ruta no encontrada." });
    } catch (error) {
      if (error instanceof ErrorHttp) {
        return responder(res, error.status, { state: "error", code: error.codigo, message: error.message });
      }
      registrar("error", "fallo inesperado", { error: String(error?.stack || error) });
      return responder(res, 500, { state: "error", code: "internal", message: "Error interno del agente." });
    }
  }

  function escuchar() {
    return Promise.all(config.hosts.map((host) => new Promise((resolve, reject) => {
      const servidor = http.createServer((req, res) => {
        manejar(req, res);
      });
      servidor.headersTimeout = 20000;
      servidor.requestTimeout = 60000;
      servidor.once("error", reject);
      servidor.listen(config.puerto, host, () => {
        servidor.off("error", reject);
        servidores.push(servidor);
        resolve(servidor);
      });
    })));
  }

  async function cerrar() {
    for (const trabajo of trabajos.values()) {
      trabajo.cancelado = true;
      matar(trabajo);
    }
    cola.splice(0);
    await Promise.all(servidores.splice(0).map((servidor) => new Promise((resolve) => {
      servidor.close(() => resolve());
      servidor.closeAllConnections?.();
    })));
  }

  return { manejar, escuchar, cerrar, estadoInterno: () => ({ enCurso, enCola: cola.length, trabajos: trabajos.size }) };
}

async function main() {
  let config;
  try {
    config = leerConfiguracion(process.env);
  } catch (error) {
    registrar("error", error.message);
    process.exit(EXIT_CONFIG);
  }
  if (typeof process.getuid === "function" && process.getuid() !== 0) {
    registrar("aviso", "el agente no corre como root: nuevo-tunel.sh fallara (useradd, systemctl)");
  }
  const agente = crearAgente({ config });
  try {
    await agente.escuchar();
  } catch (error) {
    registrar("error", `no se pudo escuchar en ${config.hosts.join(",")}:${config.puerto}: ${error.message}`);
    process.exit(1);
  }
  registrar("info", "escuchando", {
    hosts: config.hosts,
    puerto: config.puerto,
    maxConcurrentes: config.maxConcurrentes,
    script: config.script,
  });
  // A15.3: sin IP publica, PDC no puede llamar al agente; el agente le pregunta.
  let relay = null;
  if (config.relayUrl) {
    const hostLocal = config.hosts.includes("127.0.0.1") ? "127.0.0.1" : config.hosts[0];
    relay = crearClienteRelay({
      relayUrl: config.relayUrl,
      token: config.token,
      destino: `http://${hostLocal}:${config.puerto}`,
      esperaS: config.relayEsperaS,
      registrar,
    });
    relay.iniciar();
    registrar("info", "relay activo", { relay: config.relayUrl });
  }
  const salir = () => {
    Promise.resolve(relay?.detener())
      .finally(() => agente.cerrar())
      .finally(() => process.exit(0));
  };
  process.on("SIGTERM", salir);
  process.on("SIGINT", salir);
}

function esPrincipal() {
  try {
    return Boolean(process.argv[1]) && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url);
  } catch {
    return false;
  }
}

if (esPrincipal()) {
  main();
}

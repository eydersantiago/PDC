// Logica pura del agente de entornos (sin E/S): validacion de entradas,
// lectura de lo que imprimen nuevo-tunel.sh, el CLI de VS Code y systemd, y
// la maquina de estados que decide que responderle a PDC.
//
// Pruebas: node --test deploy/gcp/workspaces/agente/*.test.mjs
//
// Compatible con Node 18.19+ (el nodejs de Debian 12, que es lo que instala
// startup-ws.sh): nada de APIs exclusivas de Node 20+.

import { createHash, timingSafeEqual } from "node:crypto";
import { isIP } from "node:net";

export const URL_VERIFICACION_GITHUB = "https://github.com/login/device";
// GitHub da 15 min (expires_in = 900 s) a cada codigo de dispositivo. Al
// vencer, el CLI pide otro y lo vuelve a imprimir: siempre vale el ultimo.
export const VIDA_CODIGO_MS = 15 * 60 * 1000;
export const LARGO_MINIMO_TOKEN = 24;

// Login de GitHub tal como lo acepta nuevo-tunel.sh: minusculas, digitos y
// guiones, sin guion inicial, maximo 28 caracteres (ws-<login> tiene que
// caber en los 32 de un usuario Linux). Nada de esto llega a un shell: el
// agente pasa los argumentos a bash como lista, sin interpretar.
const LOGIN_RE = /^[a-z0-9][a-z0-9-]{0,27}$/;
const DUENO_RE = /^[A-Za-z0-9][A-Za-z0-9-]{0,38}$/;
const NOMBRE_REPO_RE = /^[A-Za-z0-9._-]{1,100}$/;
const INVOCACION_RE = /^[0-9a-f]{32}$/;

// Secuencias de color/cursor que el CLI podria emitir si creyera tener terminal.
const ANSI_RE = /\u001b\[[0-9;?]*[ -/]*[@-~]/g;

export function normalizarLogin(valor) {
  if (typeof valor !== "string") return null;
  const login = valor.trim().toLowerCase();
  return LOGIN_RE.test(login) ? login : null;
}

// Acepta "owner/nombre", "owner/nombre.git" o "https://github.com/owner/nombre(.git)".
// Devuelve el nombre canonico y la URL https que se le pasa a git clone; la
// URL siempre empieza por https://github.com/, asi que no hay forma de colar
// opciones de git (--upload-pack, ext::, file://...).
export function normalizarRepo(valor) {
  if (typeof valor !== "string") return null;
  const texto = valor.trim();
  if (!texto || texto.length > 300) return null;

  const comoUrl = texto.match(/^https:\/\/github\.com\/([^/?#\s]+)\/([^/?#\s]+?)(?:\.git)?\/?$/i);
  const comoNombre = comoUrl ? null : texto.match(/^([^/\s]+)\/([^/\s]+?)(?:\.git)?$/);
  const partes = comoUrl || comoNombre;
  if (!partes) return null;

  const [, dueno, nombre] = partes;
  if (!DUENO_RE.test(dueno) || !NOMBRE_REPO_RE.test(nombre) || nombre === "." || nombre === "..") {
    return null;
  }
  return {
    fullName: `${dueno}/${nombre}`,
    clave: `${dueno}/${nombre}`.toLowerCase(),
    url: `https://github.com/${dueno}/${nombre}.git`,
  };
}

// Misma regla que nuevo-tunel.sh: Dev Tunnels limita el nombre a 20 caracteres.
export function nombreTunel(login) {
  return `ad-${String(login).slice(0, 17)}`;
}

// El CLI publica https://vscode.dev/tunnel/<nombre>/<WorkingDirectory>, y la
// unidad adaceen-tunnel@ fija WorkingDirectory=/home/ws-<login>/proyecto.
export function urlEditor(login, tunel = nombreTunel(login)) {
  return `https://vscode.dev/tunnel/${tunel}/home/ws-${login}/proyecto`;
}

export function quitarAnsi(texto) {
  return String(texto || "").replace(ANSI_RE, "").replace(/\r/g, "");
}

// El CLI (cli/src/auth.rs) imprime, en una sola linea:
//   To grant access to the server, please log into https://github.com/login/device and use code ABCD-1234
// En el journal la linea puede llevar prefijo (fecha, host, pid). La variante
// suelta cubre el mensaje partido en dos lineas. Se devuelve la ULTIMA
// aparicion: cuando un codigo vence, el CLI imprime otro.
const CODIGO_EXACTO_RE = /log into\s+(https:\/\/\S+?)\s+and use code\s+([A-Z0-9]{4}-[A-Z0-9]{4})\b/g;
const CODIGO_SUELTO_RE = /(https:\/\/github\.com\/login\/device)\b[\s\S]{0,160}?\bcode\s+([A-Z0-9]{4}-[A-Z0-9]{4})\b/g;

export function extraerCodigoDispositivo(texto) {
  const limpio = quitarAnsi(texto);
  let ultimo = null;
  for (const expresion of [CODIGO_EXACTO_RE, CODIGO_SUELTO_RE]) {
    expresion.lastIndex = 0;
    let coincidencia = expresion.exec(limpio);
    while (coincidencia) {
      const fin = coincidencia.index + coincidencia[0].length;
      if (!ultimo || fin >= ultimo.fin) {
        ultimo = { fin, codigo: coincidencia[2], url: coincidencia[1] };
      }
      coincidencia = expresion.exec(limpio);
    }
  }
  if (!ultimo) return null;
  const url = /^https:\/\/(github\.com|microsoft\.com)\//i.test(ultimo.url) ? ultimo.url : URL_VERIFICACION_GITHUB;
  return { codigo: ultimo.codigo, url };
}

// Cuando el tunel queda conectado, el CLI imprime su enlace
// (https://vscode.dev/tunnel/<nombre>/...). Si el nombre pedido estaba ocupado
// en la cuenta, el CLI elige otro al azar: este es el nombre real.
export function extraerNombreTunel(texto) {
  const limpio = quitarAnsi(texto);
  const expresion = /https:\/\/vscode\.dev\/tunnel\/([A-Za-z0-9-]{1,40})(?=[/\s]|$)/g;
  let nombre = null;
  let coincidencia = expresion.exec(limpio);
  while (coincidencia) {
    nombre = coincidencia[1].toLowerCase();
    coincidencia = expresion.exec(limpio);
  }
  return nombre;
}

// `code tunnel user show` imprime "logged in with provider github" (salida 0)
// o "not logged in" (salida 1). Ojo: un grep -i "logged in" casa con las dos.
export function sesionIniciada(salida, codigoSalida) {
  if (codigoSalida !== 0) return false;
  const texto = quitarAnsi(salida).toLowerCase();
  if (/\bnot logged in\b/.test(texto)) return false;
  return /\blogged in\b/.test(texto);
}

// Salida de `systemctl show <unidad> --property=...`: lineas Clave=Valor.
export function leerPropiedadesSystemd(texto) {
  const propiedades = {};
  for (const linea of String(texto || "").split(/\r?\n/)) {
    const igual = linea.indexOf("=");
    if (igual > 0) {
      propiedades[linea.slice(0, igual).trim()] = linea.slice(igual + 1).trim();
    }
  }
  return propiedades;
}

export function estadoServicio(propiedades = {}) {
  const activo = propiedades.ActiveState === "active";
  const sub = propiedades.SubState || "";
  const invocacion = String(propiedades.InvocationID || "").toLowerCase();
  return {
    // "active" + "running": el proceso de code tunnel esta vivo.
    activo: activo && (!sub || sub === "running"),
    // activating / auto-restart: systemd lo esta (re)arrancando.
    arrancando: ["activating", "reloading"].includes(propiedades.ActiveState) || sub === "auto-restart",
    fallido: propiedades.ActiveState === "failed",
    invocacion: INVOCACION_RE.test(invocacion) ? invocacion : "",
  };
}

// URL del remoto origin en un .git/config (solo lectura de texto, sin git).
export function leerOrigenGit(configuracion) {
  let enOrigin = false;
  for (const cruda of String(configuracion || "").split(/\r?\n/)) {
    const linea = cruda.trim();
    if (linea.startsWith("[")) {
      enOrigin = /^\[remote\s+"origin"\]$/i.test(linea);
      continue;
    }
    if (enOrigin) {
      const url = linea.match(/^url\s*=\s*(.+)$/i);
      if (url) return url[1].trim();
    }
  }
  return null;
}

// "owner/nombre" en minusculas a partir de una URL de GitHub (https, con o sin
// credenciales, o ssh). null si no es de github.com.
export function repoDesdeUrl(url) {
  const coincidencia = String(url || "").trim().match(/github\.com[/:]([^/\s]+)\/([^/\s]+?)(?:\.git)?\/?$/i);
  if (!coincidencia) return null;
  return `${coincidencia[1]}/${coincidencia[2]}`.toLowerCase();
}

// Comparacion en tiempo constante: se comparan resumenes SHA-256 de igual
// largo, asi ni el contenido ni el largo del token se filtran por tiempos.
export function compararTokens(recibido, esperado) {
  if (typeof recibido !== "string" || typeof esperado !== "string" || !recibido || !esperado) {
    return false;
  }
  const a = createHash("sha256").update(recibido, "utf8").digest();
  const b = createHash("sha256").update(esperado, "utf8").digest();
  return timingSafeEqual(a, b);
}

export function validarPeticionPreparar(cuerpo) {
  if (!cuerpo || typeof cuerpo !== "object" || Array.isArray(cuerpo)) {
    return { ok: false, message: "Se esperaba un objeto JSON {login, repo, force?}." };
  }
  const login = normalizarLogin(cuerpo.login);
  if (!login) {
    return {
      ok: false,
      message: "login invalido: se espera el usuario de GitHub (letras, digitos y guiones, maximo 28), no el correo.",
    };
  }
  const repo = normalizarRepo(cuerpo.repo);
  if (!repo) {
    return { ok: false, message: "repo invalido: se espera owner/nombre o https://github.com/owner/nombre." };
  }
  if (cuerpo.force !== undefined && typeof cuerpo.force !== "boolean") {
    return { ok: false, message: "force debe ser true o false." };
  }
  return { ok: true, login, repo, forzar: cuerpo.force === true };
}

function recortar(texto, maximo) {
  const limpio = String(texto || "").trim();
  return limpio.length > maximo ? `${limpio.slice(0, maximo - 3)}...` : limpio;
}

function ultimasLineas(texto, cantidad) {
  return quitarAnsi(texto)
    .split("\n")
    .map((linea) => linea.trim())
    .filter(Boolean)
    .slice(-cantidad)
    .join(" | ");
}

// Traduce un fallo de nuevo-tunel.sh a un mensaje para el estudiante (message)
// y una pista tecnica para quien opera la VM (detail).
export function mensajeDeFallo(salida, { codigoSalida = null, senal = null, motivo = "" } = {}) {
  const texto = quitarAnsi(salida);
  const detalle = recortar(ultimasLineas(texto, 3), 400);
  if (motivo === "timeout") {
    return {
      code: "timeout",
      message: "La preparacion del editor tardo demasiado y se cancelo. Intenta de nuevo.",
      detail: detalle,
    };
  }
  if (motivo === "spawn") {
    return {
      code: "spawn_failed",
      message: "La VM de editores no pudo lanzar el script de preparacion. Avisa al docente.",
      detail: detalle,
    };
  }
  if (/login invalido/i.test(texto)) {
    return { code: "invalid_login", message: "El usuario de GitHub no es valido para crear el editor.", detail: detalle };
  }
  if (/repository .*not found|could not read username|authentication failed|terminal prompts disabled|invalid username or password/i.test(texto)) {
    return {
      code: "clone_failed",
      message: "No se pudo clonar el repositorio: no existe o es privado. Por ahora el editor por tunel solo clona repositorios publicos.",
      detail: detalle,
    };
  }
  const fatalGit = texto.match(/fatal: (.+)/);
  if (fatalGit) {
    return {
      code: "clone_failed",
      message: `No se pudo clonar el repositorio (${recortar(fatalGit[1], 160)}).`,
      detail: detalle,
    };
  }
  if (/useradd:/i.test(texto)) {
    return { code: "user_failed", message: "No se pudo crear el usuario del editor en la VM. Avisa al docente.", detail: detalle };
  }
  if (/adaceen-ws\.env/.test(texto) && /no such file/i.test(texto)) {
    return {
      code: "vm_not_ready",
      message: "La VM de editores aun no termino de arrancar. Intenta de nuevo en un par de minutos.",
      detail: detalle,
    };
  }
  const razon = senal ? `senal ${senal}` : `codigo ${codigoSalida}`;
  return {
    code: "script_failed",
    message: "No se pudo preparar el editor en la VM. Intenta de nuevo; si se repite, avisa al docente.",
    detail: recortar(`nuevo-tunel.sh termino con ${razon}${detalle ? `: ${detalle}` : ""}`, 400),
  };
}

function vigente(codigo, ahora) {
  return codigo && Number.isFinite(codigo.vistoEn) && ahora - codigo.vistoEn < VIDA_CODIGO_MS ? codigo : null;
}

function masReciente(a, b) {
  if (!a) return b || null;
  if (!b) return a;
  return b.vistoEn > a.vistoEn ? b : a;
}

function estadoCodigo(codigo) {
  return {
    state: "device_code",
    deviceCode: codigo.codigo,
    verificationUrl: codigo.url || URL_VERIFICACION_GITHUB,
    expiresAt: new Date(codigo.vistoEn + VIDA_CODIGO_MS).toISOString(),
    message: "Autoriza el editor en GitHub con este codigo (solo la primera vez).",
  };
}

/**
 * Decide el estado de un login a partir de lo observado. Sin E/S.
 *
 * trabajo: null o { fase: "en_cola" | "corriendo" | "terminado", posicion?,
 *            codigo?: {codigo, url, vistoEn}, exito?, fallo?: {code, message, detail} }
 * sistema: { usuarioExiste, servicio: {activo, arrancando, fallido}, sesion,
 *            codigoJournal?: {codigo, url, vistoEn} }
 *
 * Hay dos caminos para el codigo de dispositivo y los dos se aceptan:
 *   a) nuevo-tunel.sh corre `code tunnel user login` y lo imprime en su salida;
 *   b) el script cree que ya hay sesion y el propio servicio adaceen-tunnel@
 *      lo imprime en el journal (es lo que pasa hoy: su grep "logged in"
 *      tambien casa con "not logged in").
 * "ready" exige servicio activo Y sesion del CLI iniciada.
 */
export function resolverEstado({ trabajo = null, sistema = null, ahora = Date.now() } = {}) {
  const observado = sistema || { usuarioExiste: false, servicio: {}, sesion: false };
  const servicio = observado.servicio || {};
  const codigo = vigente(masReciente(trabajo?.codigo || null, observado.codigoJournal || null), ahora);

  if (trabajo?.fase === "en_cola") {
    const posicion = Number(trabajo.posicion) || 1;
    return {
      state: "pending",
      message: `En cola: la VM esta preparando otros editores (${posicion} antes que el tuyo).`,
    };
  }

  if (trabajo?.fase === "corriendo") {
    if (codigo && !observado.sesion) return estadoCodigo(codigo);
    return { state: "pending", message: "Clonando el repositorio y registrando el tunel..." };
  }

  if (trabajo?.fase === "terminado" && !trabajo.exito) {
    const fallo = trabajo.fallo || {};
    return {
      state: "error",
      code: fallo.code || "script_failed",
      message: fallo.message || "No se pudo preparar el editor.",
      ...(fallo.detail ? { detail: fallo.detail } : {}),
    };
  }

  if (!observado.usuarioExiste) {
    return {
      state: "error",
      code: "not_found",
      message: "Todavia no hay un editor preparado para esta cuenta. Pulsa Preparar entorno.",
    };
  }

  if (servicio.activo && observado.sesion) return { state: "ready" };

  if ((servicio.activo || servicio.arrancando) && !observado.sesion) {
    if (codigo) return estadoCodigo(codigo);
    return { state: "pending", message: "Esperando a que el tunel pida la autorizacion de GitHub..." };
  }

  if (servicio.arrancando) return { state: "pending", message: "Arrancando el tunel..." };

  if (servicio.fallido) {
    return {
      state: "error",
      code: "tunnel_failed",
      message: "El tunel de tu editor no pudo arrancar. Pulsa Preparar entorno de nuevo; si se repite, avisa al docente.",
    };
  }

  return {
    state: "error",
    code: "tunnel_stopped",
    message: "Tu editor esta apagado. Pulsa Preparar entorno para encenderlo.",
  };
}

/**
 * Que hacer ante POST /workspaces. Sin E/S.
 * Devuelve { accion: "esperar" | "relanzar" | "lanzar" | "responder" | "conflicto", respaldar?, respuesta? }.
 */
export function decidirPreparacion({ trabajo = null, sistema = null, repo, origen = null, forzar = false, ahora = Date.now() }) {
  const enMarcha = trabajo && (trabajo.fase === "en_cola" || trabajo.fase === "corriendo");
  if (enMarcha) {
    if (forzar) return { accion: "relanzar", respaldar: true };
    if (trabajo.repoClave && trabajo.repoClave !== repo.clave) {
      return {
        accion: "conflicto",
        respuesta: {
          state: "error",
          code: "busy_other_repo",
          message: `Ya se esta preparando ${trabajo.repoFullName || "otro repositorio"} para esta cuenta. Espera a que termine.`,
        },
      };
    }
    return { accion: "esperar" };
  }

  if (forzar) return { accion: "lanzar", respaldar: true };

  if (origen && origen !== repo.clave) {
    return {
      accion: "conflicto",
      respuesta: {
        state: "error",
        code: "repo_mismatch",
        message: `Tu editor ya tiene clonado ${origen}. Para cambiarlo por ${repo.fullName} usa la opcion de rehacer el entorno; la copia actual se guarda como respaldo en la VM.`,
      },
    };
  }

  // Idempotencia: tunel arriba (o ya esperando su codigo) -> no se relanza nada.
  const actual = resolverEstado({ trabajo: null, sistema, ahora });
  if (actual.state === "ready" || actual.state === "device_code") {
    return { accion: "responder", respuesta: actual };
  }
  return { accion: "lanzar", respaldar: false };
}

// Cuerpo JSON que ve PDC. tunnelName/webUrl siguen la regla de nuevo-tunel.sh,
// salvo que el journal diga que el CLI registro otro nombre.
export function cuerpoRespuesta(login, estado, observado = null, repo = null) {
  const tunel = observado?.nombreTunelReal || nombreTunel(login);
  return {
    login,
    state: estado.state,
    tunnelName: tunel,
    webUrl: urlEditor(login, tunel),
    ...(repo?.fullName ? { repo: repo.fullName } : {}),
    ...(estado.state === "device_code"
      ? { deviceCode: estado.deviceCode, verificationUrl: estado.verificationUrl, expiresAt: estado.expiresAt }
      : {}),
    ...(estado.message ? { message: estado.message } : {}),
    ...(estado.code ? { code: estado.code } : {}),
    ...(estado.detail ? { detail: estado.detail } : {}),
  };
}

function numeroPositivo(valor, porDefecto, nombre) {
  if (valor === undefined || valor === null || String(valor).trim() === "") return porDefecto;
  const numero = Number(valor);
  if (!Number.isFinite(numero) || numero <= 0) {
    throw new Error(`${nombre} debe ser un numero positivo.`);
  }
  return Math.floor(numero);
}

// Nunca 0.0.0.0 ni ::: el agente escucha solo en direcciones concretas
// (127.0.0.1 y/o la IP interna de la VM).
export function leerHosts(valor) {
  const hosts = String(valor || "127.0.0.1")
    .split(",")
    .map((host) => host.trim())
    .filter(Boolean);
  if (!hosts.length) throw new Error("AGENT_HOST vacio.");
  for (const host of hosts) {
    if (host === "0.0.0.0" || host === "::" || host === "[::]") {
      throw new Error(`AGENT_HOST=${host} escucharia en todas las interfaces; usa la IP interna o 127.0.0.1.`);
    }
    if (host !== "localhost" && !isIP(host)) {
      throw new Error(`AGENT_HOST=${host} no es una IP.`);
    }
  }
  return [...new Set(hosts)];
}

export function leerConfiguracion(entorno = {}) {
  const token = String(entorno.AGENT_TOKEN || "").trim();
  if (token.length < LARGO_MINIMO_TOKEN) {
    throw new Error(
      `AGENT_TOKEN ausente o corto (minimo ${LARGO_MINIMO_TOKEN} caracteres). En la VM llega por la metadata workspace-agent-token.`,
    );
  }
  const puerto = numeroPositivo(entorno.AGENT_PORT, 8787, "AGENT_PORT");
  if (puerto > 65535) throw new Error("AGENT_PORT fuera de rango.");
  return {
    token,
    hosts: leerHosts(entorno.AGENT_HOST),
    puerto,
    script: String(entorno.AGENT_SCRIPT || "/opt/adaceen/nuevo-tunel.sh").trim(),
    codeBin: String(entorno.AGENT_CODE_BIN || "/usr/local/bin/code").trim(),
    maxConcurrentes: numeroPositivo(entorno.AGENT_MAX_CONCURRENT, 3, "AGENT_MAX_CONCURRENT"),
    maxCola: numeroPositivo(entorno.AGENT_MAX_QUEUE, 40, "AGENT_MAX_QUEUE"),
    // 16 min: el clon mas el codigo de dispositivo (15 min) si el script
    // llega a esperar el login; hoy termina en segundos.
    timeoutScriptMs: numeroPositivo(entorno.AGENT_SCRIPT_TIMEOUT_MS, 16 * 60 * 1000, "AGENT_SCRIPT_TIMEOUT_MS"),
    // Lo que POST /workspaces espera al codigo o al final del script antes de
    // responder "pending". Debe ser menor que WORKSPACE_AGENT_TIMEOUT_MS de PDC.
    esperaPrepararMs: numeroPositivo(entorno.AGENT_PREPARE_WAIT_MS, 10000, "AGENT_PREPARE_WAIT_MS"),
  };
}

/**
 * Entregas ADACEEN en Google Drive (02-11-2026, docs/operacion/entregas-drive.md).
 *
 * La VM de editores sube cada hora (si cambio) la carpeta del taller de cada estudiante al bucket
 * de respaldos: gs://<BUCKET>/entregas/<taller>/<codigo del analisis>/<aaaa-mm-dd>_<hhmm>.zip y,
 * despues, su manifiesto .json (deploy/gcp/workspaces/respaldo-ws.py). Este script, en el Drive de
 * la cuenta a la que se le dio lectura (bash deploy/gcp/respaldos.sh compartir <correo>), pasa cada
 * zip nuevo a <CARPETA_ID>/<titulo del taller> (<taller>)/<codigo>/ y lo anota en la hoja: «Índice»
 * (una fila por entrega) y «Último por estudiante» (la mas reciente de cada codigo y taller). Nada
 * de esto lleva el nombre ni el login del estudiante: solo el codigo del analisis, el mismo de
 * Excel y Power BI.
 *
 * Propiedades del script (Configuración del proyecto → Propiedades del script):
 *   BUCKET      el bucket, sin gs:// (bash deploy/gcp/respaldos.sh estado lo muestra)
 *   CARPETA_ID  id de la carpeta de Drive de las entregas (lo que sigue a /folders/ en su enlace)
 *   HOJA_ID     opcional: solo si el script no esta dentro de la hoja (Extensiones → Apps Script)
 * El prefijo es fijo (ENTREGAS_PREFIJO): el mismo de respaldo-ws.py y de respaldos.sh compartir.
 * Las hojas tienen sus columnas fijas: si una hoja ya existe con otras (de otra version del script),
 * instalar() se detiene y pide renombrarla.
 *
 * instalar() una vez (pide los permisos): revisa todo, deja UN disparador cada 30 minutos y corre
 * la primera sincronizacion. desinstalar() quita el disparador.
 *
 * Las funciones sin _ al final que no usan servicios de Google (validarManifiesto, nombreDelZip...)
 * son puras: las prueba tests/scripts/entregas-drive.test.ts cargando este archivo en node:vm.
 */

/** Donde la VM deja las entregas en el bucket: el mismo ENTREGAS_PREFIJO de respaldo-ws.py y respaldos.sh. */
const ENTREGAS_PREFIJO = 'entregas';
/** El prefijo como se pide a la API de Storage (con la barra). */
const PREFIJO_DEL_LISTADO = ENTREGAS_PREFIJO + '/';

const ENTREGAS = Object.freeze({
  versionManifiesto: 1,
  minutosEntreCorridas: 30,
  // Apps Script corta a los 6 minutos: lo que no alcanza sigue en la proxima corrida.
  tiempoMaximoMs: 5 * 60 * 1000,
  // UrlFetchApp y los Blob de Apps Script llegan hasta 50 MB.
  bytesMaximos: 50 * 1024 * 1024,
  archivosMaximos: 20000,
  paginasMaximas: 500,
});

// Avance: el porcentaje, o «42 % (sin medir de nuevo)» si avance-ws.py reuso un resultado viejo
// (avanceAlDia false); «Avance medido»: cuando se calculo. «Taller» es el titulo; «Id del taller»,
// el nombre corto con que se reconoce (dos talleres con el mismo titulo no se mezclan).
const HOJA_INDICE = Object.freeze({
  nombre: 'Índice',
  columnas: ['Fecha', 'Código del análisis', 'Taller', 'Id del taller', 'Avance', 'Avance medido', 'Compila', 'Archivos', 'SHA-256', 'Zip', 'Carpeta', 'Objeto'],
  formatos: ['@', '@', '@', '@', '@', '@', '@', '0', '@', '@', '@', '@'],
});

const HOJA_ULTIMO = Object.freeze({
  nombre: 'Último por estudiante',
  columnas: ['Código del análisis', 'Taller', 'Id del taller', 'Última entrega', 'Avance', 'Avance medido', 'Compila', 'Archivos', 'SHA-256', 'Zip', 'Carpeta'],
  formatos: ['@', '@', '@', '@', '@', '@', '@', '0', '@', '@', '@'],
});

const HOJA_PROBLEMAS = Object.freeze({
  nombre: 'Problemas',
  columnas: ['Revisado', 'Objeto', 'Motivo'],
  formatos: ['@', '@', '@'],
});

const CODIGO_RE = /^[0-9a-f]{20}$/;
const TALLER_RE = /^[a-z0-9][a-z0-9._-]{0,79}$/;
const SHA256_RE = /^[0-9a-f]{64}$/;
const BUCKET_RE = /^[a-z0-9][a-z0-9._-]{1,61}[a-z0-9]$/;
const ID_DE_GOOGLE_RE = /^[A-Za-z0-9_-]{10,200}$/;
// La fecha del manifiesto: la hora de Bogota con su desfase («2026-11-02T14:30:05-05:00»).
const FECHA_RE = /^(\d{4}-\d{2}-\d{2})T(\d{2}):(\d{2})(?::\d{2}(?:\.\d+)?)?(?:Z|[+-]\d{2}:\d{2})$/;
// <taller>/<codigo>/<aaaa-mm-dd>_<hhmm>.<json|zip>, despues del prefijo.
const OBJETO_RE = /^([a-z0-9][a-z0-9._-]{0,79})\/([0-9a-f]{20})\/(\d{4}-\d{2}-\d{2})_(\d{4})\.(json|zip)$/;
const BOGOTA_MS = -5 * 60 * 60 * 1000;

// =============================================================================================
// Funciones puras (sin servicios de Google)

/** {ok, config} o {ok: false, errores} de las propiedades del script. */
function validarConfig(propiedades) {
  const p = propiedades || {};
  const errores = [];
  const bucket = String(p.BUCKET || '').trim().replace(/^gs:\/\//, '').replace(/\/+$/, '');
  if (!BUCKET_RE.test(bucket)) errores.push('BUCKET: el nombre del bucket, sin gs:// (bash deploy/gcp/respaldos.sh estado lo muestra)');
  const carpetaId = String(p.CARPETA_ID || '').trim();
  if (!ID_DE_GOOGLE_RE.test(carpetaId)) errores.push('CARPETA_ID: el id de la carpeta de Drive (lo que sigue a /folders/ en su enlace)');
  const hojaId = String(p.HOJA_ID || '').trim();
  if (hojaId && !ID_DE_GOOGLE_RE.test(hojaId)) errores.push('HOJA_ID: el id de la hoja (lo que sigue a /d/ en su enlace), o vacio');
  return errores.length
    ? { ok: false, errores: errores }
    : { ok: true, config: { bucket: bucket, prefijo: PREFIJO_DEL_LISTADO, carpetaId: carpetaId, hojaId: hojaId } };
}

/** La pagina del listado de objetos del prefijo (API JSON de Cloud Storage). */
function urlListado(bucket, prefijo, pageToken, maximo) {
  return 'https://storage.googleapis.com/storage/v1/b/' + encodeURIComponent(bucket) + '/o'
    + '?prefix=' + encodeURIComponent(prefijo)
    + '&fields=' + encodeURIComponent('nextPageToken,items(name,size,updated)')
    + (pageToken ? '&pageToken=' + encodeURIComponent(pageToken) : '')
    + (maximo ? '&maxResults=' + maximo : '');
}

/** El contenido de un objeto. */
function urlObjeto(bucket, nombre) {
  return 'https://storage.googleapis.com/storage/v1/b/' + encodeURIComponent(bucket) + '/o/' + encodeURIComponent(nombre) + '?alt=media';
}

/** {taller, codigo, dia, hora, tipo} del nombre de un objeto de entregas, o null. */
function partesDelObjeto(nombre, prefijo) {
  if (typeof nombre !== 'string' || !nombre.startsWith(prefijo)) return null;
  const m = OBJETO_RE.exec(nombre.slice(prefijo.length));
  return m ? { taller: m[1], codigo: m[2], dia: m[3], hora: m[4], tipo: m[5] } : null;
}

function objetoDelZip(manifiesto) {
  return manifiesto.replace(/\.json$/, '.zip');
}

/**
 * Los manifiestos del listado que todavia no estan en la hoja (ni en «Índice» ni en «Problemas»),
 * en orden de nombre (taller, codigo, fecha), cada uno con el tamano de su zip segun el listado
 * (null si el zip no esta).
 */
function manifiestosPendientes(items, prefijo, vistos) {
  const yaVistos = new Set(vistos || []);
  const zips = new Map();
  const manifiestos = [];
  (items || []).forEach(function (item) {
    const partes = partesDelObjeto(item && item.name, prefijo);
    if (!partes) return;
    if (partes.tipo === 'zip') zips.set(item.name, Number(item.size));
    else if (!yaVistos.has(item.name)) manifiestos.push(item.name);
  });
  return manifiestos.sort().map(function (objeto) {
    const zip = objetoDelZip(objeto);
    return { objeto: objeto, zip: zip, tamanoZip: zips.has(zip) ? zips.get(zip) : null };
  });
}

function enteroEntre(valor, minimo, maximo) {
  return typeof valor === 'number' && Number.isInteger(valor) && valor >= minimo && valor <= maximo;
}

/** El titulo del taller sin caracteres de control, a lo sumo 120. */
function limpiarTitulo(valor) {
  return typeof valor === 'string' ? valor.replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 120) : '';
}

/**
 * {ok: true, manifiesto} o {ok: false, motivo}. Estricto: version 1, codigo de 20 hex, taller,
 * fecha y codigo iguales a los del nombre del objeto, SHA-256 de 64 hex y numeros en su rango.
 * avanceMedidoEn (cuando se calculo el avance) y avanceAlDia (false si era un resultado reusado)
 * son opcionales en la version 1: sin ellos, «no se sabe» (null).
 */
function validarManifiesto(datos, objeto, prefijo) {
  const rechazo = function (motivo) { return { ok: false, motivo: motivo }; };
  const partes = partesDelObjeto(objeto, prefijo);
  if (!partes || partes.tipo !== 'json') return rechazo('el nombre no es <prefijo><taller>/<codigo>/<aaaa-mm-dd>_<hhmm>.json');
  if (!datos || typeof datos !== 'object' || Array.isArray(datos)) return rechazo('el manifiesto no es un objeto JSON');
  if (datos.version !== ENTREGAS.versionManifiesto) return rechazo('version ' + JSON.stringify(datos.version) + ' (se espera ' + ENTREGAS.versionManifiesto + ')');
  if (typeof datos.codigo !== 'string' || !CODIGO_RE.test(datos.codigo)) return rechazo('el codigo del analisis no son 20 caracteres hexadecimales');
  if (typeof datos.taller !== 'string' || !TALLER_RE.test(datos.taller)) return rechazo('el taller no es valido');
  if (datos.taller !== partes.taller || datos.codigo !== partes.codigo) return rechazo('el taller o el codigo no son los del nombre del objeto');
  const fecha = FECHA_RE.exec(typeof datos.fecha === 'string' ? datos.fecha : '');
  if (!fecha || Number.isNaN(Date.parse(datos.fecha))) return rechazo('la fecha no es ISO con su zona horaria');
  if (fecha[1] !== partes.dia || fecha[2] + fecha[3] !== partes.hora) return rechazo('la fecha no es la del nombre del objeto');
  if (typeof datos.sha256 !== 'string' || !SHA256_RE.test(datos.sha256)) return rechazo('el SHA-256 no son 64 caracteres hexadecimales');
  if (!enteroEntre(datos.bytes, 1, ENTREGAS.bytesMaximos)) return rechazo('bytes fuera de rango');
  if (!enteroEntre(datos.archivos, 1, ENTREGAS.archivosMaximos)) return rechazo('archivos fuera de rango');
  if (!enteroEntre(datos.avance, 0, 100)) return rechazo('avance fuera de rango');
  if (datos.compila !== true && datos.compila !== false && datos.compila !== null) return rechazo('compila no es true, false ni null');
  const medido = datos.avanceMedidoEn === undefined || datos.avanceMedidoEn === null ? null : datos.avanceMedidoEn;
  if (medido !== null && (!FECHA_RE.test(String(medido)) || Number.isNaN(Date.parse(medido)))) return rechazo('avanceMedidoEn no es ISO con su zona horaria');
  const alDia = datos.avanceAlDia === undefined || datos.avanceAlDia === null ? null : datos.avanceAlDia;
  if (alDia !== null && alDia !== true && alDia !== false) return rechazo('avanceAlDia no es true, false ni null');
  return {
    ok: true,
    manifiesto: {
      version: datos.version,
      taller: datos.taller,
      titulo: limpiarTitulo(datos.titulo) || datos.taller,
      codigo: datos.codigo,
      fecha: datos.fecha,
      sha256: datos.sha256,
      bytes: datos.bytes,
      archivos: datos.archivos,
      avance: datos.avance,
      compila: datos.compila,
      avanceMedidoEn: medido,
      avanceAlDia: alDia,
    },
  };
}

/**
 * «2026-11-02 14:30» en hora de Bogota, venga la fecha con -05:00 (la del manifiesto) o en UTC
 * (avanceMedidoEn, 04-11-2026: salia «2026-11-05 01:16» junto a una entrega de las 20:21).
 */
function fechaLegible(fecha) {
  const ms = FECHA_RE.test(String(fecha)) ? Date.parse(fecha) : NaN;
  return Number.isNaN(ms) ? String(fecha) : fechaDeRevision(ms);
}

/** El nombre del zip en Drive: «2026-11-02 1430 · 42 % · 0123456789ab.zip». */
function nombreDelZip(manifiesto) {
  const m = FECHA_RE.exec(manifiesto.fecha);
  return m[1] + ' ' + m[2] + m[3] + ' · ' + manifiesto.avance + ' % · ' + manifiesto.sha256.slice(0, 12) + '.zip';
}

/**
 * El nombre de la carpeta del taller en Drive: «<titulo> (<taller>)», sin barras. El taller (el
 * nombre corto) es lo que la identifica: dos talleres con el mismo titulo no comparten carpeta.
 */
function nombreDeCarpeta(manifiesto) {
  const titulo = limpiarTitulo(manifiesto.titulo).replace(/[\\/]/g, '-').slice(0, 80);
  return titulo && titulo !== manifiesto.taller ? titulo + sufijoDeCarpeta(manifiesto.taller) : manifiesto.taller;
}

/** El avance para la hoja: «42 %» o «42 % (sin medir de nuevo)» si era un resultado reusado. */
function avanceLegible(manifiesto) {
  return manifiesto.avance + ' %' + (manifiesto.avanceAlDia === false ? ' (sin medir de nuevo)' : '');
}

/** Hexadecimal de los bytes de Utilities.computeDigest (con signo: -128 a 127). */
function hexDeBytes(bytes) {
  return Array.prototype.map.call(bytes, function (b) { return ('0' + (b & 0xff).toString(16)).slice(-2); }).join('');
}

/** Un texto que la hoja tomaria como formula (= + - @) va con ' adelante. */
function celdaSegura(valor) {
  const texto = String(valor === null || valor === undefined ? '' : valor);
  return /^[=+\-@]/.test(texto) ? "'" + texto : texto;
}

function compilaLegible(compila) {
  return compila === true ? 'Sí' : compila === false ? 'No' : '—';
}

function medidoLegible(manifiesto) {
  return manifiesto.avanceMedidoEn ? fechaLegible(manifiesto.avanceMedidoEn) : '—';
}

/** La posicion (desde 0) de una columna por su nombre; lanza si la hoja no la tiene. */
function columna(definicion, nombre) {
  const indice = definicion.columnas.indexOf(nombre);
  if (indice < 0) throw new Error('La hoja «' + definicion.nombre + '» no tiene la columna «' + nombre + '»');
  return indice;
}

/** El valor de una columna (por nombre) en una fila de esa hoja. */
function celda(definicion, fila, nombre) {
  return fila[columna(definicion, nombre)];
}

/** Una fila con los valores en el orden de las columnas de la hoja (valores: {columna: valor}). */
function filaDe(definicion, valores) {
  return definicion.columnas.map(function (nombre) {
    if (!(nombre in valores)) throw new Error('Falta «' + nombre + '» para la hoja «' + definicion.nombre + '»');
    return valores[nombre];
  });
}

/** Lo que tienen en comun las dos hojas de entregas, por nombre de columna. */
function valoresDeEntrega(manifiesto, enlaces) {
  return {
    'Código del análisis': manifiesto.codigo,
    'Taller': celdaSegura(manifiesto.titulo),
    'Id del taller': manifiesto.taller,
    'Avance': avanceLegible(manifiesto),
    'Avance medido': medidoLegible(manifiesto),
    'Compila': compilaLegible(manifiesto.compila),
    'Archivos': manifiesto.archivos,
    'SHA-256': manifiesto.sha256,
    'Zip': enlaces.zip,
    'Carpeta': enlaces.carpeta,
  };
}

/** La fila de «Índice» (las columnas de HOJA_INDICE). */
function filaIndice(manifiesto, objeto, enlaces) {
  return filaDe(HOJA_INDICE, Object.assign(valoresDeEntrega(manifiesto, enlaces), { 'Fecha': fechaLegible(manifiesto.fecha), 'Objeto': objeto }));
}

/** La fila de «Último por estudiante» (las columnas de HOJA_ULTIMO). */
function filaUltimo(manifiesto, enlaces) {
  return filaDe(HOJA_ULTIMO, Object.assign(valoresDeEntrega(manifiesto, enlaces), { 'Última entrega': fechaLegible(manifiesto.fecha) }));
}

/**
 * Que hacer en «Último por estudiante» con una fila nueva, dadas las que hay (sin encabezado, como
 * texto): {accion: 'agregar'}, {accion: 'reemplazar', indice} si es mas nueva que la de su codigo e
 * id del taller (no el titulo), o {accion: 'nada'} si la que hay es igual o mas nueva.
 */
function decidirUltimo(filas, fila) {
  const de = function (unaFila, nombre) { return String(celda(HOJA_ULTIMO, unaFila, nombre)); };
  const indice = (filas || []).findIndex(function (actual) {
    return de(actual, 'Código del análisis') === de(fila, 'Código del análisis') && de(actual, 'Id del taller') === de(fila, 'Id del taller');
  });
  if (indice < 0) return { accion: 'agregar' };
  return de(filas[indice], 'Última entrega') < de(fila, 'Última entrega') ? { accion: 'reemplazar', indice: indice } : { accion: 'nada' };
}

/**
 * La hoja ya existe: {accion: 'encabezado'} si esta vacia (se le pone), {accion: 'usar'} si su fila
 * 1 son exactamente las columnas de la definicion, o {accion: 'otra-version', mensaje} si no.
 */
function revisarEncabezado(definicion, primeraFila, filas) {
  if (!filas) return { accion: 'encabezado' };
  const actual = (primeraFila || []).map(function (valor) { return String(valor).trim(); });
  const igual = actual.length >= definicion.columnas.length
    && definicion.columnas.every(function (nombre, i) { return actual[i] === nombre; })
    && actual.slice(definicion.columnas.length).every(function (valor) { return !valor; });
  return igual ? { accion: 'usar' } : {
    accion: 'otra-version',
    mensaje: 'La hoja «' + definicion.nombre + '» tiene columnas de otra versión: renómbrala y corre instalar() (se crea una nueva con las columnas de ahora).',
  };
}

/** El sufijo con que se reconoce la carpeta de un taller en Drive: « (<taller>)». */
function sufijoDeCarpeta(taller) {
  return ' (' + taller + ')';
}

/**
 * Que hacer con la carpeta de un taller, dados los nombres de las carpetas que ya hay en la raiz:
 * {accion: 'usar', nombre} si hay una con ese nombre, {accion: 'renombrar', desde, nombre} si hay
 * una del mismo taller (termina en « (<taller>)») con otro titulo, o {accion: 'crear', nombre}.
 */
function decidirCarpetaDeTaller(nombres, manifiesto) {
  const nombre = nombreDeCarpeta(manifiesto);
  if ((nombres || []).indexOf(nombre) >= 0) return { accion: 'usar', nombre: nombre };
  const sufijo = sufijoDeCarpeta(manifiesto.taller);
  const delTaller = (nombres || []).filter(function (otro) { return otro.endsWith(sufijo) || otro === manifiesto.taller; });
  return delTaller.length ? { accion: 'renombrar', desde: delTaller[0], nombre: nombre } : { accion: 'crear', nombre: nombre };
}

/** «2026-11-02 14:30» de un instante (hora de Bogota: sin horario de verano). */
function fechaDeRevision(milisegundos) {
  return new Date(milisegundos + BOGOTA_MS).toISOString().slice(0, 16).replace('T', ' ');
}

/** Por que Cloud Storage no deja leer, en palabras. */
function mensajeDeAcceso(codigo, bucket, prefijo) {
  if (codigo === 401 || codigo === 403) {
    return 'Esta cuenta no puede leer gs://' + bucket + '/' + prefijo + ' (HTTP ' + codigo + '). En Cloud Shell, con la cuenta duena del proyecto: '
      + 'bash deploy/gcp/respaldos.sh compartir <el correo de esta cuenta>. Si ya se hizo y sigue igual, Google no aplico la condicion que limita '
      + 'la lectura a entregas/: solo si esta es la cuenta del administrador, bash deploy/gcp/respaldos.sh compartir <correo> --todo-el-bucket '
      + '(tambien deja leer respaldos/<login>/; docs/operacion/entregas-drive.md).';
  }
  if (codigo === 404) return 'No existe el bucket gs://' + bucket + ' (HTTP 404): revisa BUCKET (bash deploy/gcp/respaldos.sh estado).';
  return 'Cloud Storage respondio HTTP ' + codigo + ' al listar gs://' + bucket + '/' + prefijo;
}

function resumenTexto(resumen) {
  return 'Entregas: ' + resumen.nuevas + ' nuevas, ' + resumen.problemas + ' con problemas, ' + resumen.reintentar + ' por reintentar'
    + (resumen.cortado ? '; se acabo el tiempo y sigue en la proxima corrida' : '') + '.';
}

// =============================================================================================
// La sincronizacion, con los servicios que recibe (los de Google en entornoReal_, otros en las
// pruebas). entorno: {ahora(), texto(bytes), sha256(bytes), almacen: {listar(prefijo), leer(nombre)
// -> {codigo, bytes}}, drive: {guardarZip(partes, nombre, bytes) -> {zip, carpeta}}, hojas:
// {objetosVistos(), agregarAlIndice(fila), actualizarUltimo(fila), anotarProblema(fila)}}.

function sincronizarCon_(entorno, config) {
  const inicio = entorno.ahora();
  const resumen = { nuevas: 0, problemas: 0, reintentar: 0, cortado: false };
  const pendientes = manifiestosPendientes(entorno.almacen.listar(config.prefijo), config.prefijo, entorno.hojas.objetosVistos());
  for (let i = 0; i < pendientes.length; i += 1) {
    if (entorno.ahora() - inicio > ENTREGAS.tiempoMaximoMs) {
      resumen.cortado = true;
      break;
    }
    resumen[procesarManifiesto_(entorno, config, pendientes[i])] += 1;
  }
  return resumen;
}

/** La respuesta de almacen.leer, o {codigo: 0} si fallo la red (se reintenta despues). */
function leerSinLanzar_(almacen, nombre) {
  try {
    return almacen.leer(nombre);
  } catch (error) {
    return { codigo: 0, bytes: null };
  }
}

/** Sin permiso es la configuracion, no un objeto: corta la corrida con el motivo (y el aviso). */
function exigirAcceso_(codigo, config) {
  if (codigo === 401 || codigo === 403) throw new Error(mensajeDeAcceso(codigo, config.bucket, config.prefijo));
}

/** 'nuevas', 'problemas' (queda en «Problemas» y no se vuelve a intentar) o 'reintentar'. */
function procesarManifiesto_(entorno, config, pendiente) {
  const problema = function (motivo) {
    entorno.hojas.anotarProblema(filaDe(HOJA_PROBLEMAS, { 'Revisado': fechaDeRevision(entorno.ahora()), 'Objeto': pendiente.objeto, 'Motivo': motivo }));
    return 'problemas';
  };
  const texto = leerSinLanzar_(entorno.almacen, pendiente.objeto);
  exigirAcceso_(texto.codigo, config);
  if (texto.codigo === 404) return problema('el manifiesto ya no esta en el bucket');
  if (texto.codigo !== 200) return 'reintentar';
  let datos;
  try {
    datos = JSON.parse(entorno.texto(texto.bytes));
  } catch (error) {
    return problema('el manifiesto no es JSON');
  }
  const revisado = validarManifiesto(datos, pendiente.objeto, config.prefijo);
  if (!revisado.ok) return problema(revisado.motivo);
  const manifiesto = revisado.manifiesto;
  if (pendiente.tamanoZip === null) return problema('falta el zip ' + pendiente.zip);
  if (pendiente.tamanoZip !== manifiesto.bytes) return problema('el zip no tiene los bytes que dice el manifiesto');
  const zip = leerSinLanzar_(entorno.almacen, pendiente.zip);
  exigirAcceso_(zip.codigo, config);
  if (zip.codigo === 404) return problema('falta el zip ' + pendiente.zip);
  if (zip.codigo !== 200) return 'reintentar';
  if (zip.bytes.length !== manifiesto.bytes || hexDeBytes(entorno.sha256(zip.bytes)) !== manifiesto.sha256) {
    return problema('el SHA-256 del zip no es el del manifiesto');
  }
  const enlaces = entorno.drive.guardarZip(manifiesto, nombreDelZip(manifiesto), zip.bytes);
  entorno.hojas.agregarAlIndice(filaIndice(manifiesto, pendiente.objeto, enlaces));
  entorno.hojas.actualizarUltimo(filaUltimo(manifiesto, enlaces));
  return 'nuevas';
}

// =============================================================================================
// Lo que se corre desde el editor de Apps Script

/**
 * Una vez: revisa las propiedades y el acceso (un listado de prueba de entregas/: sin permiso dice
 * como darlo, o la alternativa --todo-el-bucket), deja el disparador y corre la primera vez.
 */
function instalar() {
  const config = configuracion_();
  const entorno = entornoReal_(config);
  entorno.almacen.probar(config.prefijo);
  entorno.drive.probar();
  entorno.hojas.preparar();
  quitarDisparadores_();
  ScriptApp.newTrigger('sincronizar').timeBased().everyMinutes(ENTREGAS.minutosEntreCorridas).create();
  Logger.log('Listo: se sincroniza cada ' + ENTREGAS.minutosEntreCorridas + ' minutos desde gs://' + config.bucket + '/' + config.prefijo + '.');
  sincronizar();
}

/** Lo que corre el disparador cada 30 minutos (tambien desde el menu de la hoja). */
function sincronizar() {
  const candado = LockService.getScriptLock();
  if (!candado.tryLock(10 * 1000)) {
    Logger.log('Ya hay una sincronizacion corriendo: esta se salta.');
    return null;
  }
  try {
    const config = configuracion_();
    const resumen = sincronizarCon_(entornoReal_(config), config);
    Logger.log(resumenTexto(resumen));
    return resumen;
  } finally {
    candado.releaseLock();
  }
}

/** Quita el disparador: deja de traer entregas (lo que ya esta en Drive queda). */
function desinstalar() {
  Logger.log('Se quitaron ' + quitarDisparadores_() + ' disparador(es) de sincronizar. Lo que ya esta en Drive queda.');
}

/** Menu de la hoja (solo si el script esta dentro de ella). */
function onOpen() {
  try {
    SpreadsheetApp.getUi().createMenu('Entregas ADACEEN').addItem('Sincronizar ahora', 'sincronizar').addToUi();
  } catch (error) {
    // Script suelto (con HOJA_ID): sin menu.
  }
}

// =============================================================================================
// Servicios de Google (capas delgadas)

function configuracion_() {
  const revisada = validarConfig(PropertiesService.getScriptProperties().getProperties());
  if (!revisada.ok) {
    throw new Error('Faltan o no sirven estas propiedades del script (Configuración del proyecto → Propiedades del script):\n- ' + revisada.errores.join('\n- '));
  }
  return revisada.config;
}

function quitarDisparadores_() {
  const viejos = ScriptApp.getProjectTriggers().filter(function (disparador) { return disparador.getHandlerFunction() === 'sincronizar'; });
  viejos.forEach(function (disparador) { ScriptApp.deleteTrigger(disparador); });
  return viejos.length;
}

function entornoReal_(config) {
  return {
    ahora: function () { return Date.now(); },
    texto: function (bytes) { return Utilities.newBlob(bytes).getDataAsString('UTF-8'); },
    sha256: function (bytes) { return Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256, bytes); },
    almacen: almacenReal_(config),
    drive: driveReal_(config),
    hojas: hojasReales_(config),
  };
}

function almacenReal_(config) {
  const pedir = function (url) {
    return UrlFetchApp.fetch(url, { headers: { Authorization: 'Bearer ' + ScriptApp.getOAuthToken() }, muteHttpExceptions: true });
  };
  const pagina = function (prefijo, pageToken, maximo) {
    const respuesta = pedir(urlListado(config.bucket, prefijo, pageToken, maximo));
    if (respuesta.getResponseCode() !== 200) throw new Error(mensajeDeAcceso(respuesta.getResponseCode(), config.bucket, prefijo));
    return JSON.parse(respuesta.getContentText('UTF-8'));
  };
  return {
    probar: function (prefijo) { pagina(prefijo, '', 1); },
    listar: function (prefijo) {
      let items = [];
      let pageToken = '';
      for (let n = 0; n < ENTREGAS.paginasMaximas; n += 1) {
        const datos = pagina(prefijo, pageToken, 0);
        items = items.concat(datos.items || []);
        pageToken = datos.nextPageToken || '';
        if (!pageToken) break;
      }
      return items;
    },
    leer: function (nombre) {
      const respuesta = pedir(urlObjeto(config.bucket, nombre));
      return { codigo: respuesta.getResponseCode(), bytes: respuesta.getResponseCode() === 200 ? respuesta.getContent() : null };
    },
  };
}

function driveReal_(config) {
  const carpetas = {};
  const raiz = function () { return DriveApp.getFolderById(config.carpetaId); };
  const hija = function (padre, nombre) {
    const existentes = padre.getFoldersByName(nombre);
    return existentes.hasNext() ? existentes.next() : padre.createFolder(nombre);
  };
  // La carpeta del taller se reconoce por su id (« (<taller>)» al final), no por el titulo: si el
  // titulo cambio, se renombra la que ya habia.
  const carpetaDelTaller = function (manifiesto) {
    const padre = raiz();
    const todas = [];
    const iterador = padre.getFolders();
    while (iterador.hasNext()) todas.push(iterador.next());
    const decision = decidirCarpetaDeTaller(todas.map(function (c) { return c.getName(); }), manifiesto);
    if (decision.accion === 'crear') return padre.createFolder(decision.nombre);
    const existente = todas.filter(function (c) { return c.getName() === (decision.desde || decision.nombre); })[0];
    if (decision.accion === 'renombrar') existente.setName(decision.nombre);
    return existente;
  };
  const carpeta = function (manifiesto) {
    const clave = manifiesto.taller + '/' + manifiesto.codigo;
    if (!carpetas[clave]) carpetas[clave] = hija(carpetaDelTaller(manifiesto), manifiesto.codigo);
    return carpetas[clave];
  };
  return {
    probar: function () { raiz().getName(); },
    guardarZip: function (manifiesto, nombre, bytes) {
      const destino = carpeta(manifiesto);
      // Si una corrida cortada ya lo subio (el nombre lleva el SHA-256), no se repite.
      const existentes = destino.getFilesByName(nombre);
      const archivo = existentes.hasNext() ? existentes.next() : destino.createFile(Utilities.newBlob(bytes, 'application/zip', nombre));
      return { zip: archivo.getUrl(), carpeta: destino.getUrl() };
    },
  };
}

function hojasReales_(config) {
  const libro = config.hojaId ? SpreadsheetApp.openById(config.hojaId) : SpreadsheetApp.getActiveSpreadsheet();
  if (!libro) throw new Error('Sin hoja: abre el script desde la hoja «Entregas ADACEEN · índice» (Extensiones → Apps Script) o pon HOJA_ID.');
  const revisadas = {};
  const hoja = function (definicion) {
    const existente = libro.getSheetByName(definicion.nombre);
    const destino = existente || libro.insertSheet(definicion.nombre);
    if (!revisadas[definicion.nombre]) {
      const ancho = Math.max(destino.getLastColumn(), definicion.columnas.length);
      const primera = destino.getLastRow() ? destino.getRange(1, 1, 1, ancho).getDisplayValues()[0] : [];
      const revision = revisarEncabezado(definicion, primera, destino.getLastRow());
      if (revision.accion === 'otra-version') throw new Error(revision.mensaje);
      if (revision.accion === 'encabezado') {
        destino.getRange(1, 1, 1, definicion.columnas.length).setValues([definicion.columnas]).setFontWeight('bold');
        destino.setFrozenRows(1);
      }
      revisadas[definicion.nombre] = true;
    }
    return destino;
  };
  const leerColumna = function (definicion, nombre) {
    const destino = hoja(definicion);
    const filas = destino.getLastRow() - 1;
    return filas > 0 ? destino.getRange(2, columna(definicion, nombre) + 1, filas, 1).getDisplayValues().map(function (fila) { return fila[0]; }) : [];
  };
  const escribir = function (definicion, numero, fila) {
    const destino = hoja(definicion);
    const rango = destino.getRange(numero, 1, 1, fila.length);
    rango.setNumberFormats([definicion.formatos]);
    rango.setValues([fila]);
    [['Zip', 'Abrir zip'], ['Carpeta', 'Abrir carpeta']].forEach(function (par) {
      if (definicion.columnas.indexOf(par[0]) < 0) return;
      const indice = columna(definicion, par[0]);
      if (fila[indice]) {
        destino.getRange(numero, indice + 1).setRichTextValue(SpreadsheetApp.newRichTextValue().setText(par[1]).setLinkUrl(fila[indice]).build());
      }
    });
  };
  return {
    preparar: function () { [HOJA_INDICE, HOJA_ULTIMO, HOJA_PROBLEMAS].forEach(hoja); },
    objetosVistos: function () { return leerColumna(HOJA_INDICE, 'Objeto').concat(leerColumna(HOJA_PROBLEMAS, 'Objeto')); },
    agregarAlIndice: function (fila) { escribir(HOJA_INDICE, hoja(HOJA_INDICE).getLastRow() + 1, fila); },
    actualizarUltimo: function (fila) {
      const destino = hoja(HOJA_ULTIMO);
      const filas = destino.getLastRow() > 1 ? destino.getRange(2, 1, destino.getLastRow() - 1, HOJA_ULTIMO.columnas.length).getDisplayValues() : [];
      const decision = decidirUltimo(filas, fila);
      if (decision.accion === 'agregar') escribir(HOJA_ULTIMO, destino.getLastRow() + 1, fila);
      if (decision.accion === 'reemplazar') escribir(HOJA_ULTIMO, decision.indice + 2, fila);
    },
    anotarProblema: function (fila) {
      Logger.log('Problema con ' + celda(HOJA_PROBLEMAS, fila, 'Objeto') + ': ' + celda(HOJA_PROBLEMAS, fila, 'Motivo'));
      escribir(HOJA_PROBLEMAS, hoja(HOJA_PROBLEMAS).getLastRow() + 1, fila);
    },
  };
}

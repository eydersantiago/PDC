#!/usr/bin/env node
// Trae a la rama modularizada los commits nuevos de la rama desplegada.
//
// La rama modularizada solo MUEVE código (mismo texto, otros archivos). Por eso un cambio hecho
// en producción se puede llevar a donde el código vive ahora:
//   1. `git merge` normal (con diff3): git ya sigue los archivos renombrados.
//   2. Cada conflicto que queda suele ser «producción cambió unas líneas que aquí se movieron a
//      otro archivo». El script busca en el árbol el texto original de esas líneas (con su
//      contexto) y, si aparece en un solo lugar, aplica ahí el mismo cambio.
//   3. Los imports relativos que quedaron apuntando a rutas viejas se corrigen por nombre de
//      archivo cuando el destino es único.
// Lo que no puede resolver solo lo deja con marcas de conflicto y lo lista.
//
//   node scripts/sincronizar-modularizacion.mjs [--origen origin/feature/azure-config-observability]
//        [--commit] [--sin-fetch] [--con-submodulos]
//
// Con --con-submodulos, si producción movió el puntero de vscode-ext-prod, corre este mismo script
// dentro del submódulo (que debe estar en su rama modularizada) para traer ese commit allí, y deja
// el puntero en el resultado. Ese commit del submódulo hay que subirlo antes que el de PDC.
//
// No hace push ni toca la rama de origen. Sale con 0 si quedó todo resuelto (o ya estaba al día),
// 1 si quedaron conflictos por resolver a mano y 2 ante un error.
import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

const args = process.argv.slice(2);
const opt = (name, def) => {
  const i = args.indexOf(name);
  return i === -1 ? def : args[i + 1];
};
const ORIGEN = opt("--origen", "origin/feature/azure-config-observability");
const COMMIT = args.includes("--commit");
const SIN_FETCH = args.includes("--sin-fetch");
const CON_SUBMODULOS = args.includes("--con-submodulos");
const CONTEXTO_MAX = 8;

const git = (...a) => execFileSync("git", a, { encoding: "utf8", maxBuffer: 256 * 1024 * 1024 }).replace(/\n$/, "");
const gitOk = (...a) => spawnSync("git", a, { encoding: "utf8", maxBuffer: 256 * 1024 * 1024 });
const raiz = git("rev-parse", "--show-toplevel");
process.chdir(raiz);

function salir(codigo, mensaje) {
  if (mensaje) console.log(mensaje);
  process.exit(codigo);
}

// ---------------------------------------------------------------- preparación
if (git("status", "--porcelain", "--untracked-files=no")) salir(2, "El árbol tiene cambios sin commit; guárdalos antes de sincronizar.");
if (!SIN_FETCH && ORIGEN.startsWith("origin/")) {
  const rama = ORIGEN.slice("origin/".length);
  const r = gitOk("fetch", "origin", `${rama}:refs/remotes/origin/${rama}`);
  if (r.status !== 0) salir(2, `No pude traer ${ORIGEN}:\n${r.stderr}`);
}
if (gitOk("merge-base", "--is-ancestor", ORIGEN, "HEAD").status === 0) salir(0, `Al día: ${ORIGEN} ya está en ${git("rev-parse", "--abbrev-ref", "HEAD")}.`);

const pendientes = git("log", "--format=%h %s", `HEAD..${ORIGEN}`).split("\n").filter(Boolean);
console.log(`Commits de ${ORIGEN} por traer (${pendientes.length}):\n  ${pendientes.join("\n  ")}`);

const merge = gitOk("-c", "merge.conflictStyle=diff3", "merge", "--no-ff", "--no-commit", ORIGEN);
if (merge.status !== 0 && !/CONFLICT|Automatic merge failed/.test(merge.stdout + merge.stderr)) salir(2, merge.stdout + merge.stderr);

// ---------------------------------------------------------------- árbol en memoria
const rastreados = git("ls-files").split("\n").filter(Boolean);
const TEXTO = /\.(ts|mts|mjs|js|cjs|json|md|css|html|sh|py|yml|yaml|txt)$/;
const archivos = new Map(); // ruta -> texto (solo los que se leen o escriben)
const leer = (ruta) => {
  if (!archivos.has(ruta)) archivos.set(ruta, fs.existsSync(ruta) ? fs.readFileSync(ruta, "utf8") : "");
  return archivos.get(ruta);
};
const tocados = new Set();
const escribir = (ruta, texto) => {
  archivos.set(ruta, texto);
  tocados.add(ruta);
};
const candidatos = (ext) => rastreados.filter((r) => TEXTO.test(r) && path.extname(r) === ext && !r.startsWith("node_modules/"));

// Diferencia por líneas (LCS) -> hunks {inicio, borradas[], agregadas[]} sobre `a`.
function hunks(a, b) {
  const n = a.length, m = b.length;
  const dp = Array.from({ length: n + 1 }, () => new Int32Array(m + 1));
  for (let i = n - 1; i >= 0; i--) for (let j = m - 1; j >= 0; j--) dp[i][j] = a[i] === b[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
  const out = [];
  let i = 0, j = 0, actual = null;
  while (i < n || j < m) {
    if (i < n && j < m && a[i] === b[j]) {
      if (actual) { out.push(actual); actual = null; }
      i++; j++;
    } else if (j < m && (i === n || dp[i][j + 1] >= dp[i + 1][j])) {
      actual ??= { inicio: i, borradas: [], agregadas: [] };
      actual.agregadas.push(b[j++]);
    } else {
      actual ??= { inicio: i, borradas: [], agregadas: [] };
      actual.borradas.push(a[i++]);
    }
  }
  if (actual) out.push(actual);
  return out;
}

function ocurrencias(texto, aguja) {
  const pos = [];
  let k = texto.indexOf(aguja);
  while (k !== -1) {
    pos.push(k);
    k = texto.indexOf(aguja, k + 1);
  }
  return pos;
}

// Aplica un hunk (con contexto tomado de `baseLineas`) donde ese texto aparezca una sola vez.
function reubicar(baseLineas, h, ext, excluir) {
  const significativas = (ls) => ls.filter((l) => l.trim().length > 2).length;
  for (let ctx = 3; ctx <= CONTEXTO_MAX; ctx++) {
    for (const [antesN, despuesN] of [[ctx, ctx], [ctx, 0], [0, ctx]]) {
      const antes = baseLineas.slice(Math.max(0, h.inicio - antesN), h.inicio);
      const despues = baseLineas.slice(h.inicio + h.borradas.length, h.inicio + h.borradas.length + despuesN);
      const viejo = [...antes, ...h.borradas, ...despues];
      if (significativas(viejo) < 2) continue;
      const agujaTexto = viejo.join("\n");
      const nuevoTexto = [...antes, ...h.agregadas, ...despues].join("\n");
      const hallazgos = [];
      for (const ruta of candidatos(ext)) {
        if (excluir.has(ruta)) continue;
        const t = leer(ruta);
        for (const p of ocurrencias(t, agujaTexto)) {
          // que coincida en límites de línea
          const okIni = p === 0 || t[p - 1] === "\n";
          const fin = p + agujaTexto.length;
          const okFin = fin === t.length || t[fin] === "\n";
          if (okIni && okFin) hallazgos.push({ ruta, p });
        }
        if (hallazgos.length > 1) break;
      }
      if (hallazgos.length === 1) {
        const { ruta, p } = hallazgos[0];
        const t = leer(ruta);
        escribir(ruta, t.slice(0, p) + nuevoTexto + t.slice(p + agujaTexto.length));
        return ruta;
      }
      if (hallazgos.length > 1) continue; // ambiguo: probar con más contexto
    }
  }
  return null;
}

// Lleva el cambio base->theirs de un bloque a donde viva ahora ese código. true si pudo con todo.
function llevarCambio(baseTexto, theirsTexto, ext, excluir, notas) {
  const b = baseTexto.split("\n");
  const t = theirsTexto.split("\n");
  for (const h of hunks(b, t)) {
    const destino = reubicar(b, h, ext, excluir);
    if (!destino) return false;
    notas.push(`    -> ${destino}`);
  }
  return true;
}

// Merge de tres vías línea a línea dentro de un bloque cuando «ours» tiene las mismas líneas que
// «base» (solo cambió algunas, p. ej. las carpetas de los imports) y producción no tocó esas
// mismas líneas (agregar al lado sí vale). Las líneas que difieren solo en la carpeta de un import
// relativo cuentan como no tocadas por esta rama. null si no aplica.
function tresViasSinRutas(ours, base, theirs) {
  const sinRuta = (l) => l.replace(/(["'])(?:\.{1,2}\/)(?:[^"'\n]*\/)?([^"'\/\n]+)\1/g, "$1§/$2$1");
  const o = ours.replace(/\n$/, "").split("\n");
  const b = base.replace(/\n$/, "").split("\n");
  const t = theirs.replace(/\n$/, "").split("\n");
  if (o.length !== b.length) return null;
  const out = [];
  let i = 0;
  for (const h of hunks(b, t)) {
    for (let k = h.inicio; k < h.inicio + h.borradas.length; k++) if (sinRuta(o[k]) !== sinRuta(b[k])) return null;
    while (i < h.inicio) out.push(o[i++]);
    out.push(...h.agregadas);
    i += h.borradas.length;
  }
  while (i < o.length) out.push(o[i++]);
  return out.join("\n") + "\n";
}

// ---------------------------------------------------------------- conflictos
const sinResolver = [];
const enConflicto = git("diff", "--name-only", "--diff-filter=U").split("\n").filter(Boolean);
const etapas = (ruta) => {
  const out = {};
  for (const l of git("ls-files", "-u", "--", ruta).split("\n").filter(Boolean)) {
    const [, sha, etapa] = l.split(/\s+/);
    out[etapa] = sha;
  }
  return out;
};
const blob = (sha) => (sha ? git("cat-file", "-p", sha) : null);

for (const ruta of enConflicto) {
  const st = etapas(ruta);
  const modo = git("ls-files", "-u", "-s", "--", ruta).split("\n")[0]?.split(/\s+/)[0];
  if (modo === "160000") {
    const resumen = `${ruta}: submódulo (producción apunta a ${st[3]?.slice(0, 7)}, esta rama a ${st[2]?.slice(0, 7)})`;
    if (!CON_SUBMODULOS || !st[3] || !st[2]) {
      sinResolver.push(`${resumen}; hay que traer ese commit a la rama modularizada del submódulo (o correr con --con-submodulos).`);
      continue;
    }
    const sub = (...a) => spawnSync("git", ["-C", ruta, ...a], { encoding: "utf8" });
    const cabeza = sub("rev-parse", "HEAD").stdout.trim();
    const rama = sub("symbolic-ref", "-q", "--short", "HEAD").stdout.trim();
    if (cabeza !== st[2] || !rama) {
      sinResolver.push(`${resumen}; el submódulo debe estar en su rama modularizada en ${st[2].slice(0, 7)} (está en ${cabeza.slice(0, 7)}${rama ? " " + rama : ", sin rama"}).`);
      continue;
    }
    if (sub("cat-file", "-e", `${st[3]}^{commit}`).status !== 0) sub("fetch", "origin", st[3]);
    console.log(`\n== submódulo ${ruta} (rama ${rama}): traer ${st[3].slice(0, 7)}`);
    const r = spawnSync(process.execPath, [process.argv[1], "--origen", st[3], "--sin-fetch", "--commit"], { cwd: path.resolve(ruta), stdio: "inherit" });
    if (r.status === 0) {
      git("add", "--", ruta);
      console.log(`resuelto: ${ruta} -> ${sub("rev-parse", "--short", "HEAD").stdout.trim()} (sube la rama ${rama} del submódulo antes que PDC)\n`);
    } else sinResolver.push(`${resumen}; el merge dentro del submódulo quedó con conflictos: resuélvelo en ${ruta} y luego git add ${ruta}.`);
    continue;
  }
  const ext = path.extname(ruta);
  const notas = [];
  if (!st[2] && st[1] && st[3]) {
    // Aquí se borró (se partió o se movió sin que git lo viera como renombre); allá se modificó.
    if (llevarCambio(blob(st[1]), blob(st[3]), ext, new Set([ruta]), notas)) {
      git("rm", "-q", "--cached", "--", ruta);
      if (fs.existsSync(ruta)) fs.rmSync(ruta);
      console.log(`resuelto (borrado aquí, cambiado allá): ${ruta}\n${notas.join("\n")}`);
    } else sinResolver.push(`${ruta}: se borró en esta rama y producción lo cambió; no encontré dónde vive ahora ese código.`);
    continue;
  }
  if (st[2] && st[1] && !st[3]) {
    sinResolver.push(`${ruta}: producción lo borró y aquí se modificó.`);
    continue;
  }
  if (!st[1]) {
    sinResolver.push(`${ruta}: agregado en las dos ramas con contenido distinto.`);
    continue;
  }
  // Conflicto de contenido: bloques diff3 en el archivo de trabajo.
  const texto = fs.readFileSync(ruta, "utf8");
  const re = /^<<<<<<< [^\n]*\n([\s\S]*?)^\|\|\|\|\|\|\| [^\n]*\n([\s\S]*?)^=======\n([\s\S]*?)^>>>>>>> [^\n]*\n/gm;
  const bloques = [];
  let m;
  while ((m = re.exec(texto))) bloques.push({ ini: m.index, fin: m.index + m[0].length, ours: m[1], base: m[2], theirs: m[3], marca: m[0] });
  if (!bloques.length) {
    sinResolver.push(`${ruta}: conflicto sin marcas legibles.`);
    continue;
  }
  // Provisionalmente cada bloque queda con su lado «ours» (lo de esta rama) y un centinela.
  const SENT = (k) => `\u0000SINC_${k}\u0000\n`;
  let provisional = "";
  let cursor = 0;
  bloques.forEach((b, k) => {
    provisional += texto.slice(cursor, b.ini) + SENT(k);
    cursor = b.fin;
  });
  provisional += texto.slice(cursor);
  escribir(ruta, provisional);
  const resueltos = new Set();
  bloques.forEach((b, k) => {
    if (b.ours === b.base) {
      // esta rama no tocó esas líneas (raro con diff3): se queda lo de producción
      resueltos.add(k);
      b.resultado = b.theirs;
      return;
    }
    if (b.theirs === b.base) {
      resueltos.add(k);
      b.resultado = b.ours;
      return;
    }
    // Si las dos ramas tocaron líneas distintas del bloque (o esta solo cambió carpetas de
    // imports), el cambio de producción se aplica sobre «ours» línea a línea.
    const tres = tresViasSinRutas(b.ours, b.base, b.theirs);
    if (tres !== null) {
      resueltos.add(k);
      b.resultado = tres;
      return;
    }
    // Primero el lado «ours» queda tal cual en el archivo (centinela -> ours) para que el
    // cambio de producción se pueda aplicar también si el código se movió dentro del mismo archivo.
    escribir(ruta, leer(ruta).replace(SENT(k), () => b.ours + SENT(k)));
    if (llevarCambio(b.base.replace(/\n$/, ""), b.theirs.replace(/\n$/, ""), ext, new Set(), notas)) {
      resueltos.add(k);
      b.resultado = "";
    } else {
      // deshacer el «ours» provisional y dejar el bloque con marcas
      escribir(ruta, leer(ruta).replace(b.ours + SENT(k), () => SENT(k)));
      b.resultado = b.marca;
    }
  });
  let final = leer(ruta);
  bloques.forEach((b, k) => {
    final = final.replace(SENT(k), () => b.resultado);
  });
  escribir(ruta, final);
  const pendientesArchivo = bloques.length - resueltos.size;
  if (pendientesArchivo) sinResolver.push(`${ruta}: ${pendientesArchivo} de ${bloques.length} bloques sin resolver.`);
  else console.log(`resuelto (${bloques.length} bloques): ${ruta}${notas.length ? "\n" + notas.join("\n") : ""}`);
}

// ---------------------------------------------------------------- imports con rutas viejas
const EXT_CODIGO = [".ts", ".mts", ".js", ".mjs"];
function resuelve(desde, spec) {
  const baseRuta = path.posix.join(path.posix.dirname(desde), spec);
  const opciones = [baseRuta, baseRuta.replace(/\.js$/, ".ts"), baseRuta.replace(/\.mjs$/, ".mts"), ...EXT_CODIGO.map((e) => baseRuta + e), ...EXT_CODIGO.map((e) => baseRuta + "/index" + e)];
  return opciones.some((o) => fs.existsSync(o) || (archivos.has(o) && archivos.get(o) !== ""));
}
const cambiadosPorMerge = git("diff", "--name-only", "--cached").split("\n").filter(Boolean);
const porNombre = new Map();
for (const r of [...rastreados, ...archivos.keys()]) {
  const k = path.posix.basename(r);
  if (!porNombre.has(k)) porNombre.set(k, new Set());
  porNombre.get(k).add(r);
}
for (const ruta of new Set([...cambiadosPorMerge, ...tocados])) {
  if (!/\.(ts|mts|mjs|js)$/.test(ruta) || !fs.existsSync(ruta)) continue;
  let t = leer(ruta);
  if (/^<<<<<<< /m.test(t)) continue; // con conflictos pendientes: se corrige después a mano
  const original = t;
  t = t.replace(/(from\s+|import\s*\(\s*|import\s+)(["'])(\.{1,2}\/[^"']+)\2/g, (todo, pre, q, spec) => {
    if (resuelve(ruta, spec)) return todo;
    const nombre = path.posix.basename(spec);
    const sinExt = !path.posix.extname(nombre);
    const nombres = sinExt ? [nombre + ".ts", nombre + ".js"] : [nombre.replace(/\.js$/, ".ts"), nombre];
    const opciones = [...new Set(nombres.flatMap((n) => [...(porNombre.get(n) || [])]))].filter((o) => fs.existsSync(o));
    if (opciones.length !== 1) return todo;
    let nuevo = path.posix.relative(path.posix.dirname(ruta), opciones[0]);
    if (!nuevo.startsWith(".")) nuevo = "./" + nuevo;
    if (spec.endsWith(".js")) nuevo = nuevo.replace(/\.ts$/, ".js");
    else if (sinExt) nuevo = nuevo.replace(/\.(ts|js)$/, "");
    console.log(`import corregido en ${ruta}: ${spec} -> ${nuevo}`);
    return `${pre}${q}${nuevo}${q}`;
  });
  if (t !== original) escribir(ruta, t);
}

// ---------------------------------------------------------------- escribir y cerrar
for (const ruta of tocados) {
  fs.mkdirSync(path.dirname(ruta), { recursive: true });
  fs.writeFileSync(ruta, archivos.get(ruta));
}
const sinMarcas = [...tocados].filter((r) => !/^<<<<<<< /m.test(archivos.get(r)));
if (sinMarcas.length) git("add", "--", ...sinMarcas);

if (sinResolver.length) {
  console.log(`\nQuedan ${sinResolver.length} conflictos por resolver a mano:\n  ${sinResolver.join("\n  ")}`);
  console.log("\nResuélvelos llevando el cambio de producción a donde vive ahora el código, luego:\n  npm run build && npm test && git add -A && git commit --no-edit");
  salir(1);
}
const mensaje = `merge: traer ${pendientes.length} commit(s) de ${ORIGEN} a la rama modularizada\n\n${pendientes.map((p) => "- " + p).join("\n")}`;
if (COMMIT) {
  git("commit", "-q", "-m", mensaje);
  salir(0, `\nListo: merge hecho (${git("rev-parse", "--short", "HEAD")}). Corre npm run build y npm test antes de subir.`);
}
fs.writeFileSync(path.join(git("rev-parse", "--git-dir"), "MERGE_MSG"), mensaje + "\n");
salir(0, "\nTodo resuelto y en el índice. Corre npm run build y npm test, y luego git commit --no-edit.");

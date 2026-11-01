import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

// scripts/sincronizar-modularizacion.mjs lleva a la rama modularizada los commits de la rama
// desplegada, aunque el código que cambió se haya movido a otro archivo o carpeta.

const SCRIPT = path.resolve(process.cwd(), "scripts/sincronizar-modularizacion.mjs");

function repoTemporal() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "sinc-modular-"));
  const run = (cmd: string, ...args: string[]) => {
    const r = spawnSync(cmd, args, { cwd: dir, encoding: "utf8" });
    if (r.status !== 0) throw new Error(`${cmd} ${args.join(" ")}\n${r.stdout}\n${r.stderr}`);
    return r.stdout;
  };
  const git = (...args: string[]) => run("git", "-c", "user.name=Prueba", "-c", "user.email=prueba@example.com", ...args);
  const escribir = (rel: string, texto: string) => {
    fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true });
    fs.writeFileSync(path.join(dir, rel), texto);
  };
  const leer = (rel: string) => fs.readFileSync(path.join(dir, rel), "utf8");
  return { dir, git, escribir, leer };
}

const CALCULO = [
  "export function sumar(a: number, b: number) {",
  "  const total = a + b;",
  "  return total;",
  "}",
  "",
  "export function restar(a: number, b: number) {",
  "  const diferencia = a - b;",
  "  return diferencia;",
  "}",
  "",
].join("\n");

test("sincronizar-modularizacion: el cambio de produccion llega a la funcion movida y el import nuevo se corrige", () => {
  const { dir, git, escribir, leer } = repoTemporal();
  try {
    git("init", "-q", "-b", "produccion");
    escribir("src/calculo.ts", CALCULO);
    escribir("src/texto.ts", "export const saludo = \"hola\";\n");
    escribir("src/app.ts", ["import { sumar } from \"./calculo.js\";", "import { restar } from \"./calculo.js\";", "", "export const r = sumar(1, restar(3, 2));", ""].join("\n"));
    git("add", "-A");
    git("commit", "-qm", "base");

    // Rama modularizada: restar() pasa a su propio archivo y texto.ts a una carpeta.
    git("checkout", "-qb", "modular");
    escribir("src/calculo.ts", CALCULO.split("\n").slice(0, 5).join("\n"));
    escribir("src/calculo-resta.ts", CALCULO.split("\n").slice(5).join("\n"));
    escribir("src/app.ts", ["import { sumar } from \"./calculo.js\";", "import { restar } from \"./calculo-resta.js\";", "", "export const r = sumar(1, restar(3, 2));", ""].join("\n"));
    fs.mkdirSync(path.join(dir, "src/comun"), { recursive: true });
    git("mv", "src/texto.ts", "src/comun/texto.ts");
    git("add", "-A");
    git("commit", "-qm", "modularizar");

    // Produccion: cambia restar() en su archivo viejo y agrega un import con la ruta vieja.
    git("checkout", "-q", "produccion");
    escribir("src/calculo.ts", CALCULO.replace("  const diferencia = a - b;", "  const diferencia = Math.abs(a - b);"));
    escribir("src/app.ts", ["import { sumar } from \"./calculo.js\";", "import { restar } from \"./calculo.js\";", "import { saludo } from \"./texto.js\";", "", "export const r = sumar(1, restar(3, 2));", "export const s = saludo;", ""].join("\n"));
    git("commit", "-qam", "fix en produccion");

    git("checkout", "-q", "modular");
    const r = spawnSync(process.execPath, [SCRIPT, "--origen", "produccion", "--sin-fetch", "--commit"], { cwd: dir, encoding: "utf8" });
    assert.equal(r.status, 0, r.stdout + r.stderr);
    assert.match(leer("src/calculo-resta.ts"), /const diferencia = Math\.abs\(a - b\);/);
    assert.doesNotMatch(leer("src/calculo.ts"), /restar/);
    const app = leer("src/app.ts");
    assert.match(app, /import \{ restar \} from "\.\/calculo-resta\.js";/);
    assert.match(app, /import \{ saludo \} from "\.\/comun\/texto\.js";/);
    assert.match(app, /export const s = saludo;/);
    // quedo registrado como merge: la proxima vez esta al dia
    const otra = spawnSync(process.execPath, [SCRIPT, "--origen", "produccion", "--sin-fetch"], { cwd: dir, encoding: "utf8" });
    assert.equal(otra.status, 0);
    assert.match(otra.stdout, /Al día/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("sincronizar-modularizacion: lo que no puede ubicar queda con marcas y sale con 1", () => {
  const { dir, git, escribir } = repoTemporal();
  try {
    git("init", "-q", "-b", "produccion");
    escribir("src/calculo.ts", CALCULO);
    git("add", "-A");
    git("commit", "-qm", "base");
    git("checkout", "-qb", "modular");
    escribir("src/calculo.ts", CALCULO.replace("  const total = a + b;", "  const total = b + a;"));
    git("commit", "-qam", "modular toca la misma linea");
    git("checkout", "-q", "produccion");
    escribir("src/calculo.ts", CALCULO.replace("  const total = a + b;", "  const total = a + b + 0;"));
    git("commit", "-qam", "produccion toca la misma linea");
    git("checkout", "-q", "modular");
    const r = spawnSync(process.execPath, [SCRIPT, "--origen", "produccion", "--sin-fetch"], { cwd: dir, encoding: "utf8" });
    assert.equal(r.status, 1, r.stdout + r.stderr);
    assert.match(r.stdout, /src\/calculo\.ts: 1 de 1 bloques sin resolver/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

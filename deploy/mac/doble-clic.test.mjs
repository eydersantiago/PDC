// Pruebas de los archivos de doble clic de las Mac, en modo --simular (sirven en Linux):
//   - estudiante/Preparar-Mac-ADACEEN.command: git, VS Code, comando code,
//     extension (junto al archivo o descargada del backend) y /empezar
//   - Instalar-servidor-ADACEEN.command y Estado-servidor-ADACEEN.command,
//     que llaman a instalar-worker-mac.sh y worker-mac.sh sin escribir rutas
//   node --test deploy/mac/doble-clic.test.mjs
import assert from "node:assert/strict";
import { spawn, execFileSync } from "node:child_process";
import { chmodSync, copyFileSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readlinkSync, writeFileSync } from "node:fs";
import http from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const AQUI = path.dirname(fileURLToPath(import.meta.url));
const PREPARAR = path.join(AQUI, "estudiante", "Preparar-Mac-ADACEEN.command");
const INSTALAR = path.join(AQUI, "Instalar-servidor-ADACEEN.command");
const ESTADO = path.join(AQUI, "Estado-servidor-ADACEEN.command");
const MARCA = "# >>> ADACEEN: comando code de VS Code >>>";

function hay(comando) {
  try {
    execFileSync("sh", ["-c", `command -v ${comando}`], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}
const omitir = ["bash", "curl"].every(hay) ? false : "faltan bash o curl";

function correr(comando, argumentos, { env, entrada = "", cwd = "/" } = {}) {
  return new Promise((resolve) => {
    const hijo = spawn(comando, argumentos, { env, cwd, stdio: ["pipe", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    hijo.stdout.on("data", (dato) => { stdout += dato; });
    hijo.stderr.on("data", (dato) => { stderr += dato; });
    const reloj = setTimeout(() => hijo.kill("SIGKILL"), 120000);
    hijo.on("close", (codigo) => {
      clearTimeout(reloj);
      resolve({ codigo, stdout, stderr, todo: stdout + stderr });
    });
    hijo.stdin.end(entrada);
  });
}

// Entorno limpio: sin proxies (el backend de prueba esta en 127.0.0.1) y con HOME propio.
function entorno(extra = {}) {
  const casa = mkdtempSync(path.join(tmpdir(), "adaceen-casa-"));
  return { PATH: process.env.PATH, HOME: casa, LANG: "C.UTF-8", ...extra };
}

// VS Code falso dentro de la carpeta de simulacion: su CLI registra los argumentos
// y guarda una copia del VSIX que le pasan. `version` es la que dice --version;
// con `fallaInstalar` rechaza el VSIX como lo haria un VS Code viejo.
function vscodeFalso(simulacion, { version = "1.104.2", fallaInstalar = false } = {}) {
  const bin = path.join(simulacion, "Applications", "Visual Studio Code.app", "Contents", "Resources", "app", "bin");
  mkdirSync(bin, { recursive: true });
  const registro = path.join(simulacion, "code-args");
  writeFileSync(path.join(bin, "code"), `#!/usr/bin/env bash
printf '%s\\n' "$*" >>"${registro}"
if [ "$1" = "--version" ]; then printf '%s\\n' "${version}" "abcdef0123" "arm64"; exit 0; fi
if [ "$1" = "--install-extension" ]; then
  ${fallaInstalar ? `echo "Installing extensions..."; echo "Unable to install extension 'adaceen.adaceen' as it is not compatible with VS Code '${version}'." >&2; exit 1` : `cp "$2" "${simulacion}/vsix-instalado"`}
fi
if [ "$1" = "--list-extensions" ]; then echo "ms-python.python@2026.1.0"; echo "adaceen.adaceen@0.0.31"; fi
exit 0
`);
  chmodSync(path.join(bin, "code"), 0o755);
  return registro;
}

async function servidor(rutas) {
  const srv = http.createServer((req, res) => {
    const cuerpo = rutas[req.url];
    if (cuerpo === undefined) {
      res.writeHead(404).end("no");
      return;
    }
    res.writeHead(200).end(cuerpo);
  });
  await new Promise((resolve) => srv.listen(0, "127.0.0.1", resolve));
  return { url: `http://127.0.0.1:${srv.address().port}`, cerrar: () => new Promise((resolve) => srv.close(resolve)) };
}

// ------------------------------------------------------------------ Preparar-Mac-ADACEEN.command
test("Preparar-Mac: sin git ni VS Code explica que falta, deja el comando code y abre /empezar", { skip: omitir }, async () => {
  const sim = mkdtempSync(path.join(tmpdir(), "adaceen-sim-"));
  const env = entorno({ ADACEEN_SIM_GIT: "falta" });
  const r = await correr("bash", [PREPARAR, `--simular=${sim}`], { env });
  assert.equal(r.codigo, 0, r.todo);
  assert.match(r.stdout, /\(simulado\) xcode-select --install/);
  assert.match(r.stderr, /falta git/);
  assert.match(r.stdout, /\(simulado\) descargaria VS Code de https:\/\/update\.code\.visualstudio\.com\/latest\/darwin-universal\/stable/);
  assert.match(r.stdout, /\(simulado\) descargaria la extension de https:\/\/app-adaceen-api-eyder05232002\.azurewebsites\.net\/descargas\/adaceen\.vsix/);
  assert.match(r.stdout, /\(simulado\) open https:\/\/app-adaceen-api-eyder05232002\.azurewebsites\.net\/empezar/);
  const enlace = path.join(sim, "home", ".local", "bin", "code");
  assert.ok(lstatSync(enlace).isSymbolicLink());
  assert.equal(readlinkSync(enlace), path.join(sim, "home", "Applications", "Visual Studio Code.app", "Contents", "Resources", "app", "bin", "code"));
  const perfil = readFileSync(path.join(sim, "home", ".zprofile"), "utf8");
  assert.ok(perfil.includes('export PATH="$HOME/.local/bin:$PATH"'));
  // No se ejecuto nada del sistema real ni se toco el HOME real.
  assert.equal(existsSync(path.join(env.HOME, ".zprofile")), false);
});

test("Preparar-Mac: abrirlo otra vez no duplica el PATH en .zprofile y respeta .bash_profile", { skip: omitir }, async () => {
  const sim = mkdtempSync(path.join(tmpdir(), "adaceen-sim-"));
  mkdirSync(path.join(sim, "home"), { recursive: true });
  writeFileSync(path.join(sim, "home", ".zprofile"), "export EDITOR=vim\n");
  writeFileSync(path.join(sim, "home", ".bash_profile"), "# de antes\n");
  for (let vez = 0; vez < 2; vez += 1) {
    const r = await correr("bash", [PREPARAR, `--simular=${sim}`, "--sin-abrir"], { env: entorno() });
    assert.equal(r.codigo, 0, r.todo);
    assert.doesNotMatch(r.stdout, /open /);
  }
  for (const nombre of [".zprofile", ".bash_profile"]) {
    const perfil = readFileSync(path.join(sim, "home", nombre), "utf8");
    assert.equal(perfil.split(MARCA).length - 1, 1, `${nombre}: una sola vez`);
  }
  assert.match(readFileSync(path.join(sim, "home", ".zprofile"), "utf8"), /^export EDITOR=vim\n/);
});

test("Preparar-Mac: sin la extension del backend usa el .vsix que esta junto al archivo, sin --force (no baja de version)", { skip: omitir }, async () => {
  const api = await servidor({});
  try {
    const carpeta = mkdtempSync(path.join(tmpdir(), "adaceen-descargas-"));
    const copia = path.join(carpeta, "Preparar-Mac-ADACEEN.command");
    copyFileSync(PREPARAR, copia);
    writeFileSync(path.join(carpeta, "adaceen-0.0.31.vsix"), "PK-vsix-junto");
    const sim = mkdtempSync(path.join(tmpdir(), "adaceen-sim-"));
    const registro = vscodeFalso(sim);
    const r = await correr("bash", [copia, `--simular=${sim}`, `--backend=${api.url}`], { env: entorno({ ADACEEN_SIM_DESCARGAR: "1" }) });
    assert.equal(r.codigo, 0, r.todo);
    assert.match(r.stdout, /VS Code ya esta instalado/);
    assert.match(r.stderr, /no pude descargar la extension/);
    assert.match(r.stdout, /uso adaceen-0\.0\.31\.vsix \(junto a este archivo\)/);
    assert.match(r.stdout, /extension de ADACEEN instalada \(0\.0\.31\)/);
    const args = readFileSync(registro, "utf8");
    assert.match(args, new RegExp(`--install-extension ${carpeta}/adaceen-0\\.0\\.31\\.vsix\\n`));
    assert.doesNotMatch(args, /--force/);
    assert.equal(readFileSync(path.join(sim, "vsix-instalado"), "utf8"), "PK-vsix-junto");
    assert.match(r.stdout, /listo: esta Mac ya esta preparada/);
  } finally {
    await api.cerrar();
  }
});

test("Preparar-Mac: prefiere la extension del backend aunque en la carpeta (Descargas) haya un .vsix viejo", { skip: omitir }, async () => {
  const api = await servidor({ "/descargas/adaceen.vsix": "PK\u0003\u0004vsix-vigente" });
  try {
    const carpeta = mkdtempSync(path.join(tmpdir(), "adaceen-descargas-"));
    const copia = path.join(carpeta, "Preparar-Mac-ADACEEN.command");
    copyFileSync(PREPARAR, copia);
    writeFileSync(path.join(carpeta, "adaceen-0.0.30.vsix"), "PK-vsix-viejo");
    writeFileSync(path.join(carpeta, "adaceen.vsix"), "PK-vsix-viejo");
    const sim = mkdtempSync(path.join(tmpdir(), "adaceen-sim-"));
    const registro = vscodeFalso(sim);
    const r = await correr("bash", [copia, `--simular=${sim}`, `--backend=${api.url}`], { env: entorno({ ADACEEN_SIM_DESCARGAR: "1" }) });
    assert.equal(r.codigo, 0, r.todo);
    assert.equal(readFileSync(path.join(sim, "vsix-instalado"), "utf8"), "PK\u0003\u0004vsix-vigente");
    assert.doesNotMatch(r.stdout, /junto a este archivo/);
    assert.doesNotMatch(readFileSync(registro, "utf8"), /0\.0\.30/);
    assert.match(readFileSync(registro, "utf8"), /--install-extension \S+\/adaceen\.vsix --force/);
    // Registra la app para los enlaces vscode:// del navegador.
    assert.match(r.stdout, /\(simulado\) lsregister -f .*Visual Studio Code\.app/);
  } finally {
    await api.cerrar();
  }
});

test("Preparar-Mac: con un VS Code anterior al que pide la extension dice que hay que actualizarlo y muestra el error", { skip: omitir }, async () => {
  const api = await servidor({ "/descargas/adaceen.vsix": "PK\u0003\u0004vsix" });
  try {
    const sim = mkdtempSync(path.join(tmpdir(), "adaceen-sim-"));
    vscodeFalso(sim, { version: "1.90.2", fallaInstalar: true });
    const r = await correr("bash", [PREPARAR, `--simular=${sim}`, `--backend=${api.url}`, "--sin-abrir"], { env: entorno({ ADACEEN_SIM_DESCARGAR: "1" }) });
    assert.equal(r.codigo, 1, r.todo);
    assert.match(r.stderr, /este VS Code es la version 1\.90\.2 y la extension de ADACEEN necesita 1\.96\.0 o mas nueva/);
    assert.match(r.stderr, /not compatible with VS Code '1\.90\.2'/);
    assert.match(r.stderr, /- VS Code: actualizalo/);
    assert.match(r.stderr, /- extension: se instala sola al volver a abrir este archivo con VS Code actualizado/);
    assert.doesNotMatch(r.stderr, /Install from VSIX/);
  } finally {
    await api.cerrar();
  }

  // Una version igual o mas nueva no avisa.
  const sim2 = mkdtempSync(path.join(tmpdir(), "adaceen-sim-"));
  vscodeFalso(sim2, { version: "1.96.0" });
  const r2 = await correr("bash", [PREPARAR, `--simular=${sim2}`, "--sin-abrir"], { env: entorno() });
  assert.doesNotMatch(r2.stderr, /necesita 1\.96\.0/);
});

test("Preparar-Mac: la version minima de VS Code es la que declara la extension", { skip: omitir }, (t) => {
  const paquete = path.resolve(AQUI, "..", "..", "vscode-ext-prod", "package.json");
  if (!existsSync(paquete)) {
    t.skip("sin el submodulo vscode-ext-prod");
    return;
  }
  const motor = JSON.parse(readFileSync(paquete, "utf8")).engines.vscode.replace(/^[^0-9]*/, "");
  assert.match(readFileSync(PREPARAR, "utf8"), new RegExp(`^VSCODE_MINIMO="${motor.replace(/\./g, "\\.")}"$`, "m"));
});

test("Preparar-Mac: descarga el VSIX de <backend>/descargas/adaceen.vsix y comprueba que es un zip", { skip: omitir }, async () => {
  const api = await servidor({ "/descargas/adaceen.vsix": "PK\u0003\u0004vsix-del-backend" });
  try {
    const sim = mkdtempSync(path.join(tmpdir(), "adaceen-sim-"));
    vscodeFalso(sim);
    const r = await correr("bash", [PREPARAR, `--simular=${sim}`, `--backend=${api.url}/`], { env: entorno({ ADACEEN_SIM_DESCARGAR: "1" }) });
    assert.equal(r.codigo, 0, r.todo);
    assert.match(r.stdout, new RegExp(`descargando la extension de ${api.url}/descargas/adaceen\\.vsix`));
    assert.equal(readFileSync(path.join(sim, "vsix-instalado"), "utf8"), "PK\u0003\u0004vsix-del-backend");
    assert.match(r.stdout, new RegExp(`\\(simulado\\) open ${api.url}/empezar`));
  } finally {
    await api.cerrar();
  }
});

test("Preparar-Mac: si el backend no tiene el VSIX (o no es un zip) lo dice y termina con error", { skip: omitir }, async () => {
  const api = await servidor({ "/descargas/adaceen.vsix": "<html>no es un zip</html>" });
  try {
    const sim = mkdtempSync(path.join(tmpdir(), "adaceen-sim-"));
    const registro = vscodeFalso(sim);
    const r = await correr("bash", [PREPARAR, `--simular=${sim}`, `--backend=${api.url}`], { env: entorno({ ADACEEN_SIM_DESCARGAR: "1" }) });
    assert.equal(r.codigo, 1, r.todo);
    assert.match(r.stderr, /no pude descargar la extension/);
    assert.match(r.stderr, /casi listo; falta:\n {2}- extension/);
    assert.equal(existsSync(registro) && readFileSync(registro, "utf8").includes("--install-extension"), false);
  } finally {
    await api.cerrar();
  }
});

test("Preparar-Mac: rechaza un --backend que no es URL y, fuera de macOS, exige --simular", { skip: omitir }, async () => {
  const r1 = await correr("bash", [PREPARAR, "--simular", "--backend=file:///etc/passwd"], { env: entorno() });
  assert.equal(r1.codigo, 1);
  assert.match(r1.stderr, /no es una URL valida/);
  if (process.platform !== "darwin") {
    const r2 = await correr("bash", [PREPARAR], { env: entorno() });
    assert.equal(r2.codigo, 1);
    assert.match(r2.stderr, /es para macOS/);
  }
});

test("Preparar-Mac: bash valido, con permiso de ejecucion y sin arreglos de bash 4", { skip: omitir }, () => {
  execFileSync("bash", ["-n", PREPARAR]);
  // codesign | grep -q con pipefail: grep corta, codesign recibe SIGPIPE y una firma buena da error.
  const sinComentarios = readFileSync(PREPARAR, "utf8").split("\n").filter((linea) => !linea.trim().startsWith("#")).join("\n");
  assert.doesNotMatch(sinComentarios, /codesign[^\n]*\|\s*grep/);
  for (const archivo of [PREPARAR, INSTALAR, ESTADO]) {
    assert.ok(lstatSync(archivo).mode & 0o100, `${path.basename(archivo)} ejecutable`);
    const texto = readFileSync(archivo, "utf8");
    assert.match(texto, /^#!\/bin\/bash\n/);
    const codigo = texto.split("\n").filter((linea) => !linea.trim().startsWith("#")).join("\n");
    assert.doesNotMatch(codigo, /declare -A|mapfile|readarray|\$\{[A-Za-z_]+,,\}|\$\{[A-Za-z_]+\^\^\}/);
  }
});

// ------------------------------------------------------------------ Mac servidor
test("Instalar-servidor: pregunta el equipo la primera vez y llama al instalador (simulado)", { skip: omitir }, async () => {
  const sim = mkdtempSync(path.join(tmpdir(), "adaceen-sim-"));
  const r = await correr("bash", [INSTALAR, `--simular=${sim}`, "--backend=http://127.0.0.1:9"], { env: entorno(), entrada: "07\n" });
  assert.equal(r.codigo, 0, r.todo);
  // (read -p solo muestra la pregunta con una terminal; aqui la respuesta llega por stdin.)
  assert.match(r.stdout, /instalacion terminada/);
  const workerEnv = readFileSync(path.join(sim, "adaceen", "worker.env"), "utf8");
  assert.match(workerEnv, /^QUEUE_WORKER_ID=mac-lab07-m2$/m);
});

test("Instalar-servidor: encuentra adaceen-mac.env en el Escritorio sin escribir la ruta", { skip: omitir }, async () => {
  const env = entorno();
  mkdirSync(path.join(env.HOME, "Desktop"));
  const config = path.join(env.HOME, "Desktop", "adaceen-mac.env");
  writeFileSync(config, "AZURE_SERVICEBUS_CONNECTION_STRING=Endpoint=sb://x/;SharedAccessKeyName=worker-mac;SharedAccessKey=SECRETO\n");
  // Sin --simular: en Linux el instalador se detiene enseguida (no es macOS), pero
  // antes el envoltorio tiene que haber encontrado el archivo.
  const r = await correr("bash", [INSTALAR, "--equipo=03"], { env });
  assert.match(r.stdout, new RegExp(`uso la configuracion de ${config}`));
  assert.equal(r.todo.includes("SECRETO"), false);
  if (process.platform !== "darwin") assert.notEqual(r.codigo, 0);
});

test("Instalar-servidor: si esta Mac ya tiene configuracion, no la reemplaza con un adaceen-mac.env encontrado sin preguntar", { skip: omitir }, async () => {
  const env = entorno();
  mkdirSync(path.join(env.HOME, "Downloads"));
  mkdirSync(path.join(env.HOME, ".adaceen"));
  writeFileSync(path.join(env.HOME, ".adaceen", "worker.env"), "AZURE_SERVICEBUS_CONNECTION_STRING=la-que-funciona\n");
  const viejo = path.join(env.HOME, "Downloads", "adaceen-mac.env");
  writeFileSync(viejo, "AZURE_SERVICEBUS_CONNECTION_STRING=Endpoint=sb://x/;SharedAccessKeyName=worker-mac;SharedAccessKey=VIEJA\n");
  // Sin respuesta (Enter o sin terminal): se conserva la instalada.
  const r1 = await correr("bash", [INSTALAR, "--equipo=03"], { env, entrada: "\n" });
  assert.match(r1.stdout, /esta Mac ya tiene la configuracion instalada/);
  assert.match(r1.stdout, /conservo la configuracion instalada/);
  assert.doesNotMatch(r1.stdout, /uso la configuracion de/);
  assert.equal(r1.todo.includes("VIEJA"), false);
  // Con «s» (se rotaron las claves) usa la encontrada.
  const r2 = await correr("bash", [INSTALAR, "--equipo=03"], { env, entrada: "s\n" });
  assert.match(r2.stdout, new RegExp(`uso la configuracion de ${viejo}`));
});

test("Instalar-servidor: al terminar ofrece borrar el adaceen-mac.env del Escritorio (tiene secretos)", { skip: omitir }, async () => {
  const env = entorno();
  mkdirSync(path.join(env.HOME, "Desktop"));
  const config = path.join(env.HOME, "Desktop", "adaceen-mac.env");
  writeFileSync(config, "AZURE_SERVICEBUS_CONNECTION_STRING=Endpoint=sb://x/;SharedAccessKeyName=worker-mac;SharedAccessKey=SECRETO\nWORKER_SHARED_SECRET=S2\nWORKER_HEARTBEAT_TOKEN=S3\n");
  // Numero de equipo y Enter (= borrarlo). En la simulacion no se borra de verdad.
  const sim = mkdtempSync(path.join(tmpdir(), "adaceen-sim-"));
  const r1 = await correr("bash", [INSTALAR, `--simular=${sim}`, "--backend=http://127.0.0.1:9"], { env, entrada: "07\n\n" });
  assert.equal(r1.codigo, 0, r1.todo);
  assert.match(r1.stdout, new RegExp(`uso la configuracion de ${config}`));
  assert.match(r1.stderr, /adaceen-mac\.env tiene secretos/);
  assert.match(r1.stdout, new RegExp(`\\(simulado\\) borraria ${config}`));
  assert.ok(existsSync(config));
  assert.equal(r1.todo.includes("SECRETO"), false);
  // «n»: no lo borra y recuerda hacerlo.
  const sim2 = mkdtempSync(path.join(tmpdir(), "adaceen-sim-"));
  const r2 = await correr("bash", [INSTALAR, `--simular=${sim2}`, "--backend=http://127.0.0.1:9"], { env, entrada: "07\nn\n" });
  assert.equal(r2.codigo, 0, r2.todo);
  assert.match(r2.stderr, /no lo borre: borralo tu/);
});

test("Estado-servidor: sin instalacion lo dice; con una instalacion muestra el estado", { skip: omitir }, async () => {
  const env = entorno();
  const r1 = await correr("bash", [ESTADO], { env });
  assert.equal(r1.codigo, 1);
  assert.match(r1.stderr, /ADACEEN no esta instalado en esta Mac: doble clic en Instalar-servidor-ADACEEN\.command/);

  const sim = mkdtempSync(path.join(tmpdir(), "adaceen-sim-"));
  const instalar = await correr("bash", [INSTALAR, `--simular=${sim}`, "--equipo=05", "--backend=http://127.0.0.1:9"], { env });
  assert.equal(instalar.codigo, 0, instalar.todo);
  const r2 = await correr("bash", [ESTADO], { env: { ...env, ADACEEN_HOME: path.join(sim, "adaceen") } });
  assert.match(r2.stdout, /rol servidor, modo sesion, modelo qwen2\.5-coder:14b.*id mac-lab05-m2/);
  // Sin terminal no pregunta si encender.
  assert.doesNotMatch(r2.stdout, /Encender los servicios/);
});

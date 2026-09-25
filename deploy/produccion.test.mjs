// Pruebas de deploy/produccion.sh (revisar, aplicar y verificar) sin Azure ni
// Google Cloud:
//   - una copia del repositorio en una carpeta temporal (git de verdad), con
//     un git falso que solo cambia `git ls-remote` (lo que hay en GitHub)
//   - gcloud y az falsos que guardan su estado en archivos: las variables del
//     App Service (azure.json) y la metadata de cada VM (vm-<vm>.json)
//   - un backend HTTP local que imita /api/health, /api/agent/backend,
//     /empezar y /descargas/* a partir de ese estado (el agente de la VM
//     "se conecta" si corrio el arranque y el token es el mismo en los dos lados).
//     Como Azure, despues de cada cambio de variables se reinicia: /api/health
//     responde 503 dos veces y el agente tarda tres consultas en reconectarse.
//   node --test deploy/produccion.test.mjs
import assert from "node:assert/strict";
import { spawn, execFileSync } from "node:child_process";
import { chmodSync, copyFileSync, cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import http from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const AQUI = path.dirname(fileURLToPath(import.meta.url));
const RAIZ = path.resolve(AQUI, "..");
const RAMA = "feature/azure-config-observability";

function hay(comando) {
  try {
    execFileSync("sh", ["-c", `command -v ${comando}`], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}
const FALTAN = ["bash", "python3", "curl", "git", "openssl", "sha256sum", "awk", "sed"].filter((comando) => !hay(comando));
const omitir = FALTAN.length ? `faltan ${FALTAN.join(", ")}` : false;
const GIT_REAL = omitir ? "git" : execFileSync("sh", ["-c", "command -v git"]).toString().trim();

// Archivos que usa produccion.sh (y los scripts que llama) en la copia del repositorio.
const COPIAR = [
  "deploy/produccion.sh",
  "deploy/clase.sh",
  "deploy/gcp/comun-gcp.sh",
  "deploy/gcp/actualizar-gpus.sh",
  "deploy/gcp/startup-script.sh",
  "deploy/gcp/workspaces/startup-ws.sh",
  "browser-ext-prod/manifest.json",
  "vscode-ext-prod/package.json",
];
const version = (ruta) => JSON.parse(readFileSync(path.join(RAIZ, ruta), "utf8")).version;
const VERSION_NAVEGADOR = version("browser-ext-prod/manifest.json");
const VERSION_VSCODE = version("vscode-ext-prod/package.json");

// Secretos de prueba: ninguno puede aparecer en la salida.
const SECRETOS = {
  tokenViejo: "TOKEN-AGENTE-VIEJO-0001",
  latido: "LATIDO-SECRETO-GPU-1234",
  escaneo: "CLAVE-ESCANEO-SECRETA-77",
  sbConn: "Endpoint=sb://x/;SharedAccessKey=SB-SECRETO-99",
  otroSecreto: "OTRA-CLAVE-DE-AZURE-555",
};

const GCLOUD_FALSO = `#!/usr/bin/env bash
F="$FALSO"
printf '%s\\n' "$*" >>"$F/llamadas"
valor() { local clave="$1" a; shift; for a in "$@"; do case "$a" in "$clave="*) printf '%s' "\${a#*=}"; return 0 ;; esac; done; }
poner_estado() { sed -i "s/^$1 \\([^ ]*\\) .*/$1 \\1 $2/" "$F/instancias"; }
case "$1 $2" in
  "config get-value") cat "$F/proyecto"; exit 0 ;;
  "compute ssh")
    comando="$(valor --command "$@")"
    if [ -f "$F/falla-ssh" ]; then echo "ERROR: (gcloud.compute.ssh) IAP rechazo la conexion" >&2; exit 1; fi
    case "$comando" in
      *google_metadata_script_runner*) touch "$F/arranque-$3"; cat "$F/ssh-log" ;;
      *"systemctl is-active"*) cat "$F/ssh-verificar"; cat "$F/ssh-log" ;;
      *) cat "$F/ssh-log" ;;
    esac
    exit 0 ;;
esac
case "$1 $2 $3" in
  "compute instances list") cat "$F/instancias"; exit 0 ;;
  "compute instances describe")
    if [ "$(valor --format "$@")" = json ]; then cat "$F/vm-$4.json"; else awk -v n="$4" '$1 == n {print $3}' "$F/instancias"; fi
    exit 0 ;;
  "compute instances start" | "compute instances resume")
    poner_estado "$4" RUNNING; touch "$F/arranque-$4"; exit 0 ;;
  "compute instances add-metadata")
    if [ -f "$F/falla-add-metadata" ]; then echo "ERROR: sin permiso" >&2; exit 1; fi
    python3 - "$F/vm-$4.json" "$(valor --metadata "$@")" "$(valor --metadata-from-file "$@")" <<'PY'
import json, sys
ruta, en_linea, de_archivo = sys.argv[1:4]
d = json.load(open(ruta))
items = d.setdefault("metadata", {}).setdefault("items", [])
def poner(k, v):
    for i in items:
        if i["key"] == k:
            i["value"] = v
            return
    items.append({"key": k, "value": v})
for par in filter(None, en_linea.split(",")):
    k, v = par.split("=", 1)
    poner(k, v)
for par in filter(None, de_archivo.split(",")):
    k, archivo = par.split("=", 1)
    poner(k, open(archivo).read())
json.dump(d, open(ruta, "w"))
PY
    exit 0 ;;
esac
echo "gcloud falso: llamada no esperada: $*" >&2
exit 2
`;

// az falso: las variables viven en azure.json. Al fallar repite sus argumentos
// (como hace az con un argumento que no reconoce): el script tiene que ocultarlos.
const AZ_FALSO = `#!/usr/bin/env bash
F="$FALSO"
[ -f "$F/az-sin-login" ] && [ "$1 $2" = "account show" ] && { echo "Please run 'az login' to setup account." >&2; exit 1; }
case "$1 $2" in
  "account show") exit 0 ;;
  "appservice plan") cat "$F/capacidad" 2>/dev/null || echo 1; exit 0 ;;
esac
case "$1 $2 $3 $4" in
  "webapp config appsettings list") cat "$F/azure.json"; exit 0 ;;
  "webapp config appsettings set" | "webapp config appsettings delete")
    if [ -f "$F/az-falla" ]; then echo "ERROR: unrecognized arguments: $*" >&2; exit 1; fi
    if [ -f "$F/az-falla-token" ] && [[ "$*" == *WORKSPACE_AGENT_TOKEN=* ]]; then
      printf '%s\\n' "$*" >>"$F/az-intentos"
      echo "ERROR: unrecognized arguments: $*" >&2
      exit 1
    fi
    printf '%s\\n' "$*" >>"$F/az-cambios"
    python3 - "$F/azure.json" "$4" "$@" <<'PY'
import json, sys
ruta, orden, args = sys.argv[1], sys.argv[2], sys.argv[3:]
lista = json.load(open(ruta))
if orden == "set":
    pares = args[args.index("--settings") + 1:]
    for par in pares:
        if par.startswith("--"):
            break
        k, v = par.split("=", 1)
        lista = [i for i in lista if i["name"] != k] + [{"name": k, "value": v, "slotSetting": False}]
else:
    nombres = args[args.index("--setting-names") + 1:]
    lista = [i for i in lista if i["name"] not in nombres]
json.dump(lista, open(ruta, "w"))
PY
    exit 0 ;;
esac
case "$1 $2" in
  "webapp show") echo "/subscriptions/x/resourceGroups/rg/providers/Microsoft.Web/serverfarms/plan-adaceen"; exit 0 ;;
esac
echo "az falso: llamada no esperada: $*" >&2
exit 2
`;

const git = (cwd, ...argumentos) => execFileSync(GIT_REAL, argumentos, {
  cwd,
  env: { ...process.env, GIT_AUTHOR_NAME: "p", GIT_AUTHOR_EMAIL: "p@p", GIT_COMMITTER_NAME: "p", GIT_COMMITTER_EMAIL: "p@p", GIT_CONFIG_NOSYSTEM: "1", HOME: tmpdir() },
  stdio: ["ignore", "pipe", "pipe"],
}).toString().trim();

const metadata = (items) => ({ name: "vm", metadata: { items: Object.entries(items).map(([key, value]) => ({ key, value })) } });

// Estado de produccion antes del despliegue (como el 25 de septiembre).
function estadoInicial() {
  return {
    azure: [
      { name: "AGENT_TARGET", value: "queue" },
      { name: "WORKSPACE_AGENT_URL", value: "http://10.128.0.5:8787" },
      { name: "WORKSPACE_AGENT_TOKEN", value: SECRETOS.tokenViejo },
      { name: "SERVICE_BUS_CONNECTION_STRING", value: SECRETOS.sbConn },
      { name: "OTRA_CLAVE", value: SECRETOS.otroSecreto },
      { name: "ADACEEN_SCAN_WORKER_KEY", value: SECRETOS.escaneo },
    ],
    instancias: [
      "adaceen-worker-v100 us-central1-b TERMINATED",
      "adaceen-worker-a100 us-central1-c TERMINATED",
      "adaceen-worker us-central1-a TERMINATED",
      "adaceen-ws us-central1-a RUNNING",
    ],
    vms: {
      "adaceen-ws": { "startup-script": "#!/bin/bash\n# arranque anterior\nBRANCH=${BRANCH:-feat/workspace-tunnel}\n", branch: "feat/workspace-tunnel", "workspace-agent-token": SECRETOS.tokenViejo, "worker-secret": "VIEJO-WORKER-SECRET-1" },
      "adaceen-worker-v100": { "startup-script": "#!/bin/bash\n# gpu anterior\n", "worker-id": "gce-v100", "sb-conn": SECRETOS.sbConn },
      "adaceen-worker-a100": { "startup-script": "#!/bin/bash\n# gpu anterior\n", "worker-id": "gce-a100", "sb-conn": SECRETOS.sbConn, "heartbeat-token": SECRETOS.latido, "heartbeat-url": "https://api/api/agent/heartbeat" },
      "adaceen-worker": { "startup-script": "#!/bin/bash\n# gpu anterior\n", "worker-id": "gce-l4", "sb-conn": SECRETOS.sbConn, branch: "feat/con-latido", "heartbeat-token": SECRETOS.latido, "heartbeat-url": "https://api/api/agent/heartbeat" },
    },
  };
}

const LOG_ARRANQUE = [
  "=== adaceen-ws startup 2026-09-26T10:00:00+00:00 ===",
  "--- code CLI: 1.104.0",
  `--- PDC ${RAMA} @ abc1234`,
  `--- VSIX adaceen ${VERSION_VSCODE} instalado en /opt/adaceen/adaceen.vsix (github vscode-ext-prod b21231e1723e)`,
  "--- agente de entornos en 127.0.0.1,10.128.0.5 (puerto 8787); relay https://app/api/workspaces/agent",
  "=== listo. api=https://app idle=120min extension=/opt/adaceen/adaceen.vsix ===",
].map((linea) => `log=${linea}`).join("\n") + "\n";
// bloqueo=7: curl como nobody recibe «conexion rechazada» (la regla REJECT de startup-ws.sh).
const VERIFICAR_BIEN = "metadata=active\nagente=active\nrelay=conectado al relay\nbloqueo=7\n";

async function preparar({ estado = estadoInicial(), desplegado = true, versionNueva = true, conAz = true, pushTrasConsultas = 0, conExtension = false } = {}) {
  const dir = mkdtempSync(path.join(tmpdir(), "adaceen-produccion-"));
  const repo = path.join(dir, "PDC");
  const falso = path.join(dir, "falso");
  const bin = path.join(dir, "bin");
  const casa = path.join(dir, "casa");
  for (const carpeta of [repo, falso, bin, casa]) mkdirSync(carpeta, { recursive: true });

  // Repositorio: un commit "produccion anterior" y encima el de esta tanda.
  git(repo, "init", "-q", "-b", "claude/serene-heisenberg-0te9s9");
  writeFileSync(path.join(repo, "LEEME"), "anterior\n");
  git(repo, "add", ".");
  git(repo, "commit", "-q", "-m", "produccion anterior");
  const anterior = git(repo, "rev-parse", "HEAD");
  for (const ruta of COPIAR) {
    mkdirSync(path.dirname(path.join(repo, ruta)), { recursive: true });
    copyFileSync(path.join(RAIZ, ruta), path.join(repo, ruta));
  }
  if (conExtension) {
    // Para comparar el zip publicado con el que arma scripts/empaquetar-extension.mjs.
    cpSync(path.join(RAIZ, "browser-ext-prod"), path.join(repo, "browser-ext-prod"), { recursive: true });
    mkdirSync(path.join(repo, "scripts"), { recursive: true });
    copyFileSync(path.join(RAIZ, "scripts/empaquetar-extension.mjs"), path.join(repo, "scripts/empaquetar-extension.mjs"));
  }
  git(repo, "add", ".");
  git(repo, "commit", "-q", "-m", "esta tanda");
  const nuevo = git(repo, "rev-parse", "HEAD");
  writeFileSync(path.join(falso, "remoto"), desplegado ? nuevo : anterior);

  writeFileSync(path.join(bin, "git"), `#!/usr/bin/env bash
for a in "$@"; do
  if [ "$a" = ls-remote ]; then printf '%s\\trefs/heads/${RAMA}\\n' "$(cat "$FALSO/remoto")"; exit 0; fi
done
exec "${GIT_REAL}" "$@"
`);
  writeFileSync(path.join(bin, "gcloud"), GCLOUD_FALSO);
  if (conAz) writeFileSync(path.join(bin, "az"), AZ_FALSO);
  for (const nombre of readdirSync(bin)) chmodSync(path.join(bin, nombre), 0o755);

  writeFileSync(path.join(falso, "proyecto"), "adaceen-508504\n");
  writeFileSync(path.join(falso, "instancias"), estado.instancias.map((linea) => `${linea}\n`).join(""));
  writeFileSync(path.join(falso, "azure.json"), JSON.stringify(estado.azure));
  for (const [vm, items] of Object.entries(estado.vms)) writeFileSync(path.join(falso, `vm-${vm}.json`), JSON.stringify(metadata(items)));
  writeFileSync(path.join(falso, "llamadas"), "");
  writeFileSync(path.join(falso, "az-cambios"), "");
  writeFileSync(path.join(falso, "ssh-log"), LOG_ARRANQUE);
  writeFileSync(path.join(falso, "ssh-verificar"), VERIFICAR_BIEN);
  if (versionNueva) writeFileSync(path.join(falso, "version-nueva"), "");

  const leerJson = (nombre) => JSON.parse(readFileSync(path.join(falso, nombre), "utf8"));
  const azure = () => Object.fromEntries(leerJson("azure.json").map((i) => [i.name, i.value]));
  const vm = (nombre) => Object.fromEntries(leerJson(`vm-${nombre}.json`).metadata.items.map((i) => [i.key, i.value]));

  // Backend de prueba: responde segun el estado de los falsos.
  let consultas = 0;
  let cambiosVistos = 0;
  let caidas = 0;
  let reconexion = 0;
  const servidor = http.createServer((req, res) => {
    if (req.url === "/api/health") {
      consultas += 1;
      // Cada cambio de variables reinicia el App Service.
      const cambios = readFileSync(path.join(falso, "az-cambios"), "utf8").split("\n").filter(Boolean).length;
      if (cambios > cambiosVistos) {
        cambiosVistos = cambios;
        caidas = 2;
        reconexion = 3;
      }
      if (caidas > 0) {
        caidas -= 1;
        res.writeHead(503).end("reiniciando");
        return;
      }
      const reconectando = reconexion > 0;
      if (reconexion > 0) reconexion -= 1;
      // El push y el flujo terminan mientras aplicar espera.
      if (pushTrasConsultas && consultas >= pushTrasConsultas && !existsSync(path.join(falso, "version-nueva"))) {
        writeFileSync(path.join(falso, "version-nueva"), "");
        writeFileSync(path.join(falso, "remoto"), nuevo);
      }
      const a = azure();
      const salud = { ok: true, mode: "queue", queue_configured: true, database_provider: "postgres", github_app_configured: false };
      if (existsSync(path.join(falso, "version-nueva"))) {
        const tunel = (a.ADACEEN_WORKSPACE_PROVIDER || "").toLowerCase() === "tunnel";
        // Como src/services/workspace-provider.ts: WORKSPACE_AGENT_TRANSPORT manda; si no, la URL.
        const transporte = (a.WORKSPACE_AGENT_TRANSPORT || "").toLowerCase();
        const encendida = /^adaceen-ws \S+ RUNNING$/m.test(readFileSync(path.join(falso, "instancias"), "utf8"));
        Object.assign(salud, {
          telemetry_salt_configured: Boolean(a.TELEMETRY_SALT),
          worker_heartbeat_configured: Boolean(a.WORKER_HEARTBEAT_TOKEN),
          workspace_provider: tunel ? "tunnel" : "codespaces",
          workspace_agent_online: !reconectando && tunel && encendida && existsSync(path.join(falso, "arranque-adaceen-ws")) &&
            Boolean(a.WORKSPACE_AGENT_TOKEN) && a.WORKSPACE_AGENT_TOKEN === vm("adaceen-ws")["workspace-agent-token"],
          workspace_agent_transport: tunel ? (["direct", "relay"].includes(transporte) ? transporte : a.WORKSPACE_AGENT_URL ? "direct" : "relay") : null,
          workspace_vm_autostart: false,
          model_workers_alive: 0,
          model_workers_known_down: false,
        });
      }
      res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify(salud));
    } else if (req.url === "/api/agent/backend") {
      res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ listening: [], alive_workers: 0 }));
    } else if (req.url === "/empezar" && existsSync(path.join(falso, "version-nueva"))) {
      res.writeHead(200, { "content-type": "text/html" }).end(`<!doctype html><html lang="es" data-browser-ext-latest="${VERSION_NAVEGADOR}"><h1>Empieza con ADACEEN</h1><span>zip, version ${VERSION_NAVEGADOR}</span><span>VSIX, version ${VERSION_VSCODE}</span></html>`);
    } else if (req.url.startsWith("/descargas/") && existsSync(path.join(falso, "version-nueva"))) {
      const zip = path.join(falso, "zip-publicado");
      const cuerpo = req.url === "/descargas/adaceen-navegador.zip" && existsSync(zip) ? readFileSync(zip) : "contenido";
      res.writeHead(200, { "content-type": "application/octet-stream", "content-disposition": `attachment; filename="${path.basename(req.url)}"` }).end(cuerpo);
    } else {
      res.writeHead(404).end();
    }
  });
  await new Promise((resolve) => servidor.listen(0, "127.0.0.1", resolve));
  const url = `http://127.0.0.1:${servidor.address().port}`;
  // Sin proxies: el backend de prueba escucha en 127.0.0.1.
  const env = { PATH: `${bin}:${process.env.PATH}`, HOME: casa, FALSO: falso, LANG: "C.UTF-8", TMPDIR: dir, BACKEND: url, INTERVALO: "0.1", ESPERA_MAX: "20" };
  return {
    dir, repo, falso, casa, env, url, anterior, nuevo, azure, vm,
    script: path.join(repo, "deploy", "produccion.sh"),
    llamadas: () => readFileSync(path.join(falso, "llamadas"), "utf8"),
    cambiosAz: () => readFileSync(path.join(falso, "az-cambios"), "utf8"),
    respaldos: () => readdirSync(casa).filter((nombre) => nombre.startsWith("adaceen-respaldo-")),
    cerrar: () => new Promise((resolve) => servidor.close(resolve)),
  };
}

function correr(p, argumentos, { env = {}, entrada = "" } = {}) {
  return new Promise((resolve) => {
    const hijo = spawn("bash", [p.script, ...argumentos], { env: { ...p.env, ...env }, cwd: p.repo, stdio: ["pipe", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    hijo.stdout.on("data", (dato) => { stdout += dato; });
    hijo.stderr.on("data", (dato) => { stderr += dato; });
    const reloj = setTimeout(() => hijo.kill("SIGKILL"), 90000);
    hijo.on("close", (codigo) => {
      clearTimeout(reloj);
      resolve({ codigo, stdout, stderr, todo: stdout + stderr });
    });
    hijo.stdin.end(entrada);
  });
}

// Ningun secreto (los de prueba y los que genero aplicar) en la salida.
function sinSecretos(p, r, extras = []) {
  const a = p.azure();
  const generados = [a.TELEMETRY_SALT, a.WORKSPACE_AGENT_TOKEN, p.vm("adaceen-ws")["workspace-agent-token"]].filter(Boolean);
  for (const secreto of [...Object.values(SECRETOS), "VIEJO-WORKER-SECRET-1", ...generados, ...extras]) {
    assert.equal(r.todo.includes(secreto), false, `secreto en la salida: ${secreto.slice(0, 6)}…`);
  }
}

const huella = (valor) => execFileSync("sha256sum", { input: `${valor}\n` }).toString().slice(0, 12);
const MODIFICA_GCLOUD = / (add-metadata|remove-metadata|start|resume|stop) |google_metadata_script_runner/;

// ------------------------------------------------------------------ revisar
test("produccion.sh revisar (por defecto): solo lee, muestra nombres y huellas y lista lo que haria aplicar", { skip: omitir }, async () => {
  const p = await preparar({ desplegado: false, versionNueva: false });
  try {
    const antesAzure = readFileSync(path.join(p.falso, "azure.json"), "utf8");
    const antesVm = readFileSync(path.join(p.falso, "vm-adaceen-ws.json"), "utf8");
    const r = await correr(p, []);
    assert.equal(r.codigo, 0, r.todo);
    // Nada cambio.
    assert.equal(p.cambiosAz(), "");
    assert.doesNotMatch(p.llamadas(), MODIFICA_GCLOUD);
    assert.doesNotMatch(p.llamadas(), /compute ssh/);
    assert.equal(readFileSync(path.join(p.falso, "azure.json"), "utf8"), antesAzure);
    assert.equal(readFileSync(path.join(p.falso, "vm-adaceen-ws.json"), "utf8"), antesVm);
    assert.deepEqual(p.respaldos(), []);
    // Variables por nombre y si tienen valor.
    assert.match(r.stdout, /ADACEEN_WORKSPACE_PROVIDER\s+ausente\s+-> aplicar pone tunnel/);
    assert.match(r.stdout, /WORKSPACE_AGENT_URL\s+con valor\s+-> aplicar la borra/);
    assert.match(r.stdout, /TELEMETRY_SALT\s+ausente\s+-> aplicar la crea/);
    // Huellas iguales a las del anexo (sha256sum de "valor\n").
    assert.match(r.stdout, new RegExp(`WORKSPACE_AGENT_TOKEN\\s+Azure ${huella(SECRETOS.tokenViejo)}\\s+adaceen-ws\\s+${huella(SECRETOS.tokenViejo)}\\s+✓ iguales`));
    assert.match(r.stdout, new RegExp(`WORKER_HEARTBEAT_TOKEN\\s+Azure \\(sin valor\\)\\s+adaceen-worker-a100\\s+${huella(SECRETOS.latido)}`));
    // Estado del repositorio, de /api/health y de las VMs.
    assert.match(r.stdout, /el push sera fast-forward/);
    assert.match(r.stdout, /git push origin claude\/serene-heisenberg-0te9s9:feature\/azure-config-observability/);
    assert.match(r.stdout, /version anterior \(sin workspace_vm_autostart\)/);
    assert.match(r.stdout, /adaceen-ws \(us-central1-a\): RUNNING \| rama feat\/workspace-tunnel \| startup-script: otro/);
    assert.match(r.stdout, /una sola instancia/);
    // El plan, en orden.
    const plan = r.stdout.slice(r.stdout.indexOf("\"aplicar\" haria"));
    const orden = [
      /1\. Azure, un solo appsettings set .*ADACEEN_WORKSPACE_PROVIDER=tunnel, PUBLIC_BASE_URL=http:\/\/127\.0\.0\.1:\d+, TELEMETRY_SALT \(nuevo, al azar; no existia\), WORKER_HEARTBEAT_TOKEN \(copiado de la metadata de adaceen-worker-a100\)/,
      /2\. Azure: borrar WORKSPACE_AGENT_URL/,
      /3\. esperar .* a que \/api\/health muestre la version nueva/,
      /4\. guardar para volver atras/,
      /5\. adaceen-ws: metadata scan-worker-key = ADACEEN_SCAN_WORKER_KEY de Azure/,
      /6\. adaceen-ws: pedir confirmacion y, en una cadena, WORKSPACE_AGENT_TOKEN nuevo/,
      /7\. adaceen-ws \(RUNNING\): correr el arranque por IAP/,
      /8\. GPU: RAMA=feature\/azure-config-observability bash deploy\/gcp\/actualizar-gpus\.sh/,
    ];
    for (const paso of orden) assert.match(plan, paso);
    assert.match(r.stdout, /revisar no cambio nada/);
    sinSecretos(p, r);
  } finally {
    await p.cerrar();
  }
});

test("produccion.sh revisar: sin az dice el comando exacto para instalarlo y no toca nada", { skip: omitir }, async () => {
  const p = await preparar({ conAz: false });
  try {
    const r = await correr(p, ["revisar"]);
    assert.equal(r.codigo, 1, r.todo);
    assert.match(r.stderr, /curl -sL https:\/\/aka\.ms\/InstallAzureCLIDeb \| sudo bash/);
    assert.match(r.stderr, /az login --use-device-code/);
    assert.match(r.stdout, /antes de aplicar: az no esta listo/);
    assert.doesNotMatch(p.llamadas(), MODIFICA_GCLOUD);
    sinSecretos(p, r);
  } finally {
    await p.cerrar();
  }
});

// ------------------------------------------------------------------ aplicar
test("produccion.sh aplicar: hace todo en orden, sin mostrar secretos, y la segunda vez no cambia nada", { skip: omitir }, async () => {
  const p = await preparar();
  try {
    const startupAnterior = p.vm("adaceen-ws")["startup-script"];
    const r = await correr(p, ["aplicar"], { env: { CONFIRMAR: "1" } });
    assert.equal(r.codigo, 0, r.todo);

    // Azure: un solo set con las que faltaban, WORKSPACE_AGENT_URL borrada y el token rotado.
    const a = p.azure();
    assert.equal(a.ADACEEN_WORKSPACE_PROVIDER, "tunnel");
    assert.equal(a.PUBLIC_BASE_URL, p.url);
    assert.match(a.TELEMETRY_SALT, /^[0-9a-f]{64}$/);
    assert.equal(a.WORKER_HEARTBEAT_TOKEN, SECRETOS.latido);
    assert.equal("WORKSPACE_AGENT_URL" in a, false);
    assert.match(a.WORKSPACE_AGENT_TOKEN, /^[0-9a-f]{64}$/);
    const cambios = p.cambiosAz().trim().split("\n");
    assert.equal(cambios.length, 3, cambios.join("\n"));
    assert.match(cambios[0], /^webapp config appsettings set .*--output none --settings ADACEEN_WORKSPACE_PROVIDER=tunnel PUBLIC_BASE_URL=\S+ TELEMETRY_SALT=\S+ WORKER_HEARTBEAT_TOKEN=\S+$/);
    assert.match(cambios[1], /^webapp config appsettings delete .*--setting-names WORKSPACE_AGENT_URL --output none$/);
    assert.match(cambios[2], /^webapp config appsettings set .*--output none --settings WORKSPACE_AGENT_TOKEN=\S+$/);

    // VM de editores: rama, startup-ws.sh nuevo, el mismo token que Azure y la clave de escaneo.
    const ws = p.vm("adaceen-ws");
    assert.equal(ws.branch, RAMA);
    assert.equal(ws["startup-script"], readFileSync(path.join(RAIZ, "deploy/gcp/workspaces/startup-ws.sh"), "utf8"));
    assert.equal(ws["workspace-agent-token"], a.WORKSPACE_AGENT_TOKEN);
    assert.equal(ws["scan-worker-key"], SECRETOS.escaneo);
    const llamadas = p.llamadas();
    assert.match(llamadas, /compute ssh adaceen-ws --zone=us-central1-a --project=adaceen-508504 --tunnel-through-iap --quiet --command=sudo google_metadata_script_runner startup/);
    // Los secretos van por archivo: nunca en la linea de comandos de gcloud.
    for (const secreto of [a.WORKSPACE_AGENT_TOKEN, SECRETOS.escaneo]) assert.equal(llamadas.includes(secreto), false);
    assert.match(r.stdout, new RegExp(`token rotado en Azure y en la VM \\(huella nueva ${huella(a.WORKSPACE_AGENT_TOKEN)}\\)`));
    assert.match(r.stdout, /workspace_agent_online: true/);
    assert.match(r.stdout, /arranque nuevo sin avisos/);

    // GPU: actualizar-gpus.sh con la rama de produccion (y el latido copiado a la que no lo tenia).
    for (const gpu of ["adaceen-worker-v100", "adaceen-worker-a100", "adaceen-worker"]) {
      const m = p.vm(gpu);
      assert.equal(m["startup-script"], readFileSync(path.join(RAIZ, "deploy/gcp/startup-script.sh"), "utf8"), gpu);
      assert.equal(m.branch, RAMA, gpu);
      assert.equal(m["heartbeat-token"], SECRETOS.latido, gpu);
    }
    assert.doesNotMatch(llamadas, / (start|resume) adaceen-worker/);

    // Respaldo para volver atras.
    const [respaldo] = p.respaldos();
    assert.ok(respaldo, "no hay respaldo");
    const carpeta = path.join(p.casa, respaldo);
    assert.equal(readFileSync(path.join(carpeta, "startup-ws-anterior.sh"), "utf8"), startupAnterior);
    assert.match(readFileSync(path.join(carpeta, "adaceen-ws.txt"), "utf8"), /^rama=feat\/workspace-tunnel$/m);
    const volver = readFileSync(path.join(carpeta, "volver-atras.txt"), "utf8");
    assert.match(volver, /gcloud compute instances add-metadata adaceen-ws --zone=us-central1-a --metadata=branch=feat\/workspace-tunnel --metadata-from-file=startup-script=.*startup-ws-anterior\.sh/);
    assert.match(volver, /adaceen-worker us-central1-a worker-id=gce-l4 rama=feat\/con-latido/);
    assert.match(readFileSync(path.join(carpeta, "azure-variables.txt"), "utf8"), /^WORKSPACE_AGENT_TOKEN con valor$/m);
    assert.equal(readFileSync(path.join(carpeta, "azure-variables.txt"), "utf8").includes(SECRETOS.tokenViejo), false);
    sinSecretos(p, r);

    // Segunda vez: nada que hacer.
    const antes = { azure: p.azure(), llamadas: p.llamadas().length };
    const r2 = await correr(p, ["aplicar"]);
    assert.equal(r2.codigo, 0, r2.todo);
    assert.equal(p.cambiosAz().trim().split("\n").length, 3, "la segunda vez cambio Azure");
    assert.deepEqual(p.azure(), antes.azure);
    assert.doesNotMatch(p.llamadas().slice(antes.llamadas), MODIFICA_GCLOUD);
    assert.doesNotMatch(p.llamadas().slice(antes.llamadas), /compute ssh/);
    assert.equal(p.respaldos().length, 1);
    assert.match(r2.stdout, /variables del App Service: nada que crear/);
    assert.match(r2.stdout, /no se rota/);
    assert.match(r2.stdout, /GPU: startup-script, rama feature\/azure-config-observability y latido al dia/);
    sinSecretos(p, r2);
  } finally {
    await p.cerrar();
  }
});

test("produccion.sh aplicar antes del push: carga las variables, espera y sigue cuando llega la version nueva", { skip: omitir }, async () => {
  const p = await preparar({ desplegado: false, versionNueva: false, pushTrasConsultas: 4 });
  try {
    const r = await correr(p, ["aplicar"], { env: { CONFIRMAR: "1" } });
    assert.equal(r.codigo, 0, r.todo);
    assert.match(r.stdout, /falta el push\. En PowerShell \(seccion 2 de la guia\): git push origin claude\/serene-heisenberg-0te9s9:feature\/azure-config-observability/);
    // Las variables antes que la espera; la VM despues.
    assert.ok(r.stdout.indexOf("variables cargadas en Azure") < r.stdout.indexOf("espero hasta"));
    assert.ok(r.stdout.indexOf("espero hasta") < r.stdout.indexOf("token rotado"));
    assert.equal(p.vm("adaceen-ws").branch, RAMA);
    sinSecretos(p, r);
  } finally {
    await p.cerrar();
  }
});

test("produccion.sh aplicar: si el push no llega, corta con un mensaje claro sin tocar la VM ni las GPU", { skip: omitir }, async () => {
  const p = await preparar({ desplegado: false, versionNueva: false });
  try {
    const r = await correr(p, ["aplicar"], { env: { CONFIRMAR: "1", ESPERA_MAX: "1" } });
    assert.equal(r.codigo, 1, r.todo);
    assert.match(r.stderr, /todavia no se hizo el push\. Hazlo en PowerShell \(git push origin claude\/serene-heisenberg-0te9s9:feature\/azure-config-observability\) y vuelve a correr bash deploy\/produccion\.sh aplicar/);
    assert.match(r.stderr, /La VM y las GPU no se tocaron/);
    assert.equal(p.azure().ADACEEN_WORKSPACE_PROVIDER, "tunnel");
    // Solo Azure: ni metadata, ni arranque, ni GPU, ni respaldo.
    assert.doesNotMatch(p.llamadas(), MODIFICA_GCLOUD);
    assert.doesNotMatch(p.llamadas(), /compute ssh/);
    assert.deepEqual(p.respaldos(), []);
    assert.equal(p.vm("adaceen-ws")["workspace-agent-token"], SECRETOS.tokenViejo);
    sinSecretos(p, r);
  } finally {
    await p.cerrar();
  }
});

test("produccion.sh aplicar: si az falla corta antes de tocar la VM y no muestra lo que az repite", { skip: omitir }, async () => {
  const p = await preparar();
  try {
    writeFileSync(path.join(p.falso, "az-falla"), "");
    const r = await correr(p, ["aplicar"], { env: { CONFIRMAR: "1" } });
    assert.equal(r.codigo, 1, r.todo);
    assert.match(r.stderr, /az no pudo cargar las variables: ERROR: unrecognized arguments: .*\*\*\*.* No se toco nada mas \(ni la VM ni las GPU\)/);
    assert.doesNotMatch(p.llamadas(), MODIFICA_GCLOUD);
    assert.doesNotMatch(p.llamadas(), /compute ssh/);
    assert.deepEqual(p.respaldos(), []);
    // El TELEMETRY_SALT que se genero tampoco sale.
    assert.doesNotMatch(r.todo, /TELEMETRY_SALT=[0-9a-f]{64}/);
    sinSecretos(p, r);
  } finally {
    await p.cerrar();
  }
});

test("produccion.sh aplicar: sin sesion de az no cambia nada", { skip: omitir }, async () => {
  const p = await preparar();
  try {
    writeFileSync(path.join(p.falso, "az-sin-login"), "");
    const r = await correr(p, ["aplicar"], { env: { CONFIRMAR: "1" } });
    assert.equal(r.codigo, 1, r.todo);
    assert.match(r.stderr, /az login --use-device-code/);
    assert.match(r.stderr, /sin az no se puede aplicar\. No se toco nada/);
    assert.equal(p.cambiosAz(), "");
    assert.doesNotMatch(p.llamadas(), MODIFICA_GCLOUD);
    sinSecretos(p, r);
  } finally {
    await p.cerrar();
  }
});

test("produccion.sh aplicar: si falla la metadata despues de Azure lo dice y la repeticion rota de nuevo en los dos lados", { skip: omitir }, async () => {
  // La VM ya tiene la clave de escaneo: el unico add-metadata que falla es el del token.
  const estado = estadoInicial();
  estado.vms["adaceen-ws"]["scan-worker-key"] = SECRETOS.escaneo;
  const p = await preparar({ estado });
  try {
    writeFileSync(path.join(p.falso, "falla-add-metadata"), "");
    let r = await correr(p, ["aplicar", "--sin-gpu"], { env: { CONFIRMAR: "1" } });
    assert.equal(r.codigo, 1, r.todo);
    assert.match(r.stderr, /Azure ya tiene el token nuevo pero adaceen-ws no/);
    assert.notEqual(p.azure().WORKSPACE_AGENT_TOKEN, p.vm("adaceen-ws")["workspace-agent-token"]);
    sinSecretos(p, r);
    execFileSync("rm", [path.join(p.falso, "falla-add-metadata")]);
    r = await correr(p, ["aplicar", "--sin-gpu"], { env: { CONFIRMAR: "1" } });
    assert.equal(r.codigo, 0, r.todo);
    assert.equal(p.azure().WORKSPACE_AGENT_TOKEN, p.vm("adaceen-ws")["workspace-agent-token"]);
    sinSecretos(p, r);
  } finally {
    await p.cerrar();
  }
});

test("produccion.sh aplicar --sin-vm --sin-gpu: solo Azure; --sin-gpu no toca las GPU; --sin-vm no toca la VM ni el token", { skip: omitir }, async () => {
  const p = await preparar();
  try {
    let r = await correr(p, ["aplicar", "--sin-vm", "--sin-gpu"]);
    assert.equal(r.codigo, 0, r.todo);
    assert.equal(p.azure().ADACEEN_WORKSPACE_PROVIDER, "tunnel");
    assert.equal(p.azure().WORKSPACE_AGENT_TOKEN, SECRETOS.tokenViejo);
    assert.doesNotMatch(p.llamadas(), MODIFICA_GCLOUD);
    assert.match(r.stdout, /VM de editores: no se toca \(--sin-vm\)/);
    assert.match(r.stdout, /GPU: no se tocan \(--sin-gpu\)/);

    r = await correr(p, ["aplicar", "--sin-vm"]);
    assert.equal(r.codigo, 0, r.todo);
    assert.doesNotMatch(p.llamadas(), /add-metadata adaceen-ws|compute ssh/);
    assert.equal(p.azure().WORKSPACE_AGENT_TOKEN, SECRETOS.tokenViejo);
    assert.equal(p.vm("adaceen-worker-v100").branch, RAMA);

    const p2 = await preparar();
    try {
      r = await correr(p2, ["aplicar", "--sin-gpu"], { env: { CONFIRMAR: "1" } });
      assert.equal(r.codigo, 0, r.todo);
      assert.equal(p2.vm("adaceen-ws").branch, RAMA);
      assert.doesNotMatch(p2.llamadas(), /add-metadata adaceen-worker/);
      assert.equal(p2.vm("adaceen-worker-v100")["startup-script"], "#!/bin/bash\n# gpu anterior\n");
      sinSecretos(p2, r);
    } finally {
      await p2.cerrar();
    }
  } finally {
    await p.cerrar();
  }
});

test("produccion.sh aplicar: sin terminal ni CONFIRMAR=1 no rota el token ni toca la VM", { skip: omitir }, async () => {
  const p = await preparar();
  try {
    const r = await correr(p, ["aplicar"]);
    assert.equal(r.codigo, 1, r.todo);
    assert.match(r.stderr, /No lo hagas durante una clase/);
    assert.match(r.stderr, /CONFIRMAR=1 bash deploy\/produccion\.sh aplicar/);
    assert.equal(p.azure().WORKSPACE_AGENT_TOKEN, SECRETOS.tokenViejo);
    assert.doesNotMatch(p.llamadas(), /--metadata=branch|compute ssh|add-metadata adaceen-worker/);
    sinSecretos(p, r);
  } finally {
    await p.cerrar();
  }
});

test("produccion.sh aplicar: con la VM apagada rota sin encenderla; con --encender-vm la enciende", { skip: omitir }, async () => {
  const estado = estadoInicial();
  estado.instancias[3] = "adaceen-ws us-central1-a TERMINATED";
  const p = await preparar({ estado });
  try {
    let r = await correr(p, ["aplicar", "--sin-gpu"], { env: { CONFIRMAR: "1" } });
    assert.equal(r.codigo, 0, r.todo);
    assert.equal(p.vm("adaceen-ws")["workspace-agent-token"], p.azure().WORKSPACE_AGENT_TOKEN);
    assert.doesNotMatch(p.llamadas(), /instances start adaceen-ws|compute ssh/);
    assert.match(r.stdout, /bash deploy\/produccion\.sh aplicar --encender-vm/);

    r = await correr(p, ["aplicar", "--sin-gpu", "--encender-vm"]);
    assert.equal(r.codigo, 0, r.todo);
    assert.match(p.llamadas(), /compute instances start adaceen-ws --zone=us-central1-a --project=adaceen-508504/);
    assert.match(r.stdout, /workspace_agent_online: true/);
    sinSecretos(p, r);
  } finally {
    await p.cerrar();
  }
});

test("produccion.sh aplicar: corta antes de tocar nada si ~/PDC no es lo que se despliega", { skip: omitir }, async () => {
  const p = await preparar();
  try {
    // GitHub tiene un commit que ~/PDC no tiene.
    writeFileSync(path.join(p.falso, "remoto"), "0123456789012345678901234567890123456789");
    const r = await correr(p, ["aplicar"], { env: { CONFIRMAR: "1" } });
    assert.equal(r.codigo, 1, r.todo);
    assert.match(r.stderr, /git fetch origin && git checkout feature\/azure-config-observability && git pull --ff-only/);
    assert.equal(p.cambiosAz(), "");
    assert.doesNotMatch(p.llamadas(), MODIFICA_GCLOUD);
    sinSecretos(p, r);
  } finally {
    await p.cerrar();
  }
});

test("produccion.sh aplicar: si az falla al rotar el token, la VM no recibe nada y los dos lados siguen con el mismo", { skip: omitir }, async () => {
  const p = await preparar();
  try {
    // az acepta las variables, pero rechaza el cambio de WORKSPACE_AGENT_TOKEN (y repite sus argumentos).
    writeFileSync(path.join(p.falso, "az-falla-token"), "");
    const r = await correr(p, ["aplicar", "--sin-gpu"], { env: { CONFIRMAR: "1" } });
    assert.equal(r.codigo, 1, r.todo);
    assert.match(r.stderr, /az no pudo cambiar WORKSPACE_AGENT_TOKEN: ERROR: unrecognized arguments: .*WORKSPACE_AGENT_TOKEN=\*\*\*.* La VM no se toco: Azure y la VM siguen con el mismo token/);
    assert.equal(p.azure().ADACEEN_WORKSPACE_PROVIDER, "tunnel");
    assert.equal(p.azure().WORKSPACE_AGENT_TOKEN, SECRETOS.tokenViejo);
    assert.equal(p.vm("adaceen-ws")["workspace-agent-token"], SECRETOS.tokenViejo);
    assert.equal(p.vm("adaceen-ws").branch, "feat/workspace-tunnel");
    assert.doesNotMatch(p.llamadas(), /workspace-agent-token=|--metadata=branch|compute ssh/);
    // El token que se genero y az repitio no sale en la salida.
    const [intento] = readFileSync(path.join(p.falso, "az-intentos"), "utf8").match(/WORKSPACE_AGENT_TOKEN=([0-9a-f]{64})/).slice(1);
    assert.equal(r.todo.includes(intento), false);
    sinSecretos(p, r, [intento]);
  } finally {
    await p.cerrar();
  }
});

// Corre produccion.sh con una terminal de verdad (script de util-linux): `antes` es lo
// que ya esperaba en la terminal (un bloque pegado entero) y `respuesta` se escribe
// cuando aparece la pregunta.
function correrEnTerminal(p, argumentos, { env = {}, antes = "", respuesta = "" } = {}) {
  return new Promise((resolve) => {
    const hijo = spawn("script", ["-qec", ["bash", p.script, ...argumentos].join(" "), "/dev/null"], {
      env: { ...p.env, ...env }, cwd: p.repo, stdio: ["pipe", "pipe", "pipe"],
    });
    let todo = "";
    let contestado = false;
    const recibir = (dato) => {
      todo += dato;
      if (!contestado && todo.includes("¿Rotar ahora?")) {
        contestado = true;
        hijo.stdin.write(`${respuesta}\n`);
      }
    };
    hijo.stdout.setEncoding("utf8").on("data", recibir);
    hijo.stderr.setEncoding("utf8").on("data", recibir);
    const reloj = setTimeout(() => hijo.kill("SIGKILL"), 90000);
    hijo.on("close", (codigo) => {
      clearTimeout(reloj);
      hijo.stdin.destroy();
      resolve({ codigo, contestado, stdout: todo, stderr: todo, todo });
    });
    if (antes) hijo.stdin.write(antes);
  });
}

test("produccion.sh aplicar en una terminal: lo pegado antes de la pregunta no la contesta; si rota, cualquier otra cosa no", { skip: omitir || (hay("script") ? false : "falta script (util-linux)") }, async () => {
  const p = await preparar();
  try {
    // Otra respuesta: no rota, no guarda respaldo ni toca la VM.
    let r = await correrEnTerminal(p, ["aplicar", "--sin-gpu"], { respuesta: "no" });
    assert.equal(r.contestado, true, r.todo);
    assert.equal(r.codigo, 1, r.todo);
    assert.match(r.todo, /no se roto el token ni se toco la VM/);
    assert.equal(p.azure().WORKSPACE_AGENT_TOKEN, SECRETOS.tokenViejo);
    assert.equal(p.vm("adaceen-ws")["workspace-agent-token"], SECRETOS.tokenViejo);
    assert.doesNotMatch(p.llamadas(), /add-metadata adaceen-ws|compute ssh/);
    assert.deepEqual(p.respaldos(), []);
    sinSecretos(p, r);

    // El bloque de la guia pegado entero: la linea siguiente ya espera en la terminal.
    r = await correrEnTerminal(p, ["aplicar", "--sin-gpu"], { antes: "bash deploy/produccion.sh verificar\n", respuesta: "si" });
    assert.equal(r.contestado, true, r.todo);
    assert.equal(r.codigo, 0, r.todo);
    assert.match(r.todo, /descarte 1 linea\(s\) escritas o pegadas antes de esta pregunta/);
    assert.match(r.todo, /token rotado en Azure y en la VM/);
    assert.notEqual(p.azure().WORKSPACE_AGENT_TOKEN, SECRETOS.tokenViejo);
    assert.equal(p.vm("adaceen-ws")["workspace-agent-token"], p.azure().WORKSPACE_AGENT_TOKEN);
    sinSecretos(p, r);
  } finally {
    await p.cerrar();
  }
});

test("produccion.sh aplicar: WORKSPACE_AGENT_TRANSPORT=direct pasa a relay; con token y startup al dia solo cambia la rama, sin rotar", { skip: omitir }, async () => {
  const estado = estadoInicial();
  estado.azure = estado.azure.filter((i) => i.name !== "WORKSPACE_AGENT_URL");
  estado.azure.push({ name: "ADACEEN_WORKSPACE_PROVIDER", value: "tunnel" }, { name: "WORKSPACE_AGENT_TRANSPORT", value: "direct" });
  Object.assign(estado.vms["adaceen-ws"], {
    "startup-script": readFileSync(path.join(RAIZ, "deploy/gcp/workspaces/startup-ws.sh"), "utf8"),
    "scan-worker-key": SECRETOS.escaneo,
  });
  const p = await preparar({ estado });
  try {
    // Sin terminal ni CONFIRMAR: no hace falta confirmar porque no se rota.
    const r = await correr(p, ["aplicar", "--sin-gpu"]);
    assert.equal(r.codigo, 0, r.todo);
    const [primero] = p.cambiosAz().trim().split("\n");
    assert.match(primero, /--settings PUBLIC_BASE_URL=\S+ WORKSPACE_AGENT_TRANSPORT=relay TELEMETRY_SALT=\S+ WORKER_HEARTBEAT_TOKEN=\S+$/);
    assert.equal(p.azure().WORKSPACE_AGENT_TRANSPORT, "relay");
    assert.doesNotMatch(p.cambiosAz(), /WORKSPACE_AGENT_TOKEN=/);
    assert.equal(p.azure().WORKSPACE_AGENT_TOKEN, SECRETOS.tokenViejo);
    assert.equal(p.vm("adaceen-ws")["workspace-agent-token"], SECRETOS.tokenViejo);
    assert.equal(p.vm("adaceen-ws").branch, RAMA);
    assert.match(p.llamadas(), /add-metadata adaceen-ws --zone=us-central1-a --project=adaceen-508504 --metadata=branch=feature\/azure-config-observability\n/);
    assert.doesNotMatch(p.llamadas(), /workspace-agent-token=/);
    assert.match(p.llamadas(), /google_metadata_script_runner/);
    assert.match(r.stdout, /✓ adaceen-ws: branch=feature\/azure-config-observability/);
    assert.match(r.stdout, /workspace_agent_online: true \(transporte relay\)/);
    assert.doesNotMatch(r.todo, /Rotar ahora|voy a rotar/);
    sinSecretos(p, r);
  } finally {
    await p.cerrar();
  }
});

test("produccion.sh: la version de VS Code esperada es la del commit que fija el submodulo, no la de su copia de trabajo", { skip: omitir }, async () => {
  const p = await preparar();
  try {
    // vscode-ext-prod como submodulo: fijado en la version actual, con la copia de
    // trabajo en un commit anterior (un ~/PDC viejo sin git submodule update).
    const origen = path.join(p.dir, "vscode-ext-prod-origen");
    mkdirSync(origen);
    git(origen, "init", "-q", "-b", "main");
    writeFileSync(path.join(origen, "package.json"), JSON.stringify({ name: "adaceen", version: "0.0.30" }));
    git(origen, "add", ".");
    git(origen, "commit", "-q", "-m", "0.0.30");
    const viejo = git(origen, "rev-parse", "HEAD");
    writeFileSync(path.join(origen, "package.json"), JSON.stringify({ name: "adaceen", version: VERSION_VSCODE }));
    git(origen, "commit", "-q", "-am", VERSION_VSCODE);
    git(p.repo, "rm", "-q", "-r", "vscode-ext-prod");
    git(p.repo, "-c", "protocol.file.allow=always", "submodule", "add", "-q", origen, "vscode-ext-prod");
    git(p.repo, "commit", "-q", "-m", "submodulo");
    git(path.join(p.repo, "vscode-ext-prod"), "checkout", "-q", viejo);
    assert.equal(JSON.parse(readFileSync(path.join(p.repo, "vscode-ext-prod/package.json"), "utf8")).version, "0.0.30");
    writeFileSync(path.join(p.falso, "remoto"), git(p.repo, "rev-parse", "HEAD"));

    let r = await correr(p, ["aplicar", "--sin-gpu"], { env: { CONFIRMAR: "1" } });
    assert.equal(r.codigo, 0, r.todo);
    assert.match(r.stdout, /arranque nuevo sin avisos/);
    assert.doesNotMatch(r.todo, /VSIX 0\.0\.30/);
    r = await correr(p, ["verificar", "--sin-gpu"]);
    assert.equal(r.codigo, 0, r.todo);
    assert.match(r.stdout, new RegExp(`✓ /empezar ofrece la extension de VS Code ${VERSION_VSCODE.replace(/\./g, "\\.")} \\(el submodulo fija la ${VERSION_VSCODE.replace(/\./g, "\\.")}\\)`));
    sinSecretos(p, r);
  } finally {
    await p.cerrar();
  }
});

test("produccion.sh: el latido se copia de la GPU que tiene heartbeat-url y heartbeat-token, y avisa si alguna GPU tiene otro", { skip: omitir }, async () => {
  const OTRO_LATIDO = "OTRO-LATIDO-DE-LA-V100-42";
  const estado = estadoInicial();
  // La V100 tiene un heartbeat-token distinto y ningun heartbeat-url.
  estado.vms["adaceen-worker-v100"]["heartbeat-token"] = OTRO_LATIDO;
  const p = await preparar({ estado });
  try {
    let r = await correr(p, ["revisar"]);
    assert.equal(r.codigo, 0, r.todo);
    assert.match(r.stdout, /WORKER_HEARTBEAT_TOKEN \(copiado de la metadata de adaceen-worker-a100\)/);
    assert.match(r.stdout, new RegExp(`WORKER_HEARTBEAT_TOKEN\\s+Azure \\(sin valor\\)\\s+adaceen-worker-v100\\s+${huella(OTRO_LATIDO)}\\s+✗ distinta de la de adaceen-worker-a100`));
    assert.match(r.stdout, /✗ el heartbeat-token de adaceen-worker-v100 no es igual al de adaceen-worker-a100, que aplicar copia a Azure/);
    sinSecretos(p, r, [OTRO_LATIDO]);

    r = await correr(p, ["aplicar"], { env: { CONFIRMAR: "1" } });
    assert.equal(r.codigo, 1, r.todo);
    assert.equal(p.azure().WORKER_HEARTBEAT_TOKEN, SECRETOS.latido);
    assert.equal(p.vm("adaceen-worker-v100")["heartbeat-token"], OTRO_LATIDO);
    assert.match(r.stdout, /✗ el heartbeat-token de adaceen-worker-v100 no es igual a WORKER_HEARTBEAT_TOKEN de Azure/);
    assert.match(r.stdout, /aplicar termino con pendientes: heartbeat-token distinto en adaceen-worker-v100/);
    sinSecretos(p, r, [OTRO_LATIDO]);
  } finally {
    await p.cerrar();
  }
});

// Los comandos que produccion.sh manda por IAP (REMOTO_LOG, REMOTO_ARRANQUE y
// REMOTO_VERIFICAR) corren aqui con bash, como en la VM, con systemctl, journalctl,
// sudo, id, curl y google_metadata_script_runner falsos.
test("produccion.sh: lo que corre en la VM por IAP lee el ultimo arranque, el ultimo evento del relay y el bloqueo de la metadata", { skip: omitir || (hay("tac") ? false : "falta tac") }, () => {
  const dir = mkdtempSync(path.join(tmpdir(), "adaceen-remoto-"));
  try {
    const bin = path.join(dir, "bin");
    mkdirSync(bin);
    const falsos = {
      sudo: `if [ "$1" = -u ]; then printf '%s\\n' "$2" >>"$R/sudo-u"; shift 2; fi
if [ "$1" = tac ] && [ "$2" = /var/log/adaceen-ws-startup.log ]; then exec tac "$R/startup.log"; fi
exec "$@"`,
      systemctl: `[ "$1" = is-active ] || exit 2
if [ -f "$R/activo-$2" ]; then echo active; else echo inactive; exit 3; fi`,
      journalctl: `cat "$R/journal"`,
      id: `[ ! -f "$R/sin-nobody" ]`,
      curl: `exit "$(cat "$R/curl-codigo")"`,
      google_metadata_script_runner: `touch "$R/arranque"`,
    };
    for (const [nombre, cuerpo] of Object.entries(falsos)) {
      writeFileSync(path.join(bin, nombre), `#!/usr/bin/env bash\n${cuerpo}\n`);
      chmodSync(path.join(bin, nombre), 0o755);
    }
    const guion = readFileSync(path.join(RAIZ, "deploy/produccion.sh"), "utf8");
    const definiciones = guion.split("\n").filter((linea) => /^REMOTO_(LOG|ARRANQUE|VERIFICAR)=/.test(linea)).join("\n");
    assert.equal(definiciones.split("\n").length, 3);
    const comando = (nombre) => execFileSync("bash", ["-c", `${definiciones}\nprintf '%s' "$${nombre}"`]).toString();
    const enLaVm = (nombre) => execFileSync("bash", ["-c", comando(nombre)], {
      env: { PATH: `${bin}:${process.env.PATH}`, R: dir, LANG: "C.UTF-8" },
    }).toString();

    // Dos arranques en el log: solo cuentan las lineas --- y === del ultimo.
    writeFileSync(path.join(dir, "startup.log"), [
      "=== adaceen-ws startup 2026-09-25T09:00:00+00:00 ===",
      "--- PDC feat/workspace-tunnel @ 1111111",
      "=== listo. api=https://viejo idle=120min extension=/opt/adaceen/adaceen.vsix ===",
      "=== adaceen-ws startup 2026-09-26T10:00:00+00:00 ===",
      "Reading package lists...",
      `--- PDC ${RAMA} @ abc1234`,
      `--- VSIX adaceen ${VERSION_VSCODE} instalado en /opt/adaceen/adaceen.vsix (github vscode-ext-prod b21231e1723e)`,
      "=== listo. api=https://app idle=120min extension=/opt/adaceen/adaceen.vsix ===",
      "sin tuneles desde hace 120 min, apagando",
    ].join("\n") + "\n");
    const ultimoArranque = [
      "log==== adaceen-ws startup 2026-09-26T10:00:00+00:00 ===",
      `log=--- PDC ${RAMA} @ abc1234`,
      `log=--- VSIX adaceen ${VERSION_VSCODE} instalado en /opt/adaceen/adaceen.vsix (github vscode-ext-prod b21231e1723e)`,
      "log==== listo. api=https://app idle=120min extension=/opt/adaceen/adaceen.vsix ===",
    ].join("\n") + "\n";
    assert.equal(enLaVm("REMOTO_LOG"), ultimoArranque);
    assert.equal(enLaVm("REMOTO_ARRANQUE"), ultimoArranque);
    assert.ok(existsSync(path.join(dir, "arranque")), "REMOTO_ARRANQUE no corrio el startup-script");

    const journal = (...eventos) => writeFileSync(path.join(dir, "journal"),
      eventos.map((evento) => `sep 26 10:00:00 adaceen-ws node[1]: [agente] ${evento}\n`).join(""));
    const leer = (salida) => Object.fromEntries(salida.split("\n").filter((l) => !l.startsWith("log=") && l.includes("="))
      .map((l) => [l.slice(0, l.indexOf("=")), l.slice(l.indexOf("=") + 1)]));

    // Todo bien: servicios activos, conectado al relay, nobody recibe conexion rechazada (7).
    writeFileSync(path.join(dir, "activo-adaceen-ws-metadata"), "");
    writeFileSync(path.join(dir, "activo-adaceen-workspaces-agent"), "");
    journal("info relay activo relay=\"https://app/api/workspaces/agent\"",
      "aviso relay sin conexion; se reintenta error=\"fetch failed\"",
      "info conectado al relay relay=\"https://app/api/workspaces/agent\"");
    writeFileSync(path.join(dir, "curl-codigo"), "7");
    let salida = enLaVm("REMOTO_VERIFICAR");
    assert.deepEqual(leer(salida), { metadata: "active", agente: "active", relay: "conectado al relay", bloqueo: "7" });
    assert.ok(salida.endsWith(ultimoArranque));
    assert.equal(readFileSync(path.join(dir, "sudo-u"), "utf8"), "nobody\n");

    // Se conecto y despues perdio la conexion: el ultimo evento es «relay sin conexion».
    journal("info conectado al relay relay=\"https://app/api/workspaces/agent\"", "aviso relay sin conexion; se reintenta error=\"HTTP 503\"");
    writeFileSync(path.join(dir, "curl-codigo"), "0");
    rmSync(path.join(dir, "activo-adaceen-workspaces-agent"));
    salida = enLaVm("REMOTO_VERIFICAR");
    assert.deepEqual(leer(salida), { metadata: "active", agente: "inactive", relay: "relay sin conexion", bloqueo: "0" });

    // Token rechazado; sin usuario nobody no se prueba (y no cuenta como bloqueada).
    journal("error el relay rechazo el token: AGENT_TOKEN no coincide con WORKSPACE_AGENT_TOKEN de PDC");
    writeFileSync(path.join(dir, "sin-nobody"), "");
    salida = enLaVm("REMOTO_VERIFICAR");
    assert.deepEqual(leer(salida), { metadata: "active", agente: "inactive", relay: "el relay rechazo el token", bloqueo: "sin-prueba" });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ------------------------------------------------------------------ verificar
test("produccion.sh verificar: todo en verde despues de aplicar; en rojo si el relay rechaza el token", { skip: omitir }, async () => {
  const p = await preparar();
  try {
    let r = await correr(p, ["aplicar"], { env: { CONFIRMAR: "1" } });
    assert.equal(r.codigo, 0, r.todo);
    const antes = p.llamadas().length;
    r = await correr(p, ["verificar"]);
    assert.equal(r.codigo, 0, r.todo);
    for (const texto of [
      /✓ version nueva desplegada/,
      /✓ workspace_provider tunnel y workspace_agent_transport relay/,
      /✓ workspace_agent_online true/,
      /✓ \/empezar muestra «Empieza con ADACEEN»/,
      new RegExp(`✓ /empezar ofrece la extension de navegador ${VERSION_NAVEGADOR.replace(/\./g, "\\.")}`),
      /✓ \/descargas\/adaceen\.vsix: 200, con Content-Disposition: attachment/,
      /✓ una sola instancia del App Service \(1\)/,
      /✓ WORKSPACE_AGENT_TOKEN igual en Azure y en la metadata/,
      /✓ journal del agente: el ultimo evento del relay es «conectado al relay»/,
      /✓ la metadata esta bloqueada para quien no es root/,
      /✓ bash deploy\/clase\.sh estado: editor listo \(agente de adaceen-ws conectado\)/,
      /✓ adaceen-worker-v100: heartbeat-token igual a WORKER_HEARTBEAT_TOKEN/,
      /verificar: \d+ ✓, 0 ✗/,
    ]) {
      assert.match(r.stdout, texto);
    }
    // verificar no cambia nada: solo lee y entra por IAP a mirar.
    const deVerificar = p.llamadas().slice(antes);
    assert.match(deVerificar, /compute ssh adaceen-ws --zone=us-central1-a --project=adaceen-508504 --tunnel-through-iap --quiet --command=.*systemctl is-active adaceen-ws-metadata/);
    assert.match(deVerificar, /sudo -u nobody curl/);
    assert.doesNotMatch(deVerificar, MODIFICA_GCLOUD);
    assert.equal(p.cambiosAz().trim().split("\n").length, 3);
    sinSecretos(p, r);

    writeFileSync(path.join(p.falso, "ssh-verificar"), "metadata=active\nagente=active\nrelay=el relay rechazo el token\nbloqueo=0\n");
    writeFileSync(path.join(p.falso, "ssh-log"), `${LOG_ARRANQUE}log=--- AVISO: sin metadata workspace-agent-token; agente de entornos apagado\n`);
    r = await correr(p, ["verificar", "--sin-gpu"]);
    assert.equal(r.codigo, 1, r.todo);
    assert.match(r.stdout, /✗ journal del agente: «el relay rechazo el token»/);
    assert.match(r.stdout, /Azure y la VM tienen tokens distintos: bash deploy\/produccion\.sh aplicar/);
    assert.match(r.stdout, /✗ la metadata esta bloqueada/);
    assert.match(r.stdout, /fallo el add-metadata del token/);
    assert.doesNotMatch(r.stdout, /adaceen-worker-v100: heartbeat-token/);
    assert.match(r.stdout, /verificar: \d+ ✓, 3 ✗/);
    sinSecretos(p, r);

    // Un agente que se conecto y despues perdio la conexion no cuenta como conectado; sin
    // usuario nobody (o sin curl) el bloqueo de la metadata queda sin comprobar, no en verde.
    writeFileSync(path.join(p.falso, "ssh-verificar"), "metadata=active\nagente=active\nrelay=relay sin conexion\nbloqueo=sin-prueba\n");
    writeFileSync(path.join(p.falso, "ssh-log"), LOG_ARRANQUE);
    r = await correr(p, ["verificar", "--sin-gpu"]);
    assert.equal(r.codigo, 1, r.todo);
    assert.match(r.stdout, /✗ journal del agente: el ultimo evento del relay es «relay sin conexion; se reintenta»/);
    assert.doesNotMatch(r.stdout, /✓ la metadata esta bloqueada/);
    assert.match(r.stdout, /- la metadata esta bloqueada para quien no es root \(no pude probarlo con el usuario nobody: la VM no tiene el usuario nobody o curl/);
    assert.match(r.stdout, /verificar: \d+ ✓, 1 ✗, [1-9]\d* sin comprobar/);
    sinSecretos(p, r);
  } finally {
    await p.cerrar();
  }
});

test("produccion.sh verificar: compara el zip publicado con el que se arma desde ~/PDC", { skip: omitir || (hay("node") ? false : "falta node") }, async () => {
  const p = await preparar({ conExtension: true });
  try {
    execFileSync("node", ["scripts/empaquetar-extension.mjs"], { cwd: p.repo, stdio: "ignore" });
    const armado = path.join(p.repo, "dist", "extension", `adaceen-chromium-${VERSION_NAVEGADOR}.zip`);
    copyFileSync(armado, path.join(p.falso, "zip-publicado"));
    rmSync(path.join(p.repo, "dist"), { recursive: true });
    const sha = execFileSync("sha256sum", [path.join(p.falso, "zip-publicado")]).toString().slice(0, 64);
    let r = await correr(p, ["verificar", "--sin-vm", "--sin-gpu"]);
    assert.match(r.stdout, new RegExp(`✓ el zip publicado es el que sale de .* \\(SHA-256 ${sha}\\)`));
    sinSecretos(p, r);

    writeFileSync(path.join(p.falso, "zip-publicado"), "otro zip");
    r = await correr(p, ["verificar", "--sin-vm", "--sin-gpu"]);
    assert.match(r.stdout, /✗ el zip publicado es el que sale de/);
    assert.match(r.stdout, /el flujo empaqueto otro commit/);
    sinSecretos(p, r);
  } finally {
    await p.cerrar();
  }
});

test("produccion.sh verificar: con el backend anterior marca la version y /empezar en rojo", { skip: omitir }, async () => {
  const p = await preparar({ versionNueva: false });
  try {
    const r = await correr(p, ["verificar", "--sin-vm", "--sin-gpu"]);
    assert.equal(r.codigo, 1, r.todo);
    assert.match(r.stdout, /✗ version nueva desplegada/);
    assert.match(r.stdout, /✗ .*\/empezar responde/);
    assert.match(r.stdout, /✗ \/descargas\/adaceen-navegador\.zip: 404/);
    sinSecretos(p, r);
  } finally {
    await p.cerrar();
  }
});

test("produccion.sh: rechaza acciones y opciones desconocidas", { skip: omitir }, async () => {
  const p = await preparar();
  try {
    const r = await correr(p, ["desplegar"]);
    assert.equal(r.codigo, 1);
    assert.match(r.stderr, /opcion desconocida: desplegar/);
    const ayuda = await correr(p, ["--ayuda"]);
    assert.equal(ayuda.codigo, 0);
    assert.match(ayuda.stdout, /bash deploy\/produccion\.sh aplicar \[--sin-vm\] \[--sin-gpu\] \[--encender-vm\]/);
    // La ayuda lista los pasos de aplicar en el orden de la guia.
    const pasos = ["(1) comprueba", "(2) en UN solo cambio", "WORKSPACE_AGENT_TRANSPORT=relay", "(3) espera", "(4) vuelve a comprobar",
      "(5) pide confirmacion", "(6) guarda", "(7) pone en la metadata", "scan-worker-key", "(8) rota", "(9) corre el arranque", "(10) espera", "(11) actualizar-gpus.sh"];
    const texto = ayuda.stdout.replace(/\s+/g, " ");
    let desde = 0;
    for (const paso of pasos) {
      const donde = texto.indexOf(paso, desde);
      assert.ok(donde >= 0, `la ayuda no dice «${paso}» en su lugar`);
      desde = donde;
    }
    assert.equal(p.llamadas(), "");
    sinSecretos(p, r);
    sinSecretos(p, ayuda);
  } finally {
    await p.cerrar();
  }
});

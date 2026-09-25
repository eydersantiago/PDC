// Pruebas de los scripts de operacion de Google Cloud, sin Google Cloud:
//   - deploy/clase.sh (iniciar/terminar/estado) con un gcloud falso y un
//     backend HTTP local que imita /api/health y /api/agent/backend
//   - teardown.sh, clone-worker.sh, create-vm.sh, actualizar-gpus.sh y
//     crear-cuenta-autoencendido.sh con el mismo gcloud falso
//   - las funciones de startup-script.sh (cargado con source): cambio de rama
//     en un clon superficial y el chequeo de inactividad de la GPU
//   - el registro del ultimo trabajo del worker (QUEUE_WORKER_LAST_JOB_FILE),
//     del que depende ese chequeo
//   node --test deploy/gcp/operacion.test.mjs
import assert from "node:assert/strict";
import { spawn, execFileSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, statSync, utimesSync, writeFileSync } from "node:fs";
import fsp from "node:fs/promises";
import http from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const AQUI = path.dirname(fileURLToPath(import.meta.url));
const DEPLOY = path.resolve(AQUI, "..");
const CLASE = path.join(DEPLOY, "clase.sh");
const TEARDOWN = path.join(AQUI, "teardown.sh");
const CLONE = path.join(AQUI, "clone-worker.sh");
const CREATE = path.join(AQUI, "create-vm.sh");
const ACTUALIZAR = path.join(AQUI, "actualizar-gpus.sh");
const AUTOENCENDIDO = path.join(AQUI, "crear-cuenta-autoencendido.sh");
const STARTUP = path.join(AQUI, "startup-script.sh");
const WORKER = path.resolve(DEPLOY, "..", "scripts", "service-bus-ollama-worker.ts");

function hay(comando) {
  try {
    execFileSync("sh", ["-c", `command -v ${comando}`], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}
const FALTAN = ["bash", "python3", "curl", "sed", "awk", "git"].filter((comando) => !hay(comando));
const omitir = FALTAN.length ? `faltan ${FALTAN.join(", ")}` : false;

// gcloud falso: registra cada llamada en $FALSO/llamadas y responde con el
// estado de $FALSO/instancias ("nombre zona estado" por linea).
const GCLOUD_FALSO = `#!/usr/bin/env bash
F="$FALSO"
printf '%s\\n' "$*" >>"$F/llamadas"
valor() { local clave="$1" a; shift; for a in "$@"; do case "$a" in "$clave="*) printf '%s' "\${a#*=}"; return 0 ;; esac; done; }
copiar_meta() {
  local mff pares p
  mff="$(valor --metadata-from-file "$@")"
  [ -n "$mff" ] || return 0
  mkdir -p "$F/meta"
  IFS=',' read -ra pares <<<"$mff"
  for p in "\${pares[@]}"; do cp "\${p#*=}" "$F/meta/\${p%%=*}"; done
  valor --metadata "$@" >"$F/meta-en-linea" || true
}
poner_estado() { sed -i "s/^$1 \\([^ ]*\\) .*/$1 \\1 $2/" "$F/instancias"; }
case "$1 $2" in
  "config get-value") cat "$F/proyecto" 2>/dev/null; exit 0 ;;
esac
case "$1 $2 $3" in
  "compute instances list") cat "$F/instancias"; exit 0 ;;
  "compute instances start" | "compute instances resume")
    if [ -f "$F/falla-$4" ]; then cat "$F/falla-$4" >&2; exit 1; fi
    poner_estado "$4" RUNNING; exit 0 ;;
  "compute instances stop") poner_estado "$4" TERMINATED; exit 0 ;;
  "compute instances delete") sed -i "/^$4 /d" "$F/instancias"; exit 0 ;;
  "compute instances describe")
    if [ "$(valor --format "$@")" = json ]; then cat "$F/describe-$4.json"; else awk -v n="$4" '$1 == n {print $3}' "$F/instancias"; fi
    exit 0 ;;
  "compute instances create") copiar_meta "$@"; echo "$4 $(valor --zone "$@") RUNNING" >>"$F/instancias"; exit 0 ;;
  "compute instances add-metadata") copiar_meta "$@"; mv "$F/meta" "$F/meta-$4"; [ -f "$F/meta-en-linea" ] && mv "$F/meta-en-linea" "$F/meta-en-linea-$4"; exit 0 ;;
  "compute instances add-iam-policy-binding" | "compute instances remove-iam-policy-binding") echo "bindings: []"; exit 0 ;;
  "compute routers describe") [ -f "$F/router" ]; exit ;;
  "compute routers create") touch "$F/router"; exit 0 ;;
  "compute routers delete") rm -f "$F/router"; exit 0 ;;
  "compute routers nats")
    case "$4" in describe) [ -f "$F/nat" ]; exit ;; create) touch "$F/nat"; exit 0 ;; delete) rm -f "$F/nat"; exit 0 ;; esac ;;
  "compute snapshots describe") exit 0 ;;
  "compute disks list" | "compute snapshots list" | "compute routers list") exit 0 ;;
  "compute regions describe") echo '{"quotas": []}'; exit 0 ;;
  "iam roles describe") if [ -f "$F/rol" ]; then echo False; exit 0; fi; exit 1 ;;
  "iam roles create") touch "$F/rol"; exit 0 ;;
  "iam roles update" | "iam roles undelete") exit 0 ;;
  "iam roles delete") rm -f "$F/rol"; exit 0 ;;
  "iam service-accounts describe") [ -f "$F/cuenta" ]; exit ;;
  "iam service-accounts create") touch "$F/cuenta"; exit 0 ;;
  "iam service-accounts delete") rm -f "$F/cuenta"; exit 0 ;;
  "iam service-accounts keys")
    case "$4" in
      list) cat "$F/claves" 2>/dev/null; exit 0 ;;
      create)
        if [ -f "$F/falla-clave" ]; then cat "$F/falla-clave" >&2; exit 1; fi
        printf '%s' '{"type":"service_account","private_key_id":"abc123","private_key":"-----BEGIN PRIVATE KEY-----\\nSECRETO-DE-PRUEBA\\n-----END PRIVATE KEY-----\\n","client_email":"adaceen-autoencendido@p.iam.gserviceaccount.com"}' >"$5"
        exit 0 ;;
    esac ;;
esac
echo "gcloud falso: llamada no esperada: $*" >&2
exit 2
`;

// az falso: guarda sus argumentos (para comprobar la clave) y no imprime nada.
const AZ_FALSO = `#!/usr/bin/env bash
printf '%s\\n' "$@" >"$FALSO/az-args"
exit 0
`;

function preparar({ instancias = [], proyecto = "proyecto-prueba", conAz = false } = {}) {
  const dir = mkdtempSync(path.join(tmpdir(), "adaceen-gcp-"));
  const falso = path.join(dir, "falso");
  const bin = path.join(dir, "bin");
  const casa = path.join(dir, "casa");
  mkdirSync(falso);
  mkdirSync(bin);
  mkdirSync(casa);
  writeFileSync(path.join(bin, "gcloud"), GCLOUD_FALSO);
  chmodSync(path.join(bin, "gcloud"), 0o755);
  if (conAz) {
    writeFileSync(path.join(bin, "az"), AZ_FALSO);
    chmodSync(path.join(bin, "az"), 0o755);
  }
  writeFileSync(path.join(falso, "proyecto"), `${proyecto}\n`);
  writeFileSync(path.join(falso, "instancias"), instancias.map((linea) => `${linea}\n`).join(""));
  writeFileSync(path.join(falso, "llamadas"), "");
  // Sin proxies: el backend de prueba escucha en 127.0.0.1.
  const env = { PATH: `${bin}:${process.env.PATH}`, HOME: casa, FALSO: falso, LANG: "C.UTF-8", TMPDIR: dir };
  return {
    dir,
    falso,
    casa,
    env,
    llamadas: () => readFileSync(path.join(falso, "llamadas"), "utf8"),
    instancias: () => readFileSync(path.join(falso, "instancias"), "utf8"),
  };
}

function correr(comando, argumentos, { env, entrada = "", cwd = "/" } = {}) {
  return new Promise((resolve) => {
    const hijo = spawn(comando, argumentos, { env, cwd, stdio: ["pipe", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    hijo.stdout.on("data", (dato) => { stdout += dato; });
    hijo.stderr.on("data", (dato) => { stderr += dato; });
    const reloj = setTimeout(() => hijo.kill("SIGKILL"), 60000);
    hijo.on("close", (codigo) => {
      clearTimeout(reloj);
      resolve({ codigo, stdout, stderr, todo: stdout + stderr });
    });
    hijo.stdin.end(entrada);
  });
}

// Backend de prueba: responde /api/health y /api/agent/backend con lo que diga
// `estado(n)`, donde n es cuantas veces se pidio /api/health.
async function backend(estado) {
  let consultas = 0;
  const servidor = http.createServer((req, res) => {
    if (req.url === "/api/health") consultas += 1;
    const actual = estado(consultas);
    const cuerpo = req.url === "/api/health" ? actual.salud : req.url === "/api/agent/backend" ? actual.servidores : null;
    if (!cuerpo) {
      res.writeHead(404).end();
      return;
    }
    res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify(cuerpo));
  });
  await new Promise((resolve) => servidor.listen(0, "127.0.0.1", resolve));
  return {
    url: `http://127.0.0.1:${servidor.address().port}`,
    consultas: () => consultas,
    cerrar: () => new Promise((resolve) => servidor.close(resolve)),
  };
}

const salud = (extra = {}) => ({
  ok: true,
  mode: "queue",
  workspace_provider: "tunnel",
  workspace_agent_online: false,
  workspace_agent_transport: "relay",
  worker_heartbeat_configured: true,
  model_workers_alive: 0,
  ...extra,
});
const gpuViva = { listening: [{ id: "gce-v100", provider: "gcp", alive: true }], alive_workers: 1 };
const nadie = { listening: [], alive_workers: 0 };
const listo = { salud: salud({ workspace_agent_online: true, model_workers_alive: 1 }), servidores: gpuViva };

const TODO_APAGADO = [
  "adaceen-worker-v100 us-central1-b TERMINATED",
  "adaceen-worker-a100 us-central1-c TERMINATED",
  "adaceen-worker us-central1-a TERMINATED",
  "adaceen-ws us-central1-a TERMINATED",
];

// ------------------------------------------------------------------ clase.sh
test("clase.sh estado: muestra VMs, servicio y enlace sin encender ni apagar nada", { skip: omitir }, async () => {
  const p = preparar({ instancias: TODO_APAGADO });
  const api = await backend(() => ({ salud: salud(), servidores: nadie }));
  try {
    const r = await correr("bash", [CLASE, "estado"], { env: { ...p.env, BACKEND: api.url } });
    assert.equal(r.codigo, 0, r.todo);
    assert.match(r.todo, /GPU adaceen-worker-v100 \(us-central1-b\): TERMINATED/);
    assert.match(r.todo, /VM de editores adaceen-ws \(us-central1-a\): TERMINATED/);
    assert.match(r.todo, /no esta listo/);
    assert.match(r.todo, new RegExp(`enlace para estudiantes: ${api.url}/empezar`));
    assert.doesNotMatch(p.llamadas(), / (start|stop|resume|delete) /);
  } finally {
    await api.cerrar();
  }
});

test("clase.sh iniciar: enciende solo la primera GPU y la VM de editores, espera y da el enlace", { skip: omitir }, async () => {
  const p = preparar({ instancias: TODO_APAGADO });
  // Listo a partir de la tercera consulta: el script tiene que esperar.
  const api = await backend((n) => (n >= 3 ? listo : { salud: salud(), servidores: nadie }));
  try {
    const r = await correr("bash", [CLASE, "iniciar"], { env: { ...p.env, BACKEND: api.url, INTERVALO: "0.1", ESPERA_MAX: "30" } });
    assert.equal(r.codigo, 0, r.todo);
    const llamadas = p.llamadas();
    assert.match(llamadas, /compute instances start adaceen-worker-v100 --zone=us-central1-b --project=proyecto-prueba/);
    assert.match(llamadas, /compute instances start adaceen-ws --zone=us-central1-a/);
    assert.doesNotMatch(llamadas, /start adaceen-worker-a100/);
    assert.doesNotMatch(llamadas, /start adaceen-worker /);
    assert.ok(api.consultas() >= 3);
    assert.match(r.stdout, new RegExp(`\\n    ${api.url}/empezar\\n`));
    assert.match(r.todo, /clase lista/);
  } finally {
    await api.cerrar();
  }
});

test("clase.sh iniciar: idempotente, no toca lo que ya esta encendido", { skip: omitir }, async () => {
  const p = preparar({
    instancias: [
      "adaceen-worker-v100 us-central1-b TERMINATED",
      "adaceen-worker-a100 us-central1-c RUNNING",
      "adaceen-worker us-central1-a TERMINATED",
      "adaceen-ws us-central1-a RUNNING",
    ],
  });
  const api = await backend(() => listo);
  try {
    const r = await correr("bash", [CLASE, "iniciar"], { env: { ...p.env, BACKEND: api.url, INTERVALO: "0.1" } });
    assert.equal(r.codigo, 0, r.todo);
    assert.doesNotMatch(p.llamadas(), / start /);
    assert.match(r.todo, /GPU adaceen-worker-a100 ya encendida/);
  } finally {
    await api.cerrar();
  }
});

test("clase.sh iniciar: si la V100 no tiene cuota sigue con la A100 y no enciende la L4", { skip: omitir }, async () => {
  const p = preparar({ instancias: TODO_APAGADO });
  writeFileSync(path.join(p.falso, "falla-adaceen-worker-v100"),
    "ERROR: (gcloud.compute.instances.start) Could not fetch resource:\n - Quota 'GPUS_ALL_REGIONS' exceeded.  Limit: 1.0 globally.\n");
  const api = await backend(() => listo);
  try {
    const r = await correr("bash", [CLASE, "iniciar"], { env: { ...p.env, BACKEND: api.url, INTERVALO: "0.1" } });
    assert.equal(r.codigo, 0, r.todo);
    const llamadas = p.llamadas();
    assert.match(llamadas, /start adaceen-worker-v100/);
    assert.match(llamadas, /start adaceen-worker-a100/);
    assert.doesNotMatch(llamadas, /start adaceen-worker /);
    assert.match(r.stderr, /adaceen-worker-v100 no encendio: sin cuota de GPU/);
  } finally {
    await api.cerrar();
  }
});

test("clase.sh iniciar: con el proveedor codespaces no enciende la VM de editores", { skip: omitir }, async () => {
  const p = preparar({ instancias: TODO_APAGADO });
  const api = await backend(() => ({ salud: salud({ workspace_provider: "codespaces", model_workers_alive: 1 }), servidores: gpuViva }));
  try {
    const r = await correr("bash", [CLASE, "iniciar"], { env: { ...p.env, BACKEND: api.url, INTERVALO: "0.1" } });
    assert.equal(r.codigo, 0, r.todo);
    assert.doesNotMatch(p.llamadas(), /start adaceen-ws/);
    assert.match(r.todo, /no hace falta \(proveedor codespaces\)/);
  } finally {
    await api.cerrar();
  }
});

test("clase.sh iniciar: sin ningun servidor del modelo agota la espera y sale con error claro", { skip: omitir }, async () => {
  const p = preparar({ instancias: TODO_APAGADO });
  const api = await backend(() => ({ salud: salud({ workspace_agent_online: true }), servidores: nadie }));
  try {
    const r = await correr("bash", [CLASE, "iniciar"], { env: { ...p.env, BACKEND: api.url, INTERVALO: "0.2", ESPERA_MAX: "1" } });
    assert.equal(r.codigo, 1, r.todo);
    assert.match(r.stderr, /modelo no listo: ningun servidor del modelo manda latido/);
    assert.doesNotMatch(r.stdout, /clase lista/);
  } finally {
    await api.cerrar();
  }
});

test("clase.sh iniciar: si solo falta la GPU pero atiende una Mac, termina con aviso", { skip: omitir }, async () => {
  const p = preparar({ instancias: TODO_APAGADO });
  const mac = { listening: [{ id: "mac-lab07-m2", provider: "mac", alive: true }], alive_workers: 1 };
  const api = await backend(() => ({ salud: salud({ workspace_agent_online: true, model_workers_alive: 1 }), servidores: mac }));
  try {
    const r = await correr("bash", [CLASE, "iniciar"], { env: { ...p.env, BACKEND: api.url, INTERVALO: "0.2", ESPERA_MAX: "1" } });
    assert.equal(r.codigo, 0, r.todo);
    assert.match(r.stderr, /la GPU no mando latido .* ya atienden: mac-lab07-m2/);
    assert.match(r.stdout, /\/empezar/);
  } finally {
    await api.cerrar();
  }
});

test("clase.sh iniciar: con un backend anterior (sin model_workers_alive) cuenta los servidores de /api/agent/backend", { skip: omitir }, async () => {
  const p = preparar({ instancias: ["adaceen-worker-v100 us-central1-b RUNNING", "adaceen-ws us-central1-a RUNNING"] });
  const anterior = salud({ workspace_agent_online: true });
  delete anterior.model_workers_alive;
  delete anterior.workspace_agent_transport;
  const api = await backend(() => ({ salud: anterior, servidores: gpuViva }));
  try {
    const r = await correr("bash", [CLASE, "iniciar"], { env: { ...p.env, BACKEND: api.url, INTERVALO: "0.1", ESPERA_MAX: "5" } });
    assert.equal(r.codigo, 0, r.todo);
    assert.match(r.todo, /modelo: 1 servidor\(es\) vivo\(s\): gce-v100/);
  } finally {
    await api.cerrar();
  }
});

test("clase.sh estado: con el proveedor tunnel avisa si la VM de editores no existe en el proyecto", { skip: omitir }, async () => {
  const p = preparar({ instancias: ["adaceen-worker us-central1-a TERMINATED"] });
  const api = await backend(() => ({ salud: salud({ model_workers_alive: 1 }), servidores: gpuViva }));
  try {
    const r = await correr("bash", [CLASE, "estado"], { env: { ...p.env, BACKEND: api.url } });
    assert.equal(r.codigo, 0, r.todo);
    assert.match(r.stderr, /editor: no encuentro la VM adaceen-ws en proyecto-prueba \(usa PROYECTO=<proyecto> o VM_EDITORES=<vm>\)/);
  } finally {
    await api.cerrar();
  }
});

test("clase.sh iniciar: si el proyecto no tiene ninguna de las VMs falla enseguida y dice como elegir el proyecto", { skip: omitir }, async () => {
  const p = preparar({ instancias: ["otra-vm us-central1-a RUNNING"], proyecto: "otro-proyecto" });
  const api = await backend(() => ({ salud: salud(), servidores: nadie }));
  try {
    const inicio = Date.now();
    // ESPERA_MAX por defecto (900 s): no debe esperar.
    const r = await correr("bash", [CLASE, "iniciar"], { env: { ...p.env, BACKEND: api.url, INTERVALO: "0.1" } });
    assert.equal(r.codigo, 1, r.todo);
    assert.ok(Date.now() - inicio < 20000, "no espero");
    assert.match(r.stderr, /no encuentro ninguna de las VMs \(adaceen-worker-v100 adaceen-worker-a100 adaceen-worker adaceen-ws\) en el proyecto otro-proyecto/);
    assert.match(r.stderr, /PROYECTO=adaceen-508504 bash deploy\/clase\.sh iniciar/);
    assert.doesNotMatch(p.llamadas(), / start /);
  } finally {
    await api.cerrar();
  }
});

test("clase.sh iniciar: con el proveedor tunnel y sin la VM de editores en el proyecto no espera en vano", { skip: omitir }, async () => {
  const p = preparar({ instancias: ["adaceen-worker-v100 us-central1-b RUNNING"] });
  const api = await backend(() => ({ salud: salud({ model_workers_alive: 1 }), servidores: gpuViva }));
  try {
    const inicio = Date.now();
    const r = await correr("bash", [CLASE, "iniciar"], { env: { ...p.env, BACKEND: api.url, INTERVALO: "0.1" } });
    assert.equal(r.codigo, 1, r.todo);
    assert.ok(Date.now() - inicio < 20000, "no espero");
    assert.match(r.stderr, /editor no listo: no encuentro la VM adaceen-ws en proyecto-prueba/);
  } finally {
    await api.cerrar();
  }
});

test("clase.sh terminar: apaga las GPU encendidas y la VM de editores, y deja las apagadas", { skip: omitir }, async () => {
  const p = preparar({
    instancias: [
      "adaceen-worker-v100 us-central1-b RUNNING",
      "adaceen-worker-a100 us-central1-c TERMINATED",
      "adaceen-ws us-central1-a RUNNING",
    ],
  });
  const r = await correr("bash", [CLASE, "terminar"], { env: p.env });
  assert.equal(r.codigo, 0, r.todo);
  const llamadas = p.llamadas();
  assert.match(llamadas, /compute instances stop adaceen-worker-v100 --zone=us-central1-b --project=proyecto-prueba --async/);
  assert.match(llamadas, /compute instances stop adaceen-ws --zone=us-central1-a/);
  assert.doesNotMatch(llamadas, /stop adaceen-worker-a100/);
  assert.doesNotMatch(p.instancias(), /RUNNING/);
  assert.match(r.todo, /adaceen-worker-a100 ya estaba apagada/);
});

test("clase.sh: accion desconocida y BACKEND invalido fallan sin tocar nada", { skip: omitir }, async () => {
  const p = preparar({ instancias: TODO_APAGADO });
  const r1 = await correr("bash", [CLASE, "encender"], { env: p.env });
  assert.equal(r1.codigo, 1);
  const r2 = await correr("bash", [CLASE, "iniciar"], { env: { ...p.env, BACKEND: "javascript:alert(1)" } });
  assert.equal(r2.codigo, 1);
  assert.match(r2.stderr, /BACKEND no es una URL valida/);
  assert.equal(p.llamadas().includes(" start "), false);
});

// ------------------------------------------------------------------ teardown.sh
test("teardown.sh stop: apaga todas las GPU de la lista, cada una en su zona", { skip: omitir }, async () => {
  const p = preparar({
    instancias: ["adaceen-worker-v100 us-central1-b RUNNING", "adaceen-worker us-central1-a RUNNING", "adaceen-ws us-central1-a RUNNING"],
  });
  const r = await correr("bash", [TEARDOWN, "stop"], { env: p.env });
  assert.equal(r.codigo, 0, r.todo);
  assert.match(p.llamadas(), /stop adaceen-worker-v100 --zone=us-central1-b/);
  assert.match(p.llamadas(), /stop adaceen-worker --zone=us-central1-a/);
  assert.doesNotMatch(p.llamadas(), /stop adaceen-ws/);
});

test("teardown.sh destroy: sin confirmar no borra nada", { skip: omitir }, async () => {
  const p = preparar({ instancias: ["adaceen-worker us-central1-a TERMINATED"] });
  const r = await correr("bash", [TEARDOWN, "destroy"], { env: p.env });
  assert.equal(r.codigo, 1, r.todo);
  assert.match(r.stderr, /CONFIRMAR=1/);
  assert.doesNotMatch(p.llamadas(), /delete/);
});

test("teardown.sh destroy: borra las GPU pero conserva el NAT si la VM de editores lo usa", { skip: omitir }, async () => {
  const p = preparar({
    instancias: ["adaceen-worker-v100 us-central1-b TERMINATED", "adaceen-worker us-central1-a RUNNING", "adaceen-ws us-central1-a TERMINATED"],
  });
  writeFileSync(path.join(p.falso, "router"), "");
  writeFileSync(path.join(p.falso, "nat"), "");
  const r = await correr("bash", [TEARDOWN, "destroy"], { env: { ...p.env, CONFIRMAR: "1" } });
  assert.equal(r.codigo, 0, r.todo);
  assert.match(p.llamadas(), /instances delete adaceen-worker-v100 --zone=us-central1-b/);
  assert.match(p.llamadas(), /instances delete adaceen-worker --zone=us-central1-a/);
  assert.doesNotMatch(p.llamadas(), /routers nats delete|routers delete/);
  assert.match(r.todo, /se conservan el NAT adaceen-nat y el router adaceen-router: los usa adaceen-ws/);
  assert.match(r.todo, /incluye la L4, adaceen-worker: su disco es el origen de clone-worker\.sh/);
  assert.equal(p.instancias().trim(), "adaceen-ws us-central1-a TERMINATED");
});

test("teardown.sh destroy: sin otras VMs en la region borra tambien NAT y router", { skip: omitir }, async () => {
  const p = preparar({ instancias: ["adaceen-worker us-central1-a TERMINATED", "otra-vm europe-west1-b RUNNING"] });
  writeFileSync(path.join(p.falso, "router"), "");
  writeFileSync(path.join(p.falso, "nat"), "");
  const r = await correr("bash", [TEARDOWN, "destroy"], { env: { ...p.env, CONFIRMAR: "1" } });
  assert.equal(r.codigo, 0, r.todo);
  assert.match(p.llamadas(), /routers nats delete adaceen-nat --router=adaceen-router --region=us-central1/);
  assert.equal(existsSync(path.join(p.falso, "nat")), false);
});

// ------------------------------------------------------------------ clone-worker.sh
test("clone-worker.sh: copia toda la metadata (con el latido) sin mostrar secretos y funciona fuera de su carpeta", { skip: omitir }, async () => {
  const p = preparar({ instancias: ["adaceen-worker us-central1-a TERMINATED"] });
  const items = {
    "startup-script": "#!/bin/bash\necho viejo\n",
    "sb-conn": "Endpoint=sb://x.servicebus.windows.net/;SharedAccessKeyName=colab-worker;SharedAccessKey=SECRETO1=",
    "worker-secret": "SECRETO2",
    "heartbeat-url": "https://app.example/api/agent/heartbeat",
    "heartbeat-token": "SECRETO3",
    branch: "feature/azure-config-observability",
    "model-text": "qwen2.5-coder:14b",
    "worker-id": "gce-l4",
    "idle-minutes": "30",
  };
  writeFileSync(path.join(p.falso, "describe-adaceen-worker.json"), JSON.stringify({
    metadata: { items: Object.entries(items).map(([key, value]) => ({ key, value })) },
  }));
  const r = await correr("bash", [CLONE, "v100"], { env: p.env, cwd: "/" });
  assert.equal(r.codigo, 0, r.todo);
  const meta = (clave) => readFileSync(path.join(p.falso, "meta", clave), "utf8");
  assert.equal(meta("heartbeat-token"), "SECRETO3");
  assert.equal(meta("heartbeat-url"), items["heartbeat-url"]);
  assert.equal(meta("sb-conn"), items["sb-conn"]);
  assert.equal(meta("branch"), items.branch);
  assert.equal(meta("worker-id"), "gce-v100");
  assert.equal(meta("idle-minutes"), "180");
  assert.equal(meta("startup-script"), readFileSync(STARTUP, "utf8"));
  assert.match(p.llamadas(), /instances create adaceen-worker-v100 --project=proyecto-prueba --zone=us-central1-a .*--no-address/);
  for (const secreto of ["SECRETO1", "SECRETO2", "SECRETO3"]) {
    assert.equal(r.todo.includes(secreto), false, `${secreto} en la salida`);
    assert.equal(p.llamadas().includes(secreto), false, `${secreto} en la linea de comandos`);
  }
});

test("clone-worker.sh: si la copia ya existe (en cualquier zona) no crea otra", { skip: omitir }, async () => {
  const p = preparar({ instancias: ["adaceen-worker us-central1-a TERMINATED", "adaceen-worker-v100 us-central1-c TERMINATED"] });
  const r = await correr("bash", [CLONE, "v100"], { env: p.env });
  assert.equal(r.codigo, 1, r.todo);
  assert.match(r.stderr, /ya existe adaceen-worker-v100 en us-central1-c: no creo otra/);
  assert.doesNotMatch(p.llamadas(), /instances create|snapshots create/);
});

test("clase.sh estado: avisa si una VM esta repetida en dos zonas", { skip: omitir }, async () => {
  const p = preparar({ instancias: [...TODO_APAGADO, "adaceen-worker-v100 us-central1-a TERMINATED"] });
  const api = await backend(() => ({ salud: salud(), servidores: nadie }));
  try {
    const r = await correr("bash", [CLASE, "estado"], { env: { ...p.env, BACKEND: api.url } });
    assert.equal(r.codigo, 0, r.todo);
    assert.match(r.stderr, /mismo nombre en varias zonas: adaceen-worker-v100 \(us-central1-b us-central1-a\)/);
  } finally {
    await api.cerrar();
  }
});

// ------------------------------------------------------------------ create-vm.sh
test("create-vm.sh: desde cualquier carpeta, sin IP publica, crea el NAT si falta y pasa secretos por archivo", { skip: omitir }, async () => {
  const p = preparar();
  const env = { ...p.env, SB_CONN: "Endpoint=sb://x/;SharedAccessKeyName=k;SharedAccessKey=SECRETO1", WORKER_SECRET: "SECRETO2", HEARTBEAT_TOKEN: "SECRETO3", API_URL: "https://api.example" };
  const r = await correr("bash", [CREATE, "l4"], { env, cwd: "/" });
  assert.equal(r.codigo, 0, r.todo);
  const llamadas = p.llamadas();
  assert.match(llamadas, /routers create adaceen-router --network=default --region=us-central1/);
  assert.match(llamadas, /routers nats create adaceen-nat --router=adaceen-router --region=us-central1/);
  assert.match(llamadas, /instances create adaceen-worker .*--no-address/);
  assert.match(llamadas, /--accelerator=type=nvidia-l4,count=1/);
  const meta = (clave) => readFileSync(path.join(p.falso, "meta", clave), "utf8");
  assert.equal(meta("startup-script"), readFileSync(STARTUP, "utf8"));
  assert.equal(meta("sb-conn"), env.SB_CONN);
  assert.equal(meta("heartbeat-token"), "SECRETO3");
  assert.equal(meta("heartbeat-url"), "https://api.example/api/agent/heartbeat");
  assert.equal(meta("branch"), "feature/azure-config-observability");
  assert.equal(meta("worker-id"), "gce-l4");
  for (const secreto of ["SECRETO1", "SECRETO2", "SECRETO3"]) {
    assert.equal(r.todo.includes(secreto), false, `${secreto} en la salida`);
    assert.equal(llamadas.includes(secreto), false, `${secreto} en la linea de comandos`);
  }
});

test("create-vm.sh: con CON_IP=1 no pide --no-address ni toca el NAT", { skip: omitir }, async () => {
  const p = preparar();
  const env = { ...p.env, SB_CONN: "Endpoint=sb://x/;SharedAccessKeyName=k;SharedAccessKey=abc", WORKER_SECRET: "", HEARTBEAT_TOKEN: "", CON_IP: "1" };
  const r = await correr("bash", [CREATE, "cpu"], { env });
  assert.equal(r.codigo, 0, r.todo);
  assert.doesNotMatch(p.llamadas(), /--no-address|routers/);
  assert.match(r.stderr, /sin WORKER_HEARTBEAT_TOKEN/);
});

// ------------------------------------------------------------------ actualizar-gpus.sh
test("actualizar-gpus.sh: sube el startup-script (y la rama) a cada GPU que existe", { skip: omitir }, async () => {
  const p = preparar({ instancias: ["adaceen-worker-v100 us-central1-b TERMINATED", "adaceen-worker us-central1-a RUNNING"] });
  const r = await correr("bash", [ACTUALIZAR], { env: { ...p.env, RAMA: "feature/azure-config-observability" } });
  assert.equal(r.codigo, 0, r.todo);
  for (const vm of ["adaceen-worker-v100", "adaceen-worker"]) {
    assert.equal(readFileSync(path.join(p.falso, `meta-${vm}`, "startup-script"), "utf8"), readFileSync(STARTUP, "utf8"));
    assert.equal(readFileSync(path.join(p.falso, `meta-en-linea-${vm}`), "utf8"), "branch=feature/azure-config-observability");
  }
  assert.match(r.todo, /no existe la VM adaceen-worker-a100/);
  assert.match(r.todo, /2 VM\(s\) actualizadas/);
});

test("actualizar-gpus.sh: a una copia sin latido le copia heartbeat-url/token de otra GPU sin mostrarlos", { skip: omitir }, async () => {
  const p = preparar({ instancias: ["adaceen-worker-v100 us-central1-b TERMINATED", "adaceen-worker us-central1-a TERMINATED"] });
  const metadata = (items) => JSON.stringify({ metadata: { items: Object.entries(items).map(([key, value]) => ({ key, value })) } });
  writeFileSync(path.join(p.falso, "describe-adaceen-worker.json"),
    metadata({ "sb-conn": "x", "heartbeat-url": "https://api.example/api/agent/heartbeat", "heartbeat-token": "TOKEN-LATIDO" }));
  writeFileSync(path.join(p.falso, "describe-adaceen-worker-v100.json"), metadata({ "sb-conn": "x", "worker-id": "gce-v100" }));
  const r = await correr("bash", [ACTUALIZAR], { env: p.env });
  assert.equal(r.codigo, 0, r.todo);
  assert.equal(readFileSync(path.join(p.falso, "meta-adaceen-worker-v100", "heartbeat-token"), "utf8"), "TOKEN-LATIDO");
  assert.equal(readFileSync(path.join(p.falso, "meta-adaceen-worker-v100", "heartbeat-url"), "utf8"), "https://api.example/api/agent/heartbeat");
  // A la que ya lo tiene no se le reescribe.
  assert.equal(existsSync(path.join(p.falso, "meta-adaceen-worker", "heartbeat-token")), false);
  assert.match(r.todo, /adaceen-worker-v100 \(us-central1-b\): startup-script al dia, [^\n]*, latido copiado de adaceen-worker\n/);
  assert.equal(r.todo.includes("TOKEN-LATIDO"), false);
  assert.equal(p.llamadas().includes("TOKEN-LATIDO"), false);
});

test("actualizar-gpus.sh: a una copia sin metadata branch le copia la rama de la L4 y muestra la de cada VM", { skip: omitir }, async () => {
  const p = preparar({ instancias: ["adaceen-worker-v100 us-central1-b TERMINATED", "adaceen-worker us-central1-a TERMINATED"] });
  const metadata = (items) => JSON.stringify({ metadata: { items: Object.entries(items).map(([key, value]) => ({ key, value })) } });
  writeFileSync(path.join(p.falso, "describe-adaceen-worker.json"),
    metadata({ "sb-conn": "x", "heartbeat-url": "https://api.example/api/agent/heartbeat", "heartbeat-token": "T", branch: "feat/con-latido" }));
  // Copia hecha con el clone-worker.sh anterior: sin branch ni latido.
  writeFileSync(path.join(p.falso, "describe-adaceen-worker-v100.json"), metadata({ "sb-conn": "x", "worker-id": "gce-v100" }));
  const r = await correr("bash", [ACTUALIZAR], { env: p.env });
  assert.equal(r.codigo, 0, r.todo);
  assert.equal(readFileSync(path.join(p.falso, "meta-adaceen-worker-v100", "branch"), "utf8"), "feat/con-latido");
  // A la L4, que ya la tiene, no se le reescribe.
  assert.equal(existsSync(path.join(p.falso, "meta-adaceen-worker", "branch")), false);
  assert.match(r.todo, /adaceen-worker-v100 \(us-central1-b\): startup-script al dia, rama feat\/con-latido \(copiada de adaceen-worker\), latido copiado/);
  assert.match(r.todo, /adaceen-worker \(us-central1-a\): startup-script al dia, rama feat\/con-latido\n/);
});

test("actualizar-gpus.sh: si ninguna GPU tiene metadata branch avisa que siguen en la rama de su clon", { skip: omitir }, async () => {
  const p = preparar({ instancias: ["adaceen-worker-v100 us-central1-b TERMINATED"] });
  writeFileSync(path.join(p.falso, "describe-adaceen-worker-v100.json"), JSON.stringify({ metadata: { items: [{ key: "sb-conn", value: "x" }] } }));
  const r = await correr("bash", [ACTUALIZAR], { env: p.env });
  assert.equal(r.codigo, 0, r.todo);
  assert.equal(existsSync(path.join(p.falso, "meta-adaceen-worker-v100", "branch")), false);
  assert.equal(existsSync(path.join(p.falso, "meta-en-linea-adaceen-worker-v100")) && readFileSync(path.join(p.falso, "meta-en-linea-adaceen-worker-v100"), "utf8").includes("branch"), false);
  assert.match(r.stderr, /adaceen-worker-v100 no tiene metadata branch .* arrancara con la rama de su clon/);
  assert.match(r.todo, /sin metadata branch: sigue en la rama que ya tiene su clon/);
});

// ------------------------------------------------------------------ crear-cuenta-autoencendido.sh
test("crear-cuenta-autoencendido.sh: rol minimo sobre la VM, clave 600 y comando de Azure sin mostrar la clave", { skip: omitir }, async () => {
  const p = preparar({ instancias: ["adaceen-ws us-central1-a TERMINATED"] });
  const carpeta = path.join(p.casa, "claves");
  const r = await correr("bash", [AUTOENCENDIDO], { env: { ...p.env, CARPETA_CLAVE: carpeta } });
  assert.equal(r.codigo, 0, r.todo);
  const llamadas = p.llamadas();
  assert.match(llamadas, /iam roles create adaceenAutoencendido --project=proyecto-prueba .*--permissions=compute\.instances\.get,compute\.instances\.start /);
  assert.match(llamadas, /iam service-accounts create adaceen-autoencendido --project=proyecto-prueba/);
  assert.match(llamadas, /compute instances add-iam-policy-binding adaceen-ws --zone=us-central1-a --project=proyecto-prueba --member=serviceAccount:adaceen-autoencendido@proyecto-prueba\.iam\.gserviceaccount\.com --role=projects\/proyecto-prueba\/roles\/adaceenAutoencendido/);
  // Nada a nivel de proyecto.
  assert.doesNotMatch(llamadas, /projects add-iam-policy-binding/);
  const [archivo] = execFileSync("sh", ["-c", `ls ${carpeta}/clave-*.json`]).toString().trim().split("\n");
  assert.equal(statSync(archivo).mode & 0o777, 0o600);
  assert.equal(statSync(carpeta).mode & 0o777, 0o700);
  for (const texto of ["az webapp config appsettings set", "--output none", "WORKSPACE_VM_AUTOSTART=gcp", "WORKSPACE_VM_PROJECT=proyecto-prueba",
    "WORKSPACE_VM_ZONE=us-central1-a", "WORKSPACE_VM_NAME=adaceen-ws", "GCP_SERVICE_ACCOUNT_JSON=", "keys delete abc123", "SECRETO",
    // Lo que de verdad permite la clave (instances.get devuelve la metadata) y que hacer si se filtra.
    "workspace-agent-token", "rotar WORKSPACE_AGENT_TOKEN", "NO descargues la clave", "InstallAzureCLIDeb"]) {
    assert.ok(r.stdout.includes(texto), `falta «${texto}» en la salida`);
  }
  const clave = readFileSync(archivo);
  assert.equal(r.todo.includes("SECRETO-DE-PRUEBA"), false);
  assert.equal(r.todo.includes(clave.toString("base64").slice(0, 40)), false);
});

test("crear-cuenta-autoencendido.sh: con az y RG carga la clave en Azure (base64) sin imprimirla", { skip: omitir }, async () => {
  const p = preparar({ instancias: ["adaceen-ws us-central1-a RUNNING"], conAz: true });
  const r = await correr("bash", [AUTOENCENDIDO], { env: { ...p.env, CARPETA_CLAVE: path.join(p.casa, "c"), RG: "rg-prueba" } });
  assert.equal(r.codigo, 0, r.todo);
  const args = readFileSync(path.join(p.falso, "az-args"), "utf8").split("\n");
  assert.deepEqual(args.slice(0, 9), ["webapp", "config", "appsettings", "set", "--resource-group", "rg-prueba", "--name", "app-adaceen-api-eyder05232002", "--output"]);
  const ajuste = args.find((arg) => arg.startsWith("GCP_SERVICE_ACCOUNT_JSON="));
  const json = JSON.parse(Buffer.from(ajuste.slice("GCP_SERVICE_ACCOUNT_JSON=".length), "base64").toString("utf8"));
  assert.match(json.private_key, /SECRETO-DE-PRUEBA/);
  assert.ok(args.includes("WORKSPACE_VM_AUTOSTART=gcp"));
  assert.equal(r.todo.includes("SECRETO-DE-PRUEBA"), false);
  assert.match(r.todo, /configuracion cargada en Azure/);
  // Ya esta en Azure: no queda copia local.
  assert.equal(execFileSync("sh", ["-c", `ls ${path.join(p.casa, "c")} | wc -l`]).toString().trim(), "0");
  assert.match(r.todo, /borre la copia local de la clave/);
});

test("crear-cuenta-autoencendido.sh: explica la politica que prohibe claves y no deja archivo", { skip: omitir }, async () => {
  const p = preparar({ instancias: ["adaceen-ws us-central1-a RUNNING"] });
  writeFileSync(path.join(p.falso, "falla-clave"),
    "ERROR: (gcloud.iam.service-accounts.keys.create) FAILED_PRECONDITION: Key creation is not allowed on this service account.\n- '@type': type.googleapis.com/google.rpc.PreconditionFailure\n  violations:\n  - type: constraints/iam.disableServiceAccountKeyCreation\n");
  const carpeta = path.join(p.casa, "c");
  const r = await correr("bash", [AUTOENCENDIDO], { env: { ...p.env, CARPETA_CLAVE: carpeta } });
  assert.equal(r.codigo, 1, r.todo);
  assert.match(r.stderr, /disable-enforce iam\.disableServiceAccountKeyCreation --project=proyecto-prueba/);
  assert.equal(execFileSync("sh", ["-c", `ls ${carpeta} | wc -l`]).toString().trim(), "0");
});

test("crear-cuenta-autoencendido.sh: idempotente; con una clave ya creada no crea otra sin pedirlo", { skip: omitir }, async () => {
  const p = preparar({ instancias: ["adaceen-ws us-central1-a RUNNING"] });
  writeFileSync(path.join(p.falso, "rol"), "");
  writeFileSync(path.join(p.falso, "cuenta"), "");
  writeFileSync(path.join(p.falso, "claves"), "abc123\t2026-09-20T10:00:00Z\n");
  const r = await correr("bash", [AUTOENCENDIDO], { env: { ...p.env, CARPETA_CLAVE: path.join(p.casa, "c") } });
  assert.equal(r.codigo, 0, r.todo);
  const llamadas = p.llamadas();
  assert.match(llamadas, /iam roles update adaceenAutoencendido --project=proyecto-prueba --permissions=compute\.instances\.get,compute\.instances\.start/);
  assert.doesNotMatch(llamadas, /roles create|service-accounts create|keys create/);
  assert.match(r.todo, /no se creo otra clave/);
});

test("crear-cuenta-autoencendido.sh borrar: quita permiso, cuenta y rol", { skip: omitir }, async () => {
  const p = preparar({ instancias: ["adaceen-ws us-central1-a RUNNING"] });
  writeFileSync(path.join(p.falso, "rol"), "");
  writeFileSync(path.join(p.falso, "cuenta"), "");
  const r = await correr("bash", [AUTOENCENDIDO, "borrar"], { env: p.env });
  assert.equal(r.codigo, 0, r.todo);
  const llamadas = p.llamadas();
  assert.match(llamadas, /remove-iam-policy-binding adaceen-ws/);
  assert.match(llamadas, /iam service-accounts delete adaceen-autoencendido@proyecto-prueba\.iam\.gserviceaccount\.com/);
  assert.match(llamadas, /iam roles delete adaceenAutoencendido/);
  assert.match(r.stdout, /az webapp config appsettings delete/);
});

test("crear-cuenta-autoencendido.sh borrar: si la VM de editores ya no existe igual quita la cuenta y el rol", { skip: omitir }, async () => {
  const p = preparar({ instancias: ["adaceen-worker us-central1-a TERMINATED"] });
  writeFileSync(path.join(p.falso, "rol"), "");
  writeFileSync(path.join(p.falso, "cuenta"), "");
  const r = await correr("bash", [AUTOENCENDIDO, "borrar"], { env: p.env });
  assert.equal(r.codigo, 0, r.todo);
  const llamadas = p.llamadas();
  assert.doesNotMatch(llamadas, /remove-iam-policy-binding/);
  assert.match(llamadas, /iam service-accounts delete adaceen-autoencendido@proyecto-prueba\.iam\.gserviceaccount\.com/);
  assert.match(llamadas, /iam roles delete adaceenAutoencendido/);
  assert.match(r.todo, /la VM adaceen-ws ya no existe: no hay permiso que quitar/);
  assert.equal(existsSync(path.join(p.falso, "cuenta")), false);
  assert.equal(existsSync(path.join(p.falso, "rol")), false);

  // Crear si exige la VM.
  const r2 = await correr("bash", [AUTOENCENDIDO], { env: { ...p.env, CARPETA_CLAVE: path.join(p.casa, "c") } });
  assert.equal(r2.codigo, 1);
  assert.match(r2.stderr, /no existe la VM adaceen-ws/);
});

// ------------------------------------------------------------------ startup-script.sh
function git(cwd, ...argumentos) {
  return execFileSync("git", argumentos, {
    cwd,
    env: { ...process.env, GIT_AUTHOR_NAME: "p", GIT_AUTHOR_EMAIL: "p@p", GIT_COMMITTER_NAME: "p", GIT_COMMITTER_EMAIL: "p@p", GIT_CONFIG_NOSYSTEM: "1", HOME: tmpdir() },
    stdio: ["ignore", "pipe", "pipe"],
  }).toString().trim();
}

test("startup-script.sh: cambiar la metadata branch en una GPU ya creada no aborta (clon superficial de una rama)", { skip: omitir }, async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "adaceen-repo-"));
  const origen = path.join(dir, "origen");
  mkdirSync(origen);
  git(origen, "init", "-q", "-b", "rama-a");
  writeFileSync(path.join(origen, "cual.txt"), "a\n");
  git(origen, "add", ".");
  git(origen, "commit", "-q", "-m", "a");
  git(origen, "checkout", "-q", "-b", "rama-b");
  writeFileSync(path.join(origen, "cual.txt"), "b\n");
  git(origen, "commit", "-q", "-am", "b");
  const url = `file://${origen}`;
  const destino = path.join(dir, "opt", "repo");
  const sincronizar = (rama) => correr("bash", ["-c", `source "${STARTUP}" && sincronizar_repo "$1" "$2" "$3"`, "_", url, rama, destino],
    { env: { PATH: process.env.PATH, HOME: dir, GIT_CONFIG_NOSYSTEM: "1" } });

  let r = await sincronizar("rama-a");
  assert.equal(r.codigo, 0, r.todo);
  assert.equal(readFileSync(path.join(destino, "cual.txt"), "utf8"), "a\n");
  // Lo que hacia antes el script y abortaba el arranque:
  assert.throws(() => git(destino, "checkout", "-q", "rama-b"));
  writeFileSync(path.join(destino, ".env.worker"), "NO_SE_BORRA=1\n");

  r = await sincronizar("rama-b");
  assert.equal(r.codigo, 0, r.todo);
  assert.equal(readFileSync(path.join(destino, "cual.txt"), "utf8"), "b\n");
  assert.equal(git(destino, "rev-parse", "--abbrev-ref", "HEAD"), "rama-b");
  assert.equal(readFileSync(path.join(destino, ".env.worker"), "utf8"), "NO_SE_BORRA=1\n");

  // Una rama que no existe no rompe el arranque: sigue el codigo que habia.
  r = await sincronizar("rama-que-no-existe");
  assert.equal(r.codigo, 0, r.todo);
  assert.match(r.todo, /AVISO: no se pudo traer la rama rama-que-no-existe/);
  assert.equal(readFileSync(path.join(destino, "cual.txt"), "utf8"), "b\n");
});

test("startup-script.sh: sin metadata branch una copia vieja sigue en la rama de su clon (no salta a la de por defecto)", { skip: omitir }, async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "adaceen-rama-"));
  const origen = path.join(dir, "origen");
  mkdirSync(origen);
  git(origen, "init", "-q", "-b", "produccion");
  writeFileSync(path.join(origen, "cual.txt"), "con latido\n");
  git(origen, "add", ".");
  git(origen, "commit", "-q", "-m", "p");
  git(origen, "checkout", "-q", "-b", "vieja");
  writeFileSync(path.join(origen, "cual.txt"), "sin latido\n");
  git(origen, "commit", "-q", "-am", "v");
  git(origen, "checkout", "-q", "produccion");
  const url = `file://${origen}`;
  const destino = path.join(dir, "opt", "repo");
  const env = { PATH: process.env.PATH, HOME: dir, GIT_CONFIG_NOSYSTEM: "1" };
  // Lo mismo que hace el arranque: resolver_rama y luego sincronizar_repo.
  const arrancar = (metaBranch) => correr("bash", ["-c",
    `source "${STARTUP}" && rama=$(resolver_rama "$1" "$3" vieja) && echo "rama=$rama" && sincronizar_repo "$2" "$rama" "$3"`,
    "_", metaBranch, url, destino], { env });

  // Sin clon ni metadata: la rama por defecto (aqui, "vieja").
  let r = await arrancar("");
  assert.equal(r.codigo, 0, r.todo);
  assert.match(r.stdout, /rama=vieja/);
  assert.equal(readFileSync(path.join(destino, "cual.txt"), "utf8"), "sin latido\n");
  execFileSync("rm", ["-rf", destino]);

  // El disco de la L4 (clon de una rama con latido) copiado a la V100, sin metadata branch.
  git(dir, "clone", "-q", "--depth", "1", "-b", "produccion", url, destino);
  r = await arrancar("");
  assert.equal(r.codigo, 0, r.todo);
  assert.match(r.stdout, /rama=produccion/);
  assert.equal(git(destino, "rev-parse", "--abbrev-ref", "HEAD"), "produccion");
  assert.equal(readFileSync(path.join(destino, "cual.txt"), "utf8"), "con latido\n");

  // Con metadata branch manda la metadata.
  r = await arrancar("vieja");
  assert.equal(r.codigo, 0, r.todo);
  assert.equal(git(destino, "rev-parse", "--abbrev-ref", "HEAD"), "vieja");

  const texto = readFileSync(STARTUP, "utf8");
  assert.match(texto, /BRANCH=\$\(resolver_rama "\$BRANCH_META" \/opt\/adaceen\/repo feature\/azure-config-observability\)/);
});

test("startup-script.sh: el apagado por inactividad cuenta desde el ultimo trabajo (o el arranque), no desde el log", { skip: omitir }, async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "adaceen-idle-"));
  const chequeo = path.join(dir, "adaceen-idle-check");
  const uptime = path.join(dir, "uptime");
  const ultimo = path.join(dir, "ultimo-trabajo");
  const apagado = path.join(dir, "apagado");
  const ahora = Math.floor(Date.now() / 1000);

  const caso = async ({ minutos = 30, subidaSeg, trabajoHaceMin = null }) => {
    execFileSync("rm", ["-f", apagado, ultimo]);
    writeFileSync(uptime, `${subidaSeg}.52 1234.00\n`);
    if (trabajoHaceMin !== null) {
      writeFileSync(ultimo, "2026-09-25T10:00:00.000Z\n");
      const t = ahora - trabajoHaceMin * 60;
      utimesSync(ultimo, t, t);
    }
    const r1 = await correr("bash", ["-c", `source "${STARTUP}" && escribir_chequeo_inactividad "$@"`, "_", chequeo, String(minutos), ultimo, uptime, `touch ${apagado}`],
      { env: { PATH: process.env.PATH } });
    assert.equal(r1.codigo, 0, r1.todo);
    const r2 = await correr("bash", [chequeo], { env: { PATH: process.env.PATH } });
    assert.equal(r2.codigo, 0, r2.todo);
    return existsSync(apagado);
  };

  assert.equal(await caso({ subidaSeg: 600 }), false, "gracia de 20 min tras el arranque");
  assert.equal(await caso({ subidaSeg: 1500 }), false, "sin trabajos, pero arranco hace 25 min");
  assert.equal(await caso({ subidaSeg: 7200 }), true, "sin trabajos desde que arranco hace 2 h");
  assert.equal(await caso({ subidaSeg: 7200, trabajoHaceMin: 5 }), false, "trabajo hace 5 min");
  assert.equal(await caso({ subidaSeg: 7200, trabajoHaceMin: 45 }), true, "ultimo trabajo hace 45 min");
  assert.equal(await caso({ subidaSeg: 7200, trabajoHaceMin: 600 }), true, "trabajo de antes del arranque");
  assert.equal(await caso({ minutos: 180, subidaSeg: 7200, trabajoHaceMin: 45 }), false, "clones con 180 min");
  assert.equal(await caso({ minutos: 0, subidaSeg: 99999 }), false, "0 = no apagar");
});

test("startup-script.sh: rotacion de los logs del worker con copytruncate", { skip: omitir }, async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "adaceen-rot-"));
  const destino = path.join(dir, "adaceen-worker");
  const r = await correr("bash", ["-c", `source "${STARTUP}" && escribir_logrotate "$1"`, "_", destino], { env: { PATH: process.env.PATH } });
  assert.equal(r.codigo, 0, r.todo);
  const conf = readFileSync(destino, "utf8");
  assert.match(conf, /^\/var\/log\/adaceen-worker\.log \/var\/log\/adaceen-startup\.log \{/m);
  for (const directiva of ["copytruncate", "size 50M", "rotate 5", "compress", "missingok"]) {
    assert.ok(conf.includes(directiva), directiva);
  }
  if (hay("logrotate")) {
    const estado = path.join(dir, "estado");
    execFileSync("logrotate", ["-d", "-s", estado, destino], { stdio: "ignore" });
  }
});

test("startup-script.sh: el worker recibe la ruta del archivo de ultimo trabajo y el script sigue siendo bash valido", { skip: omitir }, () => {
  const texto = readFileSync(STARTUP, "utf8");
  assert.match(texto, /QUEUE_WORKER_LAST_JOB_FILE=\$ULTIMO_TRABAJO/);
  assert.match(texto, /escribir_chequeo_inactividad \/usr\/local\/bin\/adaceen-idle-check "\$IDLE_MINUTES" "\$ACTIVIDAD"/);
  execFileSync("bash", ["-n", STARTUP]);
  const worker = readFileSync(path.resolve(DEPLOY, "..", "scripts", "service-bus-ollama-worker.ts"), "utf8");
  // startup-script.sh decide el modo buscando este nombre en el worker de la rama clonada.
  assert.match(worker, /process\.env\.QUEUE_WORKER_LAST_JOB_FILE/);
});

// ------------------------------------------------------------------ worker: ultimo trabajo
// El worker corre al importarse (se conecta a Service Bus), asi que no se puede
// importar para probarlo: se toma el texto de createLastJobRecorder del propio
// archivo, se le quitan los tipos con esbuild (lo trae tsx) y se ejecuta con
// fs y path reales.
async function cargarRegistroUltimoTrabajo() {
  let transformSync;
  try {
    ({ transformSync } = await import("esbuild"));
  } catch {
    return null;
  }
  const fuente = readFileSync(WORKER, "utf8");
  const inicio = fuente.indexOf("function createLastJobRecorder(");
  assert.ok(inicio >= 0, "createLastJobRecorder no esta en el worker");
  let i = fuente.indexOf(") {", inicio) + 2;
  let profundidad = 0;
  for (; i < fuente.length; i += 1) {
    if (fuente[i] === "{") profundidad += 1;
    if (fuente[i] === "}" && --profundidad === 0) break;
  }
  const { code } = transformSync(fuente.slice(inicio, i + 1), { loader: "ts" });
  const errorSummary = (error) => ({ message: String(error && error.message) });
  return new Function("fsp", "path", "errorSummary", `${code}\nreturn createLastJobRecorder;`)(fsp, path, errorSummary);
}

const esperarA = async (condicion, ms = 3000) => {
  const limite = Date.now() + ms;
  while (!condicion() && Date.now() < limite) await new Promise((resolve) => setTimeout(resolve, 10));
  return condicion();
};

test("worker: tras cada trabajo escribe la hora en QUEUE_WORKER_LAST_JOB_FILE; sin la variable no hace nada y un fallo no lo detiene", async (t) => {
  const createLastJobRecorder = await cargarRegistroUltimoTrabajo();
  if (!createLastJobRecorder) {
    t.skip("sin esbuild");
    return;
  }
  const avisos = [];
  const logger = { warn: (evento, datos) => avisos.push({ evento, datos }) };
  const dir = mkdtempSync(path.join(tmpdir(), "adaceen-ultimo-"));

  // Sin ruta: no escribe nada.
  const nada = createLastJobRecorder("", logger);
  nada();
  await new Promise((resolve) => setTimeout(resolve, 50));
  assert.equal(avisos.length, 0);

  // Crea la carpeta y deja la fecha ISO; cada trabajo la renueva.
  const archivo = path.join(dir, "var", "lib", "adaceen", "ultimo-trabajo");
  const registrar = createLastJobRecorder(archivo, logger);
  registrar();
  assert.ok(await esperarA(() => existsSync(archivo)), "no escribio el archivo");
  assert.match(readFileSync(archivo, "utf8"), /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z\n$/);
  const viejo = Math.floor(Date.now() / 1000) - 3600;
  utimesSync(archivo, viejo, viejo);
  registrar();
  assert.ok(await esperarA(() => statSync(archivo).mtimeMs / 1000 > viejo + 60), "no renovo la fecha");

  // Carpeta imposible (su "padre" es un archivo): avisa el primero y cada 50, sin lanzar.
  const imposible = path.join(archivo, "no-puede", "ultimo-trabajo");
  const fallido = createLastJobRecorder(imposible, logger);
  for (let n = 0; n < 50; n += 1) fallido();
  assert.ok(await esperarA(() => avisos.length >= 2), `avisos: ${avisos.length}`);
  await new Promise((resolve) => setTimeout(resolve, 50));
  assert.equal(avisos.length, 2);
  assert.deepEqual(avisos.map((a) => a.evento), ["worker.last_job_file.failed", "worker.last_job_file.failed"]);
  assert.deepEqual(avisos.map((a) => a.datos.failures), [1, 50]);
});

test("worker: registra el ultimo trabajo solo con trabajos atendidos (no con los devueltos a la cola)", () => {
  const fuente = readFileSync(WORKER, "utf8");
  assert.match(fuente, /const recordLastJob = createLastJobRecorder\(trimText\(process\.env\.QUEUE_WORKER_LAST_JOB_FILE\), logger\);/);
  assert.match(fuente, /if \(outcome !== "retry"\) \{\s*stats\.jobsProcessed \+= 1;\s*stats\.lastJobAt = [^;]+;\s*recordLastJob\(\);\s*\}/);
  assert.equal(fuente.split("recordLastJob()").length - 1, 1, "una sola llamada");
});

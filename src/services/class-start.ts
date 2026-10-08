// «Iniciar clase» desde la tuerca del administrador o el docente (navegador 0.7.21):
// lo que hace `bash deploy/clase.sh iniciar` en Cloud Shell, pero desde el backend
// (GET /api/admin/clase/estado y POST /api/admin/clase/iniciar, src/routes/class-routes.ts).
//
// - Enciende la VM de editores (WORKSPACE_VM_ZONE/NAME) solo si el proveedor activo es
//   tunnel, y UNA GPU: la primera de CLASS_GPU_VMS ("nombre:zona,..." en orden de
//   preferencia) que acepte instances.start. Si una falla por cupo o cuota
//   (ZONE_RESOURCE_POOL_EXHAUSTED, QUOTA_EXCEEDED...) prueba la siguiente; si una ya esta
//   RUNNING (o arrancando) no enciende otra. Misma pausa minima de 2 min entre dos start
//   de la misma VM que el autoencendido.
// - Nunca apaga nada: el rol personalizado no tiene stop y los timers de inactividad de
//   las VMs se encargan (docs/operacion/runbook.md, seccion 0).
// - estado: cada VM (instances.get con cache de 15 s), el agente de editores, los
//   servidores del modelo vivos y `ready`. Ademas sigue lo que pidio iniciar: si la GPU
//   que se encendio no quedo RUNNING (un start aceptado que Compute deshizo por cupo)
//   prueba la siguiente, hasta 15 min despues de pulsar el boton.
//
// Credenciales y cliente de Compute: src/services/gcp-compute.ts (clave o federacion).
import { env } from "../config/env.js";
import {
  BOOTING_STATES,
  createComputeClient,
  createGcpTokenProvider,
  resolveGcpCredentials,
  STARTABLE_STATES,
  type ComputeClient,
  type ComputeInstanceRef,
} from "./gcp-compute.js";
import { trimText } from "./text-utils.js";

export type ClassVmKind = "gpu" | "editors";
export type ClassVmConfig = { name: string; zone: string };

export type ClassStartConfig = {
  project: string;
  /** GPU en orden de preferencia (vacio: no hay GPU que encender). */
  gpus: ClassVmConfig[];
  /** VM de editores (null: no configurada). */
  editors: ClassVmConfig | null;
};

export type ClassVmStateName = "running" | "starting" | "stopping" | "off" | "failed" | "unknown";

export type ClassVmState = {
  name: string;
  zone: string;
  kind: ClassVmKind;
  /** Estado de Compute (RUNNING, TERMINATED, STAGING...); null si no se pudo leer. */
  vmStatus: string | null;
  state: ClassVmStateName;
  /** Ultimo instances.start aceptado desde este backend. */
  startRequestedAt: string | null;
  /** Por que no se encendio o no se pudo leer ("" si nada). */
  problem: string;
};

export type ClassGpuSummary = "running" | "starting" | "off" | "failed" | "none";

export type ClassContext = {
  provider: "tunnel" | "codespaces";
  /** null: el backend no puede saberlo (transporte directo). */
  agentOnline: boolean | null;
  workersAlive: number;
};

export type ClassStatus = {
  ok: true;
  configured: true;
  provider: ClassContext["provider"];
  /** La VM de editores hace falta (proveedor tunnel) y esta configurada. */
  editorsNeeded: boolean;
  editors: ClassVmState | null;
  gpus: ClassVmState[];
  gpu: ClassGpuSummary;
  workspaceAgentOnline: boolean | null;
  modelWorkersAlive: number;
  /** Agente de editores conectado (si hace falta) y al menos un servidor del modelo vivo. */
  ready: boolean;
  /** Ultimo «Iniciar clase» atendido por este backend (quien y cuando). */
  requestedBy: string | null;
  requestedAt: string | null;
  checkedAt: string;
};

export type ClassStartOutcome = ClassStatus & {
  /** Lo que se pidio a Compute en esta llamada ("instances.start adaceen-worker-v100"). */
  actions: string[];
  message: string;
};

export type ClassStartDeps = {
  compute: ComputeClient;
  /** Proveedor activo, agente y servidores vivos (produccion: /api/health). */
  context: () => Promise<ClassContext>;
  now?: () => number;
  /** Cuanto se reutiliza el ultimo instances.get (la extension consulta cada 10 s). */
  checkCacheMs?: number;
  /** Pausa minima entre dos instances.start de la misma VM. */
  startCooldownMs?: number;
  /** Un start aceptado cuya VM sigue apagada pasado esto no encendio (cupo): se prueba la siguiente GPU. */
  startFailAfterMs?: number;
  /** Cuanto se sigue mostrando "failed" (y no se reintenta esa VM) tras un fallo. */
  failHoldMs?: number;
  /** Cuanto sigue estado completando lo que pidio iniciar (probar la siguiente GPU). */
  continueWindowMs?: number;
};

const RESOURCE_NAME_RE = /^[a-z]([-a-z0-9]{0,61}[a-z0-9])?$/;
const PROJECT_RE = /^[a-z][-a-z0-9.:]{4,61}[a-z0-9]$/;

/** "nombre:zona,nombre:zona" -> lista en orden; problem si alguna entrada no vale. */
export function parseClassGpuVms(raw: string): { gpus: ClassVmConfig[]; problem: string } {
  const gpus: ClassVmConfig[] = [];
  const invalid: string[] = [];
  for (const item of trimText(raw).split(",")) {
    const entry = item.trim();
    if (!entry) continue;
    const [name, zone, ...rest] = entry.split(":").map((part) => part.trim());
    if (rest.length || !RESOURCE_NAME_RE.test(name || "") || !RESOURCE_NAME_RE.test(zone || "")) {
      invalid.push(entry);
      continue;
    }
    if (!gpus.some((gpu) => gpu.name === name)) gpus.push({ name, zone });
  }
  return {
    gpus,
    problem: invalid.length ? `CLASS_GPU_VMS: entradas no validas (${invalid.join(", ")}); usa nombre:zona separadas por comas.` : "",
  };
}

/**
 * Configuracion de «Iniciar clase» desde el entorno (pura). config null y problem ""
 * cuando no hay ninguna VM configurada; problem si esta pedido pero mal.
 */
export function resolveClassStartConfig(source: { project?: string; zone?: string; name?: string; gpus?: string } = {
  project: env.workspaceVmProject,
  zone: env.workspaceVmZone,
  name: env.workspaceVmName,
  gpus: env.classGpuVms,
}): { config: ClassStartConfig | null; problem: string } {
  const project = trimText(source.project);
  const zone = trimText(source.zone);
  const name = trimText(source.name);
  const parsed = parseClassGpuVms(source.gpus || "");
  const editors = RESOURCE_NAME_RE.test(zone) && RESOURCE_NAME_RE.test(name) ? { name, zone } : null;
  if (!parsed.gpus.length && !editors) return { config: null, problem: parsed.problem };
  if (!PROJECT_RE.test(project)) {
    return { config: null, problem: `falta WORKSPACE_VM_PROJECT (proyecto de Google Cloud de las VMs de la clase).${parsed.problem ? ` ${parsed.problem}` : ""}` };
  }
  return { config: { project, gpus: parsed.gpus, editors }, problem: parsed.problem };
}

type VmEntry = {
  cfg: ClassVmConfig;
  kind: ClassVmKind;
  ref: ComputeInstanceRef;
  lastStartAt: number;
  lastStartAccepted: boolean;
  failedAt: number;
  problem: string;
  read: { at: number; vmStatus: string | null; problem: string } | null;
};

function iso(ms: number) {
  return ms ? new Date(ms).toISOString() : null;
}

export function createClassStarter(config: ClassStartConfig, deps: ClassStartDeps) {
  const now = deps.now || Date.now;
  const checkCacheMs = deps.checkCacheMs ?? 15_000;
  const startCooldownMs = deps.startCooldownMs ?? 2 * 60 * 1000;
  const startFailAfterMs = deps.startFailAfterMs ?? 90_000;
  const failHoldMs = deps.failHoldMs ?? 10 * 60 * 1000;
  const continueWindowMs = deps.continueWindowMs ?? 15 * 60 * 1000;

  const entry = (cfg: ClassVmConfig, kind: ClassVmKind): VmEntry => ({
    cfg,
    kind,
    ref: { project: config.project, zone: cfg.zone, name: cfg.name },
    lastStartAt: 0,
    lastStartAccepted: false,
    failedAt: 0,
    problem: "",
    read: null,
  });
  const gpus = config.gpus.map((cfg) => entry(cfg, "gpu"));
  const editors = config.editors ? entry(config.editors, "editors") : null;
  const all = editors ? [...gpus, editors] : gpus;

  let requestedBy = "";
  let requestedAt = 0;
  // Una sola consulta o encendido a la vez (la extension sondea cada 10 s).
  let inFlight: Promise<unknown> | null = null;

  async function read(vm: VmEntry, maxAgeMs: number) {
    if (vm.read && now() - vm.read.at < maxAgeMs) return vm.read;
    const result = await deps.compute.getStatus(vm.ref);
    vm.read = result.ok
      ? { at: now(), vmStatus: result.vmStatus, problem: "" }
      : { at: now(), vmStatus: null, problem: result.reason };
    return vm.read;
  }

  function stateOf(vm: VmEntry): ClassVmStateName {
    const vmStatus = vm.read?.vmStatus ?? null;
    if (vmStatus === null) return "unknown";
    if (vmStatus === "RUNNING") return "running";
    if (BOOTING_STATES.has(vmStatus)) return "starting";
    if (vmStatus === "STOPPING" || vmStatus === "SUSPENDING") return "stopping";
    if (vm.lastStartAccepted && now() - vm.lastStartAt < startFailAfterMs) return "starting";
    if (vm.lastStartAccepted && STARTABLE_STATES.has(vmStatus)) {
      // Compute acepto el start pero la VM sigue apagada: no hubo cupo. Cuenta como fallo.
      vm.lastStartAccepted = false;
      vm.failedAt = now();
      vm.problem = "Compute acepto el encendido pero la VM sigue apagada (sin cupo en la zona o sin cuota).";
      console.warn(`[clase] la VM ${vm.cfg.name} no quedo encendida tras el start: ${vm.problem}`);
    }
    if (vm.failedAt && now() - vm.failedAt < failHoldMs) return "failed";
    return "off";
  }

  function snapshot(vm: VmEntry): ClassVmState {
    const state = stateOf(vm);
    return {
      name: vm.cfg.name,
      zone: vm.cfg.zone,
      kind: vm.kind,
      vmStatus: vm.read?.vmStatus ?? null,
      state,
      startRequestedAt: vm.lastStartAccepted ? iso(vm.lastStartAt) : null,
      problem: state === "failed" || state === "unknown" ? (vm.read?.problem || vm.problem) : (vm.read?.problem || ""),
    };
  }

  /** Pide instances.start si pasaron 2 min del ultimo; false si no se pidio o Compute lo rechazo. */
  async function tryStart(vm: VmEntry, actions: string[]) {
    if (now() - vm.lastStartAt < startCooldownMs) return vm.lastStartAccepted;
    const before = vm.read?.vmStatus ?? "?";
    vm.lastStartAt = now();
    vm.lastStartAccepted = false;
    actions.push(`instances.start ${vm.cfg.name}`);
    const started = await deps.compute.start(vm.ref);
    if (!started.accepted) {
      vm.problem = started.reason;
      vm.failedAt = now();
      console.warn(`[clase] ${vm.kind === "gpu" ? "la GPU" : "la VM de editores"} ${vm.cfg.name} no encendio: ${started.reason}${started.capacity ? " (sin cupo o cuota)" : ""}`);
      return false;
    }
    vm.lastStartAccepted = true;
    vm.failedAt = 0;
    vm.problem = "";
    console.info(`[clase] encendiendo ${vm.kind === "gpu" ? "la GPU" : "la VM de editores"} ${vm.cfg.name} (${vm.cfg.zone}; estaba ${before}).`);
    return true;
  }

  /** Enciende la primera GPU que acepte, salvo que una ya este encendida o arrancando. */
  async function startNextGpu(actions: string[]) {
    if (gpus.some((gpu) => ["running", "starting"].includes(stateOf(gpu)))) return;
    for (const gpu of gpus) {
      const state = stateOf(gpu);
      if (state === "stopping" || state === "failed" || state === "unknown") continue;
      if (now() - gpu.lastStartAt < startCooldownMs) continue;
      if (await tryStart(gpu, actions)) return;
    }
  }

  function gpuSummary(): ClassGpuSummary {
    if (!gpus.length) return "none";
    const states = gpus.map(stateOf);
    if (states.includes("running")) return "running";
    if (states.includes("starting")) return "starting";
    if (states.includes("failed")) return "failed";
    return "off";
  }

  function compose(context: ClassContext): ClassStatus {
    const editorsNeeded = Boolean(editors) && context.provider === "tunnel";
    const editorsState = editors ? snapshot(editors) : null;
    const editorsReady = !editorsNeeded
      || context.agentOnline === true
      || (context.agentOnline === null && editorsState?.state === "running");
    return {
      ok: true,
      configured: true,
      provider: context.provider,
      editorsNeeded,
      editors: editorsState,
      gpus: gpus.map(snapshot),
      gpu: gpuSummary(),
      workspaceAgentOnline: context.agentOnline,
      modelWorkersAlive: context.workersAlive,
      ready: editorsReady && context.workersAlive >= 1,
      requestedBy: requestedBy || null,
      requestedAt: iso(requestedAt),
      checkedAt: new Date(now()).toISOString(),
    };
  }

  function serialized<T>(work: () => Promise<T>): Promise<T> {
    const run = (inFlight ?? Promise.resolve()).then(work, work);
    inFlight = run.catch(() => undefined);
    return run;
  }

  /** Estado de todo (cache de 15 s por VM) y continuacion de lo que pidio iniciar. */
  function status(): Promise<ClassStatus> {
    return serialized(async () => {
      const context = await deps.context();
      await Promise.all(all.map((vm) => read(vm, checkCacheMs)));
      if (requestedAt && now() - requestedAt < continueWindowMs && context.workersAlive < 1) {
        const actions: string[] = [];
        await startNextGpu(actions);
      }
      return compose(context);
    });
  }

  /** «Iniciar clase»: VM de editores (si hace falta) y una GPU. Nunca apaga nada. */
  function start(by: string): Promise<ClassStartOutcome> {
    return serialized(async () => {
      requestedBy = trimText(by).slice(0, 120) || "desconocido";
      requestedAt = now();
      console.info(`[clase] «Iniciar clase» pedido por ${requestedBy}.`);
      const context = await deps.context();
      const actions: string[] = [];
      // Lectura fresca: lo que ya esta encendido se deja como esta.
      await Promise.all(all.map((vm) => read(vm, 3_000)));
      if (editors && context.provider === "tunnel") {
        const state = stateOf(editors);
        if (state === "off" || state === "failed") await tryStart(editors, actions);
      }
      await startNextGpu(actions);
      const status = compose(context);
      return { ...status, actions, message: describeStart(status, actions) };
    });
  }

  return { config, status, start };
}

export type ClassStarter = ReturnType<typeof createClassStarter>;

function describeStart(status: ClassStatus, actions: string[]) {
  const parts: string[] = [];
  if (status.editorsNeeded && status.editors) {
    const editors = status.editors;
    if (status.workspaceAgentOnline === true) parts.push("la VM de editores ya esta conectada");
    else if (editors.state === "starting") parts.push(actions.includes(`instances.start ${editors.name}`) ? "encendiendo la VM de editores (el agente se conecta en 1-2 min)" : "la VM de editores ya se esta encendiendo");
    else if (editors.state === "running") parts.push("la VM de editores esta encendida; el agente todavia no se conecta");
    else if (editors.state === "stopping") parts.push("la VM de editores se esta apagando: vuelve a pulsar en un minuto");
    else parts.push(`la VM de editores no encendio${editors.problem ? ` (${editors.problem})` : ""}`);
  }
  if (status.gpus.length) {
    const running = status.gpus.find((gpu) => gpu.state === "running");
    const starting = status.gpus.find((gpu) => gpu.state === "starting");
    if (status.modelWorkersAlive >= 1) parts.push(`${status.modelWorkersAlive} servidor(es) del modelo ya atienden`);
    else if (running) parts.push(`la GPU ${running.name} ya esta encendida; el servidor del modelo tarda 2-5 min en mandar latido`);
    else if (starting) parts.push(`encendiendo la GPU ${starting.name} (2-5 min; la primera vez hasta 12)`);
    else {
      const failed = status.gpus.filter((gpu) => gpu.state === "failed");
      parts.push(failed.length
        ? `ninguna GPU encendio: ${failed.map((gpu) => `${gpu.name} (${gpu.problem})`).join("; ")}. Si hay Mac del laboratorio encendidas, atienden ellas`
        : "ninguna GPU se pudo encender todavia");
    }
  } else if (status.modelWorkersAlive < 1) {
    parts.push("sin GPU configurada (CLASS_GPU_VMS vacia): atienden los servidores que ya esten encendidos");
  }
  if (!parts.length) return "Nada que encender.";
  return parts.map((part) => `${part[0].toUpperCase()}${part.slice(1)}.`).join(" ");
}

let defaultStarter: { starter: ClassStarter | null; problem: string } | undefined;

/**
 * Starter del proceso segun el entorno (null con el motivo si faltan las VMs o las
 * credenciales). El contexto (proveedor, agente, servidores) lo pone la ruta.
 */
export function getDefaultClassStarter(context: () => Promise<ClassContext>) {
  if (defaultStarter !== undefined) return defaultStarter;
  const vms = resolveClassStartConfig();
  const gcp = resolveGcpCredentials();
  if (vms.problem) console.warn(`[config] «Iniciar clase»: ${vms.problem}`);
  if (gcp.problem) console.warn(`[config] ${gcp.problem}`);
  if (!vms.config) {
    defaultStarter = { starter: null, problem: "«Iniciar clase» no esta configurado en este backend: faltan CLASS_GPU_VMS o WORKSPACE_VM_ZONE/WORKSPACE_VM_NAME (y WORKSPACE_VM_PROJECT)." };
  } else if (!gcp.credentials) {
    defaultStarter = {
      starter: null,
      problem: `Este backend no tiene credenciales de Google Cloud: carga GCP_SERVICE_ACCOUNT_JSON (bash deploy/gcp/crear-cuenta-autoencendido.sh) o la federacion sin clave (bash deploy/gcp/crear-federacion-autoencendido.sh).${gcp.problem ? ` ${gcp.problem}` : ""}`,
    };
  } else {
    const compute = createComputeClient({ getAccessToken: createGcpTokenProvider(gcp.credentials) });
    defaultStarter = { starter: createClassStarter(vms.config, { compute, context }), problem: "" };
    console.info(`[config] «Iniciar clase»: GPU ${vms.config.gpus.map((gpu) => gpu.name).join(", ") || "ninguna"}; VM de editores ${vms.config.editors?.name || "ninguna"}; credenciales en modo ${gcp.credentials.mode}.`);
  }
  return defaultStarter;
}

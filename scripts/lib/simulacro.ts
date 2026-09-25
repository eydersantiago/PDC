import fsp from "node:fs/promises";
import path from "node:path";
import readline from "node:readline";
import type { Readable, Writable } from "node:stream";
import { AGENT_UNREACHABLE_MESSAGE, VM_STARTING_MESSAGE } from "../../src/services/workspace-provider.js";
import { nowStamp } from "./cli.js";
import { describeFetchError, redactSecrets, redactText } from "./evidencias.js";

/**
 * Simulacro de contingencia con cronometro (A15.5 · ADACEEN-126, A13.6 ·
 * ADACEEN-114): guia al operador por los casos de la seccion 9 de
 * docs/operacion/contingencia.md, sondea /api/health (y /api/agent/health en
 * el escenario gpu) y mide cuanto tarda el sistema en ver la caida, en quedar
 * en modo degradado y en recuperarse.
 *
 * No apaga ni enciende nada: solo muestra el comando que corre el operador
 * (a mano, con gcloud o con deploy/clase.sh) y hace GET publicos. No necesita
 * gcloud ni credenciales.
 */

export const ESCENARIOS = ["gpu", "editor", "azure"] as const;
export type Escenario = typeof ESCENARIOS[number];

export type Lectura = {
  at: string;
  /** ms desde el inicio del simulacro (inicio de la consulta). */
  tMs: number;
  /** HTTP de /api/health; 0 si no respondio. */
  status: number;
  ms: number;
  error: string | null;
  ok: boolean | null;
  mode: string | null;
  workerHeartbeatConfigured: boolean | null;
  modelWorkersAlive: number | null;
  modelWorkersKnownDown: boolean | null;
  workspaceProvider: string | null;
  workspaceAgentOnline: boolean | null;
  /** HTTP de /api/agent/health (solo escenario gpu); 0 si no respondio. */
  agentHealthStatus: number | null;
};

type PasoId = "caida" | "deteccion" | "degradado" | "recuperar" | "recuperacion" | "completo";

type PasoDef = {
  id: PasoId;
  titulo: string;
  tipo: "manual" | "auto";
  instrucciones: string[];
  /** manual: true si es una confirmacion (sin pausas queda omitida); false si es una accion (se marca al llegar). */
  confirmacion?: boolean;
  /** auto: condicion sobre una lectura. */
  condicion?: (lectura: Lectura, base: Lectura | null) => boolean;
  /** auto: "primera" lectura que cumple o inicio de la racha "estable" final. */
  modo?: "primera" | "estable";
  /** auto: desde que marca se buscan lecturas (por defecto, la ultima marca). */
  desde?: PasoId;
  /** Solo se corre si la lectura inicial lo justifica. */
  soloSi?: (base: Lectura | null) => boolean;
};

type EscenarioDef = {
  titulo: string;
  casos: string;
  requisito: string;
  sano: (lectura: Lectura) => boolean;
  avisosBase: (lectura: Lectura) => string[];
  describir: (lectura: Lectura) => string;
  pasos: PasoDef[];
  /**
   * Meta de deteccion de contingencia.md sin el intervalo de consulta (ms) y de
   * que se compone; metaDeteccionMs le suma el intervalo.
   */
  deteccionEsperada: { ms: number; detalle: string } | null;
  /** Filas de la tabla de la seccion 9 que cubre y como se evaluan. */
  filas: Array<{ caso: string; evaluar: (resultado: TiemposYPasos) => { paso: boolean | null; detalle: string } }>;
};

type EstadoPaso = "ok" | "omitido" | "sin_detectar" | "interrumpido" | "pendiente" | "no_aplica";

export type PasoResultado = {
  id: PasoId;
  titulo: string;
  tipo: "manual" | "auto";
  estado: EstadoPaso;
  at: string | null;
  tMs: number | null;
};

export type Tiempos = {
  deteccionMs: number | null;
  degradadoMs: number | null;
  recuperacionMs: number | null;
  fueraDeServicioMs: number | null;
  completoMs: number | null;
};

type TiemposYPasos = { tiempos: Tiempos; pasos: PasoResultado[]; def: EscenarioDef; intervaloMs: number };

export type SimulacroResultado = {
  escenario: Escenario;
  titulo: string;
  backend: string;
  comando: string;
  inicio: string;
  fin: string;
  intervaloMs: number;
  base: Lectura | null;
  baseSana: boolean;
  avisosBase: string[];
  pasos: PasoResultado[];
  tiempos: Tiempos;
  filas: Array<{ caso: string; paso: boolean | null; detalle: string }>;
  /** paso: todo medido y dentro de lo esperado; por_confirmar: falta una confirmacion del operador. */
  veredicto: "paso" | "por_confirmar" | "no_paso";
  lecturas: number;
  archivos: { registro: string; resumen: string };
};

export type SimulacroOptions = {
  backendUrl: string;
  escenario: Escenario;
  /** Entre consultas (por defecto 5 s). */
  intervaloMs?: number;
  /** Limite de cada consulta (por defecto 10 s). */
  timeoutMs?: number;
  /** Espera maxima de cada paso automatico (por defecto 900 s, como ESPERA_MAX de deploy/clase.sh). */
  limiteMs?: number;
  /** Cada cuanto se recuerda el cronometro mientras se espera (por defecto 15 s). */
  progresoMs?: number;
  /** false: los pasos manuales se marcan solos (acciones) o se omiten (confirmaciones). */
  pausas?: boolean;
  input?: Readable;
  output?: Writable;
  /** Carpeta del registro (por defecto exportes). */
  salida?: string;
  signal?: AbortSignal;
  comando?: string;
};

// ---------------------------------------------------------------- escenarios

const responde = (lectura: Lectura) => lectura.status === 200 && lectura.ok === true;
const siNo = (value: boolean | null) => value === null ? "sin dato" : value ? "sí" : "no";

function describirHealth(lectura: Lectura) {
  return lectura.status ? `/api/health ${lectura.status}` : `/api/health ${lectura.error || "sin respuesta"}`;
}

const CONTINGENCIA = "docs/operacion/contingencia.md, sección 9";

// Metas de deteccion. El simulacro mide desde el Enter del operador, que llega
// antes de que el comando pare el proceso en la VM, y el backend tarda en dar
// la pieza por caida: la meta suma las dos cosas y el intervalo de consulta.

/**
 * WORKER_HEARTBEAT_STALE_MS por defecto (src/config/env.ts): un worker cuenta
 * como vivo hasta 120 s despues de su ultimo latido (src/services/worker-heartbeat.ts),
 * y al parar no manda un latido de despedida.
 */
export const LATIDO_VENCE_MS = 120_000;
/** staleAfterMs de src/services/workspace-relay.ts: el agente cuenta como conectado hasta 60 s despues de su ultimo sondeo. */
export const RELAY_VENCE_MS = 60_000;
/**
 * Un sondeo largo del agente dura hasta 25 s (wait=25 en
 * deploy/gcp/workspaces/agente/relay.mjs, tope en src/routes/workspace-routes.ts).
 * Si el corte de la conexion no llega al backend, el sondeo termina por tiempo
 * y ahi empiezan los 60 s.
 */
export const SONDEO_LARGO_MS = 25_000;
/**
 * Margen entre el Enter del operador y el momento en que el comando para el
 * proceso en la VM (gcloud compute ssh por IAP, o el apagado de la VM con
 * deploy/clase.sh o gcloud). Es un margen estimado, no una medida.
 */
export const MARGEN_COMANDO_MS = 30_000;

/** Meta de deteccion con el intervalo de consulta: la lectura que ve la caida puede llegar un intervalo tarde. */
export function metaDeteccionMs(def: EscenarioDef, intervaloMs: number) {
  return def.deteccionEsperada ? def.deteccionEsperada.ms + intervaloMs : null;
}

/** 120 s | 2,5 s: para explicar de que se compone una meta. */
function segundos(ms: number) {
  return `${String(Math.round(ms / 100) / 10).replace(".", ",")} s`;
}

/** «≤ 2 min 35 s: …» o «—» si el escenario no tiene meta. */
export function describirMetaDeteccion(def: EscenarioDef, intervaloMs: number) {
  const meta = metaDeteccionMs(def, intervaloMs);
  return meta === null || !def.deteccionEsperada
    ? "—"
    : `≤ ${formatDuration(meta)}: ${def.deteccionEsperada.detalle} y ${segundos(intervaloMs)} de consulta`;
}

export const ESCENARIO_DEFS: Record<Escenario, EscenarioDef> = {
  gpu: {
    titulo: "GPU apagada o desalojada, y recuperación",
    casos: "1, 2 y 4",
    requisito: "al menos un servidor del modelo vivo (model_workers_alive >= 1)",
    sano: (lectura) => responde(lectura) && (lectura.modelWorkersAlive ?? 0) >= 1,
    avisosBase: (lectura) => {
      const avisos: string[] = [];
      if (!responde(lectura)) avisos.push("el backend no responde en /api/health");
      if (lectura.modelWorkersAlive === null) avisos.push("/api/health no informa model_workers_alive: el backend es anterior a la tanda «acceso simplificado»; solo queda /api/agent/health");
      if (lectura.workerHeartbeatConfigured === false) avisos.push("sin WORKER_HEARTBEAT_TOKEN en Azure no se puede ver la caída de la GPU");
      if (lectura.mode !== null && lectura.mode !== "queue") avisos.push(`el backend está en modo ${lectura.mode}: no usa la cola ni los latidos`);
      if (lectura.modelWorkersAlive === 0) avisos.push("no hay ningún servidor del modelo vivo: enciende la GPU antes (bash deploy/clase.sh iniciar)");
      if ((lectura.modelWorkersAlive ?? 0) > 1) avisos.push(`hay ${lectura.modelWorkersAlive} servidores vivos: al apagar una GPU los demás siguen atendiendo y la caída no se verá; apágalos todos o anota el resultado`);
      return avisos;
    },
    describir: (lectura) => [
      describirHealth(lectura),
      `servidores vivos ${lectura.modelWorkersAlive ?? "sin dato"}`,
      `known_down ${siNo(lectura.modelWorkersKnownDown)}`,
      `/api/agent/health ${lectura.agentHealthStatus || "sin respuesta"}`,
    ].join(" · "),
    pasos: [
      {
        id: "caida",
        titulo: "Apaga la GPU (caso 1) o su worker (caso 4)",
        tipo: "manual",
        instrucciones: [
          "En Cloud Shell, una de estas (este comando no apaga nada por sí mismo):",
          "  VM_EDITORES=ninguna bash deploy/clase.sh terminar      (apaga solo las GPU)",
          "  gcloud compute instances stop <vm> --zone=<zona>",
          "Caso 4, dentro de la GPU: sudo systemctl stop adaceen-worker",
        ],
      },
      {
        id: "deteccion",
        titulo: "El backend ve la GPU caída",
        tipo: "auto",
        instrucciones: [
          "Espero model_workers_alive = 0 en /api/health o 503 en /api/agent/health.",
          "El latido vence a los 120 s y va cada 30 s: el backend lo ve entre 90 y 120 s después de que el worker se detiene.",
        ],
        condicion: (lectura) => (responde(lectura) && lectura.modelWorkersAlive === 0) || lectura.agentHealthStatus === 503,
        modo: "primera",
      },
      {
        id: "degradado",
        titulo: "El backend responde en modo degradado",
        tipo: "auto",
        instrucciones: [
          "Espero model_workers_known_down = true: el backend deja de encolar y responde en segundos.",
          "Mira VS Code: la barra dice «GPU: sin worker activo» y el tutor contesta «El tutor no esta disponible en este momento».",
        ],
        condicion: (lectura) => responde(lectura) && lectura.modelWorkersKnownDown === true,
        modo: "primera",
        desde: "caida",
      },
      {
        id: "recuperar",
        titulo: "Enciende una GPU (caso 2) o el worker (caso 4)",
        tipo: "manual",
        instrucciones: [
          "En Cloud Shell: VM_EDITORES=ninguna bash deploy/clase.sh iniciar   (o la opción 1 de ADACEEN-GPU.bat)",
          "Caso 4, dentro de la GPU: sudo systemctl start adaceen-worker",
        ],
      },
      {
        id: "recuperacion",
        titulo: "Vuelve un servidor del modelo",
        tipo: "auto",
        instrucciones: ["Espero model_workers_alive >= 1 en /api/health (llega con el primer latido de la GPU)."],
        condicion: (lectura) => responde(lectura) && (lectura.modelWorkersAlive ?? 0) >= 1,
        modo: "estable",
      },
    ],
    deteccionEsperada: {
      ms: LATIDO_VENCE_MS + MARGEN_COMANDO_MS,
      detalle: `${segundos(LATIDO_VENCE_MS)} hasta que vence el latido, ${segundos(MARGEN_COMANDO_MS)} de margen para el comando`,
    },
    filas: [
      {
        caso: "1. Desalojo",
        evaluar: ({ tiempos, def, intervaloMs }) => {
          if (tiempos.deteccionMs === null || tiempos.degradadoMs === null) {
            return { paso: false, detalle: tiempos.deteccionMs === null ? "no se vio la caída" : "no se vio el modo degradado (model_workers_known_down)" };
          }
          const meta = metaDeteccionMs(def, intervaloMs) as number;
          return {
            paso: tiempos.deteccionMs <= meta,
            detalle: `detección en ${formatDuration(tiempos.deteccionMs)} (esperado ≤ ${formatDuration(meta)}); degradado en ${formatDuration(tiempos.degradadoMs)}`,
          };
        },
      },
      {
        caso: "2. Recuperación",
        evaluar: ({ tiempos }) => tiempos.recuperacionMs === null
          ? { paso: false, detalle: "no volvió ningún servidor del modelo" }
          : { paso: true, detalle: `servidor vivo a los ${formatDuration(tiempos.recuperacionMs)} de encender; falta la prueba de humo (npm run demo:escenarios)` },
      },
    ],
  },
  editor: {
    titulo: "VM de editores desconectada, y recuperación",
    casos: "8",
    requisito: "workspace_provider = tunnel y workspace_agent_online = true",
    sano: (lectura) => responde(lectura) && lectura.workspaceAgentOnline === true,
    avisosBase: (lectura) => {
      const avisos: string[] = [];
      if (!responde(lectura)) avisos.push("el backend no responde en /api/health");
      if (lectura.workspaceProvider !== null && lectura.workspaceProvider !== "tunnel") avisos.push(`el proveedor de editores es ${lectura.workspaceProvider}, no tunnel: este escenario no aplica`);
      if (lectura.workspaceAgentOnline === null) avisos.push("/api/health no informa workspace_agent_online");
      if (lectura.workspaceAgentOnline === false) avisos.push("la VM de editores ya está desconectada: enciéndela antes (GPUS=ninguna bash deploy/clase.sh iniciar)");
      return avisos;
    },
    describir: (lectura) => [
      describirHealth(lectura),
      `agente de editores ${siNo(lectura.workspaceAgentOnline)}`,
      `proveedor ${lectura.workspaceProvider ?? "sin dato"}`,
    ].join(" · "),
    pasos: [
      {
        id: "caida",
        titulo: "Desconecta el agente de la VM de editores",
        tipo: "manual",
        instrucciones: [
          "En Cloud Shell (este comando no apaga nada por sí mismo):",
          "  gcloud compute ssh adaceen-ws --zone=us-central1-a --tunnel-through-iap --command='sudo systemctl stop adaceen-workspaces-agent'",
          "o apaga la VM: GPUS=ninguna bash deploy/clase.sh terminar",
        ],
      },
      {
        id: "deteccion",
        titulo: "El backend ve la VM desconectada",
        tipo: "auto",
        instrucciones: [
          "Espero workspace_agent_online = false en /api/health.",
          "El relay da al agente por conectado hasta 60 s después de su último sondeo, que dura hasta 25 s: el backend lo ve entre 60 y 85 s después de parar el agente.",
        ],
        condicion: (lectura) => responde(lectura) && lectura.workspaceAgentOnline === false,
        modo: "primera",
      },
      {
        id: "degradado",
        titulo: "El estudiante ve el aviso y la espera sigue",
        tipo: "manual",
        confirmacion: true,
        instrucciones: [
          "Con una cuenta de estudiante pulsa «Abrir mi editor». La ventana debe decir",
          `«${AGENT_UNREACHABLE_MESSAGE}»`,
          `(con el autoencendido: «${VM_STARTING_MESSAGE}») y seguir esperando.`,
        ],
      },
      {
        id: "recuperar",
        titulo: "Vuelve a conectar el agente",
        tipo: "manual",
        instrucciones: [
          "El mismo comando con start:",
          "  gcloud compute ssh adaceen-ws --zone=us-central1-a --tunnel-through-iap --command='sudo systemctl start adaceen-workspaces-agent'",
          "o, si apagaste la VM: GPUS=ninguna bash deploy/clase.sh iniciar",
        ],
      },
      {
        id: "recuperacion",
        titulo: "El backend ve la VM conectada otra vez",
        tipo: "auto",
        instrucciones: ["Espero workspace_agent_online = true. La ventana del estudiante debe abrir el editor sola."],
        condicion: (lectura) => responde(lectura) && lectura.workspaceAgentOnline === true,
        modo: "estable",
      },
    ],
    deteccionEsperada: {
      ms: RELAY_VENCE_MS + SONDEO_LARGO_MS + MARGEN_COMANDO_MS,
      detalle: `${segundos(RELAY_VENCE_MS)} sin sondeo del relay, hasta ${segundos(SONDEO_LARGO_MS)} del último sondeo largo, ${segundos(MARGEN_COMANDO_MS)} de margen para el comando`,
    },
    filas: [
      {
        caso: "8. VM de editores desconectada",
        evaluar: ({ tiempos, pasos, def, intervaloMs }) => {
          if (tiempos.deteccionMs === null) return { paso: false, detalle: "no se vio workspace_agent_online = false" };
          if (tiempos.recuperacionMs === null) return { paso: false, detalle: `detección en ${formatDuration(tiempos.deteccionMs)}; no volvió a conectarse` };
          const aviso = pasos.find((paso) => paso.id === "degradado");
          const visto = aviso?.estado === "ok";
          const meta = metaDeteccionMs(def, intervaloMs) as number;
          const aTiempo = tiempos.deteccionMs <= meta;
          return {
            paso: aTiempo && visto ? true : aTiempo ? null : false,
            detalle: `detección en ${formatDuration(tiempos.deteccionMs)} (esperado ≤ ${formatDuration(meta)}); aviso al estudiante ${visto ? `visto a los ${formatDuration(tiempos.degradadoMs)}` : "sin confirmar"}; reconexión a los ${formatDuration(tiempos.recuperacionMs)} de arrancar el agente`,
          };
        },
      },
    ],
  },
  azure: {
    titulo: "Caída breve del backend de Azure o de la red",
    casos: "5 y 10",
    requisito: "/api/health responde 200",
    sano: responde,
    avisosBase: (lectura) => responde(lectura) ? [] : ["el backend ya no responde en /api/health"],
    describir: (lectura) => [
      describirHealth(lectura),
      `servidores vivos ${lectura.modelWorkersAlive ?? "sin dato"}`,
      `agente de editores ${siNo(lectura.workspaceAgentOnline)}`,
    ].join(" · "),
    pasos: [
      {
        id: "caida",
        titulo: "Provoca la caída",
        tipo: "manual",
        instrucciones: [
          "Caso 10, fuera de clase: reinicia el App Service (el mismo comando del flujo de despliegue).",
          "Va en el Cloud Shell de Azure o en un equipo con az login (el Cloud Shell de Google no trae az):",
          "  az webapp restart --resource-group rg-adaceen-azure --name app-adaceen-api-eyder05232002",
          "o en el portal de Azure: App Service → reiniciar.",
          "Caso 5 (red de la sala): desconecta este equipo de la red.",
        ],
      },
      {
        id: "deteccion",
        titulo: "El backend deja de responder",
        tipo: "auto",
        instrucciones: ["Espero que /api/health deje de responder 200."],
        condicion: (lectura) => !responde(lectura),
        modo: "primera",
      },
      {
        id: "degradado",
        titulo: "Los clientes avisan sin romperse",
        tipo: "manual",
        confirmacion: true,
        instrucciones: [
          "Pide una pista en el overlay y en VS Code. El overlay debe avisar que no hay backend",
          "(«No se pudo conectar con el backend. Verifica la URL del backend o recarga la extension.» o «Tiempo de espera agotado (…s).»;",
          "si Azure contesta mientras reinicia, un error con «HTTP 502» o «HTTP 503»)",
          "y VS Code mostrar «pista local (el backend no respondio)».",
          "Si desconectaste la red, vuelve a conectarla después de marcar.",
        ],
      },
      {
        id: "recuperacion",
        titulo: "El backend vuelve a responder",
        tipo: "auto",
        instrucciones: ["Espero /api/health 200 con ok: true."],
        condicion: responde,
        modo: "estable",
        desde: "deteccion",
      },
      {
        id: "completo",
        titulo: "Vuelven los servidores y el agente de editores",
        tipo: "auto",
        instrucciones: ["Espero los servidores del modelo y el agente de editores que había al empezar (reaparecen con su siguiente latido)."],
        condicion: (lectura, base) => responde(lectura)
          && (!((base?.modelWorkersAlive ?? 0) >= 1) || (lectura.modelWorkersAlive ?? 0) >= 1)
          && (base?.workspaceAgentOnline !== true || lectura.workspaceAgentOnline === true),
        modo: "estable",
        desde: "recuperacion",
        soloSi: (base) => (base?.modelWorkersAlive ?? 0) >= 1 || base?.workspaceAgentOnline === true,
      },
    ],
    deteccionEsperada: null,
    filas: [
      {
        caso: "5 o 10. Caída del backend o de la red",
        evaluar: ({ tiempos, pasos }) => {
          if (tiempos.deteccionMs === null) return { paso: false, detalle: "no se vio la caída" };
          if (tiempos.recuperacionMs === null) return { paso: false, detalle: "el backend no volvió a responder" };
          const completo = pasos.find((paso) => paso.id === "completo");
          const aviso = pasos.find((paso) => paso.id === "degradado");
          return {
            paso: completo && completo.estado !== "ok" && completo.estado !== "no_aplica" ? false : aviso?.estado === "ok" ? true : null,
            detalle: [
              `fuera de servicio ${formatDuration(tiempos.fueraDeServicioMs)}`,
              `responde a los ${formatDuration(tiempos.recuperacionMs)} de la caída`,
              completo?.estado === "ok" ? `servicio completo a los ${formatDuration(tiempos.completoMs)}` : completo?.estado === "no_aplica" ? "sin servidores ni agente al empezar" : "sin servicio completo",
              `aviso de los clientes ${aviso?.estado === "ok" ? "visto" : "sin confirmar"}`,
            ].join("; "),
          };
        },
      },
    ],
  },
};

// ---------------------------------------------------------------- utilidades

/** 4,2 s | 42 s | 1 min 05 s */
export function formatDuration(ms: number | null) {
  if (ms === null || !Number.isFinite(ms)) return "—";
  const seconds = Math.max(0, ms) / 1000;
  if (seconds < 10) return `${seconds.toFixed(1).replace(".", ",")} s`;
  if (seconds < 60) return `${Math.round(seconds)} s`;
  const whole = Math.round(seconds);
  return `${Math.floor(whole / 60)} min ${String(whole % 60).padStart(2, "0")} s`;
}

function createWaker() {
  let waiters: Array<() => void> = [];
  return {
    wake() {
      const current = waiters;
      waiters = [];
      for (const resolve of current) resolve();
    },
    wait(ms: number) {
      return new Promise<void>((resolve) => {
        const done = () => {
          clearTimeout(timer);
          waiters = waiters.filter((item) => item !== done);
          resolve();
        };
        const timer = setTimeout(done, Math.max(1, ms));
        waiters.push(done);
      });
    },
  };
}

function toBool(value: unknown) {
  return typeof value === "boolean" ? value : null;
}

async function readHealth(baseUrl: string, escenario: Escenario, timeoutMs: number, stop: AbortSignal, t0: number): Promise<Lectura | null> {
  const started = Date.now();
  const signal = () => AbortSignal.any([stop, AbortSignal.timeout(timeoutMs)]);
  const health = (async () => {
    try {
      const response = await fetch(`${baseUrl}/api/health`, { signal: signal(), headers: { accept: "application/json" } });
      const text = await response.text();
      let data: Record<string, unknown> | null = null;
      try {
        const parsed = JSON.parse(text);
        data = parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : null;
      } catch {
        data = null;
      }
      return { status: response.status, data, error: null as string | null, ms: Date.now() - started };
    } catch (error) {
      return { status: 0, data: null, error: describeFetchError(error, timeoutMs), ms: Date.now() - started };
    }
  })();
  const agent = escenario === "gpu"
    ? (async () => {
      try {
        const response = await fetch(`${baseUrl}/api/agent/health`, { signal: signal() });
        await response.arrayBuffer().catch(() => undefined);
        return response.status;
      } catch {
        return 0;
      }
    })()
    : Promise.resolve(null);
  const [result, agentHealthStatus] = await Promise.all([health, agent]);
  if (stop.aborted) return null;
  const data = result.data;
  return {
    at: new Date(started).toISOString(),
    tMs: started - t0,
    status: result.status,
    ms: result.ms,
    error: result.error,
    ok: toBool(data?.ok),
    mode: typeof data?.mode === "string" ? data.mode : null,
    workerHeartbeatConfigured: toBool(data?.worker_heartbeat_configured),
    modelWorkersAlive: typeof data?.model_workers_alive === "number" ? data.model_workers_alive : null,
    modelWorkersKnownDown: toBool(data?.model_workers_known_down),
    workspaceProvider: typeof data?.workspace_provider === "string" ? data.workspace_provider : null,
    workspaceAgentOnline: toBool(data?.workspace_agent_online),
    agentHealthStatus,
  };
}

/** Momento (ms) de la primera lectura que cumple, o del inicio de la racha final que cumple. */
export function findMark(
  lecturas: Lectura[],
  desdeMs: number,
  t0: number,
  condicion: (lectura: Lectura) => boolean,
  modo: "primera" | "estable",
): number | null {
  const candidatas = lecturas.filter((lectura) => t0 + lectura.tMs >= desdeMs);
  if (modo === "primera") {
    const hit = candidatas.find(condicion);
    return hit ? t0 + hit.tMs : null;
  }
  if (!candidatas.length || !condicion(candidatas[candidatas.length - 1])) return null;
  let index = candidatas.length - 1;
  while (index > 0 && condicion(candidatas[index - 1])) index -= 1;
  return t0 + candidatas[index].tMs;
}

function computeTiempos(marcas: Map<PasoId, number>): Tiempos {
  const diff = (to: PasoId, from: PasoId | null) => {
    const end = marcas.get(to);
    const start = from ? marcas.get(from) : undefined;
    return end !== undefined && start !== undefined ? end - start : null;
  };
  const recuperarDesde: PasoId = marcas.has("recuperar") ? "recuperar" : "caida";
  return {
    deteccionMs: diff("deteccion", "caida"),
    degradadoMs: diff("degradado", "caida"),
    recuperacionMs: diff("recuperacion", recuperarDesde),
    fueraDeServicioMs: diff("recuperacion", "deteccion"),
    completoMs: diff("completo", "caida"),
  };
}

// ---------------------------------------------------------------- simulacro

export async function runSimulacro(options: SimulacroOptions): Promise<SimulacroResultado> {
  const def = ESCENARIO_DEFS[options.escenario];
  const backend = options.backendUrl.replace(/\/+$/, "");
  const intervaloMs = options.intervaloMs ?? 5_000;
  const timeoutMs = options.timeoutMs ?? 10_000;
  const limiteMs = options.limiteMs ?? 900_000;
  const progresoMs = options.progresoMs ?? 15_000;
  const output = options.output ?? process.stdout;
  const say = (line = "") => { output.write(`${line}\n`); };
  const t0 = Date.now();
  const clock = (ms: number) => `+${formatDuration(ms - t0)}`;

  // Registro: <salida>/simulacro-<escenario>-<fecha UTC>[-n].jsonl y .md
  const dir = path.resolve(process.cwd(), options.salida || "exportes");
  await fsp.mkdir(dir, { recursive: true });
  let baseName = `simulacro-${options.escenario}-${nowStamp(new Date(t0))}`;
  for (let suffix = 2; await fsp.stat(path.join(dir, `${baseName}.jsonl`)).then(() => true).catch(() => false); suffix += 1) {
    baseName = `simulacro-${options.escenario}-${nowStamp(new Date(t0))}-${suffix}`;
  }
  const registro = path.join(dir, `${baseName}.jsonl`);
  const resumen = path.join(dir, `${baseName}.md`);
  let writes = Promise.resolve();
  const append = (entry: Record<string, unknown>) => {
    const line = `${JSON.stringify(redactSecrets(entry))}\n`;
    writes = writes.then(() => fsp.appendFile(registro, line, "utf8"));
    return writes;
  };

  const events = createWaker();
  const pollerWaker = createWaker();
  const stopPolling = new AbortController();
  const lecturas: Lectura[] = [];
  let pasoActual = "base";
  let ultimaDescripcion = "";

  // Entrada del operador: cada linea con su hora de llegada.
  const lineas: Array<{ text: string; at: number }> = [];
  const pausas = options.pausas !== false && Boolean(options.input);
  let inputOpen = false;
  let rl: readline.Interface | null = null;
  if (pausas && options.input) {
    rl = readline.createInterface({ input: options.input, terminal: false });
    inputOpen = true;
    rl.on("line", (text) => { lineas.push({ text: text.trim().toLowerCase(), at: Date.now() }); events.wake(); });
    rl.on("close", () => { inputOpen = false; events.wake(); });
  }
  const onAbort = () => { events.wake(); };
  options.signal?.addEventListener("abort", onAbort);
  const aborted = () => options.signal?.aborted === true;

  await append({ evento: "inicio", at: new Date(t0).toISOString(), escenario: options.escenario, backend, intervaloMs, comando: options.comando || "" });
  say(`Simulacro «${def.titulo}» (casos ${def.casos} de ${CONTINGENCIA})`);
  say(`Backend ${backend}; consulta /api/health${options.escenario === "gpu" ? " y /api/agent/health" : ""} cada ${formatDuration(intervaloMs)}.`);
  if (def.deteccionEsperada) say(`Meta de detección desde tu Enter: ${describirMetaDeteccion(def, intervaloMs)}.`);
  say(`Registro: ${path.relative(process.cwd(), registro) || registro}`);
  say("Este comando solo lee: tú apagas y enciendes con los comandos que te muestro.");
  if (pausas) say("Enter marca el paso; «o» + Enter lo omite; «f» + Enter termina y guarda el registro.");

  const poller = (async () => {
    while (!stopPolling.signal.aborted) {
      const started = Date.now();
      const lectura = await readHealth(backend, options.escenario, timeoutMs, stopPolling.signal, t0);
      if (!lectura) break;
      lecturas.push(lectura);
      await append({ evento: "lectura", paso: pasoActual, ...lectura });
      const descripcion = def.describir(lectura);
      if (descripcion !== ultimaDescripcion) {
        say(`  [${clock(t0 + lectura.tMs)}] ${descripcion}`);
        ultimaDescripcion = descripcion;
      }
      events.wake();
      if (stopPolling.signal.aborted) break;
      await pollerWaker.wait(Math.max(0, intervaloMs - (Date.now() - started)));
    }
  })();

  while (!lecturas.length && !aborted()) await events.wait(1_000);
  const base = lecturas[0] ?? null;
  const baseSana = base ? def.sano(base) : false;
  const avisosBase = base ? def.avisosBase(base) : ["sin lectura inicial"];
  say();
  say(`Estado inicial: ${baseSana ? "sano" : "NO sano"} (hace falta ${def.requisito}).`);
  for (const aviso of avisosBase) say(`  AVISO: ${aviso}`);

  const marcas = new Map<PasoId, number>();
  const pasos: PasoResultado[] = [];
  let ultimaMarca = t0;
  let terminar = aborted();
  const aplicables = def.pasos.filter((paso) => !paso.soloSi || paso.soloSi(base));

  for (const paso of def.pasos) {
    if (paso.soloSi && !paso.soloSi(base)) {
      pasos.push({ id: paso.id, titulo: paso.titulo, tipo: paso.tipo, estado: "no_aplica", at: null, tMs: null });
      continue;
    }
    if (terminar) {
      pasos.push({ id: paso.id, titulo: paso.titulo, tipo: paso.tipo, estado: "pendiente", at: null, tMs: null });
      continue;
    }
    pasoActual = paso.id;
    const numero = aplicables.indexOf(paso) + 1;
    say();
    say(`Paso ${numero}/${aplicables.length}: ${paso.titulo}`);
    for (const linea of paso.instrucciones) say(`  ${linea}`);

    let estado: EstadoPaso = "pendiente";
    let atMs: number | null = null;
    if (paso.tipo === "manual") {
      if (pausas && inputOpen) say(paso.confirmacion ? "  Pulsa Enter cuando lo veas (o «o» + Enter si no se puede comprobar)." : "  Pulsa Enter en el momento en que lo lances.");
      for (;;) {
        const linea = lineas.shift();
        if (linea) {
          if (linea.text === "f") { estado = "interrumpido"; terminar = true; }
          else if (linea.text === "o") estado = "omitido";
          else { estado = "ok"; atMs = linea.at; }
          break;
        }
        if (aborted()) { estado = "interrumpido"; terminar = true; break; }
        if (!pausas || !inputOpen) {
          if (paso.confirmacion) estado = "omitido";
          else { estado = "ok"; atMs = Date.now(); }
          break;
        }
        await events.wait(1_000);
      }
    } else {
      const desdeMs = paso.desde ? (marcas.get(paso.desde) ?? ultimaMarca) : ultimaMarca;
      const inicioEspera = Date.now();
      let ultimoProgreso = inicioEspera;
      const condicion = (lectura: Lectura) => paso.condicion!(lectura, base);
      for (;;) {
        const hit = findMark(lecturas, desdeMs, t0, condicion, paso.modo || "primera");
        if (hit !== null) { estado = "ok"; atMs = hit; break; }
        let linea = lineas.shift();
        while (linea && estado === "pendiente") {
          if (linea.text === "f") { estado = "interrumpido"; terminar = true; }
          else if (linea.text === "o") estado = "omitido";
          else say(`  [${clock(Date.now())}] sigo esperando (${formatDuration(Date.now() - desdeMs)}): ${ultimaDescripcion}`);
          linea = estado === "pendiente" ? lineas.shift() : undefined;
        }
        if (estado !== "pendiente") break;
        if (aborted()) { estado = "interrumpido"; terminar = true; break; }
        if (Date.now() - inicioEspera >= limiteMs) { estado = "sin_detectar"; break; }
        if (Date.now() - ultimoProgreso >= progresoMs) {
          say(`  [${clock(Date.now())}] esperando (${formatDuration(Date.now() - desdeMs)})...`);
          ultimoProgreso = Date.now();
        }
        await events.wait(Math.min(intervaloMs, 1_000));
      }
    }
    if (estado === "ok" && atMs !== null) {
      marcas.set(paso.id, atMs);
      ultimaMarca = Math.max(ultimaMarca, atMs);
    }
    const resultadoPaso: PasoResultado = {
      id: paso.id,
      titulo: paso.titulo,
      tipo: paso.tipo,
      estado,
      at: atMs !== null ? new Date(atMs).toISOString() : null,
      tMs: atMs !== null ? atMs - t0 : null,
    };
    pasos.push(resultadoPaso);
    await append({ evento: "paso", ...resultadoPaso });
    const referencia = paso.id === "caida" || paso.id === "recuperar" ? "" : (() => {
      const desde = paso.id === "recuperacion" ? (marcas.get("recuperar") ?? marcas.get("caida")) : marcas.get("caida");
      return atMs !== null && desde !== undefined ? ` (${formatDuration(atMs - desde)} después de ${paso.id === "recuperacion" && marcas.has("recuperar") ? "encender" : "la caída"})` : "";
    })();
    const textoEstado: Record<EstadoPaso, string> = {
      ok: "listo",
      omitido: "omitido",
      sin_detectar: `sin detectar en ${formatDuration(limiteMs)}`,
      interrumpido: "interrumpido",
      pendiente: "pendiente",
      no_aplica: "no aplica",
    };
    say(`  -> ${textoEstado[estado]}${atMs !== null ? ` a las ${clock(atMs)}` : ""}${referencia}`);
  }

  stopPolling.abort();
  pollerWaker.wake();
  await poller;
  rl?.close();
  options.signal?.removeEventListener("abort", onAbort);

  const tiempos = computeTiempos(marcas);
  const filas = def.filas.map((fila) => ({ caso: fila.caso, ...fila.evaluar({ tiempos, pasos, def, intervaloMs }) }));
  const completo = pasos.every((paso) => paso.estado === "ok" || paso.estado === "no_aplica" || (paso.estado === "omitido" && paso.tipo === "manual"));
  const veredicto = !completo || filas.some((fila) => fila.paso === false)
    ? "no_paso" as const
    : filas.some((fila) => fila.paso === null) ? "por_confirmar" as const : "paso" as const;
  const resultado: SimulacroResultado = {
    escenario: options.escenario,
    titulo: def.titulo,
    backend,
    comando: options.comando || "",
    inicio: new Date(t0).toISOString(),
    fin: new Date().toISOString(),
    intervaloMs,
    base,
    baseSana,
    avisosBase,
    pasos,
    tiempos,
    filas,
    veredicto,
    lecturas: lecturas.length,
    archivos: { registro, resumen },
  };
  await append({ evento: "fin", at: resultado.fin, tiempos, filas, veredicto });
  await writes;
  await fsp.writeFile(resumen, renderSimulacroMarkdown(resultado, lecturas, def), "utf8");

  say();
  say(`Detección ${formatDuration(tiempos.deteccionMs)} | degradado ${formatDuration(tiempos.degradadoMs)} | recuperación ${formatDuration(tiempos.recuperacionMs)} | fuera de servicio ${formatDuration(tiempos.fueraDeServicioMs)}`);
  for (const fila of filas) say(`Caso ${fila.caso}: ${fila.paso === null ? "por confirmar" : fila.paso ? "pasó" : "NO pasó"} (${fila.detalle})`);
  say(`Resultado: ${veredicto === "paso" ? "pasó" : veredicto === "por_confirmar" ? "por confirmar" : "NO pasó"}. Resumen: ${path.relative(process.cwd(), resumen) || resumen}`);
  return resultado;
}

// ---------------------------------------------------------------- Markdown

const ESTADO_MD: Record<EstadoPaso, string> = {
  ok: "Hecho",
  omitido: "Omitido",
  sin_detectar: "Sin detectar",
  interrumpido: "Interrumpido",
  pendiente: "Pendiente",
  no_aplica: "No aplica",
};

const VEREDICTO_MD: Record<SimulacroResultado["veredicto"], string> = {
  paso: "pasó",
  por_confirmar: "por confirmar (falta una comprobación del operador)",
  no_paso: "no pasó",
};

function hora(iso: string | null) {
  return iso ? iso.slice(11, 19) : "—";
}

export function renderSimulacroMarkdown(resultado: SimulacroResultado, lecturas: Lectura[], def = ESCENARIO_DEFS[resultado.escenario]) {
  const t = resultado.tiempos;
  const lines = [
    `# Simulacro de contingencia: ${resultado.titulo} — ${resultado.inicio.slice(0, 16).replace("T", " ")} UTC`,
    "",
    "| | |",
    "|---|---|",
    "| Jira | A15.5 · ADACEEN-126 (contingencia), A13.6 · ADACEEN-114 (ensayo) |",
    `| Casos | ${def.casos} de ${CONTINGENCIA} |`,
    `| Backend | ${resultado.backend} |`,
    `| Ventana | ${resultado.inicio} → ${resultado.fin} |`,
    `| Comando | \`${resultado.comando || `npm run piloto:simulacro -- --backend ${resultado.backend} --escenario ${resultado.escenario}`}\` |`,
    `| Lecturas | ${resultado.lecturas}, cada ${formatDuration(resultado.intervaloMs)} (/api/health${resultado.escenario === "gpu" ? " y /api/agent/health" : ""}) |`,
    `| Estado inicial | ${resultado.baseSana ? "sano" : "NO sano"}: ${resultado.base ? def.describir(resultado.base) : "sin lectura"} |`,
    `| Resultado | ${VEREDICTO_MD[resultado.veredicto]} |`,
    "",
    "Las horas son UTC. Los eventos de un simulacro quedan fuera del análisis del piloto",
    "(fuera de los bloques, regla D4, o con la cuenta de prueba, D3): anota la ventana.",
    "",
  ];
  if (resultado.avisosBase.length) {
    lines.push("Avisos al empezar:", "", ...resultado.avisosBase.map((aviso) => `- ${aviso}`), "");
  }
  lines.push(
    "## Tiempos",
    "",
    "| Medida | Desde → hasta | Tiempo | Esperado |",
    "|---|---|---|---|",
    `| Detección | caída → primera lectura que la ve | ${formatDuration(t.deteccionMs)} | ${describirMetaDeteccion(def, resultado.intervaloMs)} |`,
    `| Degradado | caída → ${resultado.escenario === "gpu" ? "`model_workers_known_down: true`" : "el operador ve el aviso en el cliente"} | ${formatDuration(t.degradadoMs)} | ${resultado.escenario === "gpu" ? "la misma lectura que la detección" : "—"} |`,
    `| Recuperación | ${resultado.pasos.some((paso) => paso.id === "recuperar") ? "encender → primera lectura sana" : "caída → primera lectura sana"} | ${formatDuration(t.recuperacionMs)} | — |`,
    `| Fuera de servicio | detección → recuperación | ${formatDuration(t.fueraDeServicioMs)} | — |`,
  );
  if (resultado.pasos.some((paso) => paso.id === "completo")) {
    lines.push(`| Servicio completo | caída → servidores y agente de vuelta | ${formatDuration(t.completoMs)} | — |`);
  }
  lines.push(
    "",
    "## Para la tabla de la sección 9",
    "",
    "| Caso | ¿Pasó? | Detalle |",
    "|---|---|---|",
    ...resultado.filas.map((fila) => `| ${fila.caso} | ${fila.paso === null ? "Por confirmar" : fila.paso ? "Sí" : "No"} | ${fila.detalle.replace(/\|/g, "\\|")} |`),
    "",
    "## Pasos",
    "",
    "| # | Paso | Tipo | Hora | Desde el inicio | Estado |",
    "|---|---|---|---|---|---|",
    ...resultado.pasos.map((paso, index) => `| ${index + 1} | ${paso.titulo} | ${paso.tipo === "manual" ? "operador" : "automático"} | ${hora(paso.at)} | ${formatDuration(paso.tMs)} | ${ESTADO_MD[paso.estado]} |`),
    "",
    "## Cambios de estado",
    "",
    "| Hora | Desde el inicio | Lectura |",
    "|---|---|---|",
  );
  let previa = "";
  lecturas.forEach((lectura, index) => {
    const descripcion = def.describir(lectura);
    if (descripcion !== previa || index === lecturas.length - 1) {
      lines.push(`| ${hora(lectura.at)} | ${formatDuration(lectura.tMs)} | ${descripcion} |`);
      previa = descripcion;
    }
  });
  lines.push("", `Registro completo, una línea por lectura: \`${path.basename(resultado.archivos.registro)}\`.`, "");
  return redactText(lines.join("\n"));
}

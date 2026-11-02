// Autoencendido de la GPU cuando un estudiante pide ayuda (28-10-2026).
//
// De 6 a. m. a 11 p. m. la GPU no depende de esto: Google la enciende y la apaga con la
// programacion de instancias (deploy/gcp/horario-gpu.sh) y su apagado por inactividad no corre de
// dia. De noche (o si se cae de dia) no hay servidor vivo; con GPU_AUTOSTART=on, el pedido al tutor
// no se encola a esperar una respuesta que no llega (agent-mode.ts): se pide el encendido y el
// estudiante lee «El tutor se esta encendiendo. Vuelve a preguntar en 2 o 3 minutos...». Si no se
// puede encender, lee que el tutor no esta disponible. /api/health muestra el ultimo intento.
//
// Enciende con lo mismo que «Iniciar clase» (src/services/infra/class-start.ts): CLASS_GPU_VMS, las
// credenciales de Google Cloud y su pausa de 2 min por VM. registerClassRoutes registra el
// encendido al arrancar (setGpuStarterProvider); sin el (o sin GPU_AUTOSTART) no se enciende nada.
//
// Seguimiento (1-11-2026): Compute puede aceptar el start y no encender la VM (sin L4 en la zona o
// sin cuota: ZONE_RESOURCE_POOL_EXHAUSTED, QUOTA_EXCEEDED). Antes la siguiente GPU de
// CLASS_GPU_VMS solo se probaba cuando llegaba otro pedido; el 1-11 el backend probo cuatro veces la
// L4 sin cupo y nunca la copia, que si tenia. Ahora, tras un start aceptado, un temporizador propio
// mira poco despues de startFailAfterMs (90 s) si la GPU quedo encendida: si no, el encendedor la
// marca como fallida y prueba la siguiente, sin esperar a que el estudiante vuelva a preguntar.
import { env } from "../../config/env.js";
import type { ClassStarter } from "./class-start.js";
import { currentGpuSchedule, describeGpuSchedule, isWithinGpuSchedule } from "./gpu-schedule.js";

export type GpuStartState = "starting" | "unavailable";

export type GpuStartResult = {
  state: GpuStartState;
  /** GPU que se encendio o que ya estaba arrancando. */
  vm: string | null;
  /** Para el log y /api/health: por que no se pudo, o que se hizo. */
  detail: string;
};

export type GpuAutostartAttempt = GpuStartResult & { at: string; reason: string };

type StarterProvider = () => { starter: ClassStarter | null; problem: string };

let provider: StarterProvider | null = null;
let lastAttempt: GpuAutostartAttempt | null = null;
let lastResult: { at: number; result: GpuStartResult } | null = null;
let inFlight: Promise<GpuStartResult> | null = null;
/** El seguimiento pendiente (uno a la vez): que GPU se revisa y en que ronda. */
let followUp: { timer: ReturnType<typeof setTimeout>; vm: string; round: number } | null = null;

/** Cuanto se reutiliza el ultimo resultado: los pedidos seguidos no consultan Compute cada vez. */
const RESULT_CACHE_MS = 20_000;
/** Lo maximo que espera el estudiante la respuesta de Compute antes de leer «se esta encendiendo». */
const MAX_WAIT_MS = 8_000;
/** El seguimiento corre este margen despues de startFailAfterMs (o el mismo startFailAfterMs si es menor). */
const FOLLOW_UP_MARGIN_MS = 5_000;
/** Si la GPU sigue arrancando (PROVISIONING, STAGING) se vuelve a mirar, hasta estas rondas por start. */
const FOLLOW_UP_MAX_ROUNDS = 3;

/** Lo que dejo un intento, ademas de lo que ve el estudiante (para decidir el seguimiento). */
type Attempt = {
  result: GpuStartResult;
  /** Compute acepto un instances.start en este intento (de result.vm). */
  accepted: boolean;
  /** Una GPU ya esta RUNNING. */
  running: boolean;
  /** Ya hay un servidor del modelo con latido. */
  served: boolean;
  /** Cuando mirar si el start aceptado encendio la VM (startFailAfterMs del encendedor + margen). */
  followUpMs: number;
};

export function isGpuAutostartEnabled() {
  return ["on", "gcp", "true", "1", "si"].includes(env.gpuAutostart);
}

export function setGpuStarterProvider(next: StarterProvider | null) {
  provider = next;
}

/** Solo las pruebas. */
export function resetGpuAutostartForTests() {
  lastAttempt = null;
  lastResult = null;
  inFlight = null;
  if (followUp) clearTimeout(followUp.timer);
  followUp = null;
}

async function attemptStart(reason: string, options: { whenIdle?: boolean } = {}): Promise<Attempt> {
  const resolved = provider ? provider() : { starter: null, problem: "el encendido de la clase no esta registrado" };
  const nothing = { accepted: false, running: false, served: false, followUpMs: 0 };
  if (!resolved.starter) return { ...nothing, result: { state: "unavailable", vm: null, detail: resolved.problem || "sin GPU configurada (CLASS_GPU_VMS)" } };
  const failAfterMs = resolved.starter.startFailAfterMs;
  const followUpMs = failAfterMs + Math.min(FOLLOW_UP_MARGIN_MS, failAfterMs);
  try {
    const outcome = await resolved.starter.startGpu(`autoencendido del tutor: ${reason}`, options);
    const active = outcome.gpus.find((gpu) => gpu.state === "running" || gpu.state === "starting");
    const facts = {
      accepted: Boolean(active && active.state === "starting" && outcome.actions.includes(`instances.start ${active.name}`)),
      running: outcome.gpus.some((gpu) => gpu.state === "running"),
      served: outcome.modelWorkersAlive >= 1,
      followUpMs,
    };
    if (active) {
      return {
        ...facts,
        result: {
          state: "starting",
          vm: active.name,
          detail: outcome.actions.length ? `${outcome.actions.join(", ")} aceptado` : `${active.name} ya estaba ${active.state === "running" ? "encendida (el servidor del modelo arranca)" : "encendiendose"}`,
        },
      };
    }
    const problems = outcome.gpus.filter((gpu) => gpu.problem).map((gpu) => `${gpu.name}: ${gpu.problem}`);
    return { ...facts, result: { state: "unavailable", vm: null, detail: problems.join("; ") || "ninguna GPU acepto el encendido" } };
  } catch (error) {
    return { ...nothing, result: { state: "unavailable", vm: null, detail: String(error).slice(0, 240) } };
  }
}

/** Guarda el intento para /api/health y la cache de 20 s, y lo deja en el log. */
function record(result: GpuStartResult, reason: string) {
  lastResult = { at: Date.now(), result };
  lastAttempt = { ...result, at: new Date().toISOString(), reason };
  const line = `[gpu] autoencendido (${reason}): ${result.state === "starting" ? "encendiendo" : "no disponible"}; ${result.detail}`;
  if (result.state === "starting") console.info(line);
  else console.warn(line);
}

/**
 * Programa el seguimiento de un start aceptado. Uno solo pendiente: uno nuevo (otro start aceptado)
 * reemplaza al anterior, porque mira la GPU mas reciente. unref: no retiene el proceso.
 */
function scheduleFollowUp(vm: string, delayMs: number, round: number) {
  if (followUp) clearTimeout(followUp.timer);
  const timer = setTimeout(() => {
    followUp = null;
    void runFollowUp(vm, round).catch((error) => console.warn(`[gpu] seguimiento del autoencendido: ${String(error).slice(0, 240)}`));
  }, delayMs);
  timer.unref?.();
  followUp = { timer, vm, round };
}

/**
 * El seguimiento: vuelve a pedir el encendido al encendedor (startGpu), que mira si la GPU quedo
 * encendida. No hace nada si GPU_AUTOSTART se apago, si una GPU esta encendida o arrancando o si ya
 * hay servidor del modelo. Si la GPU no quedo encendida, el encendedor la marca como fallida y prueba
 * la siguiente: ese intento queda en /api/health (last_attempt) como cualquier otro.
 */
async function runFollowUp(vm: string, round: number) {
  if (!isGpuAutostartEnabled()) return;
  // Un pedido en curso primero (el encendedor atiende uno a la vez); despues se mira de nuevo. Si ese
  // pedido encendio otra GPU, ya programo su propio seguimiento: este sobra.
  while (inFlight) await inFlight.catch(() => undefined);
  if (!isGpuAutostartEnabled() || followUp) return;
  const reason = `seguimiento del autoencendido: ¿quedo encendida ${vm}?`;
  const run = attemptStart(reason, { whenIdle: true }).then((attempt) => {
    const { result } = attempt;
    if (attempt.accepted && result.vm) {
      // La GPU anterior no encendio y Compute acepto la siguiente: se registra y se sigue esta.
      record(result, reason);
      scheduleFollowUp(result.vm, attempt.followUpMs, 1);
    } else if (attempt.served || attempt.running) {
      console.info(`[gpu] ${reason} ${attempt.served ? "ya hay servidor del modelo" : `${result.vm} esta encendida`}: nada que hacer`);
    } else if (result.state === "starting") {
      // Sigue en PROVISIONING o STAGING: se mira otra vez (si se quedara sin cupo, se prueba la siguiente).
      if (round < FOLLOW_UP_MAX_ROUNDS && result.vm) scheduleFollowUp(result.vm, attempt.followUpMs, round + 1);
    } else {
      // Ninguna GPU encendio ni acepto: /api/health dice por que.
      record(result, reason);
    }
    return result;
  });
  inFlight = run.finally(() => {
    inFlight = null;
  });
  await inFlight;
}

/**
 * Pide encender una GPU (si GPU_AUTOSTART esta activo). Nunca lanza; responde en a lo sumo 8 s
 * (si Compute tarda mas, «se esta encendiendo» y el intento sigue). null si esta apagado.
 */
export async function requestGpuStart(reason: string, now = Date.now()): Promise<GpuStartResult | null> {
  if (!isGpuAutostartEnabled()) return null;
  if (lastResult && now - lastResult.at < RESULT_CACHE_MS) return lastResult.result;
  if (!inFlight) {
    inFlight = attemptStart(reason)
      .then((attempt) => {
        record(attempt.result, reason);
        // Compute acepto el start: poco despues de startFailAfterMs se mira si la VM encendio.
        if (attempt.accepted && attempt.result.vm) scheduleFollowUp(attempt.result.vm, attempt.followUpMs, 1);
        return attempt.result;
      })
      .finally(() => {
        inFlight = null;
      });
  }
  const pending = inFlight;
  const timeout = new Promise<GpuStartResult>((resolve) => {
    const timer = setTimeout(() => resolve({ state: "starting", vm: null, detail: "Compute no respondio a tiempo; el encendido sigue" }), MAX_WAIT_MS);
    pending.finally(() => clearTimeout(timer)).catch(() => undefined);
  });
  return Promise.race([pending, timeout]);
}

/** Lo que lee el estudiante mientras la GPU enciende (o si no se pudo). */
export function tutorStartingMessage(now: Date = new Date()) {
  const schedule = currentGpuSchedule();
  const night = schedule && !isWithinGpuSchedule(schedule, now);
  return night
    ? `El tutor se está encendiendo. Vuelve a preguntar en 2 o 3 minutos; ${describeGpuSchedule(schedule)} responde al instante.`
    : "El tutor se está encendiendo. Vuelve a preguntar en 2 o 3 minutos.";
}

/** Sin servidor del modelo y sin poder encenderlo (o sin autoencendido): no se queda esperando. */
export const TUTOR_UNAVAILABLE_MESSAGE =
  "El tutor no está disponible en este momento: el servidor del modelo no responde. Te dejo pistas generales; si sigue así, avisa a tu docente.";

/** Horario y autoencendido para /api/health, /empezar y el monitor del docente. */
export function describeGpuAutostart(now: Date = new Date()) {
  const schedule = currentGpuSchedule();
  return {
    enabled: isGpuAutostartEnabled(),
    schedule: schedule?.raw ?? null,
    schedule_text: schedule ? describeGpuSchedule(schedule) : null,
    timezone: schedule?.timezone ?? null,
    within_schedule: schedule ? isWithinGpuSchedule(schedule, now) : null,
    last_attempt: lastAttempt
      ? { at: lastAttempt.at, ok: lastAttempt.state === "starting", vm: lastAttempt.vm, detail: lastAttempt.detail, reason: lastAttempt.reason }
      : null,
  };
}

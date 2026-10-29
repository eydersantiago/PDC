// Autoencendido de la GPU cuando un estudiante pide ayuda (28-10-2026).
//
// De 6 a. m. a 11 p. m. la GPU no depende de esto: Google la enciende y la apaga con la
// programacion de instancias (deploy/gcp/horario-gpu.sh) y su apagado por inactividad no corre de
// dia. De noche (o si se cae de dia) no hay servidor vivo; con GPU_AUTOSTART=on, el pedido al tutor
// no se encola a esperar una respuesta que no llega (agent-mode.ts): se pide el encendido y el
// estudiante lee «El tutor se esta encendiendo. Vuelve a preguntar en 2 o 3 minutos...». Si no se
// puede encender, lee que el tutor no esta disponible. /api/health muestra el ultimo intento.
//
// Enciende con lo mismo que «Iniciar clase» (src/services/class-start.ts): CLASS_GPU_VMS, las
// credenciales de Google Cloud y su pausa de 2 min por VM. registerClassRoutes registra el
// encendido al arrancar (setGpuStarterProvider); sin el (o sin GPU_AUTOSTART) no se enciende nada.
import { env } from "../config/env.js";
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

/** Cuanto se reutiliza el ultimo resultado: los pedidos seguidos no consultan Compute cada vez. */
const RESULT_CACHE_MS = 20_000;
/** Lo maximo que espera el estudiante la respuesta de Compute antes de leer «se esta encendiendo». */
const MAX_WAIT_MS = 8_000;

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
}

async function attemptStart(reason: string): Promise<GpuStartResult> {
  const resolved = provider ? provider() : { starter: null, problem: "el encendido de la clase no esta registrado" };
  if (!resolved.starter) return { state: "unavailable", vm: null, detail: resolved.problem || "sin GPU configurada (CLASS_GPU_VMS)" };
  try {
    const outcome = await resolved.starter.startGpu(`autoencendido del tutor: ${reason}`);
    const active = outcome.gpus.find((gpu) => gpu.state === "running" || gpu.state === "starting");
    if (active) {
      return {
        state: "starting",
        vm: active.name,
        detail: outcome.actions.length ? `${outcome.actions.join(", ")} aceptado` : `${active.name} ya estaba ${active.state === "running" ? "encendida (el servidor del modelo arranca)" : "encendiendose"}`,
      };
    }
    const problems = outcome.gpus.filter((gpu) => gpu.problem).map((gpu) => `${gpu.name}: ${gpu.problem}`);
    return { state: "unavailable", vm: null, detail: problems.join("; ") || "ninguna GPU acepto el encendido" };
  } catch (error) {
    return { state: "unavailable", vm: null, detail: String(error).slice(0, 240) };
  }
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
      .then((result) => {
        lastResult = { at: Date.now(), result };
        lastAttempt = { ...result, at: new Date().toISOString(), reason };
        const line = `[gpu] autoencendido (${reason}): ${result.state === "starting" ? "encendiendo" : "no disponible"}; ${result.detail}`;
        if (result.state === "starting") console.info(line);
        else console.warn(line);
        return result;
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

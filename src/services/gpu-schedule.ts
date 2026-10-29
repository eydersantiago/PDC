// Horario del tutor (28-10-2026): la GPU encendida de 6 a. m. a 11 p. m. (GPU_SCHEDULE y
// GPU_SCHEDULE_TZ). Google la enciende y la apaga con una programacion de instancias
// (deploy/gcp/horario-gpu.sh); el backend solo necesita saber el horario para decirlo (/empezar,
// monitor del docente, /api/health) y para el mensaje de quien pide ayuda de noche.
// Modulo puro: la hora entra como parametro.
import { env } from "../config/env.js";
import { trimText } from "./text-utils.js";

export type GpuSchedule = {
  /** Minutos desde la medianoche, hora local de timezone. */
  startMinutes: number;
  endMinutes: number;
  timezone: string;
  /** "06:00-23:00", tal como se configura. */
  raw: string;
};

const SCHEDULE_RE = /^([01]?\d|2[0-3]):([0-5]\d)\s*-\s*([01]?\d|2[0-4]):([0-5]\d)$/;

function validTimezone(timezone: string) {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: timezone });
    return true;
  } catch {
    return false;
  }
}

/** Horario desde "HH:MM-HH:MM"; null si esta vacio. problem si no se entiende. */
export function parseGpuSchedule(raw: string, timezone = "America/Bogota"): { schedule: GpuSchedule | null; problem: string } {
  const text = trimText(raw);
  if (!text) return { schedule: null, problem: "" };
  const match = SCHEDULE_RE.exec(text);
  const zone = trimText(timezone) || "America/Bogota";
  if (!match) return { schedule: null, problem: `GPU_SCHEDULE=${text} no es valido: usa HH:MM-HH:MM, por ejemplo 06:00-23:00.` };
  if (!validTimezone(zone)) return { schedule: null, problem: `GPU_SCHEDULE_TZ=${zone} no es una zona horaria valida (por ejemplo America/Bogota).` };
  const startMinutes = Number(match[1]) * 60 + Number(match[2]);
  const endMinutes = Math.min(24 * 60, Number(match[3]) * 60 + Number(match[4]));
  if (endMinutes <= startMinutes) {
    return { schedule: null, problem: `GPU_SCHEDULE=${text}: la hora de fin tiene que ser despues de la de inicio (el mismo dia).` };
  }
  const pad = (value: number) => String(value).padStart(2, "0");
  const hhmm = (minutes: number) => `${pad(Math.floor(minutes / 60))}:${pad(minutes % 60)}`;
  return { schedule: { startMinutes, endMinutes, timezone: zone, raw: `${hhmm(startMinutes)}-${hhmm(endMinutes)}` }, problem: "" };
}

/** Minutos desde la medianoche en la zona del horario. */
export function localMinutes(now: Date, timezone: string) {
  const parts = new Intl.DateTimeFormat("en-US", { timeZone: timezone, hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).formatToParts(now);
  const hour = Number(parts.find((part) => part.type === "hour")?.value || 0) % 24;
  const minute = Number(parts.find((part) => part.type === "minute")?.value || 0);
  return hour * 60 + minute;
}

export function isWithinGpuSchedule(schedule: GpuSchedule, now: Date = new Date()) {
  const minutes = localMinutes(now, schedule.timezone);
  return minutes >= schedule.startMinutes && minutes < schedule.endMinutes;
}

/** 360 -> "6:00 a. m.", 1380 -> "11:00 p. m." (como se escribe en Colombia). */
export function formatClock(minutes: number) {
  const total = minutes % (24 * 60);
  const hour24 = Math.floor(total / 60);
  const minute = String(total % 60).padStart(2, "0");
  const suffix = hour24 < 12 ? "a. m." : "p. m.";
  const hour12 = hour24 % 12 === 0 ? 12 : hour24 % 12;
  return `${hour12}:${minute} ${suffix}`;
}

/** "de 6:00 a. m. a 11:00 p. m." */
export function describeGpuSchedule(schedule: GpuSchedule) {
  return `de ${formatClock(schedule.startMinutes)} a ${formatClock(schedule.endMinutes)}`;
}

let cached: { key: string; value: ReturnType<typeof parseGpuSchedule> } | null = null;

/** Horario del entorno (GPU_SCHEDULE, GPU_SCHEDULE_TZ); avisa una vez si esta mal escrito. */
export function currentGpuSchedule(): GpuSchedule | null {
  const key = `${env.gpuSchedule}|${env.gpuScheduleTimezone}`;
  if (!cached || cached.key !== key) {
    cached = { key, value: parseGpuSchedule(env.gpuSchedule, env.gpuScheduleTimezone) };
    if (cached.value.problem) console.warn(`[config] ${cached.value.problem} El horario del tutor no se muestra.`);
  }
  return cached.value.schedule;
}

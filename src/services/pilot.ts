import { createHash } from "node:crypto";

/**
 * Piloto con y sin tutor (A13.1): diseno intra-sujeto contrabalanceado AB/BA.
 *
 * Cada estudiante trabaja dos bloques con ejercicios comparables: uno con el
 * tutor y otro sin el. La mitad del grupo (cohorte A) empieza con el tutor y
 * la otra mitad (cohorte B) sin el. El docente (o quien opera el piloto)
 * cambia de bloque desde el overlay o con `npm run piloto:bloque`.
 *
 *   bloque 1: A con tutor, B sin tutor
 *   bloque 2: A sin tutor, B con tutor
 *
 * Con el tutor apagado, el motor responde un mensaje controlado sin llamar al
 * modelo (reasonCode pilot_no_tutor) y no deja aplicar codigo. Las senales de
 * error y bloqueo se siguen registrando: son la linea base del tiempo hasta
 * desbloqueo. Cada evento de telemetria de un estudiante lleva el bloque, la
 * cohorte y la condicion vigentes al recibirlo.
 */

export type PilotCohort = "A" | "B";
export type PilotBlock = 0 | 1 | 2;
export type PilotCondition = "con_tutor" | "sin_tutor";

export type PilotStudentState = {
  block: PilotBlock;
  cohort: PilotCohort | "";
  condition: PilotCondition | "";
};

export const NO_PILOT: PilotStudentState = { block: 0, cohort: "", condition: "" };

export const PILOT_NO_TUTOR_REASON = "Bloque del piloto sin tutor.";
export const PILOT_NO_TUTOR_MESSAGE =
  "En este bloque del piloto trabajas sin el tutor. Sigue con tu ejercicio como lo harias en clase; el tutor vuelve en el siguiente bloque.";

export function normalizePilotBlock(value: unknown): PilotBlock {
  const parsed = Number(value);
  return parsed === 1 || parsed === 2 ? parsed : 0;
}

export function normalizePilotCohort(value: unknown): PilotCohort | "" {
  const clean = String(value || "").trim().toUpperCase();
  return clean === "A" || clean === "B" ? clean : "";
}

/** Condicion de una cohorte en un bloque; vacia fuera del piloto o sin cohorte. */
export function pilotConditionFor(cohort: PilotCohort | "" | null | undefined, block: number): PilotCondition | "" {
  if (block !== 1 && block !== 2) return "";
  if (cohort !== "A" && cohort !== "B") return "";
  const withTutorFirst = cohort === "A";
  return (block === 1) === withTutorFirst ? "con_tutor" : "sin_tutor";
}

export function pilotStateFor(cohort: string | null | undefined, block: number): PilotStudentState {
  const normalizedBlock = normalizePilotBlock(block);
  const normalizedCohort = normalizePilotCohort(cohort);
  return {
    block: normalizedBlock,
    cohort: normalizedCohort,
    condition: pilotConditionFor(normalizedCohort, normalizedBlock),
  };
}

/** Generador pseudoaleatorio con semilla (mulberry32): la asignacion se puede reproducir. */
export function seededRandom(seed: string) {
  const digest = createHash("sha256").update(seed).digest();
  let state = digest.readUInt32LE(0);
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export type PilotAssignment = { studentUserId: string; cohort: PilotCohort };

/**
 * Asigna cohortes A/B de forma balanceada y aleatoria.
 *
 * - Respeta las asignaciones existentes (salvo reset): un estudiante no
 *   cambia de cohorte a mitad del piloto.
 * - Los nuevos se barajan con la semilla y van, uno a uno, a la cohorte con
 *   menos estudiantes (empate: la que diga el generador).
 * - Con la misma lista, las mismas asignaciones previas y la misma semilla,
 *   el resultado es identico (queda en el acta del piloto).
 */
export function assignPilotCohorts(input: {
  studentUserIds: string[];
  existing: PilotAssignment[];
  seed: string;
  reset?: boolean;
}): { assignments: PilotAssignment[]; added: PilotAssignment[]; counts: Record<PilotCohort, number> } {
  const random = seededRandom(input.seed);
  const active = [...new Set(input.studentUserIds.filter(Boolean))].sort();
  const activeSet = new Set(active);
  const kept = input.reset
    ? []
    : input.existing.filter((item) => activeSet.has(item.studentUserId) && (item.cohort === "A" || item.cohort === "B"));
  const keptIds = new Set(kept.map((item) => item.studentUserId));
  const pending = active.filter((id) => !keptIds.has(id));

  // Fisher-Yates con la semilla.
  for (let index = pending.length - 1; index > 0; index -= 1) {
    const swap = Math.floor(random() * (index + 1));
    [pending[index], pending[swap]] = [pending[swap], pending[index]];
  }

  const counts: Record<PilotCohort, number> = { A: 0, B: 0 };
  for (const item of kept) counts[item.cohort] += 1;
  const added: PilotAssignment[] = [];
  for (const studentUserId of pending) {
    let cohort: PilotCohort;
    if (counts.A < counts.B) cohort = "A";
    else if (counts.B < counts.A) cohort = "B";
    else cohort = random() < 0.5 ? "A" : "B";
    counts[cohort] += 1;
    added.push({ studentUserId, cohort });
  }
  return { assignments: [...kept, ...added], added, counts };
}

export function describePilotBlock(block: PilotBlock) {
  if (block === 1) return "Bloque 1: grupo A con tutor, grupo B sin tutor.";
  if (block === 2) return "Bloque 2: grupo A sin tutor, grupo B con tutor.";
  return "Sin piloto activo: el tutor funciona para todos.";
}

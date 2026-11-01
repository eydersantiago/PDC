// KPIs: episodios de bloqueo y desbloqueo (P1, P2), comparacion entre condiciones y analisis del cruce AB/BA.
import { mannWhitneyU, median, round, wilcoxonSignedRank } from "../analytics/stats.js";
import type { WilcoxonResult } from "../analytics/stats.js";
import type { TelemetryEventRow } from "../telemetry/telemetry.js";
import { metadataValue, formatNumber, result, formatP } from "./kpi-format.js";

// --- Episodios de bloqueo (P1, P2) --------------------------------------------

export type UnblockingEpisode = {
  actor: string;
  cohort: string;
  condition: string;
  block: number | null;
  detectedAt: string | null;
  resolvedAt: string | null;
  durationMs: number | null;
  resolved: boolean;
  resolvedWhileAway: boolean;
  /** Empezo en un bloque y termino en otro: no entra en P1. */
  crossesBlock: boolean;
  /** Se cerro sin su blocking_detected (perdido o fuera de la ventana). */
  withoutDetection: boolean;
};

/** Holgura para emparejar la deteccion con la aparicion del error (mismo reloj del cliente). */
export const PAIRING_TOLERANCE_MS = 15_000;

/**
 * Empareja cada blocking_resolved con su blocking_detected: mismo
 * estudiante, sesion de VS Code, error (hash normalizado) y ejercicio, y una
 * deteccion posterior a la aparicion del error (resolvedAt - durationMs). Si
 * hay varias abiertas gana la mas reciente: una deteccion vieja sin cierre
 * (evento perdido, archivo abandonado) no se pega al episodio siguiente del
 * mismo error. La condicion es la del inicio del episodio.
 */
export function extractUnblockingEpisodes(rows: TelemetryEventRow[]): UnblockingEpisode[] {
  const relevant = rows
    .filter((row) => row.source === "vscode_extension" && (row.eventType === "blocking_detected" || row.eventType === "blocking_resolved"))
    .sort((a, b) => Date.parse(a.occurredAt) - Date.parse(b.occurredAt) || (a.seq ?? 0) - (b.seq ?? 0));
  const open = new Map<string, UnblockingEpisode[]>();
  const episodes: UnblockingEpisode[] = [];
  for (const row of relevant) {
    const key = [row.actorAnonId, row.clientSessionId, row.errorHash, row.exerciseHash].join("|");
    if (row.eventType === "blocking_detected") {
      const episode: UnblockingEpisode = {
        actor: row.actorAnonId,
        cohort: row.pilotCohort,
        condition: row.pilotCondition,
        block: row.pilotBlock,
        detectedAt: row.occurredAt,
        resolvedAt: null,
        durationMs: null,
        resolved: false,
        resolvedWhileAway: false,
        crossesBlock: false,
        withoutDetection: false,
      };
      const list = open.get(key) || [];
      list.push(episode);
      open.set(key, list);
      episodes.push(episode);
      continue;
    }
    const list = open.get(key) || [];
    const resolvedAtMs = Date.parse(row.occurredAt);
    const firstSeenMs = row.durationMs !== null ? resolvedAtMs - row.durationMs : Number.NEGATIVE_INFINITY;
    let chosen = -1;
    for (let index = list.length - 1; index >= 0; index -= 1) {
      const detectedAtMs = Date.parse(list[index].detectedAt as string);
      if (detectedAtMs <= resolvedAtMs + PAIRING_TOLERANCE_MS && detectedAtMs >= firstSeenMs - PAIRING_TOLERANCE_MS) {
        chosen = index;
        break;
      }
    }
    const episode = chosen >= 0 ? list.splice(chosen, 1)[0] : undefined;
    if (list.length === 0) open.delete(key);
    const durationMs = row.durationMs;
    const away = metadataValue(row, "resolvedWhileAway") === true;
    if (episode) {
      episode.resolved = true;
      episode.resolvedAt = row.occurredAt;
      episode.durationMs = durationMs;
      episode.resolvedWhileAway = away;
      episode.crossesBlock = (episode.block ?? null) !== (row.pilotBlock ?? null);
    } else {
      episodes.push({
        actor: row.actorAnonId,
        cohort: row.pilotCohort,
        condition: row.pilotCondition,
        block: row.pilotBlock,
        detectedAt: null,
        resolvedAt: row.occurredAt,
        durationMs,
        resolved: true,
        resolvedWhileAway: away,
        crossesBlock: false,
        withoutDetection: true,
      });
    }
  }
  return episodes;
}

export type UnblockingComparison = {
  pairedStudents: number;
  medianWithTutorS: number | null;
  medianWithoutTutorS: number | null;
  reductionPct: number | null;
  wilcoxon: WilcoxonResult;
  perStudent: Array<{ actor: string; cohort: string; withTutorS: number; withoutTutorS: number }>;
};

/** P1: medianas por estudiante en cada condicion, pareadas. */
export function compareUnblocking(episodes: UnblockingEpisode[], options: { excludeAway?: boolean; cohort?: string } = {}): UnblockingComparison {
  const byActor = new Map<string, { cohort: string; con: number[]; sin: number[] }>();
  for (const episode of episodes) {
    if (!episode.resolved || episode.crossesBlock || episode.durationMs === null) continue;
    if (options.excludeAway && episode.resolvedWhileAway) continue;
    if (episode.condition !== "con_tutor" && episode.condition !== "sin_tutor") continue;
    if (options.cohort && episode.cohort !== options.cohort) continue;
    const entry = byActor.get(episode.actor) || { cohort: episode.cohort, con: [], sin: [] };
    (episode.condition === "con_tutor" ? entry.con : entry.sin).push(episode.durationMs / 1000);
    byActor.set(episode.actor, entry);
  }
  const perStudent = [...byActor.entries()]
    .filter(([, entry]) => entry.con.length && entry.sin.length)
    .map(([actor, entry]) => ({
      actor,
      cohort: entry.cohort,
      withTutorS: median(entry.con) as number,
      withoutTutorS: median(entry.sin) as number,
    }));
  const withTutor = median(perStudent.map((item) => item.withTutorS));
  const withoutTutor = median(perStudent.map((item) => item.withoutTutorS));
  const reduction = withTutor !== null && withoutTutor !== null && withoutTutor > 0
    ? (1 - withTutor / withoutTutor) * 100
    : null;
  return {
    pairedStudents: perStudent.length,
    medianWithTutorS: withTutor,
    medianWithoutTutorS: withoutTutor,
    reductionPct: reduction,
    wilcoxon: wilcoxonSignedRank(perStudent.map((item) => [item.withTutorS, item.withoutTutorS])),
    perStudent,
  };
}

export type CrossoverAnalysis = {
  studentsA: number;
  studentsB: number;
  /** Efecto del tutor (con - sin) en segundos: negativo = menos tiempo con tutor. */
  treatmentEffectS: number | null;
  pTreatment: number | null;
  /** Efecto de periodo (bloque 1 - bloque 2) en segundos. */
  periodEffectS: number | null;
  pPeriod: number | null;
  method: string;
};

/**
 * Analisis clasico del cruzado AB/BA (Hills y Armitage): por estudiante,
 * d = mediana del bloque 1 - mediana del bloque 2. Para la cohorte A
 * d = (con - sin) + periodo y para la B d = (sin - con) + periodo, asi que el
 * efecto del tutor es (d_A - d_B) / 2 y se prueba con Mann-Whitney entre
 * cohortes; el de periodo es (d_A + d_B) / 2 (d_A contra -d_B). Complementa
 * la prueba pareada de P1 cuando hay efecto de orden.
 */
export function crossoverAnalysis(episodes: UnblockingEpisode[]): CrossoverAnalysis {
  const byStudent = new Map<string, { cohort: string; block1: number[]; block2: number[] }>();
  for (const episode of episodes) {
    if (!episode.resolved || episode.crossesBlock || episode.durationMs === null) continue;
    if (episode.block !== 1 && episode.block !== 2) continue;
    if (episode.cohort !== "A" && episode.cohort !== "B") continue;
    const entry = byStudent.get(episode.actor) || { cohort: episode.cohort, block1: [], block2: [] };
    (episode.block === 1 ? entry.block1 : entry.block2).push(episode.durationMs / 1000);
    byStudent.set(episode.actor, entry);
  }
  const differences = { A: [] as number[], B: [] as number[] };
  for (const entry of byStudent.values()) {
    if (!entry.block1.length || !entry.block2.length) continue;
    differences[entry.cohort as "A" | "B"].push((median(entry.block1) as number) - (median(entry.block2) as number));
  }
  const medianA = median(differences.A);
  const medianB = median(differences.B);
  const treatment = mannWhitneyU(differences.A, differences.B);
  const period = mannWhitneyU(differences.A, differences.B.map((value) => -value));
  return {
    studentsA: differences.A.length,
    studentsB: differences.B.length,
    treatmentEffectS: medianA !== null && medianB !== null ? (medianA - medianB) / 2 : null,
    pTreatment: treatment.p,
    periodEffectS: medianA !== null && medianB !== null ? (medianA + medianB) / 2 : null,
    pPeriod: period.p,
    method: treatment.method,
  };
}

export function unblockingKpis(rows: TelemetryEventRow[]) {
  const episodes = extractUnblockingEpisodes(rows);
  const comparison = compareUnblocking(episodes);
  const withoutAway = compareUnblocking(episodes, { excludeAway: true });
  const byCohort = {
    A: compareUnblocking(episodes, { cohort: "A" }),
    B: compareUnblocking(episodes, { cohort: "B" }),
  };
  const withCondition = episodes.filter((episode) => episode.condition === "con_tutor" || episode.condition === "sin_tutor");
  const resolution: Record<string, { detected: number; resolved: number; ratePct: number | null }> = {};
  for (const condition of ["con_tutor", "sin_tutor"]) {
    const detected = withCondition.filter((episode) => episode.condition === condition && !episode.withoutDetection);
    const resolved = detected.filter((episode) => episode.resolved && !episode.crossesBlock);
    resolution[condition] = { detected: detected.length, resolved: resolved.length, ratePct: detected.length ? round((resolved.length / detected.length) * 100, 1) : null };
  }
  const crossing = episodes.filter((episode) => episode.crossesBlock).length;
  const censored = withCondition.filter((episode) => !episode.resolved).length;

  let p1Summary: string;
  if (!comparison.pairedStudents) {
    p1Summary = "Sin estudiantes con episodios resueltos en las dos condiciones.";
  } else {
    const significance = comparison.wilcoxon.p === null
      ? ""
      : comparison.wilcoxon.p < 0.05
        ? ` La diferencia es estadísticamente significativa (Wilcoxon ${comparison.wilcoxon.method}, p = ${formatP(comparison.wilcoxon.p)}).`
        : ` La diferencia no es estadísticamente significativa (Wilcoxon ${comparison.wilcoxon.method}, p = ${formatP(comparison.wilcoxon.p)}).`;
    p1Summary = `Mediana con tutor ${formatNumber(comparison.medianWithTutorS, 0)} s y sin tutor ${formatNumber(comparison.medianWithoutTutorS, 0)} s en ${comparison.pairedStudents} estudiantes: reducción de ${formatNumber(comparison.reductionPct, 1)} %.${significance} Sin los episodios corregidos desde otro archivo: ${formatNumber(withoutAway.reductionPct, 1)} %.`;
  }
  const bothRates = resolution.con_tutor.ratePct !== null && resolution.sin_tutor.ratePct !== null;
  return {
    episodes,
    comparison,
    results: [
      result("P1", comparison.reductionPct, comparison.pairedStudents || null, p1Summary, {
        withoutAway: { reductionPct: round(withoutAway.reductionPct, 1), pairedStudents: withoutAway.pairedStudents },
        byCohort: {
          A: { reductionPct: round(byCohort.A.reductionPct, 1), pairedStudents: byCohort.A.pairedStudents },
          B: { reductionPct: round(byCohort.B.reductionPct, 1), pairedStudents: byCohort.B.pairedStudents },
        },
        wilcoxon: comparison.wilcoxon,
        crossover: crossoverAnalysis(episodes),
        crossingEpisodes: crossing,
        censoredEpisodes: censored,
      }),
      result("P2", resolution.con_tutor.ratePct, resolution.con_tutor.detected + resolution.sin_tutor.detected || null, bothRates
        ? `Resueltos con tutor ${formatNumber(resolution.con_tutor.ratePct, 1)} % (${resolution.con_tutor.resolved}/${resolution.con_tutor.detected}) y sin tutor ${formatNumber(resolution.sin_tutor.ratePct, 1)} % (${resolution.sin_tutor.resolved}/${resolution.sin_tutor.detected}). El valor es el de la condición con tutor.`
        : "Sin episodios de bloqueo con condición del piloto.", { resolution }),
    ],
  };
}

/** Lo que usa el informe para las graficas de P1. */
export function unblockingDetail(rows: TelemetryEventRow[]) {
  const episodes = extractUnblockingEpisodes(rows);
  return { episodes, comparison: compareUnblocking(episodes) };
}

/**
 * Estadistica pequena para el analisis del piloto (A14.4). Sin dependencias,
 * para que el backend, los scripts y las pruebas calculen lo mismo.
 */

export function finiteValues(values: Array<number | null | undefined>) {
  return values.filter((value): value is number => typeof value === "number" && Number.isFinite(value));
}

export function mean(values: number[]) {
  const clean = finiteValues(values);
  return clean.length ? clean.reduce((sum, value) => sum + value, 0) / clean.length : null;
}

export function standardDeviation(values: number[]) {
  const clean = finiteValues(values);
  if (clean.length < 2) return null;
  const average = clean.reduce((sum, value) => sum + value, 0) / clean.length;
  const variance = clean.reduce((sum, value) => sum + (value - average) ** 2, 0) / (clean.length - 1);
  return Math.sqrt(variance);
}

/**
 * Percentil con interpolacion lineal entre rangos (p en 0..100). Es el mismo
 * metodo de PERCENTIL.INC en Excel y del percentil por defecto de numpy.
 */
export function percentile(values: number[], p: number) {
  const sorted = finiteValues(values).sort((a, b) => a - b);
  if (!sorted.length) return null;
  if (sorted.length === 1) return sorted[0];
  const position = (Math.min(100, Math.max(0, p)) / 100) * (sorted.length - 1);
  const lower = Math.floor(position);
  const upper = Math.ceil(position);
  return sorted[lower] + (sorted[upper] - sorted[lower]) * (position - lower);
}

export function median(values: number[]) {
  return percentile(values, 50);
}

/** Funcion de distribucion normal estandar (Abramowitz y Stegun 7.1.26, error < 1,5e-7). */
export function normalCdf(z: number) {
  const sign = z < 0 ? -1 : 1;
  const x = Math.abs(z) / Math.SQRT2;
  const t = 1 / (1 + 0.3275911 * x);
  const erf = 1 - (((((1.061405429 * t - 1.453152027) * t) + 1.421413741) * t - 0.284496736) * t + 0.254829592) * t * Math.exp(-x * x);
  return 0.5 * (1 + sign * erf);
}

export type WilcoxonResult = {
  /** Pares con diferencia distinta de cero (los empates exactos se descartan). */
  n: number;
  wPlus: number;
  wMinus: number;
  /** p bilateral; null si no hay pares. */
  p: number | null;
  method: "exacto" | "aproximacion normal" | "sin datos";
  /**
   * Correlacion biserial de rangos (W+ - W-) / (n(n+1)/2), entre -1 y 1.
   * Negativa: el primer valor de cada par tiende a ser menor.
   */
  rankBiserial: number | null;
};

/**
 * Prueba de rangos con signo de Wilcoxon para datos pareados (x, y).
 * Exacta para n <= 30 sin empates; si no, aproximacion normal con correccion
 * por empates y por continuidad.
 */
export function wilcoxonSignedRank(pairs: Array<[number, number]>): WilcoxonResult {
  const diffs = pairs
    .map(([x, y]) => x - y)
    .filter((difference) => Number.isFinite(difference) && difference !== 0);
  const n = diffs.length;
  if (n === 0) return { n: 0, wPlus: 0, wMinus: 0, p: null, method: "sin datos", rankBiserial: null };

  const ordered = diffs.map((difference, index) => ({ index, size: Math.abs(difference) })).sort((a, b) => a.size - b.size);
  const ranks = new Array<number>(n);
  let tieCorrection = 0;
  for (let start = 0; start < n;) {
    let end = start;
    while (end + 1 < n && ordered[end + 1].size === ordered[start].size) end += 1;
    const averageRank = (start + end + 2) / 2;
    for (let position = start; position <= end; position += 1) ranks[ordered[position].index] = averageRank;
    const tied = end - start + 1;
    if (tied > 1) tieCorrection += tied ** 3 - tied;
    start = end + 1;
  }

  let wPlus = 0;
  let wMinus = 0;
  diffs.forEach((difference, index) => {
    if (difference > 0) wPlus += ranks[index];
    else wMinus += ranks[index];
  });
  const total = (n * (n + 1)) / 2;
  let p: number;
  let method: WilcoxonResult["method"];
  if (tieCorrection === 0 && n <= 30) {
    // Distribucion exacta de W+ bajo H0: cuantos subconjuntos de {1..n} suman s.
    const counts = new Array<number>(total + 1).fill(0);
    counts[0] = 1;
    for (let rank = 1; rank <= n; rank += 1) {
      for (let sum = total; sum >= rank; sum -= 1) counts[sum] += counts[sum - rank];
    }
    const smaller = Math.min(wPlus, wMinus);
    let cumulative = 0;
    for (let sum = 0; sum <= smaller; sum += 1) cumulative += counts[sum];
    p = Math.min(1, (2 * cumulative) / 2 ** n);
    method = "exacto";
  } else {
    const expected = total / 2;
    const variance = (n * (n + 1) * (2 * n + 1)) / 24 - tieCorrection / 48;
    const z = variance > 0 ? Math.max(0, Math.abs(wPlus - expected) - 0.5) / Math.sqrt(variance) : 0;
    p = Math.min(1, 2 * (1 - normalCdf(z)));
    method = "aproximacion normal";
  }
  return { n, wPlus, wMinus, p, method, rankBiserial: (wPlus - wMinus) / total };
}

export function round(value: number | null | undefined, digits = 2) {
  if (value === null || value === undefined || !Number.isFinite(value)) return null;
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
}

export type MannWhitneyResult = {
  n1: number;
  n2: number;
  /** U del primer grupo. */
  u1: number;
  p: number | null;
  method: "exacto" | "aproximacion normal" | "sin datos";
  /** Correlacion biserial de rangos: positiva si el primer grupo tiende a ser mayor. */
  rankBiserial: number | null;
};

/**
 * Prueba U de Mann-Whitney para dos grupos independientes. Exacta sin empates
 * y con n1 * n2 <= 400; si no, aproximacion normal con correccion por empates
 * y por continuidad.
 */
export function mannWhitneyU(first: number[], second: number[]): MannWhitneyResult {
  const a = finiteValues(first);
  const b = finiteValues(second);
  const n1 = a.length;
  const n2 = b.length;
  if (!n1 || !n2) return { n1, n2, u1: 0, p: null, method: "sin datos", rankBiserial: null };

  const all = [...a.map((value) => ({ value, group: 0 })), ...b.map((value) => ({ value, group: 1 }))].sort((x, y) => x.value - y.value);
  let rankSumFirst = 0;
  let tieCorrection = 0;
  for (let start = 0; start < all.length;) {
    let end = start;
    while (end + 1 < all.length && all[end + 1].value === all[start].value) end += 1;
    const averageRank = (start + end + 2) / 2;
    for (let position = start; position <= end; position += 1) {
      if (all[position].group === 0) rankSumFirst += averageRank;
    }
    const tied = end - start + 1;
    if (tied > 1) tieCorrection += tied ** 3 - tied;
    start = end + 1;
  }
  const u1 = rankSumFirst - (n1 * (n1 + 1)) / 2;
  const u2 = n1 * n2 - u1;
  const smaller = Math.min(u1, u2);
  let p: number;
  let method: MannWhitneyResult["method"];
  if (tieCorrection === 0 && n1 * n2 <= 400) {
    // counts[i][j][u]: formas de obtener U con i y j observaciones (recurrencia de Mann y Whitney).
    const maxU = n1 * n2;
    // Con 0 observaciones en el primer grupo, U solo puede valer 0.
    let previous: number[][] = Array.from({ length: n2 + 1 }, () => {
      const row = new Array<number>(maxU + 1).fill(0);
      row[0] = 1;
      return row;
    });
    for (let i = 1; i <= n1; i += 1) {
      const current: number[][] = Array.from({ length: n2 + 1 }, () => new Array<number>(maxU + 1).fill(0));
      current[0][0] = 1;
      for (let j = 1; j <= n2; j += 1) {
        for (let u = 0; u <= i * j; u += 1) {
          current[j][u] = (u >= j ? previous[j][u - j] : 0) + current[j - 1][u];
        }
      }
      previous = current;
    }
    const counts = previous[n2];
    const total = counts.reduce((sum, value) => sum + value, 0);
    let cumulative = 0;
    for (let u = 0; u <= Math.floor(smaller + 1e-9); u += 1) cumulative += counts[u];
    p = Math.min(1, (2 * cumulative) / total);
    method = "exacto";
  } else {
    const n = n1 + n2;
    const expected = (n1 * n2) / 2;
    const variance = (n1 * n2 / 12) * ((n + 1) - tieCorrection / (n * (n - 1)));
    const z = variance > 0 ? Math.max(0, Math.abs(u1 - expected) - 0.5) / Math.sqrt(variance) : 0;
    p = Math.min(1, 2 * (1 - normalCdf(z)));
    method = "aproximacion normal";
  }
  return { n1, n2, u1, p, method, rankBiserial: (2 * u1) / (n1 * n2) - 1 };
}

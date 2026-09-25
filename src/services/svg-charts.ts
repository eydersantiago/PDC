import { percentile } from "./stats.js";

/**
 * Graficas SVG sin dependencias para el informe del piloto (A3.6, A14.4).
 * Salen como archivos .svg que Word, los navegadores y GitHub muestran.
 */

const FONT = "system-ui, -apple-system, 'Segoe UI', Roboto, Arial, sans-serif";
const TEXT = "#1f2937";
const MUTED = "#6b7280";
const GRID = "#e5e7eb";

export const CONDITION_COLORS: Record<string, string> = {
  con_tutor: "#2563eb",
  sin_tutor: "#ea580c",
};
export const COHORT_COLORS: Record<string, string> = { A: "#0f766e", B: "#7c3aed" };
const LIKERT_COLORS = ["#b91c1c", "#f87171", "#d1d5db", "#60a5fa", "#1d4ed8"];
const LIKERT_LABELS = ["Totalmente en desacuerdo", "En desacuerdo", "Neutral", "De acuerdo", "Totalmente de acuerdo"];

export function escapeXml(value: unknown) {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function fmt(value: number, digits = 1) {
  return new Intl.NumberFormat("es-CO", { maximumFractionDigits: digits }).format(value);
}

function frame(width: number, height: number, title: string, body: string[]) {
  return [
    `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}" role="img" aria-label="${escapeXml(title)}" font-family="${FONT}">`,
    `<title>${escapeXml(title)}</title>`,
    `<rect width="${width}" height="${height}" fill="#ffffff"/>`,
    `<text x="16" y="26" font-size="16" font-weight="600" fill="${TEXT}">${escapeXml(title)}</text>`,
    ...body,
    "</svg>",
    "",
  ].join("\n");
}

function niceMax(value: number) {
  if (!Number.isFinite(value) || value <= 0) return 1;
  const exponent = 10 ** Math.floor(Math.log10(value));
  const fraction = value / exponent;
  const nice = fraction <= 1 ? 1 : fraction <= 2 ? 2 : fraction <= 2.5 ? 2.5 : fraction <= 5 ? 5 : 10;
  return nice * exponent;
}

function yAxis(x: number, top: number, bottom: number, max: number, unit: string, width: number) {
  const out: string[] = [];
  for (let step = 0; step <= 4; step += 1) {
    const value = (max / 4) * step;
    const y = bottom - ((bottom - top) * step) / 4;
    out.push(`<line x1="${x}" y1="${y}" x2="${width - 16}" y2="${y}" stroke="${GRID}"/>`);
    out.push(`<text x="${x - 6}" y="${y + 4}" font-size="11" text-anchor="end" fill="${MUTED}">${escapeXml(fmt(value))}</text>`);
  }
  out.push(`<text x="16" y="${top - 10}" font-size="11" fill="${MUTED}">${escapeXml(unit)}</text>`);
  return out;
}

export type BoxGroup = { label: string; values: number[]; color?: string };

/** Diagrama de caja por grupo (bigotes a 1,5 veces el rango intercuartil). */
export function boxPlotSvg(input: { title: string; unit: string; groups: BoxGroup[] }) {
  const width = 640;
  const height = 360;
  const top = 60;
  const bottom = 300;
  const left = 64;
  const groups = input.groups.filter((group) => group.values.length);
  const max = niceMax(Math.max(1, ...groups.flatMap((group) => group.values)));
  const scale = (value: number) => bottom - ((bottom - top) * value) / max;
  const body = [...yAxis(left, top, bottom, max, input.unit, width)];
  const slot = (width - left - 16) / Math.max(1, input.groups.length);
  input.groups.forEach((group, index) => {
    const center = left + slot * index + slot / 2;
    const color = group.color || "#475569";
    body.push(`<text x="${center}" y="${bottom + 20}" font-size="12" text-anchor="middle" fill="${TEXT}">${escapeXml(group.label)}</text>`);
    body.push(`<text x="${center}" y="${bottom + 36}" font-size="11" text-anchor="middle" fill="${MUTED}">n = ${group.values.length}</text>`);
    if (!group.values.length) return;
    const q1 = percentile(group.values, 25) as number;
    const q2 = percentile(group.values, 50) as number;
    const q3 = percentile(group.values, 75) as number;
    const iqr = q3 - q1;
    const inside = group.values.filter((value) => value >= q1 - 1.5 * iqr && value <= q3 + 1.5 * iqr);
    const low = Math.min(...inside);
    const high = Math.max(...inside);
    const boxWidth = Math.min(80, slot * 0.5);
    body.push(`<line x1="${center}" y1="${scale(high)}" x2="${center}" y2="${scale(low)}" stroke="${color}" stroke-width="1.5"/>`);
    body.push(`<line x1="${center - boxWidth / 4}" y1="${scale(high)}" x2="${center + boxWidth / 4}" y2="${scale(high)}" stroke="${color}" stroke-width="1.5"/>`);
    body.push(`<line x1="${center - boxWidth / 4}" y1="${scale(low)}" x2="${center + boxWidth / 4}" y2="${scale(low)}" stroke="${color}" stroke-width="1.5"/>`);
    body.push(`<rect x="${center - boxWidth / 2}" y="${scale(q3)}" width="${boxWidth}" height="${Math.max(1, scale(q1) - scale(q3))}" fill="${color}" fill-opacity="0.18" stroke="${color}" stroke-width="1.5"/>`);
    body.push(`<line x1="${center - boxWidth / 2}" y1="${scale(q2)}" x2="${center + boxWidth / 2}" y2="${scale(q2)}" stroke="${color}" stroke-width="3"/>`);
    body.push(`<text x="${center + boxWidth / 2 + 6}" y="${scale(q2) + 4}" font-size="11" fill="${TEXT}">${escapeXml(fmt(q2))}</text>`);
    for (const value of group.values.filter((item) => !inside.includes(item))) {
      body.push(`<circle cx="${center}" cy="${scale(value)}" r="3" fill="none" stroke="${color}"/>`);
    }
  });
  return frame(width, height, input.title, body);
}

export type PairedPoint = { left: number; right: number; group?: string };

/** Puntos pareados por persona: una linea de la condicion izquierda a la derecha. */
export function pairedDotsSvg(input: { title: string; unit: string; leftLabel: string; rightLabel: string; pairs: PairedPoint[] }) {
  const width = 640;
  const height = 380;
  const top = 60;
  const bottom = 310;
  const left = 64;
  const max = niceMax(Math.max(1, ...input.pairs.flatMap((pair) => [pair.left, pair.right])));
  const scale = (value: number) => bottom - ((bottom - top) * value) / max;
  const xLeft = left + 120;
  const xRight = width - 170;
  const body = [...yAxis(left, top, bottom, max, input.unit, width)];
  body.push(`<text x="${xLeft}" y="${bottom + 22}" font-size="12" text-anchor="middle" fill="${TEXT}">${escapeXml(input.leftLabel)}</text>`);
  body.push(`<text x="${xRight}" y="${bottom + 22}" font-size="12" text-anchor="middle" fill="${TEXT}">${escapeXml(input.rightLabel)}</text>`);
  for (const pair of input.pairs) {
    const color = COHORT_COLORS[pair.group || ""] || "#475569";
    body.push(`<line x1="${xLeft}" y1="${scale(pair.left)}" x2="${xRight}" y2="${scale(pair.right)}" stroke="${color}" stroke-opacity="0.55" stroke-width="1.5"/>`);
    body.push(`<circle cx="${xLeft}" cy="${scale(pair.left)}" r="4" fill="${color}"/>`);
    body.push(`<circle cx="${xRight}" cy="${scale(pair.right)}" r="4" fill="${color}"/>`);
  }
  const leftMedian = percentile(input.pairs.map((pair) => pair.left), 50);
  const rightMedian = percentile(input.pairs.map((pair) => pair.right), 50);
  if (leftMedian !== null && rightMedian !== null) {
    body.push(`<line x1="${xLeft}" y1="${scale(leftMedian)}" x2="${xRight}" y2="${scale(rightMedian)}" stroke="${TEXT}" stroke-width="3"/>`);
    body.push(`<text x="${xRight + 10}" y="${scale(rightMedian) + 4}" font-size="11" fill="${TEXT}">mediana ${escapeXml(fmt(rightMedian))}</text>`);
    body.push(`<text x="${xLeft - 10}" y="${scale(leftMedian) + 4}" font-size="11" text-anchor="end" fill="${TEXT}">${escapeXml(fmt(leftMedian))}</text>`);
  }
  const legendY = height - 16;
  body.push(`<circle cx="${left}" cy="${legendY - 4}" r="4" fill="${COHORT_COLORS.A}"/><text x="${left + 10}" y="${legendY}" font-size="11" fill="${TEXT}">Cohorte A (empezó con tutor)</text>`);
  body.push(`<circle cx="${left + 220}" cy="${legendY - 4}" r="4" fill="${COHORT_COLORS.B}"/><text x="${left + 230}" y="${legendY}" font-size="11" fill="${TEXT}">Cohorte B (empezó sin tutor)</text>`);
  body.push(`<text x="${width - 16}" y="${legendY}" font-size="11" text-anchor="end" fill="${MUTED}">n = ${input.pairs.length}</text>`);
  return frame(width, height, input.title, body);
}

export type Bar = { label: string; value: number; color?: string; note?: string };

/** Barras horizontales con su valor. */
export function barsSvg(input: { title: string; unit: string; bars: Bar[]; max?: number }) {
  const width = 640;
  const rowHeight = 30;
  const top = 48;
  const labelWidth = 200;
  const height = top + rowHeight * Math.max(1, input.bars.length) + 24;
  const max = input.max ?? niceMax(Math.max(1, ...input.bars.map((bar) => bar.value)));
  const span = width - labelWidth - 80;
  const body: string[] = [];
  input.bars.forEach((bar, index) => {
    const y = top + index * rowHeight;
    const length = Math.max(0, (span * bar.value) / max);
    body.push(`<text x="${labelWidth - 8}" y="${y + 18}" font-size="12" text-anchor="end" fill="${TEXT}">${escapeXml(bar.label)}</text>`);
    body.push(`<rect x="${labelWidth}" y="${y + 5}" width="${span}" height="18" fill="${GRID}" fill-opacity="0.5"/>`);
    body.push(`<rect x="${labelWidth}" y="${y + 5}" width="${length}" height="18" fill="${bar.color || "#2563eb"}"/>`);
    body.push(`<text x="${labelWidth + length + 6}" y="${y + 18}" font-size="11" fill="${TEXT}">${escapeXml(`${fmt(bar.value)}${input.unit ? ` ${input.unit}` : ""}${bar.note ? ` ${bar.note}` : ""}`)}</text>`);
  });
  return frame(width, height, input.title, body);
}

/** Barras 100 % apiladas por item Likert (1 a 5). */
export function likertSvg(input: { title: string; items: Array<{ label: string; counts: number[] }> }) {
  const width = 640;
  const rowHeight = 30;
  const top = 48;
  const labelWidth = 70;
  const height = top + rowHeight * Math.max(1, input.items.length) + 56;
  const span = width - labelWidth - 32;
  const body: string[] = [];
  input.items.forEach((item, index) => {
    const y = top + index * rowHeight;
    const total = item.counts.reduce((sum, value) => sum + value, 0);
    body.push(`<text x="${labelWidth - 8}" y="${y + 18}" font-size="12" text-anchor="end" fill="${TEXT}">${escapeXml(item.label)}</text>`);
    let x = labelWidth;
    item.counts.forEach((count, level) => {
      const segment = total ? (span * count) / total : 0;
      if (segment > 0) {
        body.push(`<rect x="${x}" y="${y + 5}" width="${segment}" height="18" fill="${LIKERT_COLORS[level]}"/>`);
        if (segment > 22) {
          body.push(`<text x="${x + segment / 2}" y="${y + 18}" font-size="10" text-anchor="middle" fill="${level === 2 ? TEXT : "#ffffff"}">${Math.round((count / total) * 100)}%</text>`);
        }
      }
      x += segment;
    });
    body.push(`<text x="${width - 16}" y="${y + 18}" font-size="10" text-anchor="end" fill="${MUTED}">${total ? "" : "sin respuestas"}</text>`);
  });
  const legendY = height - 22;
  let legendX = 16;
  LIKERT_LABELS.forEach((label, level) => {
    body.push(`<rect x="${legendX}" y="${legendY - 9}" width="10" height="10" fill="${LIKERT_COLORS[level]}"/>`);
    body.push(`<text x="${legendX + 14}" y="${legendY}" font-size="10" fill="${TEXT}">${escapeXml(label)}</text>`);
    legendX += 14 + label.length * 5.4 + 12;
  });
  return frame(width, height, input.title, body);
}

/** Histograma con cortes fijos (por ejemplo SUS de 10 en 10). */
export function histogramSvg(input: { title: string; unit: string; values: number[]; min: number; max: number; step: number; reference?: { value: number; label: string } }) {
  const edges: number[] = [];
  for (let edge = input.min; edge < input.max; edge += input.step) edges.push(edge);
  const counts = edges.map((edge, index) => input.values.filter((value) => value >= edge && (index === edges.length - 1 ? value <= input.max : value < edge + input.step)).length);
  const width = 640;
  const height = 340;
  const top = 60;
  const bottom = 280;
  const left = 64;
  const maxCount = niceMax(Math.max(1, ...counts));
  const slot = (width - left - 16) / edges.length;
  const body = [...yAxis(left, top, bottom, maxCount, "personas", width)];
  edges.forEach((edge, index) => {
    const barHeight = ((bottom - top) * counts[index]) / maxCount;
    const x = left + slot * index;
    body.push(`<rect x="${x + 2}" y="${bottom - barHeight}" width="${slot - 4}" height="${barHeight}" fill="#2563eb" fill-opacity="0.8"/>`);
    body.push(`<text x="${x + slot / 2}" y="${bottom + 16}" font-size="10" text-anchor="middle" fill="${MUTED}">${escapeXml(`${fmt(edge, 0)}–${fmt(edge + input.step, 0)}`)}</text>`);
  });
  if (input.reference) {
    const x = left + ((input.reference.value - input.min) / (input.max - input.min)) * (width - left - 16);
    body.push(`<line x1="${x}" y1="${top}" x2="${x}" y2="${bottom}" stroke="${CONDITION_COLORS.sin_tutor}" stroke-dasharray="5 4" stroke-width="2"/>`);
    body.push(`<text x="${x + 6}" y="${top + 12}" font-size="11" fill="${CONDITION_COLORS.sin_tutor}">${escapeXml(input.reference.label)}</text>`);
  }
  body.push(`<text x="${width / 2}" y="${bottom + 36}" font-size="11" text-anchor="middle" fill="${MUTED}">${escapeXml(input.unit)} (n = ${input.values.length})</text>`);
  return frame(width, height, input.title, body);
}

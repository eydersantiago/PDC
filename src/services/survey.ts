import { parseCsv } from "./csv.js";

/**
 * Encuesta final del piloto (A13.2). Cada pregunta del formulario empieza con
 * su codigo (SUS1..SUS10, UX1..UX6, PA1..PA5, CMP1, CMP2, AB1..AB3), asi que
 * la exportacion de Microsoft Forms o Google Forms se lee sin renombrar
 * columnas. Las respuestas Likert pueden venir como numero (1 a 5) o como
 * texto («Totalmente de acuerdo»).
 */

export const SURVEY_ITEM_COUNTS = { SUS: 10, UX: 6, PA: 5, CMP: 2, AB: 3 } as const;
type SurveyBlock = keyof typeof SURVEY_ITEM_COUNTS;

export type SurveyResponse = {
  sus: Array<number | null>;
  ux: Array<number | null>;
  pa: Array<number | null>;
  cmp: string[];
  open: string[];
};

const LIKERT_LABELS: Array<[RegExp, number]> = [
  [/^totalmente en desacuerdo$|^muy en desacuerdo$/, 1],
  [/^en desacuerdo$/, 2],
  [/^ni de acuerdo ni en desacuerdo$|^neutral$|^indiferente$/, 3],
  [/^de acuerdo$/, 4],
  [/^totalmente de acuerdo$|^muy de acuerdo$/, 5],
];

function normalizeLabel(value: string) {
  return value
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/\s+/g, " ")
    .trim();
}

/** Valor Likert 1..5 o null si esta vacio o no se reconoce. */
export function parseLikert(raw: string): number | null {
  const clean = normalizeLabel(String(raw || ""));
  if (!clean) return null;
  const numeric = clean.match(/^([1-5])(?:\b|\s|$)/);
  if (numeric) return Number(numeric[1]);
  for (const [pattern, value] of LIKERT_LABELS) {
    if (pattern.test(clean)) return value;
  }
  return null;
}

function codeOf(header: string): { block: SurveyBlock; index: number } | null {
  const match = String(header || "").trim().match(/^(SUS|UX|PA|CMP|AB)\s*0*(\d{1,2})(?!\d)/i);
  if (!match) return null;
  const block = match[1].toUpperCase() as SurveyBlock;
  const index = Number(match[2]) - 1;
  if (index < 0 || index >= SURVEY_ITEM_COUNTS[block]) return null;
  return { block, index };
}

export function parseSurvey(text: string): { responses: SurveyResponse[]; recognized: string[]; warnings: string[] } {
  const [header, ...rows] = parseCsv(text);
  const warnings: string[] = [];
  if (!header) return { responses: [], recognized: [], warnings: ["La encuesta esta vacia."] };
  const columns = header.map(codeOf);
  const recognized = columns.filter(Boolean).map((column) => `${column!.block}${column!.index + 1}`);
  for (const block of ["SUS", "UX", "PA"] as const) {
    const found = new Set(recognized.filter((code) => new RegExp(`^${block}\\d+$`).test(code))).size;
    if (found < SURVEY_ITEM_COUNTS[block]) {
      warnings.push(`Faltan columnas ${block}: se encontraron ${found} de ${SURVEY_ITEM_COUNTS[block]}.`);
    }
  }
  const responses = rows.map((row) => {
    const response: SurveyResponse = {
      sus: new Array(SURVEY_ITEM_COUNTS.SUS).fill(null),
      ux: new Array(SURVEY_ITEM_COUNTS.UX).fill(null),
      pa: new Array(SURVEY_ITEM_COUNTS.PA).fill(null),
      cmp: new Array(SURVEY_ITEM_COUNTS.CMP).fill(""),
      open: new Array(SURVEY_ITEM_COUNTS.AB).fill(""),
    };
    columns.forEach((column, position) => {
      if (!column) return;
      const raw = String(row[position] ?? "").trim();
      if (column.block === "SUS") response.sus[column.index] = parseLikert(raw);
      else if (column.block === "UX") response.ux[column.index] = parseLikert(raw);
      else if (column.block === "PA") response.pa[column.index] = parseLikert(raw);
      else if (column.block === "CMP") response.cmp[column.index] = raw;
      else response.open[column.index] = raw;
    });
    return response;
  });
  return { responses, recognized, warnings };
}

/** Puntaje SUS de 0 a 100; null si falta algun item. */
export function susScore(items: Array<number | null>) {
  if (items.length < 10 || items.slice(0, 10).some((value) => value === null)) return null;
  let total = 0;
  items.slice(0, 10).forEach((value, index) => {
    total += index % 2 === 0 ? (value as number) - 1 : 5 - (value as number);
  });
  return total * 2.5;
}

/** Promedio de los items respondidos si hay al menos minAnswered; si no, null. */
export function personMean(items: Array<number | null>, minAnswered: number) {
  const answered = items.filter((value): value is number => value !== null);
  if (answered.length < minAnswered) return null;
  return answered.reduce((sum, value) => sum + value, 0) / answered.length;
}

/**
 * Lector de CSV sin dependencias para las entradas del analisis del piloto
 * (encuesta exportada de Forms, asistencia, dataset). Acepta comillas,
 * comillas dobles escapadas, saltos de linea dentro de comillas, BOM y el
 * separador ";" que usa Excel en espanol.
 */

function detectDelimiter(firstLine: string) {
  let commas = 0;
  let semicolons = 0;
  let tabs = 0;
  let quoted = false;
  for (const char of firstLine) {
    if (char === "\"") quoted = !quoted;
    else if (!quoted && char === ",") commas += 1;
    else if (!quoted && char === ";") semicolons += 1;
    else if (!quoted && char === "\t") tabs += 1;
  }
  if (tabs > commas && tabs > semicolons) return "\t";
  return semicolons > commas ? ";" : ",";
}

export function parseCsv(text: string, delimiter?: string): string[][] {
  const clean = String(text || "").replace(/^﻿/, "");
  if (!clean.trim()) return [];
  const firstLineEnd = clean.search(/\r?\n/);
  const separator = delimiter || detectDelimiter(firstLineEnd === -1 ? clean : clean.slice(0, firstLineEnd));
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = "";
  let quoted = false;
  for (let index = 0; index < clean.length; index += 1) {
    const char = clean[index];
    if (quoted) {
      if (char === "\"") {
        if (clean[index + 1] === "\"") {
          cell += "\"";
          index += 1;
        } else {
          quoted = false;
        }
      } else {
        cell += char;
      }
      continue;
    }
    if (char === "\"") {
      quoted = true;
    } else if (char === separator) {
      row.push(cell);
      cell = "";
    } else if (char === "\n" || char === "\r") {
      if (char === "\r" && clean[index + 1] === "\n") index += 1;
      row.push(cell);
      rows.push(row);
      row = [];
      cell = "";
    } else {
      cell += char;
    }
  }
  if (cell !== "" || row.length) {
    row.push(cell);
    rows.push(row);
  }
  return rows.filter((item) => item.some((value) => value.trim() !== ""));
}

/** Filas como objetos con la cabecera como claves. */
export function parseCsvRecords(text: string, delimiter?: string): Array<Record<string, string>> {
  const [header, ...rows] = parseCsv(text, delimiter);
  if (!header) return [];
  const keys = header.map((key) => key.trim());
  return rows.map((row) => Object.fromEntries(keys.map((key, index) => [key, (row[index] ?? "").trim()])));
}

export function csvCell(value: unknown) {
  if (value === null || value === undefined) return "";
  const text = typeof value === "object" ? JSON.stringify(value) : String(value);
  return /[",\n\r;]/.test(text) ? `"${text.replace(/"/g, "\"\"")}"` : text;
}

export function toCsvText(header: string[], rows: Array<Record<string, unknown>>) {
  const lines = [header.map(csvCell).join(",")];
  for (const row of rows) lines.push(header.map((key) => csvCell(row[key])).join(","));
  return `${lines.join("\n")}\n`;
}

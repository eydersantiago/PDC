// KPIs: fuentes de los registros manuales (incidentes, humo, instalacion, cumplimiento, hallazgos), leerlos y exportarlos.
// Movido sin cambios desde src/services/kpi/kpis.ts (solo se agrego "export" y los imports); src/services/kpi/kpis.ts lo reexporta.
import { COMPLIANCE_ITEMS } from "../pilot/compliance-checklist.js";
import { toCsvText } from "../shared/csv.js";
import { KPI_CATALOG } from "./kpi-catalog.js";
import { MANUAL_KPI_IDS } from "./kpi-format.js";
import type { ManualKpiId } from "./kpi-format.js";
import { MANUAL_EXTRA_SOURCES, MANUAL_TEMPLATES, listText, missingColumns, parseYesNo, readSheet, stripAccents, tracker } from "./kpi-manual-parse.js";
import type { ManualContext, ManualFinding, ManualKpiSource, ManualRecordFile, ManualRecordsResult, ManualRowTrace } from "./kpi-manual-parse.js";
import { incidentsSource, smokeSource, installSource } from "./kpi-manual-install.js";

export const COMPLIANCE_STATES = new Map<string, "cumple" | "no cumple" | "no aplica" | "pendiente">(Object.entries({
  cumple: "cumple",
  si: "cumple",
  ok: "cumple",
  "no cumple": "no cumple",
  no: "no cumple",
  falla: "no cumple",
  "no aplica": "no aplica",
  "n/a": "no aplica",
  na: "no aplica",
  pendiente: "pendiente",
  manual: "pendiente",
  "no verificado": "pendiente",
  "": "pendiente",
} as const));

export function complianceState(value: string) {
  return COMPLIANCE_STATES.get(stripAccents(String(value || "")).trim().toLowerCase().replace(/\s+/g, " "));
}

/**
 * Qué hoja de cumplimiento cuenta si hay varias: entre las que tienen algún
 * ítem marcado, la de fecha más reciente en el nombre
 * (cumplimiento-AAAA-MM-DD.csv); una hoja sin fecha, como la plantilla copiada
 * tal cual, solo gana si ninguna con ítems marcados tiene fecha. Empates: la
 * que tenga más ítems marcados y después la última por nombre. Las demás
 * quedan «ignorada» con el motivo.
 */
export function pickComplianceSheet(files: ManualRecordFile[], track: ReturnType<typeof tracker>) {
  const known = new Set(COMPLIANCE_ITEMS.map((item) => item.id));
  const ranked = files.map((file) => {
    const marked = new Set<string>();
    for (const row of readSheet(file.text).rows) {
      const id = String(row.values.id || "").trim().toUpperCase();
      const state = complianceState(row.values.estado || "");
      if (!row.overflow && known.has(id) && state && state !== "pendiente") marked.add(id);
    }
    return { file, date: file.name.match(/(\d{4}-\d{2}-\d{2})/)?.[1] || "", marked: marked.size };
  });
  type Ranked = typeof ranked[number];
  const beats = (a: Ranked, b: Ranked) => {
    if ((a.marked > 0) !== (b.marked > 0)) return a.marked > 0;
    if (a.date !== b.date) return a.date > b.date;
    if (a.marked !== b.marked) return a.marked > b.marked;
    return a.file.name.localeCompare(b.file.name) > 0;
  };
  const chosen = ranked.reduce((best, entry) => (beats(entry, best) ? entry : best));
  for (const other of ranked.filter((entry) => entry !== chosen)) {
    const name = chosen.file.name;
    const reason = !other.marked && chosen.marked
      ? `sin ítems marcados; cuenta ${name}`
      : chosen.date !== other.date
        ? other.date ? `hay una hoja con fecha más reciente en el nombre: ${name}` : `sin fecha en el nombre; cuenta la hoja con fecha: ${name}`
        : chosen.marked !== other.marked
          ? `${name} tiene más ítems marcados (${chosen.marked} frente a ${other.marked})`
          : `${other.date ? "hay otra hoja del mismo día" : "hay otra hoja sin fecha"} con los mismos ítems marcados; cuenta la última por nombre: ${name}`;
    track.add(other.file.name, null, "ignorada", `${other.marked} ${other.marked === 1 ? "ítem marcado" : "ítems marcados"}`, reason);
  }
  return chosen.file;
}

// T11: ítems cumplidos / aplicables de la lista de cumplimiento, con los críticos obligatorios.
export function complianceSource(files: ManualRecordFile[], context: ManualContext): ManualKpiSource {
  const track = tracker(context, "T11");
  const file = pickComplianceSheet(files, track);
  const known = new Map(COMPLIANCE_ITEMS.map((item) => [item.id, item]));
  const status = new Map<string, "cumple" | "no cumple" | "no aplica" | "pendiente">();
  const sheet = readSheet(file.text);
  const missing = missingColumns(sheet.columns, ["id", "estado"]);
  if (missing.length) {
    track.add(file.name, null, "descartada", "", `faltan columnas: ${missing.join(", ")}`);
  } else {
    for (const row of sheet.rows) {
      if (track.overflowed(file.name, row)) continue;
      const id = row.values.id.trim().toUpperCase();
      const state = complianceState(row.values.estado);
      if (!known.has(id)) {
        track.add(file.name, row.fila, "descartada", row.values.id, "ítem desconocido: no está en la lista de cumplimiento");
      } else if (status.has(id)) {
        track.add(file.name, row.fila, "descartada", id, "ítem repetido: cuenta su primera fila");
      } else if (!state) {
        track.add(file.name, row.fila, "descartada", row.values.estado, "estado no válido (cumple, no cumple, no aplica o pendiente)");
      } else {
        status.set(id, state);
        track.add(file.name, row.fila, state === "pendiente" ? "ignorada" : "usada", `${id} ${state}`, state === "pendiente" ? "sin marcar: cuenta como no cumplido" : known.get(id)?.critical ? "ítem crítico" : "ítem");
      }
    }
  }
  const marked = [...status.values()].filter((state) => state !== "pendiente").length;
  const states = COMPLIANCE_ITEMS.map((item) => ({ item, state: status.get(item.id) || "pendiente" }));
  const applicable = states.filter((entry) => entry.state !== "no aplica");
  const met = applicable.filter((entry) => entry.state === "cumple");
  const notApplicable = states.length - applicable.length;
  const pending = applicable.filter((entry) => entry.state === "pendiente").map((entry) => entry.item.id);
  const failed = applicable.filter((entry) => entry.state === "no cumple").map((entry) => entry.item.id);
  const criticalNotMet = applicable.filter((entry) => entry.item.critical && entry.state !== "cumple").map((entry) => entry.item.id);
  const value = marked && applicable.length ? (met.length / applicable.length) * 100 : null;
  return {
    kpi: "T11",
    value,
    n: marked ? applicable.length : null,
    files: [file.name],
    usedRows: track.used,
    discardedRows: track.discarded,
    summary: marked
      ? `${met.length} de ${applicable.length} ítems aplicables cumplen (${notApplicable} no ${notApplicable === 1 ? "aplica" : "aplican"})${failed.length ? `; no cumplen: ${listText(failed)}` : ""}${pending.length ? `; sin marcar: ${listText(pending)}` : ""}; críticos sin cumplir: ${criticalNotMet.length ? listText(criticalNotMet) : "ninguno"}.`
      : "La hoja de cumplimiento no tiene ningún ítem marcado.",
    notes: [],
    blocking: marked && criticalNotMet.length ? `ítems críticos sin cumplir (${listText(criticalNotMet)}), obligatorios aunque el total pase el umbral` : null,
    details: { cumplidos: met.length, aplicables: applicable.length, noAplican: notApplicable, pendientes: pending, noCumplen: failed, criticosSinCumplir: criticalNotMet },
  };
}

export const FINDING_STATES = new Map<string, string>(Object.entries({
  implementada: "implementada",
  implementado: "implementada",
  hecha: "implementada",
  pendiente: "pendiente",
  "en curso": "en curso",
  en_curso: "en curso",
  descartada: "descartada",
}));

// P5: mejoras críticas implementadas / identificadas en los hallazgos (A14.5).
export function findingsSource(files: ManualRecordFile[], context: ManualContext, findings: ManualFinding[]): ManualKpiSource {
  const track = tracker(context, "P5");
  const known = new Set(KPI_CATALOG.map((kpi) => kpi.id));
  const seen = new Set<string>();
  const notes: string[] = [];
  for (const file of files) {
    const sheet = readSheet(file.text);
    const missing = missingColumns(sheet.columns, ["id", "critica", "estado"]);
    if (missing.length) {
      track.add(file.name, null, "descartada", "", `faltan columnas: ${missing.join(", ")}`);
      continue;
    }
    for (const row of sheet.rows) {
      if (track.overflowed(file.name, row)) continue;
      const id = row.values.id.trim();
      const critica = parseYesNo(row.values.critica);
      const estado = FINDING_STATES.get(stripAccents(row.values.estado).trim().toLowerCase().replace(/\s+/g, " "));
      const kpis = String(row.values.kpis || "").split(/[;,\s]+/).map((value) => value.trim().toUpperCase()).filter(Boolean);
      const unknown = kpis.filter((kpi) => !known.has(kpi));
      if (!id) {
        track.add(file.name, row.fila, "descartada", "", "falta id del hallazgo (H1, H2…)");
      } else if (seen.has(id.toUpperCase())) {
        track.add(file.name, row.fila, "descartada", id, "hallazgo repetido: cuenta su primera fila");
      } else if (critica === null || critica === undefined) {
        track.add(file.name, row.fila, "descartada", row.values.critica, "critica debe ser si o no");
      } else if (!estado) {
        track.add(file.name, row.fila, "descartada", row.values.estado, "estado no válido (implementada, en curso, pendiente o descartada)");
      } else {
        seen.add(id.toUpperCase());
        if (unknown.length) notes.push(`${file.name}, fila ${row.fila}: KPIs desconocidos ${unknown.join(", ")}.`);
        findings.push({ id, hallazgo: row.values.hallazgo || "", kpis: kpis.filter((kpi) => known.has(kpi)), critica, estado, accion: row.values.accion || "" });
        track.add(file.name, row.fila, "usada", `${id} ${critica ? "crítico" : "no crítico"} ${estado}`, critica ? (estado === "implementada" ? "mejora crítica implementada" : "mejora crítica sin implementar") : "no crítico: solo trazabilidad");
      }
    }
  }
  const critical = findings.filter((finding) => finding.critica);
  const done = critical.filter((finding) => finding.estado === "implementada");
  const open = critical.filter((finding) => finding.estado !== "implementada").map((finding) => finding.id);
  return {
    kpi: "P5",
    value: critical.length ? (done.length / critical.length) * 100 : null,
    n: critical.length || null,
    files: files.map((file) => file.name),
    usedRows: track.used,
    discardedRows: track.discarded,
    summary: critical.length
      ? `${done.length} de ${critical.length} mejoras críticas implementadas (${findings.length} hallazgos en la hoja)${open.length ? `; sin implementar: ${listText(open)}` : ""}.`
      : findings.length ? `Ningún hallazgo marcado como crítico (${findings.length} en la hoja).` : "Ningún hallazgo válido.",
    notes,
    details: { criticos: critical.length, implementados: done.length, sinImplementar: open },
  };
}

export function templateOf(name: string) {
  const lower = name.toLowerCase();
  const template = MANUAL_TEMPLATES.find((item) => lower.startsWith(item.prefix) && lower.endsWith(".csv"));
  if (template) return { kpi: template.kpi, kind: template.prefix };
  const extra = MANUAL_EXTRA_SOURCES.find((item) => lower.startsWith(item.prefix) && lower.endsWith(item.extension));
  return extra ? { kpi: extra.kpi, kind: extra.prefix } : null;
}

/**
 * Lee las plantillas llenas (por nombre de archivo, ver MANUAL_TEMPLATES y
 * MANUAL_EXTRA_SOURCES), valida cada fila y calcula T7, T8, T10, T11 y P5.
 * sessionDates (fechas del plan) filtra los incidentes de T7 y las pruebas de
 * humo de T8, y avisa de las sesiones sin registro. Los archivos que no
 * reconoce quedan en unrecognized.
 */
export function readManualRecords(files: ManualRecordFile[], options: { sessionDates?: string[]; timeZone?: string } = {}): ManualRecordsResult {
  const context: ManualContext = {
    trace: [],
    sessionDates: [...new Set(options.sessionDates || [])].sort(),
    timeZone: options.timeZone || "America/Bogota",
  };
  const byKind = new Map<string, ManualRecordFile[]>();
  const unrecognized: string[] = [];
  for (const file of [...files].sort((a, b) => a.name.localeCompare(b.name))) {
    const match = templateOf(file.name);
    if (!match) {
      unrecognized.push(file.name);
      context.trace.push({ kpi: "", archivo: file.name, fila: null, estado: "ignorada", valor: "", motivo: "no es una plantilla conocida" });
      continue;
    }
    byKind.set(match.kind, [...(byKind.get(match.kind) || []), file]);
  }
  const of = (kind: string) => byKind.get(kind) || [];
  const findings: ManualFinding[] = [];
  const sources: Partial<Record<ManualKpiId, ManualKpiSource>> = {};
  if (of("registro-incidentes").length) sources.T7 = incidentsSource(of("registro-incidentes"), context);
  if (of("pruebas-humo").length || of("demo-escenarios").length) sources.T8 = smokeSource(of("pruebas-humo"), of("demo-escenarios"), context);
  if (of("tiempos-instalacion").length || of("prueba-inicio-a-fin").length) sources.T10 = installSource(of("tiempos-instalacion"), of("prueba-inicio-a-fin"), context);
  if (of("cumplimiento").length) sources.T11 = complianceSource(of("cumplimiento"), context);
  if (of("hallazgos").length) sources.P5 = findingsSource(of("hallazgos"), context, findings);
  const rank = (kpi: ManualKpiId | "") => (kpi ? MANUAL_KPI_IDS.indexOf(kpi) : MANUAL_KPI_IDS.length);
  const rows = context.trace
    .map((row, index) => ({ row, index }))
    .sort((a, b) => rank(a.row.kpi) - rank(b.row.kpi) || a.row.archivo.localeCompare(b.row.archivo) || (a.row.fila ?? 0) - (b.row.fila ?? 0) || a.index - b.index)
    .map((item) => item.row);
  return { sources, rows, findings, unrecognized };
}

/** registros-manuales.csv: una fila por fila leída (o por archivo) con lo que se hizo con ella. */
export function manualRecordsCsv(rows: ManualRowTrace[]) {
  return toCsvText(["kpi", "archivo", "fila", "estado", "valor", "motivo"], rows.map((row) => ({ ...row, fila: row.fila ?? "" })));
}

/**
 * Plantillas vacías de data/piloto/plantillas/ (la de cumplimiento trae los
 * ítems de la lista). Las escribe npm run piloto:analisis -- --escribir-plantillas.
 */
export function renderManualTemplates(): Array<{ file: string; text: string }> {
  return MANUAL_TEMPLATES.map((template) => {
    if (template.kpi !== "T11") return { file: template.file, text: toCsvText(template.columns, []) };
    return {
      file: template.file,
      text: toCsvText(template.columns, COMPLIANCE_ITEMS.map((item) => ({
        id: item.id,
        area: item.area,
        item: item.item,
        critico: item.critical ? "si" : "no",
        verificacion: item.verification,
      }))),
    };
  });
}

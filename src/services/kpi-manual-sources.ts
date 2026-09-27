// KPIs: fuentes de los registros manuales (incidentes, humo, instalacion, cumplimiento, hallazgos), leerlos y exportarlos.
// Movido sin cambios desde src/services/kpis.ts (solo se agrego "export" y los imports); src/services/kpis.ts lo reexporta.
import { COMPLIANCE_ITEMS } from "./compliance-checklist.js";
import { toCsvText } from "./csv.js";
import { KPI_CATALOG } from "./kpi-catalog.js";
import { MANUAL_KPI_IDS, formatNumber } from "./kpi-compute.js";
import type { ManualKpiId } from "./kpi-compute.js";
import { MANUAL_EXTRA_SOURCES, MANUAL_TEMPLATES, clockText, dayKey, listText, localClock, missingColumns, parseCount, parseRecordClock, parseRecordDate, parseRecordNumber, parseYesNo, readSheet, stripAccents, tracker } from "./kpi-manual-parse.js";
import type { ManualContext, ManualFinding, ManualKpiSource, ManualRecordFile, ManualRecordsResult, ManualRowTrace, SheetRow } from "./kpi-manual-parse.js";
import { median, round } from "./stats.js";

// T7: incidentes S1 del registro del plan de soporte durante las sesiones.
export function incidentsSource(files: ManualRecordFile[], context: ManualContext): ManualKpiSource {
  const track = tracker(context, "T7");
  const sessions = new Set(context.sessionDates);
  const bySeverity: Record<string, number> = { S1: 0, S2: 0, S3: 0, S4: 0 };
  const criticalDates: string[] = [];
  const counted: string[] = [];
  const covered = new Set<string>();
  for (const file of files) {
    const sheet = readSheet(file.text);
    const missing = missingColumns(sheet.columns, ["fecha", "severidad"]);
    if (missing.length) {
      track.add(file.name, null, "descartada", "", `faltan columnas: ${missing.join(", ")}`);
      continue;
    }
    const nameDate = file.name.match(/(\d{4}-\d{2}-\d{2})/)?.[1] || null;
    let valid = 0;
    for (const row of sheet.rows) {
      if (track.overflowed(file.name, row)) continue;
      const fecha = parseRecordDate(row.values.fecha, context.timeZone);
      const severity = stripAccents(row.values.severidad).trim().match(/^s?\s*([1-4])(?!\d)/i);
      if (!fecha) {
        track.add(file.name, row.fila, "descartada", row.values.fecha, "fecha no válida (AAAA-MM-DD o DD/MM/AAAA)");
        continue;
      }
      if (!severity) {
        track.add(file.name, row.fila, "descartada", row.values.severidad, "severidad no válida (S1, S2, S3 o S4 del plan de soporte)");
        continue;
      }
      if (sessions.size && !sessions.has(fecha)) {
        track.add(file.name, row.fila, "ignorada", fecha, "fecha fuera de las sesiones del plan del piloto");
        continue;
      }
      const level = `S${severity[1]}`;
      valid += 1;
      bySeverity[level] += 1;
      covered.add(fecha);
      if (level === "S1") criticalDates.push(fecha);
      track.add(file.name, row.fila, "usada", `${level} ${fecha}`, level === "S1" ? "incidente crítico: cuenta en T7" : `${level}: se reporta, no cuenta en T7`);
    }
    if (valid) {
      counted.push(file.name);
      if (nameDate) covered.add(nameDate);
    } else if (!sheet.rows.length && nameDate && (!sessions.size || sessions.has(nameDate))) {
      counted.push(file.name);
      covered.add(nameDate);
      track.add(file.name, null, "usada", `0 incidentes ${nameDate}`, "registro de la sesión sin incidentes");
    } else if (!sheet.rows.length) {
      track.add(file.name, null, "ignorada", "", nameDate
        ? "sin filas y con una fecha fuera de las sesiones del plan"
        : "sin filas y sin fecha en el nombre: no cuenta como registro de una sesión (nómbrala registro-incidentes-AAAA-MM-DD.csv)");
    }
  }
  const total = Object.values(bySeverity).reduce((sum, value) => sum + value, 0);
  const notes: string[] = [];
  const uncovered = context.sessionDates.filter((date) => !covered.has(date));
  if (counted.length && uncovered.length) notes.push(`Sin registro de incidentes de: ${listText(uncovered)}.`);
  const breakdown = `S1 ${bySeverity.S1}, S2 ${bySeverity.S2}, S3 ${bySeverity.S3}, S4 ${bySeverity.S4}`;
  return {
    kpi: "T7",
    value: counted.length ? bySeverity.S1 : null,
    n: counted.length || null,
    files: files.map((file) => file.name),
    usedRows: track.used,
    discardedRows: track.discarded,
    summary: counted.length
      ? `${bySeverity.S1} ${bySeverity.S1 === 1 ? "incidente S1" : "incidentes S1"} en ${counted.length} ${counted.length === 1 ? "registro de sesión" : "registros de sesión"} (${total} incidentes en total: ${breakdown})${criticalDates.length ? `; S1 el ${listText([...new Set(criticalDates)])}` : ""}.`
      : "Ningún registro de incidentes válido.",
    notes,
    details: { bySeverity, registros: counted },
  };
}

export type SmokeRun = { fecha: string; seconds: number | null; order: number; correct: number; total: number; archivo: string; fila: number | null };

// T8: la peor sesión de npm run demo:escenarios contra producción. Con el
// plan, solo cuentan las corridas del día de una sesión (el runbook la pide
// en «Antes de la clase (T − 30 min)»): una prueba de otro día, por ejemplo la
// de la prueba de inicio a fin o una a mitad del despliegue, no es de una sesión.
export function smokeSource(csvFiles: ManualRecordFile[], mdFiles: ManualRecordFile[], context: ManualContext): ManualKpiSource {
  const track = tracker(context, "T8");
  const sessions = new Set(context.sessionDates);
  const outsideSessions = (fecha: string) => sessions.size > 0 && !sessions.has(fecha);
  const OUTSIDE_REASON = "fecha fuera de las sesiones del plan del piloto (la prueba de humo cuenta el día de la sesión)";
  const runs: SmokeRun[] = [];
  let order = 0;
  for (const file of csvFiles) {
    const sheet = readSheet(file.text);
    const missing = missingColumns(sheet.columns, ["fecha", "destino", "correctas", "total"]);
    if (missing.length) {
      track.add(file.name, null, "descartada", "", `faltan columnas: ${missing.join(", ")}`);
      continue;
    }
    for (const row of sheet.rows) {
      if (track.overflowed(file.name, row)) continue;
      const fecha = parseRecordDate(row.values.fecha, context.timeZone);
      const correct = parseCount(row.values.correctas);
      const total = parseCount(row.values.total);
      const hora = row.values.hora ? parseRecordClock(row.values.hora) : null;
      if (!fecha) {
        track.add(file.name, row.fila, "descartada", row.values.fecha, "fecha no válida (AAAA-MM-DD o DD/MM/AAAA)");
      } else if (correct === null || total === null || total === 0 || correct > total) {
        track.add(file.name, row.fila, "descartada", `${row.values.correctas} de ${row.values.total}`, "correctas y total deben ser enteros, con total > 0 y correctas ≤ total");
      } else if (row.values.hora && hora === null) {
        track.add(file.name, row.fila, "descartada", row.values.hora, "hora no válida (HH:MM)");
      } else if (!/^https:\/\//i.test(row.values.destino)) {
        track.add(file.name, row.fila, "ignorada", row.values.destino, "no es contra producción (el destino no empieza por https://)");
      } else if (outsideSessions(fecha)) {
        track.add(file.name, row.fila, "ignorada", `${correct} de ${total} (${fecha})`, OUTSIDE_REASON);
      } else {
        runs.push({ fecha, seconds: hora, order: order += 1, correct, total, archivo: file.name, fila: row.fila });
      }
    }
  }
  for (const file of mdFiles) {
    const started = file.text.match(/^- Fecha: (\S+)/m)?.[1] || "";
    const backend = file.text.match(/^- Backend: (.+)$/m)?.[1]?.trim() || "";
    const outcome = file.text.match(/^- Resultado: (\d+) de (\d+) comprobaciones correctas/m);
    if (!outcome || !Number.isFinite(Date.parse(started))) {
      track.add(file.name, null, "descartada", "", "no tiene las líneas «- Fecha:» y «- Resultado: N de M comprobaciones correctas» de npm run demo:escenarios");
      continue;
    }
    if (!/^https:\/\//i.test(backend)) {
      track.add(file.name, null, "ignorada", backend, "no es contra producción (backend sin https://)");
      continue;
    }
    const correct = Number(outcome[1]);
    const total = Number(outcome[2]);
    if (!total || correct > total) {
      track.add(file.name, null, "descartada", `${correct} de ${total}`, "resultado sin comprobaciones");
      continue;
    }
    const fecha = dayKey(started, context.timeZone);
    if (outsideSessions(fecha)) {
      track.add(file.name, null, "ignorada", `${correct} de ${total} (${fecha})`, OUTSIDE_REASON);
      continue;
    }
    runs.push({ fecha, seconds: localClock(started, context.timeZone), order: order += 1, correct, total, archivo: file.name, fila: null });
  }
  // Una por sesión: si el mismo día se repitió (por ejemplo tras corregir algo), cuenta la última.
  const byDay = new Map<string, SmokeRun[]>();
  for (const run of runs) byDay.set(run.fecha, [...(byDay.get(run.fecha) || []), run]);
  const perDay: Array<{ fecha: string; correctas: number; total: number; pct: number }> = [];
  for (const [fecha, list] of [...byDay.entries()].sort()) {
    const sorted = [...list].sort((a, b) => (a.seconds ?? -1) - (b.seconds ?? -1) || a.order - b.order);
    const last = sorted[sorted.length - 1];
    for (const run of sorted) {
      const valor = `${run.correct} de ${run.total} (${fecha}${run.seconds !== null ? ` ${clockText(run.seconds)}` : ""})`;
      if (run === last) track.add(run.archivo, run.fila, "usada", valor, "prueba de humo de la sesión");
      else track.add(run.archivo, run.fila, "ignorada", valor, "reemplazada por una corrida posterior del mismo día");
    }
    perDay.push({ fecha, correctas: last.correct, total: last.total, pct: (last.correct / last.total) * 100 });
  }
  const worst = perDay.reduce<typeof perDay[number] | null>((low, day) => (!low || day.pct < low.pct ? day : low), null);
  const notes: string[] = [];
  const missingDays = context.sessionDates.filter((date) => !byDay.has(date));
  if (perDay.length && missingDays.length) notes.push(`Sesiones del plan sin prueba de humo ese mismo día: ${listText(missingDays)}.`);
  return {
    kpi: "T8",
    value: worst ? worst.pct : null,
    n: perDay.length || null,
    files: [...csvFiles, ...mdFiles].map((file) => file.name),
    usedRows: track.used,
    discardedRows: track.discarded,
    summary: worst
      ? `Peor sesión: ${formatNumber(worst.pct, 1)} % (${worst.correctas} de ${worst.total} comprobaciones, ${worst.fecha}) en ${perDay.length} ${perDay.length === 1 ? "sesión" : "sesiones"} con prueba de humo contra producción.`
      : "Ninguna prueba de humo válida contra producción.",
    notes,
    details: { perDay: perDay.map((day) => ({ ...day, pct: round(day.pct, 1) })) },
  };
}

export type InstallPath = "tunel" | "mac";

export type InstallTime = { camino: InstallPath; minutos: number; ayuda: boolean; archivo: string };

export const PATH_LABEL: Record<InstallPath, string> = { tunel: "túnel", mac: "Mac" };

export function installTimesFromSheet(files: ManualRecordFile[], context: ManualContext, track: ReturnType<typeof tracker>) {
  const times: InstallTime[] = [];
  const seen = new Set<string>();
  const notes: string[] = [];
  for (const file of files) {
    const sheet = readSheet(file.text, { editor_por_tunel: "editor_listo", minutos: "minutos_totales" });
    const missing = missingColumns(sheet.columns, ["persona"]);
    const hasMinutes = sheet.columns.includes("minutos_totales");
    const hasClocks = sheet.columns.includes("inicio") && sheet.columns.includes("editor_listo");
    if (missing.length || (!hasMinutes && !hasClocks)) {
      track.add(file.name, null, "descartada", "", `faltan columnas: ${[...missing, ...(!hasMinutes && !hasClocks ? ["minutos_totales (o inicio y editor_listo)"] : [])].join(", ")}`);
      continue;
    }
    for (const row of sheet.rows) {
      if (track.overflowed(file.name, row)) continue;
      const persona = row.values.persona;
      const rawPath = stripAccents(row.values.camino || "").trim().toLowerCase();
      const camino = !rawPath || rawPath.startsWith("tunel") ? "tunel" : rawPath.startsWith("mac") ? "mac" : null;
      const fromColumn = row.values.minutos_totales ? parseRecordNumber(row.values.minutos_totales) : null;
      const start = row.values.inicio ? parseRecordClock(row.values.inicio) : null;
      const end = row.values.editor_listo ? parseRecordClock(row.values.editor_listo) : null;
      const fromClocks = start !== null && end !== null && end > start ? (end - start) / 60 : null;
      const ayuda = parseYesNo(row.values.ayuda_recibida || "");
      if (!persona) {
        track.add(file.name, row.fila, "descartada", "", "falta persona (un código como V1 basta)");
      } else if (!camino) {
        track.add(file.name, row.fila, "descartada", row.values.camino, "camino no válido (tunel o mac)");
      } else if (row.values.minutos_totales && fromColumn === null) {
        track.add(file.name, row.fila, "descartada", row.values.minutos_totales, "minutos_totales no es un número");
      } else if (fromColumn === null && fromClocks === null) {
        track.add(file.name, row.fila, "descartada", `${row.values.inicio || ""} → ${row.values.editor_listo || ""}`, "sin minutos_totales ni horas válidas de inicio y editor_listo (HH:MM)");
      } else if (ayuda === undefined) {
        track.add(file.name, row.fila, "descartada", row.values.ayuda_recibida, "ayuda_recibida debe ser si o no");
      } else {
        const minutos = (fromColumn ?? fromClocks) as number;
        const key = `${persona.toLowerCase()}|${camino}`;
        if (minutos <= 0 || minutos > 240) {
          track.add(file.name, row.fila, "descartada", `${formatNumber(minutos, 1)} min`, "fuera de rango (más de 0 y hasta 240 minutos)");
        } else if (seen.has(key)) {
          track.add(file.name, row.fila, "ignorada", `${formatNumber(minutos, 1)} min`, "persona repetida en el mismo camino: cuenta su primera fila");
        } else {
          seen.add(key);
          times.push({ camino, minutos, ayuda: ayuda === true, archivo: file.name });
          const mismatch = fromColumn !== null && fromClocks !== null && Math.abs(fromColumn - fromClocks) > 2;
          if (mismatch) notes.push(`${file.name}, fila ${row.fila}: minutos_totales (${formatNumber(fromColumn, 1)}) no coincide con las horas (${formatNumber(fromClocks, 1)}); se usa minutos_totales.`);
          track.add(file.name, row.fila, "usada", `${formatNumber(minutos, 1)} min (${PATH_LABEL[camino]})`, fromColumn !== null ? "minutos_totales" : "calculado con inicio y editor_listo");
        }
      }
    }
  }
  return { times, notes };
}

/**
 * Respaldo de T10: la hoja de la prueba de inicio a fin, para los caminos que
 * tiempos-instalacion.csv no trae. Túnel: de P1.1 a P1.6 (P1.6 pide los
 * «Minutos totales», que ganan sobre las horas). Mac: de P4.1 a P4.3 por las
 * horas, porque en P4.1 se anotan los minutos del paso y P4.3 no dice si son
 * los totales; los minutos de P4.3 solo se usan si faltan las horas.
 */
export function installTimesFromEndToEnd(files: ManualRecordFile[], track: ReturnType<typeof tracker>, paths: Set<InstallPath>) {
  const times: InstallTime[] = [];
  const notes: string[] = [];
  const stretches: Array<{ camino: InstallPath; start: string; end: string; prefer: "minutos" | "horas" }> = [
    { camino: "tunel", start: "P1.1", end: "P1.6", prefer: "minutos" },
    { camino: "mac", start: "P4.1", end: "P4.3", prefer: "horas" },
  ];
  const stepsUsed = new Set(stretches.flatMap((stretch) => [stretch.start, stretch.end]));
  for (const file of files) {
    const sheet = readSheet(file.text);
    const missing = missingColumns(sheet.columns, ["paso", "cuenta", "hora_inicio", "hora_fin", "minutos", "resultado"]);
    if (missing.length) {
      track.add(file.name, null, "descartada", "", `faltan columnas: ${missing.join(", ")}`);
      continue;
    }
    const first = new Map<string, SheetRow>();
    for (const row of sheet.rows) {
      const paso = row.values.paso.toUpperCase();
      // Solo importan las filas del cronómetro; una fila corrida en otro paso no afecta a T10.
      if (stepsUsed.has(paso) && track.overflowed(file.name, row)) continue;
      const key = `${paso}|${row.values.cuenta}`;
      if (!first.has(key)) first.set(key, row);
    }
    const accounts = [...new Set(sheet.rows.map((row) => row.values.cuenta).filter((cuenta) => /^E\d+$/i.test(cuenta)))];
    for (const cuenta of accounts) {
      for (const stretch of stretches) {
        const startRow = first.get(`${stretch.start}|${cuenta}`);
        const endRow = first.get(`${stretch.end}|${cuenta}`);
        if (!startRow || !endRow) continue;
        const label = `${cuenta} ${stretch.start}-${stretch.end}`;
        if (!paths.has(stretch.camino)) {
          track.add(file.name, endRow.fila, "ignorada", label, `tiempos-instalacion.csv ya trae tiempos del camino ${PATH_LABEL[stretch.camino]}: la hoja de la prueba solo es el respaldo`);
          continue;
        }
        const resultado = stripAccents(endRow.values.resultado).trim().toLowerCase();
        const fromColumn = endRow.values.minutos ? parseRecordNumber(endRow.values.minutos) : null;
        const start = parseRecordClock(startRow.values.hora_inicio);
        const end = parseRecordClock(endRow.values.hora_fin);
        const fromClocks = start !== null && end !== null && end > start ? (end - start) / 60 : null;
        const minutos = stretch.prefer === "minutos" ? fromColumn ?? fromClocks : fromClocks ?? fromColumn;
        const usedColumn = stretch.prefer === "minutos" ? fromColumn !== null : fromClocks === null && fromColumn !== null;
        if (resultado === "falla") {
          track.add(file.name, endRow.fila, "descartada", label, `${stretch.end} con resultado falla: no quedó listo`);
        } else if (resultado === "no aplica") {
          track.add(file.name, endRow.fila, "ignorada", label, `${stretch.end} no aplica`);
        } else if (endRow.values.minutos && fromColumn === null) {
          track.add(file.name, endRow.fila, "descartada", endRow.values.minutos, `minutos de ${stretch.end} no es un número`);
        } else if (minutos === null) {
          track.add(file.name, endRow.fila, "ignorada", label, `sin minutos en ${stretch.end} ni horas en ${stretch.start} y ${stretch.end}`);
        } else if (minutos <= 0 || minutos > 240) {
          track.add(file.name, endRow.fila, "descartada", `${formatNumber(minutos, 1)} min`, "fuera de rango (más de 0 y hasta 240 minutos)");
        } else {
          times.push({ camino: stretch.camino, minutos, ayuda: false, archivo: file.name });
          if (fromColumn !== null && fromClocks !== null && Math.abs(fromColumn - fromClocks) > 2) {
            notes.push(`${file.name}, ${label}: los minutos de ${stretch.end} (${formatNumber(fromColumn, 1)}) no coinciden con las horas (${formatNumber(fromClocks, 1)}); se usan ${usedColumn ? "los minutos" : "las horas"}.`);
          }
          track.add(file.name, endRow.fila, "usada", `${formatNumber(minutos, 1)} min (${label})`, usedColumn ? `minutos de ${stretch.end}` : `hora_inicio de ${stretch.start} a hora_fin de ${stretch.end}`);
        }
      }
    }
  }
  return { times, notes };
}

// T10: mediana de los minutos por persona hasta tener el editor por túnel con ADACEEN.
export function installSource(sheetFiles: ManualRecordFile[], endToEndFiles: ManualRecordFile[], context: ManualContext): ManualKpiSource {
  const track = tracker(context, "T10");
  const fromSheet = installTimesFromSheet(sheetFiles, context, track);
  const notes = [...fromSheet.notes];
  let times = fromSheet.times;
  // El respaldo cubre cada camino que tiempos-instalacion.csv no trae (por ejemplo, solo filas de la Mac).
  const missingPaths = new Set<InstallPath>((["tunel", "mac"] as const).filter((camino) => !times.some((time) => time.camino === camino)));
  if (endToEndFiles.length && missingPaths.size) {
    const fromEndToEnd = installTimesFromEndToEnd(endToEndFiles, track, missingPaths);
    times = [...times, ...fromEndToEnd.times];
    notes.push(...fromEndToEnd.notes);
  } else {
    for (const file of endToEndFiles) track.add(file.name, null, "ignorada", "", "tiempos-instalacion.csv ya trae tiempos del túnel y de la Mac: la hoja de la prueba solo es el respaldo");
  }
  const usedFiles = [...new Set(times.map((time) => time.archivo))];
  const origin = usedFiles.length ? usedFiles : [...sheetFiles, ...endToEndFiles].map((file) => file.name);
  const tunnel = times.filter((time) => time.camino === "tunel").map((time) => time.minutos);
  const mac = times.filter((time) => time.camino === "mac").map((time) => time.minutos);
  const helped = times.filter((time) => time.ayuda).length;
  if (tunnel.length && tunnel.length < 3) notes.push(`El catálogo pide al menos 3 personas que no conozcan el proyecto; hay ${tunnel.length}.`);
  const parts: string[] = [];
  parts.push(tunnel.length
    ? `Mediana de ${formatNumber(median(tunnel), 1)} min en ${tunnel.length} ${tunnel.length === 1 ? "persona" : "personas"} por túnel (máximo ${formatNumber(Math.max(...tunnel), 1)} min)`
    : "Sin tiempos del camino por túnel");
  if (mac.length) parts.push(`Mac del laboratorio: mediana ${formatNumber(median(mac), 1)} min (n = ${mac.length})`);
  if (helped) parts.push(`${helped} con ayuda de otra persona`);
  return {
    kpi: "T10",
    value: tunnel.length ? median(tunnel) : null,
    n: tunnel.length || null,
    files: origin,
    usedRows: track.used,
    discardedRows: track.discarded,
    summary: `${parts.join("; ")}.`,
    notes,
    details: {
      tunel: { n: tunnel.length, mediana: round(median(tunnel), 1), maximo: tunnel.length ? Math.max(...tunnel) : null },
      mac: { n: mac.length, mediana: round(median(mac), 1) },
      conAyuda: helped,
    },
  };
}

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

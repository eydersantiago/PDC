// KPIs manuales: incidentes, pruebas de humo y tiempos de instalacion (hoja o prueba de punta a punta).
import { formatNumber } from "./kpi-format.js";
import { clockText, dayKey, listText, localClock, missingColumns, parseCount, parseRecordClock, parseRecordDate, parseRecordNumber, parseYesNo, readSheet, stripAccents, tracker } from "./kpi-manual-parse.js";
import type { ManualContext, ManualKpiSource, ManualRecordFile, SheetRow } from "./kpi-manual-parse.js";
import { median, round } from "../analytics/stats.js";

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

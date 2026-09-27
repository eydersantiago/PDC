// KPIs: plantillas de los registros manuales y lectura de sus hojas (fechas, horas, numeros, si/no).
// Movido sin cambios desde src/services/kpis.ts (solo se agrego "export" y los imports); src/services/kpis.ts lo reexporta.
import { parseCsv } from "./csv.js";
import type { ManualKpiId } from "./kpi-compute.js";

export function dayKey(iso: string, timeZone: string) {
  return new Intl.DateTimeFormat("en-CA", { timeZone, year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date(iso));
}

// --- KPIs manuales desde plantillas CSV (T7, T8, T10, T11, P5) ----------------
//
// Las plantillas viven en data/piloto/plantillas/ (vacias). Despues de cada
// sesion se llena una copia fuera del repositorio y npm run piloto:analisis
// -- --registros=<carpeta> las lee: valida cada fila, calcula el KPI y deja el
// trazado fila por fila (registros-manuales.csv). Asi ya no hay que
// transcribir los valores a mano al plan del piloto.

export type ManualTemplate = {
  /** Nombre de la plantilla en data/piloto/plantillas/. */
  file: string;
  /** Prefijo con el que piloto:analisis reconoce las copias llenas (registro-incidentes-2026-10-13.csv). */
  prefix: string;
  kpi: ManualKpiId;
  columns: string[];
  required: string[];
  /** Una frase para la documentacion y el informe. */
  purpose: string;
};

export const MANUAL_TEMPLATES: ManualTemplate[] = [
  {
    file: "registro-incidentes.csv",
    prefix: "registro-incidentes",
    kpi: "T7",
    columns: ["fecha", "hora_inicio", "hora_fin", "severidad", "sintoma", "afectados", "causa", "respuesta", "responsable", "evidencia"],
    required: ["fecha", "severidad"],
    purpose: "Una copia por sesión (registro-incidentes-AAAA-MM-DD.csv), una fila por incidente con severidad S1 a S4 del plan de soporte. T7 cuenta los S1.",
  },
  {
    file: "pruebas-humo.csv",
    prefix: "pruebas-humo",
    kpi: "T8",
    columns: ["fecha", "hora", "destino", "correctas", "total", "evidencia", "observaciones"],
    required: ["fecha", "destino", "correctas", "total"],
    purpose: "Una fila por corrida de npm run demo:escenarios contra producción («Resultado: N de M comprobaciones correctas») el día de una sesión. También se leen los demo-escenarios*.md que escribe ese script con --salida.",
  },
  {
    file: "tiempos-instalacion.csv",
    prefix: "tiempos-instalacion",
    kpi: "T10",
    columns: ["persona", "rol", "fecha", "camino", "navegador", "sistema_operativo", "inicio", "overlay_con_sesion", "editor_listo", "minutos_totales", "ayuda_recibida", "observaciones"],
    required: ["persona"],
    purpose: "Una fila por persona cronometrada (camino tunel o mac). Para el camino que no traiga, se usa la hoja de la prueba de inicio a fin (P1.1 a P1.6 y P4.1 a P4.3).",
  },
  {
    file: "cumplimiento.csv",
    prefix: "cumplimiento",
    kpi: "T11",
    columns: ["id", "area", "item", "critico", "verificacion", "estado", "evidencia", "responsable", "fecha"],
    required: ["id", "estado"],
    purpose: "Una fila por ítem de la lista de cumplimiento con su estado (cumple, no cumple, no aplica o pendiente). Los automáticos se copian de npm run piloto:verificar. Si hay varias copias, cuenta la de fecha más reciente en el nombre (cumplimiento-AAAA-MM-DD.csv) entre las que tienen algún ítem marcado.",
  },
  {
    file: "hallazgos.csv",
    prefix: "hallazgos",
    kpi: "P5",
    columns: ["id", "hallazgo", "kpis", "critica", "estado", "accion", "evidencia", "responsable"],
    required: ["id", "critica", "estado"],
    purpose: "Una fila por hallazgo (A14.5) con los KPIs que toca, si es crítico y el estado de su mejora (implementada, en curso, pendiente o descartada). También llena hallazgo y acción en trazabilidad.csv.",
  },
];

/** Fuentes que se leen sin plantilla propia. */
export const MANUAL_EXTRA_SOURCES = [
  { prefix: "demo-escenarios", extension: ".md", kpi: "T8" as ManualKpiId, purpose: "Evidencia de npm run demo:escenarios -- --url=<backend> --salida=<archivo>." },
  { prefix: "prueba-inicio-a-fin", extension: ".csv", kpi: "T10" as ManualKpiId, purpose: "Hoja de la prueba de inicio a fin: respaldo de T10 para el camino (túnel o Mac) que tiempos-instalacion.csv no traiga." },
];

export type ManualRecordFile = {
  name: string;
  text: string;
  /** windows-1252: el archivo no era UTF-8 (Excel «CSV (delimitado por comas)») y se volvió a leer así. */
  encoding?: "utf-8" | "windows-1252";
};

export type ManualRowTrace = {
  kpi: ManualKpiId | "";
  archivo: string;
  /** Fila de la hoja (la cabecera es la 1; sin contar filas vacías). null: el archivo entero. */
  fila: number | null;
  /** usada: entra al KPI; descartada: fila mal llenada (hay que corregirla); ignorada: válida pero no aplica. */
  estado: "usada" | "descartada" | "ignorada";
  valor: string;
  motivo: string;
};

export type ManualKpiSource = {
  kpi: ManualKpiId;
  value: number | null;
  n: number | null;
  files: string[];
  usedRows: number;
  discardedRows: number;
  /** Lectura sin el veredicto del umbral. */
  summary: string;
  notes: string[];
  /** Motivo para no cumplir aunque el valor pase el umbral (T11: ítems críticos). */
  blocking?: string | null;
  details?: Record<string, unknown>;
};

export type ManualFinding = { id: string; hallazgo: string; kpis: string[]; critica: boolean; estado: string; accion: string };

export type ManualRecordsResult = {
  sources: Partial<Record<ManualKpiId, ManualKpiSource>>;
  rows: ManualRowTrace[];
  /** Hallazgos validos de hallazgos*.csv, para trazabilidad.csv. */
  findings: ManualFinding[];
  unrecognized: string[];
};

export type SheetRow = {
  fila: number;
  values: Record<string, string>;
  /** Si la fila tiene más celdas que la cabecera, cuántas tiene (las columnas quedaron corridas); si no, null. */
  overflow: string | null;
};

export function stripAccents(value: string) {
  return value.normalize("NFD").replace(/[̀-ͯ]/g, "");
}

export function normalizeKey(value: string) {
  return stripAccents(String(value || "")).trim().toLowerCase().replace(/[\s-]+/g, "_");
}

export function readSheet(text: string, aliases: Record<string, string> = {}) {
  const [header, ...rows] = parseCsv(text);
  if (!header) return { columns: [] as string[], rows: [] as SheetRow[] };
  const columns = header.map((cell) => {
    const key = normalizeKey(cell);
    return aliases[key] || key;
  });
  return {
    columns,
    rows: rows.map((cells, index) => ({
      fila: index + 2,
      values: Object.fromEntries(columns.map((column, position) => [column, String(cells[position] ?? "").trim()])),
      overflow: cells.length > columns.length ? `${cells.length} celdas; la cabecera tiene ${columns.length}` : null,
    })),
  };
}

/**
 * Una fila con más celdas que la cabecera tiene las columnas corridas: casi
 * siempre una coma decimal (12,5) o un texto con comas sin comillas en una
 * hoja separada por comas. Se descarta con ese motivo, no con el de la columna
 * que quedó mal.
 */
export const OVERFLOW_REASON = "la fila tiene más celdas que la cabecera: ¿una coma decimal (12,5) o un texto con comas sin comillas en una hoja separada por «,»? Escribe 12.5, pon el valor entre comillas o guarda la hoja con separador «;»";

/** AAAA-MM-DD, DD/MM/AAAA (Excel en español) o una fecha ISO; null si no es una fecha real. */
export function parseRecordDate(value: string, timeZone = "America/Bogota") {
  const text = String(value || "").trim();
  if (/^\d{4}-\d{2}-\d{2}T.*(Z|[+-]\d{2}:?\d{2})$/i.test(text) && Number.isFinite(Date.parse(text))) return dayKey(text, timeZone);
  let match = text.match(/^(\d{4})-(\d{2})-(\d{2})(?:T[\d:.]+)?$/);
  let year: number;
  let month: number;
  let day: number;
  if (match) {
    [year, month, day] = [Number(match[1]), Number(match[2]), Number(match[3])];
  } else if ((match = text.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/))) {
    [day, month, year] = [Number(match[1]), Number(match[2]), Number(match[3])];
  } else {
    return null;
  }
  const date = new Date(Date.UTC(year, month - 1, day));
  if (date.getUTCFullYear() !== year || date.getUTCMonth() !== month - 1 || date.getUTCDate() !== day) return null;
  return `${year}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
}

/** Hora del día en segundos: HH:MM, HH:MM:SS, con a. m./p. m., o la hora de una fecha ISO. */
export function parseRecordClock(value: string) {
  const text = stripAccents(String(value || "")).trim().toLowerCase();
  const match = text.match(/^(\d{1,2}):(\d{2})(?::(\d{2}))?(?:\s*([ap])\.?\s*m\.?)?$/) || text.match(/t(\d{2}):(\d{2})(?::(\d{2}))?/);
  if (!match) return null;
  let hours = Number(match[1]);
  const minutes = Number(match[2]);
  const seconds = Number(match[3] || 0);
  const meridiem = match[4];
  if (meridiem) {
    if (hours < 1 || hours > 12) return null;
    hours = (hours % 12) + (meridiem === "p" ? 12 : 0);
  }
  if (hours > 23 || minutes > 59 || seconds > 59) return null;
  return hours * 3600 + minutes * 60 + seconds;
}

/** Número con coma o punto decimal, con "min" opcional ("12,5 min"). */
export function parseRecordNumber(value: string) {
  const text = String(value || "").trim().toLowerCase().replace(/\s*min(utos)?\.?$/, "").replace(",", ".");
  if (!/^\d+(\.\d+)?$/.test(text)) return null;
  return Number(text);
}

export function parseCount(value: string) {
  const text = String(value || "").trim();
  return /^\d+$/.test(text) ? Number(text) : null;
}

/** true / false; null si está vacío; undefined si no se entiende. */
export function parseYesNo(value: string) {
  const text = stripAccents(String(value || "")).trim().toLowerCase();
  if (!text) return null;
  if (["si", "s", "yes", "y", "x", "true", "1"].includes(text)) return true;
  if (["no", "n", "false", "0"].includes(text)) return false;
  return undefined;
}

export function localClock(iso: string, timeZone: string) {
  const parts = new Intl.DateTimeFormat("en-GB", { timeZone, hour: "2-digit", minute: "2-digit", second: "2-digit", hourCycle: "h23" }).formatToParts(new Date(iso));
  const part = (type: string) => Number(parts.find((item) => item.type === type)?.value || 0);
  return part("hour") * 3600 + part("minute") * 60 + part("second");
}

export function clockText(seconds: number | null) {
  if (seconds === null) return "";
  return `${String(Math.floor(seconds / 3600)).padStart(2, "0")}:${String(Math.floor((seconds % 3600) / 60)).padStart(2, "0")}`;
}

export function missingColumns(columns: string[], required: string[]) {
  return required.filter((column) => !columns.includes(column));
}

export function listText(items: string[], max = 6) {
  return items.length > max ? `${items.slice(0, max).join(", ")} y ${items.length - max} más` : items.join(", ");
}

export type ManualContext = {
  trace: ManualRowTrace[];
  sessionDates: string[];
  timeZone: string;
};

export function tracker(context: ManualContext, kpi: ManualKpiId) {
  let used = 0;
  let discarded = 0;
  const add = (archivo: string, fila: number | null, estado: ManualRowTrace["estado"], valor: string, motivo: string) => {
    if (estado === "usada") used += 1;
    if (estado === "descartada") discarded += 1;
    context.trace.push({ kpi, archivo, fila, estado, valor, motivo });
  };
  return {
    get used() { return used; },
    get discarded() { return discarded; },
    add,
    /** Descarta la fila si tiene las columnas corridas (ver OVERFLOW_REASON); true si la descartó. */
    overflowed(archivo: string, row: SheetRow) {
      if (!row.overflow) return false;
      add(archivo, row.fila, "descartada", row.overflow, OVERFLOW_REASON);
      return true;
    },
  };
}

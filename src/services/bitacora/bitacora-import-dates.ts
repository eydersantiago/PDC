// Importar la bitacora: fechas (texto, numero de serie de Excel y hora) y limpieza de celdas.
import { trimText } from "../shared/text-utils.js";

const MONTHS: Record<string, number> = {
  ene: 0,
  enero: 0,
  feb: 1,
  febrero: 1,
  mar: 2,
  marzo: 2,
  abr: 3,
  abril: 3,
  may: 4,
  mayo: 4,
  jun: 5,
  junio: 5,
  jul: 6,
  julio: 6,
  ago: 7,
  agosto: 7,
  sep: 8,
  sept: 8,
  septiembre: 8,
  oct: 9,
  octubre: 9,
  nov: 10,
  noviembre: 10,
  dic: 11,
  diciembre: 11,
};

const DEFAULT_BITACORA_EVENT_HOUR = 9;

export function cleanText(value: unknown) {
  if (value == null) return "";
  if (value instanceof Date) return value.toISOString();
  if (typeof value === "string") return trimText(value).replace(/\u00a0/g, " ");
  if (typeof value === "number") return String(value);
  if (typeof value === "boolean") return value ? "Sí" : "No";
  if (typeof value === "object" && "text" in value && typeof value.text === "string") return trimText(value.text).replace(/\u00a0/g, " ");
  if (typeof value === "object" && "result" in value) return cleanText((value as { result?: unknown }).result);
  return "";
}

function pad(value: number, size = 2) {
  return String(value).padStart(size, "0");
}

export function normalizeDateText(value: unknown) {
  return trimText(value)
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/\s+/g, " ");
}

function extractClockTime(value: string) {
  const match = value.match(/\b(\d{1,2})[:h](\d{2})\b/);
  if (!match) return { hour: 0, minute: 0 };

  const hour = Number(match[1]);
  const minute = Number(match[2]);
  if (hour < 0 || hour > 23 || minute < 0 || minute > 59) {
    return { hour: DEFAULT_BITACORA_EVENT_HOUR, minute: 0 };
  }

  return { hour, minute };
}

function toIsoFromParts(year: number, monthIndex: number, day: number, hour = DEFAULT_BITACORA_EVENT_HOUR, minute = 0) {
  const normalizedYear = year < 100 ? year + 2000 : year;
  if (
    normalizedYear < 2000
    || monthIndex < 0
    || monthIndex > 11
    || day < 1
    || day > 31
    || hour < 0
    || hour > 23
    || minute < 0
    || minute > 59
  ) {
    return null;
  }

  const candidate = new Date(Date.UTC(normalizedYear, monthIndex, day, hour, minute, 0, 0));
  if (
    candidate.getUTCFullYear() !== normalizedYear
    || candidate.getUTCMonth() !== monthIndex
    || candidate.getUTCDate() !== day
  ) {
    return null;
  }

  return `${normalizedYear.toString(10)}-${pad(monthIndex + 1)}-${pad(day)}T${pad(hour)}:${pad(minute)}:00-05:00`;
}

function excelSerialToIso(serial: number) {
  const date = new Date(Math.round((serial - 25569) * 86400_000));
  if (Number.isNaN(date.getTime())) return null;
  return `${date.getUTCFullYear()}-${pad(date.getUTCMonth() + 1)}-${pad(date.getUTCDate())}T${pad(DEFAULT_BITACORA_EVENT_HOUR)}:00:00-05:00`;
}

function parseDateFromText(raw: string) {
  const source = normalizeDateText(raw);
  if (!source) return null;

  const isoMatch = source.match(/(\d{4})-(\d{1,2})-(\d{1,2})/);
  if (isoMatch) {
    return toIsoFromParts(
      Number(isoMatch[1]),
      Number(isoMatch[2]) - 1,
      Number(isoMatch[3]),
      DEFAULT_BITACORA_EVENT_HOUR,
      0,
    );
  }

  const simple = source.match(
    /\b(\d{1,2})[\/\.-](\d{1,2})(?:[\/\.-](\d{2,4}))?(?:\s+(\d{1,2})[:h](\d{2}))?/,
  );
  if (simple) {
    const now = new Date();
    const day = Number(simple[1]);
    const month = Number(simple[2]) - 1;
    const year = simple[3] ? Number(simple[3]) : now.getUTCFullYear();
    const clock = extractClockTime(source);
    const hour = Number(simple[4]) || clock.hour;
    const minute = Number(simple[5]) || clock.minute;
    return toIsoFromParts(year, month, day, hour, minute);
  }

  const spanish = source.match(
    /\b(\d{1,2})\s*(?:de\s*)?(ene|enero|feb|febrero|mar|marzo|abr|abril|may|mayo|jun|junio|jul|julio|ago|agosto|sept|septiembre|oct|octubre|nov|noviembre|dic|diciembre)(?:\s*(?:de\s*)?(\d{2,4}))?(?:\s+(?:a|hasta|y)\s*)?(?:\d{1,2}\s*(?:de\s*)?(ene|enero|feb|febrero|mar|marzo|abr|abril|may|mayo|jun|junio|jul|julio|ago|agosto|sept|septiembre|oct|octubre|nov|noviembre|dic|diciembre)?\s*(\d{2,4})?)?(?:\D{0,24}(\d{1,2})[:h](\d{2}))?/,
  );
  if (spanish) {
    const now = new Date();
    const day = Number(spanish[1]);
    const monthIndex = MONTHS[spanish[2]] ?? -1;
    const year = spanish[3] ? Number(spanish[3]) : now.getUTCFullYear();
    const clock = extractClockTime(source);
    return toIsoFromParts(year, monthIndex, day, clock.hour, clock.minute);
  }

  return null;
}

export function parseDate(value: unknown) {
  if (value == null) return { dateIso: null, visible: "" };

  if (value instanceof Date) {
    const fallback = `${value.getUTCFullYear()}-${pad(value.getUTCMonth() + 1)}-${pad(value.getUTCDate())}T${pad(DEFAULT_BITACORA_EVENT_HOUR)}:00:00-05:00`;
    return { dateIso: fallback, visible: value.toISOString() };
  }

  if (typeof value === "number") {
    return { dateIso: excelSerialToIso(value), visible: String(value) };
  }

  if (typeof value === "object" && "result" in value) {
    return parseDate((value as { result?: unknown }).result);
  }

  const raw = cleanText(value);
  const visible = raw;
  if (!visible) return { dateIso: null, visible };

  return { dateIso: parseDateFromText(visible), visible };
}

export function compact(value: string, max = 320) {
  const text = trimText(value).replace(/\s+/g, " ");
  if (!text) return "";
  return text.length <= max ? text : `${text.slice(0, Math.max(0, max - 3))}...`;
}

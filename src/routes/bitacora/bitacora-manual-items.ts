// Bitacora: registro manual (esquemas, fechas, categorias y items) y ayudas comunes a importar un archivo.
import { z } from "zod";
import { catalogoClasificacionActividad } from "../../services/bitacora/bitacora-template.js";
import type { BitacoraAgendaItem } from "../../services/documents/bitacora-agenda.js";
import { normalizeRepoFullName } from "../../services/documents/project-context.js";
import { trimText } from "../../services/shared/text-utils.js";

export const bitacoraManualItemSchema = z.object({
  week: z.coerce.number().int().min(1).max(20).optional(),
  dueAt: z.string().max(180).optional(),
  title: z.string().min(1).max(260),
  type: z.string().max(140).optional(),
  subtype: z.string().max(160).optional(),
  description: z.string().max(1600).optional(),
  notes: z.string().max(1600).optional(),
  modality: z.string().max(100).optional(),
  state: z.string().max(100).optional(),
}).strict();

export const bitacoraManualImportSchema = z.object({
  repoFullName: z.string().max(240).optional(),
  requestId: z.string().max(120).optional(),
  snapshotId: z.string().max(120).optional(),
  sourceName: z.string().max(180).optional(),
  fileName: z.string().max(500).optional(),
  activities: z.array(bitacoraManualItemSchema).max(240).optional(),
  exams: z.array(bitacoraManualItemSchema).max(160).optional(),
  dryRun: z.boolean().optional(),
  teacherUserId: z.string().max(120).optional(),
}).strict();

export function compactText(value: string, max = 300) {
  const text = trimText(value).replace(/\s+/g, " ");
  if (!text) return "";
  return text.length <= max ? text : `${text.slice(0, Math.max(0, max - 3))}...`;
}

export function isIsoDateLike(value: string) {
  const normalized = trimText(value).toLowerCase();
  return /^[0-9]{4}-[0-9]{2}-[0-9]{2}/.test(normalized);
}

export function buildManualDueAt(value: string) {
  const source = trimText(value).toLowerCase();
  if (!source) return { dueAt: null as string | null, visibleDueText: "" };
  if (isIsoDateLike(source)) {
    const withoutTime = source.split(/[T ]/)[0];
    const match = withoutTime.match(/(\d{4})-(\d{1,2})-(\d{1,2})/);
    if (!match) return { dueAt: null, visibleDueText: source };
    const year = Number(match[1]);
    const month = Number(match[2]);
    const day = Number(match[3]);
    if (
      Number.isInteger(year)
      && Number.isInteger(month)
      && Number.isInteger(day)
      && month >= 1 && month <= 12
      && day >= 1 && day <= 31
    ) {
      return {
        dueAt: `${String(year).padStart(4, "0")}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}T09:00:00-05:00`,
        visibleDueText: source,
      };
    }
    return { dueAt: null, visibleDueText: source };
  }

  const matchSlash = source.match(/^(\d{1,2})[\/\-](\d{1,2})(?:[\/\-](\d{2,4}))?(?:\s+(\d{1,2}):(\d{2}))?$/);
  if (matchSlash) {
    const day = Number(matchSlash[1]);
    const month = Number(matchSlash[2]);
    const year = matchSlash[3]
      ? Number(matchSlash[3].length === 2 ? `20${matchSlash[3]}` : matchSlash[3])
      : new Date().getUTCFullYear();
    const hour = Number(matchSlash[4] || "9");
    const minute = Number(matchSlash[5] || "0");
    if (
      Number.isInteger(day)
      && Number.isInteger(month)
      && Number.isInteger(year)
      && Number.isInteger(hour)
      && Number.isInteger(minute)
      && month >= 1 && month <= 12
      && day >= 1 && day <= 31
      && hour >= 0 && hour <= 23
      && minute >= 0 && minute <= 59
    ) {
      return {
        dueAt: `${String(year).padStart(4, "0")}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}T${String(hour).padStart(2, "0")}:${String(minute).padStart(2, "0")}:00-05:00`,
        visibleDueText: source,
      };
    }
  }

  const parsedDate = new Date(source);
  if (!Number.isNaN(parsedDate.getTime())) {
    return {
      dueAt: parsedDate.toISOString(),
      visibleDueText: source,
    };
  }

  return { dueAt: null, visibleDueText: source };
}

export function buildBitacoraImportRepoName(session: { user: { id: string } }) {
  const safeTeacherId = trimText(session.user.id).replace(/[^a-z0-9-]/gi, "").slice(0, 24) || "teacher";
  return normalizeRepoFullName(`docentes/${safeTeacherId}`) || "docentes/manual";
}

export function buildManualBitacoraValidation(input: {
  activities: Array<z.infer<typeof bitacoraManualItemSchema>>;
  exams: Array<z.infer<typeof bitacoraManualItemSchema>>;
}) {
  const allRows = [...input.activities, ...input.exams];
  const weeks = allRows.map((row) => row.week).filter((value): value is number => value !== undefined);
  const uniqueWeeks = new Set(weeks.map((week) => String(week)));
  return {
    minimumWeeks: 0,
    createdWeeks: uniqueWeeks.size,
    hasActivities: input.activities.length > 0,
    hasExams: input.exams.length > 0,
    isValid: allRows.length > 0,
    errors: [] as string[],
    warnings: allRows.length === 0
      ? ["No se enviaron filas de actividades ni exámenes desde la interfaz."]
      : [],
  };
}

export function normalizeManualBitacoraCategory(value: string) {
  const text = trimText(value)
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "");
  const found = catalogoClasificacionActividad.find((category) =>
    category.toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "") === text);
  return found || "Actividad";
}

export function inferManualAgendaType(source: "Actividades" | "Exámenes", category: string, title: string, subtype = ""): BitacoraAgendaItem["type"] {
  const normalized = normalizeManualBitacoraCategory(category);
  if (normalized === "Proyecto" || normalized === "Parcial" || normalized === "Quiz") return "task";
  if (normalized === "Actividad" || normalized === "Ejercicio") {
    return source === "Exámenes" ? "task" : "activity";
  }

  const search = `${title} ${category} ${subtype}`.toLowerCase();
  if (/examen|quiz|parcial|proyecto|entrega|evalu/.test(search)) return "task";
  return source === "Exámenes" ? "task" : "activity";
}

export function parseManualBitacoraItems(input: {
  activities: Array<z.infer<typeof bitacoraManualItemSchema>>;
  exams: Array<z.infer<typeof bitacoraManualItemSchema>>;
}) {
  const items: BitacoraAgendaItem[] = [];
  const warnings: string[] = [];
  const sections: Array<{
    source: "Actividades" | "Exámenes";
    rows: typeof input.activities;
  }> = [
    { source: "Actividades", rows: input.activities },
    { source: "Exámenes", rows: input.exams },
  ];

  for (const section of sections) {
    section.rows.forEach((row, index) => {
      const rowIndex = index + 1;
      const title = compactText(row.title, 220);
      const notes = compactText(compactText(row.notes || ""), 260);
      const typeValue = compactText(row.type || "", 120);
      const category = normalizeManualBitacoraCategory(typeValue);
      const subtypeValue = compactText(row.subtype || "", 140);
      const description = compactText(row.description || "", 500);
      const parsedDate = buildManualDueAt(row.dueAt || "");
      const visibleText = parsedDate.visibleDueText;
      const evidence = [
        `Origen: interfaz docente`,
        `Hoja: ${section.source}`,
        `Fila: ${rowIndex}`,
      ];

      if (!trimText(title) && !trimText(description)) {
        warnings.push(`Se omitió ${section.source} fila ${rowIndex}: falta título y descripción.`);
        return;
      }

      const resolvedTitle = section.source === "Exámenes" && title
        ? `Examen: ${title}`
        : title || "Sin titulo";

      const resolvedDescription = compactText([
        `Clasificación: ${category}`,
        typeValue ? `Tipo: ${typeValue}` : "",
        subtypeValue ? `Subtipo: ${subtypeValue}` : "",
        row.modality ? `Modalidad: ${row.modality}` : "",
        row.state ? `Estado: ${row.state}` : "",
        notes,
        description,
      ].filter(Boolean).join(" | "), 520);

      if (!parsedDate.dueAt && trimText(row.dueAt)) {
        warnings.push(`Se omiti\u00f3 fecha interpretada en ${section.source} fila ${rowIndex}: "${trimText(row.dueAt)}".`);
        evidence.push(`Fecha informada: ${visibleText}`);
      }

      items.push({
        title: resolvedTitle,
        type: inferManualAgendaType(section.source, category, title, subtypeValue),
        category,
        dueAt: parsedDate.dueAt,
        visibleDueText: visibleText,
        description: resolvedDescription,
        confidence: category === "Parcial" || category === "Quiz" ? 0.98 : 0.95,
        evidence: [
          ...evidence,
          `Clasificación: ${category}`,
        ],
      });
    });
  }

  const withDate = items.filter((item) => Boolean(item.dueAt)).length;
  return {
    items,
    summary: items.length
      ? `Se detectaron ${items.length} registro(s) creados desde la interfaz docente.`
      : "No se detectaron filas con información valida para agendar.",
    warnings,
    withDate,
    withoutDate: items.length - withDate,
    activities: items.filter((item) => item.type === "activity").length,
    exams: items.filter((item) => item.type === "task").length,
  };
}

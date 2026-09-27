import type { BitacoraAgendaItem } from "./document-classifier.js";
import { getBitacoraWeeklyColumns, type BitacoraWeeklyRow } from "./bitacora-template.js";
import { trimText } from "./text-utils.js";

/**
 * Exportar la bitacora cargada (navegador 0.7.15) con el diseno de la plantilla
 * semanal: Semana | Fecha | Tema | Clasificacion | Actividades en clase |
 * Actividades evaluacion. Los items guardados (bitacoraAgenda.items, que salen de
 * bitacora-import.ts) son planos; aqui se vuelven a agrupar por semana, fecha y
 * tema leyendo las marcas que deja la importacion en description y evidence
 * («Tema:», «Actividades en clase:», «Actividades evaluación:», «Semana:», «Hoja:»).
 */

type ExportGroup = BitacoraWeeklyRow & { classActivities: string[]; evaluationActivities: string[]; order: number };

function fieldFrom(text: string, label: string) {
  const match = new RegExp(`(?:^|\\|)\\s*${label}\\s*:\\s*([^|]+)`, "i").exec(text);
  return match ? trimText(match[1]) : "";
}

function weekOf(item: BitacoraAgendaItem) {
  for (const evidence of item.evidence || []) {
    const match = /Semana\s*:\s*(\d{1,2})/i.exec(String(evidence));
    if (match) return match[1];
  }
  const fromDescription = fieldFrom(item.description || "", "Semana");
  return /^\d{1,2}$/.test(fromDescription) ? fromDescription : "";
}

function sheetOf(item: BitacoraAgendaItem) {
  for (const evidence of item.evidence || []) {
    const match = /Hoja\s*:\s*(.+)$/i.exec(String(evidence));
    if (match) return trimText(match[1]);
  }
  return "";
}

function pushUnique(list: string[], value: string) {
  const clean = trimText(value);
  if (clean && !list.includes(clean)) list.push(clean);
}

export function buildBitacoraExportRows(items: BitacoraAgendaItem[]): BitacoraWeeklyRow[] {
  const groups = new Map<string, ExportGroup>();
  items.forEach((item, index) => {
    const description = String(item.description || "");
    const week = weekOf(item);
    const fecha = trimText(item.visibleDueText) || (item.dueAt ? String(item.dueAt).slice(0, 10) : "");
    const tema = fieldFrom(description, "Tema") || fieldFrom(description, "Subtipo");
    const clasificacion = trimText(item.category || "") || fieldFrom(description, "Clasificación");
    const sheet = sheetOf(item);
    const isExam = sheet === "Exámenes" || /^Examen:/i.test(item.title || "");
    const classActivity = fieldFrom(description, "Actividades en clase");
    const evaluationActivity = fieldFrom(description, "Actividades evaluación")
      || fieldFrom(description, "Evaluación relacionada")
      || (isExam ? trimText(String(item.title || "").replace(/^Examen:\s*/i, "")) : "");
    const key = `${week}|${fecha}|${tema.toLowerCase()}`;
    let group = groups.get(key);
    if (!group) {
      group = {
        semana: week,
        fecha,
        tema,
        clasificacion,
        actividadesClase: "",
        actividadesEvaluacion: "",
        classActivities: [],
        evaluationActivities: [],
        order: index,
      };
      groups.set(key, group);
    }
    if (!group.clasificacion && clasificacion) group.clasificacion = clasificacion;
    if (!group.tema && tema) group.tema = tema;
    if (isExam) {
      pushUnique(group.evaluationActivities, evaluationActivity || item.title);
    } else {
      pushUnique(group.classActivities, classActivity || (tema && item.title !== tema ? item.title : item.title));
      if (evaluationActivity) pushUnique(group.evaluationActivities, evaluationActivity);
    }
  });

  return [...groups.values()]
    .sort((left, right) => {
      const weekLeft = Number(left.semana) || 99;
      const weekRight = Number(right.semana) || 99;
      if (weekLeft !== weekRight) return weekLeft - weekRight;
      return left.order - right.order;
    })
    .map((group) => ({
      semana: group.semana,
      fecha: group.fecha,
      tema: group.tema,
      clasificacion: group.clasificacion,
      actividadesClase: group.classActivities.join("; "),
      actividadesEvaluacion: group.evaluationActivities.join("; "),
    }));
}

function csvCell(value: string | number) {
  const text = String(value ?? "");
  return /[";\n\r]/.test(text) ? `"${text.replace(/"/g, "\"\"")}"` : text;
}

/** CSV con BOM y «;» (Excel en espanol lo abre en columnas; Power BI lo detecta). */
export function buildBitacoraCsv(rows: BitacoraWeeklyRow[]) {
  const lines = [getBitacoraWeeklyColumns().map(csvCell).join(";")];
  for (const row of rows) {
    lines.push([row.semana, row.fecha, row.tema, row.clasificacion, row.actividadesClase, row.actividadesEvaluacion].map(csvCell).join(";"));
  }
  return `﻿${lines.join("\r\n")}\r\n`;
}

export function buildBitacoraExportFileName(input: { courseCode?: string; format: "xlsx" | "csv"; date?: Date }) {
  const code = trimText(input.courseCode || "").toLowerCase().replace(/[^a-z0-9]+/g, "") || "curso";
  const day = (input.date || new Date()).toISOString().slice(0, 10);
  return `bitacora_${code}_${day}.${input.format}`;
}

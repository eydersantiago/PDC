import ExcelJS from "exceljs";

type BitacoraTemplateContext = {
  teacher: {
    id: string;
    displayName: string;
    email: string;
  };
  courseName?: string;
  courseCode?: string;
  group?: string;
  academicPeriod?: string;
};

export type BitacoraTemplateCatalogs = {
  clasificacionesActividad: string[];
  tiposActividad: string[];
  modalidades: string[];
  estados: string[];
  tiposExamen: string[];
  periodicidades: string[];
};

export type BitacoraTemplateUiMetadata = {
  fileType: string;
  sheetNames: {
    bitacora: string;
    catalogos: string;
    instrucciones: string;
    metadatos: string;
  };
  requiredColumns: {
    bitacora: string[];
  };
  recommendations: string[];
  maxRows: {
    bitacora: number;
  };
  catalogs: BitacoraTemplateCatalogs;
};

const MAX_WEEKLY_ROWS = 80;
const BITACORA_SHEET_NAME = "Bitacora";
const BITACORA_COLUMNS = [
  "Semana",
  "Fecha",
  "Tema",
  "Clasificación",
  "Actividades en clase",
  "Actividades evaluación",
];

export const BITACORA_TEMPLATE_DEFAULTS = {
  courseName: "Fundamentos de Programacion Orientada a Objetos",
  courseCode: "FPOO",
  group: "Demo",
  academicPeriod: "2026-1",
} as const;

export const BITACORA_TEMPLATE_FILE_NAME = "plantilla_bitacora_fpoo_2026_1.xlsx";

const FPOO_WEEKLY_TEMPLATE_ROWS = [
  [1, "11-02-2026", "Programa, Reglas de juego, Bitacora", "C++ básico, el factorial, compilar por consola", "Programación orientada a objetos: Uso del lenguaje de programación C++ sus tipos de datos básicos"],
  [2, "18-02-2026", "Un programa en C++ vs C++ POO", "Visual Studio Code: Factorial vs Uso de objetos", "Programación orientada a objetos: El proceso de compilación, el hardware y los ámbitos de un programa"],
  [3, "25-02-2026", "Un programa en C++: Variables, Vectores, Referencias, Punteros, New, Delete", "Programa básico en C++ con vectores y referencias", "Quiz lecturas anteriores semanas y Taller"],
  [4, "04-03-2026", "Potencialidades POO. El uso de los objetos para programar", "POO: paso de mensajes Banco", "Caso de Cruz Roja"],
  [5, "11-03-2026", "Pilares del Paradigma OO. Conceptos y código en C++ (Clase invertida)", "Implementación de una clase: abstacción y encapsulamiento", "Quiz Pilares"],
  [6, "13-05-2026", "HUs, Diagrama de clases y relación de uso", "Ejercicio completo: abstracción, diseño e implementación", "Registro de Medicamentos"],
  [7, "20-05-2026", "Abstracción, encapsulamiento y test (clase invertida)", "Ejercicio completo: abstracción, diseño, implementación y test", "IMC"],
  [8, "27-05-2026", "Reutilización de código, modularidad y refactoring (clase invertida)", "Ejercicio: librerias, APis, Modulos y refactoring", "Nutrición"],
  [9, "03-06-2026", "Parcial", "Presentación del proyecto", "Examen y Evaluación del proyecto"],
  [10, "10-06-2026", "Abstraer relaciones de diferente tipo", "Discusión podcast e implementación de relaciones", "Entrega del proyecto"],
  [11, "17-06-2026", "Herencia", "Implementación de un proyecto con herencia", "Entrega del proyecto"],
  [12, "24-06-2026", "Polimorfismo", "Implementación de un proyecto con polimorfismo", "Entrega del proyecto"],
  [13, "01-07-2026", "Entrega final del proyecto", "Entrega del proyecto", ""],
  [14, "08-07-2026", "Examen final", "Examen", ""],
  [15, "15-07-2026", "Opcionales", "Examenes", ""],
] satisfies Array<[number, string, string, string, string]>;

export const catalogoClasificacionActividad = [
  "Actividad",
  "Proyecto",
  "Ejercicio",
  "Parcial",
  "Quiz",
];

function inferBitacoraTemplateClassification(...values: string[]) {
  const text = values
    .join(" ")
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "");
  if (/\bquiz|cuestionario\b/.test(text)) return "Quiz";
  if (/\bparcial|examen|evaluacion\b/.test(text)) return "Parcial";
  if (/\bproyecto|entrega|sustentacion\b/.test(text)) return "Proyecto";
  if (/\bejercicio|taller|laboratorio|practica\b/.test(text)) return "Ejercicio";
  return "Actividad";
}

export const catalogoActividades = [
  "Clase",
  "Taller",
  "Laboratorio",
  "Proyecto",
  "Examen",
  "Quiz",
  "Tarea",
  "Sustentación",
  "Reunión de Seguimiento",
];

export const catalogoModalidad = [
  "Presencial",
  "Virtual Sincrónica",
  "Virtual Asincrónica",
  "Híbrido",
];

export const catalogoEstado = [
  "Pendiente",
  "En Progreso",
  "Finalizada",
  "Reprogramada",
];

export const catalogoTipoExamen = [
  "Quiz",
  "Parcial",
  "Taller Evaluable",
  "Proyecto Parcial",
  "Examen Final",
  "Sustentación",
];

export const catalogoPeriodicidad = [
  "Semanal",
  "Quincenal",
  "Por Semana",
  "Evento Único",
];

function formatGeneratedAt(date: Date) {
  return date.toLocaleDateString("es-CO", {
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  });
}

function writeMetadataSheet(workbook: ExcelJS.Workbook, context: BitacoraTemplateContext, generatedAt: Date) {
  const sheet = workbook.addWorksheet("Metadatos");
  sheet.state = "hidden";
  sheet.columns = [
    { header: "Campo", key: "campo", width: 26 },
    { header: "Valor", key: "valor", width: 48 },
  ];

  const metadataRows = [
    ["Docente", context.teacher.displayName],
    ["Correo docente", context.teacher.email],
    ["ID docente", context.teacher.id],
    ["Curso", context.courseName || BITACORA_TEMPLATE_DEFAULTS.courseName],
    ["Código del curso", context.courseCode || BITACORA_TEMPLATE_DEFAULTS.courseCode],
    ["Grupo", context.group || BITACORA_TEMPLATE_DEFAULTS.group],
    ["Periodo académico", context.academicPeriod || BITACORA_TEMPLATE_DEFAULTS.academicPeriod],
    ["Fecha de generación", formatGeneratedAt(generatedAt)],
  ];

  metadataRows.forEach((row) => {
    sheet.addRow({ campo: row[0], valor: row[1] });
  });

  const header = sheet.getRow(1);
  header.font = { bold: true };
  sheet.eachRow((r) => {
    r.eachCell((cell) => {
      cell.border = {
        top: { style: "thin", color: { argb: "FFCBD5E1" } },
        left: { style: "thin", color: { argb: "FFCBD5E1" } },
        bottom: { style: "thin", color: { argb: "FFCBD5E1" } },
        right: { style: "thin", color: { argb: "FFCBD5E1" } },
      };
    });
  });
}

function writeCatalogSheet(workbook: ExcelJS.Workbook) {
  const sheet = workbook.addWorksheet("Catalogos");
  sheet.columns = [
    { header: "Clasificación actividad", key: "clasificacion", width: 28 },
    { header: "Tipo actividad", key: "tipo", width: 30 },
    { header: "Modalidad", key: "modalidad", width: 24 },
    { header: "Tipo examen", key: "tipoExamen", width: 24 },
    { header: "Estado", key: "estado", width: 20 },
    { header: "Periodicidad", key: "periodicidad", width: 20 },
  ];

  const maxLength = Math.max(
    catalogoClasificacionActividad.length,
    catalogoActividades.length,
    catalogoModalidad.length,
    catalogoTipoExamen.length,
    catalogoEstado.length,
    catalogoPeriodicidad.length,
  );

  for (let row = 0; row < maxLength; row += 1) {
    sheet.addRow({
      clasificacion: catalogoClasificacionActividad[row] || null,
      tipo: catalogoActividades[row] || null,
      modalidad: catalogoModalidad[row] || null,
      tipoExamen: catalogoTipoExamen[row] || null,
      estado: catalogoEstado[row] || null,
      periodicidad: catalogoPeriodicidad[row] || null,
    });
  }

  sheet.getRow(1).font = { bold: true };
  sheet.state = "hidden";
}

function writeInstructionSheet(workbook: ExcelJS.Workbook) {
  const sheet = workbook.addWorksheet("Instrucciones");
  sheet.columns = [
    { width: 100 },
  ];
  sheet.addRow(["Plantilla de bitácora semanal del curso"]);
  sheet.addRow([
    "1) Completa la hoja 'Bitacora' con una fila por semana.",
  ]);
  sheet.addRow([
    "2) Mantén las columnas Semana, Fecha, Tema, Clasificación, Actividades en clase y Actividades evaluación.",
  ]);
  sheet.addRow([
    "3) Usa el selector Clasificación para marcar Actividad, Proyecto, Ejercicio, Parcial o Quiz.",
  ]);
  sheet.addRow([
    "4) Usa fechas en formato dd-mm-aaaa, dd/mm/aaaa o yyyy-mm-dd.",
  ]);
  sheet.addRow([
    "5) Puedes subir esta plantilla como Excel o exportarla a PDF para extracción automática.",
  ]);
  sheet.getCell("A1").font = { bold: true, size: 12 };
  sheet.getRows(1, 5)?.forEach((row) => {
    row.font = { name: "Calibri", size: 11 };
    row.eachCell((cell) => {
      cell.alignment = { wrapText: true, vertical: "top" };
      cell.border = {
        top: { style: "thin", color: { argb: "FFCBD5E1" } },
        left: { style: "thin", color: { argb: "FFCBD5E1" } },
        bottom: { style: "thin", color: { argb: "FFCBD5E1" } },
        right: { style: "thin", color: { argb: "FFCBD5E1" } },
      };
    });
  });
}

function writeWeeklyBitacoraSheet(workbook: ExcelJS.Workbook) {
  const sheet = workbook.addWorksheet(BITACORA_SHEET_NAME);
  sheet.columns = [
    { header: "Semana", key: "semana", width: 10 },
    { header: "Fecha", key: "fecha", width: 16 },
    { header: "Tema", key: "tema", width: 44 },
    { header: "Clasificación", key: "clasificacion", width: 18 },
    { header: "Actividades en clase", key: "actividadesClase", width: 46 },
    { header: "Actividades evaluación", key: "actividadesEvaluacion", width: 48 },
  ];

  const header = sheet.getRow(1);
  header.height = 24;
  header.font = { bold: true, color: { argb: "FFFFFFFF" } };
  header.alignment = { vertical: "middle", horizontal: "center", wrapText: true };
  header.eachCell((cell) => {
    cell.fill = {
      type: "pattern",
      pattern: "solid",
      fgColor: { argb: "FF173046" },
    };
    cell.border = {
      top: { style: "thin", color: { argb: "FFCBD5E1" } },
      left: { style: "thin", color: { argb: "FFCBD5E1" } },
      bottom: { style: "thin", color: { argb: "FFCBD5E1" } },
      right: { style: "thin", color: { argb: "FFCBD5E1" } },
    };
  });

  for (const row of FPOO_WEEKLY_TEMPLATE_ROWS) {
    sheet.addRow({
      semana: row[0],
      fecha: row[1],
      tema: row[2],
      clasificacion: inferBitacoraTemplateClassification(row[2], row[3], row[4]),
      actividadesClase: row[3],
      actividadesEvaluacion: row[4],
    });
  }

  for (let rowIndex = 2; rowIndex <= MAX_WEEKLY_ROWS + 1; rowIndex += 1) {
    const row = sheet.getRow(rowIndex);
    row.height = rowIndex <= FPOO_WEEKLY_TEMPLATE_ROWS.length + 1 ? 42 : 28;
    row.alignment = { vertical: "top", wrapText: true };
    row.eachCell({ includeEmpty: true }, (cell, colNumber) => {
      cell.border = {
        top: { style: "thin", color: { argb: "FFE5E7EB" } },
        left: { style: "thin", color: { argb: "FFE5E7EB" } },
        bottom: { style: "thin", color: { argb: "FFE5E7EB" } },
        right: { style: "thin", color: { argb: "FFE5E7EB" } },
      };
      if (colNumber === 1) {
        cell.alignment = { vertical: "middle", horizontal: "center" };
        cell.dataValidation = {
          type: "whole",
          operator: "between",
          formulae: ["1", "20"],
          showErrorMessage: true,
          errorStyle: "error",
          errorTitle: "Semana inválida",
          error: "La semana debe ser un número entre 1 y 20.",
        };
      } else if (colNumber === 4) {
        cell.dataValidation = {
          type: "list",
          allowBlank: true,
          formulae: [`"${catalogoClasificacionActividad.join(",")}"`],
          showErrorMessage: true,
          errorStyle: "error",
          errorTitle: "Clasificación inválida",
          error: "Selecciona Actividad, Proyecto, Ejercicio, Parcial o Quiz.",
        };
      }
    });
  }

  sheet.autoFilter = {
    from: "A1",
    to: "F1",
  };
  sheet.views = [{ state: "frozen", ySplit: 1 }];
}

export async function buildBitacoraTemplate(context: BitacoraTemplateContext) {
  const generatedAt = new Date();
  const workbook = new ExcelJS.Workbook();
  workbook.creator = context.teacher.displayName || "Profesor";
  workbook.company = "ADACEEN";
  workbook.created = generatedAt;

  writeWeeklyBitacoraSheet(workbook);
  writeMetadataSheet(workbook, context, generatedAt);
  writeCatalogSheet(workbook);
  writeInstructionSheet(workbook);

  return workbook.xlsx.writeBuffer();
}

export function getBitacoraTemplateCatalogs(): BitacoraTemplateCatalogs {
  return {
    clasificacionesActividad: [...catalogoClasificacionActividad],
    tiposActividad: [...catalogoActividades],
    modalidades: [...catalogoModalidad],
    estados: [...catalogoEstado],
    tiposExamen: [...catalogoTipoExamen],
    periodicidades: [...catalogoPeriodicidad],
  };
}

export function getBitacoraTemplateUiMetadata(): BitacoraTemplateUiMetadata {
  return {
    fileType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    sheetNames: {
      bitacora: BITACORA_SHEET_NAME,
      catalogos: "Catalogos",
      instrucciones: "Instrucciones",
      metadatos: "Metadatos",
    },
    requiredColumns: {
      bitacora: [...BITACORA_COLUMNS],
    },
    recommendations: [
      "Completa siempre la hoja 'Bitacora' con una fila por semana.",
      "Conserva las columnas Semana, Fecha, Tema, Clasificación, Actividades en clase y Actividades evaluación.",
      "Usa la clasificación para diferenciar Actividad, Proyecto, Ejercicio, Parcial y Quiz.",
      "Usa fechas en formato ISO yyyy-mm-dd o dd/mm/aaaa para evitar rechazos.",
      "También puedes exportar la hoja a PDF; ADACEEN extraerá texto y fechas si la tabla queda legible.",
    ],
    maxRows: {
      bitacora: MAX_WEEKLY_ROWS,
    },
    catalogs: getBitacoraTemplateCatalogs(),
  };
}

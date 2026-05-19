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
  tiposActividad: string[];
  modalidades: string[];
  estados: string[];
  tiposExamen: string[];
  periodicidades: string[];
};

export type BitacoraTemplateUiMetadata = {
  fileType: string;
  sheetNames: {
    actividades: string;
    examenes: string;
    catalogos: string;
    instrucciones: string;
    metadatos: string;
  };
  requiredColumns: {
    actividades: string[];
    examenes: string[];
  };
  recommendations: string[];
  maxRows: {
    actividades: number;
    examenes: number;
  };
  catalogs: BitacoraTemplateCatalogs;
};

type ListValidation = {
  fromRow: number;
  toRow: number;
  column: string;
  formulae: string[];
  errorTitle?: string;
  error?: string;
};

const MAX_ACTIVITY_ROWS = 160;
const MAX_EXAM_ROWS = 120;

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

function sheetHeader(sheet: ExcelJS.Worksheet, title: string) {
  sheet.mergeCells("A1", "L1");
  sheet.getCell("A1").value = title;
  sheet.getCell("A1").font = { bold: true, size: 14, color: { argb: "FF1F2937" } };
  sheet.getCell("A1").alignment = {
    horizontal: "left",
    vertical: "middle",
  };
  sheet.getRow(1).height = 26;

  sheet.getCell("A2").value = "Instrucciones: usar listas desplegables en las columnas Tipo y Modalidad.";
  sheet.mergeCells("A2", "L2");
  sheet.getRow(2).height = 20;
}

function applyListValidation(sheet: ExcelJS.Worksheet, validation: ListValidation) {
  for (let row = validation.fromRow; row <= validation.toRow; row += 1) {
    sheet.getCell(`${validation.column}${row}`).dataValidation = {
      type: "list",
      allowBlank: true,
      formulae: validation.formulae,
      showErrorMessage: true,
      errorStyle: "error",
      errorTitle: validation.errorTitle || "Valor no permitido",
      error: validation.error || "Selecciona un valor de la lista.",
    };
  }
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
    ["Curso", context.courseName || "(Sin curso)"],
    ["Código del curso", context.courseCode || "(Sin código)"],
    ["Grupo", context.group || "(Sin grupo)"],
    ["Periodo académico", context.academicPeriod || "(Sin periodo)"],
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
    { header: "Tipo actividad", key: "tipo", width: 30 },
    { header: "Modalidad", key: "modalidad", width: 24 },
    { header: "Tipo examen", key: "tipoExamen", width: 24 },
    { header: "Estado", key: "estado", width: 20 },
    { header: "Periodicidad", key: "periodicidad", width: 20 },
  ];

  const maxLength = Math.max(
    catalogoActividades.length,
    catalogoModalidad.length,
    catalogoTipoExamen.length,
    catalogoEstado.length,
    catalogoPeriodicidad.length,
  );

  for (let row = 0; row < maxLength; row += 1) {
    sheet.addRow({
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
  sheet.addRow(["Plantilla de bitácora para actividades y evaluaciones"]);
  sheet.addRow([
    "1) Completa la pestaña 'Actividades' con las filas de seguimiento del curso.",
  ]);
  sheet.addRow([
    "2) Completa la pestaña 'Exámenes' con fechas y ponderaciones de cada evaluación.",
  ]);
  sheet.addRow([
    "3) Si es necesario, añade más filas en cada pestaña (hasta el máximo indicado).",
  ]);
  sheet.addRow([
    "4) Sube el archivo completado al flujo de documentos del sistema.",
  ]);
  sheet.getCell("A1").font = { bold: true, size: 12 };
  sheet.getRows(1, 4)?.forEach((row) => {
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

function writeActivitiesSheet(workbook: ExcelJS.Workbook) {
  const sheet = workbook.addWorksheet("Actividades");

  sheetHeader(
    sheet,
    "PLANTILLA DE BITÁCORA - ACTIVIDADES",
  );

  const baseColumns = [
    { header: "Semana", key: "semana", width: 10 },
    { header: "Fecha", key: "fecha", width: 14 },
    { header: "Tipo", key: "tipo", width: 24 },
    { header: "Subtipo", key: "subtipo", width: 26 },
    { header: "Título", key: "titulo", width: 36 },
    { header: "Descripción", key: "descripcion", width: 50 },
    { header: "Modalidad", key: "modalidad", width: 18 },
    { header: "Estado", key: "estado", width: 14 },
    { header: "Horas", key: "horas", width: 12 },
    { header: "Responsable", key: "responsable", width: 18 },
    { header: "Observaciones", key: "observaciones", width: 35 },
  ];

  sheet.columns = [
    ...baseColumns,
  ];
  const headerRow = sheet.getRow(4);
  sheet.getCell("A3").value = "Resumen de la planificación semanal y actividades.";
  sheet.mergeCells("A3", "K3");
  headerRow.values = baseColumns.map((column) => column.header);
  sheet.getRow(4).font = { bold: true };
  sheet.getRow(3).font = { bold: true };
  sheet.getRow(3).alignment = { vertical: "middle" };
  sheet.getRow(4).alignment = { vertical: "middle", wrapText: true };
  sheet.getRow(4).eachCell((cell) => {
    cell.fill = {
      type: "pattern",
      pattern: "solid",
      fgColor: { argb: "FFE5E7EB" },
    };
  });

  for (let row = 5; row < 5 + MAX_ACTIVITY_ROWS; row += 1) {
    sheet.getRow(row).font = { name: "Calibri", size: 11 };
    sheet.getCell(`B${row}`).numFmt = "yyyy-mm-dd";
    sheet.getCell(`I${row}`).value = "docente";
    sheet.getCell(`A${row}`).dataValidation = {
      type: "whole",
      operator: "between",
      formulae: ["1", "20"],
      showErrorMessage: true,
      errorStyle: "error",
      errorTitle: "Semana inválida",
      error: "La semana debe ser un número entre 1 y 20.",
    };
  }

  applyListValidation(sheet, {
    fromRow: 5,
    toRow: 5 + MAX_ACTIVITY_ROWS - 1,
    column: "C",
    formulae: ["=Catalogos!$A$2:$A$9"],
    errorTitle: "Tipo inválido",
    error: "Selecciona un tipo desde el catálogo.",
  });

  applyListValidation(sheet, {
    fromRow: 5,
    toRow: 5 + MAX_ACTIVITY_ROWS - 1,
    column: "D",
    formulae: ["=Catalogos!$A$2:$A$9"],
    errorTitle: "Subtipo inválido",
    error: "Selecciona un subtipo del catálogo.",
  });

  applyListValidation(sheet, {
    fromRow: 5,
    toRow: 5 + MAX_ACTIVITY_ROWS - 1,
    column: "G",
    formulae: ["=Catalogos!$B$2:$B$5"],
    errorTitle: "Modalidad inválida",
    error: "Selecciona una modalidad valida.",
  });

  applyListValidation(sheet, {
    fromRow: 5,
    toRow: 5 + MAX_ACTIVITY_ROWS - 1,
    column: "H",
    formulae: ["=Catalogos!$D$2:$D$5"],
    errorTitle: "Estado inválido",
    error: "Selecciona un estado válido.",
  });

  for (let row = 5; row < 5 + MAX_ACTIVITY_ROWS; row += 1) {
    sheet.getCell(`C${row}`).alignment = { wrapText: true };
    sheet.getCell(`D${row}`).alignment = { wrapText: true };
    sheet.getCell(`E${row}`).alignment = { wrapText: true };
    sheet.getCell(`F${row}`).alignment = { wrapText: true };
    sheet.getCell(`J${row}`).alignment = { wrapText: true };
  }

  sheet.autoFilter = {
    from: "A4",
    to: "K4",
  };
  sheet.views = [{ state: "frozen", xSplit: 0, ySplit: 4 }];
}

function writeExamsSheet(workbook: ExcelJS.Workbook) {
  const sheet = workbook.addWorksheet("Exámenes");

  sheetHeader(
    sheet,
    "PLANTILLA DE BITÁCORA - EXÁMENES Y EVALUACIONES",
  );

  const columns = [
    { header: "Semana", key: "semana", width: 10 },
    { header: "Fecha", key: "fecha", width: 14 },
    { header: "Tipo de evaluación", key: "tipo", width: 24 },
    { header: "Nombre", key: "nombre", width: 40 },
    { header: "Duración (min)", key: "duracion", width: 15 },
    { header: "Porcentaje", key: "porcentaje", width: 14 },
    { header: "Modalidad", key: "modalidad", width: 18 },
    { header: "Temas", key: "temas", width: 46 },
    { header: "Notas", key: "notas", width: 35 },
  ];

  sheet.columns = columns;
  const headerRow = sheet.getRow(4);
  sheet.getCell("A4").value = "Programación de evaluación del curso.";
  headerRow.values = columns.map((column) => column.header);
  sheet.getRow(4).font = { bold: true };
  sheet.getRow(4).alignment = { vertical: "middle", wrapText: true };
  sheet.getRow(4).eachCell((cell) => {
    cell.fill = {
      type: "pattern",
      pattern: "solid",
      fgColor: { argb: "FFE5E7EB" },
    };
  });

  for (let row = 5; row < 5 + MAX_EXAM_ROWS; row += 1) {
    sheet.getCell(`B${row}`).numFmt = "yyyy-mm-dd";
    sheet.getCell(`E${row}`).numFmt = "0";
    sheet.getCell(`F${row}`).numFmt = "0.00";
    sheet.getCell(`A${row}`).dataValidation = {
      type: "whole",
      operator: "between",
      formulae: ["1", "20"],
      showErrorMessage: true,
      errorStyle: "error",
      errorTitle: "Semana inválida",
      error: "La semana debe ser un número entre 1 y 20.",
    };
  }

  applyListValidation(sheet, {
    fromRow: 5,
    toRow: 5 + MAX_EXAM_ROWS - 1,
    column: "C",
    formulae: ["=Catalogos!$C$2:$C$6"],
    errorTitle: "Tipo de evaluación inválido",
    error: "Selecciona un tipo de evaluación válido.",
  });

  applyListValidation(sheet, {
    fromRow: 5,
    toRow: 5 + MAX_EXAM_ROWS - 1,
    column: "G",
    formulae: ["=Catalogos!$B$2:$B$5"],
    errorTitle: "Modalidad inválida",
    error: "Selecciona una modalidad desde el catálogo.",
  });

  for (let row = 5; row < 5 + MAX_EXAM_ROWS; row += 1) {
    sheet.getCell(`F${row}`).alignment = { wrapText: true };
    sheet.getCell(`G${row}`).alignment = { wrapText: true };
    sheet.getCell(`H${row}`).alignment = { wrapText: true };
    sheet.getCell(`I${row}`).alignment = { wrapText: true };
  }

  sheet.autoFilter = {
    from: "A4",
    to: "I4",
  };
  sheet.views = [{ state: "frozen", ySplit: 4 }];
}

export async function buildBitacoraTemplate(context: BitacoraTemplateContext) {
  const generatedAt = new Date();
  const workbook = new ExcelJS.Workbook();
  workbook.creator = context.teacher.displayName || "Profesor";
  workbook.company = "ADACEEN";
  workbook.created = generatedAt;

  writeMetadataSheet(workbook, context, generatedAt);
  writeCatalogSheet(workbook);
  writeInstructionSheet(workbook);
  writeActivitiesSheet(workbook);
  writeExamsSheet(workbook);

  return workbook.xlsx.writeBuffer();
}

export function getBitacoraTemplateCatalogs(): BitacoraTemplateCatalogs {
  return {
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
      actividades: "Actividades",
      examenes: "Exámenes",
      catalogos: "Catalogos",
      instrucciones: "Instrucciones",
      metadatos: "Metadatos",
    },
    requiredColumns: {
      actividades: [
        "Semana",
        "Fecha",
        "Tipo",
        "Subtipo",
        "Título",
        "Descripción",
        "Modalidad",
      ],
      examenes: [
        "Semana",
        "Fecha",
        "Tipo de evaluación",
        "Nombre",
        "Duración (min)",
        "Porcentaje",
        "Modalidad",
      ],
    },
    recommendations: [
      "Completa siempre la pestaña 'Actividades' y 'Exámenes' con el formato provisto.",
      "Usa fechas en formato ISO yyyy-mm-dd o dd/mm/aaaa para evitar rechazos.",
      "Evita dejar fechas combinadas sin hora para conservar horarios consistentes en el calendario.",
      "Mantén una sola fila por actividad para facilitar el parseo.",
    ],
    maxRows: {
      actividades: MAX_ACTIVITY_ROWS,
      examenes: MAX_EXAM_ROWS,
    },
    catalogs: getBitacoraTemplateCatalogs(),
  };
}

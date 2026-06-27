import assert from "node:assert/strict";
import test from "node:test";
import ExcelJS from "exceljs";
import { extractBitacoraAgenda } from "../../src/services/document-classifier.js";
import {
  BITACORA_TEMPLATE_DEFAULTS,
  BITACORA_TEMPLATE_FILE_NAME,
  buildBitacoraTemplate,
  getBitacoraTemplateUiMetadata,
} from "../../src/services/bitacora-template.js";
import { parseBitacoraTemplateUpload } from "../../src/services/bitacora-import.js";

const fpooPdfLikeText = [
  "Semana Fecha Tema Actividades en clase Actividades evaluacion",
  "1 11-02-2026 Programa, Reglas de juego, Bitacora C++ basico, el factorial, compilar por consola Programacion orientada a objetos: Uso del lenguaje de programacion C++ sus tipos de datos basicos",
  "2 18-02-2026 Un programa en C++ vs C++ POO Visual Studio Code: Factorial vs Uso de objetos Programacion orientada a objetos: El proceso de compilacion, el hardware y los ambitos de un programa",
  "3 25-02-2026 Un programa en C++: Variables, Vectores, Referencias, Punteros, New, Delete Programa basico en C++ con vectores y referencias Quiz lecturas anteriores semanas y Taller",
  "4 04-03-2026 Potencialidades POO. El uso de los objetos para programar POO: paso de mensajes Banco Caso de Cruz Roja",
  "5 11-03-2026 Pilares del Paradigma OO. Conceptos y codigo en C++ Implementacion de una clase: abstaccion y encapsulamiento Quiz Pilares",
  "6 13-05-2026 HUs, Diagrama de clases y relacion de uso Ejercicio completo: abstraccion, diseno e implementacion Registro de Medicamentos",
].join("\n");

test("plantilla de bitacora usa formato semanal FPOO e importa agenda", async () => {
  const buffer = Buffer.from(await buildBitacoraTemplate({
    teacher: {
      id: "teacher-test",
      displayName: "Docente Test",
      email: "docente@test.local",
    },
  }));

  const parsed = await parseBitacoraTemplateUpload(buffer);

  assert.equal(parsed.detectedTemplate, true);
  assert.equal(parsed.validation.isValid, true);
  assert.ok(parsed.validation.createdWeeks >= 15);
  assert.ok(parsed.rowsUsed >= 15);
  assert.ok(parsed.bitacoraAgenda.items.some((item) => /Registro de Medicamentos/i.test(item.title)));
  assert.ok(parsed.bitacoraAgenda.items.some((item) => item.dueAt?.startsWith("2026-05-13")));
  assert.ok(parsed.bitacoraAgenda.items.some((item) => item.category === "Proyecto"));
  assert.ok(parsed.bitacoraAgenda.items.some((item) => item.category === "Quiz"));
  assert.ok(parsed.bitacoraAgenda.items.every((item) => !/Quiz Pilares Quiz Pilares/i.test(item.title)));
  assert.ok(parsed.bitacoraAgenda.items.every((item) => !/Registro de Medicamentos Registro de Medicamentos/i.test(item.title)));
});

test("metadata de plantilla coincide con el contrato del seeder", async () => {
  const buffer = Buffer.from(await buildBitacoraTemplate({
    teacher: {
      id: "teacher-test",
      displayName: "Docente Test",
      email: "docente@test.local",
    },
  }));
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.load(buffer as unknown as Parameters<typeof workbook.xlsx.load>[0]);
  const sheetNames = workbook.worksheets.map((sheet) => sheet.name);
  const metadata = getBitacoraTemplateUiMetadata();
  const metadataSheet = workbook.getWorksheet("Metadatos");

  assert.equal(BITACORA_TEMPLATE_FILE_NAME, "plantilla_bitacora_fpoo_2026_1.xlsx");
  assert.deepEqual(sheetNames, ["Bitacora", "Metadatos", "Catalogos", "Instrucciones"]);
  assert.equal(workbook.getWorksheet("Actividades"), undefined);
  assert.equal(workbook.getWorksheet("Exámenes"), undefined);
  assert.deepEqual(metadata.requiredColumns.bitacora, [
    "Semana",
    "Fecha",
    "Tema",
    "Clasificación",
    "Actividades en clase",
    "Actividades evaluación",
  ]);
  assert.deepEqual(metadata.catalogs.clasificacionesActividad, [
    "Actividad",
    "Proyecto",
    "Ejercicio",
    "Parcial",
    "Quiz",
  ]);
  assert.equal(workbook.getWorksheet("Bitacora")?.getCell("D2").dataValidation?.type, "list");
  assert.equal(metadata.maxRows.bitacora, 80);
  assert.equal(metadataSheet?.getCell("B5").value, BITACORA_TEMPLATE_DEFAULTS.courseName);
  assert.equal(metadataSheet?.getCell("B6").value, BITACORA_TEMPLATE_DEFAULTS.courseCode);
});

test("extractor PDF detecta filas semanales de bitacora FPOO", () => {
  const agenda = extractBitacoraAgenda(fpooPdfLikeText);
  const dates = agenda.items.map((item) => item.dueAt?.slice(0, 10)).filter(Boolean);

  assert.ok(agenda.items.length >= 6);
  assert.ok(dates.includes("2026-02-11"));
  assert.ok(dates.includes("2026-05-13"));
  assert.equal(agenda.warnings.length, 0);
});

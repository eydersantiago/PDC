import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { bitacoraDayNumber, bitacoraItemWeek, shiftBitacoraAgendaToStart } from "../../src/services/bitacora-dates.js";
import { extractBitacoraAgenda, extractDocumentText } from "../../src/services/document-classifier.js";

async function fpooAgenda() {
  const buffer = fs.readFileSync(path.resolve(process.cwd(), "tests/fixtures/bitacora-fpoo-2025.pdf"));
  const extracted = await extractDocumentText({
    fileName: "Bitacora FPOO - Hoja 1.pdf",
    filePath: "Bitacora FPOO - Hoja 1.pdf",
    mimeType: "application/pdf",
    extension: "pdf",
    buffer,
  });
  return extractBitacoraAgenda(extracted.text);
}

test("inicio del semestre: la bitacora FPOO 2025 empieza el 25 de agosto de 2026 y llega al 8 de diciembre", async () => {
  const agenda = await fpooAgenda();
  const shift = shiftBitacoraAgendaToStart(agenda, "2026-08-25");
  assert.ok(shift);
  assert.equal(shift.previousStartDate, "2025-08-20");
  assert.equal(shift.shiftDays, 370);
  assert.equal(shift.firstDate, "2026-08-25");
  assert.equal(shift.lastDate, "2026-12-15", "la fila OPCIONAL tambien se corre");
  assert.equal(shift.weeks, 16);

  const classItems = shift.agenda.items.filter((item) => item.evidence.includes("Hoja: Actividades"));
  const weekDates = classItems.map((item) => [bitacoraItemWeek(item), item.dueAt?.slice(0, 10)]);
  assert.deepEqual(weekDates, [
    [1, "2026-08-25"], [2, "2026-09-01"], [3, "2026-09-08"], [4, "2026-09-15"],
    [5, "2026-09-22"], [6, "2026-09-29"], [7, "2026-10-06"], [8, "2026-10-13"],
    [9, "2026-10-20"], [10, "2026-10-27"], [11, "2026-11-03"], [12, "2026-11-10"],
    [13, "2026-11-17"], [14, "2026-11-24"], [15, "2026-12-01"], [16, "2026-12-08"],
    [0, "2026-12-15"],
  ]);
  // La hora y la zona se conservan; la fecha visible y la de la descripcion cambian con el mismo estilo.
  assert.equal(classItems[0].dueAt, "2026-08-25T09:00:00-05:00");
  assert.equal(classItems[0].visibleDueText, "25-8-2026");
  assert.match(classItems[0].description, /Fecha: 25-8-2026/);
  assert.doesNotMatch(classItems[0].description, /20-8-2025/);

  const evaluations = shift.agenda.items
    .filter((item) => item.evidence.includes("Hoja: Exámenes"))
    .map((item) => [item.title, item.dueAt?.slice(0, 10)]);
  assert.deepEqual(evaluations, [
    ["Examen (Primer parcial)", "2026-10-06"],
    ["Entrega de proyecto de curso 2", "2026-10-13"],
    ["Proyecto 3 entrega", "2026-11-24"],
    ["Examen (segundo parcial)", "2026-12-01"],
    ["Entrega proyecto 4", "2026-12-01"],
    ["Entrega proyecto final", "2026-12-08"],
  ]);

  // Volver a aplicarla con otra fecha parte de la semana 1 actual.
  const again = shiftBitacoraAgendaToStart(shift.agenda, "2026-08-18");
  assert.equal(again?.shiftDays, -7);
  assert.equal(again?.lastDate, "2026-12-08");
});

test("inicio del semestre: fechas invalidas, agenda sin fechas y estilos de fecha visibles", () => {
  assert.equal(bitacoraDayNumber("2026-02-30"), null);
  assert.equal(bitacoraDayNumber("25-08-2026"), null);
  assert.equal(shiftBitacoraAgendaToStart({ items: [], summary: "", warnings: [] }, "2026-08-25"), null);
  assert.equal(shiftBitacoraAgendaToStart({ items: [], summary: "", warnings: [] }, "2026-13-01"), null);

  const agenda = {
    summary: "",
    warnings: [],
    items: [
      { title: "Quiz Pilares", type: "task" as const, category: "Quiz", dueAt: "2026-03-11T09:00:00-05:00", visibleDueText: "11/03/2026", description: "Fecha: 11/03/2026 | Tema: Pilares", confidence: 0.9, evidence: ["Hoja: Exámenes", "Semana: 5"] },
      { title: "Programa", type: "activity" as const, dueAt: "2026-02-11T09:00:00-05:00", visibleDueText: "11-02-2026", description: "Tema: Programa", confidence: 0.9, evidence: ["Hoja: Actividades", "Semana: 1"] },
      { title: "Sin fecha", type: "note" as const, dueAt: null, visibleDueText: "", description: "", confidence: 0.5, evidence: [] },
    ],
  };
  const shift = shiftBitacoraAgendaToStart(agenda, "2026-08-12");
  assert.equal(shift?.previousStartDate, "2026-02-11", "la semana 1 manda aunque no sea el primer item");
  assert.equal(shift?.agenda.items[0].dueAt, "2026-09-09T09:00:00-05:00", "la semana 5 queda 4 semanas despues");
  assert.equal(shift?.agenda.items[0].visibleDueText, "09/09/2026", "conserva «/» y los ceros");
  assert.equal(shift?.agenda.items[0].description, "Fecha: 09/09/2026 | Tema: Pilares");
  assert.equal(shift?.agenda.items[1].visibleDueText, "12-08-2026");
  assert.equal(shift?.agenda.items[2].dueAt, null, "lo que no tiene fecha queda igual");
});

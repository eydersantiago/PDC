import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import {
  classifyDocument,
  classifyDocumentByRules,
  extractBitacoraAgenda,
  extractDocumentText,
  normalizeDocumentText,
} from "../../src/services/document-classifier.js";

const bitacoraScheduleText = [
  "Bitacora de seguimiento semanal",
  "Semana Fecha Tema",
  "1 01/02/2026 Planeacion inicial y objetivos del proyecto",
  "2 08/02/2026 Quiz sobre requisitos y registro de avance",
  "3 15/02/2026 Taller de arquitectura del agente",
  "4 22/02/2026 Entrega del prototipo y compromisos pendientes",
].join("\n");

test("normalizeDocumentText normaliza acentos, espacios y mayusculas", () => {
  assert.equal(
    normalizeDocumentText("  Bitacora\u00a0de   Campo\n\n\nSEMANA 1  "),
    "bitacora de campo\n\nsemana 1",
  );
});

test("classifyDocumentByRules clasifica una bitacora con estructura semanal", () => {
  const result = classifyDocumentByRules({
    fileName: "bitacora-proyecto.pdf",
    text: bitacoraScheduleText,
  });

  assert.equal(result.classification.label, "BITACORA");
  assert.equal(result.classification.method, "rules");
  assert.ok(result.classification.confidence >= 0.55);
  assert.ok(result.features.matchedTerms.includes("bitacora"));
  assert.ok(result.features.matchedTerms.includes("filas semanales con fechas"));
});

test("classifyDocumentByRules descarta documentos academicos que no son bitacora", () => {
  const result = classifyDocumentByRules({
    fileName: "rubrica-parcial.pdf",
    text: "Rubrica de evaluacion del parcial. Criterios, puntajes, entregables y enunciado del examen.",
  });

  assert.equal(result.classification.label, "OTRO");
  assert.ok(result.features.negativeScore > 0);
});

test("extractDocumentText prioriza texto entregado por el caller", async () => {
  const result = await extractDocumentText({
    fileName: "nota.txt",
    mimeType: "text/plain",
    text: "  contenido visible  ",
    buffer: Buffer.from("contenido ignorado"),
  });

  assert.equal(result.source, "provided_text");
  assert.equal(result.text, "contenido visible");
  assert.equal(result.extension, "txt");
});

test("extractDocumentText extrae buffers de texto plano", async () => {
  const result = await extractDocumentText({
    fileName: "nota.md",
    buffer: Buffer.from("\uFEFFlinea uno\nlinea dos"),
  });

  assert.equal(result.source, "plain_text");
  assert.equal(result.text, "linea uno\nlinea dos");
  assert.equal(result.extension, "md");
});

test("classifyDocument usa solo reglas cuando useModel es false", async () => {
  const result = await classifyDocument({
    fileName: "bitacora-proyecto.txt",
    text: bitacoraScheduleText,
    useModel: false,
  });

  assert.equal(result.classification.label, "BITACORA");
  assert.equal(result.modelUsed, false);
  assert.equal(result.modelError, "");
  assert.equal(result.extracted.source, "provided_text");
  assert.equal(result.trainingExample.predictedLabel, "BITACORA");
});

test("extractBitacoraAgenda extrae fechas y compromisos desde filas semanales", () => {
  const agenda = extractBitacoraAgenda(bitacoraScheduleText);
  const dates = agenda.items.map((item) => item.dueAt?.slice(0, 10)).filter(Boolean);

  assert.ok(agenda.items.length >= 3);
  assert.ok(dates.includes("2026-02-08"));
  assert.ok(dates.includes("2026-02-15"));
  assert.ok(dates.includes("2026-02-22"));
  assert.equal(agenda.warnings.length, 0);
});

// Bitacora FPOO 2025 en PDF (hoja exportada de Google Sheets, navegador 0.7.17): una fila por
// semana con el tema a veces en las lineas siguientes, la columna «Evaluacion Oral» debajo y
// tabuladores entre columnas. Antes salian 5 items con semanas mezcladas.
test("extractBitacoraAgenda lee las 16 semanas, la fila opcional y las evaluaciones del PDF de FPOO", async () => {
  const buffer = fs.readFileSync(path.resolve(process.cwd(), "tests/fixtures/bitacora-fpoo-2025.pdf"));
  const extracted = await extractDocumentText({
    fileName: "Bitacora FPOO - Hoja 1.pdf",
    filePath: "Bitacora FPOO - Hoja 1.pdf",
    mimeType: "application/pdf",
    extension: "pdf",
    buffer,
  });
  const agenda = extractBitacoraAgenda(extracted.text);
  const weekOf = (item: { evidence: string[] }) => Number(/Semana: (\d+)/.exec(item.evidence.join(" "))?.[1] || 0);
  const classItems = agenda.items.filter((item) => item.evidence.includes("Hoja: Actividades"));
  const evaluations = agenda.items.filter((item) => item.evidence.includes("Hoja: Exámenes"));

  assert.deepEqual(classItems.map(weekOf), [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 0]);
  assert.equal(classItems[0].title, "Programa del curso y bitacora");
  assert.equal(classItems[0].dueAt, "2025-08-20T09:00:00-05:00");
  assert.match(classItems[0].description, /Actividades en clase: Programar en un IDE y compilarlo \(el factorial de un n.mero\)/);
  assert.equal(classItems[1].title, "Paradigma orientado a objetos y sus potencialidades", "el tema sigue en la linea siguiente");
  assert.match(classItems[1].description, /Actividades en clase: Caso de estudio Cruz Roja/);
  assert.equal(classItems[3].title, "C++ y su semántica orientados a objetos: Abstraccion, Encapsulación y Utilizar diagramas de clase");
  assert.equal(classItems[7].title, "Aplica las relaciones entre objetos, paso de mensajes por referencia o punteros.", "el tabulador separa las columnas");
  assert.equal(classItems[13].title, "Polimorfismo");
  assert.equal(classItems[15].title, "Entrega proyecto final: Evaluar tareas específicas y comunicando ideas para integrar equipos de programación");
  assert.equal(classItems[16].title, "OPCIONAL");
  assert.equal(classItems[16].dueAt?.slice(0, 10), "2025-12-10");

  assert.deepEqual(evaluations.map((item) => [weekOf(item), item.category, item.title, item.dueAt?.slice(0, 10)]), [
    [7, "Parcial", "Examen (Primer parcial)", "2025-10-01"],
    [8, "Proyecto", "Entrega de proyecto de curso 2", "2025-10-08"],
    [14, "Proyecto", "Proyecto 3 entrega", "2025-11-19"],
    [15, "Parcial", "Examen (segundo parcial)", "2025-11-26"],
    [15, "Proyecto", "Entrega proyecto 4", "2025-11-26"],
    [16, "Proyecto", "Entrega proyecto final", "2025-12-03"],
  ]);
  assert.ok(evaluations.every((item) => item.type === "task"));
  assert.equal(agenda.warnings.length, 0);
});

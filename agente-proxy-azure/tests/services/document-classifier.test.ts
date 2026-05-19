import assert from "node:assert/strict";
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

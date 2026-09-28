import assert from "node:assert/strict";
import test from "node:test";
import { buildHeuristicMentorResult, buildMentorPrompt, describeCourseWeek } from "../../src/services/mentor-core.js";

// Semana del curso en el prompt del tutor (navegador 0.7.17).
const courseWeek = {
  courseCode: "FPOO",
  week: 5,
  totalWeeks: 16,
  topic: "Uso de clases de bibliotecas, APIs, y reutilización de código",
  weekStart: "2026-09-22",
  weekEnd: "2026-09-28",
  upcoming: [
    { title: "Examen (Primer parcial)", date: "2026-10-06", category: "Parcial" },
    { title: "Entrega de proyecto de curso 2", date: "2026-10-13", category: "Proyecto" },
  ],
};

test("describeCourseWeek arma la semana y las proximas evaluaciones", () => {
  assert.deepEqual(describeCourseWeek(courseWeek), [
    "CourseWeek: FPOO, semana 5 de 16 (2026-09-22 a 2026-09-28): Uso de clases de bibliotecas, APIs, y reutilización de código",
    "UpcomingEvaluations: Examen (Primer parcial) (Parcial, 2026-10-06); Entrega de proyecto de curso 2 (Proyecto, 2026-10-13)",
  ]);
  assert.deepEqual(describeCourseWeek({ week: 3 }), ["CourseWeek: semana 3"]);
});

test("describeCourseWeek descarta lo que no encaja", () => {
  assert.deepEqual(describeCourseWeek(null), []);
  assert.deepEqual(describeCourseWeek("semana 5"), []);
  assert.deepEqual(describeCourseWeek({ week: 0 }), []);
  assert.deepEqual(describeCourseWeek({ week: 99 }), []);
  const [line] = describeCourseWeek({ week: 2, totalWeeks: 1, weekStart: "ayer", weekEnd: "hoy", courseCode: "FP<OO>", topic: "x".repeat(400) });
  assert.equal(line, `CourseWeek: FPOO, semana 2: ${"x".repeat(240)}`);
});

test("el prompt del tutor incluye la semana del curso solo cuando llega", () => {
  const context = { pageContext: "github" as const, pageType: "github_file" as const, filePath: "src/main.cpp", codeSnippet: "int main() {}" };
  const heuristic = buildHeuristicMentorResult(context, "Explica el error", 4);
  const withWeek = buildMentorPrompt({ context: { ...context, courseWeek }, question: "Explica el error", maxItems: 4, heuristic });
  assert.match(withWeek, /Si hay CourseWeek, relaciona las pistas con el tema de esa semana/);
  assert.match(withWeek, /\nCourseWeek: FPOO, semana 5 de 16 \(2026-09-22 a 2026-09-28\): Uso de clases/);
  assert.match(withWeek, /\nUpcomingEvaluations: Examen \(Primer parcial\)/);
  const withoutWeek = buildMentorPrompt({ context, question: "Explica el error", maxItems: 4, heuristic });
  assert.doesNotMatch(withoutWeek, /CourseWeek/);
});

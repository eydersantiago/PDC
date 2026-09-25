import fsp from "node:fs/promises";
import path from "node:path";

/**
 * Formato de revision docente del banco del mini-quiz (A8.7): una tabla por
 * pregunta con casillas para aprobar, pedir cambios o descartar.
 *   npm run quiz:revision   # escribe docs/tutor/revision-banco-quiz.md
 * Se regenera cada vez que cambia data/quiz/banco-fpoo.json.
 */

type Item = {
  id: string;
  ra: string;
  tema: string;
  lenguaje: string;
  pregunta: string;
  opciones: string[];
  correcta: number;
  explicacion: string;
  abierta: string;
};

function cell(value: unknown) {
  return String(value ?? "").replace(/\|/g, "\\|").replace(/\n/g, " ");
}

async function main() {
  const bank = JSON.parse(await fsp.readFile(path.resolve(process.cwd(), "data/quiz/banco-fpoo.json"), "utf8")) as {
    version: string;
    actualizado: string;
    curso: string;
    items: Item[];
  };
  const letters = ["A", "B", "C", "D", "E"];
  const lines = [
    "# Revisión docente del banco de preguntas del mini-quiz",
    "",
    `> Generado con \`npm run quiz:revision\` desde \`data/quiz/banco-fpoo.json\` (versión ${bank.version}, ${bank.actualizado}). Si el banco cambia, se regenera.`,
    "",
    "| | |",
    "|---|---|",
    "| Jira | A8.7 · ADACEEN-82 (validación docente y proceso de actualización) |",
    `| Curso | ${cell(bank.curso)} |`,
    `| Preguntas | ${bank.items.length} |`,
    "| Proceso | [banco-quiz.md](banco-quiz.md), sección «Cómo actualizar el banco» |",
    "",
    "Para cada pregunta, marque una decisión y escriba los cambios si los hay. Criterios: la respuesta marcada es la única correcta; la pregunta es clara y del nivel del curso; la explicación enseña el concepto y no solo da la respuesta; la pregunta abierta invita a explicar con sus palabras.",
    "",
  ];
  for (const item of bank.items) {
    lines.push(
      `## ${item.id} · ${item.ra} · ${cell(item.tema)}`,
      "",
      `**Pregunta** (${item.lenguaje || "cualquier lenguaje"}): ${item.pregunta}`,
      "",
      "| Opción | Texto | Correcta |",
      "|---|---|---|",
      ...item.opciones.map((option, index) => `| ${letters[index] || index + 1} | ${cell(option)} | ${index === item.correcta ? "✔" : ""} |`),
      "",
      `**Explicación:** ${item.explicacion}`,
      "",
      `**Pregunta abierta:** ${item.abierta}`,
      "",
      "| Decisión | ☐ Aprobada | ☐ Aprobada con cambios | ☐ Descartar |",
      "|---|---|---|---|",
      "| Cambios o comentarios | | | |",
      "",
    );
  }
  lines.push(
    "## Firma",
    "",
    "| Docente | Fecha | Preguntas aprobadas | Con cambios | Descartadas |",
    "|---|---|---|---|---|",
    "| | | | | |",
    "",
  );
  const target = path.resolve(process.cwd(), "docs/tutor/revision-banco-quiz.md");
  await fsp.writeFile(target, lines.join("\n"), "utf8");
  console.log(`[quiz] Escrito ${path.relative(process.cwd(), target)} (${bank.items.length} preguntas)`);
}

main().catch((error) => {
  console.error("[quiz] Fallo:", error);
  process.exitCode = 1;
});

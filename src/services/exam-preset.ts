// Examen del 28-10-2026 (parte practica del parcial de FPOO-01, 20 % de la nota): todos los
// estudiantes del docente de las cuentas nuevas abren el mismo ejercicio, el Sistema bancario,
// desde «Tema de la clase». Lo acordaron el profesor Victor Bucheli, el monitor y Eyder el 27-10.
//
// El arranque del backend lo aplica UNA vez (bandera en app_settings): fija el tema del piloto de
// ese docente (semana 9 de la bitacora 2026-2, titulo y repositorio). Despues el docente lo puede
// cambiar en «Estudiantes» y el arranque no lo vuelve a tocar. EXAM_PRESET=off lo apaga y
// EXAM_REPO cambia el repositorio (usuario/repositorio, publico).
// El enunciado (HU-1 a HU-5 y el diagrama) va al RAG del curso por data/rag/rag_sources_seed.jsonl
// (RAG-FPOO-EXAMEN-BANCO, fijado en todos los lotes).
import { env } from "../config/env.js";
import type { PilotTopicInput } from "./pilot-topic.js";

export const EXAM_PRESET_DEFAULT_REPO = "eydersantiago/sistema-bancario-fpoo";

export type ExamPreset = {
  /** Bandera en app_settings: si existe, el preajuste ya se aplico. */
  settingKey: string;
  topic: PilotTopicInput;
};

/** El preajuste vigente, o null si EXAM_PRESET=off. */
export function resolveExamPreset(): ExamPreset | null {
  const mode = String(env.examPreset || "").trim().toLowerCase();
  if (!mode || mode === "off" || mode === "false" || mode === "0") return null;
  const repo = String(env.examRepo || "").trim() || EXAM_PRESET_DEFAULT_REPO;
  return {
    settingKey: `exam_preset_applied:sistema-bancario-2026-10-28:${repo.toLowerCase()}`,
    topic: {
      courseCode: "FPOO",
      week: 9,
      title: "Parcial: Sistema bancario (HU-1 a HU-5, desde cero en C++)",
      repoFullName: repo,
    },
  };
}

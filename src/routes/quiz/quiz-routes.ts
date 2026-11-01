// Rutas del mini quiz: registerQuizRoutes registra, en este orden, las del estudiante, el lanzamiento del docente y el banco propio con los resultados.
import type express from "express";
import type { AppDatabase } from "../../db/database.js";
import { createQuizStudentHelpers } from "./quiz-student-helpers.js";
import { registerQuizStudentRoutes } from "./quiz-student-routes.js";
import { createQuizTeacherHelpers } from "./quiz-teacher-helpers.js";
import { registerQuizTeacherLaunchRoutes, registerQuizTeacherBankRoutes } from "./quiz-teacher-routes.js";

/**
 * Rutas del mini quiz.
 *
 * Estudiante (extension de VS Code; la sesion es opcional porque en el piloto
 * muchas extensiones no la tienen configurada; sin sesion se identifica al
 * cliente con la cabecera x-adaceen-client-id):
 *   POST /api/quiz/after-accept       genera (o no, segun la politica) la pregunta
 *   GET  /api/quiz/pending            quiz lanzado por el docente o uno abierto
 *   POST /api/quiz/:id/answer         califica la opcion elegida
 *   POST /api/quiz/:id/followup       califica la explicacion abierta
 *   POST /api/quiz/:id/skip
 *
 * Docente (sesion obligatoria):
 *   POST /api/quiz/launches           lanza un quiz para su clase
 *   GET  /api/quiz/launches           ultimos lanzamientos con resultados
 *   POST /api/quiz/launches/:id/close
 *   GET  /api/quiz/summary            resumen de todos los quices de sus estudiantes
 *   GET  /api/quiz/attempts           quices hechos por sus estudiantes, con nombre (0.7.15)
 *   GET/POST /api/quiz/custom         banco propio de quices (0.7.15)
 *   PUT/DELETE /api/quiz/custom/:id
 *   POST /api/quiz/custom/:id/launch  lanza uno del banco a la clase
 */

export function registerQuizRoutes(app: express.Express, database: AppDatabase) {
  const studentHelpers = createQuizStudentHelpers(database);
  registerQuizStudentRoutes(app, database, studentHelpers);
  const teacherHelpers = createQuizTeacherHelpers(database, studentHelpers.ragBlockFor);
  registerQuizTeacherLaunchRoutes(app, teacherHelpers);
  registerQuizTeacherBankRoutes(app, database, teacherHelpers);
}


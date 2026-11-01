// Ayudas de las rutas del docente: exigir docente, activar el lanzamiento, resumir y lanzar un quiz a la clase.
import type express from "express";
import type { AppDatabase } from "../../db/database.js";
import { buildTopicQuizPrompt, generateQuizFromPrompt, normalizeQuizSettings, shuffleQuizOptions } from "../../services/quiz/quiz.js";
import { pickQuizFromBank } from "../../services/quiz/quiz-bank.js";
import type { AppSession, QuizTrigger, StudentQuizRecord } from "../../types/app.js";
import { errorMessage, resolveSession } from "../route-utils.js";
import { type QuizStudentHelpers } from "./quiz-student-helpers.js";

export function createQuizTeacherHelpers(database: AppDatabase, ragBlockFor: QuizStudentHelpers["ragBlockFor"]) {
  // --- Docente ----------------------------------------------------------------

  async function requireTeacher(req: express.Request, res: express.Response) {
    const session = await resolveSession(database, req).catch(() => null);
    if (!session) {
      res.status(401).json({ ok: false, error: "Sesion requerida." });
      return null;
    }
    if (session.user.role !== "teacher") {
      res.status(403).json({ ok: false, error: "Solo el docente puede gestionar quices de la clase." });
      return null;
    }
    return session;
  }

  /**
   * Un quiz lanzado solo llega a los estudiantes si la politica tiene
   * «Permitir mini quiz» y «Cuando yo lo lance a la clase» (ver
   * GET /api/quiz/pending). Si falta alguno, lanzar lo activa y lo guarda en
   * vez de dejar un quiz que no ve nadie. Si el mini quiz estaba apagado, se
   * enciende solo el lanzado por el docente: «Tras aceptar una sugerencia»
   * sigue sin salir, como hasta ahora (y si estaba marcado, el aviso dice que
   * queda sin marcar). Se llama despues de crear el lanzamiento: si crearlo
   * falla, la politica no cambia.
   */
  async function enableTeacherLaunch(session: AppSession) {
    const policy = await database.getTeacherPolicyForUser(session.user);
    if (!policy) return null;
    const settings = normalizeQuizSettings(policy.quizSettings);
    if (policy.allowMiniQuiz && settings.triggers.includes("teacher_launch")) return null;
    const triggers: QuizTrigger[] = policy.allowMiniQuiz
      ? [...settings.triggers, "teacher_launch"]
      : ["teacher_launch"];
    const updated = await database.updateTeacherPolicy(session.user.id, {
      allowMiniQuiz: true,
      quizSettings: { ...settings, triggers },
    });
    const activated = policy.allowMiniQuiz
      ? "«Cuando yo lo lance a la clase»"
      : "«Permitir mini quiz» con «Cuando yo lo lance a la clase»";
    const unchecked = !policy.allowMiniQuiz && settings.triggers.includes("after_accept")
      ? " «Tras aceptar una sugerencia» quedo sin marcar."
      : "";
    return {
      policy: updated,
      message: `Quiz lanzado. Se activo ${activated} en tus parametros para que llegue a tus estudiantes.${unchecked}`,
    };
  }

  function summarize(quizzes: StudentQuizRecord[]) {
    const answered = quizzes.filter((quiz) => quiz.chosenIndex !== null);
    const correct = answered.filter((quiz) => quiz.correct === true);
    const scored = quizzes.filter((quiz) => typeof quiz.followupScore === "number");
    const students = new Set(quizzes.map((quiz) => quiz.clientKey));
    return {
      total: quizzes.length,
      students: students.size,
      answered: answered.length,
      correct: correct.length,
      correctRate: answered.length ? Math.round((correct.length / answered.length) * 100) : null,
      followUps: quizzes.filter((quiz) => !!quiz.followupAnswer).length,
      averageFollowUpScore: scored.length
        ? Math.round(scored.reduce((sum, quiz) => sum + (quiz.followupScore || 0), 0) / scored.length)
        : null,
      skipped: quizzes.filter((quiz) => quiz.status === "skipped").length,
    };
  }

  /**
   * Pregunta lista para guardar o lanzar: si viene completa se barajan las
   * opciones; si solo viene el tema, se genera con el modelo (o el banco).
   */
  async function resolveQuizContent(session: AppSession, input: {
    topic: string;
    courseCode: string;
    question?: string;
    options?: string[];
    correctIndex?: number;
    explanation?: string;
    followupQuestion?: string;
  }) {
    let question = input.question || "";
    let options = input.options || [];
    let correctIndex = input.correctIndex ?? -1;
    let explanation = input.explanation || "";
    let followupQuestion = input.followupQuestion || "";

    const manual = !!question && options.length >= 3 && correctIndex >= 0 && correctIndex < options.length;
    if (!manual) {
      const ragBlock = await ragBlockFor(input.topic, "", "", "", input.courseCode, session);
      const generated = await generateQuizFromPrompt(buildTopicQuizPrompt(input.topic, input.courseCode, ragBlock));
      const quiz = generated.quiz || pickQuizFromBank({ text: input.topic });
      if (!quiz) {
        return { error: generated.error || "No se pudo generar la pregunta." };
      }
      ({ question, options, correctIndex, explanation, followupQuestion } = quiz);
    } else {
      ({ options, correctIndex } = shuffleQuizOptions({
        question, options, correctIndex, explanation, followupQuestion, topic: input.topic,
      }));
    }
    return {
      question,
      options,
      correctIndex,
      explanation,
      followupQuestion: followupQuestion || "Explica con tus palabras el concepto de esta pregunta.",
    };
  }

  /** Crea el lanzamiento y activa la politica si hace falta; arma la respuesta comun. */
  async function launchForClass(session: AppSession, input: {
    courseCode: string;
    topic: string;
    question: string;
    options: string[];
    correctIndex: number;
    explanation: string;
    followupQuestion: string;
    expiresInMinutes?: number;
    customQuizId?: string;
  }) {
    const expiresAt = new Date(Date.now() + (input.expiresInMinutes ?? 60) * 60 * 1000).toISOString();
    const launch = await database.createQuizLaunch({
      teacherUserId: session.user.id,
      courseCode: input.courseCode,
      topic: input.topic,
      question: input.question,
      options: input.options,
      correctIndex: input.correctIndex,
      explanation: input.explanation,
      followupQuestion: input.followupQuestion,
      expiresAt,
      customQuizId: input.customQuizId,
    });
    // El quiz ya quedo lanzado: si no se pudo activar la politica, se dice
    // en vez de responder un error que haria lanzarlo otra vez.
    let enabled: Awaited<ReturnType<typeof enableTeacherLaunch>>;
    try {
      enabled = await enableTeacherLaunch(session);
    } catch (error) {
      return {
        ok: true,
        launch,
        message: "Quiz lanzado, pero no se pudo revisar tus parametros: si no llega a tus estudiantes, marca "
          + `«Permitir mini quiz» y «Cuando yo lo lance a la clase» y guarda. (${errorMessage(error)})`,
      };
    }
    if (!enabled) return { ok: true, launch };
    return { ok: true, launch, autoEnabled: true, message: enabled.message, policy: enabled.policy };
  }

  return { requireTeacher, enableTeacherLaunch, summarize, resolveQuizContent, launchForClass };
}

export type QuizTeacherHelpers = ReturnType<typeof createQuizTeacherHelpers>;

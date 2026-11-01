// Rutas del mini quiz del estudiante: despues de aceptar, pendiente, responder, explicar y saltar.
import type express from "express";
import { z } from "zod";
import type { AppDatabase } from "../../db/database.js";
import { buildAfterAcceptQuizPrompt, buildFollowUpGradingPrompt, generateQuizFromPrompt, gradeFollowUp, normalizeQuizSettings, QUIZ_SESSION_WINDOW_MS } from "../../services/quiz/quiz.js";
import { pickQuizFromBank } from "../../services/quiz/quiz-bank.js";
import { trimText } from "../../services/shared/text-utils.js";
import type { StudentQuizRecord } from "../../types/app.js";
import { errorMessage } from "../route-utils.js";
import { type QuizStudentHelpers } from "./quiz-student-helpers.js";

const OPEN_QUIZ_MAX_AGE_MS = 30 * 60 * 1000;

const afterAcceptSchema = z.object({
  filePath: z.string().max(500).default(""),
  language: z.string().max(40).default(""),
  applyMode: z.enum(["insert", "replace", "delete"]),
  originalCode: z.string().max(12000).default(""),
  newCode: z.string().max(12000).default(""),
  suggestionText: z.string().max(3000).default(""),
  acceptCount: z.number().int().min(1).max(100000),
  ragCourseCode: z.string().max(40).optional(),
  repoFullName: z.string().max(200).optional(),
}).strict();

const answerSchema = z.object({
  choiceIndex: z.number().int().min(0).max(5),
}).strict();

const followUpSchema = z.object({
  answer: z.string().trim().min(1).max(2000),
}).strict();

/** Lo que ve el estudiante: nunca la respuesta correcta antes de contestar. */
export function toPublicQuiz(quiz: StudentQuizRecord) {
  const answered = quiz.chosenIndex !== null;
  return {
    id: quiz.id,
    trigger: quiz.trigger,
    launchId: quiz.launchId,
    status: quiz.status,
    topic: quiz.topic,
    filePath: quiz.filePath,
    language: quiz.language,
    question: quiz.question,
    options: quiz.options,
    createdAt: quiz.createdAt,
    result: answered
      ? {
        correct: quiz.correct === true,
        chosenIndex: quiz.chosenIndex,
        correctIndex: quiz.correctIndex,
        explanation: quiz.explanation,
      }
      : null,
    followUpQuestion: quiz.status === "followup" || quiz.followupAnswer ? quiz.followupQuestion : null,
    followUp: quiz.followupAnswer
      ? { answer: quiz.followupAnswer, score: quiz.followupScore, feedback: quiz.followupFeedback }
      : null,
  };
}

export function registerQuizStudentRoutes(app: express.Express, database: AppDatabase, helpers: QuizStudentHelpers) {
  const { resolveActor, policyFor, loadOwnQuiz, ragBlockFor } = helpers;

  // --- Estudiante -------------------------------------------------------------

  app.post("/api/quiz/after-accept", async (req, res) => {
    try {
      const actor = await resolveActor(req);
      if (!actor) {
        return res.status(400).json({ ok: false, error: "Falta la sesion o la cabecera x-adaceen-client-id." });
      }
      const input = afterAcceptSchema.parse(req.body || {});
      const policy = await policyFor(actor);
      if (!policy) {
        return res.json({ ok: true, quiz: null, reason: "sin_politica" });
      }
      const settings = normalizeQuizSettings(policy.quizSettings);
      if (!policy.allowMiniQuiz || !settings.triggers.includes("after_accept")) {
        return res.json({ ok: true, quiz: null, reason: "desactivado" });
      }
      if (input.acceptCount % settings.everyNAccepts !== 0) {
        return res.json({
          ok: true,
          quiz: null,
          reason: "no_toca",
          remaining: settings.everyNAccepts - (input.acceptCount % settings.everyNAccepts),
        });
      }
      if (settings.maxPerSession !== null) {
        const since = new Date(Date.now() - QUIZ_SESSION_WINDOW_MS).toISOString();
        const count = await database.countStudentQuizzesSince(actor.clientKey, since, "after_accept");
        if (count >= settings.maxPerSession) {
          return res.json({ ok: true, quiz: null, reason: "limite_sesion" });
        }
      }

      const code = `${input.originalCode}\n${input.newCode}`;
      const ragBlock = await ragBlockFor(
        input.suggestionText || input.filePath,
        input.filePath,
        input.language,
        code,
        trimText(input.ragCourseCode),
        actor.session,
      );
      const generated = await generateQuizFromPrompt(buildAfterAcceptQuizPrompt({
        filePath: input.filePath,
        language: input.language,
        applyMode: input.applyMode,
        originalCode: input.originalCode,
        newCode: input.newCode,
        suggestionText: input.suggestionText,
      }, ragBlock));
      if (!generated.quiz) {
        // A8.5: sin modelo (o sin pregunta valida) se usa el banco validado.
        const fromBank = pickQuizFromBank({
          text: [input.suggestionText, input.newCode, input.originalCode, input.filePath].join("\n"),
          language: input.language,
        });
        if (!fromBank) {
          return res.json({ ok: true, quiz: null, reason: "modelo_sin_pregunta", error: generated.error });
        }
        generated.quiz = fromBank;
      }

      await database.expireOpenStudentQuizzes(actor.clientKey, "after_accept");
      const quiz = await database.createStudentQuiz({
        clientKey: actor.clientKey,
        userId: actor.session?.user.id || null,
        teacherUserId: policy.teacherUserId,
        sessionId: actor.session?.id || null,
        trigger: "after_accept",
        launchId: null,
        language: input.language,
        filePath: input.filePath,
        topic: generated.quiz.topic,
        question: generated.quiz.question,
        options: generated.quiz.options,
        correctIndex: generated.quiz.correctIndex,
        explanation: generated.quiz.explanation,
        followupQuestion: settings.followUpOnWrong ? generated.quiz.followupQuestion : "",
        codeContext: {
          applyMode: input.applyMode,
          repoFullName: trimText(input.repoFullName),
          suggestionText: input.suggestionText.slice(0, 1000),
          originalCode: input.originalCode.slice(0, 3000),
          newCode: input.newCode.slice(0, 3000),
        },
      });
      return res.json({ ok: true, quiz: toPublicQuiz(quiz) });
    } catch (error) {
      return res.status(400).json({ ok: false, error: errorMessage(error) });
    }
  });

  app.get("/api/quiz/pending", async (req, res) => {
    try {
      const actor = await resolveActor(req);
      if (!actor) {
        return res.status(400).json({ ok: false, error: "Falta la sesion o la cabecera x-adaceen-client-id." });
      }
      const policy = await policyFor(actor);
      const settings = normalizeQuizSettings(policy?.quizSettings);

      if (policy && policy.allowMiniQuiz && settings.triggers.includes("teacher_launch")) {
        const launch = await database.getActiveQuizLaunch(policy.teacherUserId, new Date().toISOString());
        if (launch) {
          const existing = await database.findStudentQuizForLaunch(actor.clientKey, launch.id);
          if (!existing) {
            const created = await database.createStudentQuiz({
              clientKey: actor.clientKey,
              userId: actor.session?.user.id || null,
              teacherUserId: policy.teacherUserId,
              sessionId: actor.session?.id || null,
              trigger: "teacher_launch",
              launchId: launch.id,
              language: "",
              filePath: "",
              topic: launch.topic,
              question: launch.question,
              options: launch.options,
              correctIndex: launch.correctIndex,
              explanation: launch.explanation,
              followupQuestion: settings.followUpOnWrong ? launch.followupQuestion : "",
              codeContext: { courseCode: launch.courseCode },
            });
            return res.json({ ok: true, quiz: toPublicQuiz(created), source: "teacher_launch" });
          }
          if (existing.status === "pending" || existing.status === "followup") {
            return res.json({ ok: true, quiz: toPublicQuiz(existing), source: "teacher_launch" });
          }
        }
      }

      const since = new Date(Date.now() - OPEN_QUIZ_MAX_AGE_MS).toISOString();
      const open = await database.findLatestOpenStudentQuiz(actor.clientKey, since);
      return res.json({ ok: true, quiz: open ? toPublicQuiz(open) : null, source: open ? open.trigger : null });
    } catch (error) {
      return res.status(400).json({ ok: false, error: errorMessage(error) });
    }
  });

  app.post("/api/quiz/:id/answer", async (req, res) => {
    try {
      const loaded = await loadOwnQuiz(req, res);
      if (!loaded) return;
      const { quiz } = loaded;
      if (quiz.status !== "pending") {
        return res.status(409).json({ ok: false, error: "Este quiz ya fue respondido.", quiz: toPublicQuiz(quiz) });
      }
      const { choiceIndex } = answerSchema.parse(req.body || {});
      if (choiceIndex >= quiz.options.length) {
        return res.status(400).json({ ok: false, error: "Opcion fuera de rango." });
      }
      const correct = choiceIndex === quiz.correctIndex;
      const needsFollowUp = !correct && !!quiz.followupQuestion;
      const updated = await database.saveStudentQuizAnswer(quiz.id, {
        chosenIndex: choiceIndex,
        correct,
        status: needsFollowUp ? "followup" : "done",
      });
      return res.json({ ok: true, quiz: toPublicQuiz(updated) });
    } catch (error) {
      return res.status(400).json({ ok: false, error: errorMessage(error) });
    }
  });

  app.post("/api/quiz/:id/followup", async (req, res) => {
    try {
      const loaded = await loadOwnQuiz(req, res);
      if (!loaded) return;
      const { quiz } = loaded;
      if (quiz.status !== "followup") {
        return res.status(409).json({ ok: false, error: "Este quiz no espera una explicacion.", quiz: toPublicQuiz(quiz) });
      }
      const { answer } = followUpSchema.parse(req.body || {});
      const grade = await gradeFollowUp(buildFollowUpGradingPrompt({
        question: quiz.question,
        correctOption: quiz.options[quiz.correctIndex] || "",
        explanation: quiz.explanation,
        followupQuestion: quiz.followupQuestion,
        answer,
      }), answer);
      const updated = await database.saveStudentQuizFollowUp(quiz.id, {
        answer,
        score: grade.score,
        feedback: grade.feedback,
      });
      return res.json({ ok: true, quiz: toPublicQuiz(updated) });
    } catch (error) {
      return res.status(400).json({ ok: false, error: errorMessage(error) });
    }
  });

  app.post("/api/quiz/:id/skip", async (req, res) => {
    try {
      const loaded = await loadOwnQuiz(req, res);
      if (!loaded) return;
      const { quiz } = loaded;
      if (quiz.status !== "pending" && quiz.status !== "followup") {
        return res.json({ ok: true, quiz: toPublicQuiz(quiz) });
      }
      const updated = await database.setStudentQuizStatus(quiz.id, "skipped");
      return res.json({ ok: true, quiz: toPublicQuiz(updated) });
    } catch (error) {
      return res.status(400).json({ ok: false, error: errorMessage(error) });
    }
  });
}

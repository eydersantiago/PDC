import type express from "express";
import { z } from "zod";
import type { AppDatabase } from "../db/database.js";
import { resolveMentorRagContext } from "../services/decision-engine.js";
import {
  buildAfterAcceptQuizPrompt,
  buildFollowUpGradingPrompt,
  buildTopicQuizPrompt,
  generateQuizFromPrompt,
  gradeFollowUp,
  normalizeQuizSettings,
  QUIZ_SESSION_WINDOW_MS,
  shuffleQuizOptions,
} from "../services/quiz.js";
import { pickQuizFromBank } from "../services/quiz-bank.js";
import { buildRagPromptBlock } from "../services/rag-sources.js";
import { trimText } from "../services/text-utils.js";
import type { AppSession, AppUser, StudentQuizRecord, TeacherPolicy } from "../types/app.js";
import { errorMessage, resolveSession } from "./route-utils.js";

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
 */

const CLIENT_ID_PATTERN = /^[A-Za-z0-9_-]{8,80}$/;
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

const launchSchema = z.object({
  topic: z.string().trim().min(3).max(300),
  courseCode: z.string().max(40).optional(),
  expiresInMinutes: z.number().int().min(5).max(1440).optional(),
  question: z.string().trim().min(5).max(400).optional(),
  options: z.array(z.string().trim().min(1).max(220)).min(3).max(5).optional(),
  correctIndex: z.number().int().min(0).max(4).optional(),
  explanation: z.string().max(600).optional(),
  followupQuestion: z.string().max(300).optional(),
}).strict();

type QuizActor = {
  session: AppSession | null;
  clientKey: string;
};

const ANONYMOUS_STUDENT: AppUser = {
  id: "",
  role: "student",
  email: "",
  displayName: "",
  teacherUserId: null,
};

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

export function registerQuizRoutes(app: express.Express, database: AppDatabase) {
  async function resolveActor(req: express.Request): Promise<QuizActor | null> {
    const session = await resolveSession(database, req).catch(() => null);
    if (session) {
      return { session, clientKey: `user:${session.user.id}` };
    }
    const clientId = trimText(req.header("x-adaceen-client-id"));
    if (!CLIENT_ID_PATTERN.test(clientId)) {
      return null;
    }
    return { session: null, clientKey: `client:${clientId}` };
  }

  async function policyFor(actor: QuizActor): Promise<TeacherPolicy | null> {
    try {
      return await database.getTeacherPolicyForUser(actor.session?.user || ANONYMOUS_STUDENT);
    } catch {
      // Sin sesion se busca el docente por defecto con un JOIN que pg-mem no
      // soporta; en ese caso vale la politica del primer docente.
      return database.getFirstTeacherPolicy();
    }
  }

  async function loadOwnQuiz(req: express.Request, res: express.Response) {
    const actor = await resolveActor(req);
    if (!actor) {
      res.status(400).json({ ok: false, error: "Falta la sesion o la cabecera x-adaceen-client-id." });
      return null;
    }
    const quiz = await database.getStudentQuiz(String(req.params.id || ""));
    if (!quiz || quiz.clientKey !== actor.clientKey) {
      res.status(404).json({ ok: false, error: "Quiz no encontrado." });
      return null;
    }
    return { actor, quiz };
  }

  async function ragBlockFor(question: string, filePath: string, language: string, code: string, courseCode: string, session: AppSession | null) {
    try {
      const rag = await resolveMentorRagContext({
        question,
        context: {
          url: "",
          title: filePath,
          pageContext: "github",
          pageType: "codespace",
          repoFullName: "",
          filePath,
          languageHint: language,
          courseCode,
          ragCourseCode: courseCode,
          selection: "",
          codeSnippet: code.slice(0, 3000),
          codeLineCount: code.split(/\r?\n/).length,
        },
        session,
        database,
      });
      return buildRagPromptBlock(rag.ragSources.slice(0, 3));
    } catch {
      return "";
    }
  }

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
      }));
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

  app.post("/api/quiz/launches", async (req, res) => {
    try {
      const session = await requireTeacher(req, res);
      if (!session) return;
      const input = launchSchema.parse(req.body || {});
      const courseCode = trimText(input.courseCode) || trimText(session.user.activeCourseCode);

      let question = input.question || "";
      let options = input.options || [];
      let correctIndex = input.correctIndex ?? -1;
      let explanation = input.explanation || "";
      let followupQuestion = input.followupQuestion || "";

      const manual = !!question && options.length >= 3 && correctIndex >= 0 && correctIndex < options.length;
      if (!manual) {
        const ragBlock = await ragBlockFor(input.topic, "", "", "", courseCode, session);
        const generated = await generateQuizFromPrompt(buildTopicQuizPrompt(input.topic, courseCode, ragBlock));
        const quizForLaunch = generated.quiz || pickQuizFromBank({ text: input.topic });
        if (!quizForLaunch) {
          return res.status(502).json({ ok: false, error: generated.error || "No se pudo generar la pregunta." });
        }
        ({ question, options, correctIndex, explanation, followupQuestion } = quizForLaunch);
      } else {
        ({ options, correctIndex } = shuffleQuizOptions({
          question, options, correctIndex, explanation, followupQuestion, topic: input.topic,
        }));
      }

      const expiresAt = new Date(Date.now() + (input.expiresInMinutes ?? 60) * 60 * 1000).toISOString();
      const launch = await database.createQuizLaunch({
        teacherUserId: session.user.id,
        courseCode,
        topic: input.topic,
        question,
        options,
        correctIndex,
        explanation,
        followupQuestion: followupQuestion || "Explica con tus palabras el concepto de esta pregunta.",
        expiresAt,
      });
      return res.json({ ok: true, launch });
    } catch (error) {
      return res.status(400).json({ ok: false, error: errorMessage(error) });
    }
  });

  app.get("/api/quiz/launches", async (req, res) => {
    try {
      const session = await requireTeacher(req, res);
      if (!session) return;
      const launches = await database.listQuizLaunches(session.user.id, 10);
      const quizzes = await database.listStudentQuizzesForTeacher(session.user.id, 5000);
      return res.json({
        ok: true,
        launches: launches.map((launch) => ({
          ...launch,
          results: summarize(quizzes.filter((quiz) => quiz.launchId === launch.id)),
        })),
      });
    } catch (error) {
      return res.status(400).json({ ok: false, error: errorMessage(error) });
    }
  });

  app.post("/api/quiz/launches/:id/close", async (req, res) => {
    try {
      const session = await requireTeacher(req, res);
      if (!session) return;
      const closed = await database.closeQuizLaunch(String(req.params.id || ""), session.user.id);
      if (!closed) {
        return res.status(404).json({ ok: false, error: "Lanzamiento no encontrado." });
      }
      return res.json({ ok: true });
    } catch (error) {
      return res.status(400).json({ ok: false, error: errorMessage(error) });
    }
  });

  app.get("/api/quiz/summary", async (req, res) => {
    try {
      const session = await requireTeacher(req, res);
      if (!session) return;
      const quizzes = await database.listStudentQuizzesForTeacher(session.user.id, 5000);
      return res.json({
        ok: true,
        afterAccept: summarize(quizzes.filter((quiz) => quiz.trigger === "after_accept")),
        teacherLaunch: summarize(quizzes.filter((quiz) => quiz.trigger === "teacher_launch")),
      });
    } catch (error) {
      return res.status(400).json({ ok: false, error: errorMessage(error) });
    }
  });
}

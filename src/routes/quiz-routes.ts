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
import type { AppSession, AppUser, QuizLaunchRecord, QuizTrigger, StudentQuizRecord, TeacherPolicy } from "../types/app.js";
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
 *   GET  /api/quiz/attempts           quices hechos por sus estudiantes, con nombre (0.7.15)
 *   GET/POST /api/quiz/custom         banco propio de quices (0.7.15)
 *   PUT/DELETE /api/quiz/custom/:id
 *   POST /api/quiz/custom/:id/launch  lanza uno del banco a la clase
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

// Banco propio del docente (0.7.15): la pregunta se escribe completa o se genera del tema.
const customQuizSchema = z.object({
  topic: z.string().trim().min(3).max(300),
  courseCode: z.string().max(40).optional(),
  question: z.string().trim().min(5).max(400).optional(),
  options: z.array(z.string().trim().min(1).max(220)).min(3).max(5).optional(),
  correctIndex: z.number().int().min(0).max(4).optional(),
  explanation: z.string().max(600).optional(),
  followupQuestion: z.string().max(300).optional(),
}).strict();

const customLaunchSchema = z.object({
  expiresInMinutes: z.number().int().min(5).max(1440).optional(),
}).strict();

const attemptsQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(2000).optional(),
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

  app.post("/api/quiz/launches", async (req, res) => {
    try {
      const session = await requireTeacher(req, res);
      if (!session) return;
      const input = launchSchema.parse(req.body || {});
      const courseCode = trimText(input.courseCode) || trimText(session.user.activeCourseCode);
      const content = await resolveQuizContent(session, { ...input, courseCode });
      if ("error" in content) {
        return res.status(502).json({ ok: false, error: content.error });
      }
      return res.json(await launchForClass(session, {
        ...content,
        courseCode,
        topic: input.topic,
        expiresInMinutes: input.expiresInMinutes,
      }));
    } catch (error) {
      return res.status(400).json({ ok: false, error: errorMessage(error) });
    }
  });

  // --- Banco propio y quices hechos (0.7.15) ---------------------------------

  function mapLaunchForApi(launch: QuizLaunchRecord, quizzes: StudentQuizRecord[]) {
    return { ...launch, results: summarize(quizzes.filter((quiz) => quiz.launchId === launch.id)) };
  }

  async function customQuizPayload(session: AppSession) {
    const [quizzes, launches, attempts] = await Promise.all([
      database.listTeacherQuizzes(session.user.id),
      database.listQuizLaunches(session.user.id, 50),
      database.listStudentQuizzesForTeacher(session.user.id, 5000),
    ]);
    return {
      quizzes: quizzes.map((quiz) => {
        const own = launches.filter((launch) => launch.customQuizId === quiz.id);
        return {
          ...quiz,
          launchCount: own.length,
          lastLaunchedAt: own[0]?.createdAt || null,
          activeLaunchId: own.find((launch) => launch.active && (!launch.expiresAt || launch.expiresAt > new Date().toISOString()))?.id || null,
          results: summarize(attempts.filter((quiz2) => own.some((launch) => launch.id === quiz2.launchId))),
        };
      }),
      launches: launches.slice(0, 10).map((launch) => mapLaunchForApi(launch, attempts)),
    };
  }

  app.get("/api/quiz/custom", async (req, res) => {
    try {
      const session = await requireTeacher(req, res);
      if (!session) return;
      return res.json({ ok: true, ...(await customQuizPayload(session)) });
    } catch (error) {
      return res.status(400).json({ ok: false, error: errorMessage(error) });
    }
  });

  app.post("/api/quiz/custom", async (req, res) => {
    try {
      const session = await requireTeacher(req, res);
      if (!session) return;
      const input = customQuizSchema.parse(req.body || {});
      const courseCode = trimText(input.courseCode) || trimText(session.user.activeCourseCode);
      const content = await resolveQuizContent(session, { ...input, courseCode });
      if ("error" in content) {
        return res.status(502).json({ ok: false, error: content.error });
      }
      const quiz = await database.createTeacherQuiz({ teacherUserId: session.user.id, courseCode, topic: input.topic, ...content });
      return res.status(201).json({ ok: true, quiz, generated: !input.question });
    } catch (error) {
      return res.status(400).json({ ok: false, error: errorMessage(error) });
    }
  });

  app.put("/api/quiz/custom/:id", async (req, res) => {
    try {
      const session = await requireTeacher(req, res);
      if (!session) return;
      const input = customQuizSchema.parse(req.body || {});
      const current = await database.getTeacherQuiz(String(req.params.id || ""));
      if (!current || current.teacherUserId !== session.user.id || !current.isActive) {
        return res.status(404).json({ ok: false, error: "Quiz no encontrado." });
      }
      if (!input.question || !input.options || input.correctIndex === undefined) {
        return res.status(400).json({ ok: false, error: "Para editar un quiz se necesitan la pregunta, las opciones y la correcta." });
      }
      if (input.correctIndex >= input.options.length) {
        return res.status(400).json({ ok: false, error: "La opcion correcta no existe." });
      }
      const courseCode = trimText(input.courseCode) || current.courseCode;
      const quiz = await database.updateTeacherQuiz(current.id, session.user.id, {
        courseCode,
        topic: input.topic,
        question: input.question,
        options: input.options,
        correctIndex: input.correctIndex,
        explanation: input.explanation || "",
        followupQuestion: input.followupQuestion || current.followupQuestion,
      });
      return res.json({ ok: true, quiz });
    } catch (error) {
      return res.status(400).json({ ok: false, error: errorMessage(error) });
    }
  });

  app.delete("/api/quiz/custom/:id", async (req, res) => {
    try {
      const session = await requireTeacher(req, res);
      if (!session) return;
      const retired = await database.retireTeacherQuiz(String(req.params.id || ""), session.user.id);
      if (!retired) {
        return res.status(404).json({ ok: false, error: "Quiz no encontrado." });
      }
      return res.json({ ok: true, removed: true });
    } catch (error) {
      return res.status(400).json({ ok: false, error: errorMessage(error) });
    }
  });

  app.post("/api/quiz/custom/:id/launch", async (req, res) => {
    try {
      const session = await requireTeacher(req, res);
      if (!session) return;
      const input = customLaunchSchema.parse(req.body || {});
      const quiz = await database.getTeacherQuiz(String(req.params.id || ""));
      if (!quiz || quiz.teacherUserId !== session.user.id || !quiz.isActive) {
        return res.status(404).json({ ok: false, error: "Quiz no encontrado." });
      }
      const shuffled = shuffleQuizOptions({
        question: quiz.question,
        options: quiz.options,
        correctIndex: quiz.correctIndex,
        explanation: quiz.explanation,
        followupQuestion: quiz.followupQuestion,
        topic: quiz.topic,
      });
      return res.json(await launchForClass(session, {
        courseCode: quiz.courseCode || trimText(session.user.activeCourseCode),
        topic: quiz.topic,
        question: quiz.question,
        options: shuffled.options,
        correctIndex: shuffled.correctIndex,
        explanation: quiz.explanation,
        followupQuestion: quiz.followupQuestion || "Explica con tus palabras el concepto de esta pregunta.",
        expiresInMinutes: input.expiresInMinutes,
        customQuizId: quiz.id,
      }));
    } catch (error) {
      return res.status(400).json({ ok: false, error: errorMessage(error) });
    }
  });

  /** Quices hechos por los estudiantes del docente, con nombre; nunca ids de sesion ni de cliente. */
  app.get("/api/quiz/attempts", async (req, res) => {
    try {
      const session = await requireTeacher(req, res);
      if (!session) return;
      const query = attemptsQuerySchema.parse(req.query || {});
      const [quizzes, managed, launches] = await Promise.all([
        database.listStudentQuizzesForTeacher(session.user.id, query.limit || 300),
        database.listManagedUsers(session.user),
        database.listQuizLaunches(session.user.id, 100),
      ]);
      const students = new Map(managed.users.filter((user) => user.role === "student").map((user) => [user.id, user]));
      const launchById = new Map(launches.map((launch) => [launch.id, launch]));
      const anonymous = new Map<string, number>();
      const attempts = quizzes.map((quiz) => {
        const student = quiz.userId ? students.get(quiz.userId) : null;
        let label = student?.displayName || "";
        if (!label) {
          if (!anonymous.has(quiz.clientKey)) anonymous.set(quiz.clientKey, anonymous.size + 1);
          label = `Sin cuenta ${anonymous.get(quiz.clientKey)}`;
        }
        const launch = quiz.launchId ? launchById.get(quiz.launchId) : null;
        return {
          id: quiz.id,
          studentUserId: quiz.userId,
          studentName: label,
          studentEmail: student?.email || "",
          courseCodes: student?.assignedCourseCodes || [],
          trigger: quiz.trigger,
          status: quiz.status,
          topic: quiz.topic,
          question: quiz.question,
          options: quiz.options,
          correctIndex: quiz.correctIndex,
          chosenIndex: quiz.chosenIndex,
          correct: quiz.correct,
          followupAnswer: quiz.followupAnswer,
          followupScore: quiz.followupScore,
          followupFeedback: quiz.followupFeedback,
          launchId: quiz.launchId,
          launchTopic: launch?.topic || "",
          customQuizId: launch?.customQuizId || "",
          language: quiz.language,
          filePath: quiz.filePath,
          createdAt: quiz.createdAt,
          answeredAt: quiz.answeredAt,
          completedAt: quiz.completedAt,
        };
      });
      return res.json({ ok: true, attempts, summary: summarize(quizzes) });
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

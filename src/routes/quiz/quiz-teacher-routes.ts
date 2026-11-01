// Rutas del docente: lanzar un quiz, banco propio, quices hechos, lanzamientos y resumen.
import type express from "express";
import { z } from "zod";
import type { AppDatabase } from "../../db/database.js";
import { shuffleQuizOptions } from "../../services/quiz/quiz.js";
import { trimText } from "../../services/shared/text-utils.js";
import type { AppSession, QuizLaunchRecord, StudentQuizRecord } from "../../types/app.js";
import { errorMessage } from "../route-utils.js";
import { type QuizTeacherHelpers } from "./quiz-teacher-helpers.js";

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

export function registerQuizTeacherLaunchRoutes(app: express.Express, helpers: QuizTeacherHelpers) {
  const { requireTeacher, resolveQuizContent, launchForClass } = helpers;

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
}

export function registerQuizTeacherBankRoutes(app: express.Express, database: AppDatabase, helpers: QuizTeacherHelpers) {
  const { requireTeacher, summarize, resolveQuizContent, launchForClass } = helpers;

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

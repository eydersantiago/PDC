// Ayudas de las rutas del mini quiz: quien pide (sesion o cliente), su politica, su quiz y el bloque RAG.
import type express from "express";
import type { AppDatabase } from "../../db/database.js";
import { resolveMentorRagContext } from "../../services/tutor/decision-engine.js";
import { buildRagPromptBlock } from "../../services/rag/rag-prompt.js";
import { CLIENT_ID_PATTERN, clientActorKey, userActorKey } from "../../services/telemetry/telemetry.js";
import { trimText } from "../../services/shared/text-utils.js";
import type { AppSession, AppUser, TeacherPolicy } from "../../types/app.js";
import { resolveSession } from "../route-utils.js";

export type QuizActor = {
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

export function createQuizStudentHelpers(database: AppDatabase) {
  async function resolveActor(req: express.Request): Promise<QuizActor | null> {
    const session = await resolveSession(database, req).catch(() => null);
    if (session) {
      return { session, clientKey: userActorKey(session.user.id) };
    }
    const clientId = trimText(req.header("x-adaceen-client-id"));
    if (!CLIENT_ID_PATTERN.test(clientId)) {
      return null;
    }
    // La misma clave que su telemetria (actorFromClientId), asi el quiz y los eventos se unen.
    return { session: null, clientKey: clientActorKey(clientId) };
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

  return { resolveActor, policyFor, loadOwnQuiz, ragBlockFor };
}

export type QuizStudentHelpers = ReturnType<typeof createQuizStudentHelpers>;

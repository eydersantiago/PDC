// Contexto RAG del tutor: curso de la sesion y fuentes del lote efectivo para una pregunta (resolveMentorRagContext).
import { AppDatabase } from "../../db/database.js";
import type { AppSession, GithubMentorContext } from "../../types/app.js";
import { rankRagChunks, type RagRankOptions } from "../rag/rag-sources.js";
import { buildRagSearchQuery } from "../rag/rag-search-query.js";
import { DEFAULT_RAG_COURSE_CODE, getRagCourse, inferRagCourseCodeFromText, normalizeRagCourseCode, normalizeRagCourseCodes } from "../rag/rag-courses.js";
import { trimText } from "../shared/text-utils.js";
import { resolveEffectiveLot, type EffectiveRagLot } from "../rag/rag-lots.js";

function resolveRagCourseCodeForSession(
  session: AppSession | null,
  requestedCourseCode: string,
  inferredCourseCode: string,
) {
  const requested = normalizeRagCourseCode(requestedCourseCode);
  const inferred = normalizeRagCourseCode(inferredCourseCode);
  const candidate = getRagCourse(requested)
    ? requested
    : getRagCourse(inferred)
      ? inferred
      : DEFAULT_RAG_COURSE_CODE;

  if (session?.user.role !== "student") {
    return candidate;
  }

  const assignedCourseCodes = normalizeRagCourseCodes(session.user.assignedCourseCodes, {
    fallbackToDefault: true,
    knownOnly: true,
  });
  if (assignedCourseCodes.includes(candidate)) {
    return candidate;
  }
  return assignedCourseCodes[0] || DEFAULT_RAG_COURSE_CODE;
}

export async function resolveMentorRagContext(input: {
  question: string;
  context: GithubMentorContext;
  session: AppSession | null;
  database: AppDatabase;
  /** Consulta ya armada (la del editor sale del codigo, no de la pregunta). */
  queryOverride?: string;
  /** Umbral relativo y variedad por fuente (ver RagRankOptions). */
  rankOptions?: Omit<RagRankOptions, "languageHint">;
}) {
  const ragQuery = trimText(input.queryOverride) || buildRagSearchQuery(input.question, input.context);
  const inferredRagCourseCode = inferRagCourseCodeFromText([
    input.question,
    input.context.activityTitle,
    input.context.learningGoal,
    input.context.repoFullName,
    input.context.url,
  ].map((item) => trimText(item)).filter(Boolean).join("\n"));
  const ragCourseCode = resolveRagCourseCodeForSession(
    input.session,
    input.context.ragCourseCode || input.context.courseCode || "",
    inferredRagCourseCode,
  );
  const accessibleRagChunks = await input.database
    .listRagChunksForUser(input.session?.user || null, 800, { courseCode: ragCourseCode, includeSupplemental: true })
    .catch(() => []);
  const ragSources = rankRagChunks(
    accessibleRagChunks,
    ragQuery,
    undefined,
    // El lenguaje del archivo baja las fuentes de otro lenguaje (Ruby para un archivo C++).
    { languageHint: input.context.languageHint, ...input.rankOptions },
  );
  // Lote de RAG que aplico (0.7.15): el del estudiante, el activo del docente o la base.
  const baseLot = resolveEffectiveLot({ courseCode: ragCourseCode, lots: [], activeLotId: null });
  const ragLot: EffectiveRagLot = typeof input.database.resolveRagLotForUser === "function"
    ? await input.database.resolveRagLotForUser(input.session?.user || null, ragCourseCode).catch(() => baseLot)
    : baseLot;

  return { ragSources, ragCourseCode, ragLot };
}

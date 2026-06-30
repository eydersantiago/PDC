import assert from "node:assert/strict";
import test from "node:test";
import type { AppDatabase } from "../../src/db/database.js";
import { resolveMentorRagContext } from "../../src/services/decision-engine.js";
import { buildRagChunksForSource } from "../../src/services/rag-sources.js";
import type { AppSession, RagSource, RagSourceChunk } from "../../src/types/app.js";

function chunkAsStored(source: RagSource, chunk: ReturnType<typeof buildRagChunksForSource>[number]): RagSourceChunk {
  return {
    id: `${source.id}:chunk:${chunk.chunkIndex}`,
    sourceId: source.id,
    scope: source.scope,
    teacherUserId: source.teacherUserId,
    sourceKey: source.sourceKey,
    sourceTitle: source.title,
    sourceType: source.sourceType,
    fileName: source.fileName,
    mimeType: source.mimeType,
    sourceMetadata: source.metadata,
    isActive: source.isActive,
    ...chunk,
    createdAt: source.createdAt,
  };
}

function buildCourseSource(courseCode: string, title: string, contentText: string): RagSource {
  const source: RagSource = {
    id: `source-${courseCode.toLowerCase()}`,
    scope: "teacher",
    teacherUserId: "teacher-1",
    sourceKey: `guia-${courseCode.toLowerCase()}`,
    title,
    sourceType: "text",
    fileName: `guia-${courseCode.toLowerCase()}.txt`,
    mimeType: "text/plain",
    contentSha256: `sha-${courseCode.toLowerCase()}`,
    contentText,
    metadata: {
      courseCode,
      courseName: title,
      courseMaterialUrl: `https://example.test/${courseCode.toLowerCase()}.txt`,
    },
    isActive: true,
    createdByUserId: "teacher-1",
    createdAt: "2026-06-30T00:00:00.000Z",
    updatedAt: "2026-06-30T00:00:00.000Z",
  };
  const chunks = buildRagChunksForSource({
    title: source.title,
    sourceType: source.sourceType,
    fileName: source.fileName,
    sourceKey: source.sourceKey,
    contentText: source.contentText,
    metadata: source.metadata,
  });

  source.chunks = chunks.map((chunk) => chunkAsStored(source, chunk));
  return source;
}

test("resolveMentorRagContext usa la RAG del curso seleccionado para estudiantes multi-curso", async () => {
  const sources = [
    buildCourseSource("FPOO", "Guia FPOO objetos", "Encapsulamiento de atributos privados y metodos de negocio en clases."),
    buildCourseSource("FPOE", "Guia FPOE eventos", "Eventos, listeners, callbacks y botones para interfaces orientadas a eventos."),
  ];
  const requestedCourseCodes: Array<string | undefined> = [];
  const database = {
    async listRagChunksForUser(_user, _limit, options) {
      requestedCourseCodes.push(options?.courseCode);
      return sources
        .filter((source) => source.metadata.courseCode === options?.courseCode)
        .flatMap((source) => source.chunks || []);
    },
  } as Partial<AppDatabase> as AppDatabase;
  const session: AppSession = {
    id: "session-student",
    createdAt: "2026-06-30T00:00:00.000Z",
    lastSeenAt: "2026-06-30T00:00:00.000Z",
    user: {
      id: "student-1",
      role: "student",
      email: "student@example.test",
      displayName: "Estudiante",
      teacherUserId: "teacher-1",
      assignedCourseCodes: ["FPOO", "FPOE"],
      activeCourseCode: "FPOO",
    },
  };

  const result = await resolveMentorRagContext({
    question: "Como conecto eventos y listeners a un boton?",
    context: {
      courseCode: "FPOE",
      ragCourseCode: "FPOE",
      learningGoal: "debugging",
      codeSnippet: "button.addEventListener('click', handleClick);",
    },
    session,
    database,
  });

  assert.deepEqual(requestedCourseCodes, ["FPOE"]);
  assert.equal(result.ragCourseCode, "FPOE");
  assert.ok(result.ragSources.length > 0);
  assert.equal(result.ragSources[0].title, "Guia FPOE eventos");
  assert.ok(result.ragSources.every((source) => source.metadata.courseCode === "FPOE"));
});

import assert from "node:assert/strict";
import test from "node:test";
import type { GithubMentorResult, RagSource, RagSourceChunk } from "../../src/types/app.js";
import {
  buildRagChunksForSource,
  buildRagPromptBlock,
  ensureMentorResultRagCitations,
  getRagKnowledgeTier,
  rankRagSources,
} from "../../src/services/rag-sources.js";

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

function buildSourceWithChunks() {
  const source: RagSource = {
    id: "source-libro-poo",
    scope: "teacher",
    teacherUserId: "teacher-1",
    sourceKey: "libro-poo",
    title: "Libro base de POO",
    sourceType: "pdf",
    fileName: "libro-poo.pdf",
    mimeType: "application/pdf",
    contentSha256: "sha",
    contentText: [
      "Encapsulamiento: los atributos privados protegen invariantes de la clase.",
      "Polimorfismo: una interfaz permite sustituir implementaciones sin romper el contrato.",
    ].join("\n\n"),
    metadata: {
      courseCode: "FPOO",
      description: "Material docente de programacion orientada a objetos.",
      courseMaterialUrl: "https://example.test/libro-poo.pdf",
    },
    isActive: true,
    createdByUserId: "teacher-1",
    createdAt: "2026-06-23T00:00:00.000Z",
    updatedAt: "2026-06-23T00:00:00.000Z",
  };
  const chunks = buildRagChunksForSource({
    title: source.title,
    sourceType: source.sourceType,
    fileName: source.fileName,
    sourceKey: source.sourceKey,
    contentText: source.contentText,
    metadata: source.metadata,
    pages: [
      {
        pageNumber: 12,
        text: "Encapsulamiento: los atributos privados protegen invariantes de la clase.",
      },
      {
        pageNumber: 13,
        text: "Polimorfismo: una interfaz permite sustituir implementaciones sin romper el contrato.",
      },
    ],
  });

  source.chunks = chunks.map((chunk) => chunkAsStored(source, chunk));
  return source;
}

test("buildRagChunksForSource conserva pagina y cita obligatoria", () => {
  const source = buildSourceWithChunks();
  assert.ok(source.chunks?.length);
  assert.match(source.chunks?.[0]?.citationLabel || "", /\[libro-poo#c1 p\.12(?:-13)?\]/);
  assert.equal(source.chunks?.[0]?.pageStart, 12);
});

test("rankRagSources combina FTS y senal semantica sobre chunks", () => {
  const source = buildSourceWithChunks();
  const ranked = rankRagSources([source], "como proteger atributos con encapsulamiento", 3);

  assert.ok(ranked.length >= 1);
  assert.equal(ranked[0].sourceId, source.id);
  assert.ok(ranked[0].ftsScore > 0);
  assert.ok(ranked[0].semanticScore > 0);
  assert.match(ranked[0].citationLabel, /\[libro-poo#c\d+ p\.12/);
  assert.match(buildRagPromptBlock(ranked), /Cita obligatoria: \[libro-poo#c\d+ p\.12/);
});

test("rankRagSources trata bitacora como contexto suplementario", () => {
  const primary = buildSourceWithChunks();
  primary.scope = "default";
  primary.metadata = {
    ...primary.metadata,
    knowledge_tier: "primary",
    context_domain: "rag",
  };
  primary.chunks = buildRagChunksForSource({
    title: primary.title,
    sourceType: primary.sourceType,
    fileName: primary.fileName,
    sourceKey: primary.sourceKey,
    contentText: primary.contentText,
    metadata: primary.metadata,
  }).map((chunk) => chunkAsStored(primary, chunk));

  const supplemental: RagSource = {
    ...primary,
    id: "source-bitacora-semana",
    sourceKey: "bitacora-semana-5",
    title: "Semana 5 - Implementacion de una clase: abstraccion y encapsulamiento",
    sourceType: "bitacora_activity",
    fileName: "BITACORA.FPOO.2026-1.pdf",
    contentSha256: "sha-bitacora",
    contentText: [
      "Semana 5: Implementacion de una clase, abstraccion y encapsulamiento.",
      "Actividad: revisar atributos privados, metodos publicos y responsabilidades.",
    ].join("\n"),
    metadata: {
      courseCode: "FPOO",
      source_pdf: "BITACORA.FPOO.2026-1 - Regreso a clases 2026.pdf",
      week: 5,
      category: "actividad_clase",
      knowledge_tier: "supplemental",
      context_domain: "bitacora",
    },
  };
  supplemental.chunks = buildRagChunksForSource({
    title: supplemental.title,
    sourceType: supplemental.sourceType,
    fileName: supplemental.fileName,
    sourceKey: supplemental.sourceKey,
    contentText: supplemental.contentText,
    metadata: supplemental.metadata,
  }).map((chunk) => chunkAsStored(supplemental, chunk));

  const ranked = rankRagSources([supplemental, primary], "encapsulamiento atributos privados", 2);

  assert.equal(getRagKnowledgeTier(supplemental.metadata, supplemental.sourceType), "supplemental");
  assert.equal(ranked[0].sourceId, primary.id);
  assert.ok(ranked.some((item) => item.sourceId === supplemental.id && item.metadata.knowledgeTier === "supplemental"));
  assert.match(buildRagPromptBlock(ranked), /contexto suplementario de bitacora\/actividad/);
});

test("ensureMentorResultRagCitations agrega citas si el modelo las omite", () => {
  const source = buildSourceWithChunks();
  const ranked = rankRagSources([source], "encapsulamiento", 1);
  const result: GithubMentorResult = {
    ideas: ["Revisa que el estado interno no se modifique directamente."],
    searches: ["Revisar material de clase"],
    guide: [
      "Identifica atributos que representan estado interno.",
      "Decide que operaciones publicas cambian ese estado.",
      "Valida invariantes antes y despues de cada cambio.",
      "Resume la regla de acceso en una frase.",
    ],
    welcome_message: "Hola.",
    analysis_summary: "Respuesta generada con RAG.",
  };

  const cited = ensureMentorResultRagCitations(result, ranked);
  assert.ok(cited.ideas.every((item) => item.includes(ranked[0].citationLabel)));
  assert.ok(cited.guide.every((item) => item.includes(ranked[0].citationLabel)));
  assert.ok(cited.analysis_summary.includes(ranked[0].citationLabel));
});

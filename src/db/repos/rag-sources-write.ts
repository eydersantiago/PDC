// AppDatabase: escribir fuentes RAG (crear, reemplazar los fragmentos, actualizar el texto y retirar).
// Metodos movidos sin cambios desde src/db/repos/rag-sources.ts; la clase va entre RagSourcesDatabase y GithubDatabase.
import { randomUUID } from "node:crypto";
import type { RagSource, RagSourceChunkInput } from "../../types/app.js";
import { contentHash, mapRagSourceRow } from "../rag-rows.js";
import type { RagSourceRow } from "../rag-rows.js";
import { buildRagChunksForSource } from "../../services/rag/rag-chunks.js";
import { env } from "../../config/env.js";
import { trimText } from "../../services/shared/text-utils.js";
import { RagSourcesDatabase } from "./rag-sources.js";

export class RagSourcesWriteDatabase extends RagSourcesDatabase {
  protected async replaceRagSourceChunks(
    source: RagSource,
    chunkInputs?: RagSourceChunkInput[],
  ) {
    const chunks = chunkInputs?.length
      ? chunkInputs
      : buildRagChunksForSource({
        title: source.title,
        sourceType: source.sourceType,
        fileName: source.fileName,
        sourceKey: source.sourceKey,
        contentText: source.contentText,
        metadata: source.metadata,
      });

    await this.pool.query(
      `delete from rag_source_chunks where source_id = $1`,
      [source.id],
    );

    for (const chunk of chunks.slice(0, env.ragMaxChunksPerSource)) {
      await this.pool.query(
        `
        insert into rag_source_chunks (
          id,
          source_id,
          chunk_index,
          content_text,
          search_text,
          token_count,
          char_start,
          char_end,
          page_start,
          page_end,
          citation_label,
          metadata,
          created_at
        )
        values (
          $1,
          $2,
          $3,
          $4,
          $5,
          $6,
          $7,
          $8,
          $9,
          $10,
          $11,
          $12::jsonb,
          now()
        )
        on conflict (source_id, chunk_index) do update
        set
          content_text = excluded.content_text,
          search_text = excluded.search_text,
          token_count = excluded.token_count,
          char_start = excluded.char_start,
          char_end = excluded.char_end,
          page_start = excluded.page_start,
          page_end = excluded.page_end,
          citation_label = excluded.citation_label,
          metadata = excluded.metadata
        `,
        [
          `${source.id}:chunk:${chunk.chunkIndex}`,
          source.id,
          chunk.chunkIndex,
          chunk.contentText,
          chunk.searchText,
          chunk.tokenCount,
          chunk.charStart,
          chunk.charEnd,
          chunk.pageStart,
          chunk.pageEnd,
          chunk.citationLabel,
          JSON.stringify(chunk.metadata || {}),
        ],
      );
    }

    return chunks.length;
  }

  async createTeacherRagSource(input: {
    teacherUserId: string;
    createdByUserId: string;
    sourceKey?: string;
    title: string;
    sourceType: string;
    fileName: string;
    mimeType: string;
    contentText: string;
    metadata: Record<string, unknown>;
    chunks?: RagSourceChunkInput[];
  }) {
    const contentText = trimText(input.contentText);
    const sourceKey = trimText(input.sourceKey)
      || trimText(input.fileName)
      || randomUUID();
    const result = await this.pool.query<RagSourceRow>(
      `
      insert into rag_sources (
        id,
        scope,
        teacher_user_id,
        source_key,
        title,
        source_type,
        file_name,
        mime_type,
        content_sha256,
        content_text,
        metadata,
        is_active,
        created_by_user_id,
        created_at,
        updated_at
      )
      values (
        $1,
        'teacher',
        $2,
        $3,
        $4,
        $5,
        $6,
        $7,
        $8,
        $9,
        $10::jsonb,
        true,
        $11,
        now(),
        now()
      )
      returning
        id,
        scope,
        teacher_user_id,
        source_key,
        title,
        source_type,
        file_name,
        mime_type,
        content_sha256,
        content_text,
        metadata,
        is_active,
        created_by_user_id,
        created_at,
        updated_at
      `,
      [
        randomUUID(),
        input.teacherUserId,
        sourceKey,
        trimText(input.title).slice(0, 260) || sourceKey,
        trimText(input.sourceType).slice(0, 80) || "document",
        trimText(input.fileName).slice(0, 500),
        trimText(input.mimeType).slice(0, 160),
        contentHash(contentText),
        contentText,
        JSON.stringify(input.metadata || {}),
        input.createdByUserId,
      ],
    );

    const source = mapRagSourceRow(result.rows[0]);
    await this.replaceRagSourceChunks(source, input.chunks);
    source.chunks = await this.listRagChunksForSource(source.id, env.ragMaxChunksPerSource);
    return source;
  }

  async updateRagSourceExtractedContent(sourceId: string, input: {
    fileName?: string;
    mimeType?: string;
    sourceType?: string;
    contentText: string;
    metadata: Record<string, unknown>;
    chunks?: RagSourceChunkInput[];
  }) {
    const cleanSourceId = trimText(sourceId);
    const contentText = trimText(input.contentText);
    if (!cleanSourceId || !contentText) return null;

    const result = await this.pool.query<RagSourceRow>(
      `
      update rag_sources
      set
        source_type = coalesce(nullif($2, ''), source_type),
        file_name = coalesce(nullif($3, ''), file_name),
        mime_type = coalesce(nullif($4, ''), mime_type),
        content_sha256 = $5,
        content_text = $6,
        metadata = metadata || $7::jsonb,
        updated_at = now()
      where id = $1
        and is_active = true
      returning
        id,
        scope,
        teacher_user_id,
        source_key,
        title,
        source_type,
        file_name,
        mime_type,
        content_sha256,
        content_text,
        metadata,
        is_active,
        created_by_user_id,
        created_at,
        updated_at
      `,
      [
        cleanSourceId,
        trimText(input.sourceType).slice(0, 80),
        trimText(input.fileName).slice(0, 500),
        trimText(input.mimeType).slice(0, 160),
        contentHash(contentText),
        contentText,
        JSON.stringify(input.metadata || {}),
      ],
    );

    const source = result.rows[0] ? mapRagSourceRow(result.rows[0]) : null;
    if (!source) return null;

    await this.replaceRagSourceChunks(source, input.chunks);
    source.chunks = await this.listRagChunksForSource(source.id, env.ragMaxChunksPerSource);
    return source;
  }

  async deactivateTeacherRagSource(sourceId: string, teacherUserId: string) {
    const result = await this.pool.query<{ id: string }>(
      `
      update rag_sources
      set is_active = false, updated_at = now()
      where id = $1
        and scope = 'teacher'
        and teacher_user_id = $2
        and is_active = true
      returning id
      `,
      [sourceId, teacherUserId],
    );

    return Boolean(result.rows[0]);
  }
}

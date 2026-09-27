// AppDatabase, parte 6 de 12: fuentes RAG y sus fragmentos (listar para un usuario, crear, actualizar el texto y retirar).
// Metodos movidos sin cambios desde src/db/database.ts. Cadena: DatabaseCore -> AuthDatabase -> UsersDatabase -> PolicyDatabase -> RagLotsDatabase -> RagSourcesDatabase -> GithubDatabase -> WorkspaceDatabase -> PilotDatabase -> TelemetryDatabase -> ProgressDatabase -> QuizDatabase -> AppDatabase
// (cada clase extiende a la anterior; db.metodo() sigue igual). private pasa a protected solo si otra clase lo usa.
import { randomUUID } from "node:crypto";
import type { AppUser, RagSource, RagSourceChunk, RagSourceChunkInput } from "../../types/app.js";
import { DEFAULT_RAG_COURSE_CODE, normalizeRagCourseCode } from "../../services/rag-courses.js";
import { contentHash, mapRagChunkRow, mapRagSourceRow } from "../rows.js";
import type { RagSourceChunkRow, RagSourceRow } from "../rows.js";
import { buildRagChunksForSource, isRetrievableRagSource } from "../../services/rag-sources.js";
import { filterSourcesForLot } from "../../services/rag-lots.js";
import { env } from "../../config/env.js";
import { trimText } from "../../services/text-utils.js";
import { RagLotsDatabase } from "./rag-lots.js";

export class RagSourcesDatabase extends RagLotsDatabase {
  async listRagSourcesForUser(
    user: AppUser | null,
    limit = 100,
    options?: {
      courseCode?: string;
      includeAllCourses?: boolean;
      includeSupplemental?: boolean;
      includeReferenceOnly?: boolean;
      /** Todas las fuentes sin importar el lote ni las desactivadas (catalogo del docente). */
      includeAllLots?: boolean;
    },
  ) {
    const sourceLimit = Math.max(1, Math.min(300, Math.round(Number(limit) || 100)));
    const courseCode = normalizeRagCourseCode(options?.courseCode || DEFAULT_RAG_COURSE_CODE);
    const teacherUserId = user
      ? user.role === "teacher"
        ? user.id
        : user.teacherUserId || await this.getDefaultTeacherId()
      : null;

    const result = await this.pool.query<RagSourceRow>(
      `
      select
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
      from rag_sources
      where is_active = true
        and (
          scope = 'default'
          or (
            $1 <> ''
            and scope = 'teacher'
            and teacher_user_id = $1
          )
        )
      order by
        case scope when 'teacher' then 0 else 1 end,
        created_at desc,
        title asc
      limit $2
      `,
      [teacherUserId || "", sourceLimit],
    );

    const sources = result.rows.map(mapRagSourceRow);
    const filteredSources = sources.filter((source) => {
      const metadataCourseCode = normalizeRagCourseCode(
        String(source.metadata.courseCode || source.metadata.course_code || DEFAULT_RAG_COURSE_CODE),
      );
      const matchesCourse = options?.includeAllCourses ? true : metadataCourseCode === courseCode;
      if (!matchesCourse) return false;
      if (options?.includeReferenceOnly === true) return true;
      return isRetrievableRagSource(source, options?.includeSupplemental === true);
    });

    // Lote efectivo (0.7.15): el estudiante solo recibe el lote que le aplica (el suyo o
    // el activo del docente) y nunca las fuentes que el docente desactivo.
    const lotFiltered = options?.includeAllLots || options?.includeAllCourses
      ? filteredSources
      : filterSourcesForLot(
        filteredSources,
        await this.resolveRagLotForUser(user, courseCode),
        teacherUserId ? await this.listRagSourceOverrides(teacherUserId) : [],
      );

    return this.hydrateRagSourcesWithChunks(lotFiltered);
  }

  private async hydrateRagSourcesWithChunks(sources: RagSource[]) {
    for (const source of sources) {
      source.chunks = await this.listRagChunksForSource(source.id, env.ragMaxChunksPerSource);
    }
    return sources;
  }

  private buildVirtualRagChunks(source: RagSource): RagSourceChunk[] {
    const chunks = buildRagChunksForSource({
      title: source.title,
      sourceType: source.sourceType,
      fileName: source.fileName,
      sourceKey: source.sourceKey,
      contentText: source.contentText,
      metadata: source.metadata,
    });

    return chunks.map((chunk) => ({
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
      chunkIndex: chunk.chunkIndex,
      contentText: chunk.contentText,
      searchText: chunk.searchText,
      tokenCount: chunk.tokenCount,
      charStart: chunk.charStart,
      charEnd: chunk.charEnd,
      pageStart: chunk.pageStart,
      pageEnd: chunk.pageEnd,
      citationLabel: chunk.citationLabel,
      metadata: chunk.metadata,
      createdAt: source.createdAt,
    }));
  }

  async listRagChunksForUser(
    user: AppUser | null,
    limit = 600,
    options?: {
      courseCode?: string;
      includeAllCourses?: boolean;
      includeSupplemental?: boolean;
      includeReferenceOnly?: boolean;
    },
  ) {
    const chunkLimit = Math.max(1, Math.min(1200, Math.round(Number(limit) || 600)));
    const sources = await this.listRagSourcesForUser(user, 300, options);
    const chunks: RagSourceChunk[] = [];

    for (const source of sources) {
      const sourceChunks = source.chunks?.length
        ? source.chunks
        : await this.listRagChunksForSource(source.id, Math.max(1, Math.min(env.ragMaxChunksPerSource, chunkLimit)));
      chunks.push(...(sourceChunks.length ? sourceChunks : this.buildVirtualRagChunks(source)));
      if (chunks.length >= chunkLimit) break;
    }

    return chunks.slice(0, chunkLimit);
  }

  async getRagSourceForUser(
    user: AppUser | null,
    sourceId: string,
    options?: {
      courseCode?: string;
      includeAllCourses?: boolean;
    },
  ) {
    const cleanSourceId = trimText(sourceId);
    if (!cleanSourceId) return null;

    const sources = await this.listRagSourcesForUser(user, 300, options);
    return sources.find((source) => source.id === cleanSourceId) || null;
  }

  async getRagSourceForViewer(
    sourceId: string,
    options?: {
      courseCode?: string;
    },
  ) {
    const cleanSourceId = trimText(sourceId);
    if (!cleanSourceId) return null;

    const result = await this.pool.query<RagSourceRow>(
      `
      select
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
      from rag_sources
      where id = $1
        and is_active = true
      limit 1
      `,
      [cleanSourceId],
    );

    const source = result.rows[0] ? mapRagSourceRow(result.rows[0]) : null;
    if (!source) return null;
    if (!isRetrievableRagSource(source, true)) return null;

    const expectedCourseCode = trimText(options?.courseCode)
      ? normalizeRagCourseCode(String(options?.courseCode))
      : "";
    if (expectedCourseCode) {
      const sourceCourseCode = normalizeRagCourseCode(
        String(source.metadata.courseCode || source.metadata.course_code || DEFAULT_RAG_COURSE_CODE),
      );
      if (sourceCourseCode !== expectedCourseCode) return null;
    }

    const hydratedSources = await this.hydrateRagSourcesWithChunks([source]);
    return hydratedSources[0] || source;
  }

  private async listRagChunksForSource(sourceId: string, limit: number) {
    const chunkLimit = Math.max(1, Math.min(env.ragMaxChunksPerSource, Math.round(Number(limit) || env.ragMaxChunksPerSource)));
    const result = await this.pool.query<RagSourceChunkRow>(
      `
      select
        c.id,
        c.source_id,
        s.scope,
        s.teacher_user_id,
        s.source_key,
        s.title as source_title,
        s.source_type,
        s.file_name,
        s.mime_type,
        s.metadata as source_metadata,
        s.is_active,
        c.chunk_index,
        c.content_text,
        c.search_text,
        c.token_count,
        c.char_start,
        c.char_end,
        c.page_start,
        c.page_end,
        c.citation_label,
        c.metadata,
        c.created_at
      from rag_source_chunks c
      join rag_sources s on s.id = c.source_id
      where c.source_id = $1
        and s.is_active = true
      order by c.chunk_index asc
      limit $2
      `,
      [sourceId, chunkLimit],
    );

    return result.rows.map(mapRagChunkRow);
  }

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

// AppDatabase, arranque: fuentes RAG por defecto y el examen preparado (EXAM_PRESET).
// Metodos movidos sin cambios desde src/db/database.ts; la clase va entre SeedDemoRoutesDatabase y AppDatabase.
import path from "node:path";
import fsp from "node:fs/promises";
import { DEFAULT_RAG_COURSE_CODE, normalizeRagCourseCode, ragCourseMetadata } from "../../services/rag/rag-courses.js";
import { env } from "../../config/env.js";
import { trimText } from "../../services/shared/text-utils.js";
import { contentHash, mapRagSourceRow, seedEntryText } from "../rag-rows.js";
import type { RagSourceRow } from "../rag-rows.js";
import { buildRagChunksForSource } from "../../services/rag/rag-chunks.js";
import { resolveExamPreset } from "../../services/exam/exam-preset.js";
import { SeedDemoRoutesDatabase } from "./seed-demo-routes.js";

export class SeedRagExamDatabase extends SeedDemoRoutesDatabase {
  /**
   * Examen del 28-10-2026 (src/services/exam/exam-preset.ts): fija una vez el tema «Sistema bancario»
   * del docente de las cuentas nuevas. Si falla no detiene el arranque. Publico para las pruebas.
   */
  async syncExamPreset(preset = resolveExamPreset(), options: { force?: boolean } = {}) {
    if (!preset) return null;
    // Solo en la base real (produccion): con pg-mem (pruebas y npm run dev sin DATABASE_URL) no se
    // fija nada salvo que la prueba lo pida.
    if (this.provider !== "postgres" && !options.force) return null;
    await this.ensureExamWithTutorForAll(preset);
    try {
      const done = await this.pool.query<{ setting_value: string }>(
        `select setting_value from app_settings where setting_key = $1`,
        [preset.settingKey],
      );
      if (done.rows.length) return null;
      const teacherUserId = await this.getDefaultTeacherId();
      if (!teacherUserId) {
        console.info("[examen] no hay docente de las cuentas nuevas: el tema del Sistema bancario no se fijo.");
        return null;
      }
      const topic = await this.setPilotTopic(teacherUserId, preset.topic, "");
      await this.pool.query(
        `insert into app_settings (setting_key, setting_value, updated_at) values ($1, $2, now())
         on conflict (setting_key) do update set setting_value = excluded.setting_value, updated_at = now()`,
        [preset.settingKey, teacherUserId],
      );
      console.info(`[examen] tema fijado para el docente de las cuentas nuevas: semana ${preset.topic.week}, ${preset.topic.repoFullName}.`);
      return topic;
    } catch (error) {
      console.warn(`[examen] no se pudo fijar el tema del Sistema bancario: ${String(error)}`);
      return null;
    }
  }

  /**
   * El examen es calificable: nadie lo hace sin tutor. Si el docente de las cuentas nuevas tiene un
   * bloque del piloto activo (1 o 2: una cohorte sin tutor), pasa una vez a 0 (todos con tutor) y
   * queda en pilot_block_log como «examen-2026-10-28». Despues el docente lo puede cambiar.
   */
  private async ensureExamWithTutorForAll(preset: NonNullable<ReturnType<typeof resolveExamPreset>>) {
    try {
      const done = await this.pool.query<{ setting_value: string }>(
        `select setting_value from app_settings where setting_key = $1`,
        [preset.blockSettingKey],
      );
      if (done.rows.length) return;
      const teacherUserId = await this.getDefaultTeacherId();
      if (!teacherUserId) return;
      const current = await this.getPilotBlock(teacherUserId);
      if (current.block !== 0) {
        await this.setPilotBlock(teacherUserId, 0, "examen-2026-10-28");
        console.info(`[examen] bloque del piloto ${current.block} -> 0: todos los estudiantes con tutor durante el examen.`);
      }
      await this.pool.query(
        `insert into app_settings (setting_key, setting_value, updated_at) values ($1, $2, now())
         on conflict (setting_key) do update set setting_value = excluded.setting_value, updated_at = now()`,
        [preset.blockSettingKey, `${teacherUserId}:${current.block}`],
      );
    } catch (error) {
      console.warn(`[examen] no se pudo revisar el bloque del piloto: ${String(error)}`);
    }
  }

  protected async seedDefaultRagSources() {
    const seedPath = path.isAbsolute(env.ragSeedPath)
      ? env.ragSeedPath
      : path.resolve(process.cwd(), env.ragSeedPath);
    const raw = await fsp.readFile(seedPath, "utf8").catch((error: NodeJS.ErrnoException) => {
      if (error.code !== "ENOENT") {
        console.warn(`[rag] No se pudo leer seed default ${seedPath}: ${String(error)}`);
      }
      return "";
    });
    if (!trimText(raw)) return;

    const lines = raw
      .split(/\r?\n/)
      .map((line) => trimText(line))
      .filter(Boolean);

    for (const line of lines) {
      let entry: Record<string, unknown>;
      try {
        entry = JSON.parse(line) as Record<string, unknown>;
      } catch {
        continue;
      }

      const sourceKey = trimText(String(entry.id ?? "")) || `seed-${contentHash(line).slice(0, 16)}`;
      const title = trimText(String(entry.title ?? "")) || sourceKey;
      const sourceType = trimText(String(entry.type ?? entry.source_type ?? "seed"));
      const fileName = trimText(String(entry.suggested_name ?? entry.path ?? title));
      const contentText = seedEntryText(entry);
      const courseCode = normalizeRagCourseCode(
        String(entry.courseCode ?? entry.course_code ?? entry.course ?? DEFAULT_RAG_COURSE_CODE),
      );
      const metadata = {
        ...entry,
        ...ragCourseMetadata(courseCode),
        seeded_from: env.ragSeedPath,
      };

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
          'default',
          null,
          $2,
          $3,
          $4,
          $5,
          '',
          $6,
          $7,
          $8::jsonb,
          true,
          null,
          now(),
          now()
        )
        on conflict (id) do update
        set
          scope = 'default',
          teacher_user_id = null,
          source_key = excluded.source_key,
          title = excluded.title,
          source_type = excluded.source_type,
          file_name = excluded.file_name,
          content_sha256 = excluded.content_sha256,
          content_text = excluded.content_text,
          metadata = excluded.metadata,
          is_active = true,
          updated_at = now()
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
          sourceKey,
          sourceKey,
          title.slice(0, 260),
          sourceType.slice(0, 80) || "seed",
          fileName.slice(0, 500),
          contentHash(contentText),
          contentText,
          JSON.stringify(metadata),
        ],
      );
      const source = result.rows[0] ? mapRagSourceRow(result.rows[0]) : null;
      if (source) {
        await this.replaceRagSourceChunks(source, buildRagChunksForSource({
          title: source.title,
          sourceType: source.sourceType,
          fileName: source.fileName,
          sourceKey: source.sourceKey,
          contentText: source.contentText,
          metadata: source.metadata,
        }));
      }
    }
  }
}

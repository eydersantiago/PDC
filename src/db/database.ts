// Base de datos: AppDatabase (arranque, esquema y datos iniciales) y createDatabase().
// Los metodos de cada dominio estan en src/db/repos/*.ts, en una cadena de clases que termina aqui:
// DatabaseCore -> AuthDatabase -> UsersDatabase -> PolicyDatabase -> RagLotsDatabase -> RagSourcesDatabase -> GithubDatabase -> WorkspaceDatabase -> PilotDatabase -> TelemetryDatabase -> ProgressDatabase -> QuizDatabase -> AppDatabase.
// Tipos y mapeadores de filas: src/db/rows.ts, quiz-rows.ts y telemetry-rows.ts (se reexportan los que exportaba este archivo).
import path from "node:path";
import fsp from "node:fs/promises";
import { Pool } from "pg";
import { newDb } from "pg-mem";
import { schemaStatements } from "./schema.js";
import { seedRoles, seedTeacherPolicy, seedUsers } from "./seeds.js";
import { DEFAULT_RAG_COURSE_CODE, normalizeRagCourseCode, ragCourseMetadata } from "../services/rag-courses.js";
import { env } from "../config/env.js";
import { trimText } from "../services/text-utils.js";
import { contentHash, mapRagSourceRow, seedEntryText } from "./rows.js";
import type { RagSourceRow } from "./rows.js";
import { buildRagChunksForSource } from "../services/rag-sources.js";
import { QuizDatabase } from "./repos/quiz.js";

export type { CreateSessionOptions } from "./rows.js";
export type { PrivacyAcceptance } from "./rows.js";
export type { TelemetryEventDbRow } from "./telemetry-rows.js";
export { mapTelemetryEventRow } from "./telemetry-rows.js";

export class AppDatabase extends QuizDatabase {
  async initialize() {
    for (const statement of schemaStatements) {
      await this.pool.query(statement);
    }

    await this.seed();
  }

  // Sin transaccion: cada sentencia es idempotente (on conflict), asi que un arranque que se
  // corte a mitad se completa en el siguiente. Antes iba entre pool.query("begin") y
  // pool.query("commit"), que no es una transaccion real con un pool (A12.12).
  private async seed() {
    for (const role of seedRoles) {
      await this.pool.query(
        `
        insert into roles (id, code, name)
        values ($1, $2, $3)
        on conflict (id) do nothing
        `,
        [role.id, role.code, role.name],
      );
    }

    for (const user of seedUsers) {
      await this.pool.query(
        `
        insert into users (id, role_id, teacher_user_id, email, display_name, password_hash)
        values ($1, $2, $3, $4, $5, $6)
        on conflict (id) do nothing
        `,
        [
          user.id,
          user.roleId,
          user.teacherUserId,
          user.email,
          user.displayName,
          user.passwordHash,
        ],
      );
    }
    await this.setUserCourseAssignments("user-student-demo", [DEFAULT_RAG_COURSE_CODE], "user-teacher-demo");

    await this.pool.query(
      `
      insert into teacher_policies (
        id,
        teacher_user_id,
        policy_name,
        outcome,
        tone,
        frequency,
        help_level,
        allow_mini_quiz,
        strict_no_solution,
        max_hints_per_exercise,
        fallback_message,
        custom_instruction,
        allowed_interventions,
        allowed_topics,
        event_rules
      )
      values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13::jsonb, $14::jsonb, $15::jsonb)
      on conflict (teacher_user_id) do nothing
      `,
      [
        seedTeacherPolicy.id,
        seedTeacherPolicy.teacherUserId,
        seedTeacherPolicy.policyName,
        seedTeacherPolicy.outcome,
        seedTeacherPolicy.tone,
        seedTeacherPolicy.frequency,
        seedTeacherPolicy.helpLevel,
        seedTeacherPolicy.allowMiniQuiz,
        seedTeacherPolicy.strictNoSolution,
        seedTeacherPolicy.maxHintsPerExercise,
        seedTeacherPolicy.fallbackMessage,
        seedTeacherPolicy.customInstruction,
        JSON.stringify(seedTeacherPolicy.allowedInterventions),
        JSON.stringify(seedTeacherPolicy.allowedTopics),
        JSON.stringify(seedTeacherPolicy.eventRules),
      ],
    );

    await this.seedDefaultRagSources();
  }

  private async seedDefaultRagSources() {
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

export async function createDatabase() {
  if (env.databaseUrl) {
    const pool = new Pool({
      connectionString: env.databaseUrl,
      ssl: env.databaseSslMode === "require"
        ? { rejectUnauthorized: false }
        : undefined,
    });

    const database = new AppDatabase(pool, "postgres");
    await database.initialize();
    return database;
  }

  const inMemoryDb = newDb({
    autoCreateForeignKeyIndices: true,
  });
  const adapter = inMemoryDb.adapters.createPg();
  const pool = new adapter.Pool() as Pool;
  const database = new AppDatabase(pool, "memory-postgres");
  await database.initialize();
  return database;
}

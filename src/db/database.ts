// Base de datos: AppDatabase (arranque, esquema y datos iniciales) y createDatabase().
// Los metodos de cada dominio estan en src/db/repos/*.ts, en una cadena de clases que termina aqui:
// DatabaseCore -> AuthDatabase -> StudentSignInDatabase -> AuthSessionsDatabase -> UsersDatabase -> StudentAccessDatabase -> ManagedUsersDatabase -> CourseMembersDatabase -> PolicyDatabase -> RagLotsDatabase -> RagSourcesDatabase -> RagSourcesWriteDatabase -> GithubDatabase -> GithubTokensDatabase -> WorkspaceDatabase -> PilotDatabase -> TelemetryDatabase -> BehaviorEventsDatabase -> ProgressDatabase -> QuizDatabase -> AnalyticsDatabase -> SeedAccountsDatabase -> SeedDemoRoutesDatabase -> SeedRagExamDatabase -> AppDatabase.
// Tipos y mapeadores de filas: src/db/rows.ts, quiz-rows.ts y telemetry-rows.ts (se reexportan los que exportaba este archivo).
import { Pool } from "pg";
import { newDb } from "pg-mem";
import { schemaStatements } from "./schema.js";
import { seedRoles } from "./seeds.js";
import { env } from "../config/env.js";
import { syncAnalyticsExclusions } from "../services/analytics/learning-analytics.js";
import { SeedRagExamDatabase } from "./repos/seed-rag-exam.js";

export type { CreateSessionOptions } from "./rows.js";
export type { PrivacyAcceptance } from "./rows.js";
export type { TelemetryEventDbRow } from "./telemetry-rows.js";
export { mapTelemetryEventRow } from "./telemetry-rows.js";

export class AppDatabase extends SeedRagExamDatabase {
  async initialize() {
    for (const statement of schemaStatements) {
      await this.pool.query(statement);
    }

    await this.seed();
    // Las cuentas de muestra quedan fuera de las vistas de analisis (deploy/bi/vistas-bi.sql).
    await syncAnalyticsExclusions(this, env.analyticsExcludeEmails).catch((error) => {
      console.warn("[analitica] no se actualizaron las cuentas fuera del analisis:", error instanceof Error ? error.message : error);
    });
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

    await this.syncConfiguredAdmins();
    await this.syncDemoAccounts();
    await this.seedPersistentUsers();
    await this.syncTestAccounts();
    await this.syncDemoRouteAccounts();
    await this.seedDefaultRagSources();
    await this.syncExamPreset();
    // 0.7.22: un estudiante no entra sin codigo; las sesiones de antes vuelven a pedirlo.
    const closed = await this.closeSessionsOfStudentsWithoutCode();
    if (closed > 0) {
      console.info(`[codigo de estudiante] se cerraron ${closed} sesiones de estudiantes sin codigo: lo escriben al volver a entrar.`);
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


// Base de datos: AppDatabase (arranque, esquema y datos iniciales) y createDatabase().
// Los metodos de cada dominio estan en src/db/repos/*.ts, en una cadena de clases que termina aqui:
// DatabaseCore -> AuthDatabase -> UsersDatabase -> PolicyDatabase -> RagLotsDatabase -> RagSourcesDatabase -> GithubDatabase -> WorkspaceDatabase -> PilotDatabase -> TelemetryDatabase -> ProgressDatabase -> QuizDatabase -> AnalyticsDatabase -> AppDatabase.
// Tipos y mapeadores de filas: src/db/rows.ts, quiz-rows.ts y telemetry-rows.ts (se reexportan los que exportaba este archivo).
import path from "node:path";
import fsp from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { Pool } from "pg";
import { newDb } from "pg-mem";
import { schemaStatements } from "./schema.js";
import { PERSISTENT_TEACHER, seedRoles, seedTeacherPolicy, seedUsers } from "./seeds.js";
import { DEFAULT_RAG_COURSE_CODE, normalizeRagCourseCode, ragCourseMetadata } from "../services/rag-courses.js";
import { env } from "../config/env.js";
import { trimText } from "../services/text-utils.js";
import { contentHash, hashPassword, mapRagSourceRow, seedEntryText } from "./rows.js";
import type { RagSourceRow } from "./rows.js";
import { buildRagChunksForSource } from "../services/rag-sources.js";
import { resolveExamPreset } from "../services/exam-preset.js";
import { DEMO_ADMIN_KEPT_WARNING, DEMO_STUDENT_CODE, deactivateDemoAccounts } from "../services/demo-accounts.js";
import { describeConfiguredAdmins } from "../services/configured-admins.js";
import {
  TEST_ACCOUNTS,
  type TestAccount,
  deactivateTestAccounts,
  isTestAccountId,
  testAccountsPasswordProblem,
  testTeacherTopic,
} from "../services/test-accounts.js";
import {
  DEMO_ROUTE_ACCOUNTS,
  DEMO_ROUTES_BITACORA_DIR,
  DEMO_ROUTES_LOG,
  type DemoRouteAccount,
  deactivateDemoRouteAccounts,
  demoRouteFor,
  demoRouteTopic,
  demoRoutesExpired,
  demoRoutesPasswordProblem,
  demoRoutesUntil,
  isDemoRouteAccountId,
} from "../services/demo-route-accounts.js";
import { parseBitacoraTemplateUpload } from "../services/bitacora-import.js";
import { AnalyticsDatabase } from "./repos/analytics.js";
import { syncAnalyticsExclusions } from "../services/learning-analytics.js";

export type { CreateSessionOptions } from "./rows.js";
export type { PrivacyAcceptance } from "./rows.js";
export type { TelemetryEventDbRow } from "./telemetry-rows.js";
export { mapTelemetryEventRow } from "./telemetry-rows.js";

export class AppDatabase extends AnalyticsDatabase {
  async initialize() {
    for (const statement of schemaStatements) {
      await this.pool.query(statement);
    }

    await this.seed();
    // Las cuentas de muestra quedan fuera de las vistas de analisis (deploy/bi/vistas-bi.sql).
    await syncAnalyticsExclusions(this).catch((error) => {
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

  /**
   * ADACEEN_ADMIN_EMAILS: pasa a administrador las cuentas activas de esos correos
   * (src/services/configured-admins.ts). Va antes de syncDemoAccounts() para que el mismo
   * arranque desactive al administrador demo. Publico para que las pruebas simulen un reinicio.
   */
  async syncConfiguredAdmins(emails: readonly string[] = env.adminEmails) {
    if (!emails.length) return;
    const report = await this.promoteConfiguredAdmins(emails, { googleDefaultPassword: env.googleDefaultPassword });
    const { info, warn } = describeConfiguredAdmins(report);
    for (const line of info) console.info(line);
    for (const line of warn) console.warn(line);
  }

  /**
   * Lo que hace cada arranque con las cuentas demo: con SEED_DEMO_ACCOUNTS=true (desarrollo y
   * pruebas) las siembra con su politica; con false (produccion) no las siembra y desactiva
   * las que queden de antes. Publico para que las pruebas simulen un reinicio sobre la misma
   * base (pg-mem no deja volver a correr el esquema).
   */
  async syncDemoAccounts() {
    if (env.seedDemoAccounts) {
      await this.seedDemoAccounts();
    } else {
      await this.closeDemoAccounts();
    }
  }

  // Docente real (no demo) que entra por correo+contrasena sin Google (opcion B). Solo se siembra
  // si VICTOR_SEED_PASSWORD esta definida (en desarrollo y en produccion); sin ella no hace nada,
  // asi las pruebas y las bases sin la variable no cambian. Va despues de las cuentas demo para no
  // quedar como "el docente activo mas antiguo" de una base nueva. Un fallo (p. ej. choque de
  // correo) solo avisa y no tumba el arranque.
  private async seedPersistentUsers() {
    const password = env.victorSeedPassword.trim();
    if (!password) return;
    try {
      await this.pool.query(
        `
        insert into users (id, role_id, teacher_user_id, email, display_name, password_hash)
        values ($1, $2, $3, $4, $5, $6)
        on conflict (id) do update set
          role_id = excluded.role_id,
          display_name = excluded.display_name,
          password_hash = excluded.password_hash,
          is_active = true
        `,
        [
          PERSISTENT_TEACHER.id,
          PERSISTENT_TEACHER.roleId,
          PERSISTENT_TEACHER.teacherUserId,
          PERSISTENT_TEACHER.email,
          PERSISTENT_TEACHER.displayName,
          hashPassword(password),
        ],
      );
    } catch (error) {
      console.warn(`[cuenta-victor] No se pudo sembrar ${PERSISTENT_TEACHER.email}: ${String(error)}`);
    }
  }

  /**
   * Cuentas de prueba por rol (src/services/test-accounts.ts). Con TEST_ACCOUNTS_PASSWORD (12
   * caracteres o mas) cada arranque las deja como el escenario: activas, con esa clave, su rol, su
   * docente de prueba, su codigo de estudiante, el curso por defecto y el tema del piloto de los
   * dos docentes. La politica de cada docente de prueba se crea una sola vez, copiada de la del
   * docente del curso (el de las cuentas nuevas), asi lo que se cambie despues se conserva. Sin la
   * variable no se siembran y las que existan se desactivan. Va despues de las cuentas demo y de
   * Victor para no quedar como "el docente activo mas antiguo" de una base nueva. Publico para que
   * las pruebas simulen un reinicio. Un fallo solo avisa y no tumba el arranque.
   */
  async syncTestAccounts() {
    const password = env.testAccountsPassword;
    const problem = testAccountsPasswordProblem(password);
    try {
      if (problem) console.warn(problem);
      if (password && !problem) {
        await this.seedTestAccounts(password);
        return;
      }
      const result = await deactivateTestAccounts(this.pool);
      if (result.deactivated.length) {
        console.info(`[cuentas-prueba] Sin TEST_ACCOUNTS_PASSWORD: cuentas de prueba desactivadas al arrancar: ${result.deactivated.join(", ")}.`);
      }
      if (result.adminKept) {
        console.warn("[cuentas-prueba] prueba.admin@adaceen.edu.co sigue activa: es el unico administrador activo. Pon tu correo en ADACEEN_ADMIN_EMAILS y reinicia.");
      }
    } catch (error) {
      console.warn(`[cuentas-prueba] No se pudieron sincronizar las cuentas de prueba: ${String(error)}`);
    }
  }

  private async seedTestAccounts(password: string) {
    // El docente del curso se busca antes de crear a los de prueba (de el salen el tema y la
    // politica) y nunca es uno de prueba.
    const defaultTeacherId = await this.getDefaultTeacherId();
    const courseTeacherId = defaultTeacherId && !isTestAccountId(defaultTeacherId) && !isDemoRouteAccountId(defaultTeacherId)
      ? defaultTeacherId
      : "";
    const ready: TestAccount[] = [];
    const problems: string[] = [];
    for (const account of TEST_ACCOUNTS) {
      if (account.teacherId && !ready.some((item) => item.id === account.teacherId)) {
        problems.push(`${account.email} no se sembro porque su docente de prueba no se pudo sembrar`);
        continue;
      }
      try {
        await this.pool.query(
          `
          insert into users (id, role_id, teacher_user_id, email, display_name, password_hash)
          values ($1, $2, $3, $4, $5, $6)
          on conflict (id) do update set
            role_id = excluded.role_id,
            teacher_user_id = excluded.teacher_user_id,
            display_name = excluded.display_name,
            password_hash = excluded.password_hash,
            is_active = true
          `,
          [account.id, `role-${account.role}`, account.teacherId ?? null, account.email, account.displayName, hashPassword(password)],
        );
        ready.push(account);
      } catch (error) {
        // Casi siempre el correo: ya es de otra cuenta (users.email es unico).
        problems.push(`${account.email} no se sembro: ${String(error)}`);
      }
    }

    for (const account of ready) {
      if (account.role !== "student") continue;
      await this.setUserCourseAssignments(account.id, [DEFAULT_RAG_COURSE_CODE], account.teacherId ?? null);
      if (account.studentCode && !(await this.insertStudentCode(account.studentCode, account.id, null))) {
        problems.push(`${account.email}: el codigo ${account.studentCode} ya es de otra cuenta o la cuenta ya tiene otro; el login lo pedira`);
      }
    }

    const courseTopic = courseTeacherId ? await this.getPilotTopic(courseTeacherId) : null;
    const coursePolicy = courseTeacherId
      ? await this.getTeacherPolicyForUser({ id: courseTeacherId, role: "teacher", email: "", displayName: "", teacherUserId: null })
      : null;
    const repos: string[] = [];
    for (const account of ready) {
      if (account.role !== "teacher" || !account.topic) continue;
      const existing = await this.pool.query<{ id: string }>(
        `select id from teacher_policies where teacher_user_id = $1 limit 1`,
        [account.id],
      );
      if (!existing.rows[0]) {
        await this.ensureTeacherPolicyExists(account.id);
        if (coursePolicy) await this.updateTeacherPolicy(account.id, coursePolicy);
      }
      const { topic, warning } = testTeacherTopic(account.topic, courseTopic, {
        ownRepo: env.testAccountsOwnRepo,
        courseRepo: env.testAccountsCourseRepo,
      });
      if (warning) problems.push(warning);
      await this.setPilotTopic(account.id, topic, "");
      repos.push(`${account.email} → ${topic.repoFullName}`);
    }

    console.info(
      `[cuentas-prueba] ${ready.length} cuentas de prueba activas con la clave de TEST_ACCOUNTS_PASSWORD: ${ready.map((item) => item.email).join(", ")}. Temas: ${repos.join("; ")}.`,
    );
    for (const problem of problems) console.warn(problem.startsWith("[cuentas-prueba]") ? problem : `[cuentas-prueba] ${problem}.`);
  }

  /**
   * Cuentas demo por ruta (src/services/demo-route-accounts.ts). Con DEMO_RUTAS_PASSWORD (12
   * caracteres o mas) y hasta el dia de DEMO_RUTAS_HASTA, cada arranque deja activos un docente
   * demo por ruta y sus tres estudiantes con esa clave, su codigo, el curso por defecto y el tema
   * de la ruta. Una sola vez por docente: la politica del docente del curso, la bitacora de la ruta
   * y una copia de las fuentes del RAG que subio el docente del curso (lo que se cambie despues se
   * conserva). Sin la variable, con clave corta o vencidas, se desactivan con sus sesiones. Va
   * despues de las cuentas de prueba. Publico para que las pruebas simulen un reinicio. Un fallo
   * solo avisa y no tumba el arranque.
   */
  async syncDemoRouteAccounts(now: Date = new Date()) {
    const password = env.demoRoutesPassword;
    const problem = demoRoutesPasswordProblem(password);
    const { until, warning } = demoRoutesUntil(env.demoRoutesUntil);
    try {
      if (problem) console.warn(problem);
      if (password && !problem) {
        if (warning) console.warn(warning);
        if (!demoRoutesExpired(until, now)) {
          await this.seedDemoRouteAccounts(password, until);
          return;
        }
        console.info(`${DEMO_ROUTES_LOG} Vencieron el ${until} (DEMO_RUTAS_HASTA): no se siembran. Borra DEMO_RUTAS_PASSWORD o cambia la fecha.`);
      }
      const deactivated = await deactivateDemoRouteAccounts(this.pool);
      if (deactivated.length) {
        console.info(`${DEMO_ROUTES_LOG} Cuentas demo por ruta desactivadas al arrancar: ${deactivated.join(", ")}.`);
      }
    } catch (error) {
      console.warn(`${DEMO_ROUTES_LOG} No se pudieron sincronizar las cuentas demo por ruta: ${String(error)}`);
    }
  }

  private async seedDemoRouteAccounts(password: string, until: string) {
    const defaultTeacherId = await this.getDefaultTeacherId();
    const courseTeacherId = defaultTeacherId && !isTestAccountId(defaultTeacherId) && !isDemoRouteAccountId(defaultTeacherId)
      ? defaultTeacherId
      : "";
    const passwordHash = hashPassword(password);
    const ready: DemoRouteAccount[] = [];
    const problems: string[] = [];
    for (const account of DEMO_ROUTE_ACCOUNTS) {
      if (account.teacherId && !ready.some((item) => item.id === account.teacherId)) {
        problems.push(`${account.email} no se sembro porque su docente demo no se pudo sembrar`);
        continue;
      }
      try {
        await this.pool.query(
          `
          insert into users (id, role_id, teacher_user_id, email, display_name, password_hash)
          values ($1, $2, $3, $4, $5, $6)
          on conflict (id) do update set
            role_id = excluded.role_id,
            teacher_user_id = excluded.teacher_user_id,
            display_name = excluded.display_name,
            password_hash = excluded.password_hash,
            is_active = true
          `,
          [account.id, `role-${account.role}`, account.teacherId ?? null, account.email, account.displayName, passwordHash],
        );
        ready.push(account);
      } catch (error) {
        // Casi siempre el correo: ya es de otra cuenta (users.email es unico).
        problems.push(`${account.email} no se sembro: ${String(error)}`);
      }
    }

    for (const account of ready) {
      if (account.role !== "student") continue;
      await this.setUserCourseAssignments(account.id, [DEFAULT_RAG_COURSE_CODE], account.teacherId ?? null);
      if (account.studentCode && !(await this.insertStudentCode(account.studentCode, account.id, null))) {
        problems.push(`${account.email}: el codigo ${account.studentCode} ya es de otra cuenta o la cuenta ya tiene otro; el login lo pedira`);
      }
    }

    const coursePolicy = courseTeacherId
      ? await this.getTeacherPolicyForUser({ id: courseTeacherId, role: "teacher", email: "", displayName: "", teacherUserId: null })
      : null;
    const topics: string[] = [];
    let bitacoras = 0;
    let ragCopied = 0;
    for (const account of ready) {
      if (account.role !== "teacher") continue;
      const route = demoRouteFor(account.routeKey);
      // Cada docente por separado: un fallo en uno no deja a los demas sin bitacora ni RAG.
      try {
        const existing = await this.pool.query<{ id: string }>(
          `select id from teacher_policies where teacher_user_id = $1 limit 1`,
          [account.id],
        );
        if (!existing.rows[0]) {
          await this.ensureTeacherPolicyExists(account.id);
          if (coursePolicy) await this.updateTeacherPolicy(account.id, coursePolicy);
        }
        const { topic, warning } = demoRouteTopic(route, env.demoRoutesOrg);
        if (warning && !problems.includes(warning)) problems.push(warning);
        await this.setPilotTopic(account.id, topic, "");
        topics.push(`${route.key.toUpperCase()} → ${topic.repoFullName} (semana ${topic.week})`);
      } catch (error) {
        problems.push(`${account.email}: no se dejo la politica o el tema de la ruta: ${String(error)}`);
      }
      try {
        if (await this.seedDemoRouteBitacora(account.id, route.bitacoraFile)) bitacoras += 1;
      } catch (error) {
        problems.push(`${account.email}: no se cargo la bitacora ${route.bitacoraFile}: ${String(error)}`);
      }
      try {
        ragCopied += await this.copyCourseRagSourcesTo(account.id, courseTeacherId);
      } catch (error) {
        problems.push(`${account.email}: no se copiaron todas las fuentes del RAG del docente del curso (el arranque siguiente sigue con las que falten): ${String(error)}`);
      }
    }

    console.info(
      `${DEMO_ROUTES_LOG} ${ready.length} cuentas demo por ruta activas hasta el ${until} con la clave de DEMO_RUTAS_PASSWORD. Temas: ${topics.join("; ")}. Bitacoras cargadas en este arranque: ${bitacoras}. Fuentes del RAG copiadas en este arranque: ${ragCopied}${courseTeacherId ? "" : " (no hay docente del curso del que copiarlas)"}.`,
    );
    for (const problem of problems) console.warn(problem.startsWith(DEMO_ROUTES_LOG) ? problem : `${DEMO_ROUTES_LOG} ${problem}.`);
  }

  /**
   * Carga la bitacora de la ruta (data/demo-rutas) si el docente demo no tiene ninguna. Si la
   * cambia o la borra, se respeta lo suyo; sin ninguna, el arranque siguiente la vuelve a cargar.
   * Queda como la importacion de un .xlsx desde el overlay (repo docentes/<id>).
   */
  private async seedDemoRouteBitacora(teacherId: string, fileName: string): Promise<boolean> {
    const current = await this.pool.query<{ id: string }>(
      `select id from project_document_classifications where user_id = $1 and label = 'BITACORA' limit 1`,
      [teacherId],
    );
    if (current.rows[0]) return false;
    const buffer = await fsp.readFile(path.resolve(process.cwd(), DEMO_ROUTES_BITACORA_DIR, fileName));
    const parsed = await parseBitacoraTemplateUpload(buffer);
    if (!parsed.detectedTemplate || !parsed.validation.isValid) {
      throw new Error(`la plantilla no paso la validacion: ${parsed.validation.errors.join("; ") || "no se reconocio"}`);
    }
    const repoFullName = `docentes/${teacherId.replace(/[^a-z0-9-]/gi, "").slice(0, 24)}`;
    await this.pool.query(
      `
      insert into project_document_classifications (
        id, user_id, session_id, repo_full_name, request_id, snapshot_id, file_path, file_name,
        mime_type, extension, label, confidence, method, evidence, reason, extracted_text_preview,
        features, training_example, model_used, model_error, classified_at, updated_at
      )
      values (
        $1, $2, null, $3, $4, $5, $6, $6,
        'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', 'xlsx', 'BITACORA', 0.97, 'rules',
        $7::jsonb, $8, $9, $10::jsonb, $11::jsonb, false, '', now(), now()
      )
      on conflict (repo_full_name, snapshot_id, file_path) do nothing
      `,
      [
        randomUUID(),
        teacherId,
        repoFullName,
        "seed-demo-rutas",
        `seed-demo-rutas-${teacherId}`,
        fileName,
        JSON.stringify([`Bitacora de la ruta cargada al sembrar las cuentas demo por ruta (${parsed.bitacoraAgenda.items.length} registros).`]),
        `Cuentas demo por ruta: ${parsed.bitacoraAgenda.summary}`,
        trimText(parsed.textPreview).slice(0, 2200),
        JSON.stringify({
          source: "seed_demo_rutas",
          bitacoraAgenda: parsed.bitacoraAgenda,
          rowsParsed: parsed.rowsParsed,
          rowsUsed: parsed.rowsUsed,
          detectedTemplate: parsed.detectedTemplate,
          importWarnings: parsed.warnings,
        }),
        JSON.stringify({
          input: { fileName, filePath: fileName, textPreview: trimText(parsed.textPreview).slice(0, 2200) },
          expectedLabel: null,
          predictedLabel: "BITACORA",
        }),
      ],
    );
    return true;
  }

  /**
   * Copia al docente demo las fuentes activas del RAG que subio el docente del curso, con sus
   * fragmentos, mientras el docente demo no tenga fuentes propias (una que no sea copia). Cada
   * arranque completa las que falten (una copia cortada a mitad, o fuentes nuevas del curso) y no
   * vuelve a copiar las que ya tiene, aunque el docente demo las haya apagado. Las copias quedan en
   * la base del docente demo (sin lote) y se copian las fuentes base que el docente del curso apago.
   * Los fragmentos se copian en el servidor, una consulta por fuente, para que el primer arranque
   * no haga una consulta por fragmento. Devuelve cuantas copio.
   */
  private async copyCourseRagSourcesTo(teacherId: string, courseTeacherId: string): Promise<number> {
    if (!courseTeacherId) return 0;
    const existing = await this.pool.query<{ metadata: unknown }>(
      `select metadata from rag_sources where scope = 'teacher' and teacher_user_id = $1`,
      [teacherId],
    );
    const alreadyCopied = new Set<string>();
    for (const row of existing.rows) {
      const from = trimText(String(jsonObject(row.metadata).copiedFromSourceId ?? ""));
      if (!from) return 0; // Tiene fuentes propias: su RAG es suyo.
      alreadyCopied.add(from);
    }

    // Fuentes base que el docente del curso apago (o volvio a prender): las que el docente demo ya
    // decidio no se tocan.
    const overrides = await this.pool.query<{ source_id: string; is_active: boolean }>(
      `select source_id, is_active from rag_source_overrides where teacher_user_id = $1`,
      [courseTeacherId],
    );
    if (overrides.rows.length) {
      const defaults = await this.pool.query<{ id: string }>(`select id from rag_sources where scope = 'default'`);
      const defaultIds = new Set(defaults.rows.map((row) => row.id));
      for (const override of overrides.rows) {
        if (!defaultIds.has(override.source_id)) continue;
        await this.pool.query(
          `
          insert into rag_source_overrides (teacher_user_id, source_id, is_active, updated_at)
          values ($1, $2, $3, now())
          on conflict (teacher_user_id, source_id) do nothing
          `,
          [teacherId, override.source_id, override.is_active],
        );
      }
    }

    const sources = await this.pool.query<{
      id: string;
      source_key: string;
      title: string;
      source_type: string;
      file_name: string;
      mime_type: string;
      content_sha256: string;
      content_text: string;
      metadata: unknown;
    }>(
      `
      select id, source_key, title, source_type, file_name, mime_type, content_sha256, content_text, metadata
      from rag_sources
      where scope = 'teacher' and teacher_user_id = $1 and is_active = true
      order by created_at asc
      `,
      [courseTeacherId],
    );
    let copied = 0;
    for (const source of sources.rows) {
      if (alreadyCopied.has(source.id)) continue;
      const metadata: Record<string, unknown> = {
        ...jsonObject(source.metadata),
        copiedFromSourceId: source.id,
        copiedFor: "cuentas-demo-rutas",
      };
      // Los lotes son del docente del curso: en el docente demo la copia va a su base.
      delete metadata.lotId;
      delete metadata.lot_id;
      const copyId = randomUUID();
      const inserted = await this.pool.query<RagSourceRow>(
        `
        insert into rag_sources (
          id, scope, teacher_user_id, source_key, title, source_type, file_name, mime_type,
          content_sha256, content_text, metadata, is_active, created_by_user_id, created_at, updated_at
        )
        values ($1, 'teacher', $2, $3, $4, $5, $6, $7, $8, $9, $10::jsonb, true, $2, now(), now())
        returning
          id, scope, teacher_user_id, source_key, title, source_type, file_name, mime_type,
          content_sha256, content_text, metadata, is_active, created_by_user_id, created_at, updated_at
        `,
        [
          copyId,
          teacherId,
          source.source_key,
          source.title,
          source.source_type,
          source.file_name,
          source.mime_type,
          source.content_sha256,
          source.content_text,
          JSON.stringify(metadata),
        ],
      );
      try {
        const chunks = await this.pool.query(
          `
          insert into rag_source_chunks (
            id, source_id, chunk_index, content_text, search_text, token_count, char_start, char_end,
            page_start, page_end, citation_label, metadata, created_at
          )
          select $2 || ':chunk:' || cast(chunk_index as text), $2, chunk_index, content_text, search_text,
            token_count, char_start, char_end, page_start, page_end, citation_label, metadata, now()
          from rag_source_chunks
          where source_id = $1
          `,
          [source.id, copyId],
        );
        // Sin fragmentos en el original (raro): se arman desde el texto, como al subir la fuente.
        if (!chunks.rowCount && inserted.rows[0]) {
          await this.replaceRagSourceChunks(mapRagSourceRow(inserted.rows[0]));
        }
      } catch (error) {
        // Sin sus fragmentos la copia no sirve: se quita y el arranque siguiente la vuelve a intentar.
        await this.pool.query(`delete from rag_sources where id = $1`, [copyId]);
        throw error;
      }
      copied += 1;
    }
    return copied;
  }

  private async seedDemoAccounts() {
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
    // El estudiante demo ya tiene codigo (0.7.22): entra con correo y clave como antes.
    await this.insertStudentCode(DEMO_STUDENT_CODE, "user-student-demo", null);

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
  }

  // SEED_DEMO_ACCOUNTS=false: las cuentas demo que existan dejan de entrar (src/services/demo-accounts.ts).
  // El administrador demo se queda si es el unico administrador activo, y se avisa en consola.
  private async closeDemoAccounts() {
    const result = await deactivateDemoAccounts(this.pool);
    if (result.deactivated.length) {
      console.info(`[cuentas-demo] SEED_DEMO_ACCOUNTS=false: cuentas demo desactivadas al arrancar: ${result.deactivated.join(", ")}.`);
    }
    if (result.adminKept) {
      console.warn(DEMO_ADMIN_KEPT_WARNING);
    }
  }

  /**
   * Examen del 28-10-2026 (src/services/exam-preset.ts): fija una vez el tema «Sistema bancario»
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

/** Objeto de una columna jsonb (pg la entrega como objeto; pg-mem a veces como texto). */
function jsonObject(value: unknown): Record<string, unknown> {
  if (value && typeof value === "object" && !Array.isArray(value)) return value as Record<string, unknown>;
  if (typeof value === "string" && value.trim()) {
    try {
      const parsed = JSON.parse(value);
      return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {};
    } catch {
      return {};
    }
  }
  return {};
}

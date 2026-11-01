// AppDatabase, arranque: cuentas demo por ruta, con su bitacora y la copia de las fuentes RAG del curso.
// Metodos movidos sin cambios desde src/db/database.ts; la clase va entre SeedAccountsDatabase y SeedRagExamDatabase.
import path from "node:path";
import fsp from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { DEFAULT_RAG_COURSE_CODE } from "../../services/rag/rag-courses.js";
import { env } from "../../config/env.js";
import { trimText } from "../../services/shared/text-utils.js";
import { hashPassword } from "../rows.js";
import { mapRagSourceRow } from "../rag-rows.js";
import type { RagSourceRow } from "../rag-rows.js";
import { isTestAccountId } from "../../services/accounts/test-accounts.js";
import { DEMO_ROUTE_ACCOUNTS, DEMO_ROUTES_BITACORA_DIR, DEMO_ROUTES_LOG, type DemoRouteAccount, deactivateDemoRouteAccounts, demoRouteFor, demoRouteTopic, demoRoutesExpired, demoRoutesPasswordProblem, demoRoutesUntil, isDemoRouteAccountId } from "../../services/accounts/demo-route-accounts.js";
import { parseBitacoraTemplateUpload } from "../../services/bitacora/bitacora-import.js";
import { jsonObject } from "../rows.js";
import { SeedAccountsDatabase } from "./seed-accounts.js";

export class SeedDemoRoutesDatabase extends SeedAccountsDatabase {
  /**
   * Cuentas demo por ruta (src/services/accounts/demo-route-accounts.ts). Con DEMO_RUTAS_PASSWORD (12
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
}

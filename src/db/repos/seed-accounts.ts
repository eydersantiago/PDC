// AppDatabase, arranque: administradores configurados, cuentas demo, docente persistente y cuentas de prueba.
// Metodos movidos sin cambios desde src/db/database.ts; la clase va entre AnalyticsDatabase y SeedDemoRoutesDatabase.
import { PERSISTENT_TEACHER, seedTeacherPolicy, seedUsers } from "../seeds.js";
import { DEFAULT_RAG_COURSE_CODE } from "../../services/rag/rag-courses.js";
import { env } from "../../config/env.js";
import { hashPassword } from "../rows.js";
import { DEMO_ADMIN_KEPT_WARNING, DEMO_STUDENT_CODE, deactivateDemoAccounts } from "../../services/accounts/demo-accounts.js";
import { describeConfiguredAdmins } from "../../services/auth/configured-admins.js";
import { TEST_ACCOUNTS, type TestAccount, deactivateTestAccounts, isTestAccountId, testAccountsPasswordProblem, testTeacherTopic } from "../../services/accounts/test-accounts.js";
import { isDemoRouteAccountId } from "../../services/accounts/demo-route-accounts.js";
import { AnalyticsDatabase } from "./analytics.js";

export class SeedAccountsDatabase extends AnalyticsDatabase {
  /**
   * ADACEEN_ADMIN_EMAILS: pasa a administrador las cuentas activas de esos correos
   * (src/services/auth/configured-admins.ts). Va antes de syncDemoAccounts() para que el mismo
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
  protected async seedPersistentUsers() {
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
   * Cuentas de prueba por rol (src/services/accounts/test-accounts.ts). Con TEST_ACCOUNTS_PASSWORD (12
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

  // SEED_DEMO_ACCOUNTS=false: las cuentas demo que existan dejan de entrar (src/services/accounts/demo-accounts.ts).
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
}

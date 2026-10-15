// Cuentas de prueba por rol (TEST_ACCOUNTS_PASSWORD) para probar ADACEEN de punta a punta,
// tambien en produccion, sin tocar el grupo real del curso: un administrador, dos docentes y tres
// estudiantes con correo y contrasena (sin Google). Cada uno conecta su cuenta de GitHub con
// «Conectar GitHub» y abre en el editor por tunel su repositorio o el del curso.
//
// - Docente de prueba (curso): E1 y E2 son suyos y su tema del piloto es el repositorio del curso
//   (el del docente de las cuentas nuevas, o TEST_ACCOUNTS_COURSE_REPO). Con dos estudiantes
//   sirve para los bloques con y sin tutor.
// - Docente de prueba 2 (mi repo): E3 es suyo y su tema es TEST_ACCOUNTS_OWN_REPO. Tambien sirve
//   para ver que un docente no ve a los estudiantes de otro.
//
// src/db/database.ts (AppDatabase.syncTestAccounts) las siembra en cada arranque con la clave de
// la variable. Sin la variable (o con una clave corta) no se siembran y, si existen, se
// desactivan. scripts/piloto-dataset.ts las excluye del dataset del piloto.

import { normalizePilotTopicRepo, type PilotTopic, type PilotTopicInput } from "./pilot-topic.js";
import { DEFAULT_RAG_COURSE_CODE } from "./rag-courses.js";

export const TEST_ACCOUNTS_MIN_PASSWORD = 12;

/** Repositorios por defecto de los temas (cuando no hay variable ni tema del curso que copiar). */
export const TEST_ACCOUNTS_DEFAULT_COURSE_REPO = "vbucheli/Nutricion";
export const TEST_ACCOUNTS_DEFAULT_OWN_REPO = "eydersantiago/FadaProyecto";

export type TestAccountTopic = "course" | "own";

export type TestAccount = {
  id: string;
  role: "admin" | "teacher" | "student";
  email: string;
  displayName: string;
  /** Docente de prueba del estudiante (id de esta misma lista). */
  teacherId?: string;
  /** Codigo de estudiante (0.7.22): con el, el login no lo pide. */
  studentCode?: string;
  /** Tema del piloto del docente: el repositorio del curso o el propio. */
  topic?: TestAccountTopic;
};

// En este orden: los docentes van antes que sus estudiantes (teacher_user_id).
export const TEST_ACCOUNTS: readonly TestAccount[] = Object.freeze([
  { id: "user-test-admin", role: "admin", email: "prueba.admin@adaceen.edu.co", displayName: "Prueba Administrador" },
  { id: "user-test-teacher-course", role: "teacher", email: "prueba.docente@adaceen.edu.co", displayName: "Prueba Docente (curso)", topic: "course" },
  { id: "user-test-teacher-own", role: "teacher", email: "prueba.docente2@adaceen.edu.co", displayName: "Prueba Docente 2 (mi repo)", topic: "own" },
  { id: "user-test-student-1", role: "student", email: "prueba.e1@adaceen.edu.co", displayName: "Prueba Estudiante 1 (curso)", teacherId: "user-test-teacher-course", studentCode: "0000011" },
  { id: "user-test-student-2", role: "student", email: "prueba.e2@adaceen.edu.co", displayName: "Prueba Estudiante 2 (curso)", teacherId: "user-test-teacher-course", studentCode: "0000012" },
  { id: "user-test-student-3", role: "student", email: "prueba.e3@adaceen.edu.co", displayName: "Prueba Estudiante 3 (mi repo)", teacherId: "user-test-teacher-own", studentCode: "0000013" },
]);

export const TEST_ACCOUNT_IDS: readonly string[] = TEST_ACCOUNTS.map((account) => account.id);
export const TEST_ACCOUNT_EMAILS: readonly string[] = TEST_ACCOUNTS.map((account) => account.email);

export function isTestAccountId(id: string | null | undefined) {
  return Boolean(id) && TEST_ACCOUNT_IDS.includes(String(id));
}

/** Por que no se siembran con esa clave ("" si sirve). */
export function testAccountsPasswordProblem(password: string) {
  if (!password) return "";
  if (password.length < TEST_ACCOUNTS_MIN_PASSWORD) {
    return `[cuentas-prueba] TEST_ACCOUNTS_PASSWORD tiene menos de ${TEST_ACCOUNTS_MIN_PASSWORD} caracteres: no se siembran (una es administradora y ve a todos los estudiantes). Pon una clave mas larga y reinicia.`;
  }
  return "";
}

export const TEST_TOPIC_TITLES = {
  course: "Repositorio del curso (cuenta de prueba)",
  own: "Mi repositorio (cuenta de prueba)",
} as const;

/**
 * Tema del piloto de un docente de prueba. "course": TEST_ACCOUNTS_COURSE_REPO si tiene valor; si
 * no, el tema del docente del curso tal cual (semana, titulo y repositorio); si tampoco, el
 * repositorio por defecto. "own": TEST_ACCOUNTS_OWN_REPO (o el por defecto) con la semana del
 * curso, asi el tutor se enfoca en la misma semana. warning explica un valor que no sirvio.
 */
export function testTeacherTopic(
  kind: TestAccountTopic,
  courseTopic: Pick<PilotTopic, "courseCode" | "week" | "title" | "repoFullName"> | null,
  vars: { ownRepo: string; courseRepo: string },
): { topic: PilotTopicInput; warning: string } {
  const courseCode = courseTopic?.courseCode || DEFAULT_RAG_COURSE_CODE;
  const week = courseTopic?.week || 0;
  const wanted = kind === "own" ? vars.ownRepo : vars.courseRepo;
  const variable = kind === "own" ? "TEST_ACCOUNTS_OWN_REPO" : "TEST_ACCOUNTS_COURSE_REPO";
  const fromVar = normalizePilotTopicRepo(wanted);
  const warning = wanted && !fromVar
    ? `[cuentas-prueba] ${variable}=${wanted} no es usuario/repositorio ni un enlace de GitHub: se usa el repositorio por defecto.`
    : "";
  if (kind === "own") {
    return {
      topic: { courseCode, week, title: TEST_TOPIC_TITLES.own, repoFullName: fromVar || TEST_ACCOUNTS_DEFAULT_OWN_REPO },
      warning,
    };
  }
  if (!fromVar && courseTopic?.repoFullName) {
    return {
      topic: { courseCode, week, title: courseTopic.title || TEST_TOPIC_TITLES.course, repoFullName: courseTopic.repoFullName },
      warning,
    };
  }
  return {
    topic: { courseCode, week, title: courseTopic?.title || TEST_TOPIC_TITLES.course, repoFullName: fromVar || TEST_ACCOUNTS_DEFAULT_COURSE_REPO },
    warning,
  };
}

/** Lo minimo de pg.Pool (o de un cliente) que usan estas funciones. */
export type Queryable = {
  query: <T = Record<string, unknown>>(text: string, values?: unknown[]) => Promise<{ rows: T[]; rowCount?: number | null }>;
};

const ID_PLACEHOLDERS = TEST_ACCOUNT_IDS.map((_id, index) => `$${index + 1}`).join(", ");

/** Cuantas cuentas de prueba estan activas (lo informa /api/health como test_accounts_active). */
export async function countActiveTestAccounts(db: Queryable): Promise<number> {
  const result = await db.query<{ count: string }>(
    `select count(*)::text as count from users where is_active = true and id in (${ID_PLACEHOLDERS})`,
    [...TEST_ACCOUNT_IDS],
  );
  return Number(result.rows[0]?.count || 0);
}

export type TestAccountsShutdown = {
  /** Correos desactivados en este arranque (sus sesiones se cierran). */
  deactivated: string[];
  /** El administrador de prueba sigue activo porque no hay otro administrador activo. */
  adminKept: boolean;
};

/**
 * Desactiva las cuentas de prueba activas y cierra sus sesiones. El administrador de prueba solo
 * se desactiva si queda otro administrador activo (como el administrador demo).
 */
export async function deactivateTestAccounts(db: Queryable): Promise<TestAccountsShutdown> {
  const deactivated: string[] = [];
  let adminKept = false;
  for (const account of TEST_ACCOUNTS) {
    const found = await db.query<{ id: string }>(
      `select id from users where id = $1 and is_active = true limit 1`,
      [account.id],
    );
    if (!found.rows[0]) continue;
    if (account.role === "admin") {
      // Sin JOIN: pg-mem (pruebas y npm run dev sin DATABASE_URL) no filtra bien dentro de uno.
      const adminRole = await db.query<{ id: string }>(`select id from roles where code = 'admin' limit 1`);
      const others = await db.query<{ count: string }>(
        `select count(*)::text as count from users where role_id = $1 and is_active = true and id <> $2`,
        [adminRole.rows[0]?.id || "", account.id],
      );
      if (Number(others.rows[0]?.count || 0) === 0) {
        adminKept = true;
        continue;
      }
    }
    await db.query(`update users set is_active = false where id = $1`, [account.id]);
    await db.query(`update app_sessions set is_active = false where user_id = $1 and is_active = true`, [account.id]);
    deactivated.push(account.email);
  }
  return { deactivated, adminKept };
}

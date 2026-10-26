// Cuentas demo por ruta (DEMO_RUTAS_PASSWORD), 25 de octubre de 2026.
//
// Para que el docente del curso pruebe, como docente y como estudiante, cada ruta propuesta para
// seguir el piloto y escoja una: un docente demo por ruta, con su bitacora, su tema del piloto y
// tres estudiantes demo con codigo, todos con correo y contrasena (sin Google).
//
//   A  Droguería: cierre e integración del Taller Droguería (29-10 a 03-11).
//   B  Bus Fever Party: el proyecto del curso en ADACEEN hasta la entrega final.
//   C  Relaciones 11-11: taller propio para la clase «Abstraer relaciones de diferente tipo».
//   D  Combinada: A como prueba técnica, C como piloto formal y B como uso voluntario.
//
// pilot_topics guarda un tema por docente: el de D es el taller de C (el piloto formal); su
// bitacora muestra A y B en sus semanas y el docente puede cambiar el tema desde «Estudiantes».
//
// src/db/database.ts (AppDatabase.syncDemoRouteAccounts) las siembra en cada arranque, despues de
// las cuentas de prueba, hasta el dia de DEMO_RUTAS_HASTA. Sin la variable, con una clave corta o
// pasada esa fecha no se siembran y las que existan se desactivan con sus sesiones.
// scripts/piloto-dataset.ts las excluye del dataset del piloto y no son del grupo del docente del
// curso, asi que no entran en sus cohortes. Sus llamadas si cuentan en las metricas en vivo de
// latencia y disponibilidad (/api/telemetry/kpis y el monitor), como las de las cuentas de prueba.

import { normalizePilotTopicRepo, type PilotTopicInput } from "./pilot-topic.js";
import { DEFAULT_RAG_COURSE_CODE } from "./rag-courses.js";
import { TEST_ACCOUNTS_MIN_PASSWORD, type Queryable } from "./test-accounts.js";

export const DEMO_ROUTES_LOG = "[cuentas-demo-rutas]";

/** Organizacion de GitHub con los repositorios de las rutas (DEMO_RUTAS_ORG vacia). */
export const DEMO_ROUTES_DEFAULT_ORG = "adaceen-demo";

/** Ultimo dia de las cuentas (DEMO_RUTAS_HASTA vacia o invalida), hora de Colombia. */
export const DEMO_ROUTES_DEFAULT_UNTIL = "2026-11-15";

export const DEMO_ROUTE_STUDENTS = 3;

/** Carpeta de las bitacoras de las rutas, relativa a la raiz del backend (el despliegue copia data/). */
export const DEMO_ROUTES_BITACORA_DIR = "data/demo-rutas";

export type DemoRouteKey = "a" | "b" | "c" | "d";

export type DemoRoute = {
  key: DemoRouteKey;
  /** Nombre corto de la ruta (va en los nombres visibles de sus cuentas). */
  name: string;
  /** Repositorio del tema dentro de la organizacion demo. */
  repoName: string;
  /** Semana de la bitacora en la que se enfoca el tutor. */
  week: number;
  topicTitle: string;
  bitacoraFile: string;
  /** Los codigos de sus estudiantes son codeBase + 1, + 2 y + 3 (siete digitos). */
  codeBase: number;
};

export const DEMO_ROUTES: readonly DemoRoute[] = Object.freeze([
  { key: "a", name: "Droguería", repoName: "drogueria-fpoo", week: 8, topicTitle: "Cierre e integración del Taller Droguería", bitacoraFile: "bitacora_demo_ruta_A.xlsx", codeBase: 100 },
  { key: "b", name: "Bus Fever Party", repoName: "bus-fever-party", week: 11, topicTitle: "Proyecto Bus Fever Party! en ADACEEN", bitacoraFile: "bitacora_demo_ruta_B.xlsx", codeBase: 200 },
  { key: "c", name: "Relaciones 11-11", repoName: "taller-relaciones", week: 11, topicTitle: "Taller Relaciones en Bus Fever Party", bitacoraFile: "bitacora_demo_ruta_C.xlsx", codeBase: 300 },
  { key: "d", name: "Combinada", repoName: "taller-relaciones", week: 11, topicTitle: "Ruta combinada: Taller Relaciones (11-11)", bitacoraFile: "bitacora_demo_ruta_D.xlsx", codeBase: 400 },
]);

export type DemoRouteAccount = {
  id: string;
  role: "teacher" | "student";
  email: string;
  displayName: string;
  routeKey: DemoRouteKey;
  /** Docente demo del estudiante (id de esta misma lista). */
  teacherId?: string;
  studentCode?: string;
};

export function demoRouteTeacherId(key: DemoRouteKey) {
  return `user-demo-teacher-${key}`;
}

function buildAccounts(): DemoRouteAccount[] {
  const accounts: DemoRouteAccount[] = [];
  for (const route of DEMO_ROUTES) {
    const letter = route.key.toUpperCase();
    const teacherId = demoRouteTeacherId(route.key);
    // Los docentes van antes que sus estudiantes (teacher_user_id).
    accounts.push({
      id: teacherId,
      role: "teacher",
      email: `demo.${route.key}.docente@adaceen.edu.co`,
      displayName: `Demo Docente ${letter} (Ruta ${route.name})`,
      routeKey: route.key,
    });
    for (let index = 1; index <= DEMO_ROUTE_STUDENTS; index += 1) {
      accounts.push({
        id: `user-demo-student-${route.key}${index}`,
        role: "student",
        email: `demo.${route.key}.e${index}@adaceen.edu.co`,
        displayName: `Demo Estudiante ${letter}${index} (${route.name})`,
        routeKey: route.key,
        teacherId,
        studentCode: String(route.codeBase + index).padStart(7, "0"),
      });
    }
  }
  return accounts;
}

export const DEMO_ROUTE_ACCOUNTS: readonly DemoRouteAccount[] = Object.freeze(buildAccounts());

export const DEMO_ROUTE_ACCOUNT_IDS: readonly string[] = DEMO_ROUTE_ACCOUNTS.map((account) => account.id);

export function isDemoRouteAccountId(id: string | null | undefined) {
  return Boolean(id) && DEMO_ROUTE_ACCOUNT_IDS.includes(String(id));
}

export function demoRouteFor(key: DemoRouteKey): DemoRoute {
  return DEMO_ROUTES.find((route) => route.key === key) as DemoRoute;
}

/** Por que no se siembran con esa clave ("" si sirve o si no hay clave). */
export function demoRoutesPasswordProblem(password: string) {
  if (!password) return "";
  if (password.length < TEST_ACCOUNTS_MIN_PASSWORD) {
    return `${DEMO_ROUTES_LOG} DEMO_RUTAS_PASSWORD tiene menos de ${TEST_ACCOUNTS_MIN_PASSWORD} caracteres: no se siembran. Pon una clave mas larga y reinicia.`;
  }
  return "";
}

/** Ultimo dia (aaaa-mm-dd) y un aviso si el valor de DEMO_RUTAS_HASTA no sirvio. */
export function demoRoutesUntil(value: string): { until: string; warning: string } {
  const clean = String(value || "").trim();
  if (!clean) return { until: DEMO_ROUTES_DEFAULT_UNTIL, warning: "" };
  const match = clean.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  const date = match ? new Date(Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3]))) : null;
  const real = Boolean(date)
    && date!.getUTCFullYear() === Number(match![1])
    && date!.getUTCMonth() === Number(match![2]) - 1
    && date!.getUTCDate() === Number(match![3]);
  if (!real) {
    return {
      until: DEMO_ROUTES_DEFAULT_UNTIL,
      warning: `${DEMO_ROUTES_LOG} DEMO_RUTAS_HASTA=${clean} no es una fecha aaaa-mm-dd: se usa ${DEMO_ROUTES_DEFAULT_UNTIL}.`,
    };
  }
  return { until: clean, warning: "" };
}

/** true pasado el ultimo dia (23:59:59 hora de Colombia). */
export function demoRoutesExpired(until: string, now: Date = new Date()) {
  return now.getTime() > Date.parse(`${until}T23:59:59-05:00`);
}

const GITHUB_OWNER = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$/;

/** Tema del piloto de una ruta: el repositorio de la organizacion demo y la semana de la ruta. */
export function demoRouteTopic(route: DemoRoute, org: string): { topic: PilotTopicInput; warning: string } {
  const wanted = String(org || "").trim();
  const fromVar = GITHUB_OWNER.test(wanted) ? normalizePilotTopicRepo(`${wanted}/${route.repoName}`) : "";
  const warning = wanted && !fromVar
    ? `${DEMO_ROUTES_LOG} DEMO_RUTAS_ORG=${wanted} no es un usuario u organizacion de GitHub: se usa ${DEMO_ROUTES_DEFAULT_ORG}.`
    : "";
  return {
    topic: {
      courseCode: DEFAULT_RAG_COURSE_CODE,
      week: route.week,
      title: route.topicTitle,
      repoFullName: fromVar || `${DEMO_ROUTES_DEFAULT_ORG}/${route.repoName}`,
    },
    warning,
  };
}

const ID_PLACEHOLDERS = DEMO_ROUTE_ACCOUNT_IDS.map((_id, index) => `$${index + 1}`).join(", ");

/** Cuantas cuentas demo por ruta estan activas (lo informa /api/health). */
export async function countActiveDemoRouteAccounts(db: Queryable): Promise<number> {
  const result = await db.query<{ count: string }>(
    `select count(*)::text as count from users where is_active = true and id in (${ID_PLACEHOLDERS})`,
    [...DEMO_ROUTE_ACCOUNT_IDS],
  );
  return Number(result.rows[0]?.count || 0);
}

/**
 * Desactiva las cuentas demo por ruta activas, cierra sus sesiones y borra el token de GitHub que
 * haya conectado quien las probo; devuelve sus correos.
 */
export async function deactivateDemoRouteAccounts(db: Queryable): Promise<string[]> {
  const deactivated: string[] = [];
  for (const account of DEMO_ROUTE_ACCOUNTS) {
    const found = await db.query<{ id: string }>(
      `select id from users where id = $1 and is_active = true limit 1`,
      [account.id],
    );
    if (!found.rows[0]) continue;
    await db.query(`update users set is_active = false where id = $1`, [account.id]);
    await db.query(`update app_sessions set is_active = false where user_id = $1 and is_active = true`, [account.id]);
    await db.query(`delete from github_user_tokens where user_id = $1`, [account.id]);
    deactivated.push(account.email);
  }
  return deactivated;
}

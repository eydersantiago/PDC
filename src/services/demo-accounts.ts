// Cuentas de demostracion (administrador, docente y estudiante demo que siembra
// src/db/seeds.ts con claves publicadas en el repositorio) y su cierre fuera de produccion.
//
// seed() las crea en cada arranque con "on conflict do nothing", asi que en produccion
// borrarlas no servia y C20 de la lista de cumplimiento (no entran con la clave del
// repositorio) exigia correr npm run cuentas-demo contra la base de produccion. Con
// SEED_DEMO_ACCOUNTS=false (src/config/env.ts) no se siembran y, al arrancar, se desactivan
// las que existan: estudiante y docente siempre; el administrador demo solo si hay otro
// administrador activo, porque puede ser el unico (el overlay no crea administradores).
// scripts/lib/cuentas-demo.ts y scripts/lib/cumplimiento.ts (C20) usan esta misma lista.

export type DemoAccount = {
  id: string;
  role: "admin" | "teacher" | "student";
  email: string;
  displayName: string;
  /** Clave publicada en el repositorio (la que C20 comprueba que ya no entra). */
  password: string;
};

// En este orden: el estudiante demo apunta al docente demo (teacher_user_id).
export const DEMO_ACCOUNTS: readonly DemoAccount[] = Object.freeze([
  { id: "user-admin-demo", role: "admin", email: "admin@adaceen.edu.co", displayName: "Administrador Demo", password: "Admin123!" },
  { id: "user-teacher-demo", role: "teacher", email: "docente@adaceen.edu.co", displayName: "Docente Demo", password: "Docente123!" },
  { id: "user-student-demo", role: "student", email: "estudiante@adaceen.edu.co", displayName: "Estudiante Demo", password: "Estudiante123!" },
]);

export const DEMO_ACCOUNT_EMAILS: readonly string[] = DEMO_ACCOUNTS.map((account) => account.email);

export const DEMO_ADMIN_EMAIL = DEMO_ACCOUNTS.find((account) => account.role === "admin")!.email;

/** Aviso del arranque cuando el administrador demo no se puede desactivar. */
export const DEMO_ADMIN_KEPT_WARNING = `[cuentas-demo] SEED_DEMO_ACCOUNTS=false, pero ${DEMO_ADMIN_EMAIL} sigue activa: es el unico administrador activo y desactivarla dejaria a ADACEEN sin administrador. Crea otro administrador y reinicia el backend, o corre npm run cuentas-demo -- --confirmar para cambiarle la clave publicada.`;

/** Lo minimo de pg.Pool (o de un cliente) que usan estas funciones. */
export type Queryable = {
  query: <T = Record<string, unknown>>(text: string, values?: unknown[]) => Promise<{ rows: T[]; rowCount?: number | null }>;
};

export type DemoAccountsShutdown = {
  /** Correos desactivados en este arranque (sus sesiones se cierran). */
  deactivated: string[];
  /** El administrador demo sigue activo porque no hay otro administrador activo. */
  adminKept: boolean;
};

const EMAIL_PLACEHOLDERS = DEMO_ACCOUNT_EMAILS.map((_email, index) => `$${index + 1}`).join(", ");

/** Cuantas cuentas demo siguen activas (lo informa /api/health como demo_accounts_active). */
export async function countActiveDemoAccounts(db: Queryable): Promise<number> {
  const result = await db.query<{ count: string }>(
    `select count(*)::text as count from users where is_active = true and lower(email) in (${EMAIL_PLACEHOLDERS})`,
    [...DEMO_ACCOUNT_EMAILS],
  );
  return Number(result.rows[0]?.count || 0);
}

/**
 * Desactiva las cuentas demo que existan y cierra sus sesiones. El administrador demo solo se
 * desactiva si queda otro administrador activo; si no, se deja y adminKept es true (el que
 * llama avisa en consola con DEMO_ADMIN_KEPT_WARNING).
 */
export async function deactivateDemoAccounts(db: Queryable): Promise<DemoAccountsShutdown> {
  const deactivated: string[] = [];
  let adminKept = false;
  for (const account of DEMO_ACCOUNTS) {
    const found = await db.query<{ id: string }>(
      `select id from users where is_active = true and lower(email) = lower($1) limit 1`,
      [account.email],
    );
    const row = found.rows[0];
    if (!row) continue;
    if (account.role === "admin") {
      const others = await db.query<{ count: string }>(
        `
        select count(*)::text as count
        from users u
        join roles r on r.id = u.role_id
        where r.code = 'admin' and u.is_active = true and u.id <> $1
        `,
        [row.id],
      );
      if (Number(others.rows[0]?.count || 0) === 0) {
        adminKept = true;
        continue;
      }
    }
    await db.query(`update users set is_active = false where id = $1`, [row.id]);
    await db.query(`update app_sessions set is_active = false where user_id = $1 and is_active = true`, [row.id]);
    deactivated.push(account.email);
  }
  return { deactivated, adminKept };
}

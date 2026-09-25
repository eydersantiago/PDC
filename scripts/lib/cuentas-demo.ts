import { randomBytes, scryptSync, timingSafeEqual } from "node:crypto";
import { DEMO_ACCOUNTS } from "./cumplimiento.js";
import type { Queryable } from "./retiro.js";

/**
 * Cuentas de demostracion (src/db/seeds.ts) en la base de produccion: C20 de la lista de
 * cumplimiento pide que no entren con la clave publicada en el repositorio. seed() las
 * vuelve a crear en cada arranque si faltan ("on conflict do nothing"), asi que borrarlas
 * no sirve; lo que se cambie aqui persiste.
 *
 * - Estudiante y docente demo: se desactivan (sus sesiones dejan de valer).
 * - Administrador demo: puede ser el unico administrador de produccion (el overlay no crea
 *   administradores), asi que no se desactiva: se le pone una clave nueva al azar, que se
 *   muestra una sola vez, y se cierran sus sesiones.
 * Sin confirm solo informa.
 */

export type DemoAccountState = {
  email: string;
  exists: boolean;
  active: boolean;
  publicPassword: boolean;
  action: "ninguna" | "desactivar" | "cambiar_clave";
};

export type DemoAccountsReport = {
  confirmed: boolean;
  accounts: DemoAccountState[];
  /** Solo con confirm y si se cambio: la clave nueva del administrador demo. */
  newAdminPassword: string;
};

function passwordMatches(rawPassword: string, storedHash: string) {
  const [salt, hash] = String(storedHash || "").split(":");
  if (!salt || !hash) return false;
  const derived = scryptSync(rawPassword, salt, 64);
  const stored = Buffer.from(hash, "hex");
  return stored.length === derived.length && timingSafeEqual(stored, derived);
}

function hashPassword(rawPassword: string) {
  const salt = randomBytes(16).toString("hex");
  return `${salt}:${scryptSync(rawPassword, salt, 64).toString("hex")}`;
}

export async function closeDemoAccounts(pool: Queryable, options: { confirm: boolean }): Promise<DemoAccountsReport> {
  const accounts: DemoAccountState[] = [];
  let newAdminPassword = "";
  for (const [email, publicPassword] of DEMO_ACCOUNTS) {
    const found = await pool.query<{ id: string; is_active: boolean; password_hash: string; role: string }>(
      `select u.id, u.is_active, u.password_hash, r.code as role
       from users u join roles r on r.id = u.role_id
       where lower(u.email) = lower($1)
       limit 1`,
      [email],
    );
    const row = found.rows[0];
    const active = Boolean(row?.is_active);
    const publicKey = Boolean(row) && passwordMatches(publicPassword, row!.password_hash);
    const action: DemoAccountState["action"] = !row || !active || !publicKey
      ? "ninguna"
      : row.role === "admin" ? "cambiar_clave" : "desactivar";
    if (options.confirm && row && action === "desactivar") {
      await pool.query("update users set is_active = false where id = $1", [row.id]);
    }
    if (options.confirm && row && action === "cambiar_clave") {
      newAdminPassword = randomBytes(12).toString("base64url");
      await pool.query("update users set password_hash = $2 where id = $1", [row.id, hashPassword(newAdminPassword)]);
    }
    if (options.confirm && row && action !== "ninguna") {
      await pool.query("update app_sessions set is_active = false where user_id = $1 and is_active = true", [row.id]);
    }
    accounts.push({ email, exists: Boolean(row), active, publicPassword: publicKey, action });
  }
  return { confirmed: options.confirm, accounts, newAdminPassword };
}

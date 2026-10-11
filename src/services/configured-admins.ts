// Administradores por configuracion: ADACEEN_ADMIN_EMAILS (src/config/env.ts).
//
// El overlay y el API solo crean estudiantes y docentes, asi que en produccion el unico
// administrador era el demo (admin@adaceen.edu.co, con la clave publicada en el repositorio) y,
// con SEED_DEMO_ACCOUNTS=false, el arranque no lo podia desactivar sin dejar a ADACEEN sin
// administrador (src/services/demo-accounts.ts). Con esta variable cada arranque pasa a
// administrador las cuentas activas que ya existen con esos correos, antes de cerrar las cuentas
// demo (AppDatabase.syncConfiguredAdmins, src/db/database.ts), y ese mismo arranque desactiva al
// administrador demo. El trabajo con la base esta en UsersDatabase.promoteConfiguredAdmins
// (src/db/repos/users.ts); aqui, la lectura de la variable y los mensajes del arranque.
//   - No crea cuentas: la cuenta tiene que existir (entrar una vez con «Continuar con Google» o
//     crearla en «Usuarios»), para que nadie quede de administrador sin poder entrar.
//   - Solo sube de rol: quitar un correo de la variable no le quita el rol a nadie.
//   - No toca las cuentas demo ni a un docente con estudiantes (se quedarian sin docente).
//   - Si la cuenta entraba con la clave por defecto de las cuentas de Google
//     (GOOGLE_DEFAULT_PASSWORD, la misma para todas), se le pone una al azar: un administrador
//     entra con Google o con una clave propia.
//   - Se cierran sus sesiones: al volver a entrar ve las pestañas de administrador.

import { DEMO_ACCOUNT_EMAILS } from "./demo-accounts.js";

export const ADMIN_EMAILS_VARIABLE = "ADACEEN_ADMIN_EMAILS";

const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const LOG_PREFIX = `[administradores] ${ADMIN_EMAILS_VARIABLE}:`;

export type ConfiguredAdminsReport = {
  /** Pasaron a administrador en este arranque (sus sesiones se cerraron). */
  promoted: Array<{ email: string; previousRole: string; passwordReset: boolean }>;
  alreadyAdmin: string[];
  /** No hay cuenta con ese correo. */
  missing: string[];
  /** La cuenta existe pero esta desactivada. */
  inactive: string[];
  /** No se tocaron: correo no valido, cuenta demo o docente con estudiantes. */
  skipped: Array<{ email: string; reason: string }>;
};

export function emptyConfiguredAdminsReport(): ConfiguredAdminsReport {
  return { promoted: [], alreadyAdmin: [], missing: [], inactive: [], skipped: [] };
}

/** Correos de la variable: separados por coma, punto y coma o espacios; en minusculas y sin repetir. */
export function parseAdminEmails(raw: string): string[] {
  const emails = new Set<string>();
  for (const part of String(raw || "").split(/[\s,;]+/)) {
    const email = part.trim().toLowerCase();
    if (email) emails.add(email);
  }
  return [...emails];
}

/** Por que no se toca un correo antes de buscarlo en la base, o "" si se busca. */
export function adminEmailRejection(email: string): string {
  if (!EMAIL_PATTERN.test(email)) return "no es un correo valido.";
  if (DEMO_ACCOUNT_EMAILS.includes(email.toLowerCase())) return "es una cuenta demo (src/services/demo-accounts.ts).";
  return "";
}

export function teacherWithStudentsReason(count: number): string {
  return `es docente de ${count} estudiante${count === 1 ? "" : "s"}: pasalos a otro docente en «Usuarios» o quita el correo de la variable.`;
}

const ROLE_NAMES: Record<string, string> = { student: "estudiante", teacher: "docente", admin: "administrador" };

/** Lineas de consola del arranque (las que ya eran administrador no se repiten en cada arranque). */
export function describeConfiguredAdmins(report: ConfiguredAdminsReport): { info: string[]; warn: string[] } {
  const info = report.promoted.map((entry) => {
    const password = entry.passwordReset
      ? " Entraba con la clave por defecto de las cuentas de Google: ahora entra con Google."
      : "";
    return `${LOG_PREFIX} ${entry.email} paso de ${ROLE_NAMES[entry.previousRole] || entry.previousRole} a administrador y sus sesiones se cerraron.${password}`;
  });
  const warn = [
    ...report.missing.map((email) => `${LOG_PREFIX} no hay cuenta con ${email}: entra una vez con «Continuar con Google» (o creala en «Usuarios») y reinicia el App Service.`),
    ...report.inactive.map((email) => `${LOG_PREFIX} ${email} esta desactivada: no pasa a administrador (activala en «Usuarios» y reinicia el App Service).`),
    ...report.skipped.map((entry) => `${LOG_PREFIX} ${entry.email} no pasa a administrador: ${entry.reason}`),
  ];
  return { info, warn };
}

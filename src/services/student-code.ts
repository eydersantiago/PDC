// Codigo de estudiante como identidad (navegador 0.7.22).
//
// Una persona es un solo user_id. Google (o la clave) solo dice con que correo llega; el codigo
// de estudiante de Univalle (7 digitos) dice quien es. Un estudiante no entra sin codigo, y un
// mismo codigo no puede quedar en dos cuentas: si llega con otro correo y un codigo que ya tiene
// una cuenta, ese correo se vuelve otro acceso de esa cuenta (tabla user_login_emails) y prevalece
// su user_id, con su cohorte, telemetria, editor y quices.
//   - Si la cuenta del codigo nunca ha entrado (la creo el administrador o la importacion) y llega
//     un correo institucional que no tiene cuenta, se une solo.
//   - Si no, queda una solicitud (student_access_requests) que aprueba el docente del
//     estudiante o el administrador en «Usuarios»: el codigo no prueba identidad (cualquiera
//     puede escribir el de un compañero), asi que no se entra a una cuenta en uso sin que alguien
//     lo confirme. Mientras tanto se le dice con que correo entro antes (enmascarado).
// El trabajo con la base esta en AuthDatabase.resolveStudentSignIn (src/db/repos/auth.ts) y en
// UsersDatabase (aprobar, rechazar, quitar accesos). El codigo nunca va a la telemetria ni a las
// exportaciones del piloto.

export const STUDENT_CODE_LENGTH = 7;

/**
 * Dominio institucional: solo un correo nuevo de este dominio se une solo a una cuenta que
 * nunca entro (la importada de Campus con su codigo). Cualquier otro correo pide aprobacion,
 * para que nadie se quede con la cuenta de un compañero con un Gmail nuevo y su codigo.
 */
export const INSTITUTIONAL_EMAIL_DOMAIN = "correounivalle.edu.co";

export function isInstitutionalEmail(email: string): boolean {
  return String(email || "").trim().toLowerCase().endsWith(`@${INSTITUTIONAL_EMAIL_DOMAIN}`);
}

// Palabras que no distinguen a una persona («de la Cruz», «del Valle»).
const NAME_CONNECTORS = new Set(["de", "del", "la", "las", "los", "y", "e", "da", "das", "do", "dos", "van", "von"]);

/** Palabras de un nombre sin tildes, mayusculas ni conectores: «López de la Cruz, Ana» -> lopez, cruz, ana. */
export function personNameTokens(name: string): string[] {
  const words = String(name || "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .split(/[^a-zñ]+/)
    .filter((word) => word.length > 1 && !NAME_CONNECTORS.has(word));
  return [...new Set(words)];
}

/**
 * ¿El nombre de Google y el de la lista son de la misma persona? (examen del 28-10-2026: antes de
 * unir un correo nuevo a la fila de la lista). Coinciden si tienen las mismas palabras, en
 * cualquier orden, o si todas las del mas corto (al menos dos, p. ej. nombre y apellido) estan en
 * el otro: «Ana Lopez» y «LOPEZ CRUZ ANA MARIA» si; «Ana» sola, no.
 */
export function personNamesMatch(a: string, b: string): boolean {
  return personNameTokensMatch(personNameTokens(a), personNameTokens(b));
}

/**
 * Mismas palabras exactas, en cualquier orden y sin tildes (al menos dos). Es lo que se exige para
 * unir por el nombre solo, sin un codigo que diga cual fila es: «Juan Perez» no se une a «Juan
 * David Perez Gomez», que puede ser otro estudiante.
 */
export function personNamesEqual(a: string, b: string): boolean {
  const left = personNameTokens(a);
  const right = personNameTokens(b);
  return left.length >= 2 && left.length === right.length && personNameTokensMatch(left, right);
}

/** personNamesMatch con las palabras ya calculadas (para comparar muchos nombres entre si). */
export function personNameTokensMatch(left: string[], right: string[]): boolean {
  if (!left.length || !right.length) return false;
  const [shorter, longer] = left.length <= right.length ? [left, right] : [right, left];
  if (shorter.length < 2) return false;
  const pool = new Set(longer);
  return shorter.every((word) => pool.has(word));
}

const STUDENT_CODE_PATTERN = /^\d{7}$/;
// Univalle suele escribirlo con el programa: 2312345-3743. Se guarda solo el codigo.
const STUDENT_CODE_WITH_PROGRAM_PATTERN = /^(\d{7})-\d{4}$/;

export const STUDENT_CODE_FORMAT_MESSAGE = "El código de estudiante tiene 7 dígitos, por ejemplo 2312345.";

/** El cliente viejo (0.7.21 o anterior) muestra este texto tal cual: por eso dice que actualice. */
export const STUDENT_CODE_REQUIRED_MESSAGE =
  "Para entrar, escribe tu código de estudiante (7 dígitos). Si no ves dónde escribirlo, actualiza ADACEEN a la versión 0.7.22 o superior.";

/** Codigo normalizado (7 digitos) o null si no tiene el formato. */
export function normalizeStudentCode(raw: unknown): string | null {
  const text = String(raw ?? "").replace(/[\s.]+/g, "");
  if (STUDENT_CODE_PATTERN.test(text)) return text;
  const withProgram = STUDENT_CODE_WITH_PROGRAM_PATTERN.exec(text);
  return withProgram ? withProgram[1] : null;
}

/** ey***@correounivalle.edu.co: lo justo para que el estudiante reconozca su otro correo. */
export function maskEmail(email: string): string {
  const clean = String(email || "").trim().toLowerCase();
  const at = clean.lastIndexOf("@");
  if (at <= 0) return "***";
  const local = clean.slice(0, at);
  const domain = clean.slice(at + 1);
  const visible = local.length <= 2 ? local.slice(0, 1) : local.slice(0, 2);
  return `${visible}***@${domain}`;
}

export function pendingApprovalMessage(maskedEmail: string): string {
  return `Tu código ya está registrado con otro correo (${maskedEmail}). Entra con ese correo, `
    + "o espera a que tu docente apruebe este acceso: después podrás entrar con cualquiera de los dos.";
}

export const ACCESS_REJECTED_MESSAGE =
  "Tu docente no aprobó este acceso con ese código. Entra con el correo que usaste antes o habla con tu docente.";

export const STUDENT_CODE_UNAVAILABLE_MESSAGE =
  "Ese código no corresponde a una cuenta de estudiante. Revisa tu código o habla con tu docente.";

export const STUDENT_CODE_TOO_MANY_ATTEMPTS_MESSAGE =
  "Demasiados intentos con códigos de estudiante. Espera 15 minutos o habla con tu docente.";

export const STUDENT_CODE_REQUIRED_FOR_EDITOR_MESSAGE =
  "Antes de abrir el editor, entra en ADACEEN desde el navegador y escribe tu código de estudiante.";

/** Resultado de un intento de entrada de estudiante (o de cualquiera, para quien no lleva codigo). */
export type StudentSignInResult =
  | { status: "ok"; userId: string; created: boolean; linkedEmail: boolean }
  | { status: "student_code_required"; displayName: string; email: string }
  | { status: "invalid_code" }
  | { status: "code_unavailable" }
  | { status: "too_many_attempts" }
  | { status: "pending_approval"; maskedEmail: string; requestedAt: string }
  | { status: "rejected" }
  | { status: "inactive" };

/** Solicitud pendiente tal como la ven el docente y el administrador en «Usuarios». */
export type StudentAccessRequest = {
  id: string;
  email: string;
  displayName: string;
  studentCode: string;
  status: "pending" | "approved" | "rejected";
  createdAt: string;
  target: { id: string; displayName: string; email: string; teacherUserId: string | null };
  /** La cuenta que ya tenia ese correo (por ejemplo, una importada de Campus), si existe. */
  source: { id: string; displayName: string; email: string; hasSignedIn: boolean; otherGroup?: boolean } | null;
};

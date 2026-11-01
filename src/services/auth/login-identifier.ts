// Usuario en lugar de correo para entrar con clave (26 de octubre de 2026).
//
// Las cuentas con clave del aplicativo (las semilla, las de prueba y las demo por ruta) tienen todas
// el correo en @adaceen.edu.co. Para que el docente del curso entre escribiendo solo «demo.a.e1» o
// «demo.b.docente», POST /api/auth/login completa el dominio cuando lo escrito no trae @. Lo hace el
// servidor para que sirva tambien con la extension de la tienda, que manda lo escrito tal cual.
// Un correo completo sigue igual, y las cuentas de Google entran por /api/auth/google-login.

/** Dominio de las cuentas con clave del aplicativo. */
export const LOCAL_ACCOUNTS_DOMAIN = "adaceen.edu.co";

// Lo que va antes de la @: letras, digitos, punto, guion y guion bajo; sin punto al inicio ni al final
// ni dos seguidos, y hasta 64 caracteres.
const USERNAME = /^(?!.*\.\.)[a-z0-9_-](?:[a-z0-9._-]{0,62}[a-z0-9_-])?$/i;

/**
 * Correo con el que se busca la cuenta: «demo.a.e1» -> «demo.a.e1@adaceen.edu.co». Lo escrito sin
 * @ que no es un usuario valido (con espacios, por ejemplo) se devuelve igual, y la validacion del
 * correo lo rechaza como antes.
 */
export function loginEmailFromIdentifier(value: string): string {
  const typed = String(value ?? "").trim();
  if (typed.includes("@") || !USERNAME.test(typed)) return typed;
  return `${typed}@${LOCAL_ACCOUNTS_DOMAIN}`;
}

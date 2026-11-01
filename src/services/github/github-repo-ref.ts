// Repositorios y logins de GitHub tal como llegan (30-10-2026): un solo lector para el tema del
// piloto, la referencia del examen y el avance de los talleres. Antes cada modulo tenia el suyo y
// un enlace con /tree/main o ?tab=readme no se reconocia en unos y si en otros.

export type GithubRepoRef = {
  /** Dueno (usuario u organizacion); null si solo llego el nombre del repositorio. */
  owner: string | null;
  name: string;
};

const GITHUB_OWNER = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$/;
const GITHUB_REPO = /^[A-Za-z0-9._-]{1,100}$/;

/**
 * Lee un repositorio de GitHub de lo que se escriba o se mande: «nombre», «dueno/nombre», el
 * enlace (http o https, con o sin www, con /tree/<rama>, /blob/..., ?tab=..., #... o .git) o
 * git@github.com:dueno/nombre.git. Conserva mayusculas y minusculas. null si no es de GitHub
 * (otro servidor u otro esquema), si un enlace no trae el nombre o si el texto no es valido.
 */
export function parseGithubRepoRef(value: unknown): GithubRepoRef | null {
  const text = String(value ?? "").trim().replace(/\s+/g, "");
  if (!text) return null;
  const withoutHost = text
    .replace(/^git@github\.com:/i, "")
    .replace(/^(?:https?:\/\/)?(?:www\.)?github\.com\//i, "");
  const hadHost = withoutHost !== text;
  if (/^[a-z][a-z0-9+.-]*:/i.test(withoutHost)) return null;
  const parts = withoutHost.split(/[?#]/)[0].split("/").filter(Boolean);
  if (!parts.length || (hadHost && parts.length < 2)) return null;
  const owner = parts.length >= 2 ? parts[0] : null;
  const name = (parts.length >= 2 ? parts[1] : parts[0]).replace(/\.git$/i, "");
  if (owner !== null && !GITHUB_OWNER.test(owner)) return null;
  if (!GITHUB_REPO.test(name) || /^\.+$/.test(name)) return null;
  return { owner, name };
}

/** «dueno/nombre» (o solo «nombre» sin dueno), con las mayusculas de origen. */
export function formatGithubRepoRef(ref: GithubRepoRef) {
  return ref.owner ? `${ref.owner}/${ref.name}` : ref.name;
}

/**
 * ¿Es el mismo repositorio? Sin distinguir mayusculas. Si los dos traen dueno, se compara
 * dueno y nombre; si a alguno le falta, solo el nombre (un fork o una copia con otro dueno).
 */
export function sameGithubRepo(left: GithubRepoRef | null, right: GithubRepoRef | null) {
  if (!left || !right) return false;
  if (left.name.toLowerCase() !== right.name.toLowerCase()) return false;
  if (!left.owner || !right.owner) return true;
  return left.owner.toLowerCase() === right.owner.toLowerCase();
}

/** Login de GitHub para comparar: sin espacios y en minusculas ("" si no hay). */
export function normalizeGithubLogin(value: unknown) {
  return String(value ?? "").trim().toLowerCase();
}

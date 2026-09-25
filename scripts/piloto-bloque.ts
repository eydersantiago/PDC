import "dotenv/config";
import { fail, hasFlag, login, readArg } from "./lib/cli.js";

/**
 * Maneja el piloto AB/BA desde la terminal (lo mismo que la seccion «Piloto
 * con y sin tutor» del overlay del docente).
 *
 *   npm run piloto:bloque -- --url=<backend> --email=<docente> --password=<clave>              # estado
 *   npm run piloto:bloque -- ... --asignar [--semilla=<texto>]                                 # cohortes A y B
 *   npm run piloto:bloque -- ... --bloque=1 | --bloque=2 | --bloque=0                          # cambiar de bloque
 *   npm run piloto:bloque -- ... --docente=<id del docente>                                    # como administrador
 *
 * La semilla queda guardada: anotala en el acta de la sesion.
 */

type Summary = {
  ok: boolean;
  block?: number;
  description?: string;
  seed?: string;
  counts?: { A: number; B: number; sinAsignar: number };
  students?: Array<{ displayName: string; cohort: string }>;
  added?: number;
  error?: string;
};

async function main() {
  const baseUrl = readArg("url").replace(/\/+$/, "");
  const email = readArg("email");
  const password = readArg("password");
  if (!baseUrl || !email || !password) fail("Faltan --url, --email y --password.");
  const teacherUserId = readArg("docente");
  const sessionId = await login(baseUrl, email, password);
  const headers = { "Content-Type": "application/json; charset=utf-8", "x-session-id": sessionId };
  const suffix = teacherUserId ? `?teacherUserId=${encodeURIComponent(teacherUserId)}` : "";

  let response: Response;
  if (hasFlag("asignar")) {
    response = await fetch(`${baseUrl}/api/pilot/assign`, {
      method: "POST",
      headers,
      body: JSON.stringify({ ...(readArg("semilla") ? { seed: readArg("semilla") } : {}), ...(teacherUserId ? { teacherUserId } : {}) }),
    });
  } else if (readArg("bloque")) {
    const block = Number(readArg("bloque"));
    if (![0, 1, 2].includes(block)) fail("--bloque debe ser 0, 1 o 2.");
    response = await fetch(`${baseUrl}/api/pilot/block`, {
      method: "PUT",
      headers,
      body: JSON.stringify({ block, ...(teacherUserId ? { teacherUserId } : {}) }),
    });
  } else {
    response = await fetch(`${baseUrl}/api/pilot${suffix}`, { headers });
  }
  const data = await response.json().catch(() => ({})) as Summary;
  if (!response.ok) fail(`El backend respondio ${response.status}: ${data.error || ""}`);
  console.log(`[piloto] ${data.description}`);
  console.log(`[piloto] Grupo A: ${data.counts?.A ?? 0} · Grupo B: ${data.counts?.B ?? 0} · Sin asignar: ${data.counts?.sinAsignar ?? 0}${data.added !== undefined ? ` · Nuevos: ${data.added}` : ""}`);
  if (data.seed) console.log(`[piloto] Semilla de la asignacion: ${data.seed}`);
  if (hasFlag("lista")) {
    for (const student of data.students || []) console.log(`  ${student.cohort || "-"}  ${student.displayName}`);
  }
}

main().catch((error) => {
  console.error("[piloto] Fallo:", error);
  process.exitCode = 1;
});

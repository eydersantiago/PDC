// Telemetria: actores (usuario, cliente, sistema) y claves de union (seudonimo y ejercicio del editor).
import type { AppSession } from "../../types/app.js";
import { pseudonymize } from "./telemetry-hash.js";

// ---------------------------------------------------------------------------
// Actores
// ---------------------------------------------------------------------------

export type TelemetryActorKind = "user" | "client" | "system";

export type TelemetryActor = {
  kind: TelemetryActorKind;
  /** user:<id> | client:<id> | system: nunca se guarda en claro. */
  key: string;
  role: string;
  /** user:<id> del docente, si se conoce. */
  teacherKey: string;
};

export const CLIENT_ID_PATTERN = /^[A-Za-z0-9_-]{8,80}$/;

export const SYSTEM_ACTOR: TelemetryActor = { kind: "system", key: "system", role: "", teacherKey: "" };

// --- Claves de union de la telemetria ---------------------------------------------------------
// Un solo lugar para armarlas: el seudonimo de un usuario (actor_anon_id, teacher_anon_id) y el
// ejercicio del editor (exercise_hash) unen la telemetria, la historia del avance y las cuentas de
// muestra. Armadas a mano en varios archivos, un cambio en uno separaba los datos sin error.

const USER_KEY_PREFIX = "user:";

/** Clave del actor de un usuario con sesion («user:<id>»); se guarda solo su HMAC. */
export function userActorKey(userId: string) {
  return `${USER_KEY_PREFIX}${userId}`;
}

/** El id del usuario de una clave de actor («user:<id>»), o "" si es de un cliente sin sesion. */
export function userIdFromActorKey(key: string) {
  return key.startsWith(USER_KEY_PREFIX) ? key.slice(USER_KEY_PREFIX.length) : "";
}

/** Seudonimo de un usuario: el actor_anon_id (o teacher_anon_id) de su telemetria. */
export function userPseudonym(userId: string) {
  return pseudonymize(userActorKey(userId));
}

/**
 * Ejercicio de un archivo en VS Code: «file:<ruta en minusculas>». Lo usan /suggest-tab,
 * apply-check y los eventos de VS Code, asi las aplicaciones y los pedidos de un archivo se cuentan
 * juntos (exerciseHash).
 */
export function editorExerciseKey(filePath: string) {
  return `file:${String(filePath || "").trim().toLowerCase()}`;
}

export function actorFromSession(session: Pick<AppSession, "user">): TelemetryActor {
  const user = session.user;
  const teacherId = user.role === "teacher" ? user.id : user.teacherUserId || "";
  return {
    kind: "user",
    key: userActorKey(user.id),
    role: user.role,
    teacherKey: teacherId ? userActorKey(teacherId) : "",
  };
}

/**
 * Clave de un cliente sin sesion («client:<x-adaceen-client-id>», 31-10-2026): la de su
 * telemetria y la de sus quices (student_quizzes.client_key). Se guarda solo su HMAC.
 */
export function clientActorKey(clientId: string) {
  return `client:${clientId}`;
}

export function actorFromClientId(clientId: unknown): TelemetryActor | null {
  const clean = String(clientId || "").trim();
  if (!CLIENT_ID_PATTERN.test(clean)) return null;
  return { kind: "client", key: clientActorKey(clean), role: "", teacherKey: "" };
}

/** Clave estable del actor para limites por ejercicio (no se guarda en claro). */
export function actorAnonId(actor: TelemetryActor) {
  return actor.kind === "system" ? "" : pseudonymize(actor.key);
}

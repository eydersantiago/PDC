import type express from "express";
import { z } from "zod";
import type { AppDatabase } from "../db/database.js";
import type { TeacherPolicy } from "../types/app.js";
import { trimText } from "../services/text-utils.js";
import { actorFromClientId, actorFromSession } from "../services/telemetry.js";

export type AppSession = NonNullable<Awaited<ReturnType<AppDatabase["getSession"]>>>;

export const SESSION_COOKIE_NAME = "adaceen_session_id";

function getCookieValue(cookieHeader: string | string[] | undefined, name: string) {
  const source = Array.isArray(cookieHeader) ? cookieHeader.join("; ") : cookieHeader;
  if (!source) return null;

  try {
    return source
      .split(";")
      .map((item: string) => item.trim())
      .map((item: string) => item.split("="))
      .find((parts: string[]) => parts[0] === name)
      ?.slice(1)
      .join("=") || null;
  } catch {
    return null;
  }
}

// Cabecera con la que el backend avisa que el x-session-id recibido ya no
// vale (inactivo, vencido o inexistente). VS Code la usa para releer su
// sesion; se expone por CORS en app.ts.
export const SESSION_STATE_HEADER = "x-adaceen-session";

type SessionLookup = { sessionId: string; promise: Promise<AppSession | null> };

const SESSION_LOOKUP_KEY = "adaceenSessionLookup";

function markInvalidSession(res: express.Response | undefined) {
  if (res && !res.headersSent) res.setHeader(SESSION_STATE_HEADER, "invalid");
}

/**
 * Las respuestas que entregan una sesion nueva (login, canje de codigo o de
 * GitHub) no llevan la marca aunque el cliente mandara su x-session-id viejo:
 * asi no descarta la sesion que acaba de recibir.
 */
export function clearInvalidSessionMark(res: express.Response) {
  if (!res.headersSent) res.removeHeader(SESSION_STATE_HEADER);
}

// Una sola consulta por peticion para el x-session-id: la hace el middleware
// y resolveSession la reutiliza.
function lookupHeaderSession(database: AppDatabase, req: express.Request, sessionId: string) {
  const locals = req.res?.locals as Record<string, unknown> | undefined;
  const cached = locals?.[SESSION_LOOKUP_KEY] as SessionLookup | undefined;
  if (cached && cached.sessionId === sessionId) return cached.promise;
  const promise = database.getSession(sessionId);
  if (locals) locals[SESSION_LOOKUP_KEY] = { sessionId, promise } satisfies SessionLookup;
  return promise;
}

export async function resolveSession(database: AppDatabase, req: express.Request) {
  const headerSessionId = trimText(req.header("x-session-id"));
  const bodySessionId = trimText(req.body?.sessionId);
  const cookieSessionId = getCookieValue(req.header("cookie"), SESSION_COOKIE_NAME);
  const sessionId = headerSessionId || bodySessionId || trimText(cookieSessionId);

  if (!sessionId) return null;
  if (!headerSessionId) return database.getSession(sessionId);

  const session = await lookupHeaderSession(database, req, headerSessionId);
  if (!session) markInvalidSession(req.res);
  return session;
}

/**
 * Marca con x-adaceen-session: invalid toda respuesta a una peticion cuyo
 * x-session-id no vale, tambien en las rutas que no piden sesion (salud,
 * proveedor de entornos...). Las rutas siguen respondiendo igual: como
 * anonimo o con 401.
 */
export function createSessionStateMiddleware(database: AppDatabase): express.RequestHandler {
  return (req, res, next) => {
    const headerSessionId = trimText(req.header("x-session-id"));
    if (!headerSessionId) return next();
    lookupHeaderSession(database, req, headerSessionId)
      .then(
        (session) => {
          if (!session) markInvalidSession(res);
        },
        () => {
          // Base de datos caida: la ruta respondera su propio error.
        },
      )
      .then(() => next());
  };
}

export function buildAuthPayload(session: AppSession, policy: TeacherPolicy | null) {
  return {
    session: {
      id: session.id,
      createdAt: session.createdAt,
      lastSeenAt: session.lastSeenAt,
      kind: session.kind || "browser",
      expiresAt: session.expiresAt ?? null,
      user: session.user,
    },
    policy,
  };
}

export function errorMessage(error: unknown) {
  if (error instanceof z.ZodError) {
    return error.issues.map((issue) => issue.message).join("; ");
  }

  return String(error);
}

export function boundedInteger(value: unknown, fallback: number, min: number, max: number) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.max(min, Math.min(max, Math.round(parsed)));
}

export function getRequestBaseUrl(req: express.Request, configuredBaseUrl = "") {
  const configured = trimText(configuredBaseUrl);
  if (configured) return configured.replace(/\/+$/, "");

  const forwardedProto = trimText(req.header("x-forwarded-proto")).split(",")[0]?.trim();
  const forwardedHost = trimText(req.header("x-forwarded-host")).split(",")[0]?.trim();
  const protocol = forwardedProto || req.protocol || "http";
  const host = forwardedHost || trimText(req.header("host"));
  return host ? `${protocol}://${host}`.replace(/\/+$/, "") : "";
}

const ANONYMOUS_STUDENT: AppSession["user"] = {
  id: "",
  role: "student",
  email: "",
  displayName: "",
  teacherUserId: null,
};

/**
 * Quien hace la peticion, para politica y telemetria: la sesion si existe;
 * si no, el cliente anonimo del piloto (cabecera x-adaceen-client-id).
 */
export async function resolveRequestActor(database: AppDatabase, req: express.Request) {
  const session = await resolveSession(database, req).catch(() => null);
  if (session) {
    return { session, actor: actorFromSession(session) };
  }
  const actor = actorFromClientId(req.header("x-adaceen-client-id"));
  return { session: null, actor };
}

/**
 * Politica que aplica al actor: la de su docente o, sin sesion, la del
 * docente por defecto (con respaldo sin JOIN, que pg-mem no soporta).
 */
export async function resolvePolicyForSession(database: AppDatabase, session: AppSession | null) {
  try {
    const policy = await database.getTeacherPolicyForUser(session?.user || ANONYMOUS_STUDENT);
    if (policy) return policy;
  } catch {
    // se intenta el respaldo
  }
  return database.getFirstTeacherPolicy();
}

import type express from "express";
import { z } from "zod";
import { env, isAzureMode } from "../config/env.js";
import type { AppDatabase, PrivacyAcceptance } from "../db/database.js";
import { verifyGoogleUserFromAccessToken, verifyGoogleUserFromIdToken } from "../services/google-auth.js";
import { trimText } from "../services/text-utils.js";
import {
  ACCESS_REJECTED_MESSAGE,
  pendingApprovalMessage,
  STUDENT_CODE_FORMAT_MESSAGE,
  STUDENT_CODE_LENGTH,
  STUDENT_CODE_REQUIRED_MESSAGE,
  STUDENT_CODE_TOO_MANY_ATTEMPTS_MESSAGE,
  STUDENT_CODE_UNAVAILABLE_MESSAGE,
  type StudentSignInResult,
} from "../services/student-code.js";
import { PRIVACY_POLICY_VERSION, PUBLISHED_PRIVACY_POLICY_VERSIONS } from "./privacy-policy-routes.js";
import { buildAuthPayload, clearInvalidSessionMark, errorMessage, resolveSession, SESSION_COOKIE_NAME } from "./route-utils.js";

// Tipo de la sesion que se abre: browser (overlay, por defecto) o cli
// (scripts de consola). Cada inicio de sesion solo desactiva las de su tipo.
const sessionKindSchema = z.enum(["browser", "cli"]).optional();

// studentCode (0.7.22): el estudiante sin codigo lo manda en el segundo intento (ver
// src/services/student-code.ts). Se valida en resolveStudentSignIn para responder con el paso.
const studentCodeSchema = z.string().max(40).optional();

const loginSchema = z.object({
  email: z.string().email(),
  password: z.string().min(6),
  sessionKind: sessionKindSchema,
  studentCode: studentCodeSchema,
});

const googleLoginSchema = z.object({
  accessToken: z.string().min(20).optional(),
  idToken: z.string().min(20).optional(),
  credential: z.string().min(20).optional(),
  sessionKind: sessionKindSchema,
  studentCode: studentCodeSchema,
}).refine((input) => Boolean(input.accessToken || input.idToken || input.credential), {
  message: "accessToken, idToken o credential es requerido.",
});

// Version de la politica que el cliente acaba de mostrar. Solo se registran
// las publicadas por el servidor: una version inventada ("2099-01-01") no
// puede quedar como constancia de consentimiento.
const privacyAcceptanceSchema = z.object({
  version: z.string().trim().regex(/^[A-Za-z0-9._:-]{1,40}$/, "version invalida.")
    .refine((version) => PUBLISHED_PRIVACY_POLICY_VERSIONS.includes(version), {
      message: `Version de la politica desconocida (la vigente es ${PRIVACY_POLICY_VERSION}).`,
    }),
});

function normalizeEmail(value: string) {
  return trimText(value).toLowerCase();
}

/**
 * Intentos con codigo que no dejaron entrar (formato, codigo de otra cuenta, rechazado), por
 * correo: con cada uno se sabe si un codigo ya tiene cuenta y una pista de su correo, asi que
 * se limitan a STUDENT_CODE_MAX_MISSES cada 15 minutos (en memoria, como los de editor-auth).
 */
const STUDENT_CODE_WINDOW_MS = 15 * 60 * 1000;
const STUDENT_CODE_MAX_MISSES = 6;
const studentCodeMisses = new Map<string, number[]>();

function studentCodeAttemptsBlocked(email: string, now = Date.now()) {
  const recent = (studentCodeMisses.get(email) || []).filter((at) => now - at < STUDENT_CODE_WINDOW_MS);
  if (recent.length) studentCodeMisses.set(email, recent);
  else studentCodeMisses.delete(email);
  return recent.length >= STUDENT_CODE_MAX_MISSES;
}

function recordStudentCodeMiss(email: string, result: StudentSignInResult, now = Date.now()) {
  if (result.status !== "invalid_code" && result.status !== "code_unavailable"
    && result.status !== "pending_approval" && result.status !== "rejected") return;
  const recent = (studentCodeMisses.get(email) || []).filter((at) => now - at < STUDENT_CODE_WINDOW_MS);
  recent.push(now);
  studentCodeMisses.set(email, recent);
  if (studentCodeMisses.size > 5000) {
    // No crece sin limite: se queda con los correos de los ultimos minutos.
    for (const [key, times] of studentCodeMisses) {
      if (!times.some((at) => now - at < STUDENT_CODE_WINDOW_MS)) studentCodeMisses.delete(key);
    }
  }
}

/** resolveStudentSignIn con el limite de intentos (solo cuenta cuando se manda un codigo). */
async function resolveStudentSignInLimited(
  database: AppDatabase,
  input: Parameters<AppDatabase["resolveStudentSignIn"]>[0],
): Promise<StudentSignInResult> {
  const key = normalizeEmail(input.email);
  const sendsCode = input.studentCode != null && trimText(String(input.studentCode)) !== "";
  if (sendsCode && studentCodeAttemptsBlocked(key)) return { status: "too_many_attempts" };
  const result = await database.resolveStudentSignIn(input);
  if (sendsCode) recordStudentCodeMiss(key, result);
  return result;
}

/** Solo pruebas: olvida los intentos contados. */
export function resetStudentCodeAttemptsForTests() {
  studentCodeMisses.clear();
}

/**
 * Respuesta cuando el estudiante todavia no puede entrar (0.7.22): 200 con ok:false y step, para
 * que la extension muestre el paso (escribir el codigo o esperar la aprobacion). Una extension
 * vieja muestra error tal cual, y ese texto le dice que actualice. null si ya puede entrar.
 */
function studentSignInStep(result: StudentSignInResult): { status: number; body: Record<string, unknown> } | null {
  switch (result.status) {
    case "ok":
      return null;
    case "student_code_required":
      return {
        status: 200,
        body: {
          ok: false,
          step: "student_code",
          error: STUDENT_CODE_REQUIRED_MESSAGE,
          displayName: result.displayName,
          email: result.email,
          codeLength: STUDENT_CODE_LENGTH,
        },
      };
    case "invalid_code":
      return { status: 400, body: { ok: false, step: "student_code", error: STUDENT_CODE_FORMAT_MESSAGE, codeLength: STUDENT_CODE_LENGTH } };
    case "code_unavailable":
      return { status: 400, body: { ok: false, step: "student_code", error: STUDENT_CODE_UNAVAILABLE_MESSAGE, codeLength: STUDENT_CODE_LENGTH } };
    case "too_many_attempts":
      return { status: 429, body: { ok: false, step: "student_code", error: STUDENT_CODE_TOO_MANY_ATTEMPTS_MESSAGE } };
    case "pending_approval":
      return {
        status: 200,
        body: {
          ok: false,
          step: "pending_approval",
          error: pendingApprovalMessage(result.maskedEmail),
          maskedEmail: result.maskedEmail,
          requestedAt: result.requestedAt,
        },
      };
    case "rejected":
      return { status: 200, body: { ok: false, step: "rejected", error: ACCESS_REJECTED_MESSAGE } };
    case "inactive":
      return { status: 403, body: { ok: false, error: "El usuario existe pero esta inactivo. Contacta al administrador." } };
  }
}

export function registerAuthRoutes(app: express.Express, database: AppDatabase) {
  const sessionCookieOptions = {
    httpOnly: true,
    sameSite: isAzureMode() ? "none" : "lax",
    secure: isAzureMode(),
    path: "/",
  } as const;

  // Ultima politica aceptada por el usuario. Si la consulta falla el login no
  // se cae: la extension mostrara el modal como si no la hubiera aceptado.
  async function privacyFor(userId: string): Promise<PrivacyAcceptance> {
    try {
      return await database.getPrivacyAcceptance(userId);
    } catch {
      return { version: null, acceptedAt: null };
    }
  }

  app.post("/api/auth/login", async (req, res) => {
    try {
      const parsed = loginSchema.parse(req.body || {});
      const currentSession = await resolveSession(database, req);
      const nextEmail = normalizeEmail(parsed.email);
      const currentEmail = normalizeEmail(currentSession?.user?.email || "");
      if (currentSession && nextEmail && currentEmail && nextEmail !== currentEmail) {
        return res.status(409).json({
          ok: false,
          error: "Primero tienes que salir de la sesion activa.",
        });
      }

      const user = await database.verifyPasswordUser(parsed.email, parsed.password);
      if (!user) {
        return res.status(401).json({ ok: false, error: "Credenciales invalidas." });
      }
      const access = await resolveStudentSignInLimited(database, {
        email: user.email,
        displayName: user.displayName,
        studentCode: parsed.studentCode,
        knownUserId: user.id,
      });
      const step = studentSignInStep(access);
      if (step) return res.status(step.status).json(step.body);
      const userId = access.status === "ok" ? access.userId : user.id;
      const session = await database.openSessionForUser(userId, { kind: parsed.sessionKind === "cli" ? "cli" : "browser" });

      const policy = await database.getTeacherPolicyForUser(session.user);
      const telemetry = session.user.role === "teacher"
        ? await database.listTelemetryForTeacher(session.user.id, 6)
        : [];

      res.cookie(SESSION_COOKIE_NAME, session.id, {
        ...sessionCookieOptions,
      });
      clearInvalidSessionMark(res);

      return res.json({
        ok: true,
        ...buildAuthPayload(session, policy),
        telemetry,
        firstLogin: session.isFirstLogin === true,
        privacy: await privacyFor(session.user.id),
      });
    } catch (error) {
      return res.status(400).json({ ok: false, error: errorMessage(error) });
    }
  });

  app.post("/api/auth/google-login", async (req, res) => {
    try {
      if (!env.googleClientId) {
        return res.status(503).json({ ok: false, error: "Login con Google no configurado en servidor." });
      }
      if (!env.googleDefaultPassword) {
        return res.status(503).json({ ok: false, error: "GOOGLE_DEFAULT_PASSWORD no configurado en servidor." });
      }

      const parsed = googleLoginSchema.parse(req.body || {});
      const rawAccessToken = trimText(parsed.accessToken);
      const rawIdToken = trimText(parsed.idToken || parsed.credential);
      if (!rawAccessToken && !rawIdToken) {
        return res.status(400).json({ ok: false, error: "accessToken o idToken requerido." });
      }

      const googleUser = rawAccessToken
        ? await verifyGoogleUserFromAccessToken(rawAccessToken)
        : await verifyGoogleUserFromIdToken(rawIdToken);
      const currentSession = await resolveSession(database, req);
      const nextEmail = normalizeEmail(googleUser.email);
      const currentEmail = normalizeEmail(currentSession?.user?.email || "");
      // Un correo de acceso extra de la misma cuenta no es otra sesion (0.7.22).
      if (currentSession && nextEmail && currentEmail && nextEmail !== currentEmail
        && (await database.findLoginUserId(nextEmail)) !== currentSession.user.id) {
        return res.status(409).json({
          ok: false,
          error: "Primero tienes que salir de la sesion activa.",
        });
      }

      const access = await resolveStudentSignInLimited(database, {
        email: googleUser.email,
        displayName: googleUser.displayName,
        studentCode: parsed.studentCode,
        create: { defaultPassword: env.googleDefaultPassword },
      });
      const step = studentSignInStep(access);
      if (step) return res.status(step.status).json(step.body);
      if (access.status !== "ok") return res.status(400).json({ ok: false, error: "No se pudo iniciar sesion." });
      const session = await database.openSessionForUser(access.userId, { kind: parsed.sessionKind === "cli" ? "cli" : "browser" });

      const policy = await database.getTeacherPolicyForUser(session.user);
      const telemetry = session.user.role === "teacher"
        ? await database.listTelemetryForTeacher(session.user.id, 6)
        : [];

      res.cookie(SESSION_COOKIE_NAME, session.id, {
        ...sessionCookieOptions,
      });
      clearInvalidSessionMark(res);

      return res.json({
        ok: true,
        ...buildAuthPayload(session, policy),
        telemetry,
        firstLogin: session.isFirstLogin === true,
        privacy: await privacyFor(session.user.id),
      });
    } catch (error) {
      return res.status(400).json({ ok: false, error: errorMessage(error) });
    }
  });

  app.get("/api/auth/me", async (req, res) => {
    try {
      const session = await resolveSession(database, req);
      if (!session) {
        return res.status(401).json({ ok: false, error: "Sesion no valida." });
      }

      const policy = await database.getTeacherPolicyForUser(session.user);
      const telemetry = session.user.role === "teacher"
        ? await database.listTelemetryForTeacher(session.user.id, 6)
        : [];

      return res.json({
        ok: true,
        ...buildAuthPayload(session, policy),
        telemetry,
        privacy: await privacyFor(session.user.id),
      });
    } catch (error) {
      return res.status(500).json({ ok: false, error: String(error) });
    }
  });

  // La extension la llama al pulsar «Aceptar y continuar»: la aceptacion vale
  // para todos los navegadores y equipos del usuario (login y me la devuelven
  // en privacy). Cada version guarda la fecha de su primera aceptacion y
  // privacy es siempre la version mas nueva aceptada.
  app.post("/api/auth/privacy-acceptance", async (req, res) => {
    try {
      const session = await resolveSession(database, req);
      if (!session) {
        return res.status(401).json({ ok: false, error: "Sesion no valida." });
      }
      const parsed = privacyAcceptanceSchema.parse(req.body || {});
      const privacy = await database.savePrivacyAcceptance(session.user.id, parsed.version);
      return res.json({ ok: true, privacy });
    } catch (error) {
      const status = error instanceof z.ZodError ? 400 : 500;
      return res.status(status).json({ ok: false, error: errorMessage(error) });
    }
  });

  app.post("/api/auth/logout", async (req, res) => {
    try {
      const session = await resolveSession(database, req);
      if (session) {
        await database.logoutSession(session.id);
        // Equipos compartidos: salir desvincula tambien VS Code (sesiones
        // editor). El tunel vuelve a escribir una sesion en el siguiente
        // "Abrir mi editor" y la Mac la vuelve a vincular con su boton.
        await database.deactivateEditorSessionsForUser(session.user.id);
        await database.clearActiveTabForUser(session.user.id);
      }
      res.clearCookie(SESSION_COOKIE_NAME, {
        ...sessionCookieOptions,
      });

      return res.json({ ok: true });
    } catch (error) {
      return res.status(500).json({ ok: false, error: String(error) });
    }
  });
}

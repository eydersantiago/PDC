import type express from "express";
import { z } from "zod";
import { env, isAzureMode } from "../config/env.js";
import type { AppDatabase, PrivacyAcceptance } from "../db/database.js";
import { verifyGoogleUserFromAccessToken, verifyGoogleUserFromIdToken } from "../services/google-auth.js";
import { trimText } from "../services/text-utils.js";
import { PRIVACY_POLICY_VERSION, PUBLISHED_PRIVACY_POLICY_VERSIONS } from "./privacy-policy-routes.js";
import { buildAuthPayload, clearInvalidSessionMark, errorMessage, resolveSession, SESSION_COOKIE_NAME } from "./route-utils.js";

// Tipo de la sesion que se abre: browser (overlay, por defecto) o cli
// (scripts de consola). Cada inicio de sesion solo desactiva las de su tipo.
const sessionKindSchema = z.enum(["browser", "cli"]).optional();

const loginSchema = z.object({
  email: z.string().email(),
  password: z.string().min(6),
  sessionKind: sessionKindSchema,
});

const googleLoginSchema = z.object({
  accessToken: z.string().min(20).optional(),
  idToken: z.string().min(20).optional(),
  credential: z.string().min(20).optional(),
  sessionKind: sessionKindSchema,
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

      const session = await database.authenticateUser(parsed.email, parsed.password, { kind: parsed.sessionKind });
      if (!session) {
        return res.status(401).json({ ok: false, error: "Credenciales invalidas." });
      }

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
      if (currentSession && nextEmail && currentEmail && nextEmail !== currentEmail) {
        return res.status(409).json({
          ok: false,
          error: "Primero tienes que salir de la sesion activa.",
        });
      }

      const session = await database.authenticateGoogleUser({
        email: googleUser.email,
        displayName: googleUser.displayName,
        defaultPassword: env.googleDefaultPassword,
        kind: parsed.sessionKind,
      });

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

import type express from "express";
import { z } from "zod";
import { env, isAzureMode } from "../config/env.js";
import type { AppDatabase } from "../db/database.js";
import { verifyGoogleUserFromAccessToken, verifyGoogleUserFromIdToken } from "../services/google-auth.js";
import { trimText } from "../services/text-utils.js";
import { buildAuthPayload, errorMessage, resolveSession, SESSION_COOKIE_NAME } from "./route-utils.js";

const loginSchema = z.object({
  email: z.string().email(),
  password: z.string().min(6),
});

const googleLoginSchema = z.object({
  accessToken: z.string().min(20).optional(),
  idToken: z.string().min(20).optional(),
  credential: z.string().min(20).optional(),
}).refine((input) => Boolean(input.accessToken || input.idToken || input.credential), {
  message: "accessToken, idToken o credential es requerido.",
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

      const session = await database.authenticateUser(parsed.email, parsed.password);
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

      return res.json({
        ok: true,
        ...buildAuthPayload(session, policy),
        telemetry,
        firstLogin: session.isFirstLogin === true,
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
      });

      const policy = await database.getTeacherPolicyForUser(session.user);
      const telemetry = session.user.role === "teacher"
        ? await database.listTelemetryForTeacher(session.user.id, 6)
        : [];

      res.cookie(SESSION_COOKIE_NAME, session.id, {
        ...sessionCookieOptions,
      });

      return res.json({
        ok: true,
        ...buildAuthPayload(session, policy),
        telemetry,
        firstLogin: session.isFirstLogin === true,
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
      });
    } catch (error) {
      return res.status(500).json({ ok: false, error: String(error) });
    }
  });

  app.post("/api/auth/logout", async (req, res) => {
    try {
      const session = await resolveSession(database, req);
      if (session) {
        await database.logoutSession(session.id);
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

import type express from "express";
import { z } from "zod";
import type { AppDatabase } from "../db/database.js";
import type { TeacherPolicy } from "../types/app.js";
import { trimText } from "../services/text-utils.js";

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

export async function resolveSession(database: AppDatabase, req: express.Request) {
  const headerSessionId = trimText(req.header("x-session-id"));
  const bodySessionId = trimText(req.body?.sessionId);
  const cookieSessionId = getCookieValue(req.header("cookie"), SESSION_COOKIE_NAME);
  const sessionId = headerSessionId || bodySessionId || trimText(cookieSessionId);

  if (!sessionId) return null;
  return database.getSession(sessionId);
}

export function buildAuthPayload(session: AppSession, policy: TeacherPolicy | null) {
  return {
    session: {
      id: session.id,
      createdAt: session.createdAt,
      lastSeenAt: session.lastSeenAt,
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

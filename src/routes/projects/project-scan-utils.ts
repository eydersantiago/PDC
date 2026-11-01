// Ayudas de las rutas del escaneo del proyecto: log, id del pedido y autorizacion del worker.
import { randomUUID } from "node:crypto";
import type express from "express";
import { env } from "../../config/env.js";
import type { AppDatabase } from "../../db/database.js";
import { createDiagnosticLogger } from "../../services/shared/diagnostics.js";
import { trimText } from "../../services/shared/text-utils.js";
import { resolveSession } from "../route-utils.js";

export const projectScanLog = createDiagnosticLogger("project-scan-routes");

export function getRequestId(req: express.Request) {
  return trimText(req.header("x-request-id") || req.header("x-correlation-id")) || randomUUID();
}

export function ensureWorkerAuthorized(req: express.Request) {
  const expected = trimText(env.scanWorkerKey);
  if (!expected) return true;
  const provided = trimText(req.header("x-adaceen-worker-key") || req.query.workerKey || "");
  return provided === expected;
}

/** Hay una clave de worker configurada y la peticion la trae (worker dedicado, sin sesion). */
function hasDedicatedWorkerKey(req: express.Request) {
  return Boolean(trimText(env.scanWorkerKey)) && ensureWorkerAuthorized(req);
}

/**
 * Quien puede tocar una solicitud de escaneo (A12.12): la sesion de VS Code del mismo usuario
 * que la pidio o un worker dedicado con SCAN_WORKER_KEY. Antes bastaba el nombre del repo.
 */
export async function resolveScanActor(database: AppDatabase, req: express.Request) {
  const session = await resolveSession(database, req).catch(() => null);
  return { session, dedicatedWorker: !session && hasDedicatedWorkerKey(req) };
}

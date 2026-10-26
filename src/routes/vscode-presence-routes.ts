// La extension ADACEEN de VS Code vista por el backend (25/10/2026): el middleware que anota
// cada llamada de VS Code y la ruta que lo consulta (guia del tunel del navegador 0.8.4).
// Las cabeceras se leen aqui; src/services/vscode-presence.ts solo recibe valores.
import type express from "express";
import type { AppDatabase } from "../db/database.js";
import type { LatestVersionProvider } from "../services/download-versions.js";
import { trimText } from "../services/text-utils.js";
import {
  describeVscodeExtensionForUser,
  editorHostFromHeader,
  editorHostFromWorkerId,
  isEditorHost,
  recordVscodePresence,
  type VscodeClient,
} from "../services/vscode-presence.js";
import { workspaceVmStartupCommand } from "../services/workspace-vm-commands.js";
import { CLIENT_VERSION_HEADER, EDITOR_HOST_HEADER, SESSION_ID_HEADER, WORKER_ID_HEADER } from "./client-headers.js";
import { isStaffRole, resolveSession } from "./route-utils.js";

/**
 * La extension de VS Code que hace esta peticion: el tipo de editor sale de
 * x-adaceen-editor-host (0.0.37) o, en las anteriores, de x-adaceen-worker-id. null si la
 * peticion no es de VS Code (el navegador no manda ninguna de las dos).
 */
export function parseVscodeClientHeaders(req: express.Request): VscodeClient | null {
  const editorHost = editorHostFromHeader(req.header(EDITOR_HOST_HEADER)) ?? editorHostFromWorkerId(req.header(WORKER_ID_HEADER));
  if (!editorHost) return null;
  return { editorHost, version: trimText(req.header(CLIENT_VERSION_HEADER)) || null };
}

/**
 * Anota cada llamada de VS Code con x-session-id valido, en cualquier ruta (va despues de
 * createSessionStateMiddleware y reutiliza su consulta de la sesion). Es informativa: un fallo
 * aqui nunca frena ni rompe la peticion.
 */
export function createVscodePresenceMiddleware(database: AppDatabase): express.RequestHandler {
  return (req, _res, next) => {
    const client = parseVscodeClientHeaders(req);
    if (!client || !trimText(req.header(SESSION_ID_HEADER))) return next();
    resolveSession(database, req)
      .then((session) => {
        if (session) recordVscodePresence(session.user.id, client);
      })
      .catch(() => {
        // Base de datos caida o una sesion rara: la ruta respondera lo suyo.
      })
      .then(() => next());
  };
}

export type VscodePresenceDeps = { latestVscodeVersion: LatestVersionProvider };

/**
 * GET /api/vscode/presence[?editorHost=tunnel|local|codespaces|remote] (con sesion): la extension
 * ADACEEN de VS Code que se vio de este usuario (en ese tipo de editor o, sin tipo, la mas
 * reciente), su version y la publicada en /descargas. La usa el aviso del paso 4 del navegador
 * en vscode.dev (editorHost=tunnel) para decir si la extension ya esta en el editor y si es la
 * ultima. A docentes y administradores les agrega `workspaceVmStartupCommand`: como ponerla al
 * dia en la VM ahora (reinicia los editores abiertos).
 */
export function registerVscodePresenceRoutes(app: express.Express, database: AppDatabase, deps: VscodePresenceDeps) {
  app.get("/api/vscode/presence", async (req, res) => {
    res.setHeader("Cache-Control", "no-store");
    const raw = typeof req.query.editorHost === "string" ? req.query.editorHost.trim().toLowerCase() : "";
    if (raw && !isEditorHost(raw)) {
      return res.status(400).json({ ok: false, error: "editorHost debe ser tunnel, local, codespaces o remote." });
    }
    const editorHost = isEditorHost(raw) ? raw : undefined;
    const session = await resolveSession(database, req).catch(() => null);
    if (!session) {
      return res.status(401).json({ ok: false, error: "Sesion no valida." });
    }
    const report = describeVscodeExtensionForUser(session.user.id, deps.latestVscodeVersion(), { editorHost });
    return res.json({
      ok: true,
      ...report,
      ...(isStaffRole(session.user.role) ? { workspaceVmStartupCommand: workspaceVmStartupCommand() } : {}),
    });
  });
}

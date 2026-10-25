import path from "node:path";
import type express from "express";
import type { AppDatabase } from "../db/database.js";
import { readDownloadVersionsCached } from "../services/download-versions.js";
import { describeVscodeExtension, isVscodeHost, readVscodePresence } from "../services/vscode-presence.js";
import { resolveSession } from "./route-utils.js";

export type VscodePresenceDeps = { rootDir?: string };

/**
 * GET /api/vscode/presence[?host=tunnel|local|codespaces|other] (con sesion): la extension
 * ADACEEN de VS Code que se vio de este usuario (en ese tipo de editor o, sin host, la mas
 * reciente), su version y la publicada en /descargas. La usa el aviso del paso 4 del navegador
 * en vscode.dev (host=tunnel) para decir si la extension ya esta en el editor y si es la ultima.
 */
export function registerVscodePresenceRoutes(app: express.Express, database: AppDatabase, deps: VscodePresenceDeps = {}) {
  const rootDir = () => path.resolve(deps.rootDir || process.cwd());
  app.get("/api/vscode/presence", async (req, res) => {
    res.setHeader("Cache-Control", "no-store");
    const rawHost = typeof req.query.host === "string" ? req.query.host.trim().toLowerCase() : "";
    if (req.query.host !== undefined && !isVscodeHost(rawHost)) {
      return res.status(400).json({ ok: false, error: "host debe ser tunnel, local, codespaces u other." });
    }
    const host = isVscodeHost(rawHost) ? rawHost : undefined;
    const session = await resolveSession(database, req).catch(() => null);
    if (!session) {
      return res.status(401).json({ ok: false, error: "Sesion no valida." });
    }
    const latest = readDownloadVersionsCached(rootDir()).vscode;
    return res.json({ ok: true, ...describeVscodeExtension(readVscodePresence(session.user.id, host), latest) });
  });
}

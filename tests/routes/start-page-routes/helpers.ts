import assert from "node:assert/strict";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { Server } from "node:http";
import express from "express";
import { registerStartPageRoutes, type StartPageDeps } from "../../../src/routes/pages/start-page-routes.js";

/**
 * Pagina de inicio /empezar y descargas (acceso simplificado, seccion 6):
 * HTML propio sin recursos externos, archivos del paquete desplegado y 404
 * amable si faltan. Los paquetes firmados (CRX + manifiesto de actualizacion,
 * XPI de Firefox) y el boton de Chrome Web Store son opcionales: solo salen si
 * existen (docs/operacion/publicar-extension.md).
 */

export const UPDATE_XML = `<?xml version='1.0' encoding='UTF-8'?>
<gupdate xmlns='http://www.google.com/update2/response' protocol='2.0'>
  <app appid='abcdefghijklmnopabcdefghijklmnop'>
    <updatecheck codebase='https://ejemplo.test/descargas/adaceen.crx' version='0.7.11'/>
  </app>
</gupdate>
`;

// chromeWebStoreUrl vacia: la variable CHROME_WEB_STORE_URL del entorno no influye en las pruebas.
export async function startPage(rootDir: string, deps: Omit<StartPageDeps, "rootDir"> = {}) {
  const app = express();
  registerStartPageRoutes(app, { rootDir, chromeWebStoreUrl: "", ...deps });
  const server = await new Promise<Server>((resolve) => {
    const started = app.listen(0, () => resolve(started));
  });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("No se pudo iniciar servidor de prueba.");
  return {
    baseUrl: `http://127.0.0.1:${address.port}`,
    close: () => new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve())),
  };
}

export async function tempRoot() {
  return fsp.mkdtemp(path.join(os.tmpdir(), "adaceen-empezar-"));
}

export async function write(root: string, relative: string, content: string | Buffer) {
  const target = path.join(root, relative);
  await fsp.mkdir(path.dirname(target), { recursive: true });
  await fsp.writeFile(target, content);
}

export function inlineScript(html: string) {
  const match = html.match(/<script nonce="([^"]+)">([\s\S]*?)<\/script>/);
  assert.ok(match, "la pagina trae su script en linea con nonce");
  return { nonce: match[1], code: match[2] };
}

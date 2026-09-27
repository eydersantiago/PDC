// Pagina de respuesta de los callbacks de GitHub (OAuth y GitHub App).
// Movido sin cambios desde src/routes/github-app-routes.ts (solo se agrego "export" y los imports).
import { trimText } from "../services/text-utils.js";

export function escapeHtml(value: string) {
  return trimText(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll("\"", "&quot;")
    .replaceAll("'", "&#39;")
    .replaceAll("`", "&#96;");
}

export function callbackPage(body: string, script = "") {
  return `<!doctype html>
    <html lang="es">
      <head>
        <meta charset="utf-8">
        <meta name="viewport" content="width=device-width, initial-scale=1">
        <title>ADACEEN</title>
      </head>
      <body style="font-family:Segoe UI,sans-serif;padding:24px;line-height:1.4;">
        <h2>ADACEEN</h2>
        ${body}
        ${script}
      </body>
    </html>
  `;
}

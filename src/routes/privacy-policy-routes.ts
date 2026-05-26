import express from "express";
import { env } from "../config/env.js";

const PRIVACY_POLICY_PATH = "/privacy-policy";
export const PRIVACY_POLICY_VERSION = "2026-05-26";

type PrivacyPolicySection = {
  title: string;
  variant?: "notice" | "security";
  paragraphs?: string[];
  items?: string[];
};

type PrivacyPolicyContent = {
  productName: string;
  title: string;
  lead: string;
  canonicalUrl: string;
  updatedAt: string;
  sections: PrivacyPolicySection[];
};

function escapeHtml(value: string) {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function getForwardedHeader(req: express.Request, name: string) {
  return req.header(name)?.split(",")[0]?.trim() || "";
}

export function getPublicBaseUrl(req?: express.Request) {
  if (env.publicApiUrl) return env.publicApiUrl;
  if (env.azureServer) return env.azureServer;
  if (!req) return "";

  const host = getForwardedHeader(req, "x-forwarded-host") || req.get("host") || "";
  if (!host) return "";

  const protocol = getForwardedHeader(req, "x-forwarded-proto") || req.protocol || "https";
  return `${protocol}://${host}`.replace(/\/+$/, "");
}

export function getPrivacyPolicyUrl(req?: express.Request) {
  const baseUrl = getPublicBaseUrl(req);
  return baseUrl ? `${baseUrl}${PRIVACY_POLICY_PATH}` : PRIVACY_POLICY_PATH;
}

function buildPrivacyPolicyContent(params: {
  canonicalUrl: string;
  contactEmail: string;
}): PrivacyPolicyContent {
  const contactLine = params.contactEmail
    ? params.contactEmail
    : "el canal de soporte publicado en la ficha de Chrome Web Store o por la institucion que entrega ADACEEN";

  return {
    productName: "ADACEEN",
    title: "Politica de privacidad y seguridad",
    lead:
      "Esta politica aplica a la extension de Chrome ADACEEN y al backend productivo que atiende sus solicitudes de tutoria contextual.",
    canonicalUrl: params.canonicalUrl,
    updatedAt: PRIVACY_POLICY_VERSION,
    sections: [
      {
        title: "Datos que puede procesar ADACEEN",
        items: [
          "URL, titulo, tipo de pagina y contexto visible de Campus Virtual, GitHub o Codespaces cuando el usuario activa el tutor.",
          "Fragmentos de codigo, texto de actividades, errores visibles y senales necesarias para generar pistas pedagogicas.",
          "Datos de sesion como correo, rol, nombre mostrado, identificador de sesion y politica docente asignada.",
          "Snapshots de proyecto, nombres de archivos, contenido de archivos y metricas educativas cuando el usuario guarda o retoma un proyecto.",
          "Registros tecnicos del servicio, como hora de solicitud, ruta, estado HTTP, origen, agente de usuario e IP aproximada para seguridad y diagnostico.",
        ],
      },
      {
        title: "Como se usan los datos",
        items: [
          "Para entregar pistas, explicaciones guiadas, mini quizzes y acompanamiento pedagogico sin reemplazar el trabajo del estudiante.",
          "Para aplicar las politicas configuradas por el docente y mostrar telemetria educativa del piloto.",
          "Para guardar memoria de proyecto solicitada por el usuario y permitir retomarla entre sesiones.",
          "Para proteger el servicio, detectar abuso, depurar fallos y mantener estabilidad operacional.",
        ],
      },
      {
        title: "Con quien se comparte",
        items: [
          "El backend productivo de ADACEEN desplegado en Azure procesa las solicitudes de la extension.",
          "Servicios administrados de Azure pueden almacenar colas, base de datos, logs y telemetria tecnica necesarios para operar el sistema.",
          "Workers autorizados con Ollama pueden recibir trabajos de IA cuando el modo de cola esta activo.",
          "No vendemos datos, no usamos publicidad personalizada y no transferimos datos a data brokers.",
        ],
      },
      {
        title: "Medidas de seguridad",
        variant: "security",
        items: [
          "La extension se comunica con el backend productivo mediante HTTPS.",
          "La extension no incluye secretos de Azure, cadenas de conexion de base de datos ni credenciales de workers.",
          "Los permisos del manifest se limitan a los sitios necesarios para la funcionalidad del tutor.",
          "Las sesiones pueden cerrarse desde la extension y las preferencias tecnicas se guardan en el almacenamiento local del navegador.",
        ],
      },
      {
        title: "Uso limitado y controles del usuario",
        variant: "notice",
        paragraphs: [
          "El uso de informacion recibida de APIs de Google cumplira la Chrome Web Store User Data Policy, incluyendo los requisitos de Limited Use.",
          `El usuario puede desactivar el tutor, cerrar sesion y borrar los datos locales de la extension desde Chrome. Para solicitudes de acceso, correccion o eliminacion de datos almacenados en el backend, usa ${contactLine}.`,
        ],
      },
    ],
  };
}

function renderPrivacySection(section: PrivacyPolicySection) {
  const className = section.variant ? ` class="${section.variant}"` : "";
  const paragraphs = (section.paragraphs || [])
    .map((paragraph) => `<p>${escapeHtml(paragraph)}</p>`)
    .join("");
  const items = section.items?.length
    ? `<ul>${section.items.map((item) => `<li>${escapeHtml(item)}</li>`).join("")}</ul>`
    : "";

  return `
      <section${className}>
        <h2>${escapeHtml(section.title)}</h2>
        ${items}${paragraphs}
      </section>`;
}

function renderPrivacyPolicyHtml(params: {
  canonicalUrl: string;
  contactEmail: string;
}) {
  const content = buildPrivacyPolicyContent(params);
  const canonicalUrl = escapeHtml(params.canonicalUrl);
  const sectionsHtml = content.sections.map(renderPrivacySection).join("\n");

  return `<!doctype html>
<html lang="es">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>ADACEEN - Politica de privacidad y seguridad</title>
    <style>
      :root {
        color-scheme: light;
        --ink: #172033;
        --muted: #526171;
        --panel: #ffffff;
        --line: #dce4ec;
        --accent: #0f766e;
        --accent-soft: #e3f7f3;
        --warm: #fff7ed;
      }

      * {
        box-sizing: border-box;
      }

      body {
        margin: 0;
        color: var(--ink);
        font-family: system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
        background: #f6f8fb;
      }

      main {
        width: min(920px, calc(100% - 32px));
        margin: 0 auto;
        padding: 40px 0 56px;
      }

      header,
      section {
        border: 1px solid var(--line);
        border-radius: 8px;
        background: var(--panel);
        padding: 22px;
        box-shadow: 0 10px 30px rgba(23, 32, 51, 0.06);
      }

      section {
        margin-top: 14px;
      }

      .eyebrow {
        margin: 0 0 8px;
        color: var(--accent);
        font-size: 0.78rem;
        font-weight: 800;
        letter-spacing: 0.08em;
        text-transform: uppercase;
      }

      h1,
      h2 {
        margin: 0;
        line-height: 1.15;
      }

      h1 {
        font-size: clamp(1.8rem, 4vw, 2.7rem);
      }

      h2 {
        font-size: 1.05rem;
      }

      p,
      li,
      dd {
        color: var(--muted);
        line-height: 1.6;
      }

      .lead {
        max-width: 760px;
        margin: 14px 0 0;
        font-size: 1rem;
      }

      dl {
        display: grid;
        gap: 8px;
        margin: 18px 0 0;
      }

      dt {
        color: var(--ink);
        font-weight: 750;
      }

      dd {
        margin: 0;
        overflow-wrap: anywhere;
      }

      ul {
        margin: 12px 0 0;
        padding-left: 22px;
      }

      a {
        color: #0b635d;
        font-weight: 700;
      }

      .notice {
        border-color: #b9e3dc;
        background: var(--accent-soft);
      }

      .security {
        border-color: #f0d4b7;
        background: var(--warm);
      }
    </style>
  </head>
  <body>
    <main>
      <header>
        <p class="eyebrow">${escapeHtml(content.productName)}</p>
        <h1>${escapeHtml(content.title)}</h1>
        <p class="lead">
          ${escapeHtml(content.lead)}
        </p>
        <dl>
          <dt>URL publica para Chrome Web Store</dt>
          <dd><a href="${canonicalUrl}">${canonicalUrl}</a></dd>
          <dt>Ultima actualizacion</dt>
          <dd>${escapeHtml(content.updatedAt)}</dd>
        </dl>
      </header>
${sectionsHtml}
    </main>
  </body>
</html>`;
}

export function registerPrivacyPolicyRoutes(app: express.Express) {
  app.get([
    PRIVACY_POLICY_PATH,
    "/politica-de-privacidad",
    "/security-policy",
    "/politica-de-seguridad",
  ], (req, res) => {
    res.setHeader("Content-Type", "text/html; charset=utf-8");
    res.setHeader("Cache-Control", "public, max-age=3600");
    res.setHeader("Content-Security-Policy", "default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'; upgrade-insecure-requests");
    res.setHeader("X-Content-Type-Options", "nosniff");
    res.setHeader("Referrer-Policy", "no-referrer");
    res.setHeader("Permissions-Policy", "camera=(), microphone=(), geolocation=(), payment=()");
    res.send(renderPrivacyPolicyHtml({
      canonicalUrl: getPrivacyPolicyUrl(req),
      contactEmail: env.privacyContactEmail,
    }));
  });

  app.get(["/api/privacy-policy", `${PRIVACY_POLICY_PATH}.json`], (req, res) => {
    res.setHeader("Cache-Control", "public, max-age=3600");
    res.json({
      ok: true,
      policy: buildPrivacyPolicyContent({
        canonicalUrl: getPrivacyPolicyUrl(req),
        contactEmail: env.privacyContactEmail,
      }),
    });
  });
}

import express from "express";
import { env } from "../config/env.js";

const PRIVACY_POLICY_PATH = "/privacy-policy";
/**
 * Version vigente (fecha AAAA-MM-DD). 2026-10-11 (navegador 0.7.22): responsable y contacto,
 * codigo de estudiante, Google Calendar, GitHub, servidores del modelo y derechos de la Ley 1581.
 * Cambiarla vuelve a pedir «Aceptar y continuar» a todos (ADACEEN_PRIVACY_POLICY_VERSION de la
 * extension debe ser la misma).
 */
export const PRIVACY_POLICY_VERSION = "2026-10-11";

/**
 * Versiones publicadas de la politica (fechas AAAA-MM-DD), la vigente al
 * final. POST /api/auth/privacy-acceptance solo registra estas: al publicar
 * una version nueva, cambia PRIVACY_POLICY_VERSION y deja aqui las anteriores
 * (una extension desactualizada puede seguir aceptando la suya).
 */
export const PUBLISHED_PRIVACY_POLICY_VERSIONS: readonly string[] = ["2026-05-26", PRIVACY_POLICY_VERSION];

/**
 * Responsable del tratamiento (Ley 1581 de 2012) y contacto. La Chrome Web Store rechazo la
 * politica anterior porque no decia quien responde ni a donde escribir; el correo se puede
 * cambiar con PRIVACY_CONTACT_EMAIL sin desplegar.
 */
export const PRIVACY_CONTROLLER = Object.freeze({
  name: "Eyder Suárez",
  role: "estudiante investigador del proyecto de grado ADACEEN",
  institution: "Universidad del Valle (Cali, Colombia)",
  email: "eyder.suarez@correounivalle.edu.co",
});

const CHROME_EXTENSION_ID = "gkkcnlcbdjdjcibkkbhpopichconbojg";

type PrivacyPolicyBlock = {
  title?: string;
  paragraphs?: string[];
  items?: string[];
};

type PrivacyPolicySection = {
  title: string;
  paragraphs?: string[];
  items?: string[];
  blocks?: PrivacyPolicyBlock[];
};

type PrivacyPolicyContent = {
  productName: string;
  title: string;
  lead: string;
  canonicalUrl: string;
  updatedAt: string;
  effectiveDate: string;
  controller: { name: string; role: string; institution: string; email: string };
  sections: PrivacyPolicySection[];
  englishSummary: string[];
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
  const contactEmail = params.contactEmail || PRIVACY_CONTROLLER.email;
  const controller = { ...PRIVACY_CONTROLLER, email: contactEmail };

  return {
    productName: "ADACEEN",
    title: "Política de privacidad",
    lead:
      "ADACEEN es un tutor de programación para estudiantes de la Universidad del Valle, hecho como proyecto de grado. "
      + "Esta política explica qué datos recoge, para qué, con quién se comparten, cuánto tiempo se guardan y cómo puedes "
      + "conocerlos, corregirlos o pedir que se borren.",
    canonicalUrl: params.canonicalUrl,
    updatedAt: PRIVACY_POLICY_VERSION,
    effectiveDate: "11 de octubre de 2026",
    controller,
    sections: [
      {
        title: "Quién es el responsable",
        paragraphs: [
          `El responsable del tratamiento de los datos es ${controller.name}, ${controller.role}, ${controller.institution}. `
            + `Para cualquier pregunta o solicitud sobre tus datos escribe a ${controller.email}.`,
          `Esta política aplica a la extensión de navegador ADACEEN (Chrome Web Store, id ${CHROME_EXTENSION_ID}), a la extensión `
            + "ADACEEN para VS Code y al servidor de ADACEEN que las atiende. ADACEEN es un proyecto académico: no es un servicio "
            + "comercial, no tiene publicidad y no vende datos.",
        ],
      },
      {
        title: "Qué datos recogemos",
        blocks: [
          {
            title: "Tu cuenta",
            items: [
              "Al entrar con Google: tu nombre y tu correo (permisos userinfo.email y userinfo.profile). Si tu docente te dio un correo y una contraseña, la contraseña se guarda solo como un hash, nunca en texto.",
              "Tu código de estudiante de la Universidad del Valle (7 dígitos). Se pide una vez para que cada persona tenga una sola cuenta: si entras con otro correo y el mismo código, llegas a la misma cuenta. También guardamos los otros correos con los que entras a esa cuenta.",
              "Tu rol (estudiante o docente), tu docente, tus cursos y la versión de esta política que aceptaste.",
            ],
          },
          {
            title: "Lo que ve el tutor cuando lo usas",
            items: [
              "En Campus Virtual (campusvirtual.univalle.edu.co), GitHub (github.com) y tu editor en vscode.dev: la dirección y el título de la página, el texto visible, las actividades y fechas del curso, el código visible, el texto que seleccionas, los errores visibles y el nombre del repositorio, la rama y el archivo.",
              "Una captura de la pestaña de tu editor, solo cuando pulsas «OCR visual».",
              "Si das permiso con «Explorar repo», los archivos de código de tu repositorio (con límites de tamaño y sin los archivos que ignora tu .gitignore ni archivos con claves o contraseñas).",
              "En la extensión de VS Code: un recorte del archivo abierto, la selección, las líneas visibles y los errores del editor, para cada sugerencia.",
              "Tus respuestas a los quices del curso.",
            ],
          },
          {
            title: "GitHub",
            items: [
              "Cuando conectas GitHub: tu usuario y tu correo de GitHub y un permiso de acceso (token OAuth) que el servidor guarda para preparar tu editor en la nube con tu repositorio.",
              "Si tu curso usa GitHub Codespaces: la instalación de la GitHub App de ADACEEN en el repositorio que elijas.",
            ],
          },
          {
            title: "Google Calendar",
            items: [
              "Solo si pulsas «Sincronizar agenda» y das el permiso calendar.events: la extensión crea en tu calendario eventos con las entregas y evaluaciones del curso y, si los pides, bloques de estudio.",
              "Para no duplicar eventos y para proponer bloques en horas libres, la extensión lee los eventos de tu calendario entre hoy y la última evaluación del curso. Esa lectura ocurre solo en tu navegador: los eventos de tu calendario no se envían al servidor de ADACEEN ni se guardan en él.",
            ],
          },
          {
            title: "Uso del tutor y datos técnicos",
            items: [
              "Eventos de uso para la investigación del piloto: qué ayuda se mostró, si la aceptaste o la rechazaste, cuánto tardó y en qué bloque del piloto ocurrió. Se guardan seudonimizados (un código HMAC en lugar de tu identidad), sin el texto de los errores, sin código y sin correos.",
              "Registros técnicos del servidor: hora, ruta, estado de la respuesta, origen, navegador e IP aproximada, para seguridad y diagnóstico.",
              "En tu navegador, en el almacenamiento de la extensión: tu sesión, tus preferencias, un identificador anónimo y la dirección de tu editor en la nube.",
            ],
          },
        ],
      },
      {
        title: "Para qué los usamos",
        items: [
          "Darte pistas y explicaciones sobre tu código y tus actividades, sin resolver el ejercicio por ti, según la política que configuró tu docente.",
          "Que tu docente vea el progreso de sus estudiantes (sesiones, ayudas, quices) y prepare las clases.",
          "Investigación del proyecto de grado: análisis agregado y seudonimizado del piloto. Los resultados que se publiquen no identifican a nadie.",
          "Que cada persona tenga una sola cuenta (código de estudiante) y proteger el servicio: seguridad, abuso y fallos.",
          "No usamos tus datos para publicidad, no los vendemos, no hacemos perfiles comerciales y no los usamos para decidir créditos ni nada ajeno al curso.",
        ],
      },
      {
        title: "Con quién se comparten",
        items: [
          "Tu docente del curso y el administrador del piloto: ven tu nombre, tu correo, tu código de estudiante, tu progreso y tus quices.",
          "Microsoft Azure: aloja el servidor de ADACEEN, su base de datos y sus colas de trabajo.",
          "Google Cloud: aloja la máquina del editor en la nube (tu copia del repositorio) y el servidor del modelo de IA.",
          "Equipos Mac del laboratorio de la Universidad del Valle: pueden ejecutar el modelo de IA cuando el servidor de Google Cloud no está disponible.",
          "Los modelos de IA son de código abierto y corren en esos servidores. La pregunta del tutor se procesa en memoria y no se guarda allí. No enviamos tus datos a proveedores externos de IA.",
          "GitHub y Microsoft (Visual Studio Code y vscode.dev) cuando usas el editor en la nube, y Google cuando entras con Google o sincronizas tu calendario, según las condiciones de cada servicio.",
          "Autoridades, solo si una ley lo exige. No transferimos datos a terceros con fines comerciales ni a intermediarios de datos.",
        ],
      },
      {
        title: "Uso limitado de los datos de Google",
        paragraphs: [
          "El uso y la transferencia a cualquier otra aplicación de la información recibida de las APIs de Google cumplirá la Política de datos de usuario de los servicios de API de Google (Google API Services User Data Policy), incluidos los requisitos de Uso limitado (Limited Use).",
          "Los datos de Google (correo, nombre y calendario) solo se usan para las funciones que ves en ADACEEN. Nadie los lee salvo que tú lo autorices, por seguridad o porque una ley lo exija. ADACEEN también cumple la Política de datos de usuario de la Chrome Web Store.",
        ],
      },
      {
        title: "Cuánto tiempo los guardamos",
        items: [
          "Eventos de uso seudonimizados: como máximo 365 días.",
          "Tu cuenta y los datos del curso (progreso, quices, contexto del proyecto, código de estudiante): mientras dure el piloto y el proyecto de grado, o hasta que pidas borrarlos. Al terminar el proyecto se borran o se anonimizan.",
          "Las sesiones de VS Code vencen a los 30 días. Los eventos creados en tu Google Calendar quedan en tu calendario y los puedes borrar tú.",
        ],
      },
      {
        title: "Cómo los protegemos",
        items: [
          "Todo el tráfico entre la extensión y el servidor va cifrado (HTTPS).",
          "Las contraseñas y los códigos para conectar VS Code se guardan solo como hash. La extensión no incluye claves del servidor ni de la base de datos.",
          "Cada estudiante ve solo sus datos; un docente, solo los de sus estudiantes; el administrador del piloto, los de todos.",
          "Los permisos de la extensión se limitan a los sitios del curso: Campus Virtual, GitHub, vscode.dev y el servidor de ADACEEN.",
        ],
      },
      {
        title: "Tus derechos",
        paragraphs: [
          "Según la Ley 1581 de 2012 y el Decreto 1377 de 2013 de Colombia, puedes conocer los datos que tenemos sobre ti, actualizarlos y corregirlos, pedir que se borren, revocar tu autorización y retirarte del piloto en cualquier momento. "
            + `Escribe a ${controller.email} desde el correo de tu cuenta: respondemos las consultas en máximo 10 días hábiles y los reclamos en máximo 15 días hábiles. `
            + "Si no quedas conforme, puedes acudir a la Superintendencia de Industria y Comercio.",
          "También puedes, sin escribirnos: pausar el tutor en Configuración, cerrar sesión con «Salir», quitar la extensión de Chrome y retirar el acceso de ADACEEN en tu cuenta de Google y en GitHub (Settings, Applications).",
          "ADACEEN está pensado para estudiantes universitarios. Si eres menor de edad, necesitas la autorización de tu representante legal para usarlo.",
        ],
      },
      {
        title: "Cambios en esta política",
        paragraphs: [
          "Si esta política cambia, publicamos la versión nueva en esta misma dirección con su fecha, y la extensión te pide aceptarla de nuevo antes de seguir.",
        ],
      },
    ],
    englishSummary: [
      `Data controller: ${controller.name}, ${controller.role}, ${controller.institution}. Contact: ${controller.email}.`,
      "ADACEEN is an academic programming tutor for Universidad del Valle students. It collects the Google account name and email used to sign in, the student ID number (to keep one account per person), the page content of Campus Virtual, GitHub and vscode.dev when the tutor is used, project code only with explicit permission, GitHub username and OAuth token to set up the cloud editor, quiz answers, pseudonymized usage events and technical server logs.",
      "Google Calendar (calendar.events) is used only when the user syncs the course agenda: the extension creates events and reads events in the course window locally in the browser; calendar events are never sent to or stored on the ADACEEN server.",
      "Data is used only to provide the tutor, to let the course teacher follow progress, for pseudonymized aggregate research, and for security. It is never sold, used for advertising or transferred to data brokers. Processors: Microsoft Azure, Google Cloud and Universidad del Valle lab computers running open-source AI models; no external AI providers receive user data.",
      "ADACEEN's use and transfer of information received from Google APIs will adhere to the Google API Services User Data Policy, including the Limited Use requirements, and to the Chrome Web Store User Data Policy.",
      "Pseudonymized usage events are kept for at most 365 days; account and course data for the duration of the pilot and thesis project or until the user asks for deletion. Users can access, correct or delete their data and withdraw at any time by writing to the contact email.",
    ],
  };
}

function renderList(items: string[] | undefined) {
  return items?.length ? `<ul>${items.map((item) => `<li>${escapeHtml(item)}</li>`).join("")}</ul>` : "";
}

function renderParagraphs(paragraphs: string[] | undefined) {
  return (paragraphs || []).map((paragraph) => `<p>${escapeHtml(paragraph)}</p>`).join("");
}

function renderPrivacySection(section: PrivacyPolicySection, index: number) {
  const blocks = (section.blocks || [])
    .map((block) => `${block.title ? `<h3>${escapeHtml(block.title)}</h3>` : ""}${renderParagraphs(block.paragraphs)}${renderList(block.items)}`)
    .join("");
  return `
      <section>
        <h2><span class="number">${index + 1}.</span> ${escapeHtml(section.title)}</h2>
        ${renderParagraphs(section.paragraphs)}${renderList(section.items)}${blocks}
      </section>`;
}

function renderPrivacyPolicyHtml(params: {
  canonicalUrl: string;
  contactEmail: string;
}) {
  const content = buildPrivacyPolicyContent(params);
  const sectionsHtml = content.sections.map(renderPrivacySection).join("\n");
  const email = escapeHtml(content.controller.email);

  return `<!doctype html>
<html lang="es">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>Política de privacidad de ADACEEN</title>
    <meta name="description" content="Qué datos recoge la extensión ADACEEN, para qué los usa, con quién los comparte y cómo ejercer tus derechos." />
    <link rel="canonical" href="${escapeHtml(content.canonicalUrl)}" />
    <style>
      :root {
        color-scheme: light;
        --ink: #1b2430;
        --muted: #4d5866;
        --line: #d8dee5;
        --accent: #0b5d63;
        --paper: #ffffff;
      }

      * {
        box-sizing: border-box;
      }

      body {
        margin: 0;
        color: var(--ink);
        background: var(--paper);
        font-family: system-ui, -apple-system, "Segoe UI", Roboto, sans-serif;
        font-size: 1rem;
        line-height: 1.6;
      }

      main {
        max-width: 46rem;
        margin: 0 auto;
        padding: 48px 20px 72px;
      }

      header {
        padding-bottom: 20px;
        border-bottom: 1px solid var(--line);
      }

      .product {
        margin: 0;
        color: var(--accent);
        font-weight: 700;
      }

      h1 {
        margin: 4px 0 12px;
        font-size: clamp(1.7rem, 4vw, 2.2rem);
        line-height: 1.2;
      }

      h2 {
        margin: 36px 0 8px;
        font-size: 1.2rem;
        line-height: 1.3;
      }

      h2 .number {
        color: var(--muted);
        font-weight: 600;
      }

      h3 {
        margin: 20px 0 4px;
        font-size: 1rem;
      }

      p,
      li {
        color: var(--muted);
      }

      .meta {
        margin: 12px 0 0;
        font-size: 0.92rem;
      }

      ul {
        margin: 8px 0 0;
        padding-left: 1.3rem;
      }

      li + li {
        margin-top: 6px;
      }

      a {
        color: var(--accent);
      }

      .english {
        margin-top: 44px;
        padding-top: 4px;
        border-top: 1px solid var(--line);
      }

      footer {
        margin-top: 44px;
        padding-top: 16px;
        border-top: 1px solid var(--line);
        font-size: 0.9rem;
      }
    </style>
  </head>
  <body>
    <main>
      <header>
        <p class="product">${escapeHtml(content.productName)}</p>
        <h1>${escapeHtml(content.title)}</h1>
        <p>${escapeHtml(content.lead)}</p>
        <p class="meta">Versión ${escapeHtml(content.updatedAt)}, vigente desde el ${escapeHtml(content.effectiveDate)}. Responsable: ${escapeHtml(content.controller.name)} · <a href="mailto:${email}">${email}</a></p>
      </header>
${sectionsHtml}
      <section class="english" lang="en">
        <h2>Summary in English</h2>
        ${renderList(content.englishSummary)}
      </section>
      <footer>
        <p>Dirección de esta política: <a href="${escapeHtml(content.canonicalUrl)}">${escapeHtml(content.canonicalUrl)}</a></p>
      </footer>
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

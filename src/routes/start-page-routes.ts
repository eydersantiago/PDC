// Pagina de inicio /empezar y descargas (docs/arquitectura/acceso-simplificado.md, seccion 6).
//
//   GET /empezar                                  HTML sin recursos externos: descargas, 4 pasos
//                                                 para cargar la extension, deteccion de la
//                                                 extension y estado del servicio (/api/health).
//   GET /descargas/adaceen-navegador.zip          extension de navegador (zip de empaquetar-extension.mjs)
//   GET /descargas/adaceen.vsix                   extension de VS Code
//   GET /descargas/Preparar-Mac-ADACEEN.zip       instalador de Mac para estudiantes (con permiso de ejecucion)
//   GET /descargas/Preparar-Mac-ADACEEN.command   el mismo instalador suelto
//
// Los archivos salen del paquete desplegado (carpeta descargas/ que arma el
// workflow y vscode-ext-prod/adaceen.vsix); si faltan, 404 con una pagina amable.
// La extension de navegador avisa que esta instalada con un content script
// propio: window.postMessage({ type: "adaceen:extension", version }) y/o
// document.documentElement.dataset.adaceenExtension = version.
import { randomBytes } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import type express from "express";

export type StartPageDeps = {
  /** Raiz del paquete desplegado (por defecto process.cwd(), como el VSIX de github-app.ts). */
  rootDir?: string;
};

type DownloadKey = "navegador" | "vsix" | "macZip" | "macCommand";

type DownloadSpec = {
  path: string;
  fileName: string;
  contentType: string;
  /** Rutas relativas a la raiz, en orden de preferencia. */
  candidates: string[];
  /** Respaldo para desarrollo local: el mas nuevo que cumpla el patron en esa carpeta. */
  newestIn?: { dir: string; pattern: RegExp };
};

const DOWNLOADS: Record<DownloadKey, DownloadSpec> = {
  navegador: {
    path: "/descargas/adaceen-navegador.zip",
    fileName: "adaceen-navegador.zip",
    contentType: "application/zip",
    candidates: ["descargas/adaceen-navegador.zip"],
    newestIn: { dir: "dist/extension", pattern: /^adaceen-chromium-(\d+)\.(\d+)\.(\d+)(?:\.(\d+))?\.zip$/ },
  },
  vsix: {
    path: "/descargas/adaceen.vsix",
    fileName: "adaceen.vsix",
    contentType: "application/octet-stream",
    candidates: ["descargas/adaceen.vsix", "vscode-ext-prod/adaceen.vsix"],
    newestIn: { dir: "vscode-ext-prod", pattern: /^adaceen-(\d+)\.(\d+)\.(\d+)\.vsix$/ },
  },
  macZip: {
    path: "/descargas/Preparar-Mac-ADACEEN.zip",
    fileName: "Preparar-Mac-ADACEEN.zip",
    contentType: "application/zip",
    candidates: ["descargas/Preparar-Mac-ADACEEN.zip"],
  },
  macCommand: {
    path: "/descargas/Preparar-Mac-ADACEEN.command",
    fileName: "Preparar-Mac-ADACEEN.command",
    contentType: "application/octet-stream",
    candidates: ["descargas/Preparar-Mac-ADACEEN.command", "deploy/mac/estudiante/Preparar-Mac-ADACEEN.command"],
  },
};

const VERSION_RE = /^\d+(\.\d+){0,3}$/;

function escapeHtml(value: string) {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function isFile(filePath: string) {
  try {
    return fs.statSync(filePath).isFile();
  } catch {
    return false;
  }
}

function compareVersionParts(left: number[], right: number[]) {
  for (let index = 0; index < Math.max(left.length, right.length); index += 1) {
    const diff = (left[index] || 0) - (right[index] || 0);
    if (diff !== 0) return diff;
  }
  return 0;
}

function newestMatching(dir: string, pattern: RegExp) {
  let best: { file: string; version: number[] } | null = null;
  let names: string[] = [];
  try {
    names = fs.readdirSync(dir);
  } catch {
    return "";
  }
  for (const name of names) {
    const match = name.match(pattern);
    if (!match) continue;
    const version = match.slice(1).filter((part) => part !== undefined).map(Number);
    const file = path.join(dir, name);
    if (!isFile(file)) continue;
    if (!best || compareVersionParts(version, best.version) > 0) best = { file, version };
  }
  return best?.file || "";
}

export function resolveDownloadFile(rootDir: string, key: DownloadKey) {
  const spec = DOWNLOADS[key];
  for (const candidate of spec.candidates) {
    const absolute = path.resolve(rootDir, candidate);
    if (isFile(absolute)) return absolute;
  }
  return spec.newestIn ? newestMatching(path.resolve(rootDir, spec.newestIn.dir), spec.newestIn.pattern) : "";
}

function readJsonFile(filePath: string): Record<string, unknown> | null {
  try {
    const parsed = JSON.parse(fs.readFileSync(filePath, "utf8"));
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed as Record<string, unknown> : null;
  } catch {
    return null;
  }
}

function cleanVersion(value: unknown) {
  const text = typeof value === "string" ? value.trim() : "";
  return VERSION_RE.test(text) ? text : "";
}

/**
 * Versiones de lo que se descarga: descargas/versiones.json (lo escribe el
 * workflow) o, en desarrollo, los manifiestos del repositorio.
 */
export function readDownloadVersions(rootDir: string) {
  const published = readJsonFile(path.resolve(rootDir, "descargas/versiones.json"));
  const manifest = published ? null : readJsonFile(path.resolve(rootDir, "browser-ext-prod/manifest.json"));
  const vscodePackage = published ? null : readJsonFile(path.resolve(rootDir, "vscode-ext-prod/package.json"));
  return {
    navegador: cleanVersion(published?.navegador ?? manifest?.version),
    vscode: cleanVersion(published?.vscode ?? vscodePackage?.version),
  };
}

type PageInput = {
  nonce: string;
  available: Record<DownloadKey, boolean>;
  versions: { navegador: string; vscode: string };
};

function downloadButton(href: string, label: string, detail: string) {
  return `<a class="button" href="${escapeHtml(href)}" download>${escapeHtml(label)}<span class="button-detail">${escapeHtml(detail)}</span></a>`;
}

function unavailable(label: string) {
  return `<p class="unavailable" role="note"><strong>${escapeHtml(label)}:</strong> todavia no esta publicado en este servidor. Avisa al docente.</p>`;
}

export function renderStartPageHtml(input: PageInput) {
  const { nonce, available, versions } = input;
  const navegadorDetail = versions.navegador ? `zip, version ${versions.navegador}` : "zip";
  const vsixDetail = versions.vscode ? `VSIX, version ${versions.vscode}` : "VSIX";
  const macHref = available.macZip ? DOWNLOADS.macZip.path : DOWNLOADS.macCommand.path;
  const macAvailable = available.macZip || available.macCommand;

  return `<!doctype html>
<html lang="es" data-browser-ext-latest="${escapeHtml(versions.navegador)}">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <meta name="referrer" content="no-referrer" />
    <title>ADACEEN - Empezar</title>
    <style>
      :root {
        color-scheme: light;
        --ink: #172033;
        --muted: #4a5868;
        --panel: #ffffff;
        --line: #d5dee8;
        --accent: #0f766e;
        --accent-strong: #0b5f59;
        --accent-soft: #e3f7f3;
        --warn: #8a4b00;
        --warn-soft: #fff4e5;
        --bad: #a3242a;
        --bad-soft: #fdecec;
        --focus: #1d4ed8;
      }

      * {
        box-sizing: border-box;
      }

      body {
        margin: 0;
        color: var(--ink);
        font-family: system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
        font-size: 1rem;
        line-height: 1.55;
        background: #f6f8fb;
      }

      .skip {
        position: absolute;
        left: 12px;
        top: -48px;
        padding: 8px 12px;
        border-radius: 6px;
        background: var(--ink);
        color: #ffffff;
      }

      .skip:focus {
        top: 12px;
      }

      main {
        width: min(880px, calc(100% - 32px));
        margin: 0 auto;
        padding: 32px 0 56px;
      }

      header,
      section {
        border: 1px solid var(--line);
        border-radius: 8px;
        background: var(--panel);
        padding: 20px;
        box-shadow: 0 10px 30px rgba(23, 32, 51, 0.06);
      }

      section {
        margin-top: 14px;
      }

      .eyebrow {
        margin: 0 0 6px;
        color: var(--accent-strong);
        font-size: 0.8rem;
        font-weight: 800;
        letter-spacing: 0.08em;
        text-transform: uppercase;
      }

      h1,
      h2 {
        margin: 0;
        line-height: 1.2;
      }

      h1 {
        font-size: clamp(1.7rem, 5vw, 2.5rem);
      }

      h2 {
        font-size: 1.15rem;
      }

      p,
      li {
        color: var(--muted);
      }

      .lead {
        margin: 12px 0 0;
        max-width: 720px;
      }

      a {
        color: var(--accent-strong);
        font-weight: 700;
      }

      a:focus-visible,
      button:focus-visible {
        outline: 3px solid var(--focus);
        outline-offset: 2px;
      }

      code {
        padding: 1px 5px;
        border-radius: 4px;
        background: #eef2f6;
        color: var(--ink);
        font-size: 0.95em;
        overflow-wrap: anywhere;
      }

      .status {
        display: grid;
        gap: 10px;
        margin: 14px 0 0;
        padding: 0;
        list-style: none;
      }

      .status li {
        display: flex;
        flex-wrap: wrap;
        align-items: baseline;
        gap: 6px 10px;
        border: 1px solid var(--line);
        border-radius: 8px;
        padding: 10px 12px;
        color: var(--ink);
      }

      .badge {
        display: inline-block;
        min-width: 88px;
        border-radius: 999px;
        padding: 2px 10px;
        background: #eef2f6;
        color: var(--ink);
        font-size: 0.85rem;
        font-weight: 800;
        text-align: center;
      }

      .status li[data-state="ok"] {
        border-color: #b9e3dc;
        background: var(--accent-soft);
      }

      .status li[data-state="ok"] .badge {
        background: var(--accent-strong);
        color: #ffffff;
      }

      .status li[data-state="warn"] {
        border-color: #f0d4b7;
        background: var(--warn-soft);
      }

      .status li[data-state="warn"] .badge {
        background: var(--warn);
        color: #ffffff;
      }

      .status li[data-state="bad"] {
        border-color: #f2c4c6;
        background: var(--bad-soft);
      }

      .status li[data-state="bad"] .badge {
        background: var(--bad);
        color: #ffffff;
      }

      .status-text {
        flex: 1 1 260px;
      }

      .actions {
        display: flex;
        flex-wrap: wrap;
        gap: 10px;
        margin: 14px 0 0;
      }

      .button,
      button {
        display: inline-flex;
        flex-direction: column;
        justify-content: center;
        min-height: 44px;
        border: 0;
        border-radius: 8px;
        padding: 10px 16px;
        background: var(--accent-strong);
        color: #ffffff;
        font: inherit;
        font-weight: 800;
        text-decoration: none;
        cursor: pointer;
      }

      button.secondary {
        display: inline-flex;
        min-height: 36px;
        margin-left: 4px;
        padding: 4px 12px;
        border: 1px solid var(--accent-strong);
        background: #ffffff;
        color: var(--accent-strong);
      }

      .button-detail {
        font-size: 0.8rem;
        font-weight: 600;
        opacity: 0.9;
      }

      ol.steps {
        margin: 14px 0 0;
        padding-left: 24px;
      }

      ol.steps li {
        margin-bottom: 10px;
      }

      .note,
      .unavailable {
        margin: 12px 0 0;
        border-radius: 8px;
        padding: 10px 12px;
        background: #f1f5f9;
        font-size: 0.95rem;
      }

      .unavailable {
        background: var(--warn-soft);
        color: var(--ink);
      }

      footer {
        margin-top: 18px;
        text-align: center;
        font-size: 0.9rem;
      }

      .sr-only {
        position: absolute;
        width: 1px;
        height: 1px;
        margin: -1px;
        overflow: hidden;
        clip: rect(0 0 0 0);
        white-space: nowrap;
        border: 0;
      }

      @media (max-width: 520px) {
        header,
        section {
          padding: 16px;
        }

        .button {
          width: 100%;
        }
      }
    </style>
  </head>
  <body>
    <a class="skip" href="#paso-navegador">Saltar a los pasos</a>
    <main>
      <header>
        <p class="eyebrow">ADACEEN</p>
        <h1>Empieza con ADACEEN</h1>
        <p class="lead">
          ADACEEN es tu tutor de programacion: te da pistas en GitHub y en VS Code sin resolverte el ejercicio.
          Haz el paso 1 una sola vez en cada navegador; lo demas lo prepara ADACEEN.
        </p>
      </header>

      <section aria-labelledby="estado-titulo">
        <h2 id="estado-titulo">Estado</h2>
        <ul class="status" aria-live="polite">
          <li id="estado-extension" data-state="checking">
            <span class="badge">Buscando</span>
            <span class="status-text"><strong>Extension del navegador:</strong> <span data-role="text">comprobando si esta instalada...</span></span>
          </li>
          <li id="estado-editor" data-state="checking">
            <span class="badge">Consultando</span>
            <span class="status-text"><strong>Editor en la nube:</strong> <span data-role="text">consultando el servicio...</span></span>
          </li>
          <li id="estado-modelo" data-state="checking">
            <span class="badge">Consultando</span>
            <span class="status-text"><strong>Tutor (modelo):</strong> <span data-role="text">consultando el servicio...</span></span>
          </li>
        </ul>
      </section>

      <section id="paso-navegador" aria-labelledby="paso-navegador-titulo">
        <h2 id="paso-navegador-titulo">1. Instala la extension del navegador</h2>
        <p>Funciona en Chrome, Edge y otros navegadores basados en Chromium.</p>
        <div class="actions">
          ${available.navegador ? downloadButton(DOWNLOADS.navegador.path, "Descargar la extension", navegadorDetail) : unavailable("La extension del navegador")}
        </div>
        <ol class="steps">
          <li>Descomprime el archivo descargado (doble clic). Queda una carpeta <code>adaceen-navegador</code>; dejala donde no la borres.</li>
          <li>Abre una pestana nueva y escribe <code>chrome://extensions</code> en la barra de direcciones (en Edge, <code>edge://extensions</code>).
            <button type="button" class="secondary" data-copy="chrome://extensions">Copiar direccion</button></li>
          <li>Activa <strong>Modo de desarrollador</strong> (arriba a la derecha; en Edge, abajo a la izquierda).</li>
          <li>Pulsa <strong>Cargar descomprimida</strong> (o <strong>Cargar extension sin empaquetar</strong>), elige la carpeta <code>adaceen-navegador</code> y vuelve a esta pagina: en Estado veras la extension instalada.</li>
        </ol>
        <p class="note">Para actualizarla: descarga el zip de nuevo, reemplaza la carpeta y pulsa el boton de recargar de ADACEEN en <code>chrome://extensions</code>.</p>
      </section>

      <section aria-labelledby="paso-github-titulo">
        <h2 id="paso-github-titulo">2. Entra y abre tu editor</h2>
        <ol class="steps">
          <li>Abre tu repositorio del curso en <a href="https://github.com" rel="noreferrer">github.com</a> y pulsa el icono de ADACEEN en la barra del navegador. En Chrome, recien cargada, la extension queda dentro del menu de extensiones (el icono de <strong>pieza de rompecabezas</strong>): abrelo y pulsa ADACEEN, o fijala con el alfiler para tener el icono siempre a la vista.</li>
          <li>Inicia sesion con tu cuenta de ADACEEN. La primera vez lee la politica de privacidad y pulsa <strong>Aceptar y continuar</strong>.</li>
          <li>Pulsa <strong>Conectar GitHub</strong>. ADACEEN prepara tu editor y lo abre.</li>
          <li>La primera vez GitHub te pide un codigo de un solo uso para autorizar el editor. Otro dia basta con <strong>Abrir mi editor</strong>.</li>
        </ol>
      </section>

      <section aria-labelledby="paso-vscode-titulo">
        <h2 id="paso-vscode-titulo">3. VS Code en este equipo (opcional)</h2>
        <p>Solo si trabajas con VS Code instalado (por ejemplo, en las Mac del laboratorio). En el editor en la nube no hace falta.</p>
        <div class="actions">
          ${macAvailable ? downloadButton(macHref, "Preparar Mac del laboratorio", available.macZip ? "zip con el instalador" : "instalador") : unavailable("El instalador de Mac")}
          ${available.vsix ? downloadButton(DOWNLOADS.vsix.path, "Descargar extension de VS Code", vsixDetail) : unavailable("La extension de VS Code")}
        </div>
        <ol class="steps">
          <li><strong>Mac:</strong> descomprime el zip y haz doble clic en <code>Preparar-Mac-ADACEEN.command</code>. Si macOS no lo deja abrir, haz clic derecho sobre el archivo y elige <strong>Abrir</strong>; en macOS 15 o posterior ve a <strong>Ajustes del Sistema &rarr; Privacidad y seguridad</strong> y pulsa <strong>Abrir igualmente</strong>. Es una vez por equipo.</li>
          <li><strong>Otro equipo:</strong> en VS Code abre Extensiones, pulsa el menu <strong>...</strong> y elige <strong>Instalar desde VSIX</strong> con el archivo descargado.</li>
          <li>Para vincular VS Code con tu cuenta usa <strong>Abrir en VS Code de este equipo</strong> en el overlay, o en VS Code <strong>ADACEEN: Conectar</strong> con tu cuenta de GitHub.</li>
        </ol>
      </section>

      <footer>
        <a href="/privacy-policy">Politica de privacidad y seguridad</a>
      </footer>
      <p id="aviso" class="sr-only" aria-live="polite"></p>
    </main>
    <script nonce="${escapeHtml(nonce)}">
      (function () {
        "use strict";
        var VERSION_RE = /^\\d+(\\.\\d+){0,3}$/;
        var root = document.documentElement;
        var latest = root.getAttribute("data-browser-ext-latest") || "";
        var extensionFound = false;

        function setStatus(id, state, badge, text) {
          var item = document.getElementById(id);
          if (!item) return;
          item.setAttribute("data-state", state);
          item.querySelector(".badge").textContent = badge;
          item.querySelector("[data-role=text]").textContent = text;
        }

        function versionParts(value) {
          return String(value).split(".").map(function (part) { return Number(part) || 0; });
        }

        function isOlder(version, reference) {
          var a = versionParts(version);
          var b = versionParts(reference);
          for (var i = 0; i < Math.max(a.length, b.length); i += 1) {
            var diff = (a[i] || 0) - (b[i] || 0);
            if (diff !== 0) return diff < 0;
          }
          return false;
        }

        function showExtension(rawVersion) {
          var version = VERSION_RE.test(String(rawVersion || "")) ? String(rawVersion) : "";
          extensionFound = true;
          if (version && latest && isOlder(version, latest)) {
            setStatus("estado-extension", "warn", "Actualizar",
              "instalada (version " + version + "). Hay una version nueva (" + latest + "): descarga el zip, reemplaza la carpeta y recarga la extension.");
            return;
          }
          setStatus("estado-extension", "ok", "Instalada", version ? "lista (version " + version + ")." : "lista.");
        }

        function readMarker() {
          var marker = root.dataset ? root.dataset.adaceenExtension : "";
          if (marker) showExtension(marker);
        }

        window.addEventListener("message", function (event) {
          if (event.source !== window || !event.data || event.data.type !== "adaceen:extension") return;
          showExtension(event.data.version);
        });
        readMarker();
        if (window.MutationObserver) {
          new MutationObserver(readMarker).observe(root, { attributes: true, attributeFilter: ["data-adaceen-extension"] });
        }
        window.setTimeout(function () {
          if (!extensionFound) {
            setStatus("estado-extension", "warn", "No detectada",
              "no la encontramos en este navegador. Sigue el paso 1; si ya la instalaste, recarga esta pagina.");
          }
        }, 3000);

        function renderHealth(health) {
          var provider = String(health.workspace_provider || "");
          if (provider === "tunnel") {
            var online = health.workspace_agent_online === true;
            if (health.workspace_agent_transport === "relay" && online) {
              setStatus("estado-editor", "ok", "Encendido", "listo para preparar tu editor.");
            } else if (health.workspace_agent_transport === "relay" && health.workspace_vm_autostart === true) {
              setStatus("estado-editor", "ok", "En reposo", "apagado por ahora; se enciende solo cuando preparas tu editor (1-2 min).");
            } else if (health.workspace_agent_transport === "relay") {
              setStatus("estado-editor", "warn", "Apagado", "la VM de editores esta apagada. Avisa al docente.");
            } else {
              setStatus("estado-editor", "ok", "Configurado", "editor en la nube configurado.");
            }
          } else {
            setStatus("estado-editor", "ok", "Codespaces", "el editor se prepara con GitHub Codespaces desde el overlay.");
          }

          // Solo se alarma si el backend vio latidos y todos vencieron: sin
          // token de latidos, o recien reiniciado (el registro vive en
          // memoria), 0 equipos no significa que el tutor este caido.
          var alive = Number(health.model_workers_alive) || 0;
          if (health.mode === "queue" && alive > 0) {
            setStatus("estado-modelo", "ok", "Disponible", alive === 1 ? "1 equipo atendiendo." : alive + " equipos atendiendo.");
          } else if (health.mode === "queue" && health.model_workers_known_down === true) {
            setStatus("estado-modelo", "warn", "Sin equipos", "los equipos del modelo dejaron de responder; las respuestas pueden fallar. Avisa al docente.");
          } else if (health.mode === "queue") {
            setStatus("estado-modelo", "ok", "Configurado", "modelo configurado; todavia no hay latidos recientes de los equipos.");
          } else if (health.target_mode_valid === false) {
            setStatus("estado-modelo", "bad", "Revisar", "la configuracion del modelo no es valida. Avisa al docente.");
          } else {
            setStatus("estado-modelo", "ok", "Configurado", "modelo configurado.");
          }
        }

        function healthFailed() {
          setStatus("estado-editor", "bad", "Sin datos", "no se pudo consultar el servicio. Recarga en un momento.");
          setStatus("estado-modelo", "bad", "Sin datos", "no se pudo consultar el servicio. Recarga en un momento.");
        }

        if (window.fetch) {
          window.fetch("/api/health", { headers: { Accept: "application/json" }, cache: "no-store", credentials: "omit" })
            .then(function (response) { return response.ok ? response.json() : Promise.reject(new Error("HTTP " + response.status)); })
            .then(renderHealth, healthFailed);
        } else {
          healthFailed();
        }

        Array.prototype.forEach.call(document.querySelectorAll("[data-copy]"), function (button) {
          button.addEventListener("click", function () {
            var value = button.getAttribute("data-copy") || "";
            var aviso = document.getElementById("aviso");
            var done = function (ok) {
              button.textContent = ok ? "Copiado" : "Copialo a mano";
              if (aviso) aviso.textContent = ok ? "Direccion copiada. Pegala en una pestana nueva." : "No se pudo copiar; escribela a mano.";
              window.setTimeout(function () { button.textContent = "Copiar direccion"; }, 2500);
            };
            if (navigator.clipboard && navigator.clipboard.writeText) {
              navigator.clipboard.writeText(value).then(function () { done(true); }, function () { done(false); });
            } else {
              done(false);
            }
          });
        });
      })();
    </script>
  </body>
</html>`;
}

function renderMissingDownloadHtml(fileName: string) {
  return `<!doctype html>
<html lang="es">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>ADACEEN - Descarga no disponible</title>
    <style>
      body { margin: 0; color: #172033; font-family: system-ui, -apple-system, "Segoe UI", sans-serif; background: #f6f8fb; line-height: 1.55; }
      main { width: min(640px, calc(100% - 32px)); margin: 48px auto; padding: 22px; border: 1px solid #d5dee8; border-radius: 8px; background: #ffffff; }
      h1 { margin: 0 0 8px; font-size: 1.4rem; }
      p { color: #4a5868; }
      a { color: #0b5f59; font-weight: 700; }
      code { overflow-wrap: anywhere; }
    </style>
  </head>
  <body>
    <main>
      <h1>Esta descarga todavia no esta disponible</h1>
      <p>El archivo <code>${escapeHtml(fileName)}</code> no esta publicado en este servidor. Avisa al docente; mientras tanto puedes volver a la pagina de inicio.</p>
      <p><a href="/empezar">Volver a Empezar con ADACEEN</a></p>
    </main>
  </body>
</html>`;
}

function setPageSecurityHeaders(res: express.Response, nonce = "") {
  res.setHeader("Content-Type", "text/html; charset=utf-8");
  res.setHeader("Cache-Control", "no-store");
  res.setHeader(
    "Content-Security-Policy",
    `default-src 'none'; script-src ${nonce ? `'nonce-${nonce}'` : "'none'"}; style-src 'unsafe-inline'; connect-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'`,
  );
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("Referrer-Policy", "no-referrer");
  res.setHeader("Permissions-Policy", "camera=(), microphone=(), geolocation=(), payment=()");
}

export function registerStartPageRoutes(app: express.Express, deps: StartPageDeps = {}) {
  const rootDir = () => path.resolve(deps.rootDir || process.cwd());

  app.get("/empezar", (_req, res) => {
    const root = rootDir();
    const nonce = randomBytes(16).toString("base64");
    setPageSecurityHeaders(res, nonce);
    res.send(renderStartPageHtml({
      nonce,
      available: {
        navegador: Boolean(resolveDownloadFile(root, "navegador")),
        vsix: Boolean(resolveDownloadFile(root, "vsix")),
        macZip: Boolean(resolveDownloadFile(root, "macZip")),
        macCommand: Boolean(resolveDownloadFile(root, "macCommand")),
      },
      versions: readDownloadVersions(root),
    }));
  });

  const byPath = new Map(Object.entries(DOWNLOADS).map(([key, spec]) => [spec.path, key as DownloadKey]));
  app.get([
    "/descargas/adaceen-navegador.zip",
    "/descargas/adaceen.vsix",
    "/descargas/Preparar-Mac-ADACEEN.zip",
    "/descargas/Preparar-Mac-ADACEEN.command",
  ], (req, res) => {
    const key = byPath.get(req.path);
    const spec = key ? DOWNLOADS[key] : null;
    const filePath = key ? resolveDownloadFile(rootDir(), key) : "";
    if (!spec || !filePath) {
      setPageSecurityHeaders(res);
      return res.status(404).send(renderMissingDownloadHtml(spec?.fileName || "solicitado"));
    }
    res.setHeader("X-Content-Type-Options", "nosniff");
    // root = carpeta del archivo: send solo revisa el nombre (no la ruta completa) contra dotfiles.
    return res.sendFile(path.basename(filePath), {
      root: path.dirname(filePath),
      headers: {
        "Content-Type": spec.contentType,
        "Content-Disposition": `attachment; filename="${spec.fileName}"`,
        // Siempre se revalida: al desplegar una version nueva se descarga la nueva.
        "Cache-Control": "no-cache",
      },
    }, (error) => {
      if (error && !res.headersSent) {
        setPageSecurityHeaders(res);
        res.status(404).send(renderMissingDownloadHtml(spec.fileName));
      }
    });
  });
}

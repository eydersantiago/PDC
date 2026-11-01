// HTML de la pagina /empezar (pasos, estado, descargas) y de la descarga no disponible.
import { type ChromeWebStoreStatus } from "../../services/extensions/chrome-web-store.js";
import { type DownloadKey, DOWNLOADS } from "./start-page-downloads.js";

function escapeHtml(value: string) {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

type PolicyInfo = { id: string; manifestUrl: string };

type PageInput = {
  nonce: string;
  available: Record<DownloadKey, boolean>;
  versions: { navegador: string; vscode: string };
  /** Id y manifiesto del CRX publicado, o null si no hay CRX ni XML. */
  policy?: PolicyInfo | null;
  /** Tienda y version publicada (describeChromeWebStore); sin ella, solo el zip. */
  store?: ChromeWebStoreStatus | null;
  /** Horario del tutor (GPU_SCHEDULE) y si de noche se enciende al pedir ayuda (28-10-2026). */
  schedule?: { text: string; autostart: boolean } | null;
};

function scheduleStatusItem(schedule: PageInput["schedule"]) {
  if (!schedule) return "";
  const night = schedule.autostart
    ? "De noche está apagado: si pides ayuda se enciende solo y tarda 2 o 3 minutos; espera y vuelve a preguntar."
    : "Fuera de ese horario puede no responder.";
  return `
          <li id="estado-horario" data-state="ok">
            <span class="badge">Horario</span>
            <span class="status-text"><strong>Horario del tutor:</strong> <span data-role="text">responde al instante todos los días ${escapeHtml(schedule.text)}. ${escapeHtml(night)}</span></span>
          </li>`;
}

function downloadButton(href: string, label: string, detail: string) {
  return `<a class="button" href="${escapeHtml(href)}" download>${escapeHtml(label)}<span class="button-detail">${escapeHtml(detail)}</span></a>`;
}

// Sin el atributo download: Firefox instala el XPI al abrirlo y la tienda se abre como pagina.
function linkButton(href: string, label: string, detail: string, options: { external?: boolean } = {}) {
  const rel = options.external ? " rel=\"noreferrer noopener\"" : "";
  return `<a class="button" href="${escapeHtml(href)}"${rel}>${escapeHtml(label)}<span class="button-detail">${escapeHtml(detail)}</span></a>`;
}

function unavailable(label: string) {
  return `<p class="unavailable" role="note"><strong>${escapeHtml(label)}:</strong> todavia no esta publicado en este servidor. Avisa al docente.</p>`;
}

// La tienda se abre en otra pestana: al volver, el script recarga /empezar para que el
// content script de la extension recien agregada avise que esta instalada.
function storeButton(url: string, label: string, detail: string) {
  return `<a class="button" id="boton-tienda" href="${escapeHtml(url)}" target="_blank" rel="noreferrer noopener">${escapeHtml(label)}<span class="button-detail">${escapeHtml(detail)}</span></a>`;
}

function chromeWebStoreNote() {
  return `<p class="note">Desde la tienda basta con pulsar <strong>Agregar a Chrome</strong> y confirmar: no hay que descomprimir nada ni activar el modo de desarrollador, y se actualiza sola. En Edge acepta antes <strong>Permitir extensiones de otras tiendas</strong>. Los pasos de abajo son para el zip, si la tienda no esta disponible en tu navegador.</p>`;
}

// La carpeta del zip tiene el mismo id que la tienda (campo key del manifest): son la misma
// extension y Chrome no deja tener las dos.
function replaceManualNote() {
  return `<p class="note">Si ya la tenias cargada con el zip, quitala primero en <code>chrome://extensions</code> (boton <strong>Quitar</strong> de ADACEEN): es la misma extension y, mientras este la manual, la tienda la muestra como ya agregada.</p>`;
}

function zipActions(available: boolean, detail: string) {
  return available ? downloadButton(DOWNLOADS.navegador.path, "Descargar la extension", detail) : unavailable("La extension del navegador");
}

function zipSteps() {
  return `<ol class="steps">
          <li>Descomprime el archivo descargado (doble clic). Queda una carpeta <code>adaceen-navegador</code>; dejala donde no la borres.</li>
          <li>Abre una pestana nueva y escribe <code>chrome://extensions</code> en la barra de direcciones (en Edge, <code>edge://extensions</code>).
            <button type="button" class="secondary" data-copy="chrome://extensions">Copiar direccion</button></li>
          <li>Activa <strong>Modo de desarrollador</strong> (arriba a la derecha; en Edge, abajo a la izquierda).</li>
          <li>Pulsa <strong>Cargar descomprimida</strong> (o <strong>Cargar extension sin empaquetar</strong>), elige la carpeta <code>adaceen-navegador</code> y vuelve a esta pagina: en Estado veras la extension instalada.</li>
        </ol>
        <p class="note">Para actualizarla: descarga el zip de nuevo, reemplaza la carpeta y pulsa el boton de recargar de ADACEEN en <code>chrome://extensions</code>.</p>`;
}

/** Paso 1 segun la tienda: principal (tienda + desplegable manual), atrasada, desconocida o sin tienda. */
function browserStepBody(store: ChromeWebStoreStatus | null, zipAvailable: boolean, zipDetail: string) {
  const mode = store?.mode || "desactivada";
  if (store && mode === "principal") {
    return `<p>Chrome, Edge y otros navegadores basados en Chromium la instalan desde la Chrome Web Store; en Firefox, ver mas abajo.</p>
        <div class="actions">
          ${storeButton(store.url, "Agregar ADACEEN a Chrome", `Chrome Web Store, version ${store.version}`)}
        </div>
        <ol class="steps">
          <li>Pulsa <strong>Agregar ADACEEN a Chrome</strong>: la ficha de ADACEEN se abre en una pestana nueva de la Chrome Web Store.</li>
          <li>Alli pulsa <strong>Agregar a Chrome</strong> y confirma con <strong>Agregar extension</strong>. En Edge acepta antes <strong>Permitir extensiones de otras tiendas</strong>.</li>
          <li>Vuelve a esta pestana: se recarga sola y en Estado veras la extension instalada. Desde la tienda se actualiza sola.</li>
        </ol>
        ${replaceManualNote()}
        <details class="manual" id="instalacion-manual">
          <summary>Instalacion manual con el zip (alternativa)</summary>
          <p>Solo si la tienda no abre en tu navegador o no te deja agregarla.</p>
          <div class="actions">
            ${zipActions(zipAvailable, zipDetail)}
          </div>
          ${zipSteps()}
        </details>`;
  }
  const intro = `<p>Funciona en Chrome, Edge y otros navegadores basados en Chromium; en Firefox, ver mas abajo.</p>`;
  if (store && mode === "atrasada") {
    return `${intro}
        <p class="note" id="tienda-atrasada">La Chrome Web Store todavia tiene la version ${escapeHtml(store.version)} de ADACEEN y la vigente es la ${escapeHtml(store.minimum)}. Mientras Google aprueba la nueva, instalala con el zip; cuando la tienda se ponga al dia, esta pagina te llevara alla.</p>
        <div class="actions">
          ${zipActions(zipAvailable, zipDetail)}
        </div>
        ${zipSteps()}`;
  }
  if (store && mode === "desconocida") {
    return `${intro}
        <div class="actions">
          ${storeButton(store.url, "Instalar desde Chrome Web Store", "Chrome y Edge, sin modo de desarrollador")}
          ${zipActions(zipAvailable, zipDetail)}
        </div>
        ${chromeWebStoreNote()}
        ${zipSteps()}`;
  }
  return `${intro}
        <div class="actions">
          ${zipActions(zipAvailable, zipDetail)}
        </div>
        ${zipSteps()}`;
}

function policyNote(policy: PolicyInfo) {
  const forcelist = `${policy.id};${policy.manifestUrl}`;
  return `<p class="note" id="politica-laboratorio"><strong>Instalacion por politica (equipos del laboratorio):</strong> en los equipos que administra Sistemas, Chrome y Edge instalan y actualizan ADACEEN solos con la politica <code>ExtensionInstallForcelist</code> y el valor <code>${escapeHtml(forcelist)}</code> (id de la extension <code>${escapeHtml(policy.id)}</code>; manifiesto de actualizacion <code>${escapeHtml(policy.manifestUrl)}</code>; paquete firmado <a href="${escapeHtml(DOWNLOADS.crx.path)}" download>adaceen.crx</a>). Como aplicarla: <code>docs/operacion/publicar-extension.md</code> del repositorio.</p>`;
}

function firefoxBlock(available: boolean, version: string) {
  if (available) {
    const detail = version ? `instalacion permanente, version ${version}` : "instalacion permanente";
    return `<div class="actions">${linkButton(DOWNLOADS.firefox.path, "Instalar en Firefox", detail)}</div>
        <p class="note">Firefox avisa que este sitio quiere instalar un complemento: pulsa <strong>Permitir</strong> y luego <strong>Agregar</strong>. Queda instalada de forma permanente (no hay que repetirlo al cerrar Firefox) y se actualiza sola. En Firefox no hay inicio de sesion con Google: entra con tu correo y contrasena.</p>`;
  }
  return `<p class="note">Firefox (128 o superior): este servidor todavia no publica el paquete firmado para instalarla de forma permanente. Pide a tu docente <code>adaceen-firefox-&lt;version&gt;.zip</code>, abre <code>about:debugging</code>, entra en <strong>Este Firefox</strong> y pulsa <strong>Cargar complemento temporal...</strong> con ese zip. Se quita al cerrar Firefox, asi que repitelo en cada sesion. Entra con tu correo y contrasena: no hay inicio de sesion con Google.</p>`;
}

export function renderStartPageHtml(input: PageInput) {
  const { nonce, available, versions } = input;
  const schedule = input.schedule || null;
  const policy = input.policy || null;
  const store = input.store || null;
  const navegadorDetail = versions.navegador ? `zip, version ${versions.navegador}` : "zip";
  const vsixDetail = versions.vscode ? `VSIX, version ${versions.vscode}` : "VSIX";
  const macHref = available.macZip ? DOWNLOADS.macZip.path : DOWNLOADS.macCommand.path;
  const macAvailable = available.macZip || available.macCommand;

  return `<!doctype html>
<html lang="es" data-browser-ext-latest="${escapeHtml(versions.navegador)}" data-browser-ext-store="${escapeHtml(store?.mode === "principal" ? store.version : "")}">
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

      h3 {
        margin: 18px 0 0;
        font-size: 1rem;
        line-height: 1.3;
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

      #aviso-actualizando {
        margin: 14px 0 0;
        border-radius: 8px;
        padding: 10px 12px;
        background: var(--warn-soft);
        color: var(--ink);
        font-weight: 700;
      }

      #tienda-atrasada {
        background: var(--warn-soft);
        color: var(--ink);
      }

      details.manual {
        margin: 16px 0 0;
        border: 1px solid var(--line);
        border-radius: 8px;
        padding: 0 14px;
      }

      details.manual[open] {
        padding-bottom: 14px;
      }

      details.manual > summary {
        display: flex;
        align-items: center;
        gap: 10px;
        min-height: 44px;
        padding: 8px 0;
        color: var(--ink);
        font-weight: 800;
        cursor: pointer;
        list-style: none;
      }

      details.manual > summary::-webkit-details-marker {
        display: none;
      }

      /* Con display: flex el navegador no dibuja el triangulo: se dibuja aqui. */
      details.manual > summary::before {
        content: "";
        flex: none;
        border-top: 5px solid transparent;
        border-bottom: 5px solid transparent;
        border-left: 7px solid var(--accent-strong);
        transition: transform 0.15s ease;
      }

      details.manual[open] > summary::before {
        transform: rotate(90deg);
      }

      details.manual > summary:focus-visible {
        outline: 3px solid var(--focus);
        outline-offset: 2px;
      }

      details.manual > p:first-of-type {
        margin-top: 0;
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

      <p id="aviso-actualizando" role="status" hidden></p>

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
          </li>${scheduleStatusItem(schedule)}
        </ul>
      </section>

      <section id="paso-navegador" aria-labelledby="paso-navegador-titulo">
        <h2 id="paso-navegador-titulo">1. Instala la extension del navegador</h2>
        ${browserStepBody(store, available.navegador, navegadorDetail)}
        ${policy ? policyNote(policy) : ""}
        <h3 id="paso-firefox-titulo">Firefox</h3>
        ${firefoxBlock(available.firefox, versions.navegador)}
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
        // Con la tienda como camino principal (0.8.0), quien tiene la version de la tienda esta al
        // dia aunque el zip sea mas nuevo: la tienda se actualiza sola cuando Google aprueba.
        var storeVersion = root.getAttribute("data-browser-ext-store") || "";
        var extensionFound = false;
        // Tras abrir la tienda (otra pestana), al volver se recarga la pagina: el content
        // script de una extension recien agregada solo llega a las pestanas que se cargan despues.
        var STORE_FLAG = "adaceen-tienda-abierta";
        var storeLink = document.getElementById("boton-tienda");

        function storeOpened() {
          try {
            return window.sessionStorage.getItem(STORE_FLAG) === "1";
          } catch (error) {
            return false;
          }
        }

        function rememberStore(opened) {
          try {
            if (opened) window.sessionStorage.setItem(STORE_FLAG, "1");
            else window.sessionStorage.removeItem(STORE_FLAG);
          } catch (error) {
            // Sin sessionStorage la pagina no se recarga sola: el texto pide recargar.
          }
        }

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
          rememberStore(false);
          var reference = storeVersion && latest && isOlder(storeVersion, latest) ? storeVersion : latest;
          if (version && reference && isOlder(version, reference)) {
            setStatus("estado-extension", "warn", "Actualizar",
              "instalada (version " + version + "). Hay una version nueva (" + reference + "): si la cargaste con el zip, descargalo de nuevo, reemplaza la carpeta y recarga la extension; desde la tienda, Firefox o la politica del laboratorio se actualiza sola.");
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
            setStatus("estado-extension", "warn", "No detectada", storeOpened()
              ? "todavia no la vemos. Cuando termines en la Chrome Web Store vuelve a esta pestana: se recarga sola."
              : "no la encontramos en este navegador. Sigue el paso 1; si ya la instalaste, recarga esta pagina.");
          }
        }, 3000);

        if (storeLink) {
          storeLink.addEventListener("click", function () { rememberStore(true); });
          var reloadAfterStore = function () {
            if (!extensionFound && storeOpened() && document.visibilityState !== "hidden") window.location.reload();
          };
          document.addEventListener("visibilitychange", reloadAfterStore);
          window.addEventListener("pageshow", function (event) {
            if (event && event.persisted) reloadAfterStore();
          });
        }

        // /empezar#instalacion-manual abre el desplegable de la instalacion con el zip.
        var manual = document.getElementById("instalacion-manual");
        var openManualFromHash = function () {
          if (manual && window.location && window.location.hash === "#instalacion-manual") manual.open = true;
        };
        openManualFromHash();
        window.addEventListener("hashchange", openManualFromHash);

        function renderHealth(health) {
          // Aviso «Estamos actualizando» (28-10-2026): mientras dure, arriba de todo.
          var aviso = document.getElementById("aviso-actualizando");
          if (aviso && health.maintenance && health.maintenance.active) {
            aviso.textContent = String(health.maintenance.message || "Estamos actualizando ADACEEN.");
            aviso.hidden = false;
          }
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
          var gpu = health.gpu_autostart || {};
          if (health.mode === "queue" && alive > 0) {
            setStatus("estado-modelo", "ok", "Disponible", alive === 1 ? "1 equipo atendiendo." : alive + " equipos atendiendo.");
          } else if (health.mode === "queue" && gpu.enabled === true && gpu.within_schedule === false) {
            // De noche, apagado es lo normal: se enciende cuando alguien pide ayuda.
            setStatus("estado-modelo", "ok", "En reposo", "apagado de noche; se enciende solo cuando pides ayuda (2 o 3 minutos).");
          } else if (health.mode === "queue" && health.model_workers_known_down === true && gpu.enabled === true) {
            setStatus("estado-modelo", "warn", "Encendiendo", "ningún equipo responde ahora; al pedir ayuda se enciende (2 o 3 minutos).");
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

export function renderMissingDownloadHtml(fileName: string) {
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

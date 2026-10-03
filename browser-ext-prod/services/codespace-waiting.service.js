// ADACEEN | Capa 3 - Servicios: ventana de espera mientras se prepara el Codespace (abrirla y actualizarla).
// Movido sin cambios desde services/github.service.js.
// Orden de carga: manifest.json (content_scripts) y background.js (CONTENT_SCRIPT_FILES) deben coincidir.
"use strict";

function openCodespaceWaitingWindow(repoFullName) {
  const pendingWindow = window.open("about:blank", "_blank");
  if (!pendingWindow) return null;

  try {
    const repo = escapeWaitingPageText(repoFullName || "repositorio");
    const versionLabel = escapeWaitingPageText(ADACEEN_BROWSER_EXTENSION_LABEL);
    const slides = buildCodespaceWaitingSlides(repoFullName);
    const slidesMarkup = renderCodespaceWaitingSlidesMarkup(slides);
    const dotsMarkup = renderCodespaceWaitingDotsMarkup(slides);
    const lakeBackgroundUrl = escapeWaitingPageCssUrl(getExtensionResourceUrl("assets/codespace-bg-lake.png"));
    const mountainBackgroundUrl = escapeWaitingPageCssUrl(getExtensionResourceUrl("assets/codespace-bg-mountains.png"));
    const tunnel = typeof isTunnelProvider === "function" && isTunnelProvider();
    const waitTitle = tunnel ? "ADACEEN abriendo tu editor" : "ADACEEN preparando Codespace";
    const waitHeading = tunnel ? "ADACEEN esta preparando tu editor" : "ADACEEN esta preparando tu Codespace";
    const waitDetail = tunnel
      ? "Estamos encendiendo tu editor en la nube (VS Code en el navegador) y esperando a que este listo."
      : "Estamos creando o reutilizando la PR, iniciando Codespaces y esperando la URL lista.";
    pendingWindow.document.open();
    pendingWindow.document.write(`<!doctype html>
<html>
<head>
  <meta charset="utf-8">
  <title>${waitTitle}</title>
  <style>
    :root { color-scheme: dark; }
    * { box-sizing: border-box; }
    body {
      margin: 0;
      min-height: 100vh;
      display: flex;
      align-items: center;
      justify-content: flex-start;
      padding: clamp(18px, 5vw, 64px);
      font-family: Segoe UI, Arial, sans-serif;
      background: #06131b;
      color: #f8fbff;
      overflow-x: hidden;
    }
    .wait-background {
      position: fixed;
      inset: 0;
      z-index: 0;
      overflow: hidden;
      background: #06131b;
      pointer-events: none;
    }
    .wait-background::after {
      content: "";
      position: absolute;
      inset: 0;
      background:
        linear-gradient(90deg, rgba(3, 11, 17, 0.9) 0%, rgba(5, 17, 24, 0.78) 43%, rgba(8, 31, 42, 0.48) 72%, rgba(4, 16, 24, 0.68) 100%),
        linear-gradient(180deg, rgba(3, 12, 18, 0.14) 0%, rgba(3, 12, 18, 0.75) 100%);
    }
    .wait-bg {
      position: absolute;
      inset: 0;
      background-position: center;
      background-size: cover;
      opacity: 0;
      transform: scale(1.025);
      animation-duration: 18s;
      animation-iteration-count: infinite;
      animation-timing-function: ease-in-out;
    }
    .wait-bg-lake {
      background-image: url("${lakeBackgroundUrl}");
      animation-name: waitBgLake;
    }
    .wait-bg-mountains {
      background-image: url("${mountainBackgroundUrl}");
      animation-name: waitBgMountains;
    }
    main {
      position: relative;
      z-index: 1;
      width: min(720px, 100%);
      border: 1px solid rgba(220, 246, 250, 0.26);
      border-radius: 8px;
      background: rgba(6, 19, 28, 0.72);
      padding: clamp(18px, 3vw, 28px);
      box-shadow: 0 24px 70px rgba(0, 0, 0, 0.42);
      backdrop-filter: blur(16px) saturate(125%);
    }
    .wait-version {
      display: inline-flex;
      align-items: center;
      width: fit-content;
      max-width: 100%;
      margin-bottom: 14px;
      padding: 5px 9px;
      border: 1px solid rgba(255, 223, 170, 0.48);
      border-radius: 7px;
      background: rgba(255, 198, 94, 0.16);
      color: #ffe7b7;
      font-size: 12px;
      font-weight: 800;
      overflow-wrap: anywhere;
      text-shadow: 0 1px 2px rgba(0, 0, 0, 0.42);
    }
    .row { display: grid; grid-template-columns: 36px 1fr; align-items: center; gap: 14px; }
    .spinner {
      width: 28px;
      height: 28px;
      border: 4px solid rgba(230, 252, 255, 0.28);
      border-top-color: #76efe5;
      border-radius: 999px;
      animation: spin 0.8s linear infinite;
      flex: 0 0 auto;
    }
    h1 {
      margin: 0 0 6px;
      color: #ffffff;
      font-size: 20px;
      line-height: 1.2;
      text-shadow: 0 2px 8px rgba(0, 0, 0, 0.45);
    }
    p {
      margin: 0;
      color: #d9eaf0;
      line-height: 1.45;
      text-shadow: 0 1px 4px rgba(0, 0, 0, 0.38);
    }
    .phase {
      display: inline-flex;
      align-items: center;
      width: fit-content;
      margin-top: 14px;
      padding: 5px 9px;
      border: 1px solid rgba(141, 244, 232, 0.42);
      border-radius: 999px;
      color: #c9fff8;
      background: rgba(12, 95, 91, 0.34);
      font-size: 12px;
      font-weight: 700;
      text-shadow: 0 1px 2px rgba(0, 0, 0, 0.45);
    }
    .phase[hidden] { display: none; }
    .steps {
      display: grid;
      grid-template-columns: repeat(4, minmax(0, 1fr));
      gap: 6px;
      margin: 14px 0 0;
      padding: 0;
      list-style: none;
      counter-reset: step;
    }
    .steps li {
      counter-increment: step;
      padding: 8px 10px;
      border: 1px solid rgba(224, 248, 250, 0.18);
      border-radius: 8px;
      background: rgba(5, 17, 24, 0.5);
      color: #b9d7df;
      font-size: 12px;
      font-weight: 700;
      line-height: 1.3;
    }
    .steps li + li { margin-top: 0; }
    .steps li::before {
      content: counter(step) ". ";
      color: #76efe5;
    }
    .steps li.is-done {
      color: #9ff0c6;
      border-color: rgba(159, 240, 198, 0.4);
    }
    .steps li.is-done::before { content: "\\2713  "; color: #9ff0c6; }
    .steps li.is-current {
      color: #06131b;
      background: #76efe5;
      border-color: #76efe5;
    }
    .steps li.is-current::before { color: #06131b; }
    .repo {
      margin-top: 12px;
      padding: 10px;
      border-radius: 8px;
      border: 1px solid rgba(153, 231, 224, 0.24);
      background: rgba(214, 255, 250, 0.1);
      color: #c9fff8;
      font-weight: 700;
      overflow-wrap: anywhere;
      text-shadow: 0 1px 2px rgba(0, 0, 0, 0.44);
    }
    .content {
      margin-top: 18px;
      border: 1px solid rgba(224, 248, 250, 0.2);
      border-radius: 8px;
      overflow: hidden;
      background: rgba(5, 17, 24, 0.48);
    }
    .progress-track {
      height: 4px;
      background: rgba(232, 252, 255, 0.16);
    }
    .progress-bar {
      width: 0;
      height: 100%;
      background: #76efe5;
      transition: width 180ms ease;
    }
    .panel-wrap {
      min-height: 184px;
      padding: 18px 18px 14px;
    }
    .wait-panel { display: none; }
    .wait-panel.is-active { display: block; }
    .panel-eyebrow {
      margin-bottom: 6px;
      color: #ffd08a;
      font-size: 12px;
      font-weight: 800;
      letter-spacing: 0;
      text-transform: uppercase;
      text-shadow: 0 1px 2px rgba(0, 0, 0, 0.48);
    }
    h2 {
      margin: 0 0 10px;
      color: #ffffff;
      font-size: 18px;
      line-height: 1.25;
      text-shadow: 0 2px 8px rgba(0, 0, 0, 0.42);
    }
    ul {
      margin: 0;
      padding-left: 20px;
      color: #e3f1f5;
      line-height: 1.5;
      text-shadow: 0 1px 4px rgba(0, 0, 0, 0.38);
    }
    li::marker { color: #76efe5; }
    li + li { margin-top: 6px; }
    .dot-row {
      display: flex;
      gap: 8px;
      padding: 0 18px 16px;
    }
    .wait-dot {
      width: 28px;
      height: 8px;
      border: 0;
      border-radius: 999px;
      background: rgba(235, 252, 255, 0.26);
      cursor: pointer;
    }
    .wait-dot.is-active { background: #76efe5; }
    .manual-actions {
      display: flex;
      flex-wrap: wrap;
      gap: 10px;
      margin-top: 16px;
    }
    .manual-link {
      display: none;
      width: fit-content;
      max-width: 100%;
      padding: 10px 14px;
      border-radius: 8px;
      background: #dffffb;
      color: #07353b;
      font-weight: 700;
      text-decoration: none;
      box-shadow: 0 12px 28px rgba(0, 0, 0, 0.28);
    }
    .manual-link.secondary {
      border: 1px solid rgba(231, 249, 253, 0.24);
      background: rgba(8, 25, 35, 0.76);
      color: #eefbff;
    }
    @media (max-width: 860px) {
      body { justify-content: center; }
    }
    @media (max-width: 560px) {
      .steps { grid-template-columns: repeat(2, minmax(0, 1fr)); }
      body { align-items: stretch; padding: 12px; }
      main { padding: 18px; }
      .row { grid-template-columns: 1fr; }
      .panel-wrap { min-height: 220px; }
    }
    @media (prefers-reduced-motion: reduce) {
      .wait-bg { animation: none; transform: none; }
      .wait-bg-lake { opacity: 1; }
      .wait-bg-mountains { opacity: 0; }
    }
    @keyframes waitBgLake {
      0%, 42% { opacity: 1; transform: scale(1.025); }
      50%, 92% { opacity: 0; transform: scale(1.05); }
      100% { opacity: 1; transform: scale(1.025); }
    }
    @keyframes waitBgMountains {
      0%, 42% { opacity: 0; transform: scale(1.05); }
      50%, 92% { opacity: 1; transform: scale(1.025); }
      100% { opacity: 0; transform: scale(1.05); }
    }
    @keyframes spin { to { transform: rotate(360deg); } }
  </style>
</head>
<body>
  <div class="wait-background" aria-hidden="true">
    <span class="wait-bg wait-bg-lake"></span>
    <span class="wait-bg wait-bg-mountains"></span>
  </div>
  <main>
    <div class="wait-version">${versionLabel}</div>
    <div class="row">
      <span class="spinner" aria-hidden="true"></span>
      <div>
        <h1 id="adaceenWaitTitle">${waitHeading}</h1>
        <p id="adaceenWaitDetail">${waitDetail}</p>
      </div>
    </div>
    <div class="phase" id="adaceenWaitPhase"${tunnel ? " hidden" : ""}>Automatizacion activa</div>
    ${tunnel ? `<ol class="steps" id="adaceenWaitSteps" aria-label="Pasos para abrir tu editor">
      <li data-adaceen-wait-step="account">Tu cuenta de GitHub</li>
      <li data-adaceen-wait-step="start">Encender y clonar</li>
      <li data-adaceen-wait-step="authorize">Autorizar (solo la 1.ª vez)</li>
      <li data-adaceen-wait-step="open">Abrir VS Code</li>
    </ol>` : ""}
    <div class="repo">${repo}</div>
    <div class="content">
      <div class="progress-track" aria-hidden="true"><div class="progress-bar" id="adaceenWaitProgress"></div></div>
      <div class="panel-wrap" id="adaceenWaitPanels">${slidesMarkup}</div>
      <div class="dot-row" id="adaceenWaitDots">${dotsMarkup}</div>
    </div>
    <div class="manual-actions">
      <a class="manual-link" id="adaceenOpenCodespaceLink" href="#" rel="noopener noreferrer">Abrir Codespace ahora</a>
      <a class="manual-link secondary" id="adaceenOpenQuickstartLink" href="#" rel="noopener noreferrer">Abrir selector de Codespaces</a>
    </div>
  </main>
</body>
</html>`);
    pendingWindow.document.close();
    hydrateCodespaceWaitingWindow(pendingWindow);
  } catch {
    // Si el navegador impide escribir en la ventana, igual conservamos el handle para redirigirla.
  }

  return pendingWindow;
}

// Editor en la nube: marca en la ventana de espera el paso en curso (los anteriores quedan
// hechos). account -> start -> authorize (solo la primera vez) -> open.
const TUNNEL_WAIT_STEPS = ["account", "start", "authorize", "open"];

function setTunnelWaitingStep(pendingWindow, step) {
  const index = TUNNEL_WAIT_STEPS.indexOf(step);
  if (!pendingWindow || pendingWindow.closed || index < 0) return false;
  try {
    const items = Array.from(pendingWindow.document.querySelectorAll("[data-adaceen-wait-step]"));
    for (const item of items) {
      const itemIndex = TUNNEL_WAIT_STEPS.indexOf(item.getAttribute("data-adaceen-wait-step"));
      item.classList.toggle("is-done", itemIndex < index);
      item.classList.toggle("is-current", itemIndex === index);
      if (itemIndex === index) item.setAttribute("aria-current", "step");
      else item.removeAttribute("aria-current");
    }
    return items.length > 0;
  } catch {
    // La ventana navego a otro origen (GitHub, vscode.dev): ahi no se escribe.
    return false;
  }
}

function updateCodespaceWaitingSlides(pendingWindow, repoFullName) {
  if (!pendingWindow || pendingWindow.closed) return;

  try {
    const slides = buildCodespaceWaitingSlides(repoFullName);
    const slidesMarkup = renderCodespaceWaitingSlidesMarkup(slides);
    const dotsMarkup = renderCodespaceWaitingDotsMarkup(slides);
    const panelsMount = pendingWindow.document.getElementById("adaceenWaitPanels");
    const dotsMount = pendingWindow.document.getElementById("adaceenWaitDots");
    if (panelsMount) panelsMount.innerHTML = slidesMarkup;
    if (dotsMount) dotsMount.innerHTML = dotsMarkup;
    hydrateCodespaceWaitingWindow(pendingWindow);
  } catch {
    // La ventana puede haber navegado fuera de nuestro origen.
  }
}

// La primera vez la ventana de espera es la del OAuth, que termina en el callback del backend
// (otro origen): no se puede escribir en ella, asi que el texto le llega por postMessage y la
// pagina del callback lo muestra (ADACEEN_WAIT_UPDATE, src/routes/github-app-routes.ts). Solo
// se entrega si la ventana sigue en el origen del backend.
function postCodespaceWaitingUpdate(pendingWindow, title, detail) {
  try {
    const origin = new URL(normalizeBaseUrl(overlayState.backendUrl)).origin;
    pendingWindow.postMessage({ type: "ADACEEN_WAIT_UPDATE", title, detail }, origin);
  } catch {
    // Sin backend valido o ventana cerrada: nada que avisar.
  }
}

function updateCodespaceWaitingWindow(pendingWindow, title, detail, directUrl = "", quickstartUrl = "") {
  if (!pendingWindow || pendingWindow.closed) return;

  const nextTitle = toText(title) || "ADACEEN esta preparando tu Codespace";
  const nextDetail = toText(detail) || "GitHub sigue preparando el contenedor.";
  let written = false;
  try {
    const titleEl = pendingWindow.document.getElementById("adaceenWaitTitle");
    const detailEl = pendingWindow.document.getElementById("adaceenWaitDetail");
    const phaseEl = pendingWindow.document.getElementById("adaceenWaitPhase");
    const directLink = pendingWindow.document.getElementById("adaceenOpenCodespaceLink");
    const quickstartLink = pendingWindow.document.getElementById("adaceenOpenQuickstartLink");
    written = Boolean(titleEl);
    if (titleEl) titleEl.textContent = nextTitle;
    if (detailEl) detailEl.textContent = nextDetail;
    if (phaseEl) {
      if (/abriendo|redirig/i.test(nextTitle) || /redirig/i.test(nextDetail)) {
        phaseEl.textContent = "Redireccionando";
      } else if (/no confirmado|limite|bloque/i.test(nextTitle) || /detuvo|manual|limite|bloque/i.test(nextDetail)) {
        phaseEl.textContent = "Requiere revision";
      } else if (/buscando/i.test(nextTitle)) {
        phaseEl.textContent = "Buscando Codespace";
      } else if (/esperando|estado/i.test(nextTitle)) {
        phaseEl.textContent = "Esperando a GitHub";
      } else {
        phaseEl.textContent = "Automatizacion activa";
      }
    }
    // A12.8: los enlaces vienen del backend; solo se aceptan http/https (nunca javascript:).
    if (directLink) {
      const href = toSafeHttpUrl(directUrl);
      directLink.style.display = href ? "inline-block" : "none";
      if (href) directLink.href = href;
    }
    if (quickstartLink) {
      const href = toSafeHttpUrl(quickstartUrl);
      quickstartLink.style.display = href ? "inline-block" : "none";
      if (href) quickstartLink.href = href;
    }
  } catch {
    // La ventana navego fuera de nuestro origen: no se puede escribir en ella.
  }
  if (!written) postCodespaceWaitingUpdate(pendingWindow, nextTitle, nextDetail);
}

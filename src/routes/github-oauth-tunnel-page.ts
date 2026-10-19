// Pagina que ve el estudiante justo despues de autorizar a ADACEEN en GitHub, con el editor en
// la nube (0.8.0). Es la misma ventana que la extension usa para esperar su editor: muestra los
// cuatro pasos de la primera vez con los nombres de la extension (FIRST_TIME_STEP_LABELS en
// browser-ext-prod/services/codespace-waiting.service.js) y el paso en curso, que la extension
// manda por postMessage. La sirve el backend, asi que tambien guia a quien tiene una version
// anterior de la extension (0.7.22 de la tienda): si en unos segundos no llega ningun aviso de
// la extension, dice exactamente que pulsar.
import { escapeHtml } from "./github-callback-page.js";

export const FIRST_TIME_STEPS = [
  { id: "account", label: "Tu cuenta de GitHub" },
  { id: "start", label: "Encender tu editor" },
  { id: "authorize", label: "Autorizar tu editor" },
  { id: "open", label: "Entrar a VS Code" },
] as const;

/** Si en este tiempo no llega ningun aviso de la extension, se muestra que pulsar. */
export const TUNNEL_CALLBACK_FALLBACK_MS = 12_000;

export function tunnelCallbackStepsMarkup(current: (typeof FIRST_TIME_STEPS)[number]["id"]) {
  const index = FIRST_TIME_STEPS.findIndex((step) => step.id === current);
  return FIRST_TIME_STEPS.map((step, itemIndex) => {
    const state = itemIndex < index ? "is-done" : itemIndex === index ? "is-current" : "";
    const aria = itemIndex === index ? ' aria-current="step"' : "";
    return `<li data-adaceen-wait-step="${step.id}" class="${state}"${aria}>${itemIndex + 1}. ${step.label}</li>`;
  }).join("");
}

/**
 * Cuerpo y estilos de la pagina (sin <html>: va dentro de callbackPage). Los ids
 * adaceenWaitTitle y adaceenWaitDetail son los que actualiza callbackWaitUpdateScript.
 */
export function tunnelCallbackBody(input: { login: string; scopes: string }) {
  return `
    <style>
      body { background: #f3f6fa; color: #172033; }
      .adaceen-card { max-width: 640px; background: #ffffff; border: 1px solid #d5dee8; border-radius: 12px; padding: 18px 20px; }
      .adaceen-ok { margin: 0 0 4px; color: #166534; font-weight: 700; }
      .adaceen-account { margin: 0; color: #4a5868; font-size: 14px; }
      .adaceen-steps { display: flex; flex-wrap: wrap; gap: 6px; margin: 14px 0; padding: 0; list-style: none; }
      .adaceen-steps li { padding: 4px 10px; border-radius: 999px; border: 1px solid #d5dee8; color: #4a5868; font-size: 13px; font-weight: 700; }
      .adaceen-steps li.is-done { color: #166534; border-color: #9fd8b4; background: #e7f6ec; }
      .adaceen-steps li.is-done::before { content: "\\2713  "; }
      .adaceen-steps li.is-current { color: #ffffff; background: #0f766e; border-color: #0f766e; }
      .adaceen-step { margin: 0 0 4px; color: #0b5f59; font-size: 13px; font-weight: 800; text-transform: uppercase; letter-spacing: 0.02em; }
      #adaceenWaitTitle { margin: 0 0 6px; font-size: 19px; }
      #adaceenWaitDetail { margin: 0; color: #172033; }
      .adaceen-keep { margin: 12px 0 0; color: #4a5868; font-size: 14px; }
      .adaceen-fallback { margin: 14px 0 0; padding: 10px 12px; border-radius: 8px; background: #fff4e5; color: #8a4b00; border: 1px solid #f0c48a; }
    </style>
    <section class="adaceen-card" aria-live="polite">
      <p class="adaceen-ok">GitHub conectado correctamente para ADACEEN.</p>
      <p class="adaceen-account"><strong>Cuenta:</strong> ${escapeHtml(input.login || "GitHub")} · <strong>Permisos:</strong> ${escapeHtml(input.scopes || "(sin scopes reportados)")}</p>
      <ol class="adaceen-steps" aria-label="Pasos de la primera vez">${tunnelCallbackStepsMarkup("start")}</ol>
      <p class="adaceen-step" id="adaceenWaitStep">Paso 2 de 4 · ${FIRST_TIME_STEPS[1].label}</p>
      <h3 id="adaceenWaitTitle">ADACEEN esta preparando tu editor. Esta ventana se usara para abrirlo automaticamente.</h3>
      <p id="adaceenWaitDetail"></p>
      <p class="adaceen-keep">No cierres esta ventana: aquí sigue el paso 3 (un código de GitHub, solo la primera vez) y luego se abre tu editor.</p>
      <p class="adaceen-fallback" id="adaceenWaitFallback" hidden>¿Sigue igual? Vuelve a la pestaña de ADACEEN donde pulsaste el botón y púlsalo otra vez («Abrir el ejercicio en mi editor» o «Abrir en mi editor»). Tu cuenta de GitHub ya quedó conectada: no te la vuelve a pedir. Después puedes cerrar esta ventana.</p>
    </section>
  `;
}

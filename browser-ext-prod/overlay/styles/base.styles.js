// ADACEEN | Capa 4 - UI: estilos base (variables de diseño, reset y contenedor raíz).
// Extraído de overlay/content-styles.js (líneas 4-116).
// Orden de carga: manifest.json (content_scripts) y background.js (CONTENT_SCRIPT_FILES) deben coincidir.
"use strict";

const OVERLAY_BASE_STYLES = `
    <style>
      :host {
        all: initial;
        position: fixed;
        top: 16px;
        right: 16px;
        z-index: 2147483647;
        font-family: "Inter", "Segoe UI", system-ui, -apple-system, BlinkMacSystemFont, sans-serif;
        --adaceen-ink: #14212f;
        /* A12.9: #647184 daba 4,43:1 sobre --adaceen-soft; #566476 da >= 5,27:1 en todos los fondos. */
        --adaceen-muted: #566476;
        --adaceen-soft: #eef3f6;
        --adaceen-panel: #ffffff;
        --adaceen-panel-soft: #f8fafb;
        --adaceen-border: #d9e2ea;
        --adaceen-border-strong: #bccbd7;
        /* Lineas dentro de las tablas: entre filas y, mas suave, entre columnas. */
        --adaceen-table-line: #e3e9ef;
        --adaceen-table-divider: #edf1f5;
        --adaceen-primary: #006d77;
        --adaceen-primary-strong: #00545d;
        --adaceen-primary-soft: #e2f3f3;
        --adaceen-accent: #c25b32;
        --adaceen-accent-soft: #fff0e9;
        --adaceen-accent-strong: #9a4524;
        --adaceen-danger: #b42318;
        --adaceen-danger-soft: #fff1f0;
        --adaceen-warning: #875c0f;
        --adaceen-warning-soft: #fff7db;
        --adaceen-shadow: 0 22px 60px rgba(15, 23, 42, 0.22);
        --adaceen-shadow-soft: 0 12px 28px rgba(15, 23, 42, 0.1);
        --adaceen-radius: 8px;
        /* Borde de controles (>= 3:1, WCAG 1.4.11) y anillo de foco (WCAG 2.4.7). */
        --adaceen-control-border: #7b8a99;
        --adaceen-focus: #00545d;
      }

      * {
        box-sizing: border-box;
      }

      /* Lo oculto se oculta siempre (A12.12): un display: grid/flex de su clase anulaba el
         atributo hidden (p. ej. .next-action dejaba ver «Continuar» y «Actualizar» sin accion). */
      [hidden] {
        display: none !important;
      }

      .shell {
        width: min(400px, calc(100vw - 32px));
        color: var(--adaceen-ink);
        letter-spacing: 0;
        transition: width 180ms ease, transform 180ms ease;
      }

      .shell.is-minimized {
        width: min(244px, calc(100vw - 32px));
      }

      .window[hidden],
      .minimized-tab[hidden] {
        display: none !important;
      }

      .shell.has-tab-conflict .window > .body {
        filter: blur(2px);
        pointer-events: none;
        transition: filter 160ms ease;
      }

      .shell.shell-expanded {
        width: min(860px, calc(100vw - 32px));
      }

      .window {
        position: relative;
        display: flex;
        flex-direction: column;
        overflow: hidden;
        max-height: min(780px, calc(100dvh - 32px));
        border: 1px solid rgba(185, 199, 211, 0.95);
        border-radius: 12px;
        background: var(--adaceen-panel);
        box-shadow: var(--adaceen-shadow);
        backdrop-filter: blur(18px);
      }

      .minimized-tab {
        display: flex;
        align-items: center;
        gap: 10px;
        width: 100%;
        min-height: 48px;
        border: 1px solid rgba(185, 199, 211, 0.95);
        border-radius: 12px;
        padding: 8px 11px;
        background: var(--adaceen-panel);
        color: var(--adaceen-ink);
        box-shadow: var(--adaceen-shadow-soft);
        cursor: grab;
        font: inherit;
        text-align: left;
        touch-action: none;
        transition: transform 140ms ease, box-shadow 140ms ease, border-color 140ms ease;
        user-select: none;
      }

      .minimized-tab:hover {
        border-color: var(--adaceen-border-strong);
        box-shadow: var(--adaceen-shadow);
        transform: translateY(-1px);
      }

      .minimized-tab.is-dragging {
        cursor: grabbing;
        transform: none;
      }

      .minimized-tab:focus-visible {
        outline: 3px solid rgba(0, 109, 119, 0.22);
        outline-offset: 2px;
      }

`;

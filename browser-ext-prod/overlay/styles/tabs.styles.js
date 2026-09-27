// ADACEEN | Capa 4 - UI: estilos de la barra de navegación por pestañas y dimensionamiento por rol.
// Extraído de overlay/content-styles.js (líneas 2204-2307).
// Orden de carga: manifest.json (content_scripts) y background.js (CONTENT_SCRIPT_FILES) deben coincidir.
"use strict";

const OVERLAY_TABS_STYLES = `      /* ---- Pestañas de la vista principal (0.7.13): cada rol ve las suyas y cada una cabe en la ventana ---- */
      .tab-bar {
        display: flex;
        gap: 4px;
        margin-bottom: 12px;
        padding: 4px;
        border: 1px solid var(--adaceen-border);
        border-radius: 10px;
        background: var(--adaceen-panel-soft);
      }

      .tab-button {
        flex: 1 1 0;
        display: inline-flex;
        align-items: center;
        justify-content: center;
        gap: 6px;
        min-width: 0;
        min-height: 34px;
        padding: 6px 10px;
        border: 1px solid transparent;
        border-radius: 8px;
        background: transparent;
        color: var(--adaceen-muted);
        font: inherit;
        font-size: 0.74rem;
        font-weight: 800;
        letter-spacing: 0.02em;
        white-space: nowrap;
        cursor: pointer;
        transition: background 140ms ease, color 140ms ease, box-shadow 140ms ease;
      }

      .tab-button[hidden] {
        display: none !important;
      }

      .tab-button:hover {
        color: var(--adaceen-ink);
        background: #fff;
      }

      .tab-button.is-active {
        color: var(--adaceen-primary-strong);
        background: #fff;
        border-color: var(--adaceen-border);
        box-shadow: var(--adaceen-shadow-soft);
      }

      .tab-button:focus-visible {
        outline: 2px solid var(--adaceen-focus);
        outline-offset: 1px;
      }

      .tab-count {
        min-width: 18px;
        padding: 1px 6px;
        border-radius: 999px;
        background: var(--adaceen-primary-soft);
        color: var(--adaceen-primary-strong);
        font-size: 0.62rem;
        line-height: 1.4;
      }

      .tab-count[hidden] {
        display: none;
      }

      .tab-panel[hidden] {
        display: none !important;
      }

      /* En la ventana ancha (860px) las cinco metas van en una fila: la pestana Tutor cabe sin scroll. */
      .shell-expanded .goal-grid {
        grid-template-columns: repeat(auto-fit, minmax(148px, 1fr));
      }

      .shell-expanded .goal-button {
        min-height: 48px;
        padding: 8px 10px;
      }

      .tutor-locked-notice[hidden] {
        display: none !important;
      }

      /* La pestana Tutor con fuentes, pistas, pasos y valoracion cabe en la ventana ancha. */
      .shell-expanded .tab-panel .panel-section,
      .shell-expanded .tab-panel .tutor-response-region .panel-section {
        margin-bottom: 10px;
      }

      .sr-only {
        position: absolute;
        width: 1px;
        height: 1px;
        margin: -1px;
        padding: 0;
        overflow: hidden;
        clip: rect(0, 0, 0, 0);
        white-space: nowrap;
        border: 0;
      }

`;

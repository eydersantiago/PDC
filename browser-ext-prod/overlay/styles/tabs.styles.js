// ADACEEN | Capa 4 - UI: estilos de la barra de navegación por pestañas y dimensionamiento por rol.
// Extraído de overlay/content-styles.js (líneas 2204-2307).
// Orden de carga: manifest.json (content_scripts) y background.js (CONTENT_SCRIPT_FILES) deben coincidir.
"use strict";

const OVERLAY_TABS_STYLES = `      /* Linea de estado del tutor fuera de Inicio y Tutor (content-students.js, renderMainTabs). */
      .status.is-off-tab {
        display: none;
      }

      /* ---- Pestañas de la vista principal (0.7.13; dirección B en 0.7.22): de borde a borde
         bajo la cabecera, sobre un fondo suave para que se lea como navegación, en monoespaciada y
         minúsculas, separadas por un borde de alto completo; la activa, en blanco y subrayada con
         el acento. ---- */
      .tab-bar {
        display: flex;
        gap: 0;
        margin: -16px -18px 14px;
        padding: 0;
        border-bottom: 1px solid var(--adaceen-nav-line);
        background: var(--adaceen-nav);
        overflow-x: auto;
        scrollbar-width: thin;
      }

      .tab-button {
        flex: 0 0 auto;
        display: inline-flex;
        align-items: center;
        justify-content: center;
        gap: 6px;
        min-width: 0;
        min-height: 44px;
        padding: 0 14px;
        border: 0;
        border-right: 1px solid var(--adaceen-nav-line);
        border-radius: 0;
        background: transparent;
        color: #3d5453;
        font: inherit;
        font-family: var(--adaceen-mono);
        font-size: 0.875rem;
        font-weight: 400;
        letter-spacing: 0;
        text-transform: lowercase;
        white-space: nowrap;
        cursor: pointer;
        transition: color 120ms ease, background 120ms ease;
      }

      .tab-button[hidden] {
        display: none !important;
      }

      .tab-button:hover {
        background: var(--adaceen-nav-hover);
        color: var(--adaceen-ink);
      }

      /* La activa toma el color del fondo del panel: se une con lo de abajo, como una ceja. */
      .tab-button.is-active {
        background: var(--adaceen-canvas);
        color: var(--adaceen-ink);
        font-weight: 500;
        box-shadow: inset 0 -2px 0 var(--adaceen-primary);
      }

      .tab-button:focus-visible {
        outline: 2px solid var(--adaceen-focus);
        outline-offset: -2px;
      }

      .tab-count {
        min-width: 18px;
        padding: 0 5px;
        border-radius: var(--adaceen-radius-control);
        background: var(--adaceen-soft);
        color: var(--adaceen-body);
        font-size: 0.75rem;
        line-height: 1.5;
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

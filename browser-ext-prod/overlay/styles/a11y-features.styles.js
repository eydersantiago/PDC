// ADACEEN | Capa 4 - UI: estilos de accesibilidad (foco visible WCAG), lotes RAG y ayuda de resultados de aprendizaje.
// Extraído de overlay/content-styles.js (líneas 3303-3660).
// Orden de carga: manifest.json (content_scripts) y background.js (CONTENT_SCRIPT_FILES) deben coincidir.
"use strict";

const OVERLAY_A11Y_STYLES = `      /* ---- Accesibilidad del overlay (A12.9 ADACEEN-140, WCAG 2.1 AA) ---- */

      /* Configuracion cerrada: fuera del orden de tabulacion y del arbol de accesibilidad. */
      .settings-panel {
        visibility: hidden;
        transition: transform 160ms ease, visibility 0s linear 160ms;
      }

      .window.settings-open .settings-panel {
        visibility: visible;
        transition: transform 160ms ease, visibility 0s linear 0s;
      }

      .settings-title {
        margin: 0;
        font-size: 0.94rem;
        line-height: 1.2;
      }

      .field .field-title {
        color: var(--adaceen-body);
        font-size: 0.8125rem;
        font-weight: 600;
      }

      label.switch-row {
        cursor: pointer;
      }

      /* Foco visible y con contraste (8,66:1 sobre blanco; blanco sobre la cabecera oscura). */
      .shell button:focus-visible,
      .shell a[href]:focus-visible,
      .shell input:focus-visible,
      .shell select:focus-visible,
      .shell textarea:focus-visible,
      .shell summary:focus-visible {
        outline: 3px solid var(--adaceen-focus);
        outline-offset: 2px;
      }

      .shell .header button:focus-visible {
        outline-color: #ffffff;
      }

      /* Contenedores que reciben foco por programa (dialogo, capas, mensajes): sin anillo. */
      .shell [tabindex="-1"]:focus,
      .shell [tabindex="-1"]:focus-visible {
        outline: none;
      }

      .rag-citation-item a {
        text-decoration: underline;
        text-underline-offset: 2px;
      }

      .tutor-feedback .tutor-feedback-actions {
        display: grid;
        grid-template-columns: repeat(2, minmax(0, 1fr));
        gap: 8px;
      }

      .tutor-feedback .feedback-button {
        width: 100%;
        min-height: 44px;
        padding: 8px 12px;
        font-size: 0.875rem;
      }

      .tutor-feedback .feedback-button.is-chosen {
        border-color: var(--adaceen-primary);
        background: var(--adaceen-primary-soft);
        color: var(--adaceen-primary-strong);
      }

      .tutor-feedback .feedback-button.is-chosen:disabled {
        opacity: 1;
      }

      .tutor-feedback-status {
        margin-top: 8px;
        color: var(--adaceen-primary-strong);
        font-size: 0.875rem;
        font-weight: 500;
      }

      .tutor-feedback-status:empty {
        margin-top: 0;
      }

      /* Lotes de RAG (0.7.15) */
      .rag-course-active {
        flex: 0 0 auto;
        padding: 1px 7px;
        border-radius: 999px;
        background: var(--adaceen-soft);
        color: var(--adaceen-body);
        font-size: 0.75rem;
        font-weight: 600;
        white-space: nowrap;
      }

      .rag-course-active.is-lot {
        background: var(--adaceen-success-soft);
        color: var(--adaceen-success);
      }

      .rag-course-select {
        display: inline-flex;
        align-items: center;
        gap: 5px;
        color: var(--adaceen-muted);
        font-size: 0.75rem;
        font-weight: 700;
      }

      .rag-course-select select {
        max-width: 170px;
        padding: 4px 6px;
        border: 1px solid var(--adaceen-border);
        border-radius: var(--adaceen-radius-control);
        background: #fff;
        color: var(--adaceen-ink);
        font-size: 0.75rem;
        font-weight: 700;
      }

      .rag-lot-form {
        display: grid;
        gap: 6px;
        padding: 8px 10px;
        border: 1px dashed var(--adaceen-primary-line);
        border-radius: var(--adaceen-radius-control);
        background: var(--adaceen-soft);
      }

      .rag-lot-form input[type="text"] {
        width: 100%;
        padding: 6px 8px;
        border: 1px solid var(--adaceen-border);
        border-radius: var(--adaceen-radius-control);
        font-size: 0.8125rem;
      }

      .rag-lot-includes {
        justify-content: space-between;
      }

      .rag-lot-form-actions {
        display: flex;
        justify-content: flex-end;
        gap: 6px;
      }

      .rag-lot-group {
        border: 1px solid var(--adaceen-border);
        border-radius: var(--adaceen-radius-control);
        background: #fff;
      }

      .rag-lot-group.is-active {
        border-color: var(--adaceen-success-line);
        box-shadow: none;
      }

      .rag-lot-group > summary {
        display: flex;
        align-items: center;
        gap: 8px;
        padding: 7px 10px;
        cursor: pointer;
        list-style: none;
      }

      .rag-lot-group > summary::-webkit-details-marker {
        display: none;
      }

      .rag-lot-group > summary::before {
        content: "▸";
        color: var(--adaceen-muted);
        font-size: 0.8125rem;
      }

      .rag-lot-group[open] > summary::before {
        content: "▾";
      }

      .rag-lot-name {
        flex: 1 1 auto;
        min-width: 0;
        color: var(--adaceen-ink);
        font-size: 0.8125rem;
        font-weight: 600;
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
      }

      .rag-lot-badge {
        flex: 0 0 auto;
        padding: 1px 7px;
        border-radius: 999px;
        background: var(--adaceen-soft);
        color: var(--adaceen-body);
        font-size: 0.75rem;
        font-weight: 600;
        white-space: nowrap;
      }

      .rag-lot-badge.is-active {
        background: var(--adaceen-success-soft);
        color: var(--adaceen-success);
      }

      .rag-lot-body {
        display: grid;
        gap: 6px;
        padding: 0 10px 10px;
      }

      .rag-lot-info {
        margin: 0;
        color: var(--adaceen-muted);
        font-size: 0.75rem;
        line-height: 1.35;
      }

      .rag-lot-actions {
        display: flex;
        flex-wrap: wrap;
        gap: 6px;
      }

      .rag-lot-actions .primary-button {
        width: auto;
      }

      .rag-course-source.is-disabled {
        opacity: 0.62;
        border-style: dashed;
      }

      .rag-course-source.is-disabled .rag-course-source-title {
        text-decoration: line-through;
      }

      .admin-chip.is-lot {
        background: var(--adaceen-soft);
        color: var(--adaceen-body);
      }

      .admin-chip.is-lot,
      .admin-chip.is-lot-student {
        white-space: normal;
        line-height: 1.25;
      }

      .admin-chip.is-lot-student {
        background: var(--adaceen-warning-soft);
        border-color: var(--adaceen-warning-line);
        color: #8a5a00;
      }

      .admin-rag-cell {
        min-width: 96px;
        max-width: 150px;
      }

      .admin-lot-grid {
        display: grid;
        grid-template-columns: repeat(auto-fit, minmax(180px, 1fr));
        gap: 8px;
      }

      /* Ayuda «?» de los resultados de aprendizaje (0.7.15) */
      .label-row {
        display: flex;
        align-items: center;
        gap: 6px;
      }

      .label-row label {
        flex: 1 1 auto;
      }

      .help-button {
        flex: 0 0 auto;
        width: 20px;
        height: 20px;
        padding: 0;
        border: 1px solid var(--adaceen-border);
        border-radius: 999px;
        background: #fff;
        color: var(--adaceen-primary-strong);
        font-size: 0.8125rem;
        font-weight: 600;
        line-height: 1;
        cursor: pointer;
        /* Sin agrandar la fila de la etiqueta: el campo de al lado queda a la misma altura. */
        margin-block: -2px;
      }

      .help-button:hover,
      .help-button.is-active {
        background: var(--adaceen-primary-soft);
        border-color: var(--adaceen-primary-line);
      }

      .help-panel {
        margin: -4px 0 10px;
        padding: 8px 10px;
        border: 1px solid var(--adaceen-primary-line);
        border-radius: var(--adaceen-radius-control);
        background: var(--adaceen-soft);
      }

      .help-intro {
        margin: 0 0 6px;
        color: var(--adaceen-muted);
        font-size: 0.75rem;
        line-height: 1.35;
      }

      .help-outcomes {
        display: grid;
        grid-template-columns: repeat(auto-fit, minmax(230px, 1fr));
        gap: 5px;
        margin: 0;
        padding: 0;
        list-style: none;
      }

      .help-outcome {
        padding: 5px 8px;
        border: 1px solid var(--adaceen-border);
        border-radius: var(--adaceen-radius-control);
        background: #fff;
      }

      .help-outcome.is-selected {
        border-color: var(--adaceen-success-line);
        box-shadow: none;
      }

      .help-outcome-head {
        display: flex;
        align-items: center;
        justify-content: space-between;
        gap: 6px;
        font-size: 0.75rem;
      }

      .help-outcome-text,
      .help-outcome-split {
        margin: 3px 0 0;
        color: var(--adaceen-muted);
        font-size: 0.75rem;
        line-height: 1.35;
      }

`;

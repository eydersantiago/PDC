// ADACEEN | Capa 4 - UI: estilos de la pestaña «Bitácora» del docente (0.7.16): la línea de Inicio,
// la zona para soltar el archivo, las herramientas y los plegables. La lista de semanas y el registro
// manual siguen en tutor.styles.js (.bitacora-week-*, .bitacora-manual-*).
// Orden de carga: manifest.json (content_scripts) y background.js (CONTENT_SCRIPT_FILES) deben coincidir.
"use strict";

const OVERLAY_BITACORA_STYLES = `      /* Pestaña «Bitácora» (0.7.16) */
      .tab-flag {
        flex: 0 0 auto;
        width: 7px;
        height: 7px;
        border-radius: 999px;
        background: var(--adaceen-warning);
        box-shadow: 0 0 0 2px var(--adaceen-warning-soft);
      }

      .tab-flag[hidden] {
        display: none;
      }

      /* Línea de Inicio: el estado de la bitácora y, al pulsarla, la pestaña. */
      .bitacora-home-line {
        display: flex;
        align-items: center;
        gap: 10px;
        width: 100%;
        margin: 0 0 12px;
        min-height: 44px;
        padding: 10px 12px;
        border: 1px solid var(--adaceen-border);
        border-radius: var(--adaceen-radius-control);
        background: #fff;
        box-shadow: none;
        color: var(--adaceen-ink);
        font: inherit;
        text-align: left;
        cursor: pointer;
        transition: border-color 140ms ease, background 140ms ease;
      }

      .bitacora-home-line[hidden] {
        display: none;
      }

      .bitacora-home-line:hover {
        border-color: var(--adaceen-border-strong);
        background: var(--adaceen-soft);
      }

      .bitacora-home-line:focus-visible {
        outline: 2px solid var(--adaceen-primary);
        outline-offset: 2px;
      }

      .bitacora-home-line.is-missing {
        border-color: var(--adaceen-warning-line);
        background: var(--adaceen-warning-soft);
      }

      .bitacora-home-copy {
        flex: 1 1 auto;
        min-width: 0;
        display: grid;
        gap: 2px;
      }

      .bitacora-home-copy .eyebrow {
        margin-bottom: 0;
      }

      .bitacora-home-text {
        overflow: hidden;
        color: var(--adaceen-body);
        font-size: 0.875rem;
        line-height: 1.35;
        text-overflow: ellipsis;
        white-space: nowrap;
      }

      .bitacora-home-go {
        flex: 0 0 auto;
        color: var(--adaceen-primary-strong);
        font-size: 0.8125rem;
        font-weight: 500;
      }

      .bitacora-home-go::after {
        content: " \\203A";
      }

      /* Cabecera de la pestaña: el texto se parte en líneas; el estado y «Actualizar» quedan juntos. */
      .bitacora-section .section-title-row {
        align-items: flex-start;
      }

      .bitacora-section .section-title-row > div:first-child {
        min-width: 0;
      }

      .bitacora-section .section-title-row .summary-actions {
        flex: 0 0 auto;
        flex-wrap: nowrap;
      }

      /* Zona para soltar el Excel o el PDF, con el botón principal. */
      .bitacora-dropzone {
        display: grid;
        justify-items: center;
        gap: 6px;
        margin-top: 4px;
        padding: 16px 14px;
        border: 2px dashed var(--adaceen-primary-line);
        border-radius: var(--adaceen-radius-control);
        background: var(--adaceen-soft);
        text-align: center;
        transition: border-color 140ms ease, background 140ms ease, box-shadow 140ms ease;
      }

      .bitacora-dropzone.is-loaded {
        border-color: var(--adaceen-border-strong);
        background: var(--adaceen-panel-soft);
      }

      .bitacora-dropzone.is-dragover {
        border-color: var(--adaceen-primary);
        border-style: solid;
        background: var(--adaceen-primary-soft);
        box-shadow: 0 0 0 3px var(--adaceen-primary-soft);
      }

      .bitacora-dropzone.is-busy {
        opacity: 0.85;
      }

      .bitacora-dropzone-title {
        color: var(--adaceen-ink);
        font-size: 0.9375rem;
        font-weight: 600;
        overflow-wrap: anywhere;
      }

      .bitacora-dropzone-hint {
        max-width: 520px;
        color: var(--adaceen-muted);
        font-size: 0.8125rem;
        line-height: 1.4;
      }

      .bitacora-upload-button {
        width: auto;
        min-width: 240px;
        margin-top: 4px;
      }

      .bitacora-dropzone-note {
        color: var(--adaceen-muted);
        font-size: 0.75rem;
      }

      .bitacora-tools {
        grid-template-columns: repeat(3, minmax(0, 1fr));
        margin-top: 10px;
      }

      .bitacora-tools .ghost-button {
        min-height: 34px;
        padding: 8px 10px;
        font-size: 0.8125rem;
      }

      .bitacora-tools-note {
        margin-top: 6px;
        font-size: 0.8125rem;
      }

      /* Plegables: semanas cargadas, registro manual y borrar datos. */
      .bitacora-fold {
        margin-top: 10px;
        border: 1px solid var(--adaceen-border);
        border-radius: var(--adaceen-radius-control);
        background: #fff;
      }

      .bitacora-fold > summary {
        display: flex;
        align-items: center;
        gap: 8px;
        padding: 9px 12px;
        list-style: none;
        cursor: pointer;
        color: var(--adaceen-ink);
        font-size: 0.875rem;
        font-weight: 600;
      }

      .bitacora-fold > summary::-webkit-details-marker {
        display: none;
      }

      .bitacora-fold > summary::before {
        content: "";
        flex: 0 0 auto;
        width: 0;
        height: 0;
        border-top: 5px solid transparent;
        border-bottom: 5px solid transparent;
        border-left: 6px solid var(--adaceen-primary-strong);
        transition: transform 120ms ease;
      }

      .bitacora-fold[open] > summary::before {
        transform: rotate(90deg);
      }

      .bitacora-fold[open] > summary {
        border-bottom: 1px solid var(--adaceen-border);
      }

      .bitacora-fold > summary:focus-visible {
        outline: 3px solid var(--adaceen-primary-soft);
        outline-offset: 2px;
        border-radius: var(--adaceen-radius-control);
      }

      .bitacora-fold > :not(summary) {
        margin-left: 12px;
        margin-right: 12px;
      }

      .bitacora-fold > :last-child {
        margin-bottom: 12px;
      }

      .bitacora-fold > .settings-note {
        margin-top: 10px;
      }

      .bitacora-fold .bitacora-week-list {
        max-height: 260px;
        margin-top: 10px;
        overflow: auto;
        padding-right: 2px;
      }

      /* Etiquetas de cada línea de la semana: actividad y evaluación ya tienen color (tutor.styles.js). */
      .bitacora-line-exercise .bitacora-line-label {
        color: var(--adaceen-primary-strong);
        background: var(--adaceen-soft);
      }

      .bitacora-line-project .bitacora-line-label {
        color: var(--adaceen-accent-strong);
        background: var(--adaceen-accent-soft);
      }

      .bitacora-line-quiz .bitacora-line-label {
        color: var(--adaceen-warning);
        background: var(--adaceen-warning-soft);
      }

      .bitacora-line-partial .bitacora-line-label {
        color: var(--adaceen-danger);
        background: var(--adaceen-danger-soft);
      }

      .bitacora-fold .bitacora-manual-grid {
        margin-top: 10px;
      }

      .bitacora-fold.is-danger > summary {
        color: var(--adaceen-danger);
      }

      .bitacora-fold.is-danger > summary::before {
        border-left-color: var(--adaceen-danger);
      }

      @media (max-width: 640px) {
        .bitacora-tools {
          grid-template-columns: 1fr;
        }

        .bitacora-upload-button {
          width: 100%;
          min-width: 0;
        }

        /* Siete pestañas del docente: en pantallas angostas la barra se desplaza en vez de apretarlas. */
        .tab-bar {
          overflow-x: auto;
          scrollbar-width: none;
        }

        .tab-bar::-webkit-scrollbar {
          display: none;
        }

        .tab-button {
          flex: 0 0 auto;
        }
      }

`;

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
        background: #d99a1e;
        box-shadow: 0 0 0 2px #fff7db;
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
        padding: 10px 12px;
        border: 1px solid var(--adaceen-border);
        border-radius: var(--adaceen-radius);
        background: var(--adaceen-panel);
        box-shadow: 0 8px 20px rgba(15, 23, 42, 0.05);
        color: var(--adaceen-ink);
        font: inherit;
        text-align: left;
        cursor: pointer;
        transition: border-color 140ms ease, background 140ms ease, transform 140ms ease;
      }

      .bitacora-home-line[hidden] {
        display: none;
      }

      .bitacora-home-line:hover {
        border-color: var(--adaceen-border-strong);
        background: #f8fbfc;
        transform: translateY(-1px);
      }

      .bitacora-home-line:focus-visible {
        outline: 3px solid rgba(0, 109, 119, 0.22);
        outline-offset: 2px;
      }

      .bitacora-home-line.is-missing {
        border-color: #f0d077;
        background: linear-gradient(180deg, #fffbeb 0%, #ffffff 100%);
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
        color: #3e5362;
        font-size: 0.76rem;
        line-height: 1.35;
        text-overflow: ellipsis;
        white-space: nowrap;
      }

      .bitacora-home-go {
        flex: 0 0 auto;
        color: var(--adaceen-primary-strong);
        font-size: 0.74rem;
        font-weight: 800;
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
        border: 2px dashed #a6d7d9;
        border-radius: 10px;
        background: #f4fbfb;
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
        box-shadow: 0 0 0 4px rgba(0, 109, 119, 0.12);
      }

      .bitacora-dropzone.is-busy {
        opacity: 0.85;
      }

      .bitacora-dropzone-title {
        color: var(--adaceen-ink);
        font-size: 0.84rem;
        font-weight: 800;
        overflow-wrap: anywhere;
      }

      .bitacora-dropzone-hint {
        max-width: 520px;
        color: var(--adaceen-muted);
        font-size: 0.74rem;
        line-height: 1.4;
      }

      .bitacora-upload-button {
        width: auto;
        min-width: 240px;
        margin-top: 4px;
      }

      .bitacora-dropzone-note {
        color: var(--adaceen-muted);
        font-size: 0.68rem;
      }

      .bitacora-tools {
        grid-template-columns: repeat(3, minmax(0, 1fr));
        margin-top: 10px;
      }

      .bitacora-tools .ghost-button {
        min-height: 34px;
        padding: 8px 10px;
        font-size: 0.74rem;
      }

      .bitacora-tools-note {
        margin-top: 6px;
        font-size: 0.7rem;
      }

      /* Plegables: semanas cargadas, registro manual y borrar datos. */
      .bitacora-fold {
        margin-top: 10px;
        border: 1px solid var(--adaceen-border);
        border-radius: 8px;
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
        font-size: 0.76rem;
        font-weight: 800;
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
        outline: 3px solid rgba(0, 109, 119, 0.22);
        outline-offset: 2px;
        border-radius: 8px;
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
        background: #eef7f7;
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

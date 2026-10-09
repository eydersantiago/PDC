// ADACEEN | Capa 4 - UI: estilos del panel de configuración (tuerca) y secciones plegables.
// Extraído de overlay/content-styles.js (líneas 1817-2203).
// Orden de carga: manifest.json (content_scripts) y background.js (CONTENT_SCRIPT_FILES) deben coincidir.
"use strict";

const OVERLAY_SETTINGS_STYLES = `      /* La tuerca empieza bajo la cabecera (--adaceen-settings-top, medido al abrirla): «Salir»,
         minimizar y cerrar siguen a la vista y el foco no queda en un boton tapado. */
      .settings-panel {
        position: absolute;
        inset: var(--adaceen-settings-top, 0px) 0 0 0;
        padding: 16px;
        overflow: hidden;
        background: rgba(248, 250, 252, 0.99);
        backdrop-filter: blur(10px);
        transform: translateX(101%);
        transition: transform 160ms ease;
        display: flex;
        flex-direction: column;
        gap: 12px;
      }

      .window.settings-open .settings-panel {
        transform: translateX(0);
      }

      .settings-head {
        display: flex;
        align-items: center;
        justify-content: space-between;
        gap: 10px;
        padding-bottom: 10px;
        border-bottom: 1px solid var(--adaceen-border);
      }

      .settings-note {
        color: var(--adaceen-muted);
        font-size: 0.76rem;
        line-height: 1.4;
      }

      /* Entorno de los estudiantes (0.7.19): agente sin configurar o VM apagada. */
      .settings-note.is-warning {
        color: var(--adaceen-warning);
        font-weight: 700;
      }

      /* Clase (0.7.21): «Iniciar clase» y «Actualizar estado» en una fila; listo en verde. */
      .class-start-row {
        margin-top: 4px;
      }

      .class-start-row .save-button,
      .class-start-row .ghost-button {
        width: auto;
        padding: 8px 12px;
        font-size: 0.76rem;
        white-space: nowrap;
      }

      .settings-note.is-ready {
        color: var(--adaceen-primary-strong);
        font-weight: 700;
      }

      .settings-grid {
        flex: 1 1 auto;
        min-height: 0;
        display: grid;
        align-content: start;
        gap: 10px;
        overflow: auto;
        padding-right: 2px;
      }

      .settings-actions {
        flex: 0 0 auto;
        margin: 0;
        padding-top: 4px;
        border-top: 1px solid var(--adaceen-border);
      }

      /* Secciones plegables de la tuerca (0.7.14). */
      .settings-section {
        border: 1px solid var(--adaceen-border);
        border-radius: 8px;
        background: #fff;
      }

      .settings-section[hidden] {
        display: none !important;
      }

      .settings-section > summary {
        display: flex;
        align-items: center;
        justify-content: space-between;
        gap: 8px;
        padding: 10px 12px;
        list-style: none;
        cursor: pointer;
        color: var(--adaceen-primary-strong);
        font-size: 0.78rem;
        font-weight: 800;
      }

      .settings-section > summary::-webkit-details-marker {
        display: none;
      }

      .settings-section > summary > span:first-child::before {
        content: "";
        display: inline-block;
        width: 0;
        height: 0;
        margin-right: 8px;
        border-top: 5px solid transparent;
        border-bottom: 5px solid transparent;
        border-left: 6px solid currentColor;
        vertical-align: middle;
        transition: transform 120ms ease;
      }

      .settings-section[open] > summary > span:first-child::before {
        transform: rotate(90deg);
      }

      .settings-section[open] > summary {
        border-bottom: 1px solid var(--adaceen-border);
      }

      .settings-section-hint {
        flex: 1 1 auto;
        color: var(--adaceen-muted);
        font-size: 0.66rem;
        font-weight: 600;
        text-align: right;
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
      }

      .settings-section-body {
        display: grid;
        gap: 10px;
        padding: 10px 12px 12px;
      }

      .settings-two {
        display: grid;
        grid-template-columns: repeat(2, minmax(0, 1fr));
        gap: 10px;
      }

      @media (max-width: 520px) {
        .settings-two {
          grid-template-columns: 1fr;
        }
      }

      .settings-subcard {
        border: 1px solid var(--adaceen-border);
        border-radius: 8px;
        background: #fff;
        padding: 12px;
        display: grid;
        gap: 10px;
      }

      .settings-subhead {
        display: flex;
        align-items: flex-start;
        justify-content: space-between;
        gap: 10px;
      }

      .settings-subhead h3 {
        margin: 0 0 4px;
        font-size: 0.86rem;
        line-height: 1.2;
      }

      .settings-subhead .ghost-button {
        width: auto;
        padding: 8px 10px;
        font-size: 0.74rem;
        white-space: nowrap;
      }

      .settings-kv-grid {
        display: grid;
        grid-template-columns: repeat(2, minmax(0, 1fr));
        gap: 8px;
      }

      .settings-kv {
        border: 1px solid var(--adaceen-border);
        border-radius: 8px;
        background: var(--adaceen-panel-soft);
        padding: 9px 10px;
        display: grid;
        gap: 4px;
      }

      .settings-kv span {
        color: var(--adaceen-muted);
        font-size: 0.68rem;
        font-weight: 800;
        letter-spacing: 0.04em;
        text-transform: uppercase;
      }

      .settings-kv strong {
        color: var(--adaceen-ink);
        font-size: 0.78rem;
        line-height: 1.3;
        word-break: break-word;
      }

      .settings-history-list {
        list-style: none;
        padding-left: 0 !important;
        display: grid;
        gap: 8px;
      }

      .settings-history-item {
        border: 1px solid var(--adaceen-border);
        border-radius: 8px;
        background: #fff;
        padding: 10px;
        display: grid;
        gap: 8px;
      }

      .settings-history-top {
        display: flex;
        align-items: flex-start;
        justify-content: space-between;
        gap: 10px;
      }

      .settings-history-title {
        margin: 0;
        color: var(--adaceen-ink);
        font-size: 0.78rem;
        font-weight: 800;
        line-height: 1.3;
      }

      .settings-history-meta {
        margin-top: 3px;
        color: var(--adaceen-muted);
        font-size: 0.7rem;
        line-height: 1.35;
      }

      .settings-history-item .ghost-button,
      .settings-history-item .save-button {
        width: auto;
        padding: 8px 10px;
        font-size: 0.72rem;
      }

      .settings-history-empty {
        margin: 0;
        color: var(--adaceen-muted);
        font-size: 0.74rem;
        line-height: 1.35;
      }

      .field {
        display: grid;
        gap: 6px;
      }

      .field label {
        color: #475569;
        font-size: 0.73rem;
        font-weight: 800;
      }

      .field select,
      .field input[type="text"],
      .field input[type="password"],
      .field input[type="number"],
      .field textarea {
        width: 100%;
        border: 1px solid var(--adaceen-control-border);
        border-radius: 8px;
        background: #fff;
        color: var(--adaceen-ink);
        padding: 10px;
        font: inherit;
        font-size: 0.78rem;
        outline: none;
        transition: border-color 140ms ease, box-shadow 140ms ease;
      }

      .field select:focus,
      .field input[type="text"]:focus,
      .field input[type="password"]:focus,
      .field input[type="number"]:focus,
      .field textarea:focus {
        border-color: var(--adaceen-primary);
        box-shadow: 0 0 0 3px rgba(0, 109, 119, 0.1);
      }

      .field textarea {
        resize: vertical;
        min-height: 76px;
      }

      .switch-row {
        display: flex;
        align-items: center;
        justify-content: space-between;
        gap: 10px;
        padding: 10px 12px;
        border: 1px solid var(--adaceen-border);
        border-radius: 8px;
        background: #fff;
        color: #334155;
        font-size: 0.76rem;
      }

      .switch-row input {
        width: 18px;
        height: 18px;
      }

      .check-grid {
        display: grid;
        gap: 8px;
      }

      .quiz-status {
        margin: 6px 0 0;
        font-size: 12px;
        line-height: 1.4;
        color: var(--adaceen-muted);
      }

      .check-item {
        display: flex;
        align-items: center;
        justify-content: space-between;
        gap: 8px;
        padding: 9px 11px;
        border: 1px solid var(--adaceen-border);
        border-radius: 8px;
        background: #fff;
        font-size: 0.75rem;
      }

      .analysis-window {
        position: absolute;
        inset: 58px 14px 14px;
        border: 1px solid var(--adaceen-border);
        border-radius: 10px;
        background: rgba(255, 255, 255, 0.98);
        box-shadow: var(--adaceen-shadow);
        display: flex;
        flex-direction: column;
        z-index: 8;
      }

      .analysis-window[hidden] {
        display: none;
      }

      .analysis-head {
        display: flex;
        align-items: flex-start;
        justify-content: space-between;
        gap: 12px;
        border-bottom: 1px solid var(--adaceen-border);
        padding: 12px 12px 10px;
      }

      .analysis-head strong {
        display: block;
        color: var(--adaceen-ink);
        font-size: 0.83rem;
      }

      .analysis-meta {
        margin-top: 4px;
        color: var(--adaceen-muted);
        font-size: 0.72rem;
        line-height: 1.35;
      }

      .analysis-body {
        padding: 10px 12px 12px;
        overflow: auto;
      }

      .analysis-tree {
        list-style: none;
        margin: 0;
        padding-left: 0 !important;
        display: grid;
        gap: 6px;
      }

      .analysis-tree li {
        border: 1px solid var(--adaceen-border);
        border-radius: 8px;
        background: var(--adaceen-panel-soft);
        padding: 7px 9px;
        color: #243b53;
        font-size: 0.72rem;
        line-height: 1.35;
        font-family: Consolas, "Courier New", monospace;
      }

`;

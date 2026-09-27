// ADACEEN | Capa 4 - UI: estilos de la pestaña Inicio, centro de contexto y operaciones activas.
// Extraído de overlay/content-styles.js (líneas 692-1002).
// Orden de carga: manifest.json (content_scripts) y background.js (CONTENT_SCRIPT_FILES) deben coincidir.
"use strict";

const OVERLAY_HOME_STYLES = `      .main-top {
        display: flex;
        align-items: center;
        justify-content: space-between;
        gap: 10px;
        margin-bottom: 10px;
      }

      .main-top-left,
      .main-top-actions,
      .summary-actions,
      .compact-action-row {
        display: flex;
        align-items: center;
        flex-wrap: wrap;
        gap: 8px;
      }

      .summary-actions {
        justify-content: flex-end;
      }

      .main-top .ghost-button {
        width: auto;
        min-height: 34px;
        padding: 8px 10px;
        font-size: 0.76rem;
      }

      .context-hub {
        border: 1px solid var(--adaceen-border);
        border-radius: var(--adaceen-radius);
        background: var(--adaceen-panel);
        padding: 12px;
        margin-bottom: 12px;
        display: grid;
        gap: 10px;
        box-shadow: var(--adaceen-shadow-soft);
      }

      .context-hub-head {
        display: flex;
        align-items: flex-start;
        justify-content: space-between;
        gap: 12px;
      }

      .next-action {
        display: grid;
        gap: 10px;
      }

      .context-hub h2 {
        margin: 0 0 4px;
        font-size: 0.95rem;
        line-height: 1.2;
      }

      .context-meta {
        color: var(--adaceen-muted);
        font-size: 0.74rem;
        line-height: 1.35;
        overflow-wrap: anywhere;
      }

      .state-chip {
        flex: 0 0 auto;
        border: 1px solid var(--adaceen-border);
        border-radius: 7px;
        background: var(--adaceen-soft);
        color: #42566c;
        padding: 6px 8px;
        font-size: 0.68rem;
        font-weight: 800;
        line-height: 1;
        white-space: nowrap;
      }

      .state-chip.is-ok {
        border-color: #a6d7d9;
        background: var(--adaceen-primary-soft);
        color: var(--adaceen-primary-strong);
      }

      .state-chip.is-warn {
        border-color: #f0d077;
        background: var(--adaceen-warning-soft);
        color: var(--adaceen-warning);
      }

      .connection-grid {
        display: grid;
        grid-template-columns: repeat(4, minmax(0, 1fr));
        gap: 8px;
      }

      .connection-item {
        min-width: 0;
        border: 1px solid var(--adaceen-border);
        border-radius: 8px;
        background: var(--adaceen-panel-soft);
        padding: 8px;
        display: grid;
        gap: 5px;
      }

      .connection-item span {
        color: var(--adaceen-muted);
        font-size: 0.66rem;
        font-weight: 800;
        letter-spacing: 0.03em;
        text-transform: uppercase;
      }

      .connection-item strong {
        color: var(--adaceen-ink);
        font-size: 0.74rem;
        line-height: 1.25;
        overflow-wrap: anywhere;
      }

      .connection-item.is-ok {
        border-color: #b9dfe1;
        background: #f1fbfb;
      }

      .connection-item.is-warn {
        border-color: #f0d077;
        background: var(--adaceen-warning-soft);
      }

      .next-action {
        border-top: 1px solid var(--adaceen-border);
        padding-top: 10px;
      }

      .operation-banner {
        display: flex;
        align-items: center;
        gap: 10px;
        border: 1px solid #a6d7d9;
        border-radius: 8px;
        background: var(--adaceen-primary-soft);
        color: var(--adaceen-primary-strong);
        padding: 10px;
      }

      .operation-banner[hidden] {
        display: none !important;
      }

      .operation-banner strong {
        display: block;
        color: var(--adaceen-primary-strong);
        font-size: 0.82rem;
        line-height: 1.2;
      }

      .operation-banner p {
        color: #355d63;
        font-size: 0.72rem;
        line-height: 1.35;
        margin: 2px 0 0;
      }

      .operation-spinner {
        width: 18px;
        height: 18px;
        flex: 0 0 auto;
        border: 3px solid rgba(0, 109, 119, 0.2);
        border-top-color: var(--adaceen-primary);
        border-radius: 999px;
        animation: adaceen-spin 0.8s linear infinite;
      }

      .operation-banner.is-error {
        border-color: #ffc8c2;
        background: var(--adaceen-danger-soft);
        color: var(--adaceen-danger);
      }

      .operation-banner.is-error strong {
        color: #8d3813;
      }

      .operation-banner.is-error p {
        color: #6f3a2d;
      }

      .operation-banner.is-error .operation-spinner {
        border-color: #f3c8ba;
        border-top-color: #c65c2b;
        animation: none;
      }

      @keyframes adaceen-spin {
        to {
          transform: rotate(360deg);
        }
      }

      .next-action strong {
        display: block;
        color: var(--adaceen-ink);
        font-size: 0.86rem;
        line-height: 1.25;
        margin-bottom: 4px;
      }

      .next-action p {
        color: var(--adaceen-muted);
        font-size: 0.74rem;
        line-height: 1.35;
      }

      .context-actions {
        width: 100%;
        margin-top: 0;
      }

      .summary-card,
      .teacher-card,
      .panel-section,
      .preview-card {
        border: 1px solid var(--adaceen-border);
        border-radius: var(--adaceen-radius);
        background: var(--adaceen-panel);
        padding: 12px;
        box-shadow: 0 8px 20px rgba(15, 23, 42, 0.05);
      }

      .summary-card,
      .teacher-card,
      .panel-section {
        margin-bottom: 12px;
      }

      .summary-head {
        display: flex;
        align-items: flex-start;
        justify-content: space-between;
        gap: 8px;
      }

      .section-head {
        margin-bottom: 8px;
      }

      .section-head .eyebrow {
        margin-bottom: 0;
      }

      .section-title-row {
        display: flex;
        align-items: center;
        justify-content: space-between;
        gap: 8px;
        margin-bottom: 8px;
      }

      .section-title-row h2 {
        margin: 0;
      }

      .setup-step-card {
        margin-top: 12px;
      }

      .setup-step-card h2 {
        margin: 0 0 8px;
      }

      .setup-step-card .settings-note {
        margin-bottom: 10px;
      }

      .tight-row {
        margin-top: 8px;
      }

      .field-stack {
        margin-top: 10px;
      }

      .table-section {
        margin-top: 10px;
      }

      .analyze-button {
        width: auto;
        min-height: 32px;
        padding: 7px 9px;
        font-size: 0.72rem;
      }

      .teacher-card {
        background: linear-gradient(180deg, #f1fbfb 0%, #ffffff 100%);
        border-color: #b9dfe1;
        margin-bottom: 8px;
      }

      .eyebrow {
        display: block;
        margin-bottom: 5px;
        color: var(--adaceen-primary-strong);
        font-size: 0.64rem;
        font-weight: 800;
        letter-spacing: 0.07em;
        text-transform: uppercase;
      }

`;

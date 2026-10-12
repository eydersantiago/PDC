// ADACEEN | Capa 4 - UI: estilos de la pestaña Inicio, centro de contexto y operaciones activas.
// Dirección B (0.7.22): secciones separadas por una línea en vez de tarjetas dentro de tarjetas,
// rótulos en Plex Mono minúscula y el estado de la conexión como pares clave y valor.
// Orden de carga: manifest.json (content_scripts) y background.js (CONTENT_SCRIPT_FILES) deben coincidir.
"use strict";

const OVERLAY_HOME_STYLES = `      .main-top {
        display: flex;
        align-items: center;
        justify-content: space-between;
        gap: 10px;
        margin-bottom: 14px;
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

      .main-top-left {
        gap: 6px;
        min-width: 0;
      }

      .summary-actions {
        justify-content: flex-end;
      }

      .main-top .ghost-button {
        width: auto;
        min-height: 36px;
        padding: 6px 12px;
        font-size: 0.875rem;
      }

      .context-hub {
        border: 0;
        border-radius: 0;
        background: transparent;
        padding: 0;
        margin-bottom: 18px;
        display: grid;
        gap: 12px;
        box-shadow: none;
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
        font-size: 1rem;
        line-height: 1.3;
      }

      .context-meta {
        color: var(--adaceen-muted);
        font-size: 0.8125rem;
        line-height: 1.4;
        overflow-wrap: anywhere;
      }

      .state-chip {
        flex: 0 0 auto;
        border: 1px solid var(--adaceen-border);
        border-radius: var(--adaceen-radius-control);
        background: var(--adaceen-soft);
        color: var(--adaceen-body);
        padding: 3px 6px;
        font-family: var(--adaceen-mono);
        font-size: 0.75rem;
        font-weight: 400;
        line-height: 1.3;
        text-transform: lowercase;
        white-space: nowrap;
      }

      .state-chip.is-ok {
        border-color: var(--adaceen-primary-line);
        background: var(--adaceen-primary-soft);
        color: var(--adaceen-primary-strong);
      }

      .state-chip.is-warn {
        border-color: var(--adaceen-warning-line);
        background: var(--adaceen-warning-soft);
        color: var(--adaceen-warning);
      }

      /* Estado de la conexión como pares clave y valor en una franja suave: tres (túnel) o cuatro
         (Codespaces) por fila, sin tarjetas. */
      .connection-grid {
        display: grid;
        grid-template-columns: repeat(auto-fit, minmax(92px, 1fr));
        gap: 8px 12px;
        padding: 10px 12px;
        border-radius: var(--adaceen-radius-control);
        background: var(--adaceen-soft);
      }

      .connection-grid:empty {
        display: none;
      }

      .connection-grid:has(> :nth-child(4)) {
        grid-template-columns: repeat(auto-fit, minmax(140px, 1fr));
      }

      .connection-item {
        min-width: 0;
        border: 0;
        border-radius: 0;
        background: transparent;
        padding: 0;
        display: grid;
        gap: 2px;
      }

      .connection-item span {
        color: var(--adaceen-muted);
        font-family: var(--adaceen-mono);
        font-size: 0.75rem;
        font-weight: 400;
        letter-spacing: 0;
        text-transform: lowercase;
      }

      .connection-item strong {
        color: var(--adaceen-ink);
        font-size: 0.875rem;
        font-weight: 400;
        line-height: 1.3;
        overflow-wrap: break-word;
      }

      .connection-item.is-ok {
        border: 0;
        background: transparent;
      }

      .connection-item.is-warn strong {
        color: var(--adaceen-warning);
      }

      .next-action {
        border-top: 1px solid var(--adaceen-border);
        padding-top: 12px;
      }

      /* Un editor, varios repositorios (0.7.20): los que ya estan en el editor en la nube. */
      .editor-repos {
        display: grid;
        gap: 6px;
        border-top: 1px solid var(--adaceen-border);
        padding-top: 12px;
      }

      .editor-repos-list {
        list-style: none;
        margin: 0;
        padding: 0;
        display: grid;
        gap: 6px;
      }

      .editor-repo-open {
        width: 100%;
        min-height: 44px;
        display: flex;
        align-items: center;
        justify-content: space-between;
        gap: 8px;
        border: 1px solid var(--adaceen-border);
        border-radius: var(--adaceen-radius-control);
        background: #fff;
        color: var(--adaceen-ink);
        padding: 8px 10px;
        font: inherit;
        font-size: 0.875rem;
        text-align: left;
        cursor: pointer;
      }

      .editor-repo-open:hover:not([disabled]) {
        background: var(--adaceen-soft);
      }

      .editor-repo-open:focus-visible {
        outline: 2px solid var(--adaceen-focus);
        outline-offset: 2px;
      }

      .editor-repo-open[disabled] {
        cursor: progress;
        opacity: 0.7;
      }

      .editor-repo-name {
        font-family: var(--adaceen-mono);
        font-size: 0.8125rem;
        overflow-wrap: anywhere;
      }

      .editor-repo-go {
        flex: 0 0 auto;
        color: var(--adaceen-primary-strong);
        font-size: 0.8125rem;
        font-weight: 500;
      }

      .operation-banner {
        display: flex;
        align-items: center;
        gap: 10px;
        border: 0;
        border-radius: var(--adaceen-radius-control);
        background: var(--adaceen-soft);
        color: var(--adaceen-ink);
        padding: 10px 12px;
      }

      .operation-banner[hidden] {
        display: none !important;
      }

      .operation-banner strong {
        display: block;
        color: var(--adaceen-ink);
        font-size: 0.875rem;
        font-weight: 600;
        line-height: 1.3;
      }

      .operation-banner p {
        color: var(--adaceen-body);
        font-size: 0.8125rem;
        line-height: 1.4;
        margin: 2px 0 0;
      }

      .operation-spinner {
        width: 16px;
        height: 16px;
        flex: 0 0 auto;
        border: 2px solid var(--adaceen-primary-line);
        border-top-color: var(--adaceen-primary);
        border-radius: 999px;
        animation: adaceen-spin 0.8s linear infinite;
      }

      .operation-banner.is-error {
        background: var(--adaceen-danger-soft);
        color: var(--adaceen-danger);
      }

      .operation-banner.is-error strong {
        color: var(--adaceen-danger);
      }

      .operation-banner.is-error p {
        color: var(--adaceen-body);
      }

      .operation-banner.is-error .operation-spinner {
        border-color: var(--adaceen-danger-line);
        border-top-color: var(--adaceen-danger);
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
        font-size: 1rem;
        font-weight: 600;
        line-height: 1.3;
        margin-bottom: 4px;
      }

      .next-action p {
        color: var(--adaceen-body);
        font-size: 0.875rem;
        line-height: 1.5;
      }

      .context-actions {
        width: 100%;
        margin-top: 0;
      }

      /* Secciones (antes tarjetas con sombra): una línea arriba y aire. La primera de cada
         pestaña va sin línea (la barra de pestañas ya la tiene). */
      .summary-card,
      .teacher-card,
      .panel-section,
      .preview-card {
        border: 0;
        border-top: 1px solid var(--adaceen-border);
        border-radius: 0;
        background: transparent;
        padding: 14px 0 0;
        box-shadow: none;
      }

      .summary-card,
      .teacher-card,
      .panel-section {
        margin-bottom: 16px;
      }

      /* Primera sección visible: la primera hija o la que sigue a hijas ocultas al principio. Antes
         «[hidden] + :not([hidden])» le quitaba la línea a cualquier sección tras una oculta. */
      .tab-panel > :first-child,
      .tab-panel > [hidden]:first-child + :not([hidden]),
      .tab-panel > [hidden]:first-child + [hidden] + :not([hidden]),
      .tab-panel > [hidden]:first-child + [hidden] + [hidden] + :not([hidden]) {
        border-top: 0;
        padding-top: 0;
      }

      .summary-head {
        display: flex;
        align-items: flex-start;
        justify-content: space-between;
        gap: 8px;
      }

      .section-head {
        margin-bottom: 10px;
      }

      .section-head .eyebrow {
        margin-bottom: 0;
      }

      .section-title-row {
        display: flex;
        align-items: center;
        justify-content: space-between;
        gap: 8px;
        margin-bottom: 10px;
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
        min-height: 36px;
        padding: 6px 12px;
        font-size: 0.875rem;
      }

      .teacher-card {
        background: transparent;
        margin-bottom: 12px;
      }

      /* Rótulo de sección: monoespaciada en minúsculas, sin mayúsculas ni espaciado. */
      .eyebrow {
        display: block;
        margin-bottom: 6px;
        color: var(--adaceen-muted);
        font-family: var(--adaceen-mono);
        font-size: 0.8125rem;
        font-weight: 400;
        letter-spacing: 0;
        text-transform: lowercase;
      }

`;

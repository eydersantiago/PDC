// ADACEEN | Capa 4 - UI: vista de acceso (entrar, pasos y enlaces), código de estudiante en casillas y control
// segmentado. Movido sin cambios del final de shell.styles.js.
"use strict";

const OVERLAY_AUTH_STYLES = `      /* Vista de acceso: el contenido va directo en el panel (sin tarjeta dentro de la tarjeta). */
      .auth-card {
        margin-top: 16px;
      }

      .auth-view h1 {
        margin-top: 0;
      }

      .auth-step-line {
        display: flex;
        justify-content: space-between;
        gap: 12px;
        margin: 0 0 14px;
        color: var(--adaceen-muted);
        font-family: var(--adaceen-mono);
        font-size: 0.8125rem;
        overflow-wrap: anywhere;
      }

      .auth-step-line[hidden] {
        display: none;
      }

      .auth-step-count {
        flex: none;
      }

      .auth-step-count.is-pending {
        color: var(--adaceen-warning);
      }

      .auth-actions {
        margin-top: 16px;
      }

      .auth-links {
        display: flex;
        align-items: center;
        justify-content: space-between;
        gap: 12px;
      }

      .auth-links .policy-link[hidden] {
        display: none;
      }

      .auth-policy-note {
        margin-top: 4px;
        padding-top: 14px;
        border-top: 1px solid var(--adaceen-border);
      }

      .auth-policy-note[hidden] {
        display: none;
      }

      .policy-link {
        color: var(--adaceen-primary-strong);
        font-size: 0.875rem;
        text-underline-offset: 2px;
      }

      .policy-link:hover {
        color: var(--adaceen-ink);
      }

      .consent-link a {
        color: var(--adaceen-primary-strong);
        font-size: 0.875rem;
        text-underline-offset: 2px;
      }

      /* Código de estudiante (0.7.22): un campo sobre siete casillas. Cada casilla mide 44 px y
         van cada 50 px; con la letra monoespaciada, el espaciado (50 px menos el ancho de un
         carácter) deja cada dígito en el centro de su casilla. */
      .code-cells {
        position: relative;
        width: 344px;
        max-width: 100%;
        height: 52px;
        margin-top: 2px;
      }

      .code-cells-grid {
        position: absolute;
        inset: 0;
        display: grid;
        grid-template-columns: repeat(7, 44px);
        gap: 6px;
        pointer-events: none;
      }

      .code-cell {
        border: 1px solid var(--adaceen-control-border);
        border-radius: var(--adaceen-radius-control);
        background: #fff;
      }

      .code-cell.is-active {
        border: 2px solid var(--adaceen-primary);
        box-shadow: 0 0 0 3px var(--adaceen-primary-soft);
      }

      .code-cell.is-invalid {
        border: 2px solid var(--adaceen-danger);
        box-shadow: none;
      }

      /* Más específico que «.field input[type="text"]» de settings.styles.js. */
      .field .code-cells input.student-code-input,
      .student-code-input {
        position: absolute;
        inset: 0;
        width: 100%;
        height: 100%;
        min-height: 0;
        box-sizing: border-box;
        margin: 0;
        padding: 0 0 0 calc((44px - 1ch) / 2);
        border: 0;
        border-radius: 0;
        background: transparent;
        color: var(--adaceen-ink);
        caret-color: var(--adaceen-primary);
        font-family: var(--adaceen-mono);
        font-size: 24px;
        letter-spacing: calc(50px - 1ch);
        outline: none;
        box-shadow: none;
      }

      .field .code-cells input.student-code-input:focus,
      .field .code-cells input.student-code-input:focus-visible {
        outline: none;
        box-shadow: none;
      }

      .student-code-card .status.is-warning {
        display: flex;
        gap: 8px;
        font-size: 0.875rem;
        font-weight: 400;
      }

      .segmented {
        display: grid;
        grid-template-columns: repeat(2, 1fr);
        gap: 8px;
        margin-top: 14px;
      }

      .segment-button {
        min-height: 44px;
        border: 1px solid var(--adaceen-control-border);
        border-radius: var(--adaceen-radius-control);
        background: #fff;
        color: var(--adaceen-ink);
        cursor: pointer;
        padding: 10px;
        text-align: center;
        font-size: 0.875rem;
        font-weight: 500;
      }

      .segment-button.is-selected {
        border: 2px solid var(--adaceen-primary);
        background: var(--adaceen-primary-soft);
        color: var(--adaceen-primary-strong);
      }

`;

// ADACEEN | Capa 4 - UI: estilos de la estructura del shell, cabecera, controles comunes y autenticación.
// Dirección B (0.7.22): cabecera blanca con «adaceen» en monoespaciada, botones planos de 44 px,
// sin degradados ni sombras dentro de la ventana; rótulos en Plex Mono y texto en Plex Sans.
// Orden de carga: manifest.json (content_scripts) y background.js (CONTENT_SCRIPT_FILES) deben coincidir.
"use strict";

const OVERLAY_SHELL_STYLES = `      .minimized-tab-mark {
        display: inline-grid;
        place-items: center;
        flex: 0 0 auto;
        width: 28px;
        height: 28px;
        border-radius: var(--adaceen-radius-control);
        background: var(--adaceen-primary);
        color: #fff;
        font-family: var(--adaceen-mono);
        font-size: 0.875rem;
        font-weight: 500;
        line-height: 1;
        text-transform: lowercase;
      }

      .minimized-tab-copy {
        display: grid;
        min-width: 0;
        gap: 2px;
      }

      .minimized-tab-copy strong,
      .minimized-tab-copy span {
        display: block;
        max-width: 170px;
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
      }

      .minimized-tab-copy strong {
        color: var(--adaceen-ink);
        font-size: 0.875rem;
        font-weight: 500;
        line-height: 1.2;
      }

      .minimized-tab-copy span {
        color: var(--adaceen-muted);
        font-family: var(--adaceen-mono);
        font-size: 0.75rem;
        line-height: 1.25;
        text-transform: lowercase;
      }

      .header {
        display: flex;
        align-items: center;
        justify-content: space-between;
        gap: 8px;
        min-height: 48px;
        padding: 0 2px 0 14px;
        border-bottom: 1px solid var(--adaceen-border);
        background: var(--adaceen-panel);
        color: var(--adaceen-ink);
        cursor: grab;
      }

      .brand {
        display: flex;
        align-items: center;
        gap: 8px;
        min-width: 0;
      }

      .brand-mark {
        flex: none;
        color: var(--adaceen-ink);
        font-family: var(--adaceen-mono);
        font-size: 0.875rem;
        font-weight: 500;
        line-height: 1;
      }

      /* Con sesión, un borde separa la marca de quien entró. */
      .brand.has-user .brand-mark {
        padding-right: 10px;
        border-right: 1px solid var(--adaceen-border);
        line-height: 28px;
      }

      /* Iniciales de quien entró: un recuadro con el acento suave. */
      .user-badge {
        flex: none;
        display: inline-flex;
        align-items: center;
        justify-content: center;
        width: 28px;
        height: 28px;
        border: 1px solid var(--adaceen-primary-line);
        border-radius: var(--adaceen-radius-control);
        background: var(--adaceen-primary-soft);
        color: var(--adaceen-primary-strong);
        font-family: var(--adaceen-mono);
        font-size: 0.75rem;
        font-weight: 500;
        line-height: 1;
      }

      /* Sin sesión: la versión al lado de la marca. Con sesión: nombre arriba y rol abajo. */
      .brand-user {
        display: flex;
        align-items: baseline;
        gap: 6px;
        min-width: 0;
      }

      .brand.has-user .brand-user {
        display: grid;
        gap: 1px;
      }

      .brand strong {
        display: block;
        min-width: 0;
        color: var(--adaceen-ink);
        font-size: 0.875rem;
        font-weight: 500;
        line-height: 1.2;
        white-space: nowrap;
        overflow: hidden;
        text-overflow: ellipsis;
      }

      .brand strong[hidden] {
        display: none;
      }

      .brand-user > span {
        display: block;
        min-width: 0;
        color: var(--adaceen-muted);
        font-family: var(--adaceen-mono);
        font-size: 0.8125rem;
        line-height: 1.2;
        white-space: nowrap;
        overflow: hidden;
        text-overflow: ellipsis;
      }

      .brand.has-user .brand-user > span {
        font-size: 0.75rem;
      }

      .header-actions {
        display: flex;
        align-items: center;
        gap: 0;
      }

      .icon-button {
        display: inline-flex;
        align-items: center;
        justify-content: center;
        width: 44px;
        height: 44px;
        border: 0;
        border-radius: var(--adaceen-radius-control);
        background: transparent;
        color: var(--adaceen-ink);
        cursor: pointer;
        font-size: 0.9375rem;
        line-height: 1;
        transition: background 120ms ease;
      }

      .icon-button svg {
        display: block;
      }

      .icon-button:hover {
        background: #f0f0eb;
      }

      .body .icon-button,
      .settings-panel .icon-button,
      .teacher-rag-page .icon-button,
      .analysis-window .icon-button,
      .confirmation-dialog .icon-button {
        background: transparent;
        color: var(--adaceen-ink);
      }

      .body .icon-button:hover,
      .settings-panel .icon-button:hover,
      .teacher-rag-page .icon-button:hover,
      .analysis-window .icon-button:hover,
      .confirmation-dialog .icon-button:hover {
        background: #f0f0eb;
      }

      .icon-button:focus-visible,
      .primary-button:focus-visible,
      .ghost-button:focus-visible,
      .google-button:focus-visible,
      .save-button:focus-visible,
      .link-button:focus-visible,
      .segment-button:focus-visible,
      .goal-button:focus-visible,
      .student-course-option:focus-visible,
      .field input:focus-visible,
      .field select:focus-visible,
      .field textarea:focus-visible {
        outline: 2px solid var(--adaceen-focus);
        outline-offset: 2px;
      }

      .icon-button.text-button {
        width: auto;
        min-width: 44px;
        padding: 0 10px;
        font-size: 0.875rem;
        font-weight: 400;
      }

      .body {
        flex: 1 1 auto;
        min-height: 0;
        overflow: auto;
        overscroll-behavior: contain;
        padding: 16px 18px 18px;
        background: var(--adaceen-panel);
      }

      .body::-webkit-scrollbar,
      .settings-grid::-webkit-scrollbar,
      .bitacora-page-body::-webkit-scrollbar,
      .analysis-body::-webkit-scrollbar {
        width: 10px;
      }

      .body::-webkit-scrollbar-thumb,
      .settings-grid::-webkit-scrollbar-thumb,
      .bitacora-page-body::-webkit-scrollbar-thumb,
      .analysis-body::-webkit-scrollbar-thumb {
        border: 3px solid transparent;
        border-radius: 999px;
        background: rgba(90, 95, 102, 0.35);
        background-clip: content-box;
      }

      .view[hidden] {
        display: none;
      }

      /* Rótulos de contexto (antes pastillas en mayúsculas): texto monoespaciado en minúsculas. */
      .pill {
        display: inline-flex;
        align-items: center;
        min-height: 0;
        padding: 0;
        border: 0;
        border-radius: 0;
        background: transparent;
        color: var(--adaceen-muted);
        font-family: var(--adaceen-mono);
        font-size: 0.8125rem;
        font-weight: 400;
        letter-spacing: 0;
        text-transform: lowercase;
        max-width: 100%;
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
      }

      .extension-version-badge {
        display: inline-flex;
        align-items: center;
        max-width: 100%;
        color: var(--adaceen-muted);
        font-family: var(--adaceen-mono);
        font-size: 0.8125rem;
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
      }

      .role-pill::before {
        content: "· ";
        white-space: pre;
      }

      h1 {
        margin: 0 0 6px;
        color: var(--adaceen-ink);
        font-size: 1.25rem;
        font-weight: 600;
        line-height: 1.25;
      }

      h2 {
        margin: 0 0 8px;
        color: var(--adaceen-ink);
        font-size: 1rem;
        font-weight: 600;
        line-height: 1.3;
      }

      p {
        margin: 0;
        line-height: 1.5;
      }

      .copy {
        color: var(--adaceen-body);
        font-size: 0.9375rem;
        line-height: 1.5;
      }

      /* Botones y campos con la misma letra del overlay (sin esto Chrome usa la de controles
         del sistema y un enlace con estilo de boton se ve distinto a un boton). */
      button,
      input,
      select,
      textarea {
        font-family: inherit;
      }

      .primary-button,
      .ghost-button,
      .google-button,
      .save-button {
        width: 100%;
        min-height: 44px;
        border: 1px solid transparent;
        border-radius: var(--adaceen-radius-control);
        cursor: pointer;
        font-weight: 600;
        font-size: 0.9375rem;
        line-height: 1.2;
        padding: 10px 14px;
        transition: background 120ms ease, border-color 120ms ease, color 120ms ease;
      }

      .primary-button,
      .save-button {
        color: #fff;
        background: var(--adaceen-primary);
        border-color: var(--adaceen-primary);
        box-shadow: none;
      }

      .ghost-button {
        color: var(--adaceen-ink);
        background: #fff;
        border-color: var(--adaceen-control-border);
        font-weight: 500;
      }

      .danger-button {
        color: var(--adaceen-danger);
        background: #fff;
        border-color: var(--adaceen-danger);
      }

      .primary-button:hover,
      .save-button:hover {
        background: var(--adaceen-primary-strong);
        border-color: var(--adaceen-primary-strong);
      }

      .ghost-button:hover,
      .google-button:hover {
        background: var(--adaceen-soft);
      }

      .danger-button:hover {
        background: var(--adaceen-danger-soft);
      }

      /* Acción secundaria con aspecto de enlace (por ejemplo «Usar otra cuenta»). */
      .link-button {
        display: inline-flex;
        align-items: center;
        min-height: 44px;
        padding: 0;
        border: 0;
        background: transparent;
        color: var(--adaceen-primary-strong);
        cursor: pointer;
        font-size: 0.875rem;
        text-decoration: underline;
        text-underline-offset: 2px;
      }

      .link-button:hover {
        color: var(--adaceen-ink);
      }

      .google-button {
        display: flex;
        align-items: center;
        justify-content: center;
        gap: 10px;
        color: var(--adaceen-ink);
        background: #fff;
        border-color: var(--adaceen-control-border);
        font-weight: 500;
      }

      .auth-divider {
        display: flex;
        align-items: center;
        gap: 10px;
        margin: 16px 0 12px;
        color: var(--adaceen-muted);
        font-family: var(--adaceen-mono);
        font-size: 0.8125rem;
      }

      .auth-divider::before,
      .auth-divider::after {
        content: "";
        flex: 1;
        height: 1px;
        background: var(--adaceen-border);
      }

      .primary-button:disabled,
      .ghost-button:disabled,
      .google-button:disabled,
      .save-button:disabled,
      .link-button:disabled {
        cursor: not-allowed;
        opacity: 0.55;
      }

      .button-row {
        display: grid;
        gap: 8px;
        margin-top: 12px;
      }

      .button-row.split {
        grid-template-columns: 1fr 1fr;
      }

      /* En el aviso, «Cerrar sesión» toma lo justo y «Aceptar y continuar» el resto (cabe en una línea). */
      .confirmation-dialog .button-row.split {
        grid-template-columns: auto 1fr;
      }

      .confirmation-dialog .button-row.split .ghost-button {
        padding: 0 16px;
      }

      /* Vista de acceso: el contenido va directo en el panel (sin tarjeta dentro de la tarjeta). */
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

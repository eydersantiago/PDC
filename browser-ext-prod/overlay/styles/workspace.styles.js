// ADACEEN | Capa 4 - UI: estilos de la linea «Tu VS Code» de la pestaña Inicio (páginas de editor).
// 0.8.3: antes este archivo pintaba la paleta flotante junto al cursor y la tarjeta «Contexto de
// trabajo», que se quitaron (tapaban el panel). La línea va dentro del centro de contexto, separada
// por una línea fina como «Tus repositorios en el editor», con un punto de color para el estado.
// Orden de carga: manifest.json (content_scripts) y background.js (CONTENT_SCRIPT_FILES) deben coincidir.
"use strict";

const OVERLAY_WORKSPACE_STYLES = `      .vscode-link {
        display: flex;
        flex-wrap: wrap;
        align-items: center;
        gap: 8px 10px;
        border-top: 1px solid var(--adaceen-border);
        padding-top: 12px;
      }

      .vscode-link-dot {
        flex: 0 0 auto;
        align-self: flex-start;
        width: 8px;
        height: 8px;
        margin-top: 6px;
        border-radius: 999px;
        background: var(--adaceen-border-strong);
      }

      .vscode-link.is-ok .vscode-link-dot {
        background: var(--adaceen-success);
        box-shadow: 0 0 0 3px var(--adaceen-success-soft);
      }

      .vscode-link.is-warn .vscode-link-dot {
        background: var(--adaceen-warning);
        box-shadow: 0 0 0 3px var(--adaceen-warning-soft);
      }

      .vscode-link.is-busy .vscode-link-dot {
        background: var(--adaceen-primary);
        animation: adaceen-vscode-pulse 1.2s ease-in-out infinite;
      }

      @keyframes adaceen-vscode-pulse {
        0%, 100% { box-shadow: 0 0 0 0 var(--adaceen-primary-line); }
        50% { box-shadow: 0 0 0 4px var(--adaceen-primary-soft); }
      }

      @media (prefers-reduced-motion: reduce) {
        .vscode-link.is-busy .vscode-link-dot {
          animation: none;
        }
      }

      .vscode-link-copy {
        flex: 1 1 220px;
        min-width: 0;
        display: grid;
        gap: 2px;
      }

      .vscode-link-copy strong {
        color: var(--adaceen-ink);
        font-size: 0.875rem;
        font-weight: 600;
        line-height: 1.3;
      }

      .vscode-link.is-warn .vscode-link-copy strong {
        color: var(--adaceen-warning);
      }

      .vscode-link-copy span {
        color: var(--adaceen-muted);
        font-size: 0.8125rem;
        line-height: 1.4;
        overflow-wrap: anywhere;
      }

      .vscode-link-actions {
        display: flex;
        flex-wrap: wrap;
        gap: 6px;
        margin-left: auto;
      }

      .vscode-link-actions .ghost-button {
        width: auto;
        min-height: 36px;
        padding: 6px 12px;
        font-size: 0.8125rem;
      }

`;

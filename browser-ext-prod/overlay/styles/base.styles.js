// ADACEEN | Capa 4 - UI: estilos base (variables de diseño, reset y contenedor raíz).
// Extraído de overlay/content-styles.js (líneas 4-116).
// Orden de carga: manifest.json (content_scripts) y background.js (CONTENT_SCRIPT_FILES) deben coincidir.
"use strict";

const OVERLAY_BASE_STYLES = `
    <style>
      :host {
        all: initial;
        position: fixed;
        top: 16px;
        right: 16px;
        z-index: 2147483647;
        /* Dirección B (0.7.22): IBM Plex Sans para el texto y Plex Mono para datos, códigos,
           correos, rótulos y pestañas. Las fuentes van en la extensión (assets/fonts, OFL) y se
           registran en document.fonts (ensureAdaceenFonts, content-styles.js). */
        --adaceen-sans: "ADACEEN Plex Sans", system-ui, -apple-system, "Segoe UI", sans-serif;
        --adaceen-mono: "ADACEEN Plex Mono", ui-monospace, "SFMono-Regular", Menlo, Consolas, monospace;
        font-family: var(--adaceen-sans);
        --adaceen-ink: #1b1d1f;
        /* Texto de párrafos (6,9:1 sobre blanco); --adaceen-muted, metadatos y rótulos (6,3:1). */
        --adaceen-body: #3a3f45;
        --adaceen-muted: #5a5f66;
        --adaceen-soft: #f4f4f0;
        --adaceen-panel: #ffffff;
        --adaceen-panel-soft: #fafaf7;
        --adaceen-border: #deded8;
        --adaceen-border-strong: #c4c4bd;
        /* Lineas dentro de las tablas: entre filas y, mas suave, entre columnas. */
        --adaceen-table-line: #ecece7;
        --adaceen-table-divider: #f1f1ec;
        --adaceen-primary: #0b6466;
        --adaceen-primary-strong: #063d3d;
        --adaceen-primary-soft: #eaf3f3;
        --adaceen-primary-line: #bcd6d6;
        --adaceen-accent: #8a4a00;
        --adaceen-accent-soft: #fbf3e6;
        --adaceen-accent-strong: #6b3900;
        --adaceen-danger: #b42318;
        --adaceen-danger-soft: #fdf1f0;
        --adaceen-danger-line: #f0c5c0;
        --adaceen-warning: #8a4a00;
        --adaceen-warning-soft: #fbf3e6;
        --adaceen-warning-line: #e6cfa6;
        --adaceen-success: #1f6b45;
        --adaceen-success-soft: #edf5f0;
        --adaceen-success-line: #c5dccd;
        /* Una sombra nítida para separar la ventana de la página; nada de sombras difusas dentro. */
        --adaceen-shadow: 0 2px 8px rgba(27, 29, 31, 0.12), 0 14px 36px rgba(27, 29, 31, 0.1);
        --adaceen-shadow-soft: none;
        --adaceen-radius: 4px;
        --adaceen-radius-control: 3px;
        /* Borde de controles (>= 3:1, WCAG 1.4.11) y anillo de foco (WCAG 2.4.7). */
        --adaceen-control-border: #8a8f94;
        --adaceen-focus: #0b6466;
      }

      * {
        box-sizing: border-box;
      }

      /* Casillas y opciones con el acento de la dirección B (no el azul del sistema). */
      input[type="checkbox"],
      input[type="radio"] {
        accent-color: var(--adaceen-primary);
      }

      /* Lo oculto se oculta siempre (A12.12): un display: grid/flex de su clase anulaba el
         atributo hidden (p. ej. .next-action dejaba ver «Continuar» y «Actualizar» sin accion). */
      [hidden] {
        display: none !important;
      }

      .shell {
        width: min(400px, calc(100vw - 32px));
        color: var(--adaceen-ink);
        letter-spacing: 0;
        transition: width 180ms ease, transform 180ms ease;
      }

      .shell.is-minimized {
        width: min(244px, calc(100vw - 32px));
      }

      .window[hidden],
      .minimized-tab[hidden] {
        display: none !important;
      }

      .shell.has-tab-conflict .window > .body {
        filter: blur(2px);
        pointer-events: none;
        transition: filter 160ms ease;
      }

      .shell.shell-expanded {
        width: min(860px, calc(100vw - 32px));
      }

      .window {
        position: relative;
        display: flex;
        flex-direction: column;
        overflow: hidden;
        max-height: min(780px, calc(100dvh - 32px));
        border: 1px solid var(--adaceen-border-strong);
        border-radius: var(--adaceen-radius);
        background: var(--adaceen-panel);
        box-shadow: var(--adaceen-shadow);
        color: var(--adaceen-ink);
      }

      .minimized-tab {
        display: flex;
        align-items: center;
        gap: 10px;
        width: 100%;
        min-height: 48px;
        border: 1px solid var(--adaceen-border-strong);
        border-radius: var(--adaceen-radius);
        padding: 8px 11px;
        background: var(--adaceen-panel);
        color: var(--adaceen-ink);
        box-shadow: var(--adaceen-shadow);
        cursor: grab;
        font: inherit;
        text-align: left;
        touch-action: none;
        transition: transform 140ms ease, box-shadow 140ms ease, border-color 140ms ease;
        user-select: none;
      }

      .minimized-tab:hover {
        background: var(--adaceen-soft);
      }

      .minimized-tab.is-dragging {
        cursor: grabbing;
        transform: none;
      }

      .minimized-tab:focus-visible {
        outline: 2px solid var(--adaceen-focus);
        outline-offset: 2px;
      }

`;

// ADACEEN | Capa 4 - UI: dirección B, el pase de 0.8.3 para que el panel no se vea monótono (títulos, luces de
// estado, acción recomendada). Movido sin cambios del final de theme-b.styles.js.
"use strict";

const OVERLAY_THEME_B_083_STYLES = `      /* ==== 0.8.3 (piloto del 20/10/2026): menos monótono ====
         Antes todo empezaba igual: tarjeta blanca, rótulo gris en monoespaciada minúscula y valores
         del mismo color. Ahora: los títulos de sección son palabras (Plex Sans, en el color del
         texto) y la monoespaciada queda para los datos; cada estado lleva su luz de color; la acción
         recomendada tiene botones a su medida; y en Inicio solo el centro de contexto es tarjeta. */

      .eyebrow {
        margin-bottom: 8px;
        color: var(--adaceen-ink);
        font-family: var(--adaceen-sans);
        font-size: 0.875rem;
        font-weight: 600;
        line-height: 1.3;
        text-transform: none;
      }

      /* Antetítulo sobre un título más grande: discreto, para no apilar dos títulos. */
      .context-hub-head .eyebrow,
      .setup-step-card .eyebrow,
      .rag-course-active .eyebrow,
      .agenda-week-card .eyebrow {
        margin-bottom: 2px;
        color: var(--adaceen-muted);
        font-size: 0.8125rem;
        font-weight: 400;
      }

      .context-hub h2 {
        font-size: 1.0625rem;
      }

      /* En pantallas angostas la cabecera pasa a una columna: el estado, a lo ancho de su texto. */
      .context-hub-head .state-chip {
        justify-self: start;
      }

      .next-action .eyebrow {
        margin-bottom: 4px;
        color: var(--adaceen-primary-strong);
        font-size: 0.8125rem;
      }

      /* Luces de estado: verde listo, ámbar pendiente, gris sin empezar. */
      .connection-item strong {
        display: flex;
        align-items: flex-start;
        gap: 7px;
      }

      .connection-item strong::before {
        content: "";
        flex: 0 0 auto;
        width: 7px;
        height: 7px;
        margin-top: 0.5em;
        border-radius: 999px;
        background: var(--adaceen-border-strong);
      }

      .connection-item.is-ok strong::before {
        background: var(--adaceen-success);
      }

      .connection-item.is-warn strong::before {
        background: var(--adaceen-warning);
      }

      .connection-item.is-error strong::before {
        background: var(--adaceen-danger);
      }

      /* Acción recomendada: los botones a su medida y a la derecha, no dos mitades iguales. */
      .next-action .context-actions {
        display: flex;
        flex-wrap: wrap;
        justify-content: flex-end;
        gap: 8px;
      }

      .next-action .context-actions > button {
        width: auto;
        min-width: 132px;
      }

      /* Inicio: después del centro de contexto, la política y el resumen de sesión van sobre el fondo
         del panel; sus datos, en una franja blanca. La tarjeta queda para lo principal. */
      #tabPanelInicio > .home-facts,
      #tabPanelInicio > .home-session {
        margin: 18px 0 12px;
        padding: 0 2px;
        border: 0;
        background: transparent;
      }

      #tabPanelInicio > .home-facts .kv-grid,
      #tabPanelInicio > .home-session .kv-grid:not(.kv-list) {
        border: 1px solid var(--adaceen-border);
        background: var(--adaceen-panel);
      }

      /* «Panel administrador» va en filas (kv-list): dentro de la franja, con su margen. */
      #tabPanelInicio > .home-facts .kv-grid.kv-list {
        padding: 10px 12px;
      }

      #tabPanelInicio > .home-session .summary-title {
        margin-top: 2px;
        font-size: 0.9375rem;
        font-weight: 600;
      }

      /* Indicadores del docente: el número manda. */
      .kpi-value {
        font-family: var(--adaceen-mono);
        font-size: 1.375rem;
        font-weight: 500;
        font-variant-numeric: tabular-nums;
        line-height: 1.1;
      }

      /* «Tema del piloto»: «Quitar tema» y «Guardar tema» a su medida, como la acción recomendada. */
      .pilot-topic-section > .button-row.split {
        display: flex;
        flex-wrap: wrap;
        justify-content: flex-end;
      }

      .pilot-topic-section > .button-row.split > button {
        width: auto;
        min-width: 132px;
      }

      /* Tutor: las pistas con su marca de color y los pasos (que sí son una secuencia) numerados. */
      #ideaList li::marker {
        color: var(--adaceen-primary);
      }

      #guideList {
        padding-left: 0;
        list-style: none;
        counter-reset: adaceen-paso;
      }

      #guideList li {
        position: relative;
        padding-left: 32px;
        counter-increment: adaceen-paso;
      }

      #guideList li::before {
        content: counter(adaceen-paso);
        position: absolute;
        left: 0;
        top: 0.1em;
        width: 22px;
        height: 22px;
        display: grid;
        place-items: center;
        border-radius: 999px;
        background: var(--adaceen-primary-soft);
        color: var(--adaceen-primary-strong);
        font-family: var(--adaceen-mono);
        font-size: 0.8125rem;
        font-weight: 500;
        line-height: 1;
      }

`;

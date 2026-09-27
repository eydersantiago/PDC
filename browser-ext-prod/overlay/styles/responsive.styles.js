// ADACEEN | Capa 4 - UI: reglas de medios responsive, reducción de movimiento (accesibilidad) y cierre de estilos.
// Extraído de overlay/content-styles.js (líneas 3820-3836).
// Orden de carga: manifest.json (content_scripts) y background.js (CONTENT_SCRIPT_FILES) deben coincidir.
"use strict";

const OVERLAY_RESPONSIVE_STYLES = `      @media (max-width: 720px) {
        .quizzes-columns {
          grid-template-columns: 1fr;
        }
      }

      @media (prefers-reduced-motion: reduce) {
        .shell *,
        .shell *::before,
        .shell *::after {
          animation-duration: 0.01ms !important;
          animation-iteration-count: 1 !important;
          transition-duration: 0.01ms !important;
          transition-delay: 0s !important;
        }
      }
    </style>
`;

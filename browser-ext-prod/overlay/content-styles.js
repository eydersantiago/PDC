// ADACEEN | Capa 4 - UI: hoja de estilos del shadow DOM del overlay.
// Ensambla los módulos de overlay/styles/*.styles.js en orden estricto de cascada.
// Orden de carga: manifest.json (content_scripts) y background.js (CONTENT_SCRIPT_FILES) deben coincidir.
"use strict";

const OVERLAY_STYLES =
  OVERLAY_BASE_STYLES +
  OVERLAY_WORKSPACE_STYLES +
  OVERLAY_SHELL_STYLES +
  OVERLAY_HOME_STYLES +
  OVERLAY_TUTOR_STYLES +
  OVERLAY_SETTINGS_STYLES +
  OVERLAY_TABS_STYLES +
  OVERLAY_STUDENTS_STYLES +
  OVERLAY_RAG_STYLES +
  OVERLAY_USERS_STYLES +
  OVERLAY_STUDENT_DETAIL_STYLES +
  OVERLAY_A11Y_STYLES +
  OVERLAY_QUIZZES_STYLES +
  OVERLAY_BITACORA_STYLES +
  OVERLAY_AGENDA_STYLES +
  OVERLAY_THEME_B_STYLES +
  OVERLAY_RESPONSIVE_STYLES;

// Tipografías de la dirección B (0.7.22): IBM Plex Sans y Mono (licencia OFL, en assets/fonts).
// Un @font-face dentro del shadow root no se aplica, así que se registran en document.fonts con
// nombres propios («ADACEEN Plex …») para no chocar con las fuentes de la página. Se sirven desde la
// extensión (web_accessible_resources): no se pide nada a Google Fonts. Si la página o el navegador
// no las cargan, base.styles.js cae a las fuentes del sistema.
const ADACEEN_FONT_FILES = [
  { family: "ADACEEN Plex Sans", weight: "400", file: "ibm-plex-sans-latin-400-normal.woff2" },
  { family: "ADACEEN Plex Sans", weight: "500", file: "ibm-plex-sans-latin-500-normal.woff2" },
  { family: "ADACEEN Plex Sans", weight: "600", file: "ibm-plex-sans-latin-600-normal.woff2" },
  { family: "ADACEEN Plex Mono", weight: "400", file: "ibm-plex-mono-latin-400-normal.woff2" },
  { family: "ADACEEN Plex Mono", weight: "500", file: "ibm-plex-mono-latin-500-normal.woff2" },
];

let adaceenFontsRegistered = false;

function ensureAdaceenFonts() {
  if (adaceenFontsRegistered) {
    return;
  }
  adaceenFontsRegistered = true;
  try {
    if (typeof FontFace !== "function" || !document.fonts || typeof chrome === "undefined" || !chrome.runtime?.getURL) {
      return;
    }
    for (const font of ADACEEN_FONT_FILES) {
      const url = chrome.runtime.getURL(`assets/fonts/${font.file}`);
      const face = new FontFace(font.family, `url("${url}") format("woff2")`, {
        weight: font.weight,
        style: "normal",
        display: "swap",
      });
      document.fonts.add(face);
      face.load().catch(() => {
        // La página bloqueó la fuente (CSP) o no se encontró: quedan las del sistema.
      });
    }
  } catch {
    // Sin FontFace o sin contexto de la extensión: quedan las fuentes del sistema.
  }
}

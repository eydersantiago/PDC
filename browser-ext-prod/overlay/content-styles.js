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
  OVERLAY_RESPONSIVE_STYLES;

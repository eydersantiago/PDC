"use strict";

// ADACEEN | Capa 4 - UI: pestañas de la vista principal por rol (barra, teclado y cambio de pestaña).
// Movido sin cambios de content-students.js.

const MAIN_TAB_LABELS = Object.freeze({
  inicio: "Inicio",
  tutor: "Tutor",
  agenda: "Agenda",
  estudiantes: "Estudiantes",
  rag: "RAG",
  quices: "Quices",
  bitacora: "Bitácora",
  usuarios: "Usuarios",
});

// ---- Pestanas ----

// Pestanas que ve el rol de la sesion actual, en el orden de la barra.
function getAvailableMainTabs() {
  // Administrador: «RAG» y «Bitácora» (0.7.22) para cargar las de un docente.
  if (isAdminSession()) return ["inicio", "estudiantes", "rag", "bitacora", "usuarios"];
  if (isTeacherSession()) return ["inicio", "tutor", "estudiantes", "rag", "quices", "bitacora", "usuarios"];
  return ["inicio", "tutor", "agenda"];
}

function normalizeMainTab(value) {
  const tab = toText(value).toLowerCase();
  const available = getAvailableMainTabs();
  return available.includes(tab) ? tab : available[0];
}

function getMainTabButton(tab) {
  if (!overlayEls) return null;
  if (tab === "tutor") return overlayEls.tabBtnTutor;
  if (tab === "agenda") return overlayEls.tabBtnAgenda;
  if (tab === "estudiantes") return overlayEls.tabBtnEstudiantes;
  if (tab === "rag") return overlayEls.tabBtnRag;
  if (tab === "quices") return overlayEls.tabBtnQuices;
  if (tab === "bitacora") return overlayEls.tabBtnBitacora;
  if (tab === "usuarios") return overlayEls.tabBtnUsuarios;
  return overlayEls.tabBtnInicio;
}

function getMainTabPanel(tab) {
  if (!overlayEls) return null;
  if (tab === "tutor") return overlayEls.tabPanelTutor;
  if (tab === "agenda") return overlayEls.tabPanelAgenda;
  if (tab === "estudiantes") return overlayEls.tabPanelEstudiantes;
  if (tab === "rag") return overlayEls.tabPanelRag;
  if (tab === "quices") return overlayEls.tabPanelQuices;
  if (tab === "bitacora") return overlayEls.tabPanelBitacora;
  if (tab === "usuarios") return overlayEls.tabPanelUsuarios;
  return overlayEls.tabPanelInicio;
}

// Cambia de pestana. byUser: la eligio la persona (no se salta sola a "tutor" despues).
function setMainTab(tab, options = {}) {
  const next = normalizeMainTab(tab);
  const changed = overlayState.mainTab !== next;
  overlayState.mainTab = next;
  if (options.byUser) overlayState.mainTabChosenByUser = true;
  if (next === "estudiantes" && typeof ensureStudentsProgressLoaded === "function") {
    ensureStudentsProgressLoaded();
  }
  // Tema del piloto (0.7.21): la tarjeta va arriba de la lista de estudiantes.
  if (next === "estudiantes" && typeof ensurePilotTopicLoaded === "function") {
    ensurePilotTopicLoaded();
  }
  if (next === "rag" && typeof ensureTeacherRagLoaded === "function") {
    ensureTeacherRagLoaded();
  }
  if (next === "quices" && typeof ensureQuizzesPanelLoaded === "function") {
    ensureQuizzesPanelLoaded();
  }
  if ((next === "bitacora" || next === "agenda") && typeof ensureTeacherBitacoraLoaded === "function") {
    ensureTeacherBitacoraLoaded();
  }
  // «Usuarios» muestra el lote de RAG aplicado y, al editar, los lotes de cada curso.
  if (next === "usuarios" && isTeacherSession() && typeof ensureRagLotsLoaded === "function") {
    ensureRagLotsLoaded();
  }
  if (changed || options.forceRender) {
    renderOverlay();
  }
  if (options.focus) {
    const button = getMainTabButton(next);
    if (button && typeof button.focus === "function") button.focus();
  }
  return next;
}

// Llegan pistas del tutor: se abre "Tutor". Si la persona pidio la ayuda («Actualizar»,
// Ctrl+Enter) siempre; si fue un refresco automatico, solo cuando no eligio otra pestana.
function showTutorTabForResponse(options = {}) {
  if (isAdminSession()) return;
  if (!options.manual && overlayState.mainTabChosenByUser) return;
  overlayState.mainTab = normalizeMainTab("tutor");
}

function renderMainTabs(showingMainView) {
  if (!overlayEls?.mainTabBar) return;
  const available = getAvailableMainTabs();
  const active = normalizeMainTab(overlayState.mainTab);
  overlayState.mainTab = active;
  for (const tab of MAIN_TAB_IDS) {
    const button = getMainTabButton(tab);
    const panel = getMainTabPanel(tab);
    const visible = available.includes(tab);
    const isActive = visible && tab === active;
    if (button) {
      button.hidden = !visible;
      button.classList.toggle("is-active", isActive);
      button.setAttribute("aria-selected", isActive ? "true" : "false");
      button.tabIndex = isActive ? 0 : -1;
    }
    if (panel) {
      panel.hidden = !showingMainView || !isActive;
    }
  }
  overlayEls.mainTabBar.hidden = !showingMainView || available.length < 2;
  // La linea de estado del tutor («Falta contexto suficiente...») es de Inicio y Tutor: en las
  // pestañas de gestion (cada una con sus propios avisos) solo distraia.
  overlayEls.statusText?.classList?.toggle("is-off-tab", showingMainView && available.length >= 2 && !["inicio", "tutor"].includes(active));

  const count = Array.isArray(overlayState.studentsPanel?.items) ? overlayState.studentsPanel.items.length : 0;
  if (overlayEls.tabCountEstudiantes) {
    overlayEls.tabCountEstudiantes.hidden = count === 0;
    setTextIfChanged(overlayEls.tabCountEstudiantes, count > 0 ? String(count) : "");
  }
}

// Flechas, Inicio y Fin mueven el foco y activan la pestana (patron tablist de WAI-ARIA).
function handleMainTabKeydown(event) {
  const key = toText(event?.key);
  if (!["ArrowLeft", "ArrowRight", "Home", "End"].includes(key)) return;
  const available = getAvailableMainTabs();
  const current = available.indexOf(normalizeMainTab(overlayState.mainTab));
  let index = current;
  if (key === "ArrowLeft") index = (current - 1 + available.length) % available.length;
  if (key === "ArrowRight") index = (current + 1) % available.length;
  if (key === "Home") index = 0;
  if (key === "End") index = available.length - 1;
  event.preventDefault?.();
  setMainTab(available[index], { byUser: true, focus: true });
}

function bindMainTabs() {
  if (!overlayEls) return;
  for (const tab of MAIN_TAB_IDS) {
    const button = getMainTabButton(tab);
    if (!button) continue;
    button.addEventListener("click", () => {
      setMainTab(tab, { byUser: true, forceRender: true });
    });
    button.addEventListener("keydown", handleMainTabKeydown);
  }
}

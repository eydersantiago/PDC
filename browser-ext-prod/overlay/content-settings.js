// ADACEEN | Capa 4 - UI: tuerca (ajustes por secciones), politica de aplicacion de codigo y ayuda de los RA.
// Movido sin cambios desde content-render.js (sincronizar, abrir y guardar ajustes) y desde
// content-lifecycle.js (listeners de la tuerca, ahora en bindSettingsPanel, llamada desde ensureOverlay).
// Sin "use strict": el codigo viene de archivos en modo no estricto y se conserva igual.
// Orden de carga: manifest.json (content_scripts) y background.js (CONTENT_SCRIPT_FILES) deben coincidir.

function normalizeCodeApplicationPolicy(value) {
  const defaults = DEFAULT_POLICY.codeApplication;
  const source = value && typeof value === "object" ? value : {};
  const maxLines = Math.round(Number(source.maxLines));
  return {
    allowed: typeof source.allowed === "boolean" ? source.allowed : defaults.allowed,
    maxLines: Number.isFinite(maxLines) ? Math.min(200, Math.max(1, maxLines)) : defaults.maxLines,
    countsAsHint: typeof source.countsAsHint === "boolean" ? source.countsAsHint : defaults.countsAsHint,
    requireConfirmation: typeof source.requireConfirmation === "boolean"
      ? source.requireConfirmation
      : defaults.requireConfirmation,
  };
}

function describeCodeApplicationPolicy(policy) {
  const settings = normalizeCodeApplicationPolicy(policy?.codeApplication);
  if (!settings.allowed) return "Aplicar codigo desde VS Code: desactivado";
  return [
    `Aplicar codigo desde VS Code: hasta ${settings.maxLines} lineas`,
    settings.countsAsHint ? "cuenta como pista" : "no cuenta como pista",
    // Desde VS Code 0.0.32 el clic del estudiante cuenta como confirmacion en cambios cortos
    // (hasta 5 lineas, sin borrar codigo); el dialogo queda para los demas.
    settings.requireConfirmation ? "pide confirmacion en cambios grandes o automaticos" : "sin confirmacion",
  ].join(", ");
}

// Antes los campos se reescribian en cada render (cada 5 s en Codespaces) y se perdia lo
// escrito: solo se sincronizan cuando cambia algo de esta clave.
function buildSettingsSyncKey() {
  return JSON.stringify([
    overlayState.settingsOpen === true,
    overlayState.assistantEnabled,
    overlayState.autoConfigEnabled,
    overlayState.backendUrl,
    overlayState.session?.user?.id || "",
    overlayState.session?.user?.role || "",
    overlayState.policy || DEFAULT_POLICY,
  ]);
}

function syncSettingsInputs() {
  if (!overlayEls) return;

  const policy = overlayState.policy || DEFAULT_POLICY;
  if (!renderKeyChanged(overlayEls.settingsPanel || overlayEls.teacherSettingsBlock, buildSettingsSyncKey())) return;

  overlayEls.teacherEnabled.checked = !!overlayState.assistantEnabled;
  overlayEls.autoConfigEnabled.checked = !!overlayState.autoConfigEnabled;
  overlayEls.backendUrlInput.value = overlayState.backendUrl;
  overlayEls.settingsSessionLabel.value = overlayState.session?.user?.displayName || "Sesion sin iniciar";
  overlayEls.settingsSessionMeta.value = overlayState.session
    ? `${getRoleLabel(overlayState.session.user.role)} | ${overlayState.session.user.email}`
    : "Inicia sesion para activar roles, politicas y telemetria.";
  overlayEls.teacherSettingsBlock.hidden = !isTeacherSession();

  if (!isTeacherSession()) return;

  overlayEls.teacherPolicyName.value = policy.policyName || DEFAULT_POLICY.policyName;
  overlayEls.teacherOutcome.value = policy.outcome || DEFAULT_POLICY.outcome;
  overlayEls.teacherTone.value = policy.tone || DEFAULT_POLICY.tone;
  overlayEls.teacherFrequency.value = policy.frequency || DEFAULT_POLICY.frequency;
  overlayEls.teacherHelpLevel.value = policy.helpLevel || DEFAULT_POLICY.helpLevel;
  // Una sola casilla para el mini quiz (auditoria de redundancias, item 9): "Permitir mini
  // quiz" escribe allowMiniQuiz y el tipo "mini_quiz" de las intervenciones habilitadas.
  overlayEls.teacherMiniQuiz.checked = !!policy.allowMiniQuiz;
  const quizSettings = { ...DEFAULT_POLICY.quizSettings, ...(policy.quizSettings || {}) };
  const quizTriggers = Array.isArray(quizSettings.triggers) ? quizSettings.triggers : [];
  overlayEls.teacherQuizAfterAccept.checked = quizTriggers.includes("after_accept");
  overlayEls.teacherQuizTeacherLaunch.checked = quizTriggers.includes("teacher_launch");
  overlayEls.teacherQuizFollowUp.checked = quizSettings.followUpOnWrong !== false;
  overlayEls.teacherQuizEveryN.value = String(quizSettings.everyNAccepts || 1);
  overlayEls.teacherQuizMaxPerSession.value = quizSettings.maxPerSession == null ? "" : String(quizSettings.maxPerSession);
  const codeApplication = normalizeCodeApplicationPolicy(policy.codeApplication);
  overlayEls.teacherCodeApplyAllowed.checked = codeApplication.allowed;
  overlayEls.teacherCodeApplyMaxLines.value = String(codeApplication.maxLines);
  overlayEls.teacherCodeApplyCountsAsHint.checked = codeApplication.countsAsHint;
  overlayEls.teacherCodeApplyRequireConfirmation.checked = codeApplication.requireConfirmation;
  syncCodeApplicationInputsState();
  overlayEls.teacherNoSolution.checked = !!policy.strictNoSolution;
  overlayEls.teacherMaxHints.value = policy.maxHintsPerExercise == null ? "" : String(policy.maxHintsPerExercise);
  overlayEls.teacherAllowExplanation.checked = (policy.allowedInterventions || []).includes("explanation");
  overlayEls.teacherAllowHint.checked = (policy.allowedInterventions || []).includes("hint");
  overlayEls.teacherAllowExample.checked = (policy.allowedInterventions || []).includes("example");
  overlayEls.teacherFallbackMessage.value = policy.fallbackMessage || DEFAULT_POLICY.fallbackMessage;
  overlayEls.teacherCustomInstruction.value = policy.customInstruction || "";
}

// Con "Permitir aplicar codigo" apagado, los demas ajustes no aplican.
function syncCodeApplicationInputsState() {
  if (!overlayEls?.teacherCodeApplyAllowed) return;
  const allowed = !!overlayEls.teacherCodeApplyAllowed.checked;
  for (const input of [
    overlayEls.teacherCodeApplyMaxLines,
    overlayEls.teacherCodeApplyCountsAsHint,
    overlayEls.teacherCodeApplyRequireConfirmation,
  ]) {
    if (input) input.disabled = !allowed;
  }
}

function readCodeApplicationSettingsFromInputs() {
  const previous = normalizeCodeApplicationPolicy(overlayState.policy?.codeApplication);
  const rawMaxLines = Math.round(Number(overlayEls.teacherCodeApplyMaxLines.value));
  return {
    allowed: !!overlayEls.teacherCodeApplyAllowed.checked,
    maxLines: Number.isFinite(rawMaxLines) && rawMaxLines > 0
      ? Math.min(200, Math.max(1, rawMaxLines))
      : previous.maxLines,
    countsAsHint: !!overlayEls.teacherCodeApplyCountsAsHint.checked,
    requireConfirmation: !!overlayEls.teacherCodeApplyRequireConfirmation.checked,
  };
}

// Resultados de aprendizaje del curso (0.7.15): peso de cada RA en la nota y como se
// reparte entre las evaluaciones (tabla del programa del curso). El enunciado de cada RA se
// completa cuando el docente lo entregue.
const LEARNING_OUTCOME_EVALUATIONS = Object.freeze(["Parcial 1", "Parcial 2", "Lab 1", "Lab 2", "Lab 3", "Lab 4", "Proyecto"]);

const LEARNING_OUTCOME_HELP = Object.freeze([
  { code: "RA1", weight: 15, split: [3.88, 0, 2.18, 2.67, 2.67, 1.94, 1.94] },
  { code: "RA2", weight: 21, split: [3.64, 0.49, 1.46, 2.43, 3.64, 4.13, 4.85] },
  { code: "RA3", weight: 29, split: [2.18, 4.85, 1.46, 3.16, 4.37, 6.55, 6.31] },
  { code: "RA4", weight: 29, split: [0, 0.49, 5.34, 5.58, 6.07, 5.34, 5.83] },
  { code: "RA5", weight: 7, split: [0, 0, 1.7, 0.73, 1.7, 1.7, 0.73] },
]);

function formatOutcomePercent(value) {
  const number = Number(value) || 0;
  return `${number.toLocaleString("es-CO", { minimumFractionDigits: 0, maximumFractionDigits: 2 })} %`;
}

function renderTeacherOutcomeHelp() {
  const panel = overlayEls?.teacherOutcomeHelp;
  const button = overlayEls?.teacherOutcomeHelpBtn;
  if (!panel || !button) return;
  const open = !!overlayState.teacherOutcomeHelpOpen;
  panel.hidden = !open;
  button.setAttribute("aria-expanded", open ? "true" : "false");
  button.classList.toggle("is-active", open);
  if (!open) return;
  const selected = toText(overlayEls.teacherOutcome?.value) || "RA1";
  const key = JSON.stringify([selected]);
  if (!renderKeyChanged(panel, key)) return;
  panel.textContent = "";
  const intro = document.createElement("p");
  intro.className = "help-intro";
  intro.textContent = "Cada resultado de aprendizaje (RA) pesa un porcentaje de la nota del curso, repartido entre las evaluaciones. El RA elegido orienta las pistas del tutor hacia esa parte del curso.";
  panel.appendChild(intro);
  const list = document.createElement("ul");
  list.className = "help-outcomes";
  LEARNING_OUTCOME_HELP.forEach((outcome) => {
    const item = document.createElement("li");
    item.className = `help-outcome${outcome.code === selected ? " is-selected" : ""}`;
    const head = document.createElement("div");
    head.className = "help-outcome-head";
    const code = document.createElement("strong");
    code.textContent = `${outcome.code} · ${formatOutcomePercent(outcome.weight)} de la nota`;
    head.appendChild(code);
    if (outcome.code === selected) {
      const badge = document.createElement("span");
      badge.className = "admin-chip is-active";
      badge.textContent = "Elegido";
      head.appendChild(badge);
    }
    item.appendChild(head);
    const description = document.createElement("p");
    description.className = "help-outcome-text";
    description.textContent = toText(outcome.description) || "Enunciado del RA: pendiente de confirmar con el programa del curso.";
    item.appendChild(description);
    const split = document.createElement("p");
    split.className = "help-outcome-split";
    split.textContent = LEARNING_OUTCOME_EVALUATIONS
      .map((label, index) => [label, outcome.split[index]])
      .filter(([, value]) => Number(value) > 0)
      .map(([label, value]) => `${label} ${formatOutcomePercent(value)}`)
      .join(" · ");
    item.appendChild(split);
    list.appendChild(item);
  });
  panel.appendChild(list);
}

function setSettingsOpen(nextValue) {
  overlayState.settingsOpen = !!nextValue;
  if (overlayState.settingsOpen && isTeacherSession()) {
    void refreshClassQuizStatus();
  }
  if (overlayState.settingsOpen && !overlayState.settingsSectionsInitialized) {
    // Primera apertura de la sesion: el docente empieza por su politica; el estudiante, por
    // la sesion y el tutor. Despues se respeta lo que cada quien pliegue o despliegue.
    overlayState.settingsSectionsInitialized = true;
    if (overlayEls?.settingsSectionSession) overlayEls.settingsSectionSession.open = !isTeacherSession();
    if (overlayEls?.settingsSectionPolicy) overlayEls.settingsSectionPolicy.open = isTeacherSession();
  }
  if (overlayEls?.window) {
    overlayEls.window.classList.toggle("settings-open", overlayState.settingsOpen);
    // La tuerca se abre bajo la cabecera: «Salir» (el unico boton para cerrar sesion) sigue a
    // la vista con la tuerca abierta.
    const headerHeight = overlayState.settingsOpen ? Number(overlayEls.dragHandle?.offsetHeight) || 0 : 0;
    if (headerHeight > 0) {
      overlayEls.window.style?.setProperty?.("--adaceen-settings-top", `${Math.round(headerHeight)}px`);
    }
  }
  overlayEls?.settingsBtn?.setAttribute("aria-expanded", overlayState.settingsOpen ? "true" : "false");
  scheduleOverlayViewportSync(true);
}

async function saveSettingsFromOverlay() {
  let settingsWarning = "";
  overlayState.assistantEnabled = !!overlayEls.teacherEnabled.checked;
  overlayState.autoConfigEnabled = !!overlayEls.autoConfigEnabled.checked;
  const requestedBackendUrl = normalizeBaseUrl(overlayEls.backendUrlInput.value);
  const backendUrlRejected = !!requestedBackendUrl && !toSafeHttpUrl(requestedBackendUrl);
  if (!backendUrlRejected) {
    overlayState.backendUrl = requestedBackendUrl || DEFAULT_BACKEND_URL;
  }
  await persistPreferences();

  if (isTeacherSession() && overlayState.sessionId) {
    // "Permitir mini quiz" es la unica casilla del mini quiz: activa el quiz y su tipo de
    // intervencion a la vez (antes eran dos casillas que podian contradecirse).
    const allowMiniQuiz = !!overlayEls.teacherMiniQuiz.checked;
    const allowedInterventions = [
      overlayEls.teacherAllowExplanation.checked ? "explanation" : "",
      overlayEls.teacherAllowHint.checked ? "hint" : "",
      overlayEls.teacherAllowExample.checked ? "example" : "",
      allowMiniQuiz ? "mini_quiz" : "",
    ].filter(Boolean);

    const nextPolicy = {
      policyName: overlayEls.teacherPolicyName.value.trim() || DEFAULT_POLICY.policyName,
      outcome: overlayEls.teacherOutcome.value,
      tone: overlayEls.teacherTone.value,
      frequency: overlayEls.teacherFrequency.value,
      helpLevel: overlayEls.teacherHelpLevel.value,
      allowMiniQuiz,
      quizSettings: {
        triggers: [
          overlayEls.teacherQuizAfterAccept.checked ? "after_accept" : "",
          overlayEls.teacherQuizTeacherLaunch.checked ? "teacher_launch" : "",
        ].filter(Boolean),
        everyNAccepts: Math.min(20, Math.max(1, Math.round(Number(overlayEls.teacherQuizEveryN.value) || 1))),
        maxPerSession: overlayEls.teacherQuizMaxPerSession.value
          ? Math.min(50, Math.max(1, Math.round(Number(overlayEls.teacherQuizMaxPerSession.value) || 5)))
          : null,
        followUpOnWrong: !!overlayEls.teacherQuizFollowUp.checked,
      },
      strictNoSolution: !!overlayEls.teacherNoSolution.checked,
      maxHintsPerExercise: overlayEls.teacherMaxHints.value
        ? Math.max(1, Number(overlayEls.teacherMaxHints.value) || DEFAULT_POLICY.maxHintsPerExercise)
        : null,
      fallbackMessage: overlayEls.teacherFallbackMessage.value.trim() || DEFAULT_POLICY.fallbackMessage,
      customInstruction: overlayEls.teacherCustomInstruction.value.trim(),
      allowedInterventions: allowedInterventions.length > 0
        ? allowedInterventions
        : DEFAULT_POLICY.allowedInterventions.filter((type) => allowMiniQuiz || type !== "mini_quiz"),
      // A10.8: limites para aplicar codigo desde VS Code (el backend los hace cumplir).
      codeApplication: readCodeApplicationSettingsFromInputs(),
    };

    const putPolicy = (body) => fetchJsonWithTimeout(`${normalizeBaseUrl(overlayState.backendUrl)}/api/policies/current`, {
      method: "PUT",
      headers: buildApiHeaders(),
      body: JSON.stringify(body),
    });

    try {
      let response = null;
      try {
        response = await putPolicy(nextPolicy);
      } catch (error) {
        // Un backend anterior al contrato rechaza la clave nueva (esquema estricto):
        // se guarda el resto de la politica y se avisa.
        if (!/codeApplication/i.test(String(error?.message || error))) throw error;
        const { codeApplication: _omitido, ...legacyPolicy } = nextPolicy;
        response = await putPolicy(legacyPolicy);
        settingsWarning = "Politica docente guardada, pero este backend aun no admite los ajustes de aplicar codigo desde VS Code.";
      }
      overlayState.policy = response.policy || overlayState.policy;
      overlayState.telemetry = Array.isArray(response.telemetry) ? response.telemetry : overlayState.telemetry;
      overlayState.statusMessage = settingsWarning || "Politica docente guardada.";
    } catch (error) {
      overlayState.statusMessage = `No se pudo guardar la politica: ${String(error)}`;
    }
  } else {
    overlayState.statusMessage = "Preferencias tecnicas guardadas.";
  }
  if (backendUrlRejected) {
    settingsWarning = "La URL del backend debe empezar por http:// o https://; se conserva la anterior.";
    overlayState.statusMessage = settingsWarning;
  }

  setSettingsOpen(false);
  renderOverlay();

  if (overlayState.started && hasActiveSession()) {
    await refreshMentorSession();
    // El refresco del tutor reescribe el estado; los avisos de guardado no deben perderse.
    if (settingsWarning) {
      overlayState.statusMessage = settingsWarning;
      renderOverlay();
    }
  }
}

// Listeners de la tuerca (antes dentro de ensureOverlay, en el mismo orden).
function bindSettingsPanel() {
  // Se re-renderiza al abrir/cerrar: los campos se sincronizan antes de que el usuario
  // escriba y el foco entra/vuelve del panel (content-a11y.js).
  overlayEls.settingsBtn.addEventListener("click", () => {
    overlayState.settingsOpen = !overlayState.settingsOpen;
    renderOverlay();
  });
  overlayEls.settingsCloseBtn.addEventListener("click", () => {
    overlayState.settingsOpen = false;
    renderOverlay();
  });
  overlayEls.teacherCodeApplyAllowed?.addEventListener("change", () => {
    syncCodeApplicationInputsState();
  });
  overlayEls.saveSettingsBtn.addEventListener("click", async () => {
    await saveSettingsFromOverlay();
  });
  overlayEls.teacherOutcomeHelpBtn?.addEventListener("click", () => {
    overlayState.teacherOutcomeHelpOpen = !overlayState.teacherOutcomeHelpOpen;
    renderTeacherOutcomeHelp();
  });
  overlayEls.teacherOutcome?.addEventListener("change", () => {
    if (overlayState.teacherOutcomeHelpOpen) renderTeacherOutcomeHelp();
  });
}

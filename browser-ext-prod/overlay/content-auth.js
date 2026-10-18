// ADACEEN | Capa 4 - UI: entrar y salir (bienvenida, login con correo o Google, primer ingreso y «Salir»).
// Movido sin cambios desde content-render.js (startExperience, login, logout) y desde content-lifecycle.js
// (listeners de esas vistas, ahora en bindAuthControls, llamada desde ensureOverlay).
// Sin "use strict": el codigo viene de archivos en modo no estricto y se conserva igual.
// Orden de carga: manifest.json (content_scripts) y background.js (CONTENT_SCRIPT_FILES) deben coincidir.

// options.skipModelRequests: entrada automatica con un editor guardado (content-lifecycle.js).
async function startExperience(options = {}) {
  overlayState.started = true;
  overlayState.authError = "";

  if (!overlayState.session && overlayState.sessionId) {
    try {
      const restored = await fetchCurrentSession();
      if (!restored) {
        overlayState.sessionId = "";
        overlayState.session = null;
        await persistPreferences();
      }
    } catch {
      overlayState.sessionId = "";
      overlayState.session = null;
      await persistPreferences();
    }
  }

  if (hasActiveSession()) {
    // options.quietActiveTabConflict: overlay restaurado al cargar la pagina. Si otra pestana
    // tiene la sesion activa, se queda en la bienvenida sin el aviso de conflicto.
    const quietConflict = options?.quietActiveTabConflict === true;
    const hasForeignActiveTab = await (quietConflict
      ? probeForeignActiveTab()
      : refreshActiveTabStateFromBackend({ force: true }))
      .catch(() => false);

    if (hasForeignActiveTab) {
      overlayState.started = false;
      overlayState.loading = false;
      overlayState.analysisUnlocked = false;
      overlayState.analysisWindowOpen = false;
      if (!quietConflict) overlayState.statusMessage = "Esta sesión ya está activa en otra pestaña.";
      renderOverlay();
      return;
    }

    await refreshMentorSession({ skipModelRequests: options?.skipModelRequests === true });
    queueActiveTabReport(true);
  } else {
    renderOverlay();
  }
}

// Despues de entrar (con o sin el paso del codigo): curso activo, tutor y bienvenida.
async function finishLoginFromOverlay() {
  overlayState.studentCodeStep = null;
  await ensureStudentCourseSelection({ forceOpen: overlayState.session?.user?.role === "student" });
  if (overlayState.studentCourseModalOpen) {
    overlayState.statusMessage = "Escoge el curso activo para cargar sus fuentes RAG.";
    return;
  }
  await refreshMentorSession();
  setWelcomeStatusForCurrentUser();
}

// Paso del codigo de estudiante (0.7.22): el backend lo pide, dice que el acceso espera al
// docente o que se rechazo. method dice como repetir el login (google o password).
function showStudentCodeStep(method, step, code = "") {
  // El correo con el que entro sigue arriba en la espera (la respuesta de la espera no lo trae).
  const previous = overlayState.studentCodeStep;
  const email = toText(step?.email)
    || toText(previous?.email)
    || (method === "password" ? toText(overlayEls?.authEmail?.value).trim() : "");
  overlayState.studentCodeStep = { method, ...step, ...(email ? { email } : {}), code: toText(code) };
  if (step.step !== "student_code" && overlayEls?.studentCodeInput) overlayEls.studentCodeInput.value = "";
}

async function submitLoginFromOverlay() {
  overlayState.authBusy = true;
  overlayState.authError = "";
  renderOverlay();

  try {
    const email = overlayEls.authEmail.value.trim();
    const password = overlayEls.authPassword.value;
    const step = await loginToBackend(email, password);
    if (step) {
      showStudentCodeStep("password", step);
      return;
    }
    await finishLoginFromOverlay();
  } catch (error) {
    overlayState.authError = String(error);
    renderOverlay();
  } finally {
    overlayState.authBusy = false;
    renderOverlay();
  }
}

// «Entrar» con el codigo escrito, o «Revisar de nuevo» mientras espera la aprobacion.
async function submitStudentCodeFromOverlay() {
  const current = overlayState.studentCodeStep;
  if (!current || overlayState.authBusy) return;
  const typed = current.step === "student_code"
    ? toText(overlayEls.studentCodeInput.value).replace(/[\s.]+/g, "")
    : toText(current.code);
  if (current.step === "student_code" && !/^\d{7}(-\d{4})?$/.test(typed)) {
    const missing = 7 - normalizeStudentCodeTyping(typed).length;
    overlayState.studentCodeStep = {
      ...current,
      message: missing > 0 && missing < 7
        ? `Faltan ${missing === 1 ? "1 dígito" : `${missing} dígitos`}. El código tiene 7, por ejemplo 2312345.`
        : "Escribe los 7 dígitos de tu código, por ejemplo 2312345.",
      invalid: true,
    };
    renderOverlay();
    overlayEls.studentCodeInput?.focus();
    return;
  }

  overlayState.authBusy = true;
  overlayState.authError = "";
  renderOverlay();
  try {
    const step = current.method === "password"
      ? await loginToBackend(overlayEls.authEmail.value.trim(), overlayEls.authPassword.value, typed)
      : await loginToBackendWithGoogle(typed);
    if (step) {
      showStudentCodeStep(current.method, step, typed);
      return;
    }
    await finishLoginFromOverlay();
  } catch (error) {
    overlayState.studentCodeStep = { ...current, message: String(error?.message || error), invalid: false };
  } finally {
    overlayState.authBusy = false;
    renderOverlay();
  }
}

// Casillas del codigo (direccion B, 0.7.22): un solo campo con siete casillas dibujadas detras.
// Solo digitos y como mucho siete (pegar «2312345-3743» deja «2312345»); la casilla activa es la
// siguiente por llenar y, con el codigo mal escrito, las vacias se marcan.
function normalizeStudentCodeTyping(value) {
  return toText(value).replace(/\D+/g, "").slice(0, 7);
}

function renderStudentCodeCells(invalid = false) {
  const wrap = overlayEls?.studentCodeCells;
  const input = overlayEls?.studentCodeInput;
  if (!wrap || !input) return;
  const filled = normalizeStudentCodeTyping(input.value).length;
  const focused = typeof input.matches === "function" && input.matches(":focus");
  const cells = wrap.querySelectorAll ? Array.from(wrap.querySelectorAll(".code-cell")) : [];
  cells.forEach((cell, index) => {
    cell.classList.toggle("is-filled", index < filled);
    cell.classList.toggle("is-active", focused && index === Math.min(filled, 6));
    cell.classList.toggle("is-invalid", invalid && index >= filled);
  });
}

// «hoy, 19:42» o «12 oct, 19:42» (hora de Bogota, la del curso).
function formatStudentCodeRequestedAt(value) {
  const date = new Date(toText(value));
  if (Number.isNaN(date.getTime())) return "";
  const options = { timeZone: "America/Bogota" };
  const time = date.toLocaleTimeString("es-CO", { ...options, hour: "2-digit", minute: "2-digit", hour12: false });
  const day = date.toLocaleDateString("es-CO", { ...options, day: "numeric", month: "short" });
  const today = new Date().toLocaleDateString("es-CO", { ...options, day: "numeric", month: "short" });
  return `${day === today ? "hoy" : day}, ${time}`;
}

// Vista de acceso con el paso del codigo (lo llama renderOverlay). Sin paso, la vista de siempre.
function renderStudentCodeStep() {
  if (!overlayEls?.studentCodeCard) return;
  const current = overlayState.studentCodeStep;
  const busy = !!overlayState.authBusy;
  const justShown = !!current && overlayEls.studentCodeCard.hidden;
  overlayEls.authLoginCard.hidden = !!current;
  overlayEls.studentCodeCard.hidden = !current;
  if (overlayEls.authPolicyNote) overlayEls.authPolicyNote.hidden = !!current;
  if (overlayEls.studentCodePolicyLink) overlayEls.studentCodePolicyLink.hidden = !current;
  if (overlayEls.studentCodeWhoLine) overlayEls.studentCodeWhoLine.hidden = !current;
  if (!current) {
    setTextIfChanged(overlayEls.authTitle, "Entrar");
    setTextIfChanged(overlayEls.authCopy, "Con tu cuenta de Google de la universidad. La primera vez te pedimos tu código de estudiante.");
    overlayEls.authSubmitBtn.hidden = false;
    setTextIfChanged(overlayEls.authSubmitBtn, busy ? "Entrando..." : "Entrar");
    setTextIfChanged(overlayEls.authBackBtn, "Volver");
    return;
  }
  const askingCode = current.step === "student_code";
  const pending = current.step === "pending_approval";
  const who = toText(current.email) || toText(current.displayName);
  const titles = {
    student_code: "Código de estudiante",
    pending_approval: "Tu docente tiene que aprobar este correo",
    rejected: "Acceso no aprobado",
  };
  const copies = {
    student_code: "Se pide una sola vez. Con él llegas a tu misma cuenta aunque otro día entres con otro correo.",
    pending_approval: "Tu código ya entró antes con otro correo. Entra con ese, o espera la aprobación: después podrás usar cualquiera de los dos.",
    rejected: "Entra con el correo que usaste antes o habla con tu docente.",
  };
  setTextIfChanged(overlayEls.authTitle, titles[current.step] || titles.student_code);
  setTextIfChanged(overlayEls.authCopy, copies[current.step] || copies.student_code);
  setTextIfChanged(overlayEls.studentCodeWho, who);
  overlayEls.studentCodeWho.hidden = !who;
  if (overlayEls.studentCodeStepCount) {
    setTextIfChanged(overlayEls.studentCodeStepCount, askingCode ? "paso 2/2" : (pending ? "en revisión" : "no aprobado"));
    overlayEls.studentCodeStepCount.classList.toggle("is-pending", !askingCode);
  }
  overlayEls.studentCodeField.hidden = !askingCode;
  overlayEls.studentCodeInput.disabled = busy;
  overlayEls.studentCodeInput.setAttribute("aria-invalid", current.invalid ? "true" : "false");
  renderStudentCodeCells(askingCode && !!current.invalid);
  if (overlayEls.studentCodeReview) {
    overlayEls.studentCodeReview.hidden = !pending;
    if (pending) {
      setTextIfChanged(overlayEls.studentCodeReviewCode, toText(current.code));
      setTextIfChanged(overlayEls.studentCodeReviewEmail, toText(current.maskedEmail) || "otro correo");
      setTextIfChanged(overlayEls.studentCodeReviewAt, formatStudentCodeRequestedAt(current.requestedAt) || "hace un momento");
    }
  }
  // En el primer paso el mensaje del backend (pensado para una extension vieja) sobra: la
  // pantalla ya pide el codigo. En la espera, la pantalla ya lo dice con la lista de arriba.
  const message = (askingCode && !current.invalid) || pending ? "" : toText(current.message);
  setTextIfChanged(overlayEls.studentCodeStatus, message);
  overlayEls.studentCodeStatus.classList.toggle("is-warning", current.step === "rejected" || (askingCode && !!current.invalid));
  overlayEls.studentCodeStatus.classList.toggle("is-pending", false);
  overlayEls.authSubmitBtn.hidden = current.step === "rejected";
  setTextIfChanged(overlayEls.authSubmitBtn, busy
    ? "Revisando..."
    : (askingCode ? "Entrar" : "Revisar de nuevo"));
  setTextIfChanged(overlayEls.authBackBtn, "Usar otra cuenta");
  if (justShown && askingCode) setTimeout(() => overlayEls.studentCodeInput?.focus(), 0);
}

// «Usar otra cuenta»: vuelve al inicio de sesion y olvida el token de Google de esta cuenta
// (asi Chrome deja elegir otra).
async function leaveStudentCodeStep() {
  const current = overlayState.studentCodeStep;
  overlayState.studentCodeStep = null;
  overlayState.authError = "";
  if (overlayEls?.studentCodeInput) overlayEls.studentCodeInput.value = "";
  if (current?.method === "google") await clearGoogleAccessTokenFromBackground();
  renderOverlay();
}

function setWelcomeStatusForCurrentUser() {
  const user = overlayState.session?.user;
  if (!user) return;

  const context = overlayState.context || buildPayload();
  if (isGithubOrCodespaceContext(context) && !hasCompletedSetup(context)) {
    overlayState.statusMessage = "";
    return;
  }

  // Direccion B (0.7.22): un saludo corto; el rol esta en la cabecera y lo que hace cada rol, en Inicio.
  overlayState.statusMessage = `Bienvenido, ${user.displayName}.`;
}

async function submitGoogleLoginFromOverlay() {
  overlayState.authBusy = true;
  overlayState.authError = "";
  renderOverlay();

  try {
    const step = await loginToBackendWithGoogle();
    if (step) {
      showStudentCodeStep("google", step);
      return;
    }
    await finishLoginFromOverlay();
  } catch (error) {
    overlayState.authError = String(error);
    renderOverlay();
  } finally {
    overlayState.authBusy = false;
    renderOverlay();
  }
}

async function logoutAndReturnToLogin() {
  clearTutorResponseTracking("logout");
  await logoutFromBackend();
  overlayState.started = true;
  overlayState.ideas = [];
  overlayState.guide = [];
  overlayState.analysisUnlocked = false;
  overlayState.analysisWindowOpen = false;
  overlayState.projectAnalysis = null;
  overlayState.campusAnalysis = null;
  overlayState.setupRepoFullName = "";
  overlayState.setupWizardStep = 1;
  overlayState.githubAppBusy = false;
  overlayState.githubAppStatus = { ...EMPTY_GITHUB_APP_STATUS };
  overlayState.githubUserStatus = { ...EMPTY_GITHUB_USER_STATUS };
  overlayState.projectContextBusy = false;
  overlayState.projectContextStatus = { ...EMPTY_PROJECT_CONTEXT_STATUS };
  overlayState.projectContextHistory = [];
  overlayState.projectContextInsight = { ...EMPTY_PROJECT_CONTEXT_INSIGHT };
  overlayState.documentClassifications = { ...EMPTY_DOCUMENT_CLASSIFICATION_STATE };
  overlayState.teacherBitacoraStatus = { ...EMPTY_TEACHER_BITACORA_STATUS };
  overlayState.bitacoraOwner = { ...EMPTY_BITACORA_OWNER_STATE };
  // RAG (0.7.22): al cambiar de cuenta no queda la lista ni el docente de la sesión anterior.
  overlayState.ragOwner = { ...EMPTY_RAG_OWNER_STATE };
  overlayState.teacherRagLoadedAt = 0;
  overlayState.ragLots = { ...EMPTY_RAG_LOTS_STATE };
  overlayState.courseCalendar = { ...EMPTY_COURSE_CALENDAR_STATE };
  overlayState.teacherRagPageOpen = false;
  overlayState.teacherRagState = { ...EMPTY_TEACHER_RAG_STATE };
  overlayState.codespaceWaitingContext = { ...EMPTY_CODESPACE_WAITING_CONTEXT };
  overlayState.campusCourseAccess = { ...EMPTY_CAMPUS_COURSE_ACCESS_STATE };
  overlayState.ragCourseCatalog = [];
  overlayState.ragDefaultCourseCode = "FPOO";
  overlayState.studentCourseModalOpen = false;
  overlayState.studentCourseState = { ...EMPTY_STUDENT_COURSE_STATE };
  overlayState.projectContextMessage = "";
  overlayState.projectContextError = "";
  overlayState.adminUsers = [];
  overlayState.adminSelectedUserIds = [];
  overlayState.adminTeachers = [];
  overlayState.adminAccessRequests = [];
  overlayState.adminUsersQuery = "";
  overlayState.studentCodeStep = null;
  overlayState.adminUsersBusy = false;
  overlayState.adminUsersMessage = "";
  overlayState.operationTitle = "";
  overlayState.operationDetail = "";
  overlayState.operationKind = "busy";
  overlayState.statusMessage = "Sesion cerrada.";
  renderOverlay();
}

// Listeners de bienvenida, login, primer ingreso y «Salir» (antes dentro de ensureOverlay, en el mismo orden).
function bindAuthControls() {
  overlayEls.startBtn.addEventListener("click", async () => {
    await startExperience();
  });
  overlayEls.authSubmitBtn.addEventListener("click", async () => {
    if (overlayState.studentCodeStep) {
      await submitStudentCodeFromOverlay();
      return;
    }
    await submitLoginFromOverlay();
  });
  overlayEls.googleAuthBtn.addEventListener("click", async () => {
    await submitGoogleLoginFromOverlay();
  });
  overlayEls.authBackBtn.addEventListener("click", async () => {
    if (overlayState.studentCodeStep) {
      await leaveStudentCodeStep();
      return;
    }
    overlayState.started = false;
    overlayState.authError = "";
    renderOverlay();
  });
  overlayEls.studentCodeInput.addEventListener("keydown", async (event) => {
    if (event.key !== "Enter") return;
    event.preventDefault();
    await submitStudentCodeFromOverlay();
  });
  // Casillas: solo digitos (pegar con el programa deja el codigo) y la casilla activa al dia.
  overlayEls.studentCodeInput.addEventListener("input", () => {
    const input = overlayEls.studentCodeInput;
    const clean = normalizeStudentCodeTyping(input.value);
    if (input.value !== clean) input.value = clean;
    if (overlayState.studentCodeStep?.invalid) {
      overlayState.studentCodeStep = { ...overlayState.studentCodeStep, invalid: false, message: "" };
      renderStudentCodeStep();
      return;
    }
    renderStudentCodeCells(false);
  });
  overlayEls.studentCodeInput.addEventListener("focus", () => renderStudentCodeCells(!!overlayState.studentCodeStep?.invalid));
  overlayEls.studentCodeInput.addEventListener("blur", () => renderStudentCodeCells(!!overlayState.studentCodeStep?.invalid));
  overlayEls.firstLoginConfirmBtn.addEventListener("click", async () => {
    await markPrivacyAcceptedForCurrentSession();
    renderOverlay();
    // La respuesta del tutor que se pidio con la privacidad pendiente llega ahora.
    if (takeMentorDeferredUntilPrivacyAccepted() && overlayState.started && hasActiveSession()
      && !overlayState.firstLoginConfirmationOpen) {
      await refreshMentorSession();
    }
  });
  overlayEls.firstLoginLogoutBtn.addEventListener("click", async () => {
    await logoutAndReturnToLogin();
  });
  // Un solo boton para cerrar sesion: "Salir" de la cabecera, visible en todas las vistas
  // (antes tambien "Cerrar sesion" en el tour y en la tuerca, que hacian lo mismo).
  overlayEls.logoutHeaderBtn.addEventListener("click", async () => {
    await logoutAndReturnToLogin();
    if (overlayState.settingsOpen) {
      setSettingsOpen(false);
      renderOverlay();
    }
  });
}

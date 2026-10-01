// ADACEEN | Capa 3 - Servicios: quices de clase (estado, lanzar y cerrar) y banco de quices del docente.
// Movido sin cambios desde services/backend.service.js.
// Sin "use strict": el codigo viene de backend.service.js (modo no estricto) y se conserva igual.
// Orden de carga: manifest.json (content_scripts) y background.js (CONTENT_SCRIPT_FILES) deben coincidir.

// Quiz de la clase: el docente lanza una pregunta que les aparece a sus
// estudiantes en el panel "Quiz y seguimiento" de VS Code.
function describeClassQuiz(active, latest) {
  const target = active || latest;
  if (!target) return "Aun no has lanzado quices a la clase.";
  const results = target.results || {};
  const parts = [
    `${results.answered || 0} respuestas`,
    `${results.correct || 0} correctas`,
  ];
  if (typeof results.averageFollowUpScore === "number") {
    parts.push(`explicaciones ${results.averageFollowUpScore}/100`);
  }
  return active
    ? `Activo: "${toText(target.topic)}" (${parts.join(", ")}).`
    : `Ultimo: "${toText(target.topic)}", cerrado (${parts.join(", ")}).`;
}

async function refreshClassQuizStatus() {
  if (!overlayEls?.teacherQuizStatus || !overlayState.sessionId) return;
  const baseUrl = normalizeBaseUrl(overlayState.backendUrl);
  try {
    const response = await fetchJsonWithTimeout(`${baseUrl}/api/quiz/launches`, {
      method: "GET",
      headers: buildApiHeaders(),
    }, 15000);
    const launches = Array.isArray(response?.launches) ? response.launches : [];
    const active = launches.find((launch) => launch.active
      && (!launch.expiresAt || Date.parse(launch.expiresAt) > Date.now())) || null;
    overlayState.activeClassQuiz = active;
    if (overlayEls?.teacherQuizCloseBtn) overlayEls.teacherQuizCloseBtn.disabled = !active;
    // role="status": solo se reescribe si cambia, para no repetir el anuncio en cada render.
    setTextIfChanged(overlayEls?.teacherQuizStatus, describeClassQuiz(active, launches[0] || null));
  } catch (error) {
    setTextIfChanged(overlayEls?.teacherQuizStatus, `No se pudo consultar el quiz de la clase: ${error?.message || error}`);
  }
}

// Contrato (c): si la politica no dejaba llegar un quiz lanzado ("Permitir mini quiz" o
// "Cuando yo lo lance a la clase" sin marcar), el backend los activa, los guarda y lo dice en
// autoEnabled, message y policy. Las casillas del quiz se ponen aqui como las dejo el backend
// (con el quiz apagado solo enciende el lanzado por el docente, no "Tras aceptar una
// sugerencia"): si no, el siguiente "Guardar cambios" desharia el cambio. Lo demas que el
// docente tenga sin guardar se conserva.
function applyAutoEnabledQuizPolicy(response) {
  if (response?.autoEnabled !== true || !response.policy || typeof response.policy !== "object") return;
  const current = overlayState.policy || DEFAULT_POLICY;
  const quizSettings = response.policy.quizSettings && typeof response.policy.quizSettings === "object"
    ? response.policy.quizSettings
    : current.quizSettings;
  overlayState.policy = {
    ...current,
    allowMiniQuiz: response.policy.allowMiniQuiz !== false,
    quizSettings,
  };
  if (overlayEls?.teacherMiniQuiz) overlayEls.teacherMiniQuiz.checked = overlayState.policy.allowMiniQuiz;
  const triggers = Array.isArray(quizSettings?.triggers) ? quizSettings.triggers : [];
  if (overlayEls?.teacherQuizTeacherLaunch) overlayEls.teacherQuizTeacherLaunch.checked = triggers.includes("teacher_launch");
  if (overlayEls?.teacherQuizAfterAccept) overlayEls.teacherQuizAfterAccept.checked = triggers.includes("after_accept");
  // Los campos ya muestran la politica nueva: sin volver a sincronizar todo el formulario.
  if (overlayEls && typeof buildSettingsSyncKey === "function") {
    renderKeyChanged(overlayEls.settingsPanel || overlayEls.teacherSettingsBlock, buildSettingsSyncKey());
  }
}

async function launchClassQuiz() {
  const topic = toText(overlayEls?.teacherQuizTopic?.value);
  if (topic.length < 3) {
    overlayEls.teacherQuizStatus.textContent = "Escribe el tema del quiz (minimo 3 letras).";
    return;
  }
  const baseUrl = normalizeBaseUrl(overlayState.backendUrl);
  overlayEls.teacherQuizLaunchBtn.disabled = true;
  overlayEls.teacherQuizStatus.textContent = "Generando la pregunta y lanzandola a la clase...";
  try {
    const response = await fetchJsonWithTimeout(`${baseUrl}/api/quiz/launches`, {
      method: "POST",
      headers: buildApiHeaders(),
      body: JSON.stringify({ topic }),
    }, 150000);
    if (overlayEls?.teacherQuizTopic) overlayEls.teacherQuizTopic.value = "";
    applyAutoEnabledQuizPolicy(response);
    await refreshClassQuizStatus();
    // El aviso del backend (por ejemplo, que activo el quiz lanzado) va antes del estado.
    const message = toText(response?.message);
    if (message && overlayEls?.teacherQuizStatus) {
      setTextIfChanged(overlayEls.teacherQuizStatus, `${message} ${toText(overlayEls.teacherQuizStatus.textContent)}`.trim());
    }
  } catch (error) {
    if (overlayEls?.teacherQuizStatus) {
      overlayEls.teacherQuizStatus.textContent = `No se pudo lanzar el quiz: ${error?.message || error}`;
    }
  } finally {
    if (overlayEls?.teacherQuizLaunchBtn) overlayEls.teacherQuizLaunchBtn.disabled = false;
  }
}

async function closeActiveClassQuiz() {
  const active = overlayState.activeClassQuiz;
  if (!active?.id) {
    overlayEls.teacherQuizStatus.textContent = "No hay un quiz activo.";
    return;
  }
  const baseUrl = normalizeBaseUrl(overlayState.backendUrl);
  try {
    await fetchJsonWithTimeout(`${baseUrl}/api/quiz/launches/${encodeURIComponent(active.id)}/close`, {
      method: "POST",
      headers: buildApiHeaders(),
    }, 15000);
    await refreshClassQuizStatus();
  } catch (error) {
    overlayEls.teacherQuizStatus.textContent = `No se pudo cerrar el quiz: ${error?.message || error}`;
  }
}

// Pestana «Quices» (0.7.15): banco propio con sus lanzamientos y los quices hechos.
async function fetchTeacherQuizzesPanel() {
  const baseUrl = normalizeBaseUrl(overlayState.backendUrl);
  if (!baseUrl || !overlayState.sessionId || !isTeacherSession()) {
    throw new Error("Sesion no valida para ver los quices.");
  }
  const [bank, attempts] = await Promise.all([
    fetchJsonWithTimeout(`${baseUrl}/api/quiz/custom`, { method: "GET", headers: buildApiHeaders() }, 20000),
    fetchJsonWithTimeout(`${baseUrl}/api/quiz/attempts?limit=200`, { method: "GET", headers: buildApiHeaders() }, 20000),
  ]);
  if (!bank?.ok) throw new Error(toText(bank?.error) || "No se pudo cargar tu banco de quices.");
  if (!attempts?.ok) throw new Error(toText(attempts?.error) || "No se pudieron cargar los quices hechos.");
  return {
    quizzes: Array.isArray(bank.quizzes) ? bank.quizzes : [],
    launches: Array.isArray(bank.launches) ? bank.launches : [],
    attempts: Array.isArray(attempts.attempts) ? attempts.attempts : [],
    summary: attempts.summary && typeof attempts.summary === "object" ? attempts.summary : null,
  };
}

async function requestTeacherQuizChange(path, method, body) {
  const baseUrl = normalizeBaseUrl(overlayState.backendUrl);
  if (!baseUrl || !overlayState.sessionId || !isTeacherSession()) {
    throw new Error("Sesion no valida para administrar quices.");
  }
  const response = await fetchJsonWithTimeout(`${baseUrl}${path}`, {
    method,
    headers: buildApiHeaders(),
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  }, 30000);
  if (!response?.ok) {
    throw new Error(toText(response?.error) || "No se pudo completar la accion del quiz.");
  }
  return response;
}

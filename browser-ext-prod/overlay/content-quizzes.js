// ADACEEN | Capa 4 - UI: pestana «Quices» del docente (0.7.15).
// Tres partes: lanzar un quiz rapido por tema (lo mismo que antes hacia la tuerca), el banco
// propio del docente (GET /api/quiz/custom: lanzar, cerrar y retirar; «Crear quiz» abre la
// pagina /docente/quices del backend en otra pestana) y los quices hechos por sus
// estudiantes (GET /api/quiz/attempts, con nombre y sin ids). Las llamadas estan en
// services/backend.service.js (fetchTeacherQuizzesPanel, requestTeacherQuizChange,
// refreshClassQuizStatus, launchClassQuiz, closeActiveClassQuiz).
// Orden de carga: manifest.json (content_scripts) y background.js (CONTENT_SCRIPT_FILES) deben coincidir.
"use strict";

const QUIZZES_PANEL_STALE_MS = 60 * 1000;

function getQuizzesPanelState() {
  const state = overlayState.quizzesPanel && typeof overlayState.quizzesPanel === "object" ? overlayState.quizzesPanel : EMPTY_QUIZZES_PANEL_STATE;
  return {
    ...EMPTY_QUIZZES_PANEL_STATE,
    ...state,
    quizzes: Array.isArray(state.quizzes) ? state.quizzes : [],
    launches: Array.isArray(state.launches) ? state.launches : [],
    attempts: Array.isArray(state.attempts) ? state.attempts : [],
  };
}

function ensureQuizzesPanelLoaded() {
  if (!isTeacherSession() || !overlayState.sessionId) return;
  const state = getQuizzesPanelState();
  if (state.busy) return;
  if (state.loadedAt && Date.now() - state.loadedAt <= QUIZZES_PANEL_STALE_MS) return;
  refreshQuizzesPanel().catch(() => {});
}

async function refreshQuizzesPanel() {
  if (!isTeacherSession() || !overlayState.sessionId) return null;
  overlayState.quizzesPanel = { ...getQuizzesPanelState(), busy: true, error: "" };
  renderOverlay();
  try {
    const [panel] = await Promise.all([
      fetchTeacherQuizzesPanel(),
      refreshClassQuizStatus(),
    ]);
    overlayState.quizzesPanel = { ...getQuizzesPanelState(), ...panel, busy: false, loadedAt: Date.now(), error: "" };
  } catch (error) {
    overlayState.quizzesPanel = { ...getQuizzesPanelState(), busy: false, error: `No se pudieron cargar los quices: ${String(error?.message || error)}` };
  } finally {
    renderOverlay();
  }
  return overlayState.quizzesPanel;
}

async function runQuizBankAction(path, method, body, successMessage) {
  overlayState.quizzesPanel = { ...getQuizzesPanelState(), busy: true, error: "", message: "" };
  renderOverlay();
  try {
    const response = await requestTeacherQuizChange(path, method, body);
    if (typeof applyAutoEnabledQuizPolicy === "function") applyAutoEnabledQuizPolicy(response);
    const backendMessage = toText(response?.message);
    overlayState.quizzesPanel = { ...getQuizzesPanelState(), busy: false, message: backendMessage ? `${successMessage} ${backendMessage}` : successMessage };
    await refreshQuizzesPanel();
    return response;
  } catch (error) {
    overlayState.quizzesPanel = { ...getQuizzesPanelState(), busy: false, error: String(error?.message || error) };
    renderOverlay();
    return null;
  }
}

function launchQuizFromBank(quiz) {
  return runQuizBankAction(
    `/api/quiz/custom/${encodeURIComponent(toText(quiz?.id))}/launch`,
    "POST",
    {},
    `«${toText(quiz?.topic)}» lanzado a la clase por 60 minutos.`,
  );
}

function closeQuizLaunchFromBank(quiz) {
  return runQuizBankAction(
    `/api/quiz/launches/${encodeURIComponent(toText(quiz?.activeLaunchId))}/close`,
    "POST",
    {},
    `Lanzamiento de «${toText(quiz?.topic)}» cerrado.`,
  );
}

function retireQuizFromBank(quiz) {
  return runQuizBankAction(
    `/api/quiz/custom/${encodeURIComponent(toText(quiz?.id))}`,
    "DELETE",
    undefined,
    `«${toText(quiz?.topic)}» retirado de tu banco.`,
  );
}

function buildTeacherQuizPageUrl() {
  const baseUrl = normalizeBaseUrl(overlayState.backendUrl);
  return baseUrl ? `${baseUrl}/docente/quices` : "";
}

// «Crear quiz»: la pagina del backend en otra pestana; la extension le pasa la sesion
// (inicio/pagina-quices.content.js) y, si no llega, la pagina pide iniciar sesion.
function openTeacherQuizPage() {
  const url = buildTeacherQuizPageUrl();
  if (!url) {
    overlayState.quizzesPanel = { ...getQuizzesPanelState(), error: "Configura el backend en la tuerca antes de crear quices." };
    renderOverlay();
    return;
  }
  window.open(url, "_blank", "noopener");
  overlayState.quizzesPanel = {
    ...getQuizzesPanelState(),
    message: "Se abrio «Crear quiz» en otra pestaña. Al volver, pulsa «Actualizar» para ver los quices nuevos.",
    error: "",
  };
  renderOverlay();
}

function formatQuizDate(value) {
  const text = toText(value);
  if (!text) return "";
  const date = new Date(text);
  if (Number.isNaN(date.getTime())) return "";
  return date.toLocaleString("es-CO", { day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit", hour12: false });
}

function describeQuizAttemptResult(attempt) {
  if (toText(attempt?.status) === "skipped") return { text: "Omitido", className: "is-skipped" };
  if (attempt?.chosenIndex === null || attempt?.chosenIndex === undefined) return { text: "Sin responder", className: "is-pending" };
  const score = typeof attempt?.followupScore === "number" ? ` · ${attempt.followupScore}/100` : "";
  return attempt?.correct === true
    ? { text: `Correcta${score}`, className: "is-correct" }
    : { text: `Incorrecta${score}`, className: "is-wrong" };
}

function describeQuizAttemptOrigin(attempt) {
  if (toText(attempt?.trigger) === "teacher_launch") return toText(attempt?.customQuizId) ? "Mi banco" : "Lanzado";
  return "Tras aceptar";
}

function buildQuizBankItem(quiz, busy) {
  const li = document.createElement("li");
  li.className = `quiz-bank-item${quiz.activeLaunchId ? " is-live" : ""}`;
  const head = document.createElement("div");
  head.className = "quiz-bank-head";
  const topic = document.createElement("span");
  topic.className = "quiz-bank-topic";
  topic.textContent = toText(quiz.topic) || "Sin tema";
  head.appendChild(topic);
  const course = document.createElement("span");
  course.className = "admin-chip is-course";
  course.textContent = toText(quiz.courseCode) || "Sin curso";
  head.appendChild(course);
  if (quiz.activeLaunchId) {
    const live = document.createElement("span");
    live.className = "admin-chip is-active";
    live.textContent = "Lanzado ahora";
    head.appendChild(live);
  }
  li.appendChild(head);

  const question = document.createElement("p");
  question.className = "quiz-bank-question";
  question.textContent = truncateText(toText(quiz.question), 180);
  question.title = toText(quiz.question);
  li.appendChild(question);

  const results = quiz.results && typeof quiz.results === "object" ? quiz.results : {};
  const meta = document.createElement("p");
  meta.className = "quiz-bank-meta";
  const launchCount = Number(quiz.launchCount) || 0;
  meta.textContent = [
    `Lanzado ${launchCount} ${launchCount === 1 ? "vez" : "veces"}`,
    quiz.lastLaunchedAt ? `ultima: ${formatQuizDate(quiz.lastLaunchedAt)}` : "",
    `${Number(results.answered) || 0} respuestas`,
    typeof results.correctRate === "number" ? `${results.correctRate} % aciertos` : "",
  ].filter(Boolean).join(" | ");
  li.appendChild(meta);

  const actions = document.createElement("div");
  actions.className = "quiz-bank-actions";
  const launch = document.createElement("button");
  launch.type = "button";
  launch.className = "primary-button analyze-button";
  launch.textContent = "Lanzar";
  launch.disabled = busy;
  launch.setAttribute("aria-label", `Lanzar «${topic.textContent}» a la clase`);
  launch.addEventListener("click", () => {
    launchQuizFromBank(quiz).catch(() => {});
  });
  actions.appendChild(launch);
  if (quiz.activeLaunchId) {
    const close = document.createElement("button");
    close.type = "button";
    close.className = "ghost-button analyze-button";
    close.textContent = "Cerrar";
    close.disabled = busy;
    close.setAttribute("aria-label", `Cerrar el lanzamiento de «${topic.textContent}»`);
    close.addEventListener("click", () => {
      closeQuizLaunchFromBank(quiz).catch(() => {});
    });
    actions.appendChild(close);
  }
  const retire = document.createElement("button");
  retire.type = "button";
  retire.className = "ghost-button analyze-button danger-button";
  retire.textContent = "Retirar";
  retire.disabled = busy;
  retire.setAttribute("aria-label", `Retirar «${topic.textContent}» del banco`);
  retire.addEventListener("click", () => {
    const confirmed = window.confirm(`Se retira «${topic.textContent}» de tu banco de quices. Los resultados ya registrados se conservan. Continuar?`);
    if (!confirmed) return;
    retireQuizFromBank(quiz).catch(() => {});
  });
  actions.appendChild(retire);
  li.appendChild(actions);
  return li;
}

function buildQuizAttemptRow(attempt) {
  const row = document.createElement("tr");
  const student = document.createElement("td");
  student.className = "admin-identity-cell";
  const name = document.createElement("span");
  name.className = "admin-user-name";
  name.textContent = toText(attempt.studentName) || "Sin cuenta";
  student.appendChild(name);
  if (attempt.studentEmail) {
    const email = document.createElement("span");
    email.className = "admin-user-email";
    setEmailText(email, toText(attempt.studentEmail));
    student.appendChild(email);
  }
  row.appendChild(student);

  const topic = document.createElement("td");
  topic.className = "quiz-attempt-topic";
  const topicText = document.createElement("span");
  topicText.textContent = truncateText(toText(attempt.topic) || toText(attempt.question), 60);
  topicText.title = toText(attempt.question);
  topic.appendChild(topicText);
  const origin = document.createElement("span");
  origin.className = "quiz-attempt-origin";
  origin.textContent = describeQuizAttemptOrigin(attempt);
  topic.appendChild(origin);
  row.appendChild(topic);

  const result = document.createElement("td");
  const described = describeQuizAttemptResult(attempt);
  const chip = document.createElement("span");
  chip.className = `admin-chip quiz-result ${described.className}`;
  chip.textContent = described.text;
  result.appendChild(chip);
  row.appendChild(result);

  const date = document.createElement("td");
  date.className = "quiz-attempt-date";
  date.textContent = formatQuizDate(attempt.answeredAt || attempt.createdAt);
  row.appendChild(date);
  return row;
}

function renderQuizzesPanel(showingMainView) {
  const section = overlayEls?.quizzesSection;
  if (!section) return;
  const allowed = showingMainView && isTeacherSession();
  section.hidden = !allowed;
  if (!allowed) return;

  const state = getQuizzesPanelState();
  const summary = state.summary && typeof state.summary === "object" ? state.summary : null;
  const status = state.busy
    ? "Cargando quices..."
    : (state.loadedAt
      ? `${pluralizeStudentCount(state.quizzes.length, "quiz propio", "quices propios")} | ${pluralizeStudentCount(state.attempts.length, "quiz hecho", "quices hechos")}${summary?.students ? ` por ${pluralizeStudentCount(summary.students, "estudiante", "estudiantes")}` : ""}${typeof summary?.correctRate === "number" ? ` | ${summary.correctRate} % aciertos` : ""}.`
      : "Cargando quices...");
  setTextIfChanged(overlayEls.quizzesStatus, status);
  overlayEls.quizzesStatus?.classList.toggle("is-loading-note", state.busy);
  setTextIfChanged(overlayEls.quizzesMessage, state.error || state.message || "");
  overlayEls.quizzesMessage?.classList.toggle("is-warning", !!state.error);
  if (overlayEls.quizzesRefreshBtn) overlayEls.quizzesRefreshBtn.disabled = state.busy;
  if (overlayEls.quizzesCreateBtn) overlayEls.quizzesCreateBtn.disabled = !overlayState.sessionId;
  if (overlayEls.teacherQuizLaunchBtn) overlayEls.teacherQuizLaunchBtn.disabled = state.busy;
  if (overlayEls.teacherQuizCloseBtn) overlayEls.teacherQuizCloseBtn.disabled = state.busy;

  if (overlayEls.quizzesBankCount) {
    overlayEls.quizzesBankCount.hidden = !state.quizzes.length;
    setTextIfChanged(overlayEls.quizzesBankCount, String(state.quizzes.length));
  }
  if (overlayEls.quizzesDoneCount) {
    overlayEls.quizzesDoneCount.hidden = !state.attempts.length;
    setTextIfChanged(overlayEls.quizzesDoneCount, String(state.attempts.length));
  }
  if (overlayEls.quizzesDoneSummary) {
    setTextIfChanged(
      overlayEls.quizzesDoneSummary,
      summary?.total
        ? `${summary.answered || 0} respondidos, ${summary.correct || 0} correctos${summary.followUps ? `, ${summary.followUps} con explicacion` : ""}${summary.skipped ? `, ${summary.skipped} omitidos` : ""}.`
        : "Respuestas de tus estudiantes, del mini quiz y de los lanzados.",
    );
  }
  if (overlayEls.quizzesBankEmpty) overlayEls.quizzesBankEmpty.hidden = state.busy || state.quizzes.length > 0 || !state.loadedAt;
  if (overlayEls.quizzesDoneEmpty) overlayEls.quizzesDoneEmpty.hidden = state.busy || state.attempts.length > 0 || !state.loadedAt;

  const bankKey = JSON.stringify([state.quizzes, state.busy]);
  if (overlayEls.quizzesBankList && renderKeyChanged(overlayEls.quizzesBankList, bankKey)) {
    overlayEls.quizzesBankList.textContent = "";
    const fragment = document.createDocumentFragment();
    state.quizzes.forEach((quiz) => fragment.appendChild(buildQuizBankItem(quiz, state.busy)));
    overlayEls.quizzesBankList.appendChild(fragment);
  }
  const attemptsKey = JSON.stringify([state.attempts]);
  if (overlayEls.quizzesDoneBody && renderKeyChanged(overlayEls.quizzesDoneBody, attemptsKey)) {
    overlayEls.quizzesDoneBody.textContent = "";
    const fragment = document.createDocumentFragment();
    state.attempts.slice(0, 60).forEach((attempt) => fragment.appendChild(buildQuizAttemptRow(attempt)));
    overlayEls.quizzesDoneBody.appendChild(fragment);
  }
}

function bindQuizzesPanel() {
  if (!overlayEls) return;
  overlayEls.quizzesRefreshBtn?.addEventListener("click", () => {
    refreshQuizzesPanel().catch(() => {});
  });
  overlayEls.quizzesCreateBtn?.addEventListener("click", () => {
    openTeacherQuizPage();
  });
}

// Lanzar y cerrar el quiz rapido por tema (movidos desde ensureOverlay, content-lifecycle.js, sin cambios).
function bindTeacherQuizButtons() {
  overlayEls.teacherQuizLaunchBtn.addEventListener("click", async () => {
    await launchClassQuiz();
  });
  overlayEls.teacherQuizCloseBtn.addEventListener("click", async () => {
    await closeActiveClassQuiz();
  });
}

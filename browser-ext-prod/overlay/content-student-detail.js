"use strict";

// ADACEEN | Capa 4 - UI: detalle de un estudiante en «Estudiantes» (sesiones, intervenciones, quices,
// actividad y línea de tiempo). Movido sin cambios de content-students.js.

const STUDENT_SESSION_KIND_LABELS = Object.freeze({
  browser: "Navegador",
  editor: "VS Code",
  cli: "Consola",
});

const STUDENT_INTERVENTION_LABELS = Object.freeze({
  explanation: "Explicacion",
  hint: "Pista",
  example: "Ejemplo",
  mini_quiz: "Mini quiz",
  controlled_message: "Mensaje controlado",
});

const STUDENT_EVENT_LABELS = Object.freeze({
  compile_error: "Error de compilacion",
  runtime_error: "Error en ejecucion",
  concept_question: "Pregunta conceptual",
  design_block: "Bloqueo de diseno",
  workflow_guidance: "Guia de flujo",
  insufficient_context: "Contexto insuficiente",
  out_of_domain: "Fuera de dominio",
  code_suggestion: "Sugerencia de codigo",
});

// Eventos de actividad (docs/telemetria/diccionario-eventos.md) en palabras del docente: el
// detalle mostraba el nombre interno («tutor_request_submitted»).
const STUDENT_ACTIVITY_EVENT_LABELS = Object.freeze({
  tutor_decision: "Decision del tutor",
  tutor_request_submitted: "Pidio ayuda",
  tutor_response_received: "Respuesta del tutor recibida",
  tutor_response_shown: "Respuesta del tutor mostrada",
  tutor_response_accepted: "Le sirvio una respuesta",
  tutor_response_rejected: "No le sirvio una respuesta",
  tutor_response_ignored: "Respuesta sin calificar",
  rag_source_opened: "Abrio una fuente del curso",
  vscode_rag_source_opened: "Abrio una fuente del curso en VS Code",
  overlay_opened: "Abrio ADACEEN",
  overlay_closed: "Cerro ADACEEN",
  active_tab_seen: "Volvio a la pestana",
  active_tab_hidden: "Dejo la pestana",
  error_detected: "Error en la pagina",
  compile_error_detected: "Error de compilacion",
  blocking_detected: "Se quedo bloqueado",
  blocking_resolved: "Salio del bloqueo",
  vscode_suggestion_shown: "Sugerencia en VS Code",
  vscode_suggestion_actions_revealed: "Miro las acciones de una sugerencia",
  vscode_suggestion_panel_opened: "Abrio el panel de sugerencias",
  vscode_suggestion_manual_refresh: "Pidio una sugerencia",
  vscode_suggestion_ignored: "Sugerencia sin aplicar",
  vscode_suggestion_blocked_by_policy: "Sugerencia bloqueada por la politica",
  suggestion_completion_applied: "Aplico una sugerencia",
  code_application_checked: "Revision de un cambio de codigo",
  code_application_blocked: "Cambio de codigo bloqueado",
  prepare_environment_started: "Preparo su editor",
  prepare_environment_retry_started: "Rehizo su editor",
  prepare_environment_failed: "Fallo la preparacion del editor",
  prepare_environment_retry_failed: "Fallo al rehacer el editor",
  tunnel_workspace_device_code: "Autorizo el editor en GitHub",
  tunnel_workspace_ready: "Editor en la nube listo",
  codespace_ready: "Codespace listo",
  codespace_fallback: "Codespace por el camino de respaldo",
  bootstrap_pr_created: "PR de preparacion creado",
  bootstrap_pr_reused: "PR de preparacion reutilizado",
});

const STUDENT_ACTIVITY_SOURCE_LABELS = Object.freeze({
  browser_extension: "navegador",
  vscode_extension: "VS Code",
  backend: "servidor",
  system: "sistema",
});

// Nombre legible de un evento: el del diccionario o, si es nuevo, sin guiones bajos.
function describeStudentActivityEvent(eventType) {
  const key = toText(eventType);
  if (STUDENT_ACTIVITY_EVENT_LABELS[key]) return STUDENT_ACTIVITY_EVENT_LABELS[key];
  const words = key.replace(/_/g, " ").trim();
  return words ? words.charAt(0).toUpperCase() + words.slice(1) : "Evento";
}

const STUDENT_ACTIVITY_CATEGORY_LABELS = Object.freeze({
  suggestion: "Sugerencias",
  cursor_idle: "Cursor inactivo",
  codespace: "Entorno",
  github_pr: "Pull requests",
  navigation: "Navegacion",
  project_context: "Contexto del proyecto",
  intervention: "Intervenciones",
  error: "Errores",
  workflow: "Flujo de trabajo",
  tutor: "Tutor",
  signal: "Senales",
  code_application: "Codigo aplicado",
  quiz: "Quices",
});

function createDetailListItem(title, meta = "", detail = "") {
  const li = document.createElement("li");
  const titleEl = document.createElement("span");
  titleEl.className = "item-title";
  titleEl.textContent = title;
  li.appendChild(titleEl);
  if (meta) {
    const metaEl = document.createElement("span");
    metaEl.className = "item-meta";
    metaEl.textContent = meta;
    li.appendChild(metaEl);
  }
  if (detail) {
    const detailEl = document.createElement("span");
    detailEl.textContent = detail;
    li.appendChild(detailEl);
  }
  return li;
}

function fillDetailList(element, items, emptyText) {
  if (!element) return;
  element.textContent = "";
  if (!items.length) {
    element.appendChild(createDetailListItem(emptyText));
    return;
  }
  const fragment = document.createDocumentFragment();
  items.forEach((item) => fragment.appendChild(item));
  element.appendChild(fragment);
}

function renderStudentTimeline(timeline) {
  const container = overlayEls?.studentDetailTimeline;
  if (!container) return;
  const points = Array.isArray(timeline) ? timeline : [];
  if (overlayEls.studentDetailTimelineLegend) overlayEls.studentDetailTimelineLegend.hidden = points.length === 0;
  const key = JSON.stringify(points);
  if (!renderKeyChanged(container, key)) return;
  container.textContent = "";
  if (!points.length) return;
  const max = Math.max(1, ...points.map((point) => (Number(point.sessions) || 0) + (Number(point.interventions) || 0) + (Number(point.quizzes) || 0)));
  const fragment = document.createDocumentFragment();
  for (const point of points) {
    const day = document.createElement("div");
    day.className = "timeline-day";
    const sessions = Number(point.sessions) || 0;
    const interventions = Number(point.interventions) || 0;
    const quizzes = Number(point.quizzes) || 0;
    day.title = `${toText(point.day)}: ${pluralizeStudentCount(sessions, "sesion", "sesiones")}, ${pluralizeStudentCount(interventions, "intervencion", "intervenciones")}, ${pluralizeStudentCount(quizzes, "quiz", "quices")}`;
    const bars = [
      ["is-quizzes", quizzes],
      ["is-interventions", interventions],
      ["is-sessions", sessions],
    ];
    for (const [className, value] of bars) {
      if (!value) continue;
      const bar = document.createElement("span");
      bar.className = `timeline-bar ${className}`;
      bar.style.height = `${Math.max(6, Math.round((value / max) * 100))}%`;
      day.appendChild(bar);
    }
    fragment.appendChild(day);
  }
  container.appendChild(fragment);
  container.setAttribute("aria-label", `Actividad de los ultimos ${points.length} dias: ${points.reduce((sum, point) => sum + (Number(point.sessions) || 0), 0)} sesiones, ${points.reduce((sum, point) => sum + (Number(point.interventions) || 0), 0)} intervenciones y ${points.reduce((sum, point) => sum + (Number(point.quizzes) || 0), 0)} quices`);
}

function renderStudentDetail(panel) {
  const section = overlayEls?.studentDetailSection;
  if (!section) return;
  const open = !!panel.selectedId;
  section.hidden = !open;
  if (overlayEls.studentsSection) overlayEls.studentsSection.hidden = open;
  if (!open) return;

  const summary = panel.detail?.student || panel.items.find((item) => toText(item.id) === panel.selectedId) || null;
  const detail = panel.detail;
  const name = toText(summary?.displayName) || "Estudiante";
  setTextIfChanged(overlayEls.studentDetailTitle, name);
  const metaParts = [toText(summary?.email)];
  if (summary?.teacherDisplayName) metaParts.push(`Docente: ${toText(summary.teacherDisplayName)}`);
  if (summary?.pilotCohort) metaParts.push(`Cohorte ${toText(summary.pilotCohort)}`);
  if (Array.isArray(summary?.assignedCourseCodes) && summary.assignedCourseCodes.length) {
    metaParts.push(`Cursos: ${summary.assignedCourseCodes.map(toText).join(", ")}`);
  }
  if (summary?.isActive === false) metaParts.push("Cuenta inactiva");
  setTextIfChanged(overlayEls.studentDetailMeta, metaParts.filter(Boolean).join(" | ") || "Sin datos");

  const chip = overlayEls.studentDetailChip;
  if (chip) {
    const activeNow = !!summary?.sessions?.activeNow;
    const lastSeen = summary?.sessions?.lastSeenAt;
    setTextIfChanged(chip, activeNow ? "Activo ahora" : (lastSeen ? `Ultima sesion ${formatStudentRelativeTime(lastSeen).toLowerCase()}` : "Sin sesiones"));
    chip.classList.toggle("is-ok", activeNow);
  }

  // Solo habla cuando hay algo que decir (cargando o error): asi el detalle cabe sin scroll.
  const statusText = panel.detailError || (panel.detailBusy ? "Cargando detalle..." : "");
  setTextIfChanged(overlayEls.studentDetailStatus, statusText);
  if (overlayEls.studentDetailStatus) overlayEls.studentDetailStatus.hidden = !statusText;
  overlayEls.studentDetailStatus?.classList.toggle("is-loading-note", panel.detailBusy && !panel.detailError);
  if (overlayEls.studentDetailReloadBtn) overlayEls.studentDetailReloadBtn.disabled = panel.detailBusy;

  const kpis = overlayEls.studentDetailKpis;
  if (kpis) {
    const key = JSON.stringify([summary, panel.detailBusy]);
    if (renderKeyChanged(kpis, key)) {
      kpis.textContent = "";
      if (summary) {
        const sessions = summary.sessions || {};
        const interventions = summary.interventions || {};
        const quizzes = summary.quizzes || {};
        const exercises = summary.exercises || {};
        const grade = summary.grade || {};
        const fragment = document.createDocumentFragment();
        fragment.appendChild(createKpiTile("Sesiones", String(sessions.total || 0), `${sessions.browser || 0} navegador | ${sessions.editor || 0} VS Code${sessions.cli ? ` | ${sessions.cli} consola` : ""}`));
        fragment.appendChild(createKpiTile("Intervenciones", String(interventions.total || 0), `${interventions.hints || 0} pistas | ${interventions.explanations || 0} explic. | ${interventions.blocked || 0} bloqueadas`, Number(interventions.blocked) > 0 ? "is-warning" : ""));
        fragment.appendChild(createKpiTile("Pistas usadas", String(exercises.hints || 0), pluralizeStudentCount(exercises.total || 0, "ejercicio", "ejercicios")));
        fragment.appendChild(createKpiTile("Quices", `${quizzes.correct || 0}/${quizzes.answered || 0}`, quizzes.total
          ? `${quizzes.total} recibidos${quizzes.correctRate === null || quizzes.correctRate === undefined ? "" : ` | ${quizzes.correctRate} % aciertos`}${quizzes.skipped ? ` | ${quizzes.skipped} omitidos` : ""}`
          : "sin quices todavia"));
        fragment.appendChild(createKpiTile("Nota de quices", formatStudentGrade(grade), toText(grade.formula) || "Sin quices respondidos.", grade.level === "alto" ? "is-accent" : (grade.level === "bajo" ? "is-warning" : "")));
        kpis.appendChild(fragment);
      }
    }
  }

  renderStudentTimeline(detail?.timeline || []);

  const listsKey = JSON.stringify([detail, panel.detailBusy, panel.detailError]);
  if (!renderKeyChanged(section, listsKey)) return;

  const loadingItem = (text) => [createDetailListItem(text)];
  if (!detail) {
    const placeholder = panel.detailBusy ? "Cargando..." : (panel.detailError || "Sin datos.");
    fillDetailList(overlayEls.studentDetailQuizzes, loadingItem(placeholder), placeholder);
    fillDetailList(overlayEls.studentDetailSessions, loadingItem(placeholder), placeholder);
    fillDetailList(overlayEls.studentDetailInterventions, loadingItem(placeholder), placeholder);
    fillDetailList(overlayEls.studentDetailActivity, loadingItem(placeholder), placeholder);
    return;
  }

  fillDetailList(
    overlayEls.studentDetailQuizzes,
    detail.quizzes.map((quiz) => {
      const li = createDetailListItem(
        toText(quiz.topic) || toText(quiz.question) || "Mini quiz",
        `${quiz.trigger === "teacher_launch" ? "Lanzado por el docente" : "Tras aplicar codigo"} | ${formatStudentDateTime(quiz.createdAt)}${quiz.filePath ? ` | ${toText(quiz.filePath)}` : ""}`,
      );
      const result = document.createElement("span");
      result.className = `quiz-result ${quiz.answered ? (quiz.correct ? "is-ok" : "is-wrong") : "is-pending"}`;
      const parts = [studentQuizResultLabel(quiz)];
      if (quiz.answered && quiz.chosenOption) parts.push(`eligio "${truncateText(quiz.chosenOption, 60)}"`);
      if (quiz.answered && !quiz.correct && quiz.correctOption) parts.push(`correcta "${truncateText(quiz.correctOption, 60)}"`);
      if (quiz.followupScore !== null && quiz.followupScore !== undefined) parts.push(`seguimiento ${quiz.followupScore}/100`);
      result.textContent = parts.join(" | ");
      li.appendChild(result);
      if (quiz.followupFeedback) {
        const feedback = document.createElement("span");
        feedback.className = "item-meta";
        feedback.textContent = truncateText(quiz.followupFeedback, 160);
        li.appendChild(feedback);
      }
      return li;
    }),
    "Aun no ha recibido mini quices.",
  );

  fillDetailList(
    overlayEls.studentDetailSessions,
    detail.sessions.map((session) => createDetailListItem(
      `${STUDENT_SESSION_KIND_LABELS[toText(session.kind)] || toText(session.kind) || "Sesion"}${session.label ? ` (${toText(session.label)})` : ""}${session.isActive ? " | activa" : ""}`,
      `${formatStudentDateTime(session.createdAt)} | duro ${formatStudentDuration(session.durationMinutes)}${session.expiresAt ? ` | vence ${formatStudentDateTime(session.expiresAt)}` : ""}`,
    )),
    "Sin sesiones registradas.",
  );

  fillDetailList(
    overlayEls.studentDetailInterventions,
    detail.interventions.map((item) => createDetailListItem(
      `${STUDENT_EVENT_LABELS[toText(item.eventType)] || toText(item.eventType) || "Evento"} -> ${STUDENT_INTERVENTION_LABELS[toText(item.interventionType)] || toText(item.interventionType) || "intervencion"}${item.blocked ? " (bloqueada)" : ""}`,
      `${formatStudentDateTime(item.createdAt)} | ${toText(item.policyName) || "politica"} | ${toText(item.detailLevel) || "nivel"}${item.exerciseKey ? ` | ${toText(item.exerciseKey)}` : ""}`,
      truncateText(toText(item.reason) || toText(item.contextSummary), 140),
    )),
    "Sin intervenciones del tutor.",
  );

  const activityItems = detail.activity.map((item) => createDetailListItem(
    `${STUDENT_ACTIVITY_CATEGORY_LABELS[toText(item.category)] || toText(item.category) || "Actividad"}: ${describeStudentActivityEvent(item.eventType)}`,
    `${pluralizeStudentCount(item.totalEvents, "vez", "veces")}${item.totalDurationMs ? ` | ${formatStudentDuration(item.totalDurationMs / 60000)}` : ""} | ${STUDENT_ACTIVITY_SOURCE_LABELS[toText(item.source)] || toText(item.source) || "fuente"} | ${formatStudentRelativeTime(item.lastOccurredAt).toLowerCase()}`,
  ));
  const exerciseItems = detail.exercises.map((item) => createDetailListItem(
    `Ejercicio ${toText(item.exerciseKey)}`,
    `${pluralizeStudentCount(item.hintCount, "pista usada", "pistas usadas")} | ${formatStudentRelativeTime(item.lastInterventionAt).toLowerCase()}`,
  ));
  fillDetailList(overlayEls.studentDetailActivity, [...exerciseItems, ...activityItems], "Sin actividad registrada.");
}

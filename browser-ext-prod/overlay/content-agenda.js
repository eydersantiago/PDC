// ADACEEN | Capa 4 - UI: agenda del estudiante (0.7.17). En Inicio, una linea «Estás en FPOO ·
// semana 5 de 16» (y en el Tutor, bajo «Hoy quiero reforzar», «Semana 5 de 16») que lleva a la
// pestana «Agenda»: la semana segun la bitacora del docente, las proximas evaluaciones y
// entregas, Google Calendar (solo con el correo de la universidad) y los bloques de estudio
// sugeridos. Los calculos estan en services/course-agenda.service.js y la sincronizacion en
// services/google-calendar.service.js.
// Orden de carga: manifest.json (content_scripts) y background.js (CONTENT_SCRIPT_FILES) deben coincidir.
"use strict";

// Listeners de la agenda del estudiante (llamada desde ensureOverlay, content-lifecycle.js).
function bindCourseAgendaPanel() {
  overlayEls.agendaHomeLine?.addEventListener("click", () => {
    setMainTab("agenda", { byUser: true, forceRender: true, focus: true });
  });
  overlayEls.tutorWeekLine?.addEventListener("click", () => {
    setMainTab("agenda", { byUser: true, forceRender: true, focus: true });
  });
  overlayEls.agendaRefreshBtn?.addEventListener("click", async () => {
    await refreshTeacherBitacoraStatus();
  });
  overlayEls.agendaCalendarSyncBtn?.addEventListener("click", async () => {
    await syncCourseEvaluationsToGoogleCalendar();
  });
  overlayEls.agendaSuggestBtn?.addEventListener("click", async () => {
    await suggestCourseStudyBlocks();
  });
  overlayEls.agendaSuggestionAddBtn?.addEventListener("click", async () => {
    await addSelectedStudyBlocksToGoogleCalendar();
  });
  overlayEls.agendaSuggestionList?.addEventListener("change", (event) => {
    const input = event?.target;
    const key = toText(input?.dataset?.suggestionKey);
    if (key) toggleCourseStudySuggestion(key, input.checked === true);
  });
}

// ---- Textos ----

function describeCourseAgendaHeadline(view) {
  const code = view.courseCode;
  if (view.state === "current" && view.current) return `Estás en ${code} · semana ${view.current.week} de ${view.totalWeeks}`;
  if (view.state === "before" && view.next) return `${code} · empieza el ${formatCourseDay(view.next.dateKey)}`;
  if (view.state === "after") return `${code} · semestre terminado`;
  return "Agenda del curso";
}

function describeCourseEvaluationWhen(evaluation, todayKey) {
  const days = evaluation.day - courseDayFromKey(todayKey);
  return `${formatCourseDay(evaluation.dateKey)} (${describeCourseDaysAway(days)})`;
}

function describeCourseAgendaLine(view) {
  if (view.state === "loading") return "Consultando la bitácora del curso...";
  if (view.state === "missing") return "Tu docente aún no sube la bitácora del curso.";
  if (view.state === "error") return "No se pudo consultar la bitácora del curso. Ábrela para reintentar.";
  if (view.state === "empty") return "La bitácora del curso no trae semanas con fecha.";
  const next = view.upcoming[0];
  const nextText = next ? ` · Próximo: ${next.title}, ${describeCourseEvaluationWhen(next, view.todayKey)}` : "";
  if (view.state === "before" && view.next) return `Semana 1: ${view.next.topic || "sin tema"}${nextText}`;
  if (view.state === "after") return `La última semana fue la ${view.current?.week || view.totalWeeks}.`;
  return `${view.current?.topic || "Sin tema en la bitácora"}${nextText}`;
}

const COURSE_AGENDA_CHIPS = Object.freeze({
  loading: { text: "Consultando", kind: "" },
  missing: { text: "Sin bitácora", kind: "" },
  error: { text: "Error", kind: "is-warn" },
  empty: { text: "Sin fechas", kind: "" },
  before: { text: "Por empezar", kind: "" },
  after: { text: "Terminado", kind: "" },
});

function describeCourseAgendaChip(view) {
  if (view.state === "current" && view.current) return { text: `Semana ${view.current.week}`, kind: "is-ok" };
  return COURSE_AGENDA_CHIPS[view.state] || COURSE_AGENDA_CHIPS.loading;
}

function applyCourseAgendaChip(chip, config) {
  if (!chip) return;
  setTextIfChanged(chip, config.text);
  chip.classList.toggle("is-ok", config.kind === "is-ok");
  chip.classList.toggle("is-warn", config.kind === "is-warn");
}

// ---- Listas ----

function renderCourseAgendaUpcoming(listEl, view) {
  listEl.textContent = "";
  if (!view.upcoming.length) {
    const empty = document.createElement("li");
    empty.className = "agenda-empty";
    empty.textContent = view.evaluations.length
      ? "No quedan evaluaciones ni entregas en la bitácora."
      : "La bitácora no marca evaluaciones ni entregas.";
    listEl.appendChild(empty);
    return;
  }
  const fragment = document.createDocumentFragment();
  for (const evaluation of view.upcoming.slice(0, 4)) {
    const li = document.createElement("li");
    li.className = `agenda-upcoming-item is-${evaluation.category.toLowerCase()}`;
    const date = document.createElement("span");
    date.className = "agenda-upcoming-date";
    date.textContent = formatCourseDay(evaluation.dateKey);
    const title = document.createElement("strong");
    title.className = "agenda-upcoming-title";
    title.textContent = evaluation.title;
    const meta = document.createElement("span");
    meta.className = "agenda-upcoming-meta";
    const days = evaluation.day - courseDayFromKey(view.todayKey);
    meta.textContent = [evaluation.category, evaluation.week ? `semana ${evaluation.week}` : "", describeCourseDaysAway(days)].filter(Boolean).join(" · ");
    li.append(date, title, meta);
    fragment.appendChild(li);
  }
  listEl.appendChild(fragment);
}

function renderCourseAgendaWeeks(listEl, view) {
  listEl.textContent = "";
  const fragment = document.createDocumentFragment();
  const currentWeek = view.state === "current" ? view.current?.week : 0;
  view.weeks.forEach((week, index) => {
    const li = document.createElement("li");
    li.className = `agenda-week-row${week.week === currentWeek ? " is-current" : ""}`;
    const head = document.createElement("span");
    head.className = "agenda-week-row-head";
    const nextWeek = view.weeks[index + 1];
    const endKey = nextWeek?.day ? courseKeyFromDay(nextWeek.day - 1) : (week.day !== null ? courseKeyFromDay(week.day + 6) : "");
    head.textContent = `Semana ${week.week}${week.dateKey ? ` · ${formatCourseRange(week.dateKey, endKey)}` : ""}${week.week === currentWeek ? " · hoy" : ""}`;
    const topic = document.createElement("span");
    topic.className = "agenda-week-row-topic";
    topic.textContent = week.topic || "Sin tema";
    li.append(head, topic);
    for (const evaluation of week.evaluations || []) {
      const tag = document.createElement("span");
      tag.className = `agenda-week-row-tag is-${evaluation.category.toLowerCase()}`;
      tag.textContent = evaluation.title;
      li.appendChild(tag);
    }
    fragment.appendChild(li);
  });
  for (const extra of view.extras) {
    const li = document.createElement("li");
    li.className = "agenda-week-row is-extra";
    const head = document.createElement("span");
    head.className = "agenda-week-row-head";
    head.textContent = formatCourseDay(extra.dateKey);
    const topic = document.createElement("span");
    topic.className = "agenda-week-row-topic";
    topic.textContent = extra.title || "Sesión adicional";
    li.append(head, topic);
    fragment.appendChild(li);
  }
  listEl.appendChild(fragment);
}

function renderCourseStudySuggestions(listEl, suggestions, busy) {
  listEl.textContent = "";
  const fragment = document.createDocumentFragment();
  for (const suggestion of suggestions) {
    const li = document.createElement("li");
    li.className = `agenda-suggestion${suggestion.added ? " is-added" : ""}`;
    const label = document.createElement("label");
    const input = document.createElement("input");
    input.type = "checkbox";
    input.checked = suggestion.selected === true;
    input.disabled = busy || suggestion.added === true;
    input.dataset.suggestionKey = suggestion.key;
    const text = document.createElement("span");
    text.className = "agenda-suggestion-text";
    const title = document.createElement("strong");
    title.textContent = suggestion.title;
    const when = document.createElement("span");
    when.textContent = `${suggestion.label} · ${suggestion.reason}${suggestion.added ? " · agregado" : ""}`;
    text.append(title, when);
    label.append(input, text);
    li.appendChild(label);
    fragment.appendChild(li);
  }
  listEl.appendChild(fragment);
}

// ---- Render ----

function renderCourseAgendaHomeLine(visible, view) {
  const line = overlayEls?.agendaHomeLine;
  if (!line) return;
  line.hidden = !visible;
  if (!visible) return;
  const headline = describeCourseAgendaHeadline(view);
  const text = describeCourseAgendaLine(view);
  setTextIfChanged(overlayEls.agendaHomeEyebrow, headline);
  setTextIfChanged(overlayEls.agendaHomeText, text);
  applyCourseAgendaChip(overlayEls.agendaHomeChip, describeCourseAgendaChip(view));
  const label = `${headline}. ${text.replace(/\.$/, "")}. Abre la pestaña Agenda.`;
  if (line.getAttribute("aria-label") !== label) line.setAttribute("aria-label", label);
}

// En el Tutor, solo durante el semestre: «Semana 5 de 16» y «FPOO: <tema>». Lleva a «Agenda».
function renderCourseAgendaTutorLine(visible, view) {
  const line = overlayEls?.tutorWeekLine;
  if (!line) return;
  const show = visible && view?.state === "current" && !!view.current;
  line.hidden = !show;
  if (!show) return;
  const chip = `Semana ${view.current.week} de ${view.totalWeeks}`;
  const text = `${view.courseCode}: ${view.current.topic || "sin tema en la bitácora"}`;
  setTextIfChanged(overlayEls.tutorWeekChip, chip);
  setTextIfChanged(overlayEls.tutorWeekText, text);
  const label = `${chip} de ${view.courseCode}. ${view.current.topic || "Sin tema en la bitácora"}. Abre la pestaña Agenda.`;
  if (line.getAttribute("aria-label") !== label) line.setAttribute("aria-label", label);
}

function renderCourseAgendaPanel(showingMainView) {
  if (!overlayEls) return;
  const allowed = showingMainView && overlayState.session?.user?.role === "student";
  if (overlayEls.agendaSection) overlayEls.agendaSection.hidden = !allowed;
  if (!allowed) {
    if (overlayEls.agendaHomeLine) overlayEls.agendaHomeLine.hidden = true;
    if (overlayEls.tutorWeekLine) overlayEls.tutorWeekLine.hidden = true;
    return;
  }
  const view = getCourseAgendaView();
  renderCourseAgendaHomeLine(true, view);
  renderCourseAgendaTutorLine(true, view);

  const headline = describeCourseAgendaHeadline(view);
  setTextIfChanged(overlayEls.agendaTitle, view.state === "current" || view.state === "before" || view.state === "after" ? headline : "Agenda del curso");
  let statusText = describeCourseAgendaLine(view);
  if (view.state === "current" && view.current) {
    statusText = `${view.courseName} · ${formatCourseRange(view.current.dateKey, view.endKey)} · según la bitácora de tu docente.`;
  }
  setTextIfChanged(overlayEls.agendaStatusText, statusText);
  applyCourseAgendaChip(overlayEls.agendaWeekChip, describeCourseAgendaChip(view));
  if (overlayEls.agendaRefreshBtn) overlayEls.agendaRefreshBtn.disabled = !!view.status.busy;

  // Esta semana: tema y lo que se hace en clase.
  const week = view.state === "current" ? view.current : (view.state === "before" ? view.next : null);
  if (overlayEls.agendaWeekCard) overlayEls.agendaWeekCard.hidden = !week;
  if (week) {
    setTextIfChanged(overlayEls.agendaWeekEyebrow, view.state === "current" ? "Esta semana" : `Semana 1 · ${formatCourseDay(week.dateKey)}`);
    setTextIfChanged(overlayEls.agendaWeekTopic, week.topic || "Sin tema en la bitácora");
    const activitiesKey = JSON.stringify([week.week, week.activities]);
    if (overlayEls.agendaWeekActivities && renderKeyChanged(overlayEls.agendaWeekActivities, activitiesKey)) {
      overlayEls.agendaWeekActivities.textContent = "";
      for (const activity of week.activities.slice(0, 5)) {
        const li = document.createElement("li");
        li.textContent = activity;
        overlayEls.agendaWeekActivities.appendChild(li);
      }
    }
  }

  const upcomingKey = JSON.stringify([view.todayKey, view.upcoming.map((evaluation) => evaluation.key + evaluation.dateKey), view.evaluations.length]);
  if (overlayEls.agendaUpcomingList && renderKeyChanged(overlayEls.agendaUpcomingList, upcomingKey)) {
    renderCourseAgendaUpcoming(overlayEls.agendaUpcomingList, view);
  }

  // Google Calendar: solo con el correo de la universidad.
  const calendar = getCourseCalendarState();
  const eligibility = getCourseCalendarEligibility();
  const hasAgenda = view.weeks.length > 0;
  setTextIfChanged(
    overlayEls.agendaCalendarNote,
    eligibility.allowed
      ? `Pasa a tu Google Calendar (${eligibility.email}) las evaluaciones y entregas que falten, con aviso un día y una hora antes. Las que ya están no se repiten.`
      : eligibility.reason,
  );
  if (overlayEls.agendaCalendarSyncBtn) {
    overlayEls.agendaCalendarSyncBtn.disabled = calendar.busy || !eligibility.allowed || !view.upcoming.length;
  }
  if (overlayEls.agendaSuggestBtn) overlayEls.agendaSuggestBtn.disabled = calendar.busy || !view.upcoming.length;
  setTextIfChanged(overlayEls.agendaCalendarStatus, calendar.error || calendar.message || "");
  overlayEls.agendaCalendarStatus?.classList.toggle("is-warning", !!calendar.error);

  const suggestions = calendar.suggestions;
  if (overlayEls.agendaSuggestionsBlock) overlayEls.agendaSuggestionsBlock.hidden = !suggestions.length && !calendar.suggestionsNote;
  setTextIfChanged(overlayEls.agendaSuggestionsNote, calendar.suggestionsNote || "");
  const suggestionsKey = JSON.stringify([calendar.busy, suggestions]);
  if (overlayEls.agendaSuggestionList && renderKeyChanged(overlayEls.agendaSuggestionList, suggestionsKey)) {
    renderCourseStudySuggestions(overlayEls.agendaSuggestionList, suggestions, calendar.busy);
  }
  if (overlayEls.agendaSuggestionAddBtn) {
    overlayEls.agendaSuggestionAddBtn.hidden = !suggestions.length;
    overlayEls.agendaSuggestionAddBtn.disabled = calendar.busy || !eligibility.allowed
      || !suggestions.some((suggestion) => suggestion.selected && !suggestion.added);
  }

  if (overlayEls.agendaWeeksFold) overlayEls.agendaWeeksFold.hidden = !hasAgenda;
  if (overlayEls.agendaWeeksCount) {
    overlayEls.agendaWeeksCount.hidden = !view.totalWeeks;
    setTextIfChanged(overlayEls.agendaWeeksCount, view.totalWeeks ? String(view.totalWeeks) : "");
  }
  const weeksKey = JSON.stringify([view.todayKey, view.state, view.weeks.map((entry) => `${entry.week}|${entry.dateKey}|${entry.topic}`), view.extras.length]);
  if (overlayEls.agendaWeeksList && renderKeyChanged(overlayEls.agendaWeeksList, weeksKey)) {
    renderCourseAgendaWeeks(overlayEls.agendaWeeksList, view);
  }
}

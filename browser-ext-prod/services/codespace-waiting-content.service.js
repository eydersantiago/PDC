// ADACEEN | Capa 3 - Servicios: contenido de la ventana de espera del Codespace: eventos y agenda del
// curso, proyecto, usuario y fuentes RAG convertidos en diapositivas.
// Movido sin cambios desde services/github.service.js.
// Orden de carga: manifest.json (content_scripts) y background.js (CONTENT_SCRIPT_FILES) deben coincidir.
"use strict";

function escapeWaitingPageText(value) {
  return toText(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll("\"", "&quot;")
    .replaceAll("'", "&#39;");
}

function getExtensionResourceUrl(path) {
  const cleanPath = toText(path).replace(/^\/+/, "");
  if (!cleanPath) return "";

  try {
    if (typeof chrome !== "undefined" && chrome.runtime && typeof chrome.runtime.getURL === "function") {
      return chrome.runtime.getURL(cleanPath);
    }
  } catch {
    // Fall through to the browser runtime or relative path fallback.
  }

  try {
    if (typeof browser !== "undefined" && browser.runtime && typeof browser.runtime.getURL === "function") {
      return browser.runtime.getURL(cleanPath);
    }
  } catch {
    // Fall through to the relative path fallback.
  }

  return cleanPath;
}

function escapeWaitingPageCssUrl(value) {
  return toText(value)
    .replaceAll("\\", "\\\\")
    .replaceAll("\"", "\\\"")
    .replaceAll("\n", "")
    .replaceAll("\r", "");
}

function trimWaitingPageLine(value, maxLength = 160) {
  const text = toText(value).replace(/\s+/g, " ").trim();
  if (!text || text.length <= maxLength) return text;
  return `${text.slice(0, Math.max(0, maxLength - 3)).trim()}...`;
}

function addWaitingPageLine(lines, value, maxLength = 160) {
  const text = trimWaitingPageLine(value, maxLength);
  if (!text || lines.includes(text)) return;
  lines.push(text);
}

function formatWaitingDueText(value) {
  const text = toText(value);
  if (!text) return "";
  if (/^\d{4}-\d{2}-\d{2}/.test(text)) return text.slice(0, 10);
  return trimWaitingPageLine(text, 56);
}

function addWaitingPageEvent(events, seen, input = {}) {
  const title = trimWaitingPageLine(input.title || input.summary || input.text || input.name, 130);
  if (!title) return;

  const dueText = formatWaitingDueText(input.dueText || input.dueAt || input.date || input.start?.dateTime || input.start?.date);
  const source = trimWaitingPageLine(input.source || "agenda", 40);
  const key = `${title.toLowerCase()}|${dueText.toLowerCase()}|${source.toLowerCase()}`;
  if (seen.has(key)) return;
  seen.add(key);
  events.push({ title, dueText, source });
}

function collectWaitingPageEvents(maxLines = 4) {
  const events = [];
  const seen = new Set();
  const state = typeof normalizeDocumentClassificationState === "function"
    ? normalizeDocumentClassificationState(overlayState.documentClassifications)
    : (overlayState.documentClassifications || { items: [] });
  const documents = Array.isArray(state.items) ? state.items : [];

  for (const item of documents) {
    if (item?.label !== "BITACORA") continue;
    const agendaItems = Array.isArray(item.bitacoraAgenda?.items) ? item.bitacoraAgenda.items : [];
    for (const agendaItem of agendaItems) {
      addWaitingPageEvent(events, seen, {
        ...agendaItem,
        source: "bitacora",
        dueText: agendaItem.visibleDueText || agendaItem.dueAt,
      });
    }
  }

  const analysis = overlayState.campusAnalysis || {};
  if (analysis && typeof buildCampusCalendarEvents === "function") {
    try {
      const calendarEvents = buildCampusCalendarEvents(analysis, overlayState.context || buildPayload());
      for (const event of calendarEvents) {
        addWaitingPageEvent(events, seen, {
          title: event?.summary,
          source: "Calendar",
          dueText: event?.start?.dateTime || event?.start?.date,
        });
      }
    } catch {}
  }

  const sources = [
    ["agenda", Array.isArray(analysis.agenda) ? analysis.agenda : []],
    ["tarea", Array.isArray(analysis.tasks) ? analysis.tasks : []],
    ["actividad", Array.isArray(analysis.activities) ? analysis.activities : []],
    ["recomendacion", Array.isArray(analysis.recommendations) ? analysis.recommendations : []],
  ];
  for (const [label, items] of sources) {
    for (const rawItem of items) {
      const item = rawItem && typeof rawItem === "object" ? rawItem : { title: rawItem };
      addWaitingPageEvent(events, seen, {
        ...item,
        source: label,
        dueText: item.visibleDueText || item.dueAt || item.date,
      });
    }
  }

  const lines = events.slice(0, maxLines).map((event) => {
    const prefix = event.source ? `${event.source}: ` : "";
    return event.dueText ? `${prefix}${event.title} (${event.dueText})` : `${prefix}${event.title}`;
  });
  const sourceLabels = [...new Set(events.map((event) => event.source).filter(Boolean))];
  return { total: events.length, lines, sourceLabels };
}

function getWaitingPageAgendaLines(maxItems = 4) {
  return collectWaitingPageEvents(maxItems).lines;
}

function getWaitingPageEventSummaryLines(maxItems = 5) {
  const events = collectWaitingPageEvents(Math.max(1, maxItems - 1));
  const lines = [];

  if (events.total > 0) {
    addWaitingPageLine(
      lines,
      `Eventos cargados: ${events.total}${events.sourceLabels.length ? ` desde ${events.sourceLabels.join(", ")}` : ""}.`,
      150,
    );
    for (const line of events.lines) {
      addWaitingPageLine(lines, line, 150);
    }
    return lines.slice(0, maxItems);
  }

  addWaitingPageLine(lines, "Sin eventos cargados todavia; al detectar bitacora, agenda o Campus, ADACEEN los mostrara aqui.", 150);
  return lines;
}

function getWaitingPageProjectLines(maxItems = 5) {
  const lines = [];
  const context = overlayState.context || {};
  const status = overlayState.projectContextStatus || EMPTY_PROJECT_CONTEXT_STATUS;
  const insight = overlayState.projectContextInsight || EMPTY_PROJECT_CONTEXT_INSIGHT;
  const goal = typeof getLearningGoal === "function"
    ? getLearningGoal(overlayState.selectedLearningGoal)
    : null;
  const mainFile = toText(insight.mainFilePath || context.filePath || insight.candidates?.[0]?.path);

  if (context.branch) addWaitingPageLine(lines, `Rama detectada: ${context.branch}`, 120);
  if (mainFile) addWaitingPageLine(lines, `Archivo de trabajo: ${mainFile}`, 140);
  if (goal?.label) addWaitingPageLine(lines, `Objetivo de aprendizaje: ${goal.label}`, 120);
  if (status.summary) addWaitingPageLine(lines, `Contexto guardado: ${status.summary}`, 150);
  if (insight.summary) addWaitingPageLine(lines, insight.summary, 150);
  if (insight.autoAdvice) addWaitingPageLine(lines, insight.autoAdvice, 150);

  return lines.slice(0, maxItems);
}

function getWaitingPageSelectedRagCourseCode() {
  if (overlayState.session?.user?.role === "student" && typeof getSelectedStudentCourseCode === "function") {
    return normalizeRagCourseCodeUi(getSelectedStudentCourseCode());
  }
  if (overlayState.session?.user?.role === "teacher") {
    const state = typeof normalizeTeacherRagStatePayload === "function"
      ? normalizeTeacherRagStatePayload(overlayState.teacherRagState)
      : (overlayState.teacherRagState || {});
    return normalizeRagCourseCodeUi(state.selectedCourseCode || overlayState.activeRagCourseCode || overlayState.ragDefaultCourseCode || "FPOO");
  }
  return normalizeRagCourseCodeUi(overlayState.activeRagCourseCode || overlayState.ragDefaultCourseCode || "FPOO");
}

function getWaitingPageRagCourse(courseCode) {
  const normalized = normalizeRagCourseCodeUi(courseCode || getWaitingPageSelectedRagCourseCode());
  const waitingCourses = Array.isArray(overlayState.codespaceWaitingContext?.courses)
    ? overlayState.codespaceWaitingContext.courses
    : [];
  const catalog = waitingCourses.length || typeof getRagCourseCatalog !== "function"
    ? waitingCourses
    : getRagCourseCatalog();
  return catalog.find((course) => normalizeRagCourseCodeUi(course?.code) === normalized)
    || { code: normalized, name: normalized, shortName: normalized };
}

function getWaitingPageRagSources(courseCode) {
  const normalized = normalizeRagCourseCodeUi(courseCode || getWaitingPageSelectedRagCourseCode());
  const waitingSources = Array.isArray(overlayState.codespaceWaitingContext?.ragSources)
    ? overlayState.codespaceWaitingContext.ragSources
    : [];
  const teacherSources = Array.isArray(overlayState.teacherRagState?.sources)
    ? overlayState.teacherRagState.sources
    : [];
  const activeSources = Array.isArray(overlayState.ragSources) ? overlayState.ragSources : [];
  const sources = waitingSources.length ? waitingSources : [...teacherSources, ...activeSources];
  return sources.filter((source) => {
    const sourceCourse = normalizeRagCourseCodeUi(source.courseCode || source.metadata?.courseCode || source.metadata?.course_code || normalized);
    return !sourceCourse || sourceCourse === normalized;
  });
}

function getWaitingPageUserLines(maxItems = 5) {
  const lines = [];
  const session = overlayState.session || {};
  const user = session.user || {};
  if (!user || !session.id) return lines;

  const role = typeof getRoleLabel === "function" ? getRoleLabel(user.role) : toText(user.role || "Usuario");
  const displayName = toText(user.displayName || user.name || user.email || "Usuario ADACEEN");
  addWaitingPageLine(lines, `${displayName} | ${role}`, 140);

  const courseCode = getWaitingPageSelectedRagCourseCode();
  const course = getWaitingPageRagCourse(courseCode);
  const courseName = toText(course.shortName || course.name);
  if (courseCode) {
    addWaitingPageLine(lines, `Curso activo: ${courseCode}${courseName && courseName !== courseCode ? ` - ${courseName}` : ""}.`, 140);
  }

  const goal = typeof getLearningGoal === "function" ? getLearningGoal(overlayState.selectedLearningGoal) : null;
  if (goal?.label) addWaitingPageLine(lines, `Foco de tutor: ${goal.label}.`, 120);

  const githubLogin = toText(overlayState.githubUserStatus?.accountLogin);
  if (githubLogin) addWaitingPageLine(lines, `GitHub conectado: ${githubLogin}.`, 120);

  const policy = overlayState.policy || DEFAULT_POLICY;
  const policyLine = [
    policy.outcome ? `resultado ${policy.outcome}` : "",
    policy.helpLevel ? `ayuda ${policy.helpLevel}` : "",
    policy.maxHintsPerExercise != null ? `${policy.maxHintsPerExercise} pistas max.` : "",
  ].filter(Boolean).join(" | ");
  if (policyLine) addWaitingPageLine(lines, `Politica pedagogica: ${policyLine}`, 140);

  return lines.slice(0, maxItems);
}

function getWaitingPageRagLines(maxItems = 5) {
  const lines = [];
  const waitingContext = overlayState.codespaceWaitingContext || {};
  // ragFetchedAt: GET /api/rag/sources respondio para esta ventana. Sin eso (la ventana se arma
  // en el clic, antes de consultar) 0 fuentes no quiere decir que el curso no tenga material.
  const fetched = Boolean(waitingContext.ragFetchedAt);
  const ragError = toText(waitingContext.ragError);
  const courseCode = normalizeRagCourseCodeUi(overlayState.codespaceWaitingContext?.ragCourseCode || getWaitingPageSelectedRagCourseCode());
  const course = getWaitingPageRagCourse(courseCode);
  const courseName = toText(overlayState.codespaceWaitingContext?.ragCourseName || course.name || course.shortName || courseCode);
  const sources = getWaitingPageRagSources(courseCode);
  const defaultCount = sources.filter((source) => source.scope === "default").length;
  const teacherSources = sources.filter((source) => source.scope === "teacher");
  const teacherCount = teacherSources.length;

  // Sin consulta y sin fuentes en el overlay no hay nada que contar todavia: la consulta
  // actualiza la ventana cuando responde.
  const unknown = !fetched && !sources.length;

  addWaitingPageLine(lines, `Curso RAG seleccionado: ${courseCode}${courseName && courseName !== courseCode ? ` - ${courseName}` : ""}.`, 150);
  if (unknown) {
    if (!ragError) addWaitingPageLine(lines, "Consultando el material del curso...", 150);
  } else {
    addWaitingPageLine(lines, `Fuentes disponibles: ${defaultCount} base, ${teacherCount} del profesor.`, 140);
  }

  if (unknown) {
    // Nada mas que decir del material.
  } else if (teacherSources.length > 0) {
    const names = teacherSources
      .map((source) => toText(source.title || source.fileName || "fuente del profesor"))
      .filter(Boolean)
      .slice(0, 3);
    addWaitingPageLine(lines, `Subido por profesor: ${names.join("; ")}${teacherSources.length > names.length ? ` y ${teacherSources.length - names.length} mas` : ""}.`, 150);
  } else if (defaultCount > 0) {
    const baseText = defaultCount === 1 ? "la fuente base" : `las ${defaultCount} fuentes base`;
    addWaitingPageLine(lines, `Aun no hay fuentes del profesor para este curso; ADACEEN usara ${baseText}.`, 150);
  } else if (fetched && !ragError) {
    // Ni base ni del profesor, y la consulta respondio: el tutor no tiene material del curso.
    // Solo el docente tiene la pestana «RAG»; el administrador no.
    const role = overlayState.session?.user?.role;
    const noMaterial = "Este curso aun no tiene material en ADACEEN: el tutor responde sin fuentes del curso";
    const next = role === "teacher"
      ? ". Cargalas en la pestana «RAG»."
      : role === "admin"
        ? " hasta que el docente las cargue en su pestana «RAG»."
        : " hasta que tu docente las cargue.";
    addWaitingPageLine(lines, `${noMaterial}${next}`, 150);
  }

  if (ragError) {
    addWaitingPageLine(lines, `RAG pendiente de refrescar: ${ragError}`, 150);
  }

  return lines.slice(0, maxItems);
}

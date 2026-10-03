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
  const courseCode = normalizeRagCourseCodeUi(overlayState.codespaceWaitingContext?.ragCourseCode || getWaitingPageSelectedRagCourseCode());
  const course = getWaitingPageRagCourse(courseCode);
  const courseName = toText(overlayState.codespaceWaitingContext?.ragCourseName || course.name || course.shortName || courseCode);
  const sources = getWaitingPageRagSources(courseCode);
  const defaultCount = sources.filter((source) => source.scope === "default").length;
  const teacherSources = sources.filter((source) => source.scope === "teacher");
  const teacherCount = teacherSources.length;

  addWaitingPageLine(lines, `Curso RAG seleccionado: ${courseCode}${courseName && courseName !== courseCode ? ` - ${courseName}` : ""}.`, 150);
  addWaitingPageLine(lines, `Fuentes disponibles: ${defaultCount} base, ${teacherCount} del profesor.`, 140);

  if (teacherSources.length > 0) {
    const names = teacherSources
      .map((source) => toText(source.title || source.fileName || "fuente del profesor"))
      .filter(Boolean)
      .slice(0, 3);
    addWaitingPageLine(lines, `Subido por profesor: ${names.join("; ")}${teacherSources.length > names.length ? ` y ${teacherSources.length - names.length} mas` : ""}.`, 150);
  } else {
    addWaitingPageLine(lines, "Aun no hay fuentes del profesor para este curso; ADACEEN usara el material base disponible.", 150);
  }

  if (overlayState.codespaceWaitingContext?.ragError) {
    addWaitingPageLine(lines, `RAG pendiente de refrescar: ${overlayState.codespaceWaitingContext.ragError}`, 150);
  }

  return lines.slice(0, maxItems);
}

async function refreshCodespaceWaitingContext() {
  const baseUrl = normalizeBaseUrl(overlayState.backendUrl);
  if (!baseUrl || !overlayState.sessionId) return false;

  let courses = [];
  try {
    const coursesResponse = await fetchJsonWithTimeout(`${baseUrl}/api/rag/courses`, {
      method: "GET",
      headers: buildApiHeaders(),
    }, BACKEND_TIMEOUT_MS);
    if (typeof updateRagCourseCatalogFromResponse === "function") {
      courses = updateRagCourseCatalogFromResponse(coursesResponse);
    } else {
      courses = Array.isArray(coursesResponse?.courses) ? coursesResponse.courses : [];
    }
  } catch {}

  const courseCode = getWaitingPageSelectedRagCourseCode();
  try {
    const sourcesResponse = await fetchJsonWithTimeout(
      `${baseUrl}/api/rag/sources?courseCode=${encodeURIComponent(courseCode)}&limit=80`,
      {
        method: "GET",
        headers: buildApiHeaders(),
      },
      BACKEND_TIMEOUT_MS,
    );
    if (typeof updateRagCourseCatalogFromResponse === "function") {
      const responseCourses = updateRagCourseCatalogFromResponse(sourcesResponse);
      if (responseCourses.length) courses = responseCourses;
    }
    const normalizedCourseCode = normalizeRagCourseCodeUi(sourcesResponse?.courseCode || courseCode);
    const course = getWaitingPageRagCourse(normalizedCourseCode);
    const sources = typeof normalizeRagSourcesForUi === "function"
      ? normalizeRagSourcesForUi(sourcesResponse?.sources || [])
      : (Array.isArray(sourcesResponse?.sources) ? sourcesResponse.sources : []);
    overlayState.codespaceWaitingContext = {
      ragCourseCode: normalizedCourseCode,
      ragCourseName: toText(course.name || course.shortName || normalizedCourseCode),
      ragSources: sources,
      courses: courses.length ? courses : (Array.isArray(sourcesResponse?.courses) ? sourcesResponse.courses : []),
      ragFetchedAt: new Date().toISOString(),
      ragError: "",
    };
    return true;
  } catch (error) {
    const course = getWaitingPageRagCourse(courseCode);
    overlayState.codespaceWaitingContext = {
      ...(overlayState.codespaceWaitingContext || EMPTY_CODESPACE_WAITING_CONTEXT),
      ragCourseCode: courseCode,
      ragCourseName: toText(course.name || course.shortName || courseCode),
      courses,
      ragError: String(error?.message || error),
    };
    return false;
  }
}

function buildCodespaceWaitingSlides(repoFullName) {
  const projectLines = getWaitingPageProjectLines();
  const agendaLines = getWaitingPageAgendaLines();
  const userLines = getWaitingPageUserLines();
  const eventLines = getWaitingPageEventSummaryLines();
  const ragLines = getWaitingPageRagLines();
  // Editor en la nube (tunel): ni rama, ni PR, ni Codespaces. La primera diapositiva cuenta los
  // pasos que van a pasar en esta misma pestana y la ultima, como entrar.
  const tunnel = typeof isTunnelProvider === "function" && isTunnelProvider();
  const githubLogin = toText(overlayState.githubUserStatus?.accountLogin);
  const slides = tunnel
    ? [{
      eyebrow: "Tu editor",
      title: "Lo que pasa en esta pestana",
      lines: [
        `ADACEEN enciende tu editor en la nube y deja ${repoFullName || "tu repositorio"} en su propia carpeta (segundos; si la VM estaba apagada, 1 o 2 minutos).`,
        "Solo la primera vez, GitHub pide un codigo de un solo uso: esta pestana te lleva a pegarlo y lo deja copiado.",
        "Cuando todo este listo, esta pestana abre VS Code en el navegador (vscode.dev) sola. No la cierres.",
      ],
    }]
    : [
      {
        eyebrow: "Estado",
        title: "Preparacion del entorno",
        lines: [
          "Creando o reutilizando la rama y PR de configuracion ADACEEN.",
          "Solicitando o reanudando el Codespace con la API de GitHub.",
          "Esta ventana se redirige sola cuando el backend entregue la URL del editor (github.dev o vscode.dev/tunnel).",
        ],
      },
    ];

  if (userLines.length) {
    slides.push({
      eyebrow: "Usuario",
      title: "Sesion y enfoque",
      lines: userLines,
    });
  }

  if (projectLines.length) {
    slides.push({
      eyebrow: "Proyecto",
      title: "Contexto detectado",
      lines: projectLines,
    });
  }

  if (eventLines.length) {
    slides.push({
      eyebrow: "Agenda",
      title: "Eventos cargados",
      lines: eventLines,
    });
  } else if (agendaLines.length) {
    slides.push({
      eyebrow: "Curso",
      title: "Contenido para revisar",
      lines: agendaLines,
    });
  }

  if (ragLines.length) {
    slides.push({
      eyebrow: "RAG",
      title: "Material seleccionado",
      lines: ragLines,
    });
  }

  slides.push(tunnel
    ? {
      eyebrow: "Siguiente",
      title: "Al entrar a tu editor",
      lines: [
        githubLogin
          ? `Si vscode.dev pide iniciar sesion, elige «GitHub» con la cuenta «${githubLogin}». Con otra cuenta no encuentra tu editor.`
          : "Si vscode.dev pide iniciar sesion, elige «GitHub» con la misma cuenta que conectaste en ADACEEN.",
        "La extension ADACEEN ya viene instalada: abajo, la barra dice «ADACEEN» con tu nombre.",
        "Tus otros repositorios quedan en el mismo editor: en Inicio, «Tus repositorios en el editor».",
      ],
    }
    : {
      eyebrow: "Siguiente",
      title: "Al entrar al Codespace",
      lines: [
        "Espera a que VS Code Web termine de cargar el contenedor.",
        "Revisa el archivo principal o la tarea detectada por ADACEEN.",
        "Haz commit y push al terminar para que el avance quede registrado.",
      ],
    });

  if (!projectLines.length && !agendaLines.length) {
    slides.push({
      eyebrow: "Repositorio",
      title: "Destino activo",
      lines: [
        repoFullName || "Repositorio detectado por GitHub.",
        "La automatizacion continua en segundo plano aunque cambie este contenido.",
      ],
    });
  }

  return slides;
}

function renderCodespaceWaitingSlidesMarkup(slides) {
  return slides.map((slide, index) => {
    const lines = Array.isArray(slide.lines) && slide.lines.length
      ? slide.lines
      : ["ADACEEN mantiene la comprobacion automatica activa."];
    return `<section class="wait-panel${index === 0 ? " is-active" : ""}" data-adaceen-wait-panel="${index}" aria-hidden="${index === 0 ? "false" : "true"}">
      <div class="panel-eyebrow">${escapeWaitingPageText(slide.eyebrow)}</div>
      <h2>${escapeWaitingPageText(slide.title)}</h2>
      <ul>${lines.map((line) => `<li>${escapeWaitingPageText(line)}</li>`).join("")}</ul>
    </section>`;
  }).join("");
}

function renderCodespaceWaitingDotsMarkup(slides) {
  if (!Array.isArray(slides) || slides.length <= 1) return "";
  return slides.map((_, index) => `<button type="button" class="wait-dot${index === 0 ? " is-active" : ""}" data-adaceen-wait-dot="${index}" aria-label="Ver bloque ${index + 1}"></button>`).join("");
}

function hydrateCodespaceWaitingWindow(pendingWindow) {
  if (!pendingWindow || pendingWindow.closed) return;

  try {
    const panels = Array.from(pendingWindow.document.querySelectorAll("[data-adaceen-wait-panel]"));
    const dots = Array.from(pendingWindow.document.querySelectorAll("[data-adaceen-wait-dot]"));
    const progress = pendingWindow.document.getElementById("adaceenWaitProgress");
    if (!panels.length) return;

    let activeIndex = panels.findIndex((panel) => panel.classList.contains("is-active"));
    if (activeIndex < 0) activeIndex = 0;

    const show = (nextIndex) => {
      if (!panels.length) return;
      activeIndex = ((nextIndex % panels.length) + panels.length) % panels.length;
      panels.forEach((panel, panelIndex) => {
        const active = panelIndex === activeIndex;
        panel.classList.toggle("is-active", active);
        panel.setAttribute("aria-hidden", active ? "false" : "true");
      });
      dots.forEach((dot, dotIndex) => {
        dot.classList.toggle("is-active", dotIndex === activeIndex);
      });
      if (progress) {
        progress.style.width = `${((activeIndex + 1) / panels.length) * 100}%`;
      }
    };

    dots.forEach((dot, dotIndex) => {
      if (dot.dataset.adaceenWaitBound === "true") return;
      dot.dataset.adaceenWaitBound = "true";
      dot.addEventListener("click", () => show(dotIndex));
    });

    pendingWindow.adaceenShowWaitSlide = show;
    pendingWindow.adaceenAdvanceWaitSlide = () => show(activeIndex + 1);
    show(activeIndex);

    if (!pendingWindow.adaceenWaitSlideTimer && panels.length > 1) {
      const timerId = window.setInterval(() => {
        try {
          if (!pendingWindow || pendingWindow.closed) {
            window.clearInterval(timerId);
            return;
          }
          if (typeof pendingWindow.adaceenAdvanceWaitSlide === "function") {
            pendingWindow.adaceenAdvanceWaitSlide();
          }
        } catch {
          window.clearInterval(timerId);
        }
      }, 7000);
      pendingWindow.adaceenWaitSlideTimer = timerId;
    }
  } catch {
    // La ventana puede haber navegado fuera de nuestro origen.
  }
}

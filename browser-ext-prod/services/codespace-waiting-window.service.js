// ADACEEN | Capa 3 - Servicios: ventana intermedia que se muestra mientras GitHub prepara el Codespace.
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
  const state = normalizeDocumentClassificationState(overlayState.documentClassifications);
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
  try {
    for (const event of buildCampusCalendarEvents(analysis, getPageContext())) {
      addWaitingPageEvent(events, seen, {
        title: event?.summary,
        source: "Calendar",
        dueText: event?.start?.dateTime || event?.start?.date,
      });
    }
  } catch {}

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
  const goal = getLearningGoal(overlayState.selectedLearningGoal);
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
  if (overlayState.session?.user?.role === "student") {
    return normalizeRagCourseCodeUi(getSelectedStudentCourseCode());
  }
  if (overlayState.session?.user?.role === "teacher") {
    const state = normalizeTeacherRagStatePayload(overlayState.teacherRagState);
    return normalizeRagCourseCodeUi(state.selectedCourseCode || overlayState.activeRagCourseCode || overlayState.ragDefaultCourseCode || "FPOO");
  }
  return normalizeRagCourseCodeUi(overlayState.activeRagCourseCode || overlayState.ragDefaultCourseCode || "FPOO");
}

function getWaitingPageRagCourse(courseCode) {
  const normalized = normalizeRagCourseCodeUi(courseCode || getWaitingPageSelectedRagCourseCode());
  const waitingCourses = Array.isArray(overlayState.codespaceWaitingContext?.courses)
    ? overlayState.codespaceWaitingContext.courses
    : [];
  const catalog = waitingCourses.length ? waitingCourses : getRagCourseCatalog();
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

  const role = getRoleLabel(user.role);
  const displayName = toText(user.displayName || user.name || user.email || "Usuario ADACEEN");
  addWaitingPageLine(lines, `${displayName} | ${role}`, 140);

  const courseCode = getWaitingPageSelectedRagCourseCode();
  const course = getWaitingPageRagCourse(courseCode);
  const courseName = toText(course.shortName || course.name);
  if (courseCode) {
    addWaitingPageLine(lines, `Curso activo: ${courseCode}${courseName && courseName !== courseCode ? ` - ${courseName}` : ""}.`, 140);
  }

  const goal = getLearningGoal(overlayState.selectedLearningGoal);
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
    courses = updateRagCourseCatalogFromResponse(coursesResponse);
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
    const responseCourses = updateRagCourseCatalogFromResponse(sourcesResponse);
    if (responseCourses.length) courses = responseCourses;
    const normalizedCourseCode = normalizeRagCourseCodeUi(sourcesResponse?.courseCode || courseCode);
    const course = getWaitingPageRagCourse(normalizedCourseCode);
    const sources = normalizeRagSourcesForUi(sourcesResponse?.sources || []);
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
  const slides = [
    {
      eyebrow: "Estado",
      title: "Preparacion del entorno",
      lines: [
        "Creando o reutilizando la rama y PR de configuracion ADACEEN.",
        "Solicitando o reanudando el Codespace con la API de GitHub.",
        "Esta ventana se redirige sola cuando GitHub entregue una URL github.dev.",
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

  slides.push({
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

function openCodespaceWaitingWindow(repoFullName) {
  const pendingWindow = window.open("about:blank", "_blank");
  if (!pendingWindow) return null;

  try {
    const repo = escapeWaitingPageText(repoFullName || "repositorio");
    const versionLabel = escapeWaitingPageText(ADACEEN_BROWSER_EXTENSION_LABEL);
    const slides = buildCodespaceWaitingSlides(repoFullName);
    const slidesMarkup = renderCodespaceWaitingSlidesMarkup(slides);
    const dotsMarkup = renderCodespaceWaitingDotsMarkup(slides);
    const lakeBackgroundUrl = escapeWaitingPageCssUrl(getExtensionResourceUrl("assets/codespace-bg-lake.jpg"));
    const mountainBackgroundUrl = escapeWaitingPageCssUrl(getExtensionResourceUrl("assets/codespace-bg-mountains.jpg"));
    pendingWindow.document.open();
    pendingWindow.document.write(`<!doctype html>
<html>
<head>
  <meta charset="utf-8">
  <title>ADACEEN preparando Codespace</title>
  <style>
    :root { color-scheme: dark; }
    * { box-sizing: border-box; }
    body {
      margin: 0;
      min-height: 100vh;
      display: flex;
      align-items: center;
      justify-content: flex-start;
      padding: clamp(18px, 5vw, 64px);
      font-family: Segoe UI, Arial, sans-serif;
      background: #06131b;
      color: #f8fbff;
      overflow-x: hidden;
    }
    .wait-background {
      position: fixed;
      inset: 0;
      z-index: 0;
      overflow: hidden;
      background: #06131b;
      pointer-events: none;
    }
    .wait-background::after {
      content: "";
      position: absolute;
      inset: 0;
      background:
        linear-gradient(90deg, rgba(3, 11, 17, 0.9) 0%, rgba(5, 17, 24, 0.78) 43%, rgba(8, 31, 42, 0.48) 72%, rgba(4, 16, 24, 0.68) 100%),
        linear-gradient(180deg, rgba(3, 12, 18, 0.14) 0%, rgba(3, 12, 18, 0.75) 100%);
    }
    .wait-bg {
      position: absolute;
      inset: 0;
      background-position: center;
      background-size: cover;
      opacity: 0;
      transform: scale(1.025);
      animation-duration: 18s;
      animation-iteration-count: infinite;
      animation-timing-function: ease-in-out;
    }
    .wait-bg-lake {
      background-image: url("${lakeBackgroundUrl}");
      animation-name: waitBgLake;
    }
    .wait-bg-mountains {
      background-image: url("${mountainBackgroundUrl}");
      animation-name: waitBgMountains;
    }
    main {
      position: relative;
      z-index: 1;
      width: min(720px, 100%);
      border: 1px solid rgba(220, 246, 250, 0.26);
      border-radius: 8px;
      background: rgba(6, 19, 28, 0.72);
      padding: clamp(18px, 3vw, 28px);
      box-shadow: 0 24px 70px rgba(0, 0, 0, 0.42);
      backdrop-filter: blur(16px) saturate(125%);
    }
    .wait-version {
      display: inline-flex;
      align-items: center;
      width: fit-content;
      max-width: 100%;
      margin-bottom: 14px;
      padding: 5px 9px;
      border: 1px solid rgba(255, 223, 170, 0.48);
      border-radius: 7px;
      background: rgba(255, 198, 94, 0.16);
      color: #ffe7b7;
      font-size: 12px;
      font-weight: 800;
      overflow-wrap: anywhere;
      text-shadow: 0 1px 2px rgba(0, 0, 0, 0.42);
    }
    .row { display: grid; grid-template-columns: 36px 1fr; align-items: center; gap: 14px; }
    .spinner {
      width: 28px;
      height: 28px;
      border: 4px solid rgba(230, 252, 255, 0.28);
      border-top-color: #76efe5;
      border-radius: 999px;
      animation: spin 0.8s linear infinite;
      flex: 0 0 auto;
    }
    h1 {
      margin: 0 0 6px;
      color: #ffffff;
      font-size: 20px;
      line-height: 1.2;
      text-shadow: 0 2px 8px rgba(0, 0, 0, 0.45);
    }
    p {
      margin: 0;
      color: #d9eaf0;
      line-height: 1.45;
      text-shadow: 0 1px 4px rgba(0, 0, 0, 0.38);
    }
    .phase {
      display: inline-flex;
      align-items: center;
      width: fit-content;
      margin-top: 14px;
      padding: 5px 9px;
      border: 1px solid rgba(141, 244, 232, 0.42);
      border-radius: 999px;
      color: #c9fff8;
      background: rgba(12, 95, 91, 0.34);
      font-size: 12px;
      font-weight: 700;
      text-shadow: 0 1px 2px rgba(0, 0, 0, 0.45);
    }
    .repo {
      margin-top: 12px;
      padding: 10px;
      border-radius: 8px;
      border: 1px solid rgba(153, 231, 224, 0.24);
      background: rgba(214, 255, 250, 0.1);
      color: #c9fff8;
      font-weight: 700;
      overflow-wrap: anywhere;
      text-shadow: 0 1px 2px rgba(0, 0, 0, 0.44);
    }
    .content {
      margin-top: 18px;
      border: 1px solid rgba(224, 248, 250, 0.2);
      border-radius: 8px;
      overflow: hidden;
      background: rgba(5, 17, 24, 0.48);
    }
    .progress-track {
      height: 4px;
      background: rgba(232, 252, 255, 0.16);
    }
    .progress-bar {
      width: 0;
      height: 100%;
      background: #76efe5;
      transition: width 180ms ease;
    }
    .panel-wrap {
      min-height: 184px;
      padding: 18px 18px 14px;
    }
    .wait-panel { display: none; }
    .wait-panel.is-active { display: block; }
    .panel-eyebrow {
      margin-bottom: 6px;
      color: #ffd08a;
      font-size: 12px;
      font-weight: 800;
      letter-spacing: 0;
      text-transform: uppercase;
      text-shadow: 0 1px 2px rgba(0, 0, 0, 0.48);
    }
    h2 {
      margin: 0 0 10px;
      color: #ffffff;
      font-size: 18px;
      line-height: 1.25;
      text-shadow: 0 2px 8px rgba(0, 0, 0, 0.42);
    }
    ul {
      margin: 0;
      padding-left: 20px;
      color: #e3f1f5;
      line-height: 1.5;
      text-shadow: 0 1px 4px rgba(0, 0, 0, 0.38);
    }
    li::marker { color: #76efe5; }
    li + li { margin-top: 6px; }
    .dot-row {
      display: flex;
      gap: 8px;
      padding: 0 18px 16px;
    }
    .wait-dot {
      width: 28px;
      height: 8px;
      border: 0;
      border-radius: 999px;
      background: rgba(235, 252, 255, 0.26);
      cursor: pointer;
    }
    .wait-dot.is-active { background: #76efe5; }
    .manual-actions {
      display: flex;
      flex-wrap: wrap;
      gap: 10px;
      margin-top: 16px;
    }
    .manual-link {
      display: none;
      width: fit-content;
      max-width: 100%;
      padding: 10px 14px;
      border-radius: 8px;
      background: #dffffb;
      color: #07353b;
      font-weight: 700;
      text-decoration: none;
      box-shadow: 0 12px 28px rgba(0, 0, 0, 0.28);
    }
    .manual-link.secondary {
      border: 1px solid rgba(231, 249, 253, 0.24);
      background: rgba(8, 25, 35, 0.76);
      color: #eefbff;
    }
    @media (max-width: 860px) {
      body { justify-content: center; }
    }
    @media (max-width: 560px) {
      body { align-items: stretch; padding: 12px; }
      main { padding: 18px; }
      .row { grid-template-columns: 1fr; }
      .panel-wrap { min-height: 220px; }
    }
    @media (prefers-reduced-motion: reduce) {
      .wait-bg { animation: none; transform: none; }
      .wait-bg-lake { opacity: 1; }
      .wait-bg-mountains { opacity: 0; }
    }
    @keyframes waitBgLake {
      0%, 42% { opacity: 1; transform: scale(1.025); }
      50%, 92% { opacity: 0; transform: scale(1.05); }
      100% { opacity: 1; transform: scale(1.025); }
    }
    @keyframes waitBgMountains {
      0%, 42% { opacity: 0; transform: scale(1.05); }
      50%, 92% { opacity: 1; transform: scale(1.025); }
      100% { opacity: 0; transform: scale(1.05); }
    }
    @keyframes spin { to { transform: rotate(360deg); } }
  </style>
</head>
<body>
  <div class="wait-background" aria-hidden="true">
    <span class="wait-bg wait-bg-lake"></span>
    <span class="wait-bg wait-bg-mountains"></span>
  </div>
  <main>
    <div class="wait-version">${versionLabel}</div>
    <div class="row">
      <span class="spinner" aria-hidden="true"></span>
      <div>
        <h1 id="adaceenWaitTitle">ADACEEN esta preparando tu Codespace</h1>
        <p id="adaceenWaitDetail">Estamos creando o reutilizando la PR, iniciando Codespaces y esperando la URL lista.</p>
      </div>
    </div>
    <div class="phase" id="adaceenWaitPhase">Automatizacion activa</div>
    <div class="repo">${repo}</div>
    <div class="content">
      <div class="progress-track" aria-hidden="true"><div class="progress-bar" id="adaceenWaitProgress"></div></div>
      <div class="panel-wrap" id="adaceenWaitPanels">${slidesMarkup}</div>
      <div class="dot-row" id="adaceenWaitDots">${dotsMarkup}</div>
    </div>
    <div class="manual-actions">
      <a class="manual-link" id="adaceenOpenCodespaceLink" href="#" rel="noopener noreferrer">Abrir Codespace ahora</a>
      <a class="manual-link secondary" id="adaceenOpenQuickstartLink" href="#" rel="noopener noreferrer">Abrir selector de Codespaces</a>
    </div>
  </main>
</body>
</html>`);
    pendingWindow.document.close();
    hydrateCodespaceWaitingWindow(pendingWindow);
  } catch {
    // Si el navegador impide escribir en la ventana, igual conservamos el handle para redirigirla.
  }

  return pendingWindow;
}

function updateCodespaceWaitingSlides(pendingWindow, repoFullName) {
  if (!pendingWindow || pendingWindow.closed) return;

  try {
    const slides = buildCodespaceWaitingSlides(repoFullName);
    const slidesMarkup = renderCodespaceWaitingSlidesMarkup(slides);
    const dotsMarkup = renderCodespaceWaitingDotsMarkup(slides);
    const panelsMount = pendingWindow.document.getElementById("adaceenWaitPanels");
    const dotsMount = pendingWindow.document.getElementById("adaceenWaitDots");
    if (panelsMount) panelsMount.innerHTML = slidesMarkup;
    if (dotsMount) dotsMount.innerHTML = dotsMarkup;
    hydrateCodespaceWaitingWindow(pendingWindow);
  } catch {
    // La ventana puede haber navegado fuera de nuestro origen.
  }
}

function updateCodespaceWaitingWindow(pendingWindow, title, detail, directUrl = "", quickstartUrl = "") {
  if (!pendingWindow || pendingWindow.closed) return;

  try {
    const titleEl = pendingWindow.document.getElementById("adaceenWaitTitle");
    const detailEl = pendingWindow.document.getElementById("adaceenWaitDetail");
    const phaseEl = pendingWindow.document.getElementById("adaceenWaitPhase");
    const directLink = pendingWindow.document.getElementById("adaceenOpenCodespaceLink");
    const quickstartLink = pendingWindow.document.getElementById("adaceenOpenQuickstartLink");
    const nextTitle = toText(title) || "ADACEEN esta preparando tu Codespace";
    const nextDetail = toText(detail) || "GitHub sigue preparando el contenedor.";
    if (titleEl) titleEl.textContent = nextTitle;
    if (detailEl) detailEl.textContent = nextDetail;
    if (phaseEl) {
      if (/abriendo|redirig/i.test(nextTitle) || /redirig/i.test(nextDetail)) {
        phaseEl.textContent = "Redireccionando";
      } else if (/no confirmado|limite|bloque/i.test(nextTitle) || /detuvo|manual|limite|bloque/i.test(nextDetail)) {
        phaseEl.textContent = "Requiere revision";
      } else if (/buscando/i.test(nextTitle)) {
        phaseEl.textContent = "Buscando Codespace";
      } else if (/esperando|estado/i.test(nextTitle)) {
        phaseEl.textContent = "Esperando a GitHub";
      } else {
        phaseEl.textContent = "Automatizacion activa";
      }
    }
    if (directLink) {
      const href = toText(directUrl);
      directLink.style.display = href ? "inline-block" : "none";
      if (href) directLink.href = href;
    }
    if (quickstartLink) {
      const href = toText(quickstartUrl);
      quickstartLink.style.display = href ? "inline-block" : "none";
      if (href) quickstartLink.href = href;
    }
  } catch {
    // La ventana puede haber navegado fuera de nuestro origen; en ese caso no se puede actualizar.
  }
}

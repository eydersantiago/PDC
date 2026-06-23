
async function fetchJsonWithTimeout(url, options = {}, timeoutMs = BACKEND_TIMEOUT_MS) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const response = await fetch(url, {
      ...options,
      signal: controller.signal,
    });
    const json = await response.json().catch(() => ({}));
    if (!response.ok) {
      throw new Error(String(json.error || `HTTP ${response.status}`));
    }
    return json;
  } catch (error) {
    if (error && typeof error === "object" && error.name === "AbortError") {
      const seconds = Math.max(1, Math.round((Number(timeoutMs) || BACKEND_TIMEOUT_MS) / 1000));
      throw new Error(`Tiempo de espera agotado (${seconds}s).`);
    }
    throw error;
  } finally {
    clearTimeout(timeout);
  }
}

function buildApiHeaders() {
  return {
    "Content-Type": "application/json; charset=utf-8",
    ...(overlayState.sessionId ? { "x-session-id": overlayState.sessionId } : {}),
  };
}

function normalizeRagCourseCodeUi(value) {
  const clean = toText(value)
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toUpperCase()
    .replace(/[^A-Z0-9]+/g, "");
  if (!clean) return "FPOO";
  if (clean === "FPI" || clean.includes("IMPERATIVA")) return "FPI";
  if (clean === "FPOO" || clean === "POO" || clean.includes("OBJETOS")) return "FPOO";
  if (clean === "FPOE" || clean.includes("EVENTOS")) return "FPOE";
  if (clean === "FPFC" || clean.includes("FUNCIONAL") || clean.includes("CONCURRENTE")) return "FPFC";
  return clean;
}

function normalizeCourseCodesUi(values, fallbackToDefault = true) {
  const rawValues = Array.isArray(values)
    ? values
    : toText(values).split(",");
  const codes = rawValues
    .map((value) => toText(value))
    .filter(Boolean)
    .map((value) => normalizeRagCourseCodeUi(value))
    .filter(Boolean);
  const unique = [...new Set(codes)];
  if (unique.length) return unique;
  return fallbackToDefault ? ["FPOO"] : [];
}

function getRagCourseCatalog() {
  const catalog = Array.isArray(overlayState.ragCourseCatalog)
    ? overlayState.ragCourseCatalog
    : [];
  if (catalog.length) return catalog;
  const teacherCourses = Array.isArray(overlayState.teacherRagState?.courses)
    ? overlayState.teacherRagState.courses
    : [];
  if (teacherCourses.length) return teacherCourses;
  const studentCourses = Array.isArray(overlayState.studentCourseState?.courses)
    ? overlayState.studentCourseState.courses
    : [];
  if (studentCourses.length) return studentCourses;
  return [{ code: "FPOO", name: "Fundamentos de programación orientada a objetos", shortName: "FPOO", isDefault: true }];
}

function updateRagCourseCatalogFromResponse(response) {
  const courses = Array.isArray(response?.courses) ? response.courses : [];
  if (courses.length) {
    overlayState.ragCourseCatalog = courses;
  }
  overlayState.ragDefaultCourseCode = toText(response?.defaultCourseCode || overlayState.ragDefaultCourseCode || "FPOO") || "FPOO";
  return courses;
}

function getStudentAssignedCourseCodes() {
  return normalizeCourseCodesUi(overlayState.session?.user?.assignedCourseCodes, true);
}

function getSelectedStudentCourseCode() {
  const selected = normalizeRagCourseCodeUi(overlayState.studentCourseState?.selectedCourseCode || "FPOO");
  if (overlayState.session?.user?.role !== "student") return selected;
  const allowed = getStudentAssignedCourseCodes();
  return allowed.includes(selected) ? selected : allowed[0] || "FPOO";
}

function getSelectedStudentCourse() {
  const selected = getSelectedStudentCourseCode();
  return getRagCourseCatalog().find((course) => normalizeRagCourseCodeUi(course?.code) === selected)
    || { code: selected, name: selected, shortName: selected };
}

async function fetchRagCoursesForCurrentSession() {
  const baseUrl = normalizeBaseUrl(overlayState.backendUrl);
  if (!baseUrl || !overlayState.sessionId) return null;
  const response = await fetchJsonWithTimeout(`${baseUrl}/api/rag/courses`, {
    method: "GET",
    headers: buildApiHeaders(),
  }, 15000);
  updateRagCourseCatalogFromResponse(response);
  return response;
}

async function ensureStudentCourseSelection(options = {}) {
  if (overlayState.session?.user?.role !== "student") {
    overlayState.studentCourseModalOpen = false;
    return null;
  }

  overlayState.studentCourseState = {
    ...(overlayState.studentCourseState || EMPTY_STUDENT_COURSE_STATE),
    busy: true,
    error: "",
    message: "",
  };
  renderOverlay();

  try {
    const response = await fetchRagCoursesForCurrentSession();
    const assigned = normalizeCourseCodesUi(response?.assignedCourseCodes || overlayState.session?.user?.assignedCourseCodes, true);
    const courses = Array.isArray(response?.courses) && response.courses.length
      ? response.courses
      : getRagCourseCatalog().filter((course) => assigned.includes(normalizeRagCourseCodeUi(course?.code)));
    const selected = normalizeRagCourseCodeUi(overlayState.studentCourseState?.selectedCourseCode || assigned[0] || "FPOO");
    const nextSelected = assigned.length === 1
      ? assigned[0]
      : (assigned.includes(selected) ? selected : assigned[0] || "FPOO");
    overlayState.session.user.assignedCourseCodes = assigned;
    overlayState.session.user.activeCourseCode = nextSelected;
    overlayState.studentCourseState = {
      courses,
      selectedCourseCode: nextSelected,
      defaultCourseCode: toText(response?.defaultCourseCode || overlayState.ragDefaultCourseCode || "FPOO") || "FPOO",
      busy: false,
      error: "",
      message: assigned.length === 1 ? `Curso activo: ${nextSelected}.` : "",
    };
    overlayState.studentCourseModalOpen = options.forceOpen === true && assigned.length > 1;
    await persistPreferences();
    return overlayState.studentCourseState;
  } catch (error) {
    overlayState.studentCourseState = {
      ...(overlayState.studentCourseState || EMPTY_STUDENT_COURSE_STATE),
      courses: getRagCourseCatalog().filter((course) => getStudentAssignedCourseCodes().includes(normalizeRagCourseCodeUi(course?.code))),
      busy: false,
      error: `No se pudieron cargar cursos: ${String(error?.message || error)}`,
    };
    overlayState.studentCourseModalOpen = options.forceOpen === true;
    return null;
  } finally {
    renderOverlay();
  }
}

async function confirmStudentCourseSelection() {
  if (overlayState.session?.user?.role !== "student") return;
  const selected = getSelectedStudentCourseCode();
  const previous = normalizeRagCourseCodeUi(overlayState.studentCourseState?.selectedCourseCode || "");
  overlayState.studentCourseState = {
    ...(overlayState.studentCourseState || EMPTY_STUDENT_COURSE_STATE),
    selectedCourseCode: selected,
    busy: false,
    error: "",
    message: "Curso activo actualizado.",
  };
  overlayState.session.user.activeCourseCode = selected;
  if (previous && previous !== selected) {
    overlayState.campusCourseAccess = { ...EMPTY_CAMPUS_COURSE_ACCESS_STATE };
    overlayState.campusAnalysis = null;
  }
  overlayState.studentCourseModalOpen = false;
  await persistPreferences();
  if (overlayState.started) {
    await refreshMentorSession();
  } else {
    renderOverlay();
  }
}

function renderCourseCheckboxGroup(container, selectedCodes, options = {}) {
  if (!container) return;
  const selected = new Set(normalizeCourseCodesUi(selectedCodes, options.fallbackToDefault !== false));
  const courses = getRagCourseCatalog();
  container.textContent = "";
  for (const course of courses) {
    const code = normalizeRagCourseCodeUi(course?.code);
    const label = document.createElement("label");
    label.className = "course-chip";
    const input = document.createElement("input");
    input.type = "checkbox";
    input.value = code;
    input.checked = selected.has(code);
    input.disabled = options.disabled === true;
    const span = document.createElement("span");
    span.textContent = toText(course?.shortName || course?.code || code);
    label.append(input, span);
    container.appendChild(label);
  }
}

function getCheckedCourseCodes(container) {
  const checked = [...(container?.querySelectorAll?.("input[type='checkbox']:checked") || [])]
    .map((input) => normalizeRagCourseCodeUi(input.value))
    .filter(Boolean);
  return normalizeCourseCodesUi(checked, true);
}

function renderAdminCreateCourseGrid() {
  if (!overlayEls?.adminCreateCourseGrid) return;
  const isStudent = toText(overlayEls.adminCreateRole?.value).toLowerCase() !== "teacher";
  renderCourseCheckboxGroup(overlayEls.adminCreateCourseGrid, ["FPOO"], {
    disabled: overlayState.adminUsersBusy || !isStudent,
  });
}

async function reloadPolicyAndTelemetry() {
  if (!overlayState.sessionId) return;
  const baseUrl = normalizeBaseUrl(overlayState.backendUrl);
  if (!baseUrl) return;

  const response = await fetchJsonWithTimeout(`${baseUrl}/api/policies/current`, {
    method: "GET",
    headers: buildApiHeaders(),
  });

  if (response?.ok) {
    overlayState.policy = response.policy || { ...DEFAULT_POLICY };
    overlayState.telemetry = Array.isArray(response.telemetry) ? response.telemetry : [];
  }
}

async function reloadAdminUsers() {
  const baseUrl = normalizeBaseUrl(overlayState.backendUrl);
  if (!baseUrl || !overlayState.sessionId || !canManageUsersSession()) {
    overlayState.adminUsers = [];
    overlayState.adminTeachers = [];
    return;
  }

  const [response, coursesResponse] = await Promise.all([
    fetchJsonWithTimeout(`${baseUrl}/api/admin/users`, {
      method: "GET",
      headers: buildApiHeaders(),
    }),
    fetchRagCoursesForCurrentSession().catch(() => null),
  ]);
  updateRagCourseCatalogFromResponse(coursesResponse);

  overlayState.adminUsers = Array.isArray(response?.users) ? response.users : [];
  overlayState.adminTeachers = Array.isArray(response?.teachers) ? response.teachers : [];
}

async function createAdminUserFromForm() {
  if (!overlayEls || !canManageUsersSession()) return;

  const role = isTeacherSession()
    ? "student"
    : toText(overlayEls.adminCreateRole.value).toLowerCase() === "teacher" ? "teacher" : "student";
  const payload = {
    role,
    displayName: overlayEls.adminCreateName.value.trim(),
    email: overlayEls.adminCreateEmail.value.trim(),
    password: overlayEls.adminCreatePassword.value,
    teacherUserId: role === "student"
      ? (isTeacherSession() ? toText(overlayState.session?.user?.id) : toText(overlayEls.adminCreateTeacher.value) || null)
      : null,
    assignedCourseCodes: role === "student"
      ? getCheckedCourseCodes(overlayEls.adminCreateCourseGrid)
      : [],
  };

  const baseUrl = normalizeBaseUrl(overlayState.backendUrl);
  if (!baseUrl || !overlayState.sessionId) {
    throw new Error("Sesion no valida para crear usuarios.");
  }

  await fetchJsonWithTimeout(`${baseUrl}/api/admin/users`, {
    method: "POST",
    headers: buildApiHeaders(),
    body: JSON.stringify(payload),
  });

  overlayEls.adminCreatePassword.value = "";
}

async function updateAdminUserRow(rowUserId, data) {
  const baseUrl = normalizeBaseUrl(overlayState.backendUrl);
  if (!baseUrl || !overlayState.sessionId) {
    throw new Error("Sesion no valida para editar usuarios.");
  }

  return fetchJsonWithTimeout(`${baseUrl}/api/admin/users/${encodeURIComponent(rowUserId)}`, {
    method: "PUT",
    headers: buildApiHeaders(),
    body: JSON.stringify(data),
  });
}

async function deleteAdminUser(rowUserId) {
  const baseUrl = normalizeBaseUrl(overlayState.backendUrl);
  if (!baseUrl || !overlayState.sessionId) {
    throw new Error("Sesion no valida para eliminar usuarios.");
  }

  return fetchJsonWithTimeout(`${baseUrl}/api/admin/users/${encodeURIComponent(rowUserId)}`, {
    method: "DELETE",
    headers: buildApiHeaders(),
  });
}

async function fetchProjectConsentStatus() {
  const baseUrl = normalizeBaseUrl(overlayState.backendUrl);
  if (!baseUrl || !overlayState.sessionId) return false;

  const response = await fetchJsonWithTimeout(`${baseUrl}/api/projects/consent`, {
    method: "GET",
    headers: buildApiHeaders(),
  });

  return !!response?.consent?.granted;
}

async function grantProjectConsent() {
  const baseUrl = normalizeBaseUrl(overlayState.backendUrl);
  if (!baseUrl || !overlayState.sessionId) {
    throw new Error("Sesion no valida para registrar permisos.");
  }

  const response = await fetchJsonWithTimeout(`${baseUrl}/api/projects/consent`, {
    method: "POST",
    headers: buildApiHeaders(),
    body: JSON.stringify({
      canRead: true,
      canModify: true,
      canAnalyze: true,
    }),
  });

  return !!response?.consent?.granted;
}

async function ensureProjectConsentForCurrentUser() {
  const userId = getCurrentUserId();
  if (!userId) return false;
  if (overlayState.projectConsentByUser[userId] === true) return true;

  try {
    const grantedRemotely = await fetchProjectConsentStatus();
    if (grantedRemotely) {
      overlayState.projectConsentByUser[userId] = true;
      await persistPreferences();
      return true;
    }
  } catch {}

  const accepted = window.confirm(
    "Dar permiso para leer, modificar y hacer analisis sobre tu entorno?\n\n" +
    "Esto se solicitara solo una vez por usuario para guardar contexto del proyecto.",
  );
  if (!accepted) {
    return false;
  }

  const granted = await grantProjectConsent();
  if (!granted) {
    return false;
  }

  overlayState.projectConsentByUser[userId] = true;
  await persistPreferences();
  return true;
}

async function syncProjectRackToBackend(context, analysis) {
  const baseUrl = normalizeBaseUrl(overlayState.backendUrl);
  if (!baseUrl || !overlayState.sessionId || !analysis) return false;

  const payload = {
    source: toText(context.pageType) || "codespace",
    repoFullName: toText(context.repoFullName),
    branch: toText(context.branch),
    generatedAt: toText(analysis.generatedAt),
    totalEntries: Number(analysis.totalEntries) || 0,
    totalFiles: Number(analysis.totalFiles) || 0,
    totalFolders: Number(analysis.totalFolders) || 0,
    files: Array.isArray(analysis.files) ? analysis.files.slice(0, 10000) : [],
    folders: Array.isArray(analysis.folders) ? analysis.folders.slice(0, 10000) : [],
    activeFilePath: toText(context.filePath),
    activeCodeSnippet: toText(context.codeSnippet).slice(0, 120000),
  };

  const response = await fetchJsonWithTimeout(`${baseUrl}/api/projects/rack`, {
    method: "POST",
    headers: buildApiHeaders(),
    body: JSON.stringify(payload),
  }, 25000);

  return !!response?.ok;
}

async function requestProjectScanFromBackend(repoFullName) {
  const baseUrl = normalizeBaseUrl(overlayState.backendUrl);
  if (!baseUrl || !overlayState.sessionId) return null;
  const cleanRepo = parseRepoFullName(repoFullName);
  if (!cleanRepo) return null;

  return fetchJsonWithTimeout(`${baseUrl}/api/projects/scan/request`, {
    method: "POST",
    headers: buildApiHeaders(),
    body: JSON.stringify({
      repoFullName: cleanRepo,
      source: "dashboard_explore",
    }),
  }, 20000);
}

async function getProjectScanRequestStatus(requestId) {
  const baseUrl = normalizeBaseUrl(overlayState.backendUrl);
  if (!baseUrl || !overlayState.sessionId || !requestId) return null;
  return fetchJsonWithTimeout(`${baseUrl}/api/projects/scan/request/${encodeURIComponent(requestId)}`, {
    method: "GET",
    headers: buildApiHeaders(),
  }, 15000);
}

async function waitForProjectScanCompletion(requestId, timeoutMs = 120000, pollMs = 2500) {
  const startedAt = Date.now();
  while (Date.now() - startedAt <= timeoutMs) {
    const response = await getProjectScanRequestStatus(requestId);
    const status = toText(response?.request?.status).toLowerCase();
    if (status === "completed" || status === "failed") {
      return response;
    }
    await new Promise((resolve) => setTimeout(resolve, pollMs));
  }
  return null;
}

async function refreshProjectContextStatus() {
  const baseUrl = normalizeBaseUrl(overlayState.backendUrl);
  const repoFullName = getCurrentRepoFullName();
  if (!baseUrl || !overlayState.sessionId || !repoFullName) {
    overlayState.projectContextStatus = { ...EMPTY_PROJECT_CONTEXT_STATUS };
    return;
  }

  const response = await fetchJsonWithTimeout(
    `${baseUrl}/api/projects/context/status?repoFullName=${encodeURIComponent(repoFullName)}`,
    {
      method: "GET",
      headers: buildApiHeaders(),
    },
    15000,
  );

  overlayState.projectContextStatus = {
    ...EMPTY_PROJECT_CONTEXT_STATUS,
    ...normalizeProjectContextStatusPayload(response),
    repoFullName,
  };
}

async function refreshProjectContextHistory() {
  const baseUrl = normalizeBaseUrl(overlayState.backendUrl);
  const repoFullName = getCurrentRepoFullName();
  if (!baseUrl || !overlayState.sessionId || !repoFullName) {
    overlayState.projectContextHistory = [];
    return;
  }

  const response = await fetchJsonWithTimeout(
    `${baseUrl}/api/projects/context/history?repoFullName=${encodeURIComponent(repoFullName)}`,
    {
      method: "GET",
      headers: buildApiHeaders(),
    },
    15000,
  );

  overlayState.projectContextHistory = normalizeProjectContextHistoryPayload(response);
}

async function refreshProjectContextInsight() {
  const baseUrl = normalizeBaseUrl(overlayState.backendUrl);
  const repoFullName = getCurrentRepoFullName();
  if (!baseUrl || !overlayState.sessionId || !repoFullName) {
    overlayState.projectContextInsight = { ...EMPTY_PROJECT_CONTEXT_INSIGHT };
    return;
  }

  const useModel = overlayState.autoConfigEnabled ? "1" : "0";
  const response = await fetchJsonWithTimeout(
    `${baseUrl}/api/projects/context/insight?repoFullName=${encodeURIComponent(repoFullName)}&useModel=${useModel}`,
    {
      method: "GET",
      headers: buildApiHeaders(),
    },
    45000,
  );

  overlayState.projectContextInsight = normalizeProjectContextInsightPayload(response);
}

async function refreshDocumentClassifications() {
  const baseUrl = normalizeBaseUrl(overlayState.backendUrl);
  const repoFullName = getCurrentRepoFullName();
  if (!baseUrl || !overlayState.sessionId || !repoFullName) {
    overlayState.documentClassifications = { ...EMPTY_DOCUMENT_CLASSIFICATION_STATE };
    return;
  }

  overlayState.documentClassifications = {
    ...normalizeDocumentClassificationState(overlayState.documentClassifications),
    busy: true,
    error: "",
  };

  try {
    const response = await fetchJsonWithTimeout(
      `${baseUrl}/api/documents/classifications?repoFullName=${encodeURIComponent(repoFullName)}&limit=40`,
      {
        method: "GET",
        headers: buildApiHeaders(),
      },
      20000,
    );

    const items = normalizeDocumentClassificationsPayload(response);
    overlayState.documentClassifications = {
      items,
      busy: false,
      message: items.length > 0
        ? `${items.length} documento(s) clasificado(s).`
        : "Aun no hay documentos clasificados para este proyecto.",
      error: "",
    };
  } catch (error) {
    overlayState.documentClassifications = {
      ...normalizeDocumentClassificationState(overlayState.documentClassifications),
      busy: false,
      error: `No se pudieron cargar clasificaciones: ${String(error)}`,
    };
  }
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, Math.max(0, Number(ms) || 0)));
}

async function waitForPaintFrames(frames = 1) {
  const total = Math.max(1, Math.floor(Number(frames) || 1));
  for (let index = 0; index < total; index++) {
    await new Promise((resolve) => window.requestAnimationFrame(() => resolve()));
  }
}

async function waitForScreenshotCaptureSettle() {
  await waitForPaintFrames(SCREENSHOT_CAPTURE_PAINT_FRAMES);
  await sleep(SCREENSHOT_CAPTURE_SETTLE_MS);
}

function hideOverlayForScreenshotCapture() {
  if (!overlayHost?.isConnected) {
    return () => {};
  }

  const host = overlayHost;
  const previous = {
    visibility: host.style.visibility,
    opacity: host.style.opacity,
    pointerEvents: host.style.pointerEvents,
    transition: host.style.transition,
    captureHidden: host.getAttribute("data-adaceen-capture-hidden"),
  };

  host.setAttribute("data-adaceen-capture-hidden", "true");
  host.style.transition = "none";
  host.style.visibility = "hidden";
  host.style.opacity = "0";
  host.style.pointerEvents = "none";

  return () => {
    if (!host.isConnected) return;
    host.style.visibility = previous.visibility;
    host.style.opacity = previous.opacity;
    host.style.pointerEvents = previous.pointerEvents;
    host.style.transition = previous.transition;
    if (previous.captureHidden == null) {
      host.removeAttribute("data-adaceen-capture-hidden");
    } else {
      host.setAttribute("data-adaceen-capture-hidden", previous.captureHidden);
    }
  };
}

function buildScreenshotViewportContext() {
  const viewport = getViewportMetrics();
  return {
    width: Math.round(Number(viewport.width) || window.innerWidth || 0),
    height: Math.round(Number(viewport.height) || window.innerHeight || 0),
    offsetLeft: Math.round(Number(viewport.offsetLeft) || 0),
    offsetTop: Math.round(Number(viewport.offsetTop) || 0),
    scrollX: Math.round(Number(window.scrollX) || 0),
    scrollY: Math.round(Number(window.scrollY) || 0),
    devicePixelRatio: Number(window.devicePixelRatio || 1),
  };
}

function buildScreenshotCaptureContext(context) {
  const source = context || buildPayload();
  let explorerEntries = [];
  try {
    explorerEntries = typeof extractCodespaceExplorerEntries === "function"
      ? extractCodespaceExplorerEntries(500)
      : [];
  } catch {
    explorerEntries = [];
  }

  return {
    capturedAt: new Date().toISOString(),
    overlayHidden: true,
    viewport: buildScreenshotViewportContext(),
    url: toText(source.url),
    title: toText(source.title),
    pageContext: toText(source.pageContext),
    pageType: toText(source.pageType),
    repoFullName: toText(source.repoFullName),
    branch: toText(source.branch),
    filePath: toText(source.filePath),
    languageHint: toText(source.languageHint),
    codespaceBreadcrumbs: Array.isArray(source.codespaceBreadcrumbs) ? source.codespaceBreadcrumbs.slice(0, 12) : [],
    codespaceActiveTabs: Array.isArray(source.codespaceActiveTabs) ? source.codespaceActiveTabs.slice(0, 8) : [],
    visibleError: toText(source.visibleError).slice(0, 800),
    selection: toText(source.selection).slice(0, 2400),
    visibleText: toText(source.text).slice(0, 6000),
    codeSnippet: toText(source.codeSnippet).slice(0, 12000),
    codeLineCount: Math.max(0, Number(source.codeLineCount) || 0),
    explorerEntries: explorerEntries
      .map((entry) => ({
        type: toText(entry?.type),
        name: toText(entry?.name),
        path: toText(entry?.path),
        level: Math.max(0, Number(entry?.level) || 0),
      }))
      .filter((entry) => entry.path)
      .slice(0, 500),
  };
}

async function captureVisibleTabDataUrl(options = {}) {
  const hideOverlay = options?.hideOverlay !== false;
  const restoreOverlay = hideOverlay ? hideOverlayForScreenshotCapture() : () => {};
  if (hideOverlay) {
    await waitForScreenshotCaptureSettle();
  }

  try {
    return await new Promise((resolve, reject) => {
      chrome.runtime.sendMessage({ type: "ADACEEN_CAPTURE_VISIBLE_TAB" }, (response) => {
        const runtimeError = chrome.runtime.lastError;
        if (runtimeError) {
          reject(new Error(runtimeError.message || "No se pudo capturar la pantalla visible."));
          return;
        }

        const dataUrl = toText(response?.dataUrl);
        if (!response?.ok || !dataUrl) {
          reject(new Error(toText(response?.error) || "No se recibió imagen de captura."));
          return;
        }

        resolve(dataUrl);
      });
    });
  } finally {
    restoreOverlay();
  }
}

async function refreshProjectContextInsightFromScreenshot(options = {}) {
  const baseUrl = normalizeBaseUrl(overlayState.backendUrl);
  const repoFullName = getCurrentRepoFullName();
  const silent = options?.silent !== false;
  if (!overlayState.autoConfigEnabled || !baseUrl || !overlayState.sessionId || !repoFullName) {
    return;
  }

  const context = buildPayload();
  overlayState.context = context;
  if (context.pageType !== "codespace") {
    return;
  }

  try {
    const captureContext = buildScreenshotCaptureContext(context);
    const imageDataUrl = await captureVisibleTabDataUrl({ hideOverlay: true });
    const response = await fetchJsonWithTimeout(
      `${baseUrl}/api/projects/context/screenshot-insight`,
      {
        method: "POST",
        headers: buildApiHeaders(),
        body: JSON.stringify({
          repoFullName,
          imageDataUrl,
          captureContext,
          useModel: true,
        }),
      },
      OCR_BACKEND_TIMEOUT_MS,
    );
    overlayState.projectContextInsight = normalizeProjectContextInsightPayload(response);

    if (!silent && overlayState.projectContextInsight.screenshotUsed) {
      const mainFile = toText(overlayState.projectContextInsight.mainFilePath) || "sin detectar";
      const savedPath = toText(overlayState.projectContextInsight.screenshotSavedPath);
      overlayState.statusMessage = savedPath
        ? `OCR aplicado en screenshot. Archivo principal: ${mainFile}. Captura: ${savedPath}`
        : `OCR aplicado en screenshot. Archivo principal: ${mainFile}.`;
    }
    return true;
  } catch (error) {
    if (!silent) {
      const message = String(error);
      if (/Tiempo de espera agotado/i.test(message)) {
        overlayState.statusMessage =
          "No se pudo aplicar OCR sobre screenshot: el modelo tardó demasiado en responder. Reintenta en unos segundos.";
      } else {
        overlayState.statusMessage = `No se pudo aplicar OCR sobre screenshot: ${message}`;
      }
    }
    return false;
  }
}

async function rerunScreenshotOcrFromDashboard() {
  const context = overlayState.context || buildPayload();
  const repoFullName = getCurrentRepoFullName();

  if (!overlayState.autoConfigEnabled) {
    overlayState.statusMessage = "Activa configuracion automatica para usar OCR.";
    renderOverlay();
    return;
  }
  if (!repoFullName) {
    overlayState.statusMessage = "No se detecta repositorio activo para OCR.";
    renderOverlay();
    return;
  }
  if (context.pageType !== "codespace") {
    overlayState.statusMessage = "Reintentar OCR solo esta disponible en Codespaces.";
    renderOverlay();
    return;
  }

  overlayState.projectContextBusy = true;
  overlayState.projectContextError = "";
  overlayState.projectContextMessage = "Capturando screenshot visible para OCR...";
  overlayState.statusMessage = "Capturando screenshot y aplicando OCR...";
  renderOverlay();

  try {
    const ok = await refreshProjectContextInsightFromScreenshot({ silent: false });
    overlayState.projectContextMessage = ok
      ? "OCR manual actualizado."
      : "OCR manual completado con errores.";
  } finally {
    overlayState.projectContextBusy = false;
    renderOverlay();
  }
}

async function refreshProjectContextPanel() {
  const repoFullName = getCurrentRepoFullName();
  if (!repoFullName) {
    overlayState.projectContextStatus = { ...EMPTY_PROJECT_CONTEXT_STATUS };
    overlayState.projectContextHistory = [];
    overlayState.projectContextInsight = { ...EMPTY_PROJECT_CONTEXT_INSIGHT };
    overlayState.documentClassifications = { ...EMPTY_DOCUMENT_CLASSIFICATION_STATE };
    overlayState.projectContextError = "";
    overlayState.projectContextMessage = "";
    renderOverlay();
    return;
  }

  overlayState.projectContextBusy = true;
  overlayState.projectContextError = "";
  overlayState.projectContextMessage = "Actualizando contexto y rebuilds...";
  renderOverlay();

  try {
    const jobs = [
      refreshProjectContextStatus(),
      refreshProjectContextHistory(),
      refreshDocumentClassifications(),
    ];
    if (overlayState.autoConfigEnabled) {
      jobs.push(refreshProjectContextInsight());
    } else {
      overlayState.projectContextInsight = {
        ...EMPTY_PROJECT_CONTEXT_INSIGHT,
        configured: true,
        repoFullName,
        modelEnabled: false,
        summary: "Configuracion automatica desactivada.",
      };
    }
    await Promise.all(jobs);
    const status = overlayState.projectContextStatus || EMPTY_PROJECT_CONTEXT_STATUS;
    const insight = overlayState.projectContextInsight || EMPTY_PROJECT_CONTEXT_INSIGHT;
    const versionText = insight.version || status.latestVersion || status.currentVersion || "sin version";
    overlayState.projectContextMessage = status.hasContext
      ? `Contexto actualizado para ${repoFullName} (${versionText}).`
      : `Contexto consultado para ${repoFullName}, pero aun no hay versiones guardadas.`;
  } catch (error) {
    overlayState.projectContextError = `No se pudo actualizar el contexto: ${String(error)}`;
  } finally {
    overlayState.projectContextBusy = false;
    renderOverlay();
  }
}

async function applyProjectContextRebuild(requestId = "") {
  const repoFullName = getCurrentRepoFullName();
  const baseUrl = normalizeBaseUrl(overlayState.backendUrl);
  if (!baseUrl || !overlayState.sessionId || !repoFullName) {
    overlayState.projectContextError = "Abre un repositorio y inicia sesion para aplicar rebuild.";
    renderOverlay();
    return;
  }

  overlayState.projectContextBusy = true;
  overlayState.projectContextError = "";
  overlayState.projectContextMessage = requestId
    ? `Aplicando rebuild para ${shortenCompactId(requestId, 12)}...`
    : "Aplicando rebuild para el contexto actual...";
  renderOverlay();

  try {
    await fetchJsonWithTimeout(
      `${baseUrl}/api/projects/context/rebuild`,
      {
        method: "POST",
        headers: buildApiHeaders(),
        body: JSON.stringify({
          repoFullName,
          ...(requestId ? { requestId } : {}),
        }),
      },
      25000,
    );

    await refreshProjectContextPanel();
    overlayState.projectContextMessage = requestId
      ? `Rebuild aplicado para ${shortenCompactId(requestId, 12)}.`
      : `Rebuild aplicado para ${repoFullName}.`;
  } catch (error) {
    overlayState.projectContextError = `No se pudo aplicar rebuild: ${String(error)}`;
  } finally {
    overlayState.projectContextBusy = false;
    renderOverlay();
  }
}

function normalizeBackendResult(raw, fallbackGuide) {
  const result = raw?.result || {};
  const ideas = unique(Array.isArray(result.ideas) ? result.ideas : []).slice(0, MAX_LIST_ITEMS);
  const guide = unique(Array.isArray(result.guide) ? result.guide : []).slice(0, MAX_LIST_ITEMS);

  return {
    ideas,
    guide: guide.length > 0 ? guide : fallbackGuide,
    welcome: toText(result.welcome_message),
    summary: toText(result.analysis_summary),
  };
}

function buildBackendQuestion(context, language, goal) {
  const settings = overlayState.policy || DEFAULT_POLICY;
  const rule = settings.strictNoSolution
    ? "No entregues la solucion completa."
    : "Prioriza pistas y pasos sobre respuestas completas.";
  const tone = `Tono docente: ${settings.tone}.`;
  const help = `Nivel de ayuda: ${settings.helpLevel}.`;
  const outcome = `Resultado esperado: ${settings.outcome}.`;

  if (context.pageContext === "campus") {
    return `Estoy en Campus Virtual. Quiero reforzar ${goal.label.toLowerCase()}. ${rule} ${tone} ${help} ${outcome} Enfocate en el enunciado, la actividad visible y el error en pantalla.`;
  }
  if (context.pageType === "codespace") {
    return `Estoy programando en Codespaces en ${language}. Quiero reforzar ${goal.label.toLowerCase()}. ${rule} ${tone} ${help} ${outcome} Enfocate en el archivo abierto y el siguiente paso.`;
  }
  if (context.pageType === "github_code") {
    return `Estoy en GitHub con el archivo ${context.filePath || "actual"} en ${language}. Quiero reforzar ${goal.label.toLowerCase()}. ${rule} ${tone} ${help} ${outcome} Enfocate en el codigo abierto.`;
  }
  return `Quiero reforzar ${goal.label.toLowerCase()}. ${rule} ${tone} ${help} ${outcome} Da una orientacion breve y accionable.`;
}

async function requestBackendMentor(context, language) {
  const baseUrl = normalizeBaseUrl(overlayState.backendUrl);
  if (!baseUrl) {
    throw new Error("Base URL vacia.");
  }

  const goal = getLearningGoal(overlayState.selectedLearningGoal);
  const useStudentSelectedCourse = overlayState.session?.user?.role === "student";
  const selectedCourseCode = useStudentSelectedCourse ? getSelectedStudentCourseCode() : "";
  const selectedCourse = useStudentSelectedCourse ? getSelectedStudentCourse() : null;
  const courseQuestionSuffix = selectedCourseCode
    ? ` Curso RAG activo: ${selectedCourseCode} ${toText(selectedCourse?.name)}.`
    : "";
  const payload = {
    question: `${buildBackendQuestion(context, language, goal)}${courseQuestionSuffix}`,
    max_items: MAX_LIST_ITEMS,
    context: {
      url: toText(context.url),
      title: toText(context.title),
      pageContext: toText(context.pageContext),
      pageType: toText(context.pageType),
      repoOwner: toText(context.repoOwner),
      repoName: toText(context.repoName),
      repoFullName: toText(context.repoFullName),
      branch: toText(context.branch),
      filePath: toText(context.filePath),
      languageHint: toText(context.languageHint),
      activityTitle: toText(context.activityTitle),
      activityDeadline: toText(context.activityDeadline),
      learningGoal: goal.id,
      courseCode: selectedCourseCode,
      ragCourseCode: selectedCourseCode,
      selection: toText(context.selection),
      visibleError: toText(context.visibleError),
      codeSnippet: toText(context.codeSnippet),
      codeLineCount: Number(context.codeLineCount) || 0,
    },
  };

  const endpoints = ["/intervene", "/github-mentor"];
  let lastError = null;

  for (const endpoint of endpoints) {
    try {
      const raw = await fetchJsonWithTimeout(`${baseUrl}${endpoint}`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json; charset=utf-8",
          ...(overlayState.sessionId ? { "x-session-id": overlayState.sessionId } : {}),
        },
        body: JSON.stringify(payload),
      });

      if (!raw?.ok) {
        throw new Error(String(raw?.error || "Respuesta invalida."));
      }

      return normalizeBackendResult(raw, buildGuide(goal.id, context));
    } catch (error) {
      lastError = error;
    }
  }

  throw lastError || new Error("Backend no disponible.");
}

const ADACEEN_BACKEND_REQUEST_LOG_KEY = "adaceenBackendRequestLog";
const ADACEEN_BACKEND_REQUEST_LOG_LIMIT = 80;

function getRequestLogChromeStorage() {
  try {
    return typeof chrome !== "undefined" && chrome.storage?.local ? chrome.storage.local : null;
  } catch {
    return null;
  }
}

function summarizeRequestUrl(url) {
  try {
    const parsed = new URL(String(url));
    return {
      origin: parsed.origin,
      path: `${parsed.pathname}${parsed.search ? "?..." : ""}`,
    };
  } catch {
    return {
      origin: "",
      path: String(url || "").slice(0, 240),
    };
  }
}

function summarizeRequestBody(body) {
  if (typeof body === "string") {
    let jsonValid = false;
    try {
      JSON.parse(body);
      jsonValid = true;
    } catch {}
    return {
      bodyType: "string",
      bodyChars: body.length,
      jsonValid,
    };
  }
  if (body == null) {
    return {
      bodyType: "empty",
      bodyChars: 0,
      jsonValid: false,
    };
  }
  return {
    bodyType: Object.prototype.toString.call(body).slice(8, -1).toLowerCase() || typeof body,
    bodyChars: 0,
    jsonValid: false,
  };
}

async function appendBackendRequestLog(entry) {
  const storage = getRequestLogChromeStorage();
  const safeEntry = {
    id: entry.id,
    at: entry.at || new Date().toISOString(),
    method: entry.method || "GET",
    origin: entry.origin || "",
    path: entry.path || "",
    contentType: entry.contentType || "",
    bodyType: entry.bodyType || "empty",
    bodyChars: Number(entry.bodyChars) || 0,
    jsonValid: entry.jsonValid === true,
    status: Number(entry.status) || 0,
    ok: entry.ok === true,
    durationMs: Number(entry.durationMs) || 0,
    error: entry.error ? String(entry.error).slice(0, 240) : "",
  };
  console.debug?.("[ADACEEN] backend request", safeEntry);
  if (!storage) return;

  try {
    const current = await storage.get([ADACEEN_BACKEND_REQUEST_LOG_KEY]);
    const previous = Array.isArray(current?.[ADACEEN_BACKEND_REQUEST_LOG_KEY])
      ? current[ADACEEN_BACKEND_REQUEST_LOG_KEY]
      : [];
    await storage.set({
      [ADACEEN_BACKEND_REQUEST_LOG_KEY]: [safeEntry, ...previous].slice(0, ADACEEN_BACKEND_REQUEST_LOG_LIMIT),
    });
  } catch (error) {
    console.debug?.("[ADACEEN] no se pudo guardar request log", error);
  }
}

async function fetchJsonWithTimeout(url, options = {}, timeoutMs = BACKEND_TIMEOUT_MS) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  const startedAt = Date.now();
  const requestId = `${startedAt.toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
  const urlSummary = summarizeRequestUrl(url);
  const bodySummary = summarizeRequestBody(options.body);
  const requestMethod = String(options.method || "GET").toUpperCase();
  const contentType = typeof options.headers?.get === "function"
    ? options.headers.get("content-type")
    : (options.headers?.["Content-Type"] || options.headers?.["content-type"] || "");
  const requestOptions = {
    ...options,
    credentials: options.credentials || "omit",
    signal: controller.signal,
  };
  let responseLogged = false;

  try {
    const response = await fetch(url, requestOptions);
    const json = await response.json().catch(() => ({}));
    await appendBackendRequestLog({
      id: requestId,
      method: requestMethod,
      ...urlSummary,
      contentType,
      ...bodySummary,
      status: response.status,
      ok: response.ok,
      durationMs: Date.now() - startedAt,
    });
    responseLogged = true;
    if (!response.ok) {
      throw new Error(String(json.error || `HTTP ${response.status}`));
    }
    return json;
  } catch (error) {
    if (!responseLogged) {
      await appendBackendRequestLog({
        id: requestId,
        method: requestMethod,
        ...urlSummary,
        contentType,
        ...bodySummary,
        ok: false,
        durationMs: Date.now() - startedAt,
        error: error?.message || String(error),
      });
    }
    if (error && typeof error === "object" && error.name === "AbortError") {
      const seconds = Math.max(1, Math.round((Number(timeoutMs) || BACKEND_TIMEOUT_MS) / 1000));
      throw new Error(`Tiempo de espera agotado (${seconds}s).`);
    }
    if (error && typeof error === "object" && error.name === "TypeError") {
      throw new Error("No se pudo conectar con el backend. Verifica la URL del backend o recarga la extension.");
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

const FALLBACK_RAG_COURSES = [
  { code: "FPI", name: "Fundamentos de programación Imperativa", shortName: "Imperativa", isDefault: false },
  { code: "FPOO", name: "Fundamentos de programación orientada a objetos", shortName: "FPOO", isDefault: true },
  { code: "FPOE", name: "Fundamentos de programación orientada a eventos", shortName: "Eventos", isDefault: false },
  { code: "FPFC", name: "Fundamentos de programación funcional y concurrente", shortName: "Funcional y concurrente", isDefault: false },
];

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
  return FALLBACK_RAG_COURSES;
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
    overlayState.activeRagCourseCode = "";
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

  const [response, behaviorResponse] = await Promise.all([
    fetchJsonWithTimeout(`${baseUrl}/api/policies/current`, {
      method: "GET",
      headers: buildApiHeaders(),
    }),
    fetchJsonWithTimeout(`${baseUrl}/api/behavior/summary?source=vscode_extension&category=suggestion&limit=16`, {
      method: "GET",
      headers: buildApiHeaders(),
    }).catch(() => null),
  ]);

  if (response?.ok) {
    overlayState.policy = response.policy || { ...DEFAULT_POLICY };
    overlayState.telemetry = Array.isArray(response.telemetry) ? response.telemetry : [];
    overlayState.behaviorMetrics = Array.isArray(behaviorResponse?.items) ? behaviorResponse.items : [];
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
    activeSuggestion: toText(overlayState.vscodeSyncState?.latestRack?.activeSuggestion),
    replacementOptions: Array.isArray(overlayState.vscodeSyncState?.latestRack?.replacementOptions)
      ? overlayState.vscodeSyncState.latestRack.replacementOptions.slice(0, 8)
      : [],
  };

  const response = await fetchJsonWithTimeout(`${baseUrl}/api/projects/rack`, {
    method: "POST",
    headers: buildApiHeaders(),
    body: JSON.stringify(payload),
  }, 25000);

  return !!response?.ok;
}

function toVscodeCodeActionText(value) {
  return String(value || "")
    .replace(/\r\n/g, "\n")
    .replace(/\r/g, "\n")
    .slice(0, 120000);
}

function normalizeVscodeReplacementOptions(value) {
  const items = Array.isArray(value) ? value : [];
  return items
    .map((item, index) => {
      const source = item && typeof item === "object" ? item : {};
      return {
        id: toText(source.id) || `option-${index + 1}`,
        label: toText(source.label) || `Opcion ${index + 1}`,
        description: toText(source.description),
        filePath: toText(source.filePath || source.file_path),
        actionType: toText(source.actionType || source.action_type),
        originalText: toVscodeCodeActionText(source.originalText || source.original_text),
        replacementText: toVscodeCodeActionText(source.replacementText || source.replacement_text),
        metadata: source.metadata && typeof source.metadata === "object" ? source.metadata : {},
      };
    })
    .filter((item) => item.label || item.replacementText)
    .slice(0, 8);
}

function normalizeVscodeActionProbe(value) {
  return toText(value)
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "");
}

function inferVscodeReplacementModeFromText(value, fallback = "insert") {
  const probe = normalizeVscodeActionProbe(value);
  const explicit = probe.match(/\b(?:accion|aplicar|modo|action|apply)\s*:\s*(insert|insertar|add|replace|reemplazar|modificar|update|delete|eliminar|borrar|remove)\b/);
  const token = explicit?.[1] || "";
  if (/^(delete|eliminar|borrar|remove)$/.test(token)) return "delete";
  if (/^(replace|reemplazar|modificar|update)$/.test(token)) return "replace";
  if (/^(insert|insertar|add)$/.test(token)) return "insert";
  if (/\b(elimina|eliminar|borra|borrar|quita|quitar|remueve|remover|retira|retirar|delete|remove)\b/.test(probe)) return "delete";
  if (/\b(modifica|modificar|reemplaza|reemplazar|cambia|cambiar|actualiza|actualizar|corrige|corregir|refactoriza|refactorizar|replace|update|fix)\b/.test(probe)) return "replace";
  if (/\b(agrega|agregar|anade|anadir|inserta|insertar|crea|crear|implementa|implementar|completa|completar|add|insert|append)\b/.test(probe)) return "insert";
  return fallback;
}

function extractFirstVscodeCodeFence(value) {
  const match = toText(value).match(/```(?:[A-Za-z0-9_+-]+)?\s*\r?\n([\s\S]*?)```/);
  return match?.[1]?.replace(/\r\n/g, "\n").replace(/\r/g, "\n").trimEnd() || "";
}

function commentSyntaxForVscodeFile(filePath) {
  const lower = toText(filePath).toLowerCase();
  if (/\.(py|rb|sh|bash|zsh|ps1|yml|yaml|toml|ini|env)$/i.test(lower)) {
    return { open: "# ", close: "" };
  }
  if (/\.(html|htm|xml|svg|md)$/i.test(lower)) {
    return { open: "<!-- ", close: " -->" };
  }
  if (/\.(css|scss|sass|sql)$/i.test(lower)) {
    return { open: "/* ", close: " */" };
  }
  return { open: "// ", close: "" };
}

function firstNonEmptyLine(value) {
  return String(value || "")
    .replace(/\r\n/g, "\n")
    .replace(/\r/g, "\n")
    .split("\n")
    .find((line) => line.trim())
    || "";
}

function lineIndent(value) {
  const match = String(value || "").match(/^[ \t]*/);
  return match ? match[0] : "";
}

function normalizeVscodeTodoText(value) {
  const withoutFences = toText(value)
    .replace(/```[\s\S]*?```/g, " ")
    .replace(/\b(?:accion|aplicar|modo|action|apply)\s*:\s*(insert|insertar|add|replace|reemplazar|modificar|update|delete|eliminar|borrar|remove)\b/gi, " ")
    .replace(/\s+/g, " ")
    .trim();
  const clean = withoutFences
    .replace(/^(?:\d+[).]\s*)?(?:resumen|sugerencias del codigo|sugerencias del archivo|riesgos)\s*:?\s*/i, "")
    .replace(/^[-*]\s*/, "")
    .trim();
  return truncateText(clean || "revisar este punto con la sugerencia de ADACEEN", 180);
}

function buildVscodeFallbackReplacementText(rack, context, sourceText) {
  const filePath = toText(rack?.activeFilePath || context?.filePath);
  const codeFence = extractFirstVscodeCodeFence(sourceText);
  if (codeFence.trim()) {
    return codeFence;
  }

  const activeLine = firstNonEmptyLine(rack?.activeCodeSnippet || context?.selection || context?.codeSnippet);
  const indent = lineIndent(activeLine);
  const comment = commentSyntaxForVscodeFile(filePath);
  return `${indent}${comment.open}TODO: ${normalizeVscodeTodoText(sourceText)}${comment.close}`;
}

function normalizeVscodeFilePath(value) {
  return toText(value)
    .replace(/\\/g, "/")
    .replace(/^\/+/, "")
    .toLowerCase();
}

function isVscodeRackForDifferentFile(rack, context = {}) {
  const rackPath = normalizeVscodeFilePath(rack?.activeFilePath);
  const contextPath = normalizeVscodeFilePath(context?.filePath);
  if (!rackPath || !contextPath) return false;
  return rackPath !== contextPath
    && !rackPath.endsWith(`/${contextPath}`)
    && !contextPath.endsWith(`/${rackPath}`);
}

function buildContextScopedVscodeRack(rack, context = {}) {
  const sourceRack = rack && typeof rack === "object" ? rack : {};
  if (!isVscodeRackForDifferentFile(sourceRack, context)) {
    return sourceRack;
  }

  return {
    ...sourceRack,
    activeFilePath: toText(context.filePath) || toText(sourceRack.activeFilePath),
    activeCodeSnippet: toVscodeCodeActionText(context.selection || context.codeSnippet || ""),
    activeSuggestion: "",
    replacementOptions: [],
    contextMismatch: true,
  };
}

function appendVscodeCommentToTarget(targetText, commentText) {
  const target = toVscodeCodeActionText(targetText).replace(/\s+$/g, "");
  const comment = toVscodeCodeActionText(commentText).trimEnd();
  if (!target) return comment;
  if (!comment) return target;
  return `${target}\n${comment}`;
}

function buildBrowserDefaultVscodeReplacementOptions(rack, context = {}) {
  const scopedRack = buildContextScopedVscodeRack(rack, context);
  const staleRack = isVscodeRackForDifferentFile(rack, context);
  const filePath = toText(scopedRack.activeFilePath || context.filePath);
  if (!filePath) return [];

  const visibleSelection = toVscodeCodeActionText(context.selection);
  const rackFocusText = staleRack ? "" : toVscodeCodeActionText(rack?.activeCodeSnippet);
  const targetText = visibleSelection || rackFocusText;
  const basisText = targetText || toVscodeCodeActionText(context.codeSnippet || scopedRack.activeCodeSnippet);
  const sourceText = toText(scopedRack.activeSuggestion);
  if (!sourceText.trim()) return [];

  const mode = inferVscodeReplacementModeFromText([
    scopedRack.activeSuggestion,
    scopedRack.actionType,
    scopedRack.applyMode,
  ].map(toText).join("\n"), "insert");
  const commentText = buildVscodeFallbackReplacementText(
    { ...scopedRack, activeCodeSnippet: basisText, activeFilePath: filePath },
    context,
    sourceText,
  );
  const lineText = firstNonEmptyLine(basisText);
  const hasVisibleSelection = !!visibleSelection.trim();
  const targetModeLabel = hasVisibleSelection ? "seleccion" : "linea";
  const originalText = mode === "insert" ? lineText : targetText;
  if ((mode === "replace" || mode === "delete") && !originalText.trim()) return [];

  const replacementText = mode === "delete"
    ? ""
    : mode === "replace" && !extractFirstVscodeCodeFence(sourceText).trim()
      ? appendVscodeCommentToTarget(originalText, commentText)
      : commentText;
  const actionLabel = mode === "delete"
    ? (hasVisibleSelection ? "Eliminar seleccion" : "Eliminar linea actual")
    : mode === "replace"
      ? (hasVisibleSelection ? "Modificar seleccion" : "Modificar linea actual")
      : "Agregar comentario TODO";
  const actionType = mode === "delete"
    ? (hasVisibleSelection ? "delete_selection" : "delete_line")
    : mode === "replace"
      ? (hasVisibleSelection ? "replace_selection" : "replace_line")
      : "insert_after_line";

  return [{
    id: `browser-agent-${mode}`,
    label: actionLabel,
    description: `ADACEEN decidio ${actionLabel.toLowerCase()} sobre la ${targetModeLabel} enfocada.`,
    filePath,
    actionType,
    originalText,
    replacementText,
    metadata: {
      applyMode: mode,
      generatedBy: "browser_overlay_agent_decision",
      source: "browser_overlay",
      rackContextMismatch: staleRack,
    },
  }];
}

function hasUsableVscodeReplacementOption(option) {
  if (!option) return false;
  if (isDeleteVscodeReplacementOption(option)) return true;
  return !!toText(option.replacementText);
}

function enrichVscodeReplacementOption(option, rack, context, index) {
  const sourceText = [
    option?.replacementText,
    rack?.activeSuggestion,
    option?.description,
    option?.label,
  ].map(toText).find(Boolean) || "";
  const mode = inferVscodeReplacementModeFromText([
    option?.actionType,
    option?.id,
    option?.label,
    option?.description,
    option?.metadata?.applyMode,
    sourceText,
  ].map(toText).join("\n"), "insert");

  const optionReplacementText = toVscodeCodeActionText(option?.replacementText);
  const replacementText = optionReplacementText.trim()
    ? optionReplacementText
    : mode === "delete" ? "" : buildVscodeFallbackReplacementText(rack, context, sourceText);
  const hasExplicitActionType = !!toText(option?.actionType);
  const actionType = hasExplicitActionType
    ? toText(option.actionType)
    : mode === "delete"
      ? "delete_line"
      : mode === "replace" && extractFirstVscodeCodeFence(sourceText)
        ? "replace_line"
        : "insert_after_line";

  return {
    id: toText(option?.id) || `resolved-option-${index + 1}`,
    label: toText(option?.label) || (mode === "delete" ? "Eliminar codigo sugerido" : mode === "replace" ? "Modificar codigo sugerido" : "Agregar ayuda sugerida"),
    description: toText(option?.description) || (mode === "delete"
      ? "Elimina el bloque enfocado en VS Code."
      : "Envia una accion aplicable a VS Code basada en la sugerencia actual."),
    filePath: toText(option?.filePath || rack?.activeFilePath || context?.filePath),
    actionType,
    originalText: toVscodeCodeActionText(option?.originalText || rack?.activeCodeSnippet || context?.selection || context?.codeSnippet),
    replacementText,
    metadata: {
      ...(option?.metadata && typeof option.metadata === "object" ? option.metadata : {}),
      applyMode: mode === "replace" && !extractFirstVscodeCodeFence(sourceText) ? "insert" : mode,
      generatedBy: toText(option?.metadata?.generatedBy) || "vscode_rack_resolution",
    },
  };
}

function buildDerivedVscodeReplacementOption(rack, context) {
  const sourceText = toText(rack?.activeSuggestion);
  const filePath = toText(rack?.activeFilePath || context?.filePath);
  if (!sourceText || !filePath) return null;

  const inferredMode = inferVscodeReplacementModeFromText(sourceText, "insert");
  const codeFence = extractFirstVscodeCodeFence(sourceText);
  const safeMode = inferredMode === "replace" && !codeFence ? "insert" : inferredMode;
  const replacementText = safeMode === "delete"
    ? ""
    : buildVscodeFallbackReplacementText(rack, context, sourceText);
  const activeText = toVscodeCodeActionText(rack?.activeCodeSnippet || context?.selection || context?.codeSnippet);

  if (safeMode === "delete" && !activeText.trim()) return null;

  return {
    id: `browser-derived-${safeMode}`,
    label: safeMode === "delete"
      ? "Eliminar bloque enfocado"
      : safeMode === "replace"
        ? "Modificar con codigo sugerido"
        : "Agregar cambio sugerido",
    description: safeMode === "delete"
      ? "Envia a VS Code una accion para eliminar la linea o seleccion activa."
      : codeFence
        ? "Usa el bloque de codigo detectado en la sugerencia para continuar en VS Code."
        : "Convierte la sugerencia en un TODO aplicable cerca del cursor.",
    filePath,
    actionType: safeMode === "delete"
      ? "delete_line"
      : safeMode === "replace"
        ? "replace_line"
        : "insert_after_line",
    originalText: activeText,
    replacementText,
    metadata: {
      applyMode: safeMode,
      generatedBy: "browser_overlay_fallback",
      source: "browser_overlay",
    },
  };
}

function resolveVscodeReplacementOptions(rack, context = {}) {
  const sourceRack = rack && typeof rack === "object" ? rack : {};
  const scopedRack = buildContextScopedVscodeRack(sourceRack, context);
  const sourceOptions = scopedRack.contextMismatch
    ? []
    : normalizeVscodeReplacementOptions(sourceRack.replacementOptions || sourceRack.replacement_options);
  const hydrated = sourceOptions
    .map((option, index) => enrichVscodeReplacementOption(option, scopedRack, context, index))
    .filter((option) => option.label || option.replacementText || isDeleteVscodeReplacementOption(option))
    .slice(0, 8);

  const derived = buildDerivedVscodeReplacementOption(scopedRack, context);
  const defaults = buildBrowserDefaultVscodeReplacementOptions(sourceRack, context);
  const merged = [
    ...hydrated,
    ...(derived ? [derived] : []),
    ...defaults,
  ];
  const seen = new Set();
  const resolved = [];
  for (const option of merged) {
    if (!hasUsableVscodeReplacementOption(option)) continue;
    const key = [
      option.actionType,
      option.filePath,
      option.originalText,
      option.replacementText,
      option.label,
    ].map(toText).join("::");
    if (seen.has(key)) continue;
    seen.add(key);
    resolved.push(option);
    if (resolved.length >= 8) break;
  }

  const candidates = resolved.length ? resolved : hydrated;
  if (!candidates.length) return [];

  const agentMode = inferVscodeReplacementModeFromText([
    scopedRack.activeSuggestion,
    scopedRack.applyMode,
    scopedRack.actionType,
  ].map(toText).join("\n"), "");
  const selected = agentMode
    ? candidates.find((option) => vscodeReplacementModeFromOption(option) === agentMode) || candidates[0]
    : candidates[0];
  return selected ? [selected] : [];
}

function isDeleteVscodeReplacementOption(option) {
  const metadata = option?.metadata && typeof option.metadata === "object" ? option.metadata : {};
  return /\b(delete|remove|eliminar|borrar)\b/i.test([
    option?.actionType,
    option?.id,
    option?.label,
    metadata.applyMode,
  ].map(toText).join(" "));
}

function vscodeReplacementModeFromOption(option) {
  if (isDeleteVscodeReplacementOption(option)) return "delete";
  const metadata = option?.metadata && typeof option.metadata === "object" ? option.metadata : {};
  const probe = [
    option?.actionType,
    option?.id,
    option?.label,
    metadata.applyMode,
  ].map(toText).join(" ");
  return inferVscodeReplacementModeFromText(probe, "replace");
}

function normalizeVscodeRackPayload(value) {
  const source = value && typeof value === "object" ? value : {};
  return {
    id: toText(source.id),
    source: toText(source.source),
    repoFullName: parseRepoFullName(source.repoFullName || source.repo_full_name || ""),
    branch: toText(source.branch),
    totalEntries: Math.max(0, Number(source.totalEntries || source.total_entries || 0) || 0),
    totalFiles: Math.max(0, Number(source.totalFiles || source.total_files || 0) || 0),
    totalFolders: Math.max(0, Number(source.totalFolders || source.total_folders || 0) || 0),
    activeFilePath: toText(source.activeFilePath || source.active_file_path),
    activeCodeSnippet: toText(source.activeCodeSnippet || source.active_code_snippet),
    activeSuggestion: toText(source.activeSuggestion || source.active_suggestion),
    replacementOptions: normalizeVscodeReplacementOptions(source.replacementOptions || source.replacement_options),
    generatedAt: toText(source.generatedAt || source.generated_at),
    createdAt: toText(source.createdAt || source.created_at),
    updatedAt: toText(source.updatedAt || source.updated_at || source.createdAt || source.created_at),
  };
}

async function refreshVscodeSyncState(options = {}) {
  const baseUrl = normalizeBaseUrl(overlayState.backendUrl);
  const context = overlayState.context || buildPayload();
  const repoFullName = getCurrentRepoFullName();
  const silent = options.silent !== false;

  if (!baseUrl || !overlayState.sessionId || context.pageType !== "codespace") {
    overlayState.vscodeSyncState = { ...EMPTY_VSCODE_SYNC_STATE };
    return null;
  }

  overlayState.vscodeSyncState = {
    ...(overlayState.vscodeSyncState || EMPTY_VSCODE_SYNC_STATE),
    busy: !silent,
    error: "",
    message: silent ? toText(overlayState.vscodeSyncState?.message) : "Sincronizando con VS Code...",
  };
  if (!silent) renderOverlay();

  try {
    const response = await fetchJsonWithTimeout(`${baseUrl}/api/projects/session/state`, {
      method: "GET",
      headers: buildApiHeaders(),
    }, 15000);
    const rack = normalizeVscodeRackPayload(response?.state?.latestRack);
    const sameRepo = !repoFullName
      || !rack.repoFullName
      || rack.repoFullName.toLowerCase() === repoFullName.toLowerCase();
    const connected = !!rack.id && sameRepo;
    overlayState.vscodeSyncState = {
      connected,
      busy: false,
      error: "",
      message: connected
        ? "VS Code sincronizado con este Codespace."
        : rack.id
          ? "VS Code publico contexto de otro repositorio."
          : "Aun no hay estado publicado desde VS Code.",
      latestRack: connected ? rack : null,
      resolvedReplacementOptions: [],
      lastAction: overlayState.vscodeSyncState?.lastAction || null,
      updatedAt: rack.updatedAt || "",
      suggestionWaitKey: overlayState.vscodeSyncState?.suggestionWaitKey || "",
      suggestionWaitStartedAt: overlayState.vscodeSyncState?.suggestionWaitStartedAt || 0,
    };
    return overlayState.vscodeSyncState;
  } catch (error) {
    overlayState.vscodeSyncState = {
      ...(overlayState.vscodeSyncState || EMPTY_VSCODE_SYNC_STATE),
      connected: false,
      busy: false,
      error: String(error),
      message: "No se pudo leer el estado de VS Code.",
    };
    return null;
  } finally {
    if (!silent) renderOverlay();
  }
}

async function queueVscodeReplacementOption(option, metadata = {}) {
  const baseUrl = normalizeBaseUrl(overlayState.backendUrl);
  const context = overlayState.context || buildPayload();
  const rack = buildContextScopedVscodeRack(overlayState.vscodeSyncState?.latestRack || {}, context);
  const repoFullName = getCurrentRepoFullName() || rack.repoFullName;
  const filePath = toText(option?.filePath || rack.activeFilePath || context.filePath);
  const replacementText = toVscodeCodeActionText(option?.replacementText);
  const optionHasOriginalText = !!option && Object.prototype.hasOwnProperty.call(option, "originalText");
  const originalText = optionHasOriginalText
    ? toVscodeCodeActionText(option.originalText)
    : toVscodeCodeActionText(rack.activeCodeSnippet || context.selection || context.codeSnippet);

  if (!baseUrl || !overlayState.sessionId) {
    throw new Error("Sesion no valida para enviar reemplazos.");
  }
  if (!repoFullName || !filePath) {
    throw new Error("Falta repositorio o archivo activo para el reemplazo.");
  }
  if (!replacementText.trim() && !isDeleteVscodeReplacementOption(option)) {
    throw new Error("La opcion no contiene texto de reemplazo.");
  }

  overlayState.vscodeSyncState = {
    ...(overlayState.vscodeSyncState || EMPTY_VSCODE_SYNC_STATE),
    busy: true,
    error: "",
    message: "Enviando reemplazo a VS Code...",
  };
  renderOverlay();

  try {
    const response = await fetchJsonWithTimeout(`${baseUrl}/api/projects/code-actions`, {
      method: "POST",
      headers: buildApiHeaders(),
      body: JSON.stringify({
        repoFullName,
        branch: toText(rack.branch || context.branch),
        filePath,
        actionType: toText(option?.actionType) || "replace_selection",
        title: toText(option?.label) || "Reemplazo sugerido",
        originalText,
        replacementText,
        metadata: {
          optionId: toText(option?.id),
          optionDescription: toText(option?.description),
          pageType: toText(context.pageType),
          source: "browser_sync_panel",
          ...metadata,
        },
      }),
    }, 20000);

    overlayState.vscodeSyncState = {
      ...(overlayState.vscodeSyncState || EMPTY_VSCODE_SYNC_STATE),
      busy: false,
      error: "",
      message: "Reemplazo enviado. VS Code lo aplicara cuando confirme la accion.",
      lastAction: response?.action || null,
    };
    overlayState.statusMessage = "Reemplazo enviado a la extension VS Code.";
    return response?.action || null;
  } catch (error) {
    overlayState.vscodeSyncState = {
      ...(overlayState.vscodeSyncState || EMPTY_VSCODE_SYNC_STATE),
      busy: false,
      error: String(error),
      message: "No se pudo enviar el reemplazo a VS Code.",
    };
    throw error;
  } finally {
    renderOverlay();
  }
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
  const ragSources = normalizeRagSourcesForUi(raw?.rag_sources || raw?.ragSources || []);
  const rawRagCourseCode = toText(raw?.rag_course_code || raw?.ragCourseCode);

  return {
    ideas,
    guide: guide.length > 0 ? guide : fallbackGuide,
    welcome: toText(result.welcome_message),
    summary: toText(result.analysis_summary),
    ragCourseCode: rawRagCourseCode ? normalizeRagCourseCodeUi(rawRagCourseCode) : "",
    ragSources,
  };
}

function firstPositiveNumberUi(...values) {
  for (const value of values) {
    const number = Number(value);
    if (Number.isFinite(number) && number > 0) return number;
  }
  return null;
}

function parseRagPageRangeFromLabel(label) {
  const match = toText(label).match(/\bp\.\s*(\d+)(?:\s*-\s*(\d+))?/i);
  if (!match) return { pageStart: null, pageEnd: null };
  const pageStart = firstPositiveNumberUi(match[1]);
  const pageEnd = firstPositiveNumberUi(match[2]) || pageStart;
  return { pageStart, pageEnd };
}

function normalizeRagSourcesForUi(value) {
  const items = Array.isArray(value) ? value : [];
  return items
    .map((item) => {
      const source = item && typeof item === "object" ? item : {};
      const citation = source.citation && typeof source.citation === "object" ? source.citation : {};
      const metadata = source.metadata && typeof source.metadata === "object" ? source.metadata : {};
      const citationLabel = toText(source.citationLabel || citation.label || citation.marker);
      const labelPageRange = parseRagPageRangeFromLabel(citationLabel);
      const url = toText(source.url || source.viewerUrl || metadata.viewerUrl || citation.url);
      const externalUrl = toText(source.externalUrl || metadata.externalUrl || citation.externalUrl);
      const sourceId = toText(source.sourceId || source.source_id || source.id || citation.sourceId || citation.source_id);
      const chunkId = toText(source.chunkId || source.chunk_id || citation.chunkId || citation.chunk_id);
      return {
        id: toText(source.id),
        sourceId,
        chunkId,
        scope: toText(source.scope),
        courseCode: normalizeRagCourseCodeUi(source.courseCode || source.course_code || metadata.courseCode || metadata.course_code),
        title: toText(source.title || citation.title),
        fileName: toText(source.fileName || citation.fileName),
        sourceType: toText(source.sourceType),
        knowledgeTier: toText(source.knowledgeTier || metadata.knowledgeTier || metadata.knowledge_tier),
        contextDomain: toText(source.contextDomain || metadata.contextDomain || metadata.context_domain),
        citationLabel,
        pageStart: firstPositiveNumberUi(
          source.pageStart,
          source.page_start,
          source.page,
          source.pageNumber,
          source.page_number,
          citation.pageStart,
          citation.page_start,
          citation.page,
          citation.pageNumber,
          citation.page_number,
          metadata.pageStart,
          metadata.page_start,
          metadata.page,
          metadata.pageNumber,
          metadata.page_number,
          labelPageRange.pageStart,
        ),
        pageEnd: firstPositiveNumberUi(
          source.pageEnd,
          source.page_end,
          citation.pageEnd,
          citation.page_end,
          metadata.pageEnd,
          metadata.page_end,
          labelPageRange.pageEnd,
        ),
        excerpt: toText(source.excerpt),
        usageReason: toText(source.usageReason || source.usage_reason || metadata.usageReason || metadata.usage_reason),
        matchedTerms: Array.isArray(source.matchedTerms || source.matched_terms)
          ? (source.matchedTerms || source.matched_terms).map(toText).filter(Boolean).slice(0, 8)
          : [],
        url,
        viewerUrl: url,
        externalUrl,
        isOpenable: Boolean(source.isOpenable || source.is_openable || url || sourceId),
        score: Number(source.score) || 0,
        ftsScore: Number(source.ftsScore || source.fts_score) || 0,
        semanticScore: Number(source.semanticScore || source.semantic_score) || 0,
      };
    })
    .filter((item) => item.title || item.fileName || item.citationLabel)
    .sort((left, right) => {
      if (left.isOpenable !== right.isOpenable) return left.isOpenable ? -1 : 1;
      if (right.score !== left.score) return right.score - left.score;
      return toText(left.title || left.fileName).localeCompare(toText(right.title || right.fileName));
    })
    .slice(0, 5);
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

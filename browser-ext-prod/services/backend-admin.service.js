// ADACEEN | Capa 3 - Servicios: administracion (politica y telemetria, usuarios) y progreso de estudiantes.
// Movido sin cambios desde services/backend.service.js.
// Sin "use strict": el codigo viene de backend.service.js (modo no estricto) y se conserva igual.
// Orden de carga: manifest.json (content_scripts) y background.js (CONTENT_SCRIPT_FILES) deben coincidir.

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
    fetchRagCoursesForCurrentSession({ fresh: true }).catch(() => null),
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

// Pestana "Estudiantes" (0.7.13): progreso por estudiante con sesiones, intervenciones,
// quices y nota (GET /api/admin/students). El docente recibe a sus estudiantes; el
// administrador, a todos. 30 s de espera: es una consulta agregada, no el tutor.
const STUDENTS_PROGRESS_TIMEOUT_MS = 30000;

async function fetchStudentsProgress() {
  const baseUrl = normalizeBaseUrl(overlayState.backendUrl);
  if (!baseUrl || !overlayState.sessionId || !canManageUsersSession()) {
    throw new Error("Sesion no valida para ver el progreso de los estudiantes.");
  }
  const response = await fetchJsonWithTimeout(`${baseUrl}/api/admin/students`, {
    method: "GET",
    headers: buildApiHeaders(),
  }, STUDENTS_PROGRESS_TIMEOUT_MS);
  if (!response?.ok) {
    throw new Error(toText(response?.error) || "No se pudo cargar el progreso de los estudiantes.");
  }
  return {
    students: Array.isArray(response.students) ? response.students : [],
    totals: response.totals && typeof response.totals === "object" ? response.totals : null,
    generatedAt: toText(response.generatedAt),
    viewerRole: toText(response.viewerRole),
  };
}

// Detalle de un estudiante (GET /api/admin/students/:userId): sesiones, intervenciones,
// quices con su nota, actividad por categoria, ejercicios y linea de tiempo de 14 dias.
async function fetchStudentProgressDetail(studentUserId, limit = 30) {
  const baseUrl = normalizeBaseUrl(overlayState.backendUrl);
  const userId = toText(studentUserId);
  if (!baseUrl || !overlayState.sessionId || !canManageUsersSession() || !userId) {
    throw new Error("Sesion no valida para ver el detalle del estudiante.");
  }
  const bounded = Math.max(1, Math.min(200, Math.round(Number(limit) || 30)));
  const response = await fetchJsonWithTimeout(
    `${baseUrl}/api/admin/students/${encodeURIComponent(userId)}?limit=${bounded}`,
    { method: "GET", headers: buildApiHeaders() },
    STUDENTS_PROGRESS_TIMEOUT_MS,
  );
  if (!response?.ok || !response.student) {
    throw new Error(toText(response?.error) || "No se pudo cargar el detalle del estudiante.");
  }
  return {
    student: response.student,
    sessions: Array.isArray(response.sessions) ? response.sessions : [],
    interventions: Array.isArray(response.interventions) ? response.interventions : [],
    quizzes: Array.isArray(response.quizzes) ? response.quizzes : [],
    activity: Array.isArray(response.activity) ? response.activity : [],
    exercises: Array.isArray(response.exercises) ? response.exercises : [],
    timeline: Array.isArray(response.timeline) ? response.timeline : [],
    generatedAt: toText(response.generatedAt),
  };
}

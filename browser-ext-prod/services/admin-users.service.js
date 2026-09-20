// ADACEEN | Capa 3 - Servicios: politica docente, telemetria y administracion de usuarios del piloto.
// Orden de carga: manifest.json (content_scripts) y background.js (CONTENT_SCRIPT_FILES) deben coincidir.
"use strict";

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

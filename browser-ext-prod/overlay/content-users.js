// ADACEEN | Capa 4 - UI: pestaña «Usuarios» y administración de roles (0.7.14, 0.7.15).
// Render de la tabla de usuarios administrables (docente y admin), edición en línea de rol,
// alta de nuevos usuarios y asignación de lote/docente.
// Extraído de overlay/content-render.js y overlay/content-lifecycle.js.
// Sin "use strict": el codigo viene de content-render.js y content-lifecycle.js (modo no estricto)
// y se conserva igual.
// Orden de carga: manifest.json (content_scripts) y background.js (CONTENT_SCRIPT_FILES) deben coincidir.

async function reloadAdminUsersFromRecommendedAction() {
  if (!canManageUsersSession()) return;
  overlayState.adminUsersBusy = true;
  overlayState.adminUsersMessage = "Actualizando usuarios...";
  renderOverlay();
  try {
    await reloadAdminUsers();
    overlayState.adminUsersMessage = "Usuarios actualizados.";
  } catch (error) {
    overlayState.adminUsersMessage = `No se pudieron cargar usuarios: ${String(error)}`;
  } finally {
    overlayState.adminUsersBusy = false;
    renderOverlay();
  }
}

function renderAdminUsersTable() {
  if (!overlayEls) return;
  if (!canManageUsersSession()) {
    overlayEls.adminUsersSection.hidden = true;
    return;
  }

  const allUsers = Array.isArray(overlayState.adminUsers) ? overlayState.adminUsers : [];
  // Búsqueda (0.7.22): por nombre, correo, otros correos o código, sin tildes ni mayúsculas.
  const query = normalizeAdminUsersQuery(overlayState.adminUsersQuery);
  const users = query ? allUsers.filter((user) => adminUserMatchesQuery(user, query)) : allUsers;
  const teachers = Array.isArray(overlayState.adminTeachers) ? overlayState.adminTeachers : [];
  const busy = !!overlayState.adminUsersBusy;
  const teacherMode = isTeacherSession();
  const createFormOpen = !!overlayState.adminCreateFormOpen;
  const loadingMessage = teacherMode
    ? "Cargando estudiantes asignados"
    : "Cargando usuarios administrables";
  const students = allUsers.filter((user) => toText(user.role).toLowerCase() !== "teacher");
  const withCode = students.filter((user) => toText(user.studentCode)).length;
  const codeSummary = students.length ? ` · ${withCode} con código · ${students.length - withCode} sin código` : "";
  // Direccion B (0.7.22): el conteo en una linea corta, bajo «Usuarios».
  const defaultStatusMessage = teacherMode
    ? `${allUsers.length} estudiante${allUsers.length === 1 ? "" : "s"}${codeSummary}`
    : `${allUsers.length} usuario${allUsers.length === 1 ? "" : "s"}${codeSummary}`;
  const searchSummary = query ? `${users.length} de ${allUsers.length} coinciden con «${toText(overlayState.adminUsersQuery).trim()}».` : "";
  const statusMessage = overlayState.adminUsersMessage || (busy ? loadingMessage : (searchSummary || defaultStatusMessage));

  overlayEls.adminUsersSection.hidden = false;
  // Como docente todos son sus estudiantes: la columna «Profesor» se oculta (0.7.15).
  overlayEls.adminUsersTableBody?.parentElement?.classList?.toggle("is-teacher-mode", teacherMode);
  overlayEls.adminUsersStatus.textContent = busy ? statusMessage.replace(/\.{3}$/, "") : statusMessage;
  overlayEls.adminUsersStatus.classList.toggle("is-loading-note", busy);
  overlayEls.adminReloadUsersBtn.disabled = busy;
  overlayEls.adminToggleCreateUserBtn.disabled = busy;
  overlayEls.adminToggleCreateUserBtn.textContent = createFormOpen ? "Ocultar formulario" : "Agregar usuario";
  overlayEls.adminToggleCreateUserBtn.setAttribute("aria-expanded", createFormOpen ? "true" : "false");
  overlayEls.adminCreateForm.hidden = !createFormOpen;
  overlayEls.adminCreateBtn.disabled = busy;
  overlayEls.adminCreateRole.disabled = busy || teacherMode;
  if (teacherMode) {
    overlayEls.adminCreateRole.value = "student";
  }

  overlayEls.adminCreateTeacher.disabled = busy || teacherMode || overlayEls.adminCreateRole.value !== "student";
  const teacherOptionsKey = JSON.stringify([
    teacherMode,
    teachers.map((teacher) => [toText(teacher.id), toText(teacher.displayName), toText(teacher.email)]),
  ]);
  if (renderKeyChanged(overlayEls.adminCreateTeacher, teacherOptionsKey)) {
    overlayEls.adminCreateTeacher.textContent = "";
    const emptyTeacherOption = document.createElement("option");
    emptyTeacherOption.value = "";
    emptyTeacherOption.textContent = teachers.length > 0
      ? "Asignar profesor (opcional)"
      : "Sin profesores activos";
    overlayEls.adminCreateTeacher.appendChild(emptyTeacherOption);
    for (const teacher of teachers) {
      const option = document.createElement("option");
      option.value = toText(teacher.id);
      option.textContent = `${toText(teacher.displayName)} (${toText(teacher.email)})`;
      overlayEls.adminCreateTeacher.appendChild(option);
    }
    if (teacherMode && teachers[0]?.id) {
      overlayEls.adminCreateTeacher.value = toText(teachers[0].id);
    }
  }
  renderAdminCreateCourseGrid();
  overlayEls.adminCreateStudentCode.disabled = busy || overlayEls.adminCreateRole.value !== "student";
  renderAdminAccessRequests(busy);

  if (overlayEls.adminUsersSearch && !overlayEls.adminUsersSearch.matches(":focus")) {
    overlayEls.adminUsersSearch.value = toText(overlayState.adminUsersQuery);
  }

  // «Eliminar seleccionados» (0.7.22): solo estudiantes; la seleccion se limpia de ids que ya no
  // estan. «Seleccionar todos» marca los que muestra la busqueda.
  const allIds = new Set(allUsers.map((user) => toText(user.id)));
  const selectedIds = (Array.isArray(overlayState.adminSelectedUserIds) ? overlayState.adminSelectedUserIds : [])
    .map(toText)
    .filter((id) => allIds.has(id));
  if (selectedIds.length !== (overlayState.adminSelectedUserIds || []).length) overlayState.adminSelectedUserIds = selectedIds;
  const selected = new Set(selectedIds);
  const selectableIds = users.filter(isAdminUserSelectable).map((user) => toText(user.id));
  renderAdminUsersBulkBar(selectedIds.length, selectableIds, selected, busy);

  const editingId = toText(overlayState.adminEditingUserId);
  const tableKey = JSON.stringify([
    users,
    selectedIds,
    teachers.map((teacher) => [toText(teacher.id), toText(teacher.displayName)]),
    busy,
    teacherMode,
    editingId,
    getRagCourseCatalog().map((course) => toText(course?.code)),
    overlayState.ragLots?.courses || [],
  ]);
  if (!renderKeyChanged(overlayEls.adminUsersTableBody, tableKey)) return;
  overlayEls.adminUsersTableBody.textContent = "";
  function appendAdminUsersNotice(message, className, loading = false) {
    const row = document.createElement("tr");
    const cell = document.createElement("td");
    cell.colSpan = 8;
    cell.className = `${className}${loading ? " is-loading-note" : ""}`;
    cell.textContent = message;
    row.appendChild(cell);
    overlayEls.adminUsersTableBody.appendChild(row);
  }

  if (busy && users.length === 0) {
    appendAdminUsersNotice(loadingMessage, "admin-loading-cell", true);
    return;
  }

  if (users.length === 0) {
    appendAdminUsersNotice(query ? "Nadie coincide con la búsqueda." : "No hay usuarios administrables.", "admin-empty-cell");
    return;
  }

  const courseNames = new Map(getRagCourseCatalog().map((course) => [
    normalizeRagCourseCodeUi(course?.code),
    toText(course?.shortName || course?.code),
  ]));
  const chip = (text, className = "") => {
    const span = document.createElement("span");
    span.className = `admin-chip${className ? ` ${className}` : ""}`;
    span.textContent = text;
    return span;
  };

  // Filas legibles (0.7.14): nombre y correo completos como texto; rol, docente, cursos y
  // estado como etiquetas. «Editar» abre los campos de esa fila a todo el ancho.
  const fragment = document.createDocumentFragment();
  users.forEach((user) => {
    const role = toText(user.role).toLowerCase() === "teacher" ? "teacher" : "student";
    const userId = toText(user.id);
    const isEditing = editingId === userId;
    const inactive = user.isActive === false;

    const row = document.createElement("tr");
    row.className = `admin-user-row${isEditing ? " is-editing" : ""}${inactive ? " is-inactive" : ""}`;
    row.dataset.userId = userId;

    // Casilla para «Eliminar seleccionados» (0.7.22): solo en las filas de estudiantes.
    const selectCell = document.createElement("td");
    selectCell.className = "admin-select-cell";
    if (isAdminUserSelectable(user)) {
      selectCell.appendChild(buildAdminSelectBox("users", user, selected, selectableIds, busy));
    }

    const identityCell = document.createElement("td");
    identityCell.className = "admin-identity-cell";
    const name = document.createElement("span");
    name.className = "admin-user-name";
    name.textContent = toText(user.displayName) || "Sin nombre";
    const email = document.createElement("span");
    email.className = "admin-user-email";
    setEmailText(email, toText(user.email));
    identityCell.appendChild(name);
    identityCell.appendChild(email);
    // Otros correos con los que entra (0.7.22); el código va en su columna.
    const loginEmails = Array.isArray(user.loginEmails) ? user.loginEmails.map(toText).filter(Boolean) : [];
    if (loginEmails.length) {
      const extra = document.createElement("span");
      extra.className = "admin-user-email admin-user-login-emails";
      extra.textContent = `También entra con ${loginEmails.join(", ")}`;
      identityCell.appendChild(extra);
    }

    // Columna «Código» (dirección B, 0.7.22; antes «Rol»): el código del estudiante o por qué no
    // lo tiene. Un docente (o un administrador) no tiene código: su fila dice su rol.
    const roleCell = document.createElement("td");
    roleCell.className = "admin-code-cell";
    if (role === "teacher" || role === "admin") {
      roleCell.appendChild(chip(role === "admin" ? "Administrador" : "Profesor", "is-teacher"));
    } else if (toText(user.studentCode)) {
      roleCell.appendChild(chip(toText(user.studentCode), "is-code"));
    } else {
      roleCell.appendChild(chip(user.hasSignedIn ? "sin código · lo escribe al entrar" : "sin código · no ha entrado", "is-missing-code"));
    }

    const teacherCell = document.createElement("td");
    teacherCell.className = "admin-teacher-cell";
    teacherCell.textContent = role === "student"
      ? (toText(user.teacherDisplayName) || (toText(user.teacherUserId) ? "Profesor asignado" : "Profesor por defecto"))
      : "—";

    const coursesCell = document.createElement("td");
    coursesCell.className = "admin-course-cell";
    const codes = Array.isArray(user.assignedCourseCodes) ? user.assignedCourseCodes.map(normalizeRagCourseCodeUi).filter(Boolean) : [];
    if (role === "student" && codes.length) {
      const wrap = document.createElement("div");
      wrap.className = "admin-chip-row";
      codes.forEach((code) => {
        const courseChip = chip(code, "is-course");
        courseChip.title = courseNames.get(code) || code;
        wrap.appendChild(courseChip);
      });
      coursesCell.appendChild(wrap);
    } else {
      coursesCell.textContent = role === "student" ? "Sin cursos" : "—";
    }

    // «RAG aplicado» (0.7.15): por curso, el lote que le llega al estudiante (el asignado a
    // el, el activo del curso o la base). Lo calcula el backend (ragLots en GET /api/admin/users).
    const ragCell = document.createElement("td");
    ragCell.className = "admin-rag-cell";
    const ragLots = user.ragLots && typeof user.ragLots === "object" ? user.ragLots : {};
    if (role === "student" && codes.length) {
      const wrap = document.createElement("div");
      wrap.className = "admin-chip-row";
      codes.forEach((code) => {
        const applied = ragLots[code] && typeof ragLots[code] === "object" ? ragLots[code] : null;
        const lotName = toText(applied?.lotName) || "Base del curso";
        const origin = toText(applied?.origin);
        const lotChip = chip(codes.length > 1 ? `${code}: ${lotName}` : lotName, origin === "student" ? "is-lot-student" : "is-lot");
        lotChip.title = origin === "student"
          ? `${code}: lote asignado a este estudiante (${lotName})`
          : origin === "teacher"
            ? `${code}: lote activo del curso (${lotName})`
            : `${code}: base del curso`;
        wrap.appendChild(lotChip);
      });
      ragCell.appendChild(wrap);
    } else {
      ragCell.textContent = "—";
    }

    const statusCell = document.createElement("td");
    statusCell.appendChild(chip(inactive ? "Inactivo" : "Activo", inactive ? "is-inactive" : "is-active"));

    const actionsCell = document.createElement("td");
    actionsCell.className = "admin-actions-cell";
    actionsCell.appendChild(buildAdminUserEditButton("users", user, busy));
    actionsCell.appendChild(buildAdminUserDeleteButton("users", user, busy));

    row.appendChild(selectCell);
    row.appendChild(identityCell);
    row.appendChild(roleCell);
    row.appendChild(teacherCell);
    row.appendChild(coursesCell);
    row.appendChild(ragCell);
    row.appendChild(statusCell);
    row.appendChild(actionsCell);
    fragment.appendChild(row);

    if (!isEditing) return;

    // Fila de edicion: los campos a todo el ancho, debajo de la fila del usuario.
    const editRow = document.createElement("tr");
    editRow.className = "admin-edit-row";
    const editCell = document.createElement("td");
    editCell.colSpan = 8;
    editCell.appendChild(buildAdminUserEditForm("users", user, { busy, teacherMode, teachers }));
    editRow.appendChild(editCell);
    fragment.appendChild(editRow);
  });

  overlayEls.adminUsersTableBody.appendChild(fragment);
}

// Solicitudes de acceso (0.7.22): un correo nuevo con un codigo que ya tiene una cuenta en uso.
// Aprobar une ese correo (y la cuenta que ya tenia, si existe) a la cuenta del codigo.
function renderAdminAccessRequests(busy) {
  if (!overlayEls?.adminAccessRequests) return;
  const requests = Array.isArray(overlayState.adminAccessRequests) ? overlayState.adminAccessRequests : [];
  overlayEls.adminAccessRequests.hidden = requests.length === 0;
  const key = JSON.stringify([requests, busy]);
  if (!renderKeyChanged(overlayEls.adminAccessRequestList, key)) return;
  overlayEls.adminAccessRequestList.textContent = "";
  const decide = async (request, decision) => {
    const target = request?.target || {};
    const source = request?.source || null;
    if (decision === "approve") {
      const merge = source
        ? ` La cuenta que ya tenía ese correo${toText(source.email) ? ` (${toText(source.email)})` : ""} se unirá a la de ${toText(target.displayName)} y quedará desactivada.`
        : "";
      const confirmed = window.confirm(
        `${toText(request.email)} entrará a la cuenta de ${toText(target.displayName)} (código ${toText(request.studentCode)}).${merge} ¿Es la misma persona?`,
      );
      if (!confirmed) return;
    }
    overlayState.adminUsersBusy = true;
    overlayState.adminUsersMessage = decision === "approve" ? "Aprobando el acceso..." : "Rechazando el acceso...";
    renderOverlay();
    try {
      await decideAdminAccessRequest(toText(request.id), decision, toText(request.studentCode));
      await reloadAdminUsers();
      overlayState.adminUsersMessage = decision === "approve"
        ? `Listo: ${toText(request.email)} entra a la cuenta de ${toText(target.displayName)}.`
        : `Rechazado: ${toText(request.email)} no entra con el código ${toText(request.studentCode)}.`;
    } catch (error) {
      overlayState.adminUsersMessage = `No se pudo decidir la solicitud: ${String(error?.message || error)}`;
    } finally {
      overlayState.adminUsersBusy = false;
      renderOverlay();
    }
  };
  requests.forEach((request) => {
    const target = request?.target || {};
    const source = request?.source || null;
    const item = document.createElement("li");
    item.className = "admin-access-request";
    const text = document.createElement("p");
    text.className = "admin-access-request-text";
    const who = document.createElement("span");
    who.className = "admin-access-request-email";
    who.textContent = toText(request.email);
    text.appendChild(who);
    const requested = toText(request.displayName) ? ` (${toText(request.displayName)})` : "";
    text.appendChild(document.createTextNode(
      `${requested} escribió el código ${toText(request.studentCode)}, que es de ${toText(target.displayName)} (${toText(target.email)}).`,
    ));
    if (source) {
      text.appendChild(document.createTextNode(source.otherGroup
        ? " Ese correo ya tiene una cuenta en otro grupo: solo el administrador puede unirlas."
        : ` Ese correo ya tenía una cuenta${source.hasSignedIn ? " que se usó" : " que nunca entró"}: al aprobar se une a la otra.`));
    }
    const actions = document.createElement("div");
    actions.className = "admin-access-request-actions";
    const rejectBtn = document.createElement("button");
    rejectBtn.type = "button";
    rejectBtn.className = "ghost-button";
    rejectBtn.textContent = "Rechazar";
    rejectBtn.disabled = busy;
    rejectBtn.setAttribute("aria-label", `Rechazar el acceso de ${toText(request.email)}`);
    rejectBtn.addEventListener("click", () => decide(request, "reject"));
    const approveBtn = document.createElement("button");
    approveBtn.type = "button";
    approveBtn.className = "save-button";
    approveBtn.textContent = "Aprobar";
    approveBtn.disabled = busy || (!!source?.otherGroup && !isAdminSession());
    approveBtn.setAttribute("aria-label", `Aprobar que ${toText(request.email)} entre a la cuenta de ${toText(target.displayName)}`);
    approveBtn.addEventListener("click", () => decide(request, "approve"));
    actions.appendChild(rejectBtn);
    actions.appendChild(approveBtn);
    item.appendChild(text);
    item.appendChild(actions);
    overlayEls.adminAccessRequestList.appendChild(item);
  });
}

function normalizeAdminUsersQuery(value) {
  return toText(value).normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase().trim();
}

function adminUserMatchesQuery(user, query) {
  const haystack = [
    user?.displayName,
    user?.email,
    user?.studentCode,
    ...(Array.isArray(user?.loginEmails) ? user.loginEmails : []),
  ].map(normalizeAdminUsersQuery).join(" ");
  return query.split(/\s+/).every((word) => haystack.includes(word));
}

function bindAdminUsersPanel() {
  overlayEls.adminUsersSelectAll?.addEventListener("change", () => {
    const query = normalizeAdminUsersQuery(overlayState.adminUsersQuery);
    const visibleIds = (overlayState.adminUsers || [])
      .filter((user) => isAdminUserSelectable(user) && (!query || adminUserMatchesQuery(user, query)))
      .map((user) => toText(user.id));
    setAdminSelectionForVisible("users", visibleIds, overlayEls.adminUsersSelectAll.checked === true);
  });
  overlayEls.adminUsersBulkClearBtn?.addEventListener("click", () => {
    setAdminSelection("users", []);
    renderAdminUsersTable();
  });
  overlayEls.adminUsersBulkDeleteBtn?.addEventListener("click", async () => {
    await deleteSelectedAdminUsers();
  });
  overlayEls.adminUsersSearch?.addEventListener("input", () => {
    overlayState.adminUsersQuery = overlayEls.adminUsersSearch.value;
    overlayState.adminUsersMessage = "";
    renderAdminUsersTable();
  });
  overlayEls.adminToggleCreateUserBtn.addEventListener("click", () => {
    if (!canManageUsersSession() || overlayState.adminUsersBusy) return;
    overlayState.adminCreateFormOpen = !overlayState.adminCreateFormOpen;
    renderOverlay();
  });
  overlayEls.adminCreateRole.addEventListener("change", () => {
    renderAdminUsersTable();
  });
  overlayEls.adminReloadUsersBtn.addEventListener("click", async () => {
    if (!canManageUsersSession()) return;
    overlayState.adminUsersBusy = true;
    overlayState.adminUsersMessage = "Actualizando usuarios...";
    renderOverlay();
    try {
      await reloadAdminUsers();
      overlayState.adminUsersMessage = "Usuarios actualizados.";
    } catch (error) {
      overlayState.adminUsersMessage = `No se pudieron cargar usuarios: ${String(error)}`;
    } finally {
      overlayState.adminUsersBusy = false;
      renderOverlay();
    }
  });
  // Crear: el aviso sale en la lista desde donde se abrió el formulario («Usuarios» o
  // «Estudiantes») y se recargan las dos.
  overlayEls.adminCreateBtn.addEventListener("click", async () => {
    if (!canManageUsersSession()) return;
    const scope = currentAdminUsersScope();
    overlayState.adminUsersBusy = true;
    setAdminUsersActionMessage(scope, "Creando usuario...");
    renderOverlay();
    try {
      await createAdminUserFromForm();
      overlayEls.adminCreateName.value = "";
      overlayEls.adminCreateEmail.value = "";
      overlayEls.adminCreatePassword.value = "";
      overlayEls.adminCreateStudentCode.value = "";
      overlayEls.adminCreateTeacher.value = "";
      await refreshAfterAdminUsersChange();
      overlayState.adminCreateFormOpen = false;
      setAdminUsersActionMessage(scope, "Usuario creado correctamente.");
    } catch (error) {
      setAdminUsersActionMessage(scope, `No se pudo crear usuario: ${String(error)}`);
    } finally {
      overlayState.adminUsersBusy = false;
      renderOverlay();
    }
  });
}

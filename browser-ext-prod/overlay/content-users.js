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

  const users = Array.isArray(overlayState.adminUsers) ? overlayState.adminUsers : [];
  const teachers = Array.isArray(overlayState.adminTeachers) ? overlayState.adminTeachers : [];
  const busy = !!overlayState.adminUsersBusy;
  const teacherMode = isTeacherSession();
  const createFormOpen = !!overlayState.adminCreateFormOpen;
  const loadingMessage = teacherMode
    ? "Cargando estudiantes asignados"
    : "Cargando usuarios administrables";
  const defaultStatusMessage = teacherMode
    ? `Gestiona estudiantes asignados a tu cuenta (${users.length}).`
    : `Gestiona estudiantes y profesores (${users.length} usuario${users.length === 1 ? "" : "s"}).`;
  const statusMessage = overlayState.adminUsersMessage || (busy ? loadingMessage : defaultStatusMessage);

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

  const editingId = toText(overlayState.adminEditingUserId);
  const tableKey = JSON.stringify([
    users,
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
    cell.colSpan = 7;
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
    appendAdminUsersNotice("No hay usuarios administrables.", "admin-empty-cell");
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
    const userLabel = toText(user.displayName) || toText(user.email) || "usuario";
    const isEditing = editingId === userId;
    const inactive = user.isActive === false;

    const row = document.createElement("tr");
    row.className = `admin-user-row${isEditing ? " is-editing" : ""}${inactive ? " is-inactive" : ""}`;
    row.dataset.userId = userId;

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

    const roleCell = document.createElement("td");
    roleCell.appendChild(chip(role === "teacher" ? "Profesor" : "Estudiante", role === "teacher" ? "is-teacher" : ""));

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
    const editBtn = document.createElement("button");
    editBtn.type = "button";
    editBtn.className = "ghost-button";
    editBtn.textContent = isEditing ? "Cancelar" : "Editar";
    editBtn.setAttribute("aria-label", isEditing ? `Cancelar la edicion de ${userLabel}` : `Editar a ${userLabel}`);
    editBtn.setAttribute("aria-expanded", isEditing ? "true" : "false");
    editBtn.disabled = busy;
    editBtn.addEventListener("click", () => {
      overlayState.adminEditingUserId = isEditing ? "" : userId;
      renderOverlay();
    });

    const deleteBtn = document.createElement("button");
    deleteBtn.type = "button";
    // Accion destructiva: con el estilo de peligro, no como el boton principal.
    deleteBtn.className = "ghost-button danger-button";
    deleteBtn.textContent = "Eliminar";
    deleteBtn.setAttribute("aria-label", `Eliminar (desactivar) a ${userLabel}`);
    deleteBtn.disabled = busy || inactive;
    deleteBtn.addEventListener("click", async () => {
      const confirmed = window.confirm(`Se desactivara el usuario ${toText(user.displayName)}. Deseas continuar?`);
      if (!confirmed) return;
      overlayState.adminUsersBusy = true;
      overlayState.adminUsersMessage = `Desactivando ${toText(user.displayName)}...`;
      renderOverlay();
      try {
        await deleteAdminUser(userId);
        await reloadAdminUsers();
        if (overlayState.adminEditingUserId === userId) overlayState.adminEditingUserId = "";
        overlayState.adminUsersMessage = "Usuario desactivado.";
      } catch (error) {
        overlayState.adminUsersMessage = `No se pudo eliminar: ${String(error)}`;
      } finally {
        overlayState.adminUsersBusy = false;
        renderOverlay();
      }
    });
    actionsCell.appendChild(editBtn);
    actionsCell.appendChild(deleteBtn);

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
    editCell.colSpan = 7;
    const form = document.createElement("div");
    form.className = "admin-edit-form";
    form.setAttribute("role", "group");
    form.setAttribute("aria-label", `Editar a ${userLabel}`);

    const makeField = (labelText, control, className = "") => {
      const field = document.createElement("label");
      field.className = `admin-edit-field${className ? ` ${className}` : ""}`;
      const caption = document.createElement("span");
      caption.textContent = labelText;
      field.appendChild(caption);
      field.appendChild(control);
      return field;
    };

    const nameInput = document.createElement("input");
    nameInput.type = "text";
    nameInput.value = toText(user.displayName);
    nameInput.disabled = busy;
    nameInput.setAttribute("aria-label", `Nombre de ${userLabel}`);

    const emailInput = document.createElement("input");
    emailInput.type = "text";
    emailInput.value = toText(user.email);
    emailInput.disabled = busy;
    emailInput.setAttribute("aria-label", `Correo de ${userLabel}`);

    const roleSelect = document.createElement("select");
    roleSelect.disabled = busy || teacherMode;
    roleSelect.setAttribute("aria-label", `Rol de ${userLabel}`);
    [
      { value: "student", label: "Estudiante" },
      { value: "teacher", label: "Profesor" },
    ].forEach((item) => {
      const option = document.createElement("option");
      option.value = item.value;
      option.textContent = item.label;
      if (item.value === role) option.selected = true;
      roleSelect.appendChild(option);
    });

    const teacherSelect = document.createElement("select");
    teacherSelect.disabled = busy || teacherMode || roleSelect.value !== "student";
    teacherSelect.setAttribute("aria-label", `Profesor de ${userLabel}`);
    const emptyOption = document.createElement("option");
    emptyOption.value = "";
    emptyOption.textContent = "Profesor por defecto";
    teacherSelect.appendChild(emptyOption);
    for (const teacher of teachers) {
      const option = document.createElement("option");
      option.value = toText(teacher.id);
      option.textContent = toText(teacher.displayName);
      if (toText(user.teacherUserId) === option.value) option.selected = true;
      teacherSelect.appendChild(option);
    }

    const courseGrid = document.createElement("div");
    courseGrid.className = "course-chip-grid";
    courseGrid.setAttribute("role", "group");
    courseGrid.setAttribute("aria-label", `Cursos de ${userLabel}`);
    renderCourseCheckboxGroup(courseGrid, user.assignedCourseCodes || ["FPOO"], {
      disabled: busy || roleSelect.value !== "student",
      fallbackToDefault: roleSelect.value === "student",
    });

    function syncRowStudentControls() {
      teacherSelect.disabled = busy || teacherMode || roleSelect.value !== "student";
      const disabledCourses = busy || roleSelect.value !== "student";
      courseGrid.querySelectorAll("input[type='checkbox']").forEach((input) => {
        input.disabled = disabledCourses;
      });
      if (roleSelect.value !== "student") {
        teacherSelect.value = "";
      } else if (!courseGrid.querySelector("input[type='checkbox']:checked")) {
        const firstCourseInput = courseGrid.querySelector("input[type='checkbox']");
        if (firstCourseInput) firstCourseInput.checked = true;
      }
    }
    roleSelect.addEventListener("change", () => {
      syncRowStudentControls();
    });

    const saveBtn = document.createElement("button");
    saveBtn.type = "button";
    saveBtn.className = "save-button";
    saveBtn.textContent = "Guardar";
    saveBtn.setAttribute("aria-label", `Guardar cambios de ${userLabel}`);
    saveBtn.disabled = busy;
    saveBtn.addEventListener("click", async () => {
      overlayState.adminUsersBusy = true;
      overlayState.adminUsersMessage = `Guardando cambios de ${toText(user.displayName)}...`;
      renderOverlay();
      try {
        const payload = {
          role: roleSelect.value === "teacher" ? "teacher" : "student",
          displayName: nameInput.value.trim(),
          email: emailInput.value.trim(),
          teacherUserId: roleSelect.value === "student"
            ? (teacherMode ? toText(overlayState.session?.user?.id) : toText(teacherSelect.value) || null)
            : null,
          assignedCourseCodes: roleSelect.value === "student" ? getCheckedCourseCodes(courseGrid) : [],
        };
        await updateAdminUserRow(userId, payload);
        await reloadAdminUsers();
        overlayState.adminEditingUserId = "";
        overlayState.adminUsersMessage = "Usuario actualizado.";
      } catch (error) {
        overlayState.adminUsersMessage = `No se pudo actualizar: ${String(error)}`;
      } finally {
        overlayState.adminUsersBusy = false;
        renderOverlay();
      }
    });

    const cancelBtn = document.createElement("button");
    cancelBtn.type = "button";
    cancelBtn.className = "ghost-button";
    cancelBtn.textContent = "Cancelar";
    cancelBtn.disabled = busy;
    cancelBtn.addEventListener("click", () => {
      overlayState.adminEditingUserId = "";
      renderOverlay();
    });

    const rowOne = document.createElement("div");
    rowOne.className = "admin-edit-grid";
    rowOne.appendChild(makeField("Nombre completo", nameInput));
    rowOne.appendChild(makeField("Correo", emailInput));
    const rowTwo = document.createElement("div");
    rowTwo.className = "admin-edit-grid";
    rowTwo.appendChild(makeField("Rol", roleSelect));
    rowTwo.appendChild(makeField("Profesor asignado", teacherSelect));
    const coursesField = makeField("Cursos del estudiante", courseGrid, "is-wide");
    const actions = document.createElement("div");
    actions.className = "admin-edit-actions";
    actions.appendChild(cancelBtn);
    actions.appendChild(saveBtn);
    form.appendChild(rowOne);
    form.appendChild(rowTwo);
    form.appendChild(coursesField);
    // Lote de RAG por curso (0.7.15): el docente elige, para cada curso del estudiante, si
    // sigue el lote activo del curso o uno concreto. Se guarda al cambiar (PUT
    // /api/rag/students/:id/lot), sin esperar a «Guardar».
    if (teacherMode && role === "student" && codes.length) {
      const lotGrid = document.createElement("div");
      lotGrid.className = "admin-lot-grid";
      lotGrid.setAttribute("role", "group");
      lotGrid.setAttribute("aria-label", `Lote de RAG de ${userLabel} por curso`);
      const lotCourses = Array.isArray(overlayState.ragLots?.courses) ? overlayState.ragLots.courses : [];
      codes.forEach((code) => {
        const courseLots = lotCourses.find((course) => normalizeRagCourseCodeUi(course?.courseCode) === code);
        const applied = ragLots[code] && typeof ragLots[code] === "object" ? ragLots[code] : null;
        const select = document.createElement("select");
        select.disabled = busy;
        select.setAttribute("aria-label", `Lote de RAG de ${userLabel} en ${code}`);
        const followOption = document.createElement("option");
        followOption.value = "";
        followOption.textContent = `Lote activo del curso (${toText(courseLots?.activeLotName) || "Base del curso"})`;
        select.appendChild(followOption);
        (Array.isArray(courseLots?.lots) ? courseLots.lots : []).forEach((lot) => {
          const option = document.createElement("option");
          option.value = toText(lot.id);
          option.textContent = toText(lot.name);
          select.appendChild(option);
        });
        select.value = applied?.origin === "student" && toText(applied.lotId) ? toText(applied.lotId) : "";
        if (select.value !== (applied?.origin === "student" ? toText(applied.lotId) : "")) select.value = "";
        select.addEventListener("change", async () => {
          overlayState.adminUsersBusy = true;
          overlayState.adminUsersMessage = `Guardando el lote de RAG de ${toText(user.displayName)} en ${code}...`;
          renderOverlay();
          try {
            await requestRagLotChange(`/api/rag/students/${encodeURIComponent(userId)}/lot`, "PUT", {
              courseCode: code,
              lotId: select.value || null,
            });
            await reloadAdminUsers();
            overlayState.adminUsersMessage = select.value
              ? `Lote de RAG guardado para ${toText(user.displayName)} en ${code}.`
              : `${toText(user.displayName)} vuelve al lote activo de ${code}.`;
          } catch (error) {
            overlayState.adminUsersMessage = `No se pudo cambiar el lote: ${String(error?.message || error)}`;
          } finally {
            overlayState.adminUsersBusy = false;
            renderOverlay();
          }
        });
        lotGrid.appendChild(makeField(`RAG en ${code}`, select));
      });
      form.appendChild(makeField("Lote de RAG aplicado (se guarda al cambiar)", lotGrid, "is-wide"));
    }
    form.appendChild(actions);
    editCell.appendChild(form);
    editRow.appendChild(editCell);
    fragment.appendChild(editRow);
  });

  overlayEls.adminUsersTableBody.appendChild(fragment);
}

function bindAdminUsersPanel() {
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
  overlayEls.adminCreateBtn.addEventListener("click", async () => {
    if (!canManageUsersSession()) return;
    overlayState.adminUsersBusy = true;
    overlayState.adminUsersMessage = "Creando usuario...";
    renderOverlay();
    try {
      await createAdminUserFromForm();
      overlayEls.adminCreateName.value = "";
      overlayEls.adminCreateEmail.value = "";
      overlayEls.adminCreatePassword.value = "";
      overlayEls.adminCreateTeacher.value = "";
      await reloadAdminUsers();
      overlayState.adminCreateFormOpen = false;
      overlayState.adminUsersMessage = "Usuario creado correctamente.";
    } catch (error) {
      overlayState.adminUsersMessage = `No se pudo crear usuario: ${String(error)}`;
    } finally {
      overlayState.adminUsersBusy = false;
      renderOverlay();
    }
  });
}

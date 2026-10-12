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
    const userLabel = toText(user.displayName) || toText(user.email) || "usuario";
    const isEditing = editingId === userId;
    const inactive = user.isActive === false;

    const row = document.createElement("tr");
    row.className = `admin-user-row${isEditing ? " is-editing" : ""}${inactive ? " is-inactive" : ""}`;
    row.dataset.userId = userId;

    // Casilla para «Eliminar seleccionados» (0.7.22): solo en las filas de estudiantes.
    const selectCell = document.createElement("td");
    selectCell.className = "admin-select-cell";
    if (isAdminUserSelectable(user)) {
      const box = document.createElement("input");
      box.type = "checkbox";
      box.checked = selected.has(userId);
      box.disabled = busy;
      box.setAttribute("aria-label", `Seleccionar a ${userLabel}`);
      box.addEventListener("change", () => {
        toggleAdminUserSelection(userId, box.checked);
      });
      selectCell.appendChild(box);
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

    const codeInput = document.createElement("input");
    codeInput.type = "text";
    codeInput.inputMode = "numeric";
    codeInput.autocomplete = "off";
    codeInput.value = toText(user.studentCode);
    codeInput.placeholder = "7 dígitos";
    codeInput.disabled = busy || role !== "student";
    codeInput.setAttribute("aria-label", `Código de estudiante de ${userLabel}`);

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
        // Solo si cambio: vacio lo quita (el estudiante lo vuelve a escribir al entrar).
        const typedCode = codeInput.value.trim();
        if (role === "student" && payload.role === "student" && typedCode !== toText(user.studentCode)) {
          payload.studentCode = typedCode || null;
        }
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
    let codeRow = null;
    if (role === "student") {
      const rowCode = document.createElement("div");
      rowCode.className = "admin-edit-grid";
      rowCode.appendChild(makeField("Código de estudiante", codeInput));
      // Otros correos con los que entra: se pueden quitar (si se aprobo por error).
      const accessList = document.createElement("div");
      accessList.className = "admin-login-email-list";
      if (loginEmails.length) {
        loginEmails.forEach((loginEmail) => {
          const item = document.createElement("div");
          item.className = "admin-login-email-item";
          const label = document.createElement("span");
          label.textContent = loginEmail;
          const removeBtn = document.createElement("button");
          removeBtn.type = "button";
          removeBtn.className = "ghost-button danger-button";
          removeBtn.textContent = "Quitar";
          removeBtn.disabled = busy;
          removeBtn.setAttribute("aria-label", `Quitar el acceso ${loginEmail} de ${userLabel}`);
          removeBtn.addEventListener("click", async () => {
            const confirmed = window.confirm(`${loginEmail} ya no entrará a la cuenta de ${userLabel}. ¿Continuar?`);
            if (!confirmed) return;
            overlayState.adminUsersBusy = true;
            overlayState.adminUsersMessage = `Quitando ${loginEmail}...`;
            renderOverlay();
            try {
              await removeAdminLoginEmail(userId, loginEmail);
              await reloadAdminUsers();
              overlayState.adminUsersMessage = `${loginEmail} ya no entra a la cuenta de ${userLabel}.`;
            } catch (error) {
              overlayState.adminUsersMessage = `No se pudo quitar el acceso: ${String(error?.message || error)}`;
            } finally {
              overlayState.adminUsersBusy = false;
              renderOverlay();
            }
          });
          item.appendChild(label);
          item.appendChild(removeBtn);
          accessList.appendChild(item);
        });
      } else {
        accessList.textContent = "Solo su correo principal.";
      }
      rowCode.appendChild(makeField("Otros correos de acceso", accessList));
      codeRow = rowCode;
    }
    const coursesField = makeField("Cursos del estudiante", courseGrid, "is-wide");
    const actions = document.createElement("div");
    actions.className = "admin-edit-actions";
    actions.appendChild(cancelBtn);
    actions.appendChild(saveBtn);
    form.appendChild(rowOne);
    form.appendChild(rowTwo);
    if (codeRow) form.appendChild(codeRow);
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

// ---- «Eliminar seleccionados» (0.7.22) ----

function isAdminUserSelectable(user) {
  return toText(user?.role).toLowerCase() === "student";
}

function toggleAdminUserSelection(userId, checked) {
  const current = new Set((overlayState.adminSelectedUserIds || []).map(toText));
  if (checked) current.add(toText(userId));
  else current.delete(toText(userId));
  overlayState.adminSelectedUserIds = [...current];
  renderAdminUsersTable();
}

// Barra con el conteo, «Quitar selección» y «Eliminar seleccionados», y el estado de
// «Seleccionar todos» (marcado, a medias o vacío según los visibles).
function renderAdminUsersBulkBar(count, selectableIds, selected, busy) {
  if (overlayEls.adminUsersBulkBar) overlayEls.adminUsersBulkBar.hidden = count === 0;
  setTextIfChanged(overlayEls.adminUsersBulkCount, count === 1 ? "1 seleccionado" : `${count} seleccionados`);
  if (overlayEls.adminUsersBulkDeleteBtn) overlayEls.adminUsersBulkDeleteBtn.disabled = busy || count === 0;
  if (overlayEls.adminUsersBulkClearBtn) overlayEls.adminUsersBulkClearBtn.disabled = busy || count === 0;
  const box = overlayEls.adminUsersSelectAll;
  if (!box) return;
  const visibleSelected = selectableIds.filter((id) => selected.has(id)).length;
  box.disabled = busy || selectableIds.length === 0;
  box.checked = selectableIds.length > 0 && visibleSelected === selectableIds.length;
  box.indeterminate = visibleSelected > 0 && visibleSelected < selectableIds.length;
}

function describeAdminUsersRemoval(result) {
  const deleted = Array.isArray(result?.deleted) ? result.deleted.length : 0;
  const deactivated = Array.isArray(result?.deactivated) ? result.deactivated.length : 0;
  const skipped = Array.isArray(result?.skipped) ? result.skipped : [];
  const parts = [];
  if (deleted) parts.push(deleted === 1 ? "1 eliminado" : `${deleted} eliminados`);
  if (deactivated) parts.push(`${deactivated === 1 ? "1 desactivado" : `${deactivated} desactivados`} (ya habían entrado: conservan sus datos)`);
  if (skipped.length) {
    const reasons = [...new Set(skipped.map((entry) => toText(entry?.reason)).filter(Boolean))].join(" ");
    parts.push(`${skipped.length === 1 ? "1 sin cambios" : `${skipped.length} sin cambios`}${reasons ? ` (${reasons.replace(/\.$/, "")})` : ""}`);
  }
  const summary = parts.length ? `Listo: ${parts.join(", ")}.` : "No se eliminó a nadie.";
  return deleted ? `${summary} Si se importaron con el nombre errado, vuelve a importar la lista.` : summary;
}

async function deleteSelectedAdminUsers() {
  if (!canManageUsersSession() || overlayState.adminUsersBusy) return;
  const ids = (overlayState.adminSelectedUserIds || []).map(toText).filter(Boolean);
  if (!ids.length) return;
  const chosen = (overlayState.adminUsers || []).filter((user) => ids.includes(toText(user.id)));
  const signedIn = chosen.filter((user) => user.hasSignedIn === true).length;
  const neverSignedIn = chosen.length - signedIn;
  const lines = [chosen.length === 1 ? "Vas a eliminar 1 estudiante." : `Vas a eliminar ${chosen.length} estudiantes.`];
  if (neverSignedIn) {
    lines.push(`${neverSignedIn === 1 ? "1 nunca ha entrado: se borra" : `${neverSignedIn} nunca han entrado: se borran`} del todo (puedes volver a importarlos con el nombre correcto).`);
  }
  if (signedIn) {
    lines.push(`${signedIn === 1 ? "1 ya entró: se desactiva" : `${signedIn} ya entraron: se desactivan`} y conserva${signedIn === 1 ? "" : "n"} sus datos del piloto.`);
  }
  lines.push("¿Continuar?");
  if (!window.confirm(lines.join("\n"))) return;
  overlayState.adminUsersBusy = true;
  overlayState.adminUsersMessage = ids.length === 1 ? "Eliminando 1 estudiante..." : `Eliminando ${ids.length} estudiantes...`;
  renderOverlay();
  try {
    const result = await bulkDeleteAdminUsers(ids);
    overlayState.adminSelectedUserIds = [];
    if (ids.includes(toText(overlayState.adminEditingUserId))) overlayState.adminEditingUserId = "";
    await reloadAdminUsers();
    overlayState.adminUsersMessage = describeAdminUsersRemoval(result);
  } catch (error) {
    overlayState.adminUsersMessage = `No se pudieron eliminar: ${toText(error?.message) || String(error)}`;
  } finally {
    overlayState.adminUsersBusy = false;
    renderOverlay();
  }
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
    const users = (overlayState.adminUsers || []).filter((user) => {
      const query = normalizeAdminUsersQuery(overlayState.adminUsersQuery);
      return isAdminUserSelectable(user) && (!query || adminUserMatchesQuery(user, query));
    });
    const current = new Set((overlayState.adminSelectedUserIds || []).map(toText));
    for (const user of users) {
      if (overlayEls.adminUsersSelectAll.checked) current.add(toText(user.id));
      else current.delete(toText(user.id));
    }
    overlayState.adminSelectedUserIds = [...current];
    renderAdminUsersTable();
  });
  overlayEls.adminUsersBulkClearBtn?.addEventListener("click", () => {
    overlayState.adminSelectedUserIds = [];
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
      overlayEls.adminCreateStudentCode.value = "";
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

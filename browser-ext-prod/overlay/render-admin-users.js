// ADACEEN | Capa 4 - UI: tabla de administracion de usuarios y modal de curso del estudiante.
// Orden de carga: manifest.json (content_scripts) y background.js (CONTENT_SCRIPT_FILES) deben coincidir.
"use strict";

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
  overlayEls.adminCreateTeacher.innerHTML = "";
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
  renderAdminCreateCourseGrid();

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

  const fragment = document.createDocumentFragment();
  users.forEach((user) => {
    const row = document.createElement("tr");
    const role = toText(user.role).toLowerCase() === "teacher" ? "teacher" : "student";

    const nameCell = document.createElement("td");
    const nameInput = document.createElement("input");
    nameInput.type = "text";
    nameInput.value = toText(user.displayName);
    nameInput.disabled = busy;
    nameCell.appendChild(nameInput);

    const emailCell = document.createElement("td");
    const emailInput = document.createElement("input");
    emailInput.type = "text";
    emailInput.value = toText(user.email);
    emailInput.disabled = busy;
    emailCell.appendChild(emailInput);

    const roleCell = document.createElement("td");
    const roleSelect = document.createElement("select");
    roleSelect.disabled = busy || teacherMode;
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
    roleCell.appendChild(roleSelect);

    const teacherCell = document.createElement("td");
    const teacherSelect = document.createElement("select");
    teacherSelect.disabled = busy || teacherMode || roleSelect.value !== "student";
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
    teacherCell.appendChild(teacherSelect);

    const coursesCell = document.createElement("td");
    coursesCell.className = "admin-course-cell";
    const courseGrid = document.createElement("div");
    courseGrid.className = "course-chip-grid";
    renderCourseCheckboxGroup(courseGrid, user.assignedCourseCodes || ["FPOO"], {
      disabled: busy || roleSelect.value !== "student",
      fallbackToDefault: roleSelect.value === "student",
    });
    coursesCell.appendChild(courseGrid);

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

    const statusCell = document.createElement("td");
    statusCell.textContent = user.isActive === false ? "Inactivo" : "Activo";

    const actionsCell = document.createElement("td");
    actionsCell.className = "admin-actions-cell";
    const saveBtn = document.createElement("button");
    saveBtn.type = "button";
    saveBtn.className = "ghost-button";
    saveBtn.textContent = "Guardar";
    saveBtn.disabled = busy;

    const deleteBtn = document.createElement("button");
    deleteBtn.type = "button";
    deleteBtn.className = "save-button";
    deleteBtn.textContent = "Eliminar";
    deleteBtn.disabled = busy || user.isActive === false;

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
        await updateAdminUserRow(toText(user.id), payload);
        await reloadAdminUsers();
        overlayState.adminUsersMessage = "Usuario actualizado.";
      } catch (error) {
        overlayState.adminUsersMessage = `No se pudo actualizar: ${String(error)}`;
      } finally {
        overlayState.adminUsersBusy = false;
        renderOverlay();
      }
    });

    deleteBtn.addEventListener("click", async () => {
      const confirmed = window.confirm(`Se desactivara el usuario ${toText(user.displayName)}. Deseas continuar?`);
      if (!confirmed) return;
      overlayState.adminUsersBusy = true;
      overlayState.adminUsersMessage = `Desactivando ${toText(user.displayName)}...`;
      renderOverlay();
      try {
        await deleteAdminUser(toText(user.id));
        await reloadAdminUsers();
        overlayState.adminUsersMessage = "Usuario desactivado.";
      } catch (error) {
        overlayState.adminUsersMessage = `No se pudo eliminar: ${String(error)}`;
      } finally {
        overlayState.adminUsersBusy = false;
        renderOverlay();
      }
    });

    actionsCell.appendChild(saveBtn);
    actionsCell.appendChild(deleteBtn);

    row.appendChild(nameCell);
    row.appendChild(emailCell);
    row.appendChild(roleCell);
    row.appendChild(teacherCell);
    row.appendChild(coursesCell);
    row.appendChild(statusCell);
    row.appendChild(actionsCell);
    fragment.appendChild(row);
  });

  overlayEls.adminUsersTableBody.appendChild(fragment);
}

function renderStudentCourseModal() {
  if (!overlayEls?.studentCourseModal) return;
  const visible = !!overlayState.studentCourseModalOpen && overlayState.session?.user?.role === "student";
  overlayEls.studentCourseModal.hidden = !visible;
  if (!visible) return;

  const state = overlayState.studentCourseState || EMPTY_STUDENT_COURSE_STATE;
  const assigned = getStudentAssignedCourseCodes();
  const courses = (Array.isArray(state.courses) && state.courses.length ? state.courses : getRagCourseCatalog())
    .filter((course) => assigned.includes(normalizeRagCourseCodeUi(course?.code)));
  const selected = getSelectedStudentCourseCode();

  overlayEls.studentCourseCopy.textContent = courses.length > 1
    ? "Escoge el curso que quieres practicar ahora; las recomendaciones usaran sus fuentes RAG."
    : "Tu docente asigno este curso para practicar; ADACEEN usara sus fuentes RAG.";
  overlayEls.studentCourseOptions.textContent = "";

  if (!courses.length) {
    const empty = document.createElement("p");
    empty.className = "course-empty";
    empty.textContent = state.busy ? "Cargando cursos asignados..." : "No hay cursos asignados. Se usara FPOO por defecto.";
    overlayEls.studentCourseOptions.appendChild(empty);
  } else {
    const fragment = document.createDocumentFragment();
    for (const course of courses) {
      const code = normalizeRagCourseCodeUi(course?.code);
      const button = document.createElement("button");
      button.type = "button";
      button.className = "student-course-option";
      button.classList.toggle("is-selected", code === selected);
      button.disabled = !!state.busy;
      button.dataset.courseCode = code;
      const title = document.createElement("strong");
      title.textContent = toText(course?.shortName || course?.code || code);
      const copy = document.createElement("span");
      copy.textContent = toText(course?.name || code);
      button.append(title, copy);
      button.addEventListener("click", () => {
        const previous = normalizeRagCourseCodeUi(overlayState.studentCourseState?.selectedCourseCode || "");
        overlayState.studentCourseState = {
          ...(overlayState.studentCourseState || EMPTY_STUDENT_COURSE_STATE),
          selectedCourseCode: code,
          error: "",
          message: "",
        };
        if (previous && previous !== code) {
          overlayState.campusCourseAccess = { ...EMPTY_CAMPUS_COURSE_ACCESS_STATE };
          overlayState.campusAnalysis = null;
        }
        renderOverlay();
      });
      fragment.appendChild(button);
    }
    overlayEls.studentCourseOptions.appendChild(fragment);
  }

  overlayEls.studentCourseStatus.textContent = state.error || state.message || `Curso activo: ${selected}.`;
  const hasEnabledCourses = courses.length > 0;
  overlayEls.studentCourseLogoutBtn.textContent = hasEnabledCourses ? "Cancelar" : "Cerrar sesion";
  overlayEls.studentCourseLogoutBtn.dataset.courseModalAction = hasEnabledCourses ? "cancel" : "logout";
  overlayEls.studentCourseConfirmBtn.disabled = !!state.busy;
  overlayEls.studentCourseLogoutBtn.disabled = !!state.busy;
}

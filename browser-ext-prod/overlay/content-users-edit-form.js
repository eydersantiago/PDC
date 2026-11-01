// ADACEEN | Capa 4 - UI: formulario de edición de una cuenta en «Usuarios» y «Estudiantes» (0.7.22).
// Movido sin cambios de content-users.js.

// Formulario de edición de una cuenta, el mismo en las dos listas: nombre, correo, rol, docente,
// código y otros correos de acceso (estudiantes), cursos y, para el docente, el lote de RAG.
function buildAdminUserEditForm(scope, user, options = {}) {
  const busy = !!options.busy;
  const teacherMode = !!options.teacherMode;
  const teachers = Array.isArray(options.teachers) ? options.teachers : [];
  const role = toText(user.role).toLowerCase() === "teacher" ? "teacher" : "student";
  const userId = toText(user.id);
  const userLabel = toText(user.displayName) || toText(user.email) || "usuario";
  const loginEmails = Array.isArray(user.loginEmails) ? user.loginEmails.map(toText).filter(Boolean) : [];
  const codes = Array.isArray(user.assignedCourseCodes) ? user.assignedCourseCodes.map(normalizeRagCourseCodeUi).filter(Boolean) : [];
  const ragLots = user.ragLots && typeof user.ragLots === "object" ? user.ragLots : {};

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

  // Guardar, quitar un acceso o cambiar el lote: bloquea, avisa en la lista y recarga las dos.
  const runChange = async (startMessage, work, doneMessage, failPrefix) => {
    overlayState.adminUsersBusy = true;
    setAdminUsersActionMessage(scope, startMessage);
    renderOverlay();
    try {
      const closeEditor = await work();
      if (closeEditor) setAdminEditingId(scope, "");
      await refreshAfterAdminUsersChange();
      setAdminUsersActionMessage(scope, typeof doneMessage === "function" ? doneMessage() : doneMessage);
    } catch (error) {
      setAdminUsersActionMessage(scope, `${failPrefix}: ${String(error?.message || error)}`);
    } finally {
      overlayState.adminUsersBusy = false;
      renderOverlay();
    }
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
  saveBtn.addEventListener("click", () => runChange(`Guardando cambios de ${toText(user.displayName)}...`, async () => {
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
    return true;
  }, "Usuario actualizado.", "No se pudo actualizar"));

  const cancelBtn = document.createElement("button");
  cancelBtn.type = "button";
  cancelBtn.className = "ghost-button";
  cancelBtn.textContent = "Cancelar";
  cancelBtn.disabled = busy;
  cancelBtn.addEventListener("click", () => {
    setAdminEditingId(scope, "");
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
        removeBtn.addEventListener("click", () => {
          const confirmed = window.confirm(`${loginEmail} ya no entrará a la cuenta de ${userLabel}. ¿Continuar?`);
          if (!confirmed) return;
          runChange(`Quitando ${loginEmail}...`, async () => {
            await removeAdminLoginEmail(userId, loginEmail);
            return false;
          }, `${loginEmail} ya no entra a la cuenta de ${userLabel}.`, "No se pudo quitar el acceso");
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
      select.addEventListener("change", () => {
        const lotId = select.value || null;
        runChange(`Guardando el lote de RAG de ${toText(user.displayName)} en ${code}...`, async () => {
          await requestRagLotChange(`/api/rag/students/${encodeURIComponent(userId)}/lot`, "PUT", {
            courseCode: code,
            lotId,
          });
          return false;
        }, () => (lotId
          ? `Lote de RAG guardado para ${toText(user.displayName)} en ${code}.`
          : `${toText(user.displayName)} vuelve al lote activo de ${code}.`), "No se pudo cambiar el lote");
      });
      lotGrid.appendChild(makeField(`RAG en ${code}`, select));
    });
    form.appendChild(makeField("Lote de RAG aplicado (se guarda al cambiar)", lotGrid, "is-wide"));
  }
  form.appendChild(actions);
  return form;
}

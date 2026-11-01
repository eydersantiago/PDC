"use strict";

// ADACEEN | Capa 4 - UI: tabla de progreso de «Estudiantes» (una fila por estudiante).
// Movido sin cambios de content-students.js.

/** «Sistema bancario: 60 % · compila» (o sin carpeta / sin editor); "" sin dato del taller. */
function formatStudentWorkshop(workshop) {
  if (!workshop || typeof workshop !== "object") return "";
  const title = toText(workshop.titulo) || toText(workshop.taller) || "Taller";
  if (workshop.status === "sin-editor") return `${title}: no ha abierto su editor`;
  if (workshop.status !== "en-curso") return `${title}: sin la carpeta del taller`;
  const percent = Number.isFinite(Number(workshop.percent)) ? Math.max(0, Math.min(100, Math.round(Number(workshop.percent)))) : 0;
  const build = workshop.compiles === true ? " · compila" : workshop.compiles === false ? " · no compila" : "";
  return `${title}: ${percent} %${build}`;
}

function renderStudentsTable(panel) {
  const body = overlayEls?.studentsTableBody;
  if (!body) return;
  const visible = filterStudentsPanelItems(panel.items, panel.query);
  const now = Date.now();
  // Gestión como en «Usuarios» (0.7.22): casilla, «Editar» y «Eliminar» por fila, con la cuenta
  // de GET /api/admin/users (código, otros correos, si ya entró).
  const busy = !!overlayState.adminUsersBusy;
  const accounts = new Map((Array.isArray(overlayState.adminUsers) ? overlayState.adminUsers : []).map((user) => [toText(user.id), user]));
  const checked = new Set(getAdminSelection("students"));
  const visibleIds = visible.map((item) => toText(item.id));
  const editingId = toText(panel.editingId);
  const editingAccount = editingId ? accounts.get(editingId) || null : null;
  const teachers = Array.isArray(overlayState.adminTeachers) ? overlayState.adminTeachers : [];
  const key = JSON.stringify([
    visible,
    panel.selectedId,
    panel.busy,
    panel.error,
    // Con una fila en edición no se repinta cada minuto: se perdería lo escrito.
    editingAccount ? "editando" : Math.floor(now / 60000),
    [...checked],
    busy,
    editingId,
    editingAccount,
    visibleIds.map((id) => [accounts.get(id)?.isActive, accounts.get(id)?.hasSignedIn]),
    teachers.map((teacher) => [toText(teacher.id), toText(teacher.displayName)]),
    getRagCourseCatalog().map((course) => toText(course?.code)),
    overlayState.ragLots?.courses || [],
  ]);
  if (!renderKeyChanged(body, key)) return;
  body.textContent = "";

  const appendNotice = (message, className, loading = false) => {
    const row = document.createElement("tr");
    const cell = document.createElement("td");
    cell.colSpan = 8;
    cell.className = `${className}${loading ? " is-loading-note" : ""}`;
    cell.textContent = message;
    row.appendChild(cell);
    body.appendChild(row);
  };

  if (panel.busy && panel.items.length === 0) {
    appendNotice("Cargando progreso de los estudiantes", "admin-loading-cell", true);
    return;
  }
  if (panel.error && panel.items.length === 0) {
    appendNotice(panel.error, "admin-empty-cell");
    return;
  }
  if (panel.items.length === 0) {
    appendNotice(isTeacherSession()
      ? "Aun no tienes estudiantes asignados. Crealos en la pestaña Usuarios."
      : "No hay estudiantes registrados.", "admin-empty-cell");
    return;
  }
  if (visible.length === 0) {
    appendNotice("Ningun estudiante coincide con la busqueda.", "admin-empty-cell");
    return;
  }

  const fragment = document.createDocumentFragment();
  for (const item of visible) {
    const id = toText(item.id);
    const row = document.createElement("tr");
    const isEditing = editingId === id && !!editingAccount;
    row.className = `student-row${panel.selectedId === id ? " is-selected" : ""}${item.isActive === false ? " is-inactive" : ""}${isEditing ? " is-editing" : ""}`;
    row.dataset.userId = id;
    row.setAttribute("aria-label", `Ver detalle de ${toText(item.displayName) || toText(item.email)}`);

    // La casilla y las acciones no abren el detalle de la fila.
    const stopRowClick = (event) => event?.stopPropagation?.();
    const selectCell = document.createElement("td");
    selectCell.className = "admin-select-cell";
    selectCell.addEventListener("click", stopRowClick);
    selectCell.appendChild(buildAdminSelectBox("students", item, checked, visibleIds, busy));

    const studentCell = document.createElement("td");
    studentCell.className = "student-cell";
    const dot = document.createElement("span");
    dot.className = `online-dot${item.sessions?.activeNow ? "" : " is-off"}`;
    dot.title = item.sessions?.activeNow ? "Activo ahora" : "Sin sesion activa";
    // El nombre es un boton: abre el detalle tambien desde el teclado (la fila no recibe foco).
    const name = document.createElement("button");
    name.type = "button";
    name.className = "student-name";
    name.setAttribute("aria-label", `Ver detalle de ${toText(item.displayName) || toText(item.email)}`);
    name.appendChild(dot);
    name.appendChild(document.createTextNode(toText(item.displayName) || "Estudiante"));
    name.addEventListener("click", (event) => {
      event.stopPropagation?.();
      openStudentDetail(id);
    });
    const email = document.createElement("span");
    email.className = "student-email";
    const emailParts = [toText(item.email)];
    if (isAdminSession() && item.teacherDisplayName) emailParts.push(toText(item.teacherDisplayName));
    if (item.pilotCohort) emailParts.push(`cohorte ${toText(item.pilotCohort)}`);
    if (item.isActive === false) emailParts.push("inactivo");
    email.textContent = emailParts.filter(Boolean).join(" | ");
    studentCell.appendChild(name);
    studentCell.appendChild(email);
    // Avance del taller en curso (29-10-2026): lo calcula la VM de editores cada 10 min. Un
    // backend anterior no manda «workshop» y la linea no sale.
    const workshopText = formatStudentWorkshop(item.workshop);
    if (workshopText) {
      const workshop = document.createElement("span");
      workshop.className = "cell-note student-workshop";
      workshop.textContent = workshopText;
      workshop.title = "Avance estimado en el taller (no es la nota): clases, metodos, herencia, main y si compila";
      studentCell.appendChild(workshop);
    }

    const sessionsCell = document.createElement("td");
    const sessions = item.sessions || {};
    sessionsCell.textContent = String(sessions.total || 0);
    const sessionsNote = document.createElement("span");
    sessionsNote.className = "cell-note";
    sessionsNote.textContent = `${sessions.browser || 0} nav | ${sessions.editor || 0} VS Code`;
    sessionsCell.appendChild(sessionsNote);

    const activityCell = document.createElement("td");
    activityCell.textContent = formatStudentRelativeTime(item.lastActivityAt, now);
    const activityNote = document.createElement("span");
    activityNote.className = "cell-note";
    activityNote.textContent = item.lastActivityAt ? formatStudentDateTime(item.lastActivityAt) : "sin registros";
    activityCell.appendChild(activityNote);

    const tutorCell = document.createElement("td");
    const interventions = item.interventions || {};
    tutorCell.textContent = String(interventions.total || 0);
    const tutorNote = document.createElement("span");
    tutorNote.className = "cell-note";
    tutorNote.textContent = `${interventions.hints || 0} pistas | ${interventions.blocked || 0} bloq.`;
    tutorCell.appendChild(tutorNote);

    const quizCell = document.createElement("td");
    const quizzes = item.quizzes || {};
    quizCell.textContent = `${quizzes.correct || 0}/${quizzes.answered || 0}`;
    const quizNote = document.createElement("span");
    quizNote.className = "cell-note";
    quizNote.textContent = quizzes.total
      ? `${pluralizeStudentCount(quizzes.total, "quiz", "quices")}${quizzes.correctRate === null || quizzes.correctRate === undefined ? "" : ` | ${quizzes.correctRate} % aciertos`}`
      : "sin quices";
    quizCell.appendChild(quizNote);

    // En la tabla, la nota sobre 100 en la etiqueta y la de 0 a 5 debajo: juntas («100/100 |
    // 5,0/5») la etiqueta no cabia y la columna se salia del panel.
    const gradeCell = document.createElement("td");
    const gradeChip = document.createElement("span");
    gradeChip.className = `grade-chip is-${studentGradeLevel(item.grade)}`;
    const hasGrade = item.grade && item.grade.score !== null && item.grade.score !== undefined;
    gradeChip.textContent = hasGrade ? `${item.grade.score}/100` : formatStudentGrade(item.grade);
    gradeChip.title = toText(item.grade?.formula);
    gradeCell.appendChild(gradeChip);
    const scale5 = formatStudentGradeScale5(item.grade);
    if (hasGrade && scale5) {
      const gradeNote = document.createElement("span");
      gradeNote.className = "cell-note";
      gradeNote.textContent = scale5;
      gradeCell.appendChild(gradeNote);
    }

    const actionsCell = document.createElement("td");
    actionsCell.className = "admin-actions-cell";
    actionsCell.addEventListener("click", stopRowClick);
    actionsCell.appendChild(buildAdminUserEditButton("students", item, busy));
    actionsCell.appendChild(buildAdminUserDeleteButton("students", item, busy));

    row.addEventListener("click", () => openStudentDetail(id));
    row.appendChild(selectCell);
    row.appendChild(studentCell);
    row.appendChild(sessionsCell);
    row.appendChild(activityCell);
    row.appendChild(tutorCell);
    row.appendChild(quizCell);
    row.appendChild(gradeCell);
    row.appendChild(actionsCell);
    fragment.appendChild(row);

    if (!isEditing) continue;
    // Fila de edición: el mismo formulario que en «Usuarios», a todo el ancho.
    const editRow = document.createElement("tr");
    editRow.className = "admin-edit-row";
    const editCell = document.createElement("td");
    editCell.colSpan = 8;
    editCell.appendChild(buildAdminUserEditForm("students", editingAccount, {
      busy,
      teacherMode: isTeacherSession(),
      teachers,
    }));
    editRow.appendChild(editCell);
    fragment.appendChild(editRow);
  }
  body.appendChild(fragment);
}

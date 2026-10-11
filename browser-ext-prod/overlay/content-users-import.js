// ADACEEN | Capa 4 - UI: «Importar lista» y «Docente de las cuentas nuevas» en la pestaña
// «Usuarios» (0.7.21, piloto con FPOO-01).
// - Importar lista: el CSV de «Participantes» de Campus Virtual (o la tabla copiada) se lee
//   aquí, se muestra cuántos estudiantes tienen correo de la universidad y, al pulsar
//   «Importar», quedan como estudiantes del docente y el curso elegidos
//   (POST /api/admin/users/import). Por defecto solo los de @correounivalle.edu.co: con Google
//   entra la cuenta de la universidad, y una cuenta con otro correo solo se uniría si el
//   estudiante entra con esa misma cuenta de Google. Los docentes de la lista se muestran con su
//   estado en ADACEEN (y el administrador les crea la cuenta de docente con un clic).
// - Docente de las cuentas nuevas (solo administrador): quien entra por primera vez con Google
//   queda con él (PUT /api/admin/default-teacher).
// El docente importa a su grupo; el administrador elige el docente. Lectura y backend en
// services/course-roster.service.js.
// Orden de carga: manifest.json (content_scripts) y background.js (CONTENT_SCRIPT_FILES) deben coincidir.
"use strict";

const EMPTY_ADMIN_IMPORT_STATE = Object.freeze({
  ownerUserId: "",
  open: false,
  sourceName: "",
  roster: null,
  teacherUserId: "",
  teacherChosenByUser: false,
  courseCode: "FPOO",
  includeOther: false,
  setDefault: true,
  busy: false,
  message: "",
  error: "",
  result: null,
});

function getAdminImportState() {
  const userId = toText(overlayState.session?.user?.id);
  if (!overlayState.adminImport || overlayState.adminImport.ownerUserId !== userId) {
    overlayState.adminImport = { ...EMPTY_ADMIN_IMPORT_STATE, ownerUserId: userId };
  }
  return overlayState.adminImport;
}

function pluralizeRoster(count, singular, plural) {
  return `${count} ${count === 1 ? singular : plural}`;
}

function adminTeacherName(teacherUserId) {
  const teacher = (Array.isArray(overlayState.adminTeachers) ? overlayState.adminTeachers : [])
    .find((entry) => toText(entry.id) === toText(teacherUserId));
  return toText(teacher?.displayName) || "";
}

function selectedRosterStudents(state) {
  const students = Array.isArray(state.roster?.students) ? state.roster.students : [];
  return state.includeOther ? students : students.filter((student) => student.institutional);
}

// Docente sugerido: un profesor de la lista que ya es docente en ADACEEN; si no, el de las
// cuentas nuevas; si no, el primero.
function suggestRosterTeacher(state) {
  const teachers = Array.isArray(overlayState.adminTeachers) ? overlayState.adminTeachers : [];
  const emails = new Set((state.roster?.teachers || []).map((teacher) => teacher.email));
  const fromRoster = teachers.find((teacher) => emails.has(toText(teacher.email).toLowerCase()));
  const fallback = toText(overlayState.adminDefaultTeacher?.teacherUserId);
  return toText(fromRoster?.id) || (teachers.some((teacher) => toText(teacher.id) === fallback) ? fallback : toText(teachers[0]?.id));
}

function loadRosterText(text, sourceName) {
  const state = getAdminImportState();
  const clean = toText(text);
  state.roster = clean.trim() ? parseCourseRoster(clean) : null;
  state.sourceName = state.roster ? sourceName : "";
  state.result = null;
  state.error = "";
  state.message = state.roster && !state.roster.students.length && !state.roster.teachers.length
    ? "No se encontraron correos en la lista. Usa el CSV de «Participantes» o copia la tabla con la columna del correo."
    : "";
  if (!state.teacherChosenByUser) state.teacherUserId = suggestRosterTeacher(state);
  renderOverlay();
}

function describeRosterSummary(state) {
  const roster = state.roster;
  if (!roster) return "En Campus Virtual abre «Participantes» del curso, descarga la lista (CSV) o copia la tabla, y elígela o pégala aquí.";
  const students = roster.students.length;
  const institutional = roster.students.filter((student) => student.institutional).length;
  const other = students - institutional;
  const parts = [
    `${state.sourceName}: ${pluralizeRoster(students, "estudiante", "estudiantes")}${roster.teachers.length ? ` y ${pluralizeRoster(roster.teachers.length, "docente", "docentes")}` : ""}.`,
    `${institutional} con correo @${COURSE_ROSTER_INSTITUTIONAL_DOMAIN}${other ? ` y ${other} con otro correo (Gmail u otro)` : ""}.`,
  ];
  if (other && !state.includeOther) {
    parts.push("Los de otro correo no se importan: esa cuenta solo quedaría unida si el estudiante entra a ADACEEN con esa misma cuenta de Google. Si entra con la de la universidad, ADACEEN le crea la cuenta sola.");
  }
  if (roster.inactive) parts.push(`${pluralizeRoster(roster.inactive, "suspendido en Campus queda", "suspendidos en Campus quedan")} fuera.`);
  return parts.join(" ");
}

function describeRosterTeacherStatus(teacher) {
  const ownEmail = toText(overlayState.session?.user?.email).toLowerCase();
  if (teacher.email === ownEmail) return { text: "eres tú (administrador)", action: "" };
  const teachers = Array.isArray(overlayState.adminTeachers) ? overlayState.adminTeachers : [];
  if (teachers.some((entry) => toText(entry.email).toLowerCase() === teacher.email)) return { text: "docente en ADACEEN", action: "" };
  const user = (Array.isArray(overlayState.adminUsers) ? overlayState.adminUsers : [])
    .find((entry) => toText(entry.email).toLowerCase() === teacher.email);
  if (user && toText(user.role) === "student") return { text: "tiene cuenta de estudiante", action: "promote", userId: toText(user.id) };
  if (user && toText(user.role) === "teacher") return { text: "docente desactivado en ADACEEN", action: "" };
  return { text: "sin cuenta en ADACEEN", action: "create" };
}

function describeRosterImportResult(result, teacherName, courseCode) {
  const lines = [];
  const created = Array.isArray(result?.created) ? result.created : [];
  const updated = Array.isArray(result?.updated) ? result.updated : [];
  const unchanged = Array.isArray(result?.unchanged) ? result.unchanged : [];
  const skipped = Array.isArray(result?.skipped) ? result.skipped : [];
  const target = `${teacherName ? `${teacherName} en ` : ""}${courseCode}`;
  if (created.length) lines.push(`${pluralizeRoster(created.length, "cuenta nueva", "cuentas nuevas")} con ${target}: entran con Google.`);
  if (updated.length) lines.push(`${pluralizeRoster(updated.length, "estudiante ya tenía", "estudiantes ya tenían")} cuenta y ${updated.length === 1 ? "pasó" : "pasaron"} a ${target}: ${updated.map((entry) => toText(entry.displayName)).join(", ")}.`);
  if (unchanged.length) lines.push(`${pluralizeRoster(unchanged.length, "ya estaba", "ya estaban")} así.`);
  for (const entry of skipped) lines.push(`Sin cambios: ${toText(entry.displayName) || toText(entry.email)} (${toText(entry.email)}). ${toText(entry.reason)}`);
  return lines;
}

// ---- Render ----

function renderAdminDefaultTeacherRow() {
  const row = overlayEls?.adminDefaultTeacherRow;
  if (!row) return;
  const allowed = isAdminSession();
  row.hidden = !allowed;
  if (!allowed) return;
  const choice = overlayState.adminDefaultTeacher || null;
  const teachers = Array.isArray(overlayState.adminTeachers) ? overlayState.adminTeachers : [];
  const select = overlayEls.adminDefaultTeacherSelect;
  const key = JSON.stringify([teachers.map((teacher) => [toText(teacher.id), toText(teacher.displayName)]), choice?.chosenTeacherUserId || ""]);
  if (select && renderKeyChanged(select, key)) {
    select.textContent = "";
    const automatic = document.createElement("option");
    automatic.value = "";
    automatic.textContent = "El profesor activo más antiguo (automático)";
    select.appendChild(automatic);
    for (const teacher of teachers) {
      const option = document.createElement("option");
      option.value = toText(teacher.id);
      option.textContent = `${toText(teacher.displayName)} (${toText(teacher.email)})`;
      select.appendChild(option);
    }
    select.value = choice?.chosenInactive ? "" : toText(choice?.chosenTeacherUserId);
  }
  if (select) select.disabled = !!overlayState.adminUsersBusy || !choice;
  let note = "Quien entra por primera vez con Google, o se crea sin docente, queda con este docente y el curso FPOO.";
  if (!choice) note = "Recarga los usuarios para ver el docente de las cuentas nuevas.";
  else if (choice.source === "oldest" && choice.teacherUserId) note += ` Ahora: ${adminTeacherName(choice.teacherUserId) || "el más antiguo"}.`;
  if (choice?.chosenInactive) note += " El que se eligió ya no está activo: se usa el profesor más antiguo.";
  setTextIfChanged(overlayEls.adminDefaultTeacherNote, note);
}

function renderAdminImportPanel() {
  if (!overlayEls?.adminImportPanel) return;
  const allowed = canManageUsersSession();
  const state = getAdminImportState();
  const admin = isAdminSession();
  const busy = state.busy || !!overlayState.adminUsersBusy;
  if (overlayEls.adminToggleImportBtn) {
    overlayEls.adminToggleImportBtn.hidden = !allowed;
    overlayEls.adminToggleImportBtn.disabled = busy;
    setTextIfChanged(overlayEls.adminToggleImportBtn, state.open ? "Ocultar importación" : "Importar lista");
    overlayEls.adminToggleImportBtn.setAttribute("aria-expanded", state.open ? "true" : "false");
  }
  overlayEls.adminImportPanel.hidden = !allowed || !state.open;
  if (!allowed || !state.open) return;

  if (!state.teacherChosenByUser && admin && !state.teacherUserId) state.teacherUserId = suggestRosterTeacher(state);
  setTextIfChanged(overlayEls.adminImportFileName, state.sourceName && state.sourceName !== "Lista pegada" ? state.sourceName : "");
  setTextIfChanged(overlayEls.adminImportSummary, state.error || state.message || describeRosterSummary(state));
  overlayEls.adminImportSummary.classList.toggle("is-warning", !!state.error);

  // Docentes de la lista y su cuenta en ADACEEN (el administrador les crea la de docente).
  const rosterTeachers = admin && state.roster ? state.roster.teachers : [];
  const teachersKey = JSON.stringify([rosterTeachers, (overlayState.adminTeachers || []).map((teacher) => toText(teacher.email)), (overlayState.adminUsers || []).map((user) => `${toText(user.email)}|${toText(user.role)}`), busy]);
  if (overlayEls.adminImportTeachers && renderKeyChanged(overlayEls.adminImportTeachers, teachersKey)) {
    overlayEls.adminImportTeachers.textContent = "";
    overlayEls.adminImportTeachers.hidden = !rosterTeachers.length;
    for (const teacher of rosterTeachers) {
      const status = describeRosterTeacherStatus(teacher);
      const li = document.createElement("li");
      li.className = "admin-import-teacher";
      const text = document.createElement("span");
      text.textContent = `${teacher.displayName} (${teacher.roleLabel} en Campus): ${status.text}.`;
      li.appendChild(text);
      if (status.action) {
        const button = document.createElement("button");
        button.type = "button";
        button.className = "ghost-button analyze-button";
        button.disabled = busy;
        button.textContent = status.action === "create" ? "Crear su cuenta de docente" : "Hacerlo docente";
        button.addEventListener("click", () => {
          runRosterTeacherAction(teacher, status).catch(() => {});
        });
        li.appendChild(button);
      }
      overlayEls.adminImportTeachers.appendChild(li);
    }
  }

  // Docente (solo el administrador) y curso.
  const teachers = Array.isArray(overlayState.adminTeachers) ? overlayState.adminTeachers : [];
  if (overlayEls.adminImportTeacher) {
    overlayEls.adminImportTeacher.hidden = !admin;
    const key = JSON.stringify([teachers.map((teacher) => [toText(teacher.id), toText(teacher.displayName)]), state.teacherUserId]);
    if (admin && renderKeyChanged(overlayEls.adminImportTeacher, key)) {
      overlayEls.adminImportTeacher.textContent = "";
      if (!teachers.length) {
        const empty = document.createElement("option");
        empty.value = "";
        empty.textContent = "Sin profesores activos: crea primero la cuenta del docente";
        overlayEls.adminImportTeacher.appendChild(empty);
      }
      for (const teacher of teachers) {
        const option = document.createElement("option");
        option.value = toText(teacher.id);
        option.textContent = `Docente: ${toText(teacher.displayName)}`;
        overlayEls.adminImportTeacher.appendChild(option);
      }
      overlayEls.adminImportTeacher.value = state.teacherUserId;
    }
    overlayEls.adminImportTeacher.disabled = busy;
  }
  const courses = getRagCourseCatalog();
  if (overlayEls.adminImportCourse) {
    const key = JSON.stringify([courses.map((course) => toText(course?.code)), state.courseCode]);
    if (renderKeyChanged(overlayEls.adminImportCourse, key)) {
      overlayEls.adminImportCourse.textContent = "";
      const codes = courses.length ? courses : [{ code: "FPOO", shortName: "FPOO" }];
      for (const course of codes) {
        const option = document.createElement("option");
        option.value = normalizeRagCourseCodeUi(course?.code);
        option.textContent = `Curso: ${toText(course?.shortName || course?.code)}`;
        overlayEls.adminImportCourse.appendChild(option);
      }
      overlayEls.adminImportCourse.value = state.courseCode;
    }
    overlayEls.adminImportCourse.disabled = busy;
  }

  const students = state.roster ? state.roster.students : [];
  const other = students.filter((student) => !student.institutional).length;
  if (overlayEls.adminImportIncludeOtherRow) overlayEls.adminImportIncludeOtherRow.hidden = !other;
  if (overlayEls.adminImportIncludeOther) {
    overlayEls.adminImportIncludeOther.checked = state.includeOther;
    overlayEls.adminImportIncludeOther.disabled = busy;
  }
  setTextIfChanged(overlayEls.adminImportIncludeOtherLabel, `Incluir también ${other === 1 ? "el de otro correo" : `los ${other} de otro correo`}`);

  const teacherName = adminTeacherName(state.teacherUserId);
  const alreadyDefault = !!state.teacherUserId
    && toText(overlayState.adminDefaultTeacher?.teacherUserId) === state.teacherUserId
    && overlayState.adminDefaultTeacher?.source === "admin";
  if (overlayEls.adminImportSetDefaultRow) overlayEls.adminImportSetDefaultRow.hidden = !admin || !teacherName || alreadyDefault;
  if (overlayEls.adminImportSetDefault) {
    overlayEls.adminImportSetDefault.checked = state.setDefault;
    overlayEls.adminImportSetDefault.disabled = busy;
  }
  setTextIfChanged(overlayEls.adminImportSetDefaultLabel, `Quien entre por primera vez con Google también queda con ${teacherName || "este docente"} (curso FPOO)`);

  const selected = selectedRosterStudents(state).length;
  if (overlayEls.adminImportBtn) {
    setTextIfChanged(overlayEls.adminImportBtn, selected ? `Importar ${pluralizeRoster(selected, "estudiante", "estudiantes")}` : "Importar");
    overlayEls.adminImportBtn.disabled = busy || !selected || (admin && !state.teacherUserId);
  }
  if (overlayEls.adminImportCancelBtn) overlayEls.adminImportCancelBtn.disabled = state.busy;

  const resultLines = state.result ? describeRosterImportResult(state.result, adminTeacherName(state.result.teacherUserId), toText(state.result.courseCode)) : [];
  if (overlayEls.adminImportResult && renderKeyChanged(overlayEls.adminImportResult, JSON.stringify(resultLines))) {
    overlayEls.adminImportResult.textContent = "";
    overlayEls.adminImportResult.hidden = !resultLines.length;
    for (const line of resultLines) {
      const li = document.createElement("li");
      li.textContent = line;
      overlayEls.adminImportResult.appendChild(li);
    }
  }
}

// La pestaña «Usuarios» completa: la tabla (content-users.js), la importación y el docente de las cuentas nuevas.
function renderAdminUsersExtras() {
  renderAdminDefaultTeacherRow();
  renderAdminImportPanel();
}

// ---- Acciones ----

async function runRosterTeacherAction(teacher, status) {
  const state = getAdminImportState();
  if (state.busy || !isAdminSession()) return;
  state.busy = true;
  state.error = "";
  state.message = status.action === "create" ? `Creando la cuenta de docente de ${teacher.displayName}...` : `Pasando a ${teacher.displayName} a docente...`;
  renderOverlay();
  try {
    if (status.action === "create") {
      await createRosterTeacherAccount(teacher);
    } else {
      await updateAdminUserRow(status.userId, { role: "teacher" });
    }
    await reloadAdminUsers();
    const created = (overlayState.adminTeachers || []).find((entry) => toText(entry.email).toLowerCase() === teacher.email);
    if (created) {
      state.teacherUserId = toText(created.id);
      state.teacherChosenByUser = true;
    }
    state.message = `${teacher.displayName} ya es docente en ADACEEN${created ? " y queda elegido para la importación" : ""}. Entra con su Google de la universidad.`;
  } catch (error) {
    state.error = `No se pudo: ${toText(error?.message) || String(error)}`;
    state.message = "";
  } finally {
    state.busy = false;
    renderOverlay();
  }
}

async function runCourseRosterImport() {
  const state = getAdminImportState();
  const students = selectedRosterStudents(state);
  if (state.busy || !students.length || !canManageUsersSession()) return;
  const admin = isAdminSession();
  state.busy = true;
  state.error = "";
  state.result = null;
  state.message = `Importando ${pluralizeRoster(students.length, "estudiante", "estudiantes")}...`;
  renderOverlay();
  try {
    const result = await importCourseRoster({
      teacherUserId: admin ? state.teacherUserId : null,
      courseCode: state.courseCode,
      students,
    });
    state.result = result;
    const notes = [];
    const alreadyDefault = toText(overlayState.adminDefaultTeacher?.teacherUserId) === toText(result?.teacherUserId)
      && overlayState.adminDefaultTeacher?.source === "admin";
    if (admin && state.setDefault && toText(result?.teacherUserId) && !alreadyDefault) {
      try {
        await saveDefaultTeacherChoice(result.teacherUserId);
        notes.push(`Quien entre por primera vez con Google queda con ${adminTeacherName(result.teacherUserId) || "ese docente"}.`);
      } catch (error) {
        notes.push(toText(error?.message) || String(error));
      }
    }
    await reloadAdminUsers().catch(() => {});
    const created = Array.isArray(result?.created) ? result.created.length : 0;
    const updated = Array.isArray(result?.updated) ? result.updated.length : 0;
    state.message = `Lista importada: ${created} nuevas y ${updated} actualizadas.${notes.length ? ` ${notes.join(" ")}` : ""}`;
    overlayState.adminUsersMessage = state.message;
  } catch (error) {
    state.error = `No se pudo importar la lista: ${toText(error?.message) || String(error)}`;
    state.message = "";
  } finally {
    state.busy = false;
    renderOverlay();
  }
}

// ---- Eventos ----

function bindAdminImportPanel() {
  overlayEls.adminToggleImportBtn?.addEventListener("click", () => {
    if (!canManageUsersSession()) return;
    const state = getAdminImportState();
    state.open = !state.open;
    if (state.open) overlayState.adminCreateFormOpen = false;
    renderOverlay();
  });
  overlayEls.adminImportFileBtn?.addEventListener("click", () => {
    overlayEls.adminImportFileInput?.click();
  });
  overlayEls.adminImportFileInput?.addEventListener("change", async () => {
    const input = overlayEls.adminImportFileInput;
    const file = input?.files?.[0];
    if (!file) return;
    try {
      const text = typeof file.text === "function" ? await file.text() : "";
      if (overlayEls.adminImportText) overlayEls.adminImportText.value = "";
      loadRosterText(text, toText(file.name) || "Archivo");
    } catch (error) {
      const state = getAdminImportState();
      state.error = `No se pudo leer el archivo: ${toText(error?.message) || String(error)}`;
      renderOverlay();
    } finally {
      if (input) input.value = "";
    }
  });
  overlayEls.adminImportText?.addEventListener("input", () => {
    loadRosterText(overlayEls.adminImportText.value, "Lista pegada");
  });
  overlayEls.adminImportTeacher?.addEventListener("change", () => {
    const state = getAdminImportState();
    state.teacherUserId = toText(overlayEls.adminImportTeacher.value);
    state.teacherChosenByUser = true;
    renderOverlay();
  });
  overlayEls.adminImportCourse?.addEventListener("change", () => {
    getAdminImportState().courseCode = normalizeRagCourseCodeUi(overlayEls.adminImportCourse.value);
    renderOverlay();
  });
  overlayEls.adminImportIncludeOther?.addEventListener("change", () => {
    getAdminImportState().includeOther = overlayEls.adminImportIncludeOther.checked === true;
    renderOverlay();
  });
  overlayEls.adminImportSetDefault?.addEventListener("change", () => {
    getAdminImportState().setDefault = overlayEls.adminImportSetDefault.checked === true;
    renderOverlay();
  });
  overlayEls.adminImportCancelBtn?.addEventListener("click", () => {
    const userId = toText(overlayState.session?.user?.id);
    overlayState.adminImport = { ...EMPTY_ADMIN_IMPORT_STATE, ownerUserId: userId };
    if (overlayEls.adminImportText) overlayEls.adminImportText.value = "";
    renderOverlay();
  });
  overlayEls.adminImportBtn?.addEventListener("click", () => {
    runCourseRosterImport().catch(() => {});
  });
  overlayEls.adminDefaultTeacherSelect?.addEventListener("change", async () => {
    if (!isAdminSession()) return;
    const teacherUserId = toText(overlayEls.adminDefaultTeacherSelect.value);
    overlayState.adminUsersBusy = true;
    overlayState.adminUsersMessage = "Guardando el docente de las cuentas nuevas...";
    renderOverlay();
    try {
      const choice = await saveDefaultTeacherChoice(teacherUserId);
      overlayState.adminUsersMessage = choice?.source === "admin"
        ? `Las cuentas nuevas quedan con ${adminTeacherName(choice.teacherUserId) || "el docente elegido"}.`
        : "Las cuentas nuevas quedan con el profesor activo más antiguo.";
    } catch (error) {
      overlayState.adminUsersMessage = `No se pudo guardar: ${toText(error?.message) || String(error)}`;
    } finally {
      overlayState.adminUsersBusy = false;
      renderOverlay();
    }
  });
}

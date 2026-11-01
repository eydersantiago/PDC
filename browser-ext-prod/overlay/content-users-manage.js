// ADACEEN | Capa 4 - UI: gestión de cuentas compartida por «Usuarios» y «Estudiantes» (0.7.22):
// selección, mensajes, eliminar, desactivar y botones de cada fila. Movido sin cambios de content-users.js.

// ---- Gestión compartida por «Usuarios» y «Estudiantes» (0.7.22) ----
// Las dos listas seleccionan, editan y eliminan igual; «Estudiantes» solo muestra estudiantes.
// El ámbito ("users" o "students") dice qué selección se usa, qué fila se edita y dónde sale el
// mensaje. El trabajo es uno solo: overlayState.adminUsersBusy bloquea las dos listas y, al
// terminar, se recargan las dos (refreshAfterAdminUsersChange).

// Última casilla tocada en cada lista: con Shift se marca el tramo desde ella.
const ADMIN_SELECTION_ANCHORS = { users: "", students: "" };

function isAdminUserSelectable(user) {
  return toText(user?.role).toLowerCase() === "student";
}

function findAdminUser(userId) {
  const id = toText(userId);
  return (Array.isArray(overlayState.adminUsers) ? overlayState.adminUsers : []).find((user) => toText(user.id) === id) || null;
}

function getAdminSelection(scope) {
  const ids = scope === "students" ? overlayState.studentsPanel?.checkedIds : overlayState.adminSelectedUserIds;
  return (Array.isArray(ids) ? ids : []).map(toText).filter(Boolean);
}

function setAdminSelection(scope, ids) {
  const unique = [...new Set((ids || []).map(toText).filter(Boolean))];
  if (scope === "students") {
    if (overlayState.studentsPanel) overlayState.studentsPanel.checkedIds = unique;
  } else {
    overlayState.adminSelectedUserIds = unique;
  }
}

function getAdminEditingId(scope) {
  return toText(scope === "students" ? overlayState.studentsPanel?.editingId : overlayState.adminEditingUserId);
}

function setAdminEditingId(scope, userId) {
  if (scope === "students") {
    if (overlayState.studentsPanel) overlayState.studentsPanel.editingId = toText(userId);
  } else {
    overlayState.adminEditingUserId = toText(userId);
  }
}

function setAdminUsersActionMessage(scope, message) {
  if (scope === "students") {
    if (overlayState.studentsPanel) overlayState.studentsPanel.actionMessage = toText(message);
  } else {
    overlayState.adminUsersMessage = toText(message);
  }
}

// La lista a la vista: crear e importar avisan en ella.
function currentAdminUsersScope() {
  return normalizeMainTab(overlayState.mainTab) === "estudiantes" ? "students" : "users";
}

function renderAdminUsersScope(scope) {
  if (scope === "students" && typeof renderStudentsPanel === "function") renderStudentsPanel(true);
  else renderAdminUsersTable();
}

// «Estudiantes» queda vieja tras un cambio: se recarga al momento si está a la vista; si no,
// al abrirla.
async function refreshStudentsProgressAfterChange() {
  const panel = overlayState.studentsPanel;
  if (!panel || !panel.loadedAt) return;
  panel.loadedAt = 0;
  if (normalizeMainTab(overlayState.mainTab) === "estudiantes" && typeof loadStudentsProgress === "function") {
    await loadStudentsProgress({ force: true }).catch(() => {});
  }
}

async function refreshAfterAdminUsersChange() {
  await reloadAdminUsers();
  await refreshStudentsProgressAfterChange();
}

// Marca o desmarca una casilla; con Shift, todo el tramo (entre las filas visibles) desde la
// última casilla tocada, como en un explorador de archivos.
function toggleAdminSelection(scope, userId, checked, options = {}) {
  const id = toText(userId);
  const visible = (Array.isArray(options.visibleIds) ? options.visibleIds : []).map(toText);
  const anchor = ADMIN_SELECTION_ANCHORS[scope] || "";
  let targets = [id];
  if (options.range && anchor && anchor !== id) {
    const from = visible.indexOf(anchor);
    const to = visible.indexOf(id);
    if (from >= 0 && to >= 0) targets = visible.slice(Math.min(from, to), Math.max(from, to) + 1);
  }
  const current = new Set(getAdminSelection(scope));
  for (const target of targets) {
    if (checked) current.add(target);
    else current.delete(target);
  }
  ADMIN_SELECTION_ANCHORS[scope] = id;
  setAdminSelection(scope, [...current]);
  renderAdminUsersScope(scope);
}

function toggleAdminUserSelection(userId, checked) {
  toggleAdminSelection("users", userId, checked);
}

// «Seleccionar todos»: marca o desmarca los que muestra la búsqueda.
function setAdminSelectionForVisible(scope, visibleIds, checked) {
  const current = new Set(getAdminSelection(scope));
  for (const id of visibleIds.map(toText)) {
    if (checked) current.add(id);
    else current.delete(id);
  }
  ADMIN_SELECTION_ANCHORS[scope] = "";
  setAdminSelection(scope, [...current]);
  renderAdminUsersScope(scope);
}

function buildAdminSelectBox(scope, user, selected, visibleIds, busy) {
  const userId = toText(user?.id);
  const label = toText(user?.displayName) || toText(user?.email) || "estudiante";
  const box = document.createElement("input");
  box.type = "checkbox";
  box.checked = selected.has(userId);
  box.disabled = busy;
  box.setAttribute("aria-label", `Seleccionar a ${label}`);
  // El clic llega antes que el cambio: ahí se sabe si venía con Shift.
  let withShift = false;
  box.addEventListener("click", (event) => {
    withShift = !!event?.shiftKey;
    event?.stopPropagation?.();
  });
  box.addEventListener("change", () => {
    toggleAdminSelection(scope, userId, box.checked, { range: withShift, visibleIds });
    withShift = false;
  });
  return box;
}

// Barra con el conteo, «Quitar selección» y «Eliminar seleccionados», y el estado de
// «Seleccionar todos» (marcado, a medias o vacío según los visibles).
function renderAdminBulkBar(els, count, selectableIds, selected, busy) {
  if (els.bar) els.bar.hidden = count === 0;
  setTextIfChanged(els.count, count === 1 ? "1 seleccionado" : `${count} seleccionados`);
  if (els.deleteBtn) els.deleteBtn.disabled = busy || count === 0;
  if (els.clearBtn) els.clearBtn.disabled = busy || count === 0;
  const box = els.selectAll;
  if (!box) return;
  const visibleSelected = selectableIds.filter((id) => selected.has(id)).length;
  box.disabled = busy || selectableIds.length === 0;
  box.checked = selectableIds.length > 0 && visibleSelected === selectableIds.length;
  box.indeterminate = visibleSelected > 0 && visibleSelected < selectableIds.length;
}

function renderAdminUsersBulkBar(count, selectableIds, selected, busy) {
  renderAdminBulkBar({
    bar: overlayEls.adminUsersBulkBar,
    count: overlayEls.adminUsersBulkCount,
    deleteBtn: overlayEls.adminUsersBulkDeleteBtn,
    clearBtn: overlayEls.adminUsersBulkClearBtn,
    selectAll: overlayEls.adminUsersSelectAll,
  }, count, selectableIds, selected, busy);
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

// Eliminar estudiantes, uno o varios, igual en las dos listas (POST /api/admin/users/bulk-delete):
// quien nunca entró se borra del todo (se puede volver a importar con el nombre correcto); quien
// ya entró se desactiva y conserva sus datos del piloto. La confirmación dice qué pasará.
async function deleteAdminStudents(scope, ids) {
  if (!canManageUsersSession() || overlayState.adminUsersBusy) return;
  const list = [...new Set((ids || []).map(toText).filter(Boolean))];
  if (!list.length) return;
  // Desde «Estudiantes» puede faltar la cuenta (no se ha cargado «Usuarios»): se trae.
  if (list.some((id) => !findAdminUser(id))) await reloadAdminUsers().catch(() => {});
  const progress = Array.isArray(overlayState.studentsPanel?.items) ? overlayState.studentsPanel.items : [];
  const chosen = list.map((id) => findAdminUser(id) || progress.find((item) => toText(item.id) === id) || { id });
  const signedIn = chosen.filter((user) => user.hasSignedIn === true).length;
  const neverSignedIn = chosen.filter((user) => user.hasSignedIn === false).length;
  const name = toText(chosen[0]?.displayName) || toText(chosen[0]?.email) || "este estudiante";
  const lines = [];
  if (chosen.length === 1) {
    lines.push(`Vas a eliminar a ${name}.`);
    if (neverSignedIn) lines.push("Nunca ha entrado: se borra del todo (puedes volver a importarlo con el nombre correcto).");
    if (signedIn) lines.push("Ya entró: se desactiva y conserva sus datos del piloto.");
  } else {
    lines.push(`Vas a eliminar ${chosen.length} estudiantes.`);
    if (neverSignedIn) {
      lines.push(`${neverSignedIn === 1 ? "1 nunca ha entrado: se borra" : `${neverSignedIn} nunca han entrado: se borran`} del todo (puedes volver a importarlos con el nombre correcto).`);
    }
    if (signedIn) {
      lines.push(`${signedIn === 1 ? "1 ya entró: se desactiva" : `${signedIn} ya entraron: se desactivan`} y conserva${signedIn === 1 ? "" : "n"} sus datos del piloto.`);
    }
  }
  lines.push("¿Continuar?");
  if (!window.confirm(lines.join("\n"))) return;
  overlayState.adminUsersBusy = true;
  setAdminUsersActionMessage(scope, list.length === 1 ? `Eliminando a ${name}...` : `Eliminando ${list.length} estudiantes...`);
  renderOverlay();
  try {
    const result = await bulkDeleteAdminUsers(list);
    // Quien se eliminó sale de las dos selecciones y de la edición.
    for (const listScope of ["users", "students"]) {
      setAdminSelection(listScope, getAdminSelection(listScope).filter((id) => !list.includes(id)));
      if (list.includes(getAdminEditingId(listScope))) setAdminEditingId(listScope, "");
    }
    await refreshAfterAdminUsersChange();
    setAdminUsersActionMessage(scope, describeAdminUsersRemoval(result));
  } catch (error) {
    setAdminUsersActionMessage(scope, `No se pudo eliminar: ${toText(error?.message) || String(error)}`);
  } finally {
    overlayState.adminUsersBusy = false;
    renderOverlay();
  }
}

function deleteSelectedAdminUsers() {
  return deleteAdminStudents("users", getAdminSelection("users"));
}

// Un docente (solo en «Usuarios») se desactiva: DELETE /api/admin/users/:userId.
async function deactivateAdminTeacher(user) {
  const userId = toText(user?.id);
  if (!userId || overlayState.adminUsersBusy) return;
  const confirmed = window.confirm(`Se desactivara el usuario ${toText(user.displayName)}. Deseas continuar?`);
  if (!confirmed) return;
  overlayState.adminUsersBusy = true;
  overlayState.adminUsersMessage = `Desactivando ${toText(user.displayName)}...`;
  renderOverlay();
  try {
    await deleteAdminUser(userId);
    if (overlayState.adminEditingUserId === userId) overlayState.adminEditingUserId = "";
    await refreshAfterAdminUsersChange();
    overlayState.adminUsersMessage = "Usuario desactivado.";
  } catch (error) {
    overlayState.adminUsersMessage = `No se pudo eliminar: ${String(error)}`;
  } finally {
    overlayState.adminUsersBusy = false;
    renderOverlay();
  }
}

function buildAdminUserEditButton(scope, user, busy) {
  const userId = toText(user?.id);
  const label = toText(user?.displayName) || toText(user?.email) || "usuario";
  const isEditing = getAdminEditingId(scope) === userId;
  const button = document.createElement("button");
  button.type = "button";
  button.className = "ghost-button";
  button.textContent = isEditing ? "Cancelar" : "Editar";
  button.setAttribute("aria-label", isEditing ? `Cancelar la edicion de ${label}` : `Editar a ${label}`);
  button.setAttribute("aria-expanded", isEditing ? "true" : "false");
  button.disabled = busy;
  button.addEventListener("click", async (event) => {
    event?.stopPropagation?.();
    if (isEditing) {
      setAdminEditingId(scope, "");
      renderOverlay();
      return;
    }
    if (!findAdminUser(userId)) await reloadAdminUsers().catch(() => {});
    if (!findAdminUser(userId)) {
      setAdminUsersActionMessage(scope, `No se encontró la cuenta de ${label}: pulsa «Recargar».`);
      renderOverlay();
      return;
    }
    setAdminEditingId(scope, userId);
    renderOverlay();
  });
  return button;
}

// «Eliminar» de una fila. Un estudiante se elimina como con las casillas; desactivado y con
// entradas ya no queda nada por hacer. Un docente se desactiva.
function buildAdminUserDeleteButton(scope, user, busy) {
  const userId = toText(user?.id);
  const label = toText(user?.displayName) || toText(user?.email) || "usuario";
  const account = findAdminUser(userId) || user;
  const inactive = account?.isActive === false;
  const button = document.createElement("button");
  button.type = "button";
  // Accion destructiva: con el estilo de peligro, no como el boton principal.
  button.className = "ghost-button danger-button";
  button.textContent = "Eliminar";
  if (scope === "students" || isAdminUserSelectable(account)) {
    button.setAttribute("aria-label", `Eliminar a ${label}`);
    button.disabled = busy || (inactive && account?.hasSignedIn === true);
    button.addEventListener("click", (event) => {
      event?.stopPropagation?.();
      deleteAdminStudents(scope, [userId]).catch(() => {});
    });
  } else {
    button.setAttribute("aria-label", `Eliminar (desactivar) a ${label}`);
    button.disabled = busy || inactive;
    button.addEventListener("click", () => {
      deactivateAdminTeacher(account).catch(() => {});
    });
  }
  return button;
}

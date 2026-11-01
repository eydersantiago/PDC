"use strict";

// ADACEEN | Capa 4 - UI: pestaña «RAG», piezas de la vista: cada fuente, la lista de fuentes, el formulario
// de lote nuevo y el grupo de un lote. Movido sin cambios de content-rag.js.

const RAG_SOURCE_TYPE_LABELS = Object.freeze({
  document: "Documento",
  web_page: "Pagina web",
  open_book_html: "Libro abierto",
  open_book_html_zip: "Libro abierto (zip)",
  google_drive_file: "Google Drive",
  bitacora: "Bitacora",
  pdf: "PDF",
});

function formatRagSourceSize(source) {
  const chars = Number(source?.textLength) || 0;
  if (!chars) return "";
  if (chars < 1000) return `${chars} caracteres`;
  return `${Math.round(chars / 1000)}k caracteres`;
}

function ragSourceTypeLabel(source) {
  const type = toText(source?.sourceType).toLowerCase();
  return RAG_SOURCE_TYPE_LABELS[type] || (type ? type.replace(/_/g, " ") : "documento");
}

function buildRagSourceItem(source, courseCode, busy) {
  const enabled = isRagSourceEnabled(source);
  const li = document.createElement("li");
  li.className = `rag-course-source${source.scope === "teacher" ? " is-teacher" : ""}${enabled ? "" : " is-disabled"}`;

  const head = document.createElement("div");
  head.className = "rag-course-source-head";
  const titleBox = document.createElement("div");
  titleBox.className = "rag-course-source-titles";
  const title = document.createElement("span");
  title.className = "rag-course-source-title";
  title.textContent = toText(source.title || source.fileName || "Fuente RAG");
  title.title = title.textContent;
  const meta = document.createElement("span");
  meta.className = "rag-course-source-meta";
  const words = ragOwnerWords();
  meta.textContent = [
    enabled ? "" : `Apagada para ${words.students}`,
    source.scope === "teacher" ? (isAdminSession() ? "Cargada por el docente" : "Cargada por ti") : "Programa del curso",
    ragSourceTypeLabel(source),
    toText(source.fileName),
    formatRagSourceSize(source),
    source.createdAt ? new Date(source.createdAt).toLocaleDateString() : "",
  ].filter(Boolean).join(" | ");
  titleBox.appendChild(title);
  titleBox.appendChild(meta);
  head.appendChild(titleBox);

  const actions = document.createElement("div");
  actions.className = "rag-course-source-actions";
  const href = buildRagSourceViewerHref(source.url || source.viewerUrl, { ...source, courseCode });
  if (href) {
    const view = document.createElement("a");
    view.className = "ghost-button analyze-button rag-source-link";
    view.href = href;
    view.target = "_blank";
    view.rel = "noopener noreferrer";
    view.textContent = "Ver";
    view.setAttribute("aria-label", `Ver ${title.textContent} (se abre en otra pestaña)`);
    actions.appendChild(view);
  }
  const toggle = document.createElement("button");
  toggle.type = "button";
  toggle.className = "ghost-button analyze-button";
  toggle.textContent = enabled ? "Desactivar" : "Activar";
  toggle.disabled = busy;
  toggle.setAttribute("aria-pressed", enabled ? "true" : "false");
  toggle.setAttribute("aria-label", `${enabled ? "Desactivar" : "Activar"} ${title.textContent} para los estudiantes de ${courseCode}`);
  toggle.addEventListener("click", () => {
    setRagSourceEnabled(source, !enabled).catch(() => {});
  });
  actions.appendChild(toggle);
  if (source.scope === "teacher") {
    const remove = document.createElement("button");
    remove.type = "button";
    remove.className = "ghost-button analyze-button danger-button";
    remove.textContent = "Retirar";
    remove.disabled = busy;
    remove.setAttribute("aria-label", `Retirar ${title.textContent} del RAG de ${courseCode}`);
    remove.addEventListener("click", () => {
      deleteTeacherRagSource(toText(source.id)).catch(() => {});
    });
    actions.appendChild(remove);
  }
  head.appendChild(actions);
  li.appendChild(head);

  if (source.textPreview) {
    const preview = document.createElement("p");
    preview.className = "rag-course-source-preview";
    preview.textContent = truncateText(toText(source.textPreview), 160);
    li.appendChild(preview);
  }
  return li;
}

function sortRagSources(sources) {
  return sources
    .slice()
    .sort((left, right) => {
      if ((left.scope === "teacher") !== (right.scope === "teacher")) return left.scope === "teacher" ? -1 : 1;
      return toText(left.title || left.fileName).localeCompare(toText(right.title || right.fileName), "es");
    });
}

function buildRagSourceList(sources, courseCode, busy, emptyText) {
  const list = document.createElement("ul");
  list.className = "rag-course-sources";
  if (!sources.length) {
    const empty = document.createElement("li");
    empty.className = "rag-course-source is-empty";
    empty.textContent = emptyText;
    list.appendChild(empty);
  } else {
    sortRagSources(sources).forEach((source) => list.appendChild(buildRagSourceItem(source, courseCode, busy)));
  }
  return list;
}

function countEnabled(sources) {
  return sources.filter((source) => isRagSourceEnabled(source)).length;
}

function buildRagLotForm(course, busy) {
  const form = document.createElement("div");
  form.className = "rag-lot-form";
  form.setAttribute("role", "group");
  form.setAttribute("aria-label", `Nuevo lote de RAG en ${course.code}`);

  const nameInput = document.createElement("input");
  nameInput.type = "text";
  nameInput.maxLength = 80;
  nameInput.placeholder = "Nombre del lote, por ejemplo: enfoque videojuegos";
  nameInput.setAttribute("aria-label", `Nombre del nuevo lote de ${course.code}`);
  nameInput.disabled = busy;

  const descriptionInput = document.createElement("input");
  descriptionInput.type = "text";
  descriptionInput.maxLength = 400;
  descriptionInput.placeholder = "Para que sirve este enfoque (opcional)";
  descriptionInput.setAttribute("aria-label", `Descripcion del nuevo lote de ${course.code}`);
  descriptionInput.disabled = busy;

  const includesLabel = document.createElement("label");
  includesLabel.className = "check-item rag-lot-includes";
  const includesText = document.createElement("span");
  includesText.textContent = "Incluye la base del curso";
  const includesInput = document.createElement("input");
  includesInput.type = "checkbox";
  includesInput.checked = true;
  includesInput.disabled = busy;
  includesLabel.appendChild(includesText);
  includesLabel.appendChild(includesInput);

  const actions = document.createElement("div");
  actions.className = "rag-lot-form-actions";
  const cancel = document.createElement("button");
  cancel.type = "button";
  cancel.className = "ghost-button analyze-button";
  cancel.textContent = "Cancelar";
  cancel.disabled = busy;
  cancel.addEventListener("click", () => setRagLotFormOpen(course.code, false));
  const save = document.createElement("button");
  save.type = "button";
  save.className = "primary-button analyze-button";
  save.textContent = "Guardar lote";
  save.disabled = busy;
  save.addEventListener("click", async () => {
    const name = toText(nameInput.value);
    if (name.length < 2) {
      overlayState.ragLots = { ...getRagLotsState(), error: "El lote necesita un nombre de al menos 2 caracteres." };
      renderOverlay();
      return;
    }
    const created = await createRagLot(course.code, { name, description: toText(descriptionInput.value), includesBase: includesInput.checked });
    if (created) setRagLotFormOpen(course.code, false);
  });
  actions.appendChild(cancel);
  actions.appendChild(save);

  form.appendChild(nameInput);
  form.appendChild(descriptionInput);
  form.appendChild(includesLabel);
  form.appendChild(actions);
  return form;
}

function buildRagLotGroup(course, lot, sources, busy, isActive) {
  const group = document.createElement("details");
  group.className = `rag-lot-group${isActive ? " is-active" : ""}`;
  group.open = isActive;
  const summary = document.createElement("summary");
  const name = document.createElement("span");
  name.className = "rag-lot-name";
  name.textContent = toText(lot.name);
  summary.appendChild(name);
  const badge = document.createElement("span");
  badge.className = `rag-lot-badge${isActive ? " is-active" : ""}`;
  badge.textContent = isActive ? "Activo" : "Inactivo";
  summary.appendChild(badge);
  const counts = document.createElement("span");
  counts.className = "rag-course-counts";
  counts.textContent = `${pluralizeStudentCount(sources.length, "fuente", "fuentes")}${lot.includesBase ? " + base" : ""}`;
  summary.appendChild(counts);
  group.appendChild(summary);

  const body = document.createElement("div");
  body.className = "rag-lot-body";
  const info = document.createElement("p");
  info.className = "rag-lot-info";
  info.textContent = [
    toText(lot.description),
    lot.includesBase
      ? "Los estudiantes con este lote reciben sus fuentes y las de la base del curso."
      : "Los estudiantes con este lote reciben solo estas fuentes (sin la base).",
  ].filter(Boolean).join(" ");
  body.appendChild(info);

  const actions = document.createElement("div");
  actions.className = "rag-lot-actions";
  if (!isActive) {
    const activate = document.createElement("button");
    activate.type = "button";
    activate.className = "primary-button analyze-button";
    activate.textContent = "Activar en el curso";
    activate.disabled = busy;
    activate.setAttribute("aria-label", `Activar el lote ${toText(lot.name)} en ${course.code}`);
    activate.addEventListener("click", () => {
      setActiveRagLot(course.code, lot.id).catch(() => {});
    });
    actions.appendChild(activate);
  }
  const upload = document.createElement("button");
  upload.type = "button";
  upload.className = "ghost-button analyze-button";
  upload.textContent = "Cargar fuente aqui";
  upload.disabled = busy || !!overlayState.analysisBusy;
  upload.setAttribute("aria-label", `Cargar una fuente en el lote ${toText(lot.name)} de ${course.code}`);
  upload.addEventListener("click", () => {
    setRagUploadLot(course.code, lot.id);
    startRagUploadForCourse(course.code);
  });
  actions.appendChild(upload);
  const retire = document.createElement("button");
  retire.type = "button";
  retire.className = "ghost-button analyze-button danger-button";
  retire.textContent = "Retirar lote";
  retire.disabled = busy;
  retire.setAttribute("aria-label", `Retirar el lote ${toText(lot.name)} de ${course.code}`);
  retire.addEventListener("click", () => {
    const confirmed = window.confirm(`Se retira el lote «${toText(lot.name)}» de ${course.code}. Sus fuentes dejan de llegar a los estudiantes y el curso vuelve a la base si estaba activo. Continuar?`);
    if (!confirmed) return;
    retireRagLot(lot).catch(() => {});
  });
  actions.appendChild(retire);
  body.appendChild(actions);

  body.appendChild(buildRagSourceList(sources, course.code, busy, "Este lote no tiene fuentes todavia. «Cargar fuente aqui» agrega la primera."));
  group.appendChild(body);
  return group;
}

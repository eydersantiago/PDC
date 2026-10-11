// ADACEEN | Capa 3 - Servicios: «Importar lista» de la pestaña «Usuarios» (0.7.21, piloto con
// FPOO-01). Lee la lista de participantes de un curso de Campus Virtual (el CSV que descarga
// Moodle o la tabla copiada de la página «Participantes») y la manda a
// POST /api/admin/users/import; corrige los nombres que una importación anterior leyó mal
// (PUT /api/admin/users/:id) y guarda el docente de las cuentas nuevas
// (PUT /api/admin/default-teacher). La vista está en overlay/content-users-import.js.
// Orden de carga: manifest.json (content_scripts) y background.js (CONTENT_SCRIPT_FILES) deben coincidir.
"use strict";

const COURSE_ROSTER_INSTITUTIONAL_DOMAIN = "correounivalle.edu.co";
const COURSE_ROSTER_MAX_STUDENTS = 300;
const COURSE_ROSTER_TIMEOUT_MS = 60000;
const COURSE_ROSTER_EMAIL = /[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*\.[A-Za-z]{2,}/;
const COURSE_ROSTER_LOWER_WORDS = new Set(["de", "del", "la", "las", "los", "y", "e", "da", "do", "dos", "van", "von"]);

// ---- Lectura del CSV o del texto pegado ----

// Separador de la primera línea con contenido: tabulador (tabla copiada), «;» (Excel en
// español) o «,» (CSV de Moodle), contando solo fuera de comillas.
function detectCourseRosterDelimiter(text) {
  const firstLine = toText(text).split(/\r?\n/).find((line) => line.trim()) || "";
  const counts = { "\t": 0, ";": 0, ",": 0 };
  let quoted = false;
  for (const char of firstLine) {
    if (char === "\"") quoted = !quoted;
    else if (!quoted && Object.prototype.hasOwnProperty.call(counts, char)) counts[char] += 1;
  }
  if (counts["\t"] > 0) return "\t";
  return counts[";"] > counts[","] ? ";" : ",";
}

// Filas y celdas con comillas como las escribe un CSV (comillas dobles escapadas y saltos de
// línea dentro de comillas).
function splitCourseRosterRows(text, delimiter) {
  const rows = [];
  let row = [];
  let cell = "";
  let quoted = false;
  const source = toText(text).replace(/^﻿/, "");
  for (let index = 0; index < source.length; index += 1) {
    const char = source[index];
    if (quoted) {
      if (char === "\"" && source[index + 1] === "\"") {
        cell += "\"";
        index += 1;
      } else if (char === "\"") {
        quoted = false;
      } else {
        cell += char;
      }
      continue;
    }
    if (char === "\"" && !cell.trim()) {
      quoted = true;
      cell = "";
    } else if (char === delimiter) {
      row.push(cell.trim());
      cell = "";
    } else if (char === "\n" || char === "\r") {
      if (char === "\r" && source[index + 1] === "\n") index += 1;
      row.push(cell.trim());
      if (row.some(Boolean)) rows.push(row);
      row = [];
      cell = "";
    } else {
      cell += char;
    }
  }
  row.push(cell.trim());
  if (row.some(Boolean)) rows.push(row);
  return rows;
}

function normalizeCourseRosterHeader(value) {
  return toText(value).normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase().trim();
}

// Columnas por su encabezado (Moodle en español o inglés): el correo y alguna del nombre. null si
// la fila no es un encabezado (una línea suelta «Correo electrónico» de la tabla copiada no lo es).
function findCourseRosterColumns(row) {
  const headers = row.map(normalizeCourseRosterHeader);
  const find = (pattern, exclude) => headers.findIndex((header) => pattern.test(header) && !(exclude && exclude.test(header)));
  const email = find(/correo|e-?mail|mail/);
  if (email < 0 || row.some((cell) => COURSE_ROSTER_EMAIL.test(cell))) return null;
  const columns = {
    email,
    fullName: find(/^nombre completo$|^full ?name$|^nombre \/ apellido|^nombre y apellido/),
    firstName: find(/^nombre|^first ?name|^name$/, /apellido|completo|usuario|user|corto|short|curso/),
    lastName: find(/apellido|last ?name|surname/),
    role: find(/^roles?$|^rol\b|^role/),
    status: find(/estatus|^estado|^status/),
  };
  return columns.fullName < 0 && columns.firstName < 0 && columns.lastName < 0 ? null : columns;
}

// ---- La tabla copiada de «Participantes» ----
// Copiada de la página, cada fila empieza con el rótulo de su casilla («Seleccionar 'APELLIDOS
// NOMBRES'»), la celda del nombre trae pegadas las iniciales del avatar («AAALCANTARA MUÑOZ…», sin
// foto en Campus) y el rol, los grupos, el último acceso y el estatus pueden quedar en líneas
// aparte. Se lee por registros: de un rótulo al siguiente, con el nombre del rótulo. Sin rótulos
// (se copió desde la columna del nombre), un registro por cada línea con correo.

const COURSE_ROSTER_LABEL = /^\s*(?:seleccionar|select)\s+['"‘’“”](.*)['"‘’“”]\s*$/i;
const COURSE_ROSTER_ROLE_CELL = /^(?:estudiante|student|alumn|profesor|teacher|non-editing|docente|tutor|monitor|gestor|manager)/i;
const COURSE_ROSTER_STATUS_CELL = /^(?:activo|active|suspendido|suspended|no activo|inactivo|no actual|not current)$/i;
const COURSE_ROSTER_OTHER_CELL = /^(?:no hay grupos|no groups|nunca|never)$|^\d+\s+(?:segundo|minuto|hora|d[ií]a|semana|mes|año|second|minute|hour|day|week|month|year)/i;

// Nombre del rótulo de la casilla, o "" («Seleccionar todos» no lleva comillas).
function courseRosterLabel(line) {
  const match = COURSE_ROSTER_LABEL.exec(toText(line).split("\t")[0]);
  const label = match ? match[1].trim() : "";
  return /\p{L}/u.test(label) ? label : "";
}

function courseRosterLineCells(line) {
  const text = toText(line);
  if (!text.trim()) return [];
  const row = splitCourseRosterRows(text, detectCourseRosterDelimiter(text))[0] || [];
  return row.map((cell) => cell.trim()).filter(Boolean);
}

// Registros { label, cells }: con rótulos, de uno al siguiente; sin rótulos, desde cada línea con
// correo (también una fila sin rótulo en medio de las que lo tienen). Un registro termina en su
// estatus: lo que siga, como el pie de la página, no cuenta.
function groupCourseRosterRecords(lines, labeled) {
  const records = [];
  let current = null;
  const append = (cells) => {
    current.cells.push(...cells);
    if (cells.some((cell) => COURSE_ROSTER_EMAIL.test(cell))) current.hasEmail = true;
    if (cells.some((cell) => COURSE_ROSTER_STATUS_CELL.test(cell))) current.done = true;
  };
  for (const line of lines) {
    const label = labeled ? courseRosterLabel(line) : "";
    if (label) {
      current = { label, cells: [], hasEmail: false, done: false };
      records.push(current);
      append(courseRosterLineCells(toText(line).split("\t").slice(1).join("\t")));
      continue;
    }
    const cells = courseRosterLineCells(line);
    if (cells.some((cell) => COURSE_ROSTER_EMAIL.test(cell)) && (!current || current.hasEmail || current.done)) {
      current = { label: "", cells: [], hasEmail: false, done: false };
      records.push(current);
    }
    if (!current || current.done || !cells.length) continue;
    append(cells);
  }
  return records;
}

function isCourseRosterNameCell(cell) {
  return /\p{L}/u.test(cell)
    && !COURSE_ROSTER_EMAIL.test(cell)
    && !COURSE_ROSTER_ROLE_CELL.test(cell)
    && !COURSE_ROSTER_STATUS_CELL.test(cell)
    && !COURSE_ROSTER_OTHER_CELL.test(cell);
}

// ¿Trae pegadas las iniciales del avatar? «AAALCANTARA MUÑOZ ANDRES FELIPE» (A de Alcántara y A de
// Andrés): la primera letra se repite como tercera y la segunda empieza otra palabra.
function hasCourseRosterInitials(name) {
  const words = toText(name).trim().split(/\s+/);
  const first = Array.from(words[0] || "");
  if (words.length < 2 || first.length < 4 || words[0] !== words[0].toUpperCase()) return false;
  if (first[0] !== first[2] || !/\p{Lu}/u.test(first[1])) return false;
  return words.slice(1).some((word) => Array.from(word)[0] === first[1]);
}

function readCourseRosterRecords(records) {
  const entries = records.map((record) => {
    const emailCell = record.cells.find((cell) => COURSE_ROSTER_EMAIL.test(cell)) || "";
    return {
      email: toText((COURSE_ROSTER_EMAIL.exec(emailCell) || [""])[0]).toLowerCase(),
      roleText: record.cells.filter((cell) => COURSE_ROSTER_ROLE_CELL.test(cell)).join(" "),
      statusText: normalizeCourseRosterHeader(record.cells.find((cell) => COURSE_ROSTER_STATUS_CELL.test(cell)) || ""),
      name: record.label || record.cells.find(isCourseRosterNameCell) || "",
      fromLabel: !!record.label,
    };
  });
  // Sin rótulos, las iniciales se quitan solo si la mayoría de los nombres las trae (quien tiene
  // foto en Campus no las lleva) y el correo no trae la palabra tal cual: «ALARCON VELEZ LAURA»,
  // de laura.alarcon@…, se parece a unas iniciales pero no lo es.
  const guessed = entries.filter((entry) => !entry.fromLabel && entry.name);
  const withInitials = guessed.filter((entry) => hasCourseRosterInitials(entry.name));
  if (withInitials.length >= 2 && withInitials.length * 5 >= guessed.length * 3) {
    for (const entry of withInitials) {
      const firstWord = normalizeCourseRosterName(entry.name.trim().split(/\s+/)[0]).replace(/[^a-z]/g, "");
      const localPart = normalizeCourseRosterName(entry.email.split("@")[0]).replace(/[^a-z]/g, "");
      if (!localPart.includes(firstWord)) entry.name = Array.from(entry.name.trim()).slice(2).join("");
    }
  }
  return entries;
}

// El CSV que descarga Campus (con encabezado). null si no lo tiene, o si la mayoría de las filas
// no trae correo: es la tabla copiada, con cada fila partida en varias líneas.
function readCourseRosterCsv(source) {
  const rows = splitCourseRosterRows(source, detectCourseRosterDelimiter(source));
  let columns = null;
  let start = 0;
  for (let index = 0; index < Math.min(rows.length, 5) && !columns; index += 1) {
    columns = findCourseRosterColumns(rows[index]);
    start = index + 1;
  }
  if (!columns) return null;
  const entries = rows.slice(start).map((row) => {
    const email = toText((COURSE_ROSTER_EMAIL.exec(row[columns.email] || "") || COURSE_ROSTER_EMAIL.exec(row.join(" ")) || [""])[0]).toLowerCase();
    let name = columns.fullName >= 0 ? row[columns.fullName] : "";
    if (!name) name = [columns.firstName >= 0 ? row[columns.firstName] : "", columns.lastName >= 0 ? row[columns.lastName] : ""].filter(Boolean).join(" ");
    return {
      email,
      roleText: toText(row[columns.role]),
      statusText: normalizeCourseRosterHeader(row[columns.status]),
      name: name || row.find(isCourseRosterNameCell) || "",
    };
  });
  return entries.filter((entry) => entry.email).length * 2 >= entries.length ? entries : null;
}

// Nombre como lo escribe Campus (MAYÚSCULAS) en tipo título; en minúsculas «de», «del», «la»...
function formatCourseRosterName(value) {
  const clean = toText(value).replace(/\s+/g, " ").trim();
  if (!clean || clean !== clean.toUpperCase()) return clean;
  return clean
    .toLowerCase()
    .split(" ")
    .map((word, index) => (index > 0 && COURSE_ROSTER_LOWER_WORDS.has(word)
      ? word
      : word.replace(/(^|[-'])(\p{L})/gu, (_all, lead, letter) => `${lead}${letter.toUpperCase()}`)))
    .join(" ");
}

function courseRosterRoleKind(text) {
  const value = normalizeCourseRosterHeader(text);
  if (!value) return "student";
  if (/estudiante|student|alumn/.test(value)) return "student";
  if (/profesor|teacher|docente|tutor|monitor|editing|manager|gestor/.test(value)) return "teacher";
  return "other";
}

function isCourseRosterInstitutional(email) {
  return toText(email).toLowerCase().endsWith(`@${COURSE_ROSTER_INSTITUTIONAL_DOMAIN}`);
}

/**
 * Lista de participantes de Campus: { students, teachers, ignored, inactive, total }. Los
 * estudiantes llevan { email, displayName, institutional }; los docentes { email,
 * displayName, roleLabel }. Lee el CSV que descarga Campus (con encabezado) o la tabla copiada
 * de la página (por registros: ver groupCourseRosterRecords).
 */
function parseCourseRoster(text) {
  const source = toText(text).replace(/^\uFEFF/, "");
  const result = { students: [], teachers: [], ignored: 0, inactive: 0, total: 0 };
  if (!source.trim()) return result;
  const lines = source.split(/\r\n|\r|\n/);
  const labeled = lines.some((line) => courseRosterLabel(line));
  const entries = (!labeled && readCourseRosterCsv(source)) || readCourseRosterRecords(groupCourseRosterRecords(lines, labeled));
  const seen = new Set();
  for (const entry of entries) {
    const email = entry.email;
    if (!email) {
      result.ignored += 1;
      continue;
    }
    result.total += 1;
    if (seen.has(email)) continue;
    seen.add(email);
    if (/suspend|no activ|inactiv|no actual|not current/.test(entry.statusText)) {
      result.inactive += 1;
      continue;
    }
    // Por si la casilla quedó como nombre («Seleccionar 'X'»).
    const cleanName = toText(entry.name).replace(/^(?:seleccionar|select)\s+/i, "").replace(/^['"‘’“”]+|['"‘’“”]+$/g, "");
    const displayName = formatCourseRosterName(cleanName) || email.split("@")[0];
    const kind = courseRosterRoleKind(entry.roleText);
    if (kind === "teacher") {
      result.teachers.push({ email, displayName, roleLabel: toText(entry.roleText) || "Profesor" });
    } else if (kind === "student") {
      result.students.push({ email, displayName, institutional: isCourseRosterInstitutional(email) });
    } else {
      result.ignored += 1;
    }
  }
  return result;
}

// ---- Nombres mal leídos (0.7.21) ----
// Hasta esta corrección, la tabla copiada dejaba los nombres con las iniciales del avatar pegadas
// («Aaalcantara Muñoz Andres Felipe») o, sin nombre, con el correo. Al volver a importar la lista
// se corrigen esas cuentas (y las de los docentes de la lista) con PUT /api/admin/users/:id; un
// nombre que alguien cambió a mano no se toca.

function normalizeCourseRosterName(value) {
  return toText(value).normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase().replace(/\s+/g, " ").trim();
}

function courseRosterNameNeedsRepair(current, wanted, email) {
  const now = normalizeCourseRosterName(current);
  const target = normalizeCourseRosterName(wanted);
  if (!target || now === target) return false;
  if (now === normalizeCourseRosterName(toText(email).split("@")[0])) return true;
  return now.length === target.length + 2 && now.slice(2) === target && now[0] === target[0] && /^[a-z]{2}$/.test(now.slice(0, 2));
}

/** Cuentas de la lista con el nombre mal leído: [{ id, email, from, to }]. */
function collectCourseRosterNameRepairs(roster, users) {
  const wanted = new Map();
  for (const entry of [...(roster?.students || []), ...(roster?.teachers || [])]) {
    if (!wanted.has(entry.email)) wanted.set(entry.email, entry.displayName);
  }
  return (Array.isArray(users) ? users : [])
    .map((user) => ({ id: toText(user.id), email: toText(user.email).toLowerCase(), from: toText(user.displayName) }))
    .filter((user) => user.id && wanted.has(user.email) && courseRosterNameNeedsRepair(user.from, wanted.get(user.email), user.email))
    .map((user) => ({ ...user, to: toText(wanted.get(user.email)).slice(0, 120) }));
}

/** Corrige los nombres uno por uno: { fixed, failed }. */
async function repairCourseRosterNames(repairs, onProgress) {
  const fixed = [];
  const failed = [];
  for (const repair of repairs) {
    try {
      await updateAdminUserRow(repair.id, { displayName: repair.to });
      fixed.push(repair);
    } catch (error) {
      failed.push({ ...repair, error: toText(error?.message) || String(error) });
    }
    if (typeof onProgress === "function") onProgress(fixed.length + failed.length, repairs.length);
  }
  return { fixed, failed };
}

// ---- Backend ----

function describeCourseRosterBackendError(error, what) {
  return Number(error?.status) === 404
    ? `Este backend todavía no permite ${what} desde aquí: llega con la versión 0.7.21.`
    : toText(error?.message) || String(error);
}

// POST /api/admin/users/import: { teacherUserId, courseCode, created, updated, unchanged, skipped }.
async function importCourseRoster(payload) {
  const baseUrl = normalizeBaseUrl(overlayState.backendUrl);
  if (!baseUrl || !overlayState.sessionId || !canManageUsersSession()) {
    throw new Error("Inicia sesión como administrador o docente para importar la lista.");
  }
  try {
    return await fetchJsonWithTimeout(`${baseUrl}/api/admin/users/import`, {
      method: "POST",
      headers: buildApiHeaders(),
      body: JSON.stringify({
        teacherUserId: payload?.teacherUserId || null,
        courseCode: toText(payload?.courseCode) || "FPOO",
        students: (Array.isArray(payload?.students) ? payload.students : [])
          .slice(0, COURSE_ROSTER_MAX_STUDENTS)
          .map((student) => ({ email: toText(student.email), displayName: toText(student.displayName).slice(0, 200) })),
      }),
    }, COURSE_ROSTER_TIMEOUT_MS);
  } catch (error) {
    throw new Error(describeCourseRosterBackendError(error, "importar listas"));
  }
}

// PUT /api/admin/default-teacher (solo administrador): devuelve defaultTeacher.
async function saveDefaultTeacherChoice(teacherUserId) {
  const baseUrl = normalizeBaseUrl(overlayState.backendUrl);
  if (!baseUrl || !overlayState.sessionId || !isAdminSession()) {
    throw new Error("Solo el administrador elige el docente de las cuentas nuevas.");
  }
  try {
    const response = await fetchJsonWithTimeout(`${baseUrl}/api/admin/default-teacher`, {
      method: "PUT",
      headers: buildApiHeaders(),
      body: JSON.stringify({ teacherUserId: toText(teacherUserId) || null }),
    });
    overlayState.adminDefaultTeacher = response?.defaultTeacher || null;
    return overlayState.adminDefaultTeacher;
  } catch (error) {
    throw new Error(describeCourseRosterBackendError(error, "elegir el docente de las cuentas nuevas"));
  }
}

// Cuenta de docente para alguien de la lista que aún no la tiene (clave al azar: entra con Google).
async function createRosterTeacherAccount(teacher) {
  const baseUrl = normalizeBaseUrl(overlayState.backendUrl);
  if (!baseUrl || !overlayState.sessionId || !isAdminSession()) {
    throw new Error("Solo el administrador crea cuentas de docente.");
  }
  const bytes = new Uint8Array(18);
  crypto.getRandomValues(bytes);
  const password = Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
  const response = await fetchJsonWithTimeout(`${baseUrl}/api/admin/users`, {
    method: "POST",
    headers: buildApiHeaders(),
    body: JSON.stringify({
      role: "teacher",
      email: toText(teacher?.email),
      displayName: toText(teacher?.displayName).slice(0, 120) || toText(teacher?.email),
      password,
      teacherUserId: null,
      assignedCourseCodes: [],
    }),
  });
  return response?.user || null;
}

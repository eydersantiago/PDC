// ADACEEN | Capa 3 - Servicios: «Importar lista» de la pestaña «Usuarios» (0.7.21, piloto con
// FPOO-01). Lee la lista de participantes de un curso de Campus Virtual (el CSV que descarga
// Moodle o la tabla copiada de la página «Participantes») y la manda a
// POST /api/admin/users/import; también guarda el docente de las cuentas nuevas
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

// Columnas por su encabezado (Moodle en español o inglés). null si la fila no es un encabezado.
function findCourseRosterColumns(row) {
  const headers = row.map(normalizeCourseRosterHeader);
  const find = (pattern, exclude) => headers.findIndex((header) => pattern.test(header) && !(exclude && exclude.test(header)));
  const email = find(/correo|e-?mail|mail/);
  if (email < 0 || row.some((cell) => COURSE_ROSTER_EMAIL.test(cell))) return null;
  return {
    email,
    fullName: find(/^nombre completo$|^full ?name$|^nombre \/ apellido|^nombre y apellido/),
    firstName: find(/^nombre|^first ?name|^name$/, /apellido|completo|usuario|user|corto|short|curso/),
    lastName: find(/apellido|last ?name|surname/),
    role: find(/^roles?$|^rol\b|^role/),
    status: find(/estatus|^estado|^status/),
  };
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
 * displayName, roleLabel }. Sin encabezado (una tabla pegada sin la primera fila) toma de cada
 * fila el correo, el primer texto que no es correo ni rol como nombre y el rol que aparezca.
 */
function parseCourseRoster(text) {
  const delimiter = detectCourseRosterDelimiter(text);
  const rows = splitCourseRosterRows(text, delimiter);
  const result = { students: [], teachers: [], ignored: 0, inactive: 0, total: 0 };
  if (!rows.length) return result;
  let columns = null;
  let start = 0;
  for (let index = 0; index < Math.min(rows.length, 5); index += 1) {
    columns = findCourseRosterColumns(rows[index]);
    if (columns) {
      start = index + 1;
      break;
    }
  }
  const seen = new Set();
  for (const row of rows.slice(start)) {
    const emailCell = columns && columns.email >= 0 ? row[columns.email] : "";
    const email = toText((COURSE_ROSTER_EMAIL.exec(emailCell) || COURSE_ROSTER_EMAIL.exec(row.join(" ")) || [""])[0]).toLowerCase();
    if (!email) {
      result.ignored += 1;
      continue;
    }
    result.total += 1;
    if (seen.has(email)) continue;
    seen.add(email);
    const roleText = columns ? toText(row[columns.role]) : row.filter((cell) => courseRosterRoleKind(cell) !== "other" && !COURSE_ROSTER_EMAIL.test(cell) && /estudiante|student|alumn|profesor|teacher|docente/i.test(cell)).join(" ");
    const statusText = columns ? normalizeCourseRosterHeader(row[columns.status]) : "";
    if (/suspend|no activ|inactiv/.test(statusText)) {
      result.inactive += 1;
      continue;
    }
    let name = "";
    if (columns) {
      if (columns.fullName >= 0) name = row[columns.fullName];
      else name = [columns.firstName >= 0 ? row[columns.firstName] : "", columns.lastName >= 0 ? row[columns.lastName] : ""].filter(Boolean).join(" ");
    }
    if (!name) {
      name = row.find((cell) => cell && !COURSE_ROSTER_EMAIL.test(cell) && /\p{L}/u.test(cell) && !/estudiante|student|profesor|teacher|docente|activo|active/i.test(cell)) || "";
    }
    // La tabla copiada de «Participantes» puede traer el texto de la casilla («Seleccionar 'X'»).
    const cleanName = toText(name).replace(/^(?:seleccionar|select)\s+/i, "").replace(/^['"‘’“”]+|['"‘’“”]+$/g, "");
    const displayName = formatCourseRosterName(cleanName) || email.split("@")[0];
    const kind = courseRosterRoleKind(roleText);
    if (kind === "teacher") {
      result.teachers.push({ email, displayName, roleLabel: toText(roleText) || "Profesor" });
    } else if (kind === "student") {
      result.students.push({ email, displayName, institutional: isCourseRosterInstitutional(email) });
    } else {
      result.ignored += 1;
    }
  }
  return result;
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

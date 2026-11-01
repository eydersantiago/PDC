"use strict";

// ADACEEN | Capa 1 - Estado: estados vacios con que arranca cada parte de overlayState (GitHub, proyecto,
// bitacora, RAG, Campus, VS Code, estudiantes, quices y agenda). Movido sin cambios de session.state.js.

const EMPTY_GITHUB_APP_STATUS = {
  configured: false,
  missingConfig: [],
  installUrlBase: "",
  setupUrl: "",
  installation: null,
  repoFullName: "",
  hasRepoAccess: null,
  bootstrapReady: false,
  bootstrapSource: "",
  bootstrapUpdatedAt: "",
  bootstrapDetails: "",
  bootstrapPullUrl: "",
  bootstrapPullNumber: null,
  bootstrapBranchName: "",
  bootstrapCodespaceUrl: "",
  bootstrapSignals: null,
};

const EMPTY_GITHUB_USER_STATUS = {
  configured: false,
  missingConfig: [],
  invalidConfig: [],
  connected: false,
  accountLogin: "",
  accountEmail: "",
  scopes: [],
  hasCodespaceScope: false,
  updatedAt: "",
};

const EMPTY_PROJECT_CONTEXT_STATUS = {
  configured: false,
  repoFullName: "",
  hasContext: false,
  latestRequestId: "",
  latestSnapshotId: "",
  latestVersion: "",
  currentVersion: "",
  updatedAt: "",
  source: "",
  summary: "",
  details: "",
  totalVersions: 0,
  requestStatus: "",
};

const EMPTY_PROJECT_CONTEXT_INSIGHT = {
  configured: false,
  repoFullName: "",
  hasContext: false,
  requestId: "",
  snapshotId: "",
  version: "",
  currentVersion: "",
  source: "",
  updatedAt: "",
  totalFiles: 0,
  totalBytes: 0,
  summary: "",
  mainFilePath: "",
  mainFileReason: "",
  autoAdvice: "",
  modelEnabled: true,
  modelUsed: false,
  modelProvider: "",
  candidates: [],
  modelError: "",
  storageReadError: "",
  screenshotUsed: false,
  screenshotSource: "",
  screenshotOcrText: "",
  screenshotConfidence: 0,
  screenshotSavedPath: "",
  screenshotSavedAt: "",
};

const EMPTY_DOCUMENT_CLASSIFICATION_STATE = {
  items: [],
  busy: false,
  message: "",
  error: "",
};

// checkedAt (0.7.16): cuando se consulto por ultima vez (0 = sin consultar). Con 0 no se sabe si
// falta la bitacora: Inicio dice "Consultando" y la accion recomendada no pide subirla. busy
// desactiva los botones (consultar, descargar, exportar, borrar); checking, solo al consultar.
const EMPTY_TEACHER_BITACORA_STATUS = {
  loaded: false,
  latest: null,
  summary: null,
  busy: false,
  checking: false,
  error: "",
  checkedAt: 0,
};

// Administrador (0.7.22): el docente cuya bitácora gestiona en la pestaña «Bitácora» y la lista
// de docentes activos (vienen de GET /api/documents/bitacora/status).
const EMPTY_BITACORA_OWNER_STATE = {
  teacherUserId: "",
  teachers: [],
  message: "",
};

// Administrador (navegador 0.7.22): el docente cuyo RAG gestiona en la pestaña «RAG» y la lista de
// docentes activos (vienen de GET /api/rag/sources, como la bitácora).
const EMPTY_RAG_OWNER_STATE = {
  teacherUserId: "",
  teachers: [],
  message: "",
};

const EMPTY_TEACHER_RAG_STATE = {
  courses: [],
  sources: [],
  selectedCourseCode: "FPOO",
  defaultCourseCode: "FPOO",
  busy: false,
  error: "",
  message: "",
};

const EMPTY_CODESPACE_WAITING_CONTEXT = {
  ragCourseCode: "",
  ragCourseName: "",
  ragSources: [],
  ragFetchedAt: "",
  ragError: "",
};

const EMPTY_CAMPUS_COURSE_ACCESS_STATE = {
  checked: false,
  checking: false,
  courseCode: "",
  accessConfirmed: false,
  bitacoraLoaded: false,
  bitacoraSource: null,
  sourceCount: 0,
  error: "",
  message: "",
};

const EMPTY_STUDENT_COURSE_STATE = {
  courses: [],
  selectedCourseCode: "FPOO",
  defaultCourseCode: "FPOO",
  busy: false,
  error: "",
  message: "",
};

const EMPTY_VSCODE_SYNC_STATE = {
  connected: false,
  // Rack de menos de 10 min (isVscodeRackFresh): solo entonces se dice "VS Code conectado".
  fresh: false,
  busy: false,
  error: "",
  message: "",
  latestRack: null,
  latestRackForFile: null,
  globalLatestRack: null,
  updatedAt: "",
  // La extension de VS Code de este editor segun el backend (0.8.4): lo que devuelve
  // normalizeVscodeExtensionReport, o null si el backend no la vio (o es anterior y no la manda).
  extension: null,
};

// Si VS Code publico contexto (un rack) hace poco para el repo de la pagina (refreshVscodeRackStatus).
const EMPTY_VSCODE_RACK_STATUS = {
  repoFullName: "",
  connected: false,
  updatedAt: "",
};

// Pestana "Estudiantes" (docente y administrador, 0.7.13): lista con sesiones, intervenciones,
// quices y nota por estudiante, filtro y detalle abierto. Se llena al abrir la pestana.
const EMPTY_STUDENTS_PANEL_STATE = Object.freeze({
  items: [],
  totals: null,
  generatedAt: "",
  loadedAt: 0,
  busy: false,
  message: "",
  error: "",
  query: "",
  selectedId: "",
  detail: null,
  detailBusy: false,
  detailError: "",
  detailLoadedAt: 0,
  // Gestión como en «Usuarios» (0.7.22): casillas marcadas, fila en edición y el aviso de la
  // última acción (crear, editar, eliminar, importar). Siempre se reemplazan, nunca se mutan.
  checkedIds: [],
  editingId: "",
  actionMessage: "",
});

// Pestanas de la vista principal por rol (0.7.13). "tutor" solo para estudiante y docente;
// "estudiantes" y "usuarios" para docente y administrador; "rag" (0.7.14), "quices" (0.7.15) y
// "bitacora" (0.7.16) para el docente y, desde la 0.7.22, el administrador (también "rag", para cargar
// fuentes en el RAG de un docente); "agenda" (0.7.17) solo para el estudiante.
const MAIN_TAB_IDS = Object.freeze(["inicio", "tutor", "agenda", "estudiantes", "rag", "quices", "bitacora", "usuarios"]);

// Agenda del curso en Google Calendar (0.7.17, services/google-calendar.service.js): la ultima
// sincronizacion, la cuenta de Google y los bloques de estudio sugeridos.
const EMPTY_COURSE_CALENDAR_STATE = Object.freeze({
  busy: false,
  message: "",
  error: "",
  account: "",
  lastSync: null,
  suggestions: [],
  suggestionsNote: "",
});

const STUDENTS_PANEL_STALE_MS = 60 * 1000;

// Pestana «Quices» del docente (0.7.15): banco propio, lanzamientos y quices hechos.
const EMPTY_QUIZZES_PANEL_STATE = Object.freeze({
  quizzes: [],
  launches: [],
  attempts: [],
  summary: null,
  loadedAt: 0,
  busy: false,
  message: "",
  error: "",
});

// Lotes de RAG (0.7.15): catalogo de GET /api/rag/lots (por curso: base, lotes y activo).
const EMPTY_RAG_LOTS_STATE = Object.freeze({
  courses: [],
  disabledSourceIds: [],
  baseLotName: "Base del curso",
  loadedAt: 0,
  busy: false,
  message: "",
  error: "",
});

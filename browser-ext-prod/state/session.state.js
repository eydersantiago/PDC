"use strict";

function normalizeText(value) {
  return String(value || "")
    .replace(/\u00a0/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function normalizeCodeLine(value) {
  return String(value || "")
    .replace(/\u00a0/g, " ")
    .replace(/\r/g, "")
    .replace(/[ \t]+$/g, "");
}

function detectPageContext(urlText = location.href) {
  const url = String(urlText || "").toLowerCase();
  if (url.includes("campusvirtual.univalle.edu.co")) return "campus";
  if (url.includes("github.com") || url.includes("github.dev")) return "github";
  return "unknown";
}

function detectCampusPageType(urlText = location.href) {
  try {
    const url = new URL(urlText, location.href);
    const host = url.hostname.toLowerCase();
    if (host !== "campusvirtual.univalle.edu.co") return "";

    const path = url.pathname.toLowerCase().replace(/\/+/g, "/");
    const courseId = Number(url.searchParams.get("id") || 0);
    if (path.endsWith("/moodle/course/view.php") && Number.isInteger(courseId) && courseId > 0) {
      return "campus_course";
    }
    if (path.endsWith("/moodle/my/courses.php") || path.includes("/moodle/my/")) {
      return "campus_courses";
    }
    return "campus";
  } catch {
    const url = String(urlText || "").toLowerCase();
    if (/campusvirtual\.univalle\.edu\.co\/moodle\/course\/view\.php\?[^#]*\bid=\d+/.test(url)) {
      return "campus_course";
    }
    if (url.includes("campusvirtual.univalle.edu.co/moodle/my/")) return "campus_courses";
    return url.includes("campusvirtual.univalle.edu.co") ? "campus" : "";
  }
}

function isCampusCoursePageContext(context) {
  return String(context?.pageContext || "").trim() === "campus"
    && String(context?.pageType || "").trim() === "campus_course";
}

const OVERLAY_HOST_ID = "adaceen-overlay-host";
const STORAGE_KEY_OVERLAY_PINNED = "adaceenOverlayPinned";
const STORAGE_KEY_ENABLED = "assistantEnabled";
const STORAGE_KEY_BACKEND_URL = "mentorBackendUrl";
const STORAGE_KEY_LEARNING_GOAL = "studentLearningGoal";
const STORAGE_KEY_SELECTED_RAG_COURSE = "studentSelectedRagCourse";
const STORAGE_KEY_SESSION_ID = "adaceenSessionId";
const STORAGE_KEY_PRIVACY_ACCEPTED_BY_USER = "adaceenPrivacyAcceptedByUser";
const STORAGE_KEY_PROJECT_CONSENT_BY_USER = "adaceenProjectConsentByUser";
const STORAGE_KEY_SETUP_DONE_BY_USER = "adaceenSetupDoneByUser";
const STORAGE_KEY_AUTO_CONFIG_ENABLED = "adaceenAutoConfigEnabled";
const DEFAULT_BACKEND_URL = "https://app-adaceen-api-eyder05232002.azurewebsites.net";
const DEFAULT_LEARNING_GOAL = "oop_basics";
const BACKEND_TIMEOUT_MS = 12000;
const OCR_BACKEND_TIMEOUT_MS = 1500000;
const MAX_LIST_ITEMS = 4;
const MAX_PREVIEW_CHARS = 900;
const MAX_ANALYSIS_RENDER_ITEMS = 10000;
const OVERLAY_MARGIN = 16;
const SCREENSHOT_CAPTURE_PAINT_FRAMES = 2;
const SCREENSHOT_CAPTURE_SETTLE_MS = 90;
// Mantiene el tour alineado con permisos reales antes de crear PR.
const BYPASS_GITHUB_APP_INSTALL_VALIDATION = false;

const LEARNING_GOALS = [
  { id: "oop_basics", label: "Clases y objetos" },
  { id: "encapsulation", label: "Encapsulamiento" },
  { id: "inheritance", label: "Herencia y polimorfismo" },
  { id: "debugging", label: "Resolver errores" },
  { id: "github_flow", label: "GitHub y Codespaces" },
];

const DEFAULT_POLICY = {
  policyName: "RF-05 base del piloto",
  outcome: "RA1",
  tone: "warm",
  frequency: "medium",
  helpLevel: "progressive",
  allowMiniQuiz: true,
  strictNoSolution: true,
  maxHintsPerExercise: 3,
  fallbackMessage:
    "No puedo ayudar con ese tema o con tan poco contexto. Muestrame el ejercicio, el error o un fragmento del codigo del curso.",
  customInstruction: "",
  allowedInterventions: ["explanation", "hint", "example", "mini_quiz"],
  eventRules: {},
};

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

const EMPTY_TEACHER_BITACORA_STATUS = {
  loaded: false,
  latest: null,
  summary: null,
  busy: false,
  error: "",
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
  busy: false,
  error: "",
  message: "",
  latestRack: null,
  lastAction: null,
  updatedAt: "",
  suggestionWaitKey: "",
  suggestionWaitStartedAt: 0,
};

const overlayState = {
  assistantEnabled: true,
  autoConfigEnabled: true,
  backendUrl: DEFAULT_BACKEND_URL,
  selectedLearningGoal: DEFAULT_LEARNING_GOAL,
  sessionId: "",
  session: null,
  policy: { ...DEFAULT_POLICY },
  telemetry: [],
  behaviorMetrics: [],
  authError: "",
  authBusy: false,
  firstLoginConfirmationOpen: false,
  processNoticeOpen: false,
  analysisWindowOpen: false,
  started: false,
  settingsOpen: false,
  loading: false,
  context: null,
  ideas: [],
  guide: [],
  analysisUnlocked: false,
  welcome: "",
  mentorSummary: "",
  statusMessage: "",
  operationTitle: "",
  operationDetail: "",
  operationKind: "busy",
  analysisBusy: false,
  projectAnalysis: null,
  campusAnalysis: null,
  privacyAcceptedByUser: {},
  projectConsentByUser: {},
  setupDoneByUser: {},
  setupRepoFullName: "",
  setupWizardStep: 1,
  setupPrResultByUser: {},
  githubAppStatus: { ...EMPTY_GITHUB_APP_STATUS },
  githubUserStatus: { ...EMPTY_GITHUB_USER_STATUS },
  githubAppBusy: false,
  projectContextStatus: { ...EMPTY_PROJECT_CONTEXT_STATUS },
  projectContextHistory: [],
  projectContextInsight: { ...EMPTY_PROJECT_CONTEXT_INSIGHT },
  documentClassifications: { ...EMPTY_DOCUMENT_CLASSIFICATION_STATE },
  teacherBitacoraPageOpen: false,
  teacherBitacoraStatus: { ...EMPTY_TEACHER_BITACORA_STATUS },
  teacherRagPageOpen: false,
  teacherRagState: { ...EMPTY_TEACHER_RAG_STATE },
  campusCourseAccess: { ...EMPTY_CAMPUS_COURSE_ACCESS_STATE },
  ragCourseCatalog: [],
  ragDefaultCourseCode: "FPOO",
  studentCourseModalOpen: false,
  studentCourseState: { ...EMPTY_STUDENT_COURSE_STATE },
  vscodeSyncState: { ...EMPTY_VSCODE_SYNC_STATE },
  activeRagCourseCode: "",
  ragSources: [],
  projectContextBusy: false,
  projectContextMessage: "",
  projectContextError: "",
  adminUsers: [],
  adminTeachers: [],
  adminUsersBusy: false,
  adminUsersMessage: "",
};

let overlayHost = null;
let overlayRoot = null;
let overlayEls = null;
let preferencesLoaded = false;
let overlayViewportSyncFrame = 0;
let overlayViewportListenersBound = false;

function clamp(value, min, max) {
  return Math.min(Math.max(value, min), max);
}

function getViewportMetrics() {
  const viewport = window.visualViewport;
  return {
    width: viewport?.width || window.innerWidth || document.documentElement.clientWidth || 0,
    height: viewport?.height || window.innerHeight || document.documentElement.clientHeight || 0,
    offsetLeft: viewport?.offsetLeft || 0,
    offsetTop: viewport?.offsetTop || 0,
  };
}

function getOverlayViewportBounds() {
  const { width, height, offsetLeft, offsetTop } = getViewportMetrics();
  const rect = overlayHost?.getBoundingClientRect() || { width: 0, height: 0 };
  const minLeft = offsetLeft + OVERLAY_MARGIN;
  const minTop = offsetTop + OVERLAY_MARGIN;
  const maxLeft = Math.max(minLeft, offsetLeft + width - rect.width - OVERLAY_MARGIN);
  const maxTop = Math.max(minTop, offsetTop + height - rect.height - OVERLAY_MARGIN);

  return { minLeft, minTop, maxLeft, maxTop };
}

function placeOverlay(left, top) {
  if (!overlayHost) return;
  overlayHost.style.left = `${Math.round(left)}px`;
  overlayHost.style.top = `${Math.round(top)}px`;
  overlayHost.style.right = "auto";
  overlayHost.style.bottom = "auto";
}

function syncOverlayToViewport(preferCurrentPosition = true) {
  if (!overlayHost) return;

  const rect = overlayHost.getBoundingClientRect();
  const bounds = getOverlayViewportBounds();
  const defaultLeft = bounds.maxLeft;
  const defaultTop = bounds.minTop;
  const nextLeft = clamp(preferCurrentPosition ? rect.left : defaultLeft, bounds.minLeft, bounds.maxLeft);
  const nextTop = clamp(preferCurrentPosition ? rect.top : defaultTop, bounds.minTop, bounds.maxTop);

  placeOverlay(nextLeft, nextTop);
}

function scheduleOverlayViewportSync(preferCurrentPosition = true) {
  if (overlayViewportSyncFrame) {
    window.cancelAnimationFrame(overlayViewportSyncFrame);
  }

  overlayViewportSyncFrame = window.requestAnimationFrame(() => {
    overlayViewportSyncFrame = 0;
    syncOverlayToViewport(preferCurrentPosition);
  });
}

function bindOverlayViewportListeners() {
  if (overlayViewportListenersBound) return;

  const handleViewportChange = () => {
    scheduleOverlayViewportSync(true);
  };

  window.addEventListener("resize", handleViewportChange);
  window.visualViewport?.addEventListener("resize", handleViewportChange);
  window.visualViewport?.addEventListener("scroll", handleViewportChange);
  overlayViewportListenersBound = true;
}

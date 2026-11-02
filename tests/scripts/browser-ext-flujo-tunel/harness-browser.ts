import { MANIFEST, REPO, TUNNEL_URL, SESSION, type Json } from "./harness-config.js";
import { VirtualClock } from "./harness-clock.js";

// ---- Navegador compartido: storage de la extension, backend falso y reloj ----

type WorkspaceStep = Json;

// Resumen de un estudiante como lo devuelve GET /api/admin/students (services/progress/student-progress.ts).
export function studentProgressFixture(id: string, displayName: string, email: string, grade: Json): Json {
  const withQuizzes = grade.score !== null;
  return {
    id,
    displayName,
    email,
    isActive: true,
    createdAt: "2026-09-01T12:00:00.000Z",
    teacherUserId: "u-docente",
    teacherDisplayName: "Docente Prueba",
    assignedCourseCodes: ["FPOO"],
    pilotCohort: withQuizzes ? "A" : null,
    sessions: { total: withQuizzes ? 3 : 0, browser: withQuizzes ? 2 : 0, editor: withQuizzes ? 1 : 0, cli: 0, active: withQuizzes ? 1 : 0, firstSeenAt: withQuizzes ? "2026-09-20T12:00:00.000Z" : null, lastSeenAt: withQuizzes ? "2026-09-25T12:50:00.000Z" : null, activeNow: withQuizzes },
    interventions: { total: withQuizzes ? 3 : 0, blocked: withQuizzes ? 1 : 0, hints: withQuizzes ? 2 : 0, explanations: 0, examples: 0, miniQuizzes: 0, lastAt: withQuizzes ? "2026-09-25T12:10:00.000Z" : null },
    quizzes: { total: withQuizzes ? 2 : 0, answered: withQuizzes ? 2 : 0, correct: withQuizzes ? 1 : 0, correctRate: withQuizzes ? 50 : null, followUps: withQuizzes ? 1 : 0, averageFollowUpScore: withQuizzes ? 80 : null, skipped: 0, lastAt: withQuizzes ? "2026-09-25T12:20:00.000Z" : null },
    activity: { events: withQuizzes ? 4 : 0, byCategory: withQuizzes ? { tutor: 4 } : {}, totalDurationMs: 0, lastAt: withQuizzes ? "2026-09-25T12:30:00.000Z" : null },
    exercises: { total: withQuizzes ? 1 : 0, hints: withQuizzes ? 2 : 0, lastAt: withQuizzes ? "2026-09-25T12:10:00.000Z" : null },
    grade: { ...grade, correctRate: withQuizzes ? 50 : null, averageFollowUpScore: withQuizzes ? 80 : null, formula: withQuizzes ? "60 % aciertos (50) + 40 % seguimiento (80)." : "Sin quices respondidos." },
    lastActivityAt: withQuizzes ? "2026-09-25T12:50:00.000Z" : null,
  };
}

// Lo que devuelve reply() en fetch (harness-backend.ts).
type FakeReply = (status: number, json: unknown) => { ok: boolean; status: number; headers: { get: () => null }; json: () => Promise<unknown> };

// Estado del navegador y del backend falsos; FakeBrowser (harness-backend.ts) le suma fetch.
export class FakeBrowserState {
  clock = new VirtualClock();
  storage: Record<string, unknown> = {};
  storageListeners: Array<(changes: Json, area: string) => void> = [];
  requests: Array<{ method: string; path: string; query: string; body: Json | null; headers: Record<string, string>; at: number }> = [];
  // Retraso de respuesta por ruta (ms del reloj virtual).
  delays: Record<string, number> = {};
  // Emparejamiento: "ok", "missing" (backend anterior, 404) o "fail" (fallo pasajero, 503).
  pairingMode: "ok" | "missing" | "fail" = "ok";
  // Estado HTTP de /api/workspaces/provider (200 responde el proveedor).
  providerStatus = 200;
  unknownRoutes: string[] = [];
  clipboard: string[] = [];
  githubConnected = false;
  // Cuenta de GitHub conectada y cuando se guardo su token (0.8.1: cambiar de cuenta).
  githubAccountLogin = "alumno";
  githubUpdatedAt = "2026-09-25T12:00:00.000Z";
  prepareSteps: WorkspaceStep[] = [];
  statusSteps: WorkspaceStep[] = [];
  lastWorkspace: WorkspaceStep | null = null;
  sessionValid = true;
  pairingCodes = 0;
  // Estado de la GitHub App: por defecto sin instalar (el tunel no la necesita).
  appStatus: Json = { configured: true, installation: null, hasRepoAccess: null, bootstrapReady: false };
  provider = "tunnel";
  // Ultimo rack publicado por VS Code (GET /api/projects/session/state).
  latestRack: Json | null = null;
  // La extension de VS Code vista por el backend (0.8.4): GET /api/vscode/presence (null = backend
  // anterior, 404; a docentes y administradores el backend les suma workspaceVmStartupCommand) y
  // state.vscodeExtension del estado de la sesion (null = no lo manda).
  vscodePresence: Json | null = null;
  vscodeExtension: Json | null = null;
  // Respuesta del tutor (POST /intervene): sin pistas salvo que la prueba las ponga en result.
  tutorReply: Json = { ideas: [], guide: [], welcome: "", summary: "" };
  // Estado HTTP de POST /intervene (0.7.18): 404 es un backend sin la ruta; 503, un fallo pasajero.
  interveneStatus = 200;
  // Usuarios administrables (GET/PUT /api/admin/users) y fuentes RAG por curso (0.7.14).
  adminUsers: Json[] = [
    { id: "u-est-1", role: "student", email: "ana.maria.perez.gonzalez@correounivalle.edu.co", displayName: "Ana María Pérez González", teacherUserId: "u-docente", teacherDisplayName: "Docente Prueba", assignedCourseCodes: ["FPOO"], isActive: true, createdAt: "2026-09-01T12:00:00.000Z" },
    { id: "u-est-2", role: "student", email: "bruno@correounivalle.edu.co", displayName: "Bruno Prueba", teacherUserId: "u-docente", teacherDisplayName: "Docente Prueba", assignedCourseCodes: ["FPOO", "FPI"], isActive: false, createdAt: "2026-09-01T12:00:00.000Z" },
  ];
  adminUserUpdates: Array<{ id: string; body: Json | null }> = [];
  // «Eliminar seleccionados» (0.7.22): cuerpos de POST /api/admin/users/bulk-delete.
  bulkDeletes: Json[] = [];
  // Los que bulk-delete borró del todo: tampoco salen en GET /api/admin/students.
  removedUserIds: string[] = [];
  ragSources: Json[] = [
    { id: "RAG-FPOO-17", courseCode: "FPOO", scope: "default", title: "Conceptos basicos", fileName: "conceptos.html", sourceType: "web_page", textLength: 48000, createdAt: "2026-08-20T12:00:00.000Z" },
    { id: "RAG-T-01", courseCode: "FPOO", scope: "teacher", title: "Taller 2", fileName: "taller-2.pdf", sourceType: "document", textLength: 9800, createdAt: "2026-09-20T12:00:00.000Z" },
    { id: "RAG-FPI-01", courseCode: "FPI", scope: "default", title: "Estructuras de control", fileName: "control.html", sourceType: "web_page", textLength: 30000, createdAt: "2026-08-20T12:00:00.000Z" },
  ];
  ragDeletes: string[] = [];
  // POST /api/rag/sources (fuentes del docente, una por peticion) y los archivos que el backend rechaza.
  ragUploads: Json[] = [];
  ragUploadFailures: string[] = [];
  // Administrador (0.7.22): el docente de cada fuente cargada (teacherUserId del formulario). Las
  // fuentes del docente sin ownerId son de "u-docente".
  // Pestana Estudiantes (0.7.13): GET /api/admin/students y /api/admin/students/:id.
  students: Json[] = [
    studentProgressFixture("u-est-1", "Ana Prueba", "ana@correounivalle.edu.co", { score: 73, scale5: 3.7, level: "medio", label: "Medio" }),
    studentProgressFixture("u-est-2", "Bruno Prueba", "bruno@correounivalle.edu.co", { score: null, scale5: null, level: "sin_datos", label: "Sin quices" }),
  ];
  // Privacidad en el backend (contrato (a)): undefined = backend anterior, sin el campo
  // privacy en login ni en /api/auth/me y sin POST /api/auth/privacy-acceptance (404).
  privacy: Json | undefined = undefined;
  privacyAcceptances: Json[] = [];
  firstLogin = false;
  // Codigo de estudiante (0.7.22): respuestas del login antes de entrar (paso del codigo, espera
  // de aprobacion), en orden; y las solicitudes de acceso de «Usuarios».
  loginSteps: Array<{ status?: number; body: Json }> = [];
  accessRequests: Json[] = [];
  accessDecisions: Array<{ id: string; body: Json | null }> = [];
  // Sesion que devuelven login y /api/auth/me (por ejemplo, la de un docente).
  session: typeof SESSION = SESSION;
  // Politica que devuelven login y /api/auth/me.
  policy: Json = {};
  // Scope codespace de la cuenta de GitHub (Codespaces).
  githubCodespaceScope = false;
  // POST /api/github-app/link-installation-auto: sin una instalacion que vincular (404). Con
  // true, la App ya estaba instalada en la organizacion y queda vinculada con acceso al repo.
  appAutoLink = false;
  // Pestana activa que reporta GET /api/ui/active-tab (null: ninguna).
  activeTab: Json | null = null;
  // GET /api/documents/bitacora/status (Campus): estado HTTP y bitacora del curso.
  bitacoraStatus = 200;
  bitacoraLatest: Json | null = { id: "bitacora-1", title: "Bitacora FPOO 2026-2" };
  // Respuesta de POST /api/quiz/launches (contrato (c)). El piloto ya no se maneja desde el
  // overlay (0.7.15): va por npm run piloto:bloque.
  quizLaunchReply: Json | null = null;
  quizLaunches: Json[] = [];
  // Lotes de RAG (0.7.15): GET /api/rag/lots y sus cambios.
  ragLots: Json[] = [];
  ragActiveLots: Record<string, string> = {};
  ragDisabledSourceIds: string[] = [];
  ragStudentLots: Array<{ studentUserId: string; courseCode: string; lotId: string | null }> = [];
  // Banco de quices y quices hechos (0.7.15).
  customQuizzes: Json[] = [];
  quizAttempts: Json[] = [];
  customQuizLaunches: string[] = [];
  closedLaunches: string[] = [];
  // Bitacoras subidas con POST /api/documents/bitacora/import (0.7.16): nombre de cada archivo.
  bitacoraUploads: string[] = [];
  // Administrador (0.7.22): el docente dueño de cada bitácora subida (teacherUserId del formulario)
  // y de la última; el estado del administrador solo la da para ese docente.
  bitacoraUploadOwners: string[] = [];
  bitacoraLatestOwner = "u-docente";
  // Google Calendar simulado (0.7.17): la cuenta de Google de Chrome, los eventos del calendario
  // principal y los mensajes que el overlay le manda al background.
  googleAccount = "alumno@correounivalle.edu.co";
  // Entorno de los estudiantes (0.7.19): GET/PUT /api/admin/workspace-provider. null es un
  // backend anterior (404); workspaceSettingPuts guarda lo que manda «Guardar cambios».
  workspaceSetting: Json | null = null;
  workspaceSettingPuts: Json[] = [];
  // «Iniciar clase» (0.7.21): GET /api/admin/clase/estado y POST /api/admin/clase/iniciar. null es
  // un backend anterior (404); classStarts cuenta los «Iniciar clase» recibidos.
  classStatus: Json | null = null;
  classStarts = 0;
  calendarEvents: Json[] = [];
  calendarMessages: Json[] = [];
  // Tema del piloto (0.7.21): GET/PUT /api/pilot/topic. Con pilotTopicStatus 404 es un backend
  // anterior; pilotTopicWeeks son las semanas de la bitacora del docente.
  pilotTopic: Json | null = null;
  pilotTopicStatus = 200;
  pilotTopicWeeks: Json[] = [];
  pilotTopicPuts: Json[] = [];
  // «Importar lista» y docente de las cuentas nuevas (0.7.21). defaultTeacher null: GET
  // /api/admin/users no lo trae (un docente o un backend anterior).
  adminTeachers: Json[] = [{ id: "u-docente", email: "docente@correounivalle.edu.co", displayName: "Docente Prueba" }];
  importRequests: Json[] = [];
  importStatus = 200;
  defaultTeacher: Json | null = null;
  defaultTeacherPuts: Json[] = [];
  createdUsers: Json[] = [];

  // Lo que hace background.js con la API de Google Calendar.
  // 0.8.2: lo que pide el aviso de vscode.dev al background (borrar la sesion de vscode.dev).
  vscodeResetMessages: Json[] = [];
  vscodeResetReply: Json = { ok: true };

  backgroundMessage(message: Json): Json {
    if (message.type === "ADACEEN_RESET_VSCODE_SESSION") {
      this.vscodeResetMessages.push(structuredClone(message));
      return structuredClone(this.vscodeResetReply);
    }
    this.calendarMessages.push(structuredClone(message));
    const privateProps = (event: Json) => ((event.extendedProperties as Json)?.private || {}) as Record<string, string>;
    switch (message.type) {
      case "ADACEEN_GOOGLE_CALENDAR_AUTHORIZE":
        return { ok: true };
      case "ADACEEN_GOOGLE_CALENDAR_ACCOUNT":
        return { ok: true, email: this.googleAccount };
      case "ADACEEN_GOOGLE_CALENDAR_LIST": {
        const query = (message.query || {}) as Json;
        const filters = ([] as string[]).concat((query.privateExtendedProperty as string[]) || []);
        const timeMin = query.timeMin ? Date.parse(String(query.timeMin)) : -Infinity;
        const timeMax = query.timeMax ? Date.parse(String(query.timeMax)) : Infinity;
        const events = this.calendarEvents.filter((event) => {
          const props = privateProps(event);
          if (!filters.every((filter) => { const [key, value] = filter.split("="); return props[key] === value; })) return false;
          const start = Date.parse(String((event.start as Json)?.dateTime || ""));
          return start >= timeMin && start <= timeMax;
        });
        return { ok: true, events: structuredClone(events) };
      }
      case "ADACEEN_GOOGLE_CALENDAR_INSERT": {
        const event = { ...(structuredClone(message.event) as Json), id: `evt-${this.calendarEvents.length + 1}`, htmlLink: `https://calendar.google.com/event?eid=evt-${this.calendarEvents.length + 1}` };
        this.calendarEvents.push(event);
        return { ok: true, event: structuredClone(event) };
      }
      case "ADACEEN_GOOGLE_CALENDAR_PATCH": {
        const event = this.calendarEvents.find((item) => item.id === message.eventId);
        if (!event) return { ok: false, error: "Not Found" };
        Object.assign(event, structuredClone(message.patch));
        return { ok: true, event: structuredClone(event) };
      }
      default:
        return { ok: false, error: "sin background en la simulacion" };
    }
  }

  sessionRole() {
    return String(((this.session as Json).user as Json)?.role || "");
  }

  // Catalogo de lotes como lo arma GET /api/rag/lots (src/routes/rag/rag-routes.ts).
  ragLotCatalog() {
    const courses = ["FPI", "FPOO", "FPOE", "FPFC"].map((courseCode) => {
      const lots = this.ragLots.filter((lot) => lot.courseCode === courseCode).map((lot) => ({
        ...lot,
        sourceCount: this.ragSources.filter((source) => source.lotId === lot.id).length,
        activeSourceCount: this.ragSources.filter((source) => source.lotId === lot.id && !this.ragDisabledSourceIds.includes(String(source.id))).length,
        isCourseActive: this.ragActiveLots[courseCode] === lot.id,
      }));
      const active = lots.find((lot) => lot.isCourseActive) || null;
      const base = this.ragSources.filter((source) => source.courseCode === courseCode && !source.lotId);
      return {
        courseCode,
        courseName: courseCode,
        courseShortName: courseCode,
        activeLotId: active ? active.id : "",
        activeLotName: active ? active.name : "Base del curso",
        base: { sourceCount: base.length, activeSourceCount: base.filter((source) => !this.ragDisabledSourceIds.includes(String(source.id))).length, defaultCount: base.filter((source) => source.scope === "default").length, teacherCount: base.filter((source) => source.scope === "teacher").length },
        lots,
      };
    });
    return { baseLotName: "Base del curso", courses, disabledSourceIds: [...this.ragDisabledSourceIds] };
  }

  // «RAG aplicado» por estudiante y curso, como lo calcula GET /api/admin/users.
  appliedRagLots(user: Json) {
    const codes = Array.isArray(user.assignedCourseCodes) ? user.assignedCourseCodes as string[] : [];
    const out: Record<string, Json> = {};
    for (const code of codes) {
      const assigned = this.ragStudentLots.find((item) => item.studentUserId === user.id && item.courseCode === code);
      const assignedLot = assigned ? this.ragLots.find((lot) => lot.id === assigned.lotId) : null;
      const activeLot = this.ragLots.find((lot) => lot.id === this.ragActiveLots[code]) || null;
      out[code] = assignedLot
        ? { lotId: assignedLot.id, lotName: assignedLot.name, origin: "student" }
        : activeLot
          ? { lotId: activeLot.id, lotName: activeLot.name, origin: "teacher" }
          : { lotId: "", lotName: "Base del curso", origin: "base" };
    }
    return out;
  }

  chromeFor() {
    const browser = this;
    const clone = <T>(value: T): T => (value === undefined ? value : structuredClone(value));
    const pick = (keys: unknown) => {
      const list = keys == null ? Object.keys(browser.storage) : Array.isArray(keys) ? keys : typeof keys === "string" ? [keys] : Object.keys(keys as Json);
      const out: Json = {};
      for (const key of list as string[]) {
        if (Object.prototype.hasOwnProperty.call(browser.storage, key)) out[key] = clone(browser.storage[key]);
      }
      return out;
    };
    const notify = (changes: Json) => {
      if (!Object.keys(changes).length) return;
      for (const listener of [...browser.storageListeners]) {
        browser.clock.setTimeout(() => listener(clone(changes), "local"), 0);
      }
    };
    return {
      runtime: {
        id: "adaceen-test",
        lastError: undefined,
        getManifest: () => clone(MANIFEST),
        getURL: (rel: string) => `chrome-extension://adaceen-test/${rel}`,
        sendMessage: (message: unknown, callback?: (response: unknown) => void) => {
          const response = browser.backgroundMessage((message || {}) as Json);
          if (callback) callback(response);
        },
        onMessage: { addListener() {} },
      },
      storage: {
        local: {
          get: async (keys: unknown) => pick(keys),
          set: async (items: Json) => {
            const changes: Json = {};
            for (const [key, value] of Object.entries(items)) {
              changes[key] = { oldValue: clone(browser.storage[key]), newValue: clone(value) };
              browser.storage[key] = clone(value);
            }
            notify(changes);
          },
          remove: async (keys: unknown) => {
            const changes: Json = {};
            for (const key of (Array.isArray(keys) ? keys : [keys]) as string[]) {
              if (Object.prototype.hasOwnProperty.call(browser.storage, key)) {
                changes[key] = { oldValue: clone(browser.storage[key]) };
                delete browser.storage[key];
              }
            }
            notify(changes);
          },
        },
        onChanged: { addListener: (listener: (changes: Json, area: string) => void) => browser.storageListeners.push(listener) },
      },
    };
  }

  private workspace(status: string, extra: Json = {}) {
    return {
      ok: status !== "error",
      provider: "tunnel",
      status,
      workspace: { login: "alumno", tunnelName: "ws-alumno", webUrl: status === "ready" ? TUNNEL_URL : "", repoFullName: REPO },
      ...extra,
    };
  }

  ready() { return this.workspace("ready"); }
  vmOff() {
    return this.workspace("error", {
      code: "agent_unreachable",
      retryable: true,
      message: "El editor esta apagado. Avisa al docente; esta ventana seguira esperando.",
    });
  }
  vmStarting() {
    return this.workspace("pending", { ok: true, code: "vm_starting", retryable: true, message: "Encendiendo la VM de editores (1-2 min)..." });
  }
  deviceCode(userCode = "WDJB-MJHT") {
    return this.workspace("device_code", {
      ok: true,
      deviceCode: { userCode, verificationUrl: "https://github.com/login/device", expiresAt: new Date(this.clock.now + 14 * 60_000).toISOString() },
    });
  }
  notFound() {
    return this.workspace("error", { code: "not_found", message: "Todavia no hay un editor preparado para tu cuenta." });
  }
  agentError(message = "Tu editor ya tiene otro repositorio abierto.") {
    return this.workspace("error", { code: "repo_conflict", message });
  }

  // El default del switch de fetch (harness-backend.ts): rutas con parametros y las no simuladas.
  // El cuerpo conserva la sangria que tenia dentro del switch: es el mismo texto, y asi
  // scripts/sincronizar-modularizacion.mjs puede llevar aqui un cambio hecho en produccion.
  fetchByPattern(route: string, body: any, reply: FakeReply) {
        const activeLotMatch = route.match(/^PUT \/api\/rag\/courses\/([^/]+)\/active-lot$/);
        if (activeLotMatch) {
          const courseCode = decodeURIComponent(activeLotMatch[1]);
          const lotId = String(body?.lotId || "");
          if (lotId && !this.ragLots.some((lot) => lot.id === lotId && lot.courseCode === courseCode)) {
            return reply(400, { ok: false, error: "El lote no existe o no es de este curso." });
          }
          if (lotId) this.ragActiveLots[courseCode] = lotId; else delete this.ragActiveLots[courseCode];
          return reply(200, { ok: true, courseCode, activeLotId: lotId, catalog: this.ragLotCatalog() });
        }
        const lotDeleteMatch = route.match(/^DELETE \/api\/rag\/lots\/([^/]+)$/);
        if (lotDeleteMatch) {
          const id = decodeURIComponent(lotDeleteMatch[1]);
          if (!this.ragLots.some((lot) => lot.id === id)) return reply(404, { ok: false, error: "Lote no encontrado." });
          this.ragLots = this.ragLots.filter((lot) => lot.id !== id);
          for (const [courseCode, activeId] of Object.entries(this.ragActiveLots)) {
            if (activeId === id) delete this.ragActiveLots[courseCode];
          }
          this.ragStudentLots = this.ragStudentLots.filter((item) => item.lotId !== id);
          return reply(200, { ok: true, removed: true, id, catalog: this.ragLotCatalog() });
        }
        const sourceActiveMatch = route.match(/^PUT \/api\/rag\/sources\/([^/]+)\/active$/);
        if (sourceActiveMatch) {
          const id = decodeURIComponent(sourceActiveMatch[1]);
          this.ragDisabledSourceIds = this.ragDisabledSourceIds.filter((item) => item !== id);
          if (body?.isActive === false) this.ragDisabledSourceIds.push(id);
          return reply(200, { ok: true, id, isEnabled: body?.isActive !== false });
        }
        const studentLotMatch = route.match(/^PUT \/api\/rag\/students\/([^/]+)\/lot$/);
        if (studentLotMatch) {
          const studentUserId = decodeURIComponent(studentLotMatch[1]);
          const courseCode = String(body?.courseCode || "");
          const lotId = body?.lotId ? String(body.lotId) : null;
          this.ragStudentLots = this.ragStudentLots.filter((item) => !(item.studentUserId === studentUserId && item.courseCode === courseCode));
          if (lotId) this.ragStudentLots.push({ studentUserId, courseCode, lotId });
          return reply(200, { ok: true, studentUserId, courseCode, lotId });
        }
        const customLaunchMatch = route.match(/^POST \/api\/quiz\/custom\/([^/]+)\/launch$/);
        if (customLaunchMatch) {
          const id = decodeURIComponent(customLaunchMatch[1]);
          const quiz = this.customQuizzes.find((item) => item.id === id);
          if (!quiz) return reply(404, { ok: false, error: "Quiz no encontrado." });
          this.customQuizLaunches.push(id);
          const launch = { id: `launch-${id}`, topic: String(quiz.topic), active: true, customQuizId: id, results: { answered: 0, correct: 0 } };
          this.quizLaunches.unshift(launch);
          return reply(200, { ok: true, launch, ...(this.quizLaunchReply || {}) });
        }
        const customDeleteMatch = route.match(/^DELETE \/api\/quiz\/custom\/([^/]+)$/);
        if (customDeleteMatch) {
          const id = decodeURIComponent(customDeleteMatch[1]);
          if (!this.customQuizzes.some((item) => item.id === id)) return reply(404, { ok: false, error: "Quiz no encontrado." });
          this.customQuizzes = this.customQuizzes.filter((item) => item.id !== id);
          return reply(200, { ok: true, removed: true });
        }
        const closeLaunchMatch = route.match(/^POST \/api\/quiz\/launches\/([^/]+)\/close$/);
        if (closeLaunchMatch) {
          const id = decodeURIComponent(closeLaunchMatch[1]);
          this.closedLaunches.push(id);
          this.quizLaunches = this.quizLaunches.map((launch) => (launch.id === id ? { ...launch, active: false } : launch));
          return reply(200, { ok: true });
        }
        const accessMatch = route.match(/^POST \/api\/admin\/access-requests\/([^/]+)$/);
        if (accessMatch) {
          const id = decodeURIComponent(accessMatch[1]);
          this.accessDecisions.push({ id, body });
          const request = this.accessRequests.find((item) => item.id === id);
          this.accessRequests = this.accessRequests.filter((item) => item.id !== id);
          if (request && body?.decision === "approve") {
            this.adminUsers = this.adminUsers.map((user) => (user.id === (request.target as Json).id
              ? { ...user, loginEmails: [...((user.loginEmails as string[]) || []), String(request.email)] }
              : user));
          }
          return reply(200, { ok: true, request: { id, status: body?.decision === "approve" ? "approved" : "rejected" }, accessRequests: this.accessRequests });
        }
        const updateMatch = route.match(/^PUT \/api\/admin\/users\/([^/]+)$/);
        if (updateMatch) {
          const id = decodeURIComponent(updateMatch[1]);
          this.adminUserUpdates.push({ id, body });
          this.adminUsers = this.adminUsers.map((user) => (user.id === id ? { ...user, ...(body || {}) } : user));
          return reply(200, { ok: true, user: this.adminUsers.find((user) => user.id === id) });
        }
        const ragDeleteMatch = route.match(/^DELETE \/api\/rag\/sources\/([^/]+)$/);
        if (ragDeleteMatch) {
          const id = decodeURIComponent(ragDeleteMatch[1]);
          this.ragDeletes.push(id);
          this.ragSources = this.ragSources.filter((source) => source.id !== id);
          return reply(200, { ok: true });
        }
        const detailMatch = route.match(/^GET \/api\/admin\/students\/([^/]+)$/);
        if (detailMatch) {
          const student = this.students.find((item) => item.id === decodeURIComponent(detailMatch[1]));
          if (!student) return reply(404, { ok: false, error: "Estudiante no encontrado." });
          return reply(200, {
            ok: true,
            generatedAt: new Date(this.clock.now).toISOString(),
            student,
            sessions: [
              { kind: "browser", label: null, createdAt: "2026-09-25T12:00:00.000Z", lastSeenAt: "2026-09-25T12:50:00.000Z", expiresAt: null, isActive: true, durationMinutes: 50 },
              { kind: "editor", label: "tunnel", createdAt: "2026-09-24T12:00:00.000Z", lastSeenAt: "2026-09-24T13:00:00.000Z", expiresAt: "2026-10-24T12:00:00.000Z", isActive: false, durationMinutes: 60 },
            ],
            interventions: [
              { id: "i-1", eventType: "compile_error", interventionType: "hint", detailLevel: "guided", policyName: "RF-05", exerciseKey: "taller-1", blocked: false, reason: "", contextSummary: "Error en Main.java", createdAt: "2026-09-25T12:10:00.000Z" },
            ],
            quizzes: [
              { id: "q-1", trigger: "after_accept", status: "done", topic: "arreglos", question: "Que hace la linea?", language: "java", filePath: "src/Main.java", answered: true, correct: true, chosenOption: "Inicializa", correctOption: "Inicializa", followupAnswered: true, followupScore: 80, followupFeedback: "Bien explicado.", createdAt: "2026-09-25T12:20:00.000Z", answeredAt: "2026-09-25T12:21:00.000Z", completedAt: "2026-09-25T12:22:00.000Z" },
              { id: "q-2", trigger: "teacher_launch", status: "done", topic: "herencia", question: "Cual es la superclase?", language: "java", filePath: "", answered: true, correct: false, chosenOption: "Object", correctOption: "Animal", followupAnswered: false, followupScore: null, followupFeedback: "", createdAt: "2026-09-24T12:20:00.000Z", answeredAt: "2026-09-24T12:21:00.000Z", completedAt: "2026-09-24T12:21:00.000Z" },
            ],
            activity: [
              { category: "tutor", eventType: "tutor_request_submitted", source: "browser_extension", totalEvents: 4, totalCount: 4, totalDurationMs: 0, lastOccurredAt: "2026-09-25T12:30:00.000Z" },
            ],
            exercises: [{ exerciseKey: "taller-1", hintCount: 2, lastInterventionAt: "2026-09-25T12:10:00.000Z" }],
            timeline: Array.from({ length: 14 }, (_, index) => ({ day: `2026-09-${String(12 + index).padStart(2, "0")}`, sessions: index === 13 ? 1 : 0, interventions: index === 13 ? 1 : 0, quizzes: index >= 12 ? 1 : 0 })),
          });
        }
        this.unknownRoutes.push(route);
        return reply(404, { ok: false, error: `ruta no simulada: ${route}` });
  }
}

// ADACEEN | Capa 3 - Servicios: base de las llamadas HTTP al backend ADACEEN (registro de peticiones,
// fetchJsonWithTimeout, cabeceras) y pregunta al mentor. El resto, por dominio, en services/backend-*.service.js.
// Orden de carga: manifest.json (content_scripts) y background.js (CONTENT_SCRIPT_FILES) deben coincidir.
const ADACEEN_BACKEND_REQUEST_LOG_KEY = "adaceenBackendRequestLog";
const ADACEEN_BACKEND_REQUEST_LOG_LIMIT = 80;

function getRequestLogChromeStorage() {
  try {
    return typeof chrome !== "undefined" && chrome.storage?.local ? chrome.storage.local : null;
  } catch {
    return null;
  }
}

function summarizeRequestUrl(url) {
  try {
    const parsed = new URL(String(url));
    return {
      origin: parsed.origin,
      path: `${parsed.pathname}${parsed.search ? "?..." : ""}`,
    };
  } catch {
    return {
      origin: "",
      path: String(url || "").slice(0, 240),
    };
  }
}

function summarizeRequestBody(body) {
  if (typeof body === "string") {
    let jsonValid = false;
    try {
      JSON.parse(body);
      jsonValid = true;
    } catch {}
    return {
      bodyType: "string",
      bodyChars: body.length,
      jsonValid,
    };
  }
  if (body == null) {
    return {
      bodyType: "empty",
      bodyChars: 0,
      jsonValid: false,
    };
  }
  return {
    bodyType: Object.prototype.toString.call(body).slice(8, -1).toLowerCase() || typeof body,
    bodyChars: 0,
    jsonValid: false,
  };
}

async function appendBackendRequestLog(entry) {
  const storage = getRequestLogChromeStorage();
  const safeEntry = {
    id: entry.id,
    at: entry.at || new Date().toISOString(),
    method: entry.method || "GET",
    origin: entry.origin || "",
    path: entry.path || "",
    contentType: entry.contentType || "",
    bodyType: entry.bodyType || "empty",
    bodyChars: Number(entry.bodyChars) || 0,
    jsonValid: entry.jsonValid === true,
    status: Number(entry.status) || 0,
    ok: entry.ok === true,
    durationMs: Number(entry.durationMs) || 0,
    error: entry.error ? String(entry.error).slice(0, 240) : "",
  };
  console.debug?.("[ADACEEN] backend request", safeEntry);
  if (!storage) return;

  try {
    const current = await storage.get([ADACEEN_BACKEND_REQUEST_LOG_KEY]);
    const previous = Array.isArray(current?.[ADACEEN_BACKEND_REQUEST_LOG_KEY])
      ? current[ADACEEN_BACKEND_REQUEST_LOG_KEY]
      : [];
    await storage.set({
      [ADACEEN_BACKEND_REQUEST_LOG_KEY]: [safeEntry, ...previous].slice(0, ADACEEN_BACKEND_REQUEST_LOG_LIMIT),
    });
  } catch (error) {
    console.debug?.("[ADACEEN] no se pudo guardar request log", error);
  }
}

async function fetchJsonWithTimeout(url, options = {}, timeoutMs = BACKEND_TIMEOUT_MS) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  const startedAt = Date.now();
  const requestId = `${startedAt.toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
  const urlSummary = summarizeRequestUrl(url);
  const bodySummary = summarizeRequestBody(options.body);
  const requestMethod = String(options.method || "GET").toUpperCase();
  const contentType = typeof options.headers?.get === "function"
    ? options.headers.get("content-type")
    : (options.headers?.["Content-Type"] || options.headers?.["content-type"] || "");
  const requestOptions = {
    ...options,
    credentials: options.credentials || "omit",
    signal: controller.signal,
  };
  let responseLogged = false;

  try {
    const response = await fetch(url, requestOptions);
    const json = await response.json().catch(() => ({}));
    await appendBackendRequestLog({
      id: requestId,
      method: requestMethod,
      ...urlSummary,
      contentType,
      ...bodySummary,
      status: response.status,
      ok: response.ok,
      durationMs: Date.now() - startedAt,
    });
    responseLogged = true;
    if (!response.ok) {
      const httpError = new Error(String(json.error || `HTTP ${response.status}`));
      // Estado HTTP: distingue una ruta que el backend no conoce (404) de un fallo pasajero.
      httpError.status = response.status;
      throw httpError;
    }
    return json;
  } catch (error) {
    if (!responseLogged) {
      await appendBackendRequestLog({
        id: requestId,
        method: requestMethod,
        ...urlSummary,
        contentType,
        ...bodySummary,
        ok: false,
        durationMs: Date.now() - startedAt,
        error: error?.message || String(error),
      });
    }
    if (error && typeof error === "object" && error.name === "AbortError") {
      const seconds = Math.max(1, Math.round((Number(timeoutMs) || BACKEND_TIMEOUT_MS) / 1000));
      throw new Error(`Tiempo de espera agotado (${seconds}s).`);
    }
    if (error && typeof error === "object" && error.name === "TypeError") {
      throw new Error("No se pudo conectar con el backend. Verifica la URL del backend o recarga la extension.");
    }
    throw error;
  } finally {
    clearTimeout(timeout);
  }
}

// Backend local de desarrollo (npm run dev): solo ahi se muestran las cuentas demo del login.
function isLocalBackendUrl(value = overlayState.backendUrl) {
  try {
    const host = new URL(normalizeBaseUrl(value)).hostname.toLowerCase();
    return host === "localhost" || host === "127.0.0.1";
  } catch {
    return false;
  }
}

function buildApiHeaders() {
  // Contrato de identidad: x-session-id si hay sesion y, cuando ya se conoce,
  // x-adaceen-client-id (anonimo y persistente; gana la sesion en el servidor).
  return {
    "Content-Type": "application/json; charset=utf-8",
    ...(overlayState.sessionId ? { "x-session-id": overlayState.sessionId } : {}),
    ...(overlayState.clientId ? { "x-adaceen-client-id": overlayState.clientId } : {}),
  };
}

function normalizeBackendResult(raw, fallbackGuide) {
  const result = raw?.result || {};
  const ideas = unique(Array.isArray(result.ideas) ? result.ideas : []).slice(0, MAX_LIST_ITEMS);
  const guide = unique(Array.isArray(result.guide) ? result.guide : []).slice(0, MAX_LIST_ITEMS);
  const ragSources = normalizeRagSourcesForUi(raw?.rag_sources || raw?.ragSources || []);
  const rawRagCourseCode = toText(raw?.rag_course_code || raw?.ragCourseCode);

  return {
    ideas,
    guide: guide.length > 0 ? guide : fallbackGuide,
    welcome: toText(result.welcome_message),
    summary: toText(result.analysis_summary),
    ragCourseCode: rawRagCourseCode ? normalizeRagCourseCodeUi(rawRagCourseCode) : "",
    ragSources,
    // Telemetria v1.1 (A11.2): id de la decision del tutor y origen de la respuesta.
    decisionId: toText(raw?.decision_id || raw?.decisionId || raw?.telemetry_id || raw?.telemetryId).slice(0, 80),
    source: toText(raw?.source).toLowerCase(),
    blocked: raw?.blocked === true || raw?.policy_applied?.blocked === true,
  };
}

function buildBackendQuestion(context, language, goal) {
  const settings = overlayState.policy || DEFAULT_POLICY;
  const rule = settings.strictNoSolution
    ? "No entregues la solucion completa."
    : "Prioriza pistas y pasos sobre respuestas completas.";
  const tone = `Tono docente: ${settings.tone}.`;
  const help = `Nivel de ayuda: ${settings.helpLevel}.`;
  const outcome = `Resultado esperado: ${settings.outcome}.`;

  if (context.pageContext === "campus") {
    return `Estoy en Campus Virtual. Quiero reforzar ${goal.label.toLowerCase()}. ${rule} ${tone} ${help} ${outcome} Enfocate en el enunciado, la actividad visible y el error en pantalla.`;
  }
  if (context.pageType === "codespace") {
    return `Estoy programando en Codespaces en ${language}. Quiero reforzar ${goal.label.toLowerCase()}. ${rule} ${tone} ${help} ${outcome} Enfocate en el archivo abierto y el siguiente paso.`;
  }
  if (context.pageType === "github_code") {
    return `Estoy en GitHub con el archivo ${context.filePath || "actual"} en ${language}. Quiero reforzar ${goal.label.toLowerCase()}. ${rule} ${tone} ${help} ${outcome} Enfocate en el codigo abierto.`;
  }
  return `Quiero reforzar ${goal.label.toLowerCase()}. ${rule} ${tone} ${help} ${outcome} Da una orientacion breve y accionable.`;
}

async function requestBackendMentor(context, language) {
  const baseUrl = normalizeBaseUrl(overlayState.backendUrl);
  if (!baseUrl) {
    throw new Error("Base URL vacia.");
  }

  const goal = getLearningGoal(overlayState.selectedLearningGoal);
  const useStudentSelectedCourse = overlayState.session?.user?.role === "student";
  const selectedCourseCode = useStudentSelectedCourse ? getSelectedStudentCourseCode() : "";
  const selectedCourse = useStudentSelectedCourse ? getSelectedStudentCourse() : null;
  const courseQuestionSuffix = selectedCourseCode
    ? ` Curso RAG activo: ${selectedCourseCode} ${toText(selectedCourse?.name)}.`
    : "";
  // Semana del curso segun la bitacora (0.7.17): el tutor relaciona las pistas con ese tema.
  const courseWeek = typeof buildCourseWeekForTutor === "function" ? buildCourseWeekForTutor() : null;
  const payload = {
    question: `${buildBackendQuestion(context, language, goal)}${courseQuestionSuffix}`,
    max_items: MAX_LIST_ITEMS,
    context: {
      url: toText(context.url),
      title: toText(context.title),
      pageContext: toText(context.pageContext),
      pageType: toText(context.pageType),
      repoOwner: toText(context.repoOwner),
      repoName: toText(context.repoName),
      repoFullName: toText(context.repoFullName),
      branch: toText(context.branch),
      filePath: toText(context.filePath),
      languageHint: toText(context.languageHint),
      activityTitle: toText(context.activityTitle),
      activityDeadline: toText(context.activityDeadline),
      learningGoal: goal.id,
      courseCode: selectedCourseCode,
      ragCourseCode: selectedCourseCode,
      selection: toText(context.selection),
      visibleError: toText(context.visibleError),
      codeSnippet: toText(context.codeSnippet),
      codeLineCount: Number(context.codeLineCount) || 0,
      ...(courseWeek ? { courseWeek } : {}),
    },
  };

  const endpoints = ["/intervene", "/github-mentor"];
  let lastError = null;

  for (const endpoint of endpoints) {
    try {
      const raw = await fetchJsonWithTimeout(`${baseUrl}${endpoint}`, {
        method: "POST",
        headers: buildApiHeaders(),
        body: JSON.stringify(payload),
      });

      if (!raw?.ok) {
        throw new Error(String(raw?.error || "Respuesta invalida."));
      }

      return normalizeBackendResult(raw, buildGuide(goal.id, context));
    } catch (error) {
      lastError = error;
    }
  }

  throw lastError || new Error("Backend no disponible.");
}

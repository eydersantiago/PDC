// ADACEEN | Capa 5 - Ciclo de vida: instantanea del overlay por pestana guardada en chrome.storage.
// Orden de carga: manifest.json (content_scripts) y background.js (CONTENT_SCRIPT_FILES) deben coincidir.
"use strict";

const STORAGE_KEY_TAB_SESSION_MAP = "adaceenOverlayTabSessionMap";
const TAB_SESSION_TTL_MS = 12 * 60 * 60 * 1000;
const TAB_SESSION_MAX_ENTRIES = 24;
const TAB_SESSION_PREVIEW_CHARS = 1400;
let tabSessionSaveTimer = 0;

function buildTabSessionKey(context) {
  const raw = toText(context?.url || overlayState?.context?.url || location.href || "");
  if (!raw) {
    return "";
  }

  try {
    const parsed = new URL(raw);
    parsed.hash = "";
    const normalized = `${parsed.origin}${parsed.pathname}`.toLowerCase();
    return `${toText(overlayState?.session?.id || overlayState.sessionId || overlayState?.session?.user?.id || "anonymous")}:${normalized}`;
  } catch {
    return `${toText(overlayState?.session?.id || overlayState.sessionId || overlayState?.session?.user?.id || "anonymous")}:${raw
      .split("#")[0]
      .toLowerCase()}`;
  }
}

function compactTabSessionText(value, max = TAB_SESSION_PREVIEW_CHARS) {
  const text = toText(value);
  if (!text) return "";
  if (!Number.isFinite(max) || max <= 0) return "";
  return text.length <= max ? text : `${text.slice(0, max)}...`;
}

function normalizeSessionList(values, limit) {
  if (!Array.isArray(values)) return [];
  return values
    .filter((item) => typeof item === "string" && item.trim())
    .slice(0, Math.max(1, Number(limit) || 1));
}

function buildTabSessionSnapshot(context) {
  const payload = context || getPageContext();
  return {
    ts: Date.now(),
    started: !!overlayState.started,
    settingsOpen: !!overlayState.settingsOpen,
    minimized: !!overlayState.minimized,
    analysisWindowOpen: !!overlayState.analysisWindowOpen,
    analysisUnlocked: !!overlayState.analysisUnlocked,
    setupRepoFullName: toText(overlayState.setupRepoFullName),
    setupWizardStep: Math.max(1, Math.min(3, Number(overlayState.setupWizardStep) || 1)),
    setupPrResultByUser: overlayState.setupPrResultByUser && typeof overlayState.setupPrResultByUser === "object"
      ? overlayState.setupPrResultByUser
      : {},
    ideas: normalizeSessionList(overlayState.ideas, MAX_LIST_ITEMS),
    guide: normalizeSessionList(overlayState.guide, MAX_LIST_ITEMS),
    welcome: toText(overlayState.welcome),
    mentorSummary: toText(overlayState.mentorSummary),
    activeRagCourseCode: toText(overlayState.activeRagCourseCode),
    statusMessage: toText(overlayState.statusMessage),
    operationTitle: toText(overlayState.operationTitle),
    operationDetail: toText(overlayState.operationDetail),
    operationKind: toText(overlayState.operationKind),
    processNoticeOpen: !!overlayState.processNoticeOpen,
    projectContextMessage: toText(overlayState.projectContextMessage),
    projectContextError: toText(overlayState.projectContextError),
    projectContextStatus: normalizeProjectContextStatusPayload(overlayState.projectContextStatus),
    projectContextHistory: normalizeProjectContextHistoryPayload(overlayState.projectContextHistory).slice(0, 12),
    projectContextInsight: normalizeProjectContextInsightPayload(overlayState.projectContextInsight),
    documentClassifications: normalizeDocumentClassificationState(overlayState.documentClassifications),
    campusAnalysis: overlayState.campusAnalysis || null,
    campusCourseAccess: normalizeCampusCourseAccessState(overlayState.campusCourseAccess),
    context: {
      url: compactTabSessionText(toText(payload.url).split("#")[0], 600),
      title: compactTabSessionText(payload.title, 280),
      pageContext: toText(payload.pageContext),
      pageType: toText(payload.pageType),
      repoOwner: toText(payload.repoOwner),
      repoName: toText(payload.repoName),
      repoFullName: toText(payload.repoFullName),
      branch: toText(payload.branch),
      filePath: toText(payload.filePath),
      languageHint: toText(payload.languageHint),
      activityTitle: compactTabSessionText(payload.activityTitle, 260),
      activityDeadline: compactTabSessionText(payload.activityDeadline, 260),
      visibleError: compactTabSessionText(payload.visibleError, 420),
      codeSnippet: compactTabSessionText(payload.codeSnippet, 900),
      codeLineCount: Number(payload.codeLineCount) || 0,
    },
  };
}

function pruneTabSessionStore(store, now = Date.now()) {
  const entries = Object.entries(store || {})
    .filter((entry) => {
      const payload = entry[1];
      return payload && typeof payload === "object" && Number.isFinite(Number(payload.ts));
    })
    .filter((entry) => {
      const payload = entry[1];
      return now - Number(payload.ts) <= TAB_SESSION_TTL_MS;
    })
    .sort((a, b) => Number(b[1].ts) - Number(a[1].ts));

  const pruned = {};
  for (let i = 0; i < entries.length && i < TAB_SESSION_MAX_ENTRIES; i++) {
    const [key, payload] = entries[i];
    pruned[key] = payload;
  }
  return pruned;
}

async function loadTabSessionSnapshot(context) {
  const key = buildTabSessionKey(context);
  if (!key) return null;

  try {
    const raw = await chrome.storage.local.get([STORAGE_KEY_TAB_SESSION_MAP]);
    const storageMap = raw?.[STORAGE_KEY_TAB_SESSION_MAP];
    const data = (storageMap && typeof storageMap === "object" && !Array.isArray(storageMap))
      ? storageMap
      : {};
    const payload = data[key];

    if (!payload || !payload.state || !Number.isFinite(Number(payload.ts))) {
      return null;
    }

    const now = Date.now();
    if (now - Number(payload.ts) > TAB_SESSION_TTL_MS) {
      const pruned = pruneTabSessionStore(data, now);
      delete pruned[key];
      await chrome.storage.local.set({ [STORAGE_KEY_TAB_SESSION_MAP]: pruned });
      return null;
    }

    return payload.state;
  } catch {
    return null;
  }
}

function applyTabSessionSnapshot(snapshot) {
  if (!snapshot || typeof snapshot !== "object") return;

  overlayState.started = !!snapshot.started;
  overlayState.settingsOpen = !!snapshot.settingsOpen;
  overlayState.minimized = !!snapshot.minimized;
  overlayState.analysisWindowOpen = !!snapshot.analysisWindowOpen;
  overlayState.analysisUnlocked = !!snapshot.analysisUnlocked;
  overlayState.setupRepoFullName = toText(snapshot.setupRepoFullName);
  overlayState.setupWizardStep = Math.max(1, Math.min(3, Number(snapshot.setupWizardStep) || 1));
  overlayState.setupPrResultByUser = snapshot.setupPrResultByUser && typeof snapshot.setupPrResultByUser === "object"
    ? snapshot.setupPrResultByUser
    : overlayState.setupPrResultByUser;
  overlayState.ideas = normalizeSessionList(snapshot.ideas, MAX_LIST_ITEMS);
  overlayState.guide = normalizeSessionList(snapshot.guide, MAX_LIST_ITEMS);
  overlayState.welcome = toText(snapshot.welcome);
  overlayState.mentorSummary = toText(snapshot.mentorSummary);
  overlayState.activeRagCourseCode = toText(snapshot.activeRagCourseCode);
  overlayState.statusMessage = toText(snapshot.statusMessage);
  overlayState.operationTitle = toText(snapshot.operationTitle);
  overlayState.operationDetail = toText(snapshot.operationDetail);
  overlayState.operationKind = toText(snapshot.operationKind) || "busy";
  overlayState.processNoticeOpen = !!snapshot.processNoticeOpen;
  overlayState.projectContextMessage = toText(snapshot.projectContextMessage);
  overlayState.projectContextError = toText(snapshot.projectContextError);
  overlayState.projectContextStatus = normalizeProjectContextStatusPayload(snapshot.projectContextStatus || overlayState.projectContextStatus);
  overlayState.projectContextHistory = normalizeProjectContextHistoryPayload(snapshot.projectContextHistory).slice(0, 12);
  overlayState.projectContextInsight = normalizeProjectContextInsightPayload(snapshot.projectContextInsight || overlayState.projectContextInsight);
  overlayState.documentClassifications = normalizeDocumentClassificationState(snapshot.documentClassifications || overlayState.documentClassifications);
  overlayState.campusAnalysis = snapshot.campusAnalysis && typeof snapshot.campusAnalysis === "object"
    ? snapshot.campusAnalysis
    : overlayState.campusAnalysis;
  overlayState.campusCourseAccess = normalizeCampusCourseAccessState(
    snapshot.campusCourseAccess || overlayState.campusCourseAccess,
  );
}

async function persistTabSessionSnapshot() {
  const key = buildTabSessionKey(getPageContext());
  if (!key) return;

  try {
    const raw = await chrome.storage.local.get([STORAGE_KEY_TAB_SESSION_MAP]);
    const storageMap = raw?.[STORAGE_KEY_TAB_SESSION_MAP];
    const existing = (storageMap && typeof storageMap === "object" && !Array.isArray(storageMap))
      ? storageMap
      : {};

    const pruned = pruneTabSessionStore({
      ...existing,
      [key]: {
        ts: Date.now(),
        state: buildTabSessionSnapshot(getPageContext()),
      },
    }, Date.now());

    await chrome.storage.local.set({ [STORAGE_KEY_TAB_SESSION_MAP]: pruned });
  } catch {}
}

function queueTabSessionSave() {
  if (tabSessionSaveTimer) {
    return;
  }

  tabSessionSaveTimer = window.setTimeout(async () => {
    tabSessionSaveTimer = 0;
    await persistTabSessionSnapshot();
  }, 500);
}

async function flushTabSessionSave() {
  if (!tabSessionSaveTimer) {
    await persistTabSessionSnapshot();
    return;
  }

  window.clearTimeout(tabSessionSaveTimer);
  tabSessionSaveTimer = 0;
  await persistTabSessionSnapshot();
}

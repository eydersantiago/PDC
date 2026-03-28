"use strict";

const STORAGE_KEY_ENABLED = "assistantEnabled";
const STORAGE_KEY_BACKEND_URL = "mentorBackendUrl";
const STORAGE_KEY_LEARNING_GOAL = "studentLearningGoal";
const DEFAULT_BACKEND_URL = "http://127.0.0.1:3000";
const DEFAULT_LEARNING_GOAL = "oop_basics";
const BACKEND_TIMEOUT_MS = 12000;
const MAX_CODE_PREVIEW_CHARS = 3200;
const MAX_LIST_ITEMS = 6;

const LEARNING_GOALS = [
  {
    id: "oop_basics",
    label: "Clases y objetos",
    description: "Entender como modelar entidades, atributos y metodos.",
    prompt: "Quiero entender clases, objetos y responsabilidades basicas.",
  },
  {
    id: "encapsulation",
    label: "Encapsulamiento",
    description: "Decidir que datos deben protegerse y como acceder a ellos.",
    prompt: "Quiero practicar encapsulamiento y diseno de interfaces simples.",
  },
  {
    id: "inheritance",
    label: "Herencia y polimorfismo",
    description: "Relacionar clases y sobrescribir comportamiento sin duplicar codigo.",
    prompt: "Quiero reforzar herencia, abstraccion y polimorfismo.",
  },
  {
    id: "debugging",
    label: "Resolver errores",
    description: "Interpretar mensajes y corregir paso a paso sin recibir la solucion.",
    prompt: "Quiero entender el error y depurarlo de forma guiada.",
  },
  {
    id: "github_flow",
    label: "GitHub y Codespaces",
    description: "Trabajar con ramas, commits y entorno de entrega.",
    prompt: "Quiero aprender a trabajar mejor en GitHub y Codespaces.",
  },
];

const LANGUAGE_BY_EXTENSION = {
  ".js": "JavaScript",
  ".jsx": "JavaScript",
  ".ts": "TypeScript",
  ".tsx": "TypeScript",
  ".py": "Python",
  ".java": "Java",
  ".cpp": "C++",
  ".cc": "C++",
  ".cxx": "C++",
  ".c": "C",
  ".cs": "C#",
  ".go": "Go",
  ".rs": "Rust",
  ".php": "PHP",
  ".rb": "Ruby",
  ".kt": "Kotlin",
  ".swift": "Swift",
  ".sql": "SQL",
  ".html": "HTML",
  ".css": "CSS",
  ".scss": "SCSS",
  ".md": "Markdown",
};

const IDEAS_BY_LANGUAGE = {
  JavaScript: [
    "Ubica si el comportamiento principal esta disperso en varias funciones y requiere ordenarse.",
    "Comprueba que los nombres de funciones expliquen la intencion antes de agregar mas logica.",
  ],
  TypeScript: [
    "Revisa si los tipos actuales ayudan a prevenir errores antes de ejecutar.",
    "Define estructuras claras para que cada objeto tenga una forma facil de entender.",
  ],
  Python: [
    "Confirma que cada clase o funcion tenga una responsabilidad concreta y facil de probar.",
    "Si usas colecciones, revisa si estas recorriendo y transformando datos en el lugar correcto.",
  ],
  "C++": [
    "Verifica que cada clase tenga atributos, constructor y metodos coherentes con el problema.",
    "Revisa separacion entre cabeceras y archivos fuente antes de seguir creciendo el proyecto.",
  ],
  Java: [
    "Confirma que las clases del modelo representen realmente conceptos del problema.",
    "Revisa si el metodo principal esta haciendo demasiado y necesita delegar comportamiento.",
  ],
  General: [
    "Busca el cambio mas pequeno que te acerque al objetivo de aprendizaje de hoy.",
    "Antes de tocar todo el archivo, ubica una sola parte del flujo para trabajar.",
  ],
};

const els = {
  welcomeLead: document.getElementById("welcomeLead"),
  enabledToggle: document.getElementById("enabledToggle"),
  enabledLabel: document.getElementById("enabledLabel"),
  statusText: document.getElementById("statusText"),
  refreshBtn: document.getElementById("refreshBtn"),
  contextBadge: document.getElementById("contextBadge"),
  mentorWelcome: document.getElementById("mentorWelcome"),
  pageContextLabel: document.getElementById("pageContextLabel"),
  focusLabel: document.getElementById("focusLabel"),
  signalLabel: document.getElementById("signalLabel"),
  goalChip: document.getElementById("goalChip"),
  goalGrid: document.getElementById("goalGrid"),
  goalFeedback: document.getElementById("goalFeedback"),
  backendUrlInput: document.getElementById("backendUrlInput"),
  checkBackendBtn: document.getElementById("checkBackendBtn"),
  backendActiveUrl: document.getElementById("backendActiveUrl"),
  suggestionSource: document.getElementById("suggestionSource"),
  pageTitle: document.getElementById("pageTitle"),
  pageUrl: document.getElementById("pageUrl"),
  pageType: document.getElementById("pageType"),
  pageLanguage: document.getElementById("pageLanguage"),
  pagePath: document.getElementById("pagePath"),
  pageRepo: document.getElementById("pageRepo"),
  pageBranch: document.getElementById("pageBranch"),
  pageLines: document.getElementById("pageLines"),
  ideaList: document.getElementById("ideaList"),
  searchList: document.getElementById("searchList"),
  guideList: document.getElementById("guideList"),
  codePreview: document.getElementById("codePreview"),
};

let assistantEnabled = true;
let backendUrl = DEFAULT_BACKEND_URL;
let selectedLearningGoal = DEFAULT_LEARNING_GOAL;

function toText(value) {
  return String(value || "").trim();
}

function normalizeBaseUrl(value) {
  return toText(value).replace(/\/+$/, "");
}

function unique(items) {
  return [...new Set(items.filter(Boolean).map((item) => toText(item)))];
}

function clearList(listEl) {
  listEl.textContent = "";
}

function fillList(listEl, items) {
  clearList(listEl);
  const fragment = document.createDocumentFragment();
  for (const text of items) {
    const li = document.createElement("li");
    li.textContent = text;
    fragment.appendChild(li);
  }
  listEl.appendChild(fragment);
}

function setStatus(message, kind = "") {
  els.statusText.textContent = message;
  els.statusText.className = "status";
  if (kind) els.statusText.classList.add(kind);
}

function setSuggestionSource(source) {
  els.suggestionSource.textContent = source || "local";
}

function renderBackendState() {
  const clean = normalizeBaseUrl(backendUrl);
  els.backendUrlInput.value = clean;
  els.backendActiveUrl.textContent = clean || "-";
}

function basename(path) {
  const clean = toText(path);
  if (!clean) return "";
  const parts = clean.split("/").filter(Boolean);
  return parts[parts.length - 1] || "";
}

function getExtension(path) {
  const file = basename(path);
  const dot = file.lastIndexOf(".");
  if (dot < 0) return "";
  return file.slice(dot).toLowerCase();
}

function inferLanguage(filePath, hint) {
  const cleanHint = toText(hint);
  if (cleanHint) return cleanHint;

  const ext = getExtension(filePath);
  if (ext && LANGUAGE_BY_EXTENSION[ext]) {
    return LANGUAGE_BY_EXTENSION[ext];
  }
  return "General";
}

function friendlyPageType(pageType) {
  if (pageType === "github_code") return "GitHub Codigo";
  if (pageType === "codespace") return "Codespace";
  if (pageType === "github_general") return "GitHub";
  if (pageType === "campus") return "Campus Virtual";
  return "Otro sitio";
}

function detectPageContextFromUrl(urlText) {
  const url = toText(urlText).toLowerCase();
  if (url.includes("campusvirtual.univalle.edu.co")) return "campus";
  if (url.includes("github.com") || url.includes("github.dev")) return "github";
  return "unknown";
}

function parseGithubFromUrl(urlText) {
  try {
    const url = new URL(urlText);
    const host = url.hostname.toLowerCase();
    const parts = url.pathname.split("/").filter(Boolean);
    const isGitHub = host === "github.com";

    let repoOwner = "";
    let repoName = "";
    let repoFullName = "";
    let filePath = "";
    let pageType = "other";

    if (isGitHub && parts.length >= 2) {
      repoOwner = parts[0];
      repoName = parts[1].replace(/\.git$/i, "");
      repoFullName = `${repoOwner}/${repoName}`;
      pageType = "github_general";

      const blobIdx = parts.indexOf("blob");
      if (blobIdx > 1 && parts.length > blobIdx + 2) {
        filePath = parts.slice(blobIdx + 2).join("/");
        pageType = "github_code";
      }
    }

    const isCodespaceHost =
      host === "github.dev" ||
      host.endsWith(".github.dev") ||
      host === "app.github.dev" ||
      host.endsWith(".app.github.dev");

    if (isCodespaceHost || (isGitHub && url.pathname.includes("/codespaces/"))) {
      pageType = "codespace";
    }

    return {
      pageType,
      pageContext: pageType === "other" ? "unknown" : "github",
      repoOwner,
      repoName,
      repoFullName,
      filePath,
    };
  } catch {
    return {
      pageType: "other",
      pageContext: "unknown",
      repoOwner: "",
      repoName: "",
      repoFullName: "",
      filePath: "",
    };
  }
}

function friendlyPageContext(pageContext, pageType) {
  if (pageType === "codespace") return "GitHub / Codespaces";
  if (pageContext === "campus") return "Campus Virtual";
  if (pageContext === "github") return "GitHub";
  return "Fuera del piloto";
}

function getLearningGoal(goalId = selectedLearningGoal) {
  return LEARNING_GOALS.find((goal) => goal.id === goalId) || LEARNING_GOALS[0];
}

function activityOrFile(context) {
  return toText(context.activityTitle) || toText(context.filePath) || "-";
}

function pickSignal(context) {
  return toText(context.visibleError)
    || toText(context.selection)
    || toText(context.activityTitle)
    || (toText(context.codeSnippet) ? "Fragmento de codigo detectado" : "")
    || "Sin senales concretas todavia";
}

function analyzeCodeSignals(codeText) {
  const code = String(codeText || "");
  return {
    todoCount: (code.match(/\b(TODO|FIXME)\b/g) || []).length,
    functionCount: (code.match(/\b(function|def|func|fn|public\s+\w+|private\s+\w+)\b/g) || []).length,
    classCount: (code.match(/\b(class|struct|interface)\b/g) || []).length,
    hasTests: /\b(describe\(|it\(|pytest|unittest|assert\s|@Test)\b/i.test(code),
  };
}

function buildGoalIdeas(context, language, goalId) {
  const pageContext = toText(context.pageContext);
  const ideas = [];

  if (goalId === "oop_basics") {
    ideas.push("Identifica las entidades del problema antes de crear nuevas clases.");
    ideas.push("Define para cada clase una sola responsabilidad facil de explicar.");
    ideas.push(`Piensa que atributos y metodos necesita realmente tu modelo en ${language}.`);
  } else if (goalId === "encapsulation") {
    ideas.push("Revisa que datos deban quedar protegidos y cuales pueden exponerse.");
    ideas.push("Valida si tus metodos cambian estado de forma controlada y coherente.");
    ideas.push("Evita que otras partes del programa modifiquen atributos sensibles sin reglas claras.");
  } else if (goalId === "inheritance") {
    ideas.push("Comprueba si la relacion entre clases realmente es de tipo es-un y no solo reutilizacion.");
    ideas.push("Busca comportamiento comun para moverlo a una clase base o interfaz.");
    ideas.push("Si sobrescribes metodos, verifica que cada subtipo respete el contrato esperado.");
  } else if (goalId === "debugging") {
    ideas.push("Aisla primero la linea o bloque donde aparece la falla antes de hacer cambios grandes.");
    ideas.push("Formula una hipotesis corta del error y prueba una sola correccion por intento.");
    ideas.push("Compara lo que el programa hace con lo que el enunciado o la clase deberia lograr.");
  } else if (goalId === "github_flow") {
    ideas.push("Trabaja en una rama corta para que cada cambio sea facil de revisar.");
    ideas.push("Haz commits pequenos que expliquen la intencion del cambio, no solo el archivo tocado.");
    ideas.push("Antes de entregar, revisa diff, mensajes de error y estado de tu repositorio.");
  }

  if (pageContext === "campus") {
    ideas.push("Relaciona cada pista con el enunciado visible antes de escribir o cambiar codigo.");
    ideas.push("Subraya restricciones, entradas, salidas y palabras clave del taller o actividad.");
  } else if (context.pageType === "codespace") {
    ideas.push("Aprovecha el editor para probar una mejora pequena y validar de inmediato.");
    ideas.push("Si estas bloqueado, reduce el problema a un caso minimo ejecutable.");
  } else if (context.pageType === "github_code") {
    ideas.push("Ubica en el archivo actual la seccion que corresponde al comportamiento que quieres reforzar.");
  } else {
    ideas.push("Abre una actividad del Campus o un archivo del repositorio para darte pistas mas precisas.");
  }

  return ideas;
}

function buildIdeas(context, language, goalId) {
  const ideas = [];
  const code = String(context.codeSnippet || "");
  const signals = analyzeCodeSignals(code);

  ideas.push(...buildGoalIdeas(context, language, goalId));

  if (context.pageType === "github_general") {
    ideas.push("Abre un archivo del repositorio para recomendar sobre codigo real y no solo sobre el repo.");
  }
  if (signals.todoCount > 0) {
    ideas.push(`Convierte ${signals.todoCount} TODO(s) en un plan corto de trabajo antes de seguir.`);
  }
  if (signals.functionCount >= 12) {
    ideas.push("El archivo se ve cargado: revisa si puedes separar funciones o responsabilidades.");
  }
  if (signals.classCount >= 5) {
    ideas.push("Hay varias clases visibles: compara responsabilidades antes de crear otra mas.");
  }
  if (code && !signals.hasTests && goalId !== "github_flow") {
    ideas.push("Agrega un caso minimo de prueba para confirmar si tu cambio si corrige el problema.");
  }
  ideas.push(...(IDEAS_BY_LANGUAGE[language] || IDEAS_BY_LANGUAGE.General));

  return unique(ideas).slice(0, MAX_LIST_ITEMS);
}

function buildSearches(context, language, goalId) {
  const items = [];

  if (goalId === "oop_basics") {
    items.push("Que entidad del problema deberia convertirse en clase primero");
    items.push("Que datos pertenecen al objeto y cuales deberian llegar por parametro");
    items.push(`Ejemplos simples de clases y objetos en ${language}`);
  } else if (goalId === "encapsulation") {
    items.push("Que atributos deberian ser privados en este ejercicio");
    items.push("Cuando usar getters, setters o metodos de negocio");
    items.push(`Buenas practicas de encapsulamiento en ${language}`);
  } else if (goalId === "inheritance") {
    items.push("Que comportamiento es comun y cual cambia entre clases");
    items.push("Cuando preferir composicion frente a herencia");
    items.push(`Ejemplos de herencia y polimorfismo en ${language}`);
  } else if (goalId === "debugging") {
    items.push("Cual es la primera evidencia concreta del error");
    items.push("Que entrada minima reproduce el fallo");
    items.push(`Como leer mensajes de error en ${language}`);
  } else if (goalId === "github_flow") {
    items.push("Que cambio pequeno puedo registrar hoy en una rama separada");
    items.push("Como revisar mi diff antes de entregar");
    items.push("Flujo basico de ramas y commits en GitHub Codespaces");
  }

  if (context.pageContext === "campus") {
    items.push("Que pide exactamente el enunciado y que parte todavia no cumplo");
    items.push("Que criterio de evaluacion puedo verificar antes de codificar");
  }

  if (context.pageType === "github_code" || context.pageType === "codespace") {
    items.push("Que parte del archivo actual deberia revisar primero");
    items.push("Que evidencia de mi codigo respalda la siguiente correccion");
  }

  return unique(items).slice(0, MAX_LIST_ITEMS);
}

function buildGuide(goalId, context) {
  const pageContext = toText(context.pageContext);

  if (goalId === "debugging") {
    return [
      "Ubica el error o comportamiento inesperado mas concreto que veas.",
      "Relaciona esa senal con el enunciado o con la parte del codigo que la produce.",
      "Formula una hipotesis y cambia una sola cosa a la vez.",
      "Ejecuta de nuevo o relee el mensaje para validar si mejoro.",
      "Si persiste, trae mas contexto en lugar de adivinar la solucion completa.",
    ];
  }

  if (goalId === "github_flow") {
    return [
      "Abre el repo o Codespace donde vas a trabajar hoy.",
      "Crea o identifica una rama de trabajo corta y con nombre claro.",
      "Haz un cambio pequeno alineado con la meta de aprendizaje de hoy.",
      "Revisa el diff y escribe un commit que explique la intencion.",
      "Antes de entregar, valida que el resultado responda al enunciado.",
    ];
  }

  if (pageContext === "campus") {
    return [
      "Lee el enunciado completo y marca entradas, salidas y restricciones.",
      "Traduce el problema a una idea de clases, metodos o pasos.",
      "Pasa al archivo de codigo con una meta pequena y verificable.",
      "Vuelve al enunciado para comprobar si tu avance cumple lo pedido.",
      "Si te bloqueas, pide una pista sobre el paso exacto que no logras resolver.",
    ];
  }

  return [
    "Define una meta pequena para el archivo o ejercicio actual.",
    "Ubica la clase, metodo o bloque donde empezar sin tocar todo a la vez.",
    "Haz un cambio corto que puedas explicar con tus propias palabras.",
    "Valida el resultado con una prueba o lectura del flujo principal.",
    "Resume que aprendiste antes de pasar al siguiente cambio.",
  ];
}

function setToggleUi() {
  els.enabledToggle.checked = assistantEnabled;
  els.enabledLabel.textContent = assistantEnabled ? "Encendido" : "Apagado";
  els.enabledLabel.className = assistantEnabled ? "chip chip-on" : "chip chip-off";
  els.refreshBtn.disabled = !assistantEnabled;
  els.checkBackendBtn.disabled = !assistantEnabled;
}

function buildHeroLead(context) {
  if (context.pageContext === "campus") {
    return "Estas en Campus Virtual. Puedo ayudarte a leer el enunciado, identificar restricciones y convertirlas en pasos de trabajo.";
  }
  if (context.pageType === "codespace") {
    return "Estas en Codespaces. Puedo acompanarte mientras programas, pruebas cambios pequenos y revisas errores.";
  }
  if (context.pageContext === "github") {
    return "Estas en GitHub. Puedo tomar el archivo abierto como contexto para darte pistas orientadas a POO.";
  }
  return "Abre una actividad del Campus o un archivo en GitHub/Codespaces para activar el acompanamiento contextual.";
}

function buildWelcomeMessage(context, goal, remoteWelcome = "") {
  if (remoteWelcome) return remoteWelcome;

  if (context.pageContext === "campus") {
    return `Hola. Soy ADACEEN y te acompanare desde Campus Virtual. Hoy nos enfocaremos en ${goal.label.toLowerCase()}. Voy a darte pistas breves, conectadas con el enunciado, sin resolverte todo el ejercicio.`;
  }
  if (context.pageType === "codespace") {
    return `Hola. Veo que estas programando en Codespaces. Hoy trabajaremos ${goal.label.toLowerCase()} sobre tu propio codigo. Vamos a programar paso a paso y a validar cada avance.`;
  }
  if (context.pageType === "github_code") {
    return `Hola. Estoy leyendo el archivo actual para apoyarte con ${goal.label.toLowerCase()}. Me concentrare en lo que ya tienes abierto y te dare una siguiente accion concreta.`;
  }
  return `Hola. Elige una meta de aprendizaje y abre una actividad o archivo del piloto. En cuanto tenga contexto real, adapto las pistas a ${goal.label.toLowerCase()}.`;
}

function buildGoalFeedback(context, goal) {
  if (context.pageContext === "campus") {
    return `Meta activa: ${goal.label}. Usare el enunciado y las senales visibles del Campus para orientar la ayuda.`;
  }
  if (context.pageType === "codespace") {
    return `Meta activa: ${goal.label}. Usare tu archivo abierto y el flujo de trabajo en Codespaces para sugerir el siguiente paso.`;
  }
  if (context.pageContext === "github") {
    return `Meta activa: ${goal.label}. Usare el archivo o repositorio visible para darte pistas mas precisas.`;
  }
  return `Meta activa: ${goal.label}. Abre una pagina del piloto para activar contexto real.`;
}

function renderGoalSelection() {
  const goal = getLearningGoal(selectedLearningGoal);
  els.goalChip.textContent = `Meta: ${goal.label}`;
  els.focusLabel.textContent = goal.label;

  Array.from(els.goalGrid.querySelectorAll("[data-goal-id]")).forEach((button) => {
    const isSelected = button.dataset.goalId === goal.id;
    button.classList.toggle("is-selected", isSelected);
  });
}

function renderLearningGoals() {
  clearList(els.goalGrid);
  const fragment = document.createDocumentFragment();

  for (const goal of LEARNING_GOALS) {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "goal-card";
    button.dataset.goalId = goal.id;

    const title = document.createElement("strong");
    title.textContent = goal.label;

    const text = document.createElement("span");
    text.textContent = goal.description;

    button.appendChild(title);
    button.appendChild(text);
    button.addEventListener("click", async () => {
      await setLearningGoal(goal.id);
    });

    fragment.appendChild(button);
  }

  els.goalGrid.textContent = "";
  els.goalGrid.appendChild(fragment);
  renderGoalSelection();
}

function renderContext(context, language, goal, remoteWelcome = "") {
  els.pageTitle.textContent = toText(context.title) || "(Sin titulo)";
  els.pageUrl.textContent = toText(context.url) || "(Sin URL)";
  els.pageType.textContent = friendlyPageType(context.pageType);
  els.pageLanguage.textContent = language;
  els.pagePath.textContent = activityOrFile(context);
  els.pageRepo.textContent = toText(context.repoFullName) || "-";
  els.pageBranch.textContent = toText(context.branch) || "-";
  els.pageLines.textContent = String(Number(context.codeLineCount) || 0);
  els.contextBadge.textContent = `Contexto: ${friendlyPageContext(context.pageContext, context.pageType)}`;
  els.pageContextLabel.textContent = friendlyPageContext(context.pageContext, context.pageType);
  els.signalLabel.textContent = pickSignal(context);
  els.welcomeLead.textContent = buildHeroLead(context);
  els.mentorWelcome.textContent = buildWelcomeMessage(context, goal, remoteWelcome);
  els.goalFeedback.textContent = buildGoalFeedback(context, goal);

  const preview = toText(context.codeSnippet)
    || toText(context.selection)
    || toText(context.visibleError)
    || toText(context.activityTitle)
    || toText(context.text).slice(0, MAX_CODE_PREVIEW_CHARS);

  if (preview) {
    els.codePreview.textContent = preview.slice(0, MAX_CODE_PREVIEW_CHARS);
  } else {
    els.codePreview.textContent = "(Sin contexto relevante detectado en la vista actual)";
  }
}

function renderOffState() {
  const goal = getLearningGoal(selectedLearningGoal);
  fillList(els.ideaList, ["Asistente apagado. Enciendelo para recibir pistas contextuales."]);
  fillList(els.searchList, ["Asistente apagado. Enciendelo para ver preguntas o busquedas sugeridas."]);
  fillList(els.guideList, buildGuide(goal.id, { pageContext: "unknown", pageType: "other" }));
  setSuggestionSource("local");
  els.contextBadge.textContent = "Contexto: inactivo";
  els.pageContextLabel.textContent = "Asistente apagado";
  els.signalLabel.textContent = "-";
  els.welcomeLead.textContent = "Enciende ADACEEN para activar el acompanamiento contextual.";
  els.mentorWelcome.textContent = `ADACEEN esta en pausa. La meta seleccionada sigue siendo ${goal.label.toLowerCase()} y se aplicara cuando vuelvas a encender el asistente.`;
  els.goalFeedback.textContent = `Meta activa: ${goal.label}. Enciende el asistente para usarla en la pagina actual.`;
  setStatus("Asistente apagado.", "warn");
}

function buildDefaultStatus(context) {
  if (context.pageContext === "campus") {
    return { text: "Campus Virtual detectado. Listo para leer actividad, senales y bloqueos visibles.", kind: "ok" };
  }
  if (context.pageType === "codespace") {
    return { text: "Codespace detectado. Contexto listo para acompanar tu trabajo en el editor.", kind: "ok" };
  }
  if (context.pageType === "github_code") {
    return { text: "Archivo de GitHub leido y sugerencias generadas.", kind: "ok" };
  }
  if (context.pageType === "github_general") {
    return {
      text: "Repositorio detectado. Abre un archivo para recibir ayuda sobre codigo real.",
      kind: "warn",
    };
  }
  return {
    text: "No estas en una pagina del piloto. Abre Campus Virtual o GitHub/Codespaces para activar el contexto.",
    kind: "warn",
  };
}

async function getActiveTab() {
  const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
  return tabs[0] || null;
}

function createFallbackContext(tab) {
  const url = toText(tab?.url);
  const parsed = parseGithubFromUrl(url);
  const pageContext = detectPageContextFromUrl(url);
  return {
    url,
    title: toText(tab?.title),
    pageContext,
    pageType: pageContext === "campus" ? "campus" : parsed.pageType,
    repoOwner: parsed.repoOwner,
    repoName: parsed.repoName,
    repoFullName: parsed.repoFullName,
    filePath: parsed.filePath,
    activityTitle: "",
    selection: "",
    visibleError: "",
    branch: "",
    languageHint: "",
    codeSnippet: "",
    codeLineCount: 0,
    text: "",
  };
}

async function readTabContext() {
  const tab = await getActiveTab();
  if (!tab?.id) {
    throw new Error("No hay pestana activa disponible.");
  }

  const fallback = createFallbackContext(tab);

  try {
    const response = await chrome.tabs.sendMessage(tab.id, { type: "GET_GITHUB_CONTEXT" });
    if (!response?.ok || !response?.data) {
      return fallback;
    }

    return {
      ...fallback,
      ...response.data,
      context: undefined,
    };
  } catch {
    return fallback;
  }
}

function buildBackendQuestion(context, language, goal) {
  const baseGoal = `${goal.prompt} Responde como tutor pedagogico y no des la solucion completa.`;

  if (context.pageContext === "campus") {
    return `Estoy en Campus Virtual. ${baseGoal} Enfocate en el enunciado, la actividad visible y los posibles errores en pantalla.`;
  }
  if (context.pageType === "codespace") {
    return `Estoy programando en Codespaces. ${baseGoal} Usa el archivo abierto y el flujo de trabajo en GitHub/Codespaces.`;
  }
  if (context.pageType === "github_code") {
    return `Analiza este archivo ${context.filePath || "actual"} en ${language}. ${baseGoal} Orienta sobre el siguiente paso para aprender desde el codigo actual.`;
  }
  if (context.pageType === "github_general") {
    return `Estoy en un repositorio de GitHub. ${baseGoal} Sugiere en que archivo enfocarme y como avanzar.`;
  }
  return `${baseGoal} Sugiere como empezar en Campus Virtual o GitHub/Codespaces.`;
}

async function fetchJsonWithTimeout(url, options = {}, timeoutMs = BACKEND_TIMEOUT_MS) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const response = await fetch(url, {
      ...options,
      signal: controller.signal,
    });
    const json = await response.json().catch(() => ({}));
    if (!response.ok) {
      throw new Error(String(json.error || `HTTP ${response.status}`));
    }
    return json;
  } finally {
    clearTimeout(timeout);
  }
}

function normalizeBackendResult(raw, fallbackGuide) {
  const result = raw?.result || {};
  const ideas = unique(Array.isArray(result.ideas) ? result.ideas : []).slice(0, MAX_LIST_ITEMS);
  const searches = unique(Array.isArray(result.searches) ? result.searches : []).slice(0, MAX_LIST_ITEMS);
  const guide = unique(Array.isArray(result.guide) ? result.guide : []).slice(0, Math.max(4, MAX_LIST_ITEMS + 1));

  return {
    source: toText(raw?.source) || "backend",
    ideas,
    searches,
    guide: guide.length > 0 ? guide : fallbackGuide,
    welcome: toText(result.welcome_message),
    summary: toText(result.analysis_summary),
  };
}

async function requestBackendMentor(context, language) {
  const goal = getLearningGoal(selectedLearningGoal);
  const baseUrl = normalizeBaseUrl(backendUrl || els.backendUrlInput.value);
  if (!baseUrl) {
    throw new Error("Base URL del backend vacia.");
  }

  const payload = {
    question: buildBackendQuestion(context, language, goal),
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
      learningGoal: goal.id,
      selection: toText(context.selection),
      visibleError: toText(context.visibleError),
      codeSnippet: toText(context.codeSnippet),
      codeLineCount: Number(context.codeLineCount) || 0,
    },
  };

  const endpoints = ["/intervene", "/github-mentor"];
  let lastError = null;

  for (const endpoint of endpoints) {
    try {
      const raw = await fetchJsonWithTimeout(`${baseUrl}${endpoint}`, {
        method: "POST",
        headers: { "Content-Type": "application/json; charset=utf-8" },
        body: JSON.stringify(payload),
      });

      if (!raw?.ok) {
        throw new Error(String(raw?.error || "Respuesta invalida del backend."));
      }

      return normalizeBackendResult(raw, buildGuide(goal.id, context));
    } catch (error) {
      lastError = error;
    }
  }

  throw lastError || new Error("No se pudo consultar el backend.");
}

async function saveBackendUrl(value) {
  backendUrl = normalizeBaseUrl(value);
  renderBackendState();
  await chrome.storage.local.set({ [STORAGE_KEY_BACKEND_URL]: backendUrl });
}

async function checkBackendConnection() {
  if (!assistantEnabled) {
    setStatus("Enciende el asistente para probar conexion.", "warn");
    return;
  }

  const baseUrl = normalizeBaseUrl(els.backendUrlInput.value);
  if (!baseUrl) {
    setStatus("Ingresa URL del backend.", "error");
    return;
  }

  await saveBackendUrl(baseUrl);
  setStatus("Probando backend...", "");

  try {
    const health = await fetchJsonWithTimeout(`${baseUrl}/health`, {
      method: "GET",
      headers: { "Content-Type": "application/json; charset=utf-8" },
    });

    if (!health?.ok) {
      throw new Error(String(health?.error || "Health no disponible."));
    }

    const mode = toText(health.mode) || "desconocido";
    setStatus(`Backend conectado (${mode}).`, "ok");
  } catch (error) {
    setStatus(`No se pudo conectar al backend: ${String(error)}`, "error");
  }
}

async function refreshAnalysis() {
  if (!assistantEnabled) {
    renderOffState();
    return;
  }

  setStatus("Analizando pagina activa...", "");

  try {
    const context = await readTabContext();
    const parsed = parseGithubFromUrl(context.url);
    const merged = {
      ...parsed,
      ...context,
      pageContext: context.pageContext || detectPageContextFromUrl(context.url),
      pageType: context.pageType || parsed.pageType,
      filePath: context.filePath || parsed.filePath,
      repoFullName: context.repoFullName || parsed.repoFullName,
    };

    const language = inferLanguage(merged.filePath, merged.languageHint);
    const goal = getLearningGoal(selectedLearningGoal);
    renderGoalSelection();
    renderContext(merged, language, goal);

    const localIdeas = buildIdeas(merged, language, goal.id);
    const localSearches = buildSearches(merged, language, goal.id);
    const localGuide = buildGuide(goal.id, merged);

    fillList(els.ideaList, localIdeas);
    fillList(els.searchList, localSearches);
    fillList(els.guideList, localGuide);
    setSuggestionSource("local");

    let usedBackend = false;
    if (merged.pageContext !== "unknown" && normalizeBaseUrl(backendUrl)) {
      try {
        setStatus("Consultando backend para recomendaciones avanzadas...", "");
        const remote = await requestBackendMentor(merged, language);

        if (remote.ideas.length > 0) fillList(els.ideaList, remote.ideas);
        if (remote.searches.length > 0) fillList(els.searchList, remote.searches);
        if (remote.guide.length > 0) fillList(els.guideList, remote.guide);
        renderContext(merged, language, goal, remote.welcome);

        setSuggestionSource(`backend/${remote.source}`);
        usedBackend = true;

        if (remote.summary) {
          setStatus(remote.summary, "ok");
        }
      } catch {
        setSuggestionSource("local/fallback");
      }
    }

    if (!usedBackend) {
      const defaultStatus = buildDefaultStatus(merged);
      setStatus(defaultStatus.text, defaultStatus.kind);
    }
  } catch (error) {
    setStatus("No se pudo leer la pestana activa.", "error");
    fillList(els.ideaList, ["Verifica permisos de la extension y vuelve a intentar."]);
    fillList(els.searchList, ["Abre una pagina HTTP/HTTPS (no chrome://) y actualiza."]);
    fillList(els.guideList, buildGuide(selectedLearningGoal, { pageContext: "unknown", pageType: "other" }));
    setSuggestionSource("local/error");
    els.codePreview.textContent = String(error);
  }
}

async function setLearningGoal(goalId) {
  selectedLearningGoal = LEARNING_GOALS.some((goal) => goal.id === goalId)
    ? goalId
    : DEFAULT_LEARNING_GOAL;

  renderGoalSelection();
  await chrome.storage.local.set({ [STORAGE_KEY_LEARNING_GOAL]: selectedLearningGoal });

  if (assistantEnabled) {
    await refreshAnalysis();
  } else {
    renderOffState();
  }
}

async function setEnabledState(nextValue) {
  assistantEnabled = !!nextValue;
  setToggleUi();
  await chrome.storage.local.set({ [STORAGE_KEY_ENABLED]: assistantEnabled });
  if (assistantEnabled) {
    await refreshAnalysis();
  } else {
    renderOffState();
  }
}

async function init() {
  try {
    const stored = await chrome.storage.local.get([
      STORAGE_KEY_ENABLED,
      STORAGE_KEY_BACKEND_URL,
      STORAGE_KEY_LEARNING_GOAL,
    ]);
    assistantEnabled = typeof stored[STORAGE_KEY_ENABLED] === "boolean"
      ? stored[STORAGE_KEY_ENABLED]
      : true;

    const storedBackend = normalizeBaseUrl(stored[STORAGE_KEY_BACKEND_URL]);
    backendUrl = storedBackend || DEFAULT_BACKEND_URL;
    selectedLearningGoal = LEARNING_GOALS.some((goal) => goal.id === stored[STORAGE_KEY_LEARNING_GOAL])
      ? stored[STORAGE_KEY_LEARNING_GOAL]
      : DEFAULT_LEARNING_GOAL;
  } catch {
    assistantEnabled = true;
    backendUrl = DEFAULT_BACKEND_URL;
    selectedLearningGoal = DEFAULT_LEARNING_GOAL;
  }

  setToggleUi();
  renderBackendState();
  renderLearningGoals();
  fillList(els.guideList, buildGuide(selectedLearningGoal, { pageContext: "unknown", pageType: "other" }));

  els.enabledToggle.addEventListener("change", async () => {
    await setEnabledState(els.enabledToggle.checked);
  });

  els.refreshBtn.addEventListener("click", async () => {
    await refreshAnalysis();
  });

  els.checkBackendBtn.addEventListener("click", async () => {
    await checkBackendConnection();
  });

  els.backendUrlInput.addEventListener("blur", async () => {
    const clean = normalizeBaseUrl(els.backendUrlInput.value);
    if (!clean) return;
    await saveBackendUrl(clean);
  });

  if (assistantEnabled) {
    await refreshAnalysis();
  } else {
    renderOffState();
  }
}

init().catch((error) => {
  setStatus("Error iniciando popup.", "error");
  els.codePreview.textContent = String(error);
});

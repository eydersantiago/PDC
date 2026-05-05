
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
  const ideas = [];

  if (goalId === "encapsulation") {
    ideas.push("Revisa que datos deban quedar protegidos y cuales pueden exponerse.");
    ideas.push("Verifica si tus metodos controlan los cambios de estado.");
  } else if (goalId === "inheritance") {
    ideas.push("Confirma si la relacion entre clases realmente es de tipo es-un.");
    ideas.push("Busca comportamiento comun antes de duplicar codigo.");
  } else if (goalId === "debugging") {
    ideas.push("Aisla primero la linea o bloque donde aparece la falla.");
    ideas.push("Prueba una sola correccion por intento.");
  } else if (goalId === "github_flow") {
    ideas.push("Trabaja en una rama corta para que el cambio sea facil de revisar.");
    ideas.push("Haz commits pequenos que expliquen la intencion.");
  } else {
    ideas.push("Identifica las entidades del problema antes de crear nuevas clases.");
    ideas.push(`Piensa que atributos y metodos necesita tu modelo en ${language}.`);
  }

  if (context.pageContext === "campus") {
    ideas.push("Relaciona cada pista con el enunciado visible antes de cambiar codigo.");
  } else if (context.pageType === "codespace") {
    ideas.push("Aprovecha el editor para probar una mejora pequena de inmediato.");
  } else if (context.pageType === "github_code") {
    ideas.push("Ubica en el archivo actual el bloque exacto que quieres reforzar.");
  } else {
    ideas.push("Abre una actividad o un archivo para recibir pistas mas precisas.");
  }

  return ideas;
}

function buildIdeas(context, language, goalId) {
  const ideas = [];
  const signals = analyzeCodeSignals(context.codeSnippet || "");

  ideas.push(...buildGoalIdeas(context, language, goalId));

  if (signals.todoCount > 0) {
    ideas.push(`Convierte ${signals.todoCount} TODO(s) en un plan corto de trabajo.`);
  }
  if (signals.functionCount >= 12) {
    ideas.push("El archivo se ve cargado. Evalua separar funciones o responsabilidades.");
  }
  if (signals.classCount >= 5) {
    ideas.push("Hay varias clases visibles. Compara responsabilidades antes de crear otra.");
  }
  if (context.codeSnippet && !signals.hasTests && goalId !== "github_flow") {
    ideas.push("Agrega un caso minimo de prueba para validar el siguiente cambio.");
  }

  return unique(ideas).slice(0, MAX_LIST_ITEMS);
}

function buildGuide(goalId, context) {
  if (goalId === "debugging") {
    return [
      "Ubica la primera evidencia concreta del error.",
      "Relaciona esa senal con el bloque o enunciado correspondiente.",
      "Cambia una sola cosa y valida el resultado.",
    ];
  }

  if (goalId === "github_flow") {
    return [
      "Confirma en que rama vas a trabajar.",
      "Haz un cambio pequeno y claro.",
      "Revisa el diff antes de seguir.",
    ];
  }

  if (context.pageContext === "campus") {
    return [
      "Lee entradas, salidas y restricciones del enunciado.",
      "Traduce el problema a una idea de clases o pasos.",
      "Pasa al codigo con una meta pequena y verificable.",
    ];
  }

  return [
    "Define una meta pequena para el archivo actual.",
    "Ubica el bloque donde empezar sin tocar todo a la vez.",
    "Valida el resultado antes del siguiente cambio.",
  ];
}

function buildSummaryBlock(context, language) {
  const status = overlayState.projectContextStatus || EMPTY_PROJECT_CONTEXT_STATUS;
  const insight = overlayState.projectContextInsight || EMPTY_PROJECT_CONTEXT_INSIGHT;
  const connectedVersion = toText(insight.version || status.latestVersion || status.currentVersion);
  const versionLabel = connectedVersion ? `Version ${connectedVersion}` : "Version sin contexto";
  const activityDeadline = toText(context.activityDeadline);
  const basePreview = toText(context.codeSnippet)
    || toText(context.selection)
    || toText(context.visibleError)
    || toText(context.activityTitle)
    || toText(context.text).slice(0, MAX_PREVIEW_CHARS);
  const previewChunks = [];
  if (insight.autoAdvice) {
    previewChunks.push(`[Consejo automatico]\n${insight.autoAdvice}`);
  }
  if (insight.screenshotOcrText) {
    previewChunks.push(`[OCR screenshot]\n${truncateText(insight.screenshotOcrText, 320)}`);
  }
  if (basePreview) {
    previewChunks.push(previewChunks.length > 0 ? `[Fragmento]\n${basePreview}` : basePreview);
  }

  return {
    contextLabel: friendlyPageContext(context.pageContext, context.pageType),
    detailTitle: toText(insight.mainFilePath)
      ? `Archivo principal: ${insight.mainFilePath}`
      : (toText(context.activityTitle) || toText(context.filePath) || toText(context.title) || "Sin detalle detectado"),
    detailMeta: [
      language,
      toText(context.repoFullName) || "Sin repositorio",
      toText(context.branch) || "Sin rama",
      activityDeadline || "",
      versionLabel,
    ].filter(Boolean).join(" | "),
    signal: toText(insight.summary) || pickSignal(context),
    preview: previewChunks.join("\n\n") || "(Sin fragmento detectado)",
  };
}

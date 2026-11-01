// ADACEEN | Capa 2 - Contexto: que mostrar en el centro de contexto: textos de estado (GitHub App, tour),
// modulos y conexiones, y la accion recomendada (tour de configuracion, tunel y vista principal).
// Movido sin cambios desde overlay/content-setup.js.
// Sin "use strict": el codigo viene de archivos en modo no estricto y se conserva igual.
// Orden de carga: manifest.json (content_scripts) y background.js (CONTENT_SCRIPT_FILES) deben coincidir.

function buildGithubAppStatusText() {
  const repoFullName = getCurrentRepoFullName();
  const status = overlayState.githubAppStatus || EMPTY_GITHUB_APP_STATUS;

  if (!repoFullName) {
    return "Abre o pega un repositorio de GitHub/Codespaces para preparar ADACEEN.";
  }

  if (!status.configured) {
    return status.missingConfig?.length
      ? `Backend sin configurar GitHub App. Faltan: ${status.missingConfig.join(", ")}.`
      : "Backend sin configurar GitHub App.";
  }

  if (!status.installation) {
    return `Repo confirmado: ${repoFullName}. Falta autorizar la GitHub App para este usuario.`;
  }

  const account = status.installation.accountLogin
    ? `Instalada en ${status.installation.accountLogin}`
    : "Instalacion detectada";
  if (status.bootstrapReady === true) {
    return `${account}. ${repoFullName} ya tiene configuracion ADACEEN detectada.`;
  }
  if (status.hasRepoAccess === true) {
    return `${account}. La app ya tiene acceso a ${repoFullName}.`;
  }
  if (status.hasRepoAccess === false) {
    return `${account}. Falta confirmar acceso a ${repoFullName}.`;
  }
  return `${account}. Aun no se pudo confirmar el acceso a ${repoFullName}.`;
}

function buildSetupStatusText(context, currentStep, flow) {
  const modeLabel = context?.pageType === "codespace"
    ? "Codespaces"
    : context?.pageType === "github_code" || context?.pageType === "github_general"
      ? "GitHub"
      : "fuera de GitHub";

  if (isTunnelSetupFlow()) {
    if (!flow.repoReady) {
      return "Abre tu repositorio en GitHub o escribe owner/repo para preparar tu editor en la nube.";
    }
    if (!flow.userOAuthConfigured) {
      return "El backend aun no tiene GitHub OAuth configurado. Avisa al docente.";
    }
    if (!flow.userConnected) {
      return `Un solo paso: conecta tu cuenta de GitHub. Al volver, ADACEEN preparara tu editor en la nube para ${flow.repoFullName} y lo abrira.`;
    }
    return `GitHub conectado. ADACEEN preparara tu editor en la nube para ${flow.repoFullName} y lo abrira. La primera vez GitHub te pedira un codigo de un solo uso.`;
  }

  if (flow.prCreated) {
    return "Listo: ADACEEN ya encontro la preparacion del repositorio. Puedes abrir el Codespace o entrar al dashboard.";
  }

  if (currentStep === 1) {
    if (!flow.repoReady) {
      return `Paso 1/3 en ${modeLabel}: confirma el repositorio. ADACEEN necesita el owner/repo antes de pedir permisos.`;
    }
    return `Paso 1/3 listo: ${flow.repoFullName}. Ahora autoriza la GitHub App para que pueda crear la rama y el PR.`;
  }

  if (currentStep === 2) {
    if (!flow.configured) {
      return `Paso 2/3 bloqueado: el backend no tiene configurada la GitHub App.`;
    }
    if (isWaitingGithubAppInstall()) {
      return `Paso 2/3: termina la instalacion de la GitHub App en la pestana de GitHub. ADACEEN la detecta sola y sigue aqui.`;
    }
    if (!flow.appConnected) {
      return `Paso 2/3: instala o autoriza la GitHub App en ${flow.repoFullName}. Esto permite crear el PR de configuracion.`;
    }
    if (!flow.accessVerified) {
      return `Paso 2/3: la GitHub App esta instalada, pero aun no tiene acceso a ${flow.repoFullName}.`;
    }
    return `Paso 2/3 listo: GitHub App tiene acceso. Falta conectar tu cuenta para Codespaces y preparar el entorno.`;
  }

  if (!flow.userOAuthConfigured) {
    return `Paso 3/3 bloqueado: falta configurar GitHub OAuth en backend para crear el Codespace del estudiante.`;
  }
  if (!flow.userConnected) {
    return `Paso 3/3: conecta tu cuenta GitHub. El Codespace se creara en tu cuenta, con tus permisos.`;
  }
  if (!flow.userHasCodespaceScope) {
    return `Paso 3/3: falta el permiso Codespaces. Vuelve a autorizar GitHub para automatizar la apertura del entorno.`;
  }

  if (typeof isTunnelProvider === "function" && isTunnelProvider()) {
    return `Paso 3/3 final: ADACEEN preparara tu editor en la nube (VS Code en el navegador) y lo abrira. La primera vez GitHub te pedira un codigo de un solo uso.`;
  }
  return `Paso 3/3 final: ADACEEN creara el PR, creara o reanudara el Codespace y lo abrira automaticamente.`;
}

function buildContextModuleInfo(context) {
  const pageType = toText(context?.pageType);
  const pageContext = toText(context?.pageContext);
  const repoFullName = getCurrentRepoFullName() || inferRepoFromContext(context || {});
  const branch = toText(context?.branch);
  const activityTitle = toText(context?.activityTitle);
  const activityDeadline = toText(context?.activityDeadline);
  const filePath = toText(context?.filePath);
  const title = toText(context?.title);
  const campusCourseOpen = isCampusCoursePageContext(context);

  if (pageType === "codespace") {
    return {
      label: "Contexto actual",
      title: isTunnelEditorPage(context) ? "Editor en la nube detectado" : "Codespace detectado",
      meta: [
        repoFullName ? `Proyecto: ${repoFullName}` : "Proyecto pendiente",
        filePath ? `Archivo: ${filePath}` : "",
      ].filter(Boolean).join(" | "),
      state: repoFullName ? "Activo" : "Sin repositorio",
      kind: repoFullName ? "ok" : "warn",
    };
  }

  if (pageType === "github_code" || pageType === "github_general") {
    return {
      label: "Contexto actual",
      title: "GitHub detectado",
      meta: [
        repoFullName ? `Repositorio: ${repoFullName}` : "Repositorio pendiente",
        branch ? `Rama: ${branch}` : "",
        filePath ? `Archivo: ${filePath}` : "",
      ].filter(Boolean).join(" | "),
      state: repoFullName ? "Repo listo" : "Detectando",
      kind: repoFullName ? "ok" : "warn",
    };
  }

  if (pageContext === "campus") {
    return {
      label: "Contexto actual",
      title: campusCourseOpen ? "Curso de Campus detectado" : "Campus Virtual detectado",
      meta: [
        campusCourseOpen && activityTitle ? `Curso: ${activityTitle}` : "Abre un curso para analizar actividades",
        campusCourseOpen && activityDeadline ? `Fecha: ${activityDeadline}` : "",
      ].filter(Boolean).join(" | "),
      state: campusCourseOpen ? "Curso abierto" : "Fuera de curso",
      kind: campusCourseOpen ? "ok" : "idle",
    };
  }

  return {
    label: "Contexto actual",
    title: "Pagina sin modulo ADACEEN",
    meta: title || "Abre Campus Virtual, GitHub o Codespaces para activar acciones.",
    state: "Sin contexto",
    kind: "idle",
  };
}

function buildConnectionItems(context, flow) {
  const pageType = toText(context?.pageType);
  const pageContext = toText(context?.pageContext);
  const status = overlayState.projectContextStatus || EMPTY_PROJECT_CONTEXT_STATUS;
  const repoFullName = getCurrentRepoFullName();
  const githubContext = isGithubOrCodespaceContext(context);
  const githubUserStatus = overlayState.githubUserStatus || EMPTY_GITHUB_USER_STATUS;
  const campusDetected = pageContext === "campus";
  const campusCourseOpen = isCampusCoursePageContext(context);
  const codespaceDetected = pageType === "codespace";

  const tunnelProvider = isTunnelSetupFlow();
  // Con el tunel el editor en la nube clona el repo sin la GitHub App: su fila no se muestra.
  let githubAppStatus = "";
  let githubAppKind = "idle";
  if (githubContext && !tunnelProvider) {
    if (!repoFullName) {
      githubAppStatus = "Repositorio pendiente";
      githubAppKind = "warn";
    } else if (!flow.configured) {
      githubAppStatus = "Backend pendiente";
      githubAppKind = "warn";
    } else if (!flow.appConnected) {
      githubAppStatus = "App pendiente";
      githubAppKind = "warn";
    } else if (!flow.accessVerified) {
      githubAppStatus = "Permiso pendiente";
      githubAppKind = "warn";
    } else {
      githubAppStatus = "App lista";
      githubAppKind = "ok";
    }
  }

  let githubUserStatusLabel = "";
  let githubUserKind = "idle";
  if (githubContext) {
    if (!githubUserStatus.configured) {
      githubUserStatusLabel = "OAuth pendiente";
      githubUserKind = "warn";
    } else if (!githubUserStatus.connected) {
      githubUserStatusLabel = "Conectar cuenta";
      githubUserKind = "warn";
    } else if (!flow.userHasCodespaceScope) {
      githubUserStatusLabel = "Permiso Codespaces";
      githubUserKind = "warn";
    } else {
      githubUserStatusLabel = githubUserStatus.accountLogin
        ? `@${githubUserStatus.accountLogin}`
        : "Cuenta lista";
      githubUserKind = "ok";
    }
  }

  let codespaceStatus = "No iniciado";
  let codespaceKind = "idle";
  if (codespaceDetected && status.hasContext) {
    codespaceStatus = "Worker listo";
    codespaceKind = "ok";
  } else if (codespaceDetected) {
    codespaceStatus = "Detectado";
    codespaceKind = "ok";
  } else if (flow.bootstrapDetected) {
    codespaceStatus = "Listo";
    codespaceKind = "ok";
  } else if (githubContext && flow.accessVerified && flow.userHasCodespaceScope) {
    codespaceStatus = "Pendiente";
    codespaceKind = "warn";
  } else if (githubContext && flow.accessVerified) {
    codespaceStatus = "OAuth pendiente";
    codespaceKind = "warn";
  }

  if (tunnelProvider) {
    const savedEditor = typeof getSavedTunnelEditor === "function" ? getSavedTunnelEditor() : null;
    if (codespaceDetected) {
      codespaceStatus = "Abierto";
      codespaceKind = "ok";
    } else if (savedEditor) {
      codespaceStatus = "Listo";
      codespaceKind = "ok";
    } else if (githubContext && flow.userConnected) {
      codespaceStatus = "Pendiente";
      codespaceKind = "warn";
    } else {
      codespaceStatus = "No iniciado";
      codespaceKind = "idle";
    }
  }

  // Solo filas que dicen algo util aqui: sin la GitHub App cuando no se usa (tunel o fuera de
  // GitHub), sin la cuenta de GitHub fuera de GitHub y sin Campus fuera de Campus.
  const items = [
    {
      label: "ADACEEN",
      status: hasActiveSession() ? "Conectado" : "No conectado",
      kind: hasActiveSession() ? "ok" : "warn",
    },
    githubContext && !tunnelProvider
      ? { label: "GitHub App", status: githubAppStatus, kind: githubAppKind }
      : null,
    githubContext
      ? { label: "GitHub OAuth", status: githubUserStatusLabel, kind: githubUserKind }
      : null,
    campusDetected
      ? { label: "Campus", status: campusCourseOpen ? "Curso abierto" : "Sin curso", kind: campusCourseOpen ? "ok" : "idle" }
      : null,
    {
      // "Codespaces" solo con ese proveedor confirmado; con el tunel o aun sin consultar
      // (paginas fuera de GitHub), el editor.
      label: overlayState.workspaceProvider === "codespaces" ? "Codespaces" : "Editor",
      status: codespaceStatus,
      kind: codespaceKind,
    },
  ].filter(Boolean);

  // VS Code (tunel, local o Codespace) publico contexto hace poco para este repo.
  const rackStatus = overlayState.vscodeRackStatus || EMPTY_VSCODE_RACK_STATUS;
  if (githubContext
    && !codespaceDetected
    && rackStatus.connected
    && repoFullName
    && parseRepoFullName(rackStatus.repoFullName).toLowerCase() === repoFullName.toLowerCase()) {
    items.push({ label: "VS Code", status: "Conectado", kind: "ok" });
  }
  return items;
}

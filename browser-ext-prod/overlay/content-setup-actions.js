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
  const presence = overlayState.vscodePresence || EMPTY_VSCODE_PRESENCE;
  if (githubContext
    && !codespaceDetected
    && presence.connected
    && repoFullName
    && parseRepoFullName(presence.repoFullName).toLowerCase() === repoFullName.toLowerCase()) {
    items.push({ label: "VS Code", status: "Conectado", kind: "ok" });
  }
  return items;
}

function buildSetupRecommendedAction(context, currentStep, flow) {
  const pullResult = getLatestSetupPullResult();
  const storedCodespaceUrl = toText(pullResult?.codespaceUrl)
    || toText(overlayState.githubAppStatus?.bootstrapCodespaceUrl);
  const storedPullNumber = Number(pullResult?.pullNumber || overlayState.githubAppStatus?.bootstrapPullNumber) || 0;
  const pageType = toText(context?.pageType);

  if (isTunnelSetupFlow()) {
    return buildTunnelSetupRecommendedAction(flow);
  }

  // Solo con la App lista se prepara el Codespace: antes, "ocupado" es el enlace de la App o del OAuth.
  if (flow.repoReady && flow.accessVerified && overlayState.githubAppBusy && overlayState.operationTitle) {
    return {
      title: `Preparando ${editorNoun(true)}`,
      copy: "ADACEEN sigue intentando abrirlo automaticamente. Si GitHub ya lo muestra en tu cuenta, puedes abrirlo manualmente sin crear otro proceso.",
      primary: { label: "Abrir Codespaces manualmente", action: "open_codespaces_manual" },
      secondary: { label: "Actualizar estado", action: "refresh_github_status" },
    };
  }

  if (flow.repoReady && (storedCodespaceUrl || storedPullNumber > 0)) {
    if (pageType === "codespace") {
      return {
        title: `${editorNoun(true)} detectado`,
        copy: `Ya estas dentro del entorno. ADACEEN no necesita preparar ni reanudar otro ${editorNoun()}.`,
        primary: { label: "Continuar aqui", action: "open_codespaces" },
        secondary: { label: "Actualizar estado", action: "refresh_github_status" },
      };
    }

    const hasDirectCodespaceUrl = typeof isDirectCodespaceUrl === "function"
      && isDirectCodespaceUrl(storedCodespaceUrl);
    const pendingCodespaceCopy = storedPullNumber > 0
      ? `ADACEEN ya creo la PR #${storedPullNumber}. Puedes abrir su Codespace o reintentar la preparacion automatica.`
      : "ADACEEN tiene un enlace de selector, pero aun falta confirmar el Codespace directo. Preparalo para que se abra automaticamente.";
    return {
      title: hasDirectCodespaceUrl ? `${editorNoun(true)} listo` : `${editorNoun(true)} pendiente`,
      copy: hasDirectCodespaceUrl
        ? `ADACEEN ya tiene un enlace directo para el ${editorNoun()} de ${flow.repoFullName}.`
        : pendingCodespaceCopy,
      primary: { label: hasDirectCodespaceUrl ? `Abrir ${editorNoun()}` : `Preparar ${editorNoun()}`, action: "open_codespaces" },
      secondary: overlayState.githubAppBusy
        ? { label: "Actualizar estado", action: "refresh_github_status" }
        : { label: "Reintentar preparacion", action: "create_bootstrap_pr" },
    };
  }

  if (flow.bootstrapDetected || flow.prCreated || hasCompletedSetup()) {
    return {
      title: "Entorno listo",
      copy: flow.repoFullName
        ? `${flow.repoFullName} ya tiene preparacion ADACEEN detectada.`
        : "La preparacion inicial ya esta completa.",
      primary: { label: "Ir al dashboard", action: "finish_setup" },
      secondary: { label: "Actualizar estado", action: "refresh_github_status" },
    };
  }

  // Codespaces con un boton unico, como el tunel (auditoria de redundancias, item 2): sin
  // "Actualizar estado" ni "Volver" al lado de cada paso. La GitHub App se detecta sola tras
  // abrir la instalacion (sin "Verificar acceso") y la cuenta de GitHub, al volver del OAuth.
  if (!flow.repoReady) {
    return {
      title: "Confirmar repositorio",
      copy: "Primero confirma el repositorio. Si estas en GitHub, usa Autodetectar; si no, pega owner/repo.",
      primary: { label: "Autodetectar repositorio", action: "detect_repo" },
      secondary: null,
    };
  }

  if (!flow.configured) {
    return {
      title: "Backend GitHub pendiente",
      copy: "El servidor aun no tiene credenciales de GitHub App para generar el enlace de autorizacion. Avisa al docente.",
      primary: { label: "Actualizar estado", action: "refresh_github_status" },
      secondary: null,
    };
  }

  const waitingApp = isWaitingGithubAppInstall();
  if (!flow.appConnected || !flow.accessVerified) {
    const copy = waitingApp
      ? `Termina la instalacion en la pestana de GitHub y elige ${flow.repoFullName}. ADACEEN la detecta sola y sigue aqui; si cerraste esa pestana, pulsa Autorizar GitHub App otra vez.`
      : !flow.appConnected
        ? `Instala la GitHub App en ${flow.repoFullName}. ADACEEN solo la usa para crear la rama y el PR de configuracion, y detecta la instalacion sola.`
        : `La GitHub App esta instalada, pero aun no tiene acceso a ${flow.repoFullName}. Pulsa Autorizar GitHub App y agrega este repositorio; ADACEEN lo detecta solo.`;
    return {
      title: waitingApp ? "Esperando la GitHub App" : (!flow.appConnected ? "Autorizar repositorio" : "Permiso pendiente"),
      copy,
      primary: { label: "Autorizar GitHub App", action: "connect_github" },
      secondary: null,
    };
  }

  if (!flow.userOAuthConfigured) {
    const invalidConfig = overlayState.githubUserStatus?.invalidConfig;
    const configHint = Array.isArray(invalidConfig) && invalidConfig.length
      ? invalidConfig.join(" ")
      : "El backend necesita GITHUB_OAUTH_CLIENT_ID, GITHUB_OAUTH_CLIENT_SECRET y callback para crear Codespaces con la cuenta del estudiante.";
    return {
      title: "OAuth GitHub pendiente",
      copy: configHint,
      primary: { label: "Actualizar estado", action: "refresh_github_status" },
      secondary: null,
    };
  }

  if (!flow.userConnected) {
    return {
      title: "Conectar cuenta GitHub",
      copy: `Ahora conecta tu cuenta personal. Al volver, ADACEEN creara el PR y tu Codespace para ${flow.repoFullName} y lo abrira en esa misma ventana.`,
      primary: { label: "Conectar GitHub", action: "connect_github_user" },
      secondary: null,
    };
  }

  if (!flow.userHasCodespaceScope) {
    return {
      title: "Permiso Codespaces pendiente",
      copy: "La cuenta GitHub esta conectada, pero falta el scope codespace. Vuelve a autorizar para permitir crear o reanudar Codespaces.",
      primary: { label: "Autorizar Codespaces", action: "connect_github_user" },
      secondary: null,
    };
  }

  return {
    title: "Preparar entorno",
    copy: `Todo listo. ADACEEN creara el PR, preparara el Codespace y lo abrira automaticamente (puede tardar cerca de 2 minutos). No necesitas crear el Codespace manualmente.`,
    primary: { label: "Preparar entorno ADACEEN", action: "create_bootstrap_pr" },
    secondary: null,
  };
}

// Tunel: un boton unico. Sin la GitHub App ni botones que solo cambian de tarjeta.
function buildTunnelSetupRecommendedAction(flow) {
  if (overlayState.githubAppBusy) {
    return {
      title: "Preparando tu editor",
      copy: "ADACEEN sigue preparando tu editor en la nube. La ventana de espera lo abrira sola cuando este listo.",
      primary: { label: "Preparando...", action: "open_my_editor", disabled: true },
      secondary: null,
    };
  }

  if (!flow.repoReady) {
    return {
      title: "Confirmar repositorio",
      copy: "Abre tu repositorio en GitHub o escribe owner/repo en el campo de abajo.",
      primary: { label: "Autodetectar repositorio", action: "detect_repo" },
      secondary: null,
    };
  }

  if (!flow.userOAuthConfigured) {
    return {
      title: "OAuth GitHub pendiente",
      copy: "El backend necesita GITHUB_OAUTH_CLIENT_ID y GITHUB_OAUTH_CLIENT_SECRET para conectar tu cuenta. Avisa al docente.",
      primary: { label: "Actualizar estado", action: "refresh_github_status" },
      secondary: null,
    };
  }

  if (!flow.userConnected) {
    return {
      title: "Conectar GitHub",
      copy: `Un solo paso: conecta tu cuenta de GitHub. Al volver, ADACEEN preparara y abrira tu editor en la nube para ${flow.repoFullName}.`,
      primary: { label: "Conectar GitHub", action: "connect_github_user" },
      secondary: null,
    };
  }

  const saved = typeof getSavedTunnelEditor === "function" ? getSavedTunnelEditor() : null;
  return {
    title: saved ? "Tu editor" : "Preparar tu editor",
    copy: saved
      ? `Tu editor en la nube para ${flow.repoFullName} esta guardado. Si la VM estaba apagada, ADACEEN espera a que encienda.`
      : `GitHub conectado. ADACEEN preparara tu editor en la nube para ${flow.repoFullName} y lo abrira. La primera vez GitHub te pedira un codigo de un solo uso.`,
    primary: { label: myEditorButtonLabel(), action: "open_my_editor" },
    secondary: null,
  };
}

function getLatestSetupPullResult() {
  const userId = getCurrentUserId();
  if (!userId || !overlayState.setupPrResultByUser) return null;
  const stored = overlayState.setupPrResultByUser[userId] || null;
  if (!stored) return null;

  const currentRepo = getCurrentRepoFullName();
  const storedRepo = parseRepoFullName(stored.repoFullName);
  if (currentRepo && storedRepo && currentRepo.toLowerCase() !== storedRepo.toLowerCase()) {
    return null;
  }

  const status = overlayState.githubAppStatus || EMPTY_GITHUB_APP_STATUS;
  const statusRepo = parseRepoFullName(status.repoFullName);
  const statusMatchesCurrentRepo = !!currentRepo
    && !!statusRepo
    && currentRepo.toLowerCase() === statusRepo.toLowerCase();
  if (statusMatchesCurrentRepo && status.bootstrapReady === false && !overlayState.githubAppBusy) {
    return null;
  }

  return stored;
}

function clearSetupPrResultForCurrentUser() {
  const userId = getCurrentUserId();
  if (!userId || !overlayState.setupPrResultByUser) return;
  delete overlayState.setupPrResultByUser[userId];
}

function buildMainRecommendedAction(context, flow) {
  const pageType = toText(context?.pageType);
  const pageContext = toText(context?.pageContext);
  const repoFullName = getCurrentRepoFullName();
  const pullResult = getLatestSetupPullResult();
  const statusCodespaceUrl = toText(overlayState.githubAppStatus?.bootstrapCodespaceUrl);
  const statusPullNumber = Number(overlayState.githubAppStatus?.bootstrapPullNumber) || 0;

  if (isAdminSession()) {
    return {
      title: "Administrar ADACEEN",
      copy: "Gestiona usuarios y roles del piloto desde el panel principal.",
      primary: { label: "Recargar usuarios", action: "reload_admin_users" },
      secondary: { label: "Configuracion", action: "open_settings" },
    };
  }

  // Sin bitacora cargada (0.7.16): fuera del editor y de un curso de Campus (que tiene su propio
  // «Bitacora requerida»), la accion recomendada del docente es subirla. «Subir bitácora» abre la
  // pestana «Bitacora» y el selector de archivo; la otra accion sigue siendo la de siempre.
  const campusCourse = pageContext === "campus" && isCampusCoursePageContext(context);
  if (isTeacherSession() && pageType !== "codespace" && !campusCourse
    && typeof isTeacherBitacoraMissing === "function" && isTeacherBitacoraMissing()) {
    return {
      title: "Sube la bitácora del curso",
      copy: "Aún no has subido la bitácora. Con ella ADACEEN arma la agenda del curso y tus estudiantes pueden analizar Campus. Súbela en Excel o PDF, o descarga la plantilla en la pestaña «Bitácora».",
      primary: { label: "Subir bitácora", action: "upload_teacher_bitacora", disabled: !!overlayState.analysisBusy },
      secondary: repoFullName
        ? { label: "Abrir en VS Code de este equipo", action: "open_local_vscode" }
        : { label: "Configuracion", action: "open_settings" },
    };
  }

  // El docente no prepara un editor en la nube ni abre Codespaces desde el repositorio de un
  // estudiante (auditoria, item 8): en GitHub y en paginas sin contexto su accion es la tuerca,
  // con el quiz de la clase, la politica del tutor y el piloto. Con un repositorio conserva
  // "Abrir en VS Code de este equipo", su forma de conectar VS Code (guia, 4.2). En Campus y
  // en el editor sigue la accion de esa pagina.
  if (isTeacherSession() && pageContext !== "campus" && pageType !== "codespace") {
    return {
      title: "Panel docente",
      copy: repoFullName
        ? `En Configuracion lanzas el quiz de la clase, ajustas la politica del tutor y diriges el piloto. Para conectar tu VS Code, abre ${repoFullName} en el VS Code de este equipo.`
        : "En Configuracion lanzas el quiz de la clase, ajustas la politica del tutor y diriges el piloto. Cada estudiante prepara su editor con su propia cuenta.",
      primary: { label: "Configuracion", action: "open_settings" },
      secondary: repoFullName
        ? { label: "Abrir en VS Code de este equipo", action: "open_local_vscode" }
        : null,
    };
  }

  if (pageContext === "campus") {
    if (!isCampusCoursePageContext(context)) {
      return null;
    }

    const activity = toText(context?.activityTitle) || "Actividad del Campus";
    const access = typeof getCurrentCampusCourseAccess === "function"
      ? getCurrentCampusCourseAccess(context)
      : { checked: false, checking: false, accessConfirmed: false, bitacoraLoaded: false, courseCode: "" };
    const courseCode = typeof getActiveCampusCourseCode === "function"
      ? getActiveCampusCourseCode(context)
      : toText(access.courseCode || "FPOO");
    // Campus (auditoria de redundancias, item 10): el acceso al curso y la bitacora se verifican
    // solos al entrar (verifyCampusCourseAccessOnEntry); "Verificar acceso" solo aparece para
    // reintentar tras un fallo o cuando falta la bitacora, y siempre una sola accion.
    const busy = !!overlayState.analysisBusy;
    const verifying = typeof isCampusAccessVerificationInFlight === "function" && isCampusAccessVerificationInFlight();
    if (access.checking || (!access.checked && verifying)) {
      return {
        title: "Confirmando curso",
        copy: `Verificando el acceso y la bitacora de ${courseCode}...`,
        primary: { label: "Verificando...", action: "verify_campus_course_access", disabled: true },
        secondary: null,
      };
    }
    if (!access.checked || !access.accessConfirmed) {
      // Otra forma de arreglarlo, no el mismo boton dos veces: el docente carga la bitacora y el
      // estudiante con varios cursos elige otro.
      const otherFix = isTeacherSession()
        ? { label: "Bitácora", action: "open_teacher_bitacora", disabled: busy }
        : (typeof getStudentAssignedCourseCodes === "function" && getStudentAssignedCourseCodes().length > 1
          ? { label: "Elegir curso", action: "choose_student_course", disabled: busy }
          : null);
      return {
        title: "Confirmar acceso",
        copy: !access.checked
          ? `Confirma el acceso a ${courseCode} y su bitacora antes de analizar Campus.`
          : access.error || `ADACEEN no pudo confirmar el acceso a ${courseCode} ni su bitacora. Vuelve a intentarlo.`,
        primary: { label: "Verificar acceso", action: "verify_campus_course_access", disabled: busy },
        secondary: otherFix,
      };
    }
    if (!access.bitacoraLoaded) {
      return {
        title: "Bitacora requerida",
        copy: isTeacherSession()
          ? `Acceso confirmado para ${courseCode}, pero aún no has subido la bitácora del curso: súbela (Excel o PDF) para analizar la página.`
          : `Acceso confirmado para ${courseCode}, pero tu docente aun no carga la bitacora del curso. Cuando la cargue, pulsa Verificar acceso.`,
        primary: isTeacherSession()
          ? { label: "Subir bitácora", action: "upload_teacher_bitacora", disabled: busy }
          : { label: "Verificar acceso", action: "verify_campus_course_access", disabled: busy },
        secondary: null,
      };
    }

    const analysis = overlayState.campusAnalysis;
    const stats = analysis?.stats || {};
    let calendarEventCount = 0;
    if (analysis && typeof buildCampusCalendarEvents === "function") {
      try {
        const campusEvents = buildCampusCalendarEvents(analysis, context);
        calendarEventCount = typeof mergeCampusCalendarEvents === "function"
          ? mergeCampusCalendarEvents([campusEvents]).length
          : campusEvents.length;
      } catch {
        calendarEventCount = 0;
      }
    }

    // Una accion: "Analizar Campus" y, con eventos con fecha, "Sincronizar agenda". Los
    // botones de la cabecera del resumen ya no la repiten en Campus (content-render.js).
    return {
      title: "Agenda Campus",
      copy: calendarEventCount
        ? `Actividad detectada: ${activity}. Hay ${calendarEventCount} evento(s) listo(s) para guardar en Google Calendar.`
        : stats.taskCount
          ? `Actividad detectada: ${activity}. Hay ${stats.taskCount} tarea(s) y ${stats.deadlineCount || 0} fecha(s) visibles para sincronizar.`
        : `Bitacora y acceso confirmados para ${courseCode}. Analiza el HTML visible del curso y luego sincroniza Calendar cuando estes listo.`,
      primary: {
        label: analysis && calendarEventCount ? "Sincronizar agenda" : "Analizar Campus",
        action: analysis && calendarEventCount ? "sync_campus_calendar" : "analyze_project",
        disabled: busy,
      },
      secondary: null,
    };
  }

  if (pageType === "codespace") {
    // En el editor (vscode.dev con el tunel o un Codespace). Con el proyecto ya leido, pedir
    // ayuda es "Actualizar" de la cabecera (Ctrl+Enter): la accion recomendada ya no lo repite
    // con "Solicitar tutoria", ni "Reintentar OCR" repite "OCR visual" de la cabecera.
    const tunnelEditor = isTunnelEditorPage(context);
    if (overlayState.analysisUnlocked) {
      const askHint = overlayState.assistantEnabled
        ? "Pulsa Actualizar (Ctrl+Enter) para pedir una guia contextual."
        : "El tutor esta pausado: reactivalo en Configuracion para pedir una guia.";
      return {
        title: tunnelEditor ? "Tutor en tu editor" : "Tutor en Codespaces",
        copy: repoFullName
          ? `Proyecto activo: ${repoFullName}. ${askHint}`
          : `${tunnelEditor ? "Editor en la nube" : "Codespace"} detectado. ${askHint}`,
        primary: null,
        secondary: null,
      };
    }
    return {
      title: tunnelEditor ? "Tutor en tu editor" : "Tutor en Codespaces",
      copy: repoFullName
        ? `Proyecto activo: ${repoFullName}. El siguiente paso es leer el ${tunnelEditor ? "proyecto" : "workspace"} o pedir una guia contextual.`
        : tunnelEditor
          ? "Editor en la nube detectado. Selecciona codigo o pide una guia contextual."
          : "Codespace detectado. Falta confirmar el repositorio para coordinar el worker.",
      primary: { label: "Analizar proyecto", action: "analyze_project" },
      secondary: null,
    };
  }

  if (isTunnelSetupFlow() && (pageType === "github_code" || pageType === "github_general")) {
    const saved = typeof getSavedTunnelEditor === "function" ? getSavedTunnelEditor() : null;
    const cloudButton = {
      label: myEditorButtonLabel(),
      action: "open_my_editor",
      disabled: !repoFullName || !!overlayState.githubAppBusy,
    };
    const localButton = { label: "Abrir en VS Code de este equipo", action: "open_local_vscode", disabled: !repoFullName };
    // En la Mac del laboratorio, quien uso VS Code de este equipo la ultima vez lo tiene como
    // accion principal; el editor en la nube queda de segundo boton.
    const prefersLocal = typeof getLastEditorChoice === "function" && getLastEditorChoice() === "local_vscode";
    if (prefersLocal) {
      // La eleccion se guarda por usuario, no por repositorio: el texto no afirma que este
      // repositorio ya se abrio ahi, y solo menciona el editor en la nube si existe.
      return {
        title: "Tu VS Code",
        copy: !repoFullName
          ? "Repositorio GitHub detectado. Actualiza contexto para confirmar el owner/repo."
          : `La ultima vez usaste el VS Code de este equipo: abre ${repoFullName} ahi con un clic. `
            + (saved
              ? "Tambien tienes tu editor en la nube."
              : `Si prefieres el editor en la nube, pulsa ${cloudButton.label}.`),
        primary: localButton,
        secondary: cloudButton,
      };
    }
    return {
      title: saved ? "Tu editor" : "Preparar tu editor",
      copy: !repoFullName
        ? "Repositorio GitHub detectado. Actualiza contexto para confirmar el owner/repo."
        : saved
          ? `Tu editor en la nube para ${repoFullName} esta guardado: abrelo con un clic. Tambien puedes usar el VS Code instalado en este equipo.`
          : `ADACEEN preparara tu editor en la nube para ${repoFullName} y lo abrira. Tambien puedes usar el VS Code instalado en este equipo (por ejemplo, en las Mac del laboratorio).`,
      primary: cloudButton,
      secondary: localButton,
    };
  }

  if (pageType === "github_code" || pageType === "github_general") {
    if (pullResult?.pullUrl || statusCodespaceUrl || statusPullNumber > 0) {
      return {
        title: "PR creado",
        copy: pullResult?.codespaceUrl || statusCodespaceUrl
          ? `El PR de configuracion para ${repoFullName || "este repositorio"} ya tiene enlace directo de Codespaces.`
          : `El PR de configuracion para ${repoFullName || "este repositorio"} esta disponible.`,
        primary: { label: "Abrir Codespace de la PR", action: "open_codespaces" },
        secondary: { label: "Ver PR creado", action: "open_setup_pr" },
      };
    }

    return {
      title: "Repositorio listo",
      copy: repoFullName
        ? `GitHub conectado para ${repoFullName}. Puedes abrirlo en la nube o en el VS Code instalado en este equipo (por ejemplo, en las Mac del laboratorio).`
        : "Repositorio GitHub detectado. Actualiza contexto para confirmar el owner/repo.",
      primary: { label: "Abrir Codespaces", action: "open_codespaces", disabled: !repoFullName },
      // VS Code instalado en este equipo: clona el repositorio y copia la sesion.
      secondary: { label: "Abrir en VS Code de este equipo", action: "open_local_vscode", disabled: !repoFullName },
    };
  }

  // Volver otro dia desde una pagina sin repositorio: el ultimo editor guardado, a un clic.
  const latestSaved = typeof getLatestSavedTunnelEditor === "function" ? getLatestSavedTunnelEditor() : null;
  if (latestSaved && pageType !== "codespace" && overlayState.workspaceProvider !== "codespaces") {
    // Sin "Actualizar contexto": era el mismo "Actualizar" de la cabecera.
    return {
      title: "Tu editor",
      copy: `Tu ultimo editor en la nube es ${latestSaved.repoFullName}. Abrelo con un clic; si la VM estaba apagada, ADACEEN espera a que encienda.`,
      primary: { label: "Abrir mi editor", action: "open_my_editor", disabled: !!overlayState.githubAppBusy },
      secondary: null,
    };
  }

  // Sin boton: "Actualizar" de la cabecera hace lo mismo. Con el tutor pausado ese boton esta
  // deshabilitado, asi que la accion recomendada conserva "Actualizar contexto".
  if (!overlayState.assistantEnabled) {
    return {
      title: "Buscar contexto",
      copy: "Abre Campus Virtual o tu repositorio en GitHub para activar acciones especificas. Luego pulsa Actualizar contexto.",
      primary: { label: "Actualizar contexto", action: "refresh_mentor" },
      secondary: null,
    };
  }
  return {
    title: "Buscar contexto",
    copy: "Abre Campus Virtual o tu repositorio en GitHub para activar acciones especificas. Luego pulsa Actualizar.",
    primary: null,
    secondary: null,
  };
}

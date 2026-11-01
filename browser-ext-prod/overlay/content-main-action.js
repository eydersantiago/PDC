// ADACEEN | Capa 2 - Contexto: la acción recomendada de la vista principal (con sesión y entorno listos).
// Movido sin cambios de content-setup-actions.js.

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
    const otherEditor = !saved && typeof getLatestSavedTunnelEditor === "function" ? getLatestSavedTunnelEditor() : null;
    return {
      title: saved ? "Tu editor" : "Preparar tu editor",
      copy: !repoFullName
        ? "Repositorio GitHub detectado. Actualiza contexto para confirmar el owner/repo."
        : saved
          ? `Tu editor en la nube para ${repoFullName} esta guardado: abrelo con un clic. Tambien puedes usar el VS Code instalado en este equipo.`
          : otherEditor
            ? `ADACEEN agregara ${repoFullName} a tu editor en la nube, en su propia carpeta, y lo abrira (sin otro codigo). Tambien puedes usar el VS Code instalado en este equipo.`
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
